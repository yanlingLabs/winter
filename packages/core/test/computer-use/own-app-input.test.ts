// Wake triggers across backends: Winter's own HELPER input to an app, per bundle id, from every session — what a tab
// wake trigger on a browser that is ALSO bound as an app asks (`BrowserEngineDeps.ownAppInputAt`), since the helper's
// clicks reach its page as trusted DOM events. The rule is the tab's own (`TabDriver.ownInputAt`): in flight at `at`, or
// ended at most the 500 ms grace before it, with 50 ms of slack before a start.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../../src/agent/approvals";
import { HelperClient } from "../../src/computer-use/helper-client";
import { OwnAppInput } from "../../src/computer-use/own-app-input";
import { ComputerPolicy } from "../../src/computer-use/policy";
import { ComputerV2Service } from "../../src/computer-use/service";
import { WAKE_LIMITS } from "../../src/computer-use/wakes/types";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { FakeHelper } from "./fake-helper";

describe("OwnAppInput", () => {
  test("in flight: any instant from 50 ms before its start counts; another app does not", () => {
    let now = 1_000;
    const own = new OwnAppInput(() => now);
    const end = own.begin("com.google.Chrome");
    now = 1_200;
    expect(own.at("com.google.Chrome", 1_100)).toBe(true);
    expect(own.at("com.google.Chrome", 5_000)).toBe(true); // still in flight
    expect(own.at("com.google.Chrome", 951)).toBe(true);
    expect(own.at("com.google.Chrome", 949)).toBe(false);
    expect(own.at("com.apple.Safari", 1_100)).toBe(false);
    end();
  });

  test("closed: the window plus the grace after it, never past it", () => {
    let now = 1_000;
    const own = new OwnAppInput(() => now);
    const end = own.begin("com.google.Chrome");
    now = 1_300;
    end();
    const grace = WAKE_LIMITS.ownInputGraceMs;
    expect(own.at("com.google.Chrome", 1_300 + grace)).toBe(true);
    expect(own.at("com.google.Chrome", 1_300 + grace + 1)).toBe(false);
    expect(own.at("com.google.Chrome", 2_500)).toBe(false);
    expect(own.at("com.google.Chrome", Number.NaN)).toBe(false);
  });

  test("bundle ids compare without regard to case; nested inputs make one window; ending twice is harmless", () => {
    let now = 0;
    const own = new OwnAppInput(() => now);
    const a = own.begin("com.google.Chrome");
    now = 100;
    const b = own.begin("COM.GOOGLE.CHROME");
    now = 200;
    a();
    a();
    expect(own.at("com.google.chrome", 10_000)).toBe(true); // b is still in flight
    now = 400;
    b();
    expect(own.at("com.google.Chrome", 400 + WAKE_LIMITS.ownInputGraceMs)).toBe(true);
    expect(own.at("com.google.Chrome", 401 + WAKE_LIMITS.ownInputGraceMs)).toBe(false);
  });

  test("an old window is let go (an app's record does not grow without bound)", () => {
    let now = 0;
    const own = new OwnAppInput(() => now);
    for (let i = 0; i < 40; i++) { const end = own.begin("com.google.Chrome"); now += 10; end(); now += 10; }
    expect(own.at("com.google.Chrome", 5)).toBe(false); // the first windows were dropped (32 kept)
    expect(own.at("com.google.Chrome", now - 15)).toBe(true);
    now += 120_000;
    own.begin("com.apple.Notes")(); // a later begin prunes the stale app
    expect(own.at("com.google.Chrome", now - 120_000 - 15)).toBe(false);
  });
});

const macOnly = sandboxAvailable() ? test : test.skip;
const services: ComputerV2Service[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("the service records its helper input per app", () => {
  macOnly("an act and an AppleScript are Winter's own input to their app while in flight and for the grace after; a read is not", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-own-input-"));
    homes.push(home);
    const fake = new FakeHelper();
    const settings = { computerUse: {} } as unknown as Settings;
    let svc!: ComputerV2Service;
    const helper = new HelperClient({
      home, profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
      onNotification: (n) => svc.handleNotification(n), onDisconnect: () => svc.helperDisconnected(),
    });
    const policy = new ComputerPolicy({
      settings: () => settings, saveAlwaysGrant: () => {}, approvals: new ApprovalBroker(),
      emit: () => {}, session: () => ({ policy: "bypass", mode: "code" }), attended: () => true,
    });
    svc = new ComputerV2Service({ helper, policy, settings: () => settings });
    services.push(svc);
    // What the service answers while each helper method is in flight.
    const seen: Record<string, boolean> = {};
    const during = (method: string, answer: unknown) => async () => {
      await Bun.sleep(30);
      seen[method] = svc.ownAppInputAt("com.apple.Notes", Date.now());
      seen[`${method}:other`] = svc.ownAppInputAt("com.apple.TextEdit", Date.now());
      return answer;
    };
    fake.handlers["target.act"] = during("target.act", { rung: 1 });
    fake.handlers["target.applescript"] = during("target.applescript", { result: "ok" });
    const r = await svc.run({ sessionId: "s1", vision: true, model: "anthropic/claude-opus-5-5" }, {
      code: "const notes = await apps.open('Notes', { emit: false })\nawait notes.click(14)\nawait notes.applescript('tell application \"Notes\" to get name')",
    });
    expect(r.isError).toBe(false);
    expect(seen).toEqual({ "target.act": true, "target.act:other": false, "target.applescript": true, "target.applescript:other": false });
    // Just after: inside the grace. Past it: the user's again.
    const ended = Date.now();
    expect(svc.ownAppInputAt("com.apple.Notes", ended)).toBe(true);
    expect(svc.ownAppInputAt("com.apple.Notes", ended + WAKE_LIMITS.ownInputGraceMs + 100)).toBe(false);
    // Another session that only READS the app sends it no input.
    await Bun.sleep(WAKE_LIMITS.ownInputGraceMs + 150);
    // (s1 lets go of Notes first: an app one session holds, no other binds.)
    await svc.run({ sessionId: "s1", vision: true, model: "anthropic/claude-opus-5-5" }, { code: "await apps.release()" });
    const before = Date.now();
    const read = await svc.run({ sessionId: "s2", vision: true, model: "anthropic/claude-opus-5-5" }, {
      code: "const notes = await apps.open('Notes', { emit: false })\nawait notes.state()",
    });
    expect(read.isError).toBe(false);
    expect(svc.ownAppInputAt("com.apple.Notes", before)).toBe(false);
    expect(svc.ownAppInputAt("com.apple.Notes", Date.now())).toBe(false);
  }, 30_000);
});
