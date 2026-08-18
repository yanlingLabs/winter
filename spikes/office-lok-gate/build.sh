#!/usr/bin/env bash
# Builds the office-lok-gate spike CLI. NOT part of any Xcode target -- scratch only.
# See ../../docs/superpowers/research/2026-08-18-lok-embed-gate.md for the full gate report
# (NO-GO) and ./README.md for how this spike was used to produce it.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
clang -Wall -Wno-unused-parameter -o out/office-lok-gate main.c \
  -I "../../apple/Norma/Sources/OfficeKit/include" \
  -framework CoreGraphics -framework ImageIO -framework CoreFoundation
echo "built: out/office-lok-gate"
