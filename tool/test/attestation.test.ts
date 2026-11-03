// ABOUTME: Unit tests for contribution attestations: canonical JSON, file path, hash and manifest consistency.
// ABOUTME: The attestation sha256 is what contributors post publicly, so its bytes must be reproducible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  ATTESTATION_STATEMENT,
  attestationPath,
  attestationProblems,
  buildAttestation,
  canonicalJson,
  serializeAttestation,
} from '../src/attestation';
import { appendTurn, type Manifest, type Mirror } from '../src/manifest';

const SHA = (ch: string) => ch.repeat(64);
const BLAKE = (ch: string) => ch.repeat(128);

const manifest = (): Manifest => ({
  version: 2,
  requiredToolVersion: '1.0.0',
  snarkjsVersion: '0.7.6',
  coordination: { repo: 'ship-armada/armada-circuits', queueIssue: 10, officialReleaseTag: 'ceremony-zkeys' },
  ptau: { sha256: SHA('a'), blake2b: BLAKE('b'), power: 17, mirrors: ['https://circom.info/p.ptau'] },
  window: { opens: '2027-01-01T00:00:00Z', closes: '2027-01-22T00:00:00Z' },
  beacon: { type: 'drand', chainHash: SHA('c'), round: 1000, iterationsExp: 10 },
  policy: { minContributions: 0, minOutside: 0, minOutsideOrgs: 0, minByo: 0 },
  circuits: {
    '1x1': { r1csSha256: SHA('1'), wasmSha256: SHA('2'), status: 'open', openedAtTurn: 0, base: { zkeySha256: SHA('3'), mirrors: [] }, contributions: [] },
    '2x2': { r1csSha256: SHA('4'), wasmSha256: SHA('5'), status: 'open', openedAtTurn: 0, base: { zkeySha256: SHA('6'), mirrors: [] }, contributions: [] },
  },
});

const att = () => buildAttestation({
  ceremony: 'ship-armada/armada-circuits',
  turn: 1,
  contributor: 'alice',
  mode: 'tool',
  toolVersion: '1.0.0',
  timestamp: '2027-01-02T10:00:00Z',
  circuits: {
    '2x2': { previousZkeySha256: SHA('6'), zkeySha256: SHA('d'), contributionHash: BLAKE('d') },
    '1x1': { previousZkeySha256: SHA('3'), zkeySha256: SHA('e'), contributionHash: BLAKE('e') },
  },
});

const nextManifest = (a = att()) => appendTurn(manifest(), {
  contributor: a.contributor,
  toolVersion: a.toolVersion,
  mode: a.mode,
  attestation: attestationPath(a.turn, a.contributor),
  timestamp: a.timestamp,
  perCircuit: Object.fromEntries(Object.entries(a.circuits).map(([id, c]) => [id, { zkeySha256: c.zkeySha256, contributionHash: c.contributionHash, mirrors: [] as Mirror[] }])),
});

test('canonicalJson sorts keys at every level and ends with a newline', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{\n  "a": {\n    "c": "x",\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
});

test('serializeAttestation is independent of key order and hashes the exact bytes', () => {
  const a = att();
  const shuffled = JSON.parse(JSON.stringify({ ...a, circuits: { '1x1': a.circuits['1x1'], '2x2': a.circuits['2x2'] } }));
  const one = serializeAttestation(a);
  const two = serializeAttestation(shuffled);
  assert.equal(one.text, two.text);
  assert.equal(one.sha256, crypto.createHash('sha256').update(one.text).digest('hex'));
  assert.ok(one.text.includes(ATTESTATION_STATEMENT));
});

test('attestationPath is zero-padded by turn', () => {
  assert.equal(attestationPath(3, 'alice'), 'ceremony/attestations/turn-0003-alice.json');
});

test('attestationProblems accepts an attestation matching the new manifest turn', () => {
  assert.deepEqual(attestationProblems(att(), manifest(), nextManifest()), []);
});

test('attestationProblems reports every mismatch', () => {
  const a = att();
  const wrong = JSON.parse(JSON.stringify(a));
  wrong.turn = 2;
  wrong.contributor = 'bob';
  wrong.circuits['1x1'].zkeySha256 = SHA('f');
  wrong.circuits['2x2'].previousZkeySha256 = SHA('0');
  delete wrong.statement;
  assert.deepEqual(attestationProblems(wrong, manifest(), nextManifest(a)), [
    'attestation.statement must be the standard statement',
    'attestation turn 2 does not match manifest turn 1',
    'attestation contributor bob does not match manifest contributor alice',
    'attestation 1x1.zkeySha256 does not match the manifest',
    'attestation 2x2.previousZkeySha256 is not the previous head of 2x2',
  ]);
});

test('attestationProblems requires exactly the turn\'s circuits', () => {
  const a = att();
  const missing = JSON.parse(JSON.stringify(a));
  delete missing.circuits['2x2'];
  assert.deepEqual(attestationProblems(missing, manifest(), nextManifest(a)), ['attestation circuits must be exactly 1x1, 2x2']);
  assert.deepEqual(attestationProblems('not an object', manifest(), nextManifest(a)), ['attestation must be a JSON object']);
});
