// ABOUTME: Unit tests for GhCli with a canned `gh` runner: response parsing, PR state/CI mapping and fork handling.
// ABOUTME: The live GitHub path is exercised end to end against the test repo in M6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhCli, type GhRunner } from '../src/github';

type Route = [RegExp, string | ((args: string[], input?: string) => string)];
function runner(routes: Route[], calls: string[][] = []): GhRunner {
  return async (args, input) => {
    calls.push(args);
    const key = args.join(' ');
    for (const [re, out] of routes) if (re.test(key)) return typeof out === 'string' ? out : out(args, input);
    throw new Error(`gh ${key}: no route`);
  };
}

test('listIssueComments flattens pages and maps fields', async () => {
  const gh = new GhCli(runner([[/issues\/7\/comments/, JSON.stringify([[{ id: 1, user: { login: 'a' }, body: 'x', created_at: 't1' }], [{ id: 2, user: { login: 'b' }, body: 'y', created_at: 't2' }]])]]));
  assert.deepEqual(await gh.listIssueComments('o/r', 7), [
    { id: 1, author: 'a', body: 'x', createdAt: 't1' },
    { id: 2, author: 'b', body: 'y', createdAt: 't2' },
  ]);
});

test('listContributionPrs keeps ceremony branches and maps state and check results', async () => {
  const pulls = [
    { number: 1, user: { login: 'a' }, created_at: 't', state: 'open', merged_at: null, head: { ref: 'ceremony/turn-0003-a', sha: 's1' } },
    { number: 2, user: { login: 'b' }, created_at: 't', state: 'open', merged_at: null, head: { ref: 'ceremony/turn-0003-b', sha: 's2' } },
    { number: 3, user: { login: 'c' }, created_at: 't', state: 'open', merged_at: null, head: { ref: 'ceremony/turn-0003-c', sha: 's3' } },
    { number: 4, user: { login: 'd' }, created_at: 't', state: 'closed', merged_at: '2027', head: { ref: 'ceremony/turn-0002-d', sha: 's4' } },
    { number: 5, user: { login: 'e' }, created_at: 't', state: 'closed', merged_at: null, head: { ref: 'ceremony/turn-0002-e', sha: 's5' } },
    { number: 6, user: { login: 'f' }, created_at: 't', state: 'open', merged_at: null, head: { ref: 'fix/docs', sha: 's6' } },
  ];
  const gh = new GhCli(runner([
    [/pulls\?state=all/, JSON.stringify(pulls)],
    [/commits\/s1\/check-runs/, JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }] })],
    [/commits\/s2\/check-runs/, JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'failure' }] })],
    [/commits\/s3\/check-runs/, JSON.stringify({ check_runs: [{ status: 'in_progress', conclusion: null }] })],
  ]));
  const prs = await gh.listContributionPrs('o/r');
  assert.deepEqual(prs.map((p) => [p.number, p.state, p.ci]), [[1, 'open', 'success'], [2, 'open', 'failure'], [3, 'open', 'pending'], [4, 'merged', 'pending'], [5, 'closed', 'pending']]);
});

test('uploadToForkRelease creates the fork when missing and returns download URLs', async () => {
  const calls: string[][] = [];
  let forked = false;
  const gh = new GhCli(runner([
    [/^api user$/, JSON.stringify({ login: 'alice' })],
    [/forks\?per_page/, () => JSON.stringify([forked ? [{ full_name: 'alice/armada-circuits', owner: { login: 'alice' } }] : []])],
    [/^repo fork/, () => { forked = true; return ''; }],
    [/^release view/, () => { throw new Error('release not found'); }],
    [/^release create/, ''],
  ], calls));
  const urls = await gh.uploadToForkRelease('o/armada-circuits', 'ceremony-turn-0001', ['/tmp/x/1x1-0001-alice.zkey'], 'notes');
  assert.deepEqual(urls, { '1x1-0001-alice.zkey': 'https://github.com/alice/armada-circuits/releases/download/ceremony-turn-0001/1x1-0001-alice.zkey' });
  assert.ok(calls.some((c) => c[0] === 'repo' && c[1] === 'fork'));
  assert.ok(calls.some((c) => c[0] === 'release' && c[1] === 'create' && c.includes('alice/armada-circuits')));
});

test('openPullRequest builds the commit on the fork and opens the PR from owner:branch', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const route = (re: RegExp, out: string): Route => [re, out];
  const gh = new GhCli(async (args, input) => {
    calls.push({ args, input });
    const key = args.join(' ');
    for (const [re, out] of [
      route(/^api user$/, JSON.stringify({ login: 'alice' })),
      route(/forks\?per_page/, JSON.stringify([[{ full_name: 'alice/armada-circuits', owner: { login: 'alice' } }]])),
      route(/^api repos\/o\/armada-circuits$/, JSON.stringify({ default_branch: 'main' })),
      route(/git\/ref\/heads\/main/, JSON.stringify({ object: { sha: 'BASE' } })),
      route(/git\/commits\/BASE/, JSON.stringify({ tree: { sha: 'TREE0' } })),
      route(/alice\/armada-circuits\/git\/trees/, JSON.stringify({ sha: 'TREE1' })),
      route(/alice\/armada-circuits\/git\/commits/, JSON.stringify({ sha: 'C1' })),
      route(/git\/refs --input/, JSON.stringify({})),
      route(/o\/armada-circuits\/pulls --input/, JSON.stringify({ number: 9, html_url: 'https://github.com/o/armada-circuits/pull/9' })),
    ] as Route[]) if (re.test(key)) return out as string;
    throw new Error('no ref');
  });
  const pr = await gh.openPullRequest('o/armada-circuits', 'ceremony/turn-0001-alice', [{ path: 'ceremony/manifest.json', content: '{}' }], 'title', 'body');
  assert.deepEqual(pr, { number: 9, url: 'https://github.com/o/armada-circuits/pull/9' });
  const body = (re: RegExp) => JSON.parse(calls.find((c) => re.test(c.args.join(' ')))!.input!);
  assert.deepEqual(body(/git\/trees/), { base_tree: 'TREE0', tree: [{ path: 'ceremony/manifest.json', mode: '100644', type: 'blob', content: '{}' }] });
  assert.deepEqual(body(/alice\/armada-circuits\/git\/commits/), { message: 'title', tree: 'TREE1', parents: ['BASE'] });
  assert.deepEqual(body(/git\/refs --input/), { ref: 'refs/heads/ceremony/turn-0001-alice', sha: 'C1' });
  assert.deepEqual(body(/pulls --input/), { title: 'title', body: 'body', head: 'alice:ceremony/turn-0001-alice', base: 'main' });
});

test('getPullRequest maps state, author and head', async () => {
  const gh = new GhCli(runner([[/pulls\/12$/, JSON.stringify({
    number: 12, user: { login: 'alice' }, state: 'closed', merged_at: '2027-01-01', head: { ref: 'ceremony/turn-0001-alice', sha: 'abc', repo: { full_name: 'alice/armada-circuits' } },
  })]]));
  assert.deepEqual(await gh.getPullRequest('o/r', 12), {
    number: 12, author: 'alice', state: 'merged', headRef: 'ceremony/turn-0001-alice', headSha: 'abc', headRepo: 'alice/armada-circuits',
  });
});

test('listPullRequestFiles flattens pages of file names', async () => {
  const gh = new GhCli(runner([[/pulls\/12\/files/, JSON.stringify([[{ filename: 'a' }], [{ filename: 'b' }]])]]));
  assert.deepEqual(await gh.listPullRequestFiles('o/r', 12), ['a', 'b']);
});

test('readFileAtRef reads raw contents at a commit', async () => {
  const calls: string[][] = [];
  const gh = new GhCli(runner([[/contents\/ceremony\/manifest\.json\?ref=abc/, '{"x":1}']], calls));
  assert.equal(await gh.readFileAtRef('alice/r', 'ceremony/manifest.json', 'abc'), '{"x":1}');
  assert.ok(calls[0].includes('Accept: application/vnd.github.raw'));
});

test('listWorkflowRuns maps runs for a head commit', async () => {
  const gh = new GhCli(runner([[/actions\/runs\?head_sha=abc/, JSON.stringify({ workflow_runs: [
    { path: '.github/workflows/contribution-check.yml', event: 'pull_request_target', status: 'completed', conclusion: 'success', head_sha: 'abc' },
  ] })]]));
  assert.deepEqual(await gh.listWorkflowRuns('o/r', 'abc'), [
    { path: '.github/workflows/contribution-check.yml', event: 'pull_request_target', status: 'completed', conclusion: 'success', headSha: 'abc' },
  ]);
});

test('mergePullRequest pins the verified head commit', async () => {
  const calls: string[][] = [];
  const gh = new GhCli(runner([[/^pr merge/, '']], calls));
  await gh.mergePullRequest('o/r', 12, 'abc');
  assert.deepEqual(calls[0], ['pr', 'merge', '12', '--repo', 'o/r', '--merge', '--match-head-commit', 'abc']);
});

test('uploadToRelease creates the release when missing, otherwise uploads with --clobber', async () => {
  const calls: string[][] = [];
  let exists = false;
  const gh = new GhCli(runner([
    [/^release view/, () => { if (!exists) throw new Error('not found'); return '{}'; }],
    [/^release create/, () => { exists = true; return ''; }],
    [/^release upload/, ''],
  ], calls));
  const urls = await gh.uploadToRelease('o/r', 'ceremony-zkeys', ['/x/1x1-0001-alice.zkey'], 'notes');
  assert.deepEqual(urls, { '1x1-0001-alice.zkey': 'https://github.com/o/r/releases/download/ceremony-zkeys/1x1-0001-alice.zkey' });
  await gh.uploadToRelease('o/r', 'ceremony-zkeys', ['/x/2x2-0001-alice.zkey'], 'notes');
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['release view', 'release create', 'release view', 'release upload']);
  assert.ok(calls[3].includes('--clobber'));
});
