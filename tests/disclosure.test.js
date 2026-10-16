/**
 * Tests for the nullifier disclosure circuit (src/operations/NullifierDisclosure.circom).
 *
 *   1. Reference parity: the JS reference (circomlibjs) reproduces armada-sdk's recorded
 *      stock-engine vectors (key derivation, nullifiers, spend-authorization EdDSA).
 *   2. Real spends: NullifierOwnership reproduces the nullifier and the note public key of
 *      every input note in the captured transact fixtures.
 *   3. Acceptance: the full circuit accepts disclosures signed with armada-sdk keyset keys, and
 *      the witness satisfies the R1CS.
 *   4. Rejection: a witness that breaks one property at a time fails.
 *   5. Groth16: a proof verifies, and a change to any one public signal fails verification.
 *
 * Prerequisites: `CIRCOM_BIN=circom2 npm run compile` and `npm run setup:dev`.
 * Run: node --test tests/disclosure.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const { buildPoseidon, buildEddsa } = require('circomlibjs');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const FIXTURES = path.join(__dirname, 'fixtures', 'generated');
const SDK_VECTORS = process.env.ARMADA_SDK_VECTORS
  || path.join(ROOT, '..', 'armada-sdk', 'test', 'vectors');

const DISCLOSURE_WASM = path.join(BUILD, 'disclosure', 'main_disclosure_js', 'main_disclosure.wasm');
const DISCLOSURE_R1CS = path.join(BUILD, 'disclosure', 'main_disclosure.r1cs');
const DISCLOSURE_ZKEY = path.join(BUILD, 'disclosure', 'final.zkey');
const DISCLOSURE_VKEY = path.join(BUILD, 'disclosure', 'vkey.json');
const OWNERSHIP_WASM = path.join(BUILD, 'ownership_test', 'ownership_test_js', 'ownership_test.wasm');

const F = (hex) => BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
const loadJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let poseidon;
let eddsa;
let babyJub;
let witnessBuilder;
let ownershipBuilder;
let keysets;

const hash = (inputs) => poseidon.F.toObject(poseidon(inputs));

function loadWitnessBuilder(wasmPath) {
  const builder = require(path.join(path.dirname(wasmPath), 'witness_calculator.js'));
  return builder(fs.readFileSync(wasmPath));
}

/** Keys of one armada-sdk keyset vector, as circuit field elements. */
function keysOf(vector) {
  const k = vector.keyset;
  return {
    privateKey: Buffer.from(k.spendingPrivateKey.slice(2), 'hex'),
    publicKey: k.spendingPublicKey.map(F),
    nullifyingKey: F(k.nullifyingKey),
    masterPublicKey: F(k.masterPublicKey),
  };
}

function sign(privateKey, message) {
  const sig = eddsa.signPoseidon(privateKey, eddsa.F.e(message));
  return [eddsa.F.toObject(sig.R8[0]), eddsa.F.toObject(sig.R8[1]), sig.S];
}

/** A valid disclosure input for `keys`, at (treeNumber, leafIndex), over `statementHash`. */
function disclosureInput(keys, { leafIndex, treeNumber = 0n, statementHash = 0x1234n }) {
  const nullifier = hash([keys.nullifyingKey, BigInt(leafIndex)]);
  const message = hash([statementHash, keys.masterPublicKey, nullifier, BigInt(treeNumber), BigInt(leafIndex)]);
  return {
    statementHash,
    masterPublicKey: keys.masterPublicKey,
    nullifier,
    treeNumber: BigInt(treeNumber),
    leafIndex: BigInt(leafIndex),
    spendingPublicKey: keys.publicKey,
    nullifyingKey: keys.nullifyingKey,
    signature: sign(keys.privateKey, message),
  };
}

/** Re-sign `input` over its own public inputs with `privateKey` (for range and curve tests). */
function resign(input, privateKey) {
  const message = hash([input.statementHash, input.masterPublicKey, input.nullifier, input.treeNumber, input.leafIndex]);
  return { ...input, signature: sign(privateKey, message) };
}

async function accepts(input) {
  await witnessBuilder.calculateWitness(input, true);
}

// Each rejection names the constraint that must fail, so a case cannot pass by failing
// somewhere else. circom's witness calculator reports "Error in template <name>_<n> line: <l>".
const FAIL = {
  masterPublicKey: /NullifierDisclosure_\d+ line: 84/,  // masterPublicKey === own.masterPublicKey
  nullifier: /NullifierDisclosure_\d+ line: 85/,        // nullifier === own.nullifier
  signature: /ForceEqualIfEnabled_\d+/,                  // EdDSA: S*B8 == R8 + 8*h*A
  sRange: /EdDSAPoseidonVerifier_\d+ line: 51/,         // S < subgroup order
  smallOrderA: /EdDSAPoseidonVerifier_\d+ line: 83/,    // 8*A != identity
  range16: /Num2Bits_\d+ line: 38/,                     // 16-bit range checks
  onCurve: /BabyCheck_\d+ line: 82/,                    // point is on BabyJubJub
};

async function rejects(input, expected, label) {
  await assert.rejects(witnessBuilder.calculateWitness(input, true), expected, label);
}

before(async () => {
  poseidon = await buildPoseidon();
  eddsa = await buildEddsa();
  babyJub = eddsa.babyJub;
  witnessBuilder = await loadWitnessBuilder(DISCLOSURE_WASM);
  ownershipBuilder = await loadWitnessBuilder(OWNERSHIP_WASM);
  keysets = loadJson(path.join(SDK_VECTORS, 'keyset-vectors.json')).vectors;
});

after(async () => {
  // snarkjs keeps bn128 worker threads alive; end them so the test process exits.
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

// ── 1. Reference parity with armada-sdk (stock Railgun engine 9.6.0) ──────────────

test('reference: spending public key and masterPublicKey match armada-sdk keysets', () => {
  for (const v of keysets) {
    const keys = keysOf(v);
    const pub = eddsa.prv2pub(keys.privateKey).map((x) => eddsa.F.toObject(x));
    assert.deepEqual(pub, keys.publicKey, v.name);
    assert.equal(hash([...keys.publicKey, keys.nullifyingKey]), keys.masterPublicKey, v.name);
  }
});

test('reference: nullifiers match armada-sdk nullifier vectors', () => {
  for (const v of loadJson(path.join(SDK_VECTORS, 'nullifier-vectors.json')).vectors) {
    assert.equal(hash([F(v.nullifyingKey), BigInt(v.leafIndex)]), F(v.nullifier), `leaf ${v.leafIndex}`);
  }
});

test('reference: EdDSA signature matches armada-sdk spend-authorization vector', () => {
  const v = loadJson(path.join(SDK_VECTORS, 'eddsa-spend-auth-vectors.json')).vectors[0];
  const keys = keysOf(keysets.find((k) => k.keyset.spendingPublicKey[0] === v.spendingPublicKey[0]));
  assert.deepEqual(sign(keys.privateKey, F(v.message)), [...v.signature.R8.map(F), F(v.signature.S)]);
});

// ── 2. NullifierOwnership on real spends ─────────────────────────────────────────

test('ownership: reproduces nullifier and note public key of every captured spend', async () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => /^(transfer|unshield)-.*\.json$/.test(f));
  assert.ok(files.length >= 5, 'expected the captured transact fixtures');
  let notes = 0;
  for (const file of files) {
    const fx = loadJson(path.join(FIXTURES, file));
    for (const [i, note] of fx.inputs.entries()) {
      notes += 1;
      const w = await ownershipBuilder.calculateWitness({
        spendingPublicKey: fx.keys.spendingPublicKey.map(F),
        nullifyingKey: F(fx.keys.nullifyingKey),
        leafIndex: BigInt(note.leafIndex),
      }, true);
      const [masterPublicKey, nullifier] = [w[1], w[2]];
      assert.equal(nullifier, F(note.nullifier), `${file} input ${i}: nullifier`);
      assert.equal(nullifier, F(fx.transactionStruct.nullifiers[i]), `${file} input ${i}: on-chain nullifier`);
      assert.equal(hash([masterPublicKey, F(note.random)]), F(note.notePublicKey), `${file} input ${i}: npk`);
    }
  }
  assert.ok(notes >= 9, `expected the 9 captured spent notes, got ${notes}`);
});

// ── 3. Acceptance ─────────────────────────────────────────────────────────────────

test('accepts: disclosures for every armada-sdk keyset at the recorded nullifier leaves', async () => {
  const leaves = loadJson(path.join(SDK_VECTORS, 'nullifier-vectors.json')).vectors.map((v) => v.leafIndex);
  for (const v of keysets) {
    for (const leafIndex of [...leaves, 65535]) {
      await accepts(disclosureInput(keysOf(v), { leafIndex, treeNumber: 3n }));
    }
  }
});

test('accepts: the circuit nullifier equals the armada-sdk recorded nullifier', async () => {
  const keys = keysOf(keysets[0]);
  for (const v of loadJson(path.join(SDK_VECTORS, 'nullifier-vectors.json')).vectors) {
    assert.equal(F(v.nullifyingKey), keys.nullifyingKey);
    const input = disclosureInput(keys, { leafIndex: v.leafIndex });
    assert.equal(input.nullifier, F(v.nullifier));
    await accepts(input);
  }
});

test('accepts: the witness satisfies the R1CS', async () => {
  const input = disclosureInput(keysOf(keysets[1]), { leafIndex: 17, treeNumber: 1n });
  const wtns = path.join(fs.mkdtempSync(path.join(BUILD, 'wtns-')), 'disclosure.wtns');
  fs.writeFileSync(wtns, await witnessBuilder.calculateWTNSBin(input, true));
  assert.equal(await snarkjs.wtns.check(DISCLOSURE_R1CS, wtns), true);
});

// ── 4. Rejection: one broken property at a time ───────────────────────────────────

test('rejects: a nullifyingKey of another wallet', async () => {
  const input = disclosureInput(keysOf(keysets[0]), { leafIndex: 5 });
  await rejects({ ...input, nullifyingKey: keysOf(keysets[1]).nullifyingKey }, FAIL.masterPublicKey);
});

test('rejects: a nullifier of a different leaf', async () => {
  const keys = keysOf(keysets[0]);
  const input = disclosureInput(keys, { leafIndex: 5 });
  await rejects(resign({ ...input, nullifier: hash([keys.nullifyingKey, 6n]) }, keys.privateKey), FAIL.nullifier);
});

test('rejects: a masterPublicKey of another wallet', async () => {
  const keys = keysOf(keysets[0]);
  const input = disclosureInput(keys, { leafIndex: 5 });
  await rejects(resign({ ...input, masterPublicKey: keysOf(keysets[1]).masterPublicKey }, keys.privateKey), FAIL.masterPublicKey);
});

test('rejects: a signature by another spending key', async () => {
  const input = disclosureInput(keysOf(keysets[0]), { leafIndex: 5 });
  await rejects(resign(input, keysOf(keysets[1]).privateKey), FAIL.signature);
});

test('rejects: a signature over another statement', async () => {
  const keys = keysOf(keysets[0]);
  const input = disclosureInput(keys, { leafIndex: 5, statementHash: 111n });
  await rejects({ ...input, statementHash: 222n }, FAIL.signature);
});

test('rejects: each public input changed after signing', async () => {
  const keys = keysOf(keysets[2]);
  const input = disclosureInput(keys, { leafIndex: 9, treeNumber: 2n, statementHash: 77n });
  await rejects({ ...input, treeNumber: 3n }, FAIL.signature, 'treeNumber');
  await rejects({ ...input, statementHash: 78n }, FAIL.signature, 'statementHash');
  // leafIndex, nullifier and masterPublicKey are also bound by the key constraints;
  // keep those consistent so only the signature can catch the change.
  const otherLeaf = { ...input, leafIndex: 10n, nullifier: hash([keys.nullifyingKey, 10n]) };
  await rejects(otherLeaf, FAIL.signature, 'leafIndex');
});

test('rejects: a malleable signature (S + subgroup order)', async () => {
  const input = disclosureInput(keysOf(keysets[0]), { leafIndex: 5 });
  const [r8x, r8y, s] = input.signature;
  await rejects({ ...input, signature: [r8x, r8y, s + babyJub.subOrder] }, FAIL.sRange);
});

test('rejects: leafIndex or treeNumber outside 16 bits, even when signed', async () => {
  const keys = keysOf(keysets[0]);
  await rejects(disclosureInput(keys, { leafIndex: 65536 }), FAIL.range16, 'leafIndex');
  await rejects(disclosureInput(keys, { leafIndex: 1, treeNumber: 65536n }), FAIL.range16, 'treeNumber');
});

test('rejects: points off the curve', async () => {
  const keys = keysOf(keysets[0]);
  const input = disclosureInput(keys, { leafIndex: 5 });
  const [r8x, r8y, s] = input.signature;
  await rejects({ ...input, signature: [r8x, r8y + 1n, s] }, FAIL.onCurve, 'R8');
  const offA = [keys.publicKey[0], keys.publicKey[1] + 1n];
  const mpk = hash([...offA, keys.nullifyingKey]);
  await rejects(resign({ ...input, spendingPublicKey: offA, masterPublicKey: mpk }, keys.privateKey), FAIL.onCurve, 'A');
});

test('rejects: a forged signature for a small-order spending key', async () => {
  // With A of small order, 8*h*A is the identity, so R8 = S*B8 "verifies" for any message.
  const p = poseidon.F.p;
  for (const A of [[0n, 1n], [0n, p - 1n]]) {
    const nullifyingKey = 42n;
    const s = 12345n;
    const R8 = babyJub.mulPointEscalar(babyJub.Base8, s).map((x) => babyJub.F.toObject(x));
    await rejects({
      statementHash: 1n,
      masterPublicKey: hash([...A, nullifyingKey]),
      nullifier: hash([nullifyingKey, 5n]),
      treeNumber: 0n,
      leafIndex: 5n,
      spendingPublicKey: A,
      nullifyingKey,
      signature: [...R8, s],
    }, FAIL.smallOrderA, `A = (${A[0]}, ${A[1]})`);
  }
});

// ── 5. Groth16 round trip ─────────────────────────────────────────────────────────

test('groth16: proof verifies; any changed public signal fails', async () => {
  const vkey = loadJson(DISCLOSURE_VKEY);
  const input = disclosureInput(keysOf(keysets[0]), { leafIndex: 17, treeNumber: 1n, statementHash: 999n });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, DISCLOSURE_WASM, DISCLOSURE_ZKEY);
  assert.deepEqual(publicSignals, [input.statementHash, input.masterPublicKey, input.nullifier, input.treeNumber, input.leafIndex].map(String));
  assert.equal(await snarkjs.groth16.verify(vkey, publicSignals, proof), true);
  for (let i = 0; i < publicSignals.length; i++) {
    const changed = [...publicSignals];
    changed[i] = (BigInt(changed[i]) + 1n).toString();
    assert.equal(await snarkjs.groth16.verify(vkey, changed, proof), false, `public signal ${i}`);
  }
});

process.on('exit', () => {
  for (const d of fs.readdirSync(BUILD).filter((d) => d.startsWith('wtns-'))) {
    fs.rmSync(path.join(BUILD, d), { recursive: true, force: true });
  }
});
