// ABOUTME: Tests for the coordinator's `accept`: it merges only a PR whose base-branch check passed for its
// ABOUTME: current head (or that passes a local re-verify), copies zkeys to the official release, and frees the turn.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accept, type AcceptDeps } from '../src/accept';
import { contribute, type ContributorDeps } from '../src/contributor';
import { parseManifest } from '../src/manifest';
import { releaseCurve } from '../src/snark';
import { FakeGitHub, type FakePr } from './support/fake-github';
import { TINY_CIRCUITS, buildTinyCeremony, type TinyCeremony } from './support/tiny-ceremony';

const REPO = 'test-org/test-repo';
const TOOL = '9.9.9';
let root: string;
let clock: number;
let gh: FakeGitHub;
let tiny: TinyCeremony;
let fresh: string;
let caseNo = 0;

const cdeps = (): ContributorDeps => ({
  gh, repo: REPO, workRoot: path.join(root, 'work', `c${caseNo}`, gh.user), toolVersion: TOOL,
  now: () => clock, sleep: async () => {}, log: () => {}, download: { fetch: gh.fetch },
});
const adeps = (): AcceptDeps => ({
  gh, repo: REPO, workRoot: path.join(root, 'accept', `c${caseNo}`), log: () => {}, download: { fetch: gh.fetch },
  allowedUrlPattern: `^${gh.baseUrl.replace(/[.]/g, '\\.')}/{author}/releases/download/`,
});
const aopts = (over: Partial<Parameters<typeof accept>[2]> = {}) => ({ r1csFor: () => tiny.r1cs, ptauPath: tiny.ptau, ...over });

async function contributionPr(user: string): Promise<FakePr> {
  gh.user = user;
  const o = await contribute(cdeps());
  assert.equal(o.kind, 'submitted');
  return gh.prs[gh.prs.length - 1];
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-test-'));
  clock = Date.parse('2027-01-05T12:00:00Z');
  gh = new FakeGitHub(REPO, path.join(root, 'assets'), () => clock);
  tiny = await buildTinyCeremony(path.join(root, 'tiny'), gh, clock, TOOL);
  fresh = gh.files.get('ceremony/manifest.json')!;
});

beforeEach(() => {
  caseNo += 1;
  gh.files.set('ceremony/manifest.json', fresh);
  gh.prs = [];
  gh.runs = [];
  gh.comments = [];
  gh.merged = [];
  fs.rmSync(path.join(root, 'assets', REPO), { recursive: true, force: true }); // the official release
  clock += 3 * 60 * 60 * 1000;
});

after(async () => {
  await releaseCurve();
  fs.rmSync(root, { recursive: true, force: true });
});

test('accepts a PR whose contribution check passed for its head', async () => {
  const pr = await contributionPr('alice');
  gh.passCheck(pr.number);
  const r = await accept(adeps(), pr.number, aopts());
  assert.equal(r.turn, 1);
  assert.deepEqual(gh.merged, [{ number: pr.number, headSha: pr.headSha }]);
  for (const id of TINY_CIRCUITS) {
    assert.ok(fs.existsSync(path.join(root, 'assets', REPO, 'releases', 'download', 'ceremony-zkeys', `${id}-0001-alice.zkey`)), `${id} on the official release`);
  }
  assert.equal(parseManifest(JSON.parse(gh.files.get('ceremony/manifest.json')!)).circuits.m1.contributions.length, 1);
  assert.ok(gh.comments.some((c) => /Turn 1 by @alice accepted .*The next contributor may start/.test(c.body)));
});

test('refuses without a passing check run from the base-branch workflow for the current head', async () => {
  const pr = await contributionPr('alice');
  await assert.rejects(accept(adeps(), pr.number, aopts()), /no passing contribution-check \(pull_request_target\) run for head sha-\d+/);
  gh.passCheck(pr.number, { event: 'pull_request' });
  await assert.rejects(accept(adeps(), pr.number, aopts()), /no passing contribution-check/);
  gh.passCheck(pr.number, { conclusion: 'failure' });
  await assert.rejects(accept(adeps(), pr.number, aopts()), /no passing contribution-check/);
  gh.passCheck(pr.number, { path: '.github/workflows/other.yml' });
  await assert.rejects(accept(adeps(), pr.number, aopts()), /no passing contribution-check/);
  gh.passCheck(pr.number);
  pr.headSha = 'sha-pushed-later';
  await assert.rejects(accept(adeps(), pr.number, aopts()), /no passing contribution-check \(pull_request_target\) run for head sha-pushed-later/);
  assert.deepEqual(gh.merged, []);
});

test('refuses a PR that changes any other file, even with a passing run', async () => {
  const pr = await contributionPr('alice');
  pr.files.push({ path: '.github/workflows/contribution-check.yml', content: 'evil' });
  gh.passCheck(pr.number);
  await assert.rejects(accept(adeps(), pr.number, aopts()), /changes files a contribution may not: \.github\/workflows\/contribution-check\.yml/);
  assert.deepEqual(gh.merged, []);
});

test('refuses when a downloaded zkey does not match its pinned hash, before uploading anything', async () => {
  const pr = await contributionPr('alice');
  gh.passCheck(pr.number);
  const m = parseManifest(JSON.parse(pr.files.find((f) => f.path === 'ceremony/manifest.json')!.content));
  const file = path.join(root, 'assets', new URL(m.circuits.m2.contributions[0].mirrors[0].url).pathname);
  fs.appendFileSync(file, 'tampered');
  await assert.rejects(accept(adeps(), pr.number, aopts()), /no URL served m2-0001-alice\.zkey/);
  assert.deepEqual(gh.merged, []);
  assert.equal(fs.existsSync(path.join(root, 'assets', REPO, 'releases', 'download', 'ceremony-zkeys', 'm1-0001-alice.zkey')), false);
});

test('--reverify accepts without a CI run after a full local check in a child process', async () => {
  const pr = await contributionPr('alice');
  const r = await accept(adeps(), pr.number, aopts({ reverify: true }));
  assert.equal(r.reverified, true);
  assert.deepEqual(gh.merged.map((x) => x.number), [pr.number]);
});

test('--reverify refuses a contribution the check rejects', async () => {
  const pr = await contributionPr('alice');
  const wrongR1cs = path.join(root, 'wrong.r1cs');
  fs.writeFileSync(wrongR1cs, 'nope');
  await assert.rejects(accept(adeps(), pr.number, aopts({ reverify: true, r1csFor: () => wrongR1cs })), /local re-verify failed:.*m1 zkey verify: r1cs sha256/s);
  assert.deepEqual(gh.merged, []);
});

test('after accept the next contributor reads heads from the official release', async () => {
  const pr = await contributionPr('alice');
  gh.passCheck(pr.number);
  await accept(adeps(), pr.number, aopts());
  // Alice deletes her fork release; the official copies keep the chain going.
  fs.rmSync(path.join(root, 'assets', 'alice'), { recursive: true, force: true });
  clock += 60_000;
  const next = await contributionPr('bob');
  assert.equal(next.branch, 'ceremony/turn-0002-bob');
});

test('refuses a closed PR and a non-ceremony branch', async () => {
  const pr = await contributionPr('alice');
  gh.passCheck(pr.number);
  pr.branch = 'fix/docs';
  await assert.rejects(accept(adeps(), pr.number, aopts()), /is not a ceremony contribution branch/);
  pr.branch = 'ceremony/turn-0001-alice';
  pr.state = 'closed';
  await assert.rejects(accept(adeps(), pr.number, aopts()), /is closed/);
});

test('refuses a PR opened after the contribution window closed', async () => {
  const pr = await contributionPr('alice');
  gh.passCheck(pr.number);
  const closes = parseManifest(JSON.parse(fresh)).window.closes;
  pr.createdAt = new Date(Date.parse(closes) + 1000).toISOString();
  await assert.rejects(accept(adeps(), pr.number, aopts()), /was opened at .* after the contribution window closed/);
  // One opened before the close can still be accepted afterwards.
  pr.createdAt = new Date(Date.parse(closes) - 1000).toISOString();
  await accept(adeps(), pr.number, aopts());
  assert.equal(gh.merged.length, 1);
});
