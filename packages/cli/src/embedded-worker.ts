// WS-23: the embedded chat/dispatch runtime's Worker entry INSIDE the compiled binary. `compile:core`
// (and `compile`) pass this file as a SECOND entrypoint beside `src/main.ts`, so Bun embeds it at
// `$bunfs/root/embedded-worker.ts`, and the daemon constructs each session's Worker from the plain
// string `"./embedded-worker.ts"` (`core`'s `COMPILED_EMBEDDED_WORKER_ENTRY`). A `new URL(…,
// import.meta.url).href` hangs silently in a compiled binary (WS-23 spike #1), and a relative path
// resolves against the binary's `$bunfs` root, not the cwd (measured) — so the name and the
// location of this file ARE the contract. `test/compile-core.test.ts` pins both.
//
// One import: the daemon package's own entry, which is the SDK's Worker half of the bridge.
import "@yanlinglabs/winter-core/embedded-worker";
