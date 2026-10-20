/**
 * Shared helpers for exercising the owned Transact circuit shapes
 * (1x1_owned, 1x2_owned, 1x3_owned) from the acceptance-test scripts under
 * tests/ and scripts/. Each helper is self-contained: it compiles or sets
 * up whatever artifact it needs instead of assuming another script ran
 * first, so any one acceptance test can run standalone.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const BUILD_ROOT = path.join(ROOT, "build");
const CIRCOM2 = path.join(ROOT, "node_modules", ".bin", "circom2");
const SNARKJS_BIN = path.join(ROOT, "node_modules", ".bin", "snarkjs");

const OWNED_SHAPES = {
  "1x1_owned": { n: 1, m: 1 },
  "1x2_owned": { n: 1, m: 2 },
  "1x3_owned": { n: 1, m: 3 },
};

// A dedicated, small powers-of-tau for these test-only setups. Deterministic
// entropy: this key is for exercising the circuit shape in tests, never for
// a deployed verifier (see scripts/setup-dev.sh for that warning in full).
const TEST_PTAU_POWER = 15;

function parseShapeArg(arg) {
  const match = /^transact-owned-(\d+)x(\d+)$/.exec(arg || "");
  if (!match) {
    throw new Error(`Unrecognized --shape value: ${arg}`);
  }
  const shapeName = `${match[1]}x${match[2]}_owned`;
  if (!OWNED_SHAPES[shapeName]) {
    throw new Error(`Unknown owned shape: ${shapeName}`);
  }
  return shapeName;
}

function shapeBuildPaths(shapeName) {
  const outdir = path.join(BUILD_ROOT, shapeName);
  return {
    outdir,
    r1cs: path.join(outdir, `main_${shapeName}.r1cs`),
    sym: path.join(outdir, `main_${shapeName}.sym`),
    wasm: path.join(outdir, `main_${shapeName}_js`, `main_${shapeName}.wasm`),
  };
}

function newerThanAll(sourceMtimeMs, outputPaths) {
  return outputPaths.every(
    (p) => fs.existsSync(p) && fs.statSync(p).mtimeMs >= sourceMtimeMs,
  );
}

function ensureCompiled(shapeName) {
  const paths = shapeBuildPaths(shapeName);
  const mainFile = path.join(ROOT, "src", "main", `main_${shapeName}.circom`);
  const operationsFile = path.join(
    ROOT,
    "src",
    "operations",
    "TransactOwned.circom",
  );
  const sourceMtimeMs = Math.max(
    fs.statSync(mainFile).mtimeMs,
    fs.statSync(operationsFile).mtimeMs,
  );
  if (newerThanAll(sourceMtimeMs, [paths.r1cs, paths.sym, paths.wasm])) {
    return paths;
  }
  fs.mkdirSync(paths.outdir, { recursive: true });
  execFileSync(
    CIRCOM2,
    [mainFile, "--r1cs", "--wasm", "--sym", "-o", paths.outdir, "--O1"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return paths;
}

function parseSym(symPath) {
  const byName = new Map();
  for (const line of fs.readFileSync(symPath, "utf-8").trim().split("\n")) {
    const [, witnessIdx, , name] = line.split(",");
    byName.set(name, Number(witnessIdx));
  }
  return byName;
}

function ensureTestPtau() {
  const ptauDir = path.join(BUILD_ROOT, "ptau");
  const finalPtau = path.join(
    ptauDir,
    `pot${TEST_PTAU_POWER}_owned_test_final.ptau`,
  );
  if (fs.existsSync(finalPtau)) {
    return finalPtau;
  }
  fs.mkdirSync(ptauDir, { recursive: true });
  const init = path.join(ptauDir, `pot${TEST_PTAU_POWER}_owned_test_0000.ptau`);
  const contrib = path.join(
    ptauDir,
    `pot${TEST_PTAU_POWER}_owned_test_0001.ptau`,
  );
  execFileSync(
    SNARKJS_BIN,
    ["powersoftau", "new", "bn128", String(TEST_PTAU_POWER), init],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  execFileSync(
    SNARKJS_BIN,
    ["powersoftau", "contribute", init, contrib, "--name=owned-test"],
    {
      input: "armada-owned-test-entropy\n",
      stdio: ["pipe", "ignore", "inherit"],
    },
  );
  execFileSync(
    SNARKJS_BIN,
    ["powersoftau", "prepare", "phase2", contrib, finalPtau],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  fs.rmSync(init, { force: true });
  fs.rmSync(contrib, { force: true });
  return finalPtau;
}

function ensureZkey(r1csPath, outdir) {
  const zkeyPath = path.join(outdir, "owned-test.zkey");
  const vkeyPath = path.join(outdir, "owned-test.vkey.json");
  if (newerThanAll(fs.statSync(r1csPath).mtimeMs, [zkeyPath, vkeyPath])) {
    return { zkeyPath, vkeyPath };
  }
  const ptauPath = ensureTestPtau();
  const initialZkey = path.join(outdir, "owned-test.0000.zkey");
  execFileSync(
    SNARKJS_BIN,
    ["groth16", "setup", r1csPath, ptauPath, initialZkey],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  execFileSync(
    SNARKJS_BIN,
    ["zkey", "contribute", initialZkey, zkeyPath, "--name=owned-test"],
    {
      input: "armada-owned-test-zkey-entropy\n",
      stdio: ["pipe", "ignore", "inherit"],
    },
  );
  execFileSync(
    SNARKJS_BIN,
    ["zkey", "export", "verificationkey", zkeyPath, vkeyPath],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  fs.rmSync(initialZkey, { force: true });
  return { zkeyPath, vkeyPath };
}

let poseidonPromise = null;
function getPoseidon() {
  if (!poseidonPromise) {
    poseidonPromise = require("circomlibjs").buildPoseidon();
  }
  return poseidonPromise;
}

// Exports via the snarkjs CLI, not its `r1csfile` library (readR1cs never
// returns in this environment — it leaves the event loop open on an
// unresolved file handle). The CLI path is the same one scripts/setup-dev.sh
// already relies on, and it exits promptly.
function exportR1csJson(r1csPath, outdir) {
  const jsonPath = r1csPath.replace(/\.r1cs$/, ".r1cs.json");
  if (!newerThanAll(fs.statSync(r1csPath).mtimeMs, [jsonPath])) {
    execFileSync(SNARKJS_BIN, ["r1cs", "export", "json", r1csPath, jsonPath], {
      cwd: outdir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
}

module.exports = {
  OWNED_SHAPES,
  ROOT,
  BUILD_ROOT,
  parseShapeArg,
  shapeBuildPaths,
  ensureCompiled,
  parseSym,
  ensureZkey,
  exportR1csJson,
  getPoseidon,
};
