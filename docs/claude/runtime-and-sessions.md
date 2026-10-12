# Runtime and sessions

*Read this before touching session create/resume, the runtime child or embedded host, model switches, or any consumer of the session event log.*

## What runs a session

- **The daemon runs no agent loop.** Every session is a runtime child driven through the router (`@yanlinglabs/winter-runtime-sdk`, pin `REQUIRED_WINTER_RUNTIME_SDK`) on the Winter agent runtime — the only leg, every model, Claude included; nothing loads `@anthropic-ai/claude-agent-sdk`.
- Two topologies, one frame stream, one `query()`: **code** spawns the `winter` binary (`@yanlinglabs/winter-agent-sdk`); **chat/dispatch** run EMBEDDED, one Bun Worker per session (`runtime-sdk/embedded.ts`, `@yanlinglabs/winter-agent-runtime`). Dispatch children are code sessions, so subprocesses.
- Modes `code | dispatch | chat` (`SessionMode`, `runtime-sdk/create.ts`). **Cowork is not implemented** (`SpawnSession` refuses `type: "cowork"`; [cowork-status.md](../cowork-status.md)).

## Embedded host

- `create.ts`'s `spawnHookFor(mode)` is the ONE topology site; chat/dispatch get `createEmbeddedSessionHost` (owned by `daemon.ts`, drained in `stop()` before the stores close; `pid` is `null`; tests use `daemon.embedded.live()`).
- Worker entry `packages/cli/src/embedded-worker.ts` is a SECOND `compile:core` entrypoint, reached in the compiled binary by the plain string `"./embedded-worker.ts"` (a `new URL(…)` hangs there); it imports only `.build/embedded-worker.bundle.js`, bundled ALONE from `src/embedded-worker.source.ts`, never with `src/main.ts` (`packages/cli/test/compile-core.test.ts`).
- **Version lock**: runtime, wrapper and `REQUIRED_WINTER_AGENT_SDK` (`runtime-sdk/versions.ts`; exact pins) must agree — `embeddedVersionCheck` at boot and every spawn; a mismatch refuses `embedded_runtime_unavailable`, never a fallback to the binary.
- An embedded Workflow tool spawns `winter-core __runtime-workflow-worker --bridge`, never the daemon's `__workflow-worker`.

## Shutdown and replaced drivers

- `daemon.stop()` first calls the driver table's `beginShutdown()`: create/resume refuse `daemon_shutting_down`, an opening incarnation refuses just before it would spawn (`spawnRefusal`) — no child outlives the daemon.
- A `WinterSession.end()` landing mid-open makes that open spawn nothing; a send that joined it is refused `session_replaced`, nothing appended; the caller waits only 2 × `WINTER_SESSION_END_GRACE_MS` (120 ms).
- Every send door retries such a send ONCE on the next driver (`runtime-sdk/session-replaced.ts`'s `withReplacementRetry`: `session.send`, `session.steer`, SendMessage delivery in `agent/session-messaging.ts`). If it still escapes: RPC `ERR.RETRY` (-32007, `data: {code: "session_replaced", retryable: true}`), never `INTERNAL`; SendMessage `unavailable` + `retryable: true`; the TUI notes it and restores the composer text. `test/e2e/spawn-during-stop-e2e.test.ts` pins it.

## Where the binaries come from

- `winter` (`runtime-sdk/executable.ts`, `resolveWinterExecutable`), code only: `settings.runtimes.winterExecutable` → `$WINTER_RUNTIME_EXECUTABLE` → `<dirname(execPath)>/runtimes/winter` (Release bundle) → `<WINTER_HOME>/runtimes/bin/winter` → the optional platform package `@yanlinglabs/winter-agent-sdk-darwin-arm64`. An explicit setting/env path is authoritative — missing = the failure, never a fall-through. The package rung refuses a version ≠ `REQUIRED_WINTER_AGENT_SDK` and resolves THROUGH the wrapper's own `require`; a plain `bun install` suffices for a dev daemon.
- `ant` (`runtime-sdk/bundle-layout.ts`, `resolveAntExecutable`) — the Console login/refresh door, never a session runtime: `settings.runtimes.antExecutable` → `$WINTER_ANT_EXECUTABLE` → `<dirname(execPath)>/runtimes/ant/ant` → `$PATH` (skipped in a compiled binary).
- Release records (`RUNTIME_BUNDLE_LAYOUT`): `runtimes/VERSIONS.json` (schema 2; schema 1, the retired `claude-official` shape, refused by name) and `runtimes/ant/VERSIONS.json` (held to the repo-root `VERSIONS.json` by `release-lib.ts`'s `verifyAntEmbed`). `runtimes.claudeExecutable`/`$WINTER_CLAUDE_EXECUTABLE` are accepted and ignored.
- `bun run build:winter` builds `dist/winter` from a sibling `../winter-agent-sdk` at the pinned tag; point a daemon at it with `WINTER_RUNTIME_EXECUTABLE`. `--sign` / `$WINTER_RUNTIME_SIGN_IDENTITY` signs as `com.winter.runtime`.
- **No session reads the Keychain.** The daemon sets `Options.onCredentialResolve`, the SDK sets `hostCredentials: true`, and the child asks for each credential over its control channel (`credential_resolve`, `runtime-sdk/host-credentials.ts`), answered by `winter-core`. What is brokered: [providers-and-credentials.md](./providers-and-credentials.md).

## Which runtime a session runs on

- `create.ts`'s `selectRuntimeFor` builds one `SelectionInput` (mode, model, catalog family listing, credential presence); the router picks the row. The daemon states `hasClaudePeer: false`, so every family selects `winter-agent`; `session-driver.ts`'s `decideRuntime` refuses any other `runtimeKind` (`runtime_selection_refused`, `reason: "runtime-unavailable"`).
- Refusals are `WinterLegRefusal`s forwarded as the RPC error's `data.code`: `winter_executable_unavailable`, `runtime_selection_refused`, `legacy_session_migration_refused` (both +`data.reason`), `session_cwd_unavailable` (every incarnation checks the stored cwd FIRST — `sessionCwdRefusal`, top of `optionsFor` — and names the path), `daemon_shutting_down`, `session_replaced`. **Never a silent fallback** to another provider, model or directory.
- **Legacy adoption**: a `runtimeKind: "claude-agent"` record is adopted at its next resume by `session-driver.ts`'s `adoptLegacyRecord` (synchronous — `ensure()` never awaits): `rekeyForCanonicalCwd` moves claude's transcript to the Winter cwd key, then `runtimeKind`/`selection`/`authRef` are rewritten; provider, model and auth family carry over; the runtime reads claude's entries. Refused `legacy_session_migration_refused` (nothing moved) for `reason` `claude-oauth`, `repair-required`, `transcript-move-refused` or `transcript-collision` (record left `repair-required`); `winter doctor --repair adopt-legacy-session` clears it. `leg.ts`'s `sessionLegOf` answers `"official"` until adopted.
- Boot root recovery (`runtime-state/root-recovery.ts`) and Migration C phase 2 still reconcile leftover official working copies and `claude-resume-*` roots; nothing creates new ones. **The per-user temp folder is listed at most once per home** (`runtime-state/claude-resume-scan.ts`: 3 s / 2M entries; marker `<home>/migration/claude-resume-scan.json`); later boots re-check only recorded roots and the marker's `pending` paths BY PATH, same `known`/quarantine/24 h rules. It stays on the first boot's path: the staging reconcile must precede Migration C's re-key and any session.

## Switching model mid-session

- `session.setModel` → `runtime-sdk/handoff.ts`'s `planAndApplySwitch`: a fresh `selectRuntimeFor`, then the router's `reviewSwitch` (`runtimeSdkInternals(sdk).barrier`) for a change crossing FAMILIES. Lossy → `handoff_confirmation_required` (warnings + what stays portable); `confirmLossy: true` is one-shot, never stored. Unreviewable (review throws, or the directory row is missing after `materializeDirectoryRow`'s one retry) → a prompt, never a silent apply or refusal.
- Applied → the record is patched (`selection`/`providerId`/`modelRef`/`authRef`); `ipc/server.ts` refuses to write `meta.model` unless the record names the decided selection. A PROVIDER change evicts the live child at its next idle boundary; a running turn is never interrupted. A legacy record is adopted first; its refusal is the switch's. No cross-runtime move exists; `runtimes.handoff.crossRuntime` is inert.

## Event-sourced sessions

- A session is an append-only JSONL of `SessionEvent`s (`seq`/`sessionId`); clients replay, the daemon rebroadcasts live events to attached harnesses. `reasoning_item.itemJson` (provider `encrypted_content`) is opaque: the JSONL is its only sink — never log it, never put it in a model-readable transcript.
- Durable per-session facts (backend transcript id, provider, runtime kind, selection) live in `runtime-state.db`; every incarnation re-reads credential, model and connection.

## Tool results arrive per call

- A round's concurrency-safe calls run at once (`MAX_TOOL_CONCURRENCY` 10): `Read`/`Glob`/`Grep`/`LSP`/`WebFetch`/`WebSearch`/`Search`/`Agent`, read-only-classified `Bash`, any MCP tool listed `readOnlyHint: true`; anything else is a barrier.
- **Lanes** (`McpSdkServerConfig.toolLanes` ← `CapabilityToolFacts.lane`, `capabilities/names.ts`): `Computer` and `Browser` each have one — beside everything else, one at a time within the lane, across the whole SESSION, subagents included (`EngineOptions.toolLaneTails`). A call takes its lane only after its checks and card, and keeps it until its work has stopped: an interrupt sends `control_cancel_request` and the SDK aborts the tool's signal (`callTool(name, args, {signal})`, combined with the incarnation's in `capabilities/server.ts`); an interrupted `Browser` call waits for its panel command up to `BROWSER_CANCEL_SETTLE_MS` (4 s) unless the session is ending (`ToolContext.sessionSignal`); the lane frees when the host answers the cancel or after `SDK_MCP_CANCEL_GRACE_MS` (5 s).
- `SpawnSession` is concurrency-safe WITHOUT being read-only (`concurrentTools` ← `CapabilityToolFacts.concurrent`, no `readOnlyHint`); `ListSessions` is read-only (`readOnly` → `readOnlyHint: true`); the rest are serial. Connector permissions never read a capability tool's hint.
- **Several cards can be open at once**: bridge, broker, Mac and phone key every card by `callId`; the TUI queues a second behind the one on screen (`TuiState.queuedCards`, re-keyed so it never inherits typed input); `winter -p` shows ONE at a time (`packages/cli/src/shell-cards.ts`): a typed answer always goes to the card on screen.
- Each call's result is its own `user` frame the moment it finishes (after PostToolUse hooks, so `fileDiff` is attached first), so `tool_result`s land in COMPLETION order. **Every consumer must fold by `callId`**; the projector drops a second `tool_result` per call per turn (`projector/index.ts`). The model still gets one tool message per round, in call order. Crash window: the runtime records a round's results once, after the last call, so a child dying mid-round can leave `tool_result`s on the log the resumed model never saw.
- A push made mid-turn is FOLDED into the running turn: [dispatch-and-messaging.md](./dispatch-and-messaging.md).
