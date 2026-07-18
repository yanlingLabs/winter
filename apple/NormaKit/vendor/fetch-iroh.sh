#!/usr/bin/env bash
# Fetches iroh-ffi's prebuilt Apple XCFramework and unpacks it into
# vendor/IrohLib.xcframework (gitignored — ~133MB unpacked, ~44MB zipped).
#
# Run this once after cloning (or whenever bumping IROH_VERSION below).
# `swift build` / `swift test` in apple/NormaKit will fail with a missing
# binary-target error until this has been run.
set -euo pipefail

IROH_VERSION="v1.1.0"
# sha256 of IrohLib.xcframework.zip attached to the GitHub release, pinned so
# a compromised/rotated release asset fails loudly instead of silently
# swapping in different binaries.
IROH_ZIP_SHA256="ad46dadf09f9224157512992923562931ed60f252414230d50893a4d515c5776"
IROH_URL="https://github.com/n0-computer/iroh-ffi/releases/download/${IROH_VERSION}/IrohLib.xcframework.zip"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${SCRIPT_DIR}/IrohLib.xcframework"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Fetching iroh-ffi ${IROH_VERSION} XCFramework..."
curl -fL -o "${TMP_DIR}/IrohLib.xcframework.zip" "${IROH_URL}"

ACTUAL_SHA256="$(shasum -a 256 "${TMP_DIR}/IrohLib.xcframework.zip" | awk '{print $1}')"
if [ "${ACTUAL_SHA256}" != "${IROH_ZIP_SHA256}" ]; then
  echo "error: checksum mismatch for IrohLib.xcframework.zip" >&2
  echo "  expected: ${IROH_ZIP_SHA256}" >&2
  echo "  actual:   ${ACTUAL_SHA256}" >&2
  echo "  (bumping IROH_VERSION? update IROH_ZIP_SHA256 from the release asset digest.)" >&2
  exit 1
fi

echo "Checksum OK. Unpacking..."
rm -rf "${DEST}"
mkdir -p "${TMP_DIR}/extract"
unzip -q "${TMP_DIR}/IrohLib.xcframework.zip" -d "${TMP_DIR}/extract"

# The release zip's top-level directory is `Iroh.xcframework` (the xcframework's
# own internal module is named `Iroh` — see vendor/README.md); we place it at
# `IrohLib.xcframework` here to match this repo's Package.swift path.
mv "${TMP_DIR}/extract/Iroh.xcframework" "${DEST}"
echo "Unpacked to ${DEST}"

# Informational only: sanity-check that `swift package compute-checksum` runs in this
# environment and show its shape. This is NOT the checksum that belongs in Package.swift and
# will NOT match it (or even match itself between separate fetches): `ditto -c -k --keepParent`
# embeds each file's mtime in the zip, so re-zipping a freshly re-downloaded/re-unpacked
# xcframework produces different bytes — and a different checksum — every time, even though
# the xcframework's actual content is identical. The authoritative checksum is the one
# scripts/publish-iroh-xcframework.ts computes and prints from the exact zip it uploads;
# that's the only value that should ever go in Package.swift's `.binaryTarget(checksum:)`.
if command -v swift >/dev/null 2>&1; then
  REZIP="${TMP_DIR}/republish-preview.zip"
  ditto -c -k --keepParent "${DEST}" "${REZIP}"
  SPM_CHECKSUM="$(cd "${SCRIPT_DIR}/.." && swift package compute-checksum "${REZIP}")"
  echo "SPM checksum preview (will differ from Package.swift's pinned value — see comment above): ${SPM_CHECKSUM}"
else
  echo "note: 'swift' not found — skipping SPM checksum preview."
fi
