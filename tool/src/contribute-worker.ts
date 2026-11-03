// ABOUTME: Short-lived child process that applies one contributor's secret to every circuit, then exits.
// ABOUTME: The job (including optional personal entropy) arrives on stdin, never argv; only hashes are printed.

import { execFile } from 'node:child_process';
import { contribute, releaseCurve } from './snark';

export interface ContributeJob {
  /** Contribution name recorded in each zkey. */
  name: string;
  /** Optional personal entropy; snarkjs always mixes in 64 bytes of OS randomness as well. */
  entropy?: string;
  circuits: { id: string; input: string; output: string }[];
}

export interface ContributeResult {
  contributionHashes: Record<string, string>;
}

/**
 * Run a contribution job in a child process. The secret lives only in that
 * process, whose memory is gone when it exits (D10). Each circuit gets its
 * own fresh randomness from snarkjs.
 */
export function runContributeWorker(job: ContributeJob): Promise<ContributeResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [__filename], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`contribution process failed: ${stderr.trim() || err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ContributeResult);
      } catch {
        reject(new Error(`contribution process returned no result${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      }
    });
    child.stdin?.end(JSON.stringify(job));
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const job = JSON.parse(await readStdin()) as ContributeJob;
  const contributionHashes: Record<string, string> = {};
  for (const c of job.circuits) {
    contributionHashes[c.id] = await contribute(c.input, c.output, { name: job.name, entropy: job.entropy });
  }
  await releaseCurve();
  process.stdout.write(JSON.stringify({ contributionHashes } satisfies ContributeResult));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
