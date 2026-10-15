# Circuit Security Review (2026-07-06, updated 2026-07-27)

## Scope
- `src/operations/Transact.circom` — main circuit (parameterized N,M)
- `src/lib/merkle.circom` — Merkle tree proof verifier
- `src/main/main_NxM.circom` — 19 entry points

> **Trusted setup:** this review covers circuit correctness only. Production
> key provenance (public multi-party ceremony replacing the UNSAFE dev
> setup) is handled separately — see `docs/CEREMONY.md` and armada-poc #406.

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Missing value range checks (potential modular overflow) | **Medium** | **Fixed** (Num2Bits(120), Transact.circom) |
| 2 | No in-circuit duplicate nullifier check (same note spent twice) | **Low** | **Fixed** (pairwise distinct `leavesIndices`, Transact.circom; on-chain check retained) |
| 3 | boundParamsHash not recomputed in-circuit | **Informational** | By design (verified: recomputed on-chain) |
| 4 | No range check on npkOut values | **Low** | Acceptable |
| 5 | Merkle depth hardcoded to 16 | **Informational** | By design |
| 6 | EdDSA signature malleability (S < 2^253, not S < subgroup order l) | **Low** | Accepted (matches reference behavior) |
| 7 | Verification keys are owner-set with no on-chain VK/circuit correspondence check | **Low** | Operational: use multisig/timelock owner |
| 8 | `testingMode` / `VERIFICATION_BYPASS` proof-verification bypasses in verifier contracts | **Critical if enabled** | Testnet-only; MUST be removed before production |

## Findings

### 1. Missing Value Range Checks (Medium)

**Location:** `Transact.circom` lines 113-126

The value conservation constraint uses field arithmetic:
```
sumIn <== accIn;   // sum of valueIn[i]
sumOut <== accOut; // sum of valueOut[j]
sumIn === sumOut;
```

Since circom signals are field elements (mod p, p ≈ 2^254), an attacker could theoretically construct values where `sumIn ≡ sumOut mod p` but `sumIn ≠ sumOut` in the integers. For example, if `sumIn = 100` and `sumOut = p + 100`, both are `100 mod p`.

**Practical risk: LOW.** Input values come from valid on-chain notes created via `shield()`, which enforces max value of ~2^80 (uint80 in Solidity). With N ≤ 8 inputs, `sumIn ≤ 8 × 2^80 ≈ 2^83`, far below p ≈ 2^254. For the overflow to matter, the prover would need output values > 2^254, but the commitment `Poseidon(npkOut, token, valueOut)` is a public signal verified on-chain.

**Recommendation:** Add explicit range checks for defense in depth:
```circom
component valueInRange[N];
for (var i = 0; i < N; i++) {
  valueInRange[i] = Num2Bits(120);  // or appropriate bit width
  valueInRange[i].in <== valueIn[i];
}
```

### 2. No In-Circuit Duplicate Nullifier Check (Low)

**Location:** `Transact.circom` lines 95-99

If the same note (same leafIndex) is provided as two separate inputs, the circuit produces two identical nullifiers: `nullifiers[i] === nullifiers[j]`. The circuit does not enforce distinct nullifiers.

**Mitigation (now layered):**
1. **In-circuit (2026-07-27):** all `leavesIndices` are constrained pairwise distinct via `IsEqual` checks, so a proof that reuses a note cannot be generated at all. Distinct leaf indices imply distinct nullifiers, since `nullifier = Poseidon(nullifyingKey, leafIndex)`.
2. **On-chain:** `TransactModule.sol:328` check-and-marks each nullifier inside the loop, rejecting any duplicate (verified: sequential, so in-transaction and cross-transaction duplicates both revert).

### 3. boundParamsHash Not Recomputed In-Circuit (Informational)

**Location:** `Transact.circom` line 35

`boundParamsHash` is a pass-through public input. The circuit does not verify that it matches the `boundParams` struct. Instead, the on-chain `VerifierModule.verify()` recomputes `hashBoundParams` from the transaction's `boundParams` field.

**Risk:** None — the on-chain check is authoritative (verified: `VerifierModule.hashBoundParams` recomputes `keccak256(abi.encode(boundParams)) % SNARK_SCALAR_FIELD` from the submitted struct; a caller-supplied hash is never accepted).

### 4. No Range Check on npkOut (Low)

**Location:** `Transact.circom` lines 52, 104-111

Output note public keys (`npkOut[j]`) are private witness inputs with no range check. They must be valid BabyJubJub curve points for the output commitment to be meaningful. However, since the commitment `Poseidon(npkOut[j], token, valueOut[j])` is a public signal verified on-chain, a malicious npkOut would produce a commitment that no one can later spend (the recipient's wallet wouldn't recognize it).

**Risk:** None for security. A garbage npkOut just creates a worthless note.

### 5. Merkle Depth Hardcoded (Informational)

**Location:** `Transact.circom` line 85

The Merkle tree depth is hardcoded to 16 (65536 leaves max). This matches the on-chain MerkleModule configuration. Changing the depth would require recompiling all circuits and redeploying verification keys.

### 6. EdDSA Signature Malleability (Low, Accepted)

circomlib's `EdDSAPoseidonVerifier` bounds the scalar `S < 2^253` rather than `S < l` (BabyJubJub subgroup order, ~2^252.6). Given a valid signature `(R8, S)`, anyone can compute the equally-valid `(R8, S + l)` without the private key.

**Risk:** Not exploitable for theft. Malleating the signature does not change any public input — nullifiers are identical, so on-chain replay protection still rejects a second spend. The same property exists in the reference implementation.

### 7. Owner-Set Verification Keys (Low, Operational)

`VerifierModule.setVerificationKey` is owner-only, and the contract cannot verify that an uploaded VK actually corresponds to these circuits. A compromised owner key could register a VK for a malicious circuit and drain the pool.

**Recommendation:** Put the owner behind a multisig and/or timelock before production, and pin expected VK hashes in the deployment checklist (see armada-poc #406).

### 8. Proof-Verification Bypass Switches (Critical if enabled — testnet only)

`VerifierModule.sol` / `Verifier.sol` contain POC-only bypasses that make `verify()` return `true` unconditionally: the `testingMode` flag and `tx.origin == VERIFICATION_BYPASS`. With verification disabled, an attacker can submit an arbitrary `unshieldPreimage` plus its hash as the last commitment and withdraw funds they never deposited — the pool can be drained in one transaction.

**Status:** Tolerated on testnet (user decision, 2026-07-27). **MUST be removed before production** — delete the code paths entirely rather than relying on flag values, and assert their absence in the deployment checklist.

### 9. Merkle Proof Implementation (Verified Correct)

**Location:** `src/lib/merkle.circom`

The Merkle proof verifier uses a standard binary tree construction:
- `Num2Bits(depth)` constrains `pathIndices < 2^depth` (prevents index overflow)
- `deltaLR[i] = bit * (sibling - current)` — single constraint per level
- Hash chaining: `Poseidon(left, right)` from leaf to root

This is the standard shielded-pool Merkle membership construction. Verified correct.

### 10. EdDSA Verification (Verified Correct)

**Location:** `Transact.circom` lines 142-150

Uses circomlib's `EdDSAPoseidonVerifier` — well-audited and standard. The message hash `Poseidon(merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut)` binds all public inputs to the signature.

### 11. Signature Binding to All Public Inputs (Verified Correct)

The EdDSA message hash includes all public signals: `merkleRoot`, `boundParamsHash`, all `nullifiers`, and all `commitmentsOut`. This prevents:
- Merkle root swapping (would invalidate signature)
- Nullifier substitution (would invalidate signature)
- Commitment tampering (would invalidate signature)

## Conclusion

The circuit is sound. All actionable findings from this and the prior review are now addressed: value range checks (Finding 1) and in-circuit input-note distinctness (Finding 2) are enforced in `Transact.circom`; the remaining items are accepted-by-design or operational (trusted-setup ceremony, owner key, bypass removal) and tracked in the production checklist.
