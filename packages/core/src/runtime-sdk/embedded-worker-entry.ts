// WS-23: the embedded runtime's Worker entry, as the DAEMON package spells it. `embedded.ts` constructs
// dev/test Workers from this file's absolute path; the compiled binary uses its twin,
// `packages/cli/src/embedded-worker.ts` (a second `compile:core` entrypoint, reached by a plain
// relative path). Both are this one import: the Worker side of the bridge lives in the SDK, beside the
// engine it runs, and evaluating it is what gives each session its own realm.
import "@yanlinglabs/winter-agent-runtime/embedded-worker";
