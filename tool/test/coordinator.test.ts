// ABOUTME: End-to-end test of the coordinator commands on tiny circuits: init, contributions, add-circuit,
// ABOUTME: finalize (recorded drand round as beacon), verify --full, and release with signed SHA256SUMS.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBn128 } from 'ffjavascript';
import { powersOfTau } from 'snarkjs';
import { accept } from '../src/accept';
import { contribute, type ContributorDeps } from '../src/contributor';
import { DEFAULT_POLICY, addCircuit, announcementText, beaconRoundFor, finalize, init, release, type CoordinatorDeps } from '../src/coordinator';
import { QUICKNET, roundTime, type DrandBeacon } from '../src/drand';
import { sha256File } from '../src/http';
import { parseManifest, type Manifest } from '../src/manifest';
import type { Participants } from '../src/participants';
import { releaseCurve } from '../src/snark';
import { verify } from '../src/verify';
import { FakeGitHub } from './support/fake-github';

const REPO = 'test-org/test-repo';
const TOOL = '9.9.9';
const FIXTURE = path.join(__dirname, '..', '..', 'tool', 'test', 'fixtures');
const ROUND: DrandBeacon = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'drand-quicknet.json'), 'utf8')).rounds[0];

let root: string;
let clock: number;
let gh: FakeGitHub;
let r1cs: string;
let wasm: string;
let ptau: string;
const circuitFiles = (id: string) => ({ id, r1cs, wasm });

const drandFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  return url.endsWith(`/${QUICKNET.hash}/public/${ROUND.round}`) ? new Response(JSON.stringify(ROUND)) : new Response('', { status: 404 });
}) as typeof fetch;

const coord = (): CoordinatorDeps => ({
  gh, repo: REPO, workRoot: path.join(root, 'coordinator'), log: () => {}, now: () => clock,
  download: { fetch: gh.fetch }, drandFetch, drandEndpoints: ['https://drand-a.test', 'https://drand-b.test'],
});
const contributorDeps = (user: string): ContributorDeps => ({
  gh, repo: REPO, workRoot: path.join(root, 'work', user), toolVersion: TOOL,
  now: () => clock, sleep: async () => {}, log: () => {}, download: { fetch: gh.fetch },
});
const setMain = (m: Manifest) => gh.files.set('ceremony/manifest.json', `${JSON.stringify(m, null, 2)}\n`);
const mainManifest = () => parseManifest(JSON.parse(gh.files.get('ceremony/manifest.json')!));

async function contributeAndAccept(user: string): Promise<void> {
  gh.user = user;
  const o = await contribute(contributorDeps(user));
  assert.equal(o.kind, 'submitted', JSON.stringify(o));
  const pr = gh.prs[gh.prs.length - 1];
  gh.passCheck(pr.number);
  await accept({ gh, repo: REPO, workRoot: path.join(root, 'accept', user), log: () => {}, download: { fetch: gh.fetch },
    allowedUrlPattern: `^${gh.baseUrl.replace(/[.]/g, '\\.')}/{author}/releases/download/` }, pr.number, { r1csFor: () => r1cs, ptauPath: ptau });
  clock += 60_000;
}

const OPENS = '2027-01-01T00:00:00Z';
const CLOSES = '2027-01-22T00:00:00Z';
const people: Participants = {
  version: 1,
  participants: [
    { handle: 'alice', displayName: 'Alice', org: 'armada', armadaTeam: true },
    { handle: 'bob', displayName: 'Bob', org: 'acme', armadaTeam: false, publicPost: { url: 'https://example.org/bob', checkedBy: 'alice', checkedAt: '2027-01-10T00:00:00Z' } },
    { handle: 'carol', displayName: 'Carol', org: 'independent:carol', armadaTeam: false, publicPost: { url: 'https://example.org/carol', checkedBy: 'alice', checkedAt: '2027-01-10T00:00:00Z' } },
  ],
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-test-'));
  clock = Date.parse('2027-01-05T12:00:00Z');
  gh = new FakeGitHub(REPO, path.join(root, 'assets'), () => clock);
  const build = path.join(root, 'build');
  fs.mkdirSync(build, { recursive: true });
  execFileSync(process.env.CIRCOM_BIN ?? 'circom', [path.join(FIXTURE, 'multiplier.circom'), '--r1cs', '--wasm', '-o', build], { stdio: 'pipe' });
  r1cs = path.join(build, 'multiplier.r1cs');
  wasm = path.join(build, 'multiplier_js', 'multiplier.wasm');
  const curve = await buildBn128();
  await powersOfTau.newAccumulator(curve, 8, path.join(build, 'pot_0.ptau'));
  await powersOfTau.contribute(path.join(build, 'pot_0.ptau'), path.join(build, 'pot_1.ptau'), 'test', 'test entropy');
  ptau = path.join(build, 'pot_final.ptau');
  await powersOfTau.preparePhase2(path.join(build, 'pot_1.ptau'), ptau);
});

after(async () => {
  await releaseCurve();
  fs.rmSync(root, { recursive: true, force: true });
});

test('beaconRoundFor picks the first quicknet round at least the delay after close', () => {
  const r = beaconRoundFor(CLOSES, 48 * 3600_000);
  assert.ok(roundTime(QUICKNET, r) >= Date.parse(CLOSES) + 48 * 3600_000);
  assert.ok(roundTime(QUICKNET, r - 1) < Date.parse(CLOSES) + 48 * 3600_000);
});

test('init refuses a bad window and an unknown ptau without mirrors', async () => {
  await assert.rejects(init(coord(), { circuits: [circuitFiles('m1')], ptauPath: ptau, opens: CLOSES, closes: OPENS, queueIssue: 1, toolVersion: TOOL }), /opens must be before/);
  await assert.rejects(init(coord(), { circuits: [circuitFiles('m1')], ptauPath: ptau, opens: OPENS, closes: CLOSES, queueIssue: 1, toolVersion: TOOL }),
    /is not the pinned Hermez power-17 ptau; give its mirror URLs/);
});

test('init builds base zkeys, uploads them to the official release and writes a valid manifest', async () => {
  const { manifest, participants } = await init(coord(), {
    circuits: [circuitFiles('m1'), circuitFiles('m2')], ptauPath: ptau, ptauMirrors: ['https://example.org/pot8.ptau'],
    opens: OPENS, closes: CLOSES, queueIssue: 1, toolVersion: TOOL,
    policy: { minContributions: 3, minOutside: 2, minOutsideOrgs: 2, minByo: 0 }, beaconRound: ROUND.round,
  });
  assert.equal(manifest.circuits.m1.r1csSha256, await sha256File(r1cs));
  assert.equal(manifest.circuits.m1.wasmSha256, await sha256File(wasm));
  assert.equal(manifest.circuits.m1.base.mirrors[0].kind, 'official');
  assert.deepEqual(gh.releases.get('ceremony-zkeys')!.files.sort(), ['m1-0000.zkey', 'm2-0000.zkey']);
  assert.equal(manifest.beacon.chainHash, QUICKNET.hash);
  assert.equal(manifest.beacon.round, ROUND.round);
  assert.deepEqual(participants, { version: 1, participants: [] });
  assert.deepEqual(DEFAULT_POLICY, { minContributions: 10, minOutside: 5, minOutsideOrgs: 3, minByo: 1 });
  setMain(manifest);
  gh.files.set('ceremony/participants.json', JSON.stringify(people));
});

test('announcementText states the commitment', () => {
  const t = announcementText(mainManifest());
  for (const s of [REPO, OPENS, CLOSES, `round ${ROUND.round}`, QUICKNET.hash, new Date(roundTime(QUICKNET, ROUND.round)).toISOString(), 'minimum 3 contributions']) {
    assert.ok(t.includes(s), `announcement is missing ${s}`);
  }
});

test('two contributions, then add-circuit, then a third covering all three circuits', async () => {
  await contributeAndAccept('alice');
  await contributeAndAccept('bob');
  const added = await addCircuit(coord(), mainManifest(), circuitFiles('m3'), ptau);
  assert.equal(added.circuits.m3.openedAtTurn, 2);
  setMain(added);
  await contributeAndAccept('carol');
  const m = mainManifest();
  assert.deepEqual(['m1', 'm2', 'm3'].map((id) => m.circuits[id].contributions.length), [3, 3, 1]);
});

test('finalize refuses before the window closes, and while the policy is unmet', async () => {
  await assert.rejects(finalize(coord(), mainManifest(), people, { r1csFor: () => r1cs, ptauPath: ptau }), /the contribution window closes at/);
  clock = Date.parse(CLOSES) + 3 * 86_400_000;
  const short = { ...people, participants: people.participants.filter((p) => p.handle !== 'carol') };
  await assert.rejects(finalize(coord(), mainManifest(), short, { r1csFor: () => r1cs, ptauPath: ptau }), /participant policy not met:\n.*outside participants: 1 of 2 required/s);
});

test('finalize applies the committed drand round and verify --full accepts the result', async () => {
  const { manifest } = await finalize(coord(), mainManifest(), people, { r1csFor: () => r1cs, ptauPath: ptau });
  assert.equal(manifest.beacon.value, ROUND.randomness);
  assert.equal(manifest.beacon.signature, ROUND.signature);
  for (const id of ['m1', 'm2', 'm3']) assert.equal(manifest.circuits[id].status, 'finalized');
  setMain(manifest);
  const cache = path.join(root, 'ptau-cache.ptau');
  fs.copyFileSync(ptau, cache);
  const r = await verify(contributorDeps('verifier'), { full: true, r1csFor: () => r1cs, ptauPath: cache });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /m3: beacon is drand round 1000000/.test(l)));
});

test('finalize refuses to run twice', async () => {
  await assert.rejects(finalize(coord(), mainManifest(), people, { r1csFor: () => r1cs, ptauPath: ptau }), /already finalized/);
});

test('release publishes every artifact with SHA256SUMS, a transcript and a VK bundle', async () => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-'));
  const key = path.join(keyDir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'coordinator', '-f', key]);
  const out = path.join(root, 'release');
  const r = await release(coord(), mainManifest(), people, {
    tag: 'v1.0.0', outDir: out, r1csFor: () => r1cs, wasmFor: () => wasm, ptauPath: ptau, signingKey: key,
  });
  const rel = gh.releases.get('v1.0.0')!;
  assert.equal(rel.draft, true, 'created as a draft for review');
  for (const f of ['m1.zkey', 'm1.vkey.json', 'm1.r1cs', 'm1.wasm', 'm3.zkey', 'pot_final.ptau', 'manifest.json', 'participants.json', 'vkeys.json', 'TRANSCRIPT.md', 'SHA256SUMS', 'SHA256SUMS.sig']) {
    assert.ok(rel.files.includes(f), `release is missing ${f}`);
  }
  // Every SHA256SUMS line matches its file, and every other asset is listed.
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n');
  for (const line of sums) {
    const [sha, name] = line.split(/\s+/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex'), sha, name);
  }
  assert.deepEqual(sums.map((l) => l.split(/\s+/)[1]).sort(), r.assets.filter((a) => !a.startsWith('SHA256SUMS')).sort());
  // The signature verifies with ssh-keygen.
  fs.writeFileSync(path.join(keyDir, 'allowed'), `coordinator ${fs.readFileSync(`${key}.pub`, 'utf8')}`);
  const v = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(keyDir, 'allowed'), '-I', 'coordinator', '-n', 'armada-ceremony', '-s', path.join(out, 'SHA256SUMS.sig')],
    { input: fs.readFileSync(path.join(out, 'SHA256SUMS')) });
  assert.equal(v.status, 0, v.stderr.toString());

  const bundle = JSON.parse(fs.readFileSync(path.join(out, 'vkeys.json'), 'utf8'));
  assert.deepEqual(Object.keys(bundle.circuits).sort(), ['m1', 'm2', 'm3']);
  assert.equal(bundle.circuits.m1.vkeySha256, mainManifest().circuits.m1.final!.vkeySha256);
  // The form docs/ARMADA_POC_HANDOFF.md promises to armada-poc's VK registration and check.
  for (const id of ['m1', 'm2', 'm3']) {
    const vk = bundle.circuits[id].vkey;
    assert.deepEqual([vk.protocol, vk.curve], ['groth16', 'bn128']);
    for (const k of ['vk_alpha_1', 'vk_beta_2', 'vk_gamma_2', 'vk_delta_2', 'IC']) assert.ok(k in vk, `${id} vkey lacks ${k}`);
    assert.equal(vk.IC.length, vk.nPublic + 1);
    assert.deepEqual(vk, JSON.parse(fs.readFileSync(path.join(out, `${id}.vkey.json`), 'utf8')), 'bundle entry is exactly the per-circuit vkey');
    assert.equal(bundle.circuits[id].zkeySha256, mainManifest().circuits[id].final!.zkeySha256);
  }
  assert.equal(bundle.ceremony, REPO);
  assert.equal(bundle.beacon.round, ROUND.round);
  const transcript = fs.readFileSync(path.join(out, 'TRANSCRIPT.md'), 'utf8');
  for (const s of ['@alice', '@bob', '@carol', 'https://example.org/carol', `round ${ROUND.round}`, 'Outside participants | 2', 'coordinator-checked']) {
    assert.ok(transcript.includes(s), `transcript is missing ${s}`);
  }
  fs.rmSync(keyDir, { recursive: true, force: true });
});

test('release refuses an r1cs that does not match the manifest', async () => {
  const wrong = path.join(root, 'wrong.r1cs');
  fs.writeFileSync(wrong, 'x');
  await assert.rejects(release(coord(), mainManifest(), people, {
    tag: 'v1.0.1', outDir: path.join(root, 'release2'), r1csFor: () => wrong, wasmFor: () => wasm, ptauPath: ptau,
  }), /m1: r1cs .* does not match the manifest/);
});

test('init with a custom beacon delay picks the round that long after close', async () => {
  const { manifest } = await init(coord(), {
    circuits: [circuitFiles('m1')], ptauPath: ptau, ptauMirrors: ['https://example.org/pot8.ptau'],
    opens: OPENS, closes: CLOSES, queueIssue: 1, toolVersion: TOOL, beaconDelayMs: 3600_000,
  });
  assert.equal(manifest.beacon.round, beaconRoundFor(CLOSES, 3600_000));
});
