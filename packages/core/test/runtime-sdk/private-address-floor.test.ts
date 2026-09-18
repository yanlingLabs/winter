// THE PRIVATE-ADDRESS FLOOR IN THE APPROVAL BRIDGE (whole-branch review B1/M2, 2026-09-18).
//
// The defect this file exists to keep closed, measured before the fix: the agent SDK raises a
// MANDATORY approval for a `WebFetch` whose target is lexically private — ahead of the permission
// mode, ahead of allow rules, even under `bypassPermissions` — and hands `canUseTool` nothing to
// branch on (no `matchedAskRule`, no `blockedPath`, only a free-form `decisionReason` the bridge
// deliberately does not act on). Winter's gate classifies `web_fetch` as `NETWORK` and answers
// `allow` under every policy, which is the user's standing "public web reads never nag" posture. The
// two together answered the SDK's mandatory ask with a SILENT YES:
//
//     policy=plan/ask/accept-edits/auto/bypass  ->  {"behavior":"allow"}   events=0
//
// so a Winter child reached `192.168.1.1`, `127.0.0.1` and `*.local` with no card, no event and no
// record — on the official leg too, where claude's own per-domain cards land on this same bridge and
// no `Options.web` (and therefore no `privateAddressPolicy`) is sent at all.
//
// The rule now: a private target NEVER resolves silently. Code mode raises a real card — under every
// policy, `plan` and `bypass` included, because the runtime's own ask is mandatory under both and a
// session policy is not consent for it. Every context that cannot prompt (chat, dispatch, a dispatch
// child, `dont-ask`) gets one fixed typed deny. Public hosts stay free at the gate, unchanged.
import { test, expect, describe } from "bun:test";
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { canUseToolFor, privateWebFetchTarget, type BridgeLogger } from "../../src/runtime-sdk/approval-bridge";

type Mode = "code" | "dispatch" | "chat";
const silent: BridgeLogger = { info: () => {}, error: () => {} };
const POLICIES: SessionApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];

function harness(over: { mode: Mode; policy: SessionApprovalPolicy; origin?: string }) {
  const events: NewSessionEvent[] = [];
  const approvals = new ApprovalBroker();
  const canUse: CanUseTool = canUseToolFor({
    sessionId: "s1", mode: over.mode, policy: over.policy, origin: over.origin,
    approvals, questions: new QuestionBroker(), gate: new PermissionGate(),
    emit: (e) => { events.push(e); }, log: silent, now: () => 1_700_000_000_000,
  });
  return { events, approvals, canUse };
}

let tu = 0;
/** `suggestions` is how the SDK offers `WebFetch(domain:<host>)` on a private-address ask — the one
 *  option this floor must never let a human mint into a standing rule. */
function ctx(suggestions?: unknown): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal, toolUseID: `tu${++tu}`, requestId: `r${tu}`,
    ...(suggestions === undefined ? {} : { suggestions }),
    // Set exactly as the SDK sets it for this case, to prove the bridge does not depend on it.
    decisionReason: "192.168.1.1 is a private or loopback address (private ipv4 range); WebFetch needs explicit approval to reach it.",
  } as Parameters<CanUseTool>[2];
}

/** Every spelling `ssrfGuard`'s own corpus covers, reached through the bridge's predicate. */
const PRIVATE_URLS = [
  "http://192.168.1.1/admin",          // RFC1918
  "http://10.0.0.1/",                  // RFC1918, second block
  "http://172.16.0.1/",                // RFC1918, third block
  "http://127.0.0.1:3000/",            // loopback
  "https://printer.local/",            // mDNS name, two labels — reachable, unlike bare `localhost`
  "http://localhost:8080/",            // the single-label name
  "http://169.254.169.254/latest/",    // link-local, the metadata surface
  "http://100.64.0.1/",                // CGNAT
  "http://0.0.0.0:9000/",              // unspecified
  "http://[::1]:5173/",                // bracketed IPv6 loopback
  "http://[fe80::1]/",                 // bracketed IPv6 link-local
  "http://[::ffff:192.168.0.1]/",      // IPv4-mapped IPv6
  "http://0177.0.0.1/",                // IPv4 odd radix — a resolver dials loopback
  "http://2130706433/",                // IPv4 as one integer
  "http://192.168.1.1./",              // trailing dot (the DNS root label)
  "http://user:pw@10.0.0.1/x",         // userinfo
  "HTTP://192.168.1.1/",               // uppercase scheme
  "http://192.168.1.1:8443/x?y=1",     // port + path + query
];

const PUBLIC_URLS = [
  "https://example.com/doc",
  "https://docs.example.com/a/b?c=d",
  "https://example.com/192.168.1.1",   // a private-looking PATH is not a private target
  "https://notlocalhost.example/",      // `localhost` as a substring of a public label
];

describe("privateWebFetchTarget — the predicate", () => {
  test("every private spelling is recognised, with the host it judged", () => {
    for (const url of PRIVATE_URLS) {
      const target = privateWebFetchTarget("WebFetch", { url, prompt: "what" });
      expect({ url, seen: target !== undefined }).toEqual({ url, seen: true });
      expect(target!.host.length).toBeGreaterThan(0);
      expect(target!.reason.length).toBeGreaterThan(0);
    }
  });

  test("public hosts are not private targets", () => {
    for (const url of PUBLIC_URLS) {
      expect({ url, seen: privateWebFetchTarget("WebFetch", { url }) !== undefined }).toEqual({ url, seen: false });
    }
  });

  test("BOTH spellings of the tool reach it, and no other tool does", () => {
    const input = { url: "http://192.168.1.1/" };
    expect(privateWebFetchTarget("WebFetch", input)).toBeDefined();   // what both legs' children call it
    expect(privateWebFetchTarget("web_fetch", input)).toBeDefined();  // the host/gate spelling
    expect(privateWebFetchTarget("WebSearch", { query: "192.168.1.1" })).toBeUndefined();
    expect(privateWebFetchTarget("Bash", { command: "curl http://192.168.1.1/" })).toBeUndefined();
  });

  test("an unparseable url or a non-address input is NOT a private-address fact", () => {
    // The executor refuses these itself (`Invalid URL`, without touching the network); turning one
    // into an approval card would ask a human about a fetch that can never happen.
    for (const input of [{ url: "not a url" }, { url: "" }, { url: 42 }, {}, null, "x"]) {
      expect(privateWebFetchTarget("WebFetch", input)).toBeUndefined();
    }
  });
});

describe("the bridge: a private WebFetch target never resolves silently", () => {
  // The exact shape the review measured as broken, per policy.
  for (const policy of POLICIES) {
    test(`code/${policy}: http://192.168.1.1/admin is a card or a deny — never a silent allow`, async () => {
      const h = harness({ mode: "code", policy });
      const p = h.canUse("WebFetch", { url: "http://192.168.1.1/admin", prompt: "what" }, ctx());
      if (policy === "dont-ask") {
        const res = (await p)!;
        expect(res.behavior).toBe("deny");
        expect(h.events).toEqual([]);
        return;
      }
      // Every other policy: a REAL card. `bypass` included — the SDK's own ask is mandatory there
      // too, and only an exact-host rule or `privateAddressPolicy: "allow"` is consent (neither is a
      // session policy). `plan` included — the gate allows the NETWORK class under plan (a fetch is a
      // read, not a mutation), so there is no plan deny to preserve here, and asking a human about a
      // local target is exactly what plan mode can do.
      expect(h.events).toHaveLength(1);
      expect((h.events[0] as { type: string }).type).toBe("approval_requested");
      h.approvals.resolve("s1", (h.events[0] as { callId: string }).callId, true, "user");
      const res = (await p)!;
      expect(res.behavior).toBe("allow");
    });
  }

  test("every private spelling raises a card in code mode under `ask`", async () => {
    for (const url of PRIVATE_URLS) {
      const h = harness({ mode: "code", policy: "ask" });
      const p = h.canUse("WebFetch", { url, prompt: "what" }, ctx());
      expect({ url, events: h.events.length }).toEqual({ url, events: 1 });
      h.approvals.resolve("s1", (h.events[0] as { callId: string }).callId, false, "user");
      expect((await p)!.behavior).toBe("deny");
    }
  });

  test("a PUBLIC host stays free at the gate — allowed silently, no event (the standing posture)", async () => {
    for (const policy of ["ask", "auto", "accept-edits", "bypass"] as SessionApprovalPolicy[]) {
      for (const url of PUBLIC_URLS) {
        const h = harness({ mode: "code", policy });
        const res = (await h.canUse("WebFetch", { url, prompt: "what" }, ctx()))!;
        expect({ url, policy, behavior: res.behavior, events: h.events.length })
          .toEqual({ url, policy, behavior: "allow", events: 0 });
      }
    }
  });

  test("`WebSearch` is untouched: no url, no escalation, still free", async () => {
    const h = harness({ mode: "code", policy: "ask" });
    const res = (await h.canUse("WebSearch", { query: "printer.local status" }, ctx()))!;
    expect(res.behavior).toBe("allow");
    expect(h.events).toEqual([]);
  });

  // The never-prompting contexts. On the Winter leg the SDK's own `privateAddressPolicy: "deny"`
  // refuses these one layer down; on the OFFICIAL leg this is the only floor, because that leg is
  // sent no `Options.web` at all.
  for (const ctxCase of [
    { label: "chat", mode: "chat" as Mode, policy: "chat" as SessionApprovalPolicy, origin: undefined, word: "chat" },
    { label: "dispatch", mode: "dispatch" as Mode, policy: "auto" as SessionApprovalPolicy, origin: undefined, word: "dispatch" },
    { label: "dispatch child", mode: "code" as Mode, policy: "auto" as SessionApprovalPolicy, origin: "dispatch-child", word: "dispatch" },
  ]) {
    test(`${ctxCase.label}: a typed deny naming the host, no event, never a card`, async () => {
      const h = harness({ mode: ctxCase.mode, policy: ctxCase.policy, origin: ctxCase.origin });
      const res = (await h.canUse("WebFetch", { url: "http://127.0.0.1:3000/", prompt: "what" }, ctx()))!;
      expect(res.behavior).toBe("deny");
      expect((res as { message: string }).message).toContain("127.0.0.1");
      expect((res as { message: string }).message).toContain("private or loopback");
      expect((res as { message: string }).message).toContain(`this ${ctxCase.word} session never prompts`);
      expect(h.events).toEqual([]);
    });
  }

  test("`dont-ask` in code mode: the same fixed refusal, naming the policy rather than a mode", async () => {
    const h = harness({ mode: "code", policy: "dont-ask" });
    const res = (await h.canUse("WebFetch", { url: "https://printer.local/", prompt: "what" }, ctx()))!;
    expect(res.behavior).toBe("deny");
    expect((res as { message: string }).message).toContain("printer.local");
    expect((res as { message: string }).message).toContain("policy dont-ask declines every approval");
    expect(h.events).toEqual([]);
  });

  test("an escalation NARROWS, never widens: a gate deny stays a deny (plan mode, a MUTATING tool)", async () => {
    // The escalation is gated on `decision === "allow"`, so a verdict that was already a deny is
    // untouched. `plan` + `Write` is that case (the web class is allowed under plan — see the
    // per-policy test above — so `WebFetch` itself cannot demonstrate it).
    const h = harness({ mode: "code", policy: "plan" });
    const res = (await h.canUse("Write", { file_path: "/repo/a.ts", content: "x" }, ctx()))!;
    expect(res.behavior).toBe("deny");
    expect(h.events).toEqual([]);
  });
});

describe("the private-address card mints no standing rule", () => {
  const SDK_SUGGESTION = [{
    type: "addRules", behavior: "allow", destination: "localSettings",
    rules: [{ toolName: "WebFetch", ruleContent: "domain:192.168.1.1" }],
  }];

  test("the card offers no rule-bearing option, even when the SDK suggests WebFetch(domain:<host>)", async () => {
    // Per the 0.0.17 changelog an exact-host allow rule is standing consent for that host WHEREVER
    // IT RESOLVES and turns the private-address check off for it permanently — which no card wording
    // asks for, and which `approval.respond` would also append to `.winter/permissions.local.json`.
    const h = harness({ mode: "code", policy: "ask" });
    const p = h.canUse("WebFetch", { url: "http://192.168.1.1/admin", prompt: "what" }, ctx(SDK_SUGGESTION));
    expect(h.events).toHaveLength(1);
    const card = h.events[0] as { options?: unknown[] };
    expect(card.options).toBeUndefined();   // a plain approve/deny card
    h.approvals.resolve("s1", (h.events[0] as { callId: string }).callId, true, "user");
    const res = (await p)!;
    // Approved once: allowed, and NOTHING durable is carried back to the child.
    expect(res.behavior).toBe("allow");
    expect(res).not.toHaveProperty("updatedPermissions");
    expect((res as { decisionClassification?: string }).decisionClassification).toBe("user_temporary");
  });

  test("a PUBLIC host's card still offers the SDK's suggested rules — the drop is scoped to private targets", async () => {
    const h = harness({ mode: "code", policy: "ask" });
    // A public `WebFetch` never reaches a card on its own (NETWORK → allow), so the comparison is
    // made on the one tool that does card with suggestions, at the same code path.
    const p = h.canUse("Bash", { command: "rm -rf /tmp/x" }, ctx([{
      type: "addRules", behavior: "allow", destination: "localSettings",
      rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
    }]));
    expect(h.events).toHaveLength(1);
    const card = h.events[0] as { options?: Array<{ rule?: string }> };
    expect(card.options?.some((o) => o.rule === "Bash(rm:*)")).toBe(true);
    h.approvals.resolve("s1", (h.events[0] as { callId: string }).callId, false, "user");
    await p;
  });
});
