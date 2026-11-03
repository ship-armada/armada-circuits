// ABOUTME: Contribution attestations (ceremony/attestations/turn-NNNN-<handle>.json): build, canonical bytes, checks.
// ABOUTME: Contributors post the attestation's sha256 publicly, so serialization is canonical (sorted keys).

import crypto from 'node:crypto';
import { lastTurn, type ContributionMode, type Manifest } from './manifest';

export const ATTESTATION_STATEMENT =
  'I made this contribution with secret randomness that no one else saw. The secret existed only in the ' +
  'contribution process, which exited when it finished, and I kept no copy of it.';

export interface AttestationCircuit {
  /** sha256 of the zkey this contribution was applied to (the previous head). */
  previousZkeySha256: string;
  zkeySha256: string;
  contributionHash: string;
}

export interface Attestation {
  version: 1;
  /** Upstream repo the ceremony runs in. */
  ceremony: string;
  turn: number;
  contributor: string;
  mode: ContributionMode;
  toolVersion: string;
  timestamp: string;
  circuits: Record<string, AttestationCircuit>;
  statement: string;
}

export function buildAttestation(a: Omit<Attestation, 'version' | 'statement'>): Attestation {
  return { version: 1, ...a, statement: ATTESTATION_STATEMENT };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** JSON with keys sorted at every level, two-space indent and a trailing newline. */
export function canonicalJson(v: unknown): string {
  return `${JSON.stringify(sortKeys(v), null, 2)}\n`;
}

export function serializeAttestation(a: Attestation): { text: string; sha256: string } {
  const text = canonicalJson(a);
  return { text, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

export function attestationPath(turn: number, contributor: string): string {
  return `ceremony/attestations/turn-${String(turn).padStart(4, '0')}-${contributor}.json`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The zkey a circuit's next contribution must build on. */
export function headZkeySha256(m: Manifest, circuit: string): string {
  const chain = m.circuits[circuit];
  const last = chain.contributions[chain.contributions.length - 1];
  return last ? last.zkeySha256 : chain.base.zkeySha256;
}

/**
 * Problems with an attestation for the turn that `next` adds on top of `prev`
 * (empty = consistent). Never throws on malformed input.
 */
export function attestationProblems(att: unknown, prev: Manifest, next: Manifest): string[] {
  if (!isRecord(att)) return ['attestation must be a JSON object'];
  const p: string[] = [];
  if (att.version !== 1) p.push('attestation.version must be 1');
  if (att.statement !== ATTESTATION_STATEMENT) p.push('attestation.statement must be the standard statement');
  if (att.ceremony !== prev.coordination.repo) p.push(`attestation ceremony ${String(att.ceremony)} is not ${prev.coordination.repo}`);

  const turn = lastTurn(prev) + 1;
  const entries = Object.entries(next.circuits)
    .map(([id, c]) => ({ id, e: c.contributions.find((x) => x.turn === turn) }))
    .filter((x): x is { id: string; e: NonNullable<typeof x.e> } => x.e !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (entries.length === 0) return [...p, `manifest has no turn ${turn}`];
  const ref = entries[0].e;

  if (att.turn !== turn) p.push(`attestation turn ${String(att.turn)} does not match manifest turn ${turn}`);
  if (att.contributor !== ref.contributor) p.push(`attestation contributor ${String(att.contributor)} does not match manifest contributor ${ref.contributor}`);
  if (att.mode !== ref.mode) p.push(`attestation mode ${String(att.mode)} does not match manifest mode ${ref.mode}`);
  if (att.toolVersion !== ref.toolVersion) p.push(`attestation toolVersion ${String(att.toolVersion)} does not match the manifest`);
  if (att.timestamp !== ref.timestamp) p.push('attestation timestamp does not match the manifest');

  const circuits = isRecord(att.circuits) ? att.circuits : {};
  const want = entries.map((x) => x.id);
  if (Object.keys(circuits).sort().join(',') !== want.join(',')) {
    p.push(`attestation circuits must be exactly ${want.join(', ')}`);
    return p;
  }
  for (const { id, e } of entries) {
    const c = circuits[id];
    if (!isRecord(c)) {
      p.push(`attestation ${id} must be an object`);
      continue;
    }
    if (c.zkeySha256 !== e.zkeySha256) p.push(`attestation ${id}.zkeySha256 does not match the manifest`);
    if (c.contributionHash !== e.contributionHash) p.push(`attestation ${id}.contributionHash does not match the manifest`);
    if (c.previousZkeySha256 !== headZkeySha256(prev, id)) p.push(`attestation ${id}.previousZkeySha256 is not the previous head of ${id}`);
  }
  return p;
}
