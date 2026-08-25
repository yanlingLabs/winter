import { isExternalToolName } from "./tools/registry";

export type GateDecision = "allow" | "ask" | "deny";
// Plan-immunity (2026-07-28 design, USER-REVISED mid-implementation): "chat" is chat-mode's OWN
// fixed, immutable policy — NOT a user-selectable mode like the other six. It is core-internal
// only and NEVER crosses the wire: packages/protocol/src/methods.ts's `ApprovalPolicy` zod enum
// (session.create/session.setPolicy's wire schema) stays exactly six-valued, so a client can never
// even EXPRESS "chat" in an RPC — it can only ever be produced by engine.ts's own turn-time
// resolution (a chat-mode session's effective policy) or persisted by session.create's chat-seam
// coercion (server.ts). Read as "the fixed policy of chat mode" wherever it appears below — not to
// be confused with `mode === "chat"` (SessionStore's session-identity field, a totally different
// axis) even though the two are obviously related by design.
export type SessionApprovalPolicy = "plan" | "dont-ask" | "ask" | "accept-edits" | "auto" | "bypass" | "chat";

// Skill is read-only: it reads a SKILL.md body and marks it loaded in-memory (no filesystem
// mutation) — same class as read/glob/grep. Without this it would fall through to the
// unclassified "always ask" branch below, which would block session-sticky skill loading even
// under `auto` policy (that branch ignores policy entirely, by design — fail-closed for
// genuinely unknown tools).
// ToolSearch is the same class: it reads the (in-memory) deferred tool index and marks matched
// tools loaded for the session — no filesystem/network mutation. It must be classified here (not
// left to fall through, and NOT matched by the isExternalToolName check below — its own name never
// starts with `mcp__`/`plugin__`) so schema-loading itself never requires approval, even under `ask` policy.
// ask_user/task_create/task_update/task_list are read-only too: ask_user only emits a
// question_asked event and blocks on the QuestionBroker (no fs/process mutation — the human is
// the approval, so a gate prompt on top would double-ask); the task tools (registered in a later
// task) only maintain in-memory/session task state and emit task_updated.
// AskQuestion (B1-T3, chat's simplified question tool) is the SAME class as ask_user for the
// SAME reason: it only emits question_asked/blocks on the QuestionBroker, never touches fs/
// process state. Without this it would fall through to the unclassified "always ask" branch below
// — which ignores policy entirely — and every chat question would card for approval even under
// `auto` (chat's own default), double-asking the human to approve asking them something.
// exit_plan_mode is read-only too: it only presents a plan for approval (no fs/process mutation)
// — it must stay allowed under "plan" policy or the model could never exit plan mode.
// spawn_agent is read-only too: allowed in ALL modes, including plan — it's orchestration (launching
// a child agent), not a mutation itself. The child inherits the parent's approval policy (engine.ts's
// bridge passes the SAME `meta` object down), so the child's own mutating tool calls still get gated
// by that policy — spawning doesn't bypass anything, it just delegates.
// task_get is read-only too (4g Task 4): a pure TaskStore lookup, same class as task_list.
// enter_plan_mode is read-only too (4g Task 4): it only flips the session's approval policy to
// "plan" (no fs/process mutation) — it must be allowed under EVERY policy, including "plan" itself
// (calling it while already in plan mode is a no-op the engine bridge turns into a typed error,
// not a gate denial), so the model can always request the restrictive mode.
// send_message is read-only too (4h-ii-b Task 4): allowed in ALL modes, including plan — like
// spawn_agent it's orchestration (directing an already-launched child), not a mutation itself; the
// child's own mutating tool calls still get gated by the child's policy. In practice the engine's
// send_message bridge intercepts a depth-0 call and sets its tool_result BEFORE the gate is
// consulted, so this classification only backstops a stray depth>0 call (send_message is excluded
// from child tool sets, so this can only fire if a provider ignores that) — allow it to return the
// bridge/placeholder path cleanly rather than hang on an approval prompt.
// task_stop is read-only too (4h-ii-c Task 2): orchestration like spawn_agent/send_message — it
// only aborts Norma's OWN child work (a bg agent's AbortController, or a bg bash task it started)
// and never touches anything external on its own; CC's TaskStop prompts no approval either.
// CC-parity cleanup (removal of the redundant standalone `bash_kill` tool): task_stop's bash-task
// branch is now the ONLY way to kill a background bash task — there is no longer a separate
// MUTATING-gated `bash_kill` path a bash caller could reach for the exact same kill. This was
// flagged here for review while both tools existed (the READ_ONLY/MUTATING split for the same
// underlying OS-process-kill action); it's resolved in favor of matching CC, whose single
// TaskStop also prompts no approval — task_stop's target is Norma's own bookkeeping (a bg agent
// or a bg bash task IT started), not an arbitrary external process, so READ_ONLY stands.
// agent_list/agent_output (phase 5a Task 1) are read-only too, per the plan's own global
// constraint ("New tools are READ_ONLY ... they only read registry/store state"): both only ever
// read BackgroundAgentRegistry/SessionStore state (agent_output never flips `notified`) — same
// class as task_get/task_list, and must stay allowed under `plan` so a planning session can still
// check on its background agents.
// `lsp` (lsp consolidation T2 — replaces phase 5f's lsp_diagnostics/lsp_definition/lsp_references,
// net -2) is read-only too: every action only queries a language server (spawned/reused via
// LspManager) or reads a one-line disk preview through the SAME read fence the tool's own
// `file_path` arg is held to — no fs/process mutation, same class as read/glob/grep. Must stay
// allowed under `plan` so a planning session can still look up diagnostics/definitions/references/
// hover/symbols while researching.
// T1 (file-based memory, design doc `2026-07-15-file-based-memory-design.md`) DELETED the
// memory_read/memory_write/memory_delete tools that used to have their own entries here (phase 5b
// Task 2) — memory reads/writes now go through the plain read/write/edit tools (already
// classified below), riding their EXISTING gate posture with no new class of its own.
// push_notification (task-30) is read-only too: it only emits a notification_requested event
// (engine.ts's `notify` bridge) and, when nobody's attached, shells a FIXED osascript command
// whose only model-controlled inputs are the title/message strings themselves (never a path,
// command, or arbitrary argv — see notify-fallback.ts's argv-safety doc comment) — no fs/process
// mutation the model could use for anything beyond "put this text on screen." Same class as
// ask_user: gating it behind an approval card would be a card asking permission to tell the user
// something, which defeats the point (CC's own PushNotification prompts no approval either). Must
// stay allowed under `plan` too — flagging a decision/finish is exactly the kind of thing a
// planning session should still be able to do.
// list_sessions/manage_session are read-only too (dispatch-tool-deferral gate-classification
// follow-up): list_sessions only ever reads SessionStore/registry state and bounded transcript
// bytes, same class as task_get/agent_list. manage_session's targets are Norma's OWN session
// bookkeeping, never an arbitrary external process — `stop` is the SAME resumable ESC abort
// task_stop already rides free above; `background`/`archive`/`resume` only flip two reversible
// per-session flags (sessions/set-activity.ts). The reviewed design substitutes LOUDNESS for a
// confirmation card: every change broadcasts `session_activity` globally (T4) so every attached
// harness sees it live, rather than a human approving it first — matching dispatch's standing "no
// permission cards" posture. Left unclassified, both fell through to evaluate()'s final
// unclassified-tool branch below, which fails closed to "ask" under EVERY policy including `auto`
// (dispatch's own default — server.ts's session.dispatch) — a card a headless coordinator can never
// answer, so in practice a silent hang/timeout-deny on every real call. Same fix shape as
// task_stop's own entry above.
// office-agent-tools T3: `sheets` (T3: info/read only, READ_ONLY — see the MUTATING set below for
// T4's reclassification now that it has write verbs too). READ_ONLY's own reasoning for the read
// half, kept for the record: not NETWORK — the class boundary this file draws (LOW-2's own comment
// on `NETWORK`, above) is CALLER-DIRECTED EGRESS to a destination the daemon does not already trust
// (a url, an external endpoint) versus "the local filesystem the user already controls" — `sheets`
// opens a path that must ALREADY resolve inside this session's own working directories (its own
// fence, `sheets.ts`'s `officeSheetsResolvedPathWithinFence`, refuses anything else before
// dispatch), never a caller-supplied destination outside that. A spreadsheet cell COULD carry
// adversarial text, but that is the identical risk `read`/`glob`/`grep` already accept without a
// NETWORK-style classification — the document is local, fenced, and already inside the boundary the
// user granted Norma, unlike a url a model could point at anything.
const READ_ONLY = new Set(["read", "glob", "grep", "ls", "bash_output", "Skill", "ToolSearch", "ask_user", "AskQuestion", "task_create", "task_update", "task_list", "task_get", "exit_plan_mode", "enter_plan_mode", "spawn_agent", "send_message", "task_stop", "agent_list", "agent_output", "lsp", "push_notification", "list_sessions", "manage_session"]);
// `computer` (Phase 5 CU) is MUTATING: a computer-use action drives real mouse/keyboard/screen, so
// it must pass the gate on EVERY call (spec §4.6: "every CU action passes the permission gate") —
// ask → per-action approval card, auto → allow, plan → deny (CU makes changes). Note this is the
// PER-ACTION gate; the per-CLASS lease gate (2f: broker.lease follows the session policy) is a
// SEPARATE, earlier consent, and the whole tool is additionally opt-in via settings.computerUse.
// schedule (phase 5 routines T3, design doc §4) sits in MUTATING, not READ_ONLY: `schedule create`
// stands up an unattended, headless-firing routine — a standing prompt-injection surface (the
// design doc's own Security section calls this out explicitly) — so it must be gate-carded exactly
// like write/edit/bash: ask under `ask`, allow under `auto`, and outright denied under `plan` (a
// plan-mode session must not be able to SCHEDULE a future mutation any more than it can perform one
// now). `list`/`enable`/`disable`/`delete` ride the same class as a deliberate simplification — one
// tool, one gate decision, no op-dependent carve-out.
// T1 (file-based memory) note: a memory-fact write now lands through the plain `write`/`edit`
// tools below — same MUTATING class, same "ask under `ask`, allow under `auto` with no card" shape
// the OLD memory_write already had (THE USER PIN, design doc §"Status", 2026-07-08 sketch §5b:
// "the model writes... on its own judgment; no card under auto policy"), just with no
// memory-specific gate entry needed anymore since write/edit already ride it.
// Workflow (CC-parity phase 3, Task B2; CORRECTED by Task B-gatefix, user decision 2026-07-22) is
// plain MUTATING — no special carve-out anymore. B2 originally gave it ONE extra accept-edits
// carve-out here, reasoning that since a workflow's spawned agents ALWAYS run at a FIXED
// accept-edits floor (engine.ts's runWorkflowAgent hardcodes childPolicy: "accept-edits"), launching
// from a session already AT or above that policy (accept-edits/auto/bypass) escalated no trust, so
// it should ride free like `auto`/`bypass` already do for every MUTATING tool. The user decided that
// reasoning doesn't matter here: a launch starts a background run of up to 1000 agents, unattended,
// so a human must confirm EVERY one — CC parity (CC cards under accept-edits on every run, and
// reviews-or-cards under auto too), not just the launches weaker than accept-edits. So Workflow now
// rides the plain-MUTATING path like bash/schedule/etc. for `plan`/`dont-ask`/`ask`/`bypass`
// (`plan`→deny, `dont-ask`/`ask`→ask, `bypass`→allow), the accept-edits carve-out below is GONE
// (falls to the same final `return "ask"` any non-edit MUTATING tool gets), and `auto` gets its OWN
// one-line special case — see the comment just above the `auto` check in evaluate() below for why
// that's a bespoke card, not the AI reviewer bash/fs/external get. EDIT_CLASS is (and always was)
// write/edit ONLY.
// B2-T7: `session_spawn` joins MUTATING — the THIRD unclassified tool this branch has turned up, and
// the one the new completeness pin found by itself (the other two were found by reading).
//
// **Why not READ_ONLY beside `spawn_agent`**, which is the obvious answer and which session-spawn.ts's
// own header invites ("the spawn_agent precedent"): spawn_agent's entry above earns its READ_ONLY on
// one specific clause — "the child inherits the parent's approval policy (engine.ts's bridge passes
// the SAME `meta` object down), so the child's own mutating tool calls still get gated by that
// policy". That clause is FALSE here. A session_spawn child is a full first-class session created at
// a FIXED `approvalPolicy: "auto"` (agent/dispatch-children.ts:72), whatever the caller's own policy
// is — so it is not merely delegating within a policy, it is starting unattended work at one. That is
// the same shape `schedule` and `Workflow` are already MUTATING for ("stands up an unattended,
// headless-firing routine"; "starts a background run of up to 1000 agents"), and the same reason
// `plan` must keep denying it: a planning session must not be able to start a mutating session any
// more than it can mutate now.
//
// **The reach, honestly.** This omission is LATENT rather than live, unlike `browser`'s. In a real
// dispatch session the engine's session_spawn BRIDGE populates `spawnOutcomes` and the per-call loop
// consumes it at engine.ts's `preOutcome` branch, which sits BEFORE `gate.evaluate` — so the call
// never reaches this file at all. It becomes live exactly when that bridge is inactive: a daemon with
// `cfg.dispatch` unwired (engine.ts names that case), where the call falls through to the per-call
// loop and, unclassified, drew an approval card under `auto` — dispatch's own default — in a session
// with no human to answer it. Classified, only ONE cell moves: `auto` (ask → allow). plan stays deny,
// bypass stays allow, ask/accept-edits/dont-ask stay ask.
// office-agent-tools T4: `sheets` moves HERE from READ_ONLY (see that set's own comment for the
// read-half reasoning it still carries). Task 3 shipped `sheets` with only `info`/`read`; this task
// adds real write verbs (`set`, `insert_rows`, `insert_cols`, `delete_rows`, `delete_cols`,
// `add_sheet`, `delete_sheet`, `rename_sheet`) to the SAME tool name — and this gate classifies by
// TOOL NAME, not by verb (`evaluate(toolName, policy)` never sees `args`, so it cannot tell an
// `info` call from a `set` call). There is no per-verb gating available here to reach for.
//
// Precedent is `notebook_edit`, not `schedule`: `notebook_edit` is a structured-document editor
// that rides plain MUTATING with no carve-out of its own (this set's own comment: "notebook_edit
// rides the generic MUTATING path (niche)") — the same shape `sheets` is in now, a document editor
// whose write half must be gated like `write`/`edit`. `schedule`'s own "one tool, one gate decision,
// no op-dependent carve-out" comment is a worse fit: that tool's ops (list/enable/disable/delete)
// are UNIFORMLY mutating-adjacent (they all touch a standing routine); `sheets` mixes genuine reads
// with genuine writes on one name, which `notebook_edit` also does (a notebook read is `read`/`ls`
// on the .ipynb file itself — `notebook_edit` only ever performs the WRITE half — so `sheets` is
// actually a step further: even ITS OWN read verbs are swept into MUTATING's per-policy answer).
//
// **The disclosed cost, stated plainly rather than left to be discovered**: `sheets info`/`sheets
// read` now ask under `ask`/`dont-ask` and deny under `plan`, exactly like `sheets set` does, even
// though neither call mutates anything. This is the direct, name-keyed consequence of gate.ts having
// no verb-level granularity — not an oversight, and not something this task invents a workaround
// for (a per-verb gate would need `evaluate` to see `args`, a wider change than one tool's
// reclassification justifies). A plan-mode session that wants to inspect a spreadsheet without
// approval no longer can via `sheets` — the safe direction to err in for a tool that can now mutate
// a file, matching this file's own standing "wrongly classified as write is safe; wrongly classified
// as read is not" posture (see `office-commands.ts`'s identical reasoning for its OWN read/write
// deadline split, cited here because it is the same argument applied one layer up).
// office-agent-tools T6 — `slides` joins `sheets` here for the IDENTICAL reason (task-4-report.md's
// own reclassification, restated rather than re-derived): a mixed read/write verb set on one tool
// name, gate.ts still name-keyed not verb-keyed. `slides info`/`slides read` pay the same disclosed
// cost `sheets info`/`sheets read` already do (ask under ask/dont-ask, deny under plan) — the safe
// direction for a tool that can now mutate a presentation file.
// office-agent-tools T7 — `docs` joins them, same reason again and the same disclosed cost:
// `docs info`/`docs read` ask under ask/dont-ask and deny under plan even though neither mutates,
// because this gate is keyed by TOOL NAME and `docs` also carries `replace`/`insert`/`append`.
const MUTATING = new Set(["write", "edit", "bash", "notebook_edit", "enter_worktree", "exit_worktree", "computer", "schedule", "Workflow", "session_spawn", "sheets", "slides", "docs"]);
// web_fetch (4g Task 5, T6 adds web_search here) is Norma's ONLY network-capable tool — it does NOT
// belong in READ_ONLY (it makes a live outbound request; the response bytes are DATA that could
// carry adversarial "instructions", so an unattended session shouldn't get an implicit pass) and it
// is NOT quite MUTATING either (unlike write/edit/bash it never touches an arbitrary fs/process
// path on its own — it only ever saves into the session's own sandboxed tmp scratch dir). It gets
// its own class so its answer can diverge from both READ_ONLY and MUTATING independently.
//
// SP-approvals T10 (user addition 2026-07-21, spec §7 "Web tools"): "web tools become free by
// default" — web_search never prompts under ANY policy, and web_fetch never prompts under ANY
// policy EITHER at this gate (its one remaining floor — a dangerous-domain check — is a pre-exec
// check with path/domain awareness this gate deliberately never grows; it lives entirely in
// engine.ts, run BEFORE executeCall for every policy including plan and auto, see dangerous-
// domains.ts + engine.ts's webFetchGate). PRE-T10 this class rode the SAME branch as MUTATING/bash
// outside plan mode (ask under `ask`, allow under `auto`); that changed because re-prompting for
// every fetch/search trained users to click through without reading, while the one case that
// actually matters — a fetch that could exfiltrate data to a paste/tunnel/collector endpoint —
// needed a TARGETED floor, not a blanket prompt. web_search never makes an exfiltration-shaped
// request (its only egress is the fixed Brave Search API endpoint — no caller-directed URL), so it
// is unconditionally free with no floor at all. See evaluate() below for exactly where the
// unconditional "allow" is returned (now identical to READ_ONLY's under every policy).
//
// LOW-2, SP-approvals T10 review: NETWORK stays a SEPARATE const from READ_ONLY purely for the
// SEMANTIC risk-shape distinction — web_fetch/web_search make a live outbound request to an
// external endpoint and treat the RESPONSE as untrusted data (an adversarial page could carry
// injected instructions), whereas read/glob/grep only ever touch the local filesystem the user
// already controls. That's a meaningfully different risk shape worth its own labeled class in this
// file's taxonomy, independent of whatever concrete allow/ask/deny verdict the two classes happen
// to share today. It is NOT because engine.ts consults this class or its membership at runtime —
// engine.ts's dangerous-domain floor (webFetchGate) is keyed on a plain `call.name === "web_fetch"`
// string check, entirely decoupled from how this file organizes its sets; nothing about THIS class
// boundary is what "lets" that check exist or run.
//
// B1-T5: `Search` (chat's Exa-backed web search) joins this class too, deliberately — NOT
// READ_ONLY, unlike its sibling task-3 tool AskQuestion. AskQuestion is READ_ONLY because it only
// blocks on the QuestionBroker (a human answering is not a thing that needs gating); Search
// performs real network egress to a third-party endpoint and returns attacker-reachable page text
// as tool output — the SAME risk shape web_search already has, not the "no side effect at all"
// shape of AskQuestion/read/glob/grep. It is not MUTATING either, for the same reason web_fetch/
// web_search aren't: it never touches an arbitrary fs/process path, only ever calls the ONE fixed
// Exa endpoint with a caller-supplied QUERY STRING, never a caller-directed URL — so, exactly like
// web_search's own reasoning above, it can never be pointed at an attacker's exfiltration endpoint
// the way an open `url` parameter could. That is what makes it safe to fold into NETWORK's
// unconditional "allow" rather than inventing a stricter class of its own: the one thing that
// would justify a floor (a caller-chosen destination) is exactly what Search's schema doesn't
// have. Ending up "read-only in practice" is a consequence of that argument, not the reason for
// it — the classification is about what the tool COULD be pointed at, not what it happens to do
// today.
//
// B2-T2: `ReadPage` (chat/dispatch's batched page-reading tool) joins NETWORK for the SAME shape
// as Search, not web_fetch's: it takes a caller-supplied `url`, unlike Search's fixed-endpoint
// query — but so does web_fetch, which already lives in this class with no stricter floor at this
// gate (its one floor, the dangerous-domain check, is a pre-exec engine.ts concern this file
// deliberately never grows to match, per this class's own doc comment above). Same risk shape
// (real outbound request, response text treated as untrusted model input), same unconditional
// "allow" answer AT THIS GATE.
//
// B2-T6: `browser` (the agent's hands on the panel's real, logged-in Chromium tabs) joins NETWORK,
// and it is the class it belongs in on every axis this file cares about: it is pointed at a
// CALLER-SUPPLIED url exactly like web_fetch and ReadPage, its `read`/`screenshot` verbs return
// attacker-reachable page content as model input (the same untrusted-response risk shape the class
// exists to name), and it never touches an arbitrary fs/process path of its own — its whole effect
// is confined to tabs the daemon minted for this session.
//
// It was UNCLASSIFIED until this task, which was not a neutral omission — it is what the final
// fail-closed branch below does to a name it has never heard of, measured through the real engine:
// "deny" under `chat` (the mode spec §1 makes the browser a DEFAULT tool in — the tool was dead
// there), "deny" under `plan`, and "ask" under `auto` — i.e. an approval card on EVERY verb,
// including `tabs`, in a dispatch session that can never answer one. That is the identical trap
// list_sessions/manage_session's own entry above records, arriving the same way.
//
// The verb split (chat gets read verbs only, code/dispatch get the interaction verbs too) is NOT
// enforced here and must not be: it is the per-mode TOOL REGISTRY's (`argsByMode` — a chat session
// that calls `verb:"click"` is rejected at argument validation, structurally, before this gate's
// verdict is even relevant). This file's answer is per-TOOL-NAME by construction, so folding a
// verb-shaped distinction into it would be a second, weaker copy of a boundary that already holds.
//
// Its floor is one layer below, in the same two-place shape web_fetch's has: the DANGEROUS-DOMAIN
// adjudication for `navigate`/`open` — a hard block inside the tool (tools/browser.ts's
// `refuseDangerous`, unconditional and mode-blind), lifted for exactly one call by the engine's
// `browserGate` when a human answered fetch's own approval card. Same list, same card, same
// `WebFetch(domain:...)` rule, no new category (spec §4, the user's decision).
//
// Whole-branch review Critical 1 fix (2026-07-28, USER-REVISED design): `ReadPage` DOES now carry a
// floor of its own — same family as web_fetch's, just NOT engine.ts-level and NOT a card. Chat/
// dispatch structurally have no approval flow to card through at all (USER DECISION: "chat mode...
// would never ask permissions"), so a dangerous-domain url is HARD-BLOCKED entirely inside the tool
// (read-page.ts's `renderPage`/`runResearch`, both call page-core.ts's `checkDangerousDomain` before
// ever reaching a fetch) — an isError refusal, never a card, and with NO `WebFetch(domain:...)`
// standing-rule override (that rule is earned by approving a card, a consent flow this tool doesn't
// have). The research sub-agent's `FetchPage` gets the identical hard-block (research.ts) for the
// same reason: it "cannot card" (task-3-brief.md, "not interactive"). None of this changes what THIS
// gate returns — `ReadPage`'s verdict here is still, and remains, unconditionally "allow"; the floor
// lives entirely inside the tool, one layer below where this file's classification has any say.
// B2-T7 (whole-branch carry, from T6's review Minor-5): `list_mcp_resources` / `read_mcp_resource`
// join NETWORK — they were UNCLASSIFIED, the same silent-in-both-directions omission the `browser`
// entry above records, at a smaller blast radius (they are code-only, so nothing was dead in chat;
// what they got was "deny" under `plan` and, via engine.ts's dont-ask conversion, under `dont-ask`
// too — a read-only LISTING refused to a planning session — plus an approval card under `ask`/`auto`).
//
// THE ONE-LINE REASON: they make a live request to an external MCP server process and hand its
// response back as untrusted model input — web_fetch/ReadPage's exact risk shape — while touching no
// arbitrary fs/process path of their own; and unlike web_fetch the destination is not caller-chosen
// (it is a server the USER configured in settings, addressed by name), so the class's unconditional
// "allow" is owed with no floor beside it.
//
// NOT READ_ONLY, deliberately, on this class's own stated axis (see the LOW-2 paragraph above): the
// bytes come back from a third party over a live connection, not from a local filesystem the user
// already controls. NOT the `mcp__`/`plugin__` external branch either — these are FIXED built-ins
// (mcp-resources.ts's own header says so: they never ride `isExternalToolName`), and CC's own
// ListMcpResources/ReadMcpResource prompt no approval.
const NETWORK = new Set(["web_fetch", "web_search", "Search", "ReadPage", "browser", "list_mcp_resources", "read_mcp_resource"]);
// skill_write (phase 5c Task 2) gets a NEW class, strictly stricter than MUTATING: "ask" under
// BOTH `ask` AND `auto` (a card on EVERY call — no policy setting silences it), "deny" under
// `plan`. THE SKETCH PIN (phase-5-intelligence-design-sketch.md §5c): "a skill is standing
// instructions, i.e. durable prompt injection into future sessions" — higher blast radius than a
// file write, because a landed skill keeps steering sessions long after the one that wrote it.
// This completes the memory story told above MUTATING: a memory-fact write's USER pin deliberately
// chose silent-under-`auto` (a fact lands with no card — same as any other plain `write` under
// `auto`) because a recalled FACT is data the model weighs — a skill is INSTRUCTIONS the model
// follows, so the same silent-under-auto posture would let an unattended session install standing
// directives into every future session. (T1 note: the OLD tool-based memory_write additionally
// wrote an audit.jsonl line on every save, reviewable in the dashboard; a plain `write` into MEMDIR
// carries no such per-fact audit trail — see task-21-report.md's concerns.) Checked BEFORE the
// policy branches in evaluate(): membership overrides policy entirely, so a later accidental
// reclassification (e.g. skill_write ALSO added to MUTATING) cannot widen it to allow-under-auto.
const ALWAYS_ASK = new Set(["skill_write"]);

// SP-policies: the "edit class" `accept-edits` auto-allows (spec: "edits/writes free"). write/edit
// ONLY (matches every other edit-specific path in engine.ts — dirGrant, in-project-silent,
// approvalOptionsFor); notebook_edit rides the generic MUTATING path (niche).
const EDIT_CLASS = new Set(["write", "edit"]);

/**
 * **Does any class in this file claim `toolName`?** — B2-T7's whole-branch carry, and the answer to
 * a defect that has now landed twice on one branch (`browser`, then `list_mcp_resources`/
 * `read_mcp_resource`).
 *
 * An unclassified name is not a neutral omission: `evaluate()` fails it CLOSED, which for a
 * genuinely unknown tool is right and for a read-only built-in nobody remembered to list is a tool
 * that is dead under `plan`/`dont-ask` and cards on every call under `auto` — in a dispatch session
 * that can never answer one. Both directions are SILENT: the tool is registered, its own tests pass
 * (they call `registry.execute` with a hand-built ToolContext and never cross this gate), and the
 * mode-census sees it in the mode's set because `modes` and this file are different axes.
 *
 * **This predicate is load-bearing, not a mirror of the sets below it.** `evaluate()` itself asks it
 * — that is the whole point. A mirrored copy would drift the first time a class was added, and the
 * drift would be invisible in exactly the direction that matters (a new class whose members the
 * predicate does not know still fails closed in `evaluate`, so the pin stays green while the tools
 * are dead). Asking here means a class the predicate does not know is a class whose members
 * `evaluate` also refuses to recognise — a wrong answer that a test can see.
 *
 * Externals (`mcp__…`/`plugin__…`) count as classified: `evaluate()` gives them a real
 * per-policy verdict through the branch below, which is a classification decision — see
 * `isExternalToolName`.
 *
 * Pinned by `packages/core/test/agent/mode-toolset-census.test.ts`, against the REAL
 * `startDaemon()` registration path: every name any mode can offer must be claimed here.
 */
export function isGateClassified(toolName: string): boolean {
  return READ_ONLY.has(toolName)
    || MUTATING.has(toolName)
    || NETWORK.has(toolName)
    || ALWAYS_ASK.has(toolName)
    || isExternalToolName(toolName);
}

/**
 * v1 policy matrix (spec §4.10 arrives fully in 1b-ii with the AI reviewer):
 * read-only tools always allowed; mutating tools follow the session policy;
 * anything unrecognized asks — fail-closed toward the human.
 */
export class PermissionGate {
  evaluate(toolName: string, policy: SessionApprovalPolicy): GateDecision {
    // Plan-immunity (2026-07-28, USER-REVISED design): "chat" — chat-mode's fixed, immutable
    // policy — is checked FIRST, before ALWAYS_ASK/MUTATING/everything below, because the user's
    // directive ("chat simply wouldn't ever ask permissions") means NOTHING may resolve to "ask"
    // under it, not even a future ALWAYS_ASK-classified addition. Chat's own allowlisted tools
    // (AskQuestion/Search/ReadPage, and B2-T6's `browser`) all live in READ_ONLY/NETWORK, so this is exactly "allow the
    // read-only/network classes, deny everything else outright" — never a card, matching "never
    // asks" literally rather than degrading to a stricter-but-still-asking policy.
    if (policy === "chat") {
      // Minor 2 (fix round 1 review finding): enter_plan_mode/exit_plan_mode are READ_ONLY (no fs/
      // process mutation of their own), so the blanket READ_ONLY/NETWORK allow just below would
      // otherwise ALLOW them here. Denied explicitly instead: if either ever became chat-eligible,
      // runEnterPlanBridge (engine.ts) would flip meta.approvalPolicy = "plan" MID-TURN and persist
      // it via cfg.setPolicy — the model mutating chat's supposedly-immutable policy, bypassing the
      // session.setPolicy RPC guard entirely (one-turn blast radius; turn()'s own turn-time
      // resolution repairs it on the NEXT turn, but not this one). Unreachable today (neither tool
      // is in chat's real allowlist, registry.namesForMode("chat")) — same defense-in-depth tier as
      // this file's own "chat" branch just above.
      if (toolName === "enter_plan_mode" || toolName === "exit_plan_mode") return "deny";
      return READ_ONLY.has(toolName) || NETWORK.has(toolName) ? "allow" : "deny";
    }
    // ALWAYS_ASK (skill_write): a card no policy silences — EXCEPT bypass (accepts everything) and
    // plan (mutates nothing). See the set's doc comment.
    if (ALWAYS_ASK.has(toolName)) {
      if (policy === "plan") return "deny";
      if (policy === "bypass") return "allow";
      return "ask";
    }
    if (READ_ONLY.has(toolName)) return "allow";
    if (NETWORK.has(toolName)) return "allow"; // web tools free at this gate; engine's dangerous-domain floor is separate
    // Below: MUTATING / external / unclassified.
    if (policy === "plan") return "deny";       // nothing mutates while planning (unclassified included)
    if (policy === "bypass") return "allow";    // bypass is opt-in no-guardrails — accept literally everything
    // Past here a call must be a KNOWN mutating/external tool to earn a policy verdict. An
    // UNCLASSIFIED name fails CLOSED to "ask" under dont-ask/ask/accept-edits/auto alike — it must
    // never ride auto's blanket allow (a newly-added tool nobody remembered to classify would
    // otherwise run unreviewed under auto). This is the pre-SP-policies fail-closed posture (this
    // class's own doc comment) that a flat "auto → allow" ordering had silently dropped.
    //
    // B2-T7: expressed through `isGateClassified` rather than as its own `!MUTATING && !external`
    // pair. Identical verdict — READ_ONLY/NETWORK/ALWAYS_ASK have all returned above, so at this line
    // "classified" can only mean MUTATING-or-external — but it makes the predicate the REAL fork
    // rather than a copy of it, which is what lets a test assert completeness against something other
    // than a second hand-maintained list.
    if (!isGateClassified(toolName)) return "ask";
    // Task B-gatefix Part 2 (user decision 2026-07-22, CC-parity): a Workflow launch must not ride
    // auto's blanket allow either — it starts a background run of up to 1000 accept-edits agents, so
    // a human confirms EVERY launch, not just the ones under ask/dont-ask/accept-edits below.
    // INVESTIGATED wiring this through the AI reviewer instead, mirroring the auto-policy bash/fs/
    // external branches in engine.ts (each ultimately calls `this.cfg.reviewer.review(...)`,
    // reviewer.ts): its `ReviewClass` is a closed `"bash" | "fs" | "external"` union, and EACH class's
    // instructions text is FIXED inside `BashReviewer.review()` itself — "bash" reviews a shell
    // command, "fs" an unusual write target, "external" a third-party MCP/plugin call Norma cannot
    // inspect. None of the three describes "a script that launches an unbounded background
    // multi-agent swarm"; reusing "external"'s text would misrepresent the review target to the
    // REVIEWING MODEL itself (telling it this is uninspectable third-party code, when a workflow
    // script is the opposite — fully Norma-authored and fully inspectable) — a correctness problem
    // with the review, not merely a style mismatch. A proper fix would add a fourth ReviewClass (and
    // its own instructions constant) to reviewer.ts, which sits outside this task's file scope
    // (gate.ts/engine.ts/tests + the spec doc only) — so FALL BACK to carding it here, unconditionally,
    // rather than reviewing it. Placed BEFORE the `auto` check just below so a Workflow call can never
    // reach that blanket allow; harmless for dont-ask/ask/accept-edits too (each already returns "ask"
    // from the plain fallthrough at the bottom of this method — this line only actually CHANGES
    // auto's verdict for this one tool name).
    if (toolName === "Workflow") return "ask";
    if (policy === "auto") return "allow";      // reviewer gates the reviewable classes in engine.ts
    // Workflow does NOT ride accept-edits' free pass anymore (Task B-gatefix, user decision
    // 2026-07-22 — see MUTATING's own doc comment above for the full reversal of B2's original
    // reasoning): a launch spawns a background run of up to 1000 accept-edits agents, so the human
    // confirms it just like any other MUTATING tool under accept-edits (CC-parity: CC cards under
    // accept-edits on every run). In practice this line is never reached for "Workflow" specifically
    // (the special case above already returns "ask" for it before evaluate() gets here) — kept
    // EDIT_CLASS-only anyway so this line still reads correctly in isolation.
    if (policy === "accept-edits" && EDIT_CLASS.has(toolName)) return "allow"; // edits free; rest (incl. Workflow) → ask below
    // ask / accept-edits(non-edit) / dont-ask: a human gate. dont-ask converts a still-"ask" call to
    // deny in engine.ts (this gate has no mode/path awareness to do it here); in-project write/edit
    // is likewise silenced in engine.ts, not here.
    return "ask";
  }
}
