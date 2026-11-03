// ABOUTME: `npm run coordinator -- <command>`: the coordinators' command line (accept now; init/finalize/release next).
// ABOUTME: Uses the coordinator's own gh login; exit codes are 0 ok, 1 error, 2 usage.

import path from 'node:path';
import { accept } from './accept';
import { UsageError, parseCommandLine, type CommandSpec, type ParsedCommand } from './args';
import { DEFAULT_REPO, loadManifest } from './contributor';
import { GhCli } from './github';
import { artifactPaths, circuitById, loadRegistry } from './registry';
import { releaseCurve } from './snark';

const ROOT = path.join(__dirname, '..', '..');
const WORK_ROOT = path.join(ROOT, '.ceremony-work', 'coordinator');

export const COORDINATOR_USAGE = `usage: npm run coordinator -- <command> [options]

commands:
  accept <pr> [--reverify]          merge a contribution PR whose contribution check passed for its head,
                                    after copying its zkeys to the official release; frees the turn
                                    --reverify  run the full check locally instead (use if CI is down)
  help                              show this help

options for every command:
  --repo <owner/name>               ceremony repo (default ${DEFAULT_REPO})`;

const COMMANDS: Record<string, CommandSpec> = {
  accept: { options: { reverify: { type: 'boolean' } }, positionals: 1 },
  help: { options: {} },
};

export function parseCoordinatorCommand(argv: string[]): ParsedCommand {
  const cmd = parseCommandLine(argv, COMMANDS, DEFAULT_REPO);
  if (cmd.command === 'accept' && !/^[1-9]\d*$/.test(cmd.positionals[0])) throw new UsageError(`accept takes a PR number, got ${cmd.positionals[0]}`);
  return cmd;
}

async function run(argv: string[]): Promise<number> {
  const cmd = parseCoordinatorCommand(argv);
  if (cmd.command === 'help') {
    console.log(COORDINATOR_USAGE);
    return 0;
  }
  const gh = new GhCli();
  const reg = loadRegistry(ROOT);
  const manifest = await loadManifest({ gh, repo: cmd.repo });
  const r = await accept({ gh, repo: cmd.repo, workRoot: WORK_ROOT, log: (l) => console.log(l) }, Number(cmd.positionals[0]), {
    reverify: cmd.flags.reverify === true,
    r1csFor: (id) => artifactPaths(ROOT, circuitById(reg, id)).r1cs,
    ptauPath: path.join(ROOT, 'build', 'ptau', `pot${manifest.ptau.power}_final.ptau`),
  });
  console.log(`Accepted turn ${r.turn} by @${r.author}${r.reverified ? ' (re-verified locally)' : ''}. Now record their public post and classification in ceremony/participants.json.`);
  return 0;
}

async function main(): Promise<void> {
  let code: number;
  try {
    code = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${COORDINATOR_USAGE}`);
      code = 2;
    } else {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      code = 1;
    }
  }
  await releaseCurve();
  process.exit(code);
}

if (require.main === module) void main();
