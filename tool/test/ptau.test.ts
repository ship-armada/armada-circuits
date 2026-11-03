// ABOUTME: Tests for the phase-1 ptau fetcher (mirror fallback, sha256 + blake2b checks, cache) and transcript verify.
// ABOUTME: Mirrors are served by a local HTTP server; the transcript test uses a power-4 ptau built in a temp dir.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildBn128 } from 'ffjavascript';
import { powersOfTau } from 'snarkjs';
import { HERMEZ_17, fetchPtau, hashFile, verifyPtauTranscript } from '../src/ptau';
import { releaseCurve } from '../src/snark';

const GOOD = crypto.randomBytes(200_000);
const BAD = crypto.randomBytes(200_000);
const sha256 = crypto.createHash('sha256').update(GOOD).digest('hex');
const blake2b = crypto.createHash('blake2b512').update(GOOD).digest('hex');

let server: http.Server;
let base: string;
let dir: string;
const requests: string[] = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptau-test-'));
  server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/good.ptau') res.end(GOOD);
    else if (req.url === '/bad.ptau') res.end(BAD);
    else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseCurve();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pinned = { sha256, blake2b };

test('falls back past a missing mirror and a wrong file to the first good one', async () => {
  requests.length = 0;
  const dest = path.join(dir, 'a.ptau');
  const res = await fetchPtau({ ...pinned, mirrors: [`${base}/missing.ptau`, `${base}/bad.ptau`, `${base}/good.ptau`], dest, allowHttp: true });
  assert.equal(res.url, `${base}/good.ptau`);
  assert.equal(res.downloaded, true);
  assert.deepEqual(fs.readFileSync(dest), GOOD);
  assert.deepEqual(requests, ['/missing.ptau', '/bad.ptau', '/good.ptau']);
  assert.equal(fs.existsSync(`${dest}.partial`), false);
});

test('uses an existing file with the pinned hashes without downloading', async () => {
  requests.length = 0;
  const dest = path.join(dir, 'b.ptau');
  fs.writeFileSync(dest, GOOD);
  const res = await fetchPtau({ ...pinned, mirrors: [`${base}/good.ptau`], dest, allowHttp: true });
  assert.equal(res.downloaded, false);
  assert.deepEqual(requests, []);
});

test('replaces an existing file whose hashes do not match', async () => {
  const dest = path.join(dir, 'c.ptau');
  fs.writeFileSync(dest, BAD);
  const res = await fetchPtau({ ...pinned, mirrors: [`${base}/good.ptau`], dest, allowHttp: true });
  assert.equal(res.downloaded, true);
  assert.deepEqual(fs.readFileSync(dest), GOOD);
});

test('fails with every mirror reason when no mirror has the pinned file', async () => {
  const dest = path.join(dir, 'd.ptau');
  await assert.rejects(
    fetchPtau({ ...pinned, mirrors: [`${base}/missing.ptau`, `${base}/bad.ptau`], dest, allowHttp: true }),
    (err: Error) => {
      assert.match(err.message, /no mirror served the pinned ptau/);
      assert.match(err.message, /missing\.ptau: HTTP 404/);
      assert.match(err.message, /bad\.ptau: sha256 [0-9a-f]{64} != pinned/);
      return true;
    },
  );
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.partial`), false);
});

test('refuses plain-http mirrors unless allowed (tests only)', async () => {
  await assert.rejects(fetchPtau({ ...pinned, mirrors: [`${base}/good.ptau`], dest: path.join(dir, 'e.ptau') }), /must be https/);
});

test('a matching sha256 is not enough: blake2b is checked too', async () => {
  const dest = path.join(dir, 'f.ptau');
  await assert.rejects(
    fetchPtau({ sha256, blake2b: '0'.repeat(128), mirrors: [`${base}/good.ptau`], dest, allowHttp: true }),
    /blake2b [0-9a-f]{128} != pinned/,
  );
});

test('hashFile returns both hashes', async () => {
  const p = path.join(dir, 'g.bin');
  fs.writeFileSync(p, GOOD);
  assert.deepEqual(await hashFile(p), { sha256, blake2b });
});

test('verifyPtauTranscript accepts a real ptau and rejects a corrupted one', async () => {
  const curve = await buildBn128();
  const p0 = path.join(dir, 'pot_0.ptau');
  const p1 = path.join(dir, 'pot_1.ptau');
  const final = path.join(dir, 'pot_final.ptau');
  await powersOfTau.newAccumulator(curve, 4, p0);
  await powersOfTau.contribute(p0, p1, 'test', 'test entropy');
  await powersOfTau.preparePhase2(p1, final);
  assert.equal((await verifyPtauTranscript(final)).ok, true);

  const bytes = fs.readFileSync(final);
  bytes[bytes.length - 200] ^= 0xff;
  const bad = path.join(dir, 'pot_bad.ptau');
  fs.writeFileSync(bad, bytes);
  assert.equal((await verifyPtauTranscript(bad)).ok, false);
});

test('the ptau pinned in CI is HERMEZ_17', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, new RegExp(`PTAU_SHA256: ${HERMEZ_17.sha256}\\b`));
  assert.match(ci, new RegExp(`PTAU_URL: ${HERMEZ_17.mirrors[0].replace(/[.]/g, '\\.')}\\b`));
});
