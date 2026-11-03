// ABOUTME: Child-process entry point that runs one `snarkjs zkey verify` and prints {ok, messages} as JSON.
// ABOUTME: snarkjs verify leaves files open (e.g. the ptau in sameRatioH); exiting the process closes them cleanly.

import { zKey } from 'snarkjs';

async function main(): Promise<void> {
  const [r1cs, ptau, zkey] = process.argv.slice(2);
  const messages: string[] = [];
  const record = (...args: unknown[]) => messages.push(args.map(String).join(' '));
  // snarkjs reports some failures with console.log; keep stdout for the JSON result.
  console.log = record;
  const logger = { debug: () => {}, info: () => {}, warn: record, error: record };
  let ok = false;
  try {
    ok = (await zKey.verifyFromR1cs(r1cs, ptau, zkey, logger)) === true;
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err));
  }
  process.stdout.write(JSON.stringify({ ok, messages }));
  process.exit(0);
}

void main();
