<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/lockup-on-dark.svg">
    <img alt="Winter" src="assets/brand/lockup-on-light.svg" width="250">
  </picture>
</p>

<h3 align="center">Hand it a job. Get on with your day.</h3>

<p align="center">
  An AI assistant that lives on your Mac. It starts the sessions, watches them work<br>
  and reports back, using the AI you already pay for.
</p>

<p align="center">
  <a href="https://github.com/yanlingLabs/winter/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/yanlingLabs/winter?label=release&color=2E9484"></a>
  <img alt="macOS 26+ on Apple silicon" src="https://img.shields.io/badge/macOS-26%2B%20·%20Apple%20silicon-lightgrey.svg">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
</p>

<p align="center">
  <a href="#install"><b>Install</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/yanlingLabs/winter/releases/latest"><b>Download</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/yanlingLabs/winter/releases"><b>What's new</b></a>
</p>

<p align="center">
  <img src="assets/readme/dispatch.avif" width="100%" alt="Dispatch on a Mac: a prompt goes in, three Code sessions rise above the Dispatch pill, their windows open while they work, and Dispatch reports back when all three are done.">
</p>

## Dispatch

**One prompt in. The work fans out. Dispatch reports back.**

Tap the trackpad with four fingers in any app, or press <kbd>⌃</kbd><kbd>⌥</kbd><kbd>⌘</kbd><kbd>Space</kbd>,
and the Dispatch pill rises at the bottom of your screen. Tell it what you need the way you'd tell a
colleague: *"Get 2.4 out: check the milestone, fix the flaky login test, bump deps and draft the
release notes."*

- **It fans the work out.** Dispatch splits the job and starts a Code session for each part, in the
  right project, all running at once. Each one sits as a small pill above Dispatch, its plume
  showing what it's doing right now: reading files, running commands, searching the web.
- **Open any session.** Click a pill and that session opens in its own window. Follow every step and
  its thinking as it happens, or type into it to steer.
- **Approve from where you are.** When a session needs your OK, its pill turns orange and the
  request appears right above the Dispatch pill. If you're not looking, you get a notification.
- **It reports back.** When sessions finish, Dispatch wakes up and tells you how they went.

Dispatch can also search back through all your Code sessions (*"the one where we fixed the login
test last week"*), send a running session new instructions, stop one that's heading the wrong way,
and put a job on a schedule.

## Install

```sh
brew tap yanlingLabs/winter
brew install --cask winter
winter login          # sign in with your ChatGPT account
```

Open Winter from Applications and it moves into your menu bar. The `winter` command comes with it.

Want a different model? Skip `winter login`, open **Settings › Providers** and paste an API key for
Anthropic, OpenAI, DeepSeek, Google, OpenRouter or anyone else on the list.

Winter needs **macOS 26 or later on Apple silicon**. Rather not use Homebrew? Grab the `.dmg` from
[Releases](https://github.com/yanlingLabs/winter/releases/latest) and drag Winter into Applications.
(Newer Homebrew may ask you to trust the tap once: `brew trust yanlingLabs/winter`.)

## Also in Winter

### Code

A full coding agent. Point it at a folder and it reads and writes code, runs your build and tests,
uses git and fixes what the language server flags. Big jobs go to helper agents that work in
parallel, each able to take its own git worktree. You choose how much it does on its own, from
**Plan** (only make a plan) to **Bypass** (never ask), and it remembers the answers you've already
given. Paste a screenshot into the message box and it looks at it.

### Chat

For asking things. It searches the web, reads what it finds and knows what Winter has learned about
you. Chat has no file or shell tools of its own, and the only time it stops to ask is when one of
your connectors wants to do something you haven't already allowed.

### Work in the open

The main window has a panel beside the conversation where Winter works in plain sight: a real
Chromium browser you both use, a code editor, diffs to review and, in Code, Word documents,
spreadsheets and slide decks it edits while you watch (⌘Z undoes its edits like your own). It looks
at the images and screenshots you hand it and reads Jupyter notebooks, plots included. Turn on
computer use and Code and Dispatch can see your screen, then click and type like you would.

Sessions keep running when you close the window. Open one again and you're right where it is, even
mid-reply. If you live in the terminal, `winter` opens your Code sessions in a full terminal UI, and
`winter -p "…"` gives one-shot answers for scripts.

### Any model, switched any time

Winter runs on your own account: a ChatGPT sign-in, an OpenAI or Anthropic API key, an Anthropic
Console login, or a key from any of the 100+ providers it knows (DeepSeek, Z.ai, Google, xAI,
Mistral, Groq, OpenRouter and many more). Every model, Claude included, runs on Winter's own agent
runtime, with the same tools and the same approvals.

Change models mid-conversation, even from Claude to GPT to DeepSeek and back, and the conversation
comes with you; switch back and the old model picks up its own reasoning. If a switch would leave
something behind, like images going to a model that can't read them, Winter asks first.

```sh
winter model                          # see what you can use
winter credentials set deepseek       # add a key (asked for privately, never on the command line)
```

### It remembers, and it forgets

In Code, memory is plain markdown files the agent keeps for each project, which you can open, edit
or delete in any editor. Chat and Dispatch share a memory that looks after itself: every so often
Winter reads back over your Dispatch conversation, keeps what matters and rewrites or retires what
stopped being true.

### On your iPhone

The iPhone app connects straight to your Mac, encrypted end to end, with no account. Pick up any
session, approve what Code wants to do, or send Dispatch a job from wherever you are. Chat runs on
the phone itself, so it works even while your Mac sleeps. A TestFlight build is on its way; the
link will land here.

### Make it yours

Connect **MCP servers** (sign in to ones like GitHub or Cloudflare right from Winter) and choose,
action by action, what each may do without asking. Their tools load only when they're needed, so a
big collection costs nothing until it's used. Add **skills** in the familiar `SKILL.md` format, set
up **routines** that run a job on a schedule (`winter routines`), and for the biggest jobs let
Winter write a **workflow**: a script that fans the work out to as many background agents as it
needs, run in a sandbox once you've said yes.

## Your Mac, your data

- **Your keys stay in the Keychain.** API keys and your ChatGPT sign-in live in the macOS Keychain,
  readable only by Winter itself. Everything else (memory, settings, every conversation) stays in
  `~/.winter`, in files you can read, back up or delete.
- **No account, no telemetry.** Your messages go straight to the model provider you picked. Web
  searches go to [Exa](https://exa.ai) (its free tier, or your own key) and pages are fetched
  straight from your Mac. The only Winter server the app talks to is its update feed. When your
  phone can't reach your Mac directly, the connection goes through a relay that only ever sees
  encrypted data.
- **Guardrails on by default.** Shell commands run inside a macOS sandbox, writing outside your
  project asks first (unless you've chosen Bypass), and sites commonly used to smuggle data out,
  like paste bins, anonymous file drops and tunnels, are blocked in every mode.
- **Built to be checked.** Every build is signed and notarized by Apple, and updates install
  themselves only when nothing is running and nothing is unsaved. The app, the engine, the command
  line and the protocol are open source here under Apache 2.0. (The iPhone app is closed source; the
  Swift packages it's built on live here.)

## FAQ

**Is it free?** Winter is free and open source. You pay your model provider as usual, or use the
ChatGPT plan you already have.

**Is this just another coding agent?** Coding is one part of it. The point is one assistant for
everything on your Mac, one that can run several jobs at once and tell you how they went.

**Can I use it only from the terminal?** For Code, yes: `winter` gives you full Code sessions in the
terminal. Dispatch and Chat live in the app.

**Windows or Linux?** No. Winter is built for the Mac from the ground up.

**Is Winter affiliated with OpenAI or Anthropic?** No, it's an independent project. Signing in with
a ChatGPT account uses that account under OpenAI's terms, which don't specifically cover third-party
apps, so there's some risk there and it's your call. An API key is the by-the-book route. Either way
your credentials stay in your Mac's Keychain and Winter keeps no copy.

## For developers

Winter is a TypeScript/Bun background service (`winter-core`) plus a native Swift app, talking
JSON-RPC over a local socket. The service is the single source of truth: every session is an
append-only log of events, and the Mac app, the terminal UI and the phone are all live views of
that log. That one choice is why background sessions, several windows on one session and phone sync
all come for free.

```
packages/protocol   the contract: schemas for every RPC method and session event
packages/core       the service: sessions, tools, models, memory, routines
packages/cli        the `winter` command and its terminal UI
apple/              the Mac app and the Swift client packages (also used by the iPhone app)
```

```sh
bun install
cd packages/cli
bun src/main.ts daemon run     # run the service
bun src/main.ts                # open the terminal UI (in another terminal)
```

Building the Mac app, running the tests and keeping a dev copy apart from your everyday one are all
covered in **[CONTRIBUTING.md](CONTRIBUTING.md)**. Read it before your first build.

Issues and pull requests are welcome. Open an issue first for anything big, send security reports
through [SECURITY.md](SECURITY.md) rather than a public issue, and bring ideas and questions to
[Discussions](https://github.com/yanlingLabs/winter/discussions).

## License

[Apache License 2.0](LICENSE). © 2026 Winter.
