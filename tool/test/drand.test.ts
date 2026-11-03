// ABOUTME: Tests for drand quicknet beacon verification, round/time maths and multi-endpoint fetching.
// ABOUTME: Uses real quicknet rounds recorded in fixtures/drand-quicknet.json; endpoints are local HTTP servers.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { QUICKNET, fetchVerifiedRound, roundAt, roundTime, verifyBeacon, type DrandBeacon } from '../src/drand';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tool', 'test', 'fixtures', 'drand-quicknet.json'), 'utf8'));
const [R1, R2]: DrandBeacon[] = FIXTURE.rounds;

const flipHex = (h: string, i: number) => h.slice(0, i) + (h[i] === '0' ? '1' : '0') + h.slice(i + 1);

test('QUICKNET matches the recorded chain info', () => {
  assert.equal(QUICKNET.hash, FIXTURE.info.hash);
  assert.equal(QUICKNET.publicKey, FIXTURE.info.public_key);
  assert.equal(QUICKNET.period, FIXTURE.info.period);
  assert.equal(QUICKNET.genesisTime, FIXTURE.info.genesis_time);
  assert.equal(QUICKNET.schemeID, FIXTURE.info.schemeID);
});

test('verifyBeacon accepts real quicknet rounds', () => {
  assert.equal(verifyBeacon(QUICKNET, R1), true);
  assert.equal(verifyBeacon(QUICKNET, R2), true);
});

test('verifyBeacon rejects a signature presented for a different round', () => {
  assert.equal(verifyBeacon(QUICKNET, { ...R1, round: R2.round }), false);
});

test('verifyBeacon rejects a tampered signature and a wrong randomness', () => {
  assert.equal(verifyBeacon(QUICKNET, { ...R1, signature: flipHex(R1.signature, 10) }), false);
  assert.equal(verifyBeacon(QUICKNET, { ...R1, signature: 'not hex' }), false);
  assert.equal(verifyBeacon(QUICKNET, { ...R1, randomness: R2.randomness }), false);
});

test('verifyBeacon rejects a beacon checked against another public key', () => {
  const other = { ...QUICKNET, publicKey: flipHex(QUICKNET.publicKey, 40) };
  assert.equal(verifyBeacon(other, R1), false);
});

test('roundAt and roundTime follow genesis + (round - 1) * period', () => {
  const g = QUICKNET.genesisTime * 1000;
  assert.equal(roundTime(QUICKNET, 1), g);
  assert.equal(roundAt(QUICKNET, g), 1);
  assert.equal(roundAt(QUICKNET, g + 2_999), 1);
  assert.equal(roundAt(QUICKNET, g + 3_000), 2);
  assert.equal(roundAt(QUICKNET, roundTime(QUICKNET, R1.round)), R1.round);
  assert.throws(() => roundAt(QUICKNET, g - 1), /before the chain's genesis/);
  assert.throws(() => roundTime(QUICKNET, 0), /round must be a positive integer/);
});

// Local endpoints: each serves /<chainHash>/public/<round> from a table.
const servers: http.Server[] = [];
const urls: Record<string, string> = {};

async function endpoint(name: string, handler: (round: number) => { status: number; body?: unknown }): Promise<void> {
  const server = http.createServer((req, res) => {
    const m = /^\/([0-9a-f]{64})\/public\/(\d+)$/.exec(req.url ?? '');
    const out = m && m[1] === QUICKNET.hash ? handler(Number(m[2])) : { status: 404 };
    res.statusCode = out.status;
    res.end(out.body === undefined ? '' : JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  urls[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  const serve = (round: number) => (round === R1.round ? { status: 200, body: R1 } : { status: 425 });
  await endpoint('good1', serve);
  await endpoint('good2', serve);
  await endpoint('tampered', () => ({ status: 200, body: { ...R1, signature: flipHex(R1.signature, 10) } }));
  await endpoint('down', () => ({ status: 500 }));
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

test('fetchVerifiedRound returns the round once two endpoints serve a verified copy', async () => {
  const b = await fetchVerifiedRound(QUICKNET, R1.round, [urls.down, urls.tampered, urls.good1, urls.good2], { allowHttp: true });
  assert.deepEqual(b, { round: R1.round, randomness: R1.randomness, signature: R1.signature });
});

test('fetchVerifiedRound fails with each endpoint reason when fewer than two verify', async () => {
  await assert.rejects(
    fetchVerifiedRound(QUICKNET, R1.round, [urls.good1, urls.tampered, urls.down], { allowHttp: true }),
    (err: Error) => {
      assert.match(err.message, /only 1 of 2 required endpoints served a verified round 1000000/);
      assert.match(err.message, /tampered|signature does not verify/);
      assert.match(err.message, /HTTP 500/);
      return true;
    },
  );
});

test('fetchVerifiedRound reports a round that is not published yet', async () => {
  await assert.rejects(
    fetchVerifiedRound(QUICKNET, R1.round + 10, [urls.good1, urls.good2], { allowHttp: true }),
    /round 1000010 is not published yet/,
  );
});

test('fetchVerifiedRound refuses plain-http endpoints unless allowed (tests only)', async () => {
  await assert.rejects(fetchVerifiedRound(QUICKNET, R1.round, [urls.good1, urls.good2]), /must be https/);
});
