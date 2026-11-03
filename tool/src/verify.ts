// ABOUTME: `status` (turn holder, progress, your turns) and `verify` (zkey histories vs the manifest, optional
// ABOUTME: full zkey verify, --mine, and the beacon binding to the committed drand round once finalized).

import path from 'node:path';
import { headZkeySha256 } from './attestation';
import { turnStatus, type TurnStatus } from './claim';
import { headUrls, loadManifest, type ContributorDeps } from './contributor';
import { QUICKNET, verifyBeacon } from './drand';
import { downloadVerified, sha256File } from './http';
import { lastTurn, type Manifest, type Mirror } from './manifest';
import { fetchPtau } from './ptau';
import { readMpcParams, verifyZkey } from './snark';

export interface StatusReport {
  lastTurn: number;
  openCircuits: string[];
  yourTurns: number[];
  turn: TurnStatus;
  lines: string[];
}

function turnsBy(m: Manifest, handle: string): number[] {
  const turns = new Set<number>();
  for (const c of Object.values(m.circuits)) for (const x of c.contributions) if (x.contributor === handle) turns.add(x.turn);
  return [...turns].sort((a, b) => a - b);
}

export async function status(deps: ContributorDeps): Promise<StatusReport> {
  const handle = await deps.gh.whoami();
  const m = await loadManifest(deps);
  const comments = await deps.gh.listIssueComments(deps.repo, m.coordination.queueIssue);
  const prs = await deps.gh.listContributionPrs(deps.repo);
  const turn = turnStatus(comments, prs, deps.now());
  const openCircuits = Object.entries(m.circuits).filter(([, c]) => c.status === 'open').map(([id]) => id).sort();
  const yourTurns = turnsBy(m, handle);
  const lines = [
    `ceremony: ${deps.repo}`,
    `window: ${m.window.opens} to ${m.window.closes}`,
    `required tool version: ${m.requiredToolVersion} (this tool: ${deps.toolVersion})`,
    `accepted turns: ${lastTurn(m)}; open circuits: ${openCircuits.length}`,
    turn.held ? `turn: held by @${turn.holder} (${turn.by === 'pr' ? `PR #${turn.pr}` : 'claim'} since ${turn.since})` : 'turn: free',
    yourTurns.length > 0 ? `your turns (@${handle}): ${yourTurns.join(', ')}` : `you (@${handle}) have not contributed yet`,
  ];
  return { lastTurn: lastTurn(m), openCircuits, yourTurns, turn, lines };
}

export interface VerifyOptions {
  /** Also run `zkey verify` against the r1cs and the pinned ptau. */
  full?: boolean;
  /** Check that the current user's contributions are in every circuit. */
  mine?: boolean;
  /** Circuits to check (default: all). */
  circuits?: string[];
  /** Local r1cs for a circuit (built by compile.sh); checked against the manifest's hash. */
  r1csFor: (id: string) => string;
  /** Where the pinned ptau is cached (downloaded if missing or wrong). */
  ptauPath: string;
}

const mirrorUrls = (mirrors: Mirror[]) => {
  const rank = { official: 0, fork: 1, ipfs: 2 } as const;
  return [...mirrors].sort((a, b) => rank[a.kind] - rank[b.kind]).map((x) => x.url);
};

/**
 * Check each circuit's current zkey (the final one once finalized) against
 * the manifest. Returns ok plus a line per check; failures start with "FAIL".
 */
export async function verify(deps: ContributorDeps, opts: VerifyOptions): Promise<{ ok: boolean; lines: string[] }> {
  const m = await loadManifest(deps);
  const lines: string[] = [];
  let ok = true;
  const pass = (l: string) => lines.push(l);
  const fail = (l: string) => {
    ok = false;
    lines.push(`FAIL ${l}`);
  };

  const ids = (opts.circuits && opts.circuits.length > 0 ? opts.circuits : Object.keys(m.circuits)).slice().sort();
  for (const id of ids) if (!m.circuits[id]) throw new Error(`unknown circuit ${id}`);

  const finalized = ids.some((id) => m.circuits[id].status === 'finalized');
  if (finalized) {
    const b = m.beacon;
    if (b.value === undefined || b.signature === undefined) {
      fail('beacon: finalized, but no beacon value and signature are recorded in the manifest');
    } else if (b.chainHash !== QUICKNET.hash) {
      fail(`beacon: chain ${b.chainHash} is not drand quicknet`);
    } else if (!verifyBeacon(QUICKNET, { round: b.round, randomness: b.value, signature: b.signature })) {
      fail(`beacon: round ${b.round} does not verify against drand quicknet`);
    } else {
      pass(`beacon: drand quicknet round ${b.round} verified`);
    }
  }

  const handle = opts.mine ? await deps.gh.whoami() : undefined;
  const myTurns = handle ? turnsBy(m, handle) : [];
  if (handle && myTurns.length === 0) fail(`@${handle} has no contributions in this ceremony`);

  let ptau: string | undefined;
  for (const id of ids) {
    const chain = m.circuits[id];
    const isFinal = chain.status === 'finalized';
    if (isFinal && !chain.final) {
      fail(`${id}: finalized but has no final zkey in the manifest`);
      continue;
    }
    const sha = isFinal ? chain.final!.zkeySha256 : headZkeySha256(m, id);
    const urls = isFinal ? mirrorUrls(chain.final!.mirrors) : headUrls(deps.gh, deps.repo, m, id);
    const file = path.join(deps.workRoot, 'verify', `${id}-${sha.slice(0, 12)}.zkey`);
    try {
      await downloadVerified(urls, sha, file, deps.download);
    } catch (err) {
      fail(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const params = await readMpcParams(file);
    const expected = chain.contributions;
    const wantLength = expected.length + (isFinal ? 1 : 0);
    if (params.contributions.length !== wantLength) {
      fail(`${id}: zkey has ${params.contributions.length} contributions, the manifest records ${wantLength}`);
      continue;
    }
    const mismatched = expected.findIndex((c, i) => params.contributions[i].contributionHash !== c.contributionHash);
    if (mismatched >= 0) {
      fail(`${id}: contribution ${mismatched + 1} hash does not match the manifest`);
      continue;
    }
    pass(`${id}: ${expected.length} contributions match the manifest`);

    if (isFinal) {
      const last = params.contributions[params.contributions.length - 1];
      if (last.type !== 1) fail(`${id}: the final contribution is not a beacon`);
      else if (last.beaconHash !== m.beacon.value) fail(`${id}: beacon hash ${last.beaconHash} is not the committed drand randomness`);
      else if (last.numIterationsExp !== m.beacon.iterationsExp) fail(`${id}: beacon iterations ${last.numIterationsExp} != committed ${m.beacon.iterationsExp}`);
      else pass(`${id}: beacon is drand round ${m.beacon.round}`);
    }

    if (handle) {
      for (const t of myTurns) {
        const c = expected.find((x) => x.turn === t);
        if (c && params.contributions[c.index - 1]?.contributionHash === c.contributionHash) pass(`${id}: @${handle}'s turn ${t} is in ${id}`);
        else if (t > chain.openedAtTurn) fail(`${id}: @${handle}'s turn ${t} is missing`);
      }
    }

    if (opts.full) {
      const r1cs = opts.r1csFor(id);
      const r1csSha = await sha256File(r1cs).catch(() => 'missing');
      if (r1csSha !== chain.r1csSha256) {
        fail(`${id}: r1cs sha256 ${r1csSha} (${r1cs}) does not match the manifest; compile at the ceremony's circuit tag`);
        continue;
      }
      if (!ptau) {
        ptau = (await fetchPtau({ mirrors: m.ptau.mirrors, sha256: m.ptau.sha256, blake2b: m.ptau.blake2b, dest: opts.ptauPath, fetch: deps.download?.fetch })).path;
      }
      const res = await verifyZkey(r1cs, ptau, file);
      if (res.ok) pass(`${id}: zkey verify OK`);
      else fail(`${id}: zkey verify failed: ${res.messages.join('; ')}`);
    }
  }
  return { ok, lines };
}
