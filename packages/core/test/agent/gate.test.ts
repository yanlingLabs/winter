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

  // SP-policies Task 3 (6-mode evaluate() rewrite): the generic `policy === "auto"`/`"bypass"`
  // early-returns now fire for EVERY non-{READ_ONLY,NETWORK,ALWAYS_ASK} tool name, classified or
  // not — an unrecognized name rides the SAME "other MUTATING / external" row as a real MUTATING
  // tool under auto/bypass (the decision table has no separate "unclassified" row; see gate.ts's
  // own "Below: MUTATING / external / unclassified" comment). Fail-closed-to-the-human now holds
  // only for the HUMAN-GATED policies (ask/dont-ask/accept-edits-non-edit) and `plan` (still deny)
  // — NOT for auto/bypass, which are "trust the model" policies by design.
  test("unknown tools ask under ask-policy; auto now allows them too (SP-policies Task 3)", () => {
    expect(gate.evaluate("mystery", "auto")).toBe("allow");
    expect(gate.evaluate("mystery", "ask")).toBe("ask");
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

  // SP-policies Task 3: "frobnicate" (unclassified) now tracks write/bash/mcp__/plugin__ exactly —
  // ask under `ask`, allow under `auto` — since the 6-mode evaluate() rewrite's auto/bypass
  // early-returns apply before the unclassified default, not just to MUTATING/external names (see
  // the "unknown tools ask under ask-policy..." test above for the rationale). Every row below now
  // shares the identical p-dependent formula; the OLD byte-identical-snapshot claim held under the
  // 3-mode gate and is superseded by this task's decision table.
  test("ask/auto matrix: classified tools unchanged; unclassified now tracks MUTATING/external too (SP-policies Task 3)", () => {
    const g = new PermissionGate();
    for (const p of ["ask", "auto"] as const) {
      for (const [t, exp] of [
        ["read", "allow"],
        ["write", p === "auto" ? "allow" : "ask"],
        ["bash", p === "auto" ? "allow" : "ask"],
        ["mcp__x__y", p === "auto" ? "allow" : "ask"],
        ["plugin__x__y", p === "auto" ? "allow" : "ask"],
        ["frobnicate", p === "auto" ? "allow" : "ask"],
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
  // replacement class), plus the external (mcp__/plugin__) shape.
  test("guard: no existing tool joined ALWAYS_ASK — every previously classified tool still allows under auto", () => {
    const classified = [
      // READ_ONLY
      "read", "glob", "grep", "ls", "bash_output", "Skill", "ToolSearch", "ask_user", "task_create", "task_update", "task_list", "task_get", "exit_plan_mode", "enter_plan_mode", "spawn_agent", "send_message", "task_stop", "agent_list", "agent_output", "lsp", "push_notification",
      // MUTATING
      "write", "edit", "bash", "notebook_edit", "enter_worktree", "exit_worktree", "computer", "schedule",
      // NETWORK + externals
      "web_fetch", "web_search", "mcp__x__y", "plugin__x__y",
    ];
    for (const t of classified) expect(gate.evaluate(t, "auto")).toBe("allow");
  });

  // write-permission-flow (task 24, CC parity): request_directory is GONE — write/edit's own
  // out-of-root target now carries its own approval via the engine's dispatch loop (engine.ts's
  // `dirGrant` branch), not a self-gating tool the gate had to special-case. Guard against a
  // regression where the name comes back and the gate has to special-case it again.
  // SP-policies Task 3: under `auto` this now resolves to "allow" (same unclassified-tracks-
  // MUTATING/external widening as the "unknown tools" test above) — `ask`/`plan` are unchanged.
  test("request_directory is not a recognized tool name — falls to the unclassified branch like any unknown tool (ask/plan unchanged; auto now allows, SP-policies Task 3)", () => {
    expect(gate.evaluate("request_directory", "ask")).toBe("ask");
    expect(gate.evaluate("request_directory", "auto")).toBe("allow");
    expect(gate.evaluate("request_directory", "plan")).toBe("deny");
  });
});
