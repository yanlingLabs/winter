// Helper 1.9.8 (round 9) inside the daemon: what the Focus Guardian did or saw since the last act (an act result's
// `guardian` notes and `viewMovedBy`), and the known hover limitation said once per session per app when a bind or
// useWindow lands on a window with web content (`webContent`). A REAL sandboxed worker runs the script, the REAL policy
// decides, the REAL helper client talks to a FAKE helper.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { HelperClient } from "../../src/computer-use/helper-client";
import { ComputerPolicy, type SessionFacts } from "../../src/computer-use/policy";
import { ComputerV2Service, type ScriptResult } from "../../src/computer-use/service";
import { AutomationTelemetry } from "../../src/computer-use/telemetry";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { FakeHelper } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;

const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

const HOVER = "Safari's web pages don't react to hover from Winter's pointer while it is in the background — click instead, or app.requestForeground(reason) for a real hover";

function world() {
  const home = mkdtempSync(join(tmpdir(), "winter-cu-guardian-notes-"));
  const fake = new FakeHelper();
  fake.apps.push({ name: "Safari", bundleId: "com.apple.Safari", pid: 601, running: true });
  fake.apps.push({ name: "Notes", bundleId: "com.apple.Notes", pid: 602, running: true });
  const settings = { computerUse: { apps: {} } } as unknown as Settings;
  const facts: SessionFacts = { policy: "bypass", mode: "code" };
  let svc!: ComputerV2Service;
  const helper = new HelperClient({
    home, profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
    onNotification: (n) => svc.handleNotification(n), onDisconnect: () => svc.helperDisconnected(),
  });
  const policy = new ComputerPolicy({
    settings: () => settings, saveAlwaysGrant: () => {}, approvals: new ApprovalBroker(), emit: () => {},
    session: () => facts, attended: () => true,
  });
  svc = new ComputerV2Service({ helper, policy, settings: () => settings, telemetry: new AutomationTelemetry(home) });
  services.push(svc);
  // Safari's window holds web content; Notes' does not.
  let nextTarget = 1;
  fake.handlers["target.bind"] = (p) => {
    const app = fake.apps.find((a) => a.bundleId === p.app || a.name === p.app)!;
    const targetId = `t${nextTarget++}`;
    fake.targets.set(targetId, app);
    return {
      targetId, app: { name: app.name, bundleId: app.bundleId, pid: app.pid }, window: { id: 7, title: "w", frame: [0, 0, 1, 1] },
      ...(app.bundleId === "com.apple.Safari" ? { webContent: true } : {}),
    };
  };
  const run = (code: string, o: { sessionId?: string; reset?: boolean } = {}): Promise<ScriptResult> =>
    svc.run({ sessionId: o.sessionId ?? "s1", vision: true, model: "anthropic/claude-opus-5-5" }, { code, ...(o.reset === undefined ? {} : { reset: o.reset }) });
  return { home, fake, svc, run };
}

const text = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
/** The text OUTSIDE every screen-data fence. */
const unfenced = (r: ScriptResult): string => text(r).replace(/<screen-data id="[0-9a-f]+">[\s\S]*?<\/screen-data id="[0-9a-f]+">/g, "");
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
/** The text INSIDE the screen-data fences. */
const fenced = (r: ScriptResult): string => [...text(r).matchAll(/<screen-data id="[0-9a-f]+">([\s\S]*?)<\/screen-data id="[0-9a-f]+">/g)].map((m) => m[1]).join("\n");

describe("ComputerV2: the Focus Guardian's notes on an act's result (helper 1.9.8)", () => {
  macOnly("each note is a line inside the fence (it names apps by their own names), and the apps that came forward are counted in the metric", async () => {
    const w = world();
    let acts = 0;
    w.fake.handlers["target.act"] = () => {
      acts += 1;
      return acts === 1
        ? { rung: 1, guardian: ["Mail came forward after your action and was sent back — avoid that (a link opens in the background when clicked; apps.open and browsers.open work without bringing anything forward)"], viewMovedBy: ["Mail"] }
        : { rung: 1 };
    };
    const r = await w.run("const notes = await apps.open('Notes')\nprint(await notes.state())\nawait notes.click(14)\nawait notes.click(14)");
    expect(r.isError).toBeFalsy();
    expect(count(fenced(r), "Mail came forward after your action and was sent back")).toBe(1);
    expect(count(unfenced(r), "Mail came forward after your action")).toBe(0);
    const metrics = readFileSync(join(w.home, "logs", "automation-metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const clicks = metrics.filter((m) => m.primitive === "click");
    expect(clicks.length).toBe(2);
    expect(clicks[0]!.viewMovedBy).toEqual(["Mail"]);
    expect(clicks[1]!.viewMovedBy).toBeUndefined();
  });

  macOnly("a note is capped and never carries more than one line", async () => {
    const w = world();
    w.fake.handlers["target.act"] = () => ({ rung: 1, guardian: [`X${"y".repeat(2000)}\nsecond line`], viewMovedBy: Array.from({ length: 20 }, (_, i) => `App${i}`) });
    const r = await w.run("const notes = await apps.open('Notes')\nawait notes.click(14)");
    const all = text(r);
    expect(all.includes("second line")).toBe(false);
    expect(all.includes("y".repeat(500))).toBe(false);
    const metrics = readFileSync(join(w.home, "logs", "automation-metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect((metrics.find((m) => m.primitive === "click")!.viewMovedBy as string[]).length).toBe(8);
  });
});

describe("ComputerV2: web pages and hover — said once per session per app (helper 1.9.8)", () => {
  macOnly("a bind on a window with web content carries the line once; an app without web content never does", async () => {
    const w = world();
    const r1 = await w.run("const s = await apps.open('Safari')\nconst n = await apps.open('Notes')");
    expect(r1.isError).toBeFalsy();
    expect(count(unfenced(r1), HOVER)).toBe(1);
    expect(unfenced(r1).includes("Notes's web pages")).toBe(false);
    // Again in the same session: not repeated.
    const r2 = await w.run("const s2 = await apps.open('Safari')");
    expect(count(unfenced(r2), HOVER)).toBe(0);
    // Another session hears it on its own.
    const r3 = await w.run("const s3 = await apps.open('Safari')", { sessionId: "s2" });
    expect(count(unfenced(r3), HOVER)).toBe(1);
  });

  macOnly("again after a compaction of the main thread or a reset", async () => {
    const w = world();
    expect(count(unfenced(await w.run("const s = await apps.open('Safari')")), HOVER)).toBe(1);
    w.svc.hoverNotes.observe({ type: "continuity_warning", sessionId: "s1", warning: "compacted", threadId: "main" } as unknown as SessionEvent);
    expect(count(unfenced(await w.run("const s2 = await apps.open('Safari')")), HOVER)).toBe(1);
    // A subagent's compaction is not the main thread's: nothing forgotten.
    w.svc.hoverNotes.observe({ type: "continuity_warning", sessionId: "s1", warning: "compacted", threadId: "sub-1" } as unknown as SessionEvent);
    expect(count(unfenced(await w.run("const s3 = await apps.open('Safari')")), HOVER)).toBe(0);
    expect(count(unfenced(await w.run("const s4 = await apps.open('Safari')", { reset: true })), HOVER)).toBe(1);
  });

  macOnly("useWindow onto a window with web content says it too (once)", async () => {
    const w = world();
    w.fake.handlers["target.useWindow"] = () => ({ window: { id: 8, title: "other", frame: [0, 0, 1, 1] }, webContent: true });
    const r = await w.run("const n = await apps.open('Notes')\nawait n.useWindow('other')\nawait n.useWindow('other')");
    expect(r.isError).toBeFalsy();
    expect(count(unfenced(r), "Notes's web pages don't react to hover")).toBe(1);
  });
});
