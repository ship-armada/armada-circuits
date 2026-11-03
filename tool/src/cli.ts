// ABOUTME: `armada-ceremony` command line for contributors: doctor, contribute, submit, status, verify.
// ABOUTME: Run as `npm run ceremony -- <command>`; exit codes are 0 ok, 1 error, 2 usage, 3 turn held.

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { UsageError, defaultRepo, parseCommandLine, type CommandSpec, type ParsedCommand } from './args';
import { DEFAULT_REPO, contribute, loadManifest, submit, type ContributeOutcome, type ContributorDeps } from './contributor';
import { doctor, systemProbes } from './doctor';
import { GhCli } from './github';
import { artifactPaths, circuitById, loadRegistry } from './registry';
import { releaseCurve } from './snark';
import { TOOL_VERSION } from './version';
import { status, verify } from './verify';

export const ROOT = path.join(__dirname, '..', '..');
export const WORK_ROOT = path.join(ROOT, '.ceremony-work');

export const USAGE = `usage: npm run ceremony -- <command> [options]

commands:
  doctor [--no-practice]            check this machine and run a practice contribution
  contribute [--wait] [--download-only] [--personal-entropy]
                                    claim the turn and contribute to every open circuit
                                    --wait            wait for the turn instead of exiting
                                    --download-only   download the inputs for a BYO-tool run
                                    --personal-entropy  also mix in text you type (optional)
  submit <turn.json> <zkey-dir>     publish zkeys made by another tool (<zkey-dir>/<circuit>.zkey)
  status                            show the ceremony, who holds the turn, and your turns
  verify [--full] [--mine] [--circuits <id,id,...>]
                                    check the current zkeys against the manifest
  help                              show this help

options for every command:
  --repo <owner/name>               ceremony repo (default $ARMADA_CEREMONY_REPO, else ${DEFAULT_REPO})`;

export const EXIT = { ok: 0, error: 1, usage: 2, held: 3 } as const;
export { UsageError };

const COMMANDS: Record<string, CommandSpec> = {
  doctor: { options: { 'no-practice': { type: 'boolean' } } },
  contribute: { options: { wait: { type: 'boolean' }, 'download-only': { type: 'boolean' }, 'personal-entropy': { type: 'boolean' } } },
  submit: { options: {}, positionals: 2 },
  status: { options: {} },
  verify: { options: { full: { type: 'boolean' }, mine: { type: 'boolean' }, circuits: { type: 'string' } } },
  help: { options: {} },
};

export function parseCommand(argv: string[]): ParsedCommand {
  return parseCommandLine(argv, COMMANDS, defaultRepo());
}

/** Read a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void });
    process.stdout.write(question);
    write._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function runProcess(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function printOutcome(o: ContributeOutcome): number {
  if (o.kind === 'held') {
    console.log(o.message);
    return EXIT.held;
  }
  if (o.kind === 'downloaded') {
    console.log(`Inputs downloaded to ${o.inputDir}; your claim on the turn is kept (it lapses after 2 hours without a PR).`);
    console.log('Contribute to each <circuit>.zkey with your own tool, writing <circuit>.zkey files to one directory, then run:');
    console.log(`  npm run ceremony -- submit ${o.descriptorPath} <zkey-dir>`);
    return EXIT.ok;
  }
  console.log(`Contribution PR opened: ${o.pr.url}`);
  console.log('Contribution hashes:');
  for (const [id, h] of Object.entries(o.contributionHashes)) console.log(`  ${id}: ${h}`);
  console.log(`Attestation sha256: ${o.attestationSha256}`);
  console.log('');
  console.log('To count toward the outside-participant quota, post this from a long-lived account outside GitHub');
  console.log('(X, Mastodon, a personal or org site) and paste the link on your PR:');
  console.log(`  ${o.suggestedPost}`);
  return EXIT.ok;
}

async function run(argv: string[]): Promise<number> {
  const cmd = parseCommand(argv);
  if (cmd.command === 'help') {
    console.log(USAGE);
    return EXIT.ok;
  }
  const deps: ContributorDeps = {
    gh: new GhCli(), repo: cmd.repo, workRoot: WORK_ROOT, toolVersion: TOOL_VERSION,
    now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (l) => console.log(l),
  };

  switch (cmd.command) {
    case 'doctor': {
      const r = await doctor({
        ...systemProbes(), run: runProcess, workRoot: WORK_ROOT, toolVersion: TOOL_VERSION,
        requiredToolVersion: async () => (await loadManifest(deps)).requiredToolVersion, practice: cmd.flags['no-practice'] !== true,
      });
      for (const c of r.checks) {
        const mark = c.ok ? '✓' : c.severity === 'warning' ? '!' : '✗';
        console.log(`${mark} ${c.name}: ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ''}`);
      }
      console.log(r.ok ? 'Ready to contribute.' : 'Fix the ✗ items above, then run doctor again.');
      return r.ok ? EXIT.ok : EXIT.error;
    }
    case 'contribute': {
      const entropy = cmd.flags['personal-entropy'] ? await promptHidden('Personal entropy (not shown, not stored): ') : undefined;
      return printOutcome(await contribute(deps, { wait: cmd.flags.wait === true, downloadOnly: cmd.flags['download-only'] === true, entropy }));
    }
    case 'submit':
      return printOutcome(await submit(deps, { descriptor: path.resolve(cmd.positionals[0]), zkeyDir: path.resolve(cmd.positionals[1]) }));
    case 'status': {
      for (const l of (await status(deps)).lines) console.log(l);
      return EXIT.ok;
    }
    case 'verify': {
      const reg = loadRegistry(ROOT);
      const manifest = await loadManifest(deps);
      const r = await verify(deps, {
        full: cmd.flags.full === true,
        mine: cmd.flags.mine === true,
        circuits: typeof cmd.flags.circuits === 'string' ? cmd.flags.circuits.split(',').filter((s) => s !== '') : undefined,
        r1csFor: (id) => artifactPaths(ROOT, circuitById(reg, id)).r1cs,
        ptauPath: path.join(ROOT, 'build', 'ptau', `pot${manifest.ptau.power}_final.ptau`),
      });
      for (const l of r.lines) console.log(l);
      console.log(r.ok ? 'All checks passed.' : 'Some checks FAILED.');
      return r.ok ? EXIT.ok : EXIT.error;
    }
    default:
      throw new UsageError(`unknown command: ${cmd.command}`);
  }
}

async function main(): Promise<void> {
  let code: number;
  try {
    code = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      code = EXIT.usage;
    } else {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      code = EXIT.error;
    }
  }
  await releaseCurve();
  process.exit(code);
}

if (require.main === module) void main();
