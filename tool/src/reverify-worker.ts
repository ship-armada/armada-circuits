// ABOUTME: Child process for `accept --reverify`: runs the full contribution check on already-downloaded zkeys.
// ABOUTME: Started with a minimal environment (no GitHub token, temporary HOME) and given its job on stdin.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runContributionCheck, urlAllowedByPattern, type CheckResult, type PrData } from './check';
import type { Manifest } from './manifest';
import { releaseCurve } from './snark';

export interface ReverifyJob {
  pr: PrData;
  prevManifest: Manifest;
  /** Holds <circuit>.zkey files whose sha256 already matches the manifest, so nothing is downloaded. */
  workDir: string;
  r1cs: Record<string, string>;
  ptauPath: string;
  /** Allowlist regex source with `{author}`; default is the PR author's GitHub release assets. */
  allowedUrlPattern?: string;
}

/**
 * Run the check in a child process with no GitHub credentials in its
 * environment, so a parser bug triggered by a hostile zkey cannot reach the
 * coordinator's token. (The Docker image in M6 adds filesystem isolation.)
 */
export function runReverifyWorker(job: ReverifyJob): Promise<CheckResult> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reverify-home-'));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [__filename], { env: { PATH: process.env.PATH ?? '', HOME: home }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      fs.rmSync(home, { recursive: true, force: true });
      try {
        resolve(JSON.parse(stdout) as CheckResult);
      } catch {
        reject(new Error(`re-verify process failed: ${stderr.trim() || err?.message || 'no result'}`));
      }
    });
    child.stdin?.end(JSON.stringify(job));
  });
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ReverifyJob;
  const result = await runContributionCheck(job.pr, {
    prevManifest: job.prevManifest,
    r1csFor: (id) => job.r1cs[id],
    ptauPath: job.ptauPath,
    workDir: job.workDir,
    urlAllowed: job.allowedUrlPattern ? urlAllowedByPattern(job.allowedUrlPattern) : undefined,
    // Every file is already in workDir with the right hash; refuse any network access.
    download: { fetch: (async () => { throw new Error('re-verify does not download'); }) as typeof fetch },
  });
  await releaseCurve();
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
