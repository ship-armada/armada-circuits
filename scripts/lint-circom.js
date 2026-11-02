// ABOUTME: Runs circomspect over the circuit sources and fails on any finding not explicitly accepted.
// ABOUTME: Accepted findings live in scripts/circomspect-accepted.json, each with a written reason.
/**
 * circomspect has no per-line suppression, only a global `--allow <ID>`,
 * which would also hide real findings elsewhere. Instead this script runs
 * circomspect with SARIF output and compares every finding against an
 * accepted list keyed by (rule, file, flagged source line). It fails on:
 *   - any finding not in the accepted list, and
 *   - any accepted entry that circomspect no longer reports (stale entry).
 *
 * Run: node scripts/lint-circom.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['src/lib', 'src/operations', 'src/main'];
const ACCEPTED_PATH = path.join(__dirname, 'circomspect-accepted.json');

/**
 * Turn circomspect SARIF results into findings with repo-relative paths and
 * the trimmed source line circomspect flagged.
 */
function findingsFromSarif(sarif, root, readLine) {
  const results = (sarif.runs && sarif.runs[0] && sarif.runs[0].results) || [];
  return results.map((r) => {
    const loc = r.locations[0].physicalLocation;
    const abs = decodeURIComponent(loc.artifactLocation.uri.replace(/^file:\/\//, ''));
    const file = path.relative(root, abs).split(path.sep).join('/');
    const line = loc.region.startLine;
    return {
      rule: r.ruleId,
      file,
      line,
      code: readLine(abs, line).trim(),
      message: r.message.text,
    };
  });
}

/**
 * Split findings into accepted and unexpected, and report accepted entries
 * that matched nothing. Matching uses rule + file + flagged code, not line
 * numbers, so unrelated edits that shift lines don't invalidate the list.
 */
function compareFindings(findings, accepted) {
  const key = (x) => `${x.rule}\u0000${x.file}\u0000${x.code}`;
  const acceptedKeys = new Map(accepted.map((a) => [key(a), a]));
  const matchedKeys = new Set();
  const acceptedFindings = [];
  const unexpected = [];
  for (const f of findings) {
    const entry = acceptedKeys.get(key(f));
    if (entry) {
      acceptedFindings.push({ ...f, reason: entry.reason });
      matchedKeys.add(key(f));
    } else {
      unexpected.push(f);
    }
  }
  const stale = accepted.filter((a) => !matchedKeys.has(key(a)));
  return { acceptedFindings, unexpected, stale };
}

function validateAccepted(list) {
  if (!Array.isArray(list)) throw new Error('circomspect-accepted.json: "accepted" must be an array');
  for (const [i, a] of list.entries()) {
    for (const field of ['rule', 'file', 'code', 'reason']) {
      if (typeof a[field] !== 'string' || a[field].trim() === '') {
        throw new Error(`circomspect-accepted.json: entry ${i} needs a non-empty "${field}"`);
      }
    }
  }
  return list;
}

function circuitSources(root) {
  return SOURCE_DIRS.flatMap((dir) =>
    fs.readdirSync(path.join(root, dir))
      .filter((f) => f.endsWith('.circom'))
      .sort()
      .map((f) => path.join(root, dir, f)));
}

function main() {
  const accepted = validateAccepted(JSON.parse(fs.readFileSync(ACCEPTED_PATH, 'utf8')).accepted);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'circomspect-'));
  const sarifPath = path.join(tmp, 'results.sarif');
  // circomspect exits non-zero whenever it reports a finding, so the exit
  // code alone can't distinguish "findings" from "crashed"; the SARIF file
  // is the source of truth. Its human-readable output is captured and only
  // shown if it fails to produce SARIF.
  const run = spawnSync('circomspect', ['--sarif-file', sarifPath, ...circuitSources(ROOT)], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (run.error) {
    console.error(`circomspect could not be started: ${run.error.message}`);
    process.exit(1);
  }
  if (!fs.existsSync(sarifPath)) {
    console.error('circomspect did not produce SARIF output:');
    console.error(run.stdout + run.stderr);
    process.exit(1);
  }

  const lineCache = new Map();
  const readLine = (abs, n) => {
    if (!lineCache.has(abs)) lineCache.set(abs, fs.readFileSync(abs, 'utf8').split('\n'));
    return lineCache.get(abs)[n - 1] || '';
  };
  const findings = findingsFromSarif(JSON.parse(fs.readFileSync(sarifPath, 'utf8')), ROOT, readLine);
  fs.rmSync(tmp, { recursive: true, force: true });

  const { acceptedFindings, unexpected, stale } = compareFindings(findings, accepted);

  for (const f of acceptedFindings) {
    console.log(`  accepted ${f.rule} ${f.file}:${f.line} — ${f.reason}`);
  }
  for (const f of unexpected) {
    console.error(`  NEW ${f.rule} ${f.file}:${f.line}: ${f.message}`);
    console.error(`      ${f.code}`);
  }
  for (const a of stale) {
    console.error(`  STALE accepted entry no longer reported: ${a.rule} ${a.file}: ${a.code}`);
  }

  if (unexpected.length > 0 || stale.length > 0) {
    console.error(
      `circomspect: ${unexpected.length} new finding(s), ${stale.length} stale accepted entr(ies). ` +
      'Fix new findings or add them to scripts/circomspect-accepted.json with a reason; remove stale entries.');
    process.exit(1);
  }
  console.log(`circomspect: ${findings.length} finding(s), all accepted.`);
}

if (require.main === module) {
  main();
}

module.exports = { findingsFromSarif, compareFindings, validateAccepted };
