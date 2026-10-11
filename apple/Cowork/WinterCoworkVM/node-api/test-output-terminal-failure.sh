#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
include=${WINTER_NODE_API_HEADERS:-/opt/homebrew/opt/node/include/node}
[ -f "$include/node_api.h" ] || exit 1
mkdir -p "$here/out"
fixture=$(mktemp -d "$here/out/terminal-failure-XXXXXX")
# This compile-only injection has no exported/runtime toggle and is never used
# by build.sh or the production package recipe.
xcrun clang -std=c11 -Wall -Wextra -Werror -fPIC -bundle -undefined dynamic_lookup \
  -DWINTER_OUTPUT_FIXTURE_TERMINAL_FAILURE -I"$include" "$here/adapter.c" \
  -o "$fixture/winter-output-terminal-failure.node"
bun run "$here/output-terminal-failure-smoke.ts" "$fixture/winter-output-terminal-failure.node"
