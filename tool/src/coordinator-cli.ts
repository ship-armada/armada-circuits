// ABOUTME: `npm run coordinator -- <command>`: init, add-circuit, announce, accept, finalize, release.
// ABOUTME: Manifest changes are written to ceremony/ for a reviewed PR; exit codes are 0 ok, 1 error, 2 usage.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { accept } from './accept';
import { UsageError, defaultRepo, parseCommandLine, type CommandSpec, type ParsedCommand } from './args';
import { DEFAULT_REPO, MANIFEST_PATH, PARTICIPANTS_PATH, loadManifest } from './contributor';
import { addCircuit, announcementText, finalize, init, release, type CoordinatorDeps } from './coordinator';
import { GhCli } from './github';
import type { Manifest } from './manifest';
import { parseParticipants } from './participants';
import { artifactPaths, ceremonyCircuits, circuitById, loadRegistry } from './registry';
import { releaseCurve } from './snark';
import { TOOL_VERSION } from './version';

const ROOT = path.join(__dirname, '..', '..');
const WORK_ROOT = path.join(ROOT, '.ceremony-work', 'coordinator');

export const COORDINATOR_USAGE = `usage: npm run coordinator -- <command> [options]

commands:
  init --opens <iso> --closes <iso> --queue-issue <n> [--ptau-mirrors <url,url>] [--release-tag <tag>]
       [--circuits <id,id,...>] [--policy <contributions,outside,orgs,byo>] [--beacon-delay-hours <h>]
                                    build base zkeys for the ceremony circuits in circuits.json (or the
                                    given subset), upload them, and write ceremony/manifest.json +
                                    participants.json; defaults: policy 10,5,3,1, beacon 48 h after close
  add-circuit <id>                  add a circuits.json circuit as a new chain from the next turn on
  announce [--tag <name>]           print the commitment; --tag also creates a signed git tag with it
  accept <pr> [--reverify]          merge a contribution PR whose contribution check passed for its head,
                                    after copying its zkeys to the official release; frees the turn
                                    --reverify  run the full check locally instead (use if CI is down)
  finalize                          after the window: policy check, drand beacon, verify, export keys
  release --tag <tag> [--sign-key <ssh key>] [--publish]
                                    publish every artifact with SHA256SUMS and TRANSCRIPT.md (draft by default)
  help                              show this help

Commands that change the manifest write ceremony/manifest.json; commit it in a reviewed PR.

options for every command:
  --repo <owner/name>               ceremony repo (default $ARMADA_CEREMONY_REPO, else ${DEFAULT_REPO})`;

const COMMANDS: Record<string, CommandSpec> = {
  init: {
    options: {
      opens: { type: 'string' }, closes: { type: 'string' }, 'queue-issue': { type: 'string' }, 'ptau-mirrors': { type: 'string' },
      'release-tag': { type: 'string' }, circuits: { type: 'string' }, policy: { type: 'string' }, 'beacon-delay-hours': { type: 'string' },
    },
  },
  'add-circuit': { options: {}, positionals: 1 },
  announce: { options: { tag: { type: 'string' } } },
  accept: { options: { reverify: { type: 'boolean' } }, positionals: 1 },
  finalize: { options: {} },
  release: { options: { tag: { type: 'string' }, 'sign-key': { type: 'string' }, publish: { type: 'boolean' } } },
  help: { options: {} },
};

export function parseCoordinatorCommand(argv: string[]): ParsedCommand {
  const cmd = parseCommandLine(argv, COMMANDS, defaultRepo());
  if (cmd.command === 'accept' && !/^[1-9]\d*$/.test(cmd.positionals[0])) throw new UsageError(`accept takes a PR number, got ${cmd.positionals[0]}`);
  if (cmd.command === 'init') {
    for (const f of ['opens', 'closes', 'queue-issue']) if (typeof cmd.flags[f] !== 'string') throw new UsageError(`init needs --${f}`);
    for (const f of ['opens', 'closes']) if (Number.isNaN(Date.parse(cmd.flags[f] as string))) throw new UsageError(`--${f} must be an ISO 8601 time`);
    if (!/^[1-9]\d*$/.test(cmd.flags['queue-issue'] as string)) throw new UsageError('--queue-issue must be an issue number');
    if (cmd.flags.policy !== undefined && !/^\d+,\d+,\d+,\d+$/.test(cmd.flags.policy as string)) {
      throw new UsageError('--policy must be four non-negative integers: contributions,outside,organisations,byo');
    }
    const delay = cmd.flags['beacon-delay-hours'];
    if (delay !== undefined && !(Number(delay) > 0)) throw new UsageError('--beacon-delay-hours must be a positive number');
  }
  if (cmd.command === 'release' && typeof cmd.flags.tag !== 'string') throw new UsageError('release needs --tag');
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
  const deps: CoordinatorDeps = { gh, repo: cmd.repo, workRoot: WORK_ROOT, log: (l) => console.log(l), now: () => Date.now() };
  const r1csFor = (id: string) => artifactPaths(ROOT, circuitById(reg, id)).r1cs;
  const wasmFor = (id: string) => artifactPaths(ROOT, circuitById(reg, id)).wasm;
  const ptauFor = (power: number) => path.join(ROOT, 'build', 'ptau', `pot${power}_final.ptau`);
  const writeManifest = (m: Manifest) => {
    fs.writeFileSync(path.join(ROOT, MANIFEST_PATH), `${JSON.stringify(m, null, 2)}\n`);
    console.log(`Wrote ${MANIFEST_PATH}. Commit it in a PR for review; it takes effect when merged.`);
  };
  const participants = async () => parseParticipants(JSON.parse(await gh.readDefaultBranchFile(cmd.repo, PARTICIPANTS_PATH)));

  switch (cmd.command) {
    case 'init': {
      if (fs.existsSync(path.join(ROOT, MANIFEST_PATH))) throw new Error(`${MANIFEST_PATH} already exists; init starts a new ceremony only`);
      const subset = typeof cmd.flags.circuits === 'string' ? (cmd.flags.circuits as string).split(',').filter((x) => x !== '') : [];
      for (const id of subset) if (!circuitById(reg, id).ceremony) throw new Error(`circuit ${id} is not a ceremony circuit in circuits.json`);
      const chosen = ceremonyCircuits(reg).filter((c) => subset.length === 0 || subset.includes(c.id));
      const circuits = chosen.map((c) => ({ id: c.id, r1cs: artifactPaths(ROOT, c).r1cs, wasm: artifactPaths(ROOT, c).wasm }));
      const powers = [...new Set(chosen.map((c) => c.ptauPower))];
      const policyNumbers = typeof cmd.flags.policy === 'string' ? (cmd.flags.policy as string).split(',').map(Number) : undefined;
      if (powers.length !== 1) throw new Error(`ceremony circuits need one ptau power, found ${powers.join(', ')}`);
      const { manifest, participants: people } = await init(deps, {
        circuits, ptauPath: ptauFor(powers[0]), opens: cmd.flags.opens as string, closes: cmd.flags.closes as string,
        queueIssue: Number(cmd.flags['queue-issue']), toolVersion: TOOL_VERSION,
        ptauMirrors: typeof cmd.flags['ptau-mirrors'] === 'string' ? (cmd.flags['ptau-mirrors'] as string).split(',').filter((u) => u !== '') : undefined,
        releaseTag: cmd.flags['release-tag'] as string | undefined,
        policy: policyNumbers
          ? { minContributions: policyNumbers[0], minOutside: policyNumbers[1], minOutsideOrgs: policyNumbers[2], minByo: policyNumbers[3] }
          : undefined,
        beaconDelayMs: cmd.flags['beacon-delay-hours'] !== undefined ? Number(cmd.flags['beacon-delay-hours']) * 3600_000 : undefined,
      });
      fs.mkdirSync(path.join(ROOT, 'ceremony'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, PARTICIPANTS_PATH), `${JSON.stringify(people, null, 2)}\n`);
      writeManifest(manifest);
      console.log(`\n${announcementText(manifest)}`);
      return 0;
    }
    case 'add-circuit': {
      const c = circuitById(reg, cmd.positionals[0]);
      const m = await loadManifest(deps);
      writeManifest(await addCircuit(deps, m, { id: c.id, r1cs: artifactPaths(ROOT, c).r1cs, wasm: artifactPaths(ROOT, c).wasm }, ptauFor(m.ptau.power)));
      return 0;
    }
    case 'announce': {
      const text = announcementText(await loadManifest(deps));
      console.log(text);
      if (typeof cmd.flags.tag === 'string') {
        execFileSync('git', ['tag', '-s', cmd.flags.tag, '-m', text], { cwd: ROOT, stdio: 'inherit' });
        console.log(`\nCreated signed tag ${cmd.flags.tag}. Publish it with: git push origin ${cmd.flags.tag}`);
      }
      return 0;
    }
    case 'accept': {
      const manifest = await loadManifest(deps);
      const r = await accept({ gh, repo: cmd.repo, workRoot: WORK_ROOT, log: (l) => console.log(l) }, Number(cmd.positionals[0]), {
        reverify: cmd.flags.reverify === true, r1csFor, ptauPath: ptauFor(manifest.ptau.power),
      });
      console.log(`Accepted turn ${r.turn} by @${r.author}${r.reverified ? ' (re-verified locally)' : ''}. Now record their public post and classification in ceremony/participants.json.`);
      return 0;
    }
    case 'finalize': {
      const m = await loadManifest(deps);
      const { manifest } = await finalize(deps, m, await participants(), { r1csFor, ptauPath: ptauFor(m.ptau.power) });
      writeManifest(manifest);
      return 0;
    }
    case 'release': {
      const m = await loadManifest(deps);
      const tag = cmd.flags.tag as string;
      const r = await release(deps, m, await participants(), {
        tag, outDir: path.join(WORK_ROOT, `release-${tag}`), r1csFor, wasmFor, ptauPath: ptauFor(m.ptau.power),
        signingKey: cmd.flags['sign-key'] as string | undefined, publish: cmd.flags.publish === true,
      });
      console.log(`Uploaded ${r.assets.length} assets to release ${tag}${cmd.flags.publish ? '' : ' (draft: review and publish it on GitHub)'}.`);
      return 0;
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
