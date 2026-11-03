// ABOUTME: Loads and validates circuits.json, the single list of circuits used by compile, setup and ceremony.
// ABOUTME: Also maps each circuit to its build artifact paths (r1cs, wasm, zkey, vkey).

import fs from 'node:fs';
import path from 'node:path';

export interface Circuit {
  /** Stable identifier, e.g. "8x4" for Transact(8, 4). */
  id: string;
  /** Entry point relative to the repo root, e.g. "src/main/main_8x4.circom". */
  entry: string;
  /** Top-level template the entry point instantiates. */
  template: string;
  /** Number of public inputs the verifier expects. */
  publicInputs: number;
  /** Phase-1 ptau power this circuit needs (2^ptauPower constraints). */
  ptauPower: number;
  /** false = dev setup only (not part of the ceremony). */
  ceremony: boolean;
}

export interface Registry {
  version: 1;
  circuits: Circuit[];
}

export interface ArtifactPaths {
  dir: string;
  r1cs: string;
  wasm: string;
  zkey: string;
  vkey: string;
}

export const REGISTRY_FILE = 'circuits.json';

/** Thrown with every problem found, so one run shows them all. */
export class RegistryError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid circuit registry:\n  ${problems.join('\n  ')}`);
    this.name = 'RegistryError';
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TRANSACT_ID = /^(\d+)x(\d+)$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function circuitProblems(c: unknown, i: number): string[] {
  const at = `circuits[${i}]`;
  if (!isRecord(c)) return [`${at} must be an object`];
  const problems: string[] = [];
  if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) problems.push(`${at}.id must match ${ID_PATTERN}`);
  if (typeof c.entry !== 'string' || !c.entry.startsWith('src/') || !c.entry.endsWith('.circom') || c.entry.includes('..')) {
    problems.push(`${at}.entry must be a .circom path under src/`);
  }
  if (typeof c.template !== 'string' || c.template.trim() === '') problems.push(`${at}.template must be a non-empty string`);
  if (!Number.isInteger(c.publicInputs) || (c.publicInputs as number) < 1) problems.push(`${at}.publicInputs must be a positive integer`);
  if (!Number.isInteger(c.ptauPower) || (c.ptauPower as number) < 8 || (c.ptauPower as number) > 28) {
    problems.push(`${at}.ptauPower must be an integer from 8 to 28`);
  }
  if (typeof c.ceremony !== 'boolean') problems.push(`${at}.ceremony must be a boolean`);

  // Transact(N, M) has public inputs [merkleRoot, boundParamsHash, nullifiers[N], commitmentsOut[M]].
  if (problems.length === 0 && c.template === 'Transact') {
    const shape = TRANSACT_ID.exec(c.id as string);
    if (!shape) {
      problems.push(`${at} (${c.id}): Transact circuit id must be <N>x<M>`);
    } else {
      const expected = 2 + Number(shape[1]) + Number(shape[2]);
      if (c.publicInputs !== expected) problems.push(`${at} (${c.id}): Transact publicInputs must be 2 + N + M = ${expected}`);
    }
  }
  return problems;
}

/** Validate parsed circuits.json content. Throws RegistryError listing every problem. */
export function parseRegistry(json: unknown): Registry {
  if (!isRecord(json)) throw new RegistryError(['registry must be a JSON object']);
  const problems: string[] = [];
  if (json.version !== 1) problems.push('version must be 1');
  if (!Array.isArray(json.circuits) || json.circuits.length === 0) {
    problems.push('circuits must be a non-empty array');
    throw new RegistryError(problems);
  }
  json.circuits.forEach((c, i) => problems.push(...circuitProblems(c, i)));
  const seen = new Set<string>();
  for (const c of json.circuits) {
    if (isRecord(c) && typeof c.id === 'string') {
      if (seen.has(c.id)) problems.push(`duplicate circuit id ${c.id}`);
      seen.add(c.id);
    }
  }
  if (problems.length > 0) throw new RegistryError(problems);
  return json as unknown as Registry;
}

/** Read and validate `<root>/circuits.json`, including that every entry point exists. */
export function loadRegistry(root: string): Registry {
  const reg = parseRegistry(JSON.parse(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8')));
  const missing = reg.circuits
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !fs.existsSync(path.join(root, c.entry)))
    .map(({ c, i }) => `circuits[${i}] (${c.id}): entry ${c.entry} does not exist`);
  if (missing.length > 0) throw new RegistryError(missing);
  return reg;
}

export function ceremonyCircuits(reg: Registry): Circuit[] {
  return reg.circuits.filter((c) => c.ceremony);
}

export function circuitById(reg: Registry, id: string): Circuit {
  const c = reg.circuits.find((x) => x.id === id);
  if (!c) throw new Error(`unknown circuit ${id}`);
  return c;
}

/** The circuits named by `ids`, in registry order; all circuits when `ids` is empty. */
export function selectCircuits(reg: Registry, ids: string[]): Circuit[] {
  if (ids.length === 0) return [...reg.circuits];
  for (const id of ids) circuitById(reg, id);
  return reg.circuits.filter((c) => ids.includes(c.id));
}

/** Build artifact locations, matching scripts/compile.sh and scripts/setup-dev.sh. */
export function artifactPaths(root: string, c: Circuit): ArtifactPaths {
  const base = path.basename(c.entry, '.circom');
  const dir = path.join(root, 'build', c.id);
  return {
    dir,
    r1cs: path.join(dir, `${base}.r1cs`),
    wasm: path.join(dir, `${base}_js`, `${base}.wasm`),
    zkey: path.join(dir, 'final.zkey'),
    vkey: path.join(dir, 'vkey.json'),
  };
}
