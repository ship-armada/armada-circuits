// ABOUTME: Turn-claim rules over queue-issue comments and contribution PRs: who holds the turn, and who backs off.
// ABOUTME: Pure functions (no GitHub access); turns are a liveness courtesy, chain correctness comes from verification.

/** Hidden marker that identifies a claim comment on the queue issue. */
export const CLAIM_MARKER = '<!-- armada-ceremony:claim -->';
/** A claim with no PR lapses after this long. */
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

export interface ClaimComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface ContributionPr {
  number: number;
  author: string;
  createdAt: string;
  state: 'open' | 'merged' | 'closed';
  /** Result of the read-only contribution check for the PR's current head. */
  ci: 'pending' | 'success' | 'failure';
}

export type TurnStatus =
  | { held: false }
  | { held: true; holder: string; by: 'pr'; pr: number; since: string }
  | { held: true; holder: string; by: 'claim'; claimId: number; since: string };

export function claimBody(handle: string): string {
  return `${CLAIM_MARKER}\n@${handle} is contributing now. This claim lapses after 2 hours without a contribution PR.`;
}

export function isClaim(c: ClaimComment): boolean {
  return c.body.includes(CLAIM_MARKER);
}

const time = (iso: string) => Date.parse(iso);
const byTimeThenId = (a: ClaimComment, b: ClaimComment) => time(a.createdAt) - time(b.createdAt) || a.id - b.id;

/** A claim is consumed once its author opens a contribution PR after it; the PR then decides. */
function liveClaims(comments: ClaimComment[], prs: ContributionPr[], now: number): ClaimComment[] {
  return comments
    .filter(isClaim)
    .filter((c) => now - time(c.createdAt) < CLAIM_TTL_MS)
    .filter((c) => !prs.some((p) => p.author === c.author && time(p.createdAt) >= time(c.createdAt)))
    .sort(byTimeThenId);
}

/** An open PR whose check is pending or passed holds the turn; a failed one does not. */
function holdingPr(prs: ContributionPr[]): ContributionPr | undefined {
  return prs
    .filter((p) => p.state === 'open' && (p.ci === 'pending' || p.ci === 'success'))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.number - b.number)[0];
}

export function turnStatus(comments: ClaimComment[], prs: ContributionPr[], now: number): TurnStatus {
  const p = holdingPr(prs);
  if (p) return { held: true, holder: p.author, by: 'pr', pr: p.number, since: p.createdAt };
  const [first] = liveClaims(comments, prs, now);
  if (first) return { held: true, holder: first.author, by: 'claim', claimId: first.id, since: first.createdAt };
  return { held: false };
}

/**
 * First claim wins: after posting claim `myClaimId`, back off if a PR holds the
 * turn or another contributor's live claim came first.
 */
export function shouldBackOff(comments: ClaimComment[], prs: ContributionPr[], now: number, myClaimId: number): boolean {
  const mine = comments.find((c) => c.id === myClaimId);
  if (!mine) throw new Error(`claim ${myClaimId} not found`);
  if (holdingPr(prs)) return true;
  return liveClaims(comments, prs, now).some((c) => c.author !== mine.author && byTimeThenId(c, mine) < 0);
}
