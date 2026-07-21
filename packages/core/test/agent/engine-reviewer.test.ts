import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SessionEvent } from "@norma/protocol";
import type { HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { setupEngine } from "./engine-steer.test";
import type { ReviewInput } from "../../src/agent/reviewer";
import { sessionTmpDir } from "../../src/agent/session-tmp";

// A stub bash tool (NOT the real sandboxed one): records every invocation to `calls` so tests
// can assert whether bash actually ran, without depending on macOS sandbox-exec.
// Exported (with bashTurn/writeTurn/stubReviewer below) for reuse by reviewer-e2e.test.ts (phase
// 5e T6) — same reuse precedent as engine-steer.test.ts's setupEngine / engine-spawn.test.ts's
// setup: the e2e file drives the SAME harness idiom, not a re-derived one.
// SP-approvals Task 11 (spec §8): the schema also accepts (and `calls` also records) the two
// escalation args — `allowNetwork`/`dangerouslyDisableSandbox` — so permission-gate-order.test.ts
// can drive the REAL dispatch loop's gating for both flavors while still asserting "ran"/"did not
// run" against a fake, non-sandboxed tool. Both stay `undefined` on a `calls` entry when the model
// didn't pass them, so every PRE-EXISTING `toEqual([{command, justification}])` assertion in this
// file (and reviewer-e2e.test.ts) is unaffected — bun/Jest's `toEqual` ignores undefined-valued
// object properties.
export function stubRegistry(): {
  registry: ToolRegistry;
  calls: Array<{ command: string; justification?: string; allowNetwork?: boolean; dangerouslyDisableSandbox?: boolean }>;
} {
  const registry = new ToolRegistry();
  const calls: Array<{ command: string; justification?: string; allowNetwork?: boolean; dangerouslyDisableSandbox?: boolean }> = [];
  registry.register({
    name: "bash",
    description: "stub bash",
    args: z.object({
      command: z.string(),
      justification: z.string().optional(),
      allowNetwork: z.boolean().optional(),
      dangerouslyDisableSandbox: z.boolean().optional(),
    }),
    run({ command, justification, allowNetwork, dangerouslyDisableSandbox }) {
      calls.push({ command, justification, allowNetwork, dangerouslyDisableSandbox });
      return `ran: ${command}`;
    },
  });
  return { registry, calls };
}

// One round: model calls bash(command[, justification][, escalation args]) then stops with
// tool_calls; round 2 ends the turn. SP-approvals Task 11: the optional 3rd param threads
// allowNetwork/dangerouslyDisableSandbox into the call's argsJson — every pre-existing 2-arg
// caller is unaffected (both stay unset, matching today's argsJson shape exactly).
export function bashTurn(
  command: string,
  justification?: string,
  extra?: { allowNetwork?: boolean; dangerouslyDisableSandbox?: boolean },
): ProviderEvent[][] {
  const args: Record<string, unknown> = { command };
  if (justification !== undefined) args.justification = justification;
  if (extra?.allowNetwork !== undefined) args.allowNetwork = extra.allowNetwork;
  if (extra?.dangerouslyDisableSandbox !== undefined) args.dangerouslyDisableSandbox = extra.dangerouslyDisableSandbox;
  return [
    [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify(args) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

function types(events: SessionEvent[]): string[] { return events.map((e) => e.type); }

// One round: model calls write(path, content) then stops with tool_calls; round 2 ends the turn.
// Uses the REAL write tool (setupEngine always registers it) — not a stub — so a "safe" verdict's
// executeCall does a genuine filesystem write a test can assert on.
export function writeTurn(path: string, content: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path, content }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// Same shape for the REAL edit tool.
function editTurn(path: string, old_string: string, new_string: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "edit", argsJson: JSON.stringify({ path, old_string, new_string }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// One round: model calls an mcp__/plugin__ tool then stops with tool_calls; round 2 ends the turn.
function externalTurn(name: string, args: Record<string, unknown>): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name, argsJson: JSON.stringify(args) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// A stub external (mcp__) tool: records every invocation to `calls` so tests can assert whether
// it actually ran, without a real MCP server.
function registryWithExternal(): { registry: ToolRegistry; calls: Array<{ argsJson: string }> } {
  const registry = new ToolRegistry();
  const calls: Array<{ argsJson: string }> = [];
  registry.register({
    name: "mcp__test__thing",
    description: "stub external tool",
    args: z.record(z.string(), z.unknown()),
    run(args) {
      calls.push({ argsJson: JSON.stringify(args) });
      return "external ok";
    },
  });
  return { registry, calls };
}

// Stub reviewer: scripted verdict/throw, records every input it was asked to review — bash's
// {command, justification} shape (with `class:"bash"`, per 5e T3) as well as fs/external's
// {class, precis} shape.
export function stubReviewer(behavior: { verdict: "safe" | "unsafe"; reason: string } | "safe" | "unsafe" | "throw") {
  const seen: ReviewInput[] = [];
  // SP-policies (policy-escape.test.ts): also accept a bare verdict string ("safe"/"unsafe") — the
  // terse form the escape tests use — alongside the original {verdict, reason} object and "throw". A
  // bare string synthesizes a reason so the emitted tool_review still carries non-empty text.
  const resolved: { verdict: "safe" | "unsafe"; reason: string } | "throw" =
    behavior === "safe" ? { verdict: "safe", reason: "stub: safe" }
      : behavior === "unsafe" ? { verdict: "unsafe", reason: "stub: unsafe" }
        : behavior;
  const stub = {
    seen,
    review: async (input: ReviewInput) => {
      seen.push(input);
      if (resolved === "throw") throw new Error("reviewer boom");
      return resolved;
    },
  };
  // `{ reviewer, reviews }` aliases mirror stubRegistry's `{ registry, calls }` shape so
  // policy-escape.test.ts can destructure them; every existing caller keeps using `{ seen, review }`
  // directly (and passes the whole object as the reviewer via `as any`), both unchanged.
  return Object.assign(stub, { reviewer: stub, reviews: seen });
}

describe("engine + safety reviewer (auto-policy bash)", () => {
  test("unsafe verdict escalates; a HUMAN deny ENDS the turn (no retry-with-justification bypass), bash did NOT run, reviewer saw {command, justification}", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_SENTINEL" });
    const provider = new FakeProvider(bashTurn("rm -rf x", "cleaning up JUST_SENTINEL"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(types(events)).toEqual(expect.arrayContaining(["tool_review", "approval_requested", "approval_resolved", "tool_result"]));
    // phase 5e T2 (+review fix): the reason moves to reviewerReason; the summary is the humanized
    // bash card (approvalCardSummary's bash branch) — command only, no reason prefix, and no
    // justification (model-authored persuasion text stays off the card).
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.reviewerReason).toBe("REASON_SENTINEL");
    expect(requested.summary).toBe("bash rm -rf x");
    expect(requested.summary).not.toContain("JUST_SENTINEL");

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "unsafe", reason: "REASON_SENTINEL" });
    expect(review.summary).toContain("rm -rf x");

    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    // A human deny must STOP the loop and NOT coach the model to retry with a justification
    // (that was the gate-bypass the user hit: deny → model re-submits with justification →
    // reviewer self-approves in-turn). The turn ends so the user regains control.
    expect(result.output.toLowerCase()).toContain("denied");
    expect(result.output.toLowerCase()).not.toContain("justification");
    const completed = events.find((e) => e.type === "turn_completed") as any;
    expect(completed.stopReason).toBe("end_turn");
    // round 2 of `bashTurn` ("done") never ran — the turn ended at the denial:
    expect(events.some((e) => e.type === "assistant_message" && (e as any).text === "done")).toBe(false);

    expect(calls.length).toBe(0); // bash did NOT run
    // phase 5e T3: the engine now passes an explicit class:"bash" alongside {command, justification}
    // (the reviewer's ONE review() entry point discriminates on it) — everything else unchanged.
    expect(reviewer.seen).toEqual([{ class: "bash", command: "rm -rf x", justification: "cleaning up JUST_SENTINEL" }]);
  });

  test("escalation timeout is read from NORMA_REVIEW_APPROVAL_TIMEOUT_MS (60s default), independent of the ask-path approvalTimeoutMs", async () => {
    const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
    process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30"; // short override so the test doesn't wait 60s
    try {
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_TIMEOUT" });
      const provider = new FakeProvider(bashTurn("rm -rf x"));
      // No watcher — nobody resolves the approval, so it must time out on its own via the broker.
      const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

      const started = Date.now();
      await engine.runTurn(sessionId);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2000); // nowhere near the 5-min ask-path default or the 60s reviewer default
      const events = store.read(sessionId);
      expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "timeout" });
      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested.reviewerReason).toBe("REASON_TIMEOUT");
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      // denialMessage's shape stays BYTE-IDENTICAL to pre-T2 (the one deliberate reviewer->model
      // channel) EXCEPT the seconds figure — whole-branch fix wave: that figure is now derived
      // from the ACTUAL timeoutMs used (this test's own 30ms override, rounding to 0s), never a
      // hardcoded "60s" a client could be lied to by (see reviewAndDispatch's own doc comment).
      expect(result.output).toBe(
        'blocked by the safety reviewer: REASON_TIMEOUT. No approval within 0s. If this command is genuinely necessary, call bash again with a "justification" explaining why — the reviewer will reconsider.',
      );
      expect(calls.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
    }
  });

  test("safe verdict → bash runs, no approval_requested, but tool_review(safe) is persisted", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "safe", reason: "looks fine" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ command: "rm -rf x", justification: undefined }]);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(false);
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "safe", reason: "looks fine" });
    expect(review.summary).toContain("rm -rf x");
  });

  test("allowlisted `ls` → bash runs, reviewer.review NOT called, no approval, NO tool_review (bashLooksSafe bypass)", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("ls -la"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(reviewer.seen.length).toBe(0);
    expect(calls).toEqual([{ command: "ls -la", justification: undefined }]);
  });

  test("reviewer throws → tool_review(error) + escalates (approval_requested carries reviewerReason, NOT the smashed-in summary)", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer("throw");
    const provider = new FakeProvider(bashTurn("curl http://example.com"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "error" });
    expect(review.reason.toLowerCase()).toContain("manual approval");

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.summary).toBe("bash curl http://example.com"); // humanized card, no fail-closed text smuggled in
    expect(requested.reviewerReason.toLowerCase()).toContain("manual approval");
    expect(calls.length).toBe(0);
  });

  test("ASK policy bash → reviewer NOT consulted; normal (non-reviewer) approval path runs", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask" });

    const watcher: HubClient = {
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.summary).not.toContain("safety reviewer");
    expect(requested.reviewerReason).toBeUndefined(); // non-reviewer ask-path card carries no reviewerReason
    expect(events.some((e) => e.type === "tool_review")).toBe(false); // reviewer never consulted under ASK
    expect(calls.length).toBe(1); // approved → ran
  });

  test("reviewer disabled (reviewerEnabled:false) → bash runs directly, no review", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, reviewerEnabled: false });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("injection containment: after a TIMED-OUT review (turn continues), the NEXT provider request carries the reviewer's reason ONLY via the tool_result, never as a raw context push", async () => {
    // A human deny now ENDS the turn (no next round), so injection containment is tested on the
    // timeout path — the one case where the reviewer's reason legitimately re-enters the turn
    // (as the denial tool_result) and the loop continues.
    const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
    process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30"; // short: no watcher answers → broker times out fast
    try {
      const { registry } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_SENTINEL_INJECT" });
      const provider = new FakeProvider(bashTurn("rm -rf x"));
      const { engine, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

      await engine.runTurn(sessionId);

      // Round 1 (index 1) is the NEXT provider request after the bash tool_call/tool_result round.
      const round1 = provider.requests[1];
      expect(round1).toBeDefined();
      // The denial message DOES legitimately carry the reason (it's the bash tool_result output) —
      // but it must be there exactly once, via the tool_result item, never duplicated as a raw
      // reviewer-verdict push into the turn context.
      const toolResultItems = round1!.input.filter((i) => i.type === "tool_result");
      expect(toolResultItems.length).toBe(1);
      expect((toolResultItems[0] as any).output).toContain("REASON_SENTINEL_INJECT");
      // No OTHER input item (message/function_call) carries the raw reason:
      const nonToolResult = round1!.input.filter((i) => i.type !== "tool_result");
      for (const item of nonToolResult) {
        expect(JSON.stringify(item)).not.toContain("REASON_SENTINEL_INJECT");
      }
    } finally {
      if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
    }
  });

  test("sanitization: a multiline/oversized reason is single-lined and capped (300) on both tool_review.reason and approval_requested.reviewerReason; tool_review.summary is capped (160)", async () => {
    const { registry } = stubRegistry();
    const multilineReason = "line one\nline two\r\nline three " + "x".repeat(400); // > 300 after joining
    const reviewer = stubReviewer({ verdict: "unsafe", reason: multilineReason });
    const longCommand = "rm -rf " + "y".repeat(300); // NOT in SAFE_ARGV0 → forces a real review; > 160 once prefixed
    const provider = new FakeProvider(bashTurn(longCommand));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review.reason).not.toContain("\n");
    expect(review.reason).not.toContain("\r");
    expect(review.reason.length).toBeLessThanOrEqual(300);
    expect(review.summary.length).toBeLessThanOrEqual(160);
    expect(review.summary).not.toContain("\n");

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.reviewerReason).not.toContain("\n");
    expect(requested.reviewerReason.length).toBeLessThanOrEqual(300);
  });

  test("sanitization strips C0 controls (ESC/BEL), not just newlines — reviewer text lands on terminal cards, where raw control bytes could perturb the terminal (5e whole-branch hardening)", async () => {
    const { registry } = stubRegistry();
    // An ANSI color escape + a BEL: pre-hardening these survived sanitizeReviewText verbatim and
    // reached the wire (and Ink Text) raw.
    const controlReason = "danger \x1b[31mX\x07 here";
    const reviewer = stubReviewer({ verdict: "unsafe", reason: controlReason });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // Each control byte becomes one space; surrounding plain text (including the now-inert "[31m"
    // that followed the ESC) is untouched.
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review.reason).toBe("danger  [31mX  here");
    expect(review.reason).not.toContain("\x1b");
    expect(review.reason).not.toContain("\x07");
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.reviewerReason).toBe("danger  [31mX  here");
  });
});

// phase 5e T3: coverage generalization — fs-unusual writes/edits + external (mcp__/plugin__)
// tools join bash under the auto-policy reviewer. Reuses the SAME engine + reviewer +
// setupEngine harness above; only the trigger (what gets reviewed) and the précis (what the
// reviewer/tool_review sees) are new — verdict/emission/escalation is T2's machinery, asserted
// here to behave identically to the bash suite above.
describe("engine + safety reviewer (auto-policy fs coverage, phase 5e T3)", () => {
  test("plain in-cwd write → NOT reviewed (unchanged pre-T3 behavior); write actually lands", async () => {
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(writeTurn("notes.txt", "hello"));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello");
  });

  test("dotfile in cwd (.ssh/config) → reviewed; unsafe verdict escalates; denialMessage has NO justification sentence (fs-only text)", async () => {
    const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
    process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30"; // short: no watcher answers → broker times out fast
    try {
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_FS" });
      const provider = new FakeProvider(writeTurn(".ssh/config", "Host x\n  User y"));
      const { engine, store, sessionId, cwd } = setupEngine(provider, { reviewer: reviewer as any });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "write", verdict: "unsafe", reason: "REASON_FS" });
      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested.reviewerReason).toBe("REASON_FS");
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      // fs/external denial text: plain "blocked by..." + timeout sentence — NO bash's
      // justification-reconsideration sentence (there's no `justification` param on write/edit).
      // Seconds figure derived from this test's own 30ms override (whole-branch fix wave), not a
      // hardcoded "60s" — see reviewAndDispatch's doc comment.
      expect(result.output).toBe("blocked by the safety reviewer: REASON_FS. No approval within 0s.");
      expect(result.output.toLowerCase()).not.toContain("justification");
      expect(existsSync(join(cwd, ".ssh", "config"))).toBe(false); // blocked — never written
    } finally {
      if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
    }
  });

  test("added-root write → reviewed; safe verdict → write executes into the added root, tool_review(safe) persisted", async () => {
    const addedDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-added-")));
    const reviewer = stubReviewer({ verdict: "safe", reason: "added root, but fine" });
    const provider = new FakeProvider(writeTurn(join(addedDir, "note.txt"), "added-root content"));
    const { engine, store, sessionId, dirs } = setupEngine(provider, { reviewer: reviewer as any });
    dirs.add(sessionId, addedDir);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "write", verdict: "safe" });
    expect(review.summary).toContain(join(addedDir, "note.txt"));
    expect(readFileSync(join(addedDir, "note.txt"), "utf8")).toBe("added-root content");
  });

  test("session tmp write → reviewed (unusual: outside the primary cwd subtree, still fence-legal at the OS/sandbox level); the write TOOL's own (narrower) fence still rejects it on execution — orthogonal to review", async () => {
    // sessionId (hence the tmp dir path, which is keyed by it) isn't known until setupEngine
    // returns — `script` is the SAME array FakeProvider holds internally (passed by reference,
    // not copied), so it can be filled in with the real tool call AFTER sessionId exists but
    // BEFORE runTurn ever reads it.
    const script: ProviderEvent[][] = [];
    const provider = new FakeProvider(script);
    const reviewer = stubReviewer({ verdict: "safe", reason: "tmp write, fine" });
    const { engine, store, sessionId } = setupEngine(provider, { reviewer: reviewer as any });
    const tmp = sessionTmpDir(sessionId);
    script.push(...writeTurn(join(tmp, "scratch.txt"), "tmp content"));

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "write", verdict: "safe" });
    const result = events.find((e) => e.type === "tool_result") as any;
    // Reviewed (and approved) — but write.ts's OWN fence (roots only, no tmpDir) still rejects a
    // tmp-dir target, so the write itself fails. Review decides whether to REVIEW, not whether
    // execution succeeds.
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the allowed directories");
  });

  // task-24 review F1: the write-permission-flow's auto-policy pre-grant must NOT bypass this fs
  // reviewer. The first cut dispatched an out-of-root write straight to executeCall from the grant
  // branch — reviewer never consulted, "unsafe" never seen. Now the grant is applied BEFORE the
  // dispatch chain (dir joins the session roots, dirGrant nulled) and the call falls through the
  // SAME chain an in-root write takes — where an out-of-root target is by definition outside the
  // primary cwd subtree, i.e. exactly the fsWriteIsUnusual case the added-root test above pins.
  test("out-of-root write under auto: the dir grant is silent but the WRITE still rides the fs reviewer — unsafe verdict blocks it exactly like an in-root unusual write (task-24 review F1)", async () => {
    const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
    process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30"; // short: no watcher answers → broker times out fast
    try {
      const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-oor-unsafe-")));
      const target = join(outsideDir, "f.txt");
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_OOR" });
      const provider = new FakeProvider(writeTurn(target, "must not land"));
      const { engine, store, sessionId, dirs } = setupEngine(provider, { reviewer: reviewer as any });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      // The GRANT landed (auto grants silently; directory_added is observability, not approval)...
      expect(events.some((e) => e.type === "directory_added" && (e as any).path === outsideDir)).toBe(true);
      expect(dirs.has(sessionId, outsideDir)).toBe(true);
      // ...but the WRITE was still reviewed, found unsafe, escalated, timed out, and blocked:
      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "write", verdict: "unsafe", reason: "REASON_OOR" });
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("blocked by the safety reviewer");
      expect(existsSync(target)).toBe(false); // blocked — never written
    } finally {
      if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
    }
  });

  test("out-of-root write under auto: reviewer-approved (safe) → grant + review + the write lands (task-24 review F1, happy path)", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-oor-safe-")));
    const target = join(outsideDir, "ok.txt");
    const reviewer = stubReviewer({ verdict: "safe", reason: "granted dir, fine" });
    const provider = new FakeProvider(writeTurn(target, "reviewed and landed"));
    const { engine, store, sessionId } = setupEngine(provider, { reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "directory_added" && (e as any).path === outsideDir)).toBe(true);
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "write", verdict: "safe" });
    expect(review.summary).toContain(target); // précis saw the REAL (granted) destination
    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // safe → no escalation card
    expect(readFileSync(target, "utf8")).toBe("reviewed and landed");
  });

  test("plain in-cwd path with a dotted PREFIX but no dot-segment (e.g. \"src/a.ts\") → NOT reviewed", async () => {
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(writeTurn("src/a.ts", "export {}"));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toBe("export {}");
  });

  test("edit: same rules — dotfile edit is reviewed, plain in-cwd edit is NOT", async () => {
    // dotfile edit → reviewed (denied via timeout, mirrors the write case above):
    const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
    process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30";
    try {
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_EDIT" });
      const provider = new FakeProvider(editTurn(".git/hooks/pre-commit", "old", "new"));
      const { engine, store, sessionId } = setupEngine(provider, { reviewer: reviewer as any });
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "edit", verdict: "unsafe", reason: "REASON_EDIT" });
    } finally {
      if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
    }

    // plain in-cwd edit → NOT reviewed, and actually executes (file pre-seeded so old_string matches):
    const reviewer2 = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider2 = new FakeProvider(editTurn("app.ts", "const x = 1", "const x = 2"));
    const { engine: engine2, store: store2, sessionId: sessionId2, cwd: cwd2 } = setupEngine(provider2, { reviewer: reviewer2 as any });
    writeFileSync(join(cwd2, "app.ts"), "const x = 1;\n");
    await engine2.runTurn(sessionId2);
    const events2 = store2.read(sessionId2);
    expect(reviewer2.seen.length).toBe(0);
    expect(events2.some((e) => e.type === "tool_review")).toBe(false);
    expect(readFileSync(join(cwd2, "app.ts"), "utf8")).toBe("const x = 2;\n");
  });

  test("reviewerClasses:{fs:false} → dotfile write short-circuits: NOT reviewed, no tool_review, executes directly", async () => {
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(writeTurn(".ssh/config", "Host x"));
    const { engine, store, sessionId, cwd } = setupEngine(provider, {
      reviewer: reviewer as any,
      reviewerClasses: { fs: false },
    });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(join(cwd, ".ssh", "config"), "utf8")).toBe("Host x");
  });

  test("précis NEVER contains file content — only the resolved path + a char count", async () => {
    // "safe" verdict — no escalation/approval wait needed, this test only cares about what the
    // reviewer/tool_review SAW, not the approval flow (already covered by the dotfile-unsafe test).
    const reviewer = stubReviewer({ verdict: "safe", reason: "REASON_PRECIS" });
    const secret = "SECRET_CONTENT_MARKER_12345"; // 28 chars
    const provider = new FakeProvider(writeTurn(".ssh/config", secret));
    const { engine, store, sessionId } = setupEngine(provider, { reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(1);
    const seen = reviewer.seen[0] as { class: "fs"; precis: string };
    expect(seen.class).toBe("fs");
    expect(seen.precis).not.toContain(secret);
    expect(seen.precis).toContain(`(${secret.length} chars)`);
    expect(seen.precis.startsWith("write ")).toBe(true);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review.summary).not.toContain(secret);
    expect(review.summary).toContain(`(${secret.length} chars)`);
  });

  test("reviewer throws (fs) → tool_review(error) + escalates, same as bash", async () => {
    const reviewer = stubReviewer("throw");
    const provider = new FakeProvider(writeTurn(".ssh/config", "x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "write", verdict: "error" });
    expect(review.reason.toLowerCase()).toContain("manual approval");
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.reviewerReason.toLowerCase()).toContain("manual approval");
  });

  // 5e T3 review fix (bypass): a NEW file written through a pre-existing in-cwd symlink into an
  // added root used to classify off the RAW pre-symlink path (textually under cwd — realpath
  // throws on the not-yet-existing file, so isWithin fell back to the raw text) and SKIP review,
  // while the write itself landed in the added root. Classification and précis must both see the
  // CANONICALIZED (post-symlink) location — where the bytes actually land.
  test("write of a NEW file through an in-cwd symlink into an added root → REVIEWED; précis/summary show the true added-root path, not the cwd-relative symlink text", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-symlink-cwd-")));
    const addedDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-symlink-added-")));
    symlinkSync(addedDir, join(cwd, "link"));
    const reviewer = stubReviewer({ verdict: "safe", reason: "escape noted, fine" });
    const provider = new FakeProvider(writeTurn("link/newfile.txt", "escaped content"));
    const { engine, store, sessionId, dirs } = setupEngine(provider, { reviewer: reviewer as any, cwd });
    dirs.add(sessionId, addedDir);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(1); // the bypass: pre-fix this was 0
    const seen = reviewer.seen[0] as { class: "fs"; precis: string };
    expect(seen.class).toBe("fs");
    expect(seen.precis).toContain(join(addedDir, "newfile.txt")); // true post-symlink location
    expect(seen.precis).not.toContain(join(cwd, "link"));         // never the misleading raw text
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "write", verdict: "safe" });
    expect(review.summary).toContain(join(addedDir, "newfile.txt"));
    // safe verdict → the write executed, through the symlink, into the added root:
    expect(readFileSync(join(addedDir, "newfile.txt"), "utf8")).toBe("escaped content");
  });

  test("write of a NEW file through an in-cwd symlink to an in-cwd subdir → NOT reviewed (canonicalization causes no false positive)", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-symlink-incwd-")));
    mkdirSync(join(cwd, "subdir"));
    symlinkSync(join(cwd, "subdir"), join(cwd, "link"));
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(writeTurn("link/new.txt", "in-cwd content"));
    const { engine, store, sessionId } = setupEngine(provider, { reviewer: reviewer as any, cwd });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(join(cwd, "subdir", "new.txt"), "utf8")).toBe("in-cwd content");
  });

  test("edit of an EXISTING file through an in-cwd symlink into an added root → reviewed (was already caught pre-fix — the existing-file realpath worked; pinned so the fix doesn't regress it)", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-symlink-edit-")));
    const addedDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-fs-symlink-edit-added-")));
    writeFileSync(join(addedDir, "cfg.txt"), "value = old");
    symlinkSync(addedDir, join(cwd, "link"));
    const reviewer = stubReviewer({ verdict: "safe", reason: "fine" });
    const provider = new FakeProvider(editTurn("link/cfg.txt", "old", "new"));
    const { engine, store, sessionId, dirs } = setupEngine(provider, { reviewer: reviewer as any, cwd });
    dirs.add(sessionId, addedDir);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(1);
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "edit", verdict: "safe" });
    expect(review.summary).toContain(join(addedDir, "cfg.txt"));
    expect(readFileSync(join(addedDir, "cfg.txt"), "utf8")).toBe("value = new");
  });
});

describe("engine + safety reviewer (auto-policy external coverage, phase 5e T3)", () => {
  test("mcp__ tool under auto → ALWAYS reviewed; unsafe verdict escalates; denialMessage has NO justification sentence", async () => {
    const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
    process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30";
    try {
      const { registry, calls } = registryWithExternal();
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "RISKY_EXTERNAL" });
      const provider = new FakeProvider(externalTurn("mcp__test__thing", { action: "delete_all" }));
      const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "mcp__test__thing", verdict: "unsafe", reason: "RISKY_EXTERNAL" });
      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested.reviewerReason).toBe("RISKY_EXTERNAL");
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      // Seconds figure derived from this test's own 30ms override (whole-branch fix wave), not a
      // hardcoded "60s" — see reviewAndDispatch's doc comment.
      expect(result.output).toBe("blocked by the safety reviewer: RISKY_EXTERNAL. No approval within 0s.");
      expect(result.output.toLowerCase()).not.toContain("justification");
      expect(calls.length).toBe(0); // never ran
    } finally {
      if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
    }
  });

  test("mcp__ tool under auto, safe verdict → executes normally, tool_review(safe) persisted", async () => {
    const { registry, calls } = registryWithExternal();
    const reviewer = stubReviewer({ verdict: "safe", reason: "looks fine" });
    const provider = new FakeProvider(externalTurn("mcp__test__thing", { action: "read" }));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "mcp__test__thing", verdict: "safe" });
    expect(calls.length).toBe(1); // ran
  });

  test("mcp__ tool under ASK policy → NOT reviewed by the AI reviewer (card governs); normal ask-policy approval runs", async () => {
    const { registry, calls } = registryWithExternal();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(externalTurn("mcp__test__thing", { action: "read" }));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask" });

    const watcher: HubClient = {
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.reviewerReason).toBeUndefined();
    expect(calls.length).toBe(1); // approved → ran
  });

  test("reviewerClasses:{external:false} → NOT reviewed even under auto, executes directly", async () => {
    const { registry, calls } = registryWithExternal();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(externalTurn("mcp__test__thing", { action: "read" }));
    const { engine, store, sessionId } = setupEngine(provider, {
      registry, reviewer: reviewer as any, reviewerClasses: { external: false },
    });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("précis: tool name + a single-line argsJson slice(160)", async () => {
    const { registry } = registryWithExternal();
    const reviewer = stubReviewer({ verdict: "safe", reason: "fine" });
    const bigArg = "z".repeat(300);
    const provider = new FakeProvider(externalTurn("mcp__test__thing", { blob: bigArg }));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(1);
    const seen = reviewer.seen[0] as { class: "external"; precis: string };
    expect(seen.class).toBe("external");
    expect(seen.precis.startsWith("mcp__test__thing ")).toBe(true);
    expect(seen.precis).not.toContain("\n");
    // "tool name + single-line argsJson slice(160)" — the (160) caps the argsJson SLICE, not the
    // whole précis (the name prefix rides free) — pin the exact length so this doesn't drift.
    expect(seen.precis.length).toBe("mcp__test__thing ".length + 160);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review.summary.length).toBeLessThanOrEqual(160); // tool_review.summary's OWN cap (T2) wins when combined length would exceed it
    expect(review.summary.startsWith("mcp__test__thing ")).toBe(true);
  });

  test("reviewer throws (external) → tool_review(error) + escalates, same as bash", async () => {
    const { registry } = registryWithExternal();
    const reviewer = stubReviewer("throw");
    const provider = new FakeProvider(externalTurn("mcp__test__thing", { action: "read" }));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "mcp__test__thing", verdict: "error" });
    expect(review.reason.toLowerCase()).toContain("manual approval");
  });
});

describe("engine + safety reviewer (bash class-off, phase 5e T3)", () => {
  test("reviewerClasses:{bash:false} → bash short-circuits: NOT reviewed even under auto, executes directly", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, sessionId } = setupEngine(provider, {
      registry, reviewer: reviewer as any, reviewerClasses: { bash: false },
    });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls.length).toBe(1); // ran directly
  });
});

// Phase 5e T4: back-compat — reviewerEnabled:false is the master switch; reviewerClasses is
// subordinate to it and can never re-enable a class it turns off. Bash/fs/external all share the
// SAME `this.cfg.reviewerEnabled !== false && ... && this.reviewClassEnabled(cls)` gate (engine.ts),
// so one representative class is enough to pin the precedence.
describe("engine + safety reviewer (reviewerEnabled:false wins over reviewerClasses, phase 5e T4)", () => {
  test("reviewerEnabled:false with reviewerClasses:{bash:true,fs:true,external:true} explicitly ON → bash still runs unreviewed", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, sessionId } = setupEngine(provider, {
      registry, reviewer: reviewer as any,
      reviewerEnabled: false,
      reviewerClasses: { bash: true, fs: true, external: true }, // explicit ON — must NOT override the master switch
    });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls.length).toBe(1); // ran directly, unreviewed
  });
});
