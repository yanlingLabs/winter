import { test, expect, afterEach, jest } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import { ApprovalRequestedEvent, ApprovalResolvedEvent, type NewSessionEvent } from "@norma/protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { PermissionRules } from "../../src/agent/permission-rules";
import {
  canUseToolFor, neverPromptsMessage, approvalOptionsFromSuggestions,
  NO_PARK_TIMEOUT_MS, type BridgeLogger, type CanUseToolDeps,
} from "../../src/runtime-sdk/approval-bridge";
import { gateToolNameFor } from "../../src/runtime-sdk/tool-names";

const SESSION = "sess-1";
const FIXED_NOW = 1_700_000_000_000;
const silent: BridgeLogger = { info: () => {}, error: () => {} };

afterEach(() => { jest.useRealTimers(); });

type Harness = {
  events: NewSessionEvent[];
  approvals: ApprovalBroker;
  questions: QuestionBroker;
  canUse: CanUseTool;
};

function harness(over: Partial<CanUseToolDeps> = {}): Harness {
  const events: NewSessionEvent[] = [];
  const approvals = over.approvals ?? new ApprovalBroker();
  const questions = over.questions ?? new QuestionBroker();
  const canUse = canUseToolFor({
    sessionId: SESSION,
    mode: "code",
    policy: "ask",
    approvals,
    questions,
    gate: new PermissionGate(),
    emit: (e) => { events.push(e); },
    log: silent,
    now: () => FIXED_NOW,
    ...over,
  });
  return { events, approvals, questions, canUse };
}

function requestCtx(over: Record<string, unknown> = {}): Parameters<CanUseTool>[2] & { signal: AbortSignal } {
  const ac = (over.controller as AbortController | undefined) ?? new AbortController();
  return { signal: ac.signal, toolUseID: "tu1", requestId: "req-1", ...over } as Parameters<CanUseTool>[2];
}

/** The keys actually present with a defined value — the engine sets `reviewerReason: undefined` on
 *  this event literal, and an absent key and a present-but-undefined key are the same thing to
 *  every consumer (zod `.optional()`, JSON serialization, the Swift decoder). */
function definedKeys(o: object): string[] {
  return Object.entries(o).filter(([, v]) => v !== undefined).map(([k]) => k).sort();
}

// -------------------------------------------------------------------------------------------
// (a) FIELD PARITY — the emitted card is, name for name, the event `engine.ts:5862` produces for
//     the same tool call. The expected object below is hand-built from that literal
//     (`{ type, sessionId, threadId, callId, toolName, summary, issuedAt, expiresAt,
//        reviewerReason, options }`), NOT from the helpers the bridge itself calls.
// -------------------------------------------------------------------------------------------

test("approval_requested carries exactly the fields the engine emits today", async () => {
  const h = harness({ policy: "ask", mode: "code" });
  const input = { command: "rm -rf x" };
  const pending = h.canUse("Bash", input, requestCtx({
    toolUseID: "tu1", requestId: "r1",
    suggestions: [] as PermissionUpdate[],
  }));

  // The emit is synchronous with the call (wait-before-emit, then park) — no tick needed.
  expect(h.events).toHaveLength(1);
  const ev = h.events[0] as Record<string, unknown>;

  const issuedAt = FIXED_NOW;
  const expiresAt = FIXED_NOW + NO_PARK_TIMEOUT_MS;
  const expected = {
    type: "approval_requested",
    sessionId: SESSION,
    threadId: "main",
    callId: "tu1",
    toolName: "bash",
    summary: "bash rm -rf x",
    issuedAt,
    expiresAt,
    reviewerReason: undefined,          // the engine's literal sets this; the plain ask card omits it
    options: [
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: 'Allow "Bash(rm:*)" in this project', rule: "Bash(rm:*)", scope: "project" },
      { id: "allow_global", label: 'Allow "Bash(rm:*)" everywhere', rule: "Bash(rm:*)", scope: "global" },
      { id: "deny", label: "Deny" },
    ],
  };

  // The FULL field set, not a subset.
  expect(definedKeys(ev)).toEqual(definedKeys(expected));
  expect(ev).toEqual(expected);
  // …and the phone's own schema accepts it (seq/ts are stamped by SessionStore.append).
  expect(ApprovalRequestedEvent.parse({ ...ev, seq: 1, ts: FIXED_NOW })).toBeTruthy();

  h.approvals.resolve(SESSION, "tu1", true, "user");
  await pending;
});

test("a bridge-provided description wins over Norma's composed summary (digest item 46)", async () => {
  const h = harness();
  const pending = h.canUse("Bash", { command: "ls" }, requestCtx({ description: "List the repo root" }));
  expect((h.events[0] as { summary: string }).summary).toBe("List the repo root");
  h.approvals.resolve(SESSION, "tu1", true, "user");
  await pending;
});

test("title/displayName never shadow the composed summary — the human must see the command", async () => {
  const h = harness();
  // `displayName`/`title` are plausibly the TOOL's names, populated on every request; if either won,
  // every card would read "Bash" instead of the command being approved.
  const pending = h.canUse("Bash", { command: "rm -rf x" }, requestCtx({ displayName: "Bash", title: "Bash command" }));
  expect((h.events[0] as { summary: string }).summary).toBe("bash rm -rf x");
  h.approvals.resolve(SESSION, "tu1", true, "user");
  await pending;
});

test("Winter's suggestions become the card's rule options, session-scoped on the way back", async () => {
  const suggestions: PermissionUpdate[] = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status:*" }], behavior: "allow", destination: "projectSettings" },
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status:*" }], behavior: "deny", destination: "userSettings" },
    { type: "setMode", mode: "bypassPermissions", destination: "session" },
  ];
  expect(approvalOptionsFromSuggestions(suggestions)).toEqual([
    { id: "allow_once", label: "Allow once" },
    { id: "allow_project_0", label: 'Allow "Bash(git status:*)" in this project', rule: "Bash(git status:*)", scope: "project" },
    { id: "deny", label: "Deny" },
  ]);
  // A deny/ask suggestion, a setMode and a session/cliArg destination never become options: a card
  // answer must not be able to change the session's mode or write a deny rule.
  expect(approvalOptionsFromSuggestions([{ type: "setMode", mode: "plan", destination: "session" }])).toBeUndefined();
  expect(approvalOptionsFromSuggestions(undefined)).toBeUndefined();
  // A rule Norma's own grammar cannot parse is never offered — choosing it would append inert
  // litter to the user's rules file under a label promising it silences future calls.
  expect(approvalOptionsFromSuggestions([
    { type: "addRules", rules: [{ toolName: "NotARealNormaRuleTool", ruleContent: "x" }], behavior: "allow", destination: "projectSettings" },
  ])).toBeUndefined();
});

// -------------------------------------------------------------------------------------------
// (b) approval.respond RESOLVES a bridged request — and the "remember this" option goes through
//     the EXISTING single writer, never a second one.
// -------------------------------------------------------------------------------------------

test("resolving through the broker settles the pending canUseTool promise", async () => {
  const h = harness();
  const input = { command: "rm -rf x" };
  const pending = h.canUse("Bash", input, requestCtx());
  const res = h.approvals.resolve(SESSION, "tu1", true, "phone", "allow_once");
  expect(res).toEqual({ ok: true, alreadyResolved: false });

  await expect(pending).resolves.toEqual({
    behavior: "allow",
    updatedInput: input,
    decisionClassification: "user_temporary",
  });
  expect(h.events).toHaveLength(2);
  expect(h.events[1]).toEqual({
    type: "approval_resolved", sessionId: SESSION, threadId: "main", callId: "tu1", approved: true, by: "phone",
  });
  expect(ApprovalResolvedEvent.parse({ ...h.events[1], seq: 2, ts: FIXED_NOW })).toBeTruthy();
});

test("a rule-bearing option returns session-scoped updatedPermissions (Winter is never a second writer)", async () => {
  const h = harness();
  const pending = h.canUse("Bash", { command: "git push origin main" }, requestCtx());
  h.approvals.resolve(SESSION, "tu1", true, "phone", "allow_project");
  await expect(pending).resolves.toEqual({
    behavior: "allow",
    updatedInput: { command: "git push origin main" },
    updatedPermissions: [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
      behavior: "allow",
      destination: "session",
    }],
    decisionClassification: "user_permanent",
  });
});

test("the option the card offers is a rule the EXISTING rules store accepts and honours", () => {
  const root = mkdtempSync(join(tmpdir(), "norma-rules-"));
  const home = mkdtempSync(join(tmpdir(), "norma-home-"));
  try {
    const h = harness();
    const input = { command: "git push origin main" };
    void h.canUse("Bash", input, requestCtx());
    const opts = (h.events[0] as { options: { id: string; rule?: string; scope?: "project" | "global" }[] }).options;
    const option = opts.find((o) => o.id === "allow_project")!;
    expect(option.rule).toBe("Bash(git push:*)");

    // The bridge itself writes NOTHING — `ipc/server.ts`'s `approval.respond` handler is the one
    // writer, and it is what runs this append. Proven here by appending the bridge's own rule
    // string through the real store and watching a matching call become allowed.
    const rules = new PermissionRules({ globalAllow: () => [], normaHome: home });
    expect(existsSync(join(root, ".norma"))).toBe(false);
    expect(rules.decision({ name: "bash", argsJson: JSON.stringify(input) }, root)).toBeNull();
    rules.append(option.rule!, option.scope!, root);
    expect(rules.decision({ name: "bash", argsJson: JSON.stringify(input) }, root)).toBe("allow");

    h.approvals.resolve(SESSION, "tu1", false, "cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------
// (c) FAIL-CLOSED
// -------------------------------------------------------------------------------------------

test("an abort mid-approval denies and withdraws the card", async () => {
  const ac = new AbortController();
  const h = harness();
  const pending = h.canUse("Bash", { command: "sleep 1" }, requestCtx({ controller: ac }));
  expect(h.events).toHaveLength(1);

  ac.abort();
  const res = (await pending)!;
  expect(res.behavior).toBe("deny");
  expect((res as { message: string }).message).toContain("the turn was aborted");

  // The withdraw is `approval_resolved{approved:false}` — the ONLY unapproved shape the engine ever
  // emits (`by:"timeout"`, `by:"emit-failure"`); `by` is an open string in the protocol schema.
  expect(h.events).toHaveLength(2);
  expect(h.events[1]).toEqual({
    type: "approval_resolved", sessionId: SESSION, threadId: "main", callId: "tu1", approved: false, by: "aborted",
  });
  expect(h.approvals.list(SESSION)).toEqual([]);
});

test("an already-aborted signal denies with no event and no broker entry", async () => {
  const ac = new AbortController();
  ac.abort();
  const h = harness();
  const res = (await h.canUse("Bash", { command: "x" }, requestCtx({ controller: ac })))!;
  expect(res.behavior).toBe("deny");
  expect(h.events).toEqual([]);
  expect(h.approvals.list(SESSION)).toEqual([]);
});

test("a broker that answers null/undefined denies — never a silent allow", async () => {
  for (const answer of [null, undefined]) {
    const stub = {
      wait: async () => answer,
      resolve: () => ({ ok: true as const, alreadyResolved: false }),
      pendingMeta: () => undefined,
      list: () => [],
    } as unknown as ApprovalBroker;
    const h = harness({ approvals: stub });
    const res = (await h.canUse("Bash", { command: "x" }, requestCtx()))!;
    expect(res.behavior).toBe("deny");
    // …and it says so honestly: nobody refused, the broker simply answered with nothing.
    expect((res as { message: string }).message).toBe("Bash was not run — the approval request could not be completed. Nobody refused it.");
    expect((res as { decisionClassification?: string }).decisionClassification).toBeUndefined();
  }
});

test("an emit failure settles the waiter instead of parking it for 24 days", async () => {
  const approvals = new ApprovalBroker();
  const canUse = canUseToolFor({
    sessionId: SESSION, mode: "code", policy: "ask", approvals,
    questions: new QuestionBroker(), gate: new PermissionGate(),
    emit: () => { throw new Error("disk full"); },
    log: silent, now: () => FIXED_NOW,
  });
  const res = (await canUse("Bash", { command: "x" }, requestCtx()))!;
  expect(res.behavior).toBe("deny");
  expect(approvals.list(SESSION)).toEqual([]);
});

test("a re-request for the same toolUseID supersedes the stale wait rather than orphaning it", async () => {
  const h = harness();
  const first = h.canUse("Bash", { command: "a" }, requestCtx({ requestId: "r1" }));
  expect(h.approvals.list(SESSION)).toHaveLength(1);
  const second = h.canUse("Bash", { command: "a" }, requestCtx({ requestId: "r2" }));

  // The first promise SETTLES (denied) instead of hanging forever behind an overwritten Map entry —
  // and it must NOT tell the model the user refused, which nobody did.
  const firstRes = (await first)!;
  expect(firstRes.behavior).toBe("deny");
  expect((firstRes as { message: string }).message).toContain("Nobody refused it");
  expect((firstRes as { decisionClassification?: string }).decisionClassification).toBeUndefined();
  expect(h.approvals.list(SESSION)).toHaveLength(1);
  h.approvals.resolve(SESSION, "tu1", true, "user");
  await expect(second).resolves.toMatchObject({ behavior: "allow" });
});

// -------------------------------------------------------------------------------------------
// (d) NO PARK TIMEOUT (P8b-19)
// -------------------------------------------------------------------------------------------

test("a pending approval survives 10s of fake time with no deny, and is armed at ~24.8 days", async () => {
  const approvals = new ApprovalBroker();
  const seen: number[] = [];
  const realWait = approvals.wait.bind(approvals);
  approvals.wait = ((sid: string, cid: string, ms: number, meta?: Parameters<typeof realWait>[3]) => {
    seen.push(ms);
    return realWait(sid, cid, ms, meta);
  }) as typeof approvals.wait;

  jest.useFakeTimers();
  const h = harness({ approvals });
  let settled = false;
  const pending = h.canUse("Bash", { command: "x" }, requestCtx()).then((r) => { settled = true; return r; });

  expect(seen).toEqual([NO_PARK_TIMEOUT_MS]);
  expect(NO_PARK_TIMEOUT_MS).toBe(2 ** 31 - 1);

  jest.advanceTimersByTime(10_000);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(h.events).toHaveLength(1);   // still only the request — no timeout resolution

  h.approvals.resolve(SESSION, "tu1", true, "user");
  await expect(pending).resolves.toMatchObject({ behavior: "allow" });
});

// -------------------------------------------------------------------------------------------
// (e) THE SIX POLICIES × THE THREE MODES
// -------------------------------------------------------------------------------------------

type Expectation = "allow" | "deny" | "ask";

const MATRIX: { mode: "code" | "dispatch" | "chat"; policy: SessionApprovalPolicy; tool: string; want: Expectation; note: string }[] = [
  // bypass — allow literally everything, no card, no event
  { mode: "code", policy: "bypass", tool: "Bash", want: "allow", note: "bypass accepts everything" },
  { mode: "code", policy: "bypass", tool: "TotallyUnknownTool", want: "allow", note: "bypass, unclassified included" },
  // auto — the gate's classification decides
  { mode: "code", policy: "auto", tool: "Bash", want: "allow", note: "MUTATING rides auto's blanket allow" },
  { mode: "code", policy: "auto", tool: "Write", want: "allow", note: "MUTATING rides auto's blanket allow" },
  { mode: "code", policy: "auto", tool: "Workflow", want: "ask", note: "Workflow never rides auto (gate.ts)" },
  { mode: "code", policy: "auto", tool: "skill_write", want: "ask", note: "ALWAYS_ASK: a card no policy silences" },
  { mode: "code", policy: "auto", tool: "TotallyUnknownTool", want: "ask", note: "unclassified fails closed" },
  // plan — nothing mutates
  { mode: "code", policy: "plan", tool: "Bash", want: "deny", note: "plan denies every mutating class" },
  { mode: "code", policy: "plan", tool: "TotallyUnknownTool", want: "deny", note: "plan denies the unclassified too" },
  { mode: "code", policy: "plan", tool: "Read", want: "allow", note: "READ_ONLY survives plan" },
  { mode: "code", policy: "plan", tool: "skill_write", want: "deny", note: "ALWAYS_ASK still denies under plan" },
  // dont-ask — declines everything it would otherwise card
  { mode: "code", policy: "dont-ask", tool: "Bash", want: "deny", note: "the engine.ts:4341 ask→deny flip" },
  { mode: "code", policy: "dont-ask", tool: "Read", want: "allow", note: "reads are never carded" },
  { mode: "code", policy: "dont-ask", tool: "WebFetch", want: "allow", note: "NETWORK is allow at this gate" },
  // accept-edits — edits free, the rest as `ask`
  { mode: "code", policy: "accept-edits", tool: "Edit", want: "allow", note: "EDIT_CLASS is silent" },
  { mode: "code", policy: "accept-edits", tool: "Write", want: "allow", note: "EDIT_CLASS is silent" },
  { mode: "code", policy: "accept-edits", tool: "Bash", want: "ask", note: "non-edit MUTATING still cards" },
  { mode: "code", policy: "accept-edits", tool: "Workflow", want: "ask", note: "Workflow does not ride accept-edits" },
  // ask — the default
  { mode: "code", policy: "ask", tool: "Bash", want: "ask", note: "the default policy cards" },
  { mode: "code", policy: "ask", tool: "Read", want: "allow", note: "reads are free" },

  // DISPATCH — identical everywhere EXCEPT that a would-be card is a typed deny (P8b-7)
  { mode: "dispatch", policy: "auto", tool: "Bash", want: "allow", note: "unchanged from today" },
  { mode: "dispatch", policy: "auto", tool: "Workflow", want: "deny", note: "DIVERGENCE: cards today, denies now" },
  { mode: "dispatch", policy: "auto", tool: "TotallyUnknownTool", want: "deny", note: "DIVERGENCE: cards today, denies now" },
  { mode: "dispatch", policy: "ask", tool: "Bash", want: "deny", note: "DIVERGENCE: cards today, denies now" },
  { mode: "dispatch", policy: "plan", tool: "Bash", want: "deny", note: "unchanged from today" },
  { mode: "dispatch", policy: "dont-ask", tool: "Bash", want: "deny", note: "unchanged from today" },
  { mode: "dispatch", policy: "bypass", tool: "Bash", want: "allow", note: "unchanged from today" },

  // CHAT — the coerced internal "chat" policy is allow-or-deny and never reaches the divergence
  { mode: "chat", policy: "chat", tool: "mcp__norma__research__Search", want: "allow", note: "capability tool normalizes to NETWORK `Search`" },
  { mode: "chat", policy: "chat", tool: "mcp__norma__research__ReadPage", want: "allow", note: "normalizes to NETWORK `ReadPage`" },
  { mode: "chat", policy: "chat", tool: "mcp__norma__browser__browser", want: "allow", note: "normalizes to NETWORK `browser`" },
  { mode: "chat", policy: "chat", tool: "Bash", want: "deny", note: "chat runs nothing mutating" },
  { mode: "chat", policy: "chat", tool: "TotallyUnknownTool", want: "deny", note: "chat denies, never asks" },
  // a session created before the create-time coercion keeps `auto` on its row — the stale-row case
  { mode: "chat", policy: "auto", tool: "Workflow", want: "deny", note: "DIVERGENCE (stale row): never prompts" },
];

for (const row of MATRIX) {
  test(`${row.mode}/${row.policy}: ${row.tool} → ${row.want} (${row.note})`, async () => {
    const h = harness({ mode: row.mode, policy: row.policy });
    const pending = h.canUse(row.tool, { command: "x" }, requestCtx());

    if (row.want === "ask") {
      expect(h.events).toHaveLength(1);
      expect((h.events[0] as { type: string }).type).toBe("approval_requested");
      h.approvals.resolve(SESSION, "tu1", true, "user");
      await expect(pending).resolves.toMatchObject({ behavior: "allow" });
      return;
    }

    const res = (await pending)!;
    expect(res.behavior).toBe(row.want);
    // A silent verdict emits NOTHING: no card the user must dismiss, no event the phone must render.
    expect(h.events).toEqual([]);

    if (row.want === "deny" && row.mode !== "code") {
      const msg = (res as { message: string }).message;
      const gateVerdict = new PermissionGate().evaluate(gateToolNameFor(row.tool), row.policy);
      if (gateVerdict === "ask" && row.policy !== "dont-ask") {
        expect(msg).toBe(neverPromptsMessage(row.tool, row.mode, row.policy));
      }
    }
  });
}

test("only an actual human refusal is classified user_reject", async () => {
  // A policy deny is not a user rejection: today it is a plain isError tool result and the turn
  // continues. Claiming `user_reject` risks the runtime ending the turn on plan mode's first Bash.
  const plan = (await harness({ policy: "plan" }).canUse("Bash", {}, requestCtx()))!;
  expect((plan as { decisionClassification?: string }).decisionClassification).toBeUndefined();
  const dispatch = (await harness({ mode: "dispatch", policy: "ask" }).canUse("Bash", {}, requestCtx()))!;
  expect((dispatch as { decisionClassification?: string }).decisionClassification).toBeUndefined();

  // A timeout/abort is "nobody answered", not a refusal…
  const ac = new AbortController();
  const aborted = harness();
  const p = aborted.canUse("Bash", {}, requestCtx({ controller: ac }));
  ac.abort();
  expect(((await p)! as { decisionClassification?: string }).decisionClassification).toBeUndefined();

  // …but a human "no" is.
  const human = harness();
  const hp = human.canUse("Bash", {}, requestCtx());
  human.approvals.resolve(SESSION, "tu1", false, "phone");
  const res = (await hp)!;
  expect((res as { decisionClassification?: string }).decisionClassification).toBe("user_reject");
  expect((res as { message: string }).message).toContain("The user denied this Bash action");
});

test("the divergence message is exactly the ruling's wording", () => {
  expect(neverPromptsMessage("Workflow", "dispatch", "auto"))
    .toBe("Workflow requires approval and this dispatch session never prompts (policy auto)");
  expect(neverPromptsMessage("Bash", "chat", "ask"))
    .toBe("Bash requires approval and this chat session never prompts (policy ask)");
});

test("the deny texts are the engine's own, verbatim", async () => {
  const plan = await harness({ policy: "plan" }).canUse("Bash", {}, requestCtx());
  expect((plan as { message: string }).message).toBe(
    "Blocked in plan mode — you are researching and planning, so file changes and commands are disabled. Make no changes; when your plan is ready, call exit_plan_mode to present it for approval.",
  );
  const dontAsk = await harness({ policy: "dont-ask" }).canUse("Bash", {}, requestCtx());
  expect((dontAsk as { message: string }).message).toBe(
    "Denied automatically — you're in dont-ask mode, which declines every action that needs approval. Switch to ask or auto to be prompted, or add an allow-rule for this.",
  );
  const chat = await harness({ mode: "chat", policy: "chat" }).canUse("Bash", {}, requestCtx());
  expect((chat as { message: string }).message).toBe(
    "Blocked — chat sessions never ask permissions and cannot run this action.",
  );
});

test("the policy is re-read per call, so session.setPolicy takes effect immediately", async () => {
  let policy: SessionApprovalPolicy = "auto";
  const h = harness({ policy: () => policy });
  await expect(h.canUse("Bash", {}, requestCtx())).resolves.toMatchObject({ behavior: "allow" });
  policy = "plan";
  await expect(h.canUse("Bash", {}, requestCtx())).resolves.toMatchObject({ behavior: "deny" });
});

// -------------------------------------------------------------------------------------------
// Tool-name normalization — the reason every row above works at all.
// -------------------------------------------------------------------------------------------

test("gateToolNameFor maps Winter names onto the names gate.ts classifies", () => {
  expect(gateToolNameFor("Bash")).toBe("bash");
  expect(gateToolNameFor("Read")).toBe("read");
  expect(gateToolNameFor("Write")).toBe("write");
  expect(gateToolNameFor("Edit")).toBe("edit");
  expect(gateToolNameFor("WebFetch")).toBe("web_fetch");
  expect(gateToolNameFor("Agent")).toBe("spawn_agent");
  expect(gateToolNameFor("CronCreate")).toBe("schedule");
  // capability tools: the bare tool name, which is how all five servers' tools are already classified
  expect(gateToolNameFor("mcp__norma__research__Search")).toBe("Search");
  expect(gateToolNameFor("mcp__norma__office__docs")).toBe("docs");
  expect(gateToolNameFor("mcp__norma__sessions__manage_session")).toBe("manage_session");
  // a third-party MCP server keeps its prefix, so `isExternalToolName` still classifies it
  expect(gateToolNameFor("mcp__github__create_issue")).toBe("mcp__github__create_issue");
  expect(gateToolNameFor("plugin__battery__status")).toBe("plugin__battery__status");
  // anything unknown passes through and therefore fails closed
  expect(gateToolNameFor("SomeFutureTool")).toBe("SomeFutureTool");
  // a malformed capability name is never silently widened
  expect(gateToolNameFor("mcp__norma__broken")).toBe("mcp__norma__broken");
});

// -------------------------------------------------------------------------------------------
// AskUserQuestion is routed FIRST — it is a question, not a permission.
// -------------------------------------------------------------------------------------------

test("AskUserQuestion reaches the question bridge even under bypass", async () => {
  const h = harness({ policy: "bypass" });
  const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] };
  const pending = h.canUse("AskUserQuestion", input, requestCtx());
  expect(h.events).toHaveLength(1);
  expect((h.events[0] as { type: string }).type).toBe("question_asked");
  h.questions.respond(SESSION, "tu1", { Which: "A" }, "phone");
  await expect(pending).resolves.toMatchObject({ behavior: "allow" });
});
