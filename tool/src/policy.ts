// ABOUTME: Participant-policy counts (contributions, outside people, organisations, BYO) from manifest + participants.
// ABOUTME: finalize refuses to run while policyShortfalls reports anything.

import type { Manifest } from './manifest';
import type { Participants } from './participants';

export interface PolicyCounts {
  /** Accepted turns (each turn covers every open circuit). */
  contributions: number;
  /** Distinct outside contributors with a checked public post. */
  outside: string[];
  /** Distinct affiliations among `outside`. */
  outsideOrgs: string[];
  /** Turns made with a BYO tool. */
  byo: number;
  /** Contributors with no entry in participants.json (not counted as outside). */
  unclassified: string[];
}

interface TurnSummary {
  contributor: string;
  mode: string;
}

function turnsOf(m: Manifest): Map<number, TurnSummary> {
  const turns = new Map<number, TurnSummary>();
  for (const chain of Object.values(m.circuits)) {
    for (const c of chain.contributions) {
      if (!turns.has(c.turn)) turns.set(c.turn, { contributor: c.contributor, mode: c.mode });
    }
  }
  return turns;
}

export function computeCounts(m: Manifest, people: Participants): PolicyCounts {
  const turns = turnsOf(m);
  const byHandle = new Map(people.participants.map((p) => [p.handle, p]));
  const contributors = [...new Set([...turns.values()].map((t) => t.contributor))].sort();

  const outside = contributors.filter((h) => {
    const p = byHandle.get(h);
    return p !== undefined && !p.armadaTeam && p.publicPost !== undefined;
  });
  const outsideOrgs = [...new Set(outside.map((h) => byHandle.get(h)!.org))].sort();
  return {
    contributions: turns.size,
    outside,
    outsideOrgs,
    byo: [...turns.values()].filter((t) => t.mode === 'byo-tool').length,
    unclassified: contributors.filter((h) => !byHandle.has(h)),
  };
}

/** Every unmet policy minimum, as human-readable lines (empty = policy met). */
export function policyShortfalls(m: Manifest, people: Participants): string[] {
  const c = computeCounts(m, people);
  const checks: [string, number, number][] = [
    ['contributions', c.contributions, m.policy.minContributions],
    ['outside participants', c.outside.length, m.policy.minOutside],
    ['outside organisations', c.outsideOrgs.length, m.policy.minOutsideOrgs],
    ['BYO-tool contributions', c.byo, m.policy.minByo],
  ];
  return checks.filter(([, have, need]) => have < need).map(([label, have, need]) => `${label}: ${have} of ${need} required`);
}
