// ABOUTME: Unit tests for the ceremony manifest: schema validation, chain invariants and turn appends.
// ABOUTME: Covers the append-only rules a contribution PR must satisfy (one new turn, nothing else changed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ManifestError,
  appendTurn,
  checkContributionAppend,
  lastTurn,
  parseManifest,
  type Manifest,
  type TurnInput,
} from '../src/manifest';

const hex = (ch: string, n: number) => ch.repeat(n);
const SHA = (ch: string) => hex(ch, 64);
const BLAKE = (ch: string) => hex(ch, 128);

const baseManifest = (): Manifest => ({
  version: 2,
  requiredToolVersion: '1.0.0',
  snarkjsVersion: '0.7.6',
  ptau: { sha256: SHA('a'), blake2b: BLAKE('b'), power: 17, mirrors: ['https://circom.info/powersOfTau28_hez_final_17.ptau'] },
  window: { opens: '2027-01-01T00:00:00Z', closes: '2027-01-22T00:00:00Z' },
  beacon: { type: 'drand', chainHash: SHA('c'), round: 1000, iterationsExp: 10 },
  policy: { minContributions: 10, minOutside: 5, minOutsideOrgs: 3, minByo: 1 },
  circuits: {
    '1x1': { r1csSha256: SHA('1'), wasmSha256: SHA('2'), status: 'open', openedAtTurn: 0, base: { zkeySha256: SHA('3'), mirrors: [] }, contributions: [] },
    '2x2': { r1csSha256: SHA('4'), wasmSha256: SHA('5'), status: 'open', openedAtTurn: 0, base: { zkeySha256: SHA('6'), mirrors: [] }, contributions: [] },
  },
});

const turn = (contributor: string, ch: string): TurnInput => ({
  contributor,
  toolVersion: '1.0.0',
  mode: 'tool',
  attestation: `ceremony/attestations/turn-${contributor}.json`,
  timestamp: '2027-01-02T10:00:00Z',
  perCircuit: {
    '1x1': { zkeySha256: SHA(ch), contributionHash: BLAKE(ch), mirrors: [{ kind: 'fork', url: `https://github.com/${contributor}/armada-circuits/releases/download/t/1x1.zkey` }] },
    '2x2': { zkeySha256: SHA(ch), contributionHash: BLAKE(ch), mirrors: [{ kind: 'fork', url: `https://github.com/${contributor}/armada-circuits/releases/download/t/2x2.zkey` }] },
  },
});

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ManifestError, `expected ManifestError, got ${String(err)}`);
    return err.problems;
  }
  assert.fail('expected a ManifestError');
};

test('a fresh manifest is valid and has no turns', () => {
  const m = parseManifest(JSON.parse(JSON.stringify(baseManifest())));
  assert.equal(lastTurn(m), 0);
});

test('appendTurn adds the next turn to every open circuit', () => {
  const m = appendTurn(baseManifest(), turn('alice', 'd'));
  assert.equal(lastTurn(m), 1);
  for (const id of ['1x1', '2x2']) {
    const c = m.circuits[id].contributions;
    assert.equal(c.length, 1);
    assert.equal(c[0].index, 1);
    assert.equal(c[0].turn, 1);
    assert.equal(c[0].contributor, 'alice');
  }
  const m2 = appendTurn(m, turn('bob', 'e'));
  assert.equal(m2.circuits['2x2'].contributions[1].index, 2);
  assert.equal(lastTurn(m2), 2);
  parseManifest(m2);
});

test('appendTurn refuses missing or extra circuits and closed chains', () => {
  const t = turn('alice', 'd');
  delete t.perCircuit['2x2'];
  assert.throws(() => appendTurn(baseManifest(), t), /missing contribution for open circuit 2x2/);
  const extra = turn('alice', 'd');
  extra.perCircuit['9x9'] = extra.perCircuit['1x1'];
  assert.throws(() => appendTurn(baseManifest(), extra), /9x9 is not an open circuit/);
  const closed = baseManifest();
  closed.circuits['1x1'].status = 'closed';
  closed.circuits['2x2'].status = 'closed';
  assert.throws(() => appendTurn(closed, turn('alice', 'd')), /no open circuits/);
});

test('parseManifest reports schema problems', () => {
  const m = baseManifest() as unknown as Record<string, unknown>;
  m.version = 1;
  (m.ptau as Record<string, unknown>).sha256 = 'nothex';
  (m.policy as Record<string, unknown>).minByo = -1;
  (m.beacon as Record<string, unknown>).type = 'blockhash';
  assert.deepEqual(problemsOf(() => parseManifest(m)), [
    'version must be 2',
    'ptau.sha256 must be 64 lowercase hex characters',
    'beacon.type must be "drand"',
    'policy.minByo must be a non-negative integer',
  ]);
});

test('parseManifest enforces chain invariants', () => {
  const m = appendTurn(appendTurn(baseManifest(), turn('alice', 'd')), turn('bob', 'e'));
  m.circuits['2x2'].contributions[1].index = 5;
  m.circuits['1x1'].contributions[1].contributor = 'mallory';
  // Per-circuit checks come first; then each turn is compared with the first circuit that has it.
  assert.deepEqual(problemsOf(() => parseManifest(m)), [
    'circuits.2x2.contributions[1].index must be 2',
    'circuits.2x2: turn 2 contributor differs from circuits.1x1 (bob vs mallory)',
  ]);
});

test('parseManifest requires every turn after openedAtTurn in each circuit', () => {
  const m = appendTurn(baseManifest(), turn('alice', 'd'));
  m.circuits['2x2'].contributions = [];
  assert.deepEqual(problemsOf(() => parseManifest(m)), ['circuits.2x2: missing turn 1']);
  // A circuit added after turn 1 only has the later turns.
  const late = appendTurn(baseManifest(), turn('alice', 'd'));
  late.circuits['3x3'] = { r1csSha256: SHA('7'), wasmSha256: SHA('8'), status: 'open', openedAtTurn: 1, base: { zkeySha256: SHA('9'), mirrors: [] }, contributions: [] };
  const t2 = turn('bob', 'e');
  t2.perCircuit['3x3'] = t2.perCircuit['1x1'];
  const ok = appendTurn(late, t2);
  assert.deepEqual(ok.circuits['3x3'].contributions.map((c) => c.turn), [2]);
  assert.equal(ok.circuits['3x3'].contributions[0].index, 1);
  parseManifest(ok);
});

test('checkContributionAppend accepts exactly one new turn by the PR author', () => {
  const prev = appendTurn(baseManifest(), turn('alice', 'd'));
  const next = appendTurn(prev, turn('bob', 'e'));
  assert.deepEqual(checkContributionAppend(prev, next, 'bob'), []);
});

test('checkContributionAppend rejects everything else', () => {
  const prev = appendTurn(baseManifest(), turn('alice', 'd'));
  const next = appendTurn(prev, turn('bob', 'e'));
  assert.deepEqual(checkContributionAppend(prev, next, 'carol'), ['new turn 2 is by bob, but the PR author is carol']);
  assert.deepEqual(checkContributionAppend(prev, prev, 'bob'), ['expected exactly one new turn (2), found 0']);
  const two = appendTurn(next, turn('carol', 'f'));
  assert.deepEqual(checkContributionAppend(prev, two, 'carol'), ['expected exactly one new turn (2), found 2']);

  const tampered = structuredClone(next);
  tampered.circuits['1x1'].contributions[0].zkeySha256 = SHA('0');
  assert.deepEqual(checkContributionAppend(prev, tampered, 'bob'), ['changes outside the new turn: circuits.1x1.contributions[0]']);

  const policy = structuredClone(next);
  policy.policy.minOutside = 0;
  assert.deepEqual(checkContributionAppend(prev, policy, 'bob'), ['changes outside the new turn: policy']);

  const oldTool = appendTurn(prev, { ...turn('bob', 'e'), toolVersion: '0.9.0' });
  assert.deepEqual(checkContributionAppend(prev, oldTool, 'bob'), ['new turn 2 uses tool 0.9.0, but the manifest requires 1.0.0']);
});

test('checkContributionAppend reports an invalid next manifest instead of throwing', () => {
  const prev = baseManifest();
  const next = appendTurn(prev, turn('bob', 'e')) as unknown as Record<string, unknown>;
  next.version = 3;
  assert.deepEqual(checkContributionAppend(prev, next, 'bob'), ['invalid manifest: version must be 2']);
});
