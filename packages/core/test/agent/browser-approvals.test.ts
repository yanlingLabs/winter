import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalOption } from "@norma/protocol";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBrowserTool, type BrowserToolDeps } from "../../src/agent/tools/browser";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { PermissionRules } from "../../src/agent/permission-rules";
import { setupEngine } from "./engine-steer.test";

/**
 * b2-agent-browser T6 — the browser's domain approvals, driven through the REAL dispatch loop.
 *
 * Spec §4's decision is "no new approval category": the browser rides the SAME per-domain mechanism
 * `web_fetch` already has. That claim is only checkable end to end, because the mechanism is spread
 * across four places (gate.ts's class, engine.ts's `browserGate`, the shared
 * `webFetchApprovalOptions`, and permission-rules.ts's `WebFetch(domain:…)` grammar) — so every row
 * here runs a real turn through `setupEngine` and observes what the human was offered and what the
 * tool actually did, never a helper in isolation.
 *
 * **The REAL browser tool is registered**, not a stub (unlike policy-modes-matrix.test.ts's
 * `stubWebFetchRegistry`, which can afford one because web_fetch's whole floor lives in the engine).
 * Here the two halves of the mechanism live on opposite sides of the seam — the CARD is the engine's
 * and the REFUSAL is the tool's — so a stub would test one half against nothing. What it costs is a
 * fake `dispatch` (the panel command channel), which is exactly spec §9's prescribed posture: "the
 * daemon tool [is tested] through the fake transport".
 */

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** On dangerous-domains.ts's SHIPPED list (anonymous one-shot upload host) — the same host
 *  policy-modes-matrix.test.ts drives web_fetch's floor with, deliberately: the two mechanisms are
 *  meant to be the same one, so they are exercised on the same domain. */
const DANGEROUS = "https://transfer.sh/x";
/** On nothing. The control that makes "no new category" a measurable claim rather than a promise. */
const ORDINARY = "https://example.com/docs";

type Policy = "plan" | "dont-ask" | "ask" | "accept-edits" | "auto" | "bypass" | "chat";

interface Obs {
  /** Did an `approval_requested` fire? */
  carded: boolean;
  /** Options the human was actually offered, from the emitted event (undefined when no card). */
  options?: ApprovalOption[];
  /** The card's summary text (undefined when no card). */
  summary?: string;
  /** Commands that reached the (fake) panel channel — empty means the tool refused before dispatch. */
  dispatched: Array<{ action: string; url?: string; args?: Record<string, unknown> }>;
  /** Tabs minted by `verb:"open"` — `open` never travels the command channel. */
  opened: string[];
  isError: boolean;
  output: string;
}

function browserTurn(args: Record<string, unknown>): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "browser", argsJson: JSON.stringify(args) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
}

/** One session's worth of panel state: a single web tab, active, and an attached Mac app — the
 *  minimum that gets a command verb past the ownership and availability rungs so the DOMAIN rung is
 *  the one under test. */
function browserRegistry(): { registry: ToolRegistry; obs: Pick<Obs, "dispatched" | "opened"> } {
  const registry = new ToolRegistry();
  const dispatched: Obs["dispatched"] = [];
  const opened: string[] = [];
  const deps: BrowserToolDeps = {
    tabs: () => ({ tabs: [{ tabId: "t1", kind: "web", url: "https://example.com" }], activeTabId: "t1" }),
    openTab(p) { opened.push(p.url ?? ""); return "t-new"; },
    dispatch(cmd) {
      dispatched.push({ action: cmd.action, url: cmd.url, args: cmd.args });
      return { commandId: "pcmd_1", settled: Promise.resolve({ kind: "result", ok: true, result: "did it" }) };
    },
    harnesses: () => [{ clientName: "orb", role: "harness" }],
  };
  registerBrowserTool(registry, deps);
  return { registry, obs: { dispatched, opened } };
}

/** Drive one cell. An always-approve watcher answers any card that fires (mirroring
 *  policy-modes-matrix.test.ts's idiom), so "carded" cells still proceed to execution and the
 *  APPROVED path — the daemon stamp reaching the tool — is exercised by the same run that pins the
 *  card. A cell that must not card is proven by `carded: false`, not by the absence of a hang. */
async function drive(policy: Policy, args: Record<string, unknown>, opts?: {
  rule?: string;
  toolName?: string;
  provider?: FakeProvider;
}): Promise<Obs> {
  const cwd = tmp("norma-b6-cwd-");
  const normaHome = tmp("norma-b6-home-");
  const { registry, obs } = browserRegistry();
  const permissionRules = new PermissionRules({ globalAllow: () => (opts?.rule ? [opts.rule] : []), normaHome });
  const provider = opts?.provider ?? new FakeProvider(browserTurn(args));
  const { engine, store, hub, broker, sessionId } = setupEngine(provider, {
    registry, policy: policy as never, cwd, permissionRules,
  });
  hub.attach({
    clientName: "auto-approver",
    deliver(e: never) {
      const ev = e as unknown as { type: string; callId: string };
      if (ev.type === "approval_requested") broker.resolve(sessionId, ev.callId, true, "auto-approver");
      return true;
    },
  } as never, sessionId, 0);
  await engine.runTurn(sessionId);
  const events = store.read(sessionId);
  const card = events.find((e) => e.type === "approval_requested") as unknown as
    { summary: string; options?: ApprovalOption[] } | undefined;
  const result = events.find((e) => e.type === "tool_result") as unknown as
    { isError: boolean; output: string } | undefined;
  return {
    carded: card !== undefined,
    options: card?.options,
    summary: card?.summary,
    dispatched: obs.dispatched,
    opened: obs.opened,
    isError: !!result?.isError,
    output: result?.output ?? "",
  };
}

const EVERY_POLICY: Policy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass", "chat"];
/** Spec §4's attended set — where a human is there to answer (engine.ts's BROWSER_PROMPT_POLICIES). */
const PROMPTING: Policy[] = ["ask", "accept-edits", "plan"];
/** Spec §4's unattended set + the two policies that never prompt by definition. */
const NEVER_ASK: Policy[] = ["chat", "dont-ask", "auto", "bypass"];

describe("b2-t6: an ORDINARY domain is never gated — the 'no new approval category' pin", () => {
  // THE control row, and the one that makes every other row in this file mean something. Fetch has
  // been free by default since SP-approvals T10 (gate.ts: "web tools become free by default"); the
  // browser inherits THAT mechanism, so an unremarkable https host must flow with no card in every
  // policy, including the attended ones. A build that prompted per-new-domain would pass every
  // other test here and fail this one — which is exactly what it is for.
  for (const policy of EVERY_POLICY) {
    test(`navigate to an ordinary domain under ${policy}: no card, dispatched`, async () => {
      const o = await drive(policy, { verb: "navigate", url: ORDINARY });
      expect({ policy, carded: o.carded, dispatched: o.dispatched.length, isError: o.isError })
        .toEqual({ policy, carded: false, dispatched: 1, isError: false });
    });
  }
});

describe("b2-t6: a DANGEROUS domain with no standing rule", () => {
  for (const policy of PROMPTING) {
    test(`${policy}: cards ONCE, and the approved navigation then reaches the browser`, async () => {
      const o = await drive(policy, { verb: "navigate", url: DANGEROUS });
      expect({ policy, carded: o.carded, dispatched: o.dispatched.length, isError: o.isError })
        .toEqual({ policy, carded: true, dispatched: 1, isError: false });
      expect(o.dispatched[0]?.url).toBe(DANGEROUS);
    });
  }

  for (const policy of NEVER_ASK) {
    test(`${policy}: NO card, nothing dispatched — Task 4's hard block is the whole answer`, async () => {
      const o = await drive(policy, { verb: "navigate", url: DANGEROUS });
      expect({ policy, carded: o.carded, dispatched: o.dispatched.length, isError: o.isError })
        .toEqual({ policy, carded: false, dispatched: 0, isError: true });
      expect(o.output).toContain("dangerous-domain list");
      // Fix round 1, Minor 2: the refusal must not imply an escape that cannot be reached HERE. The
      // string is mode-invariant (this tool has no policy in ctx, by design), so the only way it can
      // be true in this cell is by naming the unattended regime out loud — including for a user who
      // holds a standing rule and would otherwise be told "no approval covers this one" while their
      // approval exists and is being ignored by policy. One fragment, on the cell where it matters.
      expect(o.output).toContain("deliberately inert");
    });
  }

  test("`open` is the second URL door and is gated identically — no tab is minted under a never-ask policy", async () => {
    const blocked = await drive("auto", { verb: "open", url: DANGEROUS });
    expect({ carded: blocked.carded, opened: blocked.opened.length, isError: blocked.isError })
      .toEqual({ carded: false, opened: 0, isError: true });
    const approved = await drive("ask", { verb: "open", url: DANGEROUS });
    expect({ carded: approved.carded, opened: approved.opened, isError: approved.isError })
      .toEqual({ carded: true, opened: [DANGEROUS], isError: false });
  });
});

describe("b2-t6: the REMEMBERED rule — fetch's own kind, and nothing new", () => {
  // The rule string is not re-spelled by this task: `browserGate` calls the SAME
  // `webFetchApprovalOptions` webFetchGate does. This row proves that at the only place it can be
  // observed from outside — the options the HUMAN is offered, on the wire, in the emitted event.
  test("THE RULE-KIND PIN: the browser card offers byte-identical options to the web_fetch card for the same host", async () => {
    const browserCard = await drive("ask", { verb: "navigate", url: DANGEROUS });
    // The same host through the OTHER tool, so the comparison is against the real thing rather than
    // a literal transcribed from it. web_fetch's floor is engine-side and name-keyed, so a stub tool
    // exercises it (the precedent policy-bypass-floors.test.ts and the policy matrix both use).
    const registry = new ToolRegistry();
    registry.register({
      name: "web_fetch", description: "stub web_fetch",
      args: (await import("zod")).z.object({ url: (await import("zod")).z.string() }),
      run: ({ url }: { url: string }) => `fetched ${url}`,
    });
    const cwd = tmp("norma-b6-wf-cwd-");
    const normaHome = tmp("norma-b6-wf-home-");
    const { engine, store, hub, broker, sessionId } = setupEngine(
      new FakeProvider([
        [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: DANGEROUS }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
      ]),
      { registry, policy: "ask", cwd, permissionRules: new PermissionRules({ globalAllow: () => [], normaHome }) },
    );
    hub.attach({
      clientName: "auto-approver",
      deliver(e: never) {
        const ev = e as unknown as { type: string; callId: string };
        if (ev.type === "approval_requested") broker.resolve(sessionId, ev.callId, true, "auto-approver");
        return true;
      },
    } as never, sessionId, 0);
    await engine.runTurn(sessionId);
    const fetchCard = store.read(sessionId).find((e) => e.type === "approval_requested") as unknown as
      { options?: ApprovalOption[] } | undefined;

    expect(browserCard.options).toEqual(fetchCard?.options);
    // Asserted absolutely as well, so the comparison cannot pass by both being wrong — and spelled
    // out literally, because THIS STRING is what lands in settings.json's permissions.allow. A NEW
    // rule kind appearing here is the failure this pin exists for.
    expect(browserCard.options).toEqual([
      { id: "allow_once", label: "Allow" },
      { id: "allow_source", label: "Always allow transfer.sh", rule: "WebFetch(domain:transfer.sh)", scope: "global" },
      { id: "deny", label: "Deny" },
    ]);
  });

  for (const policy of PROMPTING) {
    test(`${policy}: a standing WebFetch(domain:transfer.sh) rule flows with NO card`, async () => {
      const o = await drive(policy, { verb: "navigate", url: DANGEROUS }, { rule: "WebFetch(domain:transfer.sh)" });
      expect({ policy, carded: o.carded, dispatched: o.dispatched.length, isError: o.isError })
        .toEqual({ policy, carded: false, dispatched: 1, isError: false });
    });
  }

  for (const policy of NEVER_ASK) {
    test(`${policy}: the rule does NOT lift the unattended block — a grant earned attended never widens a headless surface`, async () => {
      const o = await drive(policy, { verb: "navigate", url: DANGEROUS }, { rule: "WebFetch(domain:transfer.sh)" });
      expect({ policy, carded: o.carded, dispatched: o.dispatched.length, isError: o.isError })
        .toEqual({ policy, carded: false, dispatched: 0, isError: true });
    });
  }
});

describe("b2-t6: the card's own wording carries what the human cannot see", () => {
  test("first-hop-only, the click depth, and whose browser it is — all three are IN the summary", async () => {
    const o = await drive("ask", { verb: "navigate", url: DANGEROUS });
    expect(o.summary).toContain("transfer.sh matches a dangerous-domain rule");
    expect(o.summary).toContain("OWN logged-in browser");
    expect(o.summary).toContain("first hop only");
    expect(o.summary).toContain("click on it goes next");
  });
});

describe("b2-t6: INTERACTION verbs are not navigations and are never carded", () => {
  // The ruling (task-6 report §3b/§3c): the unit of this mechanism is a NAVIGATION the model aimed.
  // A click/type/scroll/submit acts inside a page that is already loaded — including a tab the USER
  // opened themselves — and the daemon has no trustworthy fact about where that page is (the fold's
  // url is a post-hoc report with no ordering against the interaction). Gating on it would refuse
  // and permit on stale facts; gating every interaction would be the per-action category §4 forbids.
  for (const args of [
    { verb: "click", selector: "button" },
    { verb: "type", selector: "input", text: "hello" },
    { verb: "submit", selector: "form" },
    { verb: "scroll", direction: "down" },
  ]) {
    test(`${args.verb} under ask: no card, dispatched`, async () => {
      const o = await drive("ask", args);
      expect({ verb: args.verb, carded: o.carded, dispatched: o.dispatched.length })
        .toEqual({ verb: args.verb, carded: false, dispatched: 1 });
    });
  }

  // A model cannot smuggle a navigation past the gate by hanging a `url` on an interaction verb:
  // the shared arg shape tolerates the field, and `browserVerbUrl` reads the VERB first.
  test("a `url` on a click is not a navigation — no card, and the url never reaches the wire", async () => {
    const o = await drive("ask", { verb: "click", selector: "button", url: DANGEROUS });
    expect({ carded: o.carded, dispatched: o.dispatched.length, url: o.dispatched[0]?.url })
      .toEqual({ carded: false, dispatched: 1, url: undefined });
  });
});

describe("b2-t6: THE FLOOR IS INDEPENDENT — an approved domain is not a licence to type", () => {
  // Spec §4 keeps two things apart that a reader could easily merge: the DOMAIN gate (which host may
  // the agent go to) and the SENSITIVE FLOOR (may it type into a password/payment field). The floor
  // is computed app-side against a live DOM this daemon has never seen, and NOTHING the daemon sends
  // can turn it off. These rows pin that at the only place the daemon can be responsible for it:
  // the wire. If a domain approval could ever license a `type`, it would have to travel in
  // `panel_command.args` — the one model-adjacent payload — and it does not, in either direction.
  test("with the domain rule in force, a `type` still dispatches EXACTLY {selector, text} — no approval key of any kind", async () => {
    const o = await drive("ask", { verb: "type", selector: "input[name=\"pw\"]", text: "hunter2" }, { rule: "WebFetch(domain:transfer.sh)" });
    expect(o.dispatched).toHaveLength(1);
    expect(o.dispatched[0]?.args).toEqual({ selector: "input[name=\"pw\"]", text: "hunter2" });
  });

  test("a model-supplied approval key never reaches the wire, even on an APPROVED navigation's session", async () => {
    // Two calls in one turn: the navigation that legitimately earns a stamp, then a `type` whose
    // args try to carry the approval forward. The stamp is per-call and args are built field by
    // field, so the second call's payload is unchanged and its own gate never ran.
    const provider = new FakeProvider([
      [
        { type: "tool_call", callId: "c1", name: "browser", argsJson: JSON.stringify({ verb: "navigate", url: DANGEROUS }) },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "tool_call", callId: "c2", name: "browser", argsJson: JSON.stringify({ verb: "type", selector: "input", text: "x", browserDomainApproved: true, sensitiveApproved: true }) },
        { type: "done", stopReason: "tool_calls" },
      ],
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const o = await drive("ask", {}, { provider });
    expect(o.dispatched.map((d) => d.action)).toEqual(["navigate", "type"]);
    expect(o.dispatched[1]?.args).toEqual({ selector: "input", text: "x" });
  });
});

describe("b2-t6: the NEVER-ASK pin — not one approval_requested can fire in an unattended session", () => {
  // The strongest form of deliverable 2, and deliberately broader than the dangerous-domain rows
  // above: EVERY verb, ordinary and dangerous alike, across all four never-ask policies. A card in
  // any of these cells is a card nobody can answer — a headless dispatch coordinator would hang out
  // its five-minute broker timeout and then fail closed.
  for (const policy of NEVER_ASK) {
    test(`${policy}: zero cards across navigate/open/read/click, dangerous and ordinary`, async () => {
      for (const args of [
        { verb: "navigate", url: ORDINARY },
        { verb: "navigate", url: DANGEROUS },
        { verb: "open", url: ORDINARY },
        { verb: "open", url: DANGEROUS },
        { verb: "read" },
        { verb: "click", selector: "button" },
      ]) {
        const o = await drive(policy, args);
        expect({ policy, verb: args.verb, url: args.url, carded: o.carded })
          .toEqual({ policy, verb: args.verb, url: args.url, carded: false });
      }
    });
  }
});
