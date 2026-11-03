// ABOUTME: The contribution check CI runs on every ceremony PR: files, manifest rule, attestation, each zkey's
// ABOUTME: download/history/verify, and distinct secrets. PR content is treated as hostile data throughout.

import fs from 'node:fs';
import path from 'node:path';
import { attestationPath, attestationProblems, serializeAttestation, type Attestation } from './attestation';
import { MANIFEST_PATH } from './contributor';
import { CONTRIBUTION_BRANCH_PREFIX } from './github';
import { downloadVerified, sha256File, type DownloadOptions } from './http';
import { checkContributionAppend, lastTurn, parseManifest, type Manifest } from './manifest';
import { newContributionProblems, readMpcParams, sameSecret, verifyZkey, type ZkeyContribution } from './snark';

export interface PrData {
  author: string;
  headRef: string;
  /** Every path the PR changes. */
  changedFiles: string[];
  /** Contents at the PR head of the ceremony files it changes (as data; never executed). */
  files: Record<string, string>;
}

export interface CheckEnv {
  /** The manifest on the base branch. */
  prevManifest: Manifest;
  /** r1cs built from the base branch for a circuit. */
  r1csFor(id: string): string;
  /** The pinned phase-1 ptau (checked against the manifest's sha256). */
  ptauPath: string;
  workDir: string;
  download?: DownloadOptions;
  /** Whether `url` may be downloaded for a PR by `author` (default: their own GitHub release assets). */
  urlAllowed?(url: string, author: string): boolean;
  maxZkeyBytes?: number;
}

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  skipped?: boolean;
  items: CheckItem[];
}

/** Larger than any circuit's zkey (8x4 is ~41 MB); stops a hostile URL filling the disk. */
export const DEFAULT_MAX_ZKEY_BYTES = 128 * 1024 * 1024;

const RELEASE_ASSET = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/[A-Za-z0-9._-]+\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.zkey$/;

/** Only zkey assets on a release in one of the PR author's own repos. */
export function githubReleaseUrlAllowed(url: string, author: string): boolean {
  const m = RELEASE_ASSET.exec(url);
  return m !== null && m[1].toLowerCase() === author.toLowerCase();
}

export async function runContributionCheck(pr: PrData, env: CheckEnv): Promise<CheckResult> {
  if (!pr.headRef.startsWith(CONTRIBUTION_BRANCH_PREFIX)) {
    return { ok: true, skipped: true, items: [{ name: 'contribution PR', ok: true, detail: `branch ${pr.headRef} is not a ceremony contribution; nothing to check` }] };
  }
  const items: CheckItem[] = [];
  const pass = (name: string, detail: string) => items.push({ name, ok: true, detail });
  const fail = (name: string, detail: string) => items.push({ name, ok: false, detail });
  const done = () => ({ ok: items.every((i) => i.ok), items });
  const prev = env.prevManifest;
  const turn = lastTurn(prev) + 1;
  const attPath = attestationPath(turn, pr.author);

  // 1. Only the manifest and this turn's attestation may change.
  const allowed = [MANIFEST_PATH, attPath];
  const extra = pr.changedFiles.filter((f) => !allowed.includes(f));
  const missing = allowed.filter((f) => !pr.changedFiles.includes(f) || pr.files[f] === undefined);
  if (extra.length > 0 || missing.length > 0) {
    fail('files', [extra.length > 0 ? `changes files a contribution may not: ${extra.join(', ')}` : '', missing.length > 0 ? `missing ${missing.join(', ')}` : '']
      .filter((x) => x !== '').join('; '));
    return done();
  }
  pass('files', `only ${MANIFEST_PATH} and ${attPath}`);

  // 2. The manifest rule: exactly one new turn by the author, nothing else changed.
  let next: Manifest;
  try {
    const json: unknown = JSON.parse(pr.files[MANIFEST_PATH]);
    const problems = checkContributionAppend(prev, json, pr.author);
    if (problems.length > 0) {
      fail('manifest', problems.join('; '));
      return done();
    }
    next = parseManifest(json);
  } catch (err) {
    fail('manifest', `not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return done();
  }
  pass('manifest', `appends turn ${turn} by @${pr.author} and changes nothing else`);

  // 3. The attestation matches the turn and is byte-for-byte canonical (so its posted sha256 is reproducible).
  try {
    const att = JSON.parse(pr.files[attPath]) as Attestation;
    const problems = attestationProblems(att, prev, next);
    if (problems.length > 0) fail('attestation', problems.join('; '));
    else if (serializeAttestation(att).text !== pr.files[attPath]) fail('attestation', 'not in canonical form (sorted keys, two-space indent, trailing newline)');
    else pass('attestation', `matches turn ${turn}; sha256 ${serializeAttestation(att).sha256}`);
  } catch (err) {
    fail('attestation', `not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The pinned ptau the zkeys are verified against.
  const ptauSha = await sha256File(env.ptauPath).catch(() => 'missing');
  if (ptauSha !== prev.ptau.sha256) {
    fail('ptau', `${env.ptauPath} has sha256 ${ptauSha}, not the pinned ${prev.ptau.sha256}`);
    return done();
  }

  // 4-6. Each new zkey: allowed URL, size cap, sha256; history; zkey verify.
  const urlAllowed = env.urlAllowed ?? githubReleaseUrlAllowed;
  const newest: Record<string, ZkeyContribution> = {};
  const ids = Object.entries(prev.circuits).filter(([, c]) => c.status === 'open').map(([id]) => id).sort();
  fs.mkdirSync(env.workDir, { recursive: true });
  for (const id of ids) {
    const entry = next.circuits[id].contributions.find((c) => c.turn === turn)!;
    const urls = entry.mirrors.map((x) => x.url);
    const bad = urls.filter((u) => !urlAllowed(u, pr.author));
    if (urls.length === 0 || bad.length > 0) {
      fail(`${id} download`, urls.length === 0 ? 'no download URL' : `URL is not a release asset of @${pr.author}: ${bad.join(', ')}`);
      continue;
    }
    const file = path.join(env.workDir, `${id}.zkey`);
    try {
      await downloadVerified(urls, entry.zkeySha256, file, { ...env.download, maxBytes: env.maxZkeyBytes ?? DEFAULT_MAX_ZKEY_BYTES });
      pass(`${id} download`, `sha256 ${entry.zkeySha256}`);
    } catch (err) {
      fail(`${id} download`, err instanceof Error ? err.message : String(err));
      continue;
    }

    let params;
    try {
      params = await readMpcParams(file);
    } catch (err) {
      fail(`${id} history`, `cannot read the zkey: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const merged = prev.circuits[id].contributions;
    if (params.contributions.length !== merged.length + 1) {
      fail(`${id} history`, `zkey has ${params.contributions.length} contributions; expected ${merged.length + 1} (the merged chain plus one)`);
      continue;
    }
    const diverged = merged.findIndex((c, i) => params.contributions[i].contributionHash !== c.contributionHash);
    if (diverged >= 0) {
      fail(`${id} history`, `contribution ${diverged + 1} does not match the merged chain (stale or forked head)`);
      continue;
    }
    const last = params.contributions[params.contributions.length - 1];
    if (last.contributionHash !== entry.contributionHash) {
      fail(`${id} history`, 'the new contribution hash does not match the manifest');
      continue;
    }
    // The previous delta is in the zkey's own history, so no download of the old head is needed.
    const problems = newContributionProblems({ csHash: params.csHash, contributions: params.contributions.slice(0, -1) }, params);
    if (problems.length > 0) {
      fail(`${id} history`, problems.join('; '));
      continue;
    }
    pass(`${id} history`, `merged chain of ${merged.length} plus one new contribution`);
    newest[id] = last;

    const r1cs = env.r1csFor(id);
    const r1csSha = await sha256File(r1cs).catch(() => 'missing');
    if (r1csSha !== prev.circuits[id].r1csSha256) {
      fail(`${id} zkey verify`, `r1cs sha256 ${r1csSha} does not match the manifest`);
      continue;
    }
    const res = await verifyZkey(r1cs, env.ptauPath, file);
    if (res.ok) pass(`${id} zkey verify`, 'OK');
    else fail(`${id} zkey verify`, res.messages.join('; ') || 'invalid');
  }

  // 7. One secret per circuit.
  const checked = Object.keys(newest).sort();
  let reused: string | undefined;
  for (let i = 0; i < checked.length && !reused; i++) {
    for (let j = i + 1; j < checked.length && !reused; j++) {
      if (await sameSecret(newest[checked[i]], newest[checked[j]])) reused = `${checked[i]} and ${checked[j]} were contributed with the same secret`;
    }
  }
  if (reused) fail('distinct secrets', reused);
  else if (checked.length === ids.length) pass('distinct secrets', `all ${checked.length} new contributions use different secrets`);

  return done();
}

/** Markdown summary for the CI job page. */
export function checkSummary(r: CheckResult): string {
  const rows = r.items.map((i) => `| ${i.ok ? '✅' : '❌'} | ${i.name} | ${i.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  const verdict = r.skipped ? 'Not a contribution PR; skipped.' : r.ok ? 'All contribution checks passed.' : 'Contribution checks FAILED.';
  return [`## Contribution check`, '', verdict, '', '| | Check | Detail |', '|---|---|---|', ...rows, ''].join('\n');
}
