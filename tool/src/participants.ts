// ABOUTME: ceremony/participants.json: coordinators' classification of each contributor and their public post.
// ABOUTME: Kept separate from the manifest so the manifest stays append-only and contribution PRs never touch it.

import { GITHUB_HANDLE } from './manifest';

export interface PublicPost {
  /** Post of the attestation hash from a long-lived account outside GitHub. */
  url: string;
  /** Coordinator who checked that the post exists and matches. */
  checkedBy: string;
  checkedAt: string;
}

export interface Participant {
  handle: string;
  displayName: string;
  /** Affiliation; an unaffiliated individual is "independent:<handle>". */
  org: string;
  armadaTeam: boolean;
  publicPost?: PublicPost;
}

export interface Participants {
  version: 1;
  participants: Participant[];
}

/** Thrown with every problem found, so one run shows them all. */
export class ParticipantsError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid participants file:\n  ${problems.join('\n  ')}`);
    this.name = 'ParticipantsError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function postIsValid(v: unknown): boolean {
  if (!isRecord(v)) return false;
  let httpsUrl = false;
  try {
    httpsUrl = typeof v.url === 'string' && new URL(v.url).protocol === 'https:';
  } catch {
    httpsUrl = false;
  }
  return httpsUrl
    && typeof v.checkedBy === 'string' && GITHUB_HANDLE.test(v.checkedBy)
    && typeof v.checkedAt === 'string' && !Number.isNaN(Date.parse(v.checkedAt));
}

/** Validate a parsed participants.json. Throws ParticipantsError listing every problem. */
export function parseParticipants(json: unknown): Participants {
  if (!isRecord(json)) throw new ParticipantsError(['participants file must be a JSON object']);
  const p: string[] = [];
  if (json.version !== 1) p.push('version must be 1');
  if (!Array.isArray(json.participants)) {
    p.push('participants must be an array');
    throw new ParticipantsError(p);
  }
  json.participants.forEach((x, i) => {
    const at = `participants[${i}]`;
    if (!isRecord(x)) {
      p.push(`${at} must be an object`);
      return;
    }
    const handleOk = typeof x.handle === 'string' && GITHUB_HANDLE.test(x.handle);
    if (!handleOk) p.push(`${at}.handle must be a GitHub handle`);
    if (!isNonEmptyString(x.displayName)) p.push(`${at}.displayName must be a non-empty string`);
    if (!isNonEmptyString(x.org)) {
      p.push(`${at}.org must be a non-empty string`);
    } else if (x.org.startsWith('independent:') && x.org !== `independent:${x.handle}`) {
      p.push(`${at}.org "independent:..." must name the participant's own handle`);
    }
    if (typeof x.armadaTeam !== 'boolean') p.push(`${at}.armadaTeam must be a boolean`);
    if (x.publicPost !== undefined && !postIsValid(x.publicPost)) {
      p.push(`${at}.publicPost must be { url: https://..., checkedBy: <handle>, checkedAt: <ISO time> }`);
    }
  });
  const seen = new Set<string>();
  for (const x of json.participants) {
    if (isRecord(x) && typeof x.handle === 'string') {
      if (seen.has(x.handle)) p.push(`duplicate participant handle ${x.handle}`);
      seen.add(x.handle);
    }
  }
  if (p.length > 0) throw new ParticipantsError(p);
  return json as unknown as Participants;
}
