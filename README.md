<h1 align="center">Norma</h1>

<p align="center">
  <b>An AI that actually lives on your Mac.</b><br>
  A native replacement for the ChatGPT/Claude ecosystem — chat, a full coding agent, and an
  orchestrator that runs work for you — in one app, on your machine, with your own account.
</p>

<p align="center">
  <a href="https://github.com/yanlingLabs/norma/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yanlingLabs/norma/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/yanlingLabs/norma/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/yanlingLabs/norma?label=release&color=2E9484"></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <img alt="Platform: macOS 26+" src="https://img.shields.io/badge/platform-macOS%2026%2B-lightgrey.svg">
  <a href="https://github.com/yanlingLabs/norma/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/yanlingLabs/norma/total?color=555"></a>
  <a href="https://github.com/yanlingLabs/norma/discussions"><img alt="Discussions" src="https://img.shields.io/github/discussions/yanlingLabs/norma"></a>
</p>

---

Most AI tools are one of two things: a chat window in a browser tab, or a coding agent in a
terminal. Norma is meant to be the whole thing — the assistant you talk to, the agent that writes
your code, and the orchestrator that goes and does multi-step work while you get on with your day —
as one native macOS product that runs on your own machine, under your own subscription or API key.

She sits in your menu bar and follows your cursor as a small orb. She has her own window with a
real Chromium browser, a real code editor, and (soon) real documents inside it. She can see your
screen, drive your Mac, remember things about you as plain files you can read, and keep herself
updated without ever interrupting you. When you leave your desk, your iPhone picks up the same
sessions over an encrypted direct link — no cloud in the middle.

## Install

```sh
brew tap yanlingLabs/norma
brew install --cask norma
```

Or grab the latest `.dmg` from [Releases](https://github.com/yanlingLabs/norma/releases/latest),
open it, and drag Norma to your Applications folder.

Requires **macOS 26 or later** on Apple silicon. Then point her at the model you already pay for:

```sh
norma login              # sign in with your ChatGPT account
norma login --api-key    # or paste an OpenAI API key
```

That's the whole setup. She's in your menu bar, and `norma` works in any terminal. Details on
[models, reasoning effort and search keys](#bringing-your-own-ai) are further down. (Newer Homebrew
may ask you to trust the tap once: `brew trust yanlingLabs/norma`.)

## Table of contents

- [The three modes](#the-three-modes) · [Surfaces](#surfaces-where-you-talk-to-her)
- [What she can actually do](#what-she-can-actually-do) · [Memory](#memory-that-you-can-read)
- [Background sessions](#background-sessions-and-multiple-harnesses) · [Extending Norma](#extending-norma)
- [Privacy & security](#your-mac-your-data) · [Bring your own AI](#bringing-your-own-ai)
- [For developers](#for-developers) · [Roadmap](#roadmap) · [FAQ](#faq)

## The three modes

Norma isn't one agent with a system prompt swap. Each mode is a genuinely different product with its
own toolset, its own permission posture, and its own surface — enforced in the daemon, not suggested
in a prompt.

| Mode | What it is | Tools | Status |
| --- | --- | --- | --- |
| **Chat** | A conversation with a memory. Web search, page reading, a read-only browser — no filesystem, no shell, no repo access. It never asks you for permission because it can't do anything that would need it. | **4** | **Shipped** |
| **Code** | The full coding agent: your files, your shell, your git, LSP diagnostics, subagents, worktrees, notebooks, screen control. A permission model modelled on Claude Code — six approval policies from `plan` to `bypass`, and rules that remember your answers. | **36** | **Shipped** |
| **Dispatch** | The orchestrator, and a permanent session that never gets replaced and keeps its own memory. It has real hands — shell, screen control, the browser, read access to your files — but it doesn't edit code itself: it spawns, steers and stops Code sessions that do, in parallel, and reports back. | **17** | **Shipped** |
| **Cowork** | Working alongside you on a shared surface rather than for you in a transcript. | — | Planned |
| **Build** | One prompt to a finished, running thing — built end to end and optionally published to a share URL we host (or your own). | — | Planned |

<details>
<summary>The exact toolset each mode gets</summary>

These sets are pinned by a test that boots the real daemon and reads its registry, so this table
can't drift from what actually ships.

**Chat (4)** — `Search` · `ReadPage` · `browser` (read verbs only) · `AskQuestion`

**Dispatch (17)** — `session_spawn` · `list_sessions` · `manage_session` · `send_message` ·
`task_stop` · `bash` · `computer` · `browser` · `read` · `ls` · `glob` · `grep` · `Search` ·
`ReadPage` · `AskQuestion` · `push_notification` · `ToolSearch`

**Code (36)** — `read` · `ls` · `glob` · `grep` · `write` · `edit` · `notebook_edit` · `bash` ·
`bash_output` · `lsp` · `computer` · `browser` · `web_fetch` · `web_search` · `spawn_agent` ·
`send_message` · `agent_list` · `agent_output` · `task_stop` · `enter_worktree` · `exit_worktree` ·
`Workflow` · `Skill` · `skill_write` · `schedule` · `ask_user` · `enter_plan_mode` ·
`exit_plan_mode` · `task_create` · `task_update` · `task_list` · `task_get` · `push_notification` ·
`list_mcp_resources` · `read_mcp_resource` · `ToolSearch`

Plus whatever your MCP servers and add-ons contribute, which are discovered at runtime rather than
declared here.

</details>

Modes aren't just labels: a tool declares which modes it belongs to at registration time, and a
session physically cannot call a tool outside its mode — a tool with no declaration is code-only by
default, so widening one is always a deliberate edit. The mode × surface matrix is enforced too —
the TUI is code-only, the orb is dispatch-only.

## Surfaces: where you talk to her

The daemon is the product; everything below is a window onto the same live sessions.

**The Mac app.** Menu bar resident, with a full chat window: sidebar of sessions, per-mode
composers, inline tool cards, diffs rendered like a real review tool. On the right is a **panel**
with tabs — a real Chromium browser (CEF), a real code editor (Monaco), file trees, diff views, and
documents. The agent drives them and so do you, in the same tabs, at the same time.

**The orb.** A small liquid orb that follows your cursor across every space and every app.
Four-finger tap the trackpad anywhere and a text field appears — type anything and it goes straight
to Dispatch. Sessions Dispatch spawns can be detached into their own floating windows, so you can
watch a task work, or jump in and talk to it.

**The terminal.** `norma` gives you a full Ink/React TUI for Code mode — streaming transcript,
scrollback, task blocks, approvals inline. `norma -p "…"` is a one-shot for scripts. Every CLI
command talks to the same daemon the app does.

**Your iPhone.** A companion iOS app (closed source, built on the open kits in this repo) connects
**directly** to your Mac over an encrypted QUIC link established through [iroh](https://iroh.computer)
— not the same Wi-Fi, not a relay you have to trust with plaintext, no account. Run code sessions,
drive Dispatch, read transcripts, approve things. Chat runs **on the phone itself**, so it works
with your Mac asleep and syncs back when the two next see each other.

**And your own app.** `NormaProtocol`, `NormaSessionKit` and `NormaChatKit` are published as Swift
Package products from this repo — the exact same kits Norma's own iOS app is built on. If you want
to build your own client, you get the whole capability surface, not a subset.

## What she can actually do

**She sees your screen and drives your Mac.** Screenshots, accessibility-tree reads, real clicks
and keystrokes — leased through a broker so only one thing holds the input device at a time.

**She has her own browser.** Chromium, embedded in the app, driven over CDP. Full control in Code
and Dispatch; read-only by default in Chat. Sensitive domains are hard-blocked and can't be talked
around. Web *fetching* is entirely local — no third-party reader API sees your URLs.

**She reads what you give her.** PDFs, images, Jupyter notebooks, spreadsheets-as-exports — read
properly, images and all, straight into the model's context.

**She works in parallel.** Subagents with no wall-clock timeout (a progress-stall watchdog instead),
git worktree isolation so parallel work can't collide, and `Workflow` — a sandboxed JavaScript
orchestration runtime where the model *writes the control flow* for fan-out, pipelines and
adversarial verification, and it runs in a seatbelt-confined subprocess.

**She edits code like an IDE.** Monaco tabs with syntax highlighting and completions, real saves
that preserve your BOM and line endings, file watchers with conflict banners, dirty-buffer gates on
close and on quit — and automatic LSP diagnostics after every edit she makes.

**She runs on a schedule.** Routines: check something every morning, tidy a folder nightly, report
every Monday. Unattended, on the daemon's clock.

## Memory that you can read

Two kinds, deliberately.

**In Code mode**, memory is project-scoped and *written by the agent, by hand* — plain markdown
files in a folder on your Mac. No hidden database, no embeddings you can't inspect. Open them in any
editor, correct them, delete them. `norma memory list` and `norma memory show` if you'd rather stay
in the terminal.

**In Chat and Dispatch**, memory is automatic: a background "dreaming" pass distills what mattered
from your conversations, and — just as importantly — *forgets*. Facts that stopped being true get
retired instead of accumulating forever.

Sessions themselves are append-only event logs. Nothing is ever silently deleted: the only automatic
deletions are empty sessions and a once-per-lifetime cleanup pass, and anything you've kept is
permanently immune.

## Background sessions and multiple harnesses

A Code session can be **promoted to the background** — it keeps running with no window attached, no
terminal open, nobody watching. Dispatch runs that way permanently by default.

The inverse also holds: a single session can have **many harnesses attached at once** — the Mac
window, a detached orb window, a TUI, and your phone — and every one of them streams the same tokens
in real time. Close them all and the work continues; open one tomorrow and you rejoin mid-turn.

## Extending Norma

- **MCP servers** — connect any Model Context Protocol server; tools show up in the agent's hands,
  with resources readable too. Tool schemas load on demand, so a hundred MCP tools cost you nothing
  until one is actually used.
- **Skills** — drop-in markdown capability packs. Popular open-source skill packs already run on
  Norma unmodified, and the agent can write its own.
- **Plugins → Add-ons** — separate processes granted narrow, user-consented capabilities. They
  contribute tools, UI tiles and skills back to the agent, and can also be *whole small apps* living
  inside Norma's window (think fan control, window management, a dynamic island). `examples/battery-limiter`
  is a complete working reference. *(The `plugin-sdk` package is being renamed to the Add-ons SDK —
  see the [roadmap](#roadmap).)*
- **Output styles** and **hooks** — reshape how she writes, and run your own code at lifecycle points.

## Your Mac, your data

This part matters more than anything else here, so we'll say it plainly:

- **No credentials ever touch disk.** Every API key, OAuth token and secret lives in the macOS
  Keychain — never in a config file, never in plain text, never in a fixture.
- **Everything she remembers is a file you own.** Memory, settings, session logs — all plain files
  under `~/.norma`. Move them, back them up, read them, delete them.
- **Nothing leaves your machine except model calls.** Web fetching is local, and there is no Norma
  account, backend or telemetry. Your phone connects to your Mac directly, end-to-end encrypted; if
  the two can't hole-punch to each other, the connection falls back to relaying through an
  [iroh](https://iroh.computer) relay we run — which forwards ciphertext it cannot read, and never
  sees a session.
- **The shell is sandboxed.** Commands run under a macOS seatbelt profile with an explicit writable
  set; writes outside your project need your consent, and Norma's own credential directory is
  denied to the agent unconditionally.
- **Every build is signed and notarized by Apple**, and updates are Sparkle EdDSA-signed. Norma
  updates herself in the background and only installs when she's *not* in the middle of helping you
  — she waits for a natural pause, then picks up exactly where she left off.
- **The engine is fully open.** The daemon, the CLI, the Mac app, the protocol and the client kits
  are all in this repository under Apache-2.0. (The iOS app itself is closed source; the kits it is
  built on are not.)

## Bringing your own AI

Norma is the assistant; the intelligence behind her is your own — either your existing ChatGPT
subscription or an OpenAI API key, whichever you signed in with during [install](#install).

Available models are the GPT-5.6 family — `sol`, `terra` and `luna` — selectable per session, with a
reasoning-effort setting from `none` through `max`, plus Norma's own `ultra` tier:

```sh
norma model              # list what's available
norma model sol          # set the default
```

Optional search keys:

```sh
norma login --exa-key           # Exa — powers Search in Chat and Dispatch
norma login --web-search-key    # Brave — powers web_search in Code
```

> Exa's key requirement is going away, and Brave is being retired in favour of Exa everywhere.

**A note in plain language: Norma is an independent project and is not affiliated with, endorsed by,
or sponsored by OpenAI.** Signing in with a ChatGPT account uses that account under OpenAI's own
terms, which don't specifically bless third-party apps — so, as with any tool that isn't OpenAI's
own, there's some risk to that account, and it's yours to weigh. If you'd rather not, the API-key
option is the straightforward, officially-supported path. Either way, your credentials live only in
your Mac's Keychain and Norma keeps no copy.

## For developers

### Architecture

Norma is a **TypeScript/Bun daemon** (`norma-core`) that runs the agent loop — providers, tools,
sessions, plugins, scheduling — and a **native Swift app** that gives it a face. They speak JSON-RPC
2.0 over NDJSON on a Unix socket at `~/.norma/run/core.sock`.

The daemon is the single source of truth. Every client — the CLI, the Mac app, the orb, your phone —
is a *view over its event stream*. Sessions are append-only JSONL logs of typed events; clients
reconstruct state by replaying them and then follow live. That one decision is what makes background
sessions, multi-harness streaming, instant reopen and phone sync all the same mechanism instead of
four features.

```
packages/
  protocol/     the contract: zod schemas for every RPC method and session event
  core/         norma-core: agent loop, tools, providers, sessions, plugins, workflows, routines
  cli/          the `norma` command — Ink/React TUI, headless mode, daemon lifecycle
  plugin-sdk/   what third-party plugins (→ add-ons) build against
apple/
  NormaProtocol/  Swift mirror of the protocol; round-trips every TS-generated fixture in tests
  NormaKit/       Swift daemon client + the iroh transport (NormaSessionKit)
  NormaChatKit/   the standalone on-device chat engine
  Norma/          the macOS app — menu bar, chat window, orb, CEF browser, Monaco editor
examples/       reference plugins (battery-limiter is a real, complete one)
```

### Quickstart

```sh
bun install

cd packages/cli
bun src/main.ts daemon run        # headless daemon
bun src/main.ts -p "hello"        # one-shot, in another terminal
bun src/main.ts                   # interactive TUI
```

Building the Mac app, running the test suites, the protocol change checklist, and the dev/dist
profile split are all in **[CONTRIBUTING.md](CONTRIBUTING.md)** — read it before your first build,
because the app depends on three large vendored artifacts that are fetched, not committed.

## Roadmap

**Being built now**

- Documents, spreadsheets and slides in the panel, backed by headless LibreOffice — created and
  edited by the agent directly, not through an export dance
- Depth for the code editor beyond editing, highlighting and completions
- Per-child detached windows for the orb (today the detached window carries the Dispatch session
  itself)
- Renaming `plugin-sdk` → the Add-ons SDK, and hardening add-ons for real third-party use
- Browser stability, and proving out fully headless background browsing

**Next**

- **Cowork mode** and **Build mode** (see [the table above](#the-three-modes))
- A web UI, so Norma isn't Mac-only for people who just want the chat
- More providers beyond Codex OAuth and OpenAI-compatible
- Deep research, an advisor tool, and image generation (API *and* local — as a tool and as its own
  mode)
- An explicit compaction tool for Dispatch, so long-running orchestration compacts on purpose rather
  than whenever the context happens to overflow

Ideas and disagreement welcome in [Discussions](https://github.com/yanlingLabs/norma/discussions).

## FAQ

**Is this another Claude Code / Codex CLI?** No. Code mode covers that ground and takes real
inspiration from Claude Code's permission model and tool shape — but a coding agent is one of
Norma's three modes, not the product. The product is the whole assistant.

**Does it need a subscription?** It needs *a* model. Either your existing ChatGPT account or an
OpenAI API key. Norma itself is free and open source.

**Does my data go through your servers?** There is no Norma backend, no account and no telemetry.
Model calls go to your provider. Your phone connects to your Mac directly; when a direct connection
isn't possible it falls back to relaying through an iroh relay we run, which only ever forwards
ciphertext — it can't read a session, and holds nothing.

**Windows or Linux?** Not today — Norma is deeply native macOS. A web UI is on the roadmap for the
chat surface.

**Can I use it without the app?** Yes. `norma daemon run` plus the TUI is a complete Code-mode
experience with no app installed.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first, and open
an issue to discuss anything nontrivial before sending a PR. Security reports go through
[SECURITY.md](SECURITY.md) — please don't file them as public issues.

## License

[Apache License 2.0](LICENSE). © 2026 Norma.
