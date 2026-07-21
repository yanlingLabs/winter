import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerWorktreeTools } from "../../src/agent/tools/worktree";
import { WorktreeManager } from "../../src/agent/worktree";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { PermissionRules } from "../../src/agent/permission-rules";
import { registerWebTools } from "../../src/agent/tools/web";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, bashTurn, writeTurn, stubReviewer } from "./engine-reviewer.test";
import { repo } from "./engine-worktree.test";

const isMac = process.platform === "darwin";

// SP-approvals Task 3: the engine's dispatch loop now consults Task 1's PermissionRules and Task
// 2's readOnlyBash BEFORE carding an `ask`-policy call — this is the piece that stops an ask-policy
// session from re-prompting forever for a call a standing rule (or a provably read-only bash
// command) already covers. Every test below drives the REAL dispatch loop (setupEngine's harness,
// same one engine-reviewer.test.ts uses) rather than calling PermissionRules/readOnlyBash in
// isolation (already covered by their own unit suites) — the point here is the WIRING and its
// security invariants: rules are consulted ONLY on `ask`, NEVER on `deny` (plan mode), NEVER ahead
// of an out-of-root write's own grant card. SP-policies Task 8 REVERSES the last clause of this
// comment's original claim: the AI safety reviewer is now auto-ONLY, so a rule/classifier allowing
// a bash call under `ask` is a human pre-authorization and the call now runs with NO reviewer at
// all (scenarios 6/7 below, and the allowNetwork rule-reviewer case in scenario 11, were updated
// from "still rides the reviewer" to "now runs with no reviewer" accordingly —
// policy-reviewer-ask.test.ts holds the dedicated auto-vs-ask regression coverage for this).

function tmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// A stub `computer` tool (NOT the real ComputerUseService-backed one — see engine-computer.test.ts
// for that harness): records every invocation so a test can assert whether it actually ran. This
// suite only cares about the gate/rule interplay for the `computer` tool name (CC-parity default
// allow-rule, scenario 3), never computer-use itself.
function stubComputerRegistry(): { registry: ToolRegistry; calls: Array<{ action: string }> } {
  const registry = new ToolRegistry();
  const calls: Array<{ action: string }> = [];
  registry.register({
    name: "computer",
    description: "stub computer",
    args: z.object({ action: z.string() }),
    run({ action }) {
      calls.push({ action });
      return `did: ${action}`;
    },
  });
  return { registry, calls };
}

// One round: model calls computer(action) then stops with tool_calls; round 2 ends the turn.
function computerTurn(action: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "computer", argsJson: JSON.stringify({ action }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// An approval-card watcher that always approves — used where the test WANTS the card to appear
// and resolve cleanly (rather than time out), mirroring engine-reviewer.test.ts's own "auto-approver"/
// "auto-denier" watcher idiom.
function approver(broker: { resolve: (sessionId: string, callId: string, approved: boolean, by: string) => void }, sessionId: string, approved: boolean): HubClient {
  return {
    clientName: approved ? "auto-approver" : "auto-denier",
    deliver(e) {
      if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, approved, approved ? "auto-approver" : "auto-denier");
      return true;
    },
  };
}

describe("scenario 1: a project rule allows a bash call outright — no card", () => {
  test("Bash(git status:*) project rule + `git status` under ask → runs, NO approval_requested", async () => {
    const cwd = tmpDir("norma-pgo-cwd-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "permissions.local.json"), JSON.stringify({ allow: ["Bash(git status:*)"] }));
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git status"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ command: "git status", justification: undefined }]);
  });
});

describe("scenario 2: readOnlyBash classifier — read-only runs silently, non-read-only still cards", () => {
  test("no rule anywhere, `cat f` (read-only) under ask → runs, NO approval_requested", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("cat f"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ command: "cat f", justification: undefined }]);
  });

  test("no rule anywhere, `git push` (NOT read-only) under ask → card still appears (unchanged)", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git push"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(calls.length).toBe(1); // approved → ran
  });
});

describe("scenario 3: `computer` CC-parity default lives in the daemon getter fallback, not PermissionRules itself", () => {
  test("globalAllow resolves to the [\"Computer\"] default (simulating settings.permissions.allow absent) → no card", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Computer"], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubComputerRegistry();
    const provider = new FakeProvider(computerTurn("screenshot"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ action: "screenshot" }]);
  });

  test("globalAllow resolves to [] (simulating explicit settings \"allow\": []) → card returns", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubComputerRegistry();
    const provider = new FakeProvider(computerTurn("screenshot"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(calls.length).toBe(1); // approved → ran
  });
});

describe("scenario 4: an Edit rule covers an IN-ROOT target only — an out-of-root target still needs its own grant card", () => {
  test("Edit rule (any) + in-root write target under ask → no card, write lands", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn("notes.txt", "hello"));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello");
  });

  test("the SAME Edit rule + an OUT-OF-ROOT write target under ask → the grant card still appears (rule does not bypass it)", async () => {
    const outsideDir = tmpDir("norma-pgo-oor-");
    const target = join(outsideDir, "f.txt");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(target, "should still need a grant"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    // The grant-flavored card (engine.ts's dirGrant branch), NOT the generic approvalCardSummary —
    // proves this rode the SAME out-of-project grant seam a ruleless call would, not a rule-skip.
    // SP-policies Task 9: the summary reads "outside your project" and the card now carries the
    // three edit options (its rule option names the grant dir), whereas the generic ask card's
    // options — when it has any — are approvalOptionsFor's Bash(...) shape, never an Edit(<dir>) one.
    expect(requested.summary).toContain("outside your project");
    expect(requested.options.find((o: any) => o.id === "allow_project")).toMatchObject({ rule: `Edit(${outsideDir})`, scope: "project" });
    expect(readFileSync(target, "utf8")).toBe("should still need a grant"); // approved → one-shot write landed
  });
});

describe("scenario 5: plan policy denies outright — a rule is never even consulted", () => {
  test("a Bash(any) global rule + plan policy → still denied, no card, bash never ran", async () => {
    // "git status" is BOTH rule-matched (Bash, kind "any") and readOnlyBash-classified true — if
    // either source were consulted despite the deny, this would flip to "allow"; asserting the
    // plan-mode denial text proves neither ever ran.
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash"], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git status"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "plan", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // deny is silent, not a card
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("plan mode");
    expect(calls.length).toBe(0);
  });
});

describe("scenario 6/7: a rule- or classifier-allowed bash call under ASK now runs with NO reviewer (SP-policies Task 8)", () => {
  test("6. rule-allowed (Bash(npm test:*)) bash under ASK runs unreviewed even with a reviewer configured", async () => {
    // "npm test" is rule-matched but NOT readOnlyBash-classified (npm's read-only subcommands are
    // only ls/view/outdated) — isolates the RULE as the sole source of ruleAllowed. Pre-SP-policies
    // this rule-allowed call still rode the AI reviewer under `ask` (the SP-approvals T3 widening,
    // "escalation card appears DESPITE the matching rule"); Task 8 drops that widening — the
    // reviewer is auto-only now, so a rule match under `ask` is a human pre-authorization and the
    // call just runs, unreviewed. The stub verdict is "unsafe" so a regression (the reviewer
    // wrongly running and escalating) would fail loudly rather than silently pass on a lucky verdict.
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(npm test:*)"], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "WOULD_BLOCK_IF_CONSULTED" });
    const provider = new FakeProvider(bashTurn("npm test"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(false);
    expect(calls.length).toBe(1); // ran — rule-allowed, no reviewer under ask
    expect(reviewer.seen.length).toBe(0);
  });

  test("7. classifier-allowed (`git log --oneline -5`, no rule at all) bash under ASK runs unreviewed too", async () => {
    // No rule anywhere — readOnlyBash alone is what flips ruleAllowed here, isolating the
    // CLASSIFIER as the sole source: both sources of ruleAllowed lose the reviewer identically
    // under `ask` post-Task-8 (the pre-Task-8 spec required both sources to ride the SAME reviewer
    // branch; now both sources identically skip it).
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "WOULD_BLOCK_IF_CONSULTED" });
    const provider = new FakeProvider(bashTurn("git log --oneline -5"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(reviewer.seen.length).toBe(0); // the reviewer is auto-only now — never consulted under ask
    expect(calls).toEqual([{ command: "git log --oneline -5", justification: undefined }]);
  });
});

describe("scenario 8: the control-plane grant-denial hard error is unchanged — no rule can ever bypass it", () => {
  test("an allow-everything Edit rule + a write into the denied-prefix dir → still a hard error, no card, no grant", async () => {
    const runDir = tmpDir("norma-pgo-rundir-");
    const target = join(runDir, "core.sock.d", "evil.txt");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(target, "x"));
    const { engine, store, sessionId, dirs } = setupEngine(provider, { policy: "ask", permissionRules, grantDeniedPrefixes: [runDir] });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card, even under ask
    expect(events.some((e) => e.type === "directory_added")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/control plane/);
    expect(result.output).toMatch(/never be granted/);
    expect(existsSync(target)).toBe(false);
    expect(dirs.has(sessionId, runDir)).toBe(false);
  });
});

// Follow-up (reviewer's fast-follow on the T3 review — adjudicated CORRECT but untested): a
// "Worktree" rule is in Task 1's grammar (KNOWN_TOOLS includes "Worktree"; toolForCallName maps
// both enter_worktree/exit_worktree call names to it), so it rides the exact same `ruleAllowed`
// path every other tool does — flipping `decision` to "allow" BEFORE the `isWorktree` branch's own
// `decision === "ask"` check, which then takes its direct-bridge `else` arm instead of the
// approval-seam one. Real git plumbing underneath, so `describe.if(isMac)` — same guard every
// other real-worktree suite in this package uses (engine-worktree.test.ts, worktree.test.ts,
// engine-spawn.test.ts, etc.).
describe.if(isMac)("scenario 9: a Worktree rule allows enter_worktree outright — no card, the real bridge runs", () => {
  test("global Worktree rule + enter_worktree under ask → no approval_requested; worktree_entered emitted; cwd moves into the worktree", async () => {
    const cwd = repo();
    const registry = new ToolRegistry();
    registerWorktreeTools(registry);
    const worktrees = new WorktreeManager({ baseRef: () => "head" });
    const permissionRules = new PermissionRules({ globalAllow: () => ["Worktree"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, store, sessionId } = setupEngine(provider, { registry, cwd, policy: "ask", permissionRules, worktrees });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card — the bridge ran directly
    const entered = events.find((e) => e.type === "worktree_entered") as any;
    expect(entered).toMatchObject({ name: "feat", branch: "norma/feat" });
    expect(store.meta(sessionId).cwd).toBe(entered.path); // cwd moved into the worktree
  });
});

// SP-approvals Task 10 (user addition 2026-07-21, spec §7): web tools become free by default —
// gate.ts's NETWORK class now unconditionally "allow"s web_fetch/web_search under every policy —
// but web_fetch keeps ONE floor no policy can silence, entirely inside the engine: a fetch to a
// known/likely exfiltration or tunnel-provider domain still cards, under ask/auto/plan alike. This
// drives the REAL dispatch loop (same setupEngine harness) rather than unit-testing the internal
// check in isolation, matching every other scenario in this file.
describe("scenario 10: web tools — free by default, dangerous-domain floor (SP-approvals T10)", () => {
  /** A web tools registry whose `fetchFn` never hits the real network — records every URL it was
   *  asked to fetch and returns a small, successful text/html response. Mirrors engine-spawn.
   *  test.ts's own `buildWebDeferredRegistry` precedent (the established pattern for exercising a
   *  real web_fetch call through the engine with no live network). */
  function buildWebRegistry(): { registry: ToolRegistry; fetchCalls: string[] } {
    const registry = new ToolRegistry();
    const fetchCalls: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetchCalls.push(String(url));
      return new Response("<html><body><h1>hi</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    registerWebTools(registry, { fetchFn: fakeFetch });
    return { registry, fetchCalls };
  }

  /** One round: model calls web_fetch(url), then stops with tool_calls; round 2 ends the turn. */
  function webFetchTurn(url: string, callId = "c1"): ProviderEvent[][] {
    return [
      [{ type: "tool_call", callId, name: "web_fetch", argsJson: JSON.stringify({ url }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ];
  }

  test("web_search under ask runs cardless (NETWORK is now unconditionally allow)", async () => {
    const registry = new ToolRegistry();
    registerWebTools(registry, {}); // no fetchFn/secret needed — a no-key error still counts as "ran with no card"
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "web_search", argsJson: JSON.stringify({ query: "hello" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask" });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  test("web_fetch to a safe (non-dangerous) domain under ask runs cardless", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider(webFetchTurn("https://example.com/page"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask" });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(fetchCalls).toEqual(["https://example.com/page"]);
  });

  test("web_fetch to a SHIPPED dangerous domain (SUBDOMAIN hit) under ask -> card with Allow / Always allow all of <matched-entry> / Deny; the rule names the MATCHED ENTRY, not the raw host", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    // A SUBDOMAIN of the shipped "transfer.sh" entry — exercises the "matchedEntry !== host" case:
    // MEDIUM-1 (SP-approvals T10 review) says this label must read "Always allow all of
    // <matched-entry>" (not the raw host) — approving this actually grants the WHOLE family
    // (any subdomain of transfer.sh, not just uploads.transfer.sh), so the label says so honestly.
    const provider = new FakeProvider(webFetchTurn("https://uploads.transfer.sh/file1"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(approver(broker, sessionId, false), sessionId, 0); // deny — this test only cares about the card's shape

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.options).toEqual([
      { id: "allow_once", label: "Allow" },
      { id: "allow_source", label: "Always allow all of transfer.sh", rule: "WebFetch(domain:transfer.sh)", scope: "global" },
      { id: "deny", label: "Deny" },
    ]);
    expect(fetchCalls).toEqual([]); // denied — the fetch never ran
  });

  // MEDIUM-1 (SP-approvals T10 review): the OTHER half — an EXACT host hit (matchedEntry === host)
  // keeps the simple "Always allow <host>" wording, since approving it doesn't grant anything wider
  // than the one host that was actually fetched.
  test("web_fetch to a SHIPPED dangerous domain (EXACT host hit) under ask -> card label stays \"Always allow <host>\" (no \"all of\" wording — nothing wider is being granted)", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider(webFetchTurn("https://pastebin.com/raw/xyz"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.options).toEqual([
      { id: "allow_once", label: "Allow" },
      { id: "allow_source", label: "Always allow pastebin.com", rule: "WebFetch(domain:pastebin.com)", scope: "global" },
      { id: "deny", label: "Deny" },
    ]);
    expect(fetchCalls).toEqual([]);
  });

  // HIGH-1 (SP-approvals T10 review): a trailing-dot FQDN ("pastebin.com." — the literal DNS root
  // label) resolves identically to "pastebin.com" but, before the fix, sailed past dangerousDomainMatch
  // unmatched — a real bypass of the entire floor. Proven here end to end through the real dispatch
  // loop, not just at the dangerous-domains.ts/permission-rules.ts unit level.
  test("a trailing-dot FQDN does NOT bypass the floor — the card still fires", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider(webFetchTurn("https://pastebin.com./raw/x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.options.find((o: any) => o.id === "allow_source")).toMatchObject({ rule: "WebFetch(domain:pastebin.com)" });
    expect(fetchCalls).toEqual([]); // denied — the fetch never ran
  });

  test("a USER-ADDED dangerous domain (settings.permissions.dangerousDomains.added thunk) under ask -> card", async () => {
    const { registry } = buildWebRegistry();
    const provider = new FakeProvider(webFetchTurn("https://evil-example.net/x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, {
      registry, policy: "ask", dangerousDomainsAdded: ["evil-example.net"],
    });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.options).toEqual([
      { id: "allow_once", label: "Allow" },
      { id: "allow_source", label: "Always allow evil-example.net", rule: "WebFetch(domain:evil-example.net)", scope: "global" },
      { id: "deny", label: "Deny" },
    ]);
  });

  test("under AUTO policy the dangerous-domain card STILL fires — it is a floor, not an ask-only check", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider(webFetchTurn("https://pastebin.com/x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "auto" });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(fetchCalls).toEqual(["https://pastebin.com/x"]); // approved → ran
  });

  test("under PLAN policy the dangerous-domain card STILL fires — NETWORK is allowed in plan for research, but the floor still reaches there", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider(webFetchTurn("https://pastebin.com/x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "plan" });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(fetchCalls).toEqual(["https://pastebin.com/x"]); // approved → ran (plan still permits NETWORK itself)
  });

  test("an unparseable url arg -> card with ONLY Allow/Deny — no allow_source, since there is no valid host to name a rule for", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "not a url" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.options).toEqual([
      { id: "allow_once", label: "Allow" },
      { id: "deny", label: "Deny" },
    ]);
    expect(fetchCalls).toEqual([]);
  });

  test("a missing url arg entirely also fails closed to the Allow/Deny-only card", async () => {
    const { registry } = buildWebRegistry();
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({}) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested?.options).toEqual([{ id: "allow_once", label: "Allow" }, { id: "deny", label: "Deny" }]);
  });

  // LOW-3 (SP-approvals T10 review): a URL that PARSES but carries no hostname at all (a `file://`
  // URL — `new URL(...).hostname` is `""`) must also fail closed to the Allow/Deny-only card rather
  // than silently falling through as "no match" (`dangerousDomainMatch("", …)` would indeed return
  // null, which — before this fix — meant an empty-host URL ran with NO card at all). ssrfGuard
  // still backstops actual SSRF risk separately; this is about this floor's own consistency: no
  // valid host to check means no basis for concluding it's safe, so it must ask, exactly like the
  // unparseable-URL case just above.
  test("a URL with NO hostname (e.g. file://) also fails closed to the Allow/Deny-only card", async () => {
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "file:///etc/passwd" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.options).toEqual([{ id: "allow_once", label: "Allow" }, { id: "deny", label: "Deny" }]);
    expect(fetchCalls).toEqual([]);
  });

  test("full loop: dangerous fetch -> card -> respond allow_source -> rule persists GLOBALLY -> the NEXT fetch to the same domain AND a subdomain both run cardless", async () => {
    // A disk-backed globalAllow thunk (fresh readFileSync per call) — mirrors daemon.ts's real
    // `() => settings?.permissions?.allow` getter conceptually, minus the hot-settings-watcher
    // layer: since THIS thunk reads disk directly on every call, there is no propagation delay to
    // wait out (that layer exists purely so the DAEMON's in-memory settings stay live; a direct
    // PermissionRules consumer like this test needs no such caching at all).
    const normaHome = tmpDir("norma-pgo-home-");
    const settingsPath = join(normaHome, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } }));
    const globalAllow = (): string[] | undefined => {
      try {
        return JSON.parse(readFileSync(settingsPath, "utf8")).permissions?.allow;
      } catch {
        return undefined;
      }
    };
    const permissionRules = new PermissionRules({ globalAllow, normaHome });
    const { registry, fetchCalls } = buildWebRegistry();
    const provider = new FakeProvider([
      ...webFetchTurn("https://uploads.transfer.sh/file1", "c1"), // turn 1: a subdomain of the shipped "transfer.sh" entry
      ...webFetchTurn("https://transfer.sh/file2", "c2"), // turn 2: the bare matched entry itself
      ...webFetchTurn("https://another.transfer.sh/file3", "c3"), // turn 3: a DIFFERENT subdomain
    ]);
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
    // Mirrors ipc/server.ts's REAL approval.respond handler exactly (option lookup by id, append
    // BEFORE resolve) — see that handler's own doc comment for the ordering rationale — without
    // spinning up a real daemon/IPC layer just to prove the engine+PermissionRules wiring.
    hub.attach({
      clientName: "option-approver",
      deliver(e) {
        if (e.type === "approval_requested") {
          const option = e.options?.find((o) => o.id === "allow_source");
          if (option?.rule) permissionRules.append(option.rule, option.scope ?? "project", null);
          broker.resolve(sessionId, e.callId, true, "option-approver");
        }
        return true;
      },
    }, sessionId, 0);

    await engine.runTurn(sessionId); // turn 1: dangerous fetch, card, approved via allow_source
    let events = store.read(sessionId);
    expect(events.filter((e) => e.type === "approval_requested").length).toBe(1);
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).permissions.allow).toEqual(["WebFetch(domain:transfer.sh)"]);

    await engine.runTurn(sessionId); // turn 2: the bare matched entry — must run cardless
    await engine.runTurn(sessionId); // turn 3: a different subdomain — must ALSO run cardless

    events = store.read(sessionId);
    expect(events.filter((e) => e.type === "approval_requested").length).toBe(1); // still just the ONE card from turn 1
    expect(fetchCalls).toEqual([
      "https://uploads.transfer.sh/file1",
      "https://transfer.sh/file2",
      "https://another.transfer.sh/file3",
    ]);
  });
});

// SP-approvals Task 11 (spec §8): bash's two escalation args. `allowNetwork` widens the sandbox
// (write fence intact, network on for that one call) — under `ask` it cards like a normal bash
// call (rule-silenceable), under `auto` it runs cardless (reviewer still applies, exactly like
// today's plain bash). `dangerouslyDisableSandbox` (CC's exact name) is a full escape. SP-policies
// Task 11 reworked its SP-approvals always-card floor into a mode split (full matrix in
// policy-escape.test.ts): a BashUnsandboxed(<prefix>:*) rule now pre-clears it silently, `auto` lets
// the reviewer GATE it (safe → runs unattended, non-safe → the human card), and `ask`/`accept-edits`
// still card with the reviewer only annotating. The card now offers project/global BashUnsandboxed
// rule options — a plain Bash rule and the readOnlyBash classifier still never silence an escape.
// Pinned below: the no-rule ask/auto-no-reviewer card paths + plan/deny (the rule pre-clear and the
// auto-safe run live in policy-escape.test.ts). Every test below drives the REAL dispatch loop
// (setupEngine's harness) per this file's own established precedent, using the stub bash registry
// (engine-reviewer.test.ts's stubRegistry/bashTurn, now escalation-arg-aware) so no real sandbox-exec
// is needed — the actual sandboxed/unsandboxed SPAWN behavior is covered separately, end to end, in
// tools-bash.test.ts.
describe("scenario 11: bash escalation args — allowNetwork + dangerouslyDisableSandbox (SP-approvals T11)", () => {
  describe("dangerouslyDisableSandbox: cards under ask / auto-with-no-reviewer; no plain-Bash rule or classifier silences it", () => {
    test("auto policy + dangerouslyDisableSandbox:true, NO reviewer -> still cards (auto's reviewer GATE needs a reviewer; with none it falls to the human card)", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("rm -rf x", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "auto" });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.summary).toBe("bash (UNSANDBOXED): rm -rf x");
      // SP-policies Task 11: the escape card now carries standing BashUnsandboxed(<prefix>:*) memory
      // (project/global) — suggestBashPrefix("rm -rf x") === "rm". (The auto-safe reviewer-GATE run and
      // the BashUnsandboxed rule pre-clear are covered in policy-escape.test.ts.)
      expect(requested.options).toEqual([
        { id: "allow_once", label: "Allow once" },
        { id: "allow_unsandboxed_project", label: 'Always allow "BashUnsandboxed(rm:*)" in this project', rule: "BashUnsandboxed(rm:*)", scope: "project" },
        { id: "allow_unsandboxed_global", label: 'Always allow "BashUnsandboxed(rm:*)" everywhere', rule: "BashUnsandboxed(rm:*)", scope: "global" },
        { id: "deny", label: "Deny" },
      ]);
      expect(calls.length).toBe(1); // approved -> ran
    });

    test("ask policy + dangerouslyDisableSandbox:true -> cards too (same shape as auto)", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.summary).toBe("bash (UNSANDBOXED): docker ps");
      expect(calls.length).toBe(1);
    });

    test("a human DENY on the unsandboxed card means the tool never runs", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "auto" });
      hub.attach(approver(broker, sessionId, false), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      expect(calls.length).toBe(0);
    });

    test("a GLOBAL Bash(rm:*) rule matching the exact command still does not silence the card", async () => {
      // Contrast: WITHOUT dangerouslyDisableSandbox this exact rule+command combo would run
      // cardless (scenario 1's own proof, same mechanism) — proving here that adding the flag is
      // what changes the outcome, not some other difference between the two tests.
      const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(rm:*)"], normaHome: tmpDir("norma-pgo-home-") });
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("rm -rf x", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "approval_requested")).toBe(true); // card still fired despite the matching rule
      expect(calls.length).toBe(1); // approved -> ran
    });

    test("readOnlyBash-classified command (`cat f`) + dangerouslyDisableSandbox:true still cards (classifier cannot silence it either)", async () => {
      const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("cat f", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "approval_requested")).toBe(true);
      expect(calls.length).toBe(1);
    });

    test("plan policy still denies outright — the unsandboxed floor never even gets consulted", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("rm -rf x", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "plan" });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "approval_requested")).toBe(false); // plan denies silently, no card
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      expect(result.output.toLowerCase()).toContain("plan mode");
      expect(calls.length).toBe(0);
    });

    test("a background (runInBackground:true) dangerouslyDisableSandbox call gets the SAME always-card gating", async () => {
      const registry = new ToolRegistry();
      const calls: Array<{ command: string }> = [];
      registry.register({
        name: "bash",
        description: "stub bash (bg-aware)",
        args: z.object({ command: z.string(), runInBackground: z.boolean().optional(), dangerouslyDisableSandbox: z.boolean().optional(), allowNetwork: z.boolean().optional() }),
        run({ command }) {
          calls.push({ command });
          return `background task bg_stub started`;
        },
      });
      const provider = new FakeProvider([
        [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "sleep 30", runInBackground: true, dangerouslyDisableSandbox: true }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
      ]);
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "auto" });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.summary).toBe("bash (UNSANDBOXED): sleep 30");
      expect(calls.length).toBe(1); // approved -> the bg-flavored run() executed
    });
  });

  // SP-approvals T11 review, MEDIUM-1 (CC parity: an unsandboxed retry still rides the normal review
  // path). Under `ask`/`accept-edits` the reviewer is consulted BEFORE the card but strictly as an
  // ANNOTATION: its verdict never auto-approves/denies, never adds/removes options, never skips or
  // replaces the card — only its `.reason` threads into `reviewerReason`; a reviewer failure/timeout
  // degrades to no annotation, never to no card. SP-policies Task 11 changed ONE thing: under `auto`
  // the reviewer now GATES (safe → runs unattended with no card; non-safe → the card) — the auto test
  // below is updated to that; the ask-policy annotation cases are unchanged. Full gate matrix in
  // policy-escape.test.ts.
  describe("MEDIUM-1: under ask the reviewer only ANNOTATES the escape card; under auto it GATES (SP-policies Task 11)", () => {
    test("reviewer returns a verdict+reason -> the card carries reviewerReason, tool_review is emitted, and the human (not the verdict) still decides — an UNSAFE verdict does not auto-deny", async () => {
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_UNSANDBOXED_ANNOTATION" });
      const provider = new FakeProvider(bashTurn("docker run --privileged x", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask" });
      hub.attach(approver(broker, sessionId, true), sessionId, 0); // human approves DESPITE the unsafe verdict

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "bash", verdict: "unsafe", reason: "REASON_UNSANDBOXED_ANNOTATION" });
      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.reviewerReason).toBe("REASON_UNSANDBOXED_ANNOTATION");
      // The verdict never mutates the option set: an unsafe annotation adds no "escalation" option and
      // removes none — the card shows the SAME BashUnsandboxed(<prefix>:*) escape options a safe (or
      // absent) verdict would (SP-policies Task 11). suggestBashPrefix("docker run --privileged x") === "docker run".
      expect(requested.options).toEqual([
        { id: "allow_once", label: "Allow once" },
        { id: "allow_unsandboxed_project", label: 'Always allow "BashUnsandboxed(docker run:*)" in this project', rule: "BashUnsandboxed(docker run:*)", scope: "project" },
        { id: "allow_unsandboxed_global", label: 'Always allow "BashUnsandboxed(docker run:*)" everywhere', rule: "BashUnsandboxed(docker run:*)", scope: "global" },
        { id: "deny", label: "Deny" },
      ]);
      expect(calls.length).toBe(1); // human approved -> ran, DESPITE the unsafe verdict (annotation only, never a gate)
      expect(reviewer.seen).toEqual([{ class: "bash", command: "docker run --privileged x", justification: undefined }]);
    });

    test("reviewer THROWS -> the card fires WITHOUT a reviewerReason (fail-open on the annotation, never on the card)", async () => {
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer("throw");
      const provider = new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask" });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      // Still exactly one tool_review, "error" verdict — same degradation reviewAndDispatch's own
      // bash branch already uses for a throwing reviewer, reused here.
      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "bash", verdict: "error" });
      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.reviewerReason).toBeUndefined(); // no annotation
      expect(requested.summary).toBe("bash (UNSANDBOXED): docker ps"); // the card itself is unaffected
      expect(calls.length).toBe(1); // approved -> ran regardless — the card fired despite the reviewer failure
    });

    test("under AUTO the reviewer GATES the escape: a 'safe' verdict runs it UNATTENDED with no card (SP-policies Task 11)", async () => {
      // Was: "auto still cards, annotation attaches". SP-policies Task 11 makes the reviewer the GATE
      // under auto — a safe verdict now runs the escape unattended (no card). The auto+UNSAFE→card
      // path and the ask-annotation path are covered in policy-escape.test.ts / the ask test above.
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "safe", reason: "REASON_UNSANDBOXED_AUTO" });
      const provider = new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "auto" });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      // The reviewer ran (exactly one tool_review, safe) and its verdict GATED — no human card fired.
      expect(events.some((e) => e.type === "approval_requested")).toBe(false);
      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "bash", verdict: "safe", reason: "REASON_UNSANDBOXED_AUTO" });
      expect(reviewer.seen).toEqual([{ class: "bash", command: "docker ps", justification: undefined }]);
      expect(calls.length).toBe(1); // ran unsandboxed, unattended
    });

    test("no reviewer configured -> byte-identical to before this fix: no tool_review, no reviewerReason", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" }); // no `reviewer` opt
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "tool_review")).toBe(false);
      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.reviewerReason).toBeUndefined();
      expect(calls.length).toBe(1);
    });
  });

  // SP-approvals T11 review, LOW-2: pin the precedence when a (malformed/adversarial) call sets
  // BOTH escalation args at once — dangerouslyDisableSandbox must win outright: the card is the
  // UNSANDBOXED one, carrying its own BashUnsandboxed(<prefix>:*) options (SP-policies Task 11),
  // never the "(with network)" one (which would carry the plain Bash(<prefix>:*) options instead).
  describe("LOW-2: both flags set at once -> dangerouslyDisableSandbox wins outright", () => {
    test("allowNetwork:true AND dangerouslyDisableSandbox:true -> the card is UNSANDBOXED (BashUnsandboxed options), not \"(with network)\" (Bash options)", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("curl https://example.com", undefined, { allowNetwork: true, dangerouslyDisableSandbox: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.summary).toBe("bash (UNSANDBOXED): curl https://example.com"); // NOT "(with network)"
      // The ESCAPE options (BashUnsandboxed(curl:*)) — NOT allowNetwork's Bash(curl:*) shape.
      expect(requested.options).toEqual([
        { id: "allow_once", label: "Allow once" },
        { id: "allow_unsandboxed_project", label: 'Always allow "BashUnsandboxed(curl:*)" in this project', rule: "BashUnsandboxed(curl:*)", scope: "project" },
        { id: "allow_unsandboxed_global", label: 'Always allow "BashUnsandboxed(curl:*)" everywhere', rule: "BashUnsandboxed(curl:*)", scope: "global" },
        { id: "deny", label: "Deny" },
      ]);
      expect(calls.length).toBe(1);
      expect(calls[0]?.allowNetwork).toBe(true); // both flags still reach the tool unchanged — only the CARD's shape is affected
      expect(calls[0]?.dangerouslyDisableSandbox).toBe(true);
    });
  });

  describe("allowNetwork: rule-silenceable ask-card; classifier can NEVER silence it; auto stays cardless", () => {
    test("ask policy, no rule, allowNetwork:true -> cards as \"bash (with network): <cmd>\" with the STANDARD allow-similar options", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("git push", undefined, { allowNetwork: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.summary).toBe("bash (with network): git push");
      expect(requested.options).toEqual([
        { id: "allow_once", label: "Allow once" },
        { id: "allow_project", label: 'Allow "Bash(git push:*)" in this project', rule: "Bash(git push:*)", scope: "project" },
        { id: "allow_global", label: 'Allow "Bash(git push:*)" everywhere', rule: "Bash(git push:*)", scope: "global" },
        { id: "deny", label: "Deny" },
      ]);
      expect(calls.length).toBe(1); // approved -> ran
      expect(calls[0]?.allowNetwork).toBe(true); // the flag reached the tool
    });

    test("readOnlyBash-classified command (`cat x`, NO rule) + allowNetwork:true still CARDS — the classifier never covers a network call", async () => {
      // Contrast with scenario 2's own proof that `cat f` WITHOUT allowNetwork runs cardless under
      // the exact same policy/rule setup — isolating allowNetwork as what forces the card here.
      const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("cat x", undefined, { allowNetwork: true }));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
      hub.attach(approver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "approval_requested")).toBe(true);
      expect(calls.length).toBe(1);
    });

    test("a matching Bash(prefix:*) rule DOES silence an allowNetwork call — cardless, runs directly", async () => {
      const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(git push:*)"], normaHome: tmpDir("norma-pgo-home-") });
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("git push", undefined, { allowNetwork: true }));
      const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "approval_requested")).toBe(false);
      expect(calls).toEqual([{ command: "git push", justification: undefined, allowNetwork: true, dangerouslyDisableSandbox: undefined }]);
    });

    test("rule-allowed allowNetwork call under ASK now runs with NO reviewer (SP-policies Task 8)", async () => {
      // Pre-SP-policies this rule-allowed (+ allowNetwork) call still rode the AI reviewer under
      // `ask` and an "unsafe" verdict escalated to a card; Task 8's auto-only reviewer means a rule
      // match under `ask` is a human pre-authorization regardless of allowNetwork — the call now
      // just runs, unreviewed (the "unsafe" stub verdict below would still escalate+deny if the
      // reviewer were wrongly consulted, so a regression here fails loudly).
      const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(npm install:*)"], normaHome: tmpDir("norma-pgo-home-") });
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_NETWORK_RULE" });
      const provider = new FakeProvider(bashTurn("npm install", undefined, { allowNetwork: true }));
      const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask", permissionRules });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "tool_review")).toBe(false);
      expect(events.some((e) => e.type === "approval_requested")).toBe(false);
      expect(reviewer.seen.length).toBe(0);
      expect(calls).toEqual([{ command: "npm install", justification: undefined, allowNetwork: true, dangerouslyDisableSandbox: undefined }]);
    });

    test("auto policy + allowNetwork:true -> runs cardless (reviewer still applies)", async () => {
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "safe", reason: "REASON_NETWORK_AUTO" });
      const provider = new FakeProvider(bashTurn("npm install", undefined, { allowNetwork: true }));
      const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "auto" });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card
      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "bash", verdict: "safe", reason: "REASON_NETWORK_AUTO" }); // but reviewed
      expect(calls.length).toBe(1);
    });

    test("plan policy denies outright regardless of allowNetwork", async () => {
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider(bashTurn("git push", undefined, { allowNetwork: true }));
      const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "plan" });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      expect(events.some((e) => e.type === "approval_requested")).toBe(false);
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      expect(result.output.toLowerCase()).toContain("plan mode");
      expect(calls.length).toBe(0);
    });

    test("full loop: allowNetwork card -> respond allow_project -> rule persists -> the NEXT allowNetwork call with the same prefix runs cardless", async () => {
      const cwd = tmpDir("norma-pgo-cwd-");
      const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
      const { registry, calls } = stubRegistry();
      const provider = new FakeProvider([
        ...bashTurn("git push origin main", undefined, { allowNetwork: true }),
        ...bashTurn("git push origin main", undefined, { allowNetwork: true }),
      ]);
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, cwd, policy: "ask", permissionRules });
      // Mirrors ipc/server.ts's real approval.respond handler (option lookup by id, append BEFORE
      // resolve) — same precedent as scenario 10's own "full loop" test.
      hub.attach({
        clientName: "option-approver",
        deliver(e) {
          if (e.type === "approval_requested") {
            const option = e.options?.find((o) => o.id === "allow_project");
            if (option?.rule) permissionRules.append(option.rule, option.scope ?? "project", cwd);
            broker.resolve(sessionId, e.callId, true, "option-approver");
          }
          return true;
        },
      }, sessionId, 0);

      await engine.runTurn(sessionId); // turn 1: cards, approved via allow_project
      let events = store.read(sessionId);
      expect(events.filter((e) => e.type === "approval_requested").length).toBe(1);
      const rulesFile = JSON.parse(readFileSync(join(cwd, ".norma", "permissions.local.json"), "utf8"));
      expect(rulesFile.allow).toEqual(["Bash(git push:*)"]);

      await engine.runTurn(sessionId); // turn 2: same prefix, allowNetwork again -> must run cardless

      events = store.read(sessionId);
      expect(events.filter((e) => e.type === "approval_requested").length).toBe(1); // still just the one card
      expect(calls.length).toBe(2); // both turns ran
    });
  });
});

// SP-approvals final review (composition hole, HIGH): with an Edit rule in force — the feature's
// most-encouraged click — the agent could `write`/`edit` <projectRoot>/.norma/permissions.local.json
// CARDLESS (an Edit rule matches write/edit generically; the fs safety reviewer is auto-only, so it
// never sees an ask-policy call either) and mint itself a NEW rule, e.g.
// `WebFetch(domain:webhook.site)` — which webFetchGate (scenario 10, T10 §7) then treats as an
// already-approved standing exception, silencing the dangerous-domain floor for a zero-card exfil
// fetch. The rules store must be mutable ONLY via PermissionRules.append() (a human answering an
// approval card's "always allow" option) or a human's own editor — never through the agent's own
// write/edit tools, no matter what rule is in force. Fixed with a hard error in engine.ts's
// dispatch loop (checked BEFORE the ruleAllowed computation, mirroring dirGrantDenied's own
// control-plane branch style) plus a seatbelt-level carve-out (sandbox.test.ts / tools-bash.test.ts)
// for the bash-invoked write path the engine-level check can't see into.
describe("scenario 12: the permission-rules store is never agent-writable (SP-approvals final review)", () => {
  test("(a) Edit rule in force + write targeting .norma/permissions.local.json → hard error, no approval_requested, file unchanged", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(".norma/permissions.local.json", JSON.stringify({ allow: ["WebFetch(domain:webhook.site)"] })));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot write .norma/permissions.local.json");
    expect(result.output).toContain("the permission rules store can only be changed by answering an approval card (or editing it yourself)");
    expect(existsSync(join(cwd, ".norma", "permissions.local.json"))).toBe(false); // never landed
  });

  test("(b) same hard error via the edit tool (Edit rule maps write AND edit call names identically)", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "edit", argsJson: JSON.stringify({ path: ".norma/permissions.local.json", old_string: "x", new_string: "y" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, store, sessionId, cwd } = setupEngine(provider, { policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot edit .norma/permissions.local.json");
    expect(result.output).toContain("the permission rules store can only be changed by answering an approval card (or editing it yourself)");
    expect(existsSync(join(cwd, ".norma", "permissions.local.json"))).toBe(false);
  });

  test("(c) FULL EXFIL CHAIN: Edit rule → self-authored WebFetch(domain:webhook.site) rule attempt hard-errors → web_fetch to webhook.site STILL cards (the §7 floor survives)", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const registry = new ToolRegistry();
    const fetchCalls: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetchCalls.push(String(url));
      return new Response("<html><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    registerWebTools(registry, { fetchFn: fakeFetch });
    const provider = new FakeProvider([
      [
        { type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: ".norma/permissions.local.json", content: JSON.stringify({ allow: ["WebFetch(domain:webhook.site)"] }) }) },
        { type: "tool_call", callId: "c2", name: "web_fetch", argsJson: JSON.stringify({ url: "https://webhook.site/exfil-target" }) },
        { type: "done", stopReason: "tool_calls" },
      ],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const { engine, store, hub, broker, sessionId, cwd } = setupEngine(provider, { registry, policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, false), sessionId, 0); // deny the web_fetch card — this test only cares that it CARDS at all

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // Step 1: the self-authored rule injection hard-errored — nothing was ever written.
    const writeResult = events.find((e) => e.type === "tool_result" && (e as any).callId === "c1") as any;
    expect(writeResult.isError).toBe(true);
    expect(existsSync(join(cwd, ".norma", "permissions.local.json"))).toBe(false);

    // Step 2: web_fetch to the exact domain the (failed) injection targeted still CARDS — the
    // dangerous-domain floor was never silenced, because no rule ever actually landed.
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.summary).toContain("webhook.site");
    expect(fetchCalls).toEqual([]); // denied — the exfil fetch never actually ran
  });

  test("(d) a write to .norma/memory/whatever.md (the MEMDIR) with the SAME Edit rule → still runs cardless — the carve-out is file-specific, not directory-blanket", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(".norma/memory/whatever.md", "some memory content"));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(join(cwd, ".norma", "memory", "whatever.md"), "utf8")).toBe("some memory content");
  });

  // SP-approvals final review 2: the closing re-review reproduced THREE live bypasses of (a)/(b)
  // above on the default case-insensitive-but-case-preserving macOS volume format — a literal
  // string compare of basenames (the FIRST version of this fix) missed all three, because the
  // reader (permission-rules.ts's projectRulesFor) opens the file by plain `join(root, ".norma",
  // "permissions.local.json")`, which the real filesystem resolves case-insensitively and through
  // symlinks — so every one of these "different-looking" writes landed on the SAME real file the
  // reader would pick right back up. Each of the three tests below was a REPRODUCED, LIVE bypass
  // before the filesystem-identity fix; each must hard-error exactly like the exact-spelling case.
  test("(e) BYPASS (fixed): a differently-cased FILENAME — .norma/Permissions.Local.json → hard error, file never created", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(".norma/Permissions.Local.json", JSON.stringify({ allow: ["WebFetch(domain:webhook.site)"] })));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("the permission rules store can only be changed by answering an approval card (or editing it yourself)");
    expect(existsSync(join(cwd, ".norma", "Permissions.Local.json"))).toBe(false);
    expect(existsSync(join(cwd, ".norma", "permissions.local.json"))).toBe(false);
  });

  test("(f) BYPASS (fixed): a differently-cased DIRECTORY — .NORMA/permissions.local.json → hard error, file never created", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(".NORMA/permissions.local.json", JSON.stringify({ allow: ["WebFetch(domain:webhook.site)"] })));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("the permission rules store can only be changed by answering an approval card (or editing it yourself)");
    expect(existsSync(join(cwd, ".NORMA"))).toBe(false);
    expect(existsSync(join(cwd, ".norma"))).toBe(false);
  });

  test("(g) BYPASS (fixed): .norma is a PRE-CREATED SYMLINK to a real directory elsewhere — writing through it → hard error, nothing landed on either side of the symlink", async () => {
    const cwd = tmpDir("norma-pgo-cwd-");
    const realDir = tmpDir("norma-pgo-realdir-");
    symlinkSync(realDir, join(cwd, ".norma"));
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(".norma/permissions.local.json", JSON.stringify({ allow: ["WebFetch(domain:webhook.site)"] })));
    const { engine, store, sessionId } = setupEngine(provider, { policy: "ask", permissionRules, cwd });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("the permission rules store can only be changed by answering an approval card (or editing it yourself)");
    expect(existsSync(join(realDir, "permissions.local.json"))).toBe(false); // nothing landed through the symlink
    expect(existsSync(join(cwd, ".norma", "permissions.local.json"))).toBe(false); // nor via the symlinked spelling
  });
});
