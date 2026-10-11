// ComputerV2 Phase 2 — app adapters end to end inside the daemon: a REAL sandboxed worker runs the script, the REAL
// policy decides, the REAL helper client talks to a FAKE helper (1.8.0, answering `target.scriptingCommands`).
// Covers what a bind prints (the extras block once, the one line after, again after a compaction, a reset or a
// restart), the handle's `extras`/`dict`, `help()` topics, an extra and a dictionary command running through
// `target.applescript`, the access classes through the policy (plan, view, click, full; dont-ask, bypass), the
// fence, telemetry, and a helper too old to list dictionary commands.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewSessionEvent, SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { AppAdapters } from "../../src/computer-use/adapters";
import type { AppAdapter } from "../../src/computer-use/adapters/types";
import { HelperClient } from "../../src/computer-use/helper-client";
import { ComputerPolicy, type SessionFacts } from "../../src/computer-use/policy";
import type { ScriptingCommandsResult } from "../../src/computer-use/protocol";
import { ComputerV2Service, type ScriptResult } from "../../src/computer-use/service";
import { AutomationTelemetry } from "../../src/computer-use/telemetry";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { referenceProblems } from "./adapter-refs";
import { FakeHelper, FakeHelperError } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;

const FINDER_COMMANDS: ScriptingCommandsResult = {
  scriptable: true, bundleVersion: "1500",
  commands: [
    { name: "reveal", suite: "Finder", eventCode: "miscmvis", description: "Bring the specified object(s) into view", direct: { type: "specifier", optional: false }, params: [] },
    { name: "empty", suite: "Finder", eventCode: "fndrempt", description: "Empty the trash", direct: { type: "specifier", optional: true }, params: [{ name: "security", type: "boolean", optional: true }] },
    { name: "make", suite: "Standard", eventCode: "corecrel", params: [{ name: "new", type: "type", optional: false }, { name: "with properties", type: "record", optional: true }] },
    { name: "sort", suite: "Finder", eventCode: "DATASORT", direct: { type: "specifier", optional: false }, params: [{ name: "by", type: "property", optional: false }] },
  ],
};

/** A test adapter built only of the AX doors (find + act), the way the live suite's fixture adapter is. */
const AX_ADAPTER: AppAdapter = {
  bundleIds: ["com.apple.Notes"],
  guide: { id: "test-notes@3", text: "A test guide.\nSecond line." },
  extras: [
    {
      name: "fieldValue", access: "view", signature: "fieldValue(name: string): Promise<string | null>", summary: "the value of the named field",
      async run(scope, args) { const els = await scope.find({ name: String(args[0]) }); return els[0]?.value ?? null; },
    },
    {
      name: "press", access: "click", signature: "press(name: string): Promise<void>", summary: "presses the named button",
      async run(scope, args) { const els = await scope.find({ name: String(args[0]) }); await scope.act({ kind: "action", ref: els[0]!.ref, name: "AXPress" }); return undefined; },
    },
    {
      name: "fill", access: "click", signature: "fill(name: string, text: string): Promise<void>", summary: "WRONGLY classed: a click extra that sets a value",
      async run(scope, args) { const els = await scope.find({ name: String(args[0]) }); await scope.act({ kind: "setValue", ref: els[0]!.ref, value: String(args[1]) }); return undefined; },
    },
  ],
};

interface WorldOpts { policy?: SessionApprovalPolicy; apps?: Record<string, unknown>; helperVersion?: string; answer?: (e: Extract<NewSessionEvent, { type: "approval_requested" }>, b: ApprovalBroker) => void }

const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

function world(opts: WorldOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-cu-adapters-"));
  const fake = new FakeHelper();
  fake.helperVersion = opts.helperVersion ?? "1.8.0";
  fake.apps.push({ name: "Finder", bundleId: "com.apple.finder", pid: 600, running: true });
  fake.apps.push({ name: "Safari", bundleId: "com.apple.Safari", pid: 601, running: true });
  const scripts: string[] = [];
  let appleScriptResult: string | null = null;
  fake.handlers["target.applescript"] = (p) => { scripts.push(String(p.source)); return { result: appleScriptResult }; };
  fake.handlers["target.scriptingCommands"] = (p) => {
    const app = fake.targets.get(String(p.targetId));
    return app?.bundleId === "com.apple.finder" ? FINDER_COMMANDS : { scriptable: false, commands: [] };
  };
  // Every bind of an app returns the same target (the helper's idempotent bind).
  const bound = new Map<string, string>();
  fake.handlers["target.bind"] = (p) => {
    const app = fake.apps.find((a) => a.bundleId === p.app || a.name === p.app)!;
    const targetId = bound.get(app.bundleId) ?? `t${bound.size + 1}`;
    bound.set(app.bundleId, targetId);
    fake.targets.set(targetId, app);
    return { targetId, app: { name: app.name, bundleId: app.bundleId, pid: app.pid, path: `/Apps/${app.name}.app`, version: "15.1" }, window: { id: 7, title: "w", frame: [0, 0, 1, 1] } };
  };
  fake.handlers["target.find"] = (p) => ({ elements: [{ ref: 21, role: "text field", name: String((p.query as { name?: string }).name ?? ""), value: "hello" }] });
  const approvals = new ApprovalBroker();
  const events: NewSessionEvent[] = [];
  const settings = { computerUse: { apps: opts.apps ?? {} } } as unknown as Settings;
  const facts: SessionFacts = { policy: opts.policy ?? "bypass", mode: "code" };
  let svc!: ComputerV2Service;
  const helper = new HelperClient({
    home, profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
    onNotification: (n) => svc.handleNotification(n), onDisconnect: () => svc.helperDisconnected(),
  });
  const policy = new ComputerPolicy({
    settings: () => settings, saveAlwaysGrant: () => {}, approvals,
    emit: (_sid, e) => {
      events.push(e);
      if (e.type === "approval_requested" && opts.answer !== undefined) queueMicrotask(() => opts.answer!(e as never, approvals));
    },
    session: () => facts, attended: () => true,
  });
  const adapters = new AppAdapters({ adapters: [...AppAdaptersBuiltins(), AX_ADAPTER] });
  const telemetry = new AutomationTelemetry(home);
  svc = new ComputerV2Service({ helper, policy, settings: () => settings, telemetry, adapters });
  services.push(svc);
  const run = (code: string, o: { sessionId?: string; reset?: boolean; vision?: boolean } = {}): Promise<ScriptResult> =>
    svc.run({ sessionId: o.sessionId ?? "s1", vision: o.vision ?? true, model: "anthropic/claude-opus-5-5" }, { code, ...(o.reset === undefined ? {} : { reset: o.reset }) });
  return { home, fake, svc, run, scripts, events, adapters, telemetry, setResult: (r: string | null) => { appleScriptResult = r; } };
}

/** The built-in table without its Notes adapter (the test's own takes Notes). */
function AppAdaptersBuiltins(): AppAdapter[] {
  return [...new AppAdapters().registry.adapters].filter((a) => !a.bundleIds.includes("com.apple.Notes"));
}

const text = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
/** Where the first fenced block starts (the preamble names the tag too, but is not followed by a newline). */
const fenceStart = (r: ScriptResult): number => text(r).search(/<screen-data id="[0-9a-f]+">\n/);
/** The text OUTSIDE every screen-data fence. */
const unfenced = (r: ScriptResult): string => text(r).replace(/<screen-data id="[0-9a-f]+">[\s\S]*?<\/screen-data id="[0-9a-f]+">/g, "");
const fenced = (r: ScriptResult): string => [...text(r).matchAll(/<screen-data id="[0-9a-f]+">([\s\S]*?)<\/screen-data id="[0-9a-f]+">/g)].map((m) => m[1]).join("\n");

describe("adapters: what a bind prints", () => {
  macOnly("the first bind prints the extras block (exact shape, unfenced) before the fenced state; the handle lists extras and dict", async () => {
    const w = world();
    const r = await w.run("const f = await apps.open('Finder')\nprint(JSON.stringify(Object.keys(f.extras)), JSON.stringify(Object.keys(f.dict)))");
    expect(r.isError).toBe(false);
    const out = unfenced(r);
    expect(out).toContain([
      "Finder extras — on this app's handle: .extras.<name>(…); .help() shows them again",
      "  reveal(path: string): Promise<{ selected: boolean }> · click — shows the item's folder in the bound Finder window and selects the item, in the background",
      "  selection(): Promise<string[]> · view — POSIX paths selected in the bound Finder window (when its selection is provably that window's)",
      "  trash(paths: string | string[]): Promise<{ trashed: number }> · full — moves the items to the Trash",
      "  openWith(path: string, app: string): Promise<{ opened: string; app?: App }> · full — opens a file in another app, in the background, and binds its window",
      "Finder dictionary: 3 commands — .dict.<name>(…), run like applescript(); .help(\"dict\") lists them",
      "Guide finder@3:",
    ].join("\n"));
    // The block comes before the state, which is fenced.
    expect(fenceStart(r)).toBeGreaterThan(0);
    expect(text(r).indexOf("Finder extras —")).toBeLessThan(fenceStart(r));
    expect(fenced(r)).toContain('Finder — window "Finder window"');
    expect(fenced(r)).toContain('["reveal","selection","trash","openWith"] ["reveal","empty","make"]');
    expect(w.fake.calls("target.scriptingCommands")).toEqual([{ targetId: "t1", callId: expect.any(String) }]);
  }, 30_000);

  macOnly("a later bind prints one line; a compaction, a reset and a worker restart each bring the block back once", async () => {
    const w = world();
    await w.run("const f = await apps.open('Finder')");
    const again = await w.run("const g = await apps.open('Finder')\nprint(Object.keys(g.extras).length)");
    expect(unfenced(again)).toContain("(Finder: extras, dictionary commands and guide finder@3 were shown earlier — .help() shows them again)");
    expect(unfenced(again)).not.toContain("Guide finder@3:");
    expect(fenced(again)).toContain("4");
    // One scriptingCommands per running app (bundle id + pid), not per bind.
    expect(w.fake.calls("target.scriptingCommands")).toHaveLength(1);

    // A compaction of the main thread: the next primitive touching Finder prints the block first.
    w.adapters.observe({ type: "continuity_warning", sessionId: "s1", threadId: "main", warning: "compacted" } as unknown as SessionEvent);
    const after = await w.run("await f.state()");
    expect(unfenced(after)).toContain("Guide finder@3:");
    expect(text(after).indexOf("Guide finder@3:")).toBeLessThan(fenceStart(after));
    const once = await w.run("await f.state()");
    expect(unfenced(once)).not.toContain("Guide finder@3:");

    // A reset: bindings gone, so the next bind prints the block again.
    const reset = await w.run("const f = await apps.open('Finder')", { reset: true });
    expect(unfenced(reset)).toContain("Guide finder@3:");
    // Another session never saw it.
    const other = await w.run("const f = await apps.open('Finder')", { sessionId: "s2" });
    expect(unfenced(other)).toContain("Guide finder@3:");
  }, 30_000);

  macOnly("an app with neither an adapter nor a dictionary prints nothing more, and its handle has empty extras and dict", async () => {
    const w = world();
    const r = await w.run("const t = await apps.open('TextEdit')\nprint(Object.keys(t.extras).length, Object.keys(t.dict).length)");
    expect(unfenced(r)).not.toContain("extras —");
    expect(unfenced(r)).not.toContain("were shown earlier");
    expect(fenced(r)).toContain("0 0");
  }, 30_000);

  macOnly("a helper older than 1.8.0: no dictionary line and no scriptingCommands call; help(\"dict\") says why", async () => {
    const w = world({ helperVersion: "1.7.0" });
    const r = await w.run("const f = await apps.open('Finder')\nawait f.help('dict')");
    expect(unfenced(r)).toContain("Finder extras —");
    expect(unfenced(r)).not.toContain("Finder dictionary:");
    expect(fenced(r)).toContain("older than 1.8.0");
    expect(w.fake.calls("target.scriptingCommands")).toEqual([]);
  }, 30_000);

  macOnly("a failing scriptingCommands never fails the bind", async () => {
    const w = world();
    w.fake.handlers["target.scriptingCommands"] = () => { throw new FakeHelperError("busy", "the app did not answer"); };
    const r = await w.run("const f = await apps.open('Finder')\nprint(Object.keys(f.dict).length)");
    expect(r.isError).toBe(false);
    expect(unfenced(r)).toContain("Finder extras —");
    expect(fenced(r)).toContain("0");
  }, 30_000);
});

describe("adapters: help()", () => {
  macOnly("help() reprints the block (unfenced) and returns it; help(\"dict\") lists the commands, fenced; help(name) one extra; anything else is a TypeError", async () => {
    const w = world();
    await w.run("const f = await apps.open('Finder')");
    const all = await w.run("const h = await f.help({ emit: false })\nprint(h.split('\\n')[0])\nawait f.help()");
    expect(unfenced(all)).toContain("Guide finder@3:");
    expect(fenced(all)).toContain("Finder extras — on this app's handle");
    const dict = await w.run("await f.help('dict')");
    expect(fenced(dict)).toContain("reveal(direct: ref<specifier>) — Bring the specified object(s) into view");
    expect(fenced(dict)).toContain("empty(direct?: ref<specifier>, { security?: boolean }) — Empty the trash");
    expect(fenced(dict)).toContain("make(");
    expect(fenced(dict)).toContain("sort — use applescript() (its \"by\" parameter takes property)");
    const search = await w.run("await f.help('dict', { search: 'trash' })");
    expect(fenced(search)).toContain("empty(");
    expect(fenced(search)).not.toContain("reveal(direct");
    const one = await w.run("await f.help('trash')");
    expect(unfenced(one)).toContain("trash(paths: string | string[]): Promise<{ trashed: number }> · full — moves the items to the Trash\nFinder's delete");
    const badTopic = await w.run("await f.help('nope')");
    expect(badTopic.isError).toBe(true);
    expect(text(badTopic)).toContain("TypeError");
    expect(text(badTopic)).toContain('"reveal", "selection", "trash", "openWith"');
  }, 30_000);

  macOnly("after a compaction, help() is itself the redelivery — the block is printed once, not twice", async () => {
    const w = world();
    await w.run("const f = await apps.open('Finder')");
    w.adapters.observe({ type: "continuity_warning", sessionId: "s1", warning: "compacted" } as unknown as SessionEvent);
    const r = await w.run("await f.help()");
    expect(unfenced(r).split("Guide finder@3:").length - 1).toBe(1);
    const next = await w.run("await f.state()");
    expect(unfenced(next)).not.toContain("Guide finder@3:");
  }, 30_000);
});

describe("adapters: extras and dictionary commands", () => {
  macOnly("an extra runs Winter's own AppleScript through target.applescript; its result is data (the session is fenced from then on)", async () => {
    const w = world();
    const dir = mkdtempSync(join(tmpdir(), "winter-cu-adapters-files-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    await w.run("const f = await apps.open('Finder')");
    // The real helper answers a string in AppleScript's display form (quotes, `"` and `\\` escaped); extras get the string.
    const display = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
    w.setResult(display(`SEL:file://${dir}/a.txt\n`));
    const r0 = await w.run("const sel = await f.extras.selection()\nprint(JSON.stringify(sel))");
    expect(r0.isError).toBe(false);
    expect(fenced(r0)).toContain(JSON.stringify([file]));
    w.setResult(display("SELECTED"));
    const r = await w.run(`print(JSON.stringify(await f.extras.reveal(${JSON.stringify(file)})))`);
    expect(r.isError).toBe(false);
    expect(fenced(r)).toContain('{"selected":true}');
    expect(w.scripts[0]).toContain('tell application id "com.apple.finder"');
    expect(w.scripts[0]).toContain("repeat with i in (get selection)");
    // The BOUND window (the bind's window id 7), never Finder's front window.
    expect(w.scripts[0]).toContain('if (id of Finder window 1) is not 7 then return "NOTFRONT"');
    expect(w.scripts[0]).toContain('if insertionURL is not boundURL then return "NOTFOCUSED"');
    // Finder refuses `URL of (insertion location)` (-1728) — the live helper showed it; it must be fetched first.
    expect(w.scripts[0]).toContain("set insertionURL to URL of (get insertion location)");
    expect(w.scripts[1]).toContain(`set target of Finder window id 7 to ((POSIX file ${JSON.stringify(dir)}) as alias)`);
    expect(w.scripts[1]).toContain(`select ((POSIX file ${JSON.stringify(file)}) as alias)`);
    expect(unfenced(r)).toContain("the bound Finder window shows the item's folder, the item selected");
    const metrics = readFileSync(join(w.home, "logs", "automation-metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(metrics.filter((m) => m.primitive === "extra").map((m) => m.extra)).toEqual(["selection", "reveal"]);
    // Never the arguments.
    expect(JSON.stringify(metrics)).not.toContain("a.txt");
  }, 30_000);

  macOnly("a dictionary command is run like applescript(): its result printed (fenced) and returned", async () => {
    const w = world();
    await w.run("const f = await apps.open('Finder')");
    w.setResult("folder \"x\"");
    const r = await w.run("const res = await f.dict.reveal({ file: '/tmp' })\nprint(res.result === 'folder \"x\"')\nawait f.dict.empty({ security: false })");
    expect(r.isError).toBe(false);
    expect(w.scripts).toEqual([
      'tell application id "com.apple.finder"\nreveal (POSIX file "/tmp")\nend tell',
      'tell application id "com.apple.finder"\nempty security false\nend tell',
    ]);
    expect(fenced(r)).toContain('folder "x"');
    expect(fenced(r)).toContain("true");
    const metrics = readFileSync(join(w.home, "logs", "automation-metrics.jsonl"), "utf8");
    expect(metrics).toContain('"extra":"reveal"');
  }, 30_000);

  macOnly("bad arguments are TypeErrors before anything runs; an unsafe { ref } never reaches the helper", async () => {
    const w = world();
    await w.run("const f = await apps.open('Finder')");
    const r = await w.run("await f.dict.reveal({ ref: 'application \"Terminal\"' })");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("TypeError");
    const r2 = await w.run("await f.extras.trash('relative/path')");
    expect(text(r2)).toContain("absolute");
    expect(w.scripts).toEqual([]);
  }, 30_000);

  test("a forged call (a name the handle never listed, or no adapter at all) is refused by the daemon", async () => {
    // The worker is untrusted: the daemon checks the name again, whatever the bridge says.
    const adapters = new AppAdapters();
    const t = { targetId: "t9", bundleId: "com.apple.finder", name: "Finder", pid: 1 };
    const scope = {
      sessionId: "s1", callId: "c1", signal: new AbortController().signal, primitive: "extra", metric: { ts: 0, sessionId: "s1", callId: "c1", primitive: "extra", ms: 0, helperMs: 0 },
      privatePath: true, helperVersion: () => "1.8.0", helper: async () => FINDER_COMMANDS as never, authorize: async () => {},
      applescript: async () => ({ result: null }), openDocument: async () => { throw new Error("no"); },
      builder: { text: () => {}, daemonLine: () => {}, guide: () => {}, notice: () => {}, markScreenRead: () => {} },
      clampWait: (ms: number) => ms, acted: () => {}, log: () => {},
    };
    await expect(adapters.primitive(scope, t, "extra", { name: "nope", args: [] })).rejects.toThrow('Finder has no extra "nope"');
    await expect(adapters.primitive(scope, t, "dict", { name: "deleteEverything", args: [] })).rejects.toThrow('no dictionary command "deleteEverything"');
    await expect(adapters.primitive(scope, t, "extra", { name: "reveal", args: "x" })).rejects.toThrow("positional");
    await expect(adapters.primitive(scope, { ...t, targetId: "t10", bundleId: "com.example.none", name: "Other" }, "extra", { name: "reveal", args: [] })).rejects.toThrow("Other has no extra");
  });

  macOnly("AX-backed extras: find + act on the bound target, held to the extra's class (a click extra cannot set a value)", async () => {
    const w = world();
    const r = await w.run("const n = await apps.open('Notes')\nprint(await n.extras.fieldValue('Title'))\nawait n.extras.press('Save')");
    expect(r.isError).toBe(false);
    expect(fenced(r)).toContain("hello");
    expect(w.fake.calls("target.act")[0]).toMatchObject({ targetId: "t1", action: { kind: "action", ref: 21, name: "AXPress" }, access: "click", allowForeground: false });
    expect(unfenced(r)).toContain("Guide test-notes@3:\nA test guide.\nSecond line.");
    const wrong = await w.run("await n.extras.fill('Title', 'x')");
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("NotAllowed");
    expect(text(wrong)).toContain("this click extra cannot setValue");
    expect(w.fake.calls("target.act")).toHaveLength(1);
  }, 30_000);
});

describe("adapters: access classes through a script", () => {
  macOnly("a click-only Finder: reveal and selection run, trash and every dictionary command are NotAllowed naming them", async () => {
    const w = world({ apps: { "com.apple.finder": { access: "click" } } });
    const dir = mkdtempSync(join(tmpdir(), "winter-cu-adapters-click-"));
    const file = join(dir, "b.txt");
    writeFileSync(file, "x");
    const ok = await w.run(`const f = await apps.open('Finder')\nawait f.extras.reveal(${JSON.stringify(file)})\nawait f.extras.selection()`);
    expect(ok.isError).toBe(false);
    const trash = await w.run(`await f.extras.trash(${JSON.stringify(file)})`);
    expect(text(trash)).toContain("NotAllowed");
    expect(text(trash)).toContain("extras.trash does not");
    const dict = await w.run("await f.dict.reveal({ file: '/tmp' })");
    expect(text(dict)).toContain("dict.reveal does not");
    expect(w.scripts).toHaveLength(2);
  }, 30_000);

  macOnly("a view-only Finder: only view extras; plan: the bind card, then view extras only", async () => {
    const v = world({ apps: { "com.apple.finder": { access: "view" } } });
    expect((await v.run("const f = await apps.open('Finder')\nawait f.extras.selection()")).isError).toBe(false);
    expect(text(await v.run("await f.extras.reveal('/tmp')"))).toContain("view only");
    const p = world({ policy: "plan", answer: (e, b) => b.resolve(e.sessionId, e.callId, true, "orb", "session") });
    expect((await p.run("const f = await apps.open('Finder')\nawait f.extras.selection()\nawait f.help('dict')")).isError).toBe(false);
    expect(p.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
    expect(text(await p.run("await f.dict.empty()"))).toContain("plan mode");
  }, 30_000);

  macOnly("dont-ask: only an Always-allowed app; bypass: no card at all", async () => {
    const d = world({ policy: "dont-ask" });
    expect(text(await d.run("const f = await apps.open('Finder')"))).toContain("NotAllowed");
    const da = world({ policy: "dont-ask", apps: { "com.apple.finder": { grant: "always" } } });
    expect((await da.run("const f = await apps.open('Finder')\nawait f.dict.empty()")).isError).toBe(false);
    const b = world({ policy: "bypass" });
    expect((await b.run("const f = await apps.open('Finder')\nawait f.dict.empty()")).isError).toBe(false);
    expect(b.events.filter((e) => e.type === "approval_requested")).toHaveLength(0);
  }, 30_000);
});

describe("adapters: browser extras act on the BOUND window, never the front one", () => {
  // A Safari with two windows: the user's (108001) in FRONT, and the bound one (108006). The fake runs a script the way
  // Safari would: by the window it names — `window id N` — and records which window each script touched.
  function safariWorld(opts: { bindWindowId?: number | null } = {}) {
    const w = world();
    const touched: string[] = [];
    let current = "file:///bound/page.html";
    w.fake.handlers["target.bind"] = (p) => {
      const app = w.fake.apps.find((a) => a.bundleId === p.app || a.name === p.app)!;
      w.fake.targets.set("t1", app);
      const id = opts.bindWindowId === undefined ? 108006 : opts.bindWindowId;
      return { targetId: "t1", app: { name: app.name, bundleId: app.bundleId, pid: app.pid, version: "26.0" }, window: { ...(id === null ? {} : { id }), title: "Bound", frame: [0, 0, 800, 600] } };
    };
    w.fake.handlers["target.useWindow"] = (p) => ({ window: { id: Number(p.window), title: "Other", frame: [0, 0, 1, 1] } });
    w.fake.handlers["target.applescript"] = (p) => {
      const src = String(p.source);
      w.scripts.push(src);
      // The POSITIVE check: a script whose window/document/tab references are not all the window it names (the bound one)
      // would reach some other window — here, the user's in front.
      const named = /exists window id (\d+)/.exec(src);
      if (named === null || referenceProblems(src, Number(named[1])).length > 0) { touched.push("UNBOUND (the user's window)"); return { result: "file:///users/own/page.html" }; }
      const m = named;
      if (m === null) return { result: null };
      const id = Number(m[1]);
      if (id !== 108006 && id !== 108007) return { result: "NOWINDOW" };
      touched.push(String(id));
      if (src.includes("make new tab")) return { result: "TAB:3" };
      if (src.includes("URL of ct")) return { result: `URL:${current}` };
      return { result: "1\ttrue\tfile:///bound/page.html\tBound page\n" };
    };
    return { ...w, touched, setCurrent: (u: string) => { current = u; } };
  }

  macOnly("with the user's window in front, every Safari extra names the bound window — and follows a useWindow", async () => {
    const w = safariWorld();
    const r = await w.run(`const sf = await apps.open("Safari")
print(await sf.extras.currentURL())
print(JSON.stringify(await sf.extras.tabs()))
await sf.extras.pageText()
print(JSON.stringify(await sf.extras.openURL("https://example.com/x")))`);
    expect(r.isError).toBe(false);
    expect(w.touched).toEqual(["108006", "108006", "108006", "108006"]);
    expect(fenced(r)).toContain("file:///bound/page.html");
    expect(fenced(r)).not.toContain("users/own");
    for (const src of w.scripts) {
      expect(src).toContain("window id 108006");
      expect(src).not.toMatch(/front window|front document|document 1/);
    }
    // The bound window changes with useWindow: the next extra names the new one.
    await w.run("await sf.useWindow(108007)\nawait sf.extras.currentURL()");
    expect(w.touched.at(-1)).toBe("108007");
    expect(w.scripts.at(-1)).toContain("window id 108007");
  }, 30_000);

  macOnly("a bound window Safari can't resolve is NoWindow (nothing falls back to the front window)", async () => {
    const w = safariWorld();
    await w.run('const sf = await apps.open("Safari")');
    const r = await w.run("await sf.useWindow(5)\nawait sf.extras.openURL('https://example.com/y')");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("NoWindow");
    expect(text(r)).toContain("Safari has no window with the bound window's id");
    // No window was touched: the bound id resolved to nothing, so the script stopped before any tab was made.
    expect(w.touched).toEqual([]);
    expect(w.scripts.at(-1)!.indexOf('return "NOWINDOW"')).toBeLessThan(w.scripts.at(-1)!.indexOf("make new tab"));
  }, 30_000);

  macOnly("a bind whose window id the helper did not give: NoWindow, and no AppleScript runs at all", async () => {
    const w = safariWorld({ bindWindowId: null });
    const r = await w.run('const sf = await apps.open("Safari")\nawait sf.extras.currentURL()');
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/NoWindow( \(line \d+\))?: Winter doesn't know which Safari window is bound/);
    expect(w.scripts).toEqual([]);
  }, 30_000);
});

describe("adapters: openWith hands back the opener's window as an App", () => {
  macOnly("Finder's openWith binds the opener's window and returns it as a handle the script can use", async () => {
    const w = world();
    const dir = mkdtempSync(join(tmpdir(), "winter-cu-adapters-open-"));
    const file = join(dir, "note.txt");
    writeFileSync(file, "x");
    w.fake.handlers["apps.defaultOpener"] = () => ({ bundleId: "com.apple.TextEdit", name: "TextEdit", path: "/System/Applications/TextEdit.app" });
    w.fake.handlers["apps.openDocument"] = () => ({ app: { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 502 }, windowID: 7 });
    await w.run("const f = await apps.open('Finder')");
    const r = await w.run(`const o = await f.extras.openWith(${JSON.stringify(file)}, "TextEdit")
print(o.opened, String(o.app), o.app instanceof App, o.app.bundleId)
await o.app.state()`);
    expect(r.isError).toBe(false);
    expect(fenced(r)).toContain("TextEdit [App TextEdit] true com.apple.TextEdit");
    // The handle works: its state() reached the opener's bound target.
    const binds = w.fake.calls("target.bind").filter((c) => c.app === "com.apple.TextEdit");
    expect(binds.length).toBe(1);
    expect(w.fake.calls("target.snapshot").at(-1)).toMatchObject({ targetId: "t2" });
  }, 30_000);
});
