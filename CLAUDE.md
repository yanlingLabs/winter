# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

Winter is a macOS-native AI assistant: a TypeScript/Bun daemon (`winter-core`) plus a native Swift menu-bar app. They speak JSON-RPC 2.0 over NDJSON on a Unix socket (`<WINTER_HOME>/run/core.sock`; default home `~/.winter`). The daemon is the single source of truth; every client — CLI, Mac app, phone — is a view over its event stream.

**The daemon runs no agent loop of its own.** Every session is a spawned runtime child driven through the router (`@yanlinglabs/winter-runtime-sdk`), on one of two legs:

- the **Winter leg** — a `winter` binary from `@yanlinglabs/winter-agent-sdk`;
- the **official leg** — Anthropic's own `claude` binary from `@anthropic-ai/claude-agent-sdk`, used for Claude-catalog models in Code mode.

The daemon owns everything around that child: IPC, event-sourced session storage, settings, approvals/questions, the capability tools it hands the child over MCP, the hooks, and the SDK-message→`SessionEvent` projector. Session modes are `code`, `dispatch`, `chat` (`SessionMode`, `runtime-sdk/create.ts`).

## Commands

```sh
bun install                          # bun is the runtime; pnpm workspaces orchestrate

# Tests
pnpm test                            # every workspace, serially
cd packages/core && bun test         # one package
bun test path/to/file.test.ts        # one file (path substring match)
bun test -t "test name"              # one test by name
pnpm typecheck:core                  # tsc --noEmit (also typecheck:protocol)

# Protocol codegen — REQUIRED after changing packages/protocol/src/events.ts
pnpm protocol:generate               # JSON schema + per-variant fixtures, synced into the Swift test bundle

# Compiled-artifact gates (each builds a real binary; none runs under `bun test`)
bun run verify:workflow              # the sandboxed workflow worker on dist/winter-core
bun run verify:runtime-state         # the runtime-state spine on the compiled binary
bun run verify:runtimes              # the Release bundle's embedded runtimes

# Swift
cd apple/WinterProtocol && swift test  # fixture round-trip (asserts the exact fixture count)
cd apple/WinterKit && swift test       # daemon client + Gateway
cd apple/Winter && xcodegen generate && \
  xcodebuild -project Winter.xcodeproj -scheme Winter -destination 'platform=macOS' build

# CLI / daemon in dev
cd packages/cli
bun src/main.ts daemon run           # headless daemon
bun src/main.ts -p "hello"           # one-shot prompt (separate terminal)
bun src/main.ts                      # interactive TUI (Ink)
```

### Profiles — which daemon you are talking to

`WINTER_PROFILE=dev` selects the dev profile: default home `~/.winter-dev`, Keychain service `com.winter.core.dev`, app "Winter Dev" (`com.winter.app.dev`). The default `dist` profile is `~/.winter` + `com.winter.core` + `Winter.app` (`com.winter.app`) — the user's daily driver. `WINTER_HOME` overrides the home for either (`winter-dir.ts`); `profile.ts`'s `keychainService()` honours `WINTER_KEYCHAIN_SERVICE` only when the caller passes a home that is *not* the profile's default, which is how tests stay off the real Keychain.

```sh
WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev bun src/main.ts daemon run   # or: winter-dev daemon run
```

Two traps: a plain `winter` is the DIST CLI and, on a dead socket, auto-launches the dist app — never use it for dev or test work. Debug app builds embed neither `winter-core` nor the runtimes, so "Winter Dev" cannot spawn its own daemon; start the dev daemon first or the orb shows disconnected.

### Where the runtime binaries come from

`winter` (`runtime-sdk/executable.ts`, `resolveWinterExecutable`): `settings.runtimes.winterExecutable` → `$WINTER_RUNTIME_EXECUTABLE` → `<dirname(execPath)>/runtimes/winter` (Release bundle only) → `<WINTER_HOME>/runtimes/bin/winter` → the optional npm platform package `@yanlinglabs/winter-agent-sdk-darwin-arm64`. An explicit setting/env path is authoritative — if it is missing, that is the failure, never a fall-through to a different binary. The package rung refuses a version differing from `REQUIRED_WINTER_AGENT_SDK` (`runtime-sdk/versions.ts`) and is resolved *through the wrapper's own* `require`, because bun's isolated linker nests it under the wrapper. So a plain `bun install` is enough for a dev daemon.

`claude` (`runtime-sdk/official-executable.ts`): `settings.runtimes.claudeExecutable` → `$WINTER_CLAUDE_EXECUTABLE` → `<dirname(execPath)>/runtimes/claude-official/claude` (Release only, and gated on the `VERSIONS.json` staged beside it matching this build's pins) → the platform package under `node_modules` (dev only). A bare command name is refused: this leg never resolves the user's own install.

`ant` (`runtime-sdk/bundle-layout.ts`, `resolveAntExecutable`): `settings.runtimes.antExecutable` → `$WINTER_ANT_EXECUTABLE` → `<dirname(execPath)>/runtimes/ant/ant` → `$PATH` (skipped entirely in a compiled binary).

`bun run build:winter` builds `dist/winter` from a sibling `../winter-agent-sdk` checkout; point a daemon at it explicitly:

```sh
WINTER_RUNTIME_EXECUTABLE="$PWD/../../dist/winter" WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev bun src/main.ts daemon run
```

The spawned `winter` child reads the daemon's Keychain items itself, so macOS asks for consent once per credential item per binary identity — click "Always Allow", or the turn hangs until the CLI's stall watchdog fires (`WINTER_TURN_STALL_MS`, default 180 s). `build:winter --sign <identity>` (or `$WINTER_RUNTIME_SIGN_IDENTITY`) re-signs with the stable identifier `com.winter.runtime` so that ACL survives rebuilds; the npm binary is ad-hoc signed and re-prompts whenever `bun install` changes its bytes.

## Architecture

### Monorepo layout

- `packages/protocol` (`@yanlinglabs/winter-protocol`) — the contract: zod schemas for every JSON-RPC method (`methods.ts`) and `SessionEvent` variant (`events.ts`). `scripts/generate.ts` emits a JSON schema plus one canonical fixture per event variant and copies the event fixtures into the Swift test bundle; it never reads `methods.ts`.
- `packages/core` (`@yanlinglabs/winter-core`) — the daemon: `runtime-sdk/` (router handle in `create.ts`, leg dispatch in `session-driver.ts`, the official leg in `official-*.ts`, `Options` assembly in `mode-options.ts`, hooks in `hooks.ts`, model handoff in `handoff.ts`), `projector/`, `capabilities/`, `agent/` (approvals, gate, memory, skills, sandbox, LSP, and the daemon-owned tools in `agent/tools/`), `sessions/`, `runtime-state/`, `providers/` (the daemon's own internal model calls; Codex OAuth), `plugins/`, `routines/`, `workflows/`, `panel/`, `migration/`, `settings*.ts`.
- `packages/core/src/workflows/` — model-authored JS orchestration run in a **sandboxed subprocess**: the daemon self-spawns its own binary as `__workflow-worker` under a macOS seatbelt, with an NDJSON stdio bridge. Dev and compiled paths differ — `bun run verify:workflow` is the compiled-binary proof and must stay green.
- `packages/cli` (`@yanlinglabs/winter-cli`) — the `winter` command: Ink/React TUI, headless `-p`, launchd daemon lifecycle, and the `credentials` / `login` / `doctor` / `migrate` / `model` / `workflow` / … verbs.
- `packages/plugin-sdk` — what third-party plugins build against. Plugins are separate processes granted narrow, user-consented capabilities; `examples/battery-limiter` is the reference plugin.
- `apple/WinterProtocol` — Swift mirror of the protocol types; its round-trip test decodes and re-encodes every generated fixture and asserts the exact count.
- `apple/WinterKit` — the Swift daemon client (`WinterClient`), `WinterSessionKit` (phone-facing), and the `Gateway` that mediates the phone over Iroh.
- `apple/WinterChatKit` — the phone's own chat engine.
- `apple/Winter` — the menu-bar app (xcodegen `project.yml`, no committed pbxproj). Release builds embed `winter-core`, `WinterHelper`, and the three runtimes under `Contents/Resources/runtimes/` (`scripts/embed-runtimes.sh`).
- `scripts/release.ts` + `scripts/release-lib.ts` — the release pipeline; `packaging/winter.rb.tmpl` is the Homebrew cask template it renders.
- `docs/superpowers/` is git-ignored (private design docs); never reference it from a committed file.
- The iOS app lives in a **separate repo** (`yanlingLabs/winter-ios`, checked out beside this one as `../norma-ios`). It consumes `WinterProtocol` + `WinterSessionKit` + `WinterChatKit` through the root `Package.swift` pinned to a **git tag of this repo** (`v-<name>-kitN`). Editing Swift sources here does nothing for the phone until commit → push → new kit tag → the iOS project's `revision:` bump + `xcodegen generate`.

### Which leg a session runs on

`create.ts`'s `selectRuntimeFor` builds one `SelectionInput` — mode, requested model, the family listing derived from the pinned provider catalog, credential presence, whether the official peer loaded — and the router decides; `session-driver.ts` then assembles the child. Refusals are typed `WinterLegRefusal`s forwarded as the JSON-RPC error's `data.code` (`winter_executable_unavailable`, `claude_executable_unavailable`, `runtime_selection_refused` plus `data.reason`, `console_profile_missing`, …). There is never a silent fallback to another leg, another provider or another model. Chat and dispatch never reach the official leg.

### Providers and credentials

The credential inventory is **derived from the pinned catalog**, never a hand-kept list (`runtime-sdk/keychain.ts`, `credentialInventory()`): every catalog provider whose `authKinds` includes `api-key`, whose `risk.class` is not `blocked`, and which does not require the user's own endpoint gets a Keychain slot at `<providerId>:default`. Four rows are pinned at the front in order (`openai`, `codex-oauth`, `anthropic`, `anthropic:console`), because `providerSelectionFor` breaks a tie between providers serving the same bare model id by inventory order, preferring one whose credential is present.

The daemon **names** a credential and never reads it: `Options.provider.authRef` is a `{kind:"keychain", account, service}` locator the child resolves itself. Three RPCs manage slots — `credential.list`, `credential.set`, `credential.remove` — and on the terminal `winter credentials [list] | set <id> | remove <id>` (masked prompt only, never a flag, a pipe or an env var). `winter login --anthropic-key` / `--api-key` and `winter logout --anthropic` / `--openai` write the same slots. All of these go through the daemon whenever the socket is live, and a write that reaches the daemon **replaces every live child whose record names that provider** (`evictSessionsForCredential` — mid-turn children at their next idle boundary), so the key is in effect on the next turn with no restart. With no daemon running the CLI stores it and says so; live sessions pick it up at their next incarnation.

A session whose decided provider has no stored key refuses typed at the first turn (`runtime_selection_refused`, `data.reason: "no-credential"`) rather than a vendor 401 mid-turn. There is no daemon-side endpoint table and there must never be one: the catalog ships each provider's endpoints, and `settings.providers.<catalogId>.baseUrl` (`providerBaseUrlFor`) is the only override — hot, per provider. The legacy single-provider `settings.provider.baseUrl` keeps precedence for `openai`.

### The official leg's authentication

`runtimes.official.auth` is `auto` (default) | `api-key` | `console` (`officialAuthModeSetting`). `auto` picks the console profile when one exists at `<home>/runtimes/anthropic-config/credentials/winter.json` and falls back to the `anthropic:default` API-key material.

- **api-key** — the child is asserted to report `apiKeySource: "ANTHROPIC_API_KEY"`; a mismatch refuses typed (`official_auth_source_refused`) before any turn runs.
- **console** — the single login door is `ant auth login --profile winter` with `ANTHROPIC_CONFIG_DIR=<home>/runtimes/anthropic-config` (`winter login --anthropic-console`), driven by the SDK's own broker; the `claude` binary's own `auth login` is never used. The child gets exactly `ANTHROPIC_PROFILE`/`ANTHROPIC_CONFIG_DIR` and is asserted to report `apiKeySource: "none"`. A LIVE, uncached pre-spawn check refuses `console_profile_missing` on every spawn, because a missing profile silently falls back to whatever login is already stored in that config dir. `apiKeySource: "none"` is **not** a subscription discriminator — a claude.ai subscription login reports the identical value.

Every spawned `claude` child gets a Winter-owned `CLAUDE_CONFIG_DIR` (`officialConfigDirFor(home)` = `<home>/runtimes/claude-config`, created 0700) and an environment scrubbed of every other auth-injecting variable (`FORBIDDEN_CHILD_ENV`); `~/.claude` is unreachable from this leg. **claude.ai subscription auth is not shipped**: `officialSubscriptionAuthEnabled` ANDs `runtimes.official.subscriptionAuth` against the compile-time constant `OFFICIAL_SUBSCRIPTION_AUTH_APPROVED` (`runtime-sdk/versions.ts`, `false`), so flipping the setting alone is inert and logged once per settings change. Nothing in Winter may ever log `claude` into Winter's own `CLAUDE_CONFIG_DIR` — the console arm's login/logout door is `ant`, always.

### Switching model mid-session

`session.setModel` is an ordinary in-runtime change when the destination stays on the same leg and family. A change that crosses **families** (same leg included, e.g. gpt → deepseek) or **runtime legs** runs the router's pre-flight review first (`runtime-sdk/handoff.ts`):

- a lossy switch refuses typed (`handoff_confirmation_required`, carrying the warnings); `confirmLossy: true` is a one-shot confirmation for that call only and is never stored;
- a switch requested while a turn runs answers `deferred` and is applied at the next quiescent boundary — the stored model preference is not written until it lands;
- crossing legs is fenced by `runtimes.handoff.crossRuntime`, deliberately `.optional()` so an explicit `true`/`false` always wins; absent falls back to the mode-aware default in `handoffCrossRuntimeEnabled` — **ON for code**, off for chat/dispatch (which never reach the official leg anyway).

### The protocol change checklist

A new or changed **`SessionEvent` variant** touches, in order:

1. `packages/protocol/src/events.ts` — the zod schema.
2. `packages/protocol/scripts/generate.ts` — a canonical fixture for the variant.
3. `pnpm protocol:generate`.
4. `packages/core/src/projector/event-coverage.ts` — `PROJECTED_EVENT_COVERAGE` (`satisfies Record<SessionEvent["type"], boolean>`) is the one exhaustiveness map; core's `tsc` fails until it is updated.
5. `apple/WinterProtocol` — mirror the Swift type; the round-trip test asserts the exact fixture count, so it fails until synced.
6. `apple/WinterKit` — it has exhaustive `switch`es over variants (the `seq`/`sessionId` accessors); a new variant breaks compilation **there**, not in WinterProtocol.
7. Build WinterKit **and** the app, not just `swift test` in WinterProtocol — that is the only way to catch step 6.

A new **RPC method** engages none of steps 2-3 or 5 (`generate.ts` reads only `events.ts`): the zod schema in `methods.ts`, a handler in `ipc/server.ts`, the Swift call site if a Swift client needs it — plus the four remote mirrors below when it is remote-reachable.

**Adding a FIELD (not a variant) engages no compile-time trap at all**, so sweep the field's PRODUCERS BY MEANING, not by build breakage. `turn_completed.contextTokens` shipped correct on the daemon while `WinterChatKit`'s `ChatEngine` stayed a live second producer of the old shape, reaching the daemon's log verbatim through `sync.push` and past a consumer whose fallback accepted it. Ask: who else *writes* this event, in either language, and does the consumer silently accept their shape?

A new **transient** variant must be added to `TRANSIENT_EVENT_TYPES` *and* reach `REMOTE_STREAM_EVENT_TYPES` (which spreads that set, so membership is the edit). Omitting the first drops it for every remote client, silently and permanently; the parity tests pin "exactly the current set" and will **not** catch that direction.

### Event-sourced sessions

Every session is an append-only JSONL of `SessionEvent`s, each carrying `seq`/`sessionId`. Clients reconstruct state by replaying; the daemon rebroadcasts live events to attached harnesses. Provider `encrypted_content` / `reasoning_item.itemJson` is opaque: the session JSONL is its only sink — never log it, never write it into a model-readable transcript.

Durable per-session facts (the backend transcript id, provider, runtime kind, selection) live in `runtime-state.db` (`packages/core/src/runtime-state/`), which is why a resumed session re-reads its credential, model and connection at every incarnation.

### Remote surface & history (phone-facing)

- The remote-role method allowlist is **four hand-mirrored lists that move in lockstep**: `REMOTE_ALLOWED_METHODS` (`packages/core/src/ipc/server.ts`, currently 24 entries) + its literal parity test (`packages/core/test/ipc/remote-allowlist-parity.test.ts`) + Swift `Gateway.remoteAllowedMethods` (`apple/WinterKit/Sources/WinterKit/Gateway/Gateway.swift`) + its count test (`GatewayGateTests`). Adding a remote method is a deliberate edit to all four; the two tests are the drift tripwire. `REMOTE_ELIGIBLE_SESSION_MODES` (`code`/`dispatch`/`chat`) is a second, mode-level gate on every bare-`sessionId` method.
- `session.history` serves paged past events filtered by `HISTORY_EVENT_TYPES` (`packages/core/src/sessions/history.ts`) — an **allowlist, never a denylist**: `reasoning_item` must never pass it (a security sweep test pins this). Adding a type requires confirming the recursive per-event string cap bounds its large fields at every depth — the phone transport hard-fails on oversized frames, so an unbounded field is a silent connection-killer.
- The **live/replay** stream to a remote client is a *second* allowlist with the identical obligation: `REMOTE_STREAM_EVENT_TYPES` + `capEvent` (`packages/core/src/sessions/remote-stream.ts`), applied at the one `HubClient` construction in `ipc/server.ts` and gated on `authedRole === "remote"`. It is `HISTORY_EVENT_TYPES` ∪ `TRANSIENT_EVENT_TYPES` ∪ three stream-control types: history governs *persisted* replay and excludes transients by construction, so using history's set alone silently kills streaming. The three controls are retained by necessity — `harness_attached`/`harness_detached` are the Gateway's replay **terminator** (filtering them burns a 5 s watchdog per open) and `session_created` is pinned by `IrohE2ETests` as a fresh session's first frame. The Swift stack's apparent safety on `reasoning_item` is an accident of a missing protocol variant, not policy; this daemon-side guard is what makes it policy, which is why it does not live in the Gateway.
- **Transient events are one shared constant**: `TRANSIENT_EVENT_TYPES` (`packages/protocol/src/events.ts`, 11 types) ↔ Swift `SessionEvent.transientTypes`/`.isTransient`, with literal parity tests on both sides and a fixture-driven Swift equivalence test. `WinterClient`, `WinterSessionClient` and the remote-stream filter all **derive** from it — never hand-copy the strings. The daemon stamps a transient with the store's current `lastSeq`, so any client that dedupes them by seq drops all of them, forever, silently.

### Settings

`<WINTER_HOME>/settings.json` is watched (`settings-watcher.ts`: debounced, single-flight, keep-last-good on a torn file) and swapped atomically by `settings-apply.ts`; feature code reads live getters, never a boot snapshot. **No setting and no credential change may ever require a daemon restart.** Concretely: the daemon's own reads go live on the next call; a live runtime child keeps the `Options` it was spawned with and picks up new settings at its next incarnation (`optionsFor` re-reads `deps.settings()` every time) — the one exception is a credential write through the daemon, which evicts the affected children resumably so the next turn is already on the new material. New settings follow the same shape: an `.optional()` block with its default spelled in exactly one reader function (`handoffCrossRuntimeEnabled`, `legacyProjectFilesReadEnabled`, `providerBaseUrlFor`, `officialAuthModeSetting`, `winterOptionsFromSettings`, …), because an absent block never materializes zod's per-key defaults.

### Migration from the legacy home

On first boot the daemon migrates a legacy `~/.norma[-dev]` home into a pristine `~/.winter[-dev]` (absent, empty, or only empty bootstrap dirs) before creating anything else — `migration/migrate-b.ts`'s `planMigrationB`/`runMigrationB`, from `daemon.ts`'s boot hook. Auto-migration fires **only** when the home resolves to the profile's own default (`winter-dir.ts`'s `isDefaultWinterHome`), however it arrived; any other home (a temp dir, a custom `WINTER_HOME`, a CI home) logs one line and needs the explicit `winter migrate --from <legacyHome>`. Files copy byte-for-byte except the disposable set (`run/**`, `logs/**`, `cache/**`, `daemon.log`, `*.db-wal`/`*.db-shm` skipped; any `index.db` left for the runtime to rebuild) and `settings.json`, which is re-keyed (`migration/rekey-settings.ts` rewrites legacy env-var names and `~/.norma[-dev]` path segments; keys are never renamed). The known-name Keychain items (`auth/legacy-secret-names.ts`'s `MIGRATION_B_SECRET_NAMES`) copy from the legacy service to the current one, never overwriting an existing destination item. `<home>/migration/manifest.json` is written atomically after every step; a home caught mid-migration refuses boot typed (`home_half_migrated`) until `winter migrate --resume` or `--rollback` runs — the daemon never auto-resumes. `winter migrate-project [dir]` converts one project's `NORMA.md`/`.norma/` to `WINTER.md`/`.winter/` (`git mv` when tracked, content untouched). Until a project converts, Winter reads its legacy instructions file, rules, output styles and settings read-only when the Winter-named path is absent (`legacy.readLegacyProjectFiles`, default on), with a one-line deprecation notice folded into the session's system context. `winter doctor` reports migration status and a count — never names or values — of remaining legacy Keychain items.

### Tool surface

Tool design deliberately tracks Claude Code's shape; `winter-vs-cc-tools.md` at the repo root is the live comparison.

The child brings the file, shell and search tools. The **daemon** contributes its own as in-process MCP servers named `winter__<key>` (`capabilities/`), which the child sees as `mcp__winter__<key>__<tool>` — the keys are `sessions`, `computer`, `browser`, `office`, `research`, `web`, `lsp`, `external` (plugin-contributed, dynamic per plugin). Per-mode exposure is `disallowedToolsFor` (`mode-options.ts`).

Hooks ride `Options.hooks` on **both** legs from one builder: `runtime-sdk/hooks.ts`'s `sessionHooksFor` returns `{winter, official}` as the same object — plugin pre/post/failure hooks, the bash safety reviewer (gated to the `auto` policy), diagnostics-after-edit, and the `fileDiff` producer behind the diff tabs.

Reads are deliberately unfenced except for the daemon's own state: `Read`/`Glob`/`Grep` deny `<home>/run` and `<home>/runtimes` plus the SDK's `claude-resume-*` staging dirs, and the bash sandbox mirrors that (`sandboxConfigFor`'s `denyRead`/`denyWrite`). Writes additionally deny the three control-plane filenames (`permissions.local.json`, `settings.json`, `settings.local.json`) at any depth in any project as well as the user's global copies — writing one is a self-grant. A call the gate cannot allow outright raises an approval card in Code mode through `canUseTool` (`runtime-sdk/approval-bridge.ts`) and is a typed deny in dispatch/chat; session policies are `plan | dont-ask | ask | accept-edits | auto | bypass`, plus chat's immutable `chat`. Memory is file-based (a MEMDIR of markdown written with ordinary write/edit — no dedicated memory tools). Subagents have no wall-clock timeout; a progress-stall watchdog replaces it.

## Versioning & release

`VERSION` is canonical and is never edited by hand. The format is `#.###.#` — major, a three-digit feature counter, a single-digit patch (e.g. `0.112.0`); the first digit moves only for a rebrand-scale event.

```sh
bun run version:bump                 # patch +1 (throws past 9 — use a feature bump)
bun run version:bump:feature         # feature +1, patch -> 0 (also version:bump:major)
bun run version:sync                 # restamp version.ts / package.jsons / plists from VERSION

bun run scripts/release.ts --dry-run --no-bump   # full rehearsal: builds, notarizes, staples, never publishes
bun run scripts/release.ts                       # real release (bumps the version first)
```

## Hard rules

- **Never kill, restart, launch or write to a running Winter.app or the user's live daemon.** The daily driver is `Winter.app` (`com.winter.app`) in `/Applications` on `~/.winter` with Keychain `com.winter.core`. A local Release build (`out/release/<version>/…/Winter.app`) carries the same bundle id and Launch Services can resolve `com.winter.app` to it at relaunch: build Release copies, never launch one, and never delete an `out/release/<version>` tree while a Winter process runs from it. The legacy `Norma.app` / `~/.norma` / `com.norma.core` items stay untouched as the rollback source.
- **Dev work uses only the dev app** — "Winter Dev" (`com.winter.app.dev`, `~/.winter-dev`, a Debug build with an explicit `-derivedDataPath`). A Claude-launched dist instance is indistinguishable from the user's own in the menu bar and defeats the entire dev/dist split.
- **Tests never touch `~/.winter*`, `~/.claude*`, or the real Keychain.** Always point at a temp `WINTER_HOME`; every test daemon resolves credentials against a throwaway Keychain service (`packages/core/test/preload.ts` sets `WINTER_KEYCHAIN_SERVICE`), never `com.winter.core` / `com.winter.core.dev`, which hold the user's real items.
- Secrets live in the macOS Keychain (`Bun.secrets`, service `com.winter.core`) — never on disk, never in fixtures, never in a log line or an error message.
- `packages/core/src/providers/codex-config.ts` self-identifies as `originator: "winter"` — a deliberate ToS decision; do not revert it to a first-party value.
- Version strings are generated; edit only `VERSION`, through the bump/sync scripts.
- The Sparkle public key in `apple/Winter/project.yml` (`SUPublicEDKey`) is the production key; the private half exists only in the login Keychain — never committed anywhere.
