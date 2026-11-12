/**
 * Acceptance probe: every public input of each owned
 * shape appears in at least one constraint.
 *
 * Reads the compiled r1cs (via snarkjs, exported to JSON) to find which
 * witness indices are referenced by any constraint's A/B/C linear
 * combination, then checks that every public-input witness index — the
 * ones right after the outputs, per the circom witness layout — is one of
 * them.
 *
 * Prints exactly one JSON object to stdout; judges nothing itself.
 */

const {
  OWNED_SHAPES,
  ensureCompiled,
  exportR1csJson,
} = require("./lib/owned-circuit");

function unconstrainedPublicInputCount(r1cs) {
  const used = new Set();
  for (const [a, b, c] of r1cs.constraints) {
    for (const lc of [a, b, c]) {
      for (const idx of Object.keys(lc)) {
        used.add(Number(idx));
      }
    }
  }

  // Witness layout: [1, output[0..nOutputs), pubInput[0..nPubInputs), ...]
  let unconstrained = 0;
  const start = r1cs.nOutputs + 1;
  const end = start + r1cs.nPubInputs;
  for (let idx = start; idx < end; idx++) {
    if (!used.has(idx)) {
      unconstrained += 1;
    }
  }
  return unconstrained;
}

function main() {
  let unconstrainedPublicInputs = 0;
  for (const shapeName of Object.keys(OWNED_SHAPES)) {
    const paths = ensureCompiled(shapeName);
    const r1cs = exportR1csJson(paths.r1cs, paths.outdir);
    unconstrainedPublicInputs += unconstrainedPublicInputCount(r1cs);
  }
  console.log(
    JSON.stringify({ unconstrained_public_inputs: unconstrainedPublicInputs }),
  );
  process.exit(0);
}

main();
