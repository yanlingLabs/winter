#!/usr/bin/env bash
# Winter Phase 8d (P8d-1/P8d-2) — the body of apple/Winter/project.yml's "Embed runtimes"
# postCompileScript, extracted into its own file so it is unit-testable standalone (project.yml
# just calls this script; see the "Embed winter-core" precedent right before it for the same
# extraction shape — that one stayed inline because it has no logic worth testing on its own,
# this one has a real gate).
#
# What it does, in order:
#   1. Release-only — same skip shape as "Embed winter-core": a Debug build never embeds a
#      runtime (CLAUDE.md's dev/dist split), so a missing binary there is expected, not an error.
#   2. Stages the P8d-1 layout DIRECTLY into the app bundle: `bun run runtimes:stage --out
#      <bundle>/Contents/Resources/runtimes` — the SAME script `stage-runtimes.test.ts` and
#      `bun run runtimes:stage` exercise directly, so there is exactly one place `winter` is ever
#      copied from source into a destination. It writes `winter` and `runtimes/VERSIONS.json`.
#   3. Re-signs ONLY `winter` with the app's own team identity (`--identifier com.winter.runtime
#      --options runtime --timestamp`) — a stable identifier (not bun's own ad-hoc one, which
#      changes every build) so the Keychain ACL survives rebuilds, same reasoning as "Embed
#      winter-core"'s own re-sign.
#   4. (WS-23: the step that verified the vendored `claude` binary is gone with the official leg —
#      nothing under `runtimes/claude-official/` is staged any more.)
#   5. Winter Phase 10a (P10a-4/P10a-5, Task L3, fix round 2): stages `runtimes/ant/ant` from the
#      vendored `vendor/ant/<tag>/ant` (`scripts/fetch-ant.ts`, tag read from the repo-root
#      VERSIONS.json's `ant` pin), computes its sha256 IMMEDIATELY (before signing — the same
#      "pre-sign hash" shape as `winter`'s own `checksums.winterPreSign`) and RECORDS it in ant's
#      OWN record, `runtimes/ant/VERSIONS.json` (`{ schema: 1, tag, checksums: { antPreSign },
#      stagedAt }` — WS-23; it used to ride the claude record as `checksums.ant`), THEN re-signs it
#      with the SAME stable-identifier shape as `winter` above (`--identifier com.winter.ant`) — L1's
#      licence finding (MIT, github.com/anthropics/anthropic-cli) permits Winter to redistribute and
#      re-sign it. FAILS THE
#      BUILD if the vendored file is missing (never a silent skip of an optional runtime the
#      release ships) or if the re-sign doesn't land the expected identifier. release.ts reads the
#      RECORDED pre-sign hash (never a re-hash of the vendor source, and never the post-sign
#      embedded file) to prove the exact file that got signed is the git-committed, pinned one.
#
# Env (Xcode build-setting names, read exactly as project.yml's other postCompileScripts do):
#   BUILT_PRODUCTS_DIR, CONTENTS_FOLDER_PATH, CONFIGURATION, EXPANDED_CODE_SIGN_IDENTITY
#
# Standalone test invocation (scripts/embed-runtimes.test.ts):
#   BUILT_PRODUCTS_DIR=<mkdtemp> CONTENTS_FOLDER_PATH=Winter.app/Contents CONFIGURATION=Release \
#     EXPANDED_CODE_SIGN_IDENTITY=- scripts/embed-runtimes.sh
# — an ad-hoc identity (`-`) is EXPLICITLY ALLOWED here: this is the standalone build-phase proof,
# not the release gate (release.ts's own signing checks require a real Developer ID team identity;
# see its TEAM_ID-pinned `assertSigned`).
# WINTER_STAGE_ANT_PATH is the ant-staging equivalent of WINTER_STAGE_RUNTIME_PATH below — a narrow
# TEST SEAM ONLY, overriding where the `ant` binary is copied from instead of the VERSIONS.json-
# pinned `vendor/ant/<tag>/ant`. A real Release build NEVER sets this.
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

if [ ! -f "${WINTER}" ] || [ ! -f "${DEST}/VERSIONS.json" ]; then
  echo "error: runtimes:stage reported success but ${WINTER} / ${DEST}/VERSIONS.json are missing" >&2
  exit 1
fi

# --- Step 3: re-sign winter with a STABLE identifier (P8d-2) --------------------------------
# A2 (2026-09-22): plus exactly the JIT entitlement (scripts/bun-jit.entitlements). `winter` is a
# bun (JavaScriptCore) binary; under the hardened runtime without allow-jit it runs JIT-less (no
# SharedArrayBuffer, ~5x slower). The entitlement is not part of the designated requirement (identifier + team), so the
# Keychain ACL keyed on com.winter.runtime is unaffected. `ant` (Go, Step 5) needs none.
codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier com.winter.runtime --options runtime --timestamp --entitlements "${SCRIPT_DIR}/bun-jit.entitlements" "${WINTER}"

WINTER_DVV="$(codesign -dvv "${WINTER}" 2>&1 || true)"
if ! echo "${WINTER_DVV}" | grep -q "^Identifier=com.winter.runtime$"; then
  echo "error: winter re-sign did not land the stable identifier com.winter.runtime:" >&2
  echo "${WINTER_DVV}" >&2
  exit 1
fi
WINTER_ENTS="$(codesign -d --entitlements - --xml "${WINTER}" 2>/dev/null || true)"
if ! echo "${WINTER_ENTS}" | grep -q "com.apple.security.cs.allow-jit"; then
  echo "error: winter re-sign did not land the allow-jit entitlement (scripts/bun-jit.entitlements):" >&2
  echo "${WINTER_ENTS}" >&2
  exit 1
fi

# --- Step 5: stage + re-sign ant (Winter Phase 10a, P10a-4/P10a-5, Task L3) ------------------
# The pinned tag lives in the repo-root VERSIONS.json's `ant` entry (scripts/fetch-ant.ts's own
# pin) — read it the same way that script's own CLI entrypoint does, never re-spelled as a literal
# here, so a version bump there is the only edit a bump ever needs.
ANT_TAG="$(cd "${REPO_ROOT}" && bun -e 'const v = JSON.parse(await Bun.file("VERSIONS.json").text()); process.stdout.write(v.ant.tag)')"
ANT_SRC="${WINTER_STAGE_ANT_PATH:-${REPO_ROOT}/vendor/ant/${ANT_TAG}/ant}"
ANT="${DEST}/ant/ant"

if [ ! -f "${ANT_SRC}" ]; then
  echo "error: no vendored ant at ${ANT_SRC} (VERSIONS.json pins ant.tag=${ANT_TAG}) — run \`bun run scripts/fetch-ant.ts\` first" >&2
  exit 1
fi

mkdir -p "$(dirname "${ANT}")"
cp "${ANT_SRC}" "${ANT}"
chmod 755 "${ANT}"

# --- Pre-sign hash (Winter Phase 10a, fix round 2): computed and RECORDED into ant's own
# VERSIONS.json IMMEDIATELY after the copy, BEFORE codesign mutates the file — the exact same
# "hash before signing" shape as `winter`'s own `checksums.winterPreSign` (P8d-2). release.ts reads
# THIS recorded value (never the vendor/ant/<tag>/ant source, and never a re-hash of the post-sign
# embedded file, which can never equal a pre-sign pin) to prove the file that is about to be signed
# below is the git-committed, pinned one — closing the gap where a tampered/swapped staged file,
# re-signed under a legitimate identity, would otherwise pass unnoticed.
ANT_PRESIGN_SHA256="$(shasum -a 256 "${ANT}" | awk '{print $1}')"
ANT_VERSIONS_JSON="${DEST}/ant/VERSIONS.json"
bun -e '
  const [path, tag, sha] = process.argv.slice(1);
  const fs = require("node:fs");
  const record = { schema: 1, tag, checksums: { antPreSign: sha }, stagedAt: new Date().toISOString() };
  fs.writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
' "${ANT_VERSIONS_JSON}" "${ANT_TAG}" "${ANT_PRESIGN_SHA256}"

codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier com.winter.ant --options runtime --timestamp "${ANT}"

ANT_DVV="$(codesign -dvv "${ANT}" 2>&1 || true)"
if ! echo "${ANT_DVV}" | grep -q "^Identifier=com.winter.ant$"; then
  echo "error: ant re-sign did not land the stable identifier com.winter.ant:" >&2
  echo "${ANT_DVV}" >&2
  exit 1
fi

echo "runtimes embedded + verified: winter re-signed (Identifier=com.winter.runtime), ant re-signed (Identifier=com.winter.ant)"
