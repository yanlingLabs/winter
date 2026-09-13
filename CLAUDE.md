# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Winter is a macOS-native AI assistant: a TypeScript/Bun daemon (`winter-core`) that runs the agent loop, plus a native Swift menu-bar app that gives it a face. They talk JSON-RPC 2.0 over NDJSON on a Unix socket (`~/.winter/run/core.sock`). The daemon is the single source of truth; every client (CLI, app) is a view over its event stream.

## Commands

```sh
bun install                          # install everything (bun is the runtime; pnpm workspaces orchestrate)

# Tests
pnpm test                            # all workspaces, serially
cd packages/core && bun test         # one package
bun test path/to/file.test.ts        # one file (path substring match)
bun test -t "test name"              # one test by name

# Protocol codegen — REQUIRED after changing packages/protocol/src (events/methods)
pnpm protocol:generate               # regenerates JSON schema + Swift round-trip fixtures

# Workflows e2e — proves the sandboxed runtime on the REAL compiled artifact (dist/winter-core)
bun run verify:workflow

# Swift
cd apple/WinterProtocol && swift test # protocol mirror round-trip tests
cd apple/WinterKit && swift test      # daemon client library
cd apple/Winter && xcodegen generate && \
  xcodebuild -project Winter.xcodeproj -scheme Winter -destination 'platform=macOS' build

# Run the daemon + CLI in dev
cd packages/cli
bun src/main.ts daemon run           # headless daemon
bun src/main.ts -p "hello"           # one-shot prompt (separate terminal)
bun src/main.ts                      # interactive TUI (Ink)

# Dev profile: the Debug app is "Winter Dev" (com.winter.app.dev) on ~/.winter-dev, keychain
# com.winter.core.dev; the global `winter-dev` command (installed by the dev app's menu) is an
# env-setting bun wrapper. The distribution app owns `winter` (symlink installed from the app /
# brew) on ~/.winter, keychain com.winter.core. Explicit WINTER_HOME always wins over both defaults.
# LEGACY TRAP (Phase 9b): a stale global `norma-dev` wrapper exports `NORMA_HOME`/`NORMA_PROFILE`,
# which this CLI no longer reads — it would run as the DIST profile on `~/.winter`. Use `winter-dev`
# (installed by the Winter Dev app's menu). `~/.norma-dev` is untouched until Migration B (9c).
# TWO TRAPS: (1) plain `winter` is the DIST CLI — with a dead socket it AUTO-LAUNCHES the dist app
# (`open -g -b com.winter.app`), so never use it for dev/test work: use `winter-dev`, or a temp
# WINTER_HOME with a manually-spawned `daemon run`. (2) Debug builds do NOT embed winter-core —
# "Winter Dev" cannot self-spawn a daemon; start the dev daemon below FIRST or the orb shows
# disconnected.
WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev bun src/main.ts daemon run   # dev daemon (or: winter-dev daemon run)
# THIRD TRAP (Winter Phase 8b; bundle layout as of 8d; ladder as of 9a): every session runs as a
# spawned `winter` child, and DEBUG BUILDS NEVER EMBED EITHER RUNTIME (dev/dist split, CLAUDE.md's
# own Hard Rules) — only a RELEASE build embeds both under
# `Contents/Resources/runtimes/{winter,claude-official/*}` (project.yml's "Embed runtimes"
# postCompileScript, `scripts/embed-runtimes.sh`). The FULL ladder (`resolveWinterExecutable`):
# `settings.runtimes.winterExecutable` → `$WINTER_RUNTIME_EXECUTABLE` →
# `<dirname(execPath)>/runtimes/winter` (never reachable in Debug) → `<WINTER_HOME>/runtimes/bin/winter`
# → (P9a-9) the installed npm platform package `@yanlinglabs/winter-agent-sdk-darwin-arm64`, an
# OPTIONAL dependency of the wrapper that `bun install` resolves on darwin-arm64 (published since
# SDK v0.0.5; the wrapper pins the EXACT matching version, and the rung REFUSES a package whose
# version differs from `versions.ts`'s `REQUIRED_WINTER_AGENT_SDK` — a mixed pair is never spawned).
# bun's isolated linker nests it under the WRAPPER's own node_modules, which is why the resolver
# dual-hops through `@yanlinglabs/winter-agent-sdk/package.json` (P9a fix wave C1). So a PLAIN
# `bun install` is enough on its own and a dev daemon can simply be:
WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev bun src/main.ts daemon run
# The npm binary is AD-HOC signed and its bytes change on every publish, so every fresh `bun
# install` re-triggers the ONE-TIME-PER-BINARY Keychain consent dialog below. `dist/winter`
# (`bun run build:winter` from the ../winter-agent-sdk checkout at the pinned tag) stays the
# STABLE-IDENTITY option for anyone who wants that dialog to survive rebuilds — point the daemon
# at it explicitly (wins over the package rung):
WINTER_RUNTIME_EXECUTABLE="$PWD/../../dist/winter" WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev bun src/main.ts daemon run
# (or set `runtimes.winterExecutable` in ~/.winter-dev/settings.json). FIRST RUN AFTER A REBUILD OR A FRESH `bun install`:
# the winter binary reads the daemon's Keychain items itself, so macOS shows ONE consent dialog per credential item — click
# "Always Allow" or the turn stalls until the CLI's 180 s watchdog aborts it. `bun run build:winter --sign <identity>` (or env
# `WINTER_RUNTIME_SIGN_IDENTITY`; `-` for an ad-hoc-but-STABLE identity works too) re-signs a freshly built `dist/winter`
# with a fixed `--identifier com.winter.runtime`, so ITS Keychain ACL survives rebuilds instead of re-prompting every time
# (P8d-14) — the npm-installed binary has no such option (Anthropic-shaped release pipeline, not this repo's to re-sign
# for dev convenience), so it re-prompts once per `bun install` that actually changes its bytes. Credentials are JSON
# "material" records (`openai:default`, `codex-oauth:default`; see packages/core/src/auth/credential-material.ts) —
# the raw legacy records are migrated at boot.
# FOURTH TRAP (Phase 8c; bundle layout as of 8d): a Code session on a Claude catalog model routes to the OFFICIAL leg,
# which needs (1) the Claude platform runtime — `bun install` fetches `@anthropic-ai/claude-agent-sdk-darwin-arm64`;
# the ladder is `runtimes.claudeExecutable` → `$WINTER_CLAUDE_EXECUTABLE` → `<dirname(execPath)>/runtimes/claude-official/claude`
# (Release only; also gated on a `VERSIONS.json` staged beside it matching this build's pins — a mismatched pair refuses
# typed even though the binary itself exists) → node_modules (dev only) — and (2) an Anthropic API key material
# (`winter login --anthropic-key`); without either the session refuses typed (`claude_executable_unavailable` /
# `runtime_selection_refused`). Winter-leg sessions are unaffected. Cross-runtime handoff via `session.setModel` is fenced
# by `runtimes.handoff.crossRuntime` (default false).
# P9c-1 AMENDMENT (Phase 9c): the official leg authenticates ONLY with the user's own Anthropic API-key material — never a
# claude.ai subscription — until Anthropic approves it for this integration. While `runtimes.official.subscriptionAuth` is
# `false` (the default, and the only shipped value), every spawned `claude` child gets its own Winter-owned `CLAUDE_CONFIG_DIR`
# (`officialConfigDirFor(home)` = `<home>/runtimes/claude-config`, created 0700), an environment scrubbed of every other
# auth-injecting variable (`FORBIDDEN_CHILD_ENV`), and a per-session assertion that the SDK's own `system/init` message reports
# `apiKeySource: "ANTHROPIC_API_KEY"` — a mismatch refuses typed as `official_auth_source_refused` before any turn runs.
# `~/.claude` itself is unreachable from this leg regardless of the flag (the vendored router refuses any config dir under a
# `.claude` path segment outright); flipping the flag on today only widens which config dir this leg uses and skips the
# assertion — it does not grant subscription access, which needs router-level work gated on Anthropic's approval.
# P10a ADDENDUM: since Phase 10a the official leg also accepts the Console profile arm
# (`runtimes.official.auth` = auto|api-key|console) alongside the api-key arm above. The single login door is
# `ant auth login --profile winter` with `ANTHROPIC_CONFIG_DIR=<home>/runtimes/anthropic-config`, driven by the
# SDK's own broker — the `claude` binary's own `auth login` is never used for this. A spawned child on this arm
# gets exactly `ANTHROPIC_PROFILE`/`ANTHROPIC_CONFIG_DIR` and is asserted to report `apiKeySource: "none"`. A
# LIVE, uncached pre-spawn check refuses typed as `console_profile_missing` on every spawn, because a missing
# profile silently falls back to whatever login is already stored in that config dir instead of refusing.

# Versioning (Phase 9c, P9c-2) — never edit versions by hand; VERSION file (#.###.# format: 0 . three-digit feature
# counter . single-digit patch, e.g. 0.111.0) is canonical. The first digit moves only for a rebrand-scale event.
bun run version:bump                 # patch +1 (refuses past 9 — use a feature bump)
bun run version:bump:feature         # feature +1, patch -> 0 (also version:bump:major, reserved)
bun run version:sync                 # restamp package.jsons/plists from VERSION

# Release (one command → signed, notarized, stapled zip+DMG+appcast+cask+gh release)
bun run scripts/release.ts --dry-run --no-bump   # full rehearsal, never publishes
bun run scripts/release.ts                       # real release (bumps version first)
```

## Architecture

### Monorepo layout

- `packages/protocol` — the contract. Zod schemas for every JSON-RPC method and `SessionEvent` variant. `generate.ts` emits a JSON schema + canonical fixtures consumed by the Swift side.
- `packages/core` — the daemon. Every session runs through the Winter runtime SDK (`src/runtime-sdk/` — `create.ts` builds the one router handle; `session-driver.ts` dispatches a session to the Winter child or, for Claude catalog models in Code mode with an Anthropic key, the official Claude Agent SDK leg; `official-*.ts` is that leg), the SDK-message→SessionEvent projector (`src/projector/`), per-session capability servers (`src/capabilities/`), tool definitions (`src/agent/tools/`), the provider layer for the daemon's own internal model calls (`src/providers/` on `@yanlinglabs/winter-provider-runtime`; Codex OAuth login), event-sourced sessions (`src/sessions/`), plugin supervisor (`src/plugins/`), settings hot-reload (`src/settings-watcher.ts`), routines/scheduling (`src/routines/`). The old `AgentEngine` is gone (Winter Phase 8b).
- `packages/core/src/workflows/` — the workflows runtime: model-authored JS orchestration scripts run in a **sandboxed subprocess** (the daemon self-spawns its own binary as `__workflow-worker` under a macOS seatbelt; NDJSON stdio bridge). Dev and compiled paths differ — `bun run verify:workflow` is the compiled-binary proof and must stay green.
- `packages/cli` — the `winter` command: Ink/React TUI, headless `-p` mode, daemon lifecycle (launchd).
- `packages/plugin-sdk` — what third-party plugins build against. Plugins are separate processes granted narrow, user-consented capabilities; `examples/battery-limiter` is the complete reference plugin.
- `apple/WinterProtocol` — Swift mirror of the protocol types. Its tests decode/re-encode every TS-generated fixture and assert the exact fixture count.
- `apple/WinterKit` — Swift client for the daemon socket.
- `apple/Winter` — the menu-bar app (xcodegen `project.yml`, no committed pbxproj). Embeds `winter-core` and `WinterHelper` in Release builds.
- `scripts/release.ts` + `scripts/release-lib.ts` — the release pipeline; `packaging/winter.rb.tmpl` is the Homebrew cask template it renders.
- `docs/superpowers/` is git-ignored (private design docs); don't reference it from committed code.
- The iOS companion lives in a **sibling repo** (`../norma-ios`) and consumes `WinterProtocol` + `WinterSessionKit` as a remote SPM package pinned to a **git tag of this repo** (`v-*-kitN`, exposed via the root `Package.swift`). Editing Swift kit sources here does nothing for the phone until commit → push → new kit tag → `norma-ios/project.yml` `revision:` bump + `xcodegen generate`.

### The protocol change checklist

Adding/changing a `SessionEvent` variant or RPC method touches, in order:

1. `packages/protocol/src/events.ts` (or `methods.ts`) — zod schema
2. `packages/protocol/scripts/generate.ts` — add a canonical fixture for the new variant
3. `pnpm protocol:generate`
4. `packages/core/src/projector/event-coverage.ts` — its `PROJECTED_EVENT_COVERAGE` map (`satisfies Record<SessionEvent["type"], boolean>`) is the ONE exhaustiveness map since the engine retired (Winter Phase 8b); it fails core's `tsc` on a new variant until updated

   **Adding a FIELD (not a variant) engages none of the compile-time traps above — so sweep the field's PRODUCERS BY MEANING, not by build breakage.** Every step in this checklist is keyed to something failing to compile, and nothing fails to compile when a producer simply doesn't set a new optional field. `turn_completed.contextTokens` shipped correct on the daemon while `WinterChatKit`'s `ChatEngine` remained a **live second producer** emitting the old shape — reaching the daemon's log verbatim via `sync.push`, past a consumer with no mode gate. Ask: who else *writes* this event, in either language, and does the consumer's fallback silently accept their shape? (Corollary that saved that change from being a Critical: replication is byte-verbatim, so the phone does not decode and re-encode — had it done so, the new field would have been stripped in transit and the fix would have looked like it worked.)
5. `apple/WinterProtocol` — mirror the Swift type; round-trip test asserts the fixture count, so it fails until synced
6. `apple/WinterKit` — it has exhaustive `switch`es over event variants (e.g. the `seq`/`sessionId` accessors); a new variant breaks compilation there, **not** in WinterProtocol
7. Build WinterKit **and** the app, not just `swift test` in WinterProtocol — that's the only way to catch step 6

### Event-sourced sessions

Every session is an append-only JSONL of `SessionEvent`s (each carrying `seq`/`sessionId`). Clients reconstruct state by replaying; the daemon rebroadcasts live events to attached harnesses. Provider `encrypted_content` / `reasoning_item.itemJson` is opaque: the session JSONL is its only sink — never log it or write it into model-readable transcript files.

### Remote surface & history (phone-facing)

- The remote-role method allowlist is **four hand-mirrored lists that move in lockstep**: `REMOTE_ALLOWED_METHODS` (`packages/core/src/ipc/server.ts`) + its literal parity test (`packages/core/test/ipc/remote-allowlist-parity.test.ts`) + Swift `Gateway.remoteAllowedMethods` (`apple/WinterKit/Sources/WinterKit/Gateway/Gateway.swift`) + its count test (`GatewayGateTests`). Adding a remote method is a deliberate edit to all four; the two tests are the drift tripwire.
- `session.history` serves paged past events filtered by `HISTORY_EVENT_TYPES` (`packages/core/src/sessions/history.ts`) — an **allowlist, never a denylist**: `reasoning_item` must never pass it (a security sweep test pins this). Adding a type requires confirming the recursive per-event string cap bounds its large fields at every depth — the phone transport hard-fails on oversized frames, so an unbounded field is a silent connection-killer.
- The **live/replay** stream to a remote client is a *second* allowlist with the identical obligation: `REMOTE_STREAM_EVENT_TYPES` + `capEvent` (`packages/core/src/sessions/remote-stream.ts`), applied at the one `HubClient` construction in `ipc/server.ts` and gated on `authedRole === "remote"`. It is `HISTORY_EVENT_TYPES` **plus the transients** (history governs *persisted* replay; transients are never persisted, so history excludes them by construction — using history's set alone silently kills streaming). Two types are retained by necessity, not accident: `harness_attached`/`harness_detached` (the Gateway's replay **terminator** — filtering it burns a 5s watchdog per open, measured) and `session_created` (pinned by `IrohE2ETests` as a fresh session's first frame). **The Swift stack's apparent safety on `reasoning_item` is an accident of a missing protocol variant, not policy** — this daemon-side guard is what makes it policy, and is why the guard does not live in the Gateway.
- **Transient events are one shared constant**: `TRANSIENT_EVENT_TYPES` (`packages/protocol/src/events.ts`) ↔ Swift `SessionEvent.transientTypes`/`.isTransient`, with literal parity tests on both sides and a fixture-driven Swift equivalence test. `WinterClient`, `WinterSessionClient` and the remote-stream filter all **derive** from it — never hand-copy the strings (a hand-copy in `WinterSessionClient` is what dropped every `assistant_delta` on iOS: the daemon stamps transients with the store's `lastSeq`, so any client that dedupes them by seq drops all of them, forever, silently).
- **Protocol-checklist addendum:** a new **transient** variant must be added to `TRANSIENT_EVENT_TYPES` *and* to `REMOTE_STREAM_EVENT_TYPES`. Omitting the first drops it for every remote client, silently and permanently; the parity tests pin "exactly the current set" and will **not** catch that direction.

### Settings

`~/.winter/settings.json` is watched (`settings-watcher.ts`) and hot-swapped atomically; feature code reads live getters. **No setting may ever require a daemon restart to take effect** — new settings must follow the hot-reload pattern.

### Migration B (Phase 9c)

Migration B (Phase 9c): on first boot the daemon auto-migrates a legacy `~/.norma[-dev]` home into a pristine `~/.winter[-dev]` (absent, empty, or only empty bootstrap dirs) before creating anything else — `packages/core/src/migration/migrate-b.ts`'s `planMigrationB`/`runMigrationB`, invoked from `daemon.ts`'s boot hook. Auto-migration fires ONLY when the home resolves (`path.resolve`) to the profile's own default — `~/.winter` (dist) or `~/.winter-dev` (dev), via `winter-dir.ts`'s `isDefaultWinterHome` — regardless of how it arrived (`WINTER_HOME`, an explicit `home`, or the default); any other home (a temp dir, a custom `WINTER_HOME`, a CI/gate home) never auto-migrates, logs one line, and `winter migrate --from <legacyHome>` stays the explicit door for it. Every file copies byte-for-byte except the disposable set (`run/**`, `logs/**`, `cache/**`, `daemon.log`, `*.db-wal`/`*.db-shm` → skipped; `**/index.db` → left for the runtime to rebuild) and `settings.json` (re-keyed: legacy env-var names and `~/.norma[-dev]` path segments rewritten to their Winter equivalents, keys never renamed — `migration/rekey-settings.ts`); the known-name Keychain items (`auth/legacy-secret-names.ts`'s `MIGRATION_B_SECRET_NAMES`) copy from the legacy Keychain service to the current one, never overwriting an existing destination item. The manifest at `<home>/migration/manifest.json` is written atomically after every step (crash-safe); a home caught mid-migration refuses boot typed (`home_half_migrated`) until `winter migrate --resume` or `--rollback` runs — the daemon never auto-resumes. `winter migrate [--from <legacyHome>] [--status|--resume|--rollback] [--yes]` drives the same library by hand on any home (every writing action refuses while the daemon's lock is held); `winter migrate-project [dir] [--yes]` converts one project's `NORMA.md`/`.norma/` to `WINTER.md`/`.winter/` (`git mv` when tracked, content untouched). Until a project converts, Winter reads its unconverted instructions file/rules/output-styles/settings.json read-only when the Winter-named path is absent (`legacy.readLegacyProjectFiles`, default on, `legacyProjectFilesReadEnabled()`), with a one-line deprecation notice folded into the session's system context. `winter doctor` reports migration status, whether a legacy home is still present, and how many legacy Keychain items remain (a count only, never names or values).

### Tool surface

Tool design deliberately tracks Claude Code's shape (see `winter-vs-cc-tools.md` at repo root for the live comparison): file-based memory (a MEMDIR of markdown files written with normal write/edit — no dedicated memory tools), unrestricted reads (no path fence on read/glob/grep/ls; the sole read denial is `~/.winter/run`), out-of-root writes via an approval flow (grant denylist protects `~/.winter`), a single multi-purpose `lsp` tool (the `winter__lsp` capability server; auto-diagnostics-after-edit, the bash reviewer, plugin pre/post hooks and the diff-tab producer ride `Options.hooks` on BOTH legs since Phase 8c — `src/runtime-sdk/hooks.ts`), multimodal `read` (images/PDF/notebooks), and subagents with no wall-clock timeout — a progress-stall watchdog instead.

## Hard rules

- **Never kill or restart a running Winter.app or the user's live daemon.** Tests must never touch `~/.winter` — always point at a temp `WINTER_HOME`.
- **The user's live daily-driver install is `Winter.app` (`com.winter.app`) in `/Applications` on `~/.winter` with Keychain `com.winter.core` — Migration B ran on this machine on 2026-09-13 (the 0.2.015 handoff), so never launch, kill, restart, or write to any of them. A local Release build (`out/release/<version>/…/Winter.app`) carries the same bundle id and Launch Services can resolve `com.winter.app` to it at relaunch (measured on 2026-09-13): never launch one, and never delete an `out/release/<version>` tree while a Winter process runs from it. The legacy `Norma.app`/`~/.norma`/`com.norma.core` items stay untouched as the rollback source.** Tests must never resolve credentials against `com.winter.core`/`com.winter.core.dev` — every test daemon queries a throwaway Keychain service (the live install now holds real items there).
- **Never launch the dist app (`/Applications/Winter.app`, bundle `com.winter.app`, `~/.winter`) during development — dev work uses ONLY the dev app** ("Winter Dev", `com.winter.app.dev`, `~/.winter-dev`, Debug build with explicit `-derivedDataPath`). The dist copy is the user's daily driver, updated by Sparkle/brew; a Claude-launched dist instance is indistinguishable from it in the menu bar and defeats the entire dev/dist split. Same rule for local Release builds (`out/release/...`): build them, never launch them — a Release build under the same bundle id shadows the /Applications copy.
- Secrets live in the macOS Keychain (`Bun.secrets`, service `com.winter.core`) — never on disk, never in fixtures.
- `packages/core/src/providers/codex-config.ts` self-identifies as `originator: "winter"` — a deliberate ToS decision; do not revert to a first-party value.
- Version strings are generated; edit only `VERSION` via the bump/sync scripts.
- The Sparkle public key in `apple/Winter/project.yml` (`SUPublicEDKey`) is the production key; the private half exists only in the login Keychain — never committed anywhere.
