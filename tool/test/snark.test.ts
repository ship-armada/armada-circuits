// ABOUTME: Integration tests for the snarkjs wrapper on a tiny circuit and a power-4 ptau built in a temp dir.
// ABOUTME: Covers base zkey, contributions, zkey history parsing, beacon, verify, vkey export and the safety checks.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBn128, ChaCha, type Curve } from 'ffjavascript';
import { powersOfTau } from 'snarkjs';
import {
  G1_GENERATOR_HEX,
  applyBeacon,
  contribute,
  exportVkey,
  newBaseZkey,
  newContributionProblems,
  readMpcParams,
  releaseCurve,
  sameSecret,
  verifyZkey,
  type ZkeyContribution,
} from '../src/snark';

const FIXTURE = path.join(__dirname, '..', '..', 'tool', 'test', 'fixtures', 'multiplier.circom');
const CIRCOM = process.env.CIRCOM_BIN ?? 'circom';

let dir: string;
let r1cs: string;
let ptau: string;
let curve: Curve;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snark-test-'));
  execFileSync(CIRCOM, [FIXTURE, '--r1cs', '-o', dir], { stdio: 'pipe' });
  r1cs = path.join(dir, 'multiplier.r1cs');
  curve = await buildBn128();
  await powersOfTau.newAccumulator(curve, 4, path.join(dir, 'pot_0.ptau'));
  await powersOfTau.contribute(path.join(dir, 'pot_0.ptau'), path.join(dir, 'pot_1.ptau'), 'test', 'test entropy');
  ptau = path.join(dir, 'pot_final.ptau');
  await powersOfTau.preparePhase2(path.join(dir, 'pot_1.ptau'), ptau);
});

after(async () => {
  await releaseCurve();
  fs.rmSync(dir, { recursive: true, force: true });
});

const z = (name: string) => path.join(dir, name);

test('G1_GENERATOR_HEX is the uncompressed BN254 G1 generator', () => {
  const buff = new Uint8Array(64);
  curve.G1.toRprUncompressed(buff, 0, curve.G1.g);
  assert.equal(G1_GENERATOR_HEX, Buffer.from(buff).toString('hex'));
});

test('contribute twice: history, hashes and verification', async () => {
  await newBaseZkey(r1cs, ptau, z('base.zkey'));
  const base = await readMpcParams(z('base.zkey'));
  assert.equal(base.contributions.length, 0);

  const h1 = await contribute(z('base.zkey'), z('c1.zkey'), { name: 'alice' });
  const h2 = await contribute(z('c1.zkey'), z('c2.zkey'), { name: 'bob', entropy: 'personal entropy' });
  const p1 = await readMpcParams(z('c1.zkey'));
  const p2 = await readMpcParams(z('c2.zkey'));

  assert.equal(p2.contributions.length, 2);
  assert.equal(p2.csHash, base.csHash);
  assert.equal(p2.contributions[0].contributionHash, h1, 'parsed hash matches what snarkjs returned');
  assert.equal(p2.contributions[1].contributionHash, h2);
  assert.equal(p2.contributions[1].name, 'bob');
  assert.equal(p2.contributions[1].type, 0);

  assert.deepEqual(newContributionProblems(base, p1), []);
  assert.deepEqual(newContributionProblems(p1, p2), []);
  assert.deepEqual(newContributionProblems(base, p2), ['expected exactly 1 new contribution, found 2']);
  assert.deepEqual(newContributionProblems(p2, p1), ['expected exactly 1 new contribution, found -1']);

  const ok = await verifyZkey(r1cs, ptau, z('c2.zkey'));
  assert.equal(ok.ok, true);
  const vkey = await exportVkey(z('c2.zkey'));
  assert.equal(vkey.protocol, 'groth16');
  assert.equal(vkey.nPublic, 1);
});

test('verifyZkey reports a tampered zkey as invalid instead of throwing', async () => {
  await newBaseZkey(r1cs, ptau, z('t-base.zkey'));
  await contribute(z('t-base.zkey'), z('t1.zkey'), { name: 'alice' });
  const bytes = fs.readFileSync(z('t1.zkey'));
  bytes[bytes.length - 100] ^= 0xff;
  fs.writeFileSync(z('t1-bad.zkey'), bytes);
  const res = await verifyZkey(r1cs, ptau, z('t1-bad.zkey'));
  assert.equal(res.ok, false);
});

test('applyBeacon records the beacon hash and iterations', async () => {
  await newBaseZkey(r1cs, ptau, z('b-base.zkey'));
  await contribute(z('b-base.zkey'), z('b1.zkey'), { name: 'alice' });
  const beaconHash = crypto.randomBytes(32).toString('hex');
  await assert.rejects(applyBeacon(z('b1.zkey'), z('b-x.zkey'), 'final beacon', beaconHash, 4), /iterationsExp must be an integer from 10 to 63/);
  await applyBeacon(z('b1.zkey'), z('b-final.zkey'), 'final beacon', beaconHash, 10);
  const p = await readMpcParams(z('b-final.zkey'));
  const last = p.contributions[p.contributions.length - 1];
  assert.equal(last.type, 1);
  assert.equal(last.beaconHash, beaconHash);
  assert.equal(last.numIterationsExp, 10);
  assert.equal((await verifyZkey(r1cs, ptau, z('b-final.zkey'))).ok, true);
});

test('newContributionProblems flags history mismatches and null contributions', () => {
  const c = (over: Partial<ZkeyContribution>): ZkeyContribution => ({
    deltaAfter: 'aa', g1_s: '11', g1_sx: '22', g2_spx: '33', transcript: '44', type: 0, contributionHash: 'h1', ...over,
  });
  const prev = { csHash: 'cs', contributions: [c({})] };

  assert.deepEqual(newContributionProblems(prev, { csHash: 'other', contributions: [c({}), c({ deltaAfter: 'bb', contributionHash: 'h2' })] }), [
    'circuit hash changed',
  ]);
  assert.deepEqual(newContributionProblems(prev, { csHash: 'cs', contributions: [c({ contributionHash: 'x' }), c({ deltaAfter: 'bb', contributionHash: 'h2' })] }), [
    'contribution 1 differs from the merged chain',
  ]);
  assert.deepEqual(newContributionProblems(prev, { csHash: 'cs', contributions: [c({}), c({ contributionHash: 'h2' })] }), [
    'new contribution leaves delta unchanged (secret = 1)',
  ]);
  assert.deepEqual(newContributionProblems(prev, { csHash: 'cs', contributions: [c({}), c({ deltaAfter: 'bb', g1_sx: '11', contributionHash: 'h2' })] }), [
    'new contribution has g1_s == g1_sx (secret = 1)',
  ]);
  assert.deepEqual(newContributionProblems(prev, { csHash: 'cs', contributions: [c({}), c({ deltaAfter: 'bb', type: 1, contributionHash: 'h2' })] }), [
    'new contribution is a beacon, not a participant contribution',
  ]);
  // The first contribution is compared with the base delta, the G1 generator.
  assert.deepEqual(newContributionProblems({ csHash: 'cs', contributions: [] }, { csHash: 'cs', contributions: [c({ deltaAfter: G1_GENERATOR_HEX })] }), [
    'new contribution leaves delta unchanged (secret = 1)',
  ]);
});

/** Build a contribution public key with a chosen secret, the way snarkjs does. */
function keyWithSecret(secret: bigint): ZkeyContribution {
  const hex = (g: 'G1' | 'G2', p: unknown) => {
    const b = new Uint8Array(g === 'G1' ? 64 : 128);
    curve[g].toRprUncompressed(b, 0, p);
    return Buffer.from(b).toString('hex');
  };
  const transcript = crypto.randomBytes(64);
  const view = new DataView(transcript.buffer, transcript.byteOffset, transcript.byteLength);
  const g2Seed = Array.from({ length: 8 }, (_, i) => view.getUint32(i * 4));
  const x = curve.Fr.e(secret);
  const g1s = curve.G1.fromRng(new ChaCha(Array.from({ length: 8 }, () => crypto.randomInt(0, 2 ** 32))));
  const g2sp = curve.G2.fromRng(new ChaCha(g2Seed));
  return {
    deltaAfter: '00',
    g1_s: hex('G1', curve.G1.toAffine(g1s)),
    g1_sx: hex('G1', curve.G1.toAffine(curve.G1.timesFr(g1s, x))),
    g2_spx: hex('G2', curve.G2.toAffine(curve.G2.timesFr(g2sp, x))),
    transcript: transcript.toString('hex'),
    type: 0,
    contributionHash: '00',
  };
}

test('sameSecret detects one secret reused across circuits', async () => {
  const a = keyWithSecret(123456789n);
  const b = keyWithSecret(123456789n);
  const c = keyWithSecret(987654321n);
  assert.notEqual(a.g1_s, b.g1_s, 'different public points, same secret');
  assert.equal(await sameSecret(a, b), true);
  assert.equal(await sameSecret(a, c), false);
});

test('sameSecret is false for two real snarkjs contributions', async () => {
  await newBaseZkey(r1cs, ptau, z('s-base.zkey'));
  await contribute(z('s-base.zkey'), z('s1.zkey'), { name: 'a' });
  await contribute(z('s-base.zkey'), z('s2.zkey'), { name: 'b' });
  const [p1, p2] = [await readMpcParams(z('s1.zkey')), await readMpcParams(z('s2.zkey'))];
  assert.equal(await sameSecret(p1.contributions[0], p2.contributions[0]), false);
});
