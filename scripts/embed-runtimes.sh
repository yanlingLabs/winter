#!/usr/bin/env bash
# Winter Phase 8d (P8d-1/P8d-2) — the body of apple/Winter/project.yml's "Embed runtimes"
# postCompileScript, extracted into its own file so it is unit-testable standalone (project.yml
# just calls this script; see the "Embed winter-core" precedent right before it for the same
# extraction shape — that one stayed inline because it has no logic worth testing on its own,
# this one has a real gate).
#
# What it does, in order:
#   1. Release-only — same skip shape as "Embed winter-core": a Debug build never embeds either
#      runtime (CLAUDE.md's dev/dist split), so a missing binary there is expected, not an error.
#   2. Stages the P8d-1 layout DIRECTLY into the app bundle: `bun run runtimes:stage --out
#      <bundle>/Contents/Resources/runtimes` — the SAME script `stage-runtimes.test.ts` and
#      `bun run runtimes:stage` exercise directly, so there is exactly one place either binary is
#      ever copied from source into a destination.
#   3. Re-signs ONLY `winter` with the app's own team identity (`--identifier com.winter.runtime
#      --options runtime --timestamp`) — a stable identifier (not bun's own ad-hoc one, which
#      changes every build) so the Keychain ACL survives rebuilds, same reasoning as "Embed
#      winter-core"'s own re-sign.
#   4. VERIFIES (never re-signs — P8d-2) the vendored `claude` binary is exactly the pinned,
#      Anthropic-signed artifact: `codesign --verify --strict`, plus a `codesign -dvv` grep for
#      `TeamIdentifier=Q6L2SF6YDW` and `runtime` in the flags. FAILS THE BUILD on any mismatch —
#      this is the earliest point a re-signed, corrupted, or wrong-pin `claude` can be caught,
#      before it ever reaches release.ts's own (necessarily late) gate.
#
# Env (Xcode build-setting names, read exactly as project.yml's other postCompileScripts do):
#   BUILT_PRODUCTS_DIR, CONTENTS_FOLDER_PATH, CONFIGURATION, EXPANDED_CODE_SIGN_IDENTITY
#
# Standalone test invocation (scripts/embed-runtimes.test.ts):
#   BUILT_PRODUCTS_DIR=<mkdtemp> CONTENTS_FOLDER_PATH=Winter.app/Contents CONFIGURATION=Release \
#     EXPANDED_CODE_SIGN_IDENTITY=- scripts/embed-runtimes.sh
# — an ad-hoc identity (`-`) is EXPLICITLY ALLOWED here: this is the standalone build-phase proof,
# not the release gate (release.ts's own signing checks require a real Developer ID team identity;
# see its TEAM_ID-pinned `assertSigned`). The claude-verify step (4) runs against whatever the
# REAL platform package resolves to on this machine — it is skipped, with a printed reason, when
# that optional package is not installed, UNLESS WINTER_CLAUDE_REQUIRE_RUNTIME=1 is set, in which
# case a missing package is a hard failure (the same CI-honesty shape
# `test/helpers/claude-runtime.ts` already uses for the official-leg test suite).
set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
  echo "skip runtimes embed (non-Release)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources/runtimes"

# --- Step 2: stage --------------------------------------------------------------------------
# WINTER_STAGE_RUNTIME_PATH is a narrow TEST SEAM ONLY (embed-runtimes.test.ts) — it forwards
# `--winter <path>` so the standalone proof reuses the pinned `dist/winter` instead of paying for
# a fresh buildWinter() SDK-checkout build on every test run. A real Release build NEVER sets
# this: project.yml's postCompileScript invocation always rebuilds winter fresh from the pinned
# tag, exactly like `bun run build:winter` does on its own.
STAGE_ARGS=(--out "${DEST}")
if [ -n "${WINTER_STAGE_RUNTIME_PATH:-}" ]; then
  STAGE_ARGS+=(--winter "${WINTER_STAGE_RUNTIME_PATH}")
fi
( cd "${REPO_ROOT}" && bun run runtimes:stage "${STAGE_ARGS[@]}" )

WINTER="${DEST}/winter"
CLAUDE="${DEST}/claude-official/claude"

if [ ! -f "${WINTER}" ] || [ ! -f "${CLAUDE}" ]; then
  echo "error: runtimes:stage reported success but ${WINTER} / ${CLAUDE} are missing" >&2
  exit 1
fi

# --- Step 3: re-sign winter with a STABLE identifier (P8d-2) --------------------------------
codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier com.winter.runtime --options runtime --timestamp "${WINTER}"

WINTER_DVV="$(codesign -dvv "${WINTER}" 2>&1 || true)"
if ! echo "${WINTER_DVV}" | grep -q "^Identifier=com.winter.runtime$"; then
  echo "error: winter re-sign did not land the stable identifier com.winter.runtime:" >&2
  echo "${WINTER_DVV}" >&2
  exit 1
fi

# --- Step 4: VERIFY (never re-sign) the vendored claude — P8d-2 ------------------------------
if ! codesign --verify --strict "${CLAUDE}"; then
  echo "error: codesign --verify --strict failed on the embedded claude binary at ${CLAUDE} — it is not a valid, untampered Developer ID signature" >&2
  exit 1
fi

CLAUDE_DVV="$(codesign -dvv "${CLAUDE}" 2>&1 || true)"
if ! echo "${CLAUDE_DVV}" | grep -q "TeamIdentifier=Q6L2SF6YDW"; then
  echo "error: embedded claude at ${CLAUDE} is not signed by TeamIdentifier=Q6L2SF6YDW (Anthropic PBC):" >&2
  echo "${CLAUDE_DVV}" >&2
  exit 1
fi
if ! echo "${CLAUDE_DVV}" | grep -q "flags=.*runtime"; then
  echo "error: embedded claude at ${CLAUDE} does not carry the hardened-runtime flag:" >&2
  echo "${CLAUDE_DVV}" >&2
  exit 1
fi

echo "runtimes embedded + verified: winter re-signed (Identifier=com.winter.runtime), claude verified untouched (TeamIdentifier=Q6L2SF6YDW, hardened runtime)"
