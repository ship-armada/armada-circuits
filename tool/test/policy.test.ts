// ABOUTME: Unit tests for participants.json validation and the participant-policy counts finalize enforces.
// ABOUTME: Covers outside/org/BYO counting rules, unclassified contributors and shortfall reporting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantsError, parseParticipants, type Participants } from '../src/participants';
import { computeCounts, policyShortfalls } from '../src/policy';
import { appendTurn, type Manifest, type TurnInput } from '../src/manifest';

const SHA = (ch: string) => ch.repeat(64);
const BLAKE = (ch: string) => ch.repeat(128);

const manifest = (policy: Manifest['policy']): Manifest => ({
  version: 2,
  requiredToolVersion: '1.0.0',
  snarkjsVersion: '0.7.6',
  coordination: { repo: 'ship-armada/armada-circuits', queueIssue: 10, officialReleaseTag: 'ceremony-zkeys' },
  ptau: { sha256: SHA('a'), blake2b: BLAKE('b'), power: 17, mirrors: ['https://circom.info/p.ptau'] },
  window: { opens: '2027-01-01T00:00:00Z', closes: '2027-01-22T00:00:00Z' },
  beacon: { type: 'drand', chainHash: SHA('c'), round: 1000, iterationsExp: 10 },
  policy,
  circuits: {
    '2x2': { r1csSha256: SHA('1'), wasmSha256: SHA('2'), status: 'open', openedAtTurn: 0, base: { zkeySha256: SHA('3'), mirrors: [] }, contributions: [] },
  },
});

const turn = (contributor: string, mode: TurnInput['mode'] = 'tool'): TurnInput => ({
  contributor,
  toolVersion: '1.0.0',
  mode,
  attestation: `ceremony/attestations/${contributor}.json`,
  timestamp: '2027-01-02T10:00:00Z',
  perCircuit: { '2x2': { zkeySha256: SHA('d'), contributionHash: BLAKE('d'), mirrors: [] } },
});

const post = { url: 'https://example.org/post', checkedBy: 'coordinator', checkedAt: '2027-01-03T00:00:00Z' };
const people = (): Participants => ({
  version: 1,
  participants: [
    { handle: 'team1', displayName: 'Team One', org: 'armada', armadaTeam: true },
    { handle: 'alice', displayName: 'Alice', org: 'acme', armadaTeam: false, publicPost: post },
    { handle: 'bob', displayName: 'Bob', org: 'acme', armadaTeam: false, publicPost: post },
    { handle: 'carol', displayName: 'Carol', org: 'independent:carol', armadaTeam: false, publicPost: post },
    { handle: 'dave', displayName: 'Dave', org: 'globex', armadaTeam: false },
  ],
});

test('parseParticipants accepts a valid file', () => {
  assert.equal(parseParticipants(people()).participants.length, 5);
});

test('parseParticipants reports every problem', () => {
  const bad = {
    version: 1,
    participants: [
      { handle: '-bad-', displayName: '', org: 'independent:someone-else', armadaTeam: 'no', publicPost: { url: 'http://x', checkedBy: 'c', checkedAt: 'never' } },
      { handle: 'alice', displayName: 'A', org: 'acme', armadaTeam: false },
      { handle: 'alice', displayName: 'A2', org: 'acme', armadaTeam: false },
    ],
  };
  try {
    parseParticipants(bad);
    assert.fail('expected ParticipantsError');
  } catch (err) {
    assert.ok(err instanceof ParticipantsError);
    assert.deepEqual(err.problems, [
      'participants[0].handle must be a GitHub handle',
      'participants[0].displayName must be a non-empty string',
      'participants[0].org "independent:..." must name the participant\'s own handle',
      'participants[0].armadaTeam must be a boolean',
      'participants[0].publicPost must be { url: https://..., checkedBy: <handle>, checkedAt: <ISO time> }',
      'duplicate participant handle alice',
    ]);
  }
});

test('computeCounts applies the outside/org/BYO rules', () => {
  let m = manifest({ minContributions: 0, minOutside: 0, minOutsideOrgs: 0, minByo: 0 });
  for (const t of [turn('team1'), turn('alice'), turn('bob', 'byo-tool'), turn('alice'), turn('carol'), turn('dave'), turn('zed')]) {
    m = appendTurn(m, t);
  }
  const counts = computeCounts(m, people());
  assert.equal(counts.contributions, 7);
  // team1 is Armada team; dave has no checked public post; zed is unclassified; alice counts once.
  assert.deepEqual(counts.outside, ['alice', 'bob', 'carol']);
  assert.deepEqual(counts.outsideOrgs, ['acme', 'independent:carol']);
  assert.equal(counts.byo, 1);
  assert.deepEqual(counts.unclassified, ['zed']);
});

test('policyShortfalls lists every unmet minimum', () => {
  let m = manifest({ minContributions: 10, minOutside: 5, minOutsideOrgs: 3, minByo: 1 });
  m = appendTurn(m, turn('alice'));
  assert.deepEqual(policyShortfalls(m, people()), [
    'contributions: 1 of 10 required',
    'outside participants: 1 of 5 required',
    'outside organisations: 1 of 3 required',
    'BYO-tool contributions: 0 of 1 required',
  ]);
});

test('policyShortfalls is empty when the policy is met', () => {
  let m = manifest({ minContributions: 3, minOutside: 3, minOutsideOrgs: 2, minByo: 1 });
  for (const t of [turn('alice'), turn('bob', 'byo-tool'), turn('carol')]) m = appendTurn(m, t);
  assert.deepEqual(policyShortfalls(m, people()), []);
});
