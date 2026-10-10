// ComputerV2's DESKTOP SWITCH (user ruling 2026-10-10): when an act or a LIVE picture cannot be had without moving the
// user to the window's desktop, EVERY policy asks — the session's card (`onTimeout: "allow"`) and the helper's
// on-screen panel at once, first answer wins — for a minute; no answer ALLOWS; a refusal is `NeedsForeground`; the
// answer covers the app for the rest of the run; each visit is said in the result and counted in telemetry.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { HelperClient } from "../../src/computer-use/helper-client";
import {
  ComputerPolicy, DESKTOP_PROMPT_BY, DESKTOP_VISIT_CARD_OPTIONS, DESKTOP_VISIT_PROMPT_MS, desktopVisitActReason, desktopVisitCardSummary,
  foregroundCardSummary, newRunGrants, type DesktopVisitPanel, type SessionFacts,
} from "../../src/computer-use/policy";
import { RecentApps } from "../../src/computer-use/recent-apps";
import { ComputerV2Service, type ScriptResult } from "../../src/computer-use/service";
import { AutomationTelemetry } from "../../src/computer-use/telemetry";
import { helperDesktopPanel } from "../../src/computer-use/wiring";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { FakeHelper, FakeHelperError } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;
const NOTES = { bundleId: "com.apple.Notes", name: "Notes" };
const ALL_POLICIES: SessionApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
type Card = Extract<NewSessionEvent, { type: "approval_requested" }>;
type Resolved = Extract<NewSessionEvent, { type: "approval_resolved" }>;
const cardsOf = (events: NewSessionEvent[]): Card[] => events.filter((e) => e.type === "approval_requested") as Card[];
const resolvedOf = (events: NewSessionEvent[]): Resolved[] => events.filter((e) => e.type === "approval_resolved") as Resolved[];

// ── the broker ─────────────────────────────────────────────────────────────────────────────────────

describe("the approval broker: a card that default-allows", () => {
  test("onTimeout: allow resolves the deadline approved by \"timeout\"; every other wait stays fail-closed", async () => {
    const b = new ApprovalBroker();
    const allow = b.wait("s1", "c1", 20, { toolName: "ComputerV2", summary: "x", issuedAt: 1, expiresAt: 21, onTimeout: "allow" });
    expect(b.list("s1")).toEqual([expect.objectContaining({ callId: "c1", onTimeout: "allow" })]);
    expect(b.pendingMeta("s1", "c1")?.onTimeout).toBe("allow");
    expect(await allow).toEqual({ approved: true, by: "timeout" });
    const deny = b.wait("s1", "c2", 20, { toolName: "ComputerV2", summary: "x", issuedAt: 1, expiresAt: 21 });
    expect(b.list("s1")[0]!.onTimeout).toBeUndefined();
    expect(await deny).toEqual({ approved: false, by: "timeout" });
  });

  test("a person's answer before the deadline wins either way", async () => {
    const b = new ApprovalBroker();
    const p = b.wait("s1", "c1", 5_000, { toolName: "ComputerV2", summary: "x", issuedAt: 1, expiresAt: 2, onTimeout: "allow" });
    expect(b.resolve("s1", "c1", false, "orb")).toEqual({ ok: true, alreadyResolved: false });
    expect(await p).toMatchObject({ approved: false, by: "orb" });
  });
});

// ── the policy ─────────────────────────────────────────────────────────────────────────────────────

interface FakePanel extends DesktopVisitPanel {
  shown: Array<{ promptId: string; sessionId: string; app: string; bundleId: string; reason: string; timeoutMs: number }>;
  closed: number;
  answer(a: "switch" | "refuse" | "expired" | undefined): void;
}

function fakePanel(): FakePanel {
  let settle: ((a: "switch" | "refuse" | "expired" | undefined) => void) | undefined;
  const panel: FakePanel = {
    shown: [], closed: 0,
    show(p) {
      panel.shown.push(p);
      return { answer: new Promise((r) => { settle = r; }), close: () => { panel.closed += 1; settle?.(undefined); } };
    },
    answer(a) { settle?.(a); },
  };
  return panel;
}

function policyWorld(opts: { policy?: SessionApprovalPolicy; facts?: Partial<SessionFacts>; attended?: boolean; promptMs?: number; panel?: DesktopVisitPanel; answer?: (c: Card, b: ApprovalBroker) => void } = {}) {
  const approvals = new ApprovalBroker();
  const events: NewSessionEvent[] = [];
  const logs: string[] = [];
  const facts: SessionFacts = { policy: opts.policy ?? "ask", mode: "code", ...opts.facts };
  const policy = new ComputerPolicy({
    settings: () => ({ computerUse: {} }) as unknown as Settings,
    saveAlwaysGrant: () => {},
    approvals,
    emit: (_sid, e) => {
      events.push(e);
      if (e.type === "approval_requested" && opts.answer !== undefined) {
        const c = e as Card;
        queueMicrotask(() => opts.answer!(c, approvals));
      }
    },
    session: () => facts,
    attended: () => opts.attended ?? true,
    ...(opts.panel === undefined ? {} : { desktopPanel: opts.panel }),
    ...(opts.promptMs === undefined ? {} : { desktopVisitPromptMs: opts.promptMs }),
    log: (l) => logs.push(l),
  });
  return { policy, approvals, events, logs };
}

describe("the desktop-switch prompt (policy)", () => {
  test("EVERY policy asks — a Dispatch coordinator and an unattended session too; the card default-allows in a minute", async () => {
    const facts: Array<Partial<SessionFacts>> = [
      ...ALL_POLICIES.map((policy) => ({ policy })),
      { policy: "ask", mode: "dispatch" },
      { policy: "auto", origin: "dispatch-child", parentSessionId: "s_dispatch" },
    ];
    for (const f of facts) {
      const w = policyWorld({ facts: f, attended: false, answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
      const before = Date.now();
      const out = await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "to see what the page shows now");
      expect(out).toEqual({ allowed: true, answer: "allow", via: "card" });
      const [card] = cardsOf(w.events);
      expect(card).toMatchObject({
        toolName: "ComputerV2", threadId: "main", onTimeout: "allow", options: DESKTOP_VISIT_CARD_OPTIONS.map((o) => ({ ...o })),
        summary: desktopVisitCardSummary(NOTES, "to see what the page shows now"),
      });
      expect(card!.callId).toMatch(/^cu_[0-9a-f]{12}$/);
      expect(card!.expiresAt! - card!.issuedAt!).toBe(DESKTOP_VISIT_PROMPT_MS);
      expect(card!.issuedAt!).toBeGreaterThanOrEqual(before);
      expect(resolvedOf(w.events)).toEqual([expect.objectContaining({ callId: card!.callId, approved: true, by: "orb" })]);
    }
  });

  test("the question names the app, its bundle id and the reason — never more; the act's reason is the daemon's words", () => {
    expect(desktopVisitCardSummary(NOTES, "to read the chart")).toBe(
      "Switch to Notes's desktop for a moment? Notes (com.apple.Notes) — to read the chart. Winter brings you back right after; with no answer within a minute, it switches.");
    expect(desktopVisitActReason(NOTES, "click")).toBe("to click in Notes, which it accepts only with its window on screen");
    expect(desktopVisitActReason(NOTES, "type", "Fill in\nthe‮form")).toBe("to type in Notes, which it accepts only with its window on screen (Fill in the form)");
    expect(desktopVisitActReason(NOTES, "type", "x".repeat(400)).length).toBe(200);
    // The same-desktop foreground card no longer speaks of other desktops.
    expect(foregroundCardSummary(NOTES, "keys")).not.toContain("desktop");
  });

  test("no answer within the minute ALLOWS — the resolution says by: timeout", async () => {
    const w = policyWorld({ promptMs: 30, attended: false });
    const out = await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r");
    expect(out).toEqual({ allowed: true, answer: "timeout-allow", via: "timeout" });
    expect(resolvedOf(w.events)).toEqual([expect.objectContaining({ approved: true, by: "timeout" })]);
  });

  test("a refusal on the card is a refusal", async () => {
    const w = policyWorld({ answer: (c, b) => b.resolve(c.sessionId, c.callId, false, "orb") });
    expect(await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r")).toEqual({ allowed: false, answer: "refuse", via: "card" });
  });

  test("the helper's panel shows the same question; ITS answer resolves the card, and the card's answer closes it", async () => {
    // Switch on the panel.
    const p1 = fakePanel();
    const w1 = policyWorld({ panel: p1 });
    const out1 = w1.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "to see the chart");
    await Promise.resolve();
    expect(p1.shown).toEqual([{ promptId: cardsOf(w1.events)[0]!.callId, sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "to see the chart", timeoutMs: DESKTOP_VISIT_PROMPT_MS }]);
    p1.answer("switch");
    expect(await out1).toEqual({ allowed: true, answer: "allow", via: "panel" });
    expect(resolvedOf(w1.events)).toEqual([expect.objectContaining({ approved: true, by: DESKTOP_PROMPT_BY })]);
    expect(p1.closed).toBe(1);
    // Refuse on the panel.
    const p2 = fakePanel();
    const w2 = policyWorld({ panel: p2 });
    const out2 = w2.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r");
    await Promise.resolve();
    p2.answer("refuse");
    expect(await out2).toEqual({ allowed: false, answer: "refuse", via: "panel" });
    // The panel's own countdown ran out: the daemon's rule, allowed by timeout.
    const p3 = fakePanel();
    const w3 = policyWorld({ panel: p3 });
    const out3 = w3.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r");
    await Promise.resolve();
    p3.answer("expired");
    expect(await out3).toEqual({ allowed: true, answer: "timeout-allow", via: "timeout" });
    // The CARD answered first: the panel is closed, and a late panel answer changes nothing.
    const p4 = fakePanel();
    const w4 = policyWorld({ panel: p4, answer: (c, b) => b.resolve(c.sessionId, c.callId, false, "orb") });
    expect(await w4.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r")).toEqual({ allowed: false, answer: "refuse", via: "card" });
    expect(p4.closed).toBe(1);
    p4.answer("switch");
    await Promise.resolve();
    expect(resolvedOf(w4.events)).toHaveLength(1);
  });

  test("a panel that cannot be shown leaves the card to ask alone", async () => {
    const broken: DesktopVisitPanel = { show() { throw new Error("helper gone"); } };
    const w = policyWorld({ panel: broken, answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb") });
    expect(await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r")).toMatchObject({ allowed: true, via: "card" });
    expect(w.logs.some((l) => l.includes("the card alone asks"))).toBe(true);
  });

  test("an interrupt mid-prompt refuses (aborted); chat never asks; the script's clock is paused while it waits", async () => {
    const w = policyWorld();
    const abort = new AbortController();
    const waits: boolean[] = [];
    const run = newRunGrants("s1", (waiting) => waits.push(waiting));
    const out = w.policy.askDesktopVisit(run, NOTES, "r", abort.signal);
    await Promise.resolve();
    abort.abort();
    expect(await out).toEqual({ allowed: false, answer: "aborted", via: "none" });
    expect(waits).toEqual([true, false]);
    const chat = policyWorld({ facts: { policy: "chat", mode: "chat" } });
    expect((await chat.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r")).allowed).toBe(false);
    expect(cardsOf(chat.events)).toEqual([]);
  });

  test("the floors hold first: Winter itself and the system's authentication surfaces are never visited", async () => {
    const w = policyWorld();
    await expect(w.policy.askDesktopVisit(newRunGrants("s1"), { bundleId: "com.winter.app", name: "Winter" }, "r")).rejects.toThrow("Winter never controls itself");
    await expect(w.policy.askDesktopVisit(newRunGrants("s1"), { bundleId: "com.apple.SecurityAgent", name: "SecurityAgent" }, "r")).rejects.toThrow("authentication surface");
    expect(cardsOf(w.events)).toEqual([]);
  });
});

describe("the helper panel adapter (wiring)", () => {
  test("prompt.desktopVisit carries its OWN call id; closing it cancels only that call", async () => {
    const fake = new FakeHelper();
    const helper = new HelperClient({ home: mkdtempSync(join(tmpdir(), "winter-cu-panel-")), profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier });
    const panel = helperDesktopPanel(helper, () => {});
    const shown = panel.show({ promptId: "cu_aaaaaaaaaaaa", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000 });
    while (fake.prompts.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(fake.prompts[0]!.params).toMatchObject({ promptId: "cu_aaaaaaaaaaaa", callId: "cu_aaaaaaaaaaaa", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000 });
    shown.close();
    expect(await shown.answer).toBeUndefined();
    expect(fake.calls("cancel")).toEqual([{ callId: "cu_aaaaaaaaaaaa" }]);
    expect(fake.prompts[0]!.closed).toBe(true);
    // An answer comes back as the panel's word.
    const second = panel.show({ promptId: "cu_bbbbbbbbbbbb", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000 });
    while (fake.prompts.length === 1) await new Promise((r) => setTimeout(r, 5));
    fake.prompts[1]!.answer("refuse");
    expect(await second.answer).toBe("refuse");
    // An older helper that does not know the method: no answer, the card alone asks.
    fake.handlers["prompt.desktopVisit"] = () => { throw new FakeHelperError("unsupported", "unknown method prompt.desktopVisit"); };
    expect(await panel.show({ promptId: "cu_cccccccccccc", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000 }).answer).toBeUndefined();
    helper.close();
  });
});

// ── the service, end to end through a real worker ─────────────────────────────────────────────────

const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

function world(opts: { policy?: SessionApprovalPolicy; facts?: Partial<SessionFacts>; apps?: Record<string, unknown>; promptMs?: number; panel?: boolean; answer?: (c: Card, b: ApprovalBroker, fake: FakeHelper) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-cu-desktop-"));
  const fake = new FakeHelper();
  const approvals = new ApprovalBroker();
  const events: NewSessionEvent[] = [];
  const logs: string[] = [];
  const settings = { computerUse: { apps: opts.apps ?? {} } } as unknown as Settings;
  const facts: SessionFacts = { policy: opts.policy ?? "bypass", mode: "code", ...opts.facts };
  let svc!: ComputerV2Service;
  const helper = new HelperClient({
    home, profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
    onNotification: (n) => svc.handleNotification(n), onDisconnect: () => svc.helperDisconnected(),
  });
  const policy = new ComputerPolicy({
    settings: () => settings, saveAlwaysGrant: () => {}, approvals,
    emit: (_sid, e) => {
      events.push(e);
      if (e.type === "approval_requested" && opts.answer !== undefined) {
        const c = e as Card;
        queueMicrotask(() => opts.answer!(c, approvals, fake));
      }
    },
    session: () => facts,
    attended: () => true,
    ...(opts.panel === false ? {} : { desktopPanel: helperDesktopPanel(helper, (l) => logs.push(l)) }),
    ...(opts.promptMs === undefined ? {} : { desktopVisitPromptMs: opts.promptMs }),
    log: (l) => logs.push(l),
  });
  const telemetry = new AutomationTelemetry(home);
  svc = new ComputerV2Service({ helper, policy, settings: () => settings, telemetry, recentApps: new RecentApps(home), log: (l) => logs.push(l) });
  services.push(svc);
  const run = (code: string, o: { vision?: boolean; timeoutMs?: number; title?: string } = {}): Promise<ScriptResult> =>
    svc.run({ sessionId: "s1", vision: o.vision ?? true, model: "anthropic/claude-opus-5-5" },
      { code, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }), ...(o.title === undefined ? {} : { title: o.title }) });
  const metrics = (): Array<Record<string, unknown>> => {
    try { return readFileSync(telemetry.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };
  return { fake, approvals, events, logs, run, metrics, facts };
}

const text = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
/** The fake helper's `target.act`: the background attempt needs the user's desktop; with `desktopVisit` it visits. */
function visitingAct(visit: { ms: number; returned: boolean; userMoved?: boolean } = { ms: 420, returned: true }) {
  return (p: Record<string, unknown>) => {
    if (p.desktopVisit !== true) throw new FakeHelperError("needs_desktop_visit", "Notes's window is on another desktop, and this click needs it on screen", { why: "act" });
    return { rung: 4, visit };
  };
}

describe("ComputerV2: the desktop switch end to end", () => {
  macOnly("an act that needs the window's desktop: the prompt, then ONE visit, said in the result and counted", async () => {
    const w = world({ policy: "ask", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", c.summary.startsWith("Allow") ? "session" : "switch") });
    w.fake.handlers["target.act"] = visitingAct();
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)", { title: "Press the chart's Refresh" });
    expect(r.isError).toBe(false);
    const switchCard = cardsOf(w.events).find((c) => c.onTimeout === "allow")!;
    expect(switchCard.summary).toBe(desktopVisitCardSummary(NOTES, "to click in Notes, which it accepts only with its window on screen (Press the chart's Refresh)"));
    expect(w.fake.calls("target.act").map((a) => [a.desktopVisit, a.allowForeground])).toEqual([[undefined, false], [true, true]]);
    expect(text(r)).toContain("moved the user to Notes's desktop for 420 ms and back");
    // The visit line is the daemon's own words: its own item, outside the DATA-ONLY fence.
    const line = r.content.find((c) => c.type === "text" && c.text.includes("moved the user to"));
    expect(line?.type === "text" && !line.text.includes("<screen-data")).toBe(true);
    // The on-screen panel was shown with the same question, and closed when the card was answered.
    expect(w.fake.prompts).toHaveLength(1);
    expect(w.fake.prompts[0]!.params).toMatchObject({ app: "Notes", bundleId: "com.apple.Notes", callId: switchCard.callId });
    expect(w.fake.prompts[0]!.closed).toBe(true);
    const clicks = w.metrics().filter((m) => m.primitive === "click");
    expect(clicks[0]).toMatchObject({ visit: { count: 1, ms: 420, returned: true }, visitAnswer: "allow", visitVia: "card", rung: 4 });
  }, 30_000);

  macOnly("the allowance covers the app for the rest of the run (no re-prompt), never the next run", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    w.fake.handlers["target.act"] = visitingAct();
    await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)\nawait notes.click(15)\nawait notes.type('hi')");
    expect(cardsOf(w.events)).toHaveLength(1); // bypass: no per-app card — but the desktop switch asks
    expect(w.fake.calls("target.act").map((a) => a.desktopVisit)).toEqual([undefined, true, true, true]);
    const later = w.metrics().filter((m) => m.primitive === "click" || m.primitive === "type").slice(1);
    expect(later.every((m) => m.visitAnswer === undefined && (m.visit as { count: number }).count === 1)).toBe(true);
    // The next run asks again.
    await w.run("await notes.click(14)");
    expect(cardsOf(w.events)).toHaveLength(2);
  }, 30_000);

  macOnly("a refusal: NeedsForeground naming it, nothing visited, and not asked again in that run", async () => {
    const w = world({ policy: "auto", answer: (c, b) => b.resolve(c.sessionId, c.callId, c.onTimeout !== "allow", "orb", c.onTimeout === "allow" ? undefined : "session") });
    w.fake.handlers["target.act"] = visitingAct();
    const r = await w.run("const notes = await apps.open('Notes')\nfor (const ref of [14, 15]) { try { await notes.click(ref) } catch (e) { print(e.name, e.message) } }");
    expect(text(r)).toContain("NeedsForeground the user refused to be moved to Notes's desktop for this click");
    expect(cardsOf(w.events).filter((c) => c.onTimeout === "allow")).toHaveLength(1);
    expect(w.fake.calls("target.act").every((a) => a.desktopVisit === undefined)).toBe(true);
    expect(w.metrics().filter((m) => m.primitive === "click").map((m) => m.visitAnswer)).toEqual(["refuse", "run-refusal"]);
  }, 30_000);

  macOnly("no answer within the minute ALLOWS — under dont-ask and plan's live read too — and the pause never eats the script's time", async () => {
    // dont-ask on an Always-allow app: no per-app card, but the desktop switch asks — and times out to allow. The
    // prompt outlasts the script's own 1 s timeout: its wait is paused like any card's.
    const w = world({ policy: "dont-ask", apps: { "com.apple.Notes": { grant: "always" } }, promptMs: 1_300 });
    w.fake.handlers["target.act"] = visitingAct({ ms: 380, returned: true });
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)", { timeoutMs: 1_000 });
    expect(r.isError).toBe(false);
    expect(resolvedOf(w.events)).toEqual([expect.objectContaining({ approved: true, by: "timeout" })]);
    expect(text(r)).toContain("moved the user to Notes's desktop for 380 ms and back");
    expect(w.metrics().find((m) => m.primitive === "click")).toMatchObject({ visitAnswer: "timeout-allow", visitVia: "timeout" });
    // plan never acts, but may ask for a live picture.
    const plan = world({ policy: "plan", promptMs: 30, answer: (c, b) => { if (c.onTimeout !== "allow") b.resolve(c.sessionId, c.callId, true, "orb", "session"); } });
    plan.fake.handlers["target.screenshot"] = (p) => {
      if (p.desktopVisit !== true) throw new FakeHelperError("needs_desktop_visit", "stale there", { why: "live" });
      return { imageBase64: Buffer.from("jpeg").toString("base64"), mime: "image/jpeg", width: 800, height: 600, shotId: "shotL", visit: { ms: 510, returned: true } };
    };
    const rp = await plan.run("const notes = await apps.open('Notes')\nawait notes.screenshot({ live: true, reason: 'to read the live chart' })");
    expect(rp.isError).toBe(false);
    expect(text(rp)).toContain("moved the user to Notes's desktop for 510 ms and back");
    expect(text(rp)).toContain("[image]");
  }, 30_000);

  macOnly("screenshot({ live: true, reason }): the reason is required and reaches the prompt; on screen there is no prompt at all", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    let offDesktop = false;
    w.fake.handlers["target.screenshot"] = (p) => {
      if (p.live === true && offDesktop && p.desktopVisit !== true) throw new FakeHelperError("needs_desktop_visit", "stale there", { why: "live" });
      return { imageBase64: Buffer.from("jpeg").toString("base64"), mime: "image/jpeg", width: 800, height: 600, shotId: "s", ...(p.desktopVisit === true ? { visit: { ms: 600, returned: true } } : {}) };
    };
    const noReason = await w.run("const notes = await apps.open('Notes')\ntry { await notes.screenshot({ live: true }) } catch (e) { print(e.name, e.message) }");
    expect(text(noReason)).toContain("TypeError screenshot({ live: true }) takes a reason");
    // On this desktop the helper takes it from here: live, no prompt.
    await w.run("await notes.screenshot({ live: true, reason: 'to see the chart' })");
    expect(w.fake.calls("target.screenshot").at(-1)).toMatchObject({ live: true });
    expect(cardsOf(w.events)).toEqual([]);
    // Off this desktop: the prompt carries the (sanitized) reason, then the visit.
    offDesktop = true;
    const r = await w.run("await notes.screenshot({ live: true, reason: 'to see\\nthe chart\\u202e now' })");
    expect(cardsOf(w.events)[0]!.summary).toBe(desktopVisitCardSummary(NOTES, "to see the chart now"));
    expect(w.fake.calls("target.screenshot").slice(-2).map((p) => p.desktopVisit)).toEqual([undefined, true]);
    expect(text(r)).toContain("moved the user to Notes's desktop for 600 ms and back");
    // A model without image input has no screenshot at all.
    const blind = await w.run("try { await notes.screenshot({ live: true, reason: 'x' }) } catch (e) { print(e.name) }", { vision: false });
    expect(text(blind)).toContain("NotAllowed");
  }, 30_000);

  macOnly("a failed return is LOUD: a notice at the top of the result and a warning in the log; a user who took over is left be", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    w.fake.handlers["target.act"] = visitingAct({ ms: 2_400, returned: false });
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    // A notice: before the script's output (right after the fence's preamble), never inside a fenced block.
    const at = r.content.findIndex((c) => c.type === "text" && c.text.startsWith("Winter moved the user to Notes's desktop and could NOT bring them back"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(r.content.slice(0, at).every((c) => c.type === "text" && !c.text.includes("<screen-data id=\"") || (c.type === "text" && c.text.startsWith("Text between")))).toBe(true);
    expect(w.logs.some((l) => l.includes("WARNING desktop visit to com.apple.Notes") && l.includes("NOT returned"))).toBe(true);
    expect(w.metrics().find((m) => m.primitive === "click")).toMatchObject({ visit: { count: 1, ms: 2_400, returned: false } });

    const moved = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    moved.fake.handlers["target.act"] = visitingAct({ ms: 700, returned: false, userMoved: true });
    const r2 = await moved.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    expect(text(r2)).toContain("they took over during it, so Winter left them where they went");
    expect(text(r2)).not.toContain("could NOT bring them back");
  }, 30_000);

  macOnly("the panel answers first: the card resolves as the on-screen prompt's, and the act visits", async () => {
    const w = world({ policy: "ask", answer: (c, b, fake) => {
      if (c.onTimeout !== "allow") { b.resolve(c.sessionId, c.callId, true, "orb", "session"); return; }
      const click = (): void => { const p = fake.prompts.find((x) => x.params.callId === c.callId); if (p) p.answer("switch"); else setTimeout(click, 5); };
      click();
    } });
    w.fake.handlers["target.act"] = visitingAct();
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    expect(r.isError).toBe(false);
    expect(resolvedOf(w.events).at(-1)).toMatchObject({ approved: true, by: DESKTOP_PROMPT_BY });
    expect(w.metrics().find((m) => m.primitive === "click")).toMatchObject({ visitAnswer: "allow", visitVia: "panel" });
  }, 30_000);

  macOnly("the same-desktop rung 4 keeps its own rules; a window that went off-desktop after the foreground card asks for the visit", async () => {
    const w = world({ policy: "ask", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", c.summary.startsWith("Allow") ? "session" : c.onTimeout === "allow" ? "switch" : undefined) });
    w.fake.handlers["target.act"] = (p) => {
      if (p.allowForeground !== true) throw new FakeHelperError("needs_foreground", "canvas");
      if (p.desktopVisit !== true) throw new FakeHelperError("needs_desktop_visit", "elsewhere now", { why: "act" });
      return { rung: 4, visit: { ms: 300, returned: true } };
    };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    expect(r.isError).toBe(false);
    expect(cardsOf(w.events).map((c) => c.onTimeout ?? c.summary.slice(0, 22))).toEqual(["Allow Winter to use No", "Winter needs to bring ", "allow"]);
    expect(w.fake.calls("target.act").map((a) => [a.allowForeground, a.desktopVisit])).toEqual([[false, undefined], [true, undefined], [true, true]]);
  }, 30_000);

  macOnly("a helper that asks again after the allowance: NeedsForeground (never a bare Error), and no second prompt", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("needs_desktop_visit", "still elsewhere", { why: "act" }); };
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.click(14) } catch (e) { print(e.name, e.message) }");
    expect(text(r)).toContain("NeedsForeground Notes's window is on another desktop and this needs it on screen");
    expect(cardsOf(w.events)).toHaveLength(1);
    expect(w.fake.calls("target.act").map((a) => a.desktopVisit)).toEqual([undefined, true]);
  }, 30_000);

  macOnly("view-only apps never get the prompt for an act, but may for a live read", async () => {
    const w = world({ policy: "bypass", apps: { "com.apple.Notes": { access: "view" } }, answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    w.fake.handlers["target.act"] = visitingAct();
    w.fake.handlers["target.screenshot"] = (p) => {
      if (p.desktopVisit !== true) throw new FakeHelperError("needs_desktop_visit", "stale", { why: "live" });
      return { imageBase64: Buffer.from("jpeg").toString("base64"), mime: "image/jpeg", width: 8, height: 6, shotId: "s", visit: { ms: 250, returned: true } };
    };
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.click(14) } catch (e) { print(e.name) }\nawait notes.screenshot({ live: true, reason: 'to look' })");
    expect(text(r)).toContain("NotAllowed");
    expect(w.fake.calls("target.act")).toEqual([]);
    expect(cardsOf(w.events)).toHaveLength(1);
    expect(text(r)).toContain("moved the user to Notes's desktop for 250 ms and back");
  }, 30_000);
});
