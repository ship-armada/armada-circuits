// ABOUTME: Entry point for the contribution-check workflow: loads a PR as data and runs runContributionCheck.
// ABOUTME: Runs from the base-branch checkout with a read-only token; writes the job summary; exit 1 on failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attestationPath } from './attestation';
import { checkSummary, runContributionCheck, type PrData } from './check';
import { MANIFEST_PATH } from './contributor';
import { CONTRIBUTION_BRANCH_PREFIX, GhCli, type MaintainerGitHub, type PullRequestInfo } from './github';
import { lastTurn, parseManifest, type Manifest } from './manifest';
import { artifactPaths, circuitById, loadRegistry } from './registry';
import { releaseCurve } from './snark';

const ROOT = path.join(__dirname, '..', '..');

/**
 * Load what the check needs from a PR: its author, head and changed paths,
 * and the contents of only the files a contribution may change (the manifest
 * and this turn's attestation). Nothing else from the PR is fetched.
 */
export async function loadPrData(gh: MaintainerGitHub, repo: string, number: number, prev: Manifest): Promise<{ info: PullRequestInfo; data: PrData }> {
  const info = await gh.getPullRequest(repo, number);
  const changedFiles = await gh.listPullRequestFiles(repo, number);
  const wanted = [MANIFEST_PATH, attestationPath(lastTurn(prev) + 1, info.author)];
  const files: Record<string, string> = {};
  if (info.headRef.startsWith(CONTRIBUTION_BRANCH_PREFIX)) {
    for (const f of wanted.filter((w) => changedFiles.includes(w))) files[f] = await gh.readFileAtRef(info.headRepo, f, info.headSha);
  }
  return { info, data: { author: info.author, headRef: info.headRef, changedFiles, files } };
}

async function main(): Promise<number> {
  const repo = process.env.GITHUB_REPOSITORY;
  const number = Number(process.env.PR_NUMBER);
  if (!repo || !Number.isInteger(number) || number < 1) {
    console.error('GITHUB_REPOSITORY and PR_NUMBER must be set');
    return 2;
  }
  // The base-branch checkout is the trusted source for the previous manifest, registry and r1cs.
  const prev = parseManifest(JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_PATH), 'utf8')));
  const reg = loadRegistry(ROOT);
  const { info, data } = await loadPrData(new GhCli(), repo, number, prev);
  console.log(`PR #${number} by @${info.author}, head ${info.headSha} (${info.headRef})`);

  const result = await runContributionCheck(data, {
    prevManifest: prev,
    r1csFor: (id) => artifactPaths(ROOT, circuitById(reg, id)).r1cs,
    ptauPath: path.join(ROOT, 'build', 'ptau', `pot${prev.ptau.power}_final.ptau`),
    workDir: path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'contribution-check'),
  });
  for (const i of result.items) console.log(`${i.ok ? 'ok  ' : 'FAIL'} ${i.name}: ${i.detail}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, checkSummary(result));
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    })
    .then(async (code) => {
      await releaseCurve();
      process.exit(code);
    });
}
