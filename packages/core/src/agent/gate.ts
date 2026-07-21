import { isExternalToolName } from "./tools/registry";

export type GateDecision = "allow" | "ask" | "deny";
export type SessionApprovalPolicy = "ask" | "auto" | "plan";

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
const MUTATING = new Set(["write", "edit", "bash", "notebook_edit", "enter_worktree", "exit_worktree", "computer", "schedule"]);
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
// unconditional "allow" is returned (now identical to READ_ONLY's under every policy, even though
// this stays a SEPARATE const from READ_ONLY — the class boundary is what lets engine.ts single
// web_fetch out for its own check without touching read/glob/grep's).
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

/**
 * v1 policy matrix (spec §4.10 arrives fully in 1b-ii with the AI reviewer):
 * read-only tools always allowed; mutating tools follow the session policy;
 * anything unrecognized asks — fail-closed toward the human.
 */
export class PermissionGate {
  evaluate(toolName: string, policy: SessionApprovalPolicy): GateDecision {
    // ALWAYS_ASK precedes every policy branch (see the set's doc comment): plan → deny (a skill
    // write is a mutation; plan mode mutates nothing), ask/auto → ask (the card is unconditional).
    if (ALWAYS_ASK.has(toolName)) return policy === "plan" ? "deny" : "ask";
    // Plan mode: only read-only tools (incl. exit_plan_mode, ask_user, task_*) are allowed;
    // everything else (writes/edit/bash/mcp__/plugin__/unclassified) is denied outright — no prompt,
    // since the whole point of plan mode is that nothing mutates until the plan is approved.
    if (policy === "plan") {
      if (READ_ONLY.has(toolName)) return "allow"; // incl. exit_plan_mode, ask_user, task_*
      if (NETWORK.has(toolName)) return "allow"; // web_fetch: read-only research — see NETWORK's doc comment above
      return "deny"; // write/edit/bash/mcp__/plugin__/unclassified — all blocked while planning
    }
    if (READ_ONLY.has(toolName)) return "allow";
    // SP-approvals T10: NETWORK is unconditionally "allow" here too (ask AND auto), matching the
    // plan-mode branch above — web tools are free by default under EVERY policy at this gate.
    // Do NOT move web_fetch/web_search into READ_ONLY (see NETWORK's own doc comment for why they
    // stay a distinct class): this is a SEPARATE branch specifically so engine.ts's dispatch loop
    // can single web_fetch out for its own dangerous-domain pre-exec check without that check
    // needing to reach into read/glob/grep's handling at all.
    if (NETWORK.has(toolName)) return "allow";
    // write/edit stay in MUTATING even after the write-permission-flow feature (request_directory
    // removed, task 24): this decision only gates whether the TOOL CALL ITSELF needs a human's
    // yes/no — an OUT-OF-ROOT target is a SEPARATE, path-aware question the engine's dispatch loop
    // asks on top (engine.ts's `dirGrant` branch, checked before the generic `decision === "ask"`
    // branch below) — this gate has no path awareness and must not grow any.
    if (MUTATING.has(toolName)) return policy === "auto" ? "allow" : "ask";
    // MCP tools AND Phase 4b platform-plugin tools are external code (network/fs/arbitrary) →
    // approval-per-policy like bash: allowed under `auto`, prompt under `ask`. Must NOT be
    // READ_ONLY, and must NOT fall to the unclassified always-ask branch below (that would block
    // MCP/plugin tool use even under `auto`). isExternalToolName (tools/registry.ts) is the SAME
    // predicate ToolRegistry's deferral uses — one definition, both call sites widen together.
    if (isExternalToolName(toolName)) return policy === "auto" ? "allow" : "ask";
    return "ask";
  }
}
