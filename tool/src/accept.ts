// ABOUTME: Coordinator `accept <PR>`: merge a contribution only if the base-branch check passed for its current head
// ABOUTME: (or a local re-verify passes), after copying its zkeys to the official release; then free the turn.

import fs from 'node:fs';
import path from 'node:path';
import { attestationPath } from './attestation';
import { githubReleaseUrlAllowed, urlAllowedByPattern, type CheckResult } from './check';
import { MANIFEST_PATH, loadManifest } from './contributor';
import { CONTRIBUTION_BRANCH_PREFIX, type MaintainerGitHub } from './github';
import { downloadVerified, type DownloadOptions } from './http';
import { checkContributionAppend, lastTurn, parseManifest } from './manifest';
import { runReverifyWorker, type ReverifyJob } from './reverify-worker';
import { DEFAULT_MAX_ZKEY_BYTES } from './check';

export const CHECK_WORKFLOW_PATH = '.github/workflows/contribution-check.yml';

export interface AcceptDeps {
  gh: MaintainerGitHub;
  repo: string;
  workRoot: string;
  log(line: string): void;
  download?: DownloadOptions;
  /** Allowlist regex source with `{author}` (default: the author's GitHub release assets). */
  allowedUrlPattern?: string;
  /** Replaces the child-process re-verify (for tests). */
  reverify?(job: ReverifyJob): Promise<CheckResult>;
}

export interface AcceptOptions {
  /** Run the full check locally (in a child process without credentials) instead of trusting CI. */
  reverify?: boolean;
  r1csFor(id: string): string;
  ptauPath: string;
}

export async function accept(deps: AcceptDeps, number: number, opts: AcceptOptions): Promise<{ turn: number; author: string; reverified: boolean }> {
  const { gh, repo } = deps;
  const m = await loadManifest(deps);
  const info = await gh.getPullRequest(repo, number);
  if (info.state !== 'open') throw new Error(`PR #${number} is ${info.state}`);
  if (!info.headRef.startsWith(CONTRIBUTION_BRANCH_PREFIX)) throw new Error(`PR #${number} (${info.headRef}) is not a ceremony contribution branch`);

  const turn = lastTurn(m) + 1;
  const attPath = attestationPath(turn, info.author);
  const changed = await gh.listPullRequestFiles(repo, number);
  const extra = changed.filter((f) => f !== MANIFEST_PATH && f !== attPath);
  if (extra.length > 0) throw new Error(`PR #${number} changes files a contribution may not: ${extra.join(', ')}`);
  if (!changed.includes(MANIFEST_PATH) || !changed.includes(attPath)) throw new Error(`PR #${number} must change exactly ${MANIFEST_PATH} and ${attPath}`);

  const nextText = await gh.readFileAtRef(info.headRepo, MANIFEST_PATH, info.headSha);
  const attText = await gh.readFileAtRef(info.headRepo, attPath, info.headSha);
  const problems = checkContributionAppend(m, JSON.parse(nextText), info.author);
  if (problems.length > 0) throw new Error(`PR #${number}: ${problems.join('; ')}`);
  const next = parseManifest(JSON.parse(nextText));

  if (!opts.reverify) {
    const runs = await gh.listWorkflowRuns(repo, info.headSha);
    const passed = runs.some((r) => r.path === CHECK_WORKFLOW_PATH && r.event === 'pull_request_target' && r.status === 'completed'
      && r.conclusion === 'success' && r.headSha === info.headSha);
    if (!passed) {
      throw new Error(`no passing contribution-check (pull_request_target) run for head ${info.headSha} of PR #${number}; `
        + 'wait for CI, or use --reverify if CI is down');
    }
  }

  // Download (hash only: no parsing here) the zkeys to copy to the official release.
  const urlAllowed = deps.allowedUrlPattern ? urlAllowedByPattern(deps.allowedUrlPattern) : githubReleaseUrlAllowed;
  const dir = path.join(deps.workRoot, `pr-${number}-${info.headSha.slice(0, 12)}`);
  const byCircuit = path.join(dir, 'by-circuit');
  fs.mkdirSync(byCircuit, { recursive: true });
  const files: string[] = [];
  const ids = Object.entries(m.circuits).filter(([, c]) => c.status === 'open').map(([id]) => id).sort();
  for (const id of ids) {
    const entry = next.circuits[id].contributions.find((c) => c.turn === turn)!;
    const urls = entry.mirrors.map((x) => x.url);
    const bad = urls.filter((u) => !urlAllowed(u, info.author));
    if (bad.length > 0) throw new Error(`${id}: URL is not a release asset of @${info.author}: ${bad.join(', ')}`);
    const name = path.basename(new URL(urls[0]).pathname);
    const file = path.join(dir, name);
    deps.log(`downloading ${name}...`);
    await downloadVerified(urls, entry.zkeySha256, file, { ...deps.download, maxBytes: DEFAULT_MAX_ZKEY_BYTES });
    fs.copyFileSync(file, path.join(byCircuit, `${id}.zkey`));
    files.push(file);
  }

  if (opts.reverify) {
    deps.log('re-verifying locally in a separate process...');
    const job: ReverifyJob = {
      pr: { author: info.author, headRef: info.headRef, changedFiles: changed, files: { [MANIFEST_PATH]: nextText, [attPath]: attText } },
      prevManifest: m,
      workDir: byCircuit,
      r1cs: Object.fromEntries(ids.map((id) => [id, opts.r1csFor(id)])),
      ptauPath: opts.ptauPath,
      allowedUrlPattern: deps.allowedUrlPattern,
    };
    const result = await (deps.reverify ?? runReverifyWorker)(job);
    if (!result.ok) {
      throw new Error(`local re-verify failed:\n  ${result.items.filter((i) => !i.ok).map((i) => `${i.name}: ${i.detail}`).join('\n  ')}`);
    }
  }

  deps.log(`copying ${files.length} zkeys to the ${m.coordination.officialReleaseTag} release...`);
  await gh.uploadToRelease(repo, m.coordination.officialReleaseTag, files, 'Accepted ceremony contributions (one file per circuit per turn).');
  await gh.mergePullRequest(repo, number, info.headSha);
  await gh.postIssueComment(repo, m.coordination.queueIssue, `Turn ${turn} by @${info.author} accepted (#${number}). The next contributor may start.`);
  return { turn, author: info.author, reverified: opts.reverify === true };
}
