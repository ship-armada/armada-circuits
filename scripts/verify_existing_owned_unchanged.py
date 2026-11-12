#!/usr/bin/env python3
"""Acceptance probe for clause c3: the three pre-existing owned
Transact shapes (1x1_owned, 1x2_owned, 1x3_owned) keep byte-identical
circuit files and unchanged verifying keys while the owned shape matrix
is filled out to the full 8x4 set.

Diffs the real working tree against the real baseline commit with `git
diff` (no self-reported claim) for: (a) the three shapes' entry files,
and (b) any tracked verifying-key artifact (a zkey, a verification_key.json,
or anything under the real ceremony/ state) naming one of those three
shapes. No such artifacts are committed to this repo today, so (b) is 0
by observation of real repo state, not by construction -- if a future
change committed and then touched one, this would catch it.

Prints exactly one JSON object to stdout; judges nothing itself.

Usage:
  verify_existing_owned_unchanged.py --baseline <commit-sha>
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EXISTING_OWNED_SHAPES = ["1x1_owned", "1x2_owned", "1x3_owned"]
EXISTING_OWNED_FILES = [f"src/main/main_{shape}.circom" for shape in EXISTING_OWNED_SHAPES]

VERIFYING_KEY_MARKERS = ("verification_key", "vkey", ".zkey")


def emit(observations):
    print(json.dumps(observations))


def changed_against_baseline(baseline, path):
    result = subprocess.run(
        ["git", "diff", "--quiet", baseline, "--", path],
        cwd=ROOT,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(f"git diff failed for {path}: exit {result.returncode}")
    return result.returncode == 1


def tracked_verifying_key_paths():
    result = subprocess.run(
        ["git", "ls-files", "--", "*.zkey", "*verification_key*", "*vkey*", "ceremony"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True)
    args = parser.parse_args()

    changed_files = sum(
        1 for path in EXISTING_OWNED_FILES if changed_against_baseline(args.baseline, path)
    )

    relevant_vkey_paths = [
        path
        for path in tracked_verifying_key_paths()
        if any(shape in path for shape in EXISTING_OWNED_SHAPES)
        or any(marker in path for marker in VERIFYING_KEY_MARKERS)
    ]
    changed_verifying_keys = sum(
        1
        for path in relevant_vkey_paths
        if changed_against_baseline(args.baseline, path)
    )

    emit({"changed_files": changed_files, "changed_verifying_keys": changed_verifying_keys})


if __name__ == "__main__":
    sys.exit(main())
