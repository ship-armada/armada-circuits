// ABOUTME: Coordinator commands: init, add-circuit, announcement text, finalize (policy + drand beacon) and release.
// ABOUTME: They return manifests for the coordinator to commit in a reviewed PR; only release publishes a release.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { headUrls } from './contributor';
import { DRAND_ENDPOINTS, QUICKNET, fetchVerifiedRound, roundAt, roundTime } from './drand';
import type { MaintainerGitHub } from './github';
import { downloadVerified, sha256File, type DownloadOptions } from './http';
import { lastTurn, parseManifest, type CircuitChain, type Manifest } from './manifest';
import type { Participants } from './participants';
import { policyShortfalls } from './policy';
import { HERMEZ_17, hashFile, ptauPower } from './ptau';
import { applyBeacon, exportVkey, newBaseZkey, readMpcParams, verifyZkey } from './snark';
import { transcript } from './transcript';

export interface CoordinatorDeps {
  gh: MaintainerGitHub;
  repo: string;
  workRoot: string;
  log(line: string): void;
  now(): number;
  download?: DownloadOptions;
  drandEndpoints?: string[];
  /** fetch for drand requests (tests replay recorded rounds). */
  drandFetch?: typeof fetch;
}

export interface CircuitFiles {
  id: string;
  r1cs: string;
  wasm: string;
}

/** §7: 10 contributions, 5 outside people from 3 organisations, 1 BYO-tool contribution. */
export const DEFAULT_POLICY: Manifest['policy'] = { minContributions: 10, minOutside: 5, minOutsideOrgs: 3, minByo: 1 };
/** The committed drand round is about this long after the window closes (§5.8). */
export const BEACON_DELAY_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_RELEASE_TAG = 'ceremony-zkeys';
const BEACON_ITERATIONS_EXP = 10;

function snarkjsVersion(): string {
  const pkg = path.join(path.dirname(require.resolve('snarkjs')), '..', 'package.json');
  return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
}

/** The first quicknet round published at least `delayMs` after `closes`. */
export function beaconRoundFor(closes: string, delayMs: number = BEACON_DELAY_MS): number {
  const target = Date.parse(closes) + delayMs;
  const r = roundAt(QUICKNET, target);
  return roundTime(QUICKNET, r) >= target ? r : r + 1;
}

async function buildChain(deps: CoordinatorDeps, tag: string, c: CircuitFiles, ptau: string, openedAtTurn: number): Promise<CircuitChain> {
  const dir = path.join(deps.workRoot, 'base');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${c.id}-0000.zkey`);
  deps.log(`building the ${c.id} base zkey...`);
  await newBaseZkey(c.r1cs, ptau, base);
  const urls = await deps.gh.uploadToRelease(deps.repo, tag, [base], 'Accepted ceremony contributions (one file per circuit per turn).');
  return {
    r1csSha256: await sha256File(c.r1cs),
    wasmSha256: await sha256File(c.wasm),
    status: 'open',
    openedAtTurn,
    base: { zkeySha256: await sha256File(base), mirrors: [{ kind: 'official', url: urls[path.basename(base)] }] },
    contributions: [],
  };
}

export interface InitOptions {
  circuits: CircuitFiles[];
  ptauPath: string;
  /** Required unless the ptau is the pinned Hermez power-17 file. */
  ptauMirrors?: string[];
  opens: string;
  closes: string;
  queueIssue: number;
  toolVersion: string;
  releaseTag?: string;
  policy?: Manifest['policy'];
  /** Defaults to the first quicknet round BEACON_DELAY_MS after `closes`. */
  beaconRound?: number;
}

/** `init`: base zkeys for every circuit (uploaded to the official release) and the starting manifest. */
export async function init(deps: CoordinatorDeps, o: InitOptions): Promise<{ manifest: Manifest; participants: Participants }> {
  if (Date.parse(o.opens) >= Date.parse(o.closes)) throw new Error('the window opens must be before it closes');
  const hashes = await hashFile(o.ptauPath);
  const isHermez = hashes.sha256 === HERMEZ_17.sha256 && hashes.blake2b === HERMEZ_17.blake2b;
  const mirrors = o.ptauMirrors && o.ptauMirrors.length > 0 ? o.ptauMirrors : isHermez ? HERMEZ_17.mirrors : undefined;
  if (!mirrors) throw new Error(`${o.ptauPath} is not the pinned Hermez power-17 ptau; give its mirror URLs`);
  const tag = o.releaseTag ?? DEFAULT_RELEASE_TAG;

  const circuits: Record<string, CircuitChain> = {};
  for (const c of o.circuits) circuits[c.id] = await buildChain(deps, tag, c, o.ptauPath, 0);
  const manifest = parseManifest({
    version: 2,
    requiredToolVersion: o.toolVersion,
    snarkjsVersion: snarkjsVersion(),
    coordination: { repo: deps.repo, queueIssue: o.queueIssue, officialReleaseTag: tag },
    ptau: { ...hashes, power: await ptauPower(o.ptauPath), mirrors },
    window: { opens: o.opens, closes: o.closes },
    beacon: { type: 'drand', chainHash: QUICKNET.hash, round: o.beaconRound ?? beaconRoundFor(o.closes), iterationsExp: BEACON_ITERATIONS_EXP },
    policy: o.policy ?? DEFAULT_POLICY,
    circuits,
  });
  return { manifest, participants: { version: 1, participants: [] } };
}

/** `add-circuit`: a new independent chain that joins from the next turn on. */
export async function addCircuit(deps: CoordinatorDeps, m: Manifest, c: CircuitFiles, ptauPath: string): Promise<Manifest> {
  if (m.circuits[c.id]) throw new Error(`circuit ${c.id} is already in the ceremony`);
  if (deps.now() >= Date.parse(m.window.closes)) throw new Error('the contribution window has closed');
  if ((await sha256File(ptauPath)) !== m.ptau.sha256) throw new Error(`${ptauPath} is not the ceremony's ptau`);
  const next = structuredClone(m);
  next.circuits[c.id] = await buildChain(deps, m.coordination.officialReleaseTag, c, ptauPath, lastTurn(m));
  return parseManifest(next);
}

/** The commitment published at announcement (and put in the signed announcement tag). */
export function announcementText(m: Manifest): string {
  const ids = Object.keys(m.circuits).sort();
  const p = m.policy;
  return [
    `Armada trusted-setup ceremony: ${m.coordination.repo}`,
    '',
    `Contribution window: ${m.window.opens} to ${m.window.closes}`,
    `Circuits: ${ids.length} (${ids.join(', ')})`,
    `Required tool version: ${m.requiredToolVersion}`,
    `Phase 1: Powers of Tau power ${m.ptau.power}, sha256 ${m.ptau.sha256}`,
    `Beacon: drand quicknet (chain ${m.beacon.chainHash}) round ${m.beacon.round}, published ${new Date(roundTime(QUICKNET, m.beacon.round)).toISOString()},`
      + ` applied with 2^${m.beacon.iterationsExp} iterations`,
    `Participant policy: minimum ${p.minContributions} contributions, ${p.minOutside} from outside the Armada team spanning`
      + ` ${p.minOutsideOrgs} organisations, ${p.minByo} with a bring-your-own tool`,
    '',
    `How to contribute: see docs/CEREMONY.md in ${m.coordination.repo}; claims go on issue #${m.coordination.queueIssue}.`,
  ].join('\n');
}

export interface FinalizeOptions {
  r1csFor(id: string): string;
  ptauPath: string;
}

/**
 * `finalize`: after the window, check the participant policy, fetch and
 * verify the committed drand round, apply it as the beacon to every circuit,
 * verify each final zkey, export verifying keys, and upload both to the
 * official release. Returns the finalized manifest.
 */
export async function finalize(deps: CoordinatorDeps, m: Manifest, people: Participants, o: FinalizeOptions): Promise<{ manifest: Manifest }> {
  const ids = Object.keys(m.circuits).sort();
  if (ids.some((id) => m.circuits[id].status === 'finalized')) throw new Error('the ceremony is already finalized');
  if (deps.now() < Date.parse(m.window.closes)) throw new Error(`the contribution window closes at ${m.window.closes}`);
  const short = policyShortfalls(m, people);
  if (short.length > 0) throw new Error(`participant policy not met:\n  ${short.join('\n  ')}`);
  const empty = ids.filter((id) => m.circuits[id].contributions.length === 0);
  if (empty.length > 0) throw new Error(`circuits with no contributions: ${empty.join(', ')}`);
  if (m.beacon.chainHash !== QUICKNET.hash) throw new Error(`beacon chain ${m.beacon.chainHash} is not drand quicknet`);
  if ((await sha256File(o.ptauPath)) !== m.ptau.sha256) throw new Error(`${o.ptauPath} is not the ceremony's ptau`);

  deps.log(`fetching drand quicknet round ${m.beacon.round}...`);
  const beacon = await fetchVerifiedRound(QUICKNET, m.beacon.round, deps.drandEndpoints ?? DRAND_ENDPOINTS, { fetch: deps.drandFetch });

  const dir = path.join(deps.workRoot, 'finalize');
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const finals: Record<string, { zkey: string; vkey: string; vkeySha256: string }> = {};
  for (const id of ids) {
    const chain = m.circuits[id];
    const head = path.join(dir, `${id}-head.zkey`);
    await downloadVerified(headUrls(deps.gh, deps.repo, m, id), chain.contributions[chain.contributions.length - 1].zkeySha256, head, deps.download);
    const zkey = path.join(dir, `${id}-final.zkey`);
    deps.log(`applying the beacon to ${id}...`);
    await applyBeacon(head, zkey, `armada-ceremony beacon: drand quicknet round ${m.beacon.round}`, beacon.randomness, m.beacon.iterationsExp);
    const last = (await readMpcParams(zkey)).contributions.at(-1)!;
    if (last.type !== 1 || last.beaconHash !== beacon.randomness) throw new Error(`${id}: the final contribution is not the drand beacon`);
    if ((await sha256File(o.r1csFor(id))) !== chain.r1csSha256) throw new Error(`${id}: r1cs does not match the manifest`);
    const res = await verifyZkey(o.r1csFor(id), o.ptauPath, zkey);
    if (!res.ok) throw new Error(`${id}: final zkey does not verify: ${res.messages.join('; ')}`);
    const vkey = path.join(dir, `${id}.vkey.json`);
    fs.writeFileSync(vkey, `${JSON.stringify(await exportVkey(zkey), null, 2)}\n`);
    finals[id] = { zkey, vkey, vkeySha256: await sha256File(vkey) };
    files.push(zkey, vkey);
  }
  const urls = await deps.gh.uploadToRelease(deps.repo, m.coordination.officialReleaseTag, files, 'Accepted ceremony contributions (one file per circuit per turn).');

  const next = structuredClone(m);
  next.beacon.value = beacon.randomness;
  next.beacon.signature = beacon.signature;
  for (const id of ids) {
    next.circuits[id].status = 'finalized';
    next.circuits[id].final = {
      zkeySha256: await sha256File(finals[id].zkey),
      vkeySha256: finals[id].vkeySha256,
      mirrors: [{ kind: 'official', url: urls[path.basename(finals[id].zkey)] }],
    };
  }
  return { manifest: parseManifest(next) };
}

export interface ReleaseOptions {
  tag: string;
  outDir: string;
  r1csFor(id: string): string;
  wasmFor(id: string): string;
  ptauPath: string;
  /** SSH private key to sign SHA256SUMS with (`ssh-keygen -Y sign -n armada-ceremony`). */
  signingKey?: string;
  /** Publish immediately instead of creating a draft for review. */
  publish?: boolean;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, _stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${stderr.trim() || err.message}`)) : resolve()));
  });
}

/**
 * `release`: collect every artifact of a finalized ceremony (final zkeys,
 * verifying keys and the VK bundle, r1cs, wasm, ptau, manifest, participants,
 * TRANSCRIPT.md), write SHA256SUMS (optionally signed), and upload them as a
 * GitHub release (a draft unless `publish`).
 */
export async function release(deps: CoordinatorDeps, m: Manifest, people: Participants, o: ReleaseOptions): Promise<{ dir: string; assets: string[] }> {
  const ids = Object.keys(m.circuits).sort();
  const notFinal = ids.filter((id) => m.circuits[id].status !== 'finalized' || !m.circuits[id].final);
  if (notFinal.length > 0) throw new Error(`not finalized: ${notFinal.join(', ')}`);
  fs.rmSync(o.outDir, { recursive: true, force: true });
  fs.mkdirSync(o.outDir, { recursive: true });
  const out = (name: string) => path.join(o.outDir, name);
  const bundle: Record<string, { vkey: unknown; vkeySha256: string; zkeySha256: string }> = {};

  for (const id of ids) {
    const chain = m.circuits[id];
    const final = chain.final!;
    for (const [kind, file, want] of [['r1cs', o.r1csFor(id), chain.r1csSha256], ['wasm', o.wasmFor(id), chain.wasmSha256]] as const) {
      const got = await sha256File(file).catch(() => 'missing');
      if (got !== want) throw new Error(`${id}: ${kind} ${file} (sha256 ${got}) does not match the manifest`);
      fs.copyFileSync(file, out(`${id}.${kind}`));
    }
    await downloadVerified(final.mirrors.map((x) => x.url), final.zkeySha256, out(`${id}.zkey`), deps.download);
    const vkeyText = `${JSON.stringify(await exportVkey(out(`${id}.zkey`)), null, 2)}\n`;
    fs.writeFileSync(out(`${id}.vkey.json`), vkeyText);
    const vkeySha256 = await sha256File(out(`${id}.vkey.json`));
    if (vkeySha256 !== final.vkeySha256) throw new Error(`${id}: exported verifying key does not match the manifest`);
    bundle[id] = { vkey: JSON.parse(vkeyText), vkeySha256, zkeySha256: final.zkeySha256 };
  }
  if ((await sha256File(o.ptauPath)) !== m.ptau.sha256) throw new Error(`${o.ptauPath} is not the ceremony's ptau`);
  fs.copyFileSync(o.ptauPath, out(path.basename(o.ptauPath)));
  fs.writeFileSync(out('manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  fs.writeFileSync(out('participants.json'), `${JSON.stringify(people, null, 2)}\n`);
  fs.writeFileSync(out('vkeys.json'), `${JSON.stringify({ version: 1, ceremony: m.coordination.repo, beacon: m.beacon, circuits: bundle }, null, 2)}\n`);
  fs.writeFileSync(out('TRANSCRIPT.md'), transcript(m, people));

  const names = fs.readdirSync(o.outDir).sort();
  const sums = await Promise.all(names.map(async (n) => `${await sha256File(out(n))}  ${n}`));
  fs.writeFileSync(out('SHA256SUMS'), `${sums.join('\n')}\n`);
  if (o.signingKey) await run('ssh-keygen', ['-Y', 'sign', '-f', o.signingKey, '-n', 'armada-ceremony', out('SHA256SUMS')]);

  const assets = fs.readdirSync(o.outDir).sort();
  deps.log(`uploading ${assets.length} assets to release ${o.tag}...`);
  await deps.gh.uploadToRelease(deps.repo, o.tag, assets.map(out), `Armada trusted-setup ceremony: final keys and transcript. See TRANSCRIPT.md.`,
    { draft: o.publish !== true });
  return { dir: o.outDir, assets };
}
