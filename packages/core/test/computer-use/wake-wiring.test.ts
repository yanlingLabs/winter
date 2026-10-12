// Wake triggers, the PRODUCTION wiring (`createComputerUseRuntime` with no backend injected): the tab backend over the
// browser engine and the app backend over the helper are both built, and the engine asks the service whether the
// helper's input to a browser bound as an app is Winter's own (`ownAppInputAt`) — so a click the helper sends a
// browser's window is never a tab trigger's user click.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../../src/agent/approvals";
import { BrowserWakeBackend } from "../../src/computer-use/browser/wake/backend";
import { AppWakeBackend } from "../../src/computer-use/wakes/app-backend";
import type { WakeBackends } from "../../src/computer-use/wakes/registry";
import { WAKE_LIMITS } from "../../src/computer-use/wakes/types";
import { createComputerUseRuntime } from "../../src/computer-use/wiring";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import type { Settings } from "../../src/settings";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import { FakeHelper } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;

function runtime() {
  const home = mkdtempSync(join(tmpdir(), "winter-wake-wiring-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const fake = new FakeHelper();
  fake.helperVersion = "1.17.0";
  // Notes allowed always; the policy is bypass for the act below.
  const settings = { computerUse: { apps: { "com.apple.Notes": { grant: "always" } } } } as unknown as Settings;
  const rt = createComputerUseRuntime({
    home, profile: "dev", settings: () => settings, settingsPath: join(home, "settings.json"), approvals: new ApprovalBroker(), hub, store,
    launchAllowed: true,
    inject: {
      transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier, launchAllowed: true, browserInstalled: () => false,
      headless: { resolve: () => ({ missing: "no headless browser in this test" }) },
    },
  });
  const sessionId = store.createSession("t", { cwd: home, mode: "code", approvalPolicy: "bypass" });
  const done = (): void => { rt.stop(); store.close(); rmSync(home, { recursive: true, force: true }); };
  return { rt, fake, sessionId, done };
}

describe("the wake backends as the daemon builds them", () => {
  test("both are built: the tab backend over the engine, the app backend over the helper", () => {
    const w = runtime();
    try {
      const backends = (w.rt.wakes as unknown as { deps: { backends(): WakeBackends } }).deps.backends();
      expect(backends.tab).toBeInstanceOf(BrowserWakeBackend);
      expect(backends.app).toBeInstanceOf(AppWakeBackend);
    } finally { w.done(); }
  });

  macOnly("the engine sees the helper's act on an app as Winter's own input to it, from the service's record", async () => {
    const w = runtime();
    try {
      let during: boolean | undefined;
      w.fake.handlers["target.act"] = async () => {
        await Bun.sleep(30);
        during = w.rt.browsers.wakeOwnAppInput("com.apple.Notes", Date.now());
        return { rung: 1 };
      };
      const r = await w.rt.service.run({ sessionId: w.sessionId, vision: true, model: "anthropic/claude-opus-5-5" }, {
        code: "const notes = await apps.open('Notes', { emit: false })\nawait notes.click(14)",
      });
      expect(r.isError).toBe(false);
      expect(during).toBe(true);
      expect(w.rt.browsers.wakeOwnAppInput("com.google.Chrome", Date.now())).toBe(false);
      expect(w.rt.browsers.wakeOwnAppInput("com.apple.Notes", Date.now() + WAKE_LIMITS.ownInputGraceMs + 200)).toBe(false);
    } finally { w.done(); }
  }, 30_000);
});
