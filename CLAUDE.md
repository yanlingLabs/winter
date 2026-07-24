# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Norma is a macOS-native AI assistant: a TypeScript/Bun daemon (`norma-core`) that runs the agent loop, plus a native Swift menu-bar app that gives it a face. They talk JSON-RPC 2.0 over NDJSON on a Unix socket (`~/.norma/run/core.sock`). The daemon is the single source of truth; every client (CLI, app) is a view over its event stream.

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

# Workflows e2e — proves the sandboxed runtime on the REAL compiled artifact (dist/norma-core)
bun run verify:workflow

# Swift
cd apple/NormaProtocol && swift test # protocol mirror round-trip tests
cd apple/NormaKit && swift test      # daemon client library
cd apple/Norma && xcodegen generate && \
  xcodebuild -project Norma.xcodeproj -scheme Norma -destination 'platform=macOS' build

# Run the daemon + CLI in dev
cd packages/cli
bun src/main.ts daemon run           # headless daemon
bun src/main.ts -p "hello"           # one-shot prompt (separate terminal)
bun src/main.ts                      # interactive TUI (Ink)

# Dev profile: the Debug app is "Norma Dev" (com.norma.app.dev) on ~/.norma-dev; the global
# `norma-dev` command (installed by the dev app's menu) is an env-setting bun wrapper. The
# distribution app owns `norma` (symlink installed from the app / brew). Explicit NORMA_HOME
# always wins over both defaults.
NORMA_HOME=~/.norma-dev NORMA_PROFILE=dev bun src/main.ts daemon run   # dev daemon (or: norma-dev daemon run)

# Versioning — never edit versions by hand; VERSION file (#.#.### format) is canonical
bun run version:bump                 # +0.0.001 (also --minor / --major)
bun run version:sync                 # restamp package.jsons/plists from VERSION

# Release (one command → signed, notarized, stapled zip+DMG+appcast+cask+gh release)
bun run scripts/release.ts --dry-run --no-bump   # full rehearsal, never publishes
bun run scripts/release.ts                       # real release (bumps version first)
```

## Architecture

### Monorepo layout

- `packages/protocol` — the contract. Zod schemas for every JSON-RPC method and `SessionEvent` variant. `generate.ts` emits a JSON schema + canonical fixtures consumed by the Swift side.
- `packages/core` — the daemon. Agent loop (`src/agent/engine.ts`), tools (`src/agent/tools/`), providers (`src/providers/` — OpenAI-compatible API + Codex OAuth), event-sourced sessions (`src/sessions/`), plugin supervisor (`src/plugins/`), settings hot-reload (`src/settings-watcher.ts`), routines/scheduling (`src/routines/`).
- `packages/core/src/workflows/` — the workflows runtime: model-authored JS orchestration scripts run in a **sandboxed subprocess** (the daemon self-spawns its own binary as `__workflow-worker` under a macOS seatbelt; NDJSON stdio bridge). Dev and compiled paths differ — `bun run verify:workflow` is the compiled-binary proof and must stay green.
- `packages/cli` — the `norma` command: Ink/React TUI, headless `-p` mode, daemon lifecycle (launchd).
- `packages/plugin-sdk` — what third-party plugins build against. Plugins are separate processes granted narrow, user-consented capabilities; `examples/battery-limiter` is the complete reference plugin.
- `apple/NormaProtocol` — Swift mirror of the protocol types. Its tests decode/re-encode every TS-generated fixture and assert the exact fixture count.
- `apple/NormaKit` — Swift client for the daemon socket.
- `apple/Norma` — the menu-bar app (xcodegen `project.yml`, no committed pbxproj). Embeds `norma-core` and `NormaHelper` in Release builds.
- `scripts/release.ts` + `scripts/release-lib.ts` — the release pipeline; `packaging/norma.rb.tmpl` is the Homebrew cask template it renders.
- `norma/` at the repo root is a Phase-0 Xcode scaffold leftover — **not** the real app. The real app is `apple/Norma`.
- `docs/superpowers/` is git-ignored (private design docs); don't reference it from committed code.
- The iOS companion lives in a **sibling repo** (`../norma-ios`) and consumes `NormaProtocol` + `NormaSessionKit` as a remote SPM package pinned to a **git tag of this repo** (`v-*-kitN`, exposed via the root `Package.swift`). Editing Swift kit sources here does nothing for the phone until commit → push → new kit tag → `norma-ios/project.yml` `revision:` bump + `xcodegen generate`.

### The protocol change checklist

Adding/changing a `SessionEvent` variant or RPC method touches, in order:

1. `packages/protocol/src/events.ts` (or `methods.ts`) — zod schema
2. `packages/protocol/scripts/generate.ts` — add a canonical fixture for the new variant
3. `pnpm protocol:generate`
4. `packages/core/src/agent/subagent-transcript.ts` — its `satisfies Record<SessionEvent["type"], boolean>` exhaustiveness map fails core's `tsc` on a new variant until updated
5. `apple/NormaProtocol` — mirror the Swift type; round-trip test asserts the fixture count, so it fails until synced
6. `apple/NormaKit` — it has exhaustive `switch`es over event variants (e.g. the `seq`/`sessionId` accessors); a new variant breaks compilation there, **not** in NormaProtocol
7. Build NormaKit **and** the app, not just `swift test` in NormaProtocol — that's the only way to catch step 6

### Event-sourced sessions

Every session is an append-only JSONL of `SessionEvent`s (each carrying `seq`/`sessionId`). Clients reconstruct state by replaying; the daemon rebroadcasts live events to attached harnesses. Provider `encrypted_content` / `reasoning_item.itemJson` is opaque: the session JSONL is its only sink — never log it or write it into model-readable transcript files.

### Remote surface & history (phone-facing)

- The remote-role method allowlist is **four hand-mirrored lists that move in lockstep**: `REMOTE_ALLOWED_METHODS` (`packages/core/src/ipc/server.ts`) + its literal parity test (`packages/core/test/ipc/remote-allowlist-parity.test.ts`) + Swift `Gateway.remoteAllowedMethods` (`apple/NormaKit/Sources/NormaKit/Gateway/Gateway.swift`) + its count test (`GatewayGateTests`). Adding a remote method is a deliberate edit to all four; the two tests are the drift tripwire.
- `session.history` serves paged past events filtered by `HISTORY_EVENT_TYPES` (`packages/core/src/sessions/history.ts`) — an **allowlist, never a denylist**: `reasoning_item` must never pass it (a security sweep test pins this). Adding a type requires confirming the recursive per-event string cap bounds its large fields at every depth — the phone transport hard-fails on oversized frames, so an unbounded field is a silent connection-killer.

### Settings

`~/.norma/settings.json` is watched (`settings-watcher.ts`) and hot-swapped atomically; feature code reads live getters. **No setting may ever require a daemon restart to take effect** — new settings must follow the hot-reload pattern.

### Tool surface

Tool design deliberately tracks Claude Code's shape (see `norma-vs-cc-tools.md` at repo root for the live comparison): file-based memory (a MEMDIR of markdown files written with normal write/edit — no dedicated memory tools), unrestricted reads (no path fence on read/glob/grep/ls; the sole read denial is `~/.norma/run`), out-of-root writes via an approval flow (grant denylist protects `~/.norma`), a single multi-purpose `lsp` tool plus auto-diagnostics-after-edit, multimodal `read` (images/PDF/notebooks), and subagents with no wall-clock timeout — a progress-stall watchdog instead.

## Hard rules

- **Never kill or restart a running Norma.app or the user's live daemon.** Tests must never touch `~/.norma` — always point at a temp `NORMA_HOME`.
- Secrets live in the macOS Keychain (`Bun.secrets`, service `com.norma.core`) — never on disk, never in fixtures.
- `packages/core/src/providers/codex-config.ts` self-identifies as `originator: "norma"` — a deliberate ToS decision; do not revert to a first-party value.
- Version strings are generated; edit only `VERSION` via the bump/sync scripts.
- The Sparkle public key in `apple/Norma/project.yml` (`SUPublicEDKey`) is the production key; the private half exists only in the login Keychain — never committed anywhere.
