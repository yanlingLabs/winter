// WS-23: the embedded chat/dispatch runtime's Worker graph, as the compiled binary runs it. This file is
// NEVER a `bun build --compile` entrypoint itself: `compile` / `compile:core` first bundle it ALONE
// (`bun build … --target bun --outfile .build/embedded-worker.bundle.js`), and the real second
// entrypoint, `src/embedded-worker.ts`, imports only that pre-built bundle. See that file for why.
//
// One import: the daemon package's own entry, which is the SDK's Worker half of the bridge.
import "@yanlinglabs/winter-core/embedded-worker";
