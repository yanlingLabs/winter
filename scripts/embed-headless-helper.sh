#!/usr/bin/env bash
# The body of apple/Winter/project.yml's "Embed Winter Headless" postCompileScript, in its own file so it is tested
# standalone (scripts/embed-headless-helper.test.ts), like embed-computer-helper.sh beside it.
#
# Winter Headless is Winter's private, invisible browser for the agent's background reading: a background-only app
# running windowless CEF browsers, which the daemon spawns directly over a pipe. It carries no Chromium of its own —
# nested at
#
#   Winter.app/Contents/Helpers/Winter Headless.app
#
# it loads Winter.app's own Contents/Frameworks/Chromium Embedded Framework.framework and runs Winter.app's
# "Winter Helper" bundles as its subprocesses.
#
# What this does, Release only (a Debug Winter.app embeds no helper; dev uses `bun run dev:headless`):
#   0. Refuse a built helper that is not the dist one (its bundle id) or that carries its own Contents/Frameworks (a
#      self-contained dev build has no place in a release — it would ship a second Chromium).
#   1. ditto the built helper from BUILT_PRODUCTS_DIR into Contents/Helpers.
#   2. Re-sign it with the app's identity, the hardened runtime, a secure timestamp, NO entitlements, the stable
#      identifier com.winter.headless and a STATED designated requirement (identifier + Winter's team under Apple's
#      anchor) — the requirement the daemon checks before it spawns the helper. Stated here rather than through
#      OTHER_CODE_SIGN_FLAGS because release.ts overrides that setting on its xcodebuild command line for every target.
#      The helper has no nested code of its own, so there is nothing to sign before it (and never a --deep re-sign).
#   3. Check the signature took: the recorded requirement is exactly the stated one, the identifier is right, the
#      hardened runtime flag is set, and there are no entitlements.
#
# Env (Xcode's, read like project.yml's other postCompileScripts): BUILT_PRODUCTS_DIR, CONTENTS_FOLDER_PATH,
# CONFIGURATION, EXPANDED_CODE_SIGN_IDENTITY, DEVELOPMENT_TEAM.
#
# Standalone (the test): an ad-hoc identity (`-`) is allowed — this proves the build phase, not the release gate
# (release.ts checks the Developer ID team, the timestamp and that the requirement is satisfied).
set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
  echo "skip Winter Headless embed (non-Release)"
  exit 0
fi

NAME="Winter Headless"
IDENTIFIER="com.winter.headless"
TEAM="${DEVELOPMENT_TEAM:-37N77U9RSZ}"
REQUIREMENT="identifier \"${IDENTIFIER}\" and anchor apple generic and certificate leaf[subject.OU] = \"${TEAM}\""
SRC="${BUILT_PRODUCTS_DIR}/${NAME}.app"
DEST_DIR="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Helpers"
DEST="${DEST_DIR}/${NAME}.app"

if [ ! -d "${SRC}" ]; then
  echo "error: the built helper is not at ${SRC} — is the WinterHeadless target in this build?" >&2
  exit 1
fi
BUILT_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${SRC}/Contents/Info.plist" 2>/dev/null || true)"
if [ "${BUILT_ID}" != "${IDENTIFIER}" ]; then
  echo "error: the built helper's bundle id is '${BUILT_ID}', not ${IDENTIFIER} — a Release Winter.app embeds only the dist helper" >&2
  exit 1
fi
BACKGROUND_ONLY="$(/usr/libexec/PlistBuddy -c 'Print :LSBackgroundOnly' "${SRC}/Contents/Info.plist" 2>/dev/null || true)"
if [ "${BACKGROUND_ONLY}" != "true" ]; then
  echo "error: the built helper is not LSBackgroundOnly — it must never have a Dock tile or a menu bar" >&2
  exit 1
fi
if [ -e "${SRC}/Contents/Frameworks" ]; then
  echo "error: the built helper carries its own Contents/Frameworks (a self-contained dev build) — a release embeds the one that borrows Winter.app's Chromium" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
# rm first: ditto merges into an existing bundle, so a file dropped from the helper would otherwise linger.
rm -rf "${DEST}"
ditto "${SRC}" "${DEST}"

codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier "${IDENTIFIER}" --options runtime --timestamp \
  "-r=designated => ${REQUIREMENT}" "${DEST}"

RECORDED="$(codesign -d -r- "${DEST}" 2>&1 | sed -n 's/^designated => //p')"
if [ "${RECORDED}" != "${REQUIREMENT}" ]; then
  echo "error: the headless helper's designated requirement did not take:" >&2
  echo "  stated:   ${REQUIREMENT}" >&2
  echo "  recorded: ${RECORDED}" >&2
  exit 1
fi
DVV="$(codesign -dvv "${DEST}" 2>&1 || true)"
if ! echo "${DVV}" | grep -q "^Identifier=${IDENTIFIER}$"; then
  echo "error: the headless helper re-sign did not land the identifier ${IDENTIFIER}:" >&2
  echo "${DVV}" >&2
  exit 1
fi
if ! echo "${DVV}" | grep -Eq "^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime"; then
  echo "error: the headless helper is not signed with the hardened runtime:" >&2
  echo "${DVV}" >&2
  exit 1
fi
if codesign -d --entitlements - --xml "${DEST}" 2>/dev/null | grep -q "<key>"; then
  echo "error: the headless helper must carry no entitlements" >&2
  exit 1
fi
echo "embedded ${NAME} (${IDENTIFIER}, hardened runtime, no entitlements, stated requirement)"
