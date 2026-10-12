# Testing

*Read this before running or writing tests, a verify gate, or anything that reads a daemon's logs or temp dirs.*

## Daemon log

Every daemon tees stdout/stderr into `<WINTER_HOME>/logs/daemon.log` (`packages/core/src/daemon-log-file.ts`: 8 MiB, one rotation to `daemon.log.1`); `winter doctor` prints the path. Grep it before reproducing anything.

## Running tests

- `pnpm test` (every workspace, serially); `cd packages/core && bun test`; `bun test path/to/file.test.ts` (substring); `bun test -t "name"`.
- **Built-binary e2e** (`packages/core/test/e2e/winter-{chat,code,dispatch}-e2e.test.ts`, `legacy-claude-agent-adoption-e2e.test.ts`) use `test/helpers/winter-binary.ts`'s `describeWithWinterBinary`: `WINTER_RUNTIME_EXECUTABLE="$PWD/dist/winter"` (`bun run build:winter`, from a sibling `../winter-agent-sdk` or `$WINTER_SDK_CHECKOUT`) names the binary; unset → the version-matched npm platform package if installed, else SKIP; a missing path → warn and skip; `WINTER_RUNTIME_REQUIRE_BINARY=1` (CI) makes either a failure.
- **Login-shell PATH**: every daemon boot merges the user's login-shell PATH into its own (`packages/core/src/login-shell-path.ts`); `WINTER_LOGIN_SHELL_PATH=off` (or `0`/`false`) skips it. The core and cli `test/preload.ts` set it — no test runs your real shell.
- **Keychain**: the same preloads set `WINTER_KEYCHAIN_SERVICE=com.winter.core.test-isolated` (honoured only for a non-default home, `profile.ts`'s `keychainService()`).

## Per-process temp root

`packages/core/test/per-process-tmp.ts` is the FIRST import of every package's preload (core/cli `preload.ts`; protocol/plugin-sdk via `bunfig.toml`): one `<real tmpdir>/winter-test-XXXXXX` per test process, `$TMPDIR` pointed at it, the tree removed by a detached watcher once the process is gone, whatever the end (SIGKILL included). Never in-process: `bun test` exits natively (`process.on("exit")` never fires) and an `afterAll` rm blocks ~6 s into bun's 5 s hook timeout.

- A child gets the root only when the spawn passes `env: {...process.env}` — Bun 1.3.14 hands a spawn with NO `env` the STARTING environment; a bare spawn that leaks is a bug.
- `confstr`/macOS `mktemp` still answer the real per-user temp dir BY DESIGN (`agent/sandbox.ts` depends on it).
- Never leave temp dirs outside the root. Swift: `addTeardownBlock`/`defer` (WinterKit: `removeAtTeardown`); `RealDaemon` runs its daemon on its own `$TMPDIR`, removed by `stop()`. SwiftPM itself leaves `TemporaryDirectory.*` + `.lock` files in `$TMPDIR` on every `swift build/test/package` — for a bulk Swift run point `TMPDIR` at a scratch dir you delete.

## A hand-started experiment daemon

A temp `WINTER_HOME`, no `WINTER_PROFILE`, a random `WINTER_KEYCHAIN_SERVICE=com.winter.core.test-<random>` (`auth/secret-store.ts`); better, in-process: `startDaemon({ home, secrets: new FileSecretStore(...) })`.

## Compiled-artifact gates

Each builds a real binary; none runs under `bun test`: `verify:workflow` (sandboxed workflow worker on `dist/winter-core`), `verify:automation-worker` (sandboxed ComputerV2 worker), `verify:runtime-state`, `verify:runtimes` (the Release bundle's embedded runtimes), `verify:embedded` (one EMBEDDED chat turn, a Worker from `compile:core`'s 2nd entrypoint — `compile:core` is a `packages/cli` script), `verify:computer-helper` (the helper's `dist/dev` signature + a test build's handshake on a temp home), `verify:headless-helper` ([headless](./headless.md)).

## Swift

`swift test` in `apple/WinterProtocol` (fixture round-trip, exact count), `apple/WinterKit`, `apple/ComputerUse/WinterComputerUse` (helper shell), `apple/ComputerUse/WinterCUCore` (engine; `WinterCUPresentation` beside it). App: `cd apple/Winter && xcodegen generate && xcodebuild -project Winter.xcodeproj -scheme Winter -destination 'platform=macOS' build`.

## Idle wakeups

`bun run check:idle-wakeups` boots an isolated daemon, fails over 50 wakeups/s; `--pid N` measures a running one read-only. `top`'s IDLEW is the SINCE-LAUNCH count unless `-c d` (3,962 on an 8 h daemon is ~0.14/s).

## The live computer-use suite

`WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live` (`scripts/cu-live/`). **Never run it from an agent** — only with the user's standing go-ahead. Rebuilding the dev helper loses its Screen Recording grant ([computer-use](./computer-use.md)).

- **Takes over the screen** ~2–3 min: fixture apps, a second dev-helper instance on a temp home (`WINTER_CU_HOME`), a live daemon on a file store, the scripted double (no LLM); the freshness measurement is reported (`out/cu-live/freshness.json`), never asserted. Asserts the fixture's log, screenshot pixels (`#FF00FF` sentinel), mirror frames, and that the frontmost app/Space never change (20 ms sampling); "no rung-4 fallback" = the real pointer never moved, the user's app got no key/click.
- **Identities**: TEST-ONLY `com.winter.core.cutest` / `com.winter.app.cutest` (`build.ts`), accepted only by a dev helper serving a `<user temp>/winter-cu-live-*` home (`HelperIdentity.isLiveTestHome`) — never sign a test tool with a production id. Only such an instance answers `test.activate {pid}` (macOS 26 ignores a background process's activation) and `test.automation` (never asks). Fixture ids are `dev.cu-live.*`, never `com.winter.*`.
- **Real input** (idle gate, postpone, abort) is HARDWARE only: a listen-only tap counting `eventSourceUnixProcessID == 0` events (`swift/Tool/HardwareInput.swift`; keys only with existing Input Monitoring access). Never `HIDIdleTime`/`SecondsSinceLastEventType` for this (Unity apps tickle HID with no event; synthetic events never count). An abort still quits what the run launched and closes what it opened.
- **`--unattended`**: polls 5 s, up to `--max-wait` (3 h), for `--idle-seconds` (180) without hardware input, then a `--countdown-seconds` (30) banner; any input postpones and restarts the wait. Every run shows a non-activating, never-captured "don't touch the Mac" banner. From a full-screen app's Space it moves the user to a regular desktop and returns them at the end, abort too.
- **Stops**: a permission prompt in front (UserNotificationCenter, SecurityAgent, CoreServicesUIAgent) stops the run — a test never raises one (no AppleScript to other apps). A LOCKED screen is never a go: `--unattended` waits for the unlock (idle clock restarts), a hand-started run refuses, a mid-run lock aborts. SIGINT/SIGTERM/SIGHUP run the abort cleanup (report "aborted"), exit 128+n; a second signal is ignored; after 20 s (`STOP_HARD_EXIT_MS`) it SIGKILLs what it owns. Signal the `bun run` pid (it forwards). Stray `WinterCUFixture` processes are closed first.
- **Result**: `out/cu-live/last-run.json` unless `--report <file.json>`; a non-activating result panel (30 min at most; `--no-done-window` for CI).
- **Flags**: `--dry-run` (build, self-tests, plumbing, the identity rule — no screen); `--real-apps` (real apps on temp docs); `--apps "<name or id>,…"` (the generic focus check on any app — reversible, quits only what it launched); `--script <file.js>`; `--safari-freshness` (only while Safari is NOT running — it launches and quits its own), `--safari-webkit-prefs` + `--yes-restart-safari` (three WebKitPreferences keys set NO, restored exactly); `--freshness-copy-to <dir>`; `--helper-app <path>` (else `$WINTER_COMPUTER_USE_APP`, else `dist/dev/`).
