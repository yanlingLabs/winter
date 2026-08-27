#!/usr/bin/env bash
# office-authoring Job 1 — run the probe UNDER THE REAL HELPER SEATBELT.
#
# Same as run.sh, except: everything the process writes is placed under one STATE_PATH root, and
# the probe is told to apply `Sources/OfficeHelper/office-helper.sb` to itself before lok_init_2 —
# exactly what `Sources/OfficeHelper/main.swift` does. The profile is `(deny default)` with
# `(allow file-read*)` and writes fenced to `(subpath (param "STATE_PATH"))` + TMPDIR, so the LO
# user profile, the fontconfig cache and the probe's own output ALL have to live under STATE_PATH
# or the run is measuring a misconfigured bench rather than the sandbox.
#
#   ./run-sb.sh <doc_path_or_private_url> <op> [op args...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT="$REPO/apple/Norma/vendor/libreoffice/product-set"
STATE="${OFP_SB_STATE:-/tmp/ofp-sb-state}"

rm -rf "$STATE"
mkdir -p "$STATE/fc/cache" "$STATE/profile" "$STATE/out"
cat > "$STATE/fc/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
	<cachedir>$STATE/fc/cache</cachedir>
	<dir>/System/Library/Fonts</dir>
	<dir>/Library/Fonts</dir>
	<dir>$HOME/Library/Fonts</dir>
	<dir>$ROOT/Resources/fonts/truetype</dir>
	<include ignore_missing="yes">$ROOT/Resources/fontconfig/conf.d</include>
</fontconfig>
EOF
export FONTCONFIG_FILE="$STATE/fc/fonts.conf"
export OFP_SANDBOX_PROFILE="$REPO/apple/Norma/Sources/OfficeHelper/office-helper.sb"
export OFP_SANDBOX_STATE="$STATE"
exec "$HERE/out/office-format-probe" "$ROOT/Frameworks" "$STATE/profile" "$@"
