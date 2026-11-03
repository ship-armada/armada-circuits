# Armada trusted-setup ceremony

The production proving and verifying keys for Armada's circuits come from a
public multi-party ceremony (Groth16 phase 2 on top of the Hermez perpetual
Powers of Tau). The keys are secure as long as **at least one** contributor
generated their randomness honestly and did not keep it.

This document has three parts:

- [Contributor guide](#contributor-guide): how to take part.
- [Coordinator runbook](#coordinator-runbook): running a ceremony.
- [Verifier guide](#verifier-guide): checking a finished ceremony.

The ceremony repo is `ship-armada/armada-circuits` unless announced otherwise.
For a rehearsal or test ceremony, set `ARMADA_CEREMONY_REPO` (for example
`export ARMADA_CEREMONY_REPO=ship-armada/armada-circuits-ceremony-test`) and every
command below uses that repo.

---

## Contributor guide

### What you need

- Node.js 22 or newer.
- The GitHub CLI (`gh`) 2.48 or newer, logged in (`gh auth login`). The tool uses
  your GitHub account to fork the repo, upload your contribution to a release on
  your fork, and open a pull request.
- About 2 GB of free disk and 30 minutes. Each turn downloads the current key for
  every circuit and uploads your new ones (about 430 MB each way for all 19
  circuits; much less in a rehearsal).
- You do **not** need circom or any other tooling.

### Before the window (once, about 15 minutes)

```bash
git clone https://github.com/ship-armada/armada-circuits.git   # or the announced repo
cd armada-circuits
git checkout <announced tag>          # the tool version the ceremony requires
npm ci                                # installs dependencies and builds the tool
npm run ceremony -- doctor            # checks your machine and runs a practice contribution
```

`doctor` checks Node, `gh`, disk and memory, that your tool version is the one the
ceremony requires, and then makes a practice contribution to a tiny test circuit.
Fix anything marked ✗ before your turn.

### Contributing (any time during the window)

```bash
npm run ceremony -- status        # who holds the turn, how many turns are in
npm run ceremony -- contribute    # claim the turn and contribute
```

Only one person can contribute at a time, because each contribution builds on the
previous one. `contribute` checks first:

- If someone else is contributing, it says who and exits without doing anything.
  Run it again later, or use `npm run ceremony -- contribute --wait` to wait and
  start automatically.
- Otherwise it posts a claim on the queue issue, downloads the current keys,
  contributes, uploads your new keys to a release on your fork, and opens a pull
  request. A claim lapses after 2 hours without a pull request.

Your secret randomness exists only in a separate process that exits when it
finishes; it is never written to disk or printed. snarkjs mixes in 64 bytes of
operating-system randomness, so you don't need to provide any. If you want to add
your own as well, use `contribute --personal-entropy` and type anything; it is not
shown or stored.

When it finishes, the tool prints your contribution hashes, your **attestation
hash**, and a suggested public post. A coordinator accepts your pull request once
its automated check passes, usually within a few hours; then the next person can
start. If the check fails, your turn is released and you can simply run
`contribute` again.

### Public post (needed to count as an outside participant)

Post the suggested text, which includes your attestation hash, from a long-lived
account that is already linked to you or your organisation **outside GitHub** (X,
Mastodon, or a personal or company website), then paste the link as a comment on
your pull request. This lets anyone check that the contribution really came from
you, without having to trust the coordinators. Armada team members are welcome to
post too, but their contributions never count toward the outside quotas.

### After the ceremony

```bash
npm run ceremony -- verify --mine   # confirms your contribution is in every final key
```

### Bring your own tool (optional)

To contribute with your own software (for example plain snarkjs, or your own
implementation), on any machine, air-gapped or not:

```bash
npm run ceremony -- contribute --download-only   # claims the turn and downloads the inputs
# contribute to each <circuit>.zkey with your tool, e.g.:
npx snarkjs zkey contribute <inputs>/1x1.zkey <outputs>/1x1.zkey --name="your name"
# ... one output <circuit>.zkey per input, all in one directory
npm run ceremony -- submit <turn.json> <outputs>
```

`--download-only` prints where the inputs and `turn.json` are. `submit` runs the
same checks as a normal contribution (for example it refuses one secret reused for
several circuits) and opens the pull request as a `byo-tool` contribution. Your
claim still lapses 2 hours after the download; if it does and someone else takes
the turn, `submit` refuses and you download again.

### If something goes wrong

| Message | What to do |
|---|---|
| `@someone is contributing ...` | Wait, or rerun with `--wait`. |
| `this tool is version X, but the ceremony requires Y` | `git checkout` the announced tag and `npm ci`. |
| `turn N was accepted while you were contributing` | Someone else's turn landed first; run `contribute` again. |
| `no URL served <circuit>.zkey ...` | A download failed or did not match its pinned hash; try again later and tell a coordinator if it persists. |
| `the contribution window opens/closed at ...` | Outside the window; check the announcement. |

---

## Coordinator runbook

Coordinators use `npm run coordinator -- <command>` with their own `gh` login.
Commands that change the manifest write `ceremony/manifest.json` (and
`ceremony/participants.json`) locally; commit them on a branch and merge them
through a reviewed pull request. Only contribution PRs change the manifest
automatically.

### Before announcing

Work through the pre-ceremony gates in the ceremony plan (circuit freeze, audit,
phase-1 check, rehearsal). Then, from a checkout of the ceremony repo at the frozen
circuits:

```bash
npm ci
npm run compile                    # all circuits in circuits.json
# place the Hermez power-17 ptau at build/ptau/pot17_final.ptau (CI fetches it the same way)
gh issue create --title "Ceremony queue" --body "Turn claims for the ceremony. Do not edit."   # note the number
npm run coordinator -- init --opens <iso> --closes <iso> --queue-issue <n>
```

`init` builds each circuit's base key, uploads it to the `ceremony-zkeys` release,
and writes the manifest: window, the beacon commitment (the first drand quicknet
round at least 48 hours after close), and the participant policy (default: 10
contributions, 5 outside participants from 3 organisations, 1 bring-your-own-tool
contribution). Options: `--circuits <id,...>` for a subset, `--policy
<contributions,outside,orgs,byo>`, `--beacon-delay-hours <h>`, `--release-tag`,
`--ptau-mirrors` (only for a ptau other than the pinned Hermez file).

Merge the manifest PR, then announce:

```bash
npm run coordinator -- announce --tag ceremony-announce   # prints the commitment and makes a signed tag
git push origin ceremony-announce
```

Post the announcement text publicly too, so the beacon round is committed
somewhere repo admins cannot rewrite.

### During the window

For each contribution PR, once its `contribution-check` has passed:

```bash
npm run coordinator -- accept <pr>
```

`accept` merges only if the check passed for the PR's **current** head commit,
after copying the zkeys to the official release, and then tells the queue the next
contributor may start. It refuses PRs that touch other files, PRs opened after the
window closed, and zkeys that don't match their pinned hashes. If CI is down, use
`accept <pr> --reverify` to run the full check locally instead (in a separate
process with no GitHub credentials).

After accepting, record the contributor in `ceremony/participants.json` (via a
PR): display name, organisation (an unaffiliated person is
`independent:<handle>`), whether they are on the Armada team, and, once you have
checked it, their public post (`url`, `checkedBy`, `checkedAt`).

A failed check frees the turn immediately; close the failed PR when convenient. To
add a circuit mid-ceremony: `npm run coordinator -- add-circuit <id>` (joins from
the next turn). The bring-your-own-tool quota is usually met by a coordinator
following the contributor guide's "Bring your own tool" section.

### After the window

Wait until the committed drand round has been published (see the announcement),
then:

```bash
npm run coordinator -- finalize
```

`finalize` refuses if any participant-policy minimum is unmet. Otherwise it fetches
and verifies the committed drand round, applies it as the final beacon to every
circuit, verifies each final key, exports the verifying keys, uploads them, and
writes the finalized manifest. Merge that PR, then:

```bash
npm run coordinator -- release --tag v1.0.0 --sign-key ~/.ssh/id_ed25519
```

`release` re-checks every artifact against the manifest and creates a **draft**
release with the final keys, verifying keys, `vkeys.json`, r1cs, wasm, the ptau,
manifest, participants, `TRANSCRIPT.md` and a signed `SHA256SUMS`. Review it, have
someone run the verifier guide, then publish it and pin it (IPFS).

If too few people have contributed by the deadline, postpone the window and the
beacon round by public re-announcement **before** the committed round is
published.

---

## Verifier guide

Anyone can check a finished ceremony from its release:

1. Download every release asset; run `sha256sum -c SHA256SUMS`.
2. Check the signature with the coordinator's published SSH key:
   `ssh-keygen -Y verify -f <allowed_signers> -I <coordinator> -n armada-ceremony -s SHA256SUMS.sig < SHA256SUMS`.
3. From the ceremony's circuit tag: `npm ci && npm run compile`, then
   `npm run ceremony -- verify --full`. This needs circom 2.2.3 (prebuilt binaries
   on https://github.com/iden3/circom/releases/tag/v2.2.3) and uses the ptau at
   `build/ptau/pot17_final.ptau`, downloading and hash-checking it if missing. It
   checks, for every circuit:
   - the final key's contribution history matches the manifest, contribution by
     contribution;
   - the compiled r1cs matches the manifest's hash, and `snarkjs zkey verify`
     passes against it and the pinned phase-1 file;
   - the final contribution is the beacon, and its value is exactly the committed
     drand round's randomness, whose signature verifies against drand quicknet's
     public key.
4. Read `TRANSCRIPT.md`: who contributed, how each participant-policy count was
   established, and the public posts you can check yourself.

How the verifying keys get onto the chain, and how to check the registered keys
match, is in `docs/ARMADA_POC_HANDOFF.md`.
