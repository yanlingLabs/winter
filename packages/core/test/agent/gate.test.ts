import { describe, expect, test } from "bun:test";
import { PermissionGate } from "../../src/agent/gate";

describe("PermissionGate v1", () => {
  const gate = new PermissionGate();

  test("read-only tools are allowed under both policies", () => {
    for (const name of ["read", "glob", "grep", "ls"]) {
      expect(gate.evaluate(name, "ask")).toBe("allow");
      expect(gate.evaluate(name, "auto")).toBe("allow");
    }
  });

  test("mutating tools ask under ask-policy, allow under auto-policy", () => {
    for (const name of ["write", "edit"]) {
      expect(gate.evaluate(name, "ask")).toBe("ask");
      expect(gate.evaluate(name, "auto")).toBe("allow");
    }
  });

  // SP-policies Task 3 (6-mode evaluate() rewrite): an UNCLASSIFIED / unrecognized tool name still
  // fails CLOSED — "ask" under dont-ask/ask/accept-edits/auto, "deny" under plan — and never rides
  // auto's blanket allow (only KNOWN MUTATING/external tools do). Only `bypass` (opt-in
  // no-guardrails) allows an unrecognized name. Preserves gate.ts's own class-doc fail-closed
  // posture, which a flat "auto → allow" ordering had silently dropped.
  test("unknown tools fail closed: ask under dont-ask/ask/accept-edits/auto, deny under plan, allow only under bypass", () => {
    expect(gate.evaluate("mystery", "ask")).toBe("ask");
    expect(gate.evaluate("mystery", "auto")).toBe("ask"); // NOT allow — fail-closed under auto
    expect(gate.evaluate("mystery", "dont-ask")).toBe("ask");
    expect(gate.evaluate("mystery", "accept-edits")).toBe("ask");
    expect(gate.evaluate("mystery", "plan")).toBe("deny");
    expect(gate.evaluate("mystery", "bypass")).toBe("allow");
  });

  test("bash is a mutating tool: ask under ask-policy, allow under auto", () => {
    const gate = new PermissionGate();
    expect(gate.evaluate("bash", "ask")).toBe("ask");
    expect(gate.evaluate("bash", "auto")).toBe("allow");
  });

  test("bash_output is read-only: always allowed", () => {
    expect(gate.evaluate("bash_output", "ask")).toBe("allow");
  });

  // Phase 5a Task 1: agent_list/agent_output only ever read BackgroundAgentRegistry/SessionStore
  // state (agent_output never flips `notified`) — same READ_ONLY class as task_get/task_list, and
  // must stay allowed under `plan` so a planning session can still check on its background agents.
  test("agent_list + agent_output are read-only: allowed under ask/auto/plan", () => {
    for (const name of ["agent_list", "agent_output"]) {
      expect(gate.evaluate(name, "ask")).toBe("allow");
      expect(gate.evaluate(name, "auto")).toBe("allow");
      expect(gate.evaluate(name, "plan")).toBe("allow");
    }
  });

  // bash_kill (the standalone kill-a-bg-bash-task tool) was removed — CC parity: task_stop is now
  // the ONE generic stop tool (see the "task_stop is read-only too" note above). Its old MUTATING
  // classification test is gone with it; task_stop's own read-only classification is covered by
  // the "guard" test at the bottom of this file (task_stop is a READ_ONLY member there).

  test("computer (Phase 5 CU) is mutating: ask under ask, allow under auto, deny under plan", () => {
    expect(gate.evaluate("computer", "ask")).toBe("ask");
    expect(gate.evaluate("computer", "auto")).toBe("allow");
    expect(gate.evaluate("computer", "plan")).toBe("deny");
  });

  // Phase 5 routines T3 (design doc §4/security): `schedule` creates a standing, unattended,
  // prompt-injection-shaped side effect (a routine that fires headless later) — MUTATING, not
  // READ_ONLY, same class as bash/write/edit: ask under `ask`, allow under `auto`, denied outright
  // under `plan` (plan mode's whole point is "nothing mutates until the plan is approved" — that
  // must include "nothing gets SCHEDULED to mutate later" too).
  test("schedule is mutating: ask under ask-policy, allow under auto-policy, denied under plan", () => {
    expect(gate.evaluate("schedule", "ask")).toBe("ask");
    expect(gate.evaluate("schedule", "auto")).toBe("allow");
    expect(gate.evaluate("schedule", "plan")).toBe("deny");
  });

  // Task B2 (CC-parity phase 3, Workflows) originally gave Workflow an accept-edits/auto free pass,
  // reasoning that a workflow's spawned agents ALWAYS run at accept-edits (a FIXED escalation) so
  // launching from a session already at or above that policy escalated no trust. Task B-gatefix
  // (user decision 2026-07-22) REVERSED that: a launch starts a background run of up to 1000
  // agents, unattended, so a human must confirm EVERY one — CC parity (CC cards under accept-edits
  // on every run, and reviews-or-cards under auto too). Only `bypass` (opt-in no-guardrails) still
  // proceeds silently.
  test("Workflow is MUTATING with NO free-pass carve-out: deny under plan, ask/dont-ask/accept-edits/auto all card it, only bypass proceeds", () => {
    const g = new PermissionGate();
    expect(g.evaluate("Workflow", "plan")).toBe("deny");
    expect(g.evaluate("Workflow", "ask")).toBe("ask"); // carded — never silently allowed
    expect(g.evaluate("Workflow", "dont-ask")).toBe("ask"); // gate-level "ask"; engine.ts's dont-ask flip denies it downstream, same as any other mutating tool
    expect(g.evaluate("Workflow", "accept-edits")).toBe("ask"); // B-gatefix: the old accept-edits carve-out is GONE
    expect(g.evaluate("Workflow", "auto")).toBe("ask"); // B-gatefix: auto no longer rides the blanket MUTATING allow either
    expect(g.evaluate("Workflow", "bypass")).toBe("allow");
  });

  // Contrast with spawn_agent (READ_ONLY, allowed under every policy including `ask`) — Workflow
  // must NOT get the same free pass, since (unlike spawn_agent) its children don't merely inherit
  // the parent's policy, they escalate to a fixed accept-edits.
  test("Workflow is NOT READ_ONLY — unlike spawn_agent, it never gets a free pass under ask or plan", () => {
    const g = new PermissionGate();
    expect(g.evaluate("Workflow", "ask")).not.toBe(g.evaluate("spawn_agent", "ask"));
    expect(g.evaluate("Workflow", "plan")).not.toBe(g.evaluate("spawn_agent", "plan"));
  });

  test("Skill is read-only: always allowed (loading a skill body must not require approval)", () => {
    expect(gate.evaluate("Skill", "ask")).toBe("allow");
    expect(gate.evaluate("Skill", "auto")).toBe("allow");
  });

  test("mcp__ tools are approval-per-policy (like bash): allow under auto, ask under ask", () => {
    const g = new PermissionGate();
    expect(g.evaluate("mcp__srv__tool", "auto")).toBe("allow");
    expect(g.evaluate("mcp__srv__tool", "ask")).toBe("ask");
    expect(g.evaluate("read", "ask")).toBe("allow"); // READ_ONLY unchanged
  });

  // Phase 4b Task 4 (spec §3): "plugin.register/tool.register supplies name + one-liner ...
  // registered into ToolRegistry as plugin__<id>__<tool>, gated like MCP (approval per policy,
  // never READ_ONLY)". Byte-identical to the mcp__ test above — plugin__ must hit the SAME branch.
  test("plugin__ tools are gated EXACTLY like mcp__ tools: approval-per-policy (never READ_ONLY), allow under auto, ask under ask", () => {
    const g = new PermissionGate();
    expect(g.evaluate("plugin__sample-echo__echo", "auto")).toBe("allow");
    expect(g.evaluate("plugin__sample-echo__echo", "ask")).toBe("ask");
    expect(g.evaluate("read", "ask")).toBe("allow"); // READ_ONLY unchanged
  });

  test("ToolSearch is read-only: always allowed (loading a deferred tool's schema must not require approval)", () => {
    expect(gate.evaluate("ToolSearch", "ask")).toBe("allow");
    expect(gate.evaluate("ToolSearch", "auto")).toBe("allow");
  });

  test("ask_user + task tools are allow under ask policy", () => {
    for (const t of ["ask_user", "task_create", "task_update", "task_list"]) expect(gate.evaluate(t, "ask")).toBe("allow");
  });

  // SP-policies Task 3: classified MUTATING/external tools track policy (ask under `ask`, allow
  // under `auto`), but "frobnicate" (UNCLASSIFIED) fails CLOSED to "ask" under BOTH — it never rides
  // auto's blanket allow. This is the pre-SP-policies fail-closed posture the 6-mode rewrite
  // preserves (only KNOWN mutating/external names earn auto's allow; see the "unknown tools fail
  // closed" test above).
  test("ask/auto matrix: classified MUTATING/external track policy; unclassified fails closed to ask under both (SP-policies Task 3)", () => {
    const g = new PermissionGate();
    for (const p of ["ask", "auto"] as const) {
      for (const [t, exp] of [
        ["read", "allow"],
        ["write", p === "auto" ? "allow" : "ask"],
        ["bash", p === "auto" ? "allow" : "ask"],
        ["mcp__x__y", p === "auto" ? "allow" : "ask"],
        ["plugin__x__y", p === "auto" ? "allow" : "ask"],
        ["frobnicate", "ask"], // unclassified — fail-closed under auto too, NOT allow
      ] as const) {
        expect(g.evaluate(t, p)).toBe(exp);
      }
    }
  });

  test("plan matrix: read-only + exit_plan_mode + ask_user + task_* allow; write/edit/bash/mcp/plugin deny; unclassified deny", () => {
    const g = new PermissionGate();
    for (const t of ["read", "glob", "grep", "ls", "Skill", "ToolSearch", "ask_user", "task_create", "task_list", "exit_plan_mode"]) {
      expect(g.evaluate(t, "plan")).toBe("allow");
    }
    for (const t of ["write", "edit", "bash", "mcp__x__y", "plugin__x__y", "frobnicate"]) {
      expect(g.evaluate(t, "plan")).toBe("deny");
    }
  });

  // 4g Task 5/6: web_fetch/web_search are Norma's only network-capable tools. They get their OWN
  // gate class (NETWORK), distinct from both READ_ONLY and MUTATING.
  //
  // SP-approvals T10 (user addition 2026-07-21, spec §7): "web tools become free by default" —
  // NETWORK's ask/auto answer changed from "ask under `ask`, matching bash/MUTATING" (pre-T10) to
  // an unconditional "allow", now IDENTICAL to READ_ONLY's under every policy. web_fetch keeps its
  // OWN dangerous-domain floor entirely inside engine.ts (a pre-exec check with path/domain
  // awareness this gate deliberately never grows — see NETWORK's own doc comment above and
  // dangerous-domains.ts) — that floor is NOT expressed here at all. NETWORK remains a SEPARATE
  // const from READ_ONLY in gate.ts purely so the class boundary exists for engine.ts to hang
  // web_fetch-specific behavior off of, even though their gate.ts answers are now byte-identical.
  test("web_fetch/web_search are gate-classed NETWORK: allow under EVERY policy (ask/auto/plan) as of SP-approvals T10", () => {
    const g = new PermissionGate();
    for (const t of ["web_fetch", "web_search"]) {
      expect(g.evaluate(t, "plan")).toBe("allow");
      expect(g.evaluate(t, "auto")).toBe("allow");
      expect(g.evaluate(t, "ask")).toBe("allow");
    }
  });

  test("web_fetch/web_search now match READ_ONLY's ask/auto/plan answer exactly (T10) — they no longer match bash's ask-policy answer", () => {
    const g = new PermissionGate();
    for (const p of ["ask", "auto", "plan"] as const) {
      expect(g.evaluate("web_fetch", p)).toBe(g.evaluate("read", p));
      expect(g.evaluate("web_search", p)).toBe(g.evaluate("read", p));
    }
    // The pre-T10 invariant (web_fetch matches bash under ask) is GONE — pin the divergence so a
    // future revert is caught here, not downstream.
    expect(g.evaluate("web_fetch", "ask")).not.toBe(g.evaluate("bash", "ask"));
  });

  // B1-T5: `Search` (chat's Exa-backed web search) joins NETWORK too — deliberately, not READ_ONLY
  // (unlike Task 3's AskQuestion, which is read-only because it only blocks on a human answer).
  // Search makes a real outbound request to a third-party endpoint and returns attacker-reachable
  // page text as tool output — same risk shape as web_fetch/web_search, not the "no side effect"
  // shape of AskQuestion/read/glob/grep. See gate.ts's own doc comment above the NETWORK set for
  // the fuller "no caller-directed URL" argument for why it doesn't need a stricter class.
  test("Search is gate-classed NETWORK too: allow under EVERY policy (ask/auto/plan), matching web_fetch/web_search", () => {
    const g = new PermissionGate();
    for (const p of ["plan", "auto", "ask"] as const) {
      expect(g.evaluate("Search", p)).toBe("allow");
      expect(g.evaluate("Search", p)).toBe(g.evaluate("web_search", p));
    }
  });

  // B2-T6: `browser` joins NETWORK — the caller-supplied-url, untrusted-response risk shape
  // web_fetch and ReadPage already have. Pinned across ALL SEVEN policies (not the usual
  // ask/auto/plan sample) because the two cells that were actually BROKEN before this task are
  // `chat` and `auto`, and neither is in that sample: unclassified, `browser` fell to the final
  // fail-closed branch and answered "deny" under chat (the mode spec §1 makes it a DEFAULT tool in
  // — so the tool was dead there) and "ask" under auto (an approval card on every verb of a
  // headless dispatch session, which can never answer one).
  //
  // Compared cell-by-cell against `ReadPage` rather than asserted as a literal table: the claim
  // being pinned is CLASS MEMBERSHIP, and a future edit that moved BOTH out of NETWORK together
  // would still be a deliberate act, while one that moved only `browser` is exactly the drift this
  // guards. The absolute "allow" is asserted too, so the comparison can't pass by both being wrong.
  test("browser is gate-classed NETWORK: allow under EVERY policy incl. chat and auto, identical to ReadPage's cell", () => {
    const g = new PermissionGate();
    for (const p of ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass", "chat"] as const) {
      expect({ p, browser: g.evaluate("browser", p) }).toEqual({ p, browser: "allow" });
      expect({ p, browser: g.evaluate("browser", p) }).toEqual({ p, browser: g.evaluate("ReadPage", p) });
    }
  });

  // T1 (file-based memory) note: memory_read/memory_write/memory_delete are DELETED (design doc
  // `2026-07-15-file-based-memory-design.md`) — a memory-fact read/write now goes through the
  // plain read/write/edit tools, already covered by their own tests elsewhere in this file.

  // lsp consolidation T2: the single `lsp` tool (replacing lsp_diagnostics/lsp_definition/
  // lsp_references) only ever queries a language server or reads a fence-checked disk preview —
  // same READ_ONLY class as task_get/agent_list, and must stay allowed under `plan` so a planning
  // session can still look things up.
  test("lsp is read-only: allowed under ask/auto/plan", () => {
    expect(gate.evaluate("lsp", "ask")).toBe("allow");
    expect(gate.evaluate("lsp", "auto")).toBe("allow");
    expect(gate.evaluate("lsp", "plan")).toBe("allow");
  });

  // task-30 (push-notification track): push_notification only emits an event + a fixed, argv-safe
  // osascript call — same READ_ONLY class as ask_user (gating "tell the user something" behind an
  // approval card would defeat the point). Must stay allowed under `plan` too.
  test("push_notification is read-only: allowed under ask/auto/plan", () => {
    expect(gate.evaluate("push_notification", "ask")).toBe("allow");
    expect(gate.evaluate("push_notification", "auto")).toBe("allow");
    expect(gate.evaluate("push_notification", "plan")).toBe("allow");
  });

  // Phase 5c Task 2 (THE SKETCH PIN, phase-5-intelligence-design-sketch.md §5c): skill_write is
  // the first member of a NEW gate class, ALWAYS_ASK — "a skill is standing instructions, i.e.
  // durable prompt injection into future sessions" — so it is approval-carded under BOTH `ask`
  // AND `auto` (the class-defining assertions: no policy setting silences the card), and denied
  // under `plan` like any mutation. CONTRAST a plain memory-fact `write` above: that one
  // deliberately rides plain MUTATING (allow-silently-under-auto); skill_write must NOT.
  test("skill_write is ALWAYS_ASK: ask under ask-policy AND under auto-policy, deny under plan", () => {
    expect(gate.evaluate("skill_write", "ask")).toBe("ask");
    expect(gate.evaluate("skill_write", "auto")).toBe("ask");
    expect(gate.evaluate("skill_write", "plan")).toBe("deny");
  });

  // Guard: skill_write must be ALWAYS_ASK's ONLY member. "ask under auto" is the class's unique
  // signature — every tool previously classified in any other class must still resolve to
  // "allow" under `auto`, so a tool silently moved into (or added to) ALWAYS_ASK fails HERE,
  // not in some downstream E2E. The list enumerates every member of READ_ONLY, MUTATING, and
  // NETWORK as of write-permission-flow (task 24 — SELF_GATING/request_directory removed, no
  // replacement class), plus the external (mcp__/plugin__) shape. "Workflow" is DELIBERATELY
  // EXCLUDED from this list (Task B-gatefix, user decision 2026-07-22): it's the one MUTATING member
  // with its own bespoke "ask" special-case under `auto` (gate.ts's evaluate(), checked BEFORE the
  // blanket auto allow) — not a member of ALWAYS_ASK (bypass still allows it, unlike a true
  // ALWAYS_ASK member), just a second, narrower exception this guard's list doesn't cover. See the
  // dedicated test just below for its pinned auto/accept-edits verdicts.
  test("guard: no existing tool joined ALWAYS_ASK — every previously classified tool still allows under auto", () => {
    const classified = [
      // READ_ONLY ("AskQuestion" added B1-T3; branch-review FIX 3 closed the gap where this
      // completeness guard's own list omitted it even though gate.ts's real READ_ONLY set has it)
      "read", "glob", "grep", "ls", "bash_output", "Skill", "ToolSearch", "ask_user", "AskQuestion", "task_create", "task_update", "task_list", "task_get", "exit_plan_mode", "enter_plan_mode", "spawn_agent", "send_message", "task_stop", "agent_list", "agent_output", "lsp", "push_notification",
      // MUTATING ("Workflow" excluded — see this test's own doc comment above). B2-T7 adds
      // "session_spawn" (see gate.ts's own entry for why MUTATING and not READ_ONLY beside
      // spawn_agent).
      "write", "edit", "bash", "notebook_edit", "enter_worktree", "exit_worktree", "computer", "schedule", "session_spawn",
      // NETWORK + externals (B1-T5 adds "Search"; B2-T2 "ReadPage"; B2-T6 "browser"; B2-T7 the two
      // MCP resource tools — this list's claim to enumerate every member had gone stale by four
      // names, which is the same drift the new COMPLETENESS pin in mode-toolset-census.test.ts
      // exists to make impossible for the SETS themselves).
      "web_fetch", "web_search", "Search", "ReadPage", "browser", "list_mcp_resources", "read_mcp_resource",
      "mcp__x__y", "plugin__x__y",
    ];
    for (const t of classified) expect(gate.evaluate(t, "auto")).toBe("allow");
  });

  // Companion to the guard above: Workflow is the ONE MUTATING member that does NOT allow under
  // `auto` (nor `accept-edits`) — pinned here by name so a future accidental re-widening (e.g.
  // someone "fixing" the guard list above by re-adding "Workflow") is caught by an explicit
  // contradiction, not just a silent guard-list edit.
  test("guard: Workflow specifically does NOT allow under auto or accept-edits (unlike every other MUTATING tool)", () => {
    expect(gate.evaluate("Workflow", "auto")).toBe("ask");
    expect(gate.evaluate("Workflow", "accept-edits")).toBe("ask");
    expect(gate.evaluate("Workflow", "bypass")).toBe("allow"); // bypass still allows — not ALWAYS_ASK-like
  });

  // write-permission-flow (task 24, CC parity): request_directory is GONE — write/edit's own
  // out-of-root target now carries its own approval via the engine's dispatch loop (engine.ts's
  // `dirGrant` branch), not a self-gating tool the gate had to special-case. Guard against a
  // regression where the name comes back and the gate has to special-case it again.
  // SP-policies Task 3: an unrecognized name fails CLOSED — "ask" under ask AND auto, "deny" under
  // plan — never auto-allow.
  test("request_directory is not a recognized tool name — falls to the unclassified branch, fail-closed (ask under ask/auto, deny under plan)", () => {
    expect(gate.evaluate("request_directory", "ask")).toBe("ask");
    expect(gate.evaluate("request_directory", "auto")).toBe("ask");
    expect(gate.evaluate("request_directory", "plan")).toBe("deny");
  });

  // Plan-immunity (2026-07-28, USER-REVISED design): "chat" is chat-mode's own fixed, immutable
  // internal policy (never crosses the wire — see gate.ts's SessionApprovalPolicy doc comment).
  // The user's directive ("chat simply wouldn't ever ask permissions") means this policy must
  // never resolve to "ask" for ANYTHING — chat's own three allowlisted tools (AskQuestion/Search/
  // ReadPage, all READ_ONLY or NETWORK) allow; everything else DENIES outright, never cards.
  describe("policy 'chat': chat's own tools allow, everything else DENIES (never asks)", () => {
    test("chat's allowlisted tools (READ_ONLY/NETWORK classes) allow under 'chat'", () => {
      // B2-T6 adds `browser` to this list — it is chat's PRIMARY web surface per spec §1 and a
      // default (non-deferred) tool there, and it answered "deny" here until it was classified.
      for (const name of ["AskQuestion", "Search", "ReadPage", "browser", "read", "glob", "web_fetch"]) {
        expect(gate.evaluate(name, "chat")).toBe("allow");
      }
    });

    test("mutating tools DENY (not ask) under 'chat' — chat never asks permissions", () => {
      for (const name of ["write", "edit", "bash", "notebook_edit", "computer", "schedule", "Workflow"]) {
        expect(gate.evaluate(name, "chat")).toBe("deny");
      }
    });

    test("ALWAYS_ASK (skill_write) also DENIES under 'chat', not 'ask' — the fixed policy overrides even the always-ask class", () => {
      expect(gate.evaluate("skill_write", "chat")).toBe("deny");
    });

    test("an unrecognized/unclassified tool also DENIES under 'chat' (fail-closed, same direction as 'plan')", () => {
      expect(gate.evaluate("mystery", "chat")).toBe("deny");
    });

    // Fix round 1, Minor 2 (reviewer finding): enter_plan_mode/exit_plan_mode are READ_ONLY
    // (gate.ts's own set — no fs/process mutation), so the generic "chat" branch above would
    // otherwise ALLOW them by falling into the READ_ONLY/NETWORK check. If either ever became
    // chat-eligible, runEnterPlanBridge (engine.ts) would flip meta.approvalPolicy = "plan" MID-TURN
    // and persist it via cfg.setPolicy — the model mutating chat's supposedly-immutable policy,
    // bypassing the session.setPolicy RPC guard entirely (one-turn blast radius; turn()'s own
    // turn-time resolution repairs it on the NEXT turn, but not this one). Unreachable today
    // (neither tool is in chat's real allowlist), same defense-in-depth tier as the two unprompted
    // fixes elsewhere in this slice (the deny-message accuracy + the BashUnsandboxed-rule exclusion).
    test("enter_plan_mode/exit_plan_mode explicitly DENY under 'chat' despite being READ_ONLY — chat must never let the model flip its own fixed policy", () => {
      expect(gate.evaluate("enter_plan_mode", "chat")).toBe("deny");
      expect(gate.evaluate("exit_plan_mode", "chat")).toBe("deny");
    });
  });
});
