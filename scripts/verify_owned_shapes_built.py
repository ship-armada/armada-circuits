#!/usr/bin/env python3
"""Acceptance probe for the full 8x4 owned Transact shape matrix
(32 shapes, N 1-8 nullifiers by M 1-4 commitments) builds, and any shape
that would exceed the ceremony's pinned powers-of-tau size is reported
with its measured constraint count rather than silently built past a
setup the ceremony can't actually cover.

Drives the real scripts/compile.sh against the real circom2 compiler (no
mock compiler, no pre-computed shape list) and, for --limit-report,
independently re-measures each owned shape's constraint count from its
compiled .r1cs via the real `snarkjs r1cs info` — it does not trust
scripts/compile.sh's own self-reported numbers, only cross-checks that
build/owned_shapes_over_limit.json (which compile.sh writes from its own
measurement) agrees with that independent measurement for every shape
that is actually over the limit.

Prints exactly one JSON object to stdout per mode; judges nothing itself
beyond computing the named observations.

Usage:
  verify_owned_shapes_built.py
  verify_owned_shapes_built.py --limit-report
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
OVER_LIMIT_REPORT = BUILD_DIR / "owned_shapes_over_limit.json"

EXPECTED_SHAPES = [f"{n}x{m}_owned" for n in range(1, 9) for m in range(1, 5)]

# Must match scripts/compile.sh's OWNED_HARD_LIMIT_CONSTRAINTS, which in turn
# must match the pinned ptau's power (scripts/ceremony/lib.sh PTAU_POWER=17,
# scripts/setup-dev.sh POT_POWER=17).
OWNED_HARD_LIMIT_CONSTRAINTS = 131072


def emit(observations):
    print(json.dumps(observations))


def ensure_build():
    env = dict(os.environ)
    env["CIRCOM_BIN"] = str(ROOT / "node_modules" / ".bin" / "circom2")
    subprocess.run(["bash", "scripts/compile.sh"], cwd=ROOT, env=env, check=True, stdout=sys.stderr)


def shape_artifacts(shape):
    outdir = BUILD_DIR / shape
    r1cs = outdir / f"main_{shape}.r1cs"
    wasm = outdir / f"main_{shape}_js" / f"main_{shape}.wasm"
    return r1cs, wasm


def measure_constraints(r1cs_path):
    result = subprocess.run(
        ["npx", "--no-install", "snarkjs", "r1cs", "info", str(r1cs_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    match = re.search(r"# of Constraints:\s*(\d+)", result.stdout + result.stderr)
    if not match:
        raise RuntimeError(f"could not parse constraint count for {r1cs_path}")
    return int(match.group(1))


def mode_built(_args):
    ensure_build()
    present = 0
    missing = 0
    for shape in EXPECTED_SHAPES:
        r1cs, wasm = shape_artifacts(shape)
        if r1cs.exists() and wasm.exists():
            present += 1
        else:
            missing += 1
    emit({"owned_build_dirs": present, "missing_shapes": missing})


def mode_limit_report(_args):
    ensure_build()
    report = json.loads(OVER_LIMIT_REPORT.read_text()) if OVER_LIMIT_REPORT.exists() else []
    reported_by_shape = {entry["shape"]: entry["constraints"] for entry in report}

    without_report = 0
    for shape in EXPECTED_SHAPES:
        r1cs, _wasm = shape_artifacts(shape)
        measured = measure_constraints(r1cs)
        if measured > OWNED_HARD_LIMIT_CONSTRAINTS:
            if reported_by_shape.get(shape) != measured:
                without_report += 1

    emit({"over_limit_without_constraint_count": without_report})


MODES = {
    "": mode_built,
    "--limit-report": mode_limit_report,
}


def main():
    mode_key = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode_key not in MODES:
        print(f"usage: {sys.argv[0]} [--limit-report]", file=sys.stderr)
        sys.exit(2)
    MODES[mode_key](sys.argv[2:])


if __name__ == "__main__":
    main()
