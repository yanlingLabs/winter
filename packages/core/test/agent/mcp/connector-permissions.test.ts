// WS-26 — connector permissions: the pure resolver and matrix, then every cell of the matrix through the
// REAL PreToolUse hook (`sessionHooksFor`) and the REAL approval bridge (`canUseToolFor`), with the child's
// own evaluation order modelled from the pinned runtime (see `childDecides`).
import { describe, expect, test } from "bun:test";
import type { CanUseTool, HookCallback, HookCallbackMatcher, PermissionResult } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../../src/agent/approvals";
import { QuestionBroker } from "../../../src/agent/questions";
import { PermissionGate, type SessionApprovalPolicy } from "../../../src/agent/gate";
import { canUseToolFor, type BridgeLogger } from "../../../src/runtime-sdk/approval-bridge";
import { sessionHooksFor } from "../../../src/runtime-sdk/hooks";
import { McpManager } from "../../../src/agent/mcp/manager";
import type { TrustStore } from "../../../src/agent/trust";
import {
  connectorCandidates, connectorFactsFor, connectorSettingFor, connectorVerdict, isConnectorToolName, normalizeConnectorTable,
  parseConnectorToolName, sdkRulesFor, type ConnectorPermission, type ConnectorPermissionSource, type ConnectorPermissionTable,
} from "../../../src/agent/mcp/connector-permissions";
import { Settings, connectorPermissionTable, setConnectorToolPermission } from "../../../src/settings";
import type { Mode as SessionMode } from "../../../src/agent/tools/registry";

const silent: BridgeLogger = { info: () => {}, error: () => {} };

describe("the connector predicate", () => {
  test("a user server's tool is a connector action; the daemon's capability tools and built-ins are not", () => {
    expect(parseConnectorToolName("mcp__cf__workers_list")).toEqual({ server: "cf", tool: "workers_list" });
    expect(parseConnectorToolName("mcp__gh__create__issue")).toEqual({ server: "gh", tool: "create__issue" });
    expect(connectorCandidates("mcp__cf__prod__delete_worker")).toEqual([{ server: "cf", tool: "prod__delete_worker" }, { server: "cf__prod", tool: "delete_worker" }]);
    expect(connectorCandidates("mcp__winter__x__y")).toEqual([]);
    for (const name of ["mcp__winter__research__Search", "mcp__winter__external__battery", "mcp__winter__x", "plugin__battery__status", "Bash", "WebFetch", "mcp__", "mcp__cf", "mcp__cf__", "mcp____x"]) {
      expect(isConnectorToolName(name)).toBe(false);
    }
  });
});

describe("the stored table", () => {
  test("a tool's own entry wins over its server's `*`; nothing stored is undefined", () => {
    const t: ConnectorPermissionTable = { cf: { "*": "deny", workers_list: "allow" } };
    expect(connectorSettingFor(t, "cf", "workers_list")).toEqual({ permission: "allow", source: "tool" });
    expect(connectorSettingFor(t, "cf", "d1_delete")).toEqual({ permission: "deny", source: "server" });
    expect(connectorSettingFor(t, "gh", "x")).toBeUndefined();
    expect(connectorSettingFor(t, "toString", "x")).toBeUndefined();
  });

  test("an unrecognised stored value reads as ask; a row that is not an object reads as all-actions ask — never unset, never a crash", () => {
    expect(normalizeConnectorTable({ cf: { a: "Deny", b: 3, c: "allow" }, bad: "deny", arr: [] })).toEqual({ cf: { a: "ask", b: "ask", c: "allow" }, bad: { "*": "ask" }, arr: { "*": "ask" } });
    expect(normalizeConnectorTable(undefined)).toEqual({});
  });

  test("review r1 minor 3: a hand-edited `\"cf\": \"deny\"` row does not reject the settings file, and a write replaces it", () => {
    const parsed = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, mcp: { toolPermissions: { cf: "deny", gh: { x: "allow" } } } });
    expect(connectorPermissionTable(parsed)).toEqual({ cf: { "*": "ask" }, gh: { x: "allow" } });
    expect(connectorPermissionTable(setConnectorToolPermission(parsed, "cf", "x", "deny"))).toEqual({ cf: { x: "deny" }, gh: { x: "allow" } });
  });

  test("setConnectorToolPermission writes, clears to default, and resets a server's actions with `*`", () => {
    const base = { schemaVersion: 3, provider: {} } as unknown as Settings;  // a bare value, as the transform sees it
    let s = setConnectorToolPermission(base, "cf", "workers_list", "allow");
    s = setConnectorToolPermission(s, "cf", "d1_delete", "deny");
    expect(connectorPermissionTable(s)).toEqual({ cf: { workers_list: "allow", d1_delete: "deny" } });
    s = setConnectorToolPermission(s, "cf", "workers_list", undefined);
    expect(connectorPermissionTable(s)).toEqual({ cf: { d1_delete: "deny" } });
    s = setConnectorToolPermission(s, "cf", "*", "ask", { resetTools: true });
    expect(connectorPermissionTable(s)).toEqual({ cf: { "*": "ask" } });
    s = setConnectorToolPermission(s, "cf", "*", undefined);
    expect(s.mcp?.toolPermissions).toBeUndefined();
  });
});

describe("sdk/settings.json rules are matched as the pinned runtime matches them", () => {
  test("exact names and anchored globs; a bare server name is NOT server-wide; `()`/`(*)` are bare", () => {
    const perms = { allow: ["mcp__cf", "mcp__cf__*", "mcp__*"], deny: ["mcp__cf__d1_*"], ask: ["mcp__cf__workers_list()", "mcp__cf__x(foo)"] };
    expect(sdkRulesFor(perms, "mcp__cf__d1_delete")).toEqual([{ behavior: "deny", rule: "mcp__cf__d1_*" }, { behavior: "allow", rule: "mcp__cf__*" }]);
    expect(sdkRulesFor(perms, "mcp__cf__workers_list")).toEqual([{ behavior: "ask", rule: "mcp__cf__workers_list()" }, { behavior: "allow", rule: "mcp__cf__*" }]);
    expect(sdkRulesFor({ allow: ["mcp__cf"] }, "mcp__cf__anything")).toEqual([]);
    expect(sdkRulesFor({ deny: ["mcp__*"] }, "mcp__gh__x")).toEqual([{ behavior: "deny", rule: "mcp__*" }]);
  });
});

// ── The matrix, cell by cell ──────────────────────────────────────────────────────────────────────────

type Outcome = "allow" | "deny" | "card";
type Setting = ConnectorPermission | "unset";
type Cell = { deny: Outcome; allow_ro: Outcome; allow_rw: Outcome; ask_ro: Outcome; ask_rw: Outcome; unset_ro: Outcome; unset_rw: Outcome };
type Session = { label: string; mode: SessionMode; policy: SessionApprovalPolicy; origin?: string };

// THE MATRIX (`connector-permissions.ts`'s header), literally. `_ro`/`_rw`: the server marks the action
// read-only / does not.
const MATRIX: Array<[Session, Cell]> = [
  [{ label: "code plan", mode: "code", policy: "plan" },
    { deny: "deny", allow_ro: "allow", allow_rw: "deny", ask_ro: "card", ask_rw: "deny", unset_ro: "allow", unset_rw: "deny" }],
  [{ label: "code dont-ask", mode: "code", policy: "dont-ask" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "deny", ask_rw: "deny", unset_ro: "allow", unset_rw: "deny" }],
  [{ label: "code ask", mode: "code", policy: "ask" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "card", ask_rw: "card", unset_ro: "allow", unset_rw: "card" }],
  [{ label: "code accept-edits", mode: "code", policy: "accept-edits" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "card", ask_rw: "card", unset_ro: "allow", unset_rw: "card" }],
  [{ label: "code auto", mode: "code", policy: "auto" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "card", ask_rw: "card", unset_ro: "allow", unset_rw: "allow" }],
  [{ label: "code bypass", mode: "code", policy: "bypass" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "card", ask_rw: "card", unset_ro: "allow", unset_rw: "allow" }],
  [{ label: "chat", mode: "chat", policy: "chat" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "card", ask_rw: "card", unset_ro: "allow", unset_rw: "card" }],
  [{ label: "dispatch", mode: "dispatch", policy: "auto" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "card", ask_rw: "card", unset_ro: "allow", unset_rw: "card" }],
  // A dispatch child keeps today's never-prompt rule: "ask" is a typed deny; unset follows its `auto` gate.
  [{ label: "dispatch child", mode: "code", policy: "auto", origin: "dispatch-child" },
    { deny: "deny", allow_ro: "allow", allow_rw: "allow", ask_ro: "deny", ask_rw: "deny", unset_ro: "allow", unset_rw: "allow" }],
];

const TOOL = "mcp__cf__workers_list";

/** A mutable live source, as the daemon's is (settings swapped by the watcher; the probe cache). */
function liveSource(table: ConnectorPermissionTable, readOnly: Record<string, boolean | undefined> = {}): ConnectorPermissionSource & { set(t: ConnectorPermissionTable): void } {
  let current = table;
  return {
    table: () => current,
    readOnly: (server, tool) => readOnly[`${server}/${tool}`],
    set(t) { current = t; },
  };
}

function connectorHookOf(session: Session, source: ConnectorPermissionSource): HookCallback {
  const built = sessionHooksFor({ sessionId: "s_1", roots: ["/tmp"], mode: session.mode, cwd: "/tmp", policy: () => session.policy, connectors: source });
  const unmatched = (built.winter?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === undefined);
  // the plugin group, then the connector floor (no `home`: no path fence)
  expect(unmatched).toHaveLength(2);
  expect((unmatched[1] as { failClosed?: boolean }).failClosed).toBe(true);
  return unmatched[1]!.hooks[0]!;
}

async function hookDecision(hook: HookCallback, toolName: string): Promise<{ decision: string; reason?: string }> {
  const r = await hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {}, session_id: "b", transcript_path: "", cwd: "/tmp" } as never, "tu1", { signal: new AbortController().signal }) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return { decision: r.hookSpecificOutput?.permissionDecision ?? "none", ...(r.hookSpecificOutput?.permissionDecisionReason !== undefined ? { reason: r.hookSpecificOutput.permissionDecisionReason } : {}) };
}

function bridgeOf(session: Session, source: ConnectorPermissionSource | undefined) {
  const events: NewSessionEvent[] = [];
  const approvals = new ApprovalBroker();
  const canUse = canUseToolFor({
    sessionId: "s_1", mode: session.mode, ...(session.origin !== undefined ? { origin: session.origin } : {}), cwd: "/tmp",
    policy: () => session.policy, approvals, questions: new QuestionBroker(), gate: new PermissionGate(),
    emit: (e) => { events.push(e); }, log: silent, now: () => 1_700_000_000_000,
    ...(source !== undefined ? { connectors: source } : {}),
  });
  return { canUse, events, approvals };
}

const ctx = (id = "tu1"): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal, toolUseID: id, requestId: `r-${id}` }) as Parameters<CanUseTool>[2];

/**
 * The child's own order for an MCP call, from the pinned runtime's `evaluateStages`
 * (`@yanlinglabs/winter-agent-runtime` 0.0.31, `dist/index-d4pmmr27.js`): PreToolUse hooks first (a hook
 * deny wins outright), then deny rules, then ask rules / a hook `ask` (`dontAsk` → deny, otherwise the
 * prompt stage = `canUseTool`), then a hook `allow`, then the mode stage (`bypassPermissions` allows; an
 * MCP call is never built-in read-only, so every other mode is "unresolved"), then allow rules, then
 * `dontAsk` → deny, then `canUseTool`. `plan`/`default`/`acceptEdits` reach `canUseTool` for an MCP call
 * (Winter never maps a policy to the runtime's `auto`).
 */
async function childDecides(session: Session, hook: HookCallback, bridge: ReturnType<typeof bridgeOf>, toolName: string, opts: { allowRule?: boolean; id?: string } = {}): Promise<Outcome> {
  const h = await hookDecision(hook, toolName);
  if (h.decision === "deny") return "deny";
  const mode = session.policy === "bypass" ? "bypassPermissions" : session.policy === "dont-ask" ? "dontAsk" : "other";
  const prompt = async (): Promise<Outcome> => {
    const before = bridge.events.length;
    const pending = bridge.canUse(toolName, {}, ctx(opts.id));
    const card = bridge.events.slice(before).find((e) => e.type === "approval_requested");
    if (card !== undefined) {
      bridge.approvals.resolve("s_1", (card as { callId: string }).callId, false, "test");
      await pending;
      return "card";
    }
    const r = (await pending) as PermissionResult;
    return r.behavior === "allow" ? "allow" : "deny";
  };
  if (h.decision === "ask") return mode === "dontAsk" ? "deny" : prompt();
  if (h.decision === "allow") return "allow";
  if (mode === "bypassPermissions") return "allow";
  if (opts.allowRule === true) return "allow";
  if (mode === "dontAsk") return "deny";
  return prompt();
}

describe("the matrix, every cell, through the real hook and the real bridge", () => {
  for (const [session, cell] of MATRIX) {
    for (const [key, expected] of Object.entries(cell) as Array<[keyof Cell, Outcome]>) {
      const [settingRaw, ro] = key.split("_") as [Setting, "ro" | "rw" | undefined];
      test(`${session.label}: ${settingRaw}${ro === undefined ? "" : ` (${ro === "ro" ? "read-only" : "not read-only"})`} → ${expected}`, async () => {
        const readOnly = ro === undefined ? false : ro === "ro";
        const source = liveSource(settingRaw === "unset" ? {} : { cf: { workers_list: settingRaw } }, { "cf/workers_list": readOnly });
        // The pure verdict agrees with the table's shape…
        const verdict = connectorVerdict({ setting: settingRaw === "unset" ? undefined : settingRaw, readOnly, policy: session.policy, mode: session.mode, ...(session.origin !== undefined ? { origin: session.origin } : {}) });
        expect(["allow", "ask", "deny", "gate"]).toContain(verdict);
        // …and the end-to-end outcome is the matrix's.
        const outcome = await childDecides(session, connectorHookOf(session, source), bridgeOf(session, source), TOOL);
        expect(outcome).toBe(expected);
      });
    }
  }
});

describe("the floor holds where the bridge never looks", () => {
  test("a stored deny beats a saved allow rule and bypass (the hook stage runs before both)", async () => {
    for (const session of [{ label: "bypass", mode: "code", policy: "bypass" }, { label: "ask", mode: "code", policy: "ask" }] as Session[]) {
      const source = liveSource({ cf: { "*": "deny" } });
      const hook = connectorHookOf(session, source);
      expect((await hookDecision(hook, TOOL)).decision).toBe("deny");
      expect(await childDecides(session, hook, bridgeOf(session, source), TOOL, { allowRule: true })).toBe("deny");
    }
  });

  test("a stored ask beats a saved allow rule and bypass: the hook forces the prompt, and the bridge cards it", async () => {
    for (const policy of ["bypass", "auto", "ask"] as const) {
      const session: Session = { label: policy, mode: "code", policy };
      const source = liveSource({ cf: { workers_list: "ask" } });
      expect(await childDecides(session, connectorHookOf(session, source), bridgeOf(session, source), TOOL, { allowRule: true })).toBe("card");
    }
  });

  test("the deny reason names the setting (it is what the model reads)", async () => {
    const session: Session = { label: "bypass", mode: "code", policy: "bypass" };
    const r = await hookDecision(connectorHookOf(session, liveSource({ cf: { workers_list: "deny" } })), TOOL);
    expect(r.reason).toContain('"Always deny"');
    expect(r.reason).toContain("workers_list");
  });

  test("a non-connector name gets no opinion from the floor", async () => {
    const session: Session = { label: "bypass", mode: "code", policy: "bypass" };
    const hook = connectorHookOf(session, liveSource({ winter: { "*": "deny" }, cf: { "*": "deny" } }));
    for (const name of ["Bash", "mcp__winter__research__Search", "mcp__winter__external__x"]) {
      expect((await hookDecision(hook, name)).decision).toBe("none");
    }
  });
});

describe("a flip takes effect on the next call — one hook, one bridge, no respawn", () => {
  test("deny → allow → ask → default, in a chat session", async () => {
    const session: Session = { label: "chat", mode: "chat", policy: "chat" };
    const source = liveSource({ cf: { workers_list: "deny" } }, { "cf/workers_list": false });
    const hook = connectorHookOf(session, source);
    const bridge = bridgeOf(session, source);
    expect(await childDecides(session, hook, bridge, TOOL, { id: "a" })).toBe("deny");
    source.set({ cf: { workers_list: "allow" } });
    expect(await childDecides(session, hook, bridge, TOOL, { id: "b" })).toBe("allow");
    source.set({ cf: { workers_list: "ask" } });
    expect(await childDecides(session, hook, bridge, TOOL, { id: "c" })).toBe("card");
    source.set({});
    expect(await childDecides(session, hook, bridge, TOOL, { id: "d" })).toBe("card");
    source.set({ cf: { "*": "deny" } });
    expect(await childDecides(session, hook, bridge, TOOL, { id: "e" })).toBe("deny");
  });

  test("a live session.setPolicy reaches the next call too (the policy is read per call)", async () => {
    const session: Session = { label: "code", mode: "code", policy: "ask" };
    const source = liveSource({ cf: { workers_list: "ask" } });
    const hook = connectorHookOf(session, source);
    const bridge = bridgeOf(session, source);
    expect(await childDecides(session, hook, bridge, TOOL, { id: "a" })).toBe("card");
    session.policy = "dont-ask";
    expect(await childDecides(session, hook, bridge, TOOL, { id: "b" })).toBe("deny");
  });
});

describe("read-only comes from the daemon's own probe", () => {
  const trust = { isTrusted: () => false } as unknown as TrustStore;
  const fakeConnect = (tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>, fail = false) => async () => {
    if (fail) throw new Error("boom");
    return { serverName: "cf", listTools: async () => tools.map((t) => ({ inputSchema: {}, ...t })), close: async () => {} } as never;
  };

  test("readOnlyHint true → allowed unasked in chat; false, missing, unprobed tool or unknown server → a card", async () => {
    const mgr = new McpManager({ trust, stdioCwd: "/tmp", connect: fakeConnect([
      { name: "workers_list", annotations: { readOnlyHint: true } },
      { name: "workers_delete", annotations: { readOnlyHint: false } },
      { name: "kv_put" },
    ]) });
    await mgr.startAll({ cf: { command: "x" } });
    const source: ConnectorPermissionSource = { table: () => ({}), readOnly: (s, t, cwd) => mgr.readOnlyHint(s, t, cwd) };
    const session: Session = { label: "chat", mode: "chat", policy: "chat" };
    const hook = connectorHookOf(session, source);
    const bridge = bridgeOf(session, source);
    expect(await childDecides(session, hook, bridge, "mcp__cf__workers_list", { id: "1" })).toBe("allow");
    expect(await childDecides(session, hook, bridge, "mcp__cf__workers_delete", { id: "2" })).toBe("card");
    expect(await childDecides(session, hook, bridge, "mcp__cf__kv_put", { id: "3" })).toBe("card");
    expect(await childDecides(session, hook, bridge, "mcp__cf__never_listed", { id: "4" })).toBe("card");
    expect(await childDecides(session, hook, bridge, "mcp__unknown__workers_list", { id: "5" })).toBe("card");
    expect(mgr.toolsFor("cf")?.map((t) => [t.name, t.readOnly])).toEqual([["workers_list", true], ["workers_delete", false], ["kv_put", false]]);
  });

  test("a stale listing survives a failed re-probe; disable/remove drops it", async () => {
    let fail = false;
    const mgr = new McpManager({ trust, stdioCwd: "/tmp", connect: async (opts) => fakeConnect([{ name: "workers_list", annotations: { readOnlyHint: true } }], fail)() });
    await mgr.startAll({ cf: { command: "x" } });
    expect(mgr.readOnlyHint("cf", "workers_list")).toBe(true);
    fail = true;
    await mgr.startOneUserServer("cf", { command: "x" });
    expect(mgr.list()[0]?.status).toBe("failed");
    expect(mgr.readOnlyHint("cf", "workers_list")).toBe(true);
    mgr.forgetRemote();
    expect(mgr.readOnlyHint("cf", "workers_list")).toBe(true);
    mgr.stopServer("cf");
    expect(mgr.readOnlyHint("cf", "workers_list")).toBeUndefined();
  });

  test("the probe row mcp.list returns is unchanged in shape (no tools field leaks into it)", async () => {
    const mgr = new McpManager({ trust, stdioCwd: "/tmp", connect: fakeConnect([{ name: "a", annotations: { readOnlyHint: true } }]) });
    await mgr.startAll({ cf: { command: "x" } });
    expect(mgr.list()).toEqual([{ name: "cf", status: "connected", toolNames: ["a"], source: "user" }]);
  });
});

describe("chat and dispatch card connector actions, and only those", () => {
  test("chat: a connector action cards with a plain Allow/Deny card; a non-connector one is still denied, never carded", async () => {
    const session: Session = { label: "chat", mode: "chat", policy: "chat" };
    const bridge = bridgeOf(session, liveSource({}));
    const pending = bridge.canUse(TOOL, { name: "x" }, ctx("c1"));
    const card = bridge.events.find((e) => e.type === "approval_requested") as { toolName: string; options?: unknown; callId: string } | undefined;
    expect(card).toBeDefined();
    expect(card!.toolName).toBe(TOOL);
    expect(card!.options).toBeUndefined();
    bridge.approvals.resolve("s_1", "c1", true, "user");
    expect(((await pending) as PermissionResult).behavior).toBe("allow");
    for (const name of ["Bash", "mcp__winter__external__battery", "plugin__battery__status", "mcp__winter__computer__computer"]) {
      const before = bridge.events.length;
      const r = (await bridge.canUse(name, { command: "ls" }, ctx(`n-${name}`))) as PermissionResult;
      expect(r.behavior).toBe("deny");
      expect(bridge.events.length).toBe(before);
    }
  });

  test("chat without the connector wiring still cards (the gate's own chat answer), never the old refusal", async () => {
    const bridge = bridgeOf({ label: "chat", mode: "chat", policy: "chat" }, undefined);
    const pending = bridge.canUse(TOOL, {}, ctx("c2"));
    expect(bridge.events.some((e) => e.type === "approval_requested")).toBe(true);
    bridge.approvals.resolve("s_1", "c2", false, "user");
    const r = (await pending) as PermissionResult & { message?: string };
    expect(r.behavior).toBe("deny");
    expect(r.message).not.toContain("chat sessions never ask");
  });

  test("dispatch: an unset, not-read-only action cards in the dispatch session and waits for the human", async () => {
    const bridge = bridgeOf({ label: "dispatch", mode: "dispatch", policy: "auto" }, liveSource({}));
    const pending = bridge.canUse(TOOL, {}, ctx("d1"));
    const card = bridge.events.find((e) => e.type === "approval_requested") as { sessionId: string } | undefined;
    expect(card?.sessionId).toBe("s_1");
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    bridge.approvals.resolve("s_1", "d1", true, "phone");
    expect(((await pending) as PermissionResult).behavior).toBe("allow");
  });

  test("a code connector card with a stored value offers no rule (a stored ask outranks a saved allow rule)", async () => {
    const bridge = bridgeOf({ label: "code", mode: "code", policy: "ask" }, liveSource({ cf: { workers_list: "ask" } }));
    const pending = bridge.canUse(TOOL, {}, { ...ctx("k1"), suggestions: [{ type: "addRules", rules: [{ toolName: TOOL }], behavior: "allow", destination: "userSettings" }] } as Parameters<CanUseTool>[2]);
    const card = bridge.events.find((e) => e.type === "approval_requested") as { options?: unknown };
    expect(card.options).toBeUndefined();
    bridge.approvals.resolve("s_1", "k1", false, "user");
    await pending;
  });
});

test("connectorFactsFor reads the table and the probe live, and ignores non-connector names", () => {
  const source = liveSource({ cf: { "*": "ask" } }, { "cf/a": true });
  expect(connectorFactsFor(source, "mcp__cf__a")).toEqual({ server: "cf", tool: "a", setting: "ask", settingSource: "server", readOnly: true });
  expect(connectorFactsFor(source, "mcp__cf__b")).toEqual({ server: "cf", tool: "b", setting: "ask", settingSource: "server", readOnly: false });
  expect(connectorFactsFor(source, "Bash")).toBeUndefined();
});


// ── review r1, CRITICAL 1: a `__` inside a server name ──────────────────────────────────────────────────

describe("a server name containing `__` (every split is weighed)", () => {
  const DEL = "mcp__cf__prod__delete_worker";

  test("a stored deny on cf__prod binds its tool — under bypass, with nothing probed", async () => {
    const session: Session = { label: "bypass", mode: "code", policy: "bypass" };
    const source = liveSource({ cf__prod: { delete_worker: "deny" } });
    expect(connectorFactsFor(source, DEL)).toMatchObject({ server: "cf__prod", tool: "delete_worker", setting: "deny" });
    expect(await childDecides(session, connectorHookOf(session, source), bridgeOf(session, source), DEL, { allowRule: true })).toBe("deny");
    // …and a server-wide deny on cf__prod too.
    expect(connectorFactsFor(liveSource({ cf__prod: { "*": "deny" } }), DEL)?.setting).toBe("deny");
  });

  test("`cf` + `cf__prod` overlap: the strictest wins; an unconfirmed server's blanket allow never allows", () => {
    // cf's "*" deny also covers cf__prod's tools (over-strict at worst, never a silent run).
    expect(connectorFactsFor(liveSource({ cf: { "*": "deny" } }, { "cf__prod/delete_worker": true }), DEL)?.setting).toBe("deny");
    // cf's "*" allow, nothing probed: ambiguous — the allow is not applied (the default decides: toward ask).
    expect(connectorFactsFor(liveSource({ cf: { "*": "allow" } }), DEL)?.setting).toBeUndefined();
    // cf's "*" allow, cf__prod listed and unset: the default outranks the allow.
    const both = connectorFactsFor(liveSource({ cf: { "*": "allow" } }, { "cf__prod/delete_worker": false }), DEL);
    expect(both).toMatchObject({ server: "cf__prod", readOnly: false });
    expect(both?.setting).toBeUndefined();
    // an allow naming the tool exactly counts even unprobed; a deny elsewhere still beats it.
    expect(connectorFactsFor(liveSource({ cf__prod: { delete_worker: "allow" } }), DEL)?.setting).toBe("allow");
    expect(connectorFactsFor(liveSource({ cf__prod: { delete_worker: "allow" }, cf: { prod__delete_worker: "ask" } }), DEL)?.setting).toBe("ask");
  });

  test("read-only only from a candidate whose listing names the tool, and only if every such listing says so", () => {
    expect(connectorFactsFor(liveSource({}, { "cf__prod/delete_worker": true }), DEL)?.readOnly).toBe(true);
    expect(connectorFactsFor(liveSource({}, { "cf__prod/delete_worker": true, "cf/prod__delete_worker": false }), DEL)?.readOnly).toBe(false);
    expect(connectorFactsFor(liveSource({}, {}), DEL)?.readOnly).toBe(false);
  });

  test("a chat session cards an unset cf__prod action and allows it unasked once its listing marks it read-only", async () => {
    const session: Session = { label: "chat", mode: "chat", policy: "chat" };
    const source = liveSource({}, {});
    const hook = connectorHookOf(session, source);
    const bridge = bridgeOf(session, source);
    expect(await childDecides(session, hook, bridge, DEL, { id: "p1" })).toBe("card");
    const ro = liveSource({}, { "cf__prod/delete_worker": true });
    expect(await childDecides(session, connectorHookOf(session, ro), bridgeOf(session, ro), DEL, { id: "p2" })).toBe("allow");
  });
});

describe("re-review: a CONFIGURED but unconfirmed split still votes", () => {
  const DEL = "mcp__cf__prod__delete";
  const withConfigured = (table: ConnectorPermissionTable, ro: Record<string, boolean | undefined>, configured: string[]): ConnectorPermissionSource => ({
    table: () => table, readOnly: (sv, t) => ro[`${sv}/${t}`], configured: (sv) => configured.includes(sv),
  });

  test("cf lists a read-only `prod__delete`, cf__prod is configured but unlisted: NOT read-only (the call may be cf__prod's)", async () => {
    const source = withConfigured({}, { "cf/prod__delete": true }, ["cf", "cf__prod"]);
    expect(connectorFactsFor(source, DEL)).toMatchObject({ readOnly: false });
    expect(connectorFactsFor(source, DEL)?.setting).toBeUndefined();
    const session: Session = { label: "chat", mode: "chat", policy: "chat" };
    expect(await childDecides(session, connectorHookOf(session, source), bridgeOf(session, source), DEL, { id: "c1" })).toBe("card");
  });

  test("cf's `*` allow and a listed `prod__delete`, cf__prod configured and unlisted: the default outranks the allow", () => {
    const source = withConfigured({ cf: { "*": "allow" } }, { "cf/prod__delete": false }, ["cf", "cf__prod"]);
    expect(connectorFactsFor(source, DEL)?.setting).toBeUndefined();
  });

  test("a split configured nowhere is still skipped — an ordinary tool name containing `__` keeps cf's answers", () => {
    const source = withConfigured({ cf: { "*": "allow" } }, { "cf/prod__delete": true }, ["cf"]);
    expect(connectorFactsFor(source, DEL)).toMatchObject({ server: "cf", tool: "prod__delete", setting: "allow", readOnly: true });
  });

  test("a configured server's own blanket allow counts even unlisted", () => {
    const source = withConfigured({ cf__prod: { "*": "allow" } }, {}, ["cf__prod"]);
    expect(connectorFactsFor(source, DEL)?.setting).toBe("allow");
  });
});

// ── review r1, IMPORTANT 2: the bridge never turns a forced prompt into a silent allow ───────────────────

describe("a prompt another layer forced is never answered by a connector allow", () => {
  test("code/ask, an unset read-only action that still reaches canUseTool (an sdk ask rule, a plugin ask) cards", async () => {
    const bridge = bridgeOf({ label: "code", mode: "code", policy: "ask" }, liveSource({}, { "cf/workers_list": true }));
    const pending = bridge.canUse(TOOL, {}, { ...ctx("f1"), matchedAskRule: { source: "userSettings", toolName: TOOL } } as Parameters<CanUseTool>[2]);
    expect(bridge.events.some((e) => e.type === "approval_requested")).toBe(true);
    bridge.approvals.resolve("s_1", "f1", false, "user");
    await pending;
    // …and with no ask rule at all: the gate's own `ask` verdict stands (the hook, not the bridge, allows).
    const again = bridge.canUse(TOOL, {}, ctx("f2"));
    expect(bridge.events.filter((e) => e.type === "approval_requested")).toHaveLength(2);
    bridge.approvals.resolve("s_1", "f2", false, "user");
    await again;
  });

  test("chat: a stored allow that still reaches the bridge cards (the gate's chat answer), never a silent run", async () => {
    const bridge = bridgeOf({ label: "chat", mode: "chat", policy: "chat" }, liveSource({ cf: { workers_list: "allow" } }));
    const pending = bridge.canUse(TOOL, {}, ctx("f3"));
    expect(bridge.events.some((e) => e.type === "approval_requested")).toBe(true);
    bridge.approvals.resolve("s_1", "f3", true, "user");
    expect(((await pending) as PermissionResult).behavior).toBe("allow");
  });
});
