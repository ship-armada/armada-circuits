// ABOUTME: Tests for `status` and `verify` on a tiny ceremony: history checks, --mine, --full and beacon binding.
// ABOUTME: The finalized case applies a recorded quicknet round as the beacon, so beacon binding is checked offline.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimBody } from '../src/claim';
import { contribute, type ContributorDeps } from '../src/contributor';
import { QUICKNET, type DrandBeacon } from '../src/drand';
import { sha256File } from '../src/http';
import { parseManifest, type Manifest } from '../src/manifest';
import { applyBeacon, exportVkey, releaseCurve } from '../src/snark';
import { status, verify } from '../src/verify';
import { FakeGitHub } from './support/fake-github';
import { TINY_CIRCUITS, buildTinyCeremony, type TinyCeremony } from './support/tiny-ceremony';

const REPO = 'test-org/test-repo';
const TOOL = '9.9.9';
const ROUND: DrandBeacon = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tool', 'test', 'fixtures', 'drand-quicknet.json'), 'utf8')).rounds[0];
let root: string;
let clock: number;
let gh: FakeGitHub;
let tiny: TinyCeremony;
let afterTwoTurns: string;

const deps = (sub: string): ContributorDeps => ({
  gh, repo: REPO, workRoot: path.join(root, 'work', sub), toolVersion: TOOL,
  now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {}, download: { fetch: gh.fetch },
});
const opts = (over: Partial<Parameters<typeof verify>[1]> = {}): Parameters<typeof verify>[1] => ({
  r1csFor: () => tiny.r1cs, ptauPath: path.join(root, 'ptau-cache', 'pot.ptau'), ...over,
});
const setManifest = (m: Manifest) => gh.files.set('ceremony/manifest.json', `${JSON.stringify(m, null, 2)}\n`);

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  clock = Date.parse('2027-01-05T12:00:00Z');
  gh = new FakeGitHub(REPO, path.join(root, 'assets'), () => clock);
  tiny = await buildTinyCeremony(path.join(root, 'tiny'), gh, clock, TOOL);
  fs.mkdirSync(path.join(root, 'ptau-cache'), { recursive: true });
  fs.copyFileSync(tiny.ptau, path.join(root, 'ptau-cache', 'pot.ptau'));
  for (const user of ['alice', 'bob']) {
    gh.user = user;
    const o = await contribute(deps(user));
    assert.equal(o.kind, 'submitted');
    gh.merge((o as { pr: { number: number } }).pr.number);
    clock += 60_000;
  }
  afterTwoTurns = gh.files.get('ceremony/manifest.json')!;
});

after(async () => {
  await releaseCurve();
  fs.rmSync(root, { recursive: true, force: true });
});

test('status reports the turn, the holder and your contributions', async () => {
  gh.files.set('ceremony/manifest.json', afterTwoTurns);
  gh.user = 'alice';
  const s = await status(deps('status'));
  assert.equal(s.lastTurn, 2);
  assert.deepEqual(s.openCircuits, TINY_CIRCUITS);
  assert.deepEqual(s.yourTurns, [1]);
  assert.equal(s.turn.held, false, "bob's claim was consumed by his merged PR");
  assert.ok(s.lines.some((l) => /required tool version: 9\.9\.9 \(this tool: 9\.9\.9\)/.test(l)));
  gh.comments.push({ id: 7, author: 'carol', body: claimBody('carol'), createdAt: new Date(clock).toISOString() });
  const held = await status(deps('status'));
  assert.equal(held.turn.held && held.turn.holder, 'carol');
  assert.ok(held.lines.includes(`turn: held by @carol (claim since ${new Date(clock).toISOString()})`));
  gh.comments = gh.comments.filter((c) => c.id !== 7);
});

test('verify checks every head against the manifest history', async () => {
  gh.files.set('ceremony/manifest.json', afterTwoTurns);
  const r = await verify(deps('v1'), opts());
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /m1: 2 contributions match the manifest/.test(l)));
});

test('verify --mine confirms the user\'s contributions are in every head', async () => {
  gh.files.set('ceremony/manifest.json', afterTwoTurns);
  gh.user = 'alice';
  const r = await verify(deps('v2'), opts({ mine: true }));
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /@alice's turn 1 is in m1/.test(l)));
  gh.user = 'carol';
  const none = await verify(deps('v3'), opts({ mine: true }));
  assert.equal(none.ok, false);
  assert.ok(none.lines.some((l) => /@carol has no contributions in this ceremony/.test(l)));
});

test('verify fails when the manifest history does not match the zkey', async () => {
  const m = parseManifest(JSON.parse(afterTwoTurns));
  m.circuits.m2.contributions[0].contributionHash = 'e'.repeat(128);
  setManifest(m);
  const r = await verify(deps('v4'), opts());
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /m2: contribution 1 hash does not match the manifest/.test(l)), r.lines.join('\n'));
});

test('verify --full runs zkey verify against the r1cs and pinned ptau', async () => {
  gh.files.set('ceremony/manifest.json', afterTwoTurns);
  const r = await verify(deps('v5'), opts({ full: true }));
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /m1: zkey verify OK/.test(l)));
  const wrongR1cs = path.join(root, 'wrong.r1cs');
  fs.writeFileSync(wrongR1cs, 'nope');
  const bad = await verify(deps('v6'), opts({ full: true, r1csFor: () => wrongR1cs }));
  assert.equal(bad.ok, false);
  assert.ok(bad.lines.some((l) => /m1: r1cs sha256 .* does not match the manifest/.test(l)));
});

/** Finalize by hand (the coordinator command comes in M4): beacon from a recorded quicknet round. */
async function finalizedManifest(beaconHash: string): Promise<Manifest> {
  const m = parseManifest(JSON.parse(afterTwoTurns));
  m.beacon = { type: 'drand', chainHash: QUICKNET.hash, round: ROUND.round, iterationsExp: 10, value: ROUND.randomness, signature: ROUND.signature };
  for (const id of TINY_CIRCUITS) {
    const head = path.join(root, 'assets', 'bob', 'releases', 'download', 'ceremony-turn-0002', `${id}-0002-bob.zkey`);
    const out = path.join(root, `final-${id}-${beaconHash.slice(0, 6)}.zkey`);
    await applyBeacon(head, out, 'beacon', beaconHash, 10);
    const vkey = path.join(root, `vkey-${id}.json`);
    fs.writeFileSync(vkey, JSON.stringify(await exportVkey(out)));
    m.circuits[id].status = 'finalized';
    m.circuits[id].final = {
      zkeySha256: await sha256File(out), vkeySha256: await sha256File(vkey),
      mirrors: [{ kind: 'official', url: gh.host(`official/final-${id}-${beaconHash.slice(0, 6)}.zkey`, out) }],
    };
  }
  return m;
}

test('verify of a finalized ceremony checks the beacon is the committed drand round', async () => {
  setManifest(await finalizedManifest(ROUND.randomness));
  const r = await verify(deps('v7'), opts({ full: true }));
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /m1: beacon is drand round 1000000/.test(l)));
});

test('verify rejects a final zkey whose beacon is not the committed round', async () => {
  setManifest(await finalizedManifest('ab'.repeat(32)));
  const r = await verify(deps('v8'), opts());
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /m1: beacon hash .* is not the committed drand randomness/.test(l)), r.lines.join('\n'));
});

test('verify rejects a committed round whose signature does not verify', async () => {
  const m = await finalizedManifest(ROUND.randomness);
  m.beacon.signature = `${m.beacon.signature!.slice(0, -2)}00`;
  setManifest(m);
  const r = await verify(deps('v9'), opts());
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /beacon: round 1000000 does not verify against drand quicknet/.test(l)), r.lines.join('\n'));
});

test('verify needs the beacon recorded once the ceremony is finalized', async () => {
  const m = await finalizedManifest(ROUND.randomness);
  delete m.beacon.value;
  setManifest(m);
  const r = await verify(deps('v10'), opts());
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /beacon: finalized, but no beacon value and signature are recorded/.test(l)));
});
