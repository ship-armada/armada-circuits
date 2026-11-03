// ABOUTME: Tests for the CI contribution check: a real contribution PR passes, and each hostile variant fails.
// ABOUTME: PRs are produced by the real contribute flow on a fake GitHub and a tiny two-circuit ceremony.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attestationPath, buildAttestation, headZkeySha256, serializeAttestation } from '../src/attestation';
import { checkSummary, githubReleaseUrlAllowed, runContributionCheck, type CheckEnv, type PrData } from '../src/check';
import { contribute, type ContributorDeps } from '../src/contributor';
import { sha256File } from '../src/http';
import { appendTurn, parseManifest, type Manifest } from '../src/manifest';
import { contribute as snarkContribute, readMpcParams, releaseCurve } from '../src/snark';
import { FakeGitHub, type FakePr } from './support/fake-github';
import { buildTinyCeremony, type TinyCeremony } from './support/tiny-ceremony';

const REPO = 'test-org/test-repo';
const TOOL = '9.9.9';
let root: string;
let clock: number;
let gh: FakeGitHub;
let tiny: TinyCeremony;
let prev: Manifest;
let pr: FakePr;
let caseNo = 0;

const deps = (): ContributorDeps => ({
  gh, repo: REPO, workRoot: path.join(root, 'work', `c${caseNo}`), toolVersion: TOOL,
  now: () => clock, sleep: async () => {}, log: () => {}, download: { fetch: gh.fetch },
});
const env = (over: Partial<CheckEnv> = {}): CheckEnv => ({
  prevManifest: prev, r1csFor: () => tiny.r1cs, ptauPath: tiny.ptau, workDir: path.join(root, 'check', `c${caseNo}`),
  download: { fetch: gh.fetch }, urlAllowed: (url, author) => url.startsWith(`${gh.baseUrl}/${author}/releases/download/`), ...over,
});
const prData = (p: FakePr, over: Partial<PrData> = {}): PrData => ({
  author: p.author,
  headRef: p.branch,
  changedFiles: p.files.map((f) => f.path),
  files: Object.fromEntries(p.files.map((f) => [f.path, f.content])),
  ...over,
});
const failed = (r: Awaited<ReturnType<typeof runContributionCheck>>) => r.items.filter((i) => !i.ok).map((i) => `${i.name}: ${i.detail}`);
const manifestText = (m: Manifest) => `${JSON.stringify(m, null, 2)}\n`;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-test-'));
  clock = Date.parse('2027-01-05T12:00:00Z');
  gh = new FakeGitHub(REPO, path.join(root, 'assets'), () => clock);
  tiny = await buildTinyCeremony(path.join(root, 'tiny'), gh, clock, TOOL);
  prev = parseManifest(JSON.parse(gh.files.get('ceremony/manifest.json')!));
  gh.user = 'alice';
  const o = await contribute(deps());
  assert.equal(o.kind, 'submitted');
  pr = gh.prs[0];
});

beforeEach(() => {
  caseNo += 1;
});

after(async () => {
  await releaseCurve();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a real contribution PR passes every check', async () => {
  const r = await runContributionCheck(prData(pr), env());
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
  for (const name of ['files', 'manifest', 'attestation', 'm1 download', 'm1 history', 'm1 zkey verify', 'm2 zkey verify', 'distinct secrets']) {
    assert.ok(r.items.some((i) => i.name === name && i.ok), `missing passing check ${name}`);
  }
});

test('a non-ceremony branch is skipped', async () => {
  const r = await runContributionCheck(prData(pr, { headRef: 'fix/docs' }), env());
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('changing any other file fails', async () => {
  const r = await runContributionCheck(prData(pr, { changedFiles: [...pr.files.map((f) => f.path), '.github/workflows/contribution-check.yml'] }), env());
  assert.equal(r.ok, false);
  assert.match(failed(r)[0], /^files: .*\.github\/workflows\/contribution-check\.yml/);
});

test('a PR by someone other than the turn\'s contributor fails', async () => {
  // Submitting alice's files as mallory: the attestation is named for alice, so the file check stops it.
  const r = await runContributionCheck(prData(pr, { author: 'mallory' }), env());
  assert.equal(r.ok, false);
  assert.match(failed(r)[0], /^files: changes files a contribution may not: ceremony\/attestations\/turn-0001-alice\.json/);
  // Renaming the attestation too: the manifest rule still ties the turn to its contributor.
  const files = { ...prData(pr).files };
  files[attestationPath(1, 'mallory')] = files[attestationPath(1, 'alice')];
  delete files[attestationPath(1, 'alice')];
  const renamed = await runContributionCheck(prData(pr, { author: 'mallory', files, changedFiles: Object.keys(files) }), env());
  assert.equal(renamed.ok, false);
  assert.match(failed(renamed)[0], /^manifest: new turn 1 is by alice, but the PR author is mallory/);
});

test('a zkey that does not match its declared sha256 fails', async () => {
  const url = manifestOfPr().circuits.m1.contributions[0].mirrors[0].url;
  const file = path.join(root, 'assets', new URL(url).pathname);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from('x')]));
  try {
    const r = await runContributionCheck(prData(pr), env());
    assert.equal(r.ok, false);
    assert.ok(failed(r).some((f) => /^m1 download: .*sha256 [0-9a-f]{64} != expected/s.test(f)), failed(r).join('\n'));
  } finally {
    fs.writeFileSync(file, original);
  }
});

function manifestOfPr(): Manifest {
  return parseManifest(JSON.parse(pr.files.find((f) => f.path === 'ceremony/manifest.json')!.content));
}

test('a zkey URL outside the PR author\'s own releases fails', async () => {
  const m = manifestOfPr();
  m.circuits.m1.contributions[0].mirrors = [{ kind: 'fork', url: `${gh.baseUrl}/someone-else/releases/download/x/m1.zkey` }];
  const files = { ...prData(pr).files, 'ceremony/manifest.json': manifestText(m) };
  const r = await runContributionCheck(prData(pr, { files }), env());
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((f) => /^m1 download: URL is not a release asset of @alice/.test(f)), failed(r).join('\n'));
});

test('an oversized zkey fails without filling the disk', async () => {
  const r = await runContributionCheck(prData(pr), env({ maxZkeyBytes: 1000 }));
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((f) => /^m1 download: .*exceeds the 1000-byte limit/s.test(f)), failed(r).join('\n'));
});

test('an attestation that is not in canonical form fails', async () => {
  const p = attestationPath(1, 'alice');
  const files = { ...prData(pr).files, [p]: JSON.stringify(JSON.parse(prData(pr).files[p])) };
  const r = await runContributionCheck(prData(pr, { files }), env());
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((f) => /^attestation: not in canonical form/.test(f)));
});

/** Build a PR by hand (bypassing the contributor tool's own checks) from per-circuit zkeys. */
async function handmadePr(author: string, zkeys: Record<string, string>, mutate?: (m: Manifest) => void): Promise<PrData> {
  const perCircuit: Parameters<typeof appendTurn>[1]['perCircuit'] = {};
  const circuits: Record<string, { previousZkeySha256: string; zkeySha256: string; contributionHash: string }> = {};
  for (const [id, file] of Object.entries(zkeys)) {
    const url = gh.host(`${author}/releases/download/ceremony-turn-0001/${id}-0001-${author}.zkey`, file);
    const params = await readMpcParams(file);
    const contributionHash = params.contributions[params.contributions.length - 1].contributionHash;
    const zkeySha256 = await sha256File(file);
    perCircuit[id] = { zkeySha256, contributionHash, mirrors: [{ kind: 'fork', url }] };
    circuits[id] = { previousZkeySha256: headZkeySha256(prev, id), zkeySha256, contributionHash };
  }
  const timestamp = new Date(clock).toISOString();
  const next = appendTurn(prev, { contributor: author, toolVersion: TOOL, mode: 'byo-tool', attestation: attestationPath(1, author), timestamp, perCircuit });
  mutate?.(next);
  const att = buildAttestation({ ceremony: REPO, turn: 1, contributor: author, mode: 'byo-tool', toolVersion: TOOL, timestamp, circuits });
  return {
    author,
    headRef: `ceremony/turn-0001-${author}`,
    changedFiles: ['ceremony/manifest.json', attestationPath(1, author)],
    files: { 'ceremony/manifest.json': manifestText(next), [attestationPath(1, author)]: serializeAttestation(att).text },
  };
}

test('one secret reused across circuits fails', async () => {
  const dir = path.join(root, 'reuse');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(root, 'tiny', 'm1-0000.zkey');
  await snarkContribute(base, path.join(dir, 'm1.zkey'), { name: 'reused' });
  fs.copyFileSync(path.join(dir, 'm1.zkey'), path.join(dir, 'm2.zkey'));
  const r = await runContributionCheck(await handmadePr('bob', { m1: path.join(dir, 'm1.zkey'), m2: path.join(dir, 'm2.zkey') }), env());
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((f) => /^distinct secrets: m1 and m2 were contributed with the same secret/.test(f)), failed(r).join('\n'));
});

test('a zkey whose history does not extend the merged chain fails', async () => {
  // Two contributions in one zkey: the history has one entry more than the merged chain plus one.
  const dir = path.join(root, 'double');
  fs.mkdirSync(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const id of ['m1', 'm2']) {
    await snarkContribute(path.join(root, 'tiny', `${id}-0000.zkey`), path.join(dir, `${id}-a.zkey`), { name: 'a' });
    await snarkContribute(path.join(dir, `${id}-a.zkey`), path.join(dir, `${id}.zkey`), { name: 'b' });
    out[id] = path.join(dir, `${id}.zkey`);
  }
  const r = await runContributionCheck(await handmadePr('carol', out), env());
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((f) => /^m1 history: zkey has 2 contributions; expected 1/.test(f)), failed(r).join('\n'));
});

test('a zkey built for a different r1cs fails zkey verify', async () => {
  const wrong = path.join(root, 'wrong.r1cs');
  fs.writeFileSync(wrong, 'not the circuit');
  const r = await runContributionCheck(prData(pr), env({ r1csFor: () => wrong }));
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((f) => /^m1 zkey verify: r1cs sha256 .* does not match the manifest/.test(f)));
});

test('githubReleaseUrlAllowed accepts only zkey assets on the author\'s own releases', () => {
  const ok = 'https://github.com/Alice/armada-circuits/releases/download/ceremony-turn-0001/1x1-0001-alice.zkey';
  assert.equal(githubReleaseUrlAllowed(ok, 'alice'), true, 'owner match is case-insensitive');
  for (const bad of [
    'https://github.com/bob/armada-circuits/releases/download/t/1x1.zkey',
    'http://github.com/alice/armada-circuits/releases/download/t/1x1.zkey',
    'https://github.com/alice/armada-circuits/releases/download/t/1x1.zkey?x=1',
    'https://github.com/alice/armada-circuits/releases/download/t/../../evil.zkey',
    'https://github.com.evil.example/alice/r/releases/download/t/1x1.zkey',
    'https://objects.githubusercontent.com/alice/1x1.zkey',
    'https://github.com/alice/armada-circuits/releases/download/t/1x1.ptau',
  ]) assert.equal(githubReleaseUrlAllowed(bad, 'alice'), false, bad);
});

test('checkSummary renders a verdict and one row per check', () => {
  const md = checkSummary({ ok: false, items: [{ name: 'files', ok: true, detail: 'a|b' }, { name: 'manifest', ok: false, detail: 'bad' }] });
  assert.match(md, /Contribution checks FAILED\./);
  assert.match(md, /\| ✅ \| files \| a\\\|b \|/);
  assert.match(md, /\| ❌ \| manifest \| bad \|/);
});
