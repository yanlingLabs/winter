# Contributing to Norma

Thanks for wanting to help. This document is the practical stuff: how to get a working build, how to
run the tests, and the handful of rules that will save you a wasted afternoon.

**Before anything nontrivial, [open an issue](https://github.com/yanlingLabs/norma/issues) or start a
[discussion](https://github.com/yanlingLabs/norma/discussions).** Norma has a lot of load-bearing
structure that isn't obvious from a diff, and it's much easier to point you at it before you write
the code than after.

Found a security problem? Don't open an issue — see [SECURITY.md](SECURITY.md).

## Table of contents

- [What you need](#what-you-need)
- [First build](#first-build)
- [Running Norma in development](#running-norma-in-development)
- [The dev/dist split — read this one](#the-devdist-split--read-this-one)
- [Tests](#tests)
- [Changing the protocol](#changing-the-protocol)
- [Rules that bite](#rules-that-bite)
- [Sending a pull request](#sending-a-pull-request)

## What you need

| | |
| --- | --- |
| **macOS 26+**, Apple silicon | The deployment target. There is no legacy compatibility path — see [rules](#rules-that-bite). |
| **[Bun](https://bun.sh) ≥ 1.3** | The runtime. TypeScript runs directly; there is no build step in dev. |
| **pnpm** | Orchestrates the workspaces. `bun install` is what you actually run. |
| **Xcode 26+** | Only if you're touching Swift. |
| **[XcodeGen](https://github.com/yonaskolb/XcodeGen)** | `brew install xcodegen`. The `.xcodeproj` is generated from `apple/Norma/project.yml`; the pbxproj is not the source of truth. |

TypeScript-only contributions (the daemon, the CLI, tools, providers) need nothing from the Xcode
column.

## First build

```sh
git clone https://github.com/yanlingLabs/norma.git
cd norma
bun install
```

That's the whole TypeScript setup. For the **Mac app**, three large artifacts are fetched rather
than committed — the Xcode build fails loudly and names the fix command if any is missing, but you
may as well get them out of the way first:

```sh
bun run cef:fetch                      # Chromium Embedded Framework  (~332 MB, SHA1-pinned)
bun run monaco:fetch                   # Monaco editor                (~14 MB, sha512-pinned)
./apple/NormaKit/vendor/fetch-iroh.sh  # iroh transport xcframework   (~133 MB, checksum-pinned)
```

Then generate and build:

```sh
cd apple/Norma
xcodegen generate
xcodebuild -project Norma.xcodeproj -scheme Norma -destination 'platform=macOS' \
  -derivedDataPath build/DerivedData build
```

**Always pass an explicit `-derivedDataPath`.** `xcodegen generate` mints a new DerivedData hash each
time, and without this you will eventually test a days-old binary and lose hours to it. This has
happened; it is in the repo's scar tissue.

## Running Norma in development

```sh
cd packages/cli
bun src/main.ts daemon run        # headless daemon
bun src/main.ts -p "hello"        # one-shot prompt, another terminal
bun src/main.ts                   # interactive TUI (Code mode)
```

Useful CLI surface while developing: `norma status`, `norma ping`, `norma sessions`,
`norma agents`, `norma watch <sessionId>`, `norma bg list <session>`, `norma plugin list`.

## The dev/dist split — read this one

Norma ships as two separate installs that must never be confused:

| | Distribution | Development |
| --- | --- | --- |
| App | `Norma.app` | `Norma Dev.app` (Debug build) |
| Bundle id | `com.norma.app` | `com.norma.app.dev` |
| Home | `~/.norma` | `~/.norma-dev` |
| Keychain service | `com.norma.core` | `com.norma.core.dev` |
| Command | `norma` | `norma-dev` |

**Never launch the distribution app during development.** It's somebody's daily driver, updated by
Sparkle; a locally-launched copy under the same bundle id is indistinguishable from it in the menu
bar and defeats the entire split. The same goes for local Release builds — build them, don't run
them.

Two traps worth stating outright:

1. **Plain `norma` is the distribution CLI.** With a dead socket it *auto-launches the dist app*.
   Use `norma-dev`, or a temporary `NORMA_HOME` with a manually-spawned daemon:

   ```sh
   NORMA_HOME=~/.norma-dev NORMA_PROFILE=dev bun src/main.ts daemon run
   ```

2. **Debug builds don't embed `norma-core`.** "Norma Dev" cannot spawn its own daemon — start the
   dev daemon *first* or the orb just shows disconnected.

And: **after any change under `packages/`, restart the daemon, not just the app.** An app-only
relaunch is a silent no-op for daemon code.

## Tests

```sh
pnpm test                              # every workspace, serially
cd packages/core && bun test           # one package
bun test path/to/file.test.ts          # one file (path substring match)
bun test -t "test name"                # one test by name

cd apple/NormaProtocol && swift test   # protocol mirror round-trip
cd apple/NormaKit      && swift test   # daemon client library

bun run verify:workflow                # workflows e2e against the REAL compiled binary
```

`verify:workflow` matters more than its name suggests: the workflows runtime spawns the daemon's own
binary as a sandboxed subprocess, and the dev path (`bun run src/…`) and the compiled path differ.
It must stay green.

New behaviour needs a test. The bar isn't coverage percentage — it's that the *specific claim* your
change makes is pinned by something that fails when the claim stops being true.

## Changing the protocol

`packages/protocol` is the contract between the daemon and every client, in two languages. Adding or
changing a `SessionEvent` variant or an RPC method touches these, **in order**:

1. `packages/protocol/src/events.ts` (or `methods.ts`) — the zod schema
2. `packages/protocol/scripts/generate.ts` — add a canonical fixture for the new variant
3. `pnpm protocol:generate` — regenerates the JSON schema + Swift round-trip fixtures
4. `packages/core/src/agent/subagent-transcript.ts` — its exhaustiveness map fails core's `tsc`
   until you update it
5. `apple/NormaProtocol` — mirror the Swift type. Its test asserts the exact fixture count, so it
   fails until synced
6. `apple/NormaKit` — has exhaustive `switch`es over event variants (the `seq`/`sessionId`
   accessors). A new variant breaks compilation **here**, not in NormaProtocol
7. **Build NormaKit *and* the app** — not just `swift test` in NormaProtocol. That's the only way to
   catch step 6

### Adding a *field* is more dangerous than adding a variant

Every step above is keyed to something failing to compile. **Nothing fails to compile when a
producer simply doesn't set a new optional field.** So sweep the field's producers *by meaning*: who
else writes this event, in either language, and would the consumer's fallback silently accept the
old shape? This has shipped a bug before — a correct daemon and a second, stale Swift producer
emitting the old shape past a consumer with no gate.

### Two more lockstep lists

- **The remote method allowlist** is four hand-mirrored lists: `REMOTE_ALLOWED_METHODS` in
  `packages/core/src/ipc/server.ts`, its literal parity test, Swift `Gateway.remoteAllowedMethods`,
  and its count test. Adding a remote method is a deliberate edit to all four.
- **Transient events** are one shared constant — `TRANSIENT_EVENT_TYPES` in the protocol package,
  mirrored in Swift, with parity tests both sides. Never hand-copy the strings. A new transient
  variant must also be added to `REMOTE_STREAM_EVENT_TYPES`; omitting it drops that event for every
  remote client, silently and permanently, and the parity tests will *not* catch that direction.

`session.history` and the remote stream are **allowlists, never denylists**. `reasoning_item` must
never pass either one; a security test pins that.

## Rules that bite

- **Tests must never touch `~/.norma`.** Always point at a temp `NORMA_HOME`. Never kill or restart
  a user's live daemon or app.
- **No setting may ever require a daemon restart.** `~/.norma/settings.json` is watched and
  hot-swapped atomically; feature code reads live getters. New settings follow that pattern — this
  is a product promise, not a preference.
- **Secrets live in the Keychain.** `Bun.secrets`, service `com.norma.core`. Never on disk, never in
  a fixture, never in a log line.
- **Provider `encrypted_content` / `reasoning_item.itemJson` is opaque.** The session JSONL is its
  only sink. Never log it, never write it into a model-readable transcript.
- **Versions are generated.** `VERSION` (format `#.#.###`) is canonical; edit it only via
  `bun run version:bump` / `version:sync`. Never hand-edit a version in a `package.json` or plist.
- **Minimum OS targets track the latest major Apple OS.** No legacy compatibility shims.
- **`packages/core/src/providers/codex-config.ts` self-identifies as `originator: "norma"`.** That's
  a deliberate terms-of-service decision. Don't "fix" it to a first-party value.
- The Sparkle public key in `apple/Norma/project.yml` is the production key. Its private half exists
  only in one login Keychain and is committed nowhere.
- `norma/` at the repo root is a dead Phase-0 scaffold. The real app is `apple/Norma`.

## Sending a pull request

- **Branch from `main`.** Keep the PR scoped to one thing.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with a
  scope** — the repo's history is `feat(app):`, `fix(editor):`, `docs(brand):`, `perf(app):`,
  `chore(release):`. Match it.
- **Explain *why* in the body.** Norma's code carries unusually heavy comments explaining why
  something is the way it is, because the alternative is somebody helpfully undoing it in six
  months. Write your PR description the same way.
- **Run the tests for what you touched**, and say which ones you ran. If your change crosses the
  TS/Swift boundary, that means both sides plus an app build.
- **Don't bump the version** — releases run through `scripts/release.ts`.
- **UI changes: include a screenshot.** For anything visual, `docs/brand.md` is the source of truth
  for color and type; use the named tokens, never raw hex.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
