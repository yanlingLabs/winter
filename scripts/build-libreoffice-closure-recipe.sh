#!/usr/bin/env bash
# Builds the Frameworks/ half of product-set/ from the empirical DYLD_PRINT_LIBRARIES closure
# captured by run-all-fixtures.sh (dyld-traces/*.dyld.txt), plus an otool -L safety net walked
# transitively from every dylib the trace found (catches anything load-bearing but not actually
# exercised by these seven specific fixtures).
#
# DYLD_PRINT_LIBRARIES output line format (verified empirically against this macOS/dyld build,
# 2026-08-18, via a locally-compiled adhoc-signed test binary -- NOT documented anywhere, do not
# assume it's stable across macOS versions):
#   dyld[PID]: <UUID> /absolute/path/to/lib
#
# Classifies every unique path from the traces into three buckets:
#   INSTDIR  -- under core/instdir/... (LO's own bundled dylibs)              -> copied into product-set/
#   SYSTEM   -- /usr/lib/* or /System/Library/* (always present on any mac)   -> not copied, just counted
#   LEAK     -- anything else (e.g. /opt/homebrew/...)                        -> NOT copied; printed as a
#               warning, because it means something in this build links against a host-machine-only
#               path that will not exist on an end-user's machine -- a real product-shape defect to
#               report, not silently paper over.
#
# Usage: ./build-product-set-dylibs.sh
set -euo pipefail
cd "$(dirname "$0")"

TRACEDIR="dyld-traces"
INSTDIR_ROOT="$(cd core/instdir && pwd)"
FRAMEWORKS_SRC="$INSTDIR_ROOT/LibreOfficeDev.app/Contents/Frameworks"
OUT="product-set"
mkdir -p "$OUT/Frameworks"

if [ ! -d "$TRACEDIR" ] || [ -z "$(ls -A "$TRACEDIR"/*.dyld.txt 2>/dev/null)" ]; then
  echo "FAIL: no dyld traces in $TRACEDIR -- run ./run-all-fixtures.sh against core/instdir first." >&2
  exit 2
fi

RAW="$(mktemp)"
grep -hoE '^dyld\[[0-9]+\]: <[0-9A-Fa-f-]+> .+$' "$TRACEDIR"/*.dyld.txt \
  | sed -E 's/^dyld\[[0-9]+\]: <[0-9A-Fa-f-]+> //' \
  | sort -u > "$RAW"

echo "Unique images loaded across all traced fixture runs: $(wc -l < "$RAW" | tr -d ' ')"

INSTDIR_LIST="$(mktemp)"
LEAK_LIST="$(mktemp)"
SYSTEM_COUNT=0

while IFS= read -r path; do
  case "$path" in
    "$INSTDIR_ROOT"/*) echo "$path" >> "$INSTDIR_LIST" ;;
    /usr/lib/*|/System/Library/*) SYSTEM_COUNT=$((SYSTEM_COUNT + 1)) ;;
    *) echo "$path" >> "$LEAK_LIST" ;;
  esac
done < "$RAW"

echo "  instdir-owned: $(wc -l < "$INSTDIR_LIST" | tr -d ' ')"
echo "  OS-system (not bundled, assumed present on any target mac): $SYSTEM_COUNT"
if [ -s "$LEAK_LIST" ]; then
  echo "  !! LEAK -- paths outside both instdir and the OS (need investigation, NOT auto-copied):"
  sed 's/^/     /' "$LEAK_LIST"
else
  echo "  leaks: none"
fi

# otool -L safety net: transitively walk every instdir dylib the trace found, one level of
# expansion is enough here since gbuild/mergelibs already flattens most of the graph and the
# trace itself is the authoritative *runtime* answer -- this only catches something linked but
# for some reason not triggering a distinct dyld log line (e.g. a duplicate weak-link case).
EXTRA="$(mktemp)"
while IFS= read -r lib; do
  otool -L "$lib" 2>/dev/null | tail -n +2 | awk '{print $1}'
done < "$INSTDIR_LIST" | sort -u > "$EXTRA"

while IFS= read -r path; do
  case "$path" in
    "$INSTDIR_ROOT"/*)
      if ! grep -qxF "$path" "$INSTDIR_LIST"; then
        echo "$path" >> "$INSTDIR_LIST"
        echo "  [otool safety net added]: $path"
      fi
      ;;
  esac
done < "$EXTRA"

echo ""
echo "Copying $(wc -l < "$INSTDIR_LIST" | tr -d ' ') instdir dylibs into $OUT/Frameworks/ ..."
while IFS= read -r path; do
  rel="${path#"$FRAMEWORKS_SRC"/}"
  if [ "$rel" = "$path" ]; then
    # not under Frameworks/ (shouldn't happen on this mac instdir layout, but don't silently drop it)
    echo "  !! unexpected non-Frameworks instdir path: $path" >&2
    mkdir -p "$OUT/Frameworks/$(dirname "$rel")"
  fi
  mkdir -p "$OUT/Frameworks/$(dirname "$rel")"
  cp -pP "$path" "$OUT/Frameworks/$rel"
done < "$INSTDIR_LIST"

rm -f "$RAW" "$INSTDIR_LIST" "$LEAK_LIST" "$EXTRA"
echo "Done. du -sh $OUT/Frameworks:"
du -sh "$OUT/Frameworks"
