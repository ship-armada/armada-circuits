// ABOUTME: Negative test proving the EdDSA check in Transact.circom rejects malleated signatures.
// ABOUTME: Re-submits a valid 2x2 signature as (R8, S + l) and checks circomlib's S < l bound stops it.
/**
 * Negative test: EdDSA signature malleability (SECURITY_REVIEW.md Finding 6).
 *
 * A verifier that only bounds S < 2^253 would accept (R8, S + l) for any
 * valid (R8, S), where l is the BabyJubJub subgroup order (~2^251). That
 * would let anyone derive a second valid signature without the private
 * key. circomlib's EdDSAPoseidonVerifier enforces S < l with
 * CompConstant(l - 1); this test checks that a malleated signature is
 * rejected by exactly that constraint.
 *
 * A self-contained scenario is built from scratch (fresh EdDSA key, two
 * sibling leaves in a depth-16 Poseidon tree) because captured fixtures do
 * not contain the spending private key.
 *
 * Run: node tests/eddsa-malleability-test.js
 * Requires: build/2x2/{main_2x2_js/main_2x2.wasm, final.zkey, vkey.json}
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const { buildEddsa, buildPoseidon } = require('circomlibjs');

const BUILD = path.join(__dirname, '..', 'build', '2x2');
const WASM = path.join(BUILD, 'main_2x2_js', 'main_2x2.wasm');
const ZKEY = path.join(BUILD, 'final.zkey');
const VKEY_PATH = path.join(BUILD, 'vkey.json');
for (const [label, p] of [['WASM', WASM], ['ZKEY', ZKEY], ['VKEY', VKEY_PATH]]) {
  if (!fs.existsSync(p)) {
    console.error(`${label} not found: ${p}. Run 'npm run compile && npm run setup:dev' first.`);
    process.exit(1);
  }
}
const VKEY = require(VKEY_PATH);

// BabyJubJub prime subgroup order
const SUBGROUP_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// Source line of circomlib's S < l assert, so the test can check that the
// malleated signature is rejected by that constraint and not by some other failure.
const EDDSA_SRC = require.resolve('circomlib/circuits/eddsaposeidon.circom');
const S_BOUND_LINE = fs.readFileSync(EDDSA_SRC, 'utf8')
  .split('\n')
  .findIndex((l) => l.includes('compConstant.out*enabled === 0')) + 1;

const DEPTH = 16;
const TOKEN = 12345n;
const BOUND_PARAMS_HASH = 777n;
const NPK_OUT = 999n;

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
    const commitment = H([H([mpk, random]), TOKEN, value]);
    return { leafIndex, value, random, commitment };
  };

  // Leaves 0 and 1 are siblings; every node above them pairs with an empty subtree.
  const notes = [makeNote(0, 100n), makeNote(1, 50n)];
  const zeros = [0n];
  for (let i = 0; i < DEPTH; i++) zeros.push(H([zeros[i], zeros[i]]));
  let merkleRoot = H([notes[0].commitment, notes[1].commitment]);
  for (let l = 1; l < DEPTH; l++) merkleRoot = H([merkleRoot, zeros[l]]);
  const pathOf = (i) => [notes[1 - i].commitment, ...zeros.slice(1, DEPTH)];

  const nullifiers = notes.map((n) => H([nullifyingKey, BigInt(n.leafIndex)]));
  const commitmentsOut = [H([NPK_OUT, TOKEN, 150n]), H([NPK_OUT + 1n, TOKEN, 0n])];
  const msgHash = H([merkleRoot, BOUND_PARAMS_HASH, ...nullifiers, ...commitmentsOut]);
  const sig = eddsa.signPoseidon(prvKey, F.e(msgHash));

  const buildInput = (S) => ({
    merkleRoot,
    boundParamsHash: BOUND_PARAMS_HASH,
    nullifiers,
    commitmentsOut,
    token: TOKEN,
    publicKey: pubKey,
    signature: [F.toObject(sig.R8[0]), F.toObject(sig.R8[1]), S],
    randomIn: notes.map((n) => n.random),
    valueIn: notes.map((n) => n.value),
    pathElements: [...pathOf(0), ...pathOf(1)],
    leavesIndices: notes.map((n) => BigInt(n.leafIndex)),
    nullifyingKey,
    npkOut: [NPK_OUT, NPK_OUT + 1n],
    valueOut: [150n, 0n],
  });

  const proveAndVerify = async (input) => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    return snarkjs.groth16.verify(VKEY, publicSignals, proof);
  };

  // Control: the original signature — must verify
  const honestOk = await proveAndVerify(buildInput(sig.S));
  console.log(`original signature (R8, S):      verify = ${honestOk}`);
  if (!honestOk) {
    console.error('FAIL: honest transaction did not verify — test harness is broken');
    process.exit(1);
  }

  // The malleated scalar must still fit in 253 bits, otherwise Num2Bits(253)
  // would reject it first and the test would not exercise the S < l bound.
  const malleatedS = sig.S + SUBGROUP_ORDER;
  if (malleatedS >= (1n << 253n)) {
    console.error('FAIL: S + l does not fit in 253 bits — scenario does not exercise the S < l bound');
    process.exit(1);
  }

  // Attack: same signature with S + l — must NOT produce a proof. Expected:
  // witness generation aborts on circomlib's `compConstant.out*enabled === 0`
  // assert. Any other outcome fails the test: a proof being produced at all
  // means the bound is missing, and a different assert means the scenario is
  // broken rather than the attack blocked.
  // The witness calculator logs the failed assert to stderr before throwing.
  // That log is expected here, so capture it and check it instead of printing.
  const capturedErrors = [];
  const consoleError = console.error;
  console.error = (...args) => capturedErrors.push(args.join(' '));
  let attackOk;
  let attackErr;
  try {
    attackOk = await proveAndVerify(buildInput(malleatedS));
  } catch (err) {
    attackErr = err;
  } finally {
    console.error = consoleError;
  }

  if (attackErr === undefined) {
    console.log(`malleated signature (R8, S + l): verify = ${attackOk}`);
    if (attackOk) {
      console.error('FAIL: malleated signature produced a VALID proof — signatures are malleable!');
      process.exit(1);
    }
    console.error('FAIL: malleated proof was generated; expected the S < l assert to abort witness generation');
    process.exit(1);
  }

  if (S_BOUND_LINE === 0) {
    console.error(`FAIL: malleated signature rejected, but no S < l assert found in ${EDDSA_SRC}`);
    throw attackErr;
  }
  const expected = new RegExp(`Error in template EdDSAPoseidonVerifier_\\d+ line: ${S_BOUND_LINE}\\b`);
  const message = String(attackErr);
  if (!message.includes('Assert Failed') || !expected.test(message)) {
    console.error(`FAIL: malleated signature rejected, but not by the S < l assert (eddsaposeidon.circom:${S_BOUND_LINE})`);
    throw attackErr;
  }
  if (!capturedErrors.some((e) => expected.test(e))) {
    console.error('FAIL: expected the witness calculator to log the S < l assert');
    console.error(capturedErrors.join('\n'));
    process.exit(1);
  }
  console.log(`malleated signature (R8, S + l): rejected by eddsaposeidon.circom:${S_BOUND_LINE} (S < l assert)`);
  console.log('PASS: EdDSA signatures are not malleable');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
