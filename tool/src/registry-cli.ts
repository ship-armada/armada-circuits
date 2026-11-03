// ABOUTME: Command-line view of circuits.json for the shell scripts (compile.sh, setup-dev.sh).
// ABOUTME: `list [--ceremony] [ids...]` prints one "id<TAB>entry<TAB>ptauPower" line per circuit.

import path from 'node:path';
import { ceremonyCircuits, loadRegistry, selectCircuits } from './registry';

const ROOT = path.join(__dirname, '..', '..');

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command !== 'list') {
    console.error('usage: registry-cli list [--ceremony] [ids...]');
    return 2;
  }
  const ceremonyOnly = rest.includes('--ceremony');
  const ids = rest.filter((a) => a !== '--ceremony');
  const reg = loadRegistry(ROOT);
  let circuits = selectCircuits(reg, ids);
  if (ceremonyOnly) {
    const inCeremony = new Set(ceremonyCircuits(reg).map((c) => c.id));
    circuits = circuits.filter((c) => inCeremony.has(c.id));
  }
  for (const c of circuits) console.log(`${c.id}\t${c.entry}\t${c.ptauPower}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
