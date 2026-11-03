// ABOUTME: drand quicknet beacon support: pinned chain info, round/time maths, BLS signature verification.
// ABOUTME: fetchVerifiedRound needs at least two endpoints to serve a round that verifies against the pinned key.

import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha256';

export interface DrandChainInfo {
  /** Chain hash (hex), also the URL path segment on drand HTTP endpoints. */
  hash: string;
  /** Group public key (hex, compressed G2). */
  publicKey: string;
  /** Seconds between rounds. */
  period: number;
  /** Unix time (seconds) of round 1. */
  genesisTime: number;
  schemeID: string;
}

export interface DrandBeacon {
  round: number;
  /** sha256(signature), hex. This is the value applied as the ceremony beacon. */
  randomness: string;
  signature: string;
}

/** League of Entropy quicknet (D19). Pinned from https://api.drand.sh and drand.cloudflare.com. */
export const QUICKNET: DrandChainInfo = {
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesisTime: 1692803367,
  schemeID: 'bls-unchained-g1-rfc9380',
};

/** Public drand HTTP endpoints serving the League of Entropy chains. */
export const DRAND_ENDPOINTS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'];

/** Hash-to-curve domain separation tag for the bls-unchained-g1-rfc9380 scheme. */
const QUICKNET_DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';

/** Time (ms since epoch) at which `round` is produced. */
export function roundTime(chain: DrandChainInfo, round: number): number {
  if (!Number.isInteger(round) || round < 1) throw new Error('round must be a positive integer');
  return (chain.genesisTime + (round - 1) * chain.period) * 1000;
}

/** The latest round produced at time `ms` (ms since epoch). */
export function roundAt(chain: DrandChainInfo, ms: number): number {
  if (ms < chain.genesisTime * 1000) throw new Error("time is before the chain's genesis");
  return Math.floor((ms / 1000 - chain.genesisTime) / chain.period) + 1;
}

const isHex = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]+$/.test(s) && s.length % 2 === 0;

/**
 * Check an unchained G1 beacon: the signature is the group's BLS signature on
 * sha256(round as 8-byte big-endian), and randomness = sha256(signature).
 * Malformed input counts as invalid.
 */
export function verifyBeacon(chain: DrandChainInfo, b: DrandBeacon): boolean {
  if (chain.schemeID !== 'bls-unchained-g1-rfc9380') throw new Error(`unsupported drand scheme ${chain.schemeID}`);
  if (!Number.isInteger(b.round) || b.round < 1 || !isHex(b.signature) || !isHex(b.randomness)) return false;
  try {
    const msg = new Uint8Array(8);
    new DataView(msg.buffer).setBigUint64(0, BigInt(b.round));
    // hashToCurve's declared return type is narrower than the G1 point verifyShortSignature takes; it is the same point.
    const point = bls.G1.hashToCurve(sha256(msg), { DST: QUICKNET_DST }) as unknown as Parameters<typeof bls.verifyShortSignature>[1];
    if (!bls.verifyShortSignature(b.signature, point, chain.publicKey)) return false;
  } catch {
    return false;
  }
  return Buffer.from(sha256(Buffer.from(b.signature, 'hex'))).toString('hex') === b.randomness;
}

/**
 * Fetch `round` from the endpoints in order until `minVerified` of them have
 * served a copy that verifies against the pinned chain. A future round fails
 * with "not published yet". Otherwise fails with every endpoint's reason.
 */
export async function fetchVerifiedRound(
  chain: DrandChainInfo,
  round: number,
  endpoints: string[] = DRAND_ENDPOINTS,
  opts: { minVerified?: number; timeoutMs?: number; allowHttp?: boolean } = {},
): Promise<DrandBeacon> {
  const minVerified = opts.minVerified ?? 2;
  for (const e of endpoints) {
    if (!opts.allowHttp && new URL(e).protocol !== 'https:') throw new Error(`drand endpoint must be https: ${e}`);
  }
  let verified: DrandBeacon | undefined;
  let count = 0;
  let notYet = 0;
  const failures: string[] = [];
  for (const e of endpoints) {
    try {
      const res = await fetch(`${e}/${chain.hash}/public/${round}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      if (res.status === 404 || res.status === 425) {
        notYet += 1;
        throw new Error(`HTTP ${res.status} (round not available)`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Partial<DrandBeacon>;
      const b: DrandBeacon = { round: Number(body.round), randomness: String(body.randomness), signature: String(body.signature) };
      if (b.round !== round) throw new Error(`served round ${b.round}, asked for ${round}`);
      if (!verifyBeacon(chain, b)) throw new Error('signature does not verify against the pinned public key');
      verified = b;
      count += 1;
      if (count >= minVerified) return verified;
    } catch (err) {
      failures.push(`${e}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (count === 0 && notYet > 0 && Date.now() < roundTime(chain, round)) {
    throw new Error(`round ${round} is not published yet (due ${new Date(roundTime(chain, round)).toISOString()})`);
  }
  if (count === 0 && notYet === endpoints.length) throw new Error(`round ${round} is not published yet`);
  throw new Error(`only ${count} of ${minVerified} required endpoints served a verified round ${round}:\n  ${failures.join('\n  ')}`);
}
