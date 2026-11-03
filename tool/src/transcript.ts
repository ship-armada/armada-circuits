// ABOUTME: TRANSCRIPT.md for the release: contributors, policy counts with how each was established, beacon,
// ABOUTME: final key hashes and verification steps. Generated from the finalized manifest and participants.json.

import { QUICKNET, roundTime } from './drand';
import type { Manifest } from './manifest';
import type { Participants } from './participants';
import { computeCounts } from './policy';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function transcript(m: Manifest, people: Participants): string {
  const byHandle = new Map(people.participants.map((p) => [p.handle, p]));
  const turns = new Map<number, Manifest['circuits'][string]['contributions'][number]>();
  for (const chain of Object.values(m.circuits)) for (const c of chain.contributions) if (!turns.has(c.turn)) turns.set(c.turn, c);
  const counts = computeCounts(m, people);
  const ids = Object.keys(m.circuits).sort();
  const b = m.beacon;

  const lines: string[] = [
    '# Armada trusted-setup ceremony transcript',
    '',
    `- Ceremony repo: ${m.coordination.repo}`,
    `- Contribution window: ${m.window.opens} to ${m.window.closes}`,
    `- Tool version: ${m.requiredToolVersion}; snarkjs ${m.snarkjsVersion}`,
    `- Circuits: ${ids.length} (${ids.join(', ')})`,
    '',
    '## Phase 1',
    '',
    `Powers of Tau, power ${m.ptau.power}: sha256 \`${m.ptau.sha256}\`, blake2b \`${m.ptau.blake2b}\`.`,
    '',
    '## Contributions',
    '',
    '| Turn | Contributor | Name | Organisation | Armada team | Mode | Public post | Time |',
    '|---|---|---|---|---|---|---|---|',
    ...[...turns.values()].sort((x, y) => x.turn - y.turn).map((c) => {
      const p = byHandle.get(c.contributor);
      return `| ${c.turn} | @${c.contributor} | ${cell(p?.displayName ?? '(unclassified)')} | ${cell(p?.org ?? '')} | ${p ? (p.armadaTeam ? 'yes' : 'no') : ''} | ${c.mode} | ${p?.publicPost ? cell(p.publicPost.url) : ''} | ${c.timestamp} |`;
    }),
    '',
    '## Participant policy',
    '',
    '| Count | Value | Required | Basis |',
    '|---|---|---|---|',
    `| Contributions | ${counts.contributions} | ${m.policy.minContributions} | Verified: every contribution is in the final zkeys' history |`,
    `| Outside participants | ${counts.outside.length} | ${m.policy.minOutside} | Coordinator-classified team status + coordinator-checked, publicly checkable post URL |`,
    `| Outside organisations | ${counts.outsideOrgs.length} | ${m.policy.minOutsideOrgs} | Coordinator-classified; publicly checkable via the posts |`,
    `| BYO-tool contributions | ${counts.byo} | ${m.policy.minByo} | Self-declared mode in the attestation; not cryptographically checkable |`,
    '',
  ];
  if (counts.unclassified.length > 0) lines.push(`Unclassified contributors (not counted as outside): ${counts.unclassified.map((h) => `@${h}`).join(', ')}`, '');

  lines.push(
    '## Beacon',
    '',
    `drand quicknet (chain \`${b.chainHash}\`) round ${b.round}, published ${b.chainHash === QUICKNET.hash ? new Date(roundTime(QUICKNET, b.round)).toISOString() : 'n/a'}.`,
    '',
    `- Randomness (applied as the snarkjs beacon hash): \`${b.value ?? '(not yet recorded)'}\``,
    `- Signature: \`${b.signature ?? '(not yet recorded)'}\``,
    `- Iterations: 2^${b.iterationsExp}`,
    '',
    '## Final keys',
    '',
    '| Circuit | Contributions | Final zkey sha256 | Verifying key sha256 |',
    '|---|---|---|---|',
    ...ids.map((id) => `| ${id} | ${m.circuits[id].contributions.length} | \`${m.circuits[id].final?.zkeySha256 ?? ''}\` | \`${m.circuits[id].final?.vkeySha256 ?? ''}\` |`),
    '',
    '## How to verify',
    '',
    '1. `sha256sum -c SHA256SUMS` in a directory with the release assets.',
    '2. Check SHA256SUMS.sig: `ssh-keygen -Y verify -f <allowed_signers> -I <coordinator> -n armada-ceremony -s SHA256SUMS.sig < SHA256SUMS`.',
    '3. From the ceremony\'s circuit tag: `npm ci && npm run compile`, then `npm run ceremony -- verify --full`.',
    '   This checks every final zkey\'s contribution history against the manifest, runs `snarkjs zkey verify` against the',
    '   r1cs and the pinned phase-1 file, and checks the beacon is the committed drand round.',
    '4. Contributors: `npm run ceremony -- verify --mine` confirms your contribution is in every circuit.',
    '',
  );
  return lines.join('\n');
}
