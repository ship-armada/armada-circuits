// ABOUTME: Guards the security properties of the GitHub workflows, so an edit cannot quietly loosen them.
// ABOUTME: Checks triggers, permissions, pinned actions, checkout credentials and untrusted-input handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONTRIBUTION_CHECK_NAME } from '../src/github';

const WF = path.join(__dirname, '..', '..', '.github', 'workflows');
const read = (f: string) => fs.readFileSync(path.join(WF, f), 'utf8');

test('every workflow pins actions by commit SHA and does not persist checkout credentials', () => {
  for (const f of fs.readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
    const text = read(f);
    for (const m of text.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]} is not pinned to a commit`);
    if (text.includes('actions/checkout@')) assert.match(text, /persist-credentials:\s*false/, `${f}: checkout must not persist credentials`);
    assert.doesNotMatch(text, /permissions:\s*write-all|contents:\s*write|pull-requests:\s*write|id-token:\s*write/, `${f}: write permission`);
    assert.doesNotMatch(text, /\$\{\{\s*secrets\./, `${f}: uses secrets`);
  }
});

test('the contribution check runs on pull_request_target, read-only, as the job the tooling looks for', () => {
  const text = read('contribution-check.yml');
  assert.match(text, /on:\n\s+pull_request_target:/);
  assert.match(text, /permissions:\n\s+contents: read\n\s+pull-requests: read\n/);
  assert.match(text, new RegExp(`jobs:\\n\\s+${CONTRIBUTION_CHECK_NAME}:`), 'job name must match CONTRIBUTION_CHECK_NAME');
  assert.match(text, /run: node dist\/src\/ci-check\.js/);
  // Checking out the PR head would run untrusted code with the base branch's context.
  assert.doesNotMatch(text, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
  assert.doesNotMatch(text, /repository:\s*\$\{\{\s*github\.event\.pull_request\.head/);
});

test('no workflow interpolates event data into a run script', () => {
  for (const f of fs.readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
    const lines = read(f).split('\n');
    let inRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (/^\s*run:/.test(line)) {
        inRun = true;
        runIndent = indent;
        assert.doesNotMatch(line, /\$\{\{\s*github\.(event|head_ref)/, `${f}: ${line.trim()}`);
        continue;
      }
      if (inRun && line.trim() !== '' && indent <= runIndent) inRun = false;
      if (inRun) assert.doesNotMatch(line, /\$\{\{\s*github\.(event|head_ref)/, `${f}: ${line.trim()}`);
    }
  }
});
