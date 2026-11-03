// ABOUTME: Child-process entry point that runs one snarkjs verification and prints {ok, messages} as JSON.
// ABOUTME: Modes: `zkey <r1cs> <ptau> <zkey>` (zkey verify) and `ptau <ptau>` (powersoftau verify).

import { execFile } from 'node:child_process';
import path from 'node:path';
import { powersOfTau, zKey } from 'snarkjs';

export interface VerifyResult {
  ok: boolean;
  messages: string[];
}

/**
 * Run a verification in a child process. snarkjs verify leaves file handles
 * open (e.g. the ptau in zkey verify's sameRatioH), which otherwise surface as
 * garbage-collection warnings; exiting the child closes them. It also keeps
 * parsing of untrusted files out of the calling process. Anything on the
 * child's stderr, or a crash, counts as a failed verification.
 */
export function runVerifyWorker(args: string[]): Promise<VerifyResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [__filename, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      try {
        const res = JSON.parse(stdout) as VerifyResult;
        if (stderr.trim() !== '') res.messages.push(stderr.trim());
        resolve({ ok: res.ok === true && stderr.trim() === '', messages: res.messages });
      } catch {
        resolve({ ok: false, messages: [err ? err.message : 'verify worker produced no result', stderr.trim()].filter((m) => m !== '') });
      }
    });
  });
}

async function main(): Promise<void> {
  const [mode, ...files] = process.argv.slice(2);
  const messages: string[] = [];
  const record = (...args: unknown[]) => messages.push(args.map(String).join(' '));
  // snarkjs reports some failures with console.log; keep stdout for the JSON result.
  console.log = record;
  const logger = { debug: () => {}, info: () => {}, warn: record, error: record };
  let ok = false;
  try {
    if (mode === 'zkey' && files.length === 3) {
      ok = (await zKey.verifyFromR1cs(files[0], files[1], files[2], logger)) === true;
    } else if (mode === 'ptau' && files.length === 1) {
      ok = (await powersOfTau.verify(files[0], logger)) === true;
    } else {
      messages.push(`usage: ${path.basename(__filename)} zkey <r1cs> <ptau> <zkey> | ptau <ptau>`);
    }
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err));
  }
  process.stdout.write(JSON.stringify({ ok, messages }));
  process.exit(0);
}

if (require.main === module) void main();
