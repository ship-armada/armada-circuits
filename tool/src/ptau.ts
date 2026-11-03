// ABOUTME: Phase-1 ptau fetcher: tries each mirror in order and keeps a file only if sha256 and blake2b both match.
// ABOUTME: Also hashes files and runs the full `snarkjs powersoftau verify` of the transcript.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertUrlAllowed, downloadToFile, type DownloadOptions } from './http';
import { runVerifyWorker, type VerifyResult } from './verify-worker';

/** The Hermez power-17 ptau (D13): pinned hashes and known mirrors. */
export const HERMEZ_17 = {
  power: 17,
  sha256: '6b662a324867139fb1a20a324d90b6ff61856dfb23f59326909f14b0e2483ae0',
  blake2b: '6247a3433948b35fbfae414fa5a9355bfb45f56efa7ab4929e669264a0258976741dfbe3288bfb49828e5df02c2e633df38d2245e30162ae7e3bcca5b8b49345',
  mirrors: ['https://circom.info/powersOfTau28_hez_final_17.ptau'],
};

export interface FetchPtauOptions extends DownloadOptions {
  mirrors: string[];
  sha256: string;
  blake2b: string;
  dest: string;
}

export async function hashFile(file: string): Promise<{ sha256: string; blake2b: string }> {
  const sha = crypto.createHash('sha256');
  const blake = crypto.createHash('blake2b512');
  for await (const chunk of fs.createReadStream(file)) {
    sha.update(chunk as Buffer);
    blake.update(chunk as Buffer);
  }
  return { sha256: sha.digest('hex'), blake2b: blake.digest('hex') };
}

/**
 * Make `dest` hold the pinned ptau. An existing file with the pinned hashes is
 * kept; otherwise each mirror is tried in order, and a download is kept only
 * if both hashes match. Fails with every mirror's reason if none works.
 */
export async function fetchPtau(opts: FetchPtauOptions): Promise<{ path: string; url?: string; downloaded: boolean }> {
  for (const url of opts.mirrors) assertUrlAllowed(url, opts);
  const matches = (h: { sha256: string; blake2b: string }) => h.sha256 === opts.sha256 && h.blake2b === opts.blake2b;
  if (fs.existsSync(opts.dest) && matches(await hashFile(opts.dest))) return { path: opts.dest, downloaded: false };

  fs.mkdirSync(path.dirname(opts.dest), { recursive: true });
  const partial = `${opts.dest}.partial`;
  const failures: string[] = [];
  for (const url of opts.mirrors) {
    try {
      await downloadToFile(url, partial, opts);
      const got = await hashFile(partial);
      if (got.sha256 !== opts.sha256) throw new Error(`sha256 ${got.sha256} != pinned ${opts.sha256}`);
      if (got.blake2b !== opts.blake2b) throw new Error(`blake2b ${got.blake2b} != pinned ${opts.blake2b}`);
      fs.renameSync(partial, opts.dest);
      return { path: opts.dest, url, downloaded: true };
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      fs.rmSync(partial, { force: true });
    }
  }
  throw new Error(`no mirror served the pinned ptau:\n  ${failures.join('\n  ')}`);
}

/**
 * Full `snarkjs powersoftau verify`: checks every contribution and the beacon
 * recorded in the file. Takes ~35 min for power 17 on one M3 core.
 */
export async function verifyPtauTranscript(ptau: string): Promise<VerifyResult> {
  return runVerifyWorker(['ptau', ptau]);
}
