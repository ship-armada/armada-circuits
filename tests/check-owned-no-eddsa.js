/**
 * Acceptance probe: the owned shapes contain no
 * EdDSA signature check.
 *
 * Counts signals whose compiled name mentions "eddsa" (case-insensitive)
 * across all three owned shapes' .sym files. A compiled EdDSAPoseidonVerifier
 * instance always leaves such a signal (e.g. "main.eddsa.Ax"); their
 * absence means the shape never instantiated one.
 *
 * Prints exactly one JSON object to stdout; judges nothing itself.
 */

const fs = require("fs");
const { OWNED_SHAPES, ensureCompiled } = require("./lib/owned-circuit");

function main() {
  let eddsaChecksFound = 0;
  for (const shapeName of Object.keys(OWNED_SHAPES)) {
    const paths = ensureCompiled(shapeName);
    const sym = fs.readFileSync(paths.sym, "utf-8");
    for (const line of sym.trim().split("\n")) {
      const name = line.split(",")[3] || "";
      if (name.toLowerCase().includes("eddsa")) {
        eddsaChecksFound += 1;
      }
    }
  }
  console.log(JSON.stringify({ eddsa_checks_found: eddsaChecksFound }));
  process.exit(0);
}

main();
