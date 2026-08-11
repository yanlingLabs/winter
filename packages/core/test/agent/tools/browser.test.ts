import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  PANEL_COMMAND_RESULT_MAX_LENGTH, PANEL_COMMAND_ACTIONS, PANEL_COMMAND_ARGS_MAX_JSON_BYTES,
} from "@norma/protocol";
import { ToolRegistry, MAX_OUTPUT, type ToolContext } from "../../../src/agent/tools/registry";
import { registerToolSearchTool } from "../../../src/agent/tools/toolsearch";
import {
  registerBrowserTool, canHostPanel, BROWSER_DEADLINES_MS,
  BROWSER_READ_VERBS, BROWSER_INTERACT_VERBS,
  BROWSER_SELECTOR_MAX_LENGTH, BROWSER_TYPE_TEXT_MAX_LENGTH,
  BROWSER_SCROLL_DEFAULT_AMOUNT_PX, BROWSER_WAIT_DEFAULT_TIMEOUT_MS, BROWSER_WAIT_MAX_TIMEOUT_MS,
  type BrowserToolDeps,
} from "../../../src/agent/tools/browser";
import type { PanelCommandOutcome } from "../../../src/panel/commands";
import type { PanelTabState } from "../../../src/panel/store";

/**
 * b2-agent-browser T4 — the `browser` tool, through a FAKE registry recorder rather than a live
 * daemon.
 *
 * Spec §9 is explicit about the posture: "the daemon tool [is tested] through the fake transport,
 * end-to-end only at the live gate". So every test here drives `registry.execute` — the REAL
 * registration, the REAL per-mode schema resolution, the REAL refusal ladder — against a `dispatch`
 * that RECORDS instead of emitting. That recorder is what makes the negative assertions meaningful:
 * "refused without dispatch" is checked as `recorded.length === 0`, not inferred from a message.
 */

const SID = "s-browser";

interface Recorded {
  sessionId: string;
  action: string;
  tabId?: string;
  url?: string;
  args?: Record<string, unknown>;
  deadlineMs: number;
}

interface Harness {
  deps: BrowserToolDeps;
  recorded: Recorded[];
  registry: ToolRegistry;
  /** What every dispatched command will settle as. Replaceable per test. */
  outcome: (cmd: Recorded) => Promise<PanelCommandOutcome>;
  opened: Array<{ sessionId: string; kind: string; url?: string; title?: string }>;
  images: string[];
  run(args: unknown, ctx?: Partial<ToolContext>): Promise<{ output: string; isError: boolean }>;
}

function makeHarness(opts?: {
  tabs?: PanelTabState;
  harnesses?: Array<{ clientName: string; role?: string | null }>;
  dangerousAdded?: string[];
  tabsThrows?: string;
}): Harness {
  const recorded: Recorded[] = [];
  const opened: Harness["opened"] = [];
  const images: string[] = [];
  const state: PanelTabState = opts?.tabs ?? {
    tabs: [{ tabId: "t1", kind: "web", url: "https://example.com", title: "Example" }],
    activeTabId: "t1",
  };
  const h: Harness = {
    recorded, opened, images,
    outcome: async () => ({ kind: "result", ok: true, result: "did it" }),
    registry: new ToolRegistry(),
    deps: {
      tabs() {
        if (opts?.tabsThrows) throw new Error(opts.tabsThrows);
        return state;
      },
      openTab(p) {
        opened.push({ sessionId: p.sessionId, kind: p.kind, url: p.url, title: p.title });
        return "t-new";
      },
      dispatch(cmd) {
        const rec: Recorded = {
          sessionId: cmd.sessionId, action: cmd.action, tabId: cmd.tabId, url: cmd.url,
          args: cmd.args, deadlineMs: cmd.deadlineMs,
        };
        recorded.push(rec);
        return { commandId: `pcmd_${recorded.length}`, settled: h.outcome(rec) };
      },
      harnesses: () => opts?.harnesses ?? [{ clientName: "orb", role: "harness" }],
      dangerousDomainsAdded: () => opts?.dangerousAdded,
    },
    async run(args, ctx) {
      return h.registry.execute("browser", args, {
        cwd: "/tmp", roots: ["/tmp"], sessionId: SID, mode: "code",
        attachImage: (u) => images.push(u),
        ...ctx,
      } as ToolContext);
    },
  };
  registerBrowserTool(h.registry, h.deps);
  return h;
}

/** One WELL-FORMED call per command verb — every verb that travels the wire, each carrying operands
 *  that pass rung 1. Rows that mean to prove a LATER rung (ownership, availability, the outcome
 *  mapping) must start from here, or they prove rung 1 instead and the verb they name is untested.
 *  `url` is only meaningful to `navigate`; the others ignore it. */
const WELL_FORMED_COMMAND_CALLS: Array<Record<string, unknown>> = [
  { verb: "navigate", url: "https://a.example" },
  { verb: "back" },
  { verb: "read" },
  { verb: "screenshot" },
  { verb: "click", selector: "button" },
  { verb: "type", selector: "input", text: "hello" },
  { verb: "scroll", direction: "down" },
  { verb: "submit", selector: "form" },
  { verb: "wait", until: "load" },
];

// ================================================================================================
// Registration: modes, deferral, and the per-mode SCHEMA
// ================================================================================================

describe("browser: registration", () => {
  test("every mode may see it; it is deferred in code and dispatch and IMMEDIATE in chat", () => {
    const h = makeHarness();
    for (const mode of ["code", "dispatch", "chat"] as const) {
      expect(h.registry.namesForMode(mode, { builtinDeferral: true }).has("browser")).toBe(true);
    }
    // Deferred where ToolSearch exists; immediate in chat, which has no ToolSearch member to load it
    // with (the trap AskQuestion/ReadPage both record).
    expect(h.registry.isDeferredBuiltin("browser", true, "code")).toBe(true);
    expect(h.registry.isDeferredBuiltin("browser", true, "dispatch")).toBe(true);
    expect(h.registry.isDeferredBuiltin("browser", true, "chat")).toBe(false);
    // Deferral is off entirely when built-in deferral is off — the array must not become "always".
    expect(h.registry.isDeferredBuiltin("browser", false, "code")).toBe(false);
  });

  /** The verb enum the model is SHOWN, per mode. */
  function verbsIn(spec: { parameters: unknown } | undefined): string[] {
    const p = spec?.parameters as { properties?: { verb?: { enum?: string[] } } } | undefined;
    return p?.properties?.verb?.enum ?? [];
  }

  test("chat's schema carries the READ verbs and NONE of the interaction verbs", () => {
    const h = makeHarness();
    const chat = h.registry.specs("/tmp", { mode: "chat", builtinDeferral: true }).find((s) => s.name === "browser");
    expect(verbsIn(chat).sort()).toEqual([...BROWSER_READ_VERBS].sort());
    for (const v of BROWSER_INTERACT_VERBS) expect(verbsIn(chat)).not.toContain(v);
  });

  test("code and dispatch see the full set", () => {
    const h = makeHarness();
    const full = [...BROWSER_READ_VERBS, ...BROWSER_INTERACT_VERBS].sort();
    for (const mode of ["code", "dispatch"] as const) {
      const spec = h.registry
        .specs("/tmp", { mode, builtinDeferral: true, loaded: new Set(["browser"]) })
        .find((s) => s.name === "browser");
      expect(verbsIn(spec).sort()).toEqual(full);
    }
  });

  test("specFor — ToolSearch's rendering path — is mode-resolved too, not just specs()", () => {
    // The silent-narrowing guard: `browser` is DEFERRED in code, so specFor is the only way a code
    // session ever sees its schema. An unthreaded mode here would advertise the fail-closed chat
    // schema for a session execute() accepts the full one for.
    const h = makeHarness();
    expect(verbsIn(h.registry.specFor("browser", "/tmp", "code")).sort())
      .toEqual([...BROWSER_READ_VERBS, ...BROWSER_INTERACT_VERBS].sort());
    expect(verbsIn(h.registry.specFor("browser", "/tmp", "chat")).sort())
      .toEqual([...BROWSER_READ_VERBS].sort());
    // No mode at all → fail-closed to the narrow schema, never the wide one.
    expect(verbsIn(h.registry.specFor("browser", "/tmp")).sort()).toEqual([...BROWSER_READ_VERBS].sort());
  });

  test("ToolSearch — the ONLY way code ever sees this schema — renders the code one", async () => {
    // `specFor`'s mode param is only useful if its one production caller passes it. Driving the real
    // ToolSearch tool is what pins that threading; asserting on `specFor` directly (above) cannot,
    // and a mutation run proved it: unthreading toolsearch.ts alone left every other row green.
    const h = makeHarness();
    registerToolSearchTool(h.registry);
    const loaded = await h.registry.execute("ToolSearch", { query: "select:browser" }, {
      cwd: "/tmp", roots: ["/tmp"], sessionId: SID, mode: "code",
      builtinDeferral: true, loadedTools: new Set<string>(),
    } as ToolContext);
    expect(loaded.isError).toBe(false);
    for (const v of BROWSER_INTERACT_VERBS) expect(loaded.output).toContain(`"${v}"`);
  });

  test("the chat exclusion is ENFORCED at execute(), not merely un-advertised", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "click", tabId: "t1", selector: "a" }, { mode: "chat" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("invalid arguments for browser");
    expect(h.recorded).toHaveLength(0);
    // The same call in code mode gets past validation and reaches the app.
    const code = await h.run({ verb: "click", tabId: "t1", selector: "a" });
    expect(code.isError).toBe(false);
    expect(h.recorded.map((r) => r.action)).toEqual(["click"]);
  });

  test("every command verb is a real PANEL_COMMAND_ACTIONS value, and every action has a deadline", () => {
    for (const v of BROWSER_INTERACT_VERBS) expect(PANEL_COMMAND_ACTIONS).toContain(v);
    for (const v of ["navigate", "back", "read", "screenshot"] as const) expect(PANEL_COMMAND_ACTIONS).toContain(v);
    // Every wire action this tool can name has a deadline, and no orphan deadlines exist.
    expect(Object.keys(BROWSER_DEADLINES_MS).sort()).toEqual([...PANEL_COMMAND_ACTIONS].sort());
  });
});

// ================================================================================================
// T2 review rider M1 — the "matches MAX_OUTPUT" claim becomes a test
// ================================================================================================

test("PANEL_COMMAND_RESULT_MAX_LENGTH equals the registry's MAX_OUTPUT (methods.ts says so in prose)", () => {
  expect(PANEL_COMMAND_RESULT_MAX_LENGTH).toBe(MAX_OUTPUT);
});

// ================================================================================================
// tabs / open — the daemon answers, with no Mac app anywhere
// ================================================================================================

describe("browser: the daemon-answered verbs work with nothing attached", () => {
  test("tabs lists the fold and never dispatches", async () => {
    const h = makeHarness({ harnesses: [] });
    const res = await h.run({ verb: "tabs" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("t1");
    expect(res.output).toContain("(active)");
    expect(res.output).toContain("https://example.com");
    expect(h.recorded).toHaveLength(0);
  });

  test("tabs on a session with no tabs says so rather than failing", async () => {
    const h = makeHarness({ tabs: { tabs: [] }, harnesses: [] });
    const res = await h.run({ verb: "tabs" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("no tabs are open");
  });

  test("open mints through the store path with no app attached, and SAYS nothing loaded it", async () => {
    const h = makeHarness({ harnesses: [] });
    const res = await h.run({ verb: "open", url: "https://example.org", title: "Ex" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("t-new");
    expect(res.output).toContain("isn't showing this session");
    expect(h.opened).toEqual([{ sessionId: SID, kind: "web", url: "https://example.org", title: "Ex" }]);
    expect(h.recorded).toHaveLength(0);
  });

  test("open with an app attached carries no caveat", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "open", url: "https://example.org" });
    expect(res.output).not.toContain("isn't showing this session");
  });

  test("open inherits panel.openTab's OWN scheme guard rather than a second policy", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "open", url: "javascript:alert(1)" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("http or https");
    expect(h.opened).toHaveLength(0);
  });

  test("open with no url is refused before anything is minted", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "open" });
    expect(res.isError).toBe(true);
    expect(h.opened).toHaveLength(0);
  });
});

// ================================================================================================
// The three outcome mappings
// ================================================================================================

describe("browser: the outcomes are mapped honestly", () => {
  test("result → the app's content, and the dispatch shape is per-verb", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: true, result: "asked the tab to load https://a.example" });
    const res = await h.run({ verb: "navigate", tabId: "t1", url: "https://a.example" });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("asked the tab to load https://a.example");
    expect(h.recorded).toEqual([{
      sessionId: SID, action: "navigate", tabId: "t1", url: "https://a.example",
      deadlineMs: BROWSER_DEADLINES_MS.navigate,
    }]);
  });

  test("back/read/screenshot dispatch with a tabId, no url, and their own deadlines", async () => {
    const h = makeHarness();
    for (const verb of ["back", "read", "screenshot"] as const) {
      await h.run({ verb, tabId: "t1" });
    }
    expect(h.recorded).toEqual([
      { sessionId: SID, action: "back", tabId: "t1", url: undefined, deadlineMs: BROWSER_DEADLINES_MS.back },
      { sessionId: SID, action: "read", tabId: "t1", url: undefined, deadlineMs: BROWSER_DEADLINES_MS.read },
      { sessionId: SID, action: "screenshot", tabId: "t1", url: undefined, deadlineMs: BROWSER_DEADLINES_MS.screenshot },
    ]);
  });

  test("ok:false → the APP's reason, passed through untouched", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: false, result: "no live browser for that tab" });
    const res = await h.run({ verb: "read", tabId: "t1" });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("no live browser for that tab");
  });

  test("timeout → 'the Mac app did not answer', claiming nothing about the page", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "timeout", deadlineMs: 20_000 });
    const res = await h.run({ verb: "read", tabId: "t1" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("did not answer");
    expect(res.output).toContain("20s");
    // The two things the wording must never imply.
    expect(res.output).toContain("may be perfectly fine");
    expect(res.output).not.toContain("failed to load");
  });

  test("a screenshot's image rides ctx.attachImage as a data URL, not the output string", async () => {
    const h = makeHarness();
    h.outcome = async () => ({ kind: "result", ok: true, result: "captured a PNG screenshot of the tab", imageBase64: "AAAB" });
    const res = await h.run({ verb: "screenshot", tabId: "t1" });
    expect(res.isError).toBe(false);
    expect(h.images).toEqual(["data:image/png;base64,AAAB"]);
    expect(res.output).not.toContain("AAAB");
    expect(res.output.length).toBeLessThan(200);
  });

  test("screenshot is refused BEFORE dispatch when the model cannot see images", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "screenshot", tabId: "t1" }, { visionCapable: false });
    expect(res.isError).toBe(true);
    expect(h.recorded).toHaveLength(0);
    // `undefined` means unknown and is NOT a refusal (computer.ts's own precedent).
    const unknown = await h.run({ verb: "screenshot", tabId: "t1" });
    expect(unknown.isError).toBe(false);
    expect(h.recorded).toHaveLength(1);
  });

  /** T4 shipped this row against the app's `not implemented` stub. Task 5 built the arm, so the row
   *  now pins what it always meant to: an interaction verb reaches the app carrying its operands,
   *  and the app's `ok:false` — whatever it is — is the answer the model gets, untouched. The
   *  fixture is the SENSITIVE FLOOR's refusal, which is the `ok:false` this tool must not soften. */
  test("an interaction verb dispatches with its operands, and the app's refusal is the answer", async () => {
    const h = makeHarness();
    h.outcome = async () => ({
      kind: "result", ok: false,
      result: "refused: that is a password field, and Norma never types into one unattended",
    });
    const res = await h.run({ verb: "type", tabId: "t1", selector: "#pw", text: "hunter2" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("password field");
    expect(h.recorded.map((r) => r.action)).toEqual(["type"]);
    expect(h.recorded[0]?.args).toEqual({ selector: "#pw", text: "hunter2" });
  });
});

// ================================================================================================
// Unavailability (spec §3)
// ================================================================================================

describe("browser: unavailability is honest and fast", () => {
  test("nothing attached → refused with NO dispatch and no deadline burned", async () => {
    const h = makeHarness({ harnesses: [] });
    const res = await h.run({ verb: "read", tabId: "t1" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("browser unavailable");
    expect(res.output).toContain("isn't showing this session");
    expect(h.recorded).toHaveLength(0);
  });

  test("phone-only and terminal-only attachments are unavailable, and the message names them", async () => {
    const phone = makeHarness({ harnesses: [{ clientName: "iphone-gateway", role: "remote" }] });
    const pRes = await phone.run({ verb: "read", tabId: "t1" });
    expect(pRes.isError).toBe(true);
    expect(pRes.output).toContain("iphone-gateway");
    expect(phone.recorded).toHaveLength(0);

    const cli = makeHarness({ harnesses: [{ clientName: "cli-chat", role: "harness" }] });
    const cRes = await cli.run({ verb: "navigate", tabId: "t1", url: "https://a.example" });
    expect(cRes.isError).toBe(true);
    expect(cRes.output).toContain("cli-chat");
    expect(cli.recorded).toHaveLength(0);
  });

  test("a Mac app attached ALONGSIDE the phone is available", async () => {
    const h = makeHarness({
      harnesses: [{ clientName: "iphone-gateway", role: "remote" }, { clientName: "orb", role: "harness" }],
    });
    const res = await h.run({ verb: "read", tabId: "t1" });
    expect(res.isError).toBe(false);
    expect(h.recorded).toHaveLength(1);
  });

  test("canHostPanel: role beats name, terminals are denied, everything else passes", () => {
    // A gateway that calls itself anything at all is still denied — the ROLE is the daemon's record.
    expect(canHostPanel({ clientName: "orb", role: "remote" })).toBe(false);
    expect(canHostPanel({ clientName: "cli-p" })).toBe(false);
    expect(canHostPanel({ clientName: "cli-plugin-restart-x" })).toBe(false);
    expect(canHostPanel({ clientName: "orb", role: "harness" })).toBe(true);
    // The deliberately loose half: a detached window and the debug streamer both pass, and the
    // tool's own doc says why that direction of error is the cheap one.
    expect(canHostPanel({ clientName: "norma-probe", role: "harness" })).toBe(true);
  });
});

// ================================================================================================
// The RIDER: tab ↔ session ownership (T3 review Important-2)
// ================================================================================================

describe("browser: a tabId must belong to THIS session", () => {
  test("a foreign tabId is refused with ZERO dispatch", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "read", tabId: "t-from-another-session" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("does not belong to this session");
    expect(res.output).toContain("nothing was sent");
    expect(h.recorded).toHaveLength(0);
  });

  /** Every command verb, WITH valid operands — because operands are rung 1 and would otherwise be
   *  the refusal under test for the five interaction verbs, which would leave tab ownership
   *  unproven for exactly the verbs that act. */
  test("the check runs for EVERY command verb, including the interaction ones", async () => {
    const h = makeHarness();
    for (const args of WELL_FORMED_COMMAND_CALLS) {
      const res = await h.run({ ...args, tabId: "nope" });
      expect(res.isError).toBe(true);
      expect(res.output).toContain("does not belong to this session");
    }
    expect(h.recorded).toHaveLength(0);
  });

  test("an omitted tabId defaults to the session's ACTIVE tab", async () => {
    const h = makeHarness({
      tabs: {
        tabs: [{ tabId: "t1", kind: "web" }, { tabId: "t2", kind: "web" }],
        activeTabId: "t2",
      },
    });
    await h.run({ verb: "read" });
    expect(h.recorded[0]!.tabId).toBe("t2");
  });

  test("no tabId and no active tab is refused rather than guessed", async () => {
    const noTabs = makeHarness({ tabs: { tabs: [] } });
    const a = await noTabs.run({ verb: "read" });
    expect(a.isError).toBe(true);
    expect(a.output).toContain("this session has none open");
    expect(noTabs.recorded).toHaveLength(0);

    const noActive = makeHarness({ tabs: { tabs: [{ tabId: "t1", kind: "web" }] } });
    const b = await noActive.run({ verb: "read" });
    expect(b.isError).toBe(true);
    expect(b.output).toContain("no ACTIVE tab");
    expect(noActive.recorded).toHaveLength(0);
  });

  test("an unknown session surfaces the store's refusal instead of dispatching", async () => {
    const h = makeHarness({ tabsThrows: "unknown session: s-browser" });
    const res = await h.run({ verb: "read", tabId: "t1" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("could not read this session's tabs");
    expect(h.recorded).toHaveLength(0);
  });
});

// ================================================================================================
// The dangerous-domain hard block (spec §4)
// ================================================================================================

describe("browser: the dangerous-domain hard block covers BOTH url doors", () => {
  // `ngrok.io` is on the SHIPPED list (page-core.ts's SHIPPED_DANGEROUS_DOMAINS).
  test("navigate to a shipped-list host is refused with zero dispatch", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "navigate", tabId: "t1", url: "https://evil.ngrok.io/x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("dangerous-domain list");
    expect(h.recorded).toHaveLength(0);
  });

  test("open to a shipped-list host is refused with zero tabs minted", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "open", url: "https://evil.ngrok.io/x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("dangerous-domain list");
    expect(h.opened).toHaveLength(0);
  });

  test("the per-project ADDED list applies too, on both doors", async () => {
    const h = makeHarness({ dangerousAdded: ["corp-exfil.example"] });
    const nav = await h.run({ verb: "navigate", tabId: "t1", url: "https://corp-exfil.example/p" });
    expect(nav.isError).toBe(true);
    expect(nav.output).toContain("corp-exfil.example");
    const open = await h.run({ verb: "open", url: "https://corp-exfil.example/p" });
    expect(open.isError).toBe(true);
    expect(h.recorded).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  test("it fires in CHAT too — the mode with no approval flow at all", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "navigate", tabId: "t1", url: "https://evil.ngrok.io/x" }, { mode: "chat" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("dangerous-domain list");
    expect(h.recorded).toHaveLength(0);
  });

  // ── T6: the ONE thing that stands the block down, and everything that does not ────────────────
  //
  // `ctx.browserDomainApproved` is the daemon's stamp, written by engine.ts's approved-execution
  // closure after a human answered the domain card (or after their standing WebFetch rule matched).
  // Its whole design constraint — Task 5's seam — is that it must be UNREACHABLE from the model, so
  // these rows test the two halves separately: the stamp works, and the model cannot forge it.
  test("T6: a daemon-stamped ctx lifts the block on BOTH doors, for that call only", async () => {
    const h = makeHarness();
    const nav = await h.run({ verb: "navigate", tabId: "t1", url: "https://evil.ngrok.io/x" }, { browserDomainApproved: true });
    expect({ isError: nav.isError, dispatched: h.recorded.length }).toEqual({ isError: false, dispatched: 1 });
    const open = await h.run({ verb: "open", url: "https://evil.ngrok.io/x" }, { browserDomainApproved: true });
    expect({ isError: open.isError, opened: h.opened.length }).toEqual({ isError: false, opened: 1 });

    // The very next call, unstamped, is refused again — the approval covered one call, not a session.
    const again = await h.run({ verb: "navigate", tabId: "t1", url: "https://evil.ngrok.io/x" });
    expect(again.isError).toBe(true);
    expect(h.recorded).toHaveLength(1);
  });

  test("T6 SEAM: the model cannot approve itself — the flag in ARGS is not the flag in CTX", async () => {
    const h = makeHarness();
    // A model that has read its own tool description and guessed the field name. `args` is parsed by
    // the tool's zod schema (which has no such field) and is never merged into ctx, so this is
    // indistinguishable from a plain refused call.
    const res = await h.run({ verb: "navigate", tabId: "t1", url: "https://evil.ngrok.io/x", browserDomainApproved: true });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("dangerous-domain list");
    expect(h.recorded).toHaveLength(0);
  });

  test("T6: `false`/absent are both refusals — an approval is a positively-present fact, never an inferred one", async () => {
    const h = makeHarness();
    for (const ctx of [{}, { browserDomainApproved: false }, { browserDomainApproved: undefined }]) {
      const res = await h.run({ verb: "navigate", tabId: "t1", url: "https://evil.ngrok.io/x" }, ctx);
      expect({ ctx: JSON.stringify(ctx), isError: res.isError }).toEqual({ ctx: JSON.stringify(ctx), isError: true });
    }
    expect(h.recorded).toHaveLength(0);
  });

  test("T6 FLOOR INDEPENDENCE: an approved domain changes NOTHING about a `type` — same args, no extra key on the wire", async () => {
    // The sensitive floor is computed app-side against a DOM this daemon has never seen, and the
    // only payload that crosses to it is `panel_command.args`. So the daemon-side half of "approved
    // ≠ password fields allowed" is exactly this: a stamped session's `type` puts nothing on the
    // wire that a consumer could read as a floor override. Compared against the UNSTAMPED call's own
    // payload rather than a literal, so the claim is "identical", not "looks right".
    const h = makeHarness();
    await h.run({ verb: "type", tabId: "t1", selector: "input[name=\"pw\"]", text: "hunter2" });
    await h.run({ verb: "type", tabId: "t1", selector: "input[name=\"pw\"]", text: "hunter2" }, { browserDomainApproved: true });
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1]?.args).toEqual(h.recorded[0]?.args as Record<string, unknown>);
    expect(h.recorded[1]?.args).toEqual({ selector: "input[name=\"pw\"]", text: "hunter2" });
  });

  test("an ordinary host is untouched", async () => {
    const h = makeHarness();
    const res = await h.run({ verb: "navigate", tabId: "t1", url: "https://example.com" });
    expect(res.isError).toBe(false);
    expect(h.recorded).toHaveLength(1);
  });
});

// ================================================================================================
// Task 5 — the interaction operands
// ================================================================================================

describe("browser: the interaction operands", () => {
  test("every interaction verb's payload is built field by field, with the shapes the app reads", async () => {
    const h = makeHarness();
    await h.run({ verb: "click", selector: "button.buy" });
    await h.run({ verb: "type", selector: "#q", text: "norma" });
    await h.run({ verb: "submit", selector: "form#checkout" });
    await h.run({ verb: "scroll", direction: "down" });
    await h.run({ verb: "scroll", direction: "up", amount: 120 });
    await h.run({ verb: "scroll", selector: "#footer" });
    await h.run({ verb: "wait", until: "load" });
    await h.run({ verb: "wait", until: "ms", timeoutMs: 2_500 });

    expect(h.recorded.map((r) => r.args)).toEqual([
      { selector: "button.buy" },
      { selector: "#q", text: "norma" },
      { selector: "form#checkout" },
      { direction: "down", amount: BROWSER_SCROLL_DEFAULT_AMOUNT_PX },
      { direction: "up", amount: 120 },
      { selector: "#footer" },
      { until: "load", timeoutMs: BROWSER_WAIT_DEFAULT_TIMEOUT_MS },
      { until: "ms", timeoutMs: 2_500 },
    ]);
  });

  /** The READ verbs carry no `args` at all — `navigate`'s url is a top-level field, not a payload.
   *  A read verb that started shipping an args object would be a new model-authored payload on a
   *  wire nothing on the app side reads for it. */
  test("the read verbs dispatch with NO args object", async () => {
    const h = makeHarness();
    await h.run({ verb: "navigate", url: "https://a.example" });
    await h.run({ verb: "back" });
    await h.run({ verb: "read" });
    await h.run({ verb: "screenshot" });
    expect(h.recorded.map((r) => r.args)).toEqual([undefined, undefined, undefined, undefined]);
    expect(h.recorded[0]?.url).toBe("https://a.example");
  });

  /** **`args` is BUILT, never spread.** A model that sends extra keys — including whatever key a
   *  privileged flag might one day use — cannot get them onto the wire: zod strips what the schema
   *  does not declare, and `commandArgs` re-emits only the fields it named itself. Mutation:
   *  `return {...a}` in `commandArgs` and this reds.
   *
   *  T7: this used to cite "Task 6's attended-approval signal" as the example. Task 6's approval
   *  turned out to be a DOMAIN one that never touches `args` at all (`ctx.browserDomainApproved`,
   *  daemon-stamped) — the row is unchanged and still pins the rule, but the example was a
   *  prediction rather than a fact, so it is stated generically now. The concrete version lives in
   *  browser-approvals.test.ts, which drives a model trying exactly that key through a real turn. */
  test("a model cannot smuggle an extra key into args", async () => {
    const h = makeHarness();
    const res = await h.run({
      verb: "click", selector: "button", sensitiveApproved: true, args: { evil: 1 },
    });
    expect(res.isError).toBe(false);
    expect(h.recorded[0]?.args).toEqual({ selector: "button" });
  });

  test("each interaction verb names its missing operand, and NOTHING is dispatched", async () => {
    const h = makeHarness();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ verb: "click" }, "click needs a CSS selector"],
      [{ verb: "submit" }, "submit needs a CSS selector"],
      [{ verb: "type", selector: "#q" }, "type needs text"],
      [{ verb: "type", text: "hi" }, "type needs a CSS selector"],
      [{ verb: "scroll" }, "scroll needs either"],
      [{ verb: "scroll", selector: "#a", direction: "down" }, "EITHER a selector"],
      [{ verb: "scroll", selector: "#a", amount: 10 }, "amount is the distance for a direction"],
      [{ verb: "wait" }, "wait needs until"],
    ];
    for (const [args, expected] of cases) {
      const res = await h.run(args);
      expect(res.isError).toBe(true);
      expect(res.output).toContain(expected);
    }
    expect(h.recorded).toHaveLength(0);
  });

  /** Rung 1 is rung 1: a malformed interaction call is refused the same way whether or not the app
   *  is there, and whether or not the tab is this session's. "The call is malformed however the
   *  world looks." */
  test("a missing operand outranks BOTH tab ownership and availability", async () => {
    const h = makeHarness({ harnesses: [] });
    const res = await h.run({ verb: "click", tabId: "not-ours" });
    expect(res.output).toContain("click needs a CSS selector");
    expect(res.output).not.toContain("browser unavailable");
    expect(res.output).not.toContain("does not belong");
  });

  test("the schema's own bounds refuse before run() is ever reached", async () => {
    const h = makeHarness();
    const overLongSelector = await h.run({
      verb: "click", selector: "a".repeat(BROWSER_SELECTOR_MAX_LENGTH + 1),
    });
    expect(overLongSelector.output).toContain("invalid arguments for browser");
    const badDirection = await h.run({ verb: "scroll", direction: "sideways" });
    expect(badDirection.output).toContain("invalid arguments for browser");
    const badUntil = await h.run({ verb: "wait", until: "forever" });
    expect(badUntil.output).toContain("invalid arguments for browser");
    const overLongWait = await h.run({
      verb: "wait", until: "ms", timeoutMs: BROWSER_WAIT_MAX_TIMEOUT_MS + 1,
    });
    expect(overLongWait.output).toContain("invalid arguments for browser");
    expect(h.recorded).toHaveLength(0);
  });

  /** **The wait arithmetic**, as a pin rather than as prose: the model's own timeout must finish
   *  inside the command deadline with room for the round trip. Reds if either number moves toward
   *  the other. */
  test("wait's ceiling leaves real headroom inside its command deadline", () => {
    expect(BROWSER_WAIT_MAX_TIMEOUT_MS).toBeLessThan(BROWSER_DEADLINES_MS.wait);
    expect(BROWSER_DEADLINES_MS.wait - BROWSER_WAIT_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(BROWSER_WAIT_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(BROWSER_WAIT_MAX_TIMEOUT_MS);
  });

  /**
   * **The over-cap `type`, pre-checked in the wire's own unit.**
   *
   * The character bound (`BROWSER_TYPE_TEXT_MAX_LENGTH`) is zod's and fires first for long ASCII.
   * What reaches `checkArgsBudget` is text that is SHORT and WIDE — this fixture is under the
   * character bound and over the 8 KiB byte bound, which is the case a character-counting check
   * cannot see. Mutation: measure `text.length` instead of `Buffer.byteLength` and this reds while
   * every other row stays green.
   */
  test("an over-cap type is refused BEFORE dispatch, measured in bytes and not characters", async () => {
    const h = makeHarness();
    // Each emoji is FOUR UTF-8 bytes and TWO JS characters, so 2048 of them is exactly the 4096
    // character bound (zod passes it) and 8192 bytes of text — which with the object's own 27 bytes
    // of punctuation is 8219, past the 8192-byte wire cap.
    const wide = "😀".repeat(2_048);
    expect(wide.length).toBeLessThanOrEqual(BROWSER_TYPE_TEXT_MAX_LENGTH);
    expect(Buffer.byteLength(JSON.stringify({ selector: "#q", text: wide }), "utf8"))
      .toBeGreaterThan(PANEL_COMMAND_ARGS_MAX_JSON_BYTES);

    const res = await h.run({ verb: "type", selector: "#q", text: wide });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("past the 8192-byte limit");
    expect(res.output).toContain("nothing was sent");
    expect(h.recorded).toHaveLength(0);
  });

  /** The character bound is the FIRST of the two and produces the schema's own error. Both exist:
   *  this one for long ASCII, the byte one for short-and-wide. */
  test("a very long ASCII type is refused by the character bound", async () => {
    const h = makeHarness();
    const res = await h.run({
      verb: "type", selector: "#q", text: "a".repeat(BROWSER_TYPE_TEXT_MAX_LENGTH + 1),
    });
    expect(res.output).toContain("invalid arguments for browser");
    expect(h.recorded).toHaveLength(0);
  });

  /** Spec §1: "No interaction verbs, ever" in chat — and the OPERANDS are not there either, so the
   *  rendered chat schema does not advertise an interaction surface the mode cannot reach. */
  test("chat's schema carries none of the interaction operands", () => {
    const h = makeHarness();
    const spec = (mode: "chat" | "code") => JSON.stringify(
      h.registry
        .specs("/tmp", { mode, builtinDeferral: true, loaded: new Set(["browser"]) })
        .find((s) => s.name === "browser")?.parameters,
    );
    const operands = ["selector", "text", "direction", "amount", "until", "timeoutMs"];
    for (const field of operands) expect(spec("chat")).not.toContain(`"${field}"`);
    for (const field of operands) expect(spec("code")).toContain(`"${field}"`);
  });
});

// ================================================================================================
// Refusal precedence and abort
// ================================================================================================

describe("browser: precedence and abort", () => {
  test("the ladder is operands → dangerous → vision → ownership → availability", async () => {
    // Everything wrong at once, peeled one layer at a time. Each stage must win over the ones below
    // it, so a given call always produces the same complaint.
    const h = makeHarness({ harnesses: [] });
    const missingUrl = await h.run({ verb: "navigate", tabId: "nope" });
    expect(missingUrl.output).toContain("navigate needs a url");

    const dangerous = await h.run({ verb: "navigate", tabId: "nope", url: "https://evil.ngrok.io" });
    expect(dangerous.output).toContain("dangerous-domain list");

    const foreign = await h.run({ verb: "navigate", tabId: "nope", url: "https://ok.example" });
    expect(foreign.output).toContain("does not belong to this session");

    const unavailable = await h.run({ verb: "navigate", tabId: "t1", url: "https://ok.example" });
    expect(unavailable.output).toContain("browser unavailable");

    expect(h.recorded).toHaveLength(0);
  });

  test("the vision rung sits ABOVE ownership and availability — screenshot peels through both", async () => {
    // `screenshot` is the one verb with a rung of its own, and its placement is the claim: a session
    // whose model cannot see images must hear THAT, not "the tab is foreign" and not "the app isn't
    // running" — those describe a world that could change, while this call could never have worked.
    // Peeled downward, so moving the gate below either of the two reds this row.
    const h = makeHarness({ harnesses: [] });
    const blind = await h.run({ verb: "screenshot", tabId: "nope" }, { visionCapable: false });
    expect(blind.output).toContain("cannot accept images");

    // Vision restored: the next rung down (ownership) takes over, on the identical call.
    const foreign = await h.run({ verb: "screenshot", tabId: "nope" });
    expect(foreign.output).toContain("does not belong to this session");

    // Ownership satisfied: availability, the transient rung, is last.
    const unavailable = await h.run({ verb: "screenshot", tabId: "t1" });
    expect(unavailable.output).toContain("browser unavailable");

    expect(h.recorded).toHaveLength(0);
  });

  test("an aborted turn returns PROMPTLY, without waiting the command out", async () => {
    const h = makeHarness();
    // A command that never answers — if the tool awaited it, this test would hang until the runner
    // gave up rather than fail.
    h.outcome = () => new Promise<PanelCommandOutcome>(() => {});
    const ac = new AbortController();
    const started = Date.now();
    const pending = h.run({ verb: "read", tabId: "t1" }, { signal: ac.signal });
    ac.abort();
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.isError).toBe(false);
    expect(res.output).toContain("interrupted");
    // The command WAS sent — the registry entry is left to expire on its own timer, which is the
    // documented behaviour: there is no cancel path and this does not invent one.
    expect(h.recorded).toHaveLength(1);
  });

  test("an already-aborted turn dispatches NOTHING — the command is never sent", async () => {
    const h = makeHarness();
    const ac = new AbortController();
    ac.abort();
    const res = await h.run({ verb: "read", tabId: "t1" }, { signal: ac.signal });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("was not sent");
    expect(h.recorded).toHaveLength(0);
  });

  test("the abort listener is REMOVED once a command settles normally", async () => {
    // A browsing turn issues many commands against ONE long-lived signal, so a listener left
    // attached per command is genuine accumulation. `AbortSignal` exposes no listener count, so the
    // signal's own add/remove are counted directly — the only measurement available, and a real one:
    // the balance is asserted, not the absence of a crash.
    const h = makeHarness();
    const ac = new AbortController();
    let added = 0;
    let removed = 0;
    const sig = ac.signal;
    const realAdd = sig.addEventListener.bind(sig);
    const realRemove = sig.removeEventListener.bind(sig);
    Object.defineProperty(sig, "addEventListener", {
      value: (...args: Parameters<typeof realAdd>) => { added++; return realAdd(...args); },
    });
    Object.defineProperty(sig, "removeEventListener", {
      value: (...args: Parameters<typeof realRemove>) => { removed++; return realRemove(...args); },
    });
    for (let i = 0; i < 5; i++) {
      expect((await h.run({ verb: "read", tabId: "t1" }, { signal: sig })).isError).toBe(false);
    }
    expect(h.recorded).toHaveLength(5);
    expect(added).toBe(5);
    expect(removed).toBe(5);
  });
});

// ================================================================================================
// The registry seam itself — proven on a synthetic def, independent of `browser`
// ================================================================================================

describe("registry: argsByMode resolves once, for BOTH rendering and validation", () => {
  function seamRegistry(): ToolRegistry {
    const r = new ToolRegistry();
    r.register({
      name: "seam",
      description: "d",
      modes: ["code", "chat"],
      args: z.object({ v: z.enum(["a"]) }),
      argsByMode: { code: z.object({ v: z.enum(["a", "b"]) }) },
      run: () => "ok",
    });
    return r;
  }

  test("rendering and validation agree per mode, and an unknown mode is fail-closed", async () => {
    const r = seamRegistry();
    const ctx = (mode?: "code" | "chat"): ToolContext => ({ cwd: "/x", roots: ["/x"], sessionId: "s", mode }) as ToolContext;
    expect((await r.execute("seam", { v: "b" }, ctx("code"))).isError).toBe(false);
    expect((await r.execute("seam", { v: "b" }, ctx("chat"))).isError).toBe(true);
    expect((await r.execute("seam", { v: "b" }, ctx(undefined))).isError).toBe(true);
    const enumOf = (m?: "code" | "chat") =>
      (r.specFor("seam", "/x", m)?.parameters as { properties: { v: { enum: string[] } } }).properties.v.enum;
    expect(enumOf("code")).toEqual(["a", "b"]);
    expect(enumOf("chat")).toEqual(["a"]);
    expect(enumOf(undefined)).toEqual(["a"]);
  });

  test("a def with no argsByMode is unaffected in every mode", async () => {
    const r = new ToolRegistry();
    r.register({ name: "plain", description: "d", modes: ["code", "chat"], args: z.object({ v: z.string() }), run: () => "ok" });
    for (const mode of [undefined, "code", "chat"] as const) {
      expect((r.specFor("plain", "/x", mode)?.parameters as { properties: { v: unknown } }).properties.v).toBeDefined();
      expect((await r.execute("plain", { v: "x" }, { cwd: "/x", roots: ["/x"], sessionId: "s", mode } as ToolContext)).isError).toBe(false);
    }
  });
});
