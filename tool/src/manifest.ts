// ABOUTME: The ceremony manifest (ceremony/manifest.json): types, validation, chain invariants and turn appends.
// ABOUTME: checkContributionAppend is the rule a contribution PR must pass: exactly one new turn, nothing else changed.

import { isDeepStrictEqual } from 'node:util';

export type MirrorKind = 'fork' | 'official' | 'ipfs';
export type ContributionMode = 'tool' | 'byo-tool';
export type ChainStatus = 'open' | 'closed' | 'finalized';

export interface Mirror {
  kind: MirrorKind;
  url: string;
}

export interface Contribution {
  /** Position in this circuit's chain, starting at 1 (the base zkey is not a contribution). */
  index: number;
  /** Global turn number; one turn = one contributor contributing to every open circuit. */
  turn: number;
  /** GitHub handle of the PR author who made the contribution. */
  contributor: string;
  zkeySha256: string;
  /** snarkjs contribution hash (blake2b-512, hex). */
  contributionHash: string;
  mirrors: Mirror[];
  toolVersion: string;
  mode: ContributionMode;
  /** Repo-relative path of the turn's attestation file. */
  attestation: string;
  /** ISO 8601 time the contribution was made. */
  timestamp: string;
}

export interface CircuitChain {
  r1csSha256: string;
  wasmSha256: string;
  status: ChainStatus;
  /** Last turn before this circuit joined the ceremony (0 = from the start). */
  openedAtTurn: number;
  base: { zkeySha256: string; mirrors: Mirror[] };
  contributions: Contribution[];
  final?: { zkeySha256: string; vkeySha256: string; mirrors: Mirror[] };
}

export interface Manifest {
  version: 2;
  requiredToolVersion: string;
  snarkjsVersion: string;
  ptau: { sha256: string; blake2b: string; power: number; mirrors: string[] };
  window: { opens: string; closes: string };
  beacon: {
    type: 'drand';
    /** drand chain hash (hex) the beacon round is taken from. */
    chainHash: string;
    round: number;
    /** snarkjs `zkey beacon` numIterationsExp. */
    iterationsExp: number;
    publicKey?: string;
    value?: string;
    signature?: string;
  };
  policy: { minContributions: number; minOutside: number; minOutsideOrgs: number; minByo: number };
  circuits: Record<string, CircuitChain>;
}

/** The per-turn data a contributor supplies; appendTurn assigns index and turn. */
export interface TurnInput {
  contributor: string;
  toolVersion: string;
  mode: ContributionMode;
  attestation: string;
  timestamp: string;
  perCircuit: Record<string, { zkeySha256: string; contributionHash: string; mirrors: Mirror[] }>;
}

/** Thrown with every problem found, so one run shows them all. */
export class ManifestError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid manifest:\n  ${problems.join('\n  ')}`);
    this.name = 'ManifestError';
  }
}

export const GITHUB_HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const HEX = /^[0-9a-f]+$/;
const MIRROR_KINDS: MirrorKind[] = ['fork', 'official', 'ipfs'];
const MODES: ContributionMode[] = ['tool', 'byo-tool'];
const STATUSES: ChainStatus[] = ['open', 'closed', 'finalized'];
/** Fields that must be identical across every circuit for the same turn. */
const TURN_FIELDS = ['contributor', 'toolVersion', 'mode', 'attestation', 'timestamp'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isIsoTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

function mirrorProblems(v: unknown, at: string): string[] {
  if (!Array.isArray(v)) return [`${at} must be an array`];
  return v.flatMap((m, i) => {
    if (!isRecord(m) || !MIRROR_KINDS.includes(m.kind as MirrorKind) || !isHttpsUrl(m.url)) {
      return [`${at}[${i}] must be { kind: ${MIRROR_KINDS.join('|')}, url: https://... }`];
    }
    return [];
  });
}

function contributionProblems(c: unknown, at: string): string[] {
  if (!isRecord(c)) return [`${at} must be an object`];
  const p: string[] = [];
  if (!Number.isInteger(c.index) || (c.index as number) < 1) p.push(`${at}.index must be a positive integer`);
  if (!Number.isInteger(c.turn) || (c.turn as number) < 1) p.push(`${at}.turn must be a positive integer`);
  if (typeof c.contributor !== 'string' || !GITHUB_HANDLE.test(c.contributor)) p.push(`${at}.contributor must be a GitHub handle`);
  if (typeof c.zkeySha256 !== 'string' || !HEX64.test(c.zkeySha256)) p.push(`${at}.zkeySha256 must be 64 lowercase hex characters`);
  if (typeof c.contributionHash !== 'string' || !HEX128.test(c.contributionHash)) {
    p.push(`${at}.contributionHash must be 128 lowercase hex characters`);
  }
  p.push(...mirrorProblems(c.mirrors, `${at}.mirrors`));
  if (!isNonEmptyString(c.toolVersion)) p.push(`${at}.toolVersion must be a non-empty string`);
  if (!MODES.includes(c.mode as ContributionMode)) p.push(`${at}.mode must be one of ${MODES.join(', ')}`);
  if (typeof c.attestation !== 'string' || !c.attestation.startsWith('ceremony/attestations/') || c.attestation.includes('..')) {
    p.push(`${at}.attestation must be a path under ceremony/attestations/`);
  }
  if (!isIsoTime(c.timestamp)) p.push(`${at}.timestamp must be an ISO 8601 time`);
  return p;
}

function chainProblems(c: unknown, at: string): string[] {
  if (!isRecord(c)) return [`${at} must be an object`];
  const p: string[] = [];
  if (typeof c.r1csSha256 !== 'string' || !HEX64.test(c.r1csSha256)) p.push(`${at}.r1csSha256 must be 64 lowercase hex characters`);
  if (typeof c.wasmSha256 !== 'string' || !HEX64.test(c.wasmSha256)) p.push(`${at}.wasmSha256 must be 64 lowercase hex characters`);
  if (!STATUSES.includes(c.status as ChainStatus)) p.push(`${at}.status must be one of ${STATUSES.join(', ')}`);
  if (!isNonNegInt(c.openedAtTurn)) p.push(`${at}.openedAtTurn must be a non-negative integer`);
  if (!isRecord(c.base) || typeof c.base.zkeySha256 !== 'string' || !HEX64.test(c.base.zkeySha256)) {
    p.push(`${at}.base.zkeySha256 must be 64 lowercase hex characters`);
  } else {
    p.push(...mirrorProblems(c.base.mirrors, `${at}.base.mirrors`));
  }
  if (!Array.isArray(c.contributions)) {
    p.push(`${at}.contributions must be an array`);
  } else {
    c.contributions.forEach((x, i) => p.push(...contributionProblems(x, `${at}.contributions[${i}]`)));
  }
  if (c.final !== undefined) {
    const f = c.final;
    if (!isRecord(f) || typeof f.zkeySha256 !== 'string' || !HEX64.test(f.zkeySha256)
      || typeof f.vkeySha256 !== 'string' || !HEX64.test(f.vkeySha256)) {
      p.push(`${at}.final must have 64-hex zkeySha256 and vkeySha256`);
    } else {
      p.push(...mirrorProblems(f.mirrors, `${at}.final.mirrors`));
    }
  }
  return p;
}

function schemaProblems(m: Record<string, unknown>): string[] {
  const p: string[] = [];
  if (m.version !== 2) p.push('version must be 2');
  if (!isNonEmptyString(m.requiredToolVersion)) p.push('requiredToolVersion must be a non-empty string');
  if (!isNonEmptyString(m.snarkjsVersion)) p.push('snarkjsVersion must be a non-empty string');

  const ptau = m.ptau;
  if (!isRecord(ptau)) {
    p.push('ptau must be an object');
  } else {
    if (typeof ptau.sha256 !== 'string' || !HEX64.test(ptau.sha256)) p.push('ptau.sha256 must be 64 lowercase hex characters');
    if (typeof ptau.blake2b !== 'string' || !HEX128.test(ptau.blake2b)) p.push('ptau.blake2b must be 128 lowercase hex characters');
    if (!Number.isInteger(ptau.power) || (ptau.power as number) < 8 || (ptau.power as number) > 28) p.push('ptau.power must be an integer from 8 to 28');
    if (!Array.isArray(ptau.mirrors) || ptau.mirrors.length === 0 || !ptau.mirrors.every(isHttpsUrl)) {
      p.push('ptau.mirrors must be a non-empty list of https URLs');
    }
  }

  const w = m.window;
  if (!isRecord(w) || !isIsoTime(w.opens) || !isIsoTime(w.closes)) {
    p.push('window.opens and window.closes must be ISO 8601 times');
  } else if (Date.parse(w.opens) >= Date.parse(w.closes)) {
    p.push('window.opens must be before window.closes');
  }

  const b = m.beacon;
  if (!isRecord(b)) {
    p.push('beacon must be an object');
  } else {
    if (b.type !== 'drand') p.push('beacon.type must be "drand"');
    if (typeof b.chainHash !== 'string' || !HEX64.test(b.chainHash)) p.push('beacon.chainHash must be 64 lowercase hex characters');
    if (!Number.isInteger(b.round) || (b.round as number) < 1) p.push('beacon.round must be a positive integer');
    // snarkjs `zkey beacon` accepts numIterationsExp from 10 to 63.
    if (!Number.isInteger(b.iterationsExp) || (b.iterationsExp as number) < 10 || (b.iterationsExp as number) > 63) {
      p.push('beacon.iterationsExp must be an integer from 10 to 63');
    }
    for (const k of ['publicKey', 'value', 'signature'] as const) {
      if (b[k] !== undefined && (typeof b[k] !== 'string' || !HEX.test(b[k] as string))) p.push(`beacon.${k} must be lowercase hex`);
    }
  }

  const pol = m.policy;
  if (!isRecord(pol)) {
    p.push('policy must be an object');
  } else {
    for (const k of ['minContributions', 'minOutside', 'minOutsideOrgs', 'minByo'] as const) {
      if (!isNonNegInt(pol[k])) p.push(`policy.${k} must be a non-negative integer`);
    }
  }

  if (!isRecord(m.circuits) || Object.keys(m.circuits).length === 0) {
    p.push('circuits must be a non-empty object');
  } else {
    for (const [id, c] of Object.entries(m.circuits)) p.push(...chainProblems(c, `circuits.${id}`));
  }
  return p;
}

/** Highest turn number in the manifest (0 before the first contribution). */
export function lastTurn(m: Manifest): number {
  let max = 0;
  for (const c of Object.values(m.circuits)) {
    for (const x of c.contributions) max = Math.max(max, x.turn);
  }
  return max;
}

function invariantProblems(m: Manifest): string[] {
  const p: string[] = [];
  const last = lastTurn(m);
  for (const [id, c] of Object.entries(m.circuits)) {
    c.contributions.forEach((x, i) => {
      if (x.index !== i + 1) p.push(`circuits.${id}.contributions[${i}].index must be ${i + 1}`);
    });
    const turns = c.contributions.map((x) => x.turn);
    for (let t = c.openedAtTurn + 1; t <= last; t++) {
      if (!turns.includes(t)) p.push(`circuits.${id}: missing turn ${t}`);
    }
    turns.forEach((t, i) => {
      if (t <= c.openedAtTurn) p.push(`circuits.${id}.contributions[${i}]: turn ${t} is not after openedAtTurn ${c.openedAtTurn}`);
      if (i > 0 && t <= turns[i - 1]) p.push(`circuits.${id}.contributions[${i}]: turns must increase`);
    });
  }
  // Each turn's contributor metadata must match across circuits.
  const firstSeen = new Map<number, { id: string; c: Contribution }>();
  for (const [id, chain] of Object.entries(m.circuits)) {
    for (const c of chain.contributions) {
      const ref = firstSeen.get(c.turn);
      if (!ref) {
        firstSeen.set(c.turn, { id, c });
        continue;
      }
      for (const f of TURN_FIELDS) {
        if (c[f] !== ref.c[f]) p.push(`circuits.${id}: turn ${c.turn} ${f} differs from circuits.${ref.id} (${c[f]} vs ${ref.c[f]})`);
      }
    }
  }
  return p;
}

/** Validate a parsed manifest.json. Throws ManifestError listing every problem. */
export function parseManifest(json: unknown): Manifest {
  if (!isRecord(json)) throw new ManifestError(['manifest must be a JSON object']);
  const schema = schemaProblems(json);
  if (schema.length > 0) throw new ManifestError(schema);
  const m = json as unknown as Manifest;
  const invariants = invariantProblems(m);
  if (invariants.length > 0) throw new ManifestError(invariants);
  return m;
}

/** Return a copy of `m` with the next turn appended to every open circuit. */
export function appendTurn(m: Manifest, t: TurnInput): Manifest {
  const open = Object.entries(m.circuits).filter(([, c]) => c.status === 'open').map(([id]) => id);
  if (open.length === 0) throw new Error('no open circuits');
  for (const id of Object.keys(t.perCircuit)) {
    if (!open.includes(id)) throw new Error(`${id} is not an open circuit`);
  }
  for (const id of open) {
    if (!t.perCircuit[id]) throw new Error(`missing contribution for open circuit ${id}`);
  }
  const next = structuredClone(m);
  const turn = lastTurn(m) + 1;
  for (const id of open) {
    const chain = next.circuits[id];
    const pc = t.perCircuit[id];
    chain.contributions.push({
      index: chain.contributions.length + 1,
      turn,
      contributor: t.contributor,
      zkeySha256: pc.zkeySha256,
      contributionHash: pc.contributionHash,
      mirrors: structuredClone(pc.mirrors),
      toolVersion: t.toolVersion,
      mode: t.mode,
      attestation: t.attestation,
      timestamp: t.timestamp,
    });
  }
  return next;
}

/** Paths (at the granularity reviewers care about) where two manifests differ. */
function changedPaths(a: Manifest, b: Manifest): string[] {
  const paths: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === 'circuits') continue;
    if (!isDeepStrictEqual((a as unknown as Record<string, unknown>)[k], (b as unknown as Record<string, unknown>)[k])) paths.push(k);
  }
  const ids = new Set([...Object.keys(a.circuits), ...Object.keys(b.circuits)]);
  for (const id of ids) {
    const ca = a.circuits[id];
    const cb = b.circuits[id];
    if (!ca || !cb) {
      paths.push(`circuits.${id}`);
      continue;
    }
    for (const f of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
      if (f === 'contributions') continue;
      if (!isDeepStrictEqual((ca as unknown as Record<string, unknown>)[f], (cb as unknown as Record<string, unknown>)[f])) {
        paths.push(`circuits.${id}.${f}`);
      }
    }
    const n = Math.max(ca.contributions.length, cb.contributions.length);
    for (let i = 0; i < n; i++) {
      if (!isDeepStrictEqual(ca.contributions[i], cb.contributions[i])) paths.push(`circuits.${id}.contributions[${i}]`);
    }
  }
  return paths;
}

/**
 * The manifest rule for a contribution PR: `next` must equal `prev` plus exactly
 * one new turn, made by `author` with the required tool version, on every open
 * circuit. Returns problems (empty = acceptable); never throws on bad input.
 */
export function checkContributionAppend(prev: Manifest, next: unknown, author: string): string[] {
  let parsed: Manifest;
  try {
    parsed = parseManifest(next);
  } catch (err) {
    if (err instanceof ManifestError) return err.problems.map((p) => `invalid manifest: ${p}`);
    throw err;
  }
  const closed = Object.entries(prev.circuits).filter(([, c]) => c.status !== 'open').map(([id]) => id);
  if (closed.length > 0) return [`no new contributions: circuits ${closed.join(', ')} are not open`];

  const expectedTurn = lastTurn(prev) + 1;
  const added = lastTurn(parsed) - lastTurn(prev);
  if (added !== 1) return [`expected exactly one new turn (${expectedTurn}), found ${added}`];

  // Remove the new turn and require everything else to be unchanged.
  const stripped = structuredClone(parsed);
  for (const c of Object.values(stripped.circuits)) {
    c.contributions = c.contributions.filter((x) => x.turn !== expectedTurn);
  }
  const problems: string[] = [];
  const changed = changedPaths(prev, stripped);
  if (changed.length > 0) problems.push(`changes outside the new turn: ${changed.join(', ')}`);

  const newEntry = Object.values(parsed.circuits).flatMap((c) => c.contributions).find((x) => x.turn === expectedTurn);
  if (newEntry) {
    if (newEntry.contributor !== author) {
      problems.push(`new turn ${expectedTurn} is by ${newEntry.contributor}, but the PR author is ${author}`);
    }
    if (newEntry.toolVersion !== prev.requiredToolVersion) {
      problems.push(`new turn ${expectedTurn} uses tool ${newEntry.toolVersion}, but the manifest requires ${prev.requiredToolVersion}`);
    }
  }
  return problems;
}
