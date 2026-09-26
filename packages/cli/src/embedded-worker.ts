// WS-23: the embedded chat/dispatch runtime's Worker entry INSIDE the compiled binary. `compile:core`
// (and `compile`) pass this file as a SECOND entrypoint beside `src/main.ts`, so Bun embeds it at
// `$bunfs/root/embedded-worker.ts`, and the daemon constructs each session's Worker from the plain
// string `"./embedded-worker.ts"` (`core`'s `COMPILED_EMBEDDED_WORKER_ENTRY`). A `new URL(…,
// import.meta.url).href` hangs silently in a compiled binary (WS-23 spike #1), and a relative path
// resolves against the binary's `$bunfs` root, not the cwd (measured) — so the name and the
// location of this file ARE the contract. `test/compile-core.test.ts` pins both.
//
// Why a PRE-BUILT bundle and not `@yanlinglabs/winter-core/embedded-worker` directly: Bun 1.3's
// multi-entrypoint `bun build` decides once, for the whole graph, which modules to wrap in lazy
// `__esm` initialisers — and `src/main.ts` dynamically `import()`s `@yanlinglabs/winter-core` and
// `@yanlinglabs/winter-protocol`, which wraps them and everything they reach (zod included). A module
// shared with THIS entry stays wrapped here too, but an unwrapped importer that exists only in this
// entry's graph (the runtime's `@modelcontextprotocol/*`) never gets the `init_*()` call, so the Worker
// died at load with `TypeError: undefined is not a constructor (evaluating 'new ZodLazy(…)')` and
// every chat/dispatch turn ended `exited before init`. It surfaced only once the runtime came from npm:
// a linked SDK checkout resolved its own zod, so nothing was shared. `compile` / `compile:core` bundle
// `src/embedded-worker.source.ts` alone first; the bundle imports only `node:` builtins, so this
// entry's graph shares no module with `src/main.ts`'s and the linker has nothing to get wrong.
import "../.build/embedded-worker.bundle.js";
