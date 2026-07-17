# Tool inventories — Norma vs. Claude Code

Two reference tables: Norma's built-in agent tools, and Claude Code's fixed built-in
catalogue. **Deferred = Yes** means the tool is hidden behind `ToolSearch` (schema not
loaded / not callable until loaded); **No** means always visible.

---

## Norma — built-in agent tools

Source: `packages/core/src/agent/tools/` + daemon wiring (`packages/core/src/daemon.ts`).
"Deferred = Yes" reflects the per-tool `deferred: true` flag, active whenever built-in
ToolSearch deferral is on (which it is in the production daemon).

| Tool | Deferred | What it does |
|------|:--------:|--------------|
| **Filesystem — read** | | |
| `read` | No | Read a file's contents, with optional line offset/limit to page through large files. |
| `ls` | No | List files and directories one level deep under an absolute path. |
| `glob` | No | List files matching a glob pattern as newline-separated relative paths. |
| `grep` | No | Search file contents with a regex, returning `file:line:text` matches. |
| **Filesystem — write** | | |
| `write` | No | Write a file (creating parent dirs), overwriting if it exists. |
| `edit` | No | Replace an exact string in a file (unique match, or `replace_all`). |
| **Shell** | | |
| `bash` | No | Run a shell command in the sandboxed session dir (no network; supports background mode). |
| `bash_output` | Yes | Read new output produced by a background bash task since the last read. |
| `bash_kill` | Yes | Stop a running background bash task. |
| **Agents & tasks** | | |
| `spawn_agent` | No | Launch a child agent to handle a task autonomously in its own context and return its report. |
| `session_spawn` | No | Spawn a full first-class child session (own transcript, own session-list entry) — dispatch-session-only. |
| `agent_list` | Yes | List your background subagents with status, elapsed time, and description. |
| `agent_output` | Yes | Fetch a subagent's output (or latest message while running) plus its transcript path. |
| `send_message` | No | Send a message to a subagent by id/name to re-task or resume it (fire-and-forget). |
| `task_stop` | Yes | Stop a running background agent, a background bash task, or — in the dispatch session — a dispatch child session. |
| `task_create` | No | Create a task on the session's live to-do list (starts pending). |
| `task_update` | No | Update a task's status, fields, owner, or task-graph links. |
| `task_list` | No | List the session's tasks with their statuses. |
| `task_get` | Yes | Get a single task's full details by id. |
| **Planning & worktrees** | | |
| `enter_plan_mode` | Yes | Switch the session into read-only plan mode to research before editing. |
| `exit_plan_mode` | Yes | Present a finished plan to the user for approval and leave plan mode. |
| `enter_worktree` | Yes | Create an isolated git worktree on a new branch and switch the session into it. |
| `exit_worktree` | Yes | Leave the current git worktree, keeping or removing it. |
| **User interaction** | | |
| `ask_user` | No | Ask the user 1–4 multiple-choice questions when you need them to decide something. |
| `request_directory` | No | Ask the user to grant write access to a directory outside the allowed roots. |
| **Skills & memory** | | |
| `Skill` | No | Load a skill's full instructions into context for the rest of the session. |
| `skill_write` | Yes | Create a new skill or overwrite an existing one's file. |
| `memory_read` | Yes | Read the full body of a saved memory fact by name. |
| `memory_write` | Yes | Save a durable fact to recall in future sessions. |
| `memory_delete` | Yes | Delete a saved memory fact by name. |
| **Web** (only network-capable tools) | | |
| `web_fetch` | Yes | Fetch a URL and return a readable-text preview, saving the full page to a file. |
| `web_search` | Yes | Search the web via Brave and return a numbered list of results. |
| **Code intelligence (LSP)** | | |
| `lsp_diagnostics` | Yes | Get language-server errors/warnings for a file (TS/JS/Swift). |
| `lsp_definition` | Yes | Find the definition of the symbol at a position. |
| `lsp_references` | Yes | Find references to the symbol at a position. |
| **Notifications** | | |
| `push_notification` | Yes | Send a native desktop notification (UNUserNotificationCenter); headless osascript fallback when nobody's attached. |
| **Other** | | |
| `notebook_edit` | Yes | Edit a Jupyter notebook (.ipynb) at the cell level (replace/insert/delete). |
| `schedule` | Yes | Manage scheduled routines — unattended recurring headless prompts. |
| `computer` | No* | Control the Mac: read the AX tree, screenshot, click/drag/type/scroll, wait. |
| `ToolSearch` | — | Load deferred tools' schemas so they become callable. |

**40 built-in tools total** (Dispatch mode's `session_spawn` is the latest addition, after
task-30's `push_notification`). Notes:

- `computer` (`No*`) is only *registered* when `settings.computerUse.enabled` is on; when
  present it's not deferred.
- `ToolSearch` only appears when something is actually deferred (nothing to load → hidden).
- MCP / plugin tools (`mcp__…`, `plugin__…`) aren't listed: they're external and defer on a
  different trigger — a visible-count threshold (or `deferExternals: "always"`), not the
  per-tool `deferred` flag.
- All deferred built-ins ride one predicate in `registry.ts` (`isDeferred`), so `specs()`,
  the ToolSearch index, and `execute()`'s guard can never disagree about what's hidden.
- `session_spawn` is **dispatch-session-only** — the mirror image of `spawn_agent`/`skill_write`/
  `write`/`edit`/`lsp`/`notebook_edit`, which are excluded FROM a dispatch session; a code
  session never sees `session_spawn` at all. Its CC analogue is Cowork's "Dispatch" child
  creation — but unlike `spawn_agent`'s in-session subagent THREAD, a spawned dispatch child is
  a full first-class sibling SESSION (own transcript, own `session.list` entry, independently
  attachable/resumable), not a nested thread of the caller's own session. `task_stop`'s dispatch
  branch is the corresponding teardown: from the dispatch session only, it can stop one of its
  own children by session id, alongside its existing bg-agent/bg-bash-task targets.

---

## Claude Code — fixed built-in catalogue

Source: `claude-code-cli-complete-rebuild-report.md` (corrected 2026-07-11) — canonical
inventory lines 484–527, loading rule 529–557, MCP deferral 561–579.

**Key fact:** *none* of the fixed built-ins start deferred. The report calls the catalogue
*"eager-but-conditional, not deferred"* — every fixed built-in that survives the session's
registration/policy gates is supplied up front and is **not** searched for through
`ToolSearch`. Deferral in CC applies **only to MCP/plugin action tools** (`mcp__*`), which
defer by default under `ENABLE_TOOL_SEARCH`. So the "Deferred?" column is **No for all 42**;
the meaningful axis is the *availability gate* (last column).

| Tool | Deferred? | What it does | Availability gate / status |
|------|:---------:|--------------|----------------------------|
| **Shell** | | | |
| `Bash` | No | Execute shell commands. | Perm-required; command set & sandbox vary by platform/config |
| `PowerShell` | No | Execute native PowerShell commands. | OS rollout / opt-in; needs `pwsh` 7+ |
| **Filesystem — read** | | | |
| `Read` | No | Read text, images, PDFs, and notebooks (files, not directory listings). | Pagination/type limits |
| `Glob` | No | Find paths by glob pattern. | 100-result cap; ignores `.gitignore` by default |
| `Grep` | No | Search file contents with ripgrep regex semantics. | Respects `.gitignore` by default |
| **Filesystem — write** | | | |
| `Write` | No | Create or wholly overwrite a file. | Read-before-overwrite for existing files |
| `Edit` | No | Exact, targeted string replacement. | Read-before-edit + unique-match checks |
| `NotebookEdit` | No | Insert, replace, or delete a notebook cell. | Uses `Edit(...)` path permissions |
| **Agents & messaging** | | | |
| `Agent` | No | Spawn or resume an isolated-context subagent. | Child tools depend on agent definitions/rules |
| `SendMessage` | No | Message/resume a subagent, or message a team peer. | Team-protocol messages need agent teams |
| **Tasks & todo** | | | |
| `TaskCreate` | No | Create one structured task. | Default task system |
| `TaskGet` | No | Get one task's full details. | Current task system |
| `TaskList` | No | List a task snapshot. | Current task system |
| `TaskUpdate` | No | Patch, relate, assign, complete, or delete a task. | Current task system |
| `TaskOutput` | No | Read a background task's output. | Deprecated — prefer `Read` on the output file |
| `TaskStop` | No | Stop a background task/agent. | Accepts more agent identifiers in v2.1.198+ |
| `TodoWrite` | No | Replace the legacy todo checklist wholesale. | Disabled by default since v2.1.142 |
| **Planning & worktrees** | | | |
| `EnterPlanMode` | No | Enter read-only planning mode. | Mode support varies by surface |
| `ExitPlanMode` | No | Present a plan for approval and leave plan mode. | Approval never idle-auto-resolves |
| `EnterWorktree` | No | Create or enter an isolated worktree. | Needs git or custom worktree hooks |
| `ExitWorktree` | No | Leave the current worktree session. | Unavailable to agents pinned to their own cwd |
| **User interaction** | | | |
| `AskUserQuestion` | No | Ask 1–4 structured multiple-choice questions. | Not available inside `Agent`-spawned subagents |
| **Skills** | | | |
| `Skill` | No | Load and execute a skill in the conversation. | Body is lazy-loaded; rules/frontmatter can hide it |
| **Web** | | | |
| `WebFetch` | No | Fetch a URL and run an extraction prompt over it. | Lossy small-model extraction; per-domain perm flow |
| `WebSearch` | No | Search Anthropic's web-search backend. | Provider/model dependent |
| **Code intelligence** | | | |
| `LSP` | No | Language-server navigation and diagnostics. | Needs code-intel plugin + server binary |
| **Scheduling & routines** | | | |
| `CronCreate` | No | Create a session-scoped one-shot or recurring prompt. | v2.1.72+; `CLAUDE_CODE_DISABLE_CRON=1` disables |
| `CronDelete` | No | Delete a scheduled session task. | Same scheduler gate |
| `CronList` | No | List scheduled session tasks. | Same scheduler gate |
| `ScheduleWakeup` | No | Choose or stop the next self-paced `/loop` wakeup. | `stop` needs v2.1.202+ |
| `RemoteTrigger` | No | Manage and run claude.ai Routines. | Paid plan, web on, Anthropic-hosted; research preview |
| **Notifications & delivery** | | | |
| `PushNotification` | No | Send a desktop (and, when connected, phone) notification. | Anthropic-hosted; Remote Control for mobile |
| `SendUserFile` | No | Deliver a generated file to a connected user/client. | Remote Control / managed cloud; not on 3rd-party providers |
| **Publishing** | | | |
| `Artifact` | No | Publish HTML/Markdown as a private claude.ai artifact. | Paid plan, `/login`, Anthropic provider, policy/surface gates |
| `ShareOnboardingGuide` | No | Upload `ONBOARDING.md` and return a share link. | Pro/Max/Team/Enterprise claude.ai subscribers |
| **Code review** | | | |
| `ReportFindings` | No | Emit structured code-review findings. | v2.1.196+; active only when review instructions turn it on |
| **Monitoring** | | | |
| `Monitor` | No | Stream command/WebSocket events into the conversation. | v2.1.98+; provider & telemetry gates |
| **Orchestration** | | | |
| `Workflow` | No | Execute a scripted multi-subagent workflow. | v2.1.154+; paid/API/cloud providers; disableable |
| **MCP plumbing** | | | |
| `ToolSearch` | No† | Discover and load *deferred MCP tool* schemas. | Enabled by default where model/provider supports it |
| `WaitForMcpServers` | No | Wait for still-connecting MCP servers. | Registered **only** when `ToolSearch` is off/unavailable |
| `ListMcpResourcesTool` | No | List MCP resources. | Only when connected servers expose resources |
| `ReadMcpResourceTool` | No | Read an MCP resource by server and URI. | Only when a server exposes the resource |

**42 fixed built-in tools total** (excludes slash commands, keyboard actions, CLI
subcommands, and the server-side `advisor` tool). Notes:

- **† `ToolSearch` is itself eager, not deferred** — it's the *loader* for deferred MCP
  tools. Mutually exclusive with `WaitForMcpServers`: only one is registered.
- **The actual deferred family** = MCP/plugin action tools (`mcp__server__tool`, and
  plugin-bundled `mcp__plugin_<name>_<server>__<tool>`). `ENABLE_TOOL_SEARCH` governs it:
  `unset`/`auto` = defer & load on demand, `true` = force-defer all, `false` = load all up
  front. A server or single tool can opt out with `alwaysLoad` (v2.1.121+).
- **Not deferred despite confusion:** plugin *skills* (run via `Skill`), plugin *agents*
  (become `Agent` types), *LSP* plugins (configure the fixed `LSP` tool), and plugin `bin/`
  executables (enter `Bash`'s `PATH`) — none register new deferred tool names.

---

## Norma vs. CC — the contrast

- CC keeps its whole fixed catalogue **eager** and defers **only** external MCP tools.
- Norma additionally defers ~20 of its **own** built-ins via a per-tool `deferred: true`
  flag riding the same ToolSearch machinery.
- Same mechanism, broader application in Norma. CC's built-ins are "conditional" (gated by
  version/plan/provider/OS) rather than deferred; Norma's counts: 39 built-ins vs. CC's 42.
- `PushNotification`/`push_notification` (task-30) closes the last item on this list: Norma's
  version leans on a REAL Mac app for delivery — a native `UNUserNotificationCenter` alert with
  proper app identity — rather than CC's undocumented hosted delivery, plus a headless `osascript`
  fallback when nobody's attached at all (CC's hosted Remote Control phone delivery is out of
  scope for Norma).
- Update (SP2a): Norma's own remote transport — a Mac-side `Gateway` fronted by a real iroh P2P
  listener, proven end-to-end (real daemon + real iroh) in `IrohE2ETests.swift` — is now live code,
  though dev/test-only until SP2b's pairing ceremony ships.
