// ABOUTME: Thin wrapper over snarkjs for the ceremony: base zkey, contribute, beacon, verify, vkey export.
// ABOUTME: Also reads a zkey's contribution history and implements the null-contribution and reused-secret checks.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { blake2b } from '@noble/hashes/blake2b';
import * as binFileUtils from '@iden3/binfileutils';
import { buildBn128, ChaCha, type Curve } from 'ffjavascript';
import { zKey } from 'snarkjs';

/** One contribution's public data, as stored in a zkey's MPC section (points as uncompressed hex). */
export interface ZkeyContribution {
  deltaAfter: string;
  g1_s: string;
  g1_sx: string;
  g2_spx: string;
  transcript: string;
  /** 0 = participant contribution, 1 = beacon. */
  type: number;
  name?: string;
  numIterationsExp?: number;
  beaconHash?: string;
  /** snarkjs contribution hash: blake2b-512 of the contribution's public key (hex). */
  contributionHash: string;
}

export interface MpcParams {
  /** Hash of the circuit (r1cs + ptau) the chain belongs to. */
  csHash: string;
  contributions: ZkeyContribution[];
}

/** Uncompressed BN254 G1 generator (1, 2): the base zkey's delta before any contribution. */
export const G1_GENERATOR_HEX = '00'.repeat(31) + '01' + '00'.repeat(31) + '02';

/** snarkjs `zkey beacon` accepts numIterationsExp from 10 to 63. */
export const BEACON_MIN_ITERATIONS_EXP = 10;
export const BEACON_MAX_ITERATIONS_EXP = 63;

const GROTH16_PROTOCOL = 1;
const SECTION_HEADER = 1;
const SECTION_GROTH16_HEADER = 2;
const SECTION_MPC_PARAMS = 10;
const G1_BYTES = 64;
const G2_BYTES = 128;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function bn128(): Promise<Curve> {
  return buildBn128();
}

/** Stop the shared curve's worker threads so the process can exit. */
export async function releaseCurve(): Promise<void> {
  const g = globalThis as { curve_bn128?: Curve | null };
  if (g.curve_bn128) await g.curve_bn128.terminate();
}

function pointHex(curve: Curve, group: 'G1' | 'G2', montgomeryLE: Uint8Array): string {
  const p = curve[group].fromRprLEM(montgomeryLE, 0);
  const out = new Uint8Array(group === 'G1' ? G1_BYTES : G2_BYTES);
  curve[group].toRprUncompressed(out, 0, p);
  return hex(out);
}

/** Read the circuit hash and every contribution recorded in a Groth16 zkey. */
export async function readMpcParams(zkeyPath: string): Promise<MpcParams> {
  const curve = await bn128();
  const { fd, sections } = await binFileUtils.readBinFile(zkeyPath, 'zkey', 2);
  try {
    await binFileUtils.startReadUniqueSection(fd, sections, SECTION_HEADER);
    const protocol = await fd.readULE32();
    await binFileUtils.endReadSection(fd);
    if (protocol !== GROTH16_PROTOCOL) throw new Error(`${zkeyPath}: not a Groth16 zkey (protocol ${protocol})`);

    await binFileUtils.startReadUniqueSection(fd, sections, SECTION_GROTH16_HEADER);
    const n8q = await fd.readULE32();
    const q = await binFileUtils.readBigInt(fd, n8q);
    await binFileUtils.endReadSection(fd, true);
    if (q !== curve.q) throw new Error(`${zkeyPath}: not a BN254 zkey`);

    await binFileUtils.startReadUniqueSection(fd, sections, SECTION_MPC_PARAMS);
    const csHash = hex(await fd.read(64));
    const n = await fd.readULE32();
    const contributions: ZkeyContribution[] = [];
    for (let i = 0; i < n; i++) {
      const raw = {
        deltaAfter: await fd.read(G1_BYTES),
        g1_s: await fd.read(G1_BYTES),
        g1_sx: await fd.read(G1_BYTES),
        g2_spx: await fd.read(G2_BYTES),
      };
      const c: ZkeyContribution = {
        deltaAfter: pointHex(curve, 'G1', raw.deltaAfter),
        g1_s: pointHex(curve, 'G1', raw.g1_s),
        g1_sx: pointHex(curve, 'G1', raw.g1_sx),
        g2_spx: pointHex(curve, 'G2', raw.g2_spx),
        transcript: hex(await fd.read(64)),
        type: await fd.readULE32(),
        contributionHash: '',
      };
      // Optional parameters, in the order snarkjs writes them (1 name, 2 iterations, 3 beacon hash).
      const paramLength = await fd.readULE32();
      const end = fd.pos + paramLength;
      while (fd.pos < end) {
        const [kind] = await fd.read(1);
        if (kind === 1) {
          const [len] = await fd.read(1);
          c.name = new TextDecoder().decode(await fd.read(len));
        } else if (kind === 2) {
          [c.numIterationsExp] = await fd.read(1);
        } else if (kind === 3) {
          const [len] = await fd.read(1);
          c.beaconHash = hex(await fd.read(len));
        } else {
          throw new Error(`${zkeyPath}: unknown contribution parameter ${kind}`);
        }
      }
      // Same bytes snarkjs hashes in hashPubKey: deltaAfter, g1_s, g1_sx, g2_spx, transcript.
      c.contributionHash = hex(blake2b(Buffer.from(c.deltaAfter + c.g1_s + c.g1_sx + c.g2_spx + c.transcript, 'hex'), { dkLen: 64 }));
      contributions.push(c);
    }
    await binFileUtils.endReadSection(fd);
    return { csHash, contributions };
  } finally {
    await fd.close();
  }
}

/** snarkjs's hashToG2: a G2 point derived from a transcript hash (seeded ChaCha). */
function hashToG2(curve: Curve, transcriptHex: string): unknown {
  const t = Buffer.from(transcriptHex, 'hex');
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const seed = Array.from({ length: 8 }, (_, i) => view.getUint32(i * 4));
  return curve.G2.fromRng(new ChaCha(seed));
}

/**
 * True when two contributions used the same secret x. Each stores g1_s, x·g1_s
 * and x·g2_sp (g2_sp derived from its transcript), so the secrets match exactly
 * when e(g1_s_A, x_B·g2_sp_B) == e(x_A·g1_s_A, g2_sp_B).
 */
export async function sameSecret(a: ZkeyContribution, b: ZkeyContribution): Promise<boolean> {
  const curve = await bn128();
  const g1 = (h: string) => curve.G1.fromRprUncompressed(Buffer.from(h, 'hex'), 0);
  const g2 = (h: string) => curve.G2.fromRprUncompressed(Buffer.from(h, 'hex'), 0);
  return curve.pairingEq(g1(a.g1_s), g2(b.g2_spx), curve.G1.neg(g1(a.g1_sx)), hashToG2(curve, b.transcript));
}

/**
 * Checks on a new zkey's history against the merged one: same circuit, the
 * merged chain unchanged, exactly one new participant contribution, and that
 * contribution not a no-op. `zkey verify` accepts a secret of 1, so this
 * catches lazy or buggy tools; it cannot detect a contributor who keeps a
 * random secret.
 */
export function newContributionProblems(prev: MpcParams, next: MpcParams): string[] {
  if (next.csHash !== prev.csHash) return ['circuit hash changed'];
  const added = next.contributions.length - prev.contributions.length;
  if (added !== 1) return [`expected exactly 1 new contribution, found ${added}`];
  const problems: string[] = [];
  prev.contributions.forEach((c, i) => {
    if (next.contributions[i].contributionHash !== c.contributionHash) problems.push(`contribution ${i + 1} differs from the merged chain`);
  });
  if (problems.length > 0) return problems;

  const n = next.contributions[next.contributions.length - 1];
  const prevDelta = prev.contributions.length > 0 ? prev.contributions[prev.contributions.length - 1].deltaAfter : G1_GENERATOR_HEX;
  if (n.type !== 0) problems.push('new contribution is a beacon, not a participant contribution');
  if (n.deltaAfter === prevDelta) problems.push('new contribution leaves delta unchanged (secret = 1)');
  if (n.g1_s === n.g1_sx) problems.push('new contribution has g1_s == g1_sx (secret = 1)');
  return problems;
}

/** Create a circuit's base (0000) zkey from its r1cs and the phase-1 ptau. */
export async function newBaseZkey(r1cs: string, ptau: string, out: string): Promise<void> {
  resultHash('zkey new', await zKey.newZKey(r1cs, ptau, out, quietLogger()));
}

/** snarkjs logs progress through the logger and reports errors there before returning false. */
let lastSnarkjsErrors: string[] = [];
function quietLogger() {
  lastSnarkjsErrors = [];
  const record = (...args: unknown[]) => lastSnarkjsErrors.push(args.map(String).join(' '));
  return { debug: () => {}, info: () => {}, warn: record, error: record };
}

/** snarkjs returns a hash on success and false on failure. */
function resultHash(op: string, result: Uint8Array | false | undefined): string {
  if (!(result instanceof Uint8Array)) {
    throw new Error(`snarkjs ${op} failed${lastSnarkjsErrors.length > 0 ? `: ${lastSnarkjsErrors.join('; ')}` : ''}`);
  }
  return hex(result);
}

/**
 * Add one contribution. snarkjs mixes 64 bytes of OS randomness with `entropy`;
 * when no personal entropy is given a random string is passed, because an empty
 * one makes snarkjs prompt on stdin. Returns the contribution hash (hex).
 */
export async function contribute(oldZkey: string, newZkey: string, opts: { name: string; entropy?: string }): Promise<string> {
  const entropy = opts.entropy && opts.entropy.length > 0 ? opts.entropy : crypto.randomBytes(32).toString('hex');
  return resultHash('zkey contribute', await zKey.contribute(oldZkey, newZkey, opts.name, entropy, quietLogger()));
}

/** Apply the public beacon as the final contribution. Returns its contribution hash (hex). */
export async function applyBeacon(oldZkey: string, newZkey: string, name: string, beaconHashHex: string, iterationsExp: number): Promise<string> {
  if (!Number.isInteger(iterationsExp) || iterationsExp < BEACON_MIN_ITERATIONS_EXP || iterationsExp > BEACON_MAX_ITERATIONS_EXP) {
    throw new Error(`beacon iterationsExp must be an integer from ${BEACON_MIN_ITERATIONS_EXP} to ${BEACON_MAX_ITERATIONS_EXP}`);
  }
  return resultHash('zkey beacon', await zKey.beacon(oldZkey, newZkey, name, beaconHashHex, iterationsExp, quietLogger()));
}

/**
 * Full `snarkjs zkey verify` of a zkey against its r1cs and ptau, run in a
 * child process (verify-worker). snarkjs verify leaves file handles open, which
 * otherwise surface as garbage-collection warnings; it also keeps parsing of an
 * untrusted zkey out of this process. Failure details snarkjs would print are
 * returned instead. A crash or malformed file counts as invalid.
 */
export async function verifyZkey(r1cs: string, ptau: string, zkey: string): Promise<{ ok: boolean; messages: string[] }> {
  const worker = path.join(__dirname, 'verify-worker.js');
  return new Promise((resolve) => {
    execFile(process.execPath, [worker, r1cs, ptau, zkey], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      try {
        const res = JSON.parse(stdout) as { ok: boolean; messages: string[] };
        if (stderr.trim() !== '') res.messages.push(stderr.trim());
        resolve({ ok: res.ok === true && stderr.trim() === '', messages: res.messages });
      } catch {
        resolve({ ok: false, messages: [err ? err.message : 'verify worker produced no result', stderr.trim()].filter((m) => m !== '') });
      }
    });
  });
}

export async function exportVkey(zkey: string): Promise<Record<string, unknown>> {
  return zKey.exportVerificationKey(zkey);
}
