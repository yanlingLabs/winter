<h1 align="center">Winter</h1>

<p align="center">
  <b>An AI assistant that lives on your Mac.</b><br>
  Talk to it, let it write your code, or hand it a job and walk away,
  using the AI you already pay for.
</p>

<p align="center">
  <a href="https://github.com/yanlingLabs/winter/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/yanlingLabs/winter?label=release&color=2E9484"></a>
  <img alt="macOS 26+ on Apple silicon" src="https://img.shields.io/badge/macOS-26%2B%20·%20Apple%20silicon-lightgrey.svg">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
</p>

---

Winter sits in your menu bar. You can chat with it, point it at a project and let it code, or
give it an errand like *"find out why the build got slow and fix it"* and get on with your day
while it works. It's one native Mac app. There's no account to create and no Winter server in
the middle, and it runs on whichever model you want: your ChatGPT plan, Claude, DeepSeek, Gemini,
or any of a hundred-odd others.

## Quick start

```sh
brew tap yanlingLabs/winter
brew install --cask winter
winter login          # sign in with your ChatGPT account
```

That's all. Open Winter from Applications and it moves into your menu bar. The `winter` command
works in any terminal too.

Want a different model? Skip `winter login`, open **Settings › Providers** in the app and paste
an API key for Anthropic, OpenAI, DeepSeek, Google, OpenRouter or anyone else on the list.

Winter needs **macOS 26 or later on Apple silicon**. If you'd rather not use Homebrew, grab the
`.dmg` from [Releases](https://github.com/yanlingLabs/winter/releases/latest) and drag Winter
into Applications. (Newer Homebrew may ask you to trust the tap once:
`brew trust yanlingLabs/winter`.)

## Three ways to work

**Chat** is for asking things. It searches the web, reads what it finds and remembers what
matters about you from one conversation to the next. It has no access to your files and can't
run anything, so it never has to stop and ask your permission.

**Code** is a full coding agent. Point it at a folder and it reads and writes code, runs your
build and tests, uses git and fixes whatever the language server complains about. Big jobs get
split across helper agents, each working in its own copy of the repo so they don't step on each
other. You decide how much it does without asking, from "only make a plan" to "don't ask me at
all," and it remembers the answers you've already given.

**Dispatch** is the assistant that's always there. Give it a job and it starts as many Code
sessions as the job needs, keeps an eye on them and comes back when it's done. You can pull any
of those sessions into its own window to watch, or step in and take over.

The walls between modes are real. A Chat session can't touch your disk, whatever a web page or
anyone else tells it to do, because Winter never gives Chat those tools in the first place.

## It works on your Mac, with you

Tap the trackpad with four fingers anywhere, in any app, and a small orb gives you a text field.
Whatever you type goes straight to Dispatch.

The main window has a panel next to the conversation where Winter does its work in the open.
There's a real Chromium browser, a real code editor, diffs you can review, and Word documents,
spreadsheets and slide decks that it edits while you watch (and ⌘Z undoes its edits like your
own). You and Winter use the same tabs at the same time.

It can see your screen and use your Mac, clicking and typing like you would, and it reads PDFs,
images and notebooks you hand it. Work doesn't stop when you close the window either: sessions
keep running in the background, and when you open one again you're right where it is, even
mid-reply. If you live in the terminal, `winter` opens the same sessions as a full terminal UI,
and `winter -p "…"` gives you one-shot answers for scripts.

## Any model, switched any time

Winter runs on your own account: a ChatGPT sign-in, an OpenAI or Anthropic API key, an Anthropic
Console login, or a key from any of the 100+ providers it knows (DeepSeek, Z.ai, Google, xAI,
Mistral, Groq, OpenRouter and many more). Claude models in Code mode run on Anthropic's own agent
runtime, so they behave the way they were built to.

You can also change models in the middle of a conversation, even from Claude to GPT to DeepSeek
and back, and the conversation comes with you. If a switch would leave something behind (such as
a model's private reasoning), Winter tells you before it happens.

```sh
winter model                          # see what you can use
winter credentials set deepseek       # add a key (asked for privately, never on the command line)
```

## It remembers, and it forgets

In Code mode, memory is plain markdown files on your Mac, written by the agent. You can open,
edit or delete them in any editor. Nothing is hidden in a database you can't read.

In Chat and Dispatch, memory looks after itself. Every so often Winter looks back over your
conversations, keeps what mattered, and retires things that stopped being true instead of piling
them up forever.

## On your iPhone

The iPhone app connects straight to your Mac, encrypted end to end, with no account and no cloud
service holding your conversations. You can pick up any session, approve what Code wants to do,
or send Dispatch a job while you're away from your desk. Chat runs on the phone itself, so it
works even while your Mac sleeps and syncs up later. A TestFlight build is on its way; the link
will land here.

## Your Mac, your data

Your API keys and sign-ins live in the macOS Keychain, never in a config file. Everything else
Winter keeps (memory, settings, every conversation) is a plain file in `~/.winter` that you can
read, back up or delete.

There's no Winter account, no Winter backend and no telemetry. Your messages go to the model
provider you picked. Web searches go to [Exa](https://exa.ai), or to Anthropic when a Claude model
in Code mode does the searching, and pages are fetched straight from your Mac. When your phone
can't reach your Mac directly, the connection passes through a relay that only ever sees
encrypted data.

Shell commands run inside a macOS sandbox, writing outside your project needs your OK, and
known-dangerous websites are blocked in every mode. Every build is signed and notarized by Apple.
Winter updates itself in the background and waits for a quiet moment to install, so it never
cuts you off mid-task. And you don't have to take any of this on trust: the app, the engine, the
command line and the protocol are all open source in this repository under Apache 2.0. (The
iPhone app is closed source, but the Swift packages it's built on live here.)

## Make it yours

Connect any **MCP server** and its tools show up in the agent's hands. Tools load only when
they're needed, so a big collection costs nothing until something is used. Drop in **skills**
(popular open-source skill packs work unmodified, and Winter can write its own). **Plugins** run
as separate processes with only the permissions you grant them; there's a working example in
[`examples/battery-limiter`](examples/battery-limiter). **Routines** run jobs on a schedule, like
a morning check-in or a nightly folder tidy, and **hooks** let your own scripts run at key
moments.

## A note on accounts

Winter is an independent project, not affiliated with or endorsed by OpenAI or Anthropic. Signing
in with a ChatGPT account uses that account under OpenAI's terms, which don't specifically cover
third-party apps, so there's some risk there and it's your call. An API key is the by-the-book
route. Either way your credentials stay in your Mac's Keychain and Winter keeps no copy.

## FAQ

**Is it free?** Winter is free and open source. You pay your model provider as usual, or use the
ChatGPT plan you already have.

**Is this just another coding agent?** Coding is one of three things it does. The point is having
one assistant for everything, living on your Mac.

**Can I use it only from the terminal?** Yes. `winter` gives you the whole Code mode experience
in the terminal.

**Windows or Linux?** No. Winter is built for the Mac from the ground up.

## For developers

Winter is a TypeScript/Bun background service (`winter-core`) plus a native Swift app, talking
JSON-RPC over a local socket. The service is the single source of truth: every session is an
append-only log of events, and the Mac app, the terminal UI and the phone are all live views of
that log. That one design choice is why background sessions, several windows on one session, and
phone sync all come for free.

```
packages/protocol   the contract: schemas for every RPC method and session event
packages/core       the service: sessions, tools, models, memory, plugins, routines
packages/cli        the `winter` command and its terminal UI
packages/plugin-sdk what plugins build against
apple/              the Mac app and the Swift client packages (also used by the iPhone app)
```

```sh
bun install
cd packages/cli
bun src/main.ts daemon run     # run the service
bun src/main.ts                # open the terminal UI (in another terminal)
```

Building the Mac app, running the tests and keeping a dev copy separate from your everyday one are
covered in **[CONTRIBUTING.md](CONTRIBUTING.md)**. Read it before your first build.

## Contributing

Issues and pull requests are welcome. Open an issue first for anything big, and send security
reports through [SECURITY.md](SECURITY.md) rather than a public issue. Ideas and questions go in
[Discussions](https://github.com/yanlingLabs/winter/discussions).

## License

[Apache License 2.0](LICENSE). © 2026 Winter.
