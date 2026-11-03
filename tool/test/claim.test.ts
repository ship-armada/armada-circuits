// ABOUTME: Unit tests for the turn-claim rules: who holds the turn, claim expiry, failed PRs and first-claim-wins.
// ABOUTME: Pure functions over queue-issue comments and contribution PRs; no GitHub access.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_MARKER, CLAIM_TTL_MS, claimBody, isClaim, shouldBackOff, turnStatus, type ClaimComment, type ContributionPr } from '../src/claim';

const T0 = Date.parse('2027-01-05T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const NOW = T0 + 60 * 60_000; // 1 h after T0

let nextId = 1;
const claim = (author: string, minutes: number, body = claimBody(author)): ClaimComment => ({ id: nextId++, author, body, createdAt: at(minutes) });
const pr = (author: string, minutes: number, state: ContributionPr['state'], ci: ContributionPr['ci']): ContributionPr => ({
  number: nextId++, author, createdAt: at(minutes), state, ci,
});

test('claimBody carries the marker and isClaim recognises it', () => {
  const body = claimBody('alice');
  assert.ok(body.includes(CLAIM_MARKER));
  assert.equal(isClaim({ id: 1, author: 'alice', body, createdAt: at(0) }), true);
  assert.equal(isClaim({ id: 2, author: 'alice', body: 'I will contribute soon', createdAt: at(0) }), false);
});

test('the turn is free with no claims and no PRs', () => {
  assert.deepEqual(turnStatus([], [], NOW), { held: false });
});

test('a live claim holds the turn; an expired one does not', () => {
  const live = claim('alice', 30);
  assert.deepEqual(turnStatus([live], [], NOW), { held: true, holder: 'alice', by: 'claim', claimId: live.id, since: live.createdAt });
  const expired = claim('bob', 60 - CLAIM_TTL_MS / 60_000 - 1);
  assert.deepEqual(turnStatus([expired], [], NOW), { held: false });
});

test('comments without the marker are ignored', () => {
  assert.deepEqual(turnStatus([{ id: 9, author: 'alice', body: 'hello', createdAt: at(30) }], [], NOW), { held: false });
});

test('an open PR with CI pending or passed holds the turn', () => {
  for (const ci of ['pending', 'success'] as const) {
    const p = pr('alice', 40, 'open', ci);
    assert.deepEqual(turnStatus([claim('alice', 10)], [p], NOW), { held: true, holder: 'alice', by: 'pr', pr: p.number, since: p.createdAt });
  }
});

test('a PR that failed CI frees the turn, and consumes the claim before it', () => {
  assert.deepEqual(turnStatus([claim('alice', 10)], [pr('alice', 40, 'open', 'failure')], NOW), { held: false });
});

test('a merged or closed PR frees the turn', () => {
  for (const state of ['merged', 'closed'] as const) {
    assert.deepEqual(turnStatus([claim('alice', 10)], [pr('alice', 40, state, 'success')], NOW), { held: false });
  }
});

test('a new claim after a failed PR holds the turn again', () => {
  const retry = claim('alice', 50);
  const status = turnStatus([claim('alice', 10), retry], [pr('alice', 40, 'open', 'failure')], NOW);
  assert.deepEqual(status, { held: true, holder: 'alice', by: 'claim', claimId: retry.id, since: retry.createdAt });
});

test('a PR holds the turn even if someone else has a newer claim', () => {
  const p = pr('alice', 40, 'open', 'pending');
  const status = turnStatus([claim('alice', 10), claim('bob', 45)], [p], NOW);
  assert.equal(status.held && status.holder, 'alice');
});

test('with two live claims the earliest holds the turn', () => {
  const first = claim('alice', 20);
  const second = claim('bob', 21);
  assert.deepEqual(turnStatus([second, first], [], NOW), { held: true, holder: 'alice', by: 'claim', claimId: first.id, since: first.createdAt });
});

test('shouldBackOff: the later of two claims backs off, the earlier proceeds', () => {
  const a = claim('alice', 20);
  const b = claim('bob', 21);
  assert.equal(shouldBackOff([a, b], [], NOW, b.id), true);
  assert.equal(shouldBackOff([a, b], [], NOW, a.id), false);
});

test('shouldBackOff: same timestamp is broken by comment id', () => {
  const a = { id: 100, author: 'alice', body: claimBody('alice'), createdAt: at(20) };
  const b = { id: 101, author: 'bob', body: claimBody('bob'), createdAt: at(20) };
  assert.equal(shouldBackOff([b, a], [], NOW, b.id), true);
  assert.equal(shouldBackOff([b, a], [], NOW, a.id), false);
});

test('shouldBackOff: back off when a PR already holds the turn', () => {
  const mine = claim('bob', 50);
  assert.equal(shouldBackOff([mine], [pr('alice', 40, 'open', 'pending')], NOW, mine.id), true);
});

test('shouldBackOff: an expired earlier claim does not block', () => {
  const stale = claim('alice', 60 - CLAIM_TTL_MS / 60_000 - 5);
  const mine = claim('bob', 55);
  assert.equal(shouldBackOff([stale, mine], [], NOW, mine.id), false);
});

test('shouldBackOff: my own claim must be present and live', () => {
  assert.throws(() => shouldBackOff([], [], NOW, 12345), /claim 12345 not found/);
});
