/**
 * Differential test: feed captured reference vectors through our circuits.
 *
 * For each fixture in tests/fixtures/generated/, this script:
 *   1. Reads the fixture's shape (NxM) from its metadata
 *   2. Constructs the circuit input from witness data
 *   3. Generates a proof using the matching compiled circuit
 *   4. Compares public signals against the captured reference
 *   5. Verifies the proof with the circuit's vkey
 *
 * Usage:
 *   node tests/diff-test.js                      # run all fixtures
 *   node tests/diff-test.js transfer-1x2         # run a specific fixture
 */

const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'generated');
const BUILD_ROOT = path.join(__dirname, '..', 'build');

function hexToField(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + clean).toString();
}

function stripHex(hex) {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/**
 * Build the circom witness input from a captured fixture.
 * Works for any (N,M) shape — arrays auto-size from the fixture.
 */
function buildCircuitInput(fx) {
  return {
    // Public inputs
    merkleRoot: hexToField(fx.transactionStruct.merkleRoot),
    boundParamsHash: hexToField(fx.boundParamsHash),
    nullifiers: fx.transactionStruct.nullifiers.map(hexToField),
    commitments: fx.transactionStruct.commitments.map(hexToField),

    // Private: keys
    token: hexToField(fx.inputs[0].tokenHash),
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

    // Private: inputs (N entries)
    randomIn: fx.inputs.map(inp => hexToField(inp.random)),
    valueIn: fx.inputs.map(inp => inp.value),
    pathElements: fx.inputs.map(inp => inp.merkleProof.elements.map(hexToField)),
    leavesIndices: fx.inputs.map(inp => inp.leafIndex.toString()),

    // Private: outputs (M entries)
    npkOut: fx.outputs.map(out => hexToField(out.notePublicKey)),
    valueOut: fx.outputs.map(out => out.value),
  };
}

/**
 * Run a differential test for a single fixture.
 */
async function runDiffTest(fixturePath) {
  const fxName = path.basename(fixturePath, '.json');
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  const N = fx.shape.nullifiers;
  const M = fx.shape.commitments;
  const shapeName = `${N}x${M}`;

  console.log('='.repeat(60));
  console.log(`  Differential Test: ${fxName} (${shapeName})`);
  console.log('='.repeat(60));

  // Locate build artifacts for this shape
  const buildDir = path.join(BUILD_ROOT, shapeName);
  const wasm = path.join(buildDir, `main_${shapeName}_js`, `main_${shapeName}.wasm`);
  const zkey = path.join(buildDir, 'final.zkey');
  const vkeyPath = path.join(buildDir, 'vkey.json');

  for (const [label, p] of [['WASM', wasm], ['ZKEY', zkey], ['VKEY', vkeyPath]]) {
    if (!fs.existsSync(p)) {
      throw new Error(`${label} not found: ${p}. Run 'npm run compile && npm run setup:dev' first.`);
    }
  }

  // Build circuit input
  const input = buildCircuitInput(fx);
  console.log(`Loaded fixture: ${fixturePath}`);
  console.log(`  nullifiers: ${N}, commitments: ${M}`);
  console.log(`  inputs: ${input.randomIn.length}, outputs: ${input.npkOut.length}`);
  console.log(`  pathElements[0] length: ${input.pathElements[0].length}`);

  // Generate proof
  console.log('\nGenerating proof...');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  console.log('Proof generated.');

  // Compare public signals
  console.log('\nComparing public signals...');
  const expectedSignals = fx.publicSignals.map(s => {
    const clean = typeof s === 'string' ? s.replace(/^0x/i, '') : String(s);
    return BigInt('0x' + clean).toString();
  });

  let signalsMatch = true;
  for (let i = 0; i < publicSignals.length; i++) {
    const got = publicSignals[i];
    const want = expectedSignals[i];
    const match = got === want;
    if (!match) signalsMatch = false;
    console.log(`  [${i}] ${match ? '✓' : '✗'} got=${got.slice(0, 20)}... want=${want.slice(0, 20)}...`);
  }

  if (!signalsMatch) {
    console.error('  ❌ Public signals mismatch!');
  }

  // Verify proof
  console.log('\nVerifying proof...');
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));
  const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(isValid ? '  ✅ Proof verified!' : '  ❌ Proof verification FAILED!');

  const passed = signalsMatch && isValid;
  console.log(passed ? '  ✓ ALL CHECKS PASSED' : '  ✗ SOME CHECKS FAILED');
  console.log('');

  return { name: fxName, shape: shapeName, passed, signalsMatch, isValid };
}

async function main() {
  // Determine which fixtures to test
  const arg = process.argv[2];
  let fixturePaths;

  if (arg) {
    // Single fixture specified
    const name = arg.endsWith('.json') ? arg.slice(0, -5) : arg;
    fixturePaths = [path.join(FIXTURES, name + '.json')];
  } else {
    // All transfer/shield/unshield fixtures
    fixturePaths = fs.readdirSync(FIXTURES)
      .filter(f => f.endsWith('.json') && (f.startsWith('transfer-') || f.startsWith('unshield-') || f.startsWith('adapt-')))
      .map(f => path.join(FIXTURES, f))
      .sort();
  }

  if (fixturePaths.length === 0) {
    console.log('No fixtures found in', FIXTURES);
    return;
  }

  console.log(`Running ${fixturePaths.length} differential test(s)...\n`);

  const results = [];
  for (const fp of fixturePaths) {
    if (!fs.existsSync(fp)) {
      console.error('Fixture not found:', fp);
      continue;
    }
    try {
      results.push(await runDiffTest(fp));
    } catch (err) {
      console.error(`Error testing ${path.basename(fp)}:`, err.message);
      results.push({ name: path.basename(fp, '.json'), shape: '?', passed: false, error: err.message });
    }
  }

  // Summary
  console.log('='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  for (const r of results) {
    const status = r.passed ? '✓' : '✗';
    const extra = r.error ? ` (${r.error})` : '';
    console.log(`  ${status} ${r.name} (${r.shape})${extra}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
