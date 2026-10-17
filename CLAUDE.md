# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository. This file is the entry point; the detail lives in topic files under `docs/claude/` — read the one for the area you are touching (index at the end). The hard rules at the bottom apply always.

## What this is

Winter is a macOS-native AI assistant: a TypeScript/Bun daemon (`winter-core`) plus a native Swift menu-bar app. They speak JSON-RPC 2.0 over NDJSON on a Unix socket (`<WINTER_HOME>/run/core.sock`; default home `~/.winter`). The daemon is the single source of truth; every client — CLI, Mac app, phone — is a view over its event stream.

**The daemon runs no agent loop of its own.** Every session is a runtime child driven through the router (`@yanlinglabs/winter-runtime-sdk`) on the Winter agent runtime — the only leg; every model runs on it, Claude included. Code sessions spawn the `winter` binary; chat and dispatch run it EMBEDDED in `winter-core`, one Bun Worker per session. Session modes are `code`, `dispatch`, `chat`. **Cowork is not an implemented session mode** — the protocol names it (`SESSION_MODES`) but `session.create` refuses it for every role (`unsupported_topology`) and no runtime-facing type can hold it; see [docs/cowork-status.md](docs/cowork-status.md). The daemon owns everything around the child: IPC, event-sourced session storage, settings, approvals, the capability tools it hands the child over MCP, the hooks, and the SDK-message→`SessionEvent` projector.

## Commands

```sh
bun install                          # bun is the runtime; pnpm workspaces orchestrate

pnpm test                            # every workspace, serially
cd packages/core && bun test         # one package
bun test path/to/file.test.ts        # one file (substring match); `bun test -t "name"` for one test
bun run typecheck                    # every package (typecheck:core / typecheck:protocol / … for one)
pnpm protocol:generate               # REQUIRED after changing packages/protocol/src/events.ts

# Compiled-artifact gates — each builds a real binary; docs/claude/testing.md
bun run verify:workflow              # also verify:automation-worker, verify:runtime-state, verify:runtimes, verify:embedded
bun run verify:computer-helper       # also verify:headless-helper
bun run check:idle-wakeups           # idle daemon CPU wakeups/s, fails over 50/s (`top -c d`; see testing.md)

# Swift — every package in docs/claude/testing.md
cd apple/WinterProtocol && swift test   # also apple/WinterKit, apple/ComputerUse/{WinterComputerUse,WinterCUCore}
cd apple/Winter && xcodegen generate && xcodebuild -project Winter.xcodeproj -scheme Winter -destination 'platform=macOS' build

# CLI / daemon in dev — never a plain `winter`, that is the dist CLI
cd packages/cli && bun src/main.ts daemon run   # headless daemon; `-p "hello"` one-shot; no args = TUI
bun run dev:daemon                   # build + sign + run the dev daemon on ~/.winter-dev (see Profiles below)
bun run dev:helper                   # build + sign + register the dev Computer Use helper (dev:headless likewise)
bun run build:winter                 # dist/winter from ../winter-agent-sdk, for the built-binary e2e (testing.md)

# Live suites: WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live (NEVER from an agent); WINTER_BROWSER_E2E=1 bun run e2e:browser
```

Every daemon tees its stdout/stderr into `<WINTER_HOME>/logs/daemon.log` (`winter doctor` prints the path) — grep it before reproducing anything. Tests get a per-process temp root and a throwaway Keychain service from the preloads; the rules are in [docs/claude/testing.md](docs/claude/testing.md).

## Profiles — which daemon you are talking to

- The home and the profile are set INDEPENDENTLY: `WINTER_HOME` picks the home (default `~/.winter`, the user's live daily driver); `WINTER_PROFILE=dev` changes only the Keychain service and the app identity, never the home. Always set BOTH — dev is `WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev`.
- The dev daemon is the signed compiled binary `dist/dev/winter-core`, started with `bun run dev:daemon` (`--no-build` reuses it; `--cli <args>` runs the dev CLI through it). After the one-time `--transition`, never run a dev daemon or dev CLI under plain `bun` — it is prompted for every Keychain item.
- Two traps: a plain `winter` is the DIST CLI and auto-launches the dist app on a dead socket — never for dev or test work. Debug app builds embed no daemon or runtimes: start the dev daemon before "Winter Dev", or the orb shows disconnected.
- The identity rule, the transition's locks and shadows, the `winter-dev` wrapper: [docs/claude/architecture.md](docs/claude/architecture.md#profiles-and-the-dev-daemon).

## Where to read more

Plain links, not `@` imports — read the file whose area you are about to touch.

| Read | When |
|---|---|
| [architecture.md](docs/claude/architecture.md) | Before touching more than one package, any `apple/*` or `extensions/*` target, the dev daemon, or the dev/dist split. Monorepo layout and the profiles/transition rules. |
| [runtime-and-sessions.md](docs/claude/runtime-and-sessions.md) | Before touching session create/resume, the embedded host, the `winter`/`ant` binary ladders, legacy-session adoption, model switches, the event log, per-call tool results and concurrency lanes. |
| [providers-and-credentials.md](docs/claude/providers-and-credentials.md) | Before touching a Keychain slot, `credential.*`/`provider.*` doors, the host-credential broker, the boot Keychain passes or Anthropic/Console sign-in. |
| [internal-jobs.md](docs/claude/internal-jobs.md) | Before touching titles, the bash safety reviewer, the dreamer or the session cleaner — model/effort/credential resolution and the role problems. |
| [protocol-and-remote.md](docs/claude/protocol-and-remote.md) | Before changing a `SessionEvent` variant or field (the 7-step checklist), adding an RPC method, or touching what a remote/phone client sees (allowlists, history, transients, thinking pill, phone mirror). |
| [settings-and-migrations.md](docs/claude/settings-and-migrations.md) | Before adding a setting (live reload, the one-reader rule) or touching the legacy `~/.norma` home or project migration. |
| [runtime-home.md](docs/claude/runtime-home.md) | Before touching `<home>/sdk`, run folders, MCP/settings scopes and trust, Migration C, saved answers or the plugin format. |
| [tool-surface.md](docs/claude/tool-surface.md) | Before changing what a model can call: capability servers and plain names, deferral, chat/dispatch allowed lists, web tools, hooks, read/write fences, sandbox escapes, saved allow rules, skills. |
| [dispatch-and-messaging.md](docs/claude/dispatch-and-messaging.md) | Before touching mid-turn pushes (the fold), turn pairing, `SpawnSession`/children, `SendMessage`/`ListAgents`/`TaskStop`, `ListSessions`, or the Dispatch pill's command mode and terminal. |
| [mcp.md](docs/claude/mcp.md) | Before touching connector permissions, MCP OAuth sign-ins, URL-mode elicitation, an `mcp.*` RPC or `winter mcp`. |
| [images.md](docs/claude/images.md) | Before touching image attachments, `session.stageImage` or `images` on `session.send`/`steer`. |
| [computer-use.md](docs/claude/computer-use.md) | Before touching `packages/core/src/computer-use/**` (not `browser/`), `apple/ComputerUse/**`, the `computer_v2` tool, its policy/cards, the helper client, app adapters, the focus guardian. |
| [island.md](docs/claude/island.md) | Before touching `apple/Winter/Sources/Island/`, `packages/core/src/island/`, the hello's `capabilities`/`tty`, `island.pending`, or where an approval, question or desktop-switch prompt shows on the Mac. |
| [computer-use-browsers.md](docs/claude/computer-use-browsers.md) | Before touching `computer-use/browser/**`, `extensions/winter-for-chrome/**`, `apple/ComputerUse/WinterBrowserHost/**` or the browser link — tabs, readers, downloads, the sign-in hand-off, WebMCP. |
| [headless.md](docs/claude/headless.md) | Before touching the `headless` backend, the Winter Headless helper, its local-network rules or the Chromium embed layout. |
| [testing.md](docs/claude/testing.md) | Before running or writing tests, a verify gate, the live computer-use suite, or anything reading daemon logs/temp dirs. |
| [release.md](docs/claude/release.md) | Before bumping a version, writing release notes or cutting a release. |
| [cowork.md](docs/claude/cowork.md) | Before touching `packages/core/src/cowork/**`, `packages/protocol/src/cowork.ts`, `apple/Cowork/**`, host-storage-fence or home-fence cowork roots, `refreshForStorage`, or the `workspace.*` / `project.*` methods and events. |

Other references: `winter-vs-cc-tools.md` (repo root, the live tool comparison with Claude Code), `apple/ComputerUse/PROTOCOL.md` (the helper's wire contract), `apple/ComputerUse/WinterBrowserHost/PROTOCOL.md` (Winter for Chrome's).

## Hard rules

- **Never kill, restart, launch or write to a running Winter.app or the user's live daemon.** The daily driver is `Winter.app` (`com.winter.app`) in `/Applications` on `~/.winter` with Keychain `com.winter.core`. A local Release build (`out/release/<version>/…/Winter.app`) carries the same bundle id and Launch Services can resolve `com.winter.app` to it at relaunch: build Release copies, never launch one, and never delete an `out/release/<version>` tree while a Winter process runs from it. The legacy `Norma.app` / `~/.norma` / `com.norma.core` items stay untouched as the rollback source.
- **Dev work uses only the dev app** — "Winter Dev" (`com.winter.app.dev`, `~/.winter-dev`, a Debug build with an explicit `-derivedDataPath`). A Claude-launched dist instance is indistinguishable from the user's own in the menu bar and defeats the entire dev/dist split.
- **Tests never touch `~/.winter*`, `~/.claude*`, or the real Keychain.** Always point at a temp `WINTER_HOME`; every test daemon resolves credentials against a throwaway Keychain service (`packages/core/test/preload.ts` sets `WINTER_KEYCHAIN_SERVICE`), never `com.winter.core` / `com.winter.core.dev`, which hold the user's real items.
- Secrets live in the macOS Keychain (`Bun.secrets`, service `com.winter.core`) — never on disk, never in fixtures, never in a log line or an error message.
- `packages/core/src/providers/codex-config.ts` self-identifies as `originator: "winter"` — a deliberate ToS decision; do not revert it to a first-party value.
- Version strings are generated; edit only `VERSION`, through the bump/sync scripts.
- The Sparkle public key in `apple/Winter/project.yml` (`SUPublicEDKey`) is the production key; the private half exists only in the login Keychain — never committed anywhere.
- Ordinary Code, plugin hooks, LSP and third-party MCP tools get no outer Cowork Seatbelt; each tool's own sandbox is unchanged, and Cowork fences only through the existing `sandboxConfigFor` deny arrays ([cowork.md](docs/claude/cowork.md)).
