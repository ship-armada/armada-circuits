// ABOUTME: Tests for the CI entry point's PR loading: only the ceremony files a contribution may change are read.
// ABOUTME: Uses the fake GitHub; the check itself is covered by check.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadPrData } from '../src/ci-check';
import { appendTurn, type Manifest } from '../src/manifest';
import { FakeGitHub } from './support/fake-github';

const SHA = (c: string) => c.repeat(64);
const prev: Manifest = {
  version: 2, requiredToolVersion: '1', snarkjsVersion: '0.7.6',
  coordination: { repo: 'o/r', queueIssue: 1, officialReleaseTag: 'ceremony-zkeys' },
  ptau: { sha256: SHA('a'), blake2b: 'b'.repeat(128), power: 17, mirrors: ['https://x.test/p'] },
  window: { opens: '2027-01-01T00:00:00Z', closes: '2027-02-01T00:00:00Z' },
  beacon: { type: 'drand', chainHash: SHA('c'), round: 1, iterationsExp: 10 },
  policy: { minContributions: 0, minOutside: 0, minOutsideOrgs: 0, minByo: 0 },
  circuits: { m1: { r1csSha256: SHA('1'), wasmSha256: SHA('2'), status: 'open', openedAtTurn: 0, base: { zkeySha256: SHA('3'), mirrors: [] }, contributions: [] } },
};

test('loadPrData reads the PR head and only the allowed ceremony files', async () => {
  const gh = new FakeGitHub('o/r', path.join(os.tmpdir(), 'ci-check-test'), () => 0);
  gh.user = 'alice';
  const next = appendTurn(prev, {
    contributor: 'alice', toolVersion: '1', mode: 'tool', attestation: 'ceremony/attestations/turn-0001-alice.json', timestamp: '2027-01-02T00:00:00Z',
    perCircuit: { m1: { zkeySha256: SHA('d'), contributionHash: 'e'.repeat(128), mirrors: [] } },
  });
  const pr = await gh.openPullRequest('o/r', 'ceremony/turn-0001-alice', [
    { path: 'ceremony/manifest.json', content: JSON.stringify(next) },
    { path: 'ceremony/attestations/turn-0001-alice.json', content: '{"a":1}' },
    { path: 'scripts/evil.sh', content: 'rm -rf /' },
  ], 't', 'b');
  const { info, data } = await loadPrData(gh, 'o/r', pr.number, prev);
  assert.equal(info.headSha, `sha-${pr.number}`);
  assert.deepEqual(data.changedFiles, ['ceremony/manifest.json', 'ceremony/attestations/turn-0001-alice.json', 'scripts/evil.sh']);
  assert.deepEqual(Object.keys(data.files).sort(), ['ceremony/attestations/turn-0001-alice.json', 'ceremony/manifest.json'], 'other files are never fetched');
  assert.equal(data.author, 'alice');
  assert.equal(data.headRef, 'ceremony/turn-0001-alice');
});
