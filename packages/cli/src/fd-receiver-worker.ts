// The compiled daemon's receiver thread for the Cowork native channel: a THIRD `compile:core` entrypoint (beside src/main.ts and src/embedded-worker.ts), reached by the plain
// string `./fd-receiver-worker.ts` (core's COMPILED_FD_RECEIVER_WORKER_ENTRY). Same contract and same reason as embedded-worker.ts: the name and the directory ARE the contract,
// and the worker graph is PRE-BUNDLED alone (`src/fd-receiver-worker.source.ts` -> `.build/fd-receiver-worker.bundle.js`) so it shares no module with main.ts's lazily wrapped graph.
// Without this file a compiled daemon that activated Cowork could not start the channel's receiver thread. `bun run verify:fd-receiver` proves it on the real binary.
import "../.build/fd-receiver-worker.bundle.js";
