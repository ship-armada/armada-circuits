/**
 * Differential test: feed captured reference vector through our circuit.
 *
 * Loads transfer-1x2.json fixture, constructs circuit input, generates
 * witness + proof, and verifies it against the captured public signals.
 *
 * Run from armada-circuits repo root:
 *   node tests/diff-test.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const snarkjs = require('snarkjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'generated');
const BUILD = path.join(__dirname, '..', 'build', '1x2');
const WASM = path.join(BUILD, 'main_1x2_js', 'main_1x2.wasm');
const ZKEY = path.join(BUILD, 'final.zkey');
const VKEY = path.join(BUILD, 'vkey.json');

function hexToField(hex) {
  // Strip 0x prefix if present, convert to decimal string for snarkjs
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + clean).toString();
}

function stripHex(hex) {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

async function main() {
  console.log('='.repeat(60));
  console.log('  Differential Test: transfer-1x2');
  console.log('='.repeat(60));

  // Load fixture
  const fixturePath = path.join(FIXTURES, 'transfer-1x2.json');
  if (!fs.existsSync(fixturePath)) {
    throw new Error('Fixture not found: ' + fixturePath);
  }
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  console.log('Loaded fixture:', fixturePath);
  console.log('Shape:', fx.shape.nullifiers + 'x' + fx.shape.commitments);

  // Build circuit input from fixture
  // Circuit expects (from SDK formatRailgunInputs):
  //   merkleRoot, boundParamsHash, nullifiers[], commitments[],
  //   token, publicKey[2], signature[3], nullifyingKey,
  //   randomIn[], valueIn[], pathElements[N][16], leavesIndices[],
  //   npkOut[], valueOut[]

  const input = {
    // Public inputs
    merkleRoot: hexToField(fx.transactionStruct.merkleRoot),
    boundParamsHash: hexToField(fx.boundParamsHash),
    nullifiers: fx.transactionStruct.nullifiers.map(hexToField),
    commitments: fx.transactionStruct.commitments.map(hexToField),

    // Private: keys
    token: hexToField(fx.inputs[0].tokenHash),  // tokenHash
    publicKey: [
      hexToField(fx.keys.spendingPublicKey[0]),
      hexToField(fx.keys.spendingPublicKey[1]),
    ],
    signature: [
      hexToField(fx.eddsaSignature.R8[0]),
      hexToField(fx.eddsaSignature.R8[1]),
      hexToField(fx.eddsaSignature.S),
    ],
    nullifyingKey: hexToField(fx.keys.nullifyingKey),

    // Private: inputs
    randomIn: fx.inputs.map(inp => hexToField(inp.random)),
    valueIn: fx.inputs.map(inp => inp.value),  // already decimal string
    pathElements: fx.inputs.map(inp => inp.merkleProof.elements.map(hexToField)),
    leavesIndices: fx.inputs.map(inp => inp.leafIndex.toString()),

    // Private: outputs
    npkOut: fx.outputs.map(out => hexToField(out.notePublicKey)),
    valueOut: fx.outputs.map(out => out.value),  // already decimal string
  };

  console.log('\nCircuit input constructed.');
  console.log('  merkleRoot:', input.merkleRoot.slice(0, 20) + '...');
  console.log('  boundParamsHash:', input.boundParamsHash.slice(0, 20) + '...');
  console.log('  token:', input.token);
  console.log('  nullifiers:', input.nullifiers);
  console.log('  commitments:', input.commitments);
  console.log('  pathElements[0] length:', input.pathElements[0].length);
  console.log('  leavesIndices:', input.leavesIndices);

  // Verify artifacts exist
  for (const [label, p] of [['WASM', WASM], ['ZKEY', ZKEY], ['VKEY', VKEY]]) {
    if (!fs.existsSync(p)) {
      throw new Error(`${label} not found: ${p}. Run 'npm run compile && npm run setup:dev' first.`);
    }
  }

  // Generate witness + proof
  console.log('\nGenerating proof...');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

  console.log('Proof generated.');
  console.log('  proof.a.x:', proof.pi_a[0].slice(0, 20) + '...');
  console.log('  public signals:', publicSignals);

  // Compare public signals with fixture
  console.log('\nComparing public signals...');
  const expectedSignals = fx.publicSignals.map(s => {
    const clean = typeof s === 'string' ? s.replace(/^0x/i, '') : String(s);
    return BigInt('0x' + clean).toString();
  });

  let allMatch = true;
  for (let i = 0; i < publicSignals.length; i++) {
    const got = publicSignals[i];
    const want = expectedSignals[i];
    const match = got === want;
    if (!match) allMatch = false;
    console.log(`  [${i}] ${match ? '✓' : '✗'} got=${got.slice(0, 20)}... want=${want.slice(0, 20)}...`);
  }

  if (!allMatch) {
    console.error('\n❌ Public signals mismatch!');
  }

  // Verify proof
  console.log('\nVerifying proof...');
  const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf-8'));
  const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(isValid ? '✅ Proof verified successfully!' : '❌ Proof verification FAILED!');

  if (allMatch && isValid) {
    console.log('\n' + '='.repeat(60));
    console.log('  ALL CHECKS PASSED — Circuit matches reference vector');
    console.log('='.repeat(60));
  } else {
    console.log('\n' + '='.repeat(60));
    console.log('  SOME CHECKS FAILED');
    console.log('='.repeat(60));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
