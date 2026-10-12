// ComputerV2 — wake triggers on APPS: the daemon's `AppWakeBackend` over a FAKE helper (`watch.arm`, `watch.cancel`,
// `watchEvent`). No app, no socket, no TCC.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAutomationFailure } from "../../src/computer-use/errors";
import { HelperClient } from "../../src/computer-use/helper-client";
import { HELPER_WATCH_VERSION } from "../../src/computer-use/protocol";
import { AppWakeBackend, HELPER_GONE_REASON, alreadyMetSentence, wireCondition, type AppWakeTarget } from "../../src/computer-use/wakes/app-backend";
import type { WakeArmRequest, WakeBackendEvent, WakeCondition } from "../../src/computer-use/wakes/types";
import { FakeHelper, FakeHelperError } from "./fake-helper";

const NOTES: AppWakeTarget = { bundleId: "com.apple.Notes", name: "Notes", pid: 501 };

function rig(opts: { version?: string; allowed?: boolean; target?: AppWakeTarget | undefined } = {}) {
  const fake = new FakeHelper();
  fake.helperVersion = opts.version ?? HELPER_WATCH_VERSION;
  let backend: AppWakeBackend | undefined;
  const helper = new HelperClient({
    home: mkdtempSync(join(tmpdir(), "winter-wake-app-")), profile: "dev", launchAllowed: true,
    transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier, connectTimeoutMs: 500,
    // Wired the way `wiring.ts` wires it: beside the service's own handlers.
    onNotification: (n) => backend?.handleNotification(n),
    onDisconnect: () => backend?.helperDisconnected(),
  });
  const target = "target" in opts ? opts.target : NOTES;
  backend = new AppWakeBackend({
    helper,
    target: (sessionId, targetId) => (sessionId === "s1" && targetId === "t1" ? target : undefined),
    persistentlyAllowed: (_s, bundleId) => (opts.allowed ?? true) && bundleId === NOTES.bundleId,
    now: () => 4_242,
  });
  const events: WakeBackendEvent[] = [];
  return { fake, helper, backend, events, onEvent: (e: WakeBackendEvent) => { events.push(e); } };
}

async function bound(r: ReturnType<typeof rig>): Promise<void> {
  await r.helper.request("target.bind", { sessionId: "s1", app: "com.apple.Notes", mirror: false });
}

const req = (condition: WakeCondition, wakeId = "wk_0123456789ab"): WakeArmRequest =>
  ({ wakeId, sessionId: "s1", targetId: "t1", condition, expiresAt: 1_760_000_000_000 });

async function refusal(p: Promise<unknown>): Promise<{ kind: string; message: string }> {
  try {
    await p;
  } catch (err) {
    if (isAutomationFailure(err)) return { kind: err.kind, message: err.message };
    if (err instanceof TypeError) return { kind: "TypeError", message: err.message };
    throw err;
  }
  throw new Error("armed");
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("AppWakeBackend: arming", () => {
  test("arms a watch on the bound app, answering the helper's labels and a daemon-written rebind", async () => {
    const r = rig();
    await bound(r);
    const armed = await r.backend.arm(req({ kind: "clicked", ref: "12" }), r.onEvent);
    expect(armed).toEqual({ element: { role: "button", name: "Send" }, targetLabel: "Notes — Notes window", rebind: 'apps.open("com.apple.Notes")' });
    expect(r.fake.calls("watch.arm")).toEqual([{
      targetId: "t1", watchId: "wk_0123456789ab", condition: { kind: "clicked", ref: 12 }, expiresAt: 1_760_000_000_000,
    }]);
    expect(r.backend.armedCount).toBe(1);
  });

  test("a once-allowed app is refused with the spine's sentence, and nothing reaches the helper", async () => {
    const r = rig({ allowed: false });
    await bound(r);
    expect(await refusal(r.backend.arm(req({ kind: "clicked", ref: "12" }), r.onEvent))).toEqual({
      kind: "NotAllowed", message: "Notes was allowed for one call only — a wake trigger needs it allowed for this session",
    });
    expect(r.fake.calls("watch.arm")).toEqual([]);
  });

  test("a target that is not bound, or lost, is TargetLost", async () => {
    const none = rig({ target: undefined });
    expect((await refusal(none.backend.arm(req({ kind: "titled", title: "Done" }), none.onEvent))).kind).toBe("TargetLost");
    const lost = rig({ target: { ...NOTES, lost: "app_quit" } });
    expect(await refusal(lost.backend.arm(req({ kind: "titled", title: "Done" }), lost.onEvent))).toEqual({
      kind: "TargetLost", message: "Notes quit — open it again with apps.open(), then arm the trigger",
    });
  });

  test("the tab-only kinds are NotAllowed on an app; an app's ref must be a number", async () => {
    const r = rig();
    expect((await refusal(r.backend.arm(req({ kind: "submitted" }), r.onEvent))).kind).toBe("NotAllowed");
    expect((await refusal(r.backend.arm(req({ kind: "navigated", url: "x" }), r.onEvent))).message).toContain("browser tabs only");
    expect((await refusal(r.backend.arm(req({ kind: "clicked", ref: "e12" }), r.onEvent))).kind).toBe("TypeError");
    expect(r.fake.calls("watch.arm")).toEqual([]);
  });

  test("a helper older than 1.17.0 is HelperUnavailable, asked nothing", async () => {
    const r = rig({ version: "1.16.0" });
    await bound(r);
    const f = await refusal(r.backend.arm(req({ kind: "clicked", ref: "12" }), r.onEvent));
    expect(f).toEqual({ kind: "HelperUnavailable", message: "Winter Computer Use 1.16.0 is too old to wait on an app (it needs 1.17.0 or later) — update Winter" });
    expect(r.fake.calls("watch.arm")).toEqual([]);
  });

  test("the helper's refusals become the daemon's own sentences", async () => {
    const r = rig();
    await bound(r);
    const cases: Array<[FakeHelperError, WakeCondition, { kind: string; message: string }]> = [
      [new FakeHelperError("not_allowed", "“Saved” is already shown…", { reason: "already_met" }), { kind: "appeared", text: "Saved" },
        { kind: "NotAllowed", message: "“Saved” is already shown in Notes — nothing to wait for; check state()" }],
      [new FakeHelperError("refused", "the Window Title “Secret” said this", { reason: "secure_field" }), { kind: "changed", ref: "3", settleMs: 1500 },
        { kind: "Refused", message: "that is a password or payment field — Winter never watches one; ask the user to tell you when they are done" }],
      [new FakeHelperError("stale_ref", "[3] is gone", { ref: 3 }), { kind: "clicked", ref: "3" }, { kind: "StaleRef", message: "[3] is gone — call state()" }],
      [new FakeHelperError("unsupported", "no AX in “Secret Doc”", { reason: "no_accessibility" }), { kind: "titled", title: "x" },
        { kind: "NotAllowed", message: "Notes's window exposes no accessibility here, so Winter can't watch it — ask the user to show the window once on its desktop, then bind it again" }],
      [new FakeHelperError("unsupported", "unknown method watch.arm"), { kind: "titled", title: "x" },
        { kind: "HelperUnavailable", message: "Winter Computer Use is too old to wait on an app (it needs 1.17.0 or later) — update Winter" }],
      [new FakeHelperError("unsupported", "the automation engine is gone", { reason: "engine_gone" }), { kind: "titled", title: "x" },
        { kind: "HelperUnavailable", message: "Winter Computer Use could not arm the trigger (it may be quitting) — try again" }],
      [new FakeHelperError("target_lost", "gone", { reason: "window_closed" }), { kind: "titled", title: "x" },
        { kind: "TargetLost", message: "Notes's window closed — call apps.open or useWindow to pick another, then arm the trigger" }],
      [new FakeHelperError("busy", "too many"), { kind: "titled", title: "x" },
        { kind: "TargetBusy", message: "Notes is busy, or Winter Computer Use holds too many watches — try again in a moment" }],
    ];
    for (const [err, condition, want] of cases) {
      r.fake.handlers["watch.arm"] = () => { throw err; };
      const got = await refusal(r.backend.arm(req(condition), r.onEvent));
      expect(got).toEqual(want);
      // Never the helper's own words (they may carry a window title or an element's name).
      expect(got.message).not.toContain("Secret");
    }
    expect(r.backend.armedCount).toBe(0);
    // Every refused arm also cancels the helper's watch (idempotent there): nothing is left watching (review M1).
    expect(r.fake.calls("watch.cancel").length).toBe(cases.length);
  });

  test("an arm that times out cancels the helper's watch — it may have been armed after all", async () => {
    const r = rig();
    await bound(r);
    const slow = new AppWakeBackend({
      helper: r.helper, target: () => NOTES, persistentlyAllowed: () => true, armTimeoutMs: 30,
    });
    r.fake.handlers["watch.arm"] = (params) => new Promise((resolve) => setTimeout(() => { r.fake.watches.add(String(params.watchId)); resolve({ targetLabel: "Notes" }); }, 120));
    expect((await refusal(slow.arm(req({ kind: "clicked", ref: "12" }), r.onEvent))).kind).toBe("HelperUnavailable");
    await new Promise((res) => setTimeout(res, 200));
    expect(r.fake.calls("watch.cancel")).toEqual([{ watchId: "wk_0123456789ab" }]);
    expect(slow.armedCount).toBe(0);
  });

  test("a Chromium-family browser is watched on its tabs, never as an app; Safari stays an app", async () => {
    for (const bundleId of ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser"]) {
      const r = rig({ target: { bundleId, name: "Browser", pid: 9 } });
      const f = await refusal(r.backend.arm(req({ kind: "titled", title: "Done" }), r.onEvent));
      expect(f).toEqual({ kind: "NotAllowed", message: "Browser is a browser Winter drives tab by tab — wait on the tab instead: bind it with browsers.tab(…) and call tab.wakeWhen(…)" });
      expect(r.fake.calls("watch.arm")).toEqual([]);
    }
    const safari = rig({ target: { bundleId: "com.apple.Safari", name: "Safari", pid: 9 }, allowed: true });
    // (Not allowed by this rig's policy for Safari: the refusal is the grant's, not the browser's.)
    expect((await refusal(safari.backend.arm(req({ kind: "titled", title: "Done" }), safari.onEvent))).message).toContain("allowed for one call only");
  });

  test("the already-met sentences, per kind", () => {
    expect(alreadyMetSentence({ kind: "gone", text: "Uploading" }, "Mail")).toBe("“Uploading” is not shown in Mail — nothing to wait for; check state()");
    expect(alreadyMetSentence({ kind: "gone", ref: "7" }, "Mail")).toBe("[7] is already gone from Mail — nothing to wait for; check state()");
    expect(alreadyMetSentence({ kind: "titled", title: "Done" }, "Mail")).toBe("Mail's window title already contains “Done” — nothing to wait for; check state()");
  });

  test("wireCondition: the pinned shapes onto the helper's wire", () => {
    expect(wireCondition({ kind: "appeared", text: "Sent" })).toEqual({ kind: "appeared", text: "Sent" });
    expect(wireCondition({ kind: "gone", ref: "4" })).toEqual({ kind: "gone", ref: 4 });
    expect(wireCondition({ kind: "gone", text: "Uploading" })).toEqual({ kind: "gone", text: "Uploading" });
    expect(wireCondition({ kind: "changed", ref: "9", settleMs: 800 })).toEqual({ kind: "changed", ref: 9, settleMs: 800 });
    expect(wireCondition({ kind: "titled", title: "Done" })).toEqual({ kind: "titled", title: "Done" });
    expect(() => wireCondition({ kind: "clicked", ref: "0" })).toThrow(TypeError);
  });
});

describe("AppWakeBackend: events, disarm, the helper going", () => {
  test("a watchEvent ends its trigger once; an unknown or repeated one is dropped", async () => {
    const r = rig();
    await bound(r);
    await r.backend.arm(req({ kind: "clicked", ref: "12" }), r.onEvent);
    r.fake.notify("watchEvent", { watchId: "wk_other", outcome: "fired", at: 1, detail: "clicked" });
    r.fake.notify("watchEvent", { watchId: "wk_0123456789ab", outcome: "fired", at: 1_760_000_001_000, detail: "clicked" });
    r.fake.notify("watchEvent", { watchId: "wk_0123456789ab", outcome: "lost", at: 2, reason: "the app quit" });
    await settle();
    expect(r.events).toEqual([{ wakeId: "wk_0123456789ab", outcome: "fired", at: 1_760_000_001_000, detail: "clicked" }]);
    expect(r.backend.armedCount).toBe(0);
  });

  test("a lost watch says why, in the helper's words", async () => {
    const r = rig();
    await bound(r);
    await r.backend.arm(req({ kind: "titled", title: "Done" }), r.onEvent);
    r.fake.notify("watchEvent", { watchId: "wk_0123456789ab", outcome: "lost", at: 5, reason: "the window closed" });
    await settle();
    expect(r.events).toEqual([{ wakeId: "wk_0123456789ab", outcome: "lost", at: 5, reason: "the window closed" }]);
  });

  test("disarm cancels the helper's watch, once; an event after it is dropped", async () => {
    const r = rig();
    await bound(r);
    await r.backend.arm(req({ kind: "clicked", ref: "12" }), r.onEvent);
    r.backend.disarm("wk_0123456789ab");
    r.backend.disarm("wk_0123456789ab");
    r.backend.disarm("wk_never");
    await settle();
    expect(r.fake.calls("watch.cancel")).toEqual([{ watchId: "wk_0123456789ab" }]);
    expect(r.fake.watches.size).toBe(0);
    r.fake.notify("watchEvent", { watchId: "wk_0123456789ab", outcome: "fired", at: 1, detail: "clicked" });
    await settle();
    expect(r.events).toEqual([]);
  });

  test("the helper going away ends every armed trigger lost — \"Winter Computer Use quit\"", async () => {
    const r = rig();
    await bound(r);
    await r.backend.arm(req({ kind: "clicked", ref: "12" }, "wk_a"), r.onEvent);
    await r.backend.arm(req({ kind: "titled", title: "Done" }, "wk_b"), r.onEvent);
    r.fake.quit();
    await settle();
    expect(r.events).toEqual([
      { wakeId: "wk_a", outcome: "lost", at: 4_242, reason: HELPER_GONE_REASON },
      { wakeId: "wk_b", outcome: "lost", at: 4_242, reason: HELPER_GONE_REASON },
    ]);
    expect(HELPER_GONE_REASON).toBe("Winter Computer Use quit");
    expect(r.backend.armedCount).toBe(0);
  });

  test("stop() cancels every watch quietly and reports nothing", async () => {
    const r = rig();
    await bound(r);
    await r.backend.arm(req({ kind: "clicked", ref: "12" }, "wk_a"), r.onEvent);
    await r.backend.arm(req({ kind: "titled", title: "Done" }, "wk_b"), r.onEvent);
    r.backend.stop();
    await settle();
    expect(r.fake.calls("watch.cancel")).toEqual([{ watchId: "wk_a" }, { watchId: "wk_b" }]);
    r.fake.notify("watchEvent", { watchId: "wk_a", outcome: "fired", at: 1, detail: "clicked" });
    r.fake.quit();
    await settle();
    expect(r.events).toEqual([]);
    expect(r.backend.armedCount).toBe(0);
  });

  test("an event that overtakes the arm's answer is delivered after it, never before", async () => {
    const r = rig();
    await bound(r);
    r.fake.handlers["watch.arm"] = (params) => {
      r.fake.notify("watchEvent", { watchId: String(params.watchId), outcome: "fired", at: 9, detail: "clicked" });
      return new Promise((resolve) => setTimeout(() => resolve({ targetLabel: "Notes — Inbox" }), 5));
    };
    let armedFirst = false;
    const armed = await r.backend.arm(req({ kind: "clicked", ref: "12" }), (e) => { r.events.push(e); });
    armedFirst = r.events.length === 0;
    expect(armed.targetLabel).toBe("Notes — Inbox");
    expect(armedFirst).toBe(true);
    await settle();
    expect(r.events).toEqual([{ wakeId: "wk_0123456789ab", outcome: "fired", at: 9, detail: "clicked" }]);
    expect(r.backend.armedCount).toBe(0);
  });

  test("disarmed while being armed: the helper's watch is cancelled and the arm fails Cancelled", async () => {
    const r = rig();
    await bound(r);
    let release!: () => void;
    r.fake.handlers["watch.arm"] = () => new Promise((resolve) => { release = () => resolve({ targetLabel: "Notes" }); });
    const pending = r.backend.arm(req({ kind: "clicked", ref: "12" }), r.onEvent);
    await settle();
    r.backend.disarm("wk_0123456789ab");
    release();
    expect((await refusal(pending)).kind).toBe("Cancelled");
    await settle();
    expect(r.fake.calls("watch.cancel")).toEqual([{ watchId: "wk_0123456789ab" }]);
  });
});
