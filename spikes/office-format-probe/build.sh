#!/usr/bin/env bash
# Builds the office-format-probe spike CLI. NOT part of any Xcode target -- scratch only.
# Same shape as spikes/office-lok-gate/build.sh; this one needs no CoreGraphics/ImageIO (it paints
# throwaway pump tiles into a static buffer and never writes a PNG).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
clang -Wall -Wno-unused-parameter -o out/office-format-probe main.c \
  -I "../../apple/Norma/Sources/OfficeKit/include"
echo "built: out/office-format-probe"
