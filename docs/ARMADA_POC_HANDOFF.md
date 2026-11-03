# Handoff to armada-poc: ceremony keys on-chain

How the verifying keys produced by the trusted-setup ceremony get into armada-poc's
`VerifierModule`, and how anyone can check that the keys registered on-chain are
the ceremony's. armada-poc state below was checked at `main` @ `64436c14`
(2026-10-29).

## What the ceremony release provides

`npm run coordinator -- release --tag <tag>` publishes a GitHub release with, for
every circuit `<id>` (`NxM`): `<id>.zkey` (final proving key), `<id>.vkey.json`
(snarkjs verifying key), `<id>.r1cs`, `<id>.wasm`; plus the phase-1 ptau,
`manifest.json`, `participants.json`, `TRANSCRIPT.md`, `vkeys.json`, `SHA256SUMS`
and, when signed, `SHA256SUMS.sig` (`ssh-keygen -Y sign -n armada-ceremony`).

### `vkeys.json`

```jsonc
{
  "version": 1,
  "ceremony": "ship-armada/armada-circuits",     // repo the ceremony ran in
  "beacon": { /* the manifest's beacon block: drand chain hash, round, value, signature */ },
  "circuits": {
    "2x2": {
      "vkey": { /* exactly <id>.vkey.json: snarkjs `zkey export verificationkey` output */ },
      "vkeySha256": "…",                           // sha256 of <id>.vkey.json (also in manifest.json)
      "zkeySha256": "…"                            // sha256 of <id>.zkey (also in manifest.json)
    }
    // … one entry per circuit
  }
}
```

`vkey` uses snarkjs's JSON form: `protocol` (`groth16`), `curve` (`bn128`),
`nPublic`, `vk_alpha_1`, `vk_beta_2`, `vk_gamma_2`, `vk_delta_2` and `IC`
(`nPublic + 1` G1 points), with every coordinate as a decimal string.

## Registering the keys

armada-poc already has the conversion: `formatVKeyForSolidity` in
`lib/artifacts.ts`, used by `scripts/register_missing_vkeys.ts`. Feed it each
`circuits[id].vkey`. Two things to keep as they are:

- G2 points (`beta2`, `gamma2`, `delta2`) have the two halves of each coordinate
  swapped relative to snarkjs's JSON, for the BN254 pairing precompile.
- `artifactsIPFSHash` is currently the placeholder `QmPOC_<N>x<M>`. For the
  ceremony keys it should be the release's IPFS CID (pinning service still to be
  chosen, ceremony plan D20).

## Checking the registered keys (for #406's deployment checklist)

1. Verify the release: `sha256sum -c SHA256SUMS`, and `SHA256SUMS.sig` with the
   coordinator's published SSH key.
2. For every circuit `NxM` in `vkeys.json`: read `PrivacyPool.getVerificationKey(N, M)`
   over RPC, compute `formatVKeyForSolidity(vkeys.circuits["NxM"].vkey, N, M)`,
   and require equality of `alpha1`, `beta2`, `gamma2`, `delta2`, the length of `ic`
   (`nPublic + 1`) and every `ic` point, and `artifactsIPFSHash`. Exit non-zero on
   any mismatch.
3. Require that every shape the pool serves is in the ceremony: list the
   `VerifyingKeySet` events since deployment and check each `(N, M)` is a key of
   `vkeys.json`, so no unexpected shape has a key.
4. Keep watching: because `setVerificationKey` stays changeable through the
   governance timelock (#211, #349), re-run the check on every `VerifyingKeySet`
   event, and on any queued timelock operation that calls `setVerificationKey`,
   before it executes.

Reusing `formatVKeyForSolidity` (rather than re-implementing the conversion) keeps
the check and the registration from drifting apart.

## Items checked in armada-poc

| Item | Status at `64436c14` |
|---|---|
| Owner can replace verifying keys | By design: owner is the governance timelock (#349); `setVerificationKey` stays changeable but timelock-gated (#211); each change emits `VerifyingKeySet`. The check above covers it. |
| `testingMode` and `VERIFICATION_BYPASS` (`tx.origin == 0x…dEaD`) | Removed in PR #639 (#633). An unused `testingMode` storage slot remains. |
| Public inputs range-checked below the field | Yes: `SnarkTypes.sol:39`; the bound-params hash is reduced mod the field (`PrivacyPool.sol:531`). |
| Proof bytes used as identifiers | No: the proof is only passed to the verifier. |
| Same note spent twice | Rejected by the check-and-mark loop in `TransactModule._accumulateAndNullify`. Tested within one transaction and across two `transact()` calls (`test/privacy_pool_adversarial.ts:590`); **not yet tested for two transactions in one batch** (draft issue below). Since armada-circuits #5 the circuit also rejects the same note twice within one proof. |
| `uint120` truncation of amounts | The `crossChainShield` cast is gone (#610); the remaining `ShieldModule` casts take values already below 2^120. |

## Drafts (not filed)

### Issue: test a note spent twice within one `transact()` batch

> **Title:** Test: two transactions in one `transact()` batch spending the same note must revert
>
> `TransactModule._accumulateAndNullify` checks and marks each nullifier in the
> same loop iteration, and `transact()` nullifies each transaction before
> checking the next. That ordering is what rejects two different proofs in one
> batch that spend the same note. It is correct today but untested: the
> adversarial tests cover a duplicate within one transaction and across two
> `transact()` calls, not across two transactions in one call. A refactor to
> "check every nullifier, then mark them all" would make that case a double
> spend while the existing tests still pass.
>
> - [ ] Add a test: `transact([tx1, tx2])` where both spend the same nullifier
>       reverts with `TransactModule: Note already spent`.
> - [ ] Comment in `_accumulateAndNullify` / `transact()` that check-then-mark
>       per transaction is a security property.
>
> Severity: Low (latent). Since armada-circuits #5, one proof can no longer use
> a note twice, so the cross-transaction case is the one left to the contract.

### Comment on #406

> The ceremony release will include `vkeys.json` (one snarkjs verifying key per
> circuit, with its sha256 and the final zkey's sha256) alongside the per-circuit
> keys, `SHA256SUMS` and a signed `SHA256SUMS.sig`. armada-circuits
> `docs/ARMADA_POC_HANDOFF.md` specifies the format and a VK check for this
> issue's "register the ceremony vkeys" step: compare
> `PrivacyPool.getVerificationKey(N, M)` with `formatVKeyForSolidity(vkey, N, M)`
> for every shape, confirm every `VerifyingKeySet` shape is in the ceremony, and
> re-run it on each `VerifyingKeySet` event or queued timelock call. The
> `artifactsIPFSHash` placeholder (`QmPOC_NxM`) should become the release's IPFS
> CID.
