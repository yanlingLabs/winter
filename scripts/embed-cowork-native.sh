#!/usr/bin/env bash
# The body of the "Embed Cowork native pair" build phase that S7 adds to apple/Winter/project.yml, in its own file so it is tested
# standalone (scripts/embed-cowork-native.test.ts), like embed-computer-helper.sh beside it. NOTHING CALLS THIS YET: project.yml and
# release.ts are S7's, and a test pins that they do not reference it.
#
# The Cowork native pair is two nested tools the DAEMON spawns itself (never through LaunchServices):
#
#   Winter.app/Contents/Helpers/WinterCowork/winter-cowork-launcher   Swift, no entitlements
#   Winter.app/Contents/Helpers/WinterCowork/winter-cowork-worker     C + libkrun, exactly one entitlement: com.apple.security.hypervisor
#
# What this does, Release only (a Debug Winter.app embeds neither; the owner's dev flow signs a dev pair separately):
#   1. Refuse an input that is not what ships: a missing file; a binary that contains a test hook (WINTER_COWORK_TEST_…, which the
#      launcher compiles in only under -DWINTER_COWORK_TEST_BUILD); a binary that links anything but platform dylibs (/usr/lib,
#      /System/Library); a binary that names the builder's repository or home (the release name scan would reject it anyway); a
#      worker entitlements file that is not exactly the hypervisor key set to true.
#   2. ditto both into Contents/Helpers/WinterCowork (the old directory is removed first, so nothing lingers).
#   3. Sign the WORKER first, then the LAUNCHER (nested code, each with its OWN identity — never `--deep`, which would give one the
#      other's identifier): the app's identity, the hardened runtime, a secure timestamp, the stable identifier and a STATED designated
#      requirement (identifier + Winter's team under Apple's anchor). The launcher compiles the worker's requirement and checks the
#      executed worker image against it before resuming it, so the string stated here is the one the launcher enforces.
#   4. Check the signatures took: recorded requirement == stated, identifier, hardened runtime, entitlements (worker: exactly the
#      hypervisor key; launcher: none).
#
# Env (Xcode's, as in embed-computer-helper.sh): BUILT_PRODUCTS_DIR, CONTENTS_FOLDER_PATH, CONFIGURATION,
# EXPANDED_CODE_SIGN_IDENTITY, DEVELOPMENT_TEAM. Inputs (default under dist/cowork-native/, S7's build step puts them there):
# COWORK_LAUNCHER_BINARY, COWORK_WORKER_BINARY, COWORK_WORKER_ENTITLEMENTS (S3's apple/Cowork/WinterCoworkHVFWorker/worker.entitlements).
#
# Standalone (the test): an ad-hoc identity (`-`) is allowed — this proves the build phase, not the release gate (release.ts checks the
# Developer ID team, the timestamp and that the stated requirement is satisfied). The test never uses a real identity.
set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
  echo "skip Cowork native embed (non-Release)"
  exit 0
fi

TEAM="${DEVELOPMENT_TEAM:-37N77U9RSZ}"
LAUNCHER_NAME="winter-cowork-launcher"
LAUNCHER_ID="com.winter.cowork.launcher"
WORKER_NAME="winter-cowork-worker"
WORKER_ID="com.winter.cowork.worker"
ENTITLEMENT="com.apple.security.hypervisor"
TEST_MARKER="WINTER_COWORK_TEST_"
requirement() { printf 'identifier "%s" and anchor apple generic and certificate leaf[subject.OU] = "%s"' "$1" "${TEAM}"; }
LAUNCHER_REQ="$(requirement "${LAUNCHER_ID}")"
WORKER_REQ="$(requirement "${WORKER_ID}")"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER_SRC="${COWORK_LAUNCHER_BINARY:-${REPO}/dist/cowork-native/${LAUNCHER_NAME}}"
WORKER_SRC="${COWORK_WORKER_BINARY:-${REPO}/dist/cowork-native/${WORKER_NAME}}"
ENTITLEMENTS_FILE="${COWORK_WORKER_ENTITLEMENTS:-${REPO}/apple/Cowork/WinterCoworkHVFWorker/worker.entitlements}"
DEST_DIR="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Helpers/WinterCowork"

fail() { echo "error: $*" >&2; exit 1; }

check_input() { # $1 = path, $2 = name
  local path="$1" name="$2"
  [ -f "${path}" ] || fail "the built ${name} is not at ${path} — run the Cowork native build first"
  file "${path}" | grep -q "Mach-O" || fail "${name} (${path}) is not a Mach-O executable"
  if LC_ALL=C grep -aq "${TEST_MARKER}" "${path}"; then
    fail "${name} contains test hooks (${TEST_MARKER}…): they compile in only under -DWINTER_COWORK_TEST_BUILD and must never ship"
  fi
  local foreign
  foreign="$(otool -L "${path}" | tail -n +2 | awk '{print $1}' | grep -v -e '^/usr/lib/' -e '^/System/Library/' || true)"
  [ -z "${foreign}" ] || fail "${name} links non-platform libraries: ${foreign//$'\n'/, }"
  # The release name scan rejects absolute builder paths in a Mach-O; refuse them here with a name for the culprit.
  if LC_ALL=C grep -aqF "${REPO}" "${path}" || { [ -n "${HOME:-}" ] && [ "${HOME}" != "/" ] && LC_ALL=C grep -aqF "${HOME}/" "${path}"; }; then
    fail "${name} embeds the builder's repository or home path — build with the path remaps and strip"
  fi
}
check_input "${LAUNCHER_SRC}" "${LAUNCHER_NAME}"
check_input "${WORKER_SRC}" "${WORKER_NAME}"

[ -f "${ENTITLEMENTS_FILE}" ] || fail "the worker entitlements file is not at ${ENTITLEMENTS_FILE}"
KEYS="$({ grep -o "<key>[^<]*</key>" "${ENTITLEMENTS_FILE}" || true; } | sort -u | tr -d '\n')"
[ "${KEYS}" = "<key>${ENTITLEMENT}</key>" ] || fail "the worker entitlements file must contain exactly ${ENTITLEMENT} (no allow-jit, no disable-library-validation, no debugger entitlement, no networking): ${KEYS}"
tr -d '[:space:]' < "${ENTITLEMENTS_FILE}" | grep -q "<key>${ENTITLEMENT}</key><true/>" || fail "${ENTITLEMENT} must be set to true in ${ENTITLEMENTS_FILE}"

rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"
ditto "${WORKER_SRC}" "${DEST_DIR}/${WORKER_NAME}"
ditto "${LAUNCHER_SRC}" "${DEST_DIR}/${LAUNCHER_NAME}"

sign_and_check() { # $1 = name, $2 = identifier, $3 = requirement, $4 = entitlements file ("" for none)
  local name="$1" id="$2" req="$3" entitlements="$4" dest="${DEST_DIR}/$1"
  if [ -n "${entitlements}" ]; then
    codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier "${id}" --options runtime --timestamp \
      --entitlements "${entitlements}" "-r=designated => ${req}" "${dest}"
  else
    codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier "${id}" --options runtime --timestamp \
      "-r=designated => ${req}" "${dest}"
  fi
  local recorded dvv ents keys
  recorded="$(codesign -d -r- "${dest}" 2>&1 | sed -n 's/^designated => //p')"
  if [ "${recorded}" != "${req}" ]; then
    echo "error: ${name}'s designated requirement did not take:" >&2
    echo "  stated:   ${req}" >&2
    echo "  recorded: ${recorded}" >&2
    exit 1
  fi
  dvv="$(codesign -dvv "${dest}" 2>&1 || true)"
  echo "${dvv}" | grep -q "^Identifier=${id}$" || { echo "${dvv}" >&2; fail "${name} is not signed as ${id}"; }
  echo "${dvv}" | grep -Eq "^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime" || { echo "${dvv}" >&2; fail "${name} is not signed with the hardened runtime"; }
  ents="$(codesign -d --entitlements - --xml "${dest}" 2>/dev/null || true)"
  keys="$(echo "${ents}" | { grep -o "<key>[^<]*</key>" || true; } | sort -u | tr -d '\n')"
  if [ -n "${entitlements}" ]; then
    [ "${keys}" = "<key>${ENTITLEMENT}</key>" ] || { echo "${ents}" >&2; fail "${name}'s entitlements must be exactly ${ENTITLEMENT}"; }
  else
    [ -z "${keys}" ] || { echo "${ents}" >&2; fail "${name} must carry no entitlements"; }
  fi
}

# Nested code before anything that contains it, each with its own identity, never --deep. The worker first: the launcher's whole job
# is to check it.
sign_and_check "${WORKER_NAME}" "${WORKER_ID}" "${WORKER_REQ}" "${ENTITLEMENTS_FILE}"
sign_and_check "${LAUNCHER_NAME}" "${LAUNCHER_ID}" "${LAUNCHER_REQ}" ""

echo "Cowork native pair embedded at Contents/Helpers/WinterCowork and signed (${WORKER_NAME} as ${WORKER_ID} with the hypervisor entitlement only; ${LAUNCHER_NAME} as ${LAUNCHER_ID} with none; stated designated requirements, hardened runtime)"
