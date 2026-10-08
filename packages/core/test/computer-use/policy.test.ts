// ComputerV2: the per-app policy (`computer-use/policy.ts`) — the matrix, the per-app card and its options, the
// grants, the user's restrictions under every policy, the floors, the rung-4 foreground card.
import { describe, expect, test } from "bun:test";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { AutomationFailure } from "../../src/computer-use/errors";
import { APP_CARD_OPTIONS, ComputerPolicy, DEFAULT_APP_EXCEPTIONS, effectiveAppAccess, newRunGrants, type SessionFacts } from "../../src/computer-use/policy";
import type { Settings } from "../../src/settings";
import { DISPATCH_CHILD_APPROVAL_TIMEOUT_MS } from "../../src/runtime-sdk/approval-bridge";

const NOTES = { bundleId: "com.apple.Notes", name: "Notes" };

function setup(opts: { policy?: SessionApprovalPolicy; facts?: Partial<SessionFacts>; apps?: Record<string, unknown>; allowAllApps?: boolean; attended?: boolean; answer?: (callId: string, broker: ApprovalBroker, sessionId: string) => void } = {}) {
  const approvals = new ApprovalBroker();
  const events: NewSessionEvent[] = [];
  let settings: Settings = { computerUse: { apps: opts.apps ?? {}, ...(opts.allowAllApps === undefined ? {} : { allowAllApps: opts.allowAllApps }) } } as unknown as Settings;
  const saved: Array<[string, string]> = [];
  const facts: SessionFacts = { policy: opts.policy ?? "ask", mode: "code", ...opts.facts };
  const policy = new ComputerPolicy({
    settings: () => settings,
    saveAlwaysGrant: (bundleId, name) => {
      saved.push([bundleId, name]);
      settings = { computerUse: { apps: { ...(settings.computerUse?.apps ?? {}), [bundleId]: { grant: "always", name } } } } as unknown as Settings;
    },
    approvals,
    emit: (_sid, e) => {
      events.push(e);
      if (e.type === "approval_requested" && opts.answer !== undefined) {
        const callId = (e as { callId: string }).callId;
        queueMicrotask(() => opts.answer!(callId, approvals, (e as { sessionId: string }).sessionId));
      }
    },
    session: () => facts,
    attended: () => opts.attended ?? true,
  });
  return { policy, approvals, events, saved, facts, setSettings: (s: Settings) => { settings = s; } };
}

const cards = (events: NewSessionEvent[]) => events.filter((e) => e.type === "approval_requested") as Array<Extract<NewSessionEvent, { type: "approval_requested" }>>;

async function failsWith(p: Promise<unknown>, kind: AutomationFailure["kind"]): Promise<string> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(AutomationFailure);
    expect((e as AutomationFailure).kind).toBe(kind);
    return (e as Error).message;
  }
  throw new Error(`expected ${kind}`);
}

describe("the policy matrix", () => {
  test("plan: the per-app card on BIND (the ruling), then observe only — every act NotAllowed", async () => {
    const { policy, events } = setup({ policy: "plan", answer: (c, b, sid) => b.resolve(sid, c, true, "orb") });
    const run = newRunGrants("s1");
    await policy.authorize(run, NOTES, { kind: "bind" });
    expect(cards(events)).toHaveLength(1);
    await policy.authorize(run, NOTES, { kind: "observe" });
    expect(await failsWith(policy.authorize(run, NOTES, { kind: "act", primitive: "click" }), "NotAllowed")).toContain("plan mode");
    expect(cards(events)).toHaveLength(1);
    // A denied card under plan refuses the bind.
    const denied = setup({ policy: "plan", answer: (c, b, sid) => b.resolve(sid, c, false, "orb") });
    await failsWith(denied.policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" }), "NotAllowed");
  });

  test("bypass: no cards at all", async () => {
    const { policy, events } = setup({ policy: "bypass" });
    const run = newRunGrants("s1");
    await policy.authorize(run, NOTES, { kind: "bind" });
    await policy.authorize(run, NOTES, { kind: "act", primitive: "type" });
    expect(cards(events)).toHaveLength(0);
  });

  test("dont-ask: binds and acts ONLY on an Always-allow app (the ruling), never a card", async () => {
    const { policy, events } = setup({ policy: "dont-ask", apps: { "com.apple.TextEdit": { grant: "always" } } });
    const run = newRunGrants("s1");
    expect(await failsWith(policy.authorize(run, NOTES, { kind: "bind" }), "NotAllowed")).toContain("Always allow");
    expect(await failsWith(policy.authorize(run, NOTES, { kind: "act", primitive: "click" }), "NotAllowed")).toContain("Always allow");
    await policy.authorize(run, { bundleId: "com.apple.TextEdit", name: "TextEdit" }, { kind: "bind" });
    await policy.authorize(run, { bundleId: "com.apple.TextEdit", name: "TextEdit" }, { kind: "act", primitive: "type" });
    expect(cards(events)).toHaveLength(0);
  });

  for (const p of ["ask", "accept-edits", "auto"] as const) {
    test(`${p}: one per-app card on first bind, with the three options; concurrent primitives share it`, async () => {
      const { policy, events } = setup({ policy: p, answer: (callId, b) => b.resolve("s1", callId, true, "orb") });
      const run = newRunGrants("s1");
      await Promise.all([policy.authorize(run, NOTES, { kind: "bind" }), policy.authorize(run, NOTES, { kind: "act", primitive: "click" })]);
      const c = cards(events);
      expect(c).toHaveLength(1);
      // The summary names the bundle id — a look-alike app cannot borrow a trusted name (the ruling).
      expect(c[0]).toMatchObject({ toolName: "ComputerV2", summary: "Allow Winter to use Notes (com.apple.Notes)?", threadId: "main" });
      expect(c[0]!.options).toEqual([...APP_CARD_OPTIONS]);
      expect(c[0]!.options!.every((o) => o.rule === undefined)).toBe(true);
      expect(c[0]!.callId).toMatch(/^cu_[0-9a-f]{12}$/);
      expect(events.some((e) => e.type === "approval_resolved")).toBe(true);
    });
  }
});

describe("the per-app card's answers", () => {
  test("approve with NO option is Allow once: this call only", async () => {
    const { policy, events } = setup({ answer: (callId, b) => b.resolve("s1", callId, true, "orb") });
    const run1 = newRunGrants("s1");
    await policy.authorize(run1, NOTES, { kind: "bind" });
    await policy.authorize(run1, NOTES, { kind: "act", primitive: "click" }); // same call: no second card
    expect(cards(events)).toHaveLength(1);
    const run2 = newRunGrants("s1");
    await policy.authorize(run2, NOTES, { kind: "bind" }); // a new call cards again
    expect(cards(events)).toHaveLength(2);
  });

  test("Allow for this session: no card for the rest of the session, a card in another session", async () => {
    const { policy, events } = setup({ answer: (callId, b, sid) => b.resolve(sid, callId, sid === "s1", "orb", sid === "s1" ? "session" : undefined) });
    await policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" });
    await policy.authorize(newRunGrants("s1"), NOTES, { kind: "act", primitive: "click" });
    expect(cards(events)).toHaveLength(1);
    // Another session of the same daemon is asked again (and here, declines).
    expect(await failsWith(policy.authorize(newRunGrants("s2"), NOTES, { kind: "bind" }), "NotAllowed")).toContain("did not allow");
    expect(cards(events)).toHaveLength(2);
  });

  test("Always allow is persisted to computerUse.apps.<bundleId>.grant and needs no card again", async () => {
    const { policy, events, saved } = setup({ answer: (callId, b) => b.resolve("s1", callId, true, "orb", "always") });
    await policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" });
    expect(saved).toEqual([["com.apple.Notes", "Notes"]]);
    expect(policy.hasAlwaysGrant("com.apple.Notes")).toBe(true);
    await policy.authorize(newRunGrants("s9"), NOTES, { kind: "act", primitive: "type" });
    expect(cards(events)).toHaveLength(1);
  });

  test("deny is approved:false — NotAllowed, and the same call does not card the app again", async () => {
    const { policy, events } = setup({ answer: (callId, b) => b.resolve("s1", callId, false, "orb") });
    const run = newRunGrants("s1");
    await failsWith(policy.authorize(run, NOTES, { kind: "bind" }), "NotAllowed");
    await failsWith(policy.authorize(run, NOTES, { kind: "bind" }), "NotAllowed");
    expect(cards(events)).toHaveLength(1);
  });

  test("an aborted call withdraws its card", async () => {
    const { policy, events } = setup();
    const ac = new AbortController();
    const p = policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" }, ac.signal);
    await Promise.resolve();
    ac.abort();
    await failsWith(p, "NotAllowed");
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "aborted" });
  });

  test("the card pauses the script's clock while it waits (onCardWait)", async () => {
    const waits: boolean[] = [];
    const { policy } = setup({ answer: (callId, b) => b.resolve("s1", callId, true, "orb") });
    await policy.authorize(newRunGrants("s1", (w) => waits.push(w)), NOTES, { kind: "bind" });
    expect(waits).toEqual([true, false]);
  });

  test("a Dispatch child's card is bounded like every relayed card; a plain session's waits for its human", async () => {
    const child = setup({ facts: { origin: "dispatch-child", mode: "code" } });
    void child.policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" });
    await Promise.resolve();
    const c = cards(child.events)[0]!;
    expect(c.expiresAt! - c.issuedAt!).toBe(DISPATCH_CHILD_APPROVAL_TIMEOUT_MS);
    const plain = setup();
    void plain.policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" });
    await Promise.resolve();
    const p = cards(plain.events)[0]!;
    expect(p.expiresAt! - p.issuedAt!).toBeGreaterThan(24 * 3600_000);
  });
});

describe("the user's restrictions and the floors — under every policy, bypass included", () => {
  test("Don't allow: never bound", async () => {
    const { policy } = setup({ policy: "bypass", apps: { "com.apple.Notes": { access: "deny" } } });
    expect(await failsWith(policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" }), "NotAllowed")).toContain("Don't allow");
  });

  test("view only: look, never act", async () => {
    const { policy } = setup({ policy: "bypass", apps: { "com.apple.Notes": { access: "view" } } });
    const run = newRunGrants("s1");
    await policy.authorize(run, NOTES, { kind: "bind" });
    expect(await failsWith(policy.authorize(run, NOTES, { kind: "act", primitive: "click" }), "NotAllowed")).toBe("Notes is set to view only in Settings → Computer Use — you can look but not act");
  });

  test("click only: click, scroll and action pass; typing does not", async () => {
    const { policy } = setup({ policy: "bypass", apps: { "com.apple.Notes": { access: "click" } } });
    const run = newRunGrants("s1");
    for (const p of ["click", "scroll", "action"]) await policy.authorize(run, NOTES, { kind: "act", primitive: p });
    for (const p of ["type", "paste", "key", "setValue", "drag", "menu", "select"]) await failsWith(policy.authorize(run, NOTES, { kind: "act", primitive: p }), "NotAllowed");
  });

  test("an unreadable access value reads as Don't allow", async () => {
    const { policy } = setup({ policy: "bypass", apps: { "com.apple.Notes": { access: "sometimes" } } });
    expect(policy.accessFor("com.apple.Notes")).toBe("deny");
  });

  test("a password manager is Don't allow until the user says otherwise", async () => {
    const { policy, setSettings } = setup({ policy: "bypass" });
    const pm = { bundleId: "com.1password.1password", name: "1Password" };
    await failsWith(policy.authorize(newRunGrants("s1"), pm, { kind: "bind" }), "NotAllowed");
    setSettings({ computerUse: { apps: { "com.1password.1password": { access: "full" } } } } as unknown as Settings);
    await policy.authorize(newRunGrants("s1"), pm, { kind: "bind" });
  });

  test("Winter never controls itself; authentication surfaces are refused", async () => {
    const { policy } = setup({ policy: "bypass" });
    for (const id of ["com.winter.app", "com.winter.app.dev", "com.winter.computeruse", "com.winter.computeruse.dev"]) {
      await failsWith(policy.authorize(newRunGrants("s1"), { bundleId: id, name: "Winter" }, { kind: "bind" }), "Refused");
    }
    await failsWith(policy.authorize(newRunGrants("s1"), { bundleId: "com.apple.SecurityAgent", name: "SecurityAgent" }, { kind: "bind" }), "Refused");
    await failsWith(policy.authorize(newRunGrants("s1"), { bundleId: "com.apple.keychainaccess", name: "Keychain Access" }, { kind: "observe" }), "Refused");
  });

  test("whole-screen shots black out Winter and every Don't-allow app", () => {
    const { policy } = setup({ apps: { "com.apple.Notes": { access: "deny" } } });
    const ex = policy.excludedFromScreen();
    expect(ex).toContain("com.apple.Notes");
    expect(ex).toContain("com.winter.app");
    expect(ex).toContain("com.1password.1password");
  });

  test("removing Always allow forgets the session grant its card left too", async () => {
    const { policy } = setup({ answer: (callId, b) => b.resolve("s1", callId, true, "orb", "session") });
    await policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" });
    expect(policy.hasSessionGrant("s1", NOTES.bundleId)).toBe(true);
    policy.forgetGrant(NOTES.bundleId);
    expect(policy.hasSessionGrant("s1", NOTES.bundleId)).toBe(false);
  });
});

describe("the master switch and its exceptions (allowAllApps)", () => {
  const cu = (computerUse: Record<string, unknown>) => ({ computerUse } as unknown as Settings);

  test("effective access: the user's access; else removed → the switch; else the built-in default; else the switch", () => {
    for (const on of [true, false]) {
      const global = on ? "full" : "deny";
      const s = (apps: Record<string, unknown>) => cu({ allowAllApps: on, apps });
      // No row: an ordinary app follows the switch; a built-in default keeps its exception.
      expect(effectiveAppAccess(s({}), "com.apple.Notes")).toEqual({ access: global, source: "switch" });
      expect(effectiveAppAccess(s({}), "com.1password.1password")).toEqual({ access: "deny", source: "default" });
      expect(effectiveAppAccess(s({}), "com.apple.Terminal")).toEqual({ access: "click", source: "default" });
      expect(effectiveAppAccess(s({}), "com.apple.systempreferences")).toEqual({ access: "click", source: "default" });
      // The user's own access wins over both.
      expect(effectiveAppAccess(s({ "com.apple.Notes": { access: "view" } }), "com.apple.Notes")).toEqual({ access: "view", source: "user" });
      expect(effectiveAppAccess(s({ "com.apple.Terminal": { access: "full" } }), "com.apple.Terminal")).toEqual({ access: "full", source: "user" });
      // A removed default: the switch decides.
      expect(effectiveAppAccess(s({ "com.apple.Terminal": { removed: true } }), "com.apple.Terminal")).toEqual({ access: global, source: "switch" });
      // A row only for its grant does not change the access.
      expect(effectiveAppAccess(s({ "com.apple.Notes": { grant: "always" } }), "com.apple.Notes").access).toBe(global);
      expect(effectiveAppAccess(s({ "com.apple.Terminal": { grant: "always" } }), "com.apple.Terminal").access).toBe("click");
    }
    // The switch defaults ON; a bundle id shaped like a prototype key is an ordinary app.
    expect(effectiveAppAccess(null, "com.apple.Notes").access).toBe("full");
    expect(effectiveAppAccess(cu({ allowAllApps: false }), "constructor").access).toBe("deny");
    expect(effectiveAppAccess(null, "toString").access).toBe("full");
  });

  test("the built-in table: password managers deny, seven terminals and System Settings click", () => {
    const click = Object.entries(DEFAULT_APP_EXCEPTIONS).filter(([, v]) => v.access === "click").map(([id]) => id).sort();
    expect(click).toEqual(["com.apple.Terminal", "com.apple.systempreferences", "com.github.wez.wezterm", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable", "net.kovidgoyal.kitty", "org.alacritty"].sort());
    expect(Object.values(DEFAULT_APP_EXCEPTIONS).every((v) => v.access === "deny" || v.access === "click")).toBe(true);
    expect(DEFAULT_APP_EXCEPTIONS["com.apple.Passwords"]).toEqual({ access: "deny", name: "Passwords" });
  });

  test("switch OFF: an app with no exception is refused under every policy (bypass too), naming the switch; an allowing exception binds", async () => {
    const { policy } = setup({ policy: "bypass", allowAllApps: false, apps: { "com.apple.TextEdit": { access: "full" } } });
    const msg = await failsWith(policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" }), "NotAllowed");
    expect(msg).toContain("\"Allow all apps\" is off");
    await failsWith(policy.authorize(newRunGrants("s1"), NOTES, { kind: "observe" }), "NotAllowed");
    await policy.authorize(newRunGrants("s1"), { bundleId: "com.apple.TextEdit", name: "TextEdit" }, { kind: "bind" });
    // A terminal keeps its click-only default: clicks pass, typing does not.
    const term = { bundleId: "com.apple.Terminal", name: "Terminal" };
    await policy.authorize(newRunGrants("s1"), term, { kind: "act", primitive: "click" });
    expect(await failsWith(policy.authorize(newRunGrants("s1"), term, { kind: "act", primitive: "type" }), "NotAllowed")).toContain("click only");
  });

  test("an explicit deny still names the user's setting, not the switch", async () => {
    const { policy } = setup({ policy: "bypass", apps: { "com.apple.Notes": { access: "deny" } } });
    expect(await failsWith(policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" }), "NotAllowed")).toBe("Notes is set to Don't allow in Settings → Computer Use — ask the user if you need it");
  });

  test("switch ON: a terminal is click only by default and System Settings too; a removed default is full again", async () => {
    const { policy, setSettings } = setup({ policy: "bypass" });
    const term = { bundleId: "com.googlecode.iterm2", name: "iTerm" };
    await failsWith(policy.authorize(newRunGrants("s1"), term, { kind: "act", primitive: "key" }), "NotAllowed");
    await failsWith(policy.authorize(newRunGrants("s1"), { bundleId: "com.apple.systempreferences", name: "System Settings" }, { kind: "act", primitive: "setValue" }), "NotAllowed");
    setSettings(cu({ apps: { "com.googlecode.iterm2": { removed: true } } }));
    await policy.authorize(newRunGrants("s1"), term, { kind: "act", primitive: "key" });
  });

  test("the cap is checked BEFORE the grant: an Always-allow grant never lifts a switch-off deny", async () => {
    const { policy, events } = setup({ policy: "ask", allowAllApps: false, apps: { "com.apple.Notes": { grant: "always" } } });
    await failsWith(policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" }), "NotAllowed");
    expect(cards(events)).toHaveLength(0);
  });

  test("whole-screen exclusion with the switch OFF: every running app without an allowing exception, plus the floors", () => {
    const { policy } = setup({ allowAllApps: false, apps: { "com.apple.Notes": { access: "view" }, "com.apple.Terminal": { removed: true } } });
    const ex = policy.excludedFromScreen(["com.apple.Notes", "com.apple.Safari", "com.apple.Terminal", "com.googlecode.iterm2", "com.apple.finder"]);
    expect(ex).toContain("com.apple.Safari");
    expect(ex).toContain("com.apple.finder");
    expect(ex).toContain("com.apple.Terminal"); // its default removed: the switch (off) decides
    expect(ex).not.toContain("com.apple.Notes");
    expect(ex).not.toContain("com.googlecode.iterm2"); // click by default
    expect(ex).toContain("com.winter.app");
    expect(ex).toContain("com.apple.SecurityAgent");
    expect(ex).toContain("com.1password.1password");
    expect(policy.hiddenFromScreen("com.apple.Safari")).toBe(true);
    expect(policy.hiddenFromScreen("com.apple.Notes")).toBe(false);
    // Switch ON: a running app with no row is not excluded.
    const on = setup({ apps: { "com.apple.Notes": { access: "view" } } }).policy;
    expect(on.excludedFromScreen(["com.apple.Safari"])).not.toContain("com.apple.Safari");
    expect(on.hiddenFromScreen("com.apple.keychainaccess")).toBe(true);
  });
});

describe("rung 4 — the foreground", () => {
  test("ask: a second card, Allow once / Deny", async () => {
    const { policy, events } = setup({ answer: (callId, b) => b.resolve("s1", callId, true, "orb", "once") });
    expect(await policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(true);
    const c = cards(events)[0]!;
    expect(c.summary).toBe("Winter needs to bring Notes (com.apple.Notes) to the front and use your mouse for a moment");
    expect(c.options).toEqual([{ id: "once", label: "Allow once" }]);
  });

  test("declined, unattended or dont-ask: refused (the caller throws NeedsForeground)", async () => {
    expect(await setup({ answer: (c, b) => b.resolve("s1", c, false, "orb") }).policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(false);
    const unattended = setup({ attended: false });
    expect(await unattended.policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(false);
    expect(cards(unattended.events)).toHaveLength(0);
    expect(await setup({ policy: "dont-ask" }).policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(false);
  });

  test("bypass: no foreground card at all (the user ruling) — allowed at once, attended or not", async () => {
    for (const attended of [true, false]) {
      const { policy, events } = setup({ policy: "bypass", attended });
      expect(await policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(true);
      expect(cards(events)).toHaveLength(0);
    }
  });

  test("ask, accept-edits and auto keep the foreground card; plan and chat refuse it", async () => {
    for (const p of ["ask", "accept-edits", "auto"] as const) {
      const { policy, events } = setup({ policy: p, answer: (c, b, sid) => b.resolve(sid, c, true, "orb") });
      expect(await policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(true);
      expect(cards(events)).toHaveLength(1);
    }
    expect(await setup({ policy: "plan" }).policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(false);
    expect(await setup({ policy: "bypass", facts: { mode: "chat" } }).policy.allowForeground(newRunGrants("s1"), NOTES)).toBe(false);
  });

  test("persistentlyAllowed: bypass, Always allow and Allow for this session outlive the call; Allow once does not", async () => {
    expect(setup({ policy: "bypass" }).policy.persistentlyAllowed("s1", NOTES.bundleId)).toBe(true);
    expect(setup({ policy: "ask", apps: { "com.apple.Notes": { grant: "always" } } }).policy.persistentlyAllowed("s1", NOTES.bundleId)).toBe(true);
    const once = setup({ answer: (c, b, sid) => b.resolve(sid, c, true, "orb") });
    await once.policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" });
    expect(once.policy.persistentlyAllowed("s1", NOTES.bundleId)).toBe(false);
    const session = setup({ answer: (c, b, sid) => b.resolve(sid, c, true, "orb", "session") });
    await session.policy.authorize(newRunGrants("s1"), NOTES, { kind: "bind" });
    expect(session.policy.persistentlyAllowed("s1", NOTES.bundleId)).toBe(true);
  });
});
