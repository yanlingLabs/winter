import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
// of an out-of-root write's own grant card, and NEVER in a way that lets the AI safety reviewer be
// skipped for bash once a rule/classifier allows it.

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
    // The grant-flavored summary (engine.ts's dirGrant branch), NOT the generic approvalCardSummary
    // — proves this rode the SAME out-of-root grant seam a ruleless call would, not a rule-skip.
    expect(requested.summary).toContain("outside the allowed directories");
    expect(requested.summary).toContain(`grant write access to ${outsideDir}`);
    expect(readFileSync(target, "utf8")).toBe("should still need a grant"); // approved → grant applied → write landed
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

describe("scenario 6/7: a rule- or classifier-allowed bash call still rides the AI safety reviewer when configured", () => {
  test("6. rule-allowed (Bash(npm test:*)) + reviewer configured, unsafe verdict → escalation card appears DESPITE the matching rule", async () => {
    // "npm test" is rule-matched but NOT readOnlyBash-classified (npm's read-only subcommands are
    // only ls/view/outdated) — isolates the RULE as the sole source of ruleAllowed.
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(npm test:*)"], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_RULE_BASH" });
    const provider = new FakeProvider(bashTurn("npm test"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "unsafe", reason: "REASON_RULE_BASH" });
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.reviewerReason).toBe("REASON_RULE_BASH");
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(calls.length).toBe(0); // never ran — reviewer said unsafe, human denied
    expect(reviewer.seen).toEqual([{ class: "bash", command: "npm test", justification: undefined }]);
  });

  test("7. classifier-allowed (`git log --oneline -5`, no rule at all) + reviewer configured, safe verdict → reviewer WAS consulted, bash ran", async () => {
    // No rule anywhere — readOnlyBash alone is what flips ruleAllowed here, isolating the
    // CLASSIFIER as the sole source (spec: both sources must ride the same reviewer branch).
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "safe", reason: "REASON_CLASSIFIER_BASH" });
    const provider = new FakeProvider(bashTurn("git log --oneline -5"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // safe verdict, no escalation
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "safe", reason: "REASON_CLASSIFIER_BASH" });
    expect(reviewer.seen.length).toBe(1); // the reviewer was genuinely consulted, not bypassed
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
