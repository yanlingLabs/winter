#!/usr/bin/env bash
# The body of apple/Winter/project.yml's "Embed Winter Computer Use" postCompileScript, in its own file so it
# is tested standalone (scripts/embed-computer-helper.test.ts), like embed-runtimes.sh beside it.
#
# Winter Computer Use is the signed helper app that holds its own Accessibility and Screen Recording grants
# for ComputerV2. The daemon launches it through LaunchServices (never as a child, or TCC would check the
# daemon's grants), so it ships as a whole .app inside Winter.app:
#
#   Winter.app/Contents/Helpers/Winter Computer Use.app
#
# What this does, Release only (a Debug Winter.app embeds no helper; dev uses `bun run dev:helper`):
#   1. ditto the built helper from BUILT_PRODUCTS_DIR into Contents/Helpers.
#   2. Re-sign it with the app's identity, the hardened runtime, a secure timestamp, EXACTLY ONE entitlement
#      (com.apple.security.automation.apple-events, from apple/ComputerUse/WinterComputerUse/Support — applescript() sends
#      Apple Events, which the hardened runtime refuses without it), the
#      stable identifier com.winter.computeruse and a STATED designated requirement (identifier + Winter's
#      team under Apple's anchor). The requirement is what TCC keys the user's grants on, so it must not
#      change between releases: the one Xcode derives names the signing certificate's common name. It is
#      stated here rather than through OTHER_CODE_SIGN_FLAGS because release.ts overrides that setting on
#      its xcodebuild command line for every target.
#   0. Refuse a helper whose CFBundleShortVersionString is not its own version, apple/ComputerUse/VERSION
#      (independent of Winter's; stamped by version:sync — see scripts/computer-helper-lib.ts).
#   3. Check the signature took: the recorded requirement is exactly the stated one, the identifier is
#      right, the hardened runtime flag is set, and the entitlements are exactly that one.
#
# Env (Xcode's, read like project.yml's other postCompileScripts): BUILT_PRODUCTS_DIR, CONTENTS_FOLDER_PATH,
# CONFIGURATION, EXPANDED_CODE_SIGN_IDENTITY, DEVELOPMENT_TEAM.
#
# Standalone (the test): an ad-hoc identity (`-`) is allowed — this proves the build phase, not the release
# gate (release.ts checks the Developer ID team, the timestamp and that the requirement is satisfied).
set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
  echo "skip Winter Computer Use embed (non-Release)"
  exit 0
fi

NAME="Winter Computer Use"
IDENTIFIER="com.winter.computeruse"
TEAM="${DEVELOPMENT_TEAM:-37N77U9RSZ}"
REQUIREMENT="identifier \"${IDENTIFIER}\" and anchor apple generic and certificate leaf[subject.OU] = \"${TEAM}\""
ENTITLEMENT="com.apple.security.automation.apple-events"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTITLEMENTS_FILE="${REPO}/apple/ComputerUse/WinterComputerUse/Support/WinterComputerUse.entitlements"
HELPER_VERSION="$(tr -d '[:space:]' < "${REPO}/apple/ComputerUse/VERSION")"
SRC="${BUILT_PRODUCTS_DIR}/${NAME}.app"
DEST_DIR="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Helpers"
DEST="${DEST_DIR}/${NAME}.app"

if [ ! -d "${SRC}" ]; then
  echo "error: the built helper is not at ${SRC} — is the WinterComputerUse target in this build?" >&2
  exit 1
fi
BUILT_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${SRC}/Contents/Info.plist" 2>/dev/null || true)"
if [ "${BUILT_ID}" != "${IDENTIFIER}" ]; then
  echo "error: the built helper's bundle id is '${BUILT_ID}', not ${IDENTIFIER} — a Release Winter.app embeds only the dist helper" >&2
  exit 1
fi
BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${SRC}/Contents/Info.plist" 2>/dev/null || true)"
if [ "${BUILT_VERSION}" != "${HELPER_VERSION}" ]; then
  echo "error: the built helper is version '${BUILT_VERSION}', but apple/ComputerUse/VERSION says ${HELPER_VERSION} — run \`bun run version:sync\` (it stamps the helper's own version into project.yml and its Info.plist) and rebuild" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
# rm first: ditto merges into an existing bundle, so a file dropped from the helper would otherwise linger.
rm -rf "${DEST}"
ditto "${SRC}" "${DEST}"

codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier "${IDENTIFIER}" --options runtime --timestamp \
  --entitlements "${ENTITLEMENTS_FILE}" "-r=designated => ${REQUIREMENT}" "${DEST}"

RECORDED="$(codesign -d -r- "${DEST}" 2>&1 | sed -n 's/^designated => //p')"
if [ "${RECORDED}" != "${REQUIREMENT}" ]; then
  echo "error: the helper's designated requirement did not take:" >&2
  echo "  stated:   ${REQUIREMENT}" >&2
  echo "  recorded: ${RECORDED}" >&2
  exit 1
fi
DVV="$(codesign -dvv "${DEST}" 2>&1 || true)"
if ! echo "${DVV}" | grep -q "^Identifier=${IDENTIFIER}$"; then
  echo "error: the helper re-sign did not land the identifier ${IDENTIFIER}:" >&2
  echo "${DVV}" >&2
  exit 1
fi
if ! echo "${DVV}" | grep -Eq "^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime"; then
  echo "error: the helper is not signed with the hardened runtime:" >&2
  echo "${DVV}" >&2
  exit 1
fi
ENTS="$(codesign -d --entitlements - --xml "${DEST}" 2>/dev/null || true)"
KEYS="$(echo "${ENTS}" | grep -o "<key>[^<]*</key>" | sort -u | tr -d '\n')"
if [ "${KEYS}" != "<key>${ENTITLEMENT}</key>" ]; then
  echo "error: the helper's entitlements must be exactly ${ENTITLEMENT}:" >&2
  echo "${ENTS}" >&2
  exit 1
fi

echo "Winter Computer Use embedded at Contents/Helpers and signed (Identifier=${IDENTIFIER}, stated designated requirement, hardened runtime, the Apple Events entitlement only)"
