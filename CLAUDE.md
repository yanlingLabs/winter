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
# Every daemon (app-launched or `daemon run`) tees its stdout/stderr into <WINTER_HOME>/logs/daemon.log (8 MB, one rotation);
# `winter doctor` prints the path. Grep it before reproducing anything.
# The "built binary through a real daemon" e2e files (test/e2e/winter-{chat,code,dispatch}-e2e, official-leg.e2e)
# need WINTER_RUNTIME_EXECUTABLE="$PWD/dist/winter" (built by `bun run build:winter`); without it the daemon
# resolves the npm platform binary and the pid scan for dist/winter FAILS rather than skips.
# Every daemon boot merges the user's login-shell PATH into its own (core/src/login-shell-path.ts);
# WINTER_LOGIN_SHELL_PATH=off (or 0/false) skips it — both test preloads set it, so no test runs your real shell.
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

The home and the profile are set INDEPENDENTLY, and the home is profile-blind: `resolveWinterHome()` reads only `WINTER_HOME` and defaults to `~/.winter` — the user's live daily driver (`winter-dir.ts`). `WINTER_PROFILE=dev` changes only the Keychain service (`com.winter.core.dev`) and the app identity ("Winter Dev", `com.winter.app.dev`); it does NOT move the home. So `WINTER_PROFILE=dev` alone would run dev-profile tooling against `~/.winter` — always set BOTH (`WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev …`). The `~/.winter-dev` convention is supplied by the `winter-dev` wrapper script (it exports `WINTER_HOME` for you), not by core code. The `dist` profile is `~/.winter` + `com.winter.core` + `Winter.app` (`com.winter.app`). `profile.ts`'s `keychainService()` honours `WINTER_KEYCHAIN_SERVICE` only when the caller passes a home that is *not* the profile's default, which is how tests stay off the real Keychain.

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

The credential inventory is **derived from the pinned catalog**, never a hand-kept list (`runtime-sdk/keychain.ts`, `credentialInventory()`): every catalog provider whose `authKinds` includes `api-key`, whose `risk.class` is not `blocked`, and which does not require the user's own endpoint gets a Keychain slot at `<providerId>:default`. Four rows are pinned at the front (`openai`, `codex-oauth`, `anthropic`, `anthropic:console`); since WS-20 their order carries no meaning — a session names its provider in the tag. A model is always a provider-qualified tag (`codex-oauth/gpt-5.6-terra`); `providerFor(tag)` names the credential and nothing in the daemon selects a provider for a bare id (WS-20).

The daemon **names** a credential and never reads it: `Options.provider.authRef` is a `{kind:"keychain", account, service}` locator the child resolves itself. Three RPCs manage slots — `credential.list`, `credential.set`, `credential.remove` — and on the terminal `winter credentials [list] | set <id> | remove <id>` (masked prompt only, never a flag, a pipe or an env var). `winter login --anthropic-key` / `--api-key` and `winter logout --anthropic` / `--openai` write the same slots. All of these go through the daemon whenever the socket is live, and a write that reaches the daemon **replaces every live child whose record names that provider**, or whose cross-provider advisor pin does (`evictSessionsForCredential` — mid-turn children at their next idle boundary), so the key is in effect on the next turn with no restart. With no daemon running the CLI stores it and says so; live sessions pick it up at their next incarnation.

Two rows are daemon TOOL keys rather than provider credentials (raw values under their own long-standing secret names, `TOOL_ROWS` in `runtime-sdk/credentials.ts`). **`exa` is the exception to "a tool key evicts nothing"**: since the Exa key is named on a spawn (`Options.web.search.authRef`) *and* decides the tool surface, a write through the daemon evicts every **Winter-leg** child resumably, and `winter login --exa-key` goes through the daemon like a provider key. **`web-search`** (the Brave key) is retired: nothing reads it, `credential.set` refuses it typed, the row is listed only when something is actually stored and then only as removable (`manageable: false`), and `winter login --web-search-key` is a one-line deprecation notice.

A session whose decided provider has no stored key refuses typed at the first turn (`runtime_selection_refused`, `data.reason: "no-credential"`) rather than a vendor 401 mid-turn. There is no daemon-side endpoint table and there must never be one: the catalog ships each provider's endpoints, and `settings.providers.<catalogId>.baseUrl` (`providerBaseUrlFor`) is the only override — hot, per provider. The legacy single-provider `settings.provider.baseUrl` is gone (WS-20): the v2→v3 settings migration copies a stored value into `providers.openai.baseUrl` once.

### The daemon's own background jobs

Session titles, the bash safety reviewer, the dreamer and the session cleaner are the daemon's OWN model calls — not a session, not a runtime child. They run through `providers/internal-router.ts`'s `resolve(role, settings)`, which answers `{provider, model, tag, effort}` or a typed refusal; the four consumers (`agent/titles.ts`, `agent/reviewer.ts`, `agent/dreamer.ts`, `sessions/cleaner.ts`) each take that one seam and skip their run on a refusal.

**They are decoupled from `settings.provider.model`** (2026-09-19). Which providers they can run on is `internalEligibleProviderIds()` (`settings.ts`): every catalog provider that is an ordinary model-role candidate (`permittedProviders()`'s floor), has a Keychain slot in `credentialInventory()`, whose adapter family the daemon can drive (`providers/internal-adapters.ts`'s table — bedrock/vertex are out because their `aws`/`gcp-*` material is refused by `credential-store.ts`; xai-oauth has no Winter login door; azure/oci/local are `requiresUserEndpoint`), and that is **not a first-party Claude provider** (`anthropic`/`console`/`cc` — the user's ruling: Claude runs through Anthropic's own runtime, which brings its own reviewer). That is an exclusion by provider ID, never by adapter family: `deepseek-anthropic`, `zai-anthropic` and friends merely speak the dialect and stay eligible.

A role with no explicit pin resolves through `internalRoleEffectiveTag`, and **Winter never chooses a model on a provider the user did not choose**: (1) `settings.provider.model`'s provider when it is eligible AND credentialed — its `terra`/`luna` family slot if it declares one, else `provider.model` itself (so a DeepSeek user with a DeepSeek key gets titles on DeepSeek with zero setup); (2) else a credentialed `codex-oauth`/`openai`, which both declare the slots; (3) else **no default at all** — the role reports `no-default-model` and is inert until the user pins one. A first draft had a rung picking "the provider's first non-blocked llm row"; measurement killed it (only 3 of 94 eligible providers declare a `terra` slot, and that rung chose things like `agentrouter/claude-opus-4-8` and a vision model). Never Claude at any rung.

Effort: the SDK's `mapEffort` validates against real descriptors, and `internalWireEffortFor` maps a role's effort onto the row it is about to run on and **drops** what the row cannot take — an unmappable non-`"none"` effort (e.g. the dreamer's `"medium"` on a row whose vocabulary omits it) is dropped rather than falling through to `implicitEffortFor`'s ordinary rule. `"none"` has its own rule (2026-09-22, after a dist cleaner/title timeout storm): a row with no effort vocabulary still sends nothing; a row whose vocabulary lists `"none"` itself still has it dropped (what those endpoints do with a literal `"none"` is unmeasured); but a row that reasons without a `"none"` tier is sent its **lowest declared effort** — never dropped to silence, because an effortless request lets the provider's own default (`"medium"` on `codex-oauth/gpt-5.6-luna`) escalate past what a role pinned to `"none"` for speed asked for. A failed cleaner judgment is not retried for 30 minutes (`CLEANER_RETRY_BACKOFF_MS`).

Quota is **one `QuotaManager` per provider** (`InternalRouter.quotaFor`), keyed like the `Provider` cache: a Codex usage-limit 429 carries an hour-scale retry-after and a shared ledger's `limitedUntil` would stall a healthy DeepSeek role. `daemon.status`/`sync.config` read the **`codex-oauth` ledger**, created at boot (`daemon.ts` reads `internalRouter.quota` once, with the map empty) — so a codex user's status is unchanged, and a non-codex home shows an inert zero/ok ledger, which is what it showed before this branch too. Token counters are one provider's alone, never a cross-vendor sum.

`winter login` (ChatGPT/Codex) and bare `winter logout` write `codex-oauth:default` **in-process** and cannot use `credential.set`, so the snapshot has two other carriers: the CLI pokes a live daemon through `credential.list` (whose handler reconciles the view), and the router self-heals — `view.refreshSoon()` (non-blocking, one probe per 30 s) on `no-internal-credential`, on `no-default-model`'s sibling refusals, on any `auth`-classified failure of the titler, the reviewer, the dreamer or the cleaner, and once per dreamer tick.

`providers/internal-view.ts` holds the ONE mutable fact — which eligible providers hold material — seeded from the boot probe and refreshed inside `credential.set`/`credential.remove` before they return. The wire, the default-tag readers and the dispatcher all derive from that snapshot synchronously, which is how they cannot disagree; a per-provider `Provider` instance is cached against `view.generation()` and the resolved base URL. One log line per change, never per call. `INTERNAL_PROVIDER_IDS` no longer gates anything — it survives only as the preference-order head.

Three `problem` reasons on `settings.modelRoles` are **derived, never persisted** (`providers/internal-role-problems.ts`): `provider-unsupported` (an explicit pin on a provider Winter's jobs cannot use), `no-internal-credential` (nothing eligible is credentialed) and `no-default-model` (something IS credentialed, but Winter will not name a model on it — the fix is a pin, not a key). A per-provider `no-credential` is the pre-existing reason, reused. They take precedence over a recorded `role-health.json` note and clear themselves the moment the condition clears. `setModelRole` refuses an internal role's tag only on the permanent facts and accepts an eligible provider whose key has not arrived yet (which then reports the pre-existing `no-credential`).

Effort is normalised at the boundary: the SDK's `mapEffort` validates against real descriptors and refuses both `"none"` on an openai/codex row and the dreamer's `"medium"` on a deepseek row, so `internalWireEffortFor` maps the effort onto the row — dropping an unmappable non-`"none"` effort, and sending the row's own lowest declared tier for a role's `"none"` (above). **Turn compaction is vestigial** — `agent/compactor.ts` has no production construction site (the runtime child compacts itself; `session.compact` answers `not_supported_on_winter_leg`), so it is not one of these jobs.

### The official leg's authentication

The arm is the tag's prefix: `anthropic/*` = API key, `console/*` = the Console profile, `cc/*` reserved.

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

`<WINTER_HOME>/settings.json` is watched (`settings-watcher.ts`: debounced, single-flight, keep-last-good on a torn file) and swapped atomically by `settings-apply.ts`; feature code reads live getters, never a boot snapshot. **No setting and no credential change may ever require a daemon restart.** Concretely: the daemon's own reads go live on the next call; a live runtime child keeps the `Options` it was spawned with and picks up new settings at its next incarnation (`optionsFor` re-reads `deps.settings()` every time) — the one exception is a credential write through the daemon, which evicts the affected children resumably so the next turn is already on the new material. New settings follow the same shape: an `.optional()` block with its default spelled in exactly one reader function (`handoffCrossRuntimeEnabled`, `legacyProjectFilesReadEnabled`, `providerBaseUrlFor`, `pinsFor`, `winterOptionsFromSettings`, …), because an absent block never materializes zod's per-key defaults.

### Migration from the legacy home

On first boot the daemon migrates a legacy `~/.norma[-dev]` home into a pristine `~/.winter[-dev]` (absent, empty, or only empty bootstrap dirs) before creating anything else — `migration/migrate-b.ts`'s `planMigrationB`/`runMigrationB`, from `daemon.ts`'s boot hook. Auto-migration fires **only** when the home resolves to the profile's own default (`winter-dir.ts`'s `isDefaultWinterHome`), however it arrived; any other home (a temp dir, a custom `WINTER_HOME`, a CI home) logs one line and needs the explicit `winter migrate --from <legacyHome>`. Files copy byte-for-byte except the disposable set (`run/**`, `logs/**`, `cache/**`, `daemon.log`, `*.db-wal`/`*.db-shm` skipped; any `index.db` left for the runtime to rebuild) and `settings.json`, which is re-keyed (`migration/rekey-settings.ts` rewrites legacy env-var names and `~/.norma[-dev]` path segments; keys are never renamed). The known-name Keychain items (`auth/legacy-secret-names.ts`'s `MIGRATION_B_SECRET_NAMES`) copy from the legacy service to the current one, never overwriting an existing destination item. `<home>/migration/manifest.json` is written atomically after every step; a home caught mid-migration refuses boot typed (`home_half_migrated`) until `winter migrate --resume` or `--rollback` runs — the daemon never auto-resumes. `winter migrate-project [dir]` converts one project's `NORMA.md`/`.norma/` to `WINTER.md`/`.winter/` (`git mv` when tracked, content untouched). Until a project converts, Winter reads its legacy instructions file, rules, output styles and settings read-only when the Winter-named path is absent (`legacy.readLegacyProjectFiles`, default on), with a one-line deprecation notice folded into the session's system context. `winter doctor` reports migration status and a count — never names or values — of remaining legacy Keychain items.

### Tool surface

Tool design deliberately tracks Claude Code's shape; `winter-vs-cc-tools.md` at the repo root is the live comparison.

The child brings the file, shell, search **and web** tools. The **daemon** contributes its own as in-process MCP servers named `winter__<key>` (`capabilities/`), which the child sees as `mcp__winter__<key>__<tool>` — the keys are `sessions`, `computer`, `browser`, `office`, `research`, `lsp`, `external` (plugin-contributed, dynamic per plugin). Per-mode exposure is `disallowedToolsFor(mode, exposure, …)` (`mode-options.ts`), which takes the **leg** as a required argument.

**The web surface is the child's `WebFetch`/`WebSearch` on both legs** (the 2026-09-18 ruling; the daemon's own `web_fetch`/`web_search`/`ReadPage` and its multi-page research sub-agent are retired, and the `winter__web` server is gone). The daemon supplies what a built-in cannot reach by itself through `Options.web` (`webOptionsFor`, Winter leg only): the Exa key as a Keychain **locator**, `pins.research` as `WebFetch`'s page-digest model (dropped rather than stated when it cannot resolve), and the dangerous-domain floor as `blockedDomains`. The official leg is sent no web block at all: claude's NATIVE tools are kept, but their approvals are Winter's — every `canUseTool` request lands on the daemon's bridge, where a public web read is free and silent (the `NETWORK` class), a private/loopback target raises a card in code and is a typed deny wherever nobody can answer one (`privateWebFetchTarget`, the only private-address floor on that leg), and the dangerous-domain floor hard-blocks through the shared hooks.

The one daemon-owned web tool left is chat's and dispatch's **`Search`** (Exa ANSWER mode — `POST https://api.exa.ai/answer`, the key in the `x-api-key` header, a written answer plus its sources, the floor applied to cited urls). `/answer` cannot be called anonymously, so **exactly one of `Search` / `WebSearch` is exposed to chat and dispatch**, decided by whether an Exa key is stored: `exaKeyPresent(store)` (`runtime-sdk/credentials.ts`) is read once per incarnation and drives BOTH the capability-server build (`capabilities/research.ts`, via `CapabilitySession.exaKeyPresent`) AND `disallowedToolsFor` AND the chat/dispatch base prompts (`chatSystemPrompt`/`dispatchSystemPrompt`). Absent reads as "a key is stored" at every one of those doors. Both halves of the tool gate are required: a `disallowedTools` string naming a tool the server never advertised denies nothing, silently, and the reverse offers nothing, also silently.

**All of that is the DAEMON's chat, not the phone's.** Chat started on the iPhone runs `apple/WinterChatKit`'s own engine (Chat Slice D), which is a live SECOND producer of `Search` — still on Exa's `/search` shape with `numResults`, and still shipping its own `ReadPage`/research runner — and it has no `WebSearch`/`WebFetch` at all, so the "no Exa key falls back to `WebSearch`" rule does not hold there. Any statement about which web tools chat has must say which engine it means until a kit tag brings the phone along.

Hooks ride `Options.hooks` on **both** legs from one builder: `runtime-sdk/hooks.ts`'s `sessionHooksFor` returns `{winter, official}` as the same object — plugin pre/post/failure hooks, the bash safety reviewer (gated to the `auto` policy), diagnostics-after-edit, the `fileDiff` producer behind the diff tabs, the **sandbox-escape floor** (below), and the dangerous-domain floor for `WebFetch`/`WebSearch` (registered last; a deny for a floor-listed `WebFetch` url, the floor injected into `WebSearch`'s `blocked_domains` — the only enforcer on the official leg, where the child's tools are claude's own).

Reads are deliberately unfenced except for the daemon's own state: `Read`/`Glob`/`Grep` deny `<home>/run` and `<home>/runtimes` plus the SDK's `claude-resume-*` staging dirs, and the bash sandbox mirrors that (`sandboxConfigFor`'s `denyRead`). **Writes are denied to every self-grant path**, on both legs, by the write-tool deny rules (`controlPlaneDenyRules`) and the bash sandbox's `denyWrite` (`sandboxConfigFor(home, cwd)`): the three control-plane filenames (`permissions.local.json`, `settings.json`, `settings.local.json`) at any depth in any project and the user's global copies, agent definitions (`<home>/agents` and any `.winter/agents` — the sandbox, which takes only real paths, names the session's own `<cwd>/.winter/agents`), `<home>/run`, `<home>/runtimes`, `<home>/plugins`, `<home>/permissions`, all of `<home>/cache` and `<home>/trust.json`. `sandboxConfigFor`'s `denyWrite` is the one list the escape floor derives from (`runtime-sdk/home-fence.ts`), so a new self-grant path goes there.

A **sandbox escape** (`Bash` with `dangerouslyDisableSandbox`) follows claude's rule, not an always-card: deny rules, the permission mode, allow rules, then the approval bridge. On top, on both legs: the escape floor hook denies any escape that touches a fenced path under **every** policy, `bypass` included; and under `auto` an escape runs only on the bash reviewer's positive clearance for that call (reviewed with the unsandboxed premise — no reviewer, no model, a transient failure or a missing call id is a card in code and a typed deny in dispatch). Saved rules decide an escape on the official leg today; the Winter leg's pinned agent SDK 0.0.17 still makes every escape a mandatory interaction, until 0.0.18 is pinned.

**Saved allow rules reach the child on both legs** as `Options.permissions.allow` (code mode only; `persistedAllowRulesFor` → `sdkAllowRulesFor`, the one translation into claude's grammar, never wider than what was saved; deny still wins), read live per incarnation: `settings.json`'s `permissions.allow`; the daemon-owned **approved-rules store** `<home>/permissions/projects.json` (`agent/approved-project-rules.ts` — written only by `approval.respond` for a card's "in this project" answer, keyed by canonical project root, never read or written through a link, applied regardless of trust); and a project's in-repo `.winter/settings.json`/`.winter/permissions.local.json` only when the project is trusted. The project root is `repoRootFor(cwd)`, which ignores a `.git` file whose git dir does not own the cwd. Two claude-parity consequences are deliberate: under `plan` the official leg applies saved rules (claude does) while the Winter SDK still holds writes back; and a dispatch session's code-mode children receive them, as claude's headless mode does.

**Plugin skills are the only skills a child loads** (`settingSources: []` switches off both runtimes' own discovery). `SkillStore.childSkillSurface` hands each eligible plugin over as a skills-only view, `<home>/cache/skill-plugins/<plugin>/skills` → the plugin's own `skills/` (no manifest, so no hooks, MCP or agents ride along; rebuilt before every spawn, never through a link; a symlinked `<home>/cache` refuses that spawn's handover): `Options.plugins` + `Options.skills` on the Winter leg, the router's `OptionsTemplatePolicy.plugins` on the official leg. Eligible = enabled, not disabled and consent-complete (`pluginSkillsEligible`): a manifest plugin that ships skills requires the `exec` consent (a skill can run shell commands); a legacy plugin requires none, and its enable prints that disclosure instead (`enableNotice`). `skills.list` reports per skill whether a session can load it (`loadsInSessions`/`sessionNote`).

The bash safety reviewer is the one internal job that **never switches itself off over a pin mistake** (user ruling): when `reviewer.model`'s explicit pin is unrunnable (`provider-unsupported`, or `no-credential` for the pinned provider) it falls back to the default rule's answer and **runs** on that, while the role's `problem` still reports the pin's own issue with a `— reviewing on <tag> meanwhile` clause. `resolve` enforces that on the role, so the other three keep "a refused pin is inert with a note" (spending on a provider the user did not choose for titles/dreams/cleanup is worse than not running). Only when the default rule has **no** answer either (`no-internal-credential`/`no-default-model`) does the hook **allow** an ordinary sandboxed call (never an escape — see above) — byte-identical to what such a home got before the reviewer could exist there at all (a Claude-only home is exactly this case, by the Claude-exclusion ruling, and the Mac creates code sessions on `auto`); one log line per change of state. A **transient** failure on a home that does have a runnable provider still escalates with `ask`. A call the gate cannot allow outright raises an approval card in Code mode through `canUseTool` (`runtime-sdk/approval-bridge.ts`) and is a typed deny in dispatch/chat; session policies are `plan | dont-ask | ask | accept-edits | auto | bypass`, plus chat's immutable `chat`. Memory is file-based (a MEMDIR of markdown written with ordinary write/edit — no dedicated memory tools). Subagents have no wall-clock timeout; a progress-stall watchdog replaces it.

## Versioning & release

`VERSION` is canonical and is never edited by hand. The format is `#.###.#` — major, a three-digit feature counter, a single-digit patch (e.g. `0.112.0`); the first digit moves only for a rebrand-scale event.

```sh
bun run version:bump                 # patch +1 (throws past 9 — use a feature bump)
bun run version:bump:feature         # feature +1, patch -> 0 (also version:bump:major)
bun run version:sync                 # restamp version.ts / package.jsons / plists from VERSION

bun run scripts/release.ts --dry-run --no-bump   # full rehearsal: builds, notarizes, staples, never publishes
bun run scripts/release.ts                       # real release (bumps the version first)
```

`releases/notes/<version>.md` is **required** for the version being released — it is both the GitHub
release body and the Sparkle appcast `<description>` (rendered to HTML by `releaseNotesHtml`, which
throws on any markdown construct outside `#`/`##`/`###`, paragraphs, `- ` bullets with two-space
continuations, ``` fences, `` `code` `` and `**bold**`). The preflight fails before the bump when it
is absent, so the flow is: write and commit the notes for the next version, bump and sync, then
release with `--no-bump`.

## Hard rules

- **Never kill, restart, launch or write to a running Winter.app or the user's live daemon.** The daily driver is `Winter.app` (`com.winter.app`) in `/Applications` on `~/.winter` with Keychain `com.winter.core`. A local Release build (`out/release/<version>/…/Winter.app`) carries the same bundle id and Launch Services can resolve `com.winter.app` to it at relaunch: build Release copies, never launch one, and never delete an `out/release/<version>` tree while a Winter process runs from it. The legacy `Norma.app` / `~/.norma` / `com.norma.core` items stay untouched as the rollback source.
- **Dev work uses only the dev app** — "Winter Dev" (`com.winter.app.dev`, `~/.winter-dev`, a Debug build with an explicit `-derivedDataPath`). A Claude-launched dist instance is indistinguishable from the user's own in the menu bar and defeats the entire dev/dist split.
- **Tests never touch `~/.winter*`, `~/.claude*`, or the real Keychain.** Always point at a temp `WINTER_HOME`; every test daemon resolves credentials against a throwaway Keychain service (`packages/core/test/preload.ts` sets `WINTER_KEYCHAIN_SERVICE`), never `com.winter.core` / `com.winter.core.dev`, which hold the user's real items.
- Secrets live in the macOS Keychain (`Bun.secrets`, service `com.winter.core`) — never on disk, never in fixtures, never in a log line or an error message.
- `packages/core/src/providers/codex-config.ts` self-identifies as `originator: "winter"` — a deliberate ToS decision; do not revert it to a first-party value.
- Version strings are generated; edit only `VERSION`, through the bump/sync scripts.
- The Sparkle public key in `apple/Winter/project.yml` (`SUPublicEDKey`) is the production key; the private half exists only in the login Keychain — never committed anywhere.
