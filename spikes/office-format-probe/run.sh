#!/usr/bin/env bash
# Runs office-format-probe with the SAME boot environment LOKBridge establishes before lok_init_2:
# a fresh scratch profile dir, and FONTCONFIG_FILE pointing at a generated fonts.conf naming a
# writable cachedir plus the system + bundled font dirs. `LOKBridge.configureFontconfig`'s own
# header records why the ordering matters: fontconfig resolves lazily but the first font lookup
# happens deep inside LO's init/load path, so "before lok_init_2" is the only safe point.
#
#   ./run.sh <doc_path> <op> [op args...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT="$REPO/apple/Norma/vendor/libreoffice/product-set"
RUN="${OFP_RUN_DIR:-/tmp/ofp-run}"

mkdir -p "$RUN/fc/cache" "$RUN/profile-$$"
cat > "$RUN/fc/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
	<cachedir>$RUN/fc/cache</cachedir>
	<dir>/System/Library/Fonts</dir>
	<dir>/Library/Fonts</dir>
	<dir>$HOME/Library/Fonts</dir>
	<dir>$ROOT/Resources/fonts/truetype</dir>
	<include ignore_missing="yes">$ROOT/Resources/fontconfig/conf.d</include>
</fontconfig>
EOF
export FONTCONFIG_FILE="$RUN/fc/fonts.conf"
exec "$HERE/out/office-format-probe" "$ROOT/Frameworks" "$RUN/profile-$$" "$@"
