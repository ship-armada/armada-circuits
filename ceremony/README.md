# Ceremony state

This directory tracks the **production trusted-setup ceremony** for the
Armada circuits (see `docs/CEREMONY.md`).

- `manifest.json` — ceremony state of record (created by
  `scripts/ceremony/init.sh`, updated via PRs).
- `<shape>/NNNN-<handle>.md` — contributor attestation files.

Zkeys, ptau files, and the `.cache/` download dir are gitignored on
purpose — binaries travel via release assets and contributor self-hosting,
always pinned by sha256 in the manifest.

⚠️ Until the ceremony completes and the `v1.0.0` release is cut, the only
published artifacts remain the UNSAFE `v0.1.0-dev` set (testnet only).
