// ABOUTME: Unit tests for the circuit registry (circuits.json) parser, loader and path helpers.
// ABOUTME: Also checks the repo's own circuits.json against the entry points in src/main.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RegistryError,
  artifactPaths,
  ceremonyCircuits,
  circuitById,
  loadRegistry,
  parseRegistry,
  selectCircuits,
} from '../src/registry';

const REPO_ROOT = path.join(__dirname, '..', '..');

const circuit = (over: Record<string, unknown> = {}) => ({
  id: '2x2',
  entry: 'src/main/main_2x2.circom',
  template: 'Transact',
  publicInputs: 6,
  ptauPower: 17,
  ceremony: true,
  ...over,
});
const registry = (circuits: unknown[]) => ({ version: 1, circuits });

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RegistryError, `expected RegistryError, got ${String(err)}`);
    return err.problems;
  }
  assert.fail('expected a RegistryError');
};

test('parses a valid registry', () => {
  const reg = parseRegistry(registry([circuit(), circuit({ id: '1x2', entry: 'src/main/main_1x2.circom', publicInputs: 5 })]));
  assert.equal(reg.circuits.length, 2);
  assert.equal(reg.circuits[0].id, '2x2');
});

test('rejects a wrong version and a missing circuit list', () => {
  assert.deepEqual(problemsOf(() => parseRegistry({ version: 2, circuits: [] })), [
    'version must be 1',
    'circuits must be a non-empty array',
  ]);
  assert.deepEqual(problemsOf(() => parseRegistry(null)), ['registry must be a JSON object']);
});

test('reports every problem in one error', () => {
  const problems = problemsOf(() => parseRegistry(registry([
    circuit({ id: 'Bad Id', entry: '../escape.circom', template: '', publicInputs: 0, ptauPower: 40, ceremony: 'yes' }),
  ])));
  assert.deepEqual(problems, [
    'circuits[0].id must match /^[a-z0-9][a-z0-9-]*$/',
    'circuits[0].entry must be a .circom path under src/',
    'circuits[0].template must be a non-empty string',
    'circuits[0].publicInputs must be a positive integer',
    'circuits[0].ptauPower must be an integer from 8 to 28',
    'circuits[0].ceremony must be a boolean',
  ]);
});

test('rejects duplicate ids', () => {
  assert.deepEqual(problemsOf(() => parseRegistry(registry([circuit(), circuit()]))), ['duplicate circuit id 2x2']);
});

test('checks Transact public inputs against the NxM shape', () => {
  assert.deepEqual(problemsOf(() => parseRegistry(registry([circuit({ publicInputs: 7 })]))), [
    'circuits[0] (2x2): Transact publicInputs must be 2 + N + M = 6',
  ]);
  assert.deepEqual(problemsOf(() => parseRegistry(registry([circuit({ id: 'transact' })]))), [
    'circuits[0] (transact): Transact circuit id must be <N>x<M>',
  ]);
});

test('non-Transact circuits skip the shape check', () => {
  const reg = parseRegistry(registry([circuit({ id: 'disclosure', entry: 'src/main/disclosure.circom', template: 'Disclosure', publicInputs: 3, ceremony: false })]));
  assert.equal(reg.circuits[0].template, 'Disclosure');
});

test('ceremonyCircuits, circuitById and selectCircuits', () => {
  const reg = parseRegistry(registry([
    circuit(),
    circuit({ id: 'disclosure', entry: 'src/main/disclosure.circom', template: 'Disclosure', publicInputs: 3, ceremony: false }),
  ]));
  assert.deepEqual(ceremonyCircuits(reg).map((c) => c.id), ['2x2']);
  assert.equal(circuitById(reg, 'disclosure').template, 'Disclosure');
  assert.throws(() => circuitById(reg, '9x9'), /unknown circuit 9x9/);
  assert.deepEqual(selectCircuits(reg, []).map((c) => c.id), ['2x2', 'disclosure']);
  assert.deepEqual(selectCircuits(reg, ['disclosure']).map((c) => c.id), ['disclosure']);
  assert.throws(() => selectCircuits(reg, ['2x2', '9x9']), /unknown circuit 9x9/);
});

test('artifactPaths follows the compile.sh layout', () => {
  const p = artifactPaths('/repo', circuit());
  assert.equal(p.dir, path.join('/repo', 'build', '2x2'));
  assert.equal(p.r1cs, path.join('/repo', 'build', '2x2', 'main_2x2.r1cs'));
  assert.equal(p.wasm, path.join('/repo', 'build', '2x2', 'main_2x2_js', 'main_2x2.wasm'));
  assert.equal(p.zkey, path.join('/repo', 'build', '2x2', 'final.zkey'));
  assert.equal(p.vkey, path.join('/repo', 'build', '2x2', 'vkey.json'));
});

test('loadRegistry reports entry files that do not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  fs.mkdirSync(path.join(dir, 'src', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main', 'main_2x2.circom'), '');
  fs.writeFileSync(path.join(dir, 'circuits.json'), JSON.stringify(registry([
    circuit(),
    circuit({ id: '1x2', entry: 'src/main/main_1x2.circom', publicInputs: 5 }),
  ])));
  assert.deepEqual(problemsOf(() => loadRegistry(dir)), ['circuits[1] (1x2): entry src/main/main_1x2.circom does not exist']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the repo's circuits.json lists exactly the entry points in src/main", () => {
  const reg = loadRegistry(REPO_ROOT);
  const listed = reg.circuits.map((c) => c.entry).sort();
  const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'src', 'main'))
    .filter((f) => f.endsWith('.circom'))
    .map((f) => `src/main/${f}`)
    .sort();
  assert.deepEqual(listed, onDisk);
  assert.equal(ceremonyCircuits(reg).length, 19);
});
