import { describe, expect, test } from "bun:test";
import {
  SessionAttachParams,
  SessionListResult,
  SessionAttachResult,
  SessionCreateParams,
  SessionCreateResult,
  ApprovalRespondParams,
  ApprovalRespondResult,
  ApprovalPolicy,
  AskUserRespondParams,
  AskUserRespondResult,
  TaskListParams,
  TaskListResult,
  PlanRespondParams,
  PlanRespondResult,
  SessionSetPolicyParams,
  SessionSetPolicyResult,
  SessionSetModelParams,
  SessionSetModelResult,
  SessionSetEffortParams,
  SessionSetEffortResult,
  SESSION_EFFORT_MAX_CHARS,
  SessionAddDirParams,
  SessionSetCwdParams,
  TrustDirParams,
  TrustDirResult,
  BgListParams,
  BgPeekParams,
  BgKillParams,
  BgKillAllParams,
  BgListResult,
  SessionSteerParams,
  SessionInterruptParams,
  SessionSteerResult,
  SessionInterruptResult,
  SessionCompactParams,
  SessionCompactResult,
  SkillMetaSchema,
  SkillsListParams,
  SkillsListResult,
  SkillsReadParams,
  SkillsReadResult,
  SkillsWriteParams,
  SkillsWriteResult,
  SkillsDeleteParams,
  SkillsDeleteResult,
  McpServerStatusSchema,
  PluginInfoSchema,
  PluginsListParams,
  PluginsListResult,
  ThreadInfoSchema,
  ThreadListParams,
  ThreadListResult,
  ThreadSendParams,
  ThreadSendResult,
  AgentStopParams,
  AgentStopResult,
  PeripheralLeaseParams,
  PeripheralLeaseResult,
  PeripheralRenewParams,
  PeripheralRenewResult,
  PeripheralReleaseParams,
  PeripheralReleaseResult,
  PeripheralAdvertiseParams,
  PeripheralAdvertiseResult,
  PeripheralRevokeParams,
  PeripheralRevokeResult,
  PeripheralRespondParams,
  PeripheralRespondResult,
  DaemonStatusParams,
  DaemonStatusResult,
  QuotaStateParams,
  QuotaStateResult,
  TrustListParams,
  TrustListResult,
  TrustRemoveParams,
  TrustRemoveResult,
  PluginRegisterParams,
  PluginRegisterResult,
  ToolRegisterParams,
  ToolRegisterResult,
  ShortcutRegisterParams,
  ShortcutRegisterResult,
  TileUpdateParams,
  TileUpdateResult,
  ProviderRegisterParams,
  ProviderRegisterResult,
  PluginContribEntrySchema,
  PluginsContribParams,
  PluginsContribResult,
  PluginToolResultParams,
  PluginToolResultResult,
  PluginRevokeTokenParams,
  PluginRevokeTokenResult,
  PluginRestartParams,
  PluginRestartResult,
  HardwareRequestParams,
  HardwareRequestResult,
  HardwareRespondParams,
  HardwareRespondResult,
  ShortcutInvokeParams,
  ShortcutInvokeResult,
  TileActionParams,
  TileActionResult,
  RoutineSchema,
  RoutinesCreateParams,
  RoutinesCreateResult,
  RoutinesListParams,
  RoutinesListResult,
  RoutinesUpdateParams,
  RoutinesUpdateResult,
  RoutinesDeleteParams,
  RoutinesDeleteResult,
  MemoryFactMetaSchema,
  MemoryFactSchema,
  MemoryAuditLineSchema,
  MemoryListParams,
  MemoryListResult,
  MemoryReadParams,
  MemoryReadResult,
  MemoryWriteParams,
  MemoryWriteResult,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryAuditParams,
  MemoryAuditResult,
  WorkflowListParams,
  WorkflowListResult,
  WorkflowRunViewSchema,
  WorkflowSavedSchema,
  WorkflowRunParams,
  WorkflowRunResult,
  WorkflowStopParams,
  WorkflowStopResult,
  WorkflowGetParams,
  WorkflowGetResult,
  SessionHistoryParams,
  SessionHistoryResult,
  SyncConfigParams,
  SyncConfigModel,
  SyncConfigResult,
  SyncPushParams,
  METHODS,
  PanelTabSchema,
  PanelOpenTabParams,
} from "../src/methods";

describe("SessionAttachParams", () => {
  test("fromSeq defaults to 0 when omitted", () => {
    const result = SessionAttachParams.parse({ sessionId: "abc" });
    expect(result.fromSeq).toBe(0);
  });
});

describe("lastSeq nonnegative", () => {
  test("SessionListResult rejects negative lastSeq", () => {
    expect(() =>
      SessionListResult.parse({
        sessions: [
          { sessionId: "s1", scope: "foo", createdAt: 0, lastSeq: -1 },
        ],
      })
    ).toThrow();
  });

  test("SessionAttachResult rejects negative lastSeq", () => {
    expect(() =>
      SessionAttachResult.parse({ ok: true, lastSeq: -1 })
    ).toThrow();
  });
});

describe("scope regex", () => {
  test('"abc-" rejected (trailing hyphen)', () => {
    expect(() => SessionCreateParams.parse({ scope: "abc-" })).toThrow();
  });

  test('"a" accepted (single char)', () => {
    expect(SessionCreateParams.parse({ scope: "a" }).scope).toBe("a");
  });

  test('"a--b" accepted (consecutive interior hyphens are fine)', () => {
    expect(SessionCreateParams.parse({ scope: "a--b" }).scope).toBe("a--b");
  });

  test("41-char scope accepted", () => {
    // slug: no leading/trailing hyphen, ≤41 chars
    const slug = "a" + "b".repeat(39) + "c"; // 41 chars
    expect(SessionCreateParams.parse({ scope: slug }).scope).toBe(slug);
  });

  test("42-char scope rejected", () => {
    const slug = "a" + "b".repeat(40) + "c"; // 42 chars
    expect(() => SessionCreateParams.parse({ scope: slug })).toThrow();
  });
});

describe("agent method schemas", () => {
  test("approval.respond params/result", () => {
    const p = ApprovalRespondParams.parse({ sessionId: "s_1", callId: "c1", approved: false });
    expect(p.approved).toBe(false);
    expect(ApprovalRespondResult.parse({ ok: true, alreadyResolved: false }).ok).toBe(true);
    expect(METHODS.approvalRespond).toBe("approval.respond");
  });

  test("session.create accepts optional cwd (absolute) and approvalPolicy", () => {
    const p = SessionCreateParams.parse({ scope: "global", cwd: "/tmp/x", approvalPolicy: "auto" });
    expect(p.approvalPolicy).toBe("auto");
    expect(SessionCreateParams.parse({ scope: "global" }).approvalPolicy).toBe("ask");
    expect(() => SessionCreateParams.parse({ scope: "global", cwd: "relative/path" })).toThrow();
  });

  // Phase 5 routines T3 (design doc §3): additive session-meta `origin` — optional on both the
  // create params and each session.list row (superseding T2's title-only stamp with a real,
  // machine-readable field).
  test("session.create accepts optional origin; session.list rows carry it (both optional, older shapes still parse)", () => {
    const p = SessionCreateParams.parse({ scope: "global", origin: "routine/abc123" });
    expect(p.origin).toBe("routine/abc123");
    expect(SessionCreateParams.parse({ scope: "global" }).origin).toBeUndefined();
    expect(() => SessionCreateParams.parse({ scope: "global", origin: "" })).toThrow();

    const listed = SessionListResult.parse({
      sessions: [
        { sessionId: "s_1", scope: "global", createdAt: 1, lastSeq: 0, origin: "routine/abc123" },
        { sessionId: "s_2", scope: "global", createdAt: 1, lastSeq: 0 }, // no origin — pre-existing shape
      ],
    });
    expect(listed.sessions[0]!.origin).toBe("routine/abc123");
    expect(listed.sessions[1]!.origin).toBeUndefined();
  });

  test("session.list rows carry an optional title (values already flow; this declares them)", () => {
    const listed = SessionListResult.parse({
      sessions: [
        { sessionId: "s_1", scope: "global", createdAt: 1, lastSeq: 3, title: "Fixing the login flow" },
        { sessionId: "s_2", scope: "global", createdAt: 1, lastSeq: 0 }, // no title — pre-existing shape still parses
      ],
    });
    expect(listed.sessions[0]!.title).toBe("Fixing the login flow");
    expect(listed.sessions[1]!.title).toBeUndefined();
  });

  test("session.history params/result schemas", () => {
    expect(METHODS.sessionHistory).toBe("session.history");
    // params: sessionId required; beforeSeq/limit optional, positive, limit capped at 500
    expect(SessionHistoryParams.parse({ sessionId: "s_1" }).sessionId).toBe("s_1");
    expect(SessionHistoryParams.parse({ sessionId: "s_1", beforeSeq: 42, limit: 200 }).limit).toBe(200);
    expect(() => SessionHistoryParams.parse({ sessionId: "s_1", beforeSeq: 0 })).toThrow();   // positive
    expect(() => SessionHistoryParams.parse({ sessionId: "s_1", limit: 501 })).toThrow();      // max 500
    // result: oldestSeq is nullable (null iff events empty)
    const r = SessionHistoryResult.parse({ events: [], hasMore: false, oldestSeq: null });
    expect(r.oldestSeq).toBeNull();
    const one = { seq: 7, sessionId: "s_1", ts: 1, threadId: "main", type: "assistant_message", text: "hi" };
    const r2 = SessionHistoryResult.parse({ events: [one], hasMore: true, oldestSeq: 7 });
    expect(r2.events[0]!.type).toBe("assistant_message");
    expect(r2.hasMore).toBe(true);
  });
});

describe("directory method schemas", () => {
  test("session.addDir / session.setCwd params", () => {
    expect(SessionAddDirParams.parse({ sessionId: "s1", path: "/x", persist: true }).persist).toBe(true);
    expect(SessionAddDirParams.parse({ sessionId: "s1", path: "/x" }).persist).toBe(false);
    expect(() => SessionSetCwdParams.parse({ sessionId: "s1", cwd: "rel" })).toThrow();
    expect(SessionSetCwdParams.parse({ sessionId: "s1", cwd: "/abs" }).cwd).toBe("/abs");
    expect(METHODS.sessionAddDir).toBe("session.addDir");
    expect(METHODS.sessionSetCwd).toBe("session.setCwd");
  });
});

describe("SessionCreateResult.trusted", () => {
  test("SessionCreateResult carries trusted", () => {
    expect(SessionCreateResult.parse({ sessionId: "s1", trusted: false }).trusted).toBe(false);
    expect(() => SessionCreateResult.parse({ sessionId: "s1" })).toThrow(); // trusted now required
  });
});

describe("daemon.trustDir", () => {
  test("daemon.trustDir params/result + method string", () => {
    expect(TrustDirParams.parse({ path: "/Users/x/proj" }).path).toBe("/Users/x/proj");
    expect(() => TrustDirParams.parse({ path: "rel" })).toThrow();   // must be absolute
    expect(() => TrustDirParams.parse({ path: "/" })).toThrow();     // reject filesystem root
    expect(TrustDirResult.parse({ ok: true, trusted: true }).trusted).toBe(true);
    expect(METHODS.trustDir).toBe("daemon.trustDir");
  });
});

describe("cwd '/' rejection", () => {
  test("cwd '/' is rejected for create and setCwd (whole-fs guard)", () => {
    expect(() => SessionCreateParams.parse({ scope: "global", cwd: "/" })).toThrow();
    expect(() => SessionSetCwdParams.parse({ sessionId: "s1", cwd: "/" })).toThrow();
    expect(SessionCreateParams.parse({ scope: "global", cwd: "/Users/x" }).cwd).toBe("/Users/x");
  });
});

describe("bg.* method schemas", () => {
  test("bg.* method schemas", () => {
    expect(BgListParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(BgPeekParams.parse({ sessionId: "s1", taskId: "bg_a" }).taskId).toBe("bg_a");
    expect(BgKillParams.parse({ sessionId: "s1", taskId: "bg_a" }).taskId).toBe("bg_a");
    expect(BgKillAllParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(BgListResult.parse({ tasks: [{ taskId: "bg_a", command: "sleep 5", status: "running", exitCode: null, startedAt: 1 }] }).tasks).toHaveLength(1);
    expect([METHODS.bgList, METHODS.bgPeek, METHODS.bgKill, METHODS.bgKillAll]).toEqual(["bg.list", "bg.peek", "bg.kill", "bg.killAll"]);
  });
});

describe("session.steer / session.interrupt schemas", () => {
  test("session.steer / session.interrupt schemas", () => {
    expect(SessionSteerParams.parse({ sessionId: "s1", text: "hi" }).text).toBe("hi");
    expect(() => SessionSteerParams.parse({ sessionId: "s1", text: "" })).toThrow();
    expect(SessionSteerResult.parse({ ok: true, injected: true }).injected).toBe(true);
    expect(SessionInterruptParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(SessionInterruptResult.parse({ ok: true, wasRunning: false }).wasRunning).toBe(false);
    expect([METHODS.sessionSteer, METHODS.sessionInterrupt]).toEqual(["session.steer", "session.interrupt"]);
  });
});

describe("session.compact schema", () => {
  test("session.compact params/result + method string", () => {
    expect(SessionCompactParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(() => SessionCompactParams.parse({ sessionId: "" })).toThrow();
    const r = SessionCompactResult.parse({ ok: true, compacted: true, uptoSeq: 12, summaryChars: 340 });
    expect(r).toEqual({ ok: true, compacted: true, uptoSeq: 12, summaryChars: 340 });
    expect(() => SessionCompactResult.parse({ ok: true, compacted: true, uptoSeq: -1, summaryChars: 0 })).toThrow();
    expect(() => SessionCompactResult.parse({ ok: true, compacted: true, uptoSeq: 0, summaryChars: -1 })).toThrow();
    expect(METHODS.sessionCompact).toBe("session.compact");
  });
});

describe("skills.list schema", () => {
  test("skills.list params/result + method string", () => {
    expect(SkillsListParams.parse({}).cwd).toBeUndefined();
    expect(SkillsListParams.parse({ cwd: "/tmp/x" }).cwd).toBe("/tmp/x");
    const meta = SkillMetaSchema.parse({ name: "greet", description: "Say hi", source: "user", path: "/x/SKILL.md" });
    expect(meta.source).toBe("user");
    expect(() => SkillMetaSchema.parse({ name: "greet", description: "Say hi", source: "bogus", path: "/x" })).toThrow();
    const r = SkillsListResult.parse({ ok: true, skills: [meta] });
    expect(r.skills).toHaveLength(1);
    expect(METHODS.skillsList).toBe("skills.list");
  });

  test("SkillMetaSchema.author is optional, round-trips when present (phase 5c Task 3)", () => {
    const meta = SkillMetaSchema.parse({ name: "greet", description: "Say hi", source: "self", path: "/x/SKILL.md" });
    expect(meta.author).toBeUndefined();
    const stamped = SkillMetaSchema.parse({ name: "greet", description: "Say hi", source: "self", path: "/x", author: "norma" });
    expect(stamped.author).toBe("norma");
  });

  // 5c T3 review regression: source:"builtin" (always present since T1's shipped writing-skills)
  // and claudeFormat (set on claude-format plugin skills) existed on core's SkillMeta but not this
  // wire schema — one unparseable element fails z.array() wholesale, so the CLI's validated
  // listSkills threw on EVERY skills.list response. Pin both fields at the schema layer.
  test("SkillMetaSchema admits source 'builtin' and optional claudeFormat; SkillsListResult parses a mixed list", () => {
    const builtin = SkillMetaSchema.parse({ name: "writing-skills", description: "d", source: "builtin", path: "/repo/packages/core/skills/writing-skills/SKILL.md" });
    expect(builtin.source).toBe("builtin");
    expect(builtin.claudeFormat).toBeUndefined();
    const ccPlugin = SkillMetaSchema.parse({ name: "cc-plug:greet", description: "d", source: "plugin", path: "/x", claudeFormat: true });
    expect(ccPlugin.claudeFormat).toBe(true);
    const r = SkillsListResult.parse({ ok: true, skills: [ccPlugin, builtin] });
    expect(r.skills).toHaveLength(2);
  });
});

describe("skills.read/write/delete schemas (Phase 5c Task 3)", () => {
  test("METHODS carries all three verbs", () => {
    expect(METHODS.skillsRead).toBe("skills.read");
    expect(METHODS.skillsWrite).toBe("skills.write");
    expect(METHODS.skillsDelete).toBe("skills.delete");
  });

  test("skills.read params: name required, cwd optional; result is {skill} with body", () => {
    expect(SkillsReadParams.parse({ name: "my-skill" })).toEqual({ name: "my-skill" });
    expect(SkillsReadParams.parse({ name: "my-skill", cwd: "/tmp/proj" })).toEqual({ name: "my-skill", cwd: "/tmp/proj" });
    expect(() => SkillsReadParams.parse({ name: "" })).toThrow();
    const skill = { name: "my-skill", description: "d", source: "self" as const, path: "/x/SKILL.md", author: "norma", body: "BODY" };
    expect(SkillsReadResult.parse({ skill })).toEqual({ skill });
  });

  test("skills.write params require name/description/body, no cwd/scope; result is empty", () => {
    const p = SkillsWriteParams.parse({ name: "my-skill", description: "d", body: "b" });
    expect(p).toEqual({ name: "my-skill", description: "d", body: "b" });
    expect(() => SkillsWriteParams.parse({ name: "my-skill", description: "d", body: "" })).toThrow();
    expect(() => SkillsWriteParams.parse({ name: "", description: "d", body: "b" })).toThrow();
    expect(SkillsWriteResult.parse({})).toEqual({});
  });

  test("skills.delete params: name only, no cwd/scope; result is empty", () => {
    expect(SkillsDeleteParams.parse({ name: "my-skill" })).toEqual({ name: "my-skill" });
    expect(() => SkillsDeleteParams.parse({ name: "" })).toThrow();
    expect(SkillsDeleteResult.parse({})).toEqual({});
  });
});

describe("plugins.list schema", () => {
  test("plugins.list params/result + method string", () => {
    expect(PluginsListParams.parse({})).toEqual({});
    const info = PluginInfoSchema.parse({
      name: "demo", description: "d", version: "0.1.0",
      skills: ["greet"], hasMcp: true, mcpEnabled: false, disabled: false,
    });
    expect(info.name).toBe("demo");
    // description/version are optional
    expect(PluginInfoSchema.parse({ name: "bare", skills: [], hasMcp: false, mcpEnabled: false, disabled: false }).description).toBeUndefined();
    const r = PluginsListResult.parse({ ok: true, plugins: [info] });
    expect(r.plugins).toHaveLength(1);
    expect(METHODS.pluginsList).toBe("plugins.list");
  });

  test("Phase 4a Task 3: consent-flow fields (tier/requiredConsents/consented/legacy/execPayload/tccPermissions/hardwarePermissions) round-trip", () => {
    const info = PluginInfoSchema.parse({
      name: "demo", skills: [], hasMcp: false, mcpEnabled: true, disabled: false,
      tier: "platform", requiredConsents: ["exec", "tcc", "hardware"], consented: ["exec"], legacy: false,
      execPayload: ["mcp: node server.js", "entry: node index.js"],
      tccPermissions: ["accessibility"], hardwarePermissions: ["battery"],
    });
    expect(info).toMatchObject({
      tier: "platform", requiredConsents: ["exec", "tcc", "hardware"], consented: ["exec"], legacy: false,
      execPayload: ["mcp: node server.js", "entry: node index.js"],
      tccPermissions: ["accessibility"], hardwarePermissions: ["battery"],
    });
  });

  test("McpServerStatusSchema.source is widened to include \"plugin\"", () => {
    expect(McpServerStatusSchema.parse({ name: "x", status: "connected", toolNames: [], source: "plugin" }).source).toBe("plugin");
  });

  test("Phase 4d-i Task 4: status is optional and accepts every SupervisorStatus value plus \"na\"", () => {
    expect(PluginInfoSchema.parse({ name: "bare", skills: [], hasMcp: false, mcpEnabled: false, disabled: false }).status).toBeUndefined();
    for (const status of ["starting", "running", "backoff", "circuit-open", "stopped", "na"] as const) {
      expect(PluginInfoSchema.parse({ name: "demo", skills: [], hasMcp: false, mcpEnabled: true, disabled: false, status }).status).toBe(status);
    }
    expect(() => PluginInfoSchema.parse({ name: "demo", skills: [], hasMcp: false, mcpEnabled: true, disabled: false, status: "bogus" })).toThrow();
  });
});

describe("ask_user.respond / task.list schemas", () => {
  test("ask_user.respond params/result + method string", () => {
    const p = AskUserRespondParams.parse({ sessionId: "s1", callId: "c1", answers: { "Which codename?": "Falcon" } });
    expect(p.answers["Which codename?"]).toBe("Falcon");
    expect(AskUserRespondResult.parse({ ok: true, alreadyResolved: false }).alreadyResolved).toBe(false);
    expect(METHODS.askUserRespond).toBe("ask_user.respond");
  });

  // CC AskUserQuestion parity: optional per-question `notes`, additive to `answers`.
  test("ask_user.respond params accept optional notes, keyed like answers", () => {
    const withNotes = AskUserRespondParams.parse({
      sessionId: "s1", callId: "c1", answers: { "Which codename?": "Falcon" }, notes: { "Which codename?": "prefer the bird" },
    });
    expect(withNotes.notes?.["Which codename?"]).toBe("prefer the bird");

    const withoutNotes = AskUserRespondParams.parse({ sessionId: "s1", callId: "c1", answers: { "Which codename?": "Falcon" } });
    expect(withoutNotes.notes).toBeUndefined();
  });

  test("task.list params/result + method string", () => {
    expect(TaskListParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    const r = TaskListResult.parse({ ok: true, tasks: [{ id: "1", subject: "rename", status: "pending" }] });
    expect(r.tasks).toHaveLength(1);
    expect(() => TaskListResult.parse({ ok: true, tasks: [{ id: "1", subject: "rename", status: "bogus" }] })).toThrow();
    expect(METHODS.taskList).toBe("task.list");
  });
});

describe("plan.respond / session.setPolicy schemas", () => {
  test("ApprovalPolicy accepts plan; plan.respond + session.setPolicy params parse", () => {
    expect(ApprovalPolicy.parse("plan")).toBe("plan");
    expect(PlanRespondParams.parse({ sessionId: "s", callId: "c", approved: false }).autoAccept).toBe(false); // default
    expect(SessionSetPolicyParams.parse({ sessionId: "s", policy: "plan" }).policy).toBe("plan");
  });

  test("plan.respond params/result + method string", () => {
    const p = PlanRespondParams.parse({ sessionId: "s1", callId: "c1", approved: true, feedback: "looks good", autoAccept: true });
    expect(p).toEqual({ sessionId: "s1", callId: "c1", approved: true, feedback: "looks good", autoAccept: true });
    expect(PlanRespondResult.parse({ ok: true, alreadyResolved: false }).alreadyResolved).toBe(false);
    expect(METHODS.planRespond).toBe("plan.respond");
  });

  test("session.setPolicy params/result + method string", () => {
    expect(SessionSetPolicyParams.parse({ sessionId: "s1", policy: "auto" }).policy).toBe("auto");
    expect(() => SessionSetPolicyParams.parse({ sessionId: "s1", policy: "bogus" })).toThrow();
    expect(SessionSetPolicyResult.parse({ ok: true }).ok).toBe(true);
    expect(METHODS.sessionSetPolicy).toBe("session.setPolicy");
  });

  // mac-chat-parity T4: the READ half of `session.setPolicy` — the row now reports the policy the
  // setter writes, so a persistent picker can show the truth instead of its own last write.
  test("SessionListResult rows carry an optional approvalPolicy; older shapes without it still parse", () => {
    const listed = SessionListResult.parse({
      sessions: [
        { sessionId: "s_1", scope: "global", createdAt: 1, lastSeq: 0, approvalPolicy: "bypass" },
        { sessionId: "s_2", scope: "global", createdAt: 1, lastSeq: 0 }, // an OLDER daemon — never a real answer
      ],
    });
    expect(listed.sessions[0]!.approvalPolicy).toBe("bypass");
    expect(listed.sessions[1]!.approvalPolicy).toBeUndefined();
  });

  // The row's field is a bare bounded STRING, deliberately NOT `ApprovalPolicy` — a chat session's
  // stored policy is the internal `"chat"` (core's gate.ts `SessionApprovalPolicy`), which
  // `session.create` persists verbatim and which is NOT a settable wire value. Typing the row with
  // the setter's enum would make the daemon's own truthful answer fail its own schema — the exact
  // clamp-whose-output-its-own-schema-rejects contradiction `capTitle`'s doc records.
  test("the row's approvalPolicy admits the internal chat value the setter's enum rejects", () => {
    expect(() => SessionSetPolicyParams.parse({ sessionId: "s1", policy: "chat" })).toThrow();
    const listed = SessionListResult.parse({
      sessions: [{ sessionId: "s_chat", scope: "global", createdAt: 1, lastSeq: 0, approvalPolicy: "chat" }],
    });
    expect(listed.sessions[0]!.approvalPolicy).toBe("chat");
  });

  // Empty is not a policy: a zero-length string would reach a picker as a value that matches no row
  // and reads as "some policy we don't render", which is worse than the honest absent case.
  test("an empty approvalPolicy is refused", () => {
    expect(() => SessionListResult.parse({
      sessions: [{ sessionId: "s_1", scope: "global", createdAt: 1, lastSeq: 0, approvalPolicy: "" }],
    })).toThrow();
  });
});

// Chat Slice D Task 1: per-session model override — session.setModel {sessionId, model: string|null}
// → {} (null clears). Works for ALL modes (unlike session.setPolicy, which chat rejects outright).
describe("session.setModel schema (Chat Slice D Task 1)", () => {
  test("params: sessionId required non-empty, model is a nullable string (both string and null accepted)", () => {
    expect(SessionSetModelParams.parse({ sessionId: "s1", model: "claude-opus-5" }).model).toBe("claude-opus-5");
    expect(SessionSetModelParams.parse({ sessionId: "s1", model: null }).model).toBeNull();
    expect(() => SessionSetModelParams.parse({ sessionId: "s1", model: "" })).toThrow(); // empty string is not a valid model id
    expect(() => SessionSetModelParams.parse({ sessionId: "", model: "m" })).toThrow();
    expect(() => SessionSetModelParams.parse({ sessionId: "s1" })).toThrow(); // model is required (nullable, not optional)
  });

  test("result is empty; METHODS carries the verb", () => {
    expect(SessionSetModelResult.parse({})).toEqual({});
    expect(METHODS.sessionSetModel).toBe("session.setModel");
  });
});

describe("session.create / session.list carry an optional per-session model (Chat Slice D Task 1)", () => {
  test("SessionCreateParams accepts an optional model, absent by default", () => {
    expect(SessionCreateParams.parse({ scope: "global", model: "claude-opus-5" }).model).toBe("claude-opus-5");
    expect(SessionCreateParams.parse({ scope: "global" }).model).toBeUndefined();
    expect(() => SessionCreateParams.parse({ scope: "global", model: "" })).toThrow();
  });

  test("SessionListResult rows carry an optional model; older shapes without it still parse", () => {
    const listed = SessionListResult.parse({
      sessions: [
        { sessionId: "s_1", scope: "global", createdAt: 1, lastSeq: 0, model: "claude-opus-5" },
        { sessionId: "s_2", scope: "global", createdAt: 1, lastSeq: 0 }, // no model — pre-existing shape
      ],
    });
    expect(listed.sessions[0]!.model).toBe("claude-opus-5");
    expect(listed.sessions[1]!.model).toBeUndefined();
  });
});

// provider-correctness T4: per-session reasoning effort — session.setEffort {sessionId, effort:
// string|null} → {} (null clears). Its OWN method, not a second argument on session.setModel
// ("effort and model are two different things, just like the CLI"), and mode-agnostic on the same
// terms. The VALUE is not enumerated here on purpose: which efforts a model accepts is provider
// knowledge the daemon checks at set time (a zod enum here would be a second, drift-prone copy of
// a set this package cannot see change).
describe("session.setEffort schema (provider-correctness T4)", () => {
  test("params: sessionId required non-empty, effort is a nullable string (both string and null accepted)", () => {
    expect(SessionSetEffortParams.parse({ sessionId: "s1", effort: "xhigh" }).effort).toBe("xhigh");
    expect(SessionSetEffortParams.parse({ sessionId: "s1", effort: null }).effort).toBeNull();
    expect(() => SessionSetEffortParams.parse({ sessionId: "s1", effort: "" })).toThrow(); // empty string is not a level
    expect(() => SessionSetEffortParams.parse({ sessionId: "", effort: "high" })).toThrow();
    expect(() => SessionSetEffortParams.parse({ sessionId: "s1" })).toThrow(); // effort is required (nullable, not optional)
  });

  test("the value is bounded but NOT enumerated — an unknown slug parses here and is refused by the daemon", () => {
    // "minimal" is a real level the API rejects PER-MODEL; the wire schema deliberately lets it
    // through so the daemon's model-aware check (ipc/server.ts) is the one place that decides.
    expect(SessionSetEffortParams.parse({ sessionId: "s1", effort: "minimal" }).effort).toBe("minimal");
    expect(SessionSetEffortParams.parse({ sessionId: "s1", effort: "e".repeat(SESSION_EFFORT_MAX_CHARS) }).effort!.length).toBe(SESSION_EFFORT_MAX_CHARS);
    expect(() => SessionSetEffortParams.parse({ sessionId: "s1", effort: "e".repeat(SESSION_EFFORT_MAX_CHARS + 1) })).toThrow();
  });

  test("result is empty; METHODS carries the verb", () => {
    expect(SessionSetEffortResult.parse({})).toEqual({});
    expect(METHODS.sessionSetEffort).toBe("session.setEffort");
  });

  test("SessionListResult rows carry an optional effort; older shapes without it still parse", () => {
    const listed = SessionListResult.parse({
      sessions: [
        { sessionId: "s_1", scope: "global", createdAt: 1, lastSeq: 0, effort: "xhigh" },
        { sessionId: "s_2", scope: "global", createdAt: 1, lastSeq: 0 }, // no effort — uses the global default
      ],
    });
    expect(listed.sessions[0]!.effort).toBe("xhigh");
    expect(listed.sessions[1]!.effort).toBeUndefined();
  });
});

// provider-correctness T6: the two remaining places a per-session effort can enter the daemon —
// `sync.push`'s index-only `meta` (the phone's replication path) and `session.create` (so a client
// that wants an effort from turn one doesn't need a second round trip). Both are SHAPE-only here;
// the model-aware membership check and the tier gate live in core, at each handler.
describe("per-session effort ingress shapes (provider-correctness T6)", () => {
  test("SyncPushParams.meta carries an optional effort, bounded by SESSION_EFFORT_MAX_CHARS", () => {
    const base = { sessionId: "s1", baseSeq: 0, data: "", complete: true };
    expect(SyncPushParams.parse({ ...base, meta: { effort: "xhigh" } }).meta!.effort).toBe("xhigh");
    // Absent stays absent — an omitted field is "unchanged", never "clear" (applySyncMeta's rule).
    expect(SyncPushParams.parse({ ...base, meta: { title: "t" } }).meta!.effort).toBeUndefined();
    expect(SyncPushParams.parse({ ...base }).meta).toBeUndefined();
    expect(() => SyncPushParams.parse({ ...base, meta: { effort: "" } })).toThrow();
    expect(() => SyncPushParams.parse({ ...base, meta: { effort: "e".repeat(SESSION_EFFORT_MAX_CHARS + 1) } })).toThrow();
  });

  test("SyncPushParams.meta.effort is bounded but NOT enumerated — the tier drop is a handler rule", () => {
    // `ultra` is a Norma-level tier this ingress always DROPS (sync.push is chat-only fail-closed,
    // and tiers are code-sessions-only). It parses here on purpose: the schema is a shape contract,
    // and enumerating levels in this package would be a second copy of a set it cannot see change.
    const base = { sessionId: "s1", baseSeq: 0, data: "", complete: true };
    expect(SyncPushParams.parse({ ...base, meta: { effort: "ultra" } }).meta!.effort).toBe("ultra");
  });

  test("SessionCreateParams accepts an optional effort, absent by default", () => {
    expect(SessionCreateParams.parse({ scope: "global", effort: "high" }).effort).toBe("high");
    expect(SessionCreateParams.parse({ scope: "global" }).effort).toBeUndefined();
    expect(() => SessionCreateParams.parse({ scope: "global", effort: "" })).toThrow();
    expect(() => SessionCreateParams.parse({ scope: "global", effort: "e".repeat(SESSION_EFFORT_MAX_CHARS + 1) })).toThrow();
  });
});

describe("peripheral lease + dashboard read methods", () => {
  test("METHODS carries the six peripheral verbs + four dashboard read methods", () => {
    expect(METHODS.peripheralLease).toBe("peripheral.lease");
    expect(METHODS.peripheralRenew).toBe("peripheral.renew");
    expect(METHODS.peripheralRelease).toBe("peripheral.release");
    expect(METHODS.peripheralAdvertise).toBe("peripheral.advertise");
    expect(METHODS.peripheralRevoke).toBe("peripheral.revoke");
    expect(METHODS.peripheralRespond).toBe("peripheral.respond");
    expect(METHODS.daemonStatus).toBe("daemon.status");
    expect(METHODS.quotaState).toBe("quota.state");
    expect(METHODS.trustList).toBe("trust.list");
    expect(METHODS.trustRemove).toBe("trust.remove");
  });

  test("peripheral.lease params/result: class enum + grant/held/no_provider/denied variants", () => {
    expect(PeripheralLeaseParams.parse({ sessionId: "s1", class: "noop" }).class).toBe("noop");
    expect(() => PeripheralLeaseParams.parse({ sessionId: "s1", class: "bogus" })).toThrow();
    const granted = PeripheralLeaseResult.parse({ leaseId: "l1", token: "t1", expiresAt: 100 });
    expect("leaseId" in granted && granted.leaseId).toBe("l1");
    expect(PeripheralLeaseResult.parse({ code: "lease_held", holder: { kind: "session", id: "s2" } })).toEqual({
      code: "lease_held", holder: { kind: "session", id: "s2" },
    });
    expect(PeripheralLeaseResult.parse({ code: "no_provider" })).toEqual({ code: "no_provider" });
    expect(PeripheralLeaseResult.parse({ code: "denied" })).toEqual({ code: "denied" });
    const pluginDenied = PeripheralLeaseResult.parse({ code: "denied", reason: "plugin-leasing-not-yet-available" });
    expect("reason" in pluginDenied && pluginDenied.reason).toBe("plugin-leasing-not-yet-available");
    expect(() => PeripheralLeaseResult.parse({ code: "bogus" })).toThrow();
  });

  test("peripheral.renew / peripheral.release params/result", () => {
    const rp = PeripheralRenewParams.parse({ sessionId: "s1", leaseId: "l1", token: "t1" });
    expect(rp).toEqual({ sessionId: "s1", leaseId: "l1", token: "t1" });
    const renewed = PeripheralRenewResult.parse({ ok: true, expiresAt: 200 });
    expect("expiresAt" in renewed && renewed.expiresAt).toBe(200);
    expect(PeripheralRenewResult.parse({ code: "not_found" })).toEqual({ code: "not_found" });
    expect(PeripheralRenewResult.parse({ code: "token_mismatch" })).toEqual({ code: "token_mismatch" });
    // L1 fix: renew() rejects a lease past expiresAt (pre-sweep window) instead of resurrecting it.
    expect(PeripheralRenewResult.parse({ code: "expired" })).toEqual({ code: "expired" });
    const renewDenied = PeripheralRenewResult.parse({ code: "denied", reason: "plugin-leasing-not-yet-available" });
    expect("code" in renewDenied && renewDenied.code).toBe("denied");

    const relp = PeripheralReleaseParams.parse({ sessionId: "s1", leaseId: "l1", token: "t1" });
    expect(relp).toEqual({ sessionId: "s1", leaseId: "l1", token: "t1" });
    expect(PeripheralReleaseResult.parse({ ok: true })).toEqual({ ok: true });
    expect(PeripheralReleaseResult.parse({ code: "not_found" })).toEqual({ code: "not_found" });
  });

  test("peripheral.advertise / peripheral.revoke / peripheral.respond params/result", () => {
    const ap = PeripheralAdvertiseParams.parse({ classes: [{ class: "noop", tccGranted: true }] });
    expect(ap.classes).toHaveLength(1);
    expect(PeripheralAdvertiseResult.parse({ ok: true })).toEqual({ ok: true });

    expect(PeripheralRevokeParams.parse({ all: true, reason: "panic" })).toEqual({ all: true, reason: "panic" });
    expect(PeripheralRevokeParams.parse({ leaseId: "l1", reason: "revoked" }).leaseId).toBe("l1");
    expect(() => PeripheralRevokeParams.parse({ all: true, reason: "bogus" })).toThrow();
    expect(PeripheralRevokeResult.parse({ ok: true, revoked: 2 }).revoked).toBe(2);

    expect(PeripheralRespondParams.parse({ requestId: "r1", resultJson: "{}" }).requestId).toBe("r1");
    expect(PeripheralRespondParams.parse({ requestId: "r1", error: "boom" }).error).toBe("boom");
    expect(PeripheralRespondResult.parse({ ok: true, alreadyResolved: false }).alreadyResolved).toBe(false);
  });

  test("daemon.status / quota.state shapes", () => {
    expect(DaemonStatusParams.parse({})).toEqual({});
    const status = DaemonStatusResult.parse({
      version: "0.0.1", uptimeMs: 1234, socketPath: "/tmp/core.sock",
      provider: { id: "fake", model: "fake-1" }, sessionsCount: 2, pluginsCount: 0,
    });
    expect(status.provider?.id).toBe("fake");
    expect(DaemonStatusResult.parse({
      version: "0.0.1", uptimeMs: 0, socketPath: "/tmp/core.sock",
      provider: null, sessionsCount: 0, pluginsCount: 0,
    }).provider).toBeNull();

    expect(QuotaStateParams.parse({})).toEqual({});
    expect(QuotaStateResult.parse({ kind: "ok", inputTokens: 0, outputTokens: 0 }).kind).toBe("ok");
    const limited = QuotaStateResult.parse({ kind: "limited", resumeAt: 999, inputTokens: 5, outputTokens: 6 });
    expect(limited.resumeAt).toBe(999);
  });

  test("trust.list / trust.remove params/result", () => {
    expect(TrustListParams.parse({})).toEqual({});
    expect(TrustListResult.parse({ dirs: ["/a", "/b"] }).dirs).toHaveLength(2);
    expect(TrustRemoveParams.parse({ path: "/a" }).path).toBe("/a");
    expect(() => TrustRemoveParams.parse({ path: "rel" })).toThrow();
    expect(TrustRemoveResult.parse({ removed: true }).removed).toBe(true);
  });
});

describe("thread.list schema", () => {
  test("thread.list params/result + method string", () => {
    expect(ThreadListParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(() => ThreadListParams.parse({ sessionId: "" })).toThrow();
    const info = ThreadInfoSchema.parse({ threadId: "th_child1", parentThreadId: "main", agentType: "researcher", status: "running" });
    expect(info.status).toBe("running");
    // parentThreadId/agentType/stopReason are optional
    expect(ThreadInfoSchema.parse({ threadId: "main", status: "completed" }).parentThreadId).toBeUndefined();
    expect(() => ThreadInfoSchema.parse({ threadId: "t", status: "bogus" })).toThrow();
    const r = ThreadListResult.parse({ ok: true, threads: [info] });
    expect(r.threads).toHaveLength(1);
    expect(METHODS.threadList).toBe("thread.list");
  });
});

describe("thread.send / agent.stop (child-transcript-view T1)", () => {
  test("METHODS carries both verbs", () => {
    expect(METHODS.threadSend).toBe("thread.send");
    expect(METHODS.agentStop).toBe("agent.stop");
  });

  test("thread.send params: sessionId/agent/text all required non-empty", () => {
    const p = ThreadSendParams.parse({ sessionId: "s1", agent: "worker", text: "keep going" });
    expect(p).toEqual({ sessionId: "s1", agent: "worker", text: "keep going" });
    expect(() => ThreadSendParams.parse({ sessionId: "s1", agent: "", text: "x" })).toThrow();
    expect(() => ThreadSendParams.parse({ sessionId: "s1", agent: "worker", text: "" })).toThrow();
    expect(() => ThreadSendParams.parse({ sessionId: "s1", agent: "worker" })).toThrow();
  });

  test("thread.send result: delivered is queued|resumed, agentId round-trips", () => {
    const queued = ThreadSendResult.parse({ ok: true, delivered: "queued", agentId: "ag_1" });
    expect(queued.delivered).toBe("queued");
    const resumed = ThreadSendResult.parse({ ok: true, delivered: "resumed", agentId: "ag_2" });
    expect(resumed.delivered).toBe("resumed");
    expect(() => ThreadSendResult.parse({ ok: true, delivered: "sent", agentId: "ag_1" })).toThrow();
  });

  test("agent.stop params: sessionId/agent required non-empty", () => {
    expect(AgentStopParams.parse({ sessionId: "s1", agent: "worker" })).toEqual({ sessionId: "s1", agent: "worker" });
    expect(() => AgentStopParams.parse({ sessionId: "s1", agent: "" })).toThrow();
  });

  test("agent.stop result: status is the full AgentStatus enum (running included, though the handler never returns it)", () => {
    for (const status of ["running", "completed", "failed", "stopped", "timeout"] as const) {
      expect(AgentStopResult.parse({ ok: true, status }).status).toBe(status);
    }
    expect(() => AgentStopResult.parse({ ok: true, status: "bogus" })).toThrow();
  });
});

describe("plugin verbs (Phase 4b Task 1, spec §3)", () => {
  test("METHODS carries the six plugin verbs", () => {
    expect(METHODS.pluginRegister).toBe("plugin.register");
    expect(METHODS.toolRegister).toBe("tool.register");
    expect(METHODS.shortcutRegister).toBe("shortcut.register");
    expect(METHODS.tileUpdate).toBe("tile.update");
    expect(METHODS.providerRegister).toBe("provider.register");
    expect(METHODS.pluginToolResult).toBe("plugin.toolResult");
  });

  test("plugin.register params/result", () => {
    expect(PluginRegisterParams.parse({ pluginId: "sample-echo" }).pluginId).toBe("sample-echo");
    expect(() => PluginRegisterParams.parse({ pluginId: "" })).toThrow();
    expect(PluginRegisterResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("tool.register params/result: parameters optional, registeredAs required in result", () => {
    const bare = ToolRegisterParams.parse({ name: "echo", description: "Echo the input back" });
    expect(bare.parameters).toBeUndefined();
    const withParams = ToolRegisterParams.parse({
      name: "echo", description: "Echo the input back",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    expect(withParams.parameters).toMatchObject({ type: "object" });
    expect(() => ToolRegisterParams.parse({ name: "", description: "x" })).toThrow();
    expect(() => ToolRegisterParams.parse({ name: "echo", description: "" })).toThrow();
    expect(ToolRegisterResult.parse({ ok: true, registeredAs: "plugin__sample-echo__echo" }).registeredAs)
      .toBe("plugin__sample-echo__echo");
    expect(() => ToolRegisterResult.parse({ ok: true, registeredAs: "" })).toThrow();
  });

  test("tool.register name charset (final-review Fix 3): alphanumeric + single -/_ separators only — no __, no leading/trailing _, no other punctuation", () => {
    for (const ok of ["echo", "read-file", "read_file", "a1-b2_c3", "UPPER", "123"]) {
      expect(ToolRegisterParams.parse({ name: ok, description: "d" }).name).toBe(ok);
    }
    for (const bad of ["read__file", "_leading", "trailing_", "__", "has space", "has.dot", "has/slash", "emoji🎉"]) {
      expect(() => ToolRegisterParams.parse({ name: bad, description: "d" })).toThrow();
    }
  });

  test("shortcut.register params/result: description/default optional, id required", () => {
    const p = ShortcutRegisterParams.parse({
      shortcuts: [{ id: "toggle-limiter" }, { id: "boost", description: "Boost charging", default: "cmd+shift+b" }],
    });
    expect(p.shortcuts).toHaveLength(2);
    expect(p.shortcuts[0]!.description).toBeUndefined();
    expect(p.shortcuts[1]!.default).toBe("cmd+shift+b");
    expect(() => ShortcutRegisterParams.parse({ shortcuts: [{ id: "" }] })).toThrow();
    expect(ShortcutRegisterResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("tile.update params/result: tile is an opaque record", () => {
    const p = TileUpdateParams.parse({ tile: { title: "Charge Limit", value: "80%", progress: 0.8 } });
    expect(p.tile).toMatchObject({ title: "Charge Limit" });
    expect(TileUpdateResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("provider.register params/result: reserved-minimal, info is an opaque record", () => {
    const p = ProviderRegisterParams.parse({ info: { id: "local-models", model: "llama-3" } });
    expect(p.info).toMatchObject({ id: "local-models" });
    expect(ProviderRegisterResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("plugin.toolResult params/result: mirrors peripheral.respond's shape minus alreadyResolved", () => {
    expect(PluginToolResultParams.parse({ requestId: "req_1", resultJson: "{\"echo\":\"hi\"}" }).requestId).toBe("req_1");
    expect(PluginToolResultParams.parse({ requestId: "req_1", error: "plugin sample-echo crashed during echo" }).error)
      .toBe("plugin sample-echo crashed during echo");
    expect(() => PluginToolResultParams.parse({ requestId: "" })).toThrow();
    expect(PluginToolResultResult.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe("plugins.contrib (Phase 4d Task 1, spec §6/§7 — read surface for PluginContribRegistry, NOT a plugin-role verb)", () => {
  test("METHODS carries it", () => {
    expect(METHODS.pluginsContrib).toBe("plugins.contrib");
  });

  test("PluginsContribParams is empty; PluginsContribResult wraps an array of entries", () => {
    expect(PluginsContribParams.parse({})).toEqual({});
    const r = PluginsContribResult.parse({
      ok: true,
      entries: [{ pluginId: "sample-echo", tile: { title: "Sample", value: "1" } }],
    });
    expect(r.entries).toHaveLength(1);
  });

  test("PluginContribEntrySchema: pluginId required, shortcuts/tile/provider all optional", () => {
    const bare = PluginContribEntrySchema.parse({ pluginId: "sample-echo" });
    expect(bare.shortcuts).toBeUndefined();
    expect(bare.tile).toBeUndefined();
    expect(bare.provider).toBeUndefined();

    const full = PluginContribEntrySchema.parse({
      pluginId: "sample-echo",
      shortcuts: [{ id: "toggle", description: "toggle it" }],
      tile: { title: "Sample", value: "1" },
      provider: { kind: "noop" },
    });
    expect(full.shortcuts).toEqual([{ id: "toggle", description: "toggle it" }]);
    expect(full.tile).toEqual({ title: "Sample", value: "1" });
    expect(full.provider).toEqual({ kind: "noop" });

    expect(() => PluginContribEntrySchema.parse({})).toThrow(); // pluginId required
    // shortcuts reuses ShortcutRegisterParams's own field schema — an empty id is still rejected.
    expect(() => PluginContribEntrySchema.parse({ pluginId: "p1", shortcuts: [{ id: "" }] })).toThrow();
  });
});

describe("plugin.revokeToken (Phase 4b Task 2, spec §3 — harness-role admin verb, NOT one of the six plugin verbs)", () => {
  test("METHODS carries it; params require a non-empty pluginId; result is a plain ok", () => {
    expect(METHODS.pluginRevokeToken).toBe("plugin.revokeToken");
    expect(PluginRevokeTokenParams.parse({ pluginId: "sample-echo" }).pluginId).toBe("sample-echo");
    expect(() => PluginRevokeTokenParams.parse({ pluginId: "" })).toThrow();
    expect(() => PluginRevokeTokenParams.parse({})).toThrow();
    expect(PluginRevokeTokenResult.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe("plugin.restart (final-review Fix 1 — restart rider, recovers a circuit-open plugin; harness/admin role like plugins.list, NOT one of the six plugin verbs)", () => {
  test("METHODS carries it; params require a non-empty pluginId; result is a plain ok", () => {
    expect(METHODS.pluginRestart).toBe("plugin.restart");
    expect(PluginRestartParams.parse({ pluginId: "sample-echo" }).pluginId).toBe("sample-echo");
    expect(() => PluginRestartParams.parse({ pluginId: "" })).toThrow();
    expect(() => PluginRestartParams.parse({})).toThrow();
    expect(PluginRestartResult.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe("hardware.request / hardware.respond (Phase 4c Task 1, spec §5)", () => {
  test("METHODS carries both verbs", () => {
    expect(METHODS.hardwareRequest).toBe("hardware.request");
    expect(METHODS.hardwareRespond).toBe("hardware.respond");
  });

  test("hardware.request params: verb required, argsJson optional", () => {
    expect(HardwareRequestParams.parse({ verb: "setChargeLimit", argsJson: '{"percent":80}' }).verb).toBe("setChargeLimit");
    const bare = HardwareRequestParams.parse({ verb: "getChargeLimit" });
    expect(bare.argsJson).toBeUndefined();
    expect(() => HardwareRequestParams.parse({ verb: "" })).toThrow();
    expect(() => HardwareRequestParams.parse({})).toThrow();
  });

  // Task 2 review pin (binding): widened from a bare {resultJson} object to a success|error-code
  // union mirroring PeripheralLeaseResult — see methods.ts's HardwareRequestResult doc comment.
  test("hardware.request result: success|unknown_verb|consent_denied|no_provider|timeout|provider_error union", () => {
    const success = HardwareRequestResult.parse({ resultJson: "{\"percent\":80}" });
    expect("resultJson" in success && success.resultJson).toBe("{\"percent\":80}");
    expect(() => HardwareRequestResult.parse({})).toThrow();

    expect(HardwareRequestResult.parse({ code: "unknown_verb" })).toEqual({ code: "unknown_verb" });

    expect(HardwareRequestResult.parse({ code: "consent_denied" })).toEqual({ code: "consent_denied" });
    expect(HardwareRequestResult.parse({ code: "consent_denied", missing: "battery" })).toEqual({
      code: "consent_denied", missing: "battery",
    });

    expect(HardwareRequestResult.parse({ code: "no_provider", message: "hardware features require Norma.app" })).toEqual({
      code: "no_provider", message: "hardware features require Norma.app",
    });
    expect(() => HardwareRequestResult.parse({ code: "no_provider" })).toThrow(); // message is required

    expect(HardwareRequestResult.parse({ code: "timeout" })).toEqual({ code: "timeout" });

    expect(HardwareRequestResult.parse({ code: "provider_error", message: "unsupported_value" })).toEqual({
      code: "provider_error", message: "unsupported_value",
    });
    expect(() => HardwareRequestResult.parse({ code: "provider_error" })).toThrow(); // message is required

    expect(() => HardwareRequestResult.parse({ code: "bogus" })).toThrow();
  });

  test("hardware.respond params/result: mirrors peripheral.respond's shape minus alreadyResolved, same precedent as plugin.toolResult", () => {
    expect(HardwareRespondParams.parse({ requestId: "req_1", resultJson: "{\"percent\":80}" }).requestId).toBe("req_1");
    expect(HardwareRespondParams.parse({ requestId: "req_1", error: "unsupported_value" }).error).toBe("unsupported_value");
    expect(() => HardwareRespondParams.parse({ requestId: "" })).toThrow();
    expect(HardwareRespondResult.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe("shortcut.invoke / tile.action (Phase 4d Task 2, spec §6/§7 — harness→plugin push)", () => {
  test("METHODS carries both verbs", () => {
    expect(METHODS.shortcutInvoke).toBe("shortcut.invoke");
    expect(METHODS.tileAction).toBe("tile.action");
  });

  test("shortcut.invoke params: pluginId + shortcutId both required non-empty", () => {
    expect(ShortcutInvokeParams.parse({ pluginId: "p1", shortcutId: "do-thing" })).toEqual({ pluginId: "p1", shortcutId: "do-thing" });
    expect(() => ShortcutInvokeParams.parse({ pluginId: "", shortcutId: "do-thing" })).toThrow();
    expect(() => ShortcutInvokeParams.parse({ pluginId: "p1", shortcutId: "" })).toThrow();
    expect(() => ShortcutInvokeParams.parse({ pluginId: "p1" })).toThrow();
  });

  test("tile.action params: pluginId + actionId both required non-empty", () => {
    expect(TileActionParams.parse({ pluginId: "p1", actionId: "reconnect" })).toEqual({ pluginId: "p1", actionId: "reconnect" });
    expect(() => TileActionParams.parse({ pluginId: "", actionId: "reconnect" })).toThrow();
    expect(() => TileActionParams.parse({ pluginId: "p1", actionId: "" })).toThrow();
    expect(() => TileActionParams.parse({ pluginId: "p1" })).toThrow();
  });

  // Shared result union (methods.ts's PluginPushResult) — mirrors HardwareRequestResult's style:
  // success carries no payload (the push either lands or it doesn't), failure is a typed code.
  test("shortcut.invoke / tile.action result: ok | not_connected | unknown_plugin union", () => {
    expect(ShortcutInvokeResult.parse({ ok: true })).toEqual({ ok: true });
    expect(ShortcutInvokeResult.parse({ code: "not_connected" })).toEqual({ code: "not_connected" });
    expect(ShortcutInvokeResult.parse({ code: "unknown_plugin" })).toEqual({ code: "unknown_plugin" });
    expect(() => ShortcutInvokeResult.parse({ code: "bogus" })).toThrow();
    expect(() => ShortcutInvokeResult.parse({})).toThrow();

    expect(TileActionResult.parse({ ok: true })).toEqual({ ok: true });
    expect(TileActionResult.parse({ code: "not_connected" })).toEqual({ code: "not_connected" });
    expect(TileActionResult.parse({ code: "unknown_plugin" })).toEqual({ code: "unknown_plugin" });
  });
});

describe("routines RPCs (Phase 5 routines T3, design doc §3)", () => {
  const routine = {
    id: "r_abc123456789", spec: "every 30m", prompt: "check inbox", policy: "auto" as const,
    cwd: "/tmp/proj", enabled: true, lastRunAt: null, nextRunAt: 1700000000000,
    createdAt: 1699999999000, lastResult: null, deferAttempts: 0,
  };

  test("METHODS carries all four verbs", () => {
    expect(METHODS.routinesCreate).toBe("routines.create");
    expect(METHODS.routinesList).toBe("routines.list");
    expect(METHODS.routinesUpdate).toBe("routines.update");
    expect(METHODS.routinesDelete).toBe("routines.delete");
  });

  test("RoutineSchema mirrors the store's Routine shape and rejects policy \"ask\"", () => {
    expect(RoutineSchema.parse(routine)).toEqual(routine);
    expect(() => RoutineSchema.parse({ ...routine, policy: "ask" })).toThrow();
  });

  test("routines.create params: spec + prompt required; policy/cwd optional; policy \"ask\" rejected at the wire schema", () => {
    const p = RoutinesCreateParams.parse({ spec: "every 30m", prompt: "check inbox" });
    expect(p.policy).toBeUndefined();
    expect(p.cwd).toBeUndefined();
    expect(RoutinesCreateParams.parse({ spec: "every 30m", prompt: "x", policy: "plan", cwd: "/tmp/proj" }).policy).toBe("plan");
    expect(() => RoutinesCreateParams.parse({ spec: "every 30m", prompt: "x", policy: "ask" })).toThrow();
    expect(() => RoutinesCreateParams.parse({ spec: "", prompt: "x" })).toThrow();
    expect(() => RoutinesCreateParams.parse({ spec: "every 30m", prompt: "" })).toThrow();
    expect(() => RoutinesCreateParams.parse({ spec: "every 30m", prompt: "x", cwd: "relative/path" })).toThrow();
  });

  test("routines.create result: {routine}", () => {
    expect(RoutinesCreateResult.parse({ routine })).toEqual({ routine });
  });

  test("routines.list params/result", () => {
    expect(RoutinesListParams.parse({})).toEqual({});
    expect(RoutinesListResult.parse({ routines: [routine] })).toEqual({ routines: [routine] });
    expect(RoutinesListResult.parse({ routines: [] })).toEqual({ routines: [] });
  });

  test("routines.update params: patch is enabled?/spec?/prompt?/policy? only (no cwd — narrower than the store's own patch shape)", () => {
    const p = RoutinesUpdateParams.parse({ id: "r_1", patch: { enabled: false } });
    expect(p.patch).toEqual({ enabled: false });
    expect(RoutinesUpdateParams.parse({ id: "r_1", patch: {} }).patch).toEqual({});
    expect(RoutinesUpdateParams.parse({ id: "r_1", patch: { spec: "every 1h", prompt: "new prompt", policy: "plan", enabled: true } }).patch)
      .toEqual({ spec: "every 1h", prompt: "new prompt", policy: "plan", enabled: true });
    expect(() => RoutinesUpdateParams.parse({ id: "r_1", patch: { policy: "ask" } })).toThrow();
    expect(() => RoutinesUpdateParams.parse({ id: "", patch: {} })).toThrow();
    // cwd is not part of the wire patch shape — an extra key is silently stripped (zod default),
    // not rejected, matching every other z.object() schema in this file.
    expect((RoutinesUpdateParams.parse({ id: "r_1", patch: { cwd: "/tmp/x" } }).patch as Record<string, unknown>).cwd).toBeUndefined();
  });

  test("routines.update result: {routine}", () => {
    expect(RoutinesUpdateResult.parse({ routine })).toEqual({ routine });
  });

  test("routines.delete params/result", () => {
    expect(RoutinesDeleteParams.parse({ id: "r_1" })).toEqual({ id: "r_1" });
    expect(() => RoutinesDeleteParams.parse({ id: "" })).toThrow();
    expect(RoutinesDeleteResult.parse({ ok: true, removed: true })).toEqual({ ok: true, removed: true });
    expect(RoutinesDeleteResult.parse({ ok: true, removed: false })).toEqual({ ok: true, removed: false });
  });
});

describe("memory RPCs (Phase 5b Task 3, design doc §4)", () => {
  const factMeta = { name: "coffee-pref", description: "Likes oat milk lattes", type: "user" as const };
  const fact = { ...factMeta, body: "User prefers oat milk lattes over regular." };
  const auditLine = { ts: 1700000000000, source: "rpc" as const, scope: "user" as const, action: "write" as const, name: "coffee-pref" };

  test("METHODS carries all five verbs", () => {
    expect(METHODS.memoryList).toBe("memory.list");
    expect(METHODS.memoryRead).toBe("memory.read");
    expect(METHODS.memoryWrite).toBe("memory.write");
    expect(METHODS.memoryDelete).toBe("memory.delete");
    expect(METHODS.memoryAudit).toBe("memory.audit");
  });

  test("MemoryFactMetaSchema/MemoryFactSchema mirror the store's shapes", () => {
    expect(MemoryFactMetaSchema.parse(factMeta)).toEqual(factMeta);
    expect(MemoryFactSchema.parse(fact)).toEqual(fact);
    expect(() => MemoryFactMetaSchema.parse({ ...factMeta, type: "bogus" })).toThrow();
  });

  test("MemoryAuditLineSchema: sessionId/description optional, omitted when absent", () => {
    expect(MemoryAuditLineSchema.parse(auditLine)).toEqual(auditLine);
    const full = { ...auditLine, sessionId: "s_1", description: "d", action: "delete" as const };
    expect(MemoryAuditLineSchema.parse(full)).toEqual(full);
    expect(() => MemoryAuditLineSchema.parse({ ...auditLine, source: "bogus" })).toThrow();
  });

  test("memory.list params require scope, cwd optional + absolute", () => {
    expect(MemoryListParams.parse({ scope: "user" })).toEqual({ scope: "user" });
    expect(MemoryListParams.parse({ scope: "project", cwd: "/tmp/proj" })).toEqual({ scope: "project", cwd: "/tmp/proj" });
    expect(() => MemoryListParams.parse({})).toThrow();
    expect(() => MemoryListParams.parse({ scope: "user", cwd: "relative/path" })).toThrow();
    expect(MemoryListResult.parse({ facts: [factMeta] })).toEqual({ facts: [factMeta] });
    expect(MemoryListResult.parse({ facts: [] })).toEqual({ facts: [] });
  });

  test("memory.read params require scope + name; result is {fact}", () => {
    expect(MemoryReadParams.parse({ scope: "user", name: "x" })).toEqual({ scope: "user", name: "x" });
    expect(() => MemoryReadParams.parse({ scope: "user", name: "" })).toThrow();
    expect(MemoryReadResult.parse({ fact })).toEqual({ fact });
  });

  test("memory.write params: type defaults to 'user' when omitted; result is empty", () => {
    const p = MemoryWriteParams.parse({ scope: "user", name: "x", description: "d", body: "b" });
    expect(p.type).toBe("user");
    expect(MemoryWriteParams.parse({ scope: "user", name: "x", description: "d", body: "b", type: "reference" }).type).toBe("reference");
    expect(() => MemoryWriteParams.parse({ scope: "user", name: "x", description: "d", body: "" })).toThrow();
    expect(MemoryWriteResult.parse({})).toEqual({});
  });

  test("memory.delete params/result", () => {
    expect(MemoryDeleteParams.parse({ scope: "project", name: "x", cwd: "/tmp/proj" })).toEqual({ scope: "project", name: "x", cwd: "/tmp/proj" });
    expect(MemoryDeleteResult.parse({})).toEqual({});
  });

  test("memory.audit params: limit optional nonnegative; result is {lines}", () => {
    expect(MemoryAuditParams.parse({})).toEqual({});
    expect(MemoryAuditParams.parse({ limit: 10 }).limit).toBe(10);
    expect(() => MemoryAuditParams.parse({ limit: -1 })).toThrow();
    expect(MemoryAuditResult.parse({ lines: [auditLine] })).toEqual({ lines: [auditLine] });
    expect(MemoryAuditResult.parse({ lines: [] })).toEqual({ lines: [] });
  });
});

describe("ApprovalPolicy — 6 modes (SP-policies)", () => {
  test("all six parse", () => {
    for (const p of ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] as const) {
      expect(ApprovalPolicy.parse(p)).toBe(p);
    }
  });
  test("unknown mode rejected", () => {
    expect(() => ApprovalPolicy.parse("yolo")).toThrow();
  });
  test("default is ask", () => {
    expect(ApprovalPolicy.default("ask").parse(undefined)).toBe("ask");
  });
});

describe("workflow RPCs (CC-parity phase 3, Track C Task C2)", () => {
  const runView = {
    runId: "wf_abc123", sessionId: "s_1", name: "nightly", status: "running" as const,
    counts: { running: 1, completed: 2, total: 3 }, phase: "triage", startedAt: 1700000000000,
  };

  test("METHODS carries all four verbs", () => {
    expect(METHODS.workflowList).toBe("workflow.list");
    expect(METHODS.workflowRun).toBe("workflow.run");
    expect(METHODS.workflowStop).toBe("workflow.stop");
    expect(METHODS.workflowGet).toBe("workflow.get");
  });

  test("WorkflowRunViewSchema mirrors WorkflowRunView (workflows/types.ts) field-for-field; rejects a bogus status", () => {
    expect(WorkflowRunViewSchema.parse(runView)).toEqual(runView);
    const terminal = { ...runView, status: "completed" as const, result: "done" };
    expect(WorkflowRunViewSchema.parse(terminal)).toEqual(terminal);
    const failed = { ...runView, status: "failed" as const, error: "boom" };
    expect(WorkflowRunViewSchema.parse(failed)).toEqual(failed);
    expect(() => WorkflowRunViewSchema.parse({ ...runView, status: "bogus" })).toThrow();
    // name/phase/result/error all optional — a bare minimal view still parses.
    const minimal = { runId: "wf_x", sessionId: "s_1", status: "running" as const, counts: { running: 0, completed: 0, total: 0 }, startedAt: 0 };
    expect(WorkflowRunViewSchema.parse(minimal)).toEqual(minimal);
  });

  test("WorkflowSavedSchema: name/description/source, all required strings", () => {
    const saved = { name: "nightly", description: "nightly sweep", source: "user" };
    expect(WorkflowSavedSchema.parse(saved)).toEqual(saved);
    expect(() => WorkflowSavedSchema.parse({ name: "nightly", source: "user" })).toThrow();
  });

  test("workflow.list params: sessionId required, cwd optional; result is {running, saved}", () => {
    expect(WorkflowListParams.parse({ sessionId: "s_1" })).toEqual({ sessionId: "s_1" });
    expect(WorkflowListParams.parse({ sessionId: "s_1", cwd: "/tmp/proj" })).toEqual({ sessionId: "s_1", cwd: "/tmp/proj" });
    expect(() => WorkflowListParams.parse({})).toThrow();
    expect(() => WorkflowListParams.parse({ sessionId: "" })).toThrow();
    const saved = { name: "nightly", description: "nightly sweep", source: "user" };
    expect(WorkflowListResult.parse({ running: [runView], saved: [saved] })).toEqual({ running: [runView], saved: [saved] });
    expect(WorkflowListResult.parse({ running: [], saved: [] })).toEqual({ running: [], saved: [] });
  });

  test("workflow.run params: sessionId required; name/script/args all optional (exactly-one-of is handler-enforced, not the wire schema); result is {runId, status:'running'}", () => {
    expect(WorkflowRunParams.parse({ sessionId: "s_1" })).toEqual({ sessionId: "s_1" });
    expect(WorkflowRunParams.parse({ sessionId: "s_1", name: "nightly" })).toEqual({ sessionId: "s_1", name: "nightly" });
    expect(WorkflowRunParams.parse({ sessionId: "s_1", script: "return 1;" })).toEqual({ sessionId: "s_1", script: "return 1;" });
    expect(WorkflowRunParams.parse({ sessionId: "s_1", script: "return 1;", args: { seed: 1 } }).args).toEqual({ seed: 1 });
    expect(() => WorkflowRunParams.parse({})).toThrow();
    expect(() => WorkflowRunParams.parse({ sessionId: "" })).toThrow();
    expect(WorkflowRunResult.parse({ runId: "wf_1", status: "running" })).toEqual({ runId: "wf_1", status: "running" });
    expect(() => WorkflowRunResult.parse({ runId: "wf_1", status: "completed" })).toThrow();
  });

  test("workflow.stop params/result: runId required; result is {ok:true, stopped}", () => {
    expect(WorkflowStopParams.parse({ runId: "wf_1" })).toEqual({ runId: "wf_1" });
    expect(() => WorkflowStopParams.parse({ runId: "" })).toThrow();
    expect(() => WorkflowStopParams.parse({})).toThrow();
    expect(WorkflowStopResult.parse({ ok: true, stopped: true })).toEqual({ ok: true, stopped: true });
    expect(WorkflowStopResult.parse({ ok: true, stopped: false })).toEqual({ ok: true, stopped: false });
  });

  test("workflow.get params/result: runId required; result is {run: WorkflowRunView}", () => {
    expect(WorkflowGetParams.parse({ runId: "wf_1" })).toEqual({ runId: "wf_1" });
    expect(() => WorkflowGetParams.parse({})).toThrow();
    expect(WorkflowGetResult.parse({ run: runView })).toEqual({ run: runView });
  });
});

// ------------------------------------------------------------------------------------------------
// sync.config — the phone's bootstrap bundle, widened by provider-correctness T3 with the daemon's
// model catalogue and its live reasoning effort.
//
// Before T3 the wire carried ONE model string and the phone DERIVED a lineup from it (split on the
// last `-`, read the tail as a tier, synthesize the siblings by concatenation) while its effort
// control was a UI mock that had drifted to offering `ultra` — a level the backend rejects
// outright. Neither could be proved right by the side doing the guessing. Both are now served by
// the side that already validates them.
// ------------------------------------------------------------------------------------------------
describe("sync.config schema (provider-correctness T3)", () => {
  const full = {
    provider: "codex-oauth",
    exaKey: null,
    dangerousDomains: [],
    defaultModel: "gpt-5.6-sol",
    models: [{ id: "gpt-5.6-sol", efforts: ["none", "low", "medium", "high", "xhigh", "max"] }],
    defaultEffort: "high",
    clientEfforts: ["ultra"],
  };

  test("sync.config params are empty; the result carries the catalogue and the effort", () => {
    expect(SyncConfigParams.parse({})).toEqual({});
    expect(SyncConfigResult.parse(full)).toEqual(full);
    expect(METHODS.syncConfig).toBe("sync.config");
  });

  test("models/defaultEffort are REQUIRED on the wire — the daemon always states them", () => {
    // The daemon is never allowed to stay silent about the catalogue: `[]` and `""` are how it says
    // "there is none", and that is a statement a client can act on. An OMITTED field would be
    // indistinguishable from a serialization bug, so the schema refuses it.
    const { models, ...noModels } = full;
    const { defaultEffort, ...noEffort } = full;
    expect(() => SyncConfigResult.parse(noModels)).toThrow();
    expect(() => SyncConfigResult.parse(noEffort)).toThrow();
  });

  test("an empty catalogue and an unset effort are VALID — that is the never-synced answer", () => {
    // A provider that cannot enumerate its models (an arbitrary openai-compatible endpoint), or no
    // provider at all. The client waits; it does not derive a lineup from `defaultModel`. A guessed
    // fallback is what produced a 400-on-first-turn on a freshly-paired phone once already.
    expect(SyncConfigResult.parse({ ...full, models: [], defaultEffort: "" })).toEqual({
      ...full, models: [], defaultEffort: "",
    });
  });

  test("a catalogue row needs a non-empty id AND an efforts array — no half rows", () => {
    expect(SyncConfigModel.parse({ id: "m", efforts: ["low"] })).toEqual({ id: "m", efforts: ["low"] });
    expect(SyncConfigModel.parse({ id: "m", efforts: [] })).toEqual({ id: "m", efforts: [] });
    expect(() => SyncConfigModel.parse({ id: "", efforts: ["low"] })).toThrow();
    expect(() => SyncConfigModel.parse({ id: "m" })).toThrow();
    expect(() => SyncConfigModel.parse({ efforts: ["low"] })).toThrow();
    // An empty-string effort would reach a request body verbatim and 400 the turn.
    expect(() => SyncConfigModel.parse({ id: "m", efforts: [""] })).toThrow();
    // One bad row poisons the whole result rather than being silently dropped.
    expect(() => SyncConfigResult.parse({ ...full, models: [{ id: "", efforts: [] }] })).toThrow();
  });

  // provider-correctness T5 — `clientEfforts`: NORMA-LEVEL tiers, a SEPARATE field from
  // `models[].efforts` and never merged into it. `models[].efforts` is exactly what the endpoint's
  // request validator accepts; a client tier is exactly what it does NOT (the daemon translates it
  // before building a request). Merging them would make the daemon advertise a value its own turn
  // would 400 on — the original bug, reintroduced through the field that was added to fix it.
  test("clientEfforts is REQUIRED — a daemon that offers no tiers says `[]`, it never stays silent", () => {
    const { clientEfforts, ...noClientEfforts } = full;
    expect(() => SyncConfigResult.parse(noClientEfforts)).toThrow();
    // The same sentinel discipline as `models: []` / `defaultEffort: ""`: an explicit empty is a
    // statement ("this daemon offers no Norma-level tiers"), which is what lets an older/newer
    // pairing degrade to daemon-driven pickers instead of a client-side guess.
    expect(SyncConfigResult.parse({ ...full, clientEfforts: [] }).clientEfforts).toEqual([]);
  });

  test("a client tier must be a non-empty string, like every other level on this wire", () => {
    // Same reason as inside a catalogue row: an empty string would reach a picker as a selectable
    // level and, if anything ever put it on the wire, come back an opaque 400.
    expect(() => SyncConfigResult.parse({ ...full, clientEfforts: [""] })).toThrow();
    expect(() => SyncConfigResult.parse({ ...full, clientEfforts: ["ultra", ""] })).toThrow();
    expect(() => SyncConfigResult.parse({ ...full, clientEfforts: "ultra" })).toThrow();
  });

  // provider-correctness whole-branch review C1 — `provider`: what makes this bundle
  // SELF-DESCRIBING. Every other field says WHAT the Mac runs; without this one nothing says WHOSE.
  // A phone runs its own engine on codex-oauth credentials, so an `openai-compatible` Mac's
  // non-empty foreign `defaultModel` (its `models` is `[]` — that provider cannot enumerate) is a
  // 400 on the phone's first turn unless the phone can SEE that it came from another provider.
  test("provider is REQUIRED and NON-EMPTY — the one field with no 'I have none' sentinel", () => {
    const { provider, ...noProvider } = full;
    expect(() => SyncConfigResult.parse(noProvider)).toThrow();
    // `""` is how `defaultEffort` says "unset" and `[]` is how `models` says "none". There is no
    // such state here: a daemon always knows which provider it is running, and "no provider
    // configured" is itself a stateable answer (`"none"`), not a silence.
    expect(() => SyncConfigResult.parse({ ...full, provider: "" })).toThrow();
    expect(SyncConfigResult.parse({ ...full, provider: "none" }).provider).toBe("none");
    expect(SyncConfigResult.parse({ ...full, provider: "openai-compatible" }).provider).toBe("openai-compatible");
    // Not an enum on the wire, deliberately: the phone's rule is "not MINE ⇒ never-synced", which
    // is decided by string inequality against its own provider and needs no shared vocabulary. A
    // zod enum here would make a Mac that gains a third provider type fail its phone's whole
    // bootstrap — the Exa key and dangerous-domain list included — instead of degrading it.
    expect(SyncConfigResult.parse({ ...full, provider: "some-future-provider" }).provider).toBe("some-future-provider");
  });

  test("the shape C1 exists for: a BYOK Mac states its provider beside an empty catalogue and a foreign slug", () => {
    // Exactly what an `openai-compatible` daemon serves. `models: []` alone does NOT protect a
    // phone (T6b's "empty catalogue is ignored on apply" governs `models` only); `defaultModel` is
    // still non-empty and still foreign, and only `provider` distinguishes it from a codex Mac's.
    const byok = { ...full, provider: "openai-compatible", defaultModel: "llama-3.3-70b-local", models: [] };
    expect(SyncConfigResult.parse(byok)).toEqual(byok);
    expect(byok.provider).not.toBe("codex-oauth");
  });

  test("efforts ride per model, and rows may legitimately disagree", () => {
    // Uniform today; the schema must not be the thing that stops a divergence from being expressed,
    // because the API demonstrably validates effort per model (`minimal` -> `unsupported_value`
    // naming the slug, a different layer from the global enum that rejects `ultra`).
    const divergent = {
      ...full,
      models: [
        { id: "gpt-5.6-sol", efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-5.7-nano", efforts: ["low", "medium"] },
      ],
    };
    expect(SyncConfigResult.parse(divergent)).toEqual(divergent);
  });

  // ----------------------------------------------------------------------------------------------
  // Whole-branch review C3 — THE MIRROR TRIPWIRE.
  //
  // `sync.config` is mirrored BY HAND into two Swift types that no compiler and no fixture connects
  // to this schema: NormaChatKit's `SyncConfig` (the phone's whole local-chat bootstrap) and
  // NormaKit's `SyncConfigSnapshot` (the Mac pickers' projection). `packages/protocol`'s generated
  // artifacts cover EVENTS only — a method result gets no fixture, so the round-trip test that
  // normally forces a Swift sync never fires for this type. Adding a field here therefore breaks
  // NOTHING anywhere, in either language, and the phone simply never learns about it.
  //
  // This is that missing break. It is a KEY-SET pin, not a behaviour test: the shape of every field
  // is already covered above; what nobody else notices is a field ARRIVING or LEAVING.
  // ----------------------------------------------------------------------------------------------
  test("MIRROR TRIPWIRE — the field set is pinned; changing it means editing two Swift files by hand", () => {
    expect(
      Object.keys(SyncConfigResult.shape).sort(),
      "sync.config's FIELD SET changed. Nothing else in either language will tell you, so update " +
      "BOTH hand-written Swift mirrors in the same commit, then this pin:\n" +
      "  • apple/NormaChatKit/Sources/NormaChatKit/SyncClient.swift  (struct SyncConfig — the phone's " +
      "local-chat bootstrap; its memberwise init takes NO default arguments on purpose, so every " +
      "construction site including both test doubles must be updated)\n" +
      "  • apple/NormaKit/Sources/NormaKit/NormaClient+Methods.swift (struct SyncConfigSnapshot — the " +
      "Mac pickers' projection; widen it only for a field a Mac caller genuinely needs)\n" +
      "…and, at the next kit tag, ../norma-ios's ScriptedSyncDaemon double.",
    ).toEqual([
      "clientEfforts",
      "dangerousDomains",
      "defaultEffort",
      "defaultModel",
      "exaKey",
      "models",
      "provider",
    ]);
  });
});

// diff-tabs Task 7, fix round 1: `PanelTabSchema`'s own doc comment (methods.ts) promises it
// "Mirrors PanelTabState (core/src/panel/store.ts) field-for-field — this IS the fold, verbatim."
// Task 7 broke that promise silently — it added `diffId` to the daemon's own `PanelTabState`/
// `PanelTab` fold but missed this, its documented mirror — because a zod `z.object()` parse SILENTLY
// STRIPS any key not declared in the schema rather than erroring, so nothing failed anywhere: no
// compile error (a field, not a variant — CLAUDE.md's protocol-checklist addendum names exactly this
// failure mode), no runtime throw, just a byte quietly dropped on the floor. This retention pin is
// what makes that class of regression visible: if `diffId` is ever removed from `PanelTabSchema`
// again, `.parse()`'s OUTPUT (not the input object, which zod never consults again) stops carrying
// it, and this test starts failing instead of the mirror silently going stale a second time.
describe("PanelTabSchema (diff-tabs Task 7 fix round 1 — the mirror-staleness pin)", () => {
  test("diffId is a DECLARED field — parse retains it (an undeclared key would be silently stripped)", () => {
    const parsed = PanelTabSchema.parse({ tabId: "t1", kind: "diff", diffId: "abc" });
    expect(parsed.diffId).toBe("abc");
  });
});

// fix-wave 2026-08-14, Item 1: `PanelOpenTabParams`'s `superRefine` gained a second issue —
// `diffId` present with `kind !== "diff"` is now refused, closing the gap three shipped Swift
// comments already claimed was closed (NormaClient+Methods.swift, ShellSessionHost.swift ×2).
describe("PanelOpenTabParams diffId/kind pairing (fix-wave 2026-08-14, Item 1)", () => {
  test('diffId present with kind "web" is refused; kind "diff" with no diffId still parses (the reverse is NOT required)', () => {
    const result = PanelOpenTabParams.safeParse({ sessionId: "s1", kind: "web", diffId: "a".repeat(8) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path).toEqual(["diffId"]);
      expect(result.error.issues[0]?.message).toBe("a non-diff tab's diffId must be unset");
    }
    // An id-less diff tab is a supported render state (PanelDiffTabModel's unavailable-by-
    // inspection branch) — the params schema must not start requiring diffId on kind "diff".
    expect(PanelOpenTabParams.safeParse({ sessionId: "s1", kind: "diff" }).success).toBe(true);
  });
});
