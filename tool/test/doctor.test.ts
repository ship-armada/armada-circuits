// ABOUTME: Tests for `doctor`: environment checks with injected probes, and a real practice contribution.
// ABOUTME: Each failing check must name what is wrong and how to fix it.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctor, type DoctorDeps } from '../src/doctor';
import { releaseCurve } from '../src/snark';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
after(async () => {
  await releaseCurve();
  fs.rmSync(work, { recursive: true, force: true });
});

const GB = 1024 ** 3;
const goodRun: DoctorDeps['run'] = async (cmd, args) => {
  if (cmd === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh version 2.96.0 (2026-07-02)\n', stderr: '' };
  if (cmd === 'gh' && args[0] === 'auth') return { code: 0, stdout: '', stderr: 'Logged in to github.com account alice' };
  return { code: 1, stdout: '', stderr: 'unexpected' };
};
const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  run: goodRun, nodeVersion: '22.14.0', totalMemBytes: 16 * GB, freeDiskBytes: () => 100 * GB, workRoot: work,
  toolVersion: '1.0.0', requiredToolVersion: async () => '1.0.0', practice: true, ...over,
});
const byName = (r: Awaited<ReturnType<typeof doctor>>, name: string) => r.checks.find((c) => c.name === name)!;

test('a healthy machine passes every check, including the practice contribution', async () => {
  const r = await doctor(deps());
  assert.equal(r.ok, true, JSON.stringify(r.checks, null, 2));
  assert.equal(byName(r, 'practice contribution').ok, true);
});

test('old Node, old or logged-out gh, low disk fail with fixes', async () => {
  const r = await doctor(deps({
    nodeVersion: '20.11.0',
    freeDiskBytes: () => 1 * GB,
    practice: false,
    run: async (cmd, args) => {
      if (cmd === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh version 2.40.1 (2023-12-13)\n', stderr: '' };
      if (cmd === 'gh' && args[0] === 'auth') return { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
      return { code: 1, stdout: '', stderr: '' };
    },
  }));
  assert.equal(r.ok, false);
  assert.match(byName(r, 'node').detail, /20\.11\.0.*22 or newer/);
  assert.match(byName(r, 'gh version').detail, /2\.40\.1.*2\.48 or newer/);
  assert.match(byName(r, 'gh login').fix ?? '', /gh auth login/);
  assert.match(byName(r, 'disk space').detail, /1\.0 GB free.*2 GB/);
});

test('missing gh is reported, not thrown', async () => {
  const r = await doctor(deps({ practice: false, run: async () => { throw new Error('spawn gh ENOENT'); } }));
  assert.equal(byName(r, 'gh version').ok, false);
  assert.match(byName(r, 'gh version').fix ?? '', /cli\.github\.com/);
});

test('low memory is a warning, not a failure', async () => {
  const r = await doctor(deps({ totalMemBytes: 2 * GB, practice: false }));
  const mem = byName(r, 'memory');
  assert.equal(mem.ok, false);
  assert.equal(mem.severity, 'warning');
  assert.equal(r.ok, true);
});

test('a tool version that does not match the ceremony fails', async () => {
  const r = await doctor(deps({ requiredToolVersion: async () => '1.1.0', practice: false }));
  assert.equal(r.ok, false);
  assert.match(byName(r, 'tool version').detail, /1\.0\.0.*requires 1\.1\.0/);
});

test('an unreachable or not-yet-started ceremony is only a warning', async () => {
  const r = await doctor(deps({ requiredToolVersion: async () => { throw new Error('404 ceremony/manifest.json'); }, practice: false }));
  const v = byName(r, 'tool version');
  assert.equal(v.severity, 'warning');
  assert.equal(r.ok, true);
});
