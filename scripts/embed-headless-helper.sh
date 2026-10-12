#!/usr/bin/env bash
# The body of apple/Winter/project.yml's "Embed Winter Headless" postCompileScript, in its own file so it is tested
# standalone (scripts/embed-headless-helper.test.ts), like embed-computer-helper.sh beside it.
#
# Winter Headless is Winter's private, invisible browser for the agent's background reading: a background-only app
# running windowless CEF browsers, which the daemon spawns directly over a pipe. It also carries Winter's ONE Chromium
# (the user's ruling): the CEF framework and the five "Winter Helper" bundles in its own Contents/Frameworks, and
# Winter.app's own CEF runs from there too. Nested at
#
#   Winter.app/Contents/Helpers/Winter Headless.app        (Release)
#   Winter.app/Contents/Helpers/Winter Headless Dev.app    (Debug: Winter Dev runs its CEF from it the same way)
#
# What this does, in EVERY configuration (a Debug Winter.app has no Chromium of its own any more either):
#   0. Refuse a built helper with the wrong bundle id for this configuration (Release: com.winter.headless; Debug: the
#      Debug build's own), one that is not LSBackgroundOnly, or one without its Chromium (the framework and the five
#      helper bundles in its Contents/Frameworks).
#   1. ditto the helper into Contents/Helpers.
#   2. Re-sign the helper BUNDLE (its framework and helpers are already signed, inside-out, by its own build — never a
#      --deep re-sign) with the app's identity, the hardened runtime, NO entitlements, its stable identifier and a
#      STATED designated requirement (identifier + Winter's team under Apple's anchor) — the requirement the daemon
#      checks before it spawns the helper; a secure timestamp in Release. Stated here rather than through
#      OTHER_CODE_SIGN_FLAGS because release.ts overrides that setting on its xcodebuild command line for every target.
#      Winter.app is signed last, by Xcode.
#   3. Check the signature took: the recorded requirement is exactly the stated one, the identifier is right, the
#      hardened runtime flag is set, and there are no entitlements.
#
# Env (Xcode's, read like project.yml's other postCompileScripts): BUILT_PRODUCTS_DIR, CONTENTS_FOLDER_PATH,
# CONFIGURATION, EXPANDED_CODE_SIGN_IDENTITY, DEVELOPMENT_TEAM.
#
# Standalone (the test): an ad-hoc identity (`-`) is allowed — this proves the build phase, not the release gate
# (release.ts checks the Developer ID team, the timestamp and that the requirement is satisfied).
set -euo pipefail

if [ "${CONFIGURATION:-}" = "Release" ]; then
  NAME="Winter Headless"
  ALLOWED_IDS=("com.winter.headless")
  TS="--timestamp"
else
  NAME="Winter Headless Dev"
  ALLOWED_IDS=("com.winter.headless.xcode-debug" "com.winter.headless.dev")
  TS=""
fi
TEAM="${DEVELOPMENT_TEAM:-37N77U9RSZ}"
SRC="${BUILT_PRODUCTS_DIR}/${NAME}.app"
APP_CONTENTS="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}"
DEST_DIR="${APP_CONTENTS}/Helpers"
DEST="${DEST_DIR}/${NAME}.app"
HELPERS=("Winter Helper" "Winter Helper (Alerts)" "Winter Helper (GPU)" "Winter Helper (Plugin)" "Winter Helper (Renderer)")

if [ ! -d "${SRC}" ]; then
  echo "error: the built helper is not at ${SRC} — is the WinterHeadless target in this build?" >&2
  exit 1
fi
IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${SRC}/Contents/Info.plist" 2>/dev/null || true)"
ALLOWED=0
for ID in "${ALLOWED_IDS[@]}"; do [ "${IDENTIFIER}" = "${ID}" ] && ALLOWED=1; done
if [ "${ALLOWED}" != "1" ]; then
  echo "error: the built helper's bundle id is '${IDENTIFIER}', not one of ${ALLOWED_IDS[*]} — a ${CONFIGURATION:-?} Winter.app embeds only its own configuration's helper" >&2
  exit 1
fi
BACKGROUND_ONLY="$(/usr/libexec/PlistBuddy -c 'Print :LSBackgroundOnly' "${SRC}/Contents/Info.plist" 2>/dev/null || true)"
if [ "${BACKGROUND_ONLY}" != "true" ]; then
  echo "error: the built helper is not LSBackgroundOnly — it must never have a Dock tile or a menu bar" >&2
  exit 1
fi
MISSING=""
[ -e "${SRC}/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework" ] || MISSING="${MISSING} Chromium Embedded Framework.framework"
for H in "${HELPERS[@]}"; do
  [ -e "${SRC}/Contents/Frameworks/${H}.app/Contents/MacOS/${H}" ] || MISSING="${MISSING} [${H}.app]"
done
if [ -n "${MISSING}" ]; then
  echo "error: the built helper does not carry Winter's Chromium in its Contents/Frameworks — missing:${MISSING}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
# The other configuration's helper never rides along (a tree that built both).
for OTHER in "Winter Headless" "Winter Headless Dev"; do
  [ "${OTHER}" = "${NAME}" ] || rm -rf "${DEST_DIR}/${OTHER}.app"
done
# rm first: ditto merges into an existing bundle, so a file dropped from the helper would otherwise linger.
rm -rf "${DEST}"
ditto "${SRC}" "${DEST}"

REQUIREMENT="identifier \"${IDENTIFIER}\" and anchor apple generic and certificate leaf[subject.OU] = \"${TEAM}\""
codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --identifier "${IDENTIFIER}" --options runtime ${TS} \
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
echo "embedded ${NAME} (${IDENTIFIER}, hardened runtime, no entitlements, stated requirement, Winter's one Chromium inside)"
