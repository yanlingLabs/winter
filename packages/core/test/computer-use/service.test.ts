// ComputerV2 end to end inside the daemon (`computer-use/service.ts`): a REAL sandboxed worker runs the script,
// the REAL policy decides, the REAL helper client talks to a FAKE helper. Covers the diff base (printed vs
// emit:false, full, compaction, restart), the policy through a script (cards, dont-ask, plan, restrictions,
// floors), locks across sessions, timeout/interrupt/kill, screenshots and the vision gate, points, rung 4,
// busy retry, the helper's notifications, telemetry and the audit line.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewSessionEvent, SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { HelperClient } from "../../src/computer-use/helper-client";
import { ComputerPolicy, type SessionFacts } from "../../src/computer-use/policy";
import { RecentApps } from "../../src/computer-use/recent-apps";
import { ComputerV2Service, type ScriptResult } from "../../src/computer-use/service";
import { AutomationTelemetry } from "../../src/computer-use/telemetry";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { FakeHelper, FakeHelperError } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;

interface WorldOpts {
  policy?: SessionApprovalPolicy;
  facts?: Partial<SessionFacts>;
  apps?: Record<string, unknown>;
  /** `computerUse.allowAllApps` (absent: the default, on). */
  allowAllApps?: boolean;
  /** `computerUse.privateEventPath` (absent: the default, on). */
  privateEventPath?: boolean;
  attended?: boolean;
  answer?: (e: Extract<NewSessionEvent, { type: "approval_requested" }>, broker: ApprovalBroker) => void;
}

const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

function world(opts: WorldOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-cu-service-"));
  const fake = new FakeHelper();
  const approvals = new ApprovalBroker();
  const events: NewSessionEvent[] = [];
  const settings = { computerUse: { apps: opts.apps ?? {}, ...(opts.allowAllApps === undefined ? {} : { allowAllApps: opts.allowAllApps }), ...(opts.privateEventPath === undefined ? {} : { privateEventPath: opts.privateEventPath }) } } as unknown as Settings;
  const facts: SessionFacts = { policy: opts.policy ?? "bypass", mode: "code", ...opts.facts };
  const audits: Array<Record<string, unknown>> = [];
  const interrupts: string[] = [];
  const logs: string[] = [];
  let svc!: ComputerV2Service;
  const helper = new HelperClient({
    home, profile: "dev", launchAllowed: true,
    transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
    onNotification: (n) => svc.handleNotification(n), onDisconnect: () => svc.helperDisconnected(),
  });
  const policy = new ComputerPolicy({
    settings: () => settings,
    saveAlwaysGrant: () => {},
    approvals,
    emit: (_sid, e) => {
      events.push(e);
      if (e.type === "approval_requested" && opts.answer !== undefined) {
        const card = e as Extract<NewSessionEvent, { type: "approval_requested" }>;
        queueMicrotask(() => opts.answer!(card, approvals));
      }
    },
    session: () => facts,
    attended: () => opts.attended ?? true,
  });
  const telemetry = new AutomationTelemetry(home);
  svc = new ComputerV2Service({
    helper, policy, settings: () => settings, telemetry, recentApps: new RecentApps(home),
    audit: (l) => audits.push(l), interrupt: (sid) => interrupts.push(sid), log: (l) => logs.push(l),
  });
  services.push(svc);
  const run = (code: string, o: { sessionId?: string; vision?: boolean; timeoutMs?: number; reset?: boolean; signal?: AbortSignal; model?: string } = {}): Promise<ScriptResult> =>
    svc.run(
      { sessionId: o.sessionId ?? "s1", vision: o.vision ?? true, model: o.model ?? "anthropic/claude-opus-5-5", ...(o.signal === undefined ? {} : { signal: o.signal }) },
      { code, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }), ...(o.reset === undefined ? {} : { reset: o.reset }) },
    );
  return { home, fake, approvals, events, svc, run, audits, interrupts, telemetry, facts, logs };
}

const text = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
const cards = (events: NewSessionEvent[]) => events.filter((e) => e.type === "approval_requested") as Array<Extract<NewSessionEvent, { type: "approval_requested" }>>;

describe("ComputerV2: binding, state and the diff base", () => {
  macOnly("apps.open binds with the mirror, prints the full state fenced, and the next state() is a diff against it", async () => {
    const w = world();
    const r1 = await w.run("const notes = await apps.open('Notes')");
    expect(r1.isError).toBe(false);
    expect(w.fake.calls("target.bind")[0]).toMatchObject({ sessionId: "s1", app: "com.apple.Notes", mirror: true, privatePath: true });
    expect(text(r1)).toContain('<screen-data id="');
    expect(text(r1)).toContain('Notes — window "Notes window"');
    const bound = w.fake.calls("target.snapshot")[0]!;
    expect(bound).toMatchObject({ full: true, settle: { maxMs: 1500 } });
    expect(typeof bound.callId).toBe("string");

    const r2 = await w.run("await notes.state()");
    expect(w.fake.calls("target.snapshot")[1]).toMatchObject({ since: "snap1" });
    expect(text(r2)).toContain('~ [14] value "a" → "b"');
  }, 30_000);

  macOnly("an emit:false read does not advance the base; {full:true} omits since; within never becomes the base", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')");
    const r = await w.run("const quiet = await notes.state({ emit: false })\nprint(typeof quiet)\nawait notes.state()\nawait notes.state({ full: true })\nawait notes.state({ within: 14 })\nawait notes.state()");
    expect(text(r)).toContain("string");
    const snaps = w.fake.calls("target.snapshot");
    expect(snaps[1]).toMatchObject({ since: "snap1" }); // the quiet read
    expect(snaps[2]).toMatchObject({ since: "snap1" }); // still snap1 — the quiet read did not advance it
    expect(snaps[3]!.since).toBeUndefined(); // full
    expect(snaps[3]).toMatchObject({ full: true });
    expect(snaps[4]).toMatchObject({ within: 14 });
    expect(snaps[4]!.since).toBeUndefined();
    expect(snaps[5]).toMatchObject({ since: "snap4" }); // the full one (snap4) is the base, not the within read
  }, 30_000);

  macOnly("a compaction on the session's log forgets the base: the next state() is full", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')");
    w.svc.diffBases.observe({ type: "continuity_warning", sessionId: "s1", threadId: "main", warning: "compacted", text: "Conversation compacted" } as unknown as SessionEvent);
    await w.run("await notes.state()");
    expect(w.fake.calls("target.snapshot")[1]!.since).toBeUndefined();
  }, 30_000);

  macOnly("state() settles only after an action in the same call; click carries the call id, privatePath and access", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')\nawait notes.state()");
    expect(w.fake.calls("target.snapshot")[1]!.settle).toBeUndefined();
    await w.run("await notes.click(14)\nawait notes.state()");
    expect(w.fake.calls("target.snapshot")[2]).toMatchObject({ settle: { maxMs: 1500 } });
    expect(w.fake.calls("target.act")[0]).toMatchObject({ action: { kind: "click", ref: 14 }, access: "full", allowForeground: false, privatePath: true, sessionId: "s1" });
  }, 30_000);

  macOnly("reset: a fresh runtime, the bindings and bases are gone, and the model is told", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')\nconst keep = 1");
    const r = await w.run("print(typeof notes, typeof keep)", { reset: true });
    expect(text(r)).toContain("The automation runtime was reset");
    expect(text(r)).toContain("undefined undefined");
    expect(w.fake.calls("target.release")).toEqual([{ targetId: "t1" }]);
  }, 30_000);

  macOnly("a worker that died is reported at the next call, and its targets are forgotten", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')");
    process.kill(w.svc.workerPid("s1")!, "SIGKILL");
    await Bun.sleep(100);
    const r = await w.run("print(typeof notes)");
    expect(text(r)).toContain("The automation runtime restarted; earlier variables and bindings are gone.");
    expect(text(r)).toContain("undefined");
  }, 30_000);
});

describe("ComputerV2: the policy, through a script", () => {
  macOnly("ask: the per-app card on first bind; once covers this call only — its targets are released at the end; deny is NotAllowed", async () => {
    const w = world({ policy: "ask", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb") });
    const r1 = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    expect(r1.isError).toBe(false);
    expect(cards(w.events)).toHaveLength(1);
    expect(cards(w.events)[0]).toMatchObject({ toolName: "ComputerV2", summary: "Allow Winter to use Notes (com.apple.Notes)?" });
    // "Once" covered that call: the target is released, so the next call can neither act nor LOOK (review I3).
    expect(w.fake.calls("target.release")).toEqual([{ targetId: "t1" }]);
    const looked = await w.run("try { await notes.state() } catch (e) { print(e.name, e.message) }");
    expect(text(looked)).toContain("TargetLost Notes is gone (it was allowed for one call only)");
    expect(w.fake.calls("target.snapshot")).toHaveLength(1); // the bind's own snapshot only
    // Binding again asks again.
    await w.run("const again = await apps.open('Notes')");
    expect(cards(w.events)).toHaveLength(2);

    const denied = world({ policy: "ask", answer: (c, b) => b.resolve(c.sessionId, c.callId, false, "orb") });
    const r2 = await denied.run("try { await apps.open('Notes') } catch (e) { print(e instanceof NotAllowed, e.message) }");
    expect(text(r2)).toContain("true The user did not allow Winter to use Notes.");
    expect(denied.fake.calls("target.bind")).toEqual([]); // nothing was launched or bound
  }, 30_000);

  macOnly("the card does not count against the script's timeout", async () => {
    const w = world({ policy: "ask", answer: (c, b) => { setTimeout(() => b.resolve(c.sessionId, c.callId, true, "orb", "session"), 1_500); } });
    const r = await w.run("const notes = await apps.open('Notes')\nprint('bound')", { timeoutMs: 1_000 });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain("bound");
  }, 30_000);

  macOnly("dont-ask: binds ONLY an Always-allow app (the ruling) — nothing else is launched, bound or carded", async () => {
    const w = world({ policy: "dont-ask" });
    const r = await w.run("try { await apps.open('Notes') } catch (e) { print(e.name) }");
    expect(text(r)).toContain("NotAllowed");
    expect(w.fake.calls("target.bind")).toEqual([]);
    expect(w.fake.calls("target.act")).toEqual([]);
    expect(cards(w.events)).toEqual([]);
    const granted = world({ policy: "dont-ask", apps: { "com.apple.Notes": { grant: "always" } } });
    const r2 = await granted.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    expect(r2.isError).toBe(false);
  }, 30_000);

  macOnly("plan: the per-app card on bind (the ruling), then state works and every action is NotAllowed", async () => {
    const w = world({ policy: "plan", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "session") });
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.state()\nawait notes.type('x')");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("NotAllowed (line 3): this session is in plan mode");
    expect(cards(w.events).map((c) => c.summary)).toEqual(["Allow Winter to use Notes (com.apple.Notes)?"]);
  }, 30_000);

  macOnly("restrictions and floors under bypass: Don't allow, click only, Winter itself", async () => {
    const w = world({ apps: { "com.apple.TextEdit": { access: "deny" }, "com.apple.Notes": { access: "click" } } });
    const r = await w.run([
      "try { await apps.open('TextEdit') } catch (e) { print('textedit', e.name) }",
      "try { await apps.open('Winter') } catch (e) { print('winter', e.name) }",
      "const notes = await apps.open('Notes')",
      "await notes.click(14)",
      "try { await notes.type('x') } catch (e) { print('type', e.name) }",
    ].join("\n"));
    expect(text(r)).toContain("textedit NotAllowed");
    expect(text(r)).toContain("winter Refused");
    expect(text(r)).toContain("type NotAllowed");
    expect(w.fake.calls("target.act").map((a) => a.access)).toEqual(["click"]);
  }, 30_000);

  macOnly("rung 4: needs_foreground → the foreground card → retried with allowForeground; unattended → NeedsForeground", async () => {
    const w = world({ policy: "ask", answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "session") });
    let first = true;
    w.fake.handlers["target.act"] = (p) => { if (first && p.allowForeground === false) { first = false; throw new FakeHelperError("needs_foreground", "canvas"); } return { rung: 4 }; };
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    expect(r.isError).toBe(false);
    expect(cards(w.events).map((c) => c.summary)).toEqual(["Allow Winter to use Notes (com.apple.Notes)?", "Winter needs to bring Notes (com.apple.Notes) to the front and use your mouse for a moment"]);
    expect(w.fake.calls("target.act").map((a) => a.allowForeground)).toEqual([false, true]);

    const lonely = world({ policy: "ask", attended: false, answer: (c, b) => b.resolve(c.sessionId, c.callId, true, "orb", "session") });
    lonely.fake.handlers["target.act"] = () => { throw new FakeHelperError("needs_foreground", "canvas"); };
    const r2 = await lonely.run("const notes = await apps.open('Notes')\ntry { await notes.click(14) } catch (e) { print(e.name) }");
    expect(text(r2)).toContain("NeedsForeground");
    expect(cards(lonely.events).map((c) => c.summary)).toEqual(["Allow Winter to use Notes (com.apple.Notes)?"]);
    // A menu command the app keeps disabled in the background: the same rung, worded for a menu.
    const r3 = await lonely.run("try { await notes.menu(['File', 'Move to Trash']) } catch (e) { print(e.name, e.message) }");
    expect(text(r3)).toContain("NeedsForeground Notes only enables that menu command while it is in front");
  }, 30_000);

  macOnly("bypass: NO computer-use prompt at all — needs_foreground is retried at once with allowForeground, attended or not", async () => {
    for (const attended of [false, true]) {
      const w = world({ policy: "bypass", attended });
      let first = true;
      w.fake.handlers["target.act"] = (p) => { if (first && p.allowForeground === false) { first = false; throw new FakeHelperError("needs_foreground", "canvas"); } return { rung: 4 }; };
      const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
      expect(r.isError).toBe(false);
      expect(cards(w.events)).toEqual([]);
      expect(w.fake.calls("target.act").map((a) => a.allowForeground)).toEqual([false, true]);
    }
    // The restrictions still hold under bypass: a view-only app never reaches the foreground retry.
    const viewOnly = world({ policy: "bypass", apps: { "com.apple.Notes": { access: "view" } } });
    const r = await viewOnly.run("const notes = await apps.open('Notes')\ntry { await notes.click(14) } catch (e) { print(e.name) }");
    expect(text(r)).toContain("NotAllowed");
    expect(viewOnly.fake.calls("target.act")).toEqual([]);
    expect(cards(viewOnly.events)).toEqual([]);
  }, 30_000);
});

describe("ComputerV2: locks, timeouts and cancellation", () => {
  macOnly("two sessions on one app: the second waits, then TargetBusy names the holder", async () => {
    const w = world();
    const holder = w.run("const notes = await apps.open('Notes')\nawait sleep(3000)", { sessionId: "s_holder" });
    await Bun.sleep(400);
    const r = await w.run("try { await apps.open('Notes') } catch (e) { print(e.name, e.message) }", { sessionId: "s_other", timeoutMs: 2_000 });
    expect(text(r)).toContain("TargetBusy Notes is in use by session s_holder");
    await holder;
  }, 30_000);

  macOnly("a timeout cancels the in-flight primitive (Cancelled) and the runtime survives", async () => {
    const w = world();
    const r = await w.run("const x = 7\nawait sleep(30000)", { timeoutMs: 1_000 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Cancelled");
    expect(text(r)).toContain("timed out after 1000 ms");
    const after = await w.run("print(x)");
    expect(text(after)).toContain("7");
    expect(text(after)).not.toContain("restarted");
  }, 30_000);

  macOnly("a script that never yields is killed one second after the cancel; the next call says so", async () => {
    const w = world();
    const t0 = Date.now();
    const r = await w.run("while (true) {}", { timeoutMs: 1_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(text(r)).toContain("the script did not stop, so the runtime was restarted");
    expect((await w.run("print(1)")).isError).toBe(false);
  }, 30_000);

  macOnly("an interrupt (the call's signal) cancels the script and the helper's work for that call id", async () => {
    const w = world();
    w.fake.handlers["target.waitFor"] = () => new Promise(() => {});
    const ac = new AbortController();
    const p = w.run("const notes = await apps.open('Notes')\nawait notes.waitFor({ text: 'never' })", { signal: ac.signal });
    await Bun.sleep(500);
    ac.abort();
    const r = await p;
    expect(text(r)).toContain("Cancelled");
    expect(w.fake.calls("cancel").length).toBeGreaterThan(0);
    expect(typeof w.fake.calls("target.waitFor")[0]!.callId).toBe("string");
  }, 30_000);

  macOnly("Esc from the helper interrupts the session's turn and cancels its script", async () => {
    const w = world();
    const p = w.run("await sleep(20000)");
    await Bun.sleep(300);
    // The helper only speaks once connected: bind something first in another session to open the connection.
    await w.run("await apps.list({ emit: false })", { sessionId: "s_open" });
    w.fake.notify("escPressed", { sessionIds: ["s1"] });
    const r = await p;
    expect(w.interrupts).toEqual(["s1"]);
    expect(text(r)).toContain("the user pressed Esc");
  }, 30_000);

  macOnly("an Esc naming a session with NO script running interrupts nothing (a late notification never stops a newer turn)", async () => {
    const w = world();
    await w.run("await apps.list({ emit: false })");   // opens the connection; the script has ended
    w.fake.notify("escPressed", { sessionIds: ["s1", "s_other"] });
    await Bun.sleep(100);
    expect(w.interrupts).toEqual([]);
  }, 30_000);
});

describe("ComputerV2: screenshots, points and the vision gate", () => {
  macOnly("a screenshot is an ordered image item at the model's budget; show() repeats it; emit:false only returns it", async () => {
    const w = world();
    const r = await w.run("const notes = await apps.open('Notes')\nprint('before')\nconst img = await notes.screenshot()\nprint('after')\nconst quiet = await notes.screenshot({ emit: false })\nshow(quiet)");
    const kinds = r.content.map((c) => (c.type === "image" ? "IMG" : c.text.includes("after") ? "after" : c.text.includes("before") ? "before" : "x"));
    expect(kinds.indexOf("IMG")).toBeGreaterThan(kinds.indexOf("before"));
    expect(kinds.lastIndexOf("after")).toBeGreaterThan(kinds.indexOf("IMG"));
    expect(r.content.filter((c) => c.type === "image")).toHaveLength(2);
    expect(w.fake.calls("target.screenshot")[0]).toMatchObject({ budget: { maxLongEdge: 2576, tile: 28, maxTiles: 4784, quality: 0.8 } });
    expect(typeof w.fake.calls("target.screenshot")[0]!.callId).toBe("string");
  }, 30_000);

  macOnly("show(await screen.screenshot()) sends the image ONCE (the live gate): one capture, one image item", async () => {
    const w = world();
    const r = await w.run("show(await screen.screenshot())\nconst notes = await apps.open('Notes')\nshow(await notes.screenshot())");
    expect(r.isError).toBe(false);
    expect(w.fake.calls("screen.screenshot")).toHaveLength(1);
    expect(w.fake.calls("target.screenshot")).toHaveLength(1);
    expect(r.content.filter((c) => c.type === "image")).toHaveLength(2);
  }, 30_000);

  macOnly("without vision: screenshot, show and Points are NotAllowed", async () => {
    const w = world();
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.screenshot() } catch (e) { print('shot', e.name, e.message) }\ntry { await notes.click([10, 10]) } catch (e) { print('point', e.name) }", { vision: false });
    expect(text(r)).toContain("shot NotAllowed this model can't see images — use state()");
    expect(text(r)).toContain("point NotAllowed");
    expect(w.fake.calls("target.screenshot")).toEqual([]);
  }, 30_000);

  macOnly("a Point needs the app's latest screenshot, and carries its shot id", async () => {
    const w = world();
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.click([5, 5]) } catch (e) { print(e.name) }\nawait notes.screenshot({ emit: false })\nawait notes.click([5, 5])");
    expect(text(r)).toContain("NotAllowed");
    expect(w.fake.calls("target.act")[0]).toMatchObject({ action: { kind: "click", point: [5, 5], shotId: "shot1" } });
  }, 30_000);

  macOnly("screen.screenshot blacks out the auth surfaces and Don't-allow apps — not Winter; screen.windows hides the same", async () => {
    const w = world({ apps: { "com.apple.Notes": { access: "deny" } } });
    w.fake.apps.find((a) => a.bundleId === "com.apple.TextEdit")!.running = true;
    const r = await w.run("await screen.screenshot()\nconst wins = await screen.windows({ emit: false })\nprint('[' + wins.map((x) => x.app).join(',') + ']')");
    const ex = w.fake.calls("screen.screenshot")[0]!.excludeBundleIds as string[];
    expect(ex).not.toContain("com.winter.app"); // the user ruling: Winter's windows are shown (binding it stays refused)
    expect(ex).toContain("com.apple.Notes");
    expect(ex).toContain("com.1password.1password"); // a built-in Don't-allow exception
    expect(ex).toContain("com.apple.keychainaccess"); // a floor
    expect(ex).not.toContain("com.apple.TextEdit");
    // The switch is on: the running apps are not asked for (nothing without a row is denied).
    expect(w.fake.calls("apps.list")).toEqual([]);
    // Running: Notes (Don't allow), TextEdit, Winter (shown), 1Password (default Don't allow), Keychain Access (an
    // auth surface) — TextEdit and Winter are listed.
    expect(text(r)).toContain("[TextEdit,Winter]");
  }, 30_000);

  macOnly("with Allow all apps OFF, a shot blacks out every RUNNING app without an allowing exception (asked fresh)", async () => {
    const w = world({ allowAllApps: false, apps: { "com.apple.Notes": { access: "view" } } });
    w.fake.apps.find((a) => a.bundleId === "com.apple.TextEdit")!.running = true;
    const r = await w.run("await screen.screenshot()\nconst wins = await screen.windows({ emit: false })\nprint('[' + wins.map((x) => x.app).join(',') + ']')");
    expect(w.fake.calls("apps.list")).toHaveLength(1);
    const ex = w.fake.calls("screen.screenshot")[0]!.excludeBundleIds as string[];
    expect(ex).toContain("com.apple.TextEdit"); // running, no exception → deny
    expect(ex).not.toContain("com.winter.app"); // running, no exception — but Winter is always shown
    expect(ex).toContain("com.1password.1password");
    expect(ex).not.toContain("com.apple.Notes"); // an allowing exception (view)
    expect(text(r)).toContain("[Notes,Winter]");
  }, 30_000);
});

describe("ComputerV2: the helper's errors and notifications", () => {
  macOnly("off-Space: privatePath follows the setting; a bind's or useWindow's detail is a daemon line before the state, outside the fence", async () => {
    const off = world({ privateEventPath: false });
    await off.run("const notes = await apps.open('Notes')");
    expect(off.fake.calls("target.bind")[0]).toMatchObject({ privatePath: false });

    const w = world();
    const bind = w.fake.handlers;
    let detail: string | undefined = "opened a new Notes window; the existing one is on another Space";
    const notesApp = w.fake.apps.find((a) => a.bundleId === "com.apple.Notes")!;
    bind["target.bind"] = () => {
      (w.fake as unknown as { targets: Map<string, unknown> }).targets.set("t1", notesApp);
      return { targetId: "t1", app: { name: "Notes", bundleId: "com.apple.Notes", pid: 501 }, window: { id: 9, title: "Notes window", frame: [0, 0, 800, 600] }, ...(detail === undefined ? {} : { detail }) };
    };
    const r = await w.run("const notes = await apps.open('Notes')");
    const items = r.content.map((c) => (c.type === "text" ? c.text : "[image]"));
    const at = items.findIndex((t) => t === "opened a new Notes window; the existing one is on another Space\n");
    expect(at).toBeGreaterThanOrEqual(0);
    // Its own item, unfenced, right before the fenced state.
    expect(items[at + 1]).toMatch(/^<screen-data id="[0-9a-f]+">\nNotes — window/);
    bind["target.useWindow"] = () => ({ window: { id: 10, title: "other", frame: [0, 0, 1, 1] }, detail: "moved Notes's window to this desktop from another Space" });
    const r2 = await w.run("await notes.useWindow('other')");
    expect(text(r2)).toContain("moved Notes's window to this desktop from another Space");
    expect(text(r2)).not.toContain("<screen-data");
    detail = undefined;
    const r3 = await w.run("const again = await apps.open('Notes')");
    expect(text(r3)).not.toContain("opened a new");
  }, 30_000);

  macOnly("a target screenshot's detail is an unfenced daemon line, even for an emit:false read", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')");
    w.fake.handlers["target.screenshot"] = () => ({ imageBase64: Buffer.from("jpeg-x").toString("base64"), mime: "image/jpeg", width: 10, height: 10, shotId: "shotX", detail: "Notes's window is on another desktop (another Space or full screen), so this is its last drawn content — it may be a little out of date" });
    const r = await w.run("await notes.screenshot()");
    expect(r.content.map((c) => (c.type === "text" ? c.text : "[image]"))).toContain("Notes's window is on another desktop (another Space or full screen), so this is its last drawn content — it may be a little out of date\n");
    const r2 = await w.run("const quiet = await notes.screenshot({ emit: false })");
    expect(r2.content.map((c) => (c.type === "text" ? c.text : "[image]"))).toEqual(["Notes's window is on another desktop (another Space or full screen), so this is its last drawn content — it may be a little out of date\n"]);
  }, 30_000);

  macOnly("unsupported: the helper's sentence reaches the script; data.axError only the log", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')");
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("unsupported", "Notes' editor does not expose a settable value", { axError: -25205 }); };
    const r = await w.run("try { await notes.setValue(14, 'x') } catch (e) { print(e.name, e.message) }");
    expect(text(r)).toContain("Error Notes' editor does not expose a settable value");
    expect(text(r)).not.toContain("25205");
    expect(w.logs.some((l) => l.includes("AX error -25205"))).toBe(true);
  }, 30_000);

  macOnly("window_elsewhere with newWindowId: NoWindow says a new window was opened — call state() and retry; the diff base resets", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')");
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("window_elsewhere", "Notes's window is on another Space or in full screen and could not be moved here, so a new Notes window was opened on this desktop and the target now uses it — the action did not run; refs and screenshots were reset, so call state() and retry", { newWindowId: 12 }); };
    const r = await w.run("try { await notes.click(14) } catch (e) { print(e.name, e.message) }\nawait notes.state()");
    expect(text(r)).toContain("NoWindow Notes's window is on another Space or in full screen, so a new window was opened on this desktop and the target now uses it — the action did not run; call state() and retry");
    expect(text(r)).not.toContain("quit");
    // The next state() is FULL: no `since` from the old window's base.
    const snaps = w.fake.calls("target.snapshot");
    expect(snaps[snaps.length - 1]!.since).toBeUndefined();
  }, 30_000);

  macOnly("window_elsewhere and no_window are NoWindow, keep the helper's message, never say the app quit", async () => {
    const w = world();
    let code = "window_elsewhere";
    w.fake.handlers["target.find"] = () => { throw new FakeHelperError(code, code === "window_elsewhere" ? "the window is on another Space / full screen" : "the app has no open window"); };
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.find({ role: 'button' }) } catch (e) { print(e instanceof NoWindow, e instanceof TargetLost, e.message) }");
    expect(text(r)).toContain("true false Notes: the window is on another Space / full screen — ask the user to bring it to this desktop");
    expect(text(r)).not.toContain("quit");
    code = "no_window";
    const r2 = await w.run("try { await notes.find({ role: 'button' }) } catch (e) { print(e.name, e.message) }\nawait notes.state()");
    expect(text(r2)).toContain("NoWindow Notes: the app has no open window — ask the user to open one");
    expect(text(r2)).not.toContain("quit");
    // The target stays bound (the window may come back): the next call reaches the helper again.
    expect(r2.isError).toBe(false);
  }, 30_000);

  macOnly("the live gate's Finder run: find shows disabled, screen.windows shows off screen, metrics keep the helper's code", async () => {
    const w = world();
    w.fake.handlers["target.find"] = () => ({ elements: [{ ref: 334, role: "menu item", name: "Move to Trash", states: ["disabled"] }] });
    w.fake.handlers["screen.windows"] = () => ({ windows: [
      { app: "Safari", bundleId: "com.apple.Safari", pid: 7, windowId: 84426, title: "OpenRouter", frame: [0, 33, 1512, 949], onScreen: false },
    ] });
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("unsupported", "“Move to Trash” is disabled right now"); };
    const r = await w.run([
      "const finder = await apps.open('Notes')",
      "const items = await finder.find({ role: 'menu item' })",
      "print(JSON.stringify(items[0].states))",
      "const wins = await screen.windows()",
      "print(String(wins[0].onScreen))",
      "try { await finder.click(334) } catch (e) { print(e.name) }",
    ].join("\n"));
    expect(text(r)).toContain('[334] menu item "Move to Trash" (disabled)');
    expect(text(r)).toContain('["disabled"]');
    expect(text(r)).toContain('Safari — "OpenRouter" [0, 33, 1512, 949] (off screen)');
    expect(text(r)).toContain("false");
    const lines = readFileSync(w.telemetry.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.primitive === "click")).toMatchObject({ error: "Error", errorCode: "unsupported" });
  }, 30_000);

  macOnly("busy is retried once; twice is a typed HelperUnavailable", async () => {
    const w = world();
    let n = 0;
    w.fake.handlers["target.find"] = () => { n++; if (n === 1) throw new FakeHelperError("busy", "queue full", { retryable: true }); return { elements: [{ ref: 3, role: "button", name: "OK" }] }; };
    const r = await w.run("const notes = await apps.open('Notes')\nconst els = await notes.find('OK')\nprint(els.length)");
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('[3] button "OK"');
    w.fake.handlers["target.find"] = () => { throw new FakeHelperError("busy", "ax timeout"); };
    const r2 = await w.run("try { await notes.find('OK') } catch (e) { print(e.name, e.message) }");
    expect(text(r2)).toContain("HelperUnavailable Notes did not answer in time");
  }, 30_000);

  macOnly("typed helper errors become their classes with one actionable sentence", async () => {
    const w = world();
    w.fake.handlers["target.act"] = (p) => {
      const kind = (p.action as { kind: string }).kind;
      if (kind === "click") throw new FakeHelperError("stale_ref", "gone", { ref: 12 });
      if (kind === "type") throw new FakeHelperError("refused", "", { reason: "secure_field" });
      throw new FakeHelperError("permission_missing", "no", { permission: "accessibility" });
    };
    const r = await w.run([
      "const notes = await apps.open('Notes')",
      "try { await notes.click(12) } catch (e) { print(e.name, e.message) }",
      "try { await notes.type('pw') } catch (e) { print(e.name, e.message) }",
      "try { await notes.key('cmd+s') } catch (e) { print(e.name, e.message) }",
    ].join("\n"));
    expect(text(r)).toContain("StaleRef [12] is gone — call state()");
    expect(text(r)).toContain("Refused that is a password or payment field");   // a bare refusal: the fallback words
    expect(text(r)).toContain("PermissionMissing Winter Computer Use needs the Accessibility permission");
  }, 30_000);

  macOnly("a refusal keeps the HELPER's own sentence — never a canned one for its reason code (the live gate)", async () => {
    const w = world();
    const said = "can't tell which field has focus in Code, so it could be a password field — pass `into` or click a text field first";
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("refused", said, { reason: "secure_field" }); };
    const r = await w.run("const notes = await apps.open('Notes')\ntry { await notes.type('hello') } catch (e) { print(e.name, e.message) }");
    expect(text(r)).toContain(`Refused ${said}`);
    expect(text(r)).not.toContain("that is a password or payment field");
    // focus_unknown (the core lane's new reason) keeps the helper's sentence too.
    const focus = "can't tell which field has focus in Notes — pass `into` or click a text field first";
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("refused", focus, { reason: "focus_unknown" }); };
    const r1 = await w.run("try { await notes.type('hello') } catch (e) { print(e.name, e.message) }");
    expect(text(r1)).toContain(`Refused ${focus}`);
    expect(text(r1)).not.toContain("refused that action");
    // focus_unknown with no message of its own gets its own words.
    w.fake.handlers["target.act"] = () => { throw new FakeHelperError("refused", "", { reason: "focus_unknown" }); };
    const r2 = await w.run("try { await notes.type('hello') } catch (e) { print(e.name, e.message) }");
    expect(text(r2)).toContain("Refused can't tell which field has focus in Notes, so it could be a password field — pass `into` or click a text field first");
  }, 30_000);

  macOnly("targetLost and the helper quitting: TargetLost next use; HelperUnavailable mid-call; the next call relaunches", async () => {
    const w = world();
    await w.run("const notes = await apps.open('Notes')");
    w.fake.notify("targetLost", { targetId: "t1", reason: "app_quit" });
    await Bun.sleep(20);
    const r1 = await w.run("try { await notes.state() } catch (e) { print(e.name, e.message) }");
    expect(text(r1)).toContain("TargetLost Notes is gone (the app quit)");

    w.fake.handlers["apps.list"] = () => new Promise(() => {});
    const p = w.run("try { await apps.list() } catch (e) { print(e.name) }");
    await Bun.sleep(300);
    w.fake.quit();
    expect(text(await p)).toContain("HelperUnavailable");
    delete w.fake.handlers["apps.list"];
    const r3 = await w.run("const again = await apps.open('Notes')\nprint(again.name)");
    expect(r3.isError).toBe(false);
    expect(w.fake.launched).toEqual([expect.stringMatching(/dist\/dev\/Winter Computer Use Dev\.app$/)]);
  }, 30_000);
});

describe("ComputerV2: the record it leaves", () => {
  macOnly("telemetry: one line per primitive, no content; the audit line names apps and primitives, never code", async () => {
    const w = world();
    const secret = "hunter2-typed-secret";
    await w.run(`const notes = await apps.open('Notes')\nawait notes.type('${secret}')\nawait notes.state()`);
    const lines = readFileSync(w.telemetry.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.primitive)).toEqual(["apps.open", "type", "state"]);
    for (const l of lines) {
      expect(Object.keys(l).sort().every((k) => ["ts", "sessionId", "callId", "primitive", "ms", "helperMs", "rung", "settleMs", "settleExit", "imageBytes", "error", "errorCode"].includes(k))).toBe(true);
    }
    expect(readFileSync(w.telemetry.path, "utf8")).not.toContain(secret);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ kind: "automation", sessionId: "s1", apps: ["Notes"], primitives: { "apps.open": 1, type: 1, state: 1 }, outcome: "ok" });
    expect(JSON.stringify(w.audits)).not.toContain(secret);
  }, 30_000);

  macOnly("a script that only prints is not fenced; reading the screen fences everything it printed", async () => {
    const w = world();
    expect(text(await w.run("print('plain')"))).not.toContain("screen-data");
    const r = await w.run("const s = await (await apps.open('Notes')).state({ emit: false })\nprint(s.split('\\n')[0])");
    expect(text(r)).toMatch(/<screen-data id="[0-9a-f]{12}">\nNotes — /);
  }, 30_000);
});
