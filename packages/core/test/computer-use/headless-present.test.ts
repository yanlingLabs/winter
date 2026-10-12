// ComputerV2 Phase 4, lane H3 — a headless tab SHOWN in Winter's panel, over a FAKE Winter Headless on a real pipe
// (`headless-fake-helper.ts`) and a fake panel (the browser link's `headless` feature): the hand-off (`present`, the
// person in control), the control lease (the agent's commands refused while the person holds the tab; the ones in flight
// finish first), watch and take over from the panel, a presentation nobody connected to, a viewer that leaves, the
// turn's end closing a tab the person holds, the panel's list, and a helper or app without the feature.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HeadlessShowParams, HeadlessTabRow } from "../../src/computer-use/browser/cef-link/cef-transport";
import type { HeadlessViewer } from "../../src/computer-use/browser/cef-link/rpc";
import { headlessRequirementFor, winterAppRequirementFor } from "../../src/computer-use/browser/headless/engines";
import { HEADLESS_USER_HAS_TAB, headlessUploadDir, HeadlessPool, type HeadlessPoolDeps } from "../../src/computer-use/browser/headless/pool";
import { spawnEngineProcess } from "../../src/computer-use/browser/headless/winter-engine";
import { TransportError } from "../../src/computer-use/browser/transport";
import { AutomationFailure } from "../../src/computer-use/errors";

const FAKE = join(import.meta.dir, "headless-fake-helper.ts");
const REQUIREMENT = headlessRequirementFor("dev", false);

interface Panel extends HeadlessViewer {
  shown: HeadlessShowParams[];
  hidden: Array<{ sessionId: string; tabId: string; reason: string }>;
  lists: Array<{ sessionId: string; tabs: HeadlessTabRow[] }>;
}

function panel(): Panel {
  const p: Panel = {
    shown: [], hidden: [], lists: [],
    show: async (s) => { p.shown.push(s); },
    hide: async (h) => { p.hidden.push(h); },
    tabs: (t) => { p.lists.push(t); },
  };
  return p;
}

interface Rig { pool: HeadlessPool; home: string; panel: Panel; app: { up: boolean; feature: boolean }; commands(): Array<{ op: string; params: Record<string, unknown> }> }

const pools: HeadlessPool[] = [];
afterEach(() => { for (const p of pools.splice(0)) p.stop(); });

function rig(o: { mode?: string; presentStartMs?: number; drainMs?: number } = {}): Rig {
  const home = mkdtempSync(join(tmpdir(), "winter-headless-present-"));
  const log = join(home, "fake.log");
  const view = panel();
  const app = { up: true, feature: true };
  const deps: HeadlessPoolDeps = {
    home,
    enabled: () => true,
    resolve: () => ({ engine: "winter", app: "/fake/Winter Headless Dev.app", executable: "/fake/Winter Headless Dev.app/Contents/MacOS/Winter Headless Dev", requirement: REQUIREMENT }),
    spawn: (_cmd, args) => spawnEngineProcess("/bin/sh", ["-c", 'exec "$0" "$@" 0<&3 1>&4 3<&- 4>&-', process.execPath, FAKE, `--fake-mode=${o.mode ?? "normal"}`, `--fake-log=${log}`, ...args]),
    verify: () => true,
    memoryOf: () => 100 * 1024 * 1024,
    viewer: () => (app.up && app.feature ? view : undefined),
    viewerMissing: () => (!app.up ? "Winter isn't running — ask the user to open Winter" : !app.feature ? "this Winter's app can't show a headless tab — ask the user to update Winter" : undefined),
    viewerRequirement: () => winterAppRequirementFor("dev"),
    presentStartMs: o.presentStartMs ?? 2_000,
    drainMs: o.drainMs ?? 2_000,
    timeouts: { hello: 5_000, probe: 300 },
  };
  const pool = new HeadlessPool(deps);
  pools.push(pool);
  return {
    pool, home, panel: view, app,
    commands: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as { op: string; params: Record<string, unknown> }) : []),
  };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

async function until(what: string, pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
}

const isUserHasTab = (e: Error): boolean => e instanceof TransportError && e.code === "capacity" && e.message === HEADLESS_USER_HAS_TAB;

describe("the hand-off (waitForUser): the tab shown in Winter's panel, the person in control", () => {
  test("present: the helper checks in a presentation for Winter's own app, the panel connects, and the agent waits until Done", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://accounts.example/" });
    await r.pool.present(t.tabKey, { sessionId: "s1" });
    const present = r.commands().find((c) => c.op === "headless.present")!;
    expect(present.params).toMatchObject({ tabId: t.tabKey, control: true, scale: 1, viewerRequirement: winterAppRequirementFor("dev") });
    expect(String(present.params.nonce)).toMatch(/^[0-9a-f]{16}$/);
    expect(r.panel.shown).toHaveLength(1);
    expect(r.panel.shown[0]).toMatchObject({
      sessionId: "s1", tabId: t.tabKey, nonce: present.params.nonce, producerRequirement: REQUIREMENT, control: true, purpose: "handoff",
      url: "https://accounts.example/", uploadDir: headlessUploadDir(r.home),
    });
    expect(r.panel.shown[0]!.service).toMatch(/^com\.winter\.headless\.present\./);
    // The person holds it: every agent command on it is refused, typed, with the sentence the model reads.
    expect(isUserHasTab(await failure(r.pool.send(t.tabKey, "Page.enable")))).toBe(true);
    expect(isUserHasTab(await failure(r.pool.attach(t.tabKey, { sessionId: "s1" })))).toBe(true);
    expect(isUserHasTab(await failure(r.pool.subscribe(t.tabKey, ["Page.loadEventFired"])))).toBe(true);
    await r.pool.detach(t.tabKey); // letting go is always allowed
    // The panel's Done answers the engine's wait; the engine then hands it back.
    const answers: Array<[string, boolean]> = [];
    r.pool.onUserDone((k, done) => answers.push([k, done]));
    await r.pool.panelAction("s1", t.tabKey, "done");
    expect(answers).toEqual([[t.tabKey, true]]);
    await r.pool.handBack(t.tabKey);
    expect(r.commands().some((c) => c.op === "headless.unpresent" && c.params.tabId === t.tabKey)).toBe(true);
    expect(r.panel.hidden).toEqual([{ sessionId: "s1", tabId: t.tabKey, reason: "done" }]);
    await r.pool.send(t.tabKey, "Page.enable");
  });

  test("Stop waiting answers the wait; the tab stays the person's (still refused to the agent) until they hand it back", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    await r.pool.present(t.tabKey, { sessionId: "s1" });
    const answers: boolean[] = [];
    r.pool.onUserDone((_k, done) => answers.push(done));
    await r.pool.panelAction("s1", t.tabKey, "stopWaiting");
    expect(answers).toEqual([false]);
    r.pool.handoffOver(t.tabKey);
    expect(isUserHasTab(await failure(r.pool.send(t.tabKey, "Page.enable")))).toBe(true);
    // Nobody waits now: Done hands it back and the view goes, here.
    await r.pool.panelAction("s1", t.tabKey, "done");
    expect(answers).toEqual([false]);
    expect(r.panel.hidden.map((h) => h.reason)).toEqual(["done"]);
    await r.pool.send(t.tabKey, "Page.enable");
  });

  test("nobody connects in time (Winter.app's viewer never came, or was refused): the presentation is ended and the call fails, typed", async () => {
    const r = rig({ presentStartMs: 150 });
    const t = await r.pool.createTab({ sessionId: "s1", url: "http://no-viewer.test/" });
    const e = await failure(r.pool.present(t.tabKey, { sessionId: "s1" }));
    expect((e as AutomationFailure).kind).toBe("BrowserUnavailable");
    expect(e.message).toMatch(/Winter could not show the headless tab \(Winter's panel did not connect to it in time\)/);
    expect(r.commands().some((c) => c.op === "headless.unpresent")).toBe(true);
    expect(r.panel.hidden.map((h) => h.reason)).toEqual(["not shown"]);
    await r.pool.send(t.tabKey, "Page.enable"); // the agent has it again
  });

  test("the viewer leaves (the person closed it, Winter quit): the wait reads not done and control returns to the agent", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "http://viewer-leaves.test/" });
    const answers: boolean[] = [];
    r.pool.onUserDone((_k, done) => answers.push(done));
    await r.pool.present(t.tabKey, { sessionId: "s1" });
    await until("the viewer leaving", () => answers.length > 0);
    expect(answers).toEqual([false]);
    await r.pool.send(t.tabKey, "Page.enable");
  });

  test("a tab of another session is not shown", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    expect(((await failure(r.pool.present(t.tabKey, { sessionId: "s2" }))) as TransportError).code).toBe("not_allowed");
    expect(((await failure(r.pool.panelAction("s2", t.tabKey, "watch"))) as AutomationFailure).kind).toBe("TargetLost");
    expect(r.panel.shown).toEqual([]);
  });
});

describe("watch and take over from the panel", () => {
  test("watch: shown, watch-only — the agent keeps working; take over waits for the agent's command in flight, then the tab is the person's; hand back returns it", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "http://slow-send.test/" });
    await r.pool.panelAction("s1", t.tabKey, "watch");
    expect(r.panel.shown[0]).toMatchObject({ purpose: "watch", control: false });
    expect(r.commands().find((c) => c.op === "headless.present")!.params.control).toBe(false);
    // Watching: the agent's command runs (slowly) …
    const order: string[] = [];
    const inFlight = r.pool.send(t.tabKey, "Page.enable").then(() => order.push("agent's send answered"));
    await new Promise((res) => setTimeout(res, 50));
    // … and the person takes over meanwhile: a NEW agent command is refused at once, the one in flight finishes first.
    const takeOver = r.pool.panelAction("s1", t.tabKey, "takeOver").then(() => order.push("control given"));
    await new Promise((res) => setTimeout(res, 10));
    expect(isUserHasTab(await failure(r.pool.send(t.tabKey, "Runtime.enable")))).toBe(true);
    await Promise.all([inFlight, takeOver]);
    expect(order).toEqual(["agent's send answered", "control given"]);
    const control = r.commands().filter((c) => c.op === "headless.control");
    expect(control.map((c) => c.params.control)).toEqual([true]);
    expect(isUserHasTab(await failure(r.pool.send(t.tabKey, "Page.enable")))).toBe(true);
    await r.pool.panelAction("s1", t.tabKey, "handBack");
    expect(r.commands().filter((c) => c.op === "headless.control").map((c) => c.params.control)).toEqual([true, false]);
    expect(r.panel.hidden).toEqual([]); // still shown, watch-only
    await r.pool.send(t.tabKey, "Page.enable");
    await r.pool.panelAction("s1", t.tabKey, "close");
    expect(r.commands().some((c) => c.op === "headless.unpresent")).toBe(true);
    expect(r.panel.hidden).toEqual([]); // the panel closed it itself
  });

  test("the turn's end closes a tab the person holds only once they let it go", async () => {
    const r = rig();
    const gone: string[] = [];
    r.pool.onTabGone((k, why) => gone.push(`${k}:${why}`));
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    await r.pool.panelAction("s1", t.tabKey, "watch");
    await r.pool.panelAction("s1", t.tabKey, "takeOver");
    // Taking over undid what the agent's attachment turned on, and told the engine the tab "stopped" (it attaches
    // afresh after the hand-back).
    expect(gone).toEqual([`${t.tabKey}:stopped`]);
    const undo = r.commands().filter((c) => c.op === "cdp.send").map((c) => c.params.method);
    expect(undo).toEqual(["Page.setInterceptFileChooserDialog", "Emulation.setFocusEmulationEnabled", "Emulation.clearDeviceMetricsOverride"]);
    gone.length = 0;
    await r.pool.closeTab(t.tabKey);
    expect(r.commands().some((c) => c.op === "tab.close")).toBe(false);
    expect(await r.pool.listTabs({ sessionId: "s1" })).toEqual([]); // no longer the agent's to find
    expect(r.pool.tabCount("s1")).toBe(1); // still counted while it lives
    await r.pool.panelAction("s1", t.tabKey, "handBack");
    await until("the close", () => r.commands().some((c) => c.op === "tab.close" && c.params.tabId === t.tabKey));
    expect(gone).toEqual([`${t.tabKey}:closed`]);
    expect(r.panel.hidden.map((h) => h.reason)).toEqual(["closed"]);
    expect(r.pool.tabCount()).toBe(0);
  });

  test("watching a tab the turn's end closes: the presentation ends with it", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    await r.pool.panelAction("s1", t.tabKey, "watch");
    await r.pool.closeTab(t.tabKey);
    expect(r.commands().some((c) => c.op === "tab.close")).toBe(true);
    await until("the panel told", () => r.panel.hidden.length === 1);
    expect(r.panel.hidden[0]!.reason).toBe("closed");
  });

  test("take over needs the tab shown; the panel's list says which are shown and held", async () => {
    const r = rig();
    const a = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    const b = await r.pool.createTab({ sessionId: "s1", url: "https://b.example/" });
    expect(((await failure(r.pool.panelAction("s1", a.tabKey, "takeOver"))) as AutomationFailure).kind).toBe("NotAllowed");
    await r.pool.panelAction("s1", b.tabKey, "watch");
    await r.pool.panelAction("s1", b.tabKey, "takeOver");
    const rows = await r.pool.panelTabs("s1");
    expect(rows.find((x) => x.tabId === a.tabKey)).toMatchObject({ presented: false, control: false });
    expect(rows.find((x) => x.tabId === b.tabKey)).toMatchObject({ presented: true, control: true });
    // The panel heard of the session's tabs as they changed.
    await until("a pushed list with b held", () => r.panel.lists.some((l) => l.tabs.some((x) => x.tabId === b.tabKey && x.control)));
    expect(r.panel.lists.every((l) => l.sessionId === "s1")).toBe(true);
  });

  test("the session's runtime ending and the helper stopping end its presentations and tell the panel", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    await r.pool.panelAction("s1", t.tabKey, "watch");
    r.pool.disposeSession("s1");
    await until("the panel told", () => r.panel.hidden.length === 1);
    expect(r.panel.hidden[0]!.reason).toBe("the session ended");
    const u = await r.pool.createTab({ sessionId: "s2", url: "https://b.example/" });
    await r.pool.panelAction("s2", u.tabKey, "watch");
    process.kill(r.pool.pid!, "SIGKILL");
    await until("the panel told again", () => r.panel.hidden.length === 2);
    expect(r.panel.hidden[1]!.reason).toBe("the headless browser stopped");
  });
});

describe("a window the person opens (a sign-in window)", () => {
  test("shown beside its opener with the person in control, never listed to the agent, closed when the person lets the opener go", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "http://opens-window.test/" });
    await r.pool.present(t.tabKey, { sessionId: "s1" });
    await until("the window shown", () => r.panel.shown.some((x) => x.purpose === "popup"));
    const w = r.panel.shown.find((x) => x.purpose === "popup")!;
    expect(w).toMatchObject({ sessionId: "s1", control: true, url: "http://window.test/" });
    expect(w.tabId).not.toBe(t.tabKey);
    // The person's alone: not in the agent's list, nor in the panel's watch list; it counts toward the budget.
    expect((await r.pool.listTabs({ sessionId: "s1" })).map((x) => x.tabKey)).toEqual([t.tabKey]);
    expect((await r.pool.panelTabs("s1")).map((x) => x.tabId)).toEqual([t.tabKey]);
    expect(r.pool.tabCount("s1")).toBe(2);
    // Done on the opener: the window goes with it.
    await r.pool.handBack(t.tabKey);
    await until("the window closed", () => r.commands().some((c) => c.op === "tab.close" && c.params.tabId === w.tabId));
    expect(r.panel.hidden.map((h) => h.tabId).sort()).toEqual([t.tabKey, w.tabId].sort());
    expect(r.pool.tabCount("s1")).toBe(1);
  });

  test("a window from a tab the person does not hold is closed at once", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "http://opens-window.test/" });
    await r.pool.panelAction("s1", t.tabKey, "watch"); // watch only: the page's window is not the person's
    await until("the window closed", () => r.commands().some((c) => c.op === "tab.close"));
    expect(r.panel.shown.filter((x) => x.purpose === "popup")).toEqual([]);
    expect(r.pool.tabCount("s1")).toBe(1);
  });
});

describe("what can't show a tab says so", () => {
  test("Winter.app not there, or without the feature: refused before anything is checked in", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    r.app.up = false;
    expect(r.pool.presentMissing()).toBe("Winter isn't running — ask the user to open Winter");
    const e = await failure(r.pool.present(t.tabKey, { sessionId: "s1" }));
    expect((e as AutomationFailure).kind).toBe("BrowserUnavailable");
    expect(e.message).toContain("Winter isn't running");
    r.app.up = true; r.app.feature = false;
    expect(r.pool.presentMissing()).toMatch(/can't show a headless tab — ask the user to update Winter/);
    expect(r.commands().some((c) => c.op === "headless.present")).toBe(false);
  });

  test("a helper without the `present` feature is never sent the presentation ops", async () => {
    const r = rig({ mode: "no-present" });
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    expect(r.pool.presentMissing()).toBe("Winter's headless browser is too old to show a tab — ask the user to update Winter");
    const e = await failure(r.pool.panelAction("s1", t.tabKey, "watch"));
    expect((e as AutomationFailure).kind).toBe("BrowserUnavailable");
    expect(r.commands().some((c) => c.op === "headless.present")).toBe(false);
  });
});
