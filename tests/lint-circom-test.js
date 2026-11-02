// ABOUTME: Unit tests for the circomspect accepted-findings check in scripts/lint-circom.js.
// ABOUTME: Covers SARIF parsing, matching by rule/file/code, new findings, stale entries and validation.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findingsFromSarif, compareFindings, validateAccepted } = require('../scripts/lint-circom.js');

const ROOT = '/repo';

const sarifWith = (results) => ({ runs: [{ results }] });
const result = (ruleId, file, line, text = 'msg') => ({
  ruleId,
  message: { text },
  locations: [{ physicalLocation: { artifactLocation: { uri: `file://${ROOT}/${file}` }, region: { startLine: line } } }],
});
const sources = {
  [path.join(ROOT, 'src/lib/merkle.circom')]: ['a', '  component idxBits = Num2Bits(depth);  ', 'c'],
  [path.join(ROOT, 'src/operations/Transact.circom')]: ['x', 'component bits = Num2Bits(254);'],
};
const readLine = (abs, n) => sources[abs][n - 1];

const ACCEPTED = {
  rule: 'CS0010',
  file: 'src/lib/merkle.circom',
  code: 'component idxBits = Num2Bits(depth);',
  reason: 'depth is always 16',
};

test('findingsFromSarif gives repo-relative paths and the trimmed flagged line', () => {
  const findings = findingsFromSarif(sarifWith([result('CS0010', 'src/lib/merkle.circom', 2)]), ROOT, readLine);
  assert.deepEqual(findings, [{
    rule: 'CS0010',
    file: 'src/lib/merkle.circom',
    line: 2,
    code: 'component idxBits = Num2Bits(depth);',
    message: 'msg',
  }]);
});

test('findingsFromSarif handles a run with no results', () => {
  assert.deepEqual(findingsFromSarif({ runs: [{}] }, ROOT, readLine), []);
});

test('an accepted finding matches regardless of its line number', () => {
  const findings = [{ rule: 'CS0010', file: 'src/lib/merkle.circom', line: 99, code: ACCEPTED.code, message: 'm' }];
  const { acceptedFindings, unexpected, stale } = compareFindings(findings, [ACCEPTED]);
  assert.equal(acceptedFindings.length, 1);
  assert.equal(acceptedFindings[0].reason, 'depth is always 16');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(stale, []);
});

test('the same rule on different code is a new finding', () => {
  const findings = [{ rule: 'CS0010', file: 'src/operations/Transact.circom', line: 2, code: 'component bits = Num2Bits(254);', message: 'm' }];
  const { acceptedFindings, unexpected, stale } = compareFindings(findings, [ACCEPTED]);
  assert.deepEqual(acceptedFindings, []);
  assert.equal(unexpected.length, 1);
  assert.equal(stale.length, 1, 'the accepted entry matched nothing, so it is stale');
});

test('a different rule on accepted code is a new finding', () => {
  const findings = [{ rule: 'CS0005', file: ACCEPTED.file, line: 2, code: ACCEPTED.code, message: 'm' }];
  const { unexpected } = compareFindings(findings, [ACCEPTED]);
  assert.equal(unexpected.length, 1);
});

test('no findings and no accepted entries is clean', () => {
  assert.deepEqual(compareFindings([], []), { acceptedFindings: [], unexpected: [], stale: [] });
});

test('validateAccepted rejects entries missing a reason', () => {
  assert.throws(() => validateAccepted([{ ...ACCEPTED, reason: '  ' }]), /entry 0 needs a non-empty "reason"/);
  assert.throws(() => validateAccepted({}), /must be an array/);
  assert.deepEqual(validateAccepted([ACCEPTED]), [ACCEPTED]);
});
