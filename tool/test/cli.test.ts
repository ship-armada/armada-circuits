// ABOUTME: Tests for the armada-ceremony command line: argument parsing, help, usage errors and exit codes.
// ABOUTME: Commands that need GitHub are covered by the flow tests; these spawn the CLI only for help and usage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { EXIT, UsageError, parseCommand } from '../src/cli';
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
