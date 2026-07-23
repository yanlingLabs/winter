import { isExternalToolName } from "./tools/registry";

export type GateDecision = "allow" | "ask" | "deny";
export type SessionApprovalPolicy = "plan" | "dont-ask" | "ask" | "accept-edits" | "auto" | "bypass";

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
const READ_ONLY = new Set(["read", "glob", "grep", "ls", "bash_output", "Skill", "ToolSearch", "ask_user", "task_create", "task_update", "task_list", "task_get", "exit_plan_mode", "enter_plan_mode", "spawn_agent", "send_message", "task_stop", "agent_list", "agent_output", "lsp", "push_notification"]);
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
const MUTATING = new Set(["write", "edit", "bash", "notebook_edit", "enter_worktree", "exit_worktree", "computer", "schedule", "Workflow"]);
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
const NETWORK = new Set(["web_fetch", "web_search"]);
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
 * v1 policy matrix (spec §4.10 arrives fully in 1b-ii with the AI reviewer):
 * read-only tools always allowed; mutating tools follow the session policy;
 * anything unrecognized asks — fail-closed toward the human.
 */
export class PermissionGate {
  evaluate(toolName: string, policy: SessionApprovalPolicy): GateDecision {
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
    if (!MUTATING.has(toolName) && !isExternalToolName(toolName)) return "ask";
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
