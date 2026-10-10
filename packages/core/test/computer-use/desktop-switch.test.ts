// ComputerV2's DESKTOP SWITCH (user rulings 2026-10-10): when an act or a LIVE picture cannot be had without moving the
// user to the window's desktop, EVERY policy asks — the session's card (`onTimeout: "allow"`) and the helper's
// on-screen panel at once, first answer wins — for a minute; no answer ALLOWS; a person's refusal is `NeedsForeground`
// and holds until the user's next message (5a); the answer covers the app for the rest of the run; the visit stays
// OPEN across the primitives that need it (5d) and is closed and said — one line, one metrics entry — at the latest
// when the script ends.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewSessionEvent, SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { HelperClient } from "../../src/computer-use/helper-client";
import { FOREGROUND_LOCK_KEY } from "../../src/computer-use/locks";
import {
  cardName, ComputerPolicy, DESKTOP_PROMPT_BY, DESKTOP_VISIT_CARD_OPTIONS, DESKTOP_VISIT_PROMPT_MS, desktopVisitActReason, desktopVisitCardSummary,
  foregroundCardSummary, newRunGrants, type DesktopVisitPanel, type SessionFacts,
} from "../../src/computer-use/policy";
import { RecentApps } from "../../src/computer-use/recent-apps";
import { ComputerV2Service, visitLine, type ScriptResult } from "../../src/computer-use/service";
import { AutomationTelemetry } from "../../src/computer-use/telemetry";
import { desktopRefusalLiftFor, helperDesktopPanel } from "../../src/computer-use/wiring";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { FakeHelper, FakeHelperError } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;
const NOTES = { bundleId: "com.apple.Notes", name: "Notes" };
const ALL_POLICIES: SessionApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
type Card = Extract<NewSessionEvent, { type: "approval_requested" }>;
type Resolved = Extract<NewSessionEvent, { type: "approval_resolved" }>;
const cardsOf = (events: NewSessionEvent[]): Card[] => events.filter((e) => e.type === "approval_requested") as Card[];
const switchCards = (events: NewSessionEvent[]): Card[] => cardsOf(events).filter((c) => c.onTimeout === "allow");
const resolvedOf = (events: NewSessionEvent[]): Resolved[] => events.filter((e) => e.type === "approval_resolved") as Resolved[];
const REFUSED = "the user refused to be moved to Notes's desktop — ask them in your reply if it is needed";

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

type Shown = Parameters<DesktopVisitPanel["show"]>[0];
interface FakePanel extends DesktopVisitPanel {
  shown: Shown[];
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

function policyWorld(opts: { policy?: SessionApprovalPolicy; facts?: Partial<SessionFacts>; factsFor?: (sid: string) => SessionFacts; attended?: boolean; promptMs?: number; graceMs?: number; panel?: DesktopVisitPanel; emitThrows?: boolean; answer?: (c: Card, b: ApprovalBroker) => void } = {}) {
  const approvals = new ApprovalBroker();
  const events: NewSessionEvent[] = [];
  const logs: string[] = [];
  const facts: SessionFacts = { policy: opts.policy ?? "ask", mode: "code", ...opts.facts };
  const policy = new ComputerPolicy({
    settings: () => ({ computerUse: {} }) as unknown as Settings,
    saveAlwaysGrant: () => {},
    approvals,
    emit: (_sid, e) => {
      if (opts.emitThrows === true && e.type === "approval_requested") throw new Error("log closed");
      events.push(e);
      if (e.type === "approval_requested" && opts.answer !== undefined) {
        const c = e as Card;
        queueMicrotask(() => opts.answer!(c, approvals));
      }
    },
    session: (sid) => opts.factsFor?.(sid) ?? facts,
    attended: () => opts.attended ?? true,
    ...(opts.panel === undefined ? {} : { desktopPanel: opts.panel }),
    ...(opts.promptMs === undefined ? {} : { desktopVisitPromptMs: opts.promptMs }),
    ...(opts.graceMs === undefined ? {} : { desktopVisitGraceMs: opts.graceMs }),
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
    expect(foregroundCardSummary(NOTES, "keys")).not.toContain("desktop");
  });

  test("the APP NAME on every card is cleaned like the reason: no bidi or control characters, one line, at most 80 (8f)", () => {
    const evil = { bundleId: "com.evil.app", name: "Notes‮\u0007 sneaky\n" + "x".repeat(200) };
    for (const summary of [desktopVisitCardSummary(evil, "r"), desktopVisitActReason(evil, "click")]) {
      expect(summary).not.toMatch(/[\u0000-\u001f‪-‮⁦-⁩]/);
    }
    expect(cardName(evil.name).length).toBe(80);
    expect(cardName("Notes‮")).toBe("Notes");
    expect(cardName("‮\u0007")).toBe("this app");
    expect(desktopVisitCardSummary(evil, "r")).toContain(`${cardName(evil.name)} (com.evil.app)`);
  });

  test("no answer within the minute ALLOWS — the resolution says by: timeout; it is never a refusal", async () => {
    const w = policyWorld({ promptMs: 30, graceMs: 10, attended: false });
    const out = await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r");
    expect(out).toEqual({ allowed: true, answer: "timeout-allow", via: "timeout" });
    expect(resolvedOf(w.events)).toEqual([expect.objectContaining({ approved: true, by: "timeout" })]);
    expect(w.policy.desktopRefused("s1", NOTES.bundleId)).toBe(false);
  });

  test("the panel counts down to the CARD's own deadline (absolute), and an answer racing it still wins within the grace (7)", async () => {
    const panel = fakePanel();
    // The card's deadline is 30 ms out; the user's click lands 80 ms in — after the deadline, inside the 1 s grace.
    const w = policyWorld({ promptMs: 30, panel, answer: (c, b) => { setTimeout(() => b.resolve(c.sessionId, c.callId, false, "orb"), 80); } });
    const out = await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r");
    expect(out).toEqual({ allowed: false, answer: "refuse", via: "card" });
    expect(panel.shown[0]!.expiresAt).toBe(cardsOf(w.events)[0]!.expiresAt!);
    // The panel's own "expired" decides nothing: a card answer after it, still inside the grace, wins.
    const p2 = fakePanel();
    const w2 = policyWorld({ promptMs: 20, graceMs: 200, panel: p2, answer: (c, b) => { setTimeout(() => b.resolve(c.sessionId, c.callId, false, "orb"), 60); } });
    const out2 = w2.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r");
    await new Promise((r) => setTimeout(r, 25));
    p2.answer("expired");
    expect(await out2).toEqual({ allowed: false, answer: "refuse", via: "card" });
  });

  test("a refusal on the card is a refusal — and it HOLDS for that app until the user's next message (5a)", async () => {
    const w = policyWorld({ answer: (c, b) => b.resolve(c.sessionId, c.callId, false, "orb") });
    expect(await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r")).toEqual({ allowed: false, answer: "refuse", via: "card" });
    expect(w.policy.desktopRefused("s1", NOTES.bundleId)).toBe(true);
    expect(w.policy.desktopRefused("s1", "com.apple.TextEdit")).toBe(false);
    expect(w.policy.desktopRefused("s2", NOTES.bundleId)).toBe(false);
    w.policy.liftDesktopRefusals("s1");
    expect(w.policy.desktopRefused("s1", NOTES.bundleId)).toBe(false);
  });

  test("a dispatch child's refusal lifts on the user's next message to the child OR its coordinator — not another session's", () => {
    const w = policyWorld({ factsFor: (sid) => (sid.startsWith("child") ? { policy: "auto", mode: "code", origin: "dispatch-child", parentSessionId: "coord" } : { policy: "ask", mode: "code" }) });
    w.policy.noteDesktopRefusal("child1", NOTES.bundleId);
    w.policy.noteDesktopRefusal("child2", NOTES.bundleId);
    w.policy.liftDesktopRefusals("someone-else");
    expect(w.policy.desktopRefused("child1", NOTES.bundleId)).toBe(true);
    w.policy.liftDesktopRefusals("coord");
    expect(w.policy.desktopRefused("child1", NOTES.bundleId)).toBe(false);
    expect(w.policy.desktopRefused("child2", NOTES.bundleId)).toBe(false);
    w.policy.noteDesktopRefusal("child1", NOTES.bundleId);
    w.policy.liftDesktopRefusals("child1");
    expect(w.policy.desktopRefused("child1", NOTES.bundleId)).toBe(false);
  });

  test("only a HUMAN-origin user_message lifts a refusal — never messaging, dispatch or dispatch-wake", () => {
    const msg = (clientName?: string): SessionEvent => ({ type: "user_message", seq: 1, ts: 0, sessionId: "s1", threadId: "main", text: "hi", ...(clientName === undefined ? {} : { clientName }) }) as unknown as SessionEvent;
    expect(desktopRefusalLiftFor(msg("orb"))).toBe("s1");
    expect(desktopRefusalLiftFor(msg("iphone-gateway"))).toBe("s1");
    expect(desktopRefusalLiftFor(msg(undefined))).toBe("s1");
    for (const automated of ["messaging", "dispatch", "dispatch-wake"]) expect(desktopRefusalLiftFor(msg(automated))).toBeUndefined();
    expect(desktopRefusalLiftFor({ type: "turn_started", seq: 2, ts: 0, sessionId: "s1", threadId: "main" } as unknown as SessionEvent)).toBeUndefined();
  });

  test("the helper's panel shows the same question; ITS answer resolves the card, and the card's answer closes it", async () => {
    const p1 = fakePanel();
    const w1 = policyWorld({ panel: p1 });
    const out1 = w1.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "to see the chart");
    await Promise.resolve();
    const card = cardsOf(w1.events)[0]!;
    expect(p1.shown).toEqual([{ promptId: card.callId, sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "to see the chart", timeoutMs: DESKTOP_VISIT_PROMPT_MS, expiresAt: card.expiresAt! }]);
    p1.answer("switch");
    expect(await out1).toEqual({ allowed: true, answer: "allow", via: "panel" });
    expect(resolvedOf(w1.events)).toEqual([expect.objectContaining({ approved: true, by: DESKTOP_PROMPT_BY })]);
    expect(p1.closed).toBe(1);
    // Refuse on the panel: a refusal, held like the card's.
    const p2 = fakePanel();
    const w2 = policyWorld({ panel: p2 });
    const out2 = w2.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r");
    await Promise.resolve();
    p2.answer("refuse");
    expect(await out2).toEqual({ allowed: false, answer: "refuse", via: "panel" });
    expect(w2.policy.desktopRefused("s1", NOTES.bundleId)).toBe(true);
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

  test("a card that cannot be raised is 'unavailable' — never a refusal, never held (8d)", async () => {
    const w = policyWorld({ emitThrows: true });
    expect(await w.policy.askDesktopVisit(newRunGrants("s1"), NOTES, "r")).toEqual({ allowed: false, answer: "unavailable", via: "none" });
    expect(w.policy.desktopRefused("s1", NOTES.bundleId)).toBe(false);
  });

  test("an interrupt mid-prompt refuses (aborted, not held); chat never asks; the script's clock is paused while it waits", async () => {
    const w = policyWorld();
    const abort = new AbortController();
    const waits: boolean[] = [];
    const run = newRunGrants("s1", (waiting) => waits.push(waiting));
    const out = w.policy.askDesktopVisit(run, NOTES, "r", abort.signal);
    await Promise.resolve();
    abort.abort();
    expect(await out).toEqual({ allowed: false, answer: "aborted", via: "none" });
    expect(waits).toEqual([true, false]);
    expect(w.policy.desktopRefused("s1", NOTES.bundleId)).toBe(false);
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
  test("prompt.desktopVisit carries its OWN call id and the card's deadline; closing it cancels only that call", async () => {
    const fake = new FakeHelper();
    const helper = new HelperClient({ home: mkdtempSync(join(tmpdir(), "winter-cu-panel-")), profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier });
    const panel = helperDesktopPanel(helper, () => {});
    const shown = panel.show({ promptId: "cu_aaaaaaaaaaaa", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000, expiresAt: 1_781_270_060_000 });
    while (fake.prompts.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(fake.prompts[0]!.params).toMatchObject({ promptId: "cu_aaaaaaaaaaaa", callId: "cu_aaaaaaaaaaaa", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000, expiresAt: 1_781_270_060_000 });
    shown.close();
    expect(await shown.answer).toBeUndefined();
    expect(fake.calls("cancel")).toEqual([{ callId: "cu_aaaaaaaaaaaa" }]);
    expect(fake.prompts[0]!.closed).toBe(true);
    const second = panel.show({ promptId: "cu_bbbbbbbbbbbb", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000, expiresAt: 1 });
    while (fake.prompts.length === 1) await new Promise((r) => setTimeout(r, 5));
    fake.prompts[1]!.answer("refuse");
    expect(await second.answer).toBe("refuse");
    fake.handlers["prompt.desktopVisit"] = () => { throw new FakeHelperError("unsupported", "unknown method prompt.desktopVisit"); };
    expect(await panel.show({ promptId: "cu_cccccccccccc", sessionId: "s1", app: "Notes", bundleId: "com.apple.Notes", reason: "r", timeoutMs: 60_000, expiresAt: 1 }).answer).toBeUndefined();
    helper.close();
  });
});

describe("the result's words for a closed visit", () => {
  test("one line per visit — its time away and how many actions ran in it; a failed return is a notice; a user who took over is left be", () => {
    expect(visitLine("Safari", { ms: 2_400, actions: 5, returned: true })).toEqual({ line: "moved the user to Safari's desktop for 2.4 s (5 actions) and back" });
    expect(visitLine("Safari", { ms: 420, actions: 1, returned: true })).toEqual({ line: "moved the user to Safari's desktop for 420 ms (1 action) and back" });
    expect(visitLine("Safari", { ms: 700, actions: 2, returned: false, userMoved: true }).line).toContain("they took over during it, so Winter left them where they went");
    expect(visitLine("Safari", { ms: 2_200, actions: 1, returned: false }).notice).toContain("could NOT bring them back");
  });
});

// ── the service, end to end through a real worker ─────────────────────────────────────────────────

const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

function world(opts: { policy?: SessionApprovalPolicy; facts?: Partial<SessionFacts>; apps?: Record<string, unknown>; promptMs?: number; panel?: boolean; attended?: boolean; answer?: (c: Card, b: ApprovalBroker, fake: FakeHelper) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-cu-desktop-"));
  const fake = new FakeHelper();
  const approvals = new ApprovalBroker();
  const events: NewSessionEvent[] = [];
  const logs: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
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
    attended: () => opts.attended ?? true,
    ...(opts.panel === false ? {} : { desktopPanel: helperDesktopPanel(helper, (l) => logs.push(l)) }),
    ...(opts.promptMs === undefined ? {} : { desktopVisitPromptMs: opts.promptMs, desktopVisitGraceMs: 10 }),
    log: (l) => logs.push(l),
  });
  const telemetry = new AutomationTelemetry(home);
  svc = new ComputerV2Service({ helper, policy, settings: () => settings, telemetry, recentApps: new RecentApps(home), log: (l) => logs.push(l), audit: (l) => audits.push(l) });
  services.push(svc);
  const run = (code: string, o: { vision?: boolean; timeoutMs?: number; title?: string; signal?: AbortSignal } = {}): Promise<ScriptResult> =>
    svc.run({ sessionId: "s1", vision: o.vision ?? true, model: "anthropic/claude-opus-5-5", ...(o.signal === undefined ? {} : { signal: o.signal }) },
      { code, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }), ...(o.title === undefined ? {} : { title: o.title }) });
  const metrics = (): Array<Record<string, unknown>> => {
    try { return readFileSync(telemetry.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };
  return { fake, approvals, events, logs, audits, run, metrics, facts, policy, svc };
}

const text = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");

/**
 * The helper's OPEN-VISIT model, on the fake (5d): a primitive carrying `desktopVisit: true` that needs the window's
 * desktop opens the visit (once — `opens` counts the switches) and runs there (`inVisit: true`); the visit stays open
 * until `visit.close` (or `close()`), which hands every closed report over once and notifies `desktopVisited`.
 */
function openVisits(fake: FakeHelper, report: { ms?: number; returned?: boolean; userMoved?: boolean } = {}) {
  let open: { targetId: string; actions: number } | undefined;
  const closed: Array<Record<string, unknown>> = [];
  const v = { opens: 0, closes: 0, enter(p: Record<string, unknown>): void {
    if (p.desktopVisit !== true) throw new FakeHelperError("needs_desktop_visit", "Notes's window is on another desktop, and this needs it on screen", { why: "act" });
    if (open === undefined) { open = { targetId: String(p.targetId), actions: 0 }; v.opens++; }
    open.actions++;
  }, close(): void {
    if (open === undefined) return;
    v.closes++;
    const r = { visitId: `v${v.closes}`, targetId: open.targetId, app: "Notes", why: "act", actions: open.actions, ms: report.ms ?? 420, returned: report.returned ?? true, ...(report.userMoved === true ? { userMoved: true } : {}) };
    open = undefined;
    closed.push(r);
    fake.notify("desktopVisited", { ...r, sessionId: "s1", callId: "cv2" });
  }, get isOpen(): boolean { return open !== undefined; } };
  fake.handlers["visit.close"] = () => { v.close(); return { visits: closed.splice(0) }; };
  return v;
}

describe("ComputerV2: the desktop switch end to end", () => {
  macOnly("an act that needs the window's desktop: the prompt, then the visit — closed and said at the script's end, one metrics entry", async () => {
    const w = world({ policy: "ask", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", c.summary.startsWith("Allow") ? "session" : "switch") });
    const v = openVisits(w.fake);
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)", { title: "Press the chart's Refresh" });
    expect(r.isError).toBe(false);
    expect(switchCards(w.events)[0]!.summary).toBe(desktopVisitCardSummary(NOTES, "to click in Notes, which it accepts only with its window on screen (Press the chart's Refresh)"));
    // The visit allowance never stands in for allowForeground (blocker 1): only desktopVisit is added.
    expect(w.fake.calls("target.act").map((a) => [a.desktopVisit, a.allowForeground, a.visitMaxMs])).toEqual([[undefined, false, undefined], [true, false, 10_000]]);
    expect(w.fake.calls("visit.close")).toEqual([{ sessionId: "s1" }]);
    expect(text(r)).toContain("moved the user to Notes's desktop for 420 ms (1 action) and back");
    const line = r.content.find((c) => c.type === "text" && c.text.includes("moved the user to"));
    expect(line?.type === "text" && !line.text.includes("<screen-data")).toBe(true);
    expect(w.fake.prompts[0]!.params).toMatchObject({ app: "Notes", bundleId: "com.apple.Notes", callId: switchCards(w.events)[0]!.callId });
    expect(w.fake.prompts[0]!.closed).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(w.metrics().filter((m) => m.primitive === "desktop.visit")).toEqual([expect.objectContaining({ visit: { actions: 1, ms: 420, returned: true }, visitWhy: "act" })]);
    expect(w.metrics().find((m) => m.primitive === "click" && m.inVisit === true)).toMatchObject({ visitAnswer: "allow", visitVia: "card", rung: 4 });
    expect(w.audits.at(-1)).toMatchObject({ kind: "automation", desktopVisits: 1 });
  }, 30_000);

  macOnly("ONE visit for a stretch of work: three back-to-back acts are one prompt, one switch, one return and one line", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake, { ms: 2_400 });
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)\nawait notes.click(15)\nawait notes.type('hi')");
    expect(switchCards(w.events)).toHaveLength(1);
    expect(v.opens).toBe(1);
    expect(v.closes).toBe(1);
    expect(text(r).match(/moved the user to/g)).toHaveLength(1);
    expect(text(r)).toContain("moved the user to Notes's desktop for 2.4 s (3 actions) and back");
    expect(w.fake.calls("target.act").map((a) => a.desktopVisit)).toEqual([undefined, true, true, true]);
    // The next run asks again (the allowance is the run's).
    await w.run("await notes.click(14)");
    expect(switchCards(w.events)).toHaveLength(2);
  }, 30_000);

  macOnly("the open visit holds the screen's foreground lock, and lets it go when the helper reports the visit closed", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake);
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    let heldDuring: unknown;
    let heldAfterClose: unknown;
    w.fake.handlers["target.snapshot"] = () => {
      heldDuring ??= w.svc.locks.holder(FOREGROUND_LOCK_KEY);
      return { snapshotId: "s", text: "Notes", isDiff: false, changedRatio: 1, settled: true, waitedMs: 0 };
    };
    // The helper closes the visit by itself (its grace after the last visit-needing act): the lock goes with it.
    w.fake.handlers["target.find"] = async () => {
      v.close();
      await new Promise((res) => setTimeout(res, 20));
      heldAfterClose = w.svc.locks.holder(FOREGROUND_LOCK_KEY) ?? null;
      return { elements: [] };
    };
    await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)\nawait notes.state()\nawait notes.find('x')");
    expect(heldDuring).toMatchObject({ sessionId: "s1" });
    expect(heldAfterClose).toBeNull();
  }, 30_000);

  macOnly("a REFUSAL holds until the user's next message: no new prompt meanwhile, in that run and the next (5a)", async () => {
    const w = world({ policy: "auto", answer: (c, b) => b.resolve(c.sessionId, c.callId, c.onTimeout !== "allow", "orb", c.onTimeout === "allow" ? undefined : "session") });
    const v = openVisits(w.fake);
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    const r = await w.run("const notes = await apps.open('Notes')\nfor (const ref of [14, 15]) { try { await notes.click(ref) } catch (e) { print(e.name, e.message) } }");
    expect(text(r)).toContain(`NeedsForeground ${REFUSED}`);
    expect(switchCards(w.events)).toHaveLength(1);
    const r2 = await w.run("try { await notes.click(14) } catch (e) { print(e.name, e.message) }");
    expect(text(r2)).toContain(`NeedsForeground ${REFUSED}`);
    expect(switchCards(w.events)).toHaveLength(1);
    expect(w.fake.calls("target.act").every((a) => a.desktopVisit === undefined)).toBe(true);
    expect(w.metrics().filter((m) => m.primitive === "click").map((m) => m.visitAnswer)).toEqual(["refuse", "held-refusal", "held-refusal"]);
    // The user's next message lifts it: the next need asks again.
    w.policy.liftDesktopRefusals("s1");
    await w.run("try { await notes.click(14) } catch (e) { print(e.name) }");
    expect(switchCards(w.events)).toHaveLength(2);
  }, 30_000);

  macOnly("no answer within the minute ALLOWS — under dont-ask, and plan's live read too — and the pause never eats the script's time", async () => {
    const w = world({ policy: "dont-ask", apps: { "com.apple.Notes": { grant: "always" } }, promptMs: 1_300 });
    const v = openVisits(w.fake, { ms: 380 });
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)", { timeoutMs: 1_000 });
    expect(r.isError).toBe(false);
    expect(resolvedOf(w.events)).toEqual([expect.objectContaining({ approved: true, by: "timeout" })]);
    expect(text(r)).toContain("moved the user to Notes's desktop for 380 ms (1 action) and back");
    expect(w.metrics().find((m) => m.primitive === "click")).toMatchObject({ visitAnswer: "timeout-allow", visitVia: "timeout" });
    expect(w.policy.desktopRefused("s1", NOTES.bundleId)).toBe(false);

    const plan = world({ policy: "plan", promptMs: 30, answer: (c, b) => { if (c.onTimeout !== "allow") b.resolve(c.sessionId, c.callId, true, "orb", "session"); } });
    const pv = openVisits(plan.fake, { ms: 510 });
    plan.fake.handlers["target.screenshot"] = (p) => {
      if (p.live !== true || p.desktopVisit !== true) throw new FakeHelperError("needs_desktop_visit", "stale there", { why: "live" });
      pv.enter(p);
      return { imageBase64: Buffer.from("jpeg").toString("base64"), mime: "image/jpeg", width: 800, height: 600, shotId: "shotL", inVisit: true };
    };
    const rp = await plan.run("const notes = await apps.open('Notes')\nawait notes.screenshot({ live: true, reason: 'to read the live chart' })");
    expect(rp.isError).toBe(false);
    expect(text(rp)).toContain("moved the user to Notes's desktop for 510 ms (1 action) and back");
    expect(text(rp)).toContain("[image]");
  }, 30_000);

  macOnly("screenshot({ live: true, reason }): the reason is required and reaches the prompt; on screen there is no prompt at all", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake, { ms: 600 });
    let offDesktop = false;
    w.fake.handlers["target.screenshot"] = (p) => {
      if (p.live === true && offDesktop) v.enter(p);
      return { imageBase64: Buffer.from("jpeg").toString("base64"), mime: "image/jpeg", width: 800, height: 600, shotId: "s", ...(p.desktopVisit === true ? { inVisit: true } : {}) };
    };
    const noReason = await w.run("const notes = await apps.open('Notes')\ntry { await notes.screenshot({ live: true }) } catch (e) { print(e.name, e.message) }");
    expect(text(noReason)).toContain("TypeError screenshot({ live: true }) takes a reason");
    await w.run("await notes.screenshot({ live: true, reason: 'to see the chart' })");
    expect(w.fake.calls("target.screenshot").at(-1)).toMatchObject({ live: true });
    expect(cardsOf(w.events)).toEqual([]);
    offDesktop = true;
    const r = await w.run("await notes.screenshot({ live: true, reason: 'to see\\nthe chart\\u202e now' })");
    expect(cardsOf(w.events)[0]!.summary).toBe(desktopVisitCardSummary(NOTES, "to see the chart now"));
    expect(w.fake.calls("target.screenshot").slice(-2).map((p) => p.desktopVisit)).toEqual([undefined, true]);
    expect(text(r)).toContain("moved the user to Notes's desktop for 600 ms (1 action) and back");
    const blind = await w.run("try { await notes.screenshot({ live: true, reason: 'x' }) } catch (e) { print(e.name) }", { vision: false });
    expect(text(blind)).toContain("NotAllowed");
  }, 30_000);

  macOnly("one capture per visited shot: the budget carries maxBytes, and a shot taken in a visit is never re-taken for its size (5b)", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake);
    const big = "A".repeat(4 * 1024 * 1024 + 8); // ~3 MiB decoded: over the cap
    w.fake.handlers["target.screenshot"] = (p) => {
      v.enter(p);
      return { imageBase64: big, mime: "image/jpeg", width: 4000, height: 3000, shotId: "s", inVisit: true };
    };
    await w.run("const notes = await apps.open('Notes')\nawait notes.screenshot({ live: true, reason: 'to see it', emit: false })");
    const shots = w.fake.calls("target.screenshot");
    expect(shots.map((p) => p.desktopVisit)).toEqual([undefined, true]);
    expect((shots[1]!.budget as { maxBytes?: number }).maxBytes).toBe(3 * 1024 * 1024);
  }, 30_000);

  macOnly("the visit allowance never skips the same-desktop rung-4 card: allowForeground is sent as it is (blocker 1)", async () => {
    // Attended: after the visit allowance, an act that needs the front ON THIS DESKTOP still raises the rung-4 card.
    const w = world({ policy: "ask", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", c.summary.startsWith("Allow") ? "session" : c.onTimeout === "allow" ? "switch" : undefined) });
    const v = openVisits(w.fake);
    let n = 0;
    // The fake honours allowForeground: from the third request on, the window is on this desktop and the act needs
    // the front — refused without allowForeground.
    w.fake.handlers["target.act"] = (p) => {
      if (++n >= 3) { if (p.allowForeground !== true) throw new FakeHelperError("needs_foreground", "canvas"); return { rung: 4 }; }
      v.enter(p);
      return { rung: 4, inVisit: true };
    };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)\nawait notes.click(15)");
    expect(r.isError).toBe(false);
    expect(cardsOf(w.events).map((c) => c.onTimeout ?? c.summary.slice(0, 22))).toEqual(["Allow Winter to use No", "allow", "Winter needs to bring "]);
    expect(w.fake.calls("target.act").map((a) => [a.desktopVisit, a.allowForeground])).toEqual([[undefined, false], [true, false], [true, false], [true, true]]);
    // Unattended: the rung-4 card is never raised, so that act fails NeedsForeground — the allowance did not widen it.
    const w2 = world({ policy: "ask", attended: false, answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", c.summary.startsWith("Allow") ? "session" : "switch") });
    const v2 = openVisits(w2.fake);
    let m = 0;
    w2.fake.handlers["target.act"] = (p) => {
      if (++m >= 3) { if (p.allowForeground !== true) throw new FakeHelperError("needs_foreground", "canvas"); return { rung: 4 }; }
      v2.enter(p);
      return { rung: 4, inVisit: true };
    };
    const r2 = await w2.run("const notes = await apps.open('Notes')\nawait notes.click(14)\ntry { await notes.click(15) } catch (e) { print(e.name) }");
    expect(text(r2)).toContain("NeedsForeground");
    expect(w2.fake.calls("target.act").map((a) => [a.desktopVisit, a.allowForeground])).toEqual([[undefined, false], [true, false], [true, false]]);
  }, 30_000);

  macOnly("a failed return is LOUD: a notice at the top of the result and a warning in the log; a user who took over is left be", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake, { ms: 2_400, returned: false });
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    const at = r.content.findIndex((c) => c.type === "text" && c.text.startsWith("Winter moved the user to Notes's desktop and could NOT bring them back"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(w.logs.some((l) => l.includes("WARNING desktop visit v1") && l.includes("NOT returned"))).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(w.metrics().find((m) => m.primitive === "desktop.visit")).toMatchObject({ visit: { actions: 1, ms: 2_400, returned: false } });

    const moved = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const mv = openVisits(moved.fake, { ms: 700, returned: false, userMoved: true });
    moved.fake.handlers["target.act"] = (p) => { mv.enter(p); return { rung: 4, inVisit: true }; };
    const r2 = await moved.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    expect(text(r2)).toContain("they took over during it, so Winter left them where they went");
    expect(text(r2)).not.toContain("could NOT bring them back");
    await new Promise((res) => setTimeout(res, 20));
    // A user left where they went was NOT returned (8e).
    expect(moved.metrics().find((m) => m.primitive === "desktop.visit")).toMatchObject({ visit: { returned: false, userMoved: true } });
  }, 30_000);

  macOnly("the helper gone during an open visit: the result says loudly the user may still be on that desktop (6)", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake);
    let n = 0;
    w.fake.handlers["target.act"] = (p) => {
      if (++n === 3) { w.fake.quit(); return new Promise(() => {}); }
      v.enter(p);
      return { rung: 4, inVisit: true };
    };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)\ntry { await notes.click(15) } catch (e) { print(e.name) }");
    expect(r.content.some((c) => c.type === "text" && c.text.includes("the user may still be on Notes's desktop"))).toBe(true);
    expect(w.logs.some((l) => l.includes("WARNING the helper went away during a desktop visit to Notes"))).toBe(true);
  }, 30_000);

  macOnly("a cancelled run still closes its visit and says it; a visit the helper closed after a run ended is said by the next run", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake, { ms: 900 });
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    const abort = new AbortController();
    w.fake.handlers["target.waitFor"] = () => { abort.abort(); return new Promise(() => {}); };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)\nawait notes.waitFor({ text: 'x' })", { signal: abort.signal });
    expect(text(r)).toContain("Cancelled");
    expect(text(r)).toContain("moved the user to Notes's desktop for 900 ms (1 action) and back");
    expect(v.isOpen).toBe(false);
    // A visit that closed AFTER its run (the helper's own report, `desktopVisited`): the next run claims and says it.
    v.enter({ desktopVisit: true, targetId: "t1" });
    v.close();
    await new Promise((res) => setTimeout(res, 20));
    const next = await w.run("print('hi')");
    expect(text(next)).toContain("moved the user to Notes's desktop for 900 ms (1 action) and back");
  }, 30_000);

  macOnly("view-only apps never get the prompt for an act, but may for a live read", async () => {
    const w = world({ policy: "bypass", apps: { "com.apple.Notes": { access: "view" } }, answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    const v = openVisits(w.fake, { ms: 250 });
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    w.fake.handlers["target.screenshot"] = (p) => {
      v.enter(p);
      return { imageBase64: Buffer.from("jpeg").toString("base64"), mime: "image/jpeg", width: 8, height: 6, shotId: "s", inVisit: true };
    };
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.click(14) } catch (e) { print(e.name) }\nawait notes.screenshot({ live: true, reason: 'to look' })");
    expect(text(r)).toContain("NotAllowed");
    expect(w.fake.calls("target.act")).toEqual([]);
    expect(cardsOf(w.events)).toHaveLength(1);
    expect(text(r)).toContain("moved the user to Notes's desktop for 250 ms (1 action) and back");
  }, 30_000);

  macOnly("a helper that asks again after the allowance: NeedsForeground (never a bare Error), and no second prompt", async () => {
    const w = world({ policy: "bypass", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "switch") });
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("needs_desktop_visit", "still elsewhere", { why: "act" }); };
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.click(14) } catch (e) { print(e.name, e.message) }");
    expect(text(r)).toContain("NeedsForeground Notes's window is on another desktop and this needs it on screen");
    expect(cardsOf(w.events)).toHaveLength(1);
    expect(w.fake.calls("target.act").map((a) => a.desktopVisit)).toEqual([undefined, true]);
  }, 30_000);

  macOnly("a prompt that could not be shown is worded as such — never as the user's refusal (8d)", async () => {
    const w = world({ policy: "bypass" });
    const v = openVisits(w.fake);
    w.fake.handlers["target.act"] = (p) => { v.enter(p); return { rung: 4, inVisit: true }; };
    // The session's log refuses the card (an emit failure).
    (w.policy as unknown as { deps: { emit: () => void } }).deps.emit = () => { throw new Error("closed"); };
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.click(14) } catch (e) { print(e.name, e.message) }");
    expect(text(r)).toContain("NeedsForeground the desktop-switch prompt could not be shown, so Notes's window was not visited");
    expect(text(r)).not.toContain("refused");
  }, 30_000);
});
