// ABOUTME: `doctor`: checks a contributor's machine (Node, gh, disk, memory, tool version) before their turn,
// ABOUTME: and runs a practice contribution on the bundled practice assets (no circom or download needed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runContributeWorker } from './contribute-worker';
import { newContributionProblems, readMpcParams, verifyZkey } from './snark';

export interface Check {
  name: string;
  ok: boolean;
  severity: 'error' | 'warning';
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  nodeVersion: string;
  totalMemBytes: number;
  freeDiskBytes(dir: string): number;
  workRoot: string;
  toolVersion: string;
  /** The ceremony's required tool version (from the manifest on main). */
  requiredToolVersion(): Promise<string>;
  /** Run the practice contribution. */
  practice: boolean;
}

const GB = 1024 ** 3;
const MIN_NODE_MAJOR = 22;
const MIN_GH: [number, number] = [2, 48]; // `gh api --slurp`
const MIN_DISK_GB = 2;
const MIN_MEM_GB = 4;
export const PRACTICE_DIR = path.join(__dirname, '..', '..', 'tool', 'assets', 'practice');

const parseVersion = (s: string): number[] | undefined => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

async function practiceRun(workRoot: string): Promise<Check> {
  const name = 'practice contribution';
  const dir = fs.mkdtempSync(path.join(workRoot, 'practice-'));
  try {
    const base = path.join(PRACTICE_DIR, 'practice-base.zkey');
    const out = path.join(dir, 'practice-1.zkey');
    await runContributeWorker({ name: 'doctor practice', circuits: [{ id: 'practice', input: base, output: out }] });
    const problems = newContributionProblems(await readMpcParams(base), await readMpcParams(out));
    if (problems.length > 0) return { name, ok: false, severity: 'error', detail: problems.join('; ') };
    const res = await verifyZkey(path.join(PRACTICE_DIR, 'practice.r1cs'), path.join(PRACTICE_DIR, 'practice.ptau'), out);
    if (!res.ok) return { name, ok: false, severity: 'error', detail: `zkey verify failed: ${res.messages.join('; ')}` };
    return { name, ok: true, severity: 'error', detail: 'contributed to a test circuit in a separate process and verified it' };
  } catch (err) {
    return { name, ok: false, severity: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function doctor(deps: DoctorDeps): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  const nodeMajor = parseVersion(deps.nodeVersion)?.[0] ?? 0;
  checks.push(nodeMajor >= MIN_NODE_MAJOR
    ? { name: 'node', ok: true, severity: 'error', detail: `Node ${deps.nodeVersion}` }
    : { name: 'node', ok: false, severity: 'error', detail: `Node ${deps.nodeVersion}; ${MIN_NODE_MAJOR} or newer is required`, fix: 'install Node 22 LTS from https://nodejs.org' });

  let ghInstalled = false;
  try {
    const v = await deps.run('gh', ['--version']);
    ghInstalled = true;
    const ver = parseVersion(v.stdout);
    const ghOk = ver !== undefined && (ver[0] > MIN_GH[0] || (ver[0] === MIN_GH[0] && ver[1] >= MIN_GH[1]));
    checks.push(ghOk
      ? { name: 'gh version', ok: true, severity: 'error', detail: v.stdout.split('\n')[0] }
      : { name: 'gh version', ok: false, severity: 'error', detail: `${ver ? ver.join('.') : 'unknown version'}; ${MIN_GH.join('.')} or newer is required`, fix: 'upgrade gh: https://cli.github.com' });
  } catch {
    checks.push({ name: 'gh version', ok: false, severity: 'error', detail: 'gh is not installed', fix: 'install the GitHub CLI: https://cli.github.com' });
  }
  if (ghInstalled) {
    const auth = await deps.run('gh', ['auth', 'status']);
    checks.push(auth.code === 0
      ? { name: 'gh login', ok: true, severity: 'error', detail: (auth.stderr || auth.stdout).trim().split('\n').find((l) => /Logged in/i.test(l))?.trim() ?? 'logged in' }
      : { name: 'gh login', ok: false, severity: 'error', detail: 'gh is not logged in to github.com', fix: 'run `gh auth login`' });
  }

  fs.mkdirSync(deps.workRoot, { recursive: true });
  const free = deps.freeDiskBytes(deps.workRoot);
  checks.push(free >= MIN_DISK_GB * GB
    ? { name: 'disk space', ok: true, severity: 'error', detail: `${(free / GB).toFixed(1)} GB free in ${deps.workRoot}` }
    : { name: 'disk space', ok: false, severity: 'error', detail: `${(free / GB).toFixed(1)} GB free in ${deps.workRoot}; at least ${MIN_DISK_GB} GB is needed`, fix: 'free up disk space' });

  checks.push(deps.totalMemBytes >= MIN_MEM_GB * GB
    ? { name: 'memory', ok: true, severity: 'warning', detail: `${(deps.totalMemBytes / GB).toFixed(0)} GB` }
    : { name: 'memory', ok: false, severity: 'warning', detail: `${(deps.totalMemBytes / GB).toFixed(1)} GB; the largest circuit may be slow below ${MIN_MEM_GB} GB` });

  try {
    const required = await deps.requiredToolVersion();
    checks.push(required === deps.toolVersion
      ? { name: 'tool version', ok: true, severity: 'error', detail: `${deps.toolVersion}, as the ceremony requires` }
      : { name: 'tool version', ok: false, severity: 'error', detail: `this tool is ${deps.toolVersion}, but the ceremony requires ${required}`, fix: `check out the ${required} release tag and run npm ci` });
  } catch (err) {
    checks.push({ name: 'tool version', ok: false, severity: 'warning', detail: `could not read the ceremony manifest (${err instanceof Error ? err.message : String(err)}); it may not have started yet` });
  }

  if (deps.practice) checks.push(await practiceRun(deps.workRoot));

  return { ok: checks.every((c) => c.ok || c.severity === 'warning'), checks };
}

/** Real probes for the CLI. */
export function systemProbes(): Pick<DoctorDeps, 'nodeVersion' | 'totalMemBytes' | 'freeDiskBytes'> {
  return {
    nodeVersion: process.versions.node,
    totalMemBytes: os.totalmem(),
    freeDiskBytes: (dir) => {
      const s = fs.statfsSync(dir);
      return s.bavail * s.bsize;
    },
  };
}
