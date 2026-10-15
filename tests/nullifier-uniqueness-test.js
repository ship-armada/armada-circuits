/**
 * Negative test: in-circuit input-note distinctness (Transact.circom).
 *
 * Simulates the double-count attack from SECURITY_REVIEW.md Finding 2:
 * a malicious prover passes the SAME note as both inputs of a 2x2 proof,
 * signs the transaction themselves, and tries to create an output worth
 * twice the note's value. Before the fix, the circuit accepted this and
 * only the on-chain duplicate-nullifier check saved the pool. Now the
 * pairwise IsEqual constraints on leavesIndices must make any such proof
 * unverifiable.
 *
 * A self-contained scenario is built from scratch (fresh EdDSA key, own
 * depth-16 Poseidon tree) because captured fixtures do not contain the
 * spending private key needed to sign an adversarial transaction.
 *
 * Run: node tests/nullifier-uniqueness-test.js
 * Requires: build/2x2/{main_2x2_js/main_2x2.wasm, final.zkey, vkey.json}
 */

const path = require('path');
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const { buildEddsa, buildPoseidon } = require('circomlibjs');

const BUILD = path.join(__dirname, '..', 'build', '2x2');
const WASM = path.join(BUILD, 'main_2x2_js', 'main_2x2.wasm');
const ZKEY = path.join(BUILD, 'final.zkey');
const VKEY = require(path.join(BUILD, 'vkey.json'));

const DEPTH = 16;
const TOKEN = 12345n;
const BOUND_PARAMS_HASH = 777n;
const NPK_OUT = 999n;

// Minimal sparse Poseidon Merkle tree (empty leaf = 0)
class SparseTree {
  constructor(H) {
    this.H = H;
    this.zeros = [0n];
    for (let i = 0; i < DEPTH; i++) {
      this.zeros.push(H([this.zeros[i], this.zeros[i]]));
    }
    this.levels = [new Map()]; // level -> Map(index -> hash)
  }

  get(level, idx) {
    const l = this.levels[level];
    return (l && l.has(idx)) ? l.get(idx) : this.zeros[level];
  }

  insert(idx, hash) {
    this.levels[0].set(idx, hash);
  }

  computeRoot() {
    for (let l = 0; l < DEPTH; l++) {
      const next = new Map();
      const parents = new Set();
      for (const idx of this.levels[l].keys()) parents.add(idx >> 1);
      for (const p of parents) {
        next.set(p, this.H([this.get(l, 2 * p), this.get(l, 2 * p + 1)]));
      }
      this.levels[l + 1] = next;
    }
    return this.get(DEPTH, 0);
  }

  path(idx) {
    const elements = [];
    for (let l = 0; l < DEPTH; l++) {
      elements.push(this.get(l, (idx >> l) ^ 1));
    }
    return elements;
  }
}

async function main() {
  const eddsa = await buildEddsa();
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs) => F.toObject(poseidon(xs));

  // Fresh spending key + nullifying key
  const prvKey = crypto.randomBytes(32);
  const pubKey = eddsa.prv2pub(prvKey).map((c) => F.toObject(c));
  const nullifyingKey = BigInt('0x' + crypto.randomBytes(16).toString('hex'));

  // Key hierarchy: mpk -> npk -> commitment (mirrors Transact.circom)
  const mpk = H([pubKey[0], pubKey[1], nullifyingKey]);

  const makeNote = (leafIndex, value) => {
    const random = BigInt('0x' + crypto.randomBytes(16).toString('hex'));
    const npk = H([mpk, random]);
    const commitment = H([npk, TOKEN, value]);
    return { leafIndex, value, random, commitment };
  };

  const noteA = makeNote(5, 100n);
  const noteB = makeNote(9, 50n);

  const tree = new SparseTree(H);
  tree.insert(noteA.leafIndex, noteA.commitment);
  tree.insert(noteB.leafIndex, noteB.commitment);
  const merkleRoot = tree.computeRoot();

  const buildInput = (inputNotes, totalOut) => {
    const nullifiers = inputNotes.map((n) => H([nullifyingKey, BigInt(n.leafIndex)]));
    const commitmentsOut = [H([NPK_OUT, TOKEN, totalOut]), H([NPK_OUT + 1n, TOKEN, 0n])];
    const msgHash = H([merkleRoot, BOUND_PARAMS_HASH, ...nullifiers, ...commitmentsOut]);
    const sig = eddsa.signPoseidon(prvKey, F.e(msgHash));
    return {
      merkleRoot,
      boundParamsHash: BOUND_PARAMS_HASH,
      nullifiers,
      commitmentsOut,
      token: TOKEN,
      publicKey: pubKey,
      signature: [F.toObject(sig.R8[0]), F.toObject(sig.R8[1]), sig.S],
      randomIn: inputNotes.map((n) => n.random),
      valueIn: inputNotes.map((n) => n.value),
      pathElements: inputNotes.flatMap((n) => tree.path(n.leafIndex)),
      leavesIndices: inputNotes.map((n) => BigInt(n.leafIndex)),
      nullifyingKey,
      npkOut: [NPK_OUT, NPK_OUT + 1n],
      valueOut: [totalOut, 0n],
    };
  };

  const proveAndVerify = async (input) => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    return snarkjs.groth16.verify(VKEY, publicSignals, proof);
  };

  // Control: honest 2x2 spend of two distinct notes — must verify
  const honestOk = await proveAndVerify(buildInput([noteA, noteB], 150n));
  console.log(`honest 2x2 (distinct notes):    verify = ${honestOk}`);
  if (!honestOk) {
    console.error('FAIL: honest transaction did not verify — test harness is broken');
    process.exit(1);
  }

  // Attack: same note twice, output worth 2x its value — must NOT verify.
  // The attacker signs it themselves (they own the note), so only the
  // in-circuit distinctness check can stop this. Expected: witness
  // generation aborts on the `indexEq.out === 0` assert (Transact.circom),
  // or — if a proof were somehow produced — verification must fail.
  try {
    const attackOk = await proveAndVerify(buildInput([noteA, noteA], 200n));
    console.log(`attack 2x2 (note spent twice):  verify = ${attackOk}`);
    if (attackOk) {
      console.error('FAIL: double-count attack produced a VALID proof — pool could be drained!');
      process.exit(1);
    }
    console.log('PASS: attack proof does not verify');
    process.exit(0);
  } catch (err) {
    if (String(err).includes('Assert Failed')) {
      console.log('attack 2x2 (note spent twice):  witness generation rejected (Assert Failed)');
      console.log('PASS: input-note distinctness is enforced in-circuit');
      process.exit(0);
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
