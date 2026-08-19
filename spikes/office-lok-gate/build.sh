#!/usr/bin/env bash
# Builds the office-lok-gate spike CLI. NOT part of any Xcode target -- scratch only.
# History: this spike originally proved NO-GO against the official, dmg-packaged LibreOffice
# (see git history and ./README.md). That verdict was later overturned by a from-scratch native
# build (--enable-headless) -- see the release notes at
# https://github.com/yanlingLabs/norma/releases/tag/vendor-libreoffice-20260819 for the full
# story, and ./README.md for how this spike fits into it today.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
clang -Wall -Wno-unused-parameter -o out/office-lok-gate main.c \
  -I "../../apple/Norma/Sources/OfficeKit/include" \
  -framework CoreGraphics -framework ImageIO -framework CoreFoundation
echo "built: out/office-lok-gate"
