// ABOUTME: Contributor flows: `contribute` (claim, download heads, contribute, publish, open PR) and `submit` (BYO tool).
// ABOUTME: GitHub access goes through the GitHub interface so whole multi-turn runs can be tested with a fake.

import fs from 'node:fs';
import path from 'node:path';
import {
  attestationPath,
  attestationProblems,
  buildAttestation,
  headZkeySha256,
  serializeAttestation,
  type AttestationCircuit,
} from './attestation';
import { CLAIM_TTL_MS, claimBody, shouldBackOff, turnStatus, type ContributionPr, type TurnStatus } from './claim';
import { runContributeWorker } from './contribute-worker';
import { CONTRIBUTION_BRANCH_PREFIX, type GitHub } from './github';
import { downloadVerified, sha256File, type DownloadOptions } from './http';
import {
  appendTurn,
  checkContributionAppend,
  lastTurn,
  parseManifest,
  type ContributionMode,
  type Manifest,
  type Mirror,
} from './manifest';
import { newContributionProblems, readMpcParams, sameSecret, type ZkeyContribution } from './snark';

export const MANIFEST_PATH = 'ceremony/manifest.json';
export const PARTICIPANTS_PATH = 'ceremony/participants.json';
export const DEFAULT_REPO = 'ship-armada/armada-circuits';

export interface ContributorDeps {
  gh: GitHub;
  /** Upstream repo, "<owner>/<name>". */
  repo: string;
  /** Directory for downloaded and produced zkeys (one subdirectory per turn). */
  workRoot: string;
  toolVersion: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** User-facing progress output. */
  log(line: string): void;
  download?: DownloadOptions;
  /** How often --wait re-checks the turn. */
  pollMs?: number;
}

export type ContributeOutcome =
  | { kind: 'held'; message: string }
  | { kind: 'downloaded'; descriptorPath: string; inputDir: string }
  | {
    kind: 'submitted';
    turn: number;
    pr: { number: number; url: string };
    attestationSha256: string;
    contributionHashes: Record<string, string>;
    suggestedPost: string;
  };

/** Written by `contribute --download-only`; read by `submit`. */
export interface TurnDescriptor {
  version: 1;
  repo: string;
  turn: number;
  contributor: string;
  claimId: number;
  circuits: Record<string, { previousZkeySha256: string; input: string }>;
}

const pad = (n: number) => String(n).padStart(4, '0');
const iso = (ms: number) => new Date(ms).toISOString();

export async function loadManifest(deps: ContributorDeps): Promise<Manifest> {
  return parseManifest(JSON.parse(await deps.gh.readDefaultBranchFile(deps.repo, MANIFEST_PATH)));
}

function openCircuits(m: Manifest): string[] {
  return Object.entries(m.circuits).filter(([, c]) => c.status === 'open').map(([id]) => id).sort();
}

/** Why this tool can't contribute to `m` right now, or undefined. */
function preconditionProblem(m: Manifest, deps: ContributorDeps): string | undefined {
  if (m.requiredToolVersion !== deps.toolVersion) {
    return `this tool is version ${deps.toolVersion}, but the ceremony requires ${m.requiredToolVersion}; install that release and rerun`;
  }
  const now = deps.now();
  if (now < Date.parse(m.window.opens)) return `the contribution window opens at ${m.window.opens}`;
  if (now >= Date.parse(m.window.closes)) return `the contribution window closed at ${m.window.closes}`;
  if (openCircuits(m).length === 0) return 'no circuits are open for contributions';
  return undefined;
}

function describeHolder(st: Extract<TurnStatus, { held: true }>, prs: ContributionPr[]): string {
  if (st.by === 'pr') {
    const pr = prs.find((p) => p.number === st.pr);
    const state = pr?.ci === 'success' ? 'CI passed, waiting for a coordinator' : 'CI running';
    return `@${st.holder} is contributing (PR #${st.pr}, ${state}).`;
  }
  return `@${st.holder} claimed the turn at ${st.since} (the claim lapses at ${iso(Date.parse(st.since) + CLAIM_TTL_MS)} without a PR).`;
}

/** Claim the turn (or resume this user's own live claim). Returns the claim id, or why the turn is held. */
async function acquireTurn(deps: ContributorDeps, handle: string, issue: number, wait: boolean): Promise<{ claimId: number } | { held: string }> {
  for (;;) {
    const comments = await deps.gh.listIssueComments(deps.repo, issue);
    const prs = await deps.gh.listContributionPrs(deps.repo);
    const st = turnStatus(comments, prs, deps.now());
    if (st.held && st.holder === handle) {
      if (st.by === 'claim') return { claimId: st.claimId };
      return { held: `you already have contribution PR #${st.pr} open; wait for it to be accepted or rejected.` };
    }
    if (!st.held) {
      const claimId = await deps.gh.postIssueComment(deps.repo, issue, claimBody(handle));
      const after = await deps.gh.listIssueComments(deps.repo, issue);
      const afterPrs = await deps.gh.listContributionPrs(deps.repo);
      if (!shouldBackOff(after, afterPrs, deps.now(), claimId)) return { claimId };
      await deps.gh.deleteIssueComment(deps.repo, claimId);
      const now = turnStatus(after, afterPrs, deps.now());
      const msg = now.held ? describeHolder(now, afterPrs) : 'another contributor claimed the turn first.';
      if (!wait) return { held: `${msg} Try again later, or rerun with --wait to start automatically.` };
      deps.log(`${msg} Waiting for the turn...`);
    } else {
      const msg = describeHolder(st, prs);
      if (!wait) return { held: `${msg} Try again later, or rerun with --wait to start automatically.` };
      deps.log(`${msg} Waiting for the turn...`);
    }
    await deps.sleep(deps.pollMs ?? 60_000);
  }
}

/** URLs for a circuit's current head, official release first. */
function headUrls(m: Manifest, id: string): string[] {
  const chain = m.circuits[id];
  const last = chain.contributions[chain.contributions.length - 1];
  const mirrors: Mirror[] = last ? last.mirrors : chain.base.mirrors;
  const rank = { official: 0, fork: 1, ipfs: 2 } as const;
  return [...mirrors].sort((a, b) => rank[a.kind] - rank[b.kind]).map((x) => x.url);
}

function turnDir(deps: ContributorDeps, turn: number): string {
  return path.join(deps.workRoot, `turn-${pad(turn)}`);
}

async function downloadHeads(deps: ContributorDeps, m: Manifest, inputDir: string): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {};
  for (const id of openCircuits(m)) {
    const dest = path.join(inputDir, `${id}.zkey`);
    deps.log(`downloading ${id} head...`);
    await downloadVerified(headUrls(m, id), headZkeySha256(m, id), dest, deps.download);
    inputs[id] = dest;
  }
  return inputs;
}

interface FinishContext {
  handle: string;
  prev: Manifest;
  turn: number;
  mode: ContributionMode;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

/** Check, publish and open the PR for a finished contribution (shared by contribute and submit). */
async function finishTurn(deps: ContributorDeps, ctx: FinishContext): Promise<Extract<ContributeOutcome, { kind: 'submitted' }>> {
  const ids = Object.keys(ctx.inputs).sort();

  // The same no-op and reused-secret checks CI runs, so a bad contribution fails here, not after upload.
  const newest: Record<string, ZkeyContribution> = {};
  for (const id of ids) {
    const before = await readMpcParams(ctx.inputs[id]);
    const after = await readMpcParams(ctx.outputs[id]);
    const problems = newContributionProblems(before, after);
    if (problems.length > 0) throw new Error(`${id}: ${problems.join('; ')}`);
    newest[id] = after.contributions[after.contributions.length - 1];
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (await sameSecret(newest[ids[i]], newest[ids[j]])) throw new Error(`circuits ${ids[i]} and ${ids[j]} were contributed with the same secret`);
    }
  }

  // Stop early if another contribution was accepted while this one ran.
  const current = await loadManifest(deps);
  if (lastTurn(current) !== lastTurn(ctx.prev)) {
    throw new Error(`turn ${lastTurn(current)} was accepted while you were contributing, so this contribution is stale; rerun to contribute on the new head`);
  }

  const uploadDir = path.join(turnDir(deps, ctx.turn), 'upload');
  fs.mkdirSync(uploadDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const id of ids) {
    const index = ctx.prev.circuits[id].contributions.length + 1;
    const file = path.join(uploadDir, `${id}-${pad(index)}-${ctx.handle}.zkey`);
    fs.copyFileSync(ctx.outputs[id], file);
    files[id] = file;
  }
  deps.log(`uploading ${ids.length} zkeys to a release on your fork...`);
  const urls = await deps.gh.uploadToForkRelease(deps.repo, `ceremony-turn-${pad(ctx.turn)}`, ids.map((id) => files[id]),
    `Armada trusted-setup ceremony, turn ${ctx.turn}, by @${ctx.handle}.`);

  const timestamp = iso(deps.now());
  const circuits: Record<string, AttestationCircuit> = {};
  const perCircuit: Record<string, { zkeySha256: string; contributionHash: string; mirrors: Mirror[] }> = {};
  for (const id of ids) {
    const zkeySha256 = await sha256File(files[id]);
    const url = urls[path.basename(files[id])];
    if (!url) throw new Error(`upload returned no URL for ${path.basename(files[id])}`);
    circuits[id] = { previousZkeySha256: headZkeySha256(ctx.prev, id), zkeySha256, contributionHash: newest[id].contributionHash };
    perCircuit[id] = { zkeySha256, contributionHash: newest[id].contributionHash, mirrors: [{ kind: 'fork', url }] };
  }
  const att = buildAttestation({
    ceremony: deps.repo, turn: ctx.turn, contributor: ctx.handle, mode: ctx.mode, toolVersion: deps.toolVersion, timestamp, circuits,
  });
  const { text, sha256: attestationSha256 } = serializeAttestation(att);
  const next = appendTurn(ctx.prev, {
    contributor: ctx.handle, toolVersion: deps.toolVersion, mode: ctx.mode, attestation: attestationPath(ctx.turn, ctx.handle), timestamp, perCircuit,
  });
  const selfCheck = [...checkContributionAppend(ctx.prev, next, ctx.handle), ...attestationProblems(att, ctx.prev, next)];
  if (selfCheck.length > 0) throw new Error(`internal check failed before opening the PR: ${selfCheck.join('; ')}`);

  const suggestedPost = `I contributed to the Armada trusted-setup ceremony (turn ${ctx.turn}, github.com/${ctx.handle}). `
    + `Attestation sha256: ${attestationSha256}`;
  const pr = await deps.gh.openPullRequest(
    deps.repo,
    `${CONTRIBUTION_BRANCH_PREFIX}${pad(ctx.turn)}-${ctx.handle}`,
    [
      { path: MANIFEST_PATH, content: `${JSON.stringify(next, null, 2)}\n` },
      { path: attestationPath(ctx.turn, ctx.handle), content: text },
    ],
    `ceremony: turn ${ctx.turn} by @${ctx.handle}`,
    [
      `Contribution for turn ${ctx.turn} (${ids.length} circuits, mode \`${ctx.mode}\`).`,
      '',
      `Attestation sha256: \`${attestationSha256}\``,
      '',
      'To count toward the outside-participant quota, post this from a long-lived account outside GitHub and paste the link here:',
      '',
      `> ${suggestedPost}`,
    ].join('\n'),
  );
  return {
    kind: 'submitted',
    turn: ctx.turn,
    pr,
    attestationSha256,
    contributionHashes: Object.fromEntries(ids.map((id) => [id, newest[id].contributionHash])),
    suggestedPost,
  };
}

/**
 * `contribute`: claim the turn, download every open circuit's head, contribute
 * in a child process, then publish and open the PR. With `downloadOnly`, stop
 * after downloading and write a descriptor for `submit` (BYO tool).
 */
export async function contribute(deps: ContributorDeps, opts: { wait?: boolean; downloadOnly?: boolean; entropy?: string } = {}): Promise<ContributeOutcome> {
  const handle = await deps.gh.whoami();
  let m = await loadManifest(deps);
  const blocked = preconditionProblem(m, deps);
  if (blocked) throw new Error(blocked);

  const claim = await acquireTurn(deps, handle, m.coordination.queueIssue, opts.wait === true);
  if ('held' in claim) return { kind: 'held', message: claim.held };

  let keepClaim = false;
  try {
    m = await loadManifest(deps);
    const turn = lastTurn(m) + 1;
    const dir = turnDir(deps, turn);
    const inputDir = path.join(dir, 'in');
    const inputs = await downloadHeads(deps, m, inputDir);

    if (opts.downloadOnly) {
      const descriptor: TurnDescriptor = {
        version: 1, repo: deps.repo, turn, contributor: handle, claimId: claim.claimId,
        circuits: Object.fromEntries(Object.entries(inputs).map(([id, input]) => [id, { previousZkeySha256: headZkeySha256(m, id), input }])),
      };
      const descriptorPath = path.join(dir, 'turn.json');
      fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
      keepClaim = true;
      return { kind: 'downloaded', descriptorPath, inputDir };
    }

    const outputDir = path.join(dir, 'out');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputs = Object.fromEntries(Object.keys(inputs).map((id) => [id, path.join(outputDir, `${id}.zkey`)]));
    deps.log(`contributing to ${Object.keys(inputs).length} circuits in a separate process...`);
    await runContributeWorker({
      name: `armada-ceremony turn ${turn} (@${handle})`,
      entropy: opts.entropy,
      circuits: Object.keys(inputs).map((id) => ({ id, input: inputs[id], output: outputs[id] })),
    });
    const outcome = await finishTurn(deps, { handle, prev: m, turn, mode: 'tool', inputs, outputs });
    keepClaim = true;
    return outcome;
  } finally {
    // A failed run must not block the turn for the claim's full lifetime.
    if (!keepClaim) await deps.gh.deleteIssueComment(deps.repo, claim.claimId).catch(() => undefined);
  }
}

/** `submit`: publish zkeys produced by another tool (`<zkeyDir>/<circuit>.zkey`) for a `--download-only` turn. */
export async function submit(deps: ContributorDeps, opts: { descriptor: string; zkeyDir: string }): Promise<ContributeOutcome> {
  const d = JSON.parse(fs.readFileSync(opts.descriptor, 'utf8')) as TurnDescriptor;
  const handle = await deps.gh.whoami();
  if (d.version !== 1 || d.repo !== deps.repo) throw new Error(`${opts.descriptor} is not a turn descriptor for ${deps.repo}`);
  if (d.contributor !== handle) throw new Error(`${opts.descriptor} was made by @${d.contributor}, but you are @${handle}`);

  const m = await loadManifest(deps);
  const blocked = preconditionProblem(m, deps);
  if (blocked) throw new Error(blocked);
  if (lastTurn(m) + 1 !== d.turn) {
    throw new Error(`turn ${lastTurn(m)} was accepted after you downloaded turn ${d.turn}'s inputs; run contribute --download-only again`);
  }
  const comments = await deps.gh.listIssueComments(deps.repo, m.coordination.queueIssue);
  const prs = await deps.gh.listContributionPrs(deps.repo);
  const st = turnStatus(comments, prs, deps.now());
  if (st.held && st.holder !== handle) throw new Error(`the turn is now held by someone else: ${describeHolder(st, prs)}`);

  const ids = openCircuits(m);
  const missing = ids.filter((id) => !fs.existsSync(path.join(opts.zkeyDir, `${id}.zkey`)));
  if (missing.length > 0) throw new Error(`missing zkeys in ${opts.zkeyDir}: ${missing.map((id) => `${id}.zkey`).join(', ')}`);
  for (const id of ids) {
    if (d.circuits[id]?.previousZkeySha256 !== headZkeySha256(m, id)) throw new Error(`${id}: the head changed since --download-only; download again`);
  }
  return finishTurn(deps, {
    handle, prev: m, turn: d.turn, mode: 'byo-tool',
    inputs: Object.fromEntries(ids.map((id) => [id, d.circuits[id].input])),
    outputs: Object.fromEntries(ids.map((id) => [id, path.join(opts.zkeyDir, `${id}.zkey`)])),
  });
}
