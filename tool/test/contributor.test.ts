// ABOUTME: Flow tests for contribute/submit against a fake GitHub and a tiny two-circuit ceremony with real snarkjs.
// ABOUTME: Covers multi-turn chains, turn held, first-claim-wins back-off, refusals, tampered heads, stale turns and BYO.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attestationProblems } from '../src/attestation';
import { claimBody } from '../src/claim';
import { contribute, submit, type ContributorDeps, type ContributeOutcome } from '../src/contributor';
import { checkContributionAppend, parseManifest, type Manifest } from '../src/manifest';
import { contribute as snarkContribute, readMpcParams, releaseCurve, verifyZkey } from '../src/snark';
import { FakeGitHub, type FakePr } from './support/fake-github';
import { TINY_CIRCUITS, buildTinyCeremony, type TinyCeremony } from './support/tiny-ceremony';

const REPO = 'test-org/test-repo';
const TOOL = '9.9.9';
let root: string;
let clock: number;
let gh: FakeGitHub;
let tiny: TinyCeremony;
let freshManifest: string;
let caseNo = 0;
const logs: string[] = [];

const deps = (over: Partial<ContributorDeps> = {}): ContributorDeps => ({
  gh, repo: REPO, workRoot: path.join(root, 'work', `case-${caseNo}`, gh.user), toolVersion: TOOL,
  now: () => clock, sleep: async (ms) => { clock += ms; }, log: (l) => logs.push(l),
  download: { fetch: gh.fetch }, pollMs: 60_000, ...over,
});

const submitted = (o: ContributeOutcome) => {
  assert.equal(o.kind, 'submitted', `expected submitted, got ${JSON.stringify(o)}`);
  return o as Extract<ContributeOutcome, { kind: 'submitted' }>;
};
const manifestOf = (pr: FakePr): Manifest => parseManifest(JSON.parse(pr.files.find((f) => f.path === 'ceremony/manifest.json')!.content));
const mainManifest = (): Manifest => parseManifest(JSON.parse(gh.files.get('ceremony/manifest.json')!));

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'contributor-test-'));
  clock = Date.parse('2027-01-05T12:00:00Z');
  gh = new FakeGitHub(REPO, path.join(root, 'assets'), () => clock);
  tiny = await buildTinyCeremony(path.join(root, 'tiny'), gh, clock, TOOL);
  freshManifest = gh.files.get('ceremony/manifest.json')!;
});

beforeEach(() => {
  gh.files.set('ceremony/manifest.json', freshManifest);
  gh.comments = [];
  gh.prs = [];
  gh.afterPost = undefined;
  gh.onRead = undefined;
  gh.reads = 0;
  caseNo += 1;
  logs.length = 0;
  clock += 3 * 60 * 60 * 1000; // past any earlier claim's lifetime
});

after(async () => {
  await releaseCurve();
  fs.rmSync(root, { recursive: true, force: true });
});

test('two contributors in turn build a valid chain on every circuit', async () => {
  const prev = mainManifest();
  gh.user = 'alice';
  const a = submitted(await contribute(deps()));
  assert.equal(a.turn, 1);
  const prA = gh.prs.find((p) => p.number === a.pr.number)!;
  assert.equal(prA.branch, 'ceremony/turn-0001-alice');
  const nextA = manifestOf(prA);
  assert.deepEqual(checkContributionAppend(prev, nextA, 'alice'), []);
  const att = JSON.parse(prA.files.find((f) => f.path === 'ceremony/attestations/turn-0001-alice.json')!.content);
  assert.deepEqual(attestationProblems(att, prev, nextA), []);
  assert.ok(gh.comments.some((c) => c.author === 'alice'), 'claim stays until the PR is accepted');
  gh.merge(a.pr.number);

  gh.user = 'bob';
  clock += 60_000;
  const b = submitted(await contribute(deps()));
  assert.equal(b.turn, 2);
  gh.merge(b.pr.number);

  // Bob's zkeys (downloaded from his fork release URLs) carry both contributions and verify.
  const m = mainManifest();
  for (const id of TINY_CIRCUITS) {
    const head = m.circuits[id].contributions[1];
    const file = path.join(root, 'assets', 'bob', 'releases', 'download', 'ceremony-turn-0002', `${id}-0002-bob.zkey`);
    const params = await readMpcParams(file);
    assert.deepEqual(params.contributions.map((c) => c.contributionHash), [m.circuits[id].contributions[0].contributionHash, head.contributionHash]);
    assert.equal((await verifyZkey(tiny.r1cs, tiny.ptau, file)).ok, true);
  }
  assert.match(b.suggestedPost, /turn 2, github\.com\/bob\)\. Attestation sha256: [0-9a-f]{64}/);
});

test('the turn is held by another live claim: no claim is posted', async () => {
  gh.comments.push({ id: 1, author: 'carol', body: claimBody('carol'), createdAt: new Date(clock - 10 * 60_000).toISOString() });
  gh.user = 'dave';
  const o = await contribute(deps());
  assert.equal(o.kind, 'held');
  assert.match((o as { message: string }).message, /@carol claimed the turn .* Try again later, or rerun with --wait/);
  assert.equal(gh.comments.filter((c) => c.author === 'dave').length, 0);
});

test('the turn is held by an open PR whose CI passed', async () => {
  gh.prs.push({ number: 42, author: 'alice', createdAt: new Date(clock - 60_000).toISOString(), state: 'open', ci: 'success', branch: 'ceremony/turn-0001-alice', files: [], title: '', body: '', headSha: 'sha-42' });
  gh.user = 'dave';
  const o = await contribute(deps());
  assert.deepEqual(o, { kind: 'held', message: '@alice is contributing (PR #42, CI passed, waiting for a coordinator). Try again later, or rerun with --wait to start automatically.' });
});

test('first claim wins: a later claim backs off and removes itself', async () => {
  gh.user = 'dave';
  gh.afterPost = () => {
    gh.comments.push({ id: 1, author: 'erin', body: claimBody('erin'), createdAt: new Date(clock - 1_000).toISOString() });
    gh.afterPost = undefined;
  };
  const o = await contribute(deps());
  assert.equal(o.kind, 'held');
  assert.deepEqual(gh.comments.map((c) => c.author), ['erin']);
});

test('--wait polls until the turn frees, then contributes', async () => {
  gh.comments.push({ id: 1, author: 'carol', body: claimBody('carol'), createdAt: new Date(clock - 119 * 60_000).toISOString() });
  gh.user = 'dave';
  const o = submitted(await contribute(deps(), { wait: true }));
  assert.equal(o.turn, 1);
  assert.ok(logs.some((l) => /@carol claimed the turn .* Waiting for the turn/.test(l)));
});

test('refuses a tool version other than the required one, before claiming', async () => {
  gh.user = 'dave';
  await assert.rejects(contribute(deps({ toolVersion: '0.0.1' })), /this tool is version 0\.0\.1, but the ceremony requires 9\.9\.9/);
  assert.equal(gh.comments.length, 0);
});

test('a repo without a ceremony manifest gets a clear error', async () => {
  gh.files.delete('ceremony/manifest.json');
  gh.user = 'dave';
  await assert.rejects(contribute(deps()), /test-org\/test-repo has no ceremony\/manifest\.json on its default branch; the ceremony has not been set up yet/);
});

test('refuses outside the contribution window', async () => {
  gh.user = 'dave';
  await assert.rejects(contribute(deps({ now: () => clock + 60 * 86_400_000 })), /the contribution window closed/);
});

test('a head that does not match its pinned hash aborts and releases the claim', async () => {
  const m = mainManifest();
  const tampered = path.join(root, 'tampered.zkey');
  fs.writeFileSync(tampered, 'not a zkey');
  m.circuits.m1.base.mirrors = [{ kind: 'official', url: gh.host('official/tampered.zkey', tampered) }];
  gh.files.set('ceremony/manifest.json', `${JSON.stringify(m, null, 2)}\n`);
  gh.user = 'dave';
  await assert.rejects(contribute(deps()), /no URL served m1\.zkey with sha256 .*sha256 [0-9a-f]{64} != expected/s);
  assert.equal(gh.comments.length, 0, 'claim removed after the failure');
});

test('a turn accepted while contributing makes the contribution stale before upload', async () => {
  gh.user = 'dave';
  const otherTurn = (() => {
    const m = mainManifest();
    for (const id of TINY_CIRCUITS) {
      m.circuits[id].contributions.push({
        index: 1, turn: 1, contributor: 'zed', zkeySha256: 'a'.repeat(64), contributionHash: 'b'.repeat(128), mirrors: [],
        toolVersion: TOOL, mode: 'tool', attestation: 'ceremony/attestations/turn-0001-zed.json', timestamp: new Date(clock).toISOString(),
      });
    }
    return `${JSON.stringify(m, null, 2)}\n`;
  })();
  gh.onRead = (_p, count) => (count >= 3 ? otherTurn : undefined); // reads: precheck, after claim, before upload
  await assert.rejects(contribute(deps()), /turn 1 was accepted while you were contributing/);
  assert.equal(gh.prs.length, 0);
  assert.equal(gh.comments.length, 0);
});

test('BYO tool: download-only, contribute with plain snarkjs, then submit', async () => {
  gh.user = 'frank';
  const d = await contribute(deps(), { downloadOnly: true });
  assert.equal(d.kind, 'downloaded');
  const { descriptorPath, inputDir } = d as Extract<ContributeOutcome, { kind: 'downloaded' }>;
  assert.ok(gh.comments.some((c) => c.author === 'frank'), 'claim kept for the BYO run');

  const byoDir = path.join(root, 'byo-out');
  fs.mkdirSync(byoDir, { recursive: true });
  for (const id of TINY_CIRCUITS) await snarkContribute(path.join(inputDir, `${id}.zkey`), path.join(byoDir, `${id}.zkey`), { name: 'frank byo' });

  const o = submitted(await submit(deps(), { descriptor: descriptorPath, zkeyDir: byoDir }));
  const next = manifestOf(gh.prs.find((p) => p.number === o.pr.number)!);
  assert.equal(next.circuits.m1.contributions[0].mode, 'byo-tool');
  assert.deepEqual(checkContributionAppend(mainManifest(), next, 'frank'), []);
});

test('submit rejects a BYO zkey set that reuses one secret across circuits', async () => {
  gh.user = 'grace';
  const d = (await contribute(deps(), { downloadOnly: true })) as Extract<ContributeOutcome, { kind: 'downloaded' }>;
  const byoDir = path.join(root, 'byo-same');
  fs.mkdirSync(byoDir, { recursive: true });
  // Same base zkey on both circuits + one contribution copied to both = one secret used twice.
  await snarkContribute(path.join(d.inputDir, 'm1.zkey'), path.join(byoDir, 'm1.zkey'), { name: 'reused' });
  fs.copyFileSync(path.join(byoDir, 'm1.zkey'), path.join(byoDir, 'm2.zkey'));
  await assert.rejects(submit(deps(), { descriptor: d.descriptorPath, zkeyDir: byoDir }), /circuits m1 and m2 were contributed with the same secret/);
  assert.equal(gh.prs.length, 0);
});
