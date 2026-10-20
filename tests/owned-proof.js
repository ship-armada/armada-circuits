/**
 * Prove and verify an owned Transact shape from a hand-built witness.
 *
 * Usage:
 *   node tests/owned-proof.js --shape transact-owned-1x2 --case base
 *   node tests/owned-proof.js --shape transact-owned-1x2 --case different-owner
 *
 * Case "base" proves one witness and checks the proof verifies, that the
 * circuit's npk output matches Poseidon(ownerField, random), and that its
 * nullifier output matches Poseidon(ownerField, leafIndex) — both computed
 * independently in JavaScript. The nullifier binds to ownerField alone, so
 * no other witness input can change it (double-spend protection).
 *
 * Case "different-owner" proves two witnesses that differ only in owner,
 * and checks they produce two different npk values.
 *
 * Prints exactly one JSON object to stdout; judges nothing itself.
 */

const fs = require("fs");
const snarkjs = require("snarkjs");
const {
  OWNED_SHAPES,
  parseShapeArg,
  ensureCompiled,
  ensureZkey,
  parseSym,
  getPoseidon,
} = require("./lib/owned-circuit");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    args[key] = argv[i + 1];
  }
  return args;
}

function buildOwnedWitness({ poseidon, m, owner, random, boundParamsHash }) {
  const F = poseidon.F;
  const hash2 = (a, b) => F.toString(poseidon([a, b]));
  const hash3 = (a, b, c) => F.toString(poseidon([a, b, c]));

  const token = "999";
  const leafIndex = "0";
  const valueIn = "1000";

  const npk = hash2(owner, random);
  const leaf = hash3(npk, token, valueIn);

  const DEPTH = 16;
  let levelHash = leaf;
  for (let i = 0; i < DEPTH; i++) {
    levelHash = hash2(levelHash, "0");
  }
  const merkleRoot = levelHash;

  const nullifier = hash2(owner, leafIndex);

  const npkOut = [];
  const valueOut = [];
  const commitmentsOut = [];
  for (let j = 0; j < m; j++) {
    const npkOutJ = hash2(String(2000 + j), "1");
    const valueOutJ = j === 0 ? valueIn : "0";
    npkOut.push(npkOutJ);
    valueOut.push(valueOutJ);
    commitmentsOut.push(hash3(npkOutJ, token, valueOutJ));
  }

  const input = {
    merkleRoot,
    boundParamsHash,
    nullifiers: [nullifier],
    commitmentsOut,
    ownerField: owner,
    token,
    randomIn: [random],
    valueIn: [valueIn],
    pathElements: new Array(DEPTH).fill("0"),
    leavesIndices: [leafIndex],
    npkOut,
    valueOut,
  };

  return { input, npkExpected: npk, nullifierExpected: nullifier };
}

async function proveAndGetNpk({ paths, zkeyPath, poseidon, m, owner, random }) {
  const { input, npkExpected, nullifierExpected } = buildOwnedWitness({
    poseidon,
    m,
    owner,
    random,
    boundParamsHash: "555",
  });

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    paths.wasm,
    zkeyPath,
  );

  const symMap = parseSym(paths.sym);
  const npkWitnessIdx = symMap.get(`main.npk[0]`);
  if (npkWitnessIdx === undefined) {
    throw new Error(`main.npk[0] not found in ${paths.sym}`);
  }
  const nullifierWitnessIdx = symMap.get(`main.nullifiers[0]`);
  if (nullifierWitnessIdx === undefined) {
    throw new Error(`main.nullifiers[0] not found in ${paths.sym}`);
  }
  // publicSignals excludes the constant-1 signal at witness index 0.
  const npkFromProof = publicSignals[npkWitnessIdx - 1];
  const nullifierFromProof = publicSignals[nullifierWitnessIdx - 1];

  return {
    proof,
    publicSignals,
    npkFromProof,
    npkExpected,
    nullifierFromProof,
    nullifierExpected,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const shapeName = parseShapeArg(args.shape);
  const { m } = OWNED_SHAPES[shapeName];

  const paths = ensureCompiled(shapeName);
  const { zkeyPath, vkeyPath } = ensureZkey(paths.r1cs, paths.outdir);
  const poseidon = await getPoseidon();

  const OWNER_A = "123456789012345678901234567890123456789";
  const OWNER_B = "987654321098765432109876543210987654321";
  const RANDOM_A = "424242";

  if (args.case === "base") {
    const {
      proof,
      publicSignals,
      npkFromProof,
      npkExpected,
      nullifierFromProof,
      nullifierExpected,
    } = await proveAndGetNpk({
      paths,
      zkeyPath,
      poseidon,
      m,
      owner: OWNER_A,
      random: RANDOM_A,
    });

    const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
    const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    const npk_matches_js_poseidon = npkFromProof === npkExpected;
    const nullifier_matches_js_poseidon =
      nullifierFromProof === nullifierExpected;

    console.log(
      JSON.stringify({
        verified,
        npk_matches_js_poseidon,
        nullifier_matches_js_poseidon,
      }),
    );
    process.exit(0);
  }

  if (args.case === "different-owner") {
    const a = await proveAndGetNpk({
      paths,
      zkeyPath,
      poseidon,
      m,
      owner: OWNER_A,
      random: RANDOM_A,
    });
    const b = await proveAndGetNpk({
      paths,
      zkeyPath,
      poseidon,
      m,
      owner: OWNER_B,
      random: RANDOM_A,
    });

    const npk_differs = a.npkFromProof !== b.npkFromProof;
    console.log(JSON.stringify({ npk_differs }));
    process.exit(0);
  }

  throw new Error(`Unknown --case value: ${args.case}`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
