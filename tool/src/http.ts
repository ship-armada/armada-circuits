// ABOUTME: Shared download helpers: stream a URL to a file, and download from mirrors until a sha256 matches.
// ABOUTME: https only, except when a caller explicitly allows http (local test servers).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';

export interface DownloadOptions {
  timeoutMs?: number;
  /** Allow http:// URLs; for tests against a local server only. */
  allowHttp?: boolean;
  /** fetch implementation; tests inject one that serves local files. */
  fetch?: typeof fetch;
  /** Abort a download larger than this many bytes (protects the disk from hostile URLs). */
  maxBytes?: number;
}

export function assertUrlAllowed(url: string, opts: DownloadOptions = {}): void {
  if (!opts.allowHttp && new URL(url).protocol !== 'https:') throw new Error(`URL must be https: ${url}`);
}

/** Stream `url` into `out`. Throws on a non-2xx response. */
export async function downloadToFile(url: string, out: string, opts: DownloadOptions = {}): Promise<void> {
  assertUrlAllowed(url, opts);
  const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const max = opts.maxBytes;
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (max !== undefined && seen > max) done(new Error(`download exceeds the ${max}-byte limit`));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as ReadableStream), limit, fs.createWriteStream(out));
  } catch (err) {
    fs.rmSync(out, { force: true });
    throw err;
  }
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Make `dest` hold the file with `sha256`: reuse an existing matching file,
 * else try each URL in order and keep the first download that matches.
 * Returns the URL used (undefined when reused). Fails with every URL's reason.
 */
export async function downloadVerified(urls: string[], sha256: string, dest: string, opts: DownloadOptions = {}): Promise<string | undefined> {
  for (const u of urls) assertUrlAllowed(u, opts);
  if (fs.existsSync(dest) && (await sha256File(dest)) === sha256) return undefined;
  const partial = `${dest}.partial`;
  const failures: string[] = [];
  for (const url of urls) {
    try {
      await downloadToFile(url, partial, opts);
      const got = await sha256File(partial);
      if (got !== sha256) throw new Error(`sha256 ${got} != expected ${sha256}`);
      fs.renameSync(partial, dest);
      return url;
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      fs.rmSync(partial, { force: true });
    }
  }
  throw new Error(`no URL served ${path.basename(dest)} with sha256 ${sha256}:\n  ${failures.join('\n  ')}`);
}
