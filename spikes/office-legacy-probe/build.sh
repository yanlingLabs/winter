#!/usr/bin/env bash
# Builds the office-legacy-probe spike CLI. NOT part of any Xcode target -- scratch only.
# Mirrors spikes/office-lok-gate/build.sh's own flags exactly (same headers, no CoreGraphics
# needed here -- this spike never paints a tile).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
clang -Wall -Wno-unused-parameter -o out/office-legacy-probe main.c \
  -I "../../apple/Norma/Sources/OfficeKit/include"
echo "built: out/office-legacy-probe"
