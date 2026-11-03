// ABOUTME: Builds a tiny two-circuit ceremony for flow tests: multiplier r1cs, power-8 ptau, base zkeys, manifest.
// ABOUTME: Base zkeys are hosted on the fake GitHub's server as the official mirror.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildBn128 } from 'ffjavascript';
import { powersOfTau } from 'snarkjs';
import type { Manifest } from '../../src/manifest';
import { sha256File } from '../../src/http';
import { hashFile } from '../../src/ptau';
import { newBaseZkey } from '../../src/snark';
import type { FakeGitHub } from './fake-github';

export const TINY_CIRCUITS = ['m1', 'm2'];
const FIXTURE = path.join(__dirname, '..', '..', '..', 'tool', 'test', 'fixtures', 'multiplier.circom');

export interface TinyCeremony {
  r1cs: string;
  ptau: string;
  manifest: Manifest;
}

export async function buildTinyCeremony(dir: string, gh: FakeGitHub, now: number, toolVersion: string): Promise<TinyCeremony> {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(process.env.CIRCOM_BIN ?? 'circom', [FIXTURE, '--r1cs', '-o', dir], { stdio: 'pipe' });
  const r1cs = path.join(dir, 'multiplier.r1cs');
  const curve = await buildBn128();
  await powersOfTau.newAccumulator(curve, 8, path.join(dir, 'pot_0.ptau'));
  await powersOfTau.contribute(path.join(dir, 'pot_0.ptau'), path.join(dir, 'pot_1.ptau'), 'test', 'test entropy');
  const ptau = path.join(dir, 'pot_final.ptau');
  await powersOfTau.preparePhase2(path.join(dir, 'pot_1.ptau'), ptau);

  const r1csSha256 = await sha256File(r1cs);
  const circuits: Manifest['circuits'] = {};
  for (const id of TINY_CIRCUITS) {
    const base = path.join(dir, `${id}-0000.zkey`);
    await newBaseZkey(r1cs, ptau, base);
    const url = gh.host(`official/${id}-0000.zkey`, base);
    circuits[id] = {
      r1csSha256, wasmSha256: 'f'.repeat(64), status: 'open', openedAtTurn: 0,
      base: { zkeySha256: await sha256File(base), mirrors: [{ kind: 'official', url }] }, contributions: [],
    };
  }
  const manifest: Manifest = {
    version: 2,
    requiredToolVersion: toolVersion,
    snarkjsVersion: '0.7.6',
    coordination: { repo: gh.repo, queueIssue: 1, officialReleaseTag: 'ceremony-zkeys' },
    ptau: { ...(await hashFile(ptau)), power: 8, mirrors: ['https://example.org/pot.ptau'] },
    window: { opens: new Date(now - 30 * 86_400_000).toISOString(), closes: new Date(now + 30 * 86_400_000).toISOString() },
    beacon: { type: 'drand', chainHash: 'c'.repeat(64), round: 1, iterationsExp: 10 },
    policy: { minContributions: 0, minOutside: 0, minOutsideOrgs: 0, minByo: 0 },
    circuits,
  };
  gh.files.set('ceremony/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { r1cs, ptau, manifest };
}
