// ABOUTME: Tests for the armada-ceremony command line: argument parsing, help, usage errors and exit codes.
// ABOUTME: Commands that need GitHub are covered by the flow tests; these spawn the CLI only for help and usage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { EXIT, UsageError, parseCommand, shouldPromptForEntropy } from '../src/cli';
import { parseCoordinatorCommand } from '../src/coordinator-cli';

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const runCli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('parseCommand reads flags, positionals and --repo', () => {
  assert.deepEqual(parseCommand(['contribute', '--wait']).flags.wait, true);
  assert.equal(parseCommand(['status']).repo, 'ship-armada/armada-circuits');
  assert.equal(parseCommand(['status', '--repo', 'ship-armada/armada-circuits-ceremony-test']).repo, 'ship-armada/armada-circuits-ceremony-test');
  assert.deepEqual(parseCommand(['submit', 'turn.json', 'out']).positionals, ['turn.json', 'out']);
  assert.equal(parseCommand(['verify', '--circuits', '1x1,2x2', '--full']).flags.circuits, '1x1,2x2');
});

test('parseCommand rejects unknown commands, unknown options and wrong arity', () => {
  assert.throws(() => parseCommand([]), (e: Error) => e instanceof UsageError && /no command given/.test(e.message));
  assert.throws(() => parseCommand(['frobnicate']), /unknown command: frobnicate/);
  assert.throws(() => parseCommand(['contribute', '--bogus']), /Unknown option '--bogus'/);
  assert.throws(() => parseCommand(['submit', 'only-one']), /submit takes 2 argument\(s\), got 1/);
  assert.throws(() => parseCommand(['status', '--repo', 'no-slash']), /--repo must be <owner>\/<name>/);
});

test('help prints usage and exits 0', () => {
  const r = runCli('help');
  assert.equal(r.status, EXIT.ok);
  assert.match(r.stdout, /usage: npm run ceremony -- <command>/);
  assert.equal(r.stderr, '');
});

test('a usage error prints the message and usage to stderr and exits 2', () => {
  const r = runCli('frobnicate');
  assert.equal(r.status, EXIT.usage);
  assert.match(r.stderr, /unknown command: frobnicate[\s\S]*usage:/);
  assert.equal(r.stdout, '');
});

test('coordinator command line: accept takes a PR number', () => {
  assert.equal(parseCoordinatorCommand(['accept', '12', '--reverify']).flags.reverify, true);
  assert.throws(() => parseCoordinatorCommand(['accept', 'twelve']), /accept takes a PR number, got twelve/);
  assert.throws(() => parseCoordinatorCommand(['accept']), /accept takes 1 argument/);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'coordinator-cli.js'), 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: npm run coordinator -- <command>/);
});

test('coordinator command line: init, release and add-circuit arguments', () => {
  const ok = parseCoordinatorCommand(['init', '--opens', '2027-01-01T00:00:00Z', '--closes', '2027-01-22T00:00:00Z', '--queue-issue', '7']);
  assert.equal(ok.flags['queue-issue'], '7');
  assert.throws(() => parseCoordinatorCommand(['init', '--opens', '2027-01-01T00:00:00Z', '--closes', '2027-01-22T00:00:00Z']), /init needs --queue-issue/);
  assert.throws(() => parseCoordinatorCommand(['init', '--opens', 'soon', '--closes', '2027-01-22T00:00:00Z', '--queue-issue', '7']), /--opens must be an ISO 8601 time/);
  assert.throws(() => parseCoordinatorCommand(['release']), /release needs --tag/);
  assert.equal(parseCoordinatorCommand(['add-circuit', 'disclosure']).positionals[0], 'disclosure');
  assert.equal(parseCoordinatorCommand(['release', '--tag', 'v1.0.0', '--publish']).flags.publish, true);
});

test('coordinator init accepts rehearsal options: circuit subset, policy and beacon delay', () => {
  const base = ['init', '--opens', '2027-01-01T00:00:00Z', '--closes', '2027-01-04T00:00:00Z', '--queue-issue', '1'];
  const c = parseCoordinatorCommand([...base, '--circuits', '1x1,1x2,2x2', '--policy', '3,0,0,1', '--beacon-delay-hours', '1']);
  assert.equal(c.flags.circuits, '1x1,1x2,2x2');
  assert.throws(() => parseCoordinatorCommand([...base, '--policy', '3,0,0']), /--policy must be four non-negative integers/);
  assert.throws(() => parseCoordinatorCommand([...base, '--policy', '3,0,-1,1']), /--policy must be four non-negative integers/);
  assert.throws(() => parseCoordinatorCommand([...base, '--beacon-delay-hours', 'soon']), /--beacon-delay-hours must be a positive number/);
});

test('ARMADA_CEREMONY_REPO sets the default repo for both command lines; --repo still wins', () => {
  const saved = process.env.ARMADA_CEREMONY_REPO;
  process.env.ARMADA_CEREMONY_REPO = 'ship-armada/armada-circuits-ceremony-test';
  try {
    assert.equal(parseCommand(['status']).repo, 'ship-armada/armada-circuits-ceremony-test');
    assert.equal(parseCoordinatorCommand(['accept', '3']).repo, 'ship-armada/armada-circuits-ceremony-test');
    assert.equal(parseCommand(['status', '--repo', 'o/r']).repo, 'o/r');
  } finally {
    if (saved === undefined) delete process.env.ARMADA_CEREMONY_REPO;
    else process.env.ARMADA_CEREMONY_REPO = saved;
  }
});

test('contribute asks for personal entropy by default, only on a terminal, unless --no-personal-entropy', () => {
  assert.equal(shouldPromptForEntropy(parseCommand(['contribute']), true), true);
  assert.equal(shouldPromptForEntropy(parseCommand(['contribute', '--wait']), true), true, 'asked before waiting, so --wait still runs unattended');
  assert.equal(shouldPromptForEntropy(parseCommand(['contribute']), false), false, 'no terminal: no prompt');
  assert.equal(shouldPromptForEntropy(parseCommand(['contribute', '--no-personal-entropy']), true), false);
  assert.equal(shouldPromptForEntropy(parseCommand(['contribute', '--download-only']), true), false, 'BYO runs use their own tool');
  assert.throws(() => parseCommand(['contribute', '--personal-entropy']), /Unknown option '--personal-entropy'/);
});
