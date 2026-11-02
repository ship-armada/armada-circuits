# Circuit Security Review (2026-07-06, updated 2026-11-02)

## Scope
- `src/operations/Transact.circom` — main circuit (parameterized N,M)
- `src/lib/merkle.circom` — Merkle tree proof verifier
- `src/main/main_NxM.circom` — 19 entry points

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Missing value range checks (potential modular overflow) | **Medium** | **Fixed** (`Num2Bits(120)` on every input and output value, Transact.circom) |
| 2 | No in-circuit duplicate nullifier check (same note spent twice) | **Low** | **Fixed** (pairwise-distinct `leavesIndices`, Transact.circom; on-chain check retained) |
| 3 | boundParamsHash not recomputed in-circuit | **Informational** | By design |
| 4 | No range check on npkOut values | **Low** | Acceptable |
| 5 | Merkle depth hardcoded to 16 | **Informational** | By design |

## Findings

### 1. Missing Value Range Checks (Medium)

**Location:** `Transact.circom` lines 115-143

The value conservation constraint uses field arithmetic:
```
sumIn <== accIn;   // sum of valueIn[i]
sumOut <== accOut; // sum of valueOut[j]
sumIn === sumOut;
```

Since circom signals are field elements (mod p, p ≈ 2^254), an attacker could theoretically construct values where `sumIn ≡ sumOut mod p` but `sumIn ≠ sumOut` in the integers. For example, if `sumIn = 100` and `sumOut = p + 100`, both are `100 mod p`.

**Practical risk: LOW.** Input values come from valid on-chain notes created via `shield()`, which stores note values as `uint120`. With N ≤ 8 inputs, `sumIn ≤ 8 × 2^120 = 2^123`, far below p ≈ 2^254. For the overflow to matter, the prover would need output values > 2^254, but the commitment `Poseidon(npkOut, token, valueOut)` is a public signal verified on-chain.

**Recommendation:** Add explicit range checks for defense in depth:
```circom
component valueInRange[N];
for (var i = 0; i < N; i++) {
  valueInRange[i] = Num2Bits(120);  // or appropriate bit width
  valueInRange[i].in <== valueIn[i];
}
```

**Status: Fixed.** `Transact.circom` step 4 range-checks every `valueIn[i]` and `valueOut[j]` with `Num2Bits(120)`, so the equality `sumIn === sumOut` holds over the integers, not just mod p.

### 2. No In-Circuit Duplicate Nullifier Check (Low)

**Location:** `Transact.circom` lines 98-101 (nullifier derivation); fix in step 4b, lines 145-161

If the same note (same leafIndex) is provided as two separate inputs, the circuit produces two identical nullifiers: `nullifiers[i] === nullifiers[j]`. The circuit does not enforce distinct nullifiers.

The value of that note would then count twice toward `sumIn`, so a proof spending one 100-token note twice could create 200 tokens of outputs. `tests/nullifier-uniqueness-test.js` builds exactly this proof and confirms it verifies without the fix.

**Mitigation (layered):**
1. **In-circuit:** step 4b constrains all `leavesIndices` pairwise distinct with `IsEqual`, so a proof that reuses a note cannot be generated. Distinct leaf indices imply distinct nullifiers, since every input uses the same `nullifyingKey` in `nullifier = Poseidon(nullifyingKey, leafIndex)`, and `MerkleTreeProof` constrains each leaf index to 16 bits, so two different values cannot address the same leaf. Cost: N(N−1)/2 comparisons, 56 constraints for 8x4.
2. **On-chain:** armada-poc `TransactModule._accumulateAndNullify` checks and marks each nullifier inside the same loop, so a duplicate within one transaction reverts ("Note already spent"). This depends on the check and the mark staying in the same loop iteration; the in-circuit check removes that dependency.
3. **SDK:** armada-sdk `planTransfer` selects each note at most once and never pads inputs to fit a shape.

### 3. boundParamsHash Not Recomputed In-Circuit (Informational)

**Location:** `Transact.circom` line 37

`boundParamsHash` is a pass-through public input. The circuit does not verify that it matches the `boundParams` struct. Instead, the on-chain `VerifierModule.verify()` recomputes `hashBoundParams` from the transaction's `boundParams` field.

**Risk:** None — the on-chain check is authoritative. If the prover submits a mismatched hash, the verifier rejects it.

### 4. No Range Check on npkOut (Low)

**Location:** `Transact.circom` lines 54, 104-112

Output note public keys (`npkOut[j]`) are private witness inputs with no range check. They must be valid BabyJubJub curve points for the output commitment to be meaningful. However, since the commitment `Poseidon(npkOut[j], token, valueOut[j])` is a public signal verified on-chain, a malicious npkOut would produce a commitment that no one can later spend (the recipient's wallet wouldn't recognize it).

**Risk:** None for security. A garbage npkOut just creates a worthless note.

### 5. Merkle Depth Hardcoded (Informational)

**Location:** `Transact.circom` line 87

The Merkle tree depth is hardcoded to 16 (65536 leaves max). This matches the on-chain MerkleModule configuration. Changing the depth would require recompiling all circuits and redeploying verification keys.

### 6. Merkle Proof Implementation (Verified Correct)

**Location:** `src/lib/merkle.circom`

The Merkle proof verifier uses a standard binary tree construction:
- `Num2Bits(depth)` constrains `pathIndices < 2^depth` (prevents index overflow)
- `deltaLR[i] = bit * (sibling - current)` — single constraint per level
- Hash chaining: `Poseidon(left, right)` from leaf to root

This is the standard Tornado Cash / Railgun pattern. Verified correct.

### 7. EdDSA Verification (Verified Correct)

**Location:** `Transact.circom` lines 177-185

Uses circomlib's `EdDSAPoseidonVerifier` — well-audited and standard. The message hash `Poseidon(merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut)` binds all public inputs to the signature.

### 8. Signature Binding to All Public Inputs (Verified Correct)

The EdDSA message hash includes all public signals: `merkleRoot`, `boundParamsHash`, all `nullifiers`, and all `commitmentsOut`. This prevents:
- Merkle root swapping (would invalidate signature)
- Nullifier substitution (would invalidate signature)
- Commitment tampering (would invalidate signature)

## Conclusion

The circuit is sound. Findings 1 (value range checks) and 2 (input-note distinctness) are now enforced in `Transact.circom`; the remaining findings are acceptable or by design.
