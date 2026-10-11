#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package=$(CDPATH= cd -- "$here/.." && pwd)
include=${WINTER_NODE_API_HEADERS:-/opt/homebrew/opt/node/include/node}
[ -f "$include/node_api.h" ] || { printf '%s\n' 'Set WINTER_NODE_API_HEADERS to existing headers; no global install is performed.' >&2; exit 1; }
swift build --package-path "$package" --jobs 4
mkdir -p "$here/out"
build_root=$(mktemp -d "$here/out/build-XXXXXX")
cp "$package/.build/debug/libWinterCoworkNative.dylib" "$build_root/libWinterCoworkNative.dylib"
xcrun clang -std=c11 -Wall -Wextra -Werror -fPIC -bundle -undefined dynamic_lookup -I"$include" "$here/adapter.c" -o "$build_root/winter-cowork-native.node"
printf '%s\n' "$build_root" > "$here/out/latest-build.txt"
printf '%s\n' "$build_root"
