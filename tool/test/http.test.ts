// ABOUTME: Tests for the shared download helpers: mirror fallback with sha256 checks and the download size cap.
// ABOUTME: Uses an injected fetch, so no network or local server is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadToFile, downloadVerified } from '../src/http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-test-'));
const GOOD = crypto.randomBytes(50_000);
const sha = crypto.createHash('sha256').update(GOOD).digest('hex');
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith('/good')) return new Response(GOOD);
  if (url.endsWith('/big')) return new Response(crypto.randomBytes(200_000));
  return new Response('nope', { status: 404 });
}) as typeof fetch;

test('downloadVerified skips a 404 and keeps the matching file', async () => {
  const dest = path.join(dir, 'a.bin');
  const used = await downloadVerified(['https://x.test/missing', 'https://x.test/good'], sha, dest, { fetch: fakeFetch });
  assert.equal(used, 'https://x.test/good');
  assert.deepEqual(fs.readFileSync(dest), GOOD);
});

test('downloadToFile aborts once a response exceeds maxBytes, leaving no file', async () => {
  const out = path.join(dir, 'big.bin');
  await assert.rejects(downloadToFile('https://x.test/big', out, { fetch: fakeFetch, maxBytes: 100_000 }), /exceeds the 100000-byte limit/);
  assert.equal(fs.existsSync(out), false);
});

test('maxBytes allows files up to the limit', async () => {
  const out = path.join(dir, 'ok.bin');
  await downloadToFile('https://x.test/good', out, { fetch: fakeFetch, maxBytes: GOOD.length });
  assert.equal(fs.statSync(out).size, GOOD.length);
});

test('plain http is refused unless allowed', async () => {
  await assert.rejects(downloadToFile('http://x.test/good', path.join(dir, 'h.bin'), { fetch: fakeFetch }), /URL must be https/);
});
