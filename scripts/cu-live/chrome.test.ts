// The live suite's `chrome` group without a screen: the launch never names the user's Chrome or its default profile,
// the rig's parsing, the probes' verdicts — and every script RUN against a scripted stand-in of the browser, its
// facts then judged by the scenario's own checks (what passes, and the round-13 silent no-op that must fail).
import { describe, expect, test } from "bun:test";
import {
  CFT_BUNDLE, CHROME_PRELUDE, CHROME_SCENARIOS, chromeLaunchArgs, chromePidFrom, describeChromePlan, keyVerdict, localStateFor, needsChrome, pageEventsSince,
  parseDevToolsActivePort, runningChromeForTesting, saysNothingHappened, stepOutput, type ChromeObservation, type PageEvent,
} from "./chrome";
import { markerFacts } from "./lib";
import { scriptOf, type ImageStats, type VerifyContext } from "./scenarios";

const APP = "/Users/u/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app";
const byName = (name: string) => CHROME_SCENARIOS.find((s) => s.name.includes(name))!;
const failing = (checks: Array<{ name: string; ok: boolean }>): string[] => checks.filter((c) => !c.ok).map((c) => c.name);

/** A scripted browser bound as an app: `find` answers from `els`, acts call `on`, every act's printed line is `said`. */
function fakeApp(els: Array<{ ref: number; role: string; name: string; value?: string; states?: string[] }>, on: (what: string, ...a: unknown[]) => string | void) {
  const out: string[] = [];
  const act = (what: string) => async (...a: unknown[]) => {
    const said = on(what, ...a);
    if (typeof said !== "string") return;
    const thrown = /^throw (\w+): ([\s\S]*)$/.exec(said);
    if (thrown !== null) {
      // An error class of that name, as the worker's typed errors are (`e.constructor.name`).
      const Kind = { [thrown[1]!]: class extends Error {} }[thrown[1]!]!;
      throw new Kind(thrown[2]);
    }
    out.push(said);
  };
  const app = {
    name: "Google Chrome for Testing", bundleId: CFT_BUNDLE,
    // (The page's web area is there: `webReady` returns at once.)
    state: async () => `[0] web area "Material Probe" · Select file\n` + els.map((e) => `[${e.ref}] ${e.role} "${e.name}"${e.value ? ` value="${e.value}"` : ""}`).join("\n"),
    find: async (q: string | { role?: string; name?: string }) => els.filter((e) => typeof q === "string" ? e.name.includes(q) : (q.role === undefined || e.role === q.role) && (q.name === undefined || e.name === q.name)),
    click: act("click"), key: act("key"), setValue: act("setValue"), action: act("action"),
    windows: async () => [{ id: 1, title: "Material Probe", focused: true }],
    screenshot: async () => ({}),
  };
  return { app, out };
}

/** Runs a script against a fake; the fake's own act lines land in the output in order, as the runtime prints them. */
async function runScript(code: string, app: { out: string[] } | unknown): Promise<string> {
  const lines: string[] = (app as { out?: string[] }).out ?? [];
  const print = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const apps = { open: async () => (app as { app?: unknown }).app ?? app };
  const fn = new Function("apps", "screen", "print", "sleep", "show", `return (async () => {${code}})`)(apps, {}, print, async () => {}, () => {}) as () => Promise<void>;
  await fn();
  return lines.join("\n");
}

const ctxOf = (output: string, page: PageEvent[], over: Partial<VerifyContext> = {}): VerifyContext => ({
  output, isError: false, facts: markerFacts(output), events: [], since: 0, probe: [], metrics: [], shots: [], page, ...over,
});

describe("the chrome group: launch and rig", () => {
  test("a launch is always a temp profile with a mock keychain — never the default profile", () => {
    const args = chromeLaunchArgs({ key: "material", lang: "en", start: "material" }, "/tmp/run/cft-1", "http://127.0.0.1:5555/material.html");
    expect(args[0]).toBe("--user-data-dir=/tmp/run/cft-1");
    expect(args).toContain("--use-mock-keychain");
    expect(args).toContain("--password-store=basic");
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--disable-features=MediaRouter");
    expect(args.at(-1)).toBe("http://127.0.0.1:5555/material.html");
    expect(chromeLaunchArgs({ key: "fr", lang: "fr", start: "inspect" }, "/tmp/p", "x").at(-1)).toBe("chrome://inspect/#remote-debugging");
    expect(localStateFor({ key: "d", lang: "fr", start: "material", remoteDebugging: true })).toEqual({ devtools: { remote_debugging: { "user-enabled": true } } });
    expect(localStateFor({ key: "m", lang: "en", start: "material" })).toBeUndefined();
  });

  test("DevToolsActivePort, the instance's pid, and any Chrome for Testing already running", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/f1f8d164-360f-4126-93bf-6b3d8ad3c253")).toEqual({ port: 9222, path: "/devtools/browser/f1f8d164-360f-4126-93bf-6b3d8ad3c253" });
    expect(parseDevToolsActivePort("x\n/devtools/browser/1")).toBeUndefined();
    expect(parseDevToolsActivePort("9222\n")).toBeUndefined();
    const ps = [
      `  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/run/cft-1`,
      `  202 ${APP}/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/run/cft-1 --no-first-run`,
      `  203 ${APP}/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/156/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=/tmp/run/cft-1`,
      `  304 /other/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless=new`,
    ].join("\n");
    expect(chromePidFrom(ps, APP, "/tmp/run/cft-1")).toBe(202);
    expect(chromePidFrom(ps, APP, "/tmp/run/cft-2")).toBeUndefined();
    // The user's Chrome is never counted; helpers are not main processes.
    expect(runningChromeForTesting(ps)).toEqual([202, 304]);
    expect(runningChromeForTesting("  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toEqual([]);
  });

  test("the page's events since a time (by the runner's receipt)", () => {
    const ev: PageEvent[] = [{ t: 5, at: 10, ev: "a" }, { t: 20, at: 21, ev: "b" }, { t: 30, ev: "c" }];
    expect(pageEventsSince(ev, 15).map((e) => e.ev)).toEqual(["b", "c"]);
  });

  test("the plan says what it launches, what it changes and puts back", () => {
    const plan = describeChromePlan(APP).join("\n");
    expect(plan).toContain("--user-data-dir=<run temp>");
    expect(plan).toContain("AppleLanguages");
    expect(plan).toContain("deleted again");
    expect(describeChromePlan(undefined)[0]).toContain("NOT found");
  });
});

describe("the chrome group: scenarios", () => {
  test("every row needs a browser, carries the chrome prelude, compiles, and never binds the user's Chrome", () => {
    expect(CHROME_SCENARIOS.length).toBe(12);
    for (const s of CHROME_SCENARIOS) {
      expect(needsChrome(s)).toBe(true);
      expect(s.group).toBe("chrome");
      expect(s.name.startsWith("chrome")).toBe(true);
      expect(s.prelude).toContain(CHROME_PRELUDE.trim().slice(0, 40));
      expect(() => new Function("apps", "screen", "print", "sleep", "show", `return (async () => {${scriptOf(s)}})`)).not.toThrow();
      for (const step of s.prepare ?? []) if ("turn" in step) expect(() => new Function(`return (async () => {${step.turn}})`)).not.toThrow();
      expect(`${s.code}${JSON.stringify(s.prepare ?? [])}`).not.toMatch(/com\.google\.Chrome\b|"Google Chrome"/);
    }
    // A fresh instance whenever the need changes: the French ones and the off-desktop one never reuse the English page's.
    expect(new Set(CHROME_SCENARIOS.map((s) => s.chrome!.key))).toEqual(new Set(["material-background", "material-noocclusion", "material-shown", "material-bound-shown", "material-offspace", "fr-inspect", "fr-dialog"]));
    // The probes run on the instance shown in front once; the diagnostics compare the ways of launching.
    expect(byName("mat-select").chrome).toMatchObject({ key: "material-bound-shown", bindThenShow: true });
    expect(byName("--disable-backgrounding").chrome!.extraArgs).toEqual(["--disable-backgrounding-occluded-windows"]);
    expect(chromeLaunchArgs(byName("--disable-backgrounding").chrome!, "/p", "u")).toContain("--disable-backgrounding-occluded-windows");
    expect(byName("Autoriser").chrome).toEqual({ key: "fr-dialog", lang: "fr", start: "material", remoteDebugging: true });
  });

  test("the helper's honest key notes are recognised; a plain 'pressed' is not one", () => {
    for (const s of [
      "the keyboard focus did not move after tab (the page may not have taken the key) — click the field you mean, or pass { into }",
      "the focused check box did not change after space (the page may not have taken the key) — click(ref) presses it",
      "the selection did not change after cmd+a (the field holds 20 characters; the page may not have taken the key) — setValue(ref, text) replaces a field's text",
    ]) expect(saysNothingHappened(s)).toBe(true);
    expect(saysNothingHappened("pressed tab in Google Chrome for Testing")).toBe(false);
    expect(keyVerdict(true, "pressed tab").ok).toBe(true);
    expect(keyVerdict(false, "the focus did not move after tab (the page may not have taken the key)").ok).toBe(true);
    expect(keyVerdict(false, "pressed tab").ok).toBe(false);          // the round-13 bug
    expect(keyVerdict(true, "the page may not have taken the key").ok).toBe(false);
    expect(stepOutput("=== a\none\n=== b\ntwo\nthree\n=== end\n", "b")).toBe("two\nthree\n");
    expect(stepOutput("=== a\none", "a")).toBe("one");
    expect(stepOutput("nothing", "a")).toBe("");
  });

  test("Tab / Space / cmd+a: run against a browser that works — passes; one that ignores the keys silently — fails; one that says so — passes", async () => {
    const s = byName("Tab, Space and cmd+a");
    const els = [{ ref: 7, role: "text field", name: "Title" }, { ref: 9, role: "check box", name: "Accept the terms" }];
    const works = fakeApp(els, (what, combo) => what === "key" ? `pressed ${String(combo)}` : undefined);
    const out = await runScript(scriptOf(s), works);
    const page: PageEvent[] = [{ t: 1, ev: "focus", id: "title" }, { t: 2, ev: "focus", id: "subtitle" }, { t: 3, ev: "check", id: "terms", checked: false }, { t: 4, ev: "selection", id: "title", start: 0, end: 20, length: 20 }];
    expect(failing(s.verify(ctxOf(out, page)))).toEqual([]);
    // Silent: "ok" and nothing in the page — every key row fails.
    expect(failing(s.verify(ctxOf(out, [])))).toHaveLength(3);
    // Honest: nothing in the page, and each answer says so.
    const honest = fakeApp(els, (what, combo) => what === "key" ? `pressed ${String(combo)} — the page may not have taken the key` : undefined);
    expect(failing(s.verify(ctxOf(await runScript(scriptOf(s), honest), [])))).toEqual([]);
  });

  test("mat-select: the exact option, refusals naming the options, the open list read", async () => {
    const s = byName("mat-select");
    let size = "Medium";
    const els = [{ ref: 3, role: "combo box", name: "Size", get value() { return size; } }] as Array<{ ref: number; role: string; name: string; value?: string }>;
    const opts = ["Small", "Extra Small", "Medium", "Large", "Extra Large"].map((name, i) => ({ ref: 20 + i, role: "option", name }));
    const browser = fakeApp([...els, ...opts], (what, ref, value) => {
      if (what === "setValue" && value === "Small") { size = "Small"; return "set"; }
      if (what === "setValue") return `throw invalid_params: no option of [3] is “${String(value)}” — its options: Small, Extra Small, Medium, Large, Extra Large`;
      if (what === "click" && ref === 23) { size = "Large"; return "clicked"; }
      return "clicked";
    });
    const out = await runScript(scriptOf(s), browser);
    const page: PageEvent[] = [{ t: 1, ev: "select.value", id: "size", value: "Small" }, { t: 2, ev: "select.value", id: "size", value: "Large" }];
    expect(failing(s.verify(ctxOf(out, page)))).toEqual([]);
    // The H1 bug: "Small" chose "Extra Small".
    expect(failing(s.verify(ctxOf(out, [{ t: 1, ev: "select.value", id: "size", value: "Extra Small" }, ...page.slice(1)])))).toContain("the PAGE chose Small (never Extra Small) first");
  });

  test("check boxes and radios: ticked in the page AND reported checked", async () => {
    const s = byName("check boxes and radios");
    const checked = new Set<number>();
    const els = [[1, "check box", "Accept the terms"], [2, "check box", "Notify me"], [3, "check box", "Mature content"], [4, "radio button", "Unlisted"]].map(([ref, role, name]) => ({
      ref: ref as number, role: role as string, name: name as string, get states() { return checked.has(ref as number) ? ["checked"] : []; },
    }));
    const browser = fakeApp(els, (what, ref) => { if (what === "click") { checked.add(ref as number); return "clicked"; } return undefined; });
    const out = await runScript(scriptOf(s), browser);
    const page: PageEvent[] = ["terms", "notify", "mature", "vis-unlisted"].map((id, i) => ({ t: i, ev: "check", id, checked: true }));
    expect(failing(s.verify(ctxOf(out, page)))).toEqual([]);
    // A press that "worked" but the page never ticked (the round-13 finding).
    expect(failing(s.verify(ctxOf(out, page.slice(1))))).toEqual(["terms: the PAGE ticked it"]);
  });

  test("Select file: a click that opens nothing must name key(\"return\", { into }); a silent one fails", async () => {
    const s = byName("Select file");
    const els = [{ ref: 11, role: "button", name: "Select file" }];
    const honest = fakeApp(els, (what) => what === "click" ? "clicked — a page button that opens a file chooser or another system picker may need real keyboard input — once [11] holds the keyboard focus, key(\"return\", { into: 11 }) sends it one" : "pressed");
    const out = await runScript(scriptOf(s), honest);
    const page: PageEvent[] = [{ t: 1, ev: "button", id: "select-file" }];
    const fails = failing(s.verify(ctxOf(out, page)));
    // The fake never opens a chooser, so only the "return opened it" row fails here; the click's own answer passes.
    expect(fails).toEqual(["if the click did not open it, key(\"return\", { into }) did"]);
    const silent = fakeApp(els, () => "clicked");
    expect(failing(s.verify(ctxOf(await runScript(scriptOf(s), silent), page)))).toContain("the click opened the chooser, or its answer names key(\"return\", { into })");
  });

  test("off-desktop redraw: a fresh picture passes, a stale one passes only when it says so", async () => {
    const s = byName("off-desktop");
    const els = [{ ref: 5, role: "button", name: "Paint" }];
    const shot = (sentinel: number): ImageStats => ({ file: "x", width: 800, height: 600, stddevLuma: 30, blank: false, sentinelPixels: sentinel });
    const plain = fakeApp(els, () => undefined);
    const bindLine = "Google Chrome for Testing — Material Probe (on another desktop: worked from here)\n";
    const out = bindLine + await runScript(scriptOf(s), plain);
    const painted: PageEvent[] = [{ t: 1, ev: "paint" }];
    expect(failing(s.verify(ctxOf(out, painted, { shots: [shot(0), shot(40_000), shot(40_000)] })))).toEqual([]);
    // Stale and silent: the subject's failure.
    expect(failing(s.verify(ctxOf(out, painted, { shots: [shot(0), shot(0), shot(40_000)] })))).toContain(
      "the picture right AFTER the click shows the result, or says it may predate the action and names screenshot({ live: true })");
    // Stale and said.
    const said = out.replace("=== after\n", "=== after\nscreenshot — this picture may predate the last action: Google Chrome for Testing may not redraw a window on another desktop until it is seen; screenshot({ live: true, reason }) shows it now\n");
    expect(failing(s.verify(ctxOf(said, painted, { shots: [shot(0), shot(0), shot(40_000)] })))).toEqual([]);
  });

  test("Floor F in French: refusals pass; an act that went through, or remote debugging on, fails", async () => {
    const inspect = byName("chrome://inspect");
    const refusal = "throw Refused: Winter never turns on or approves remote debugging in a browser — it would give any app on this Mac full control of the browser and its sign-ins. Ask the user to do it if they really want it.";
    /** The browser in French on chrome://inspect once the address is typed: its page's elements under its web area. */
    const inspectBrowser = (acts: (what: string, into?: unknown) => string | void) => {
      const fake = fakeApp([{ ref: 11, role: "text field", name: "Barre d'adresse et de recherche" }], (what, _a, b) => acts(what, what === "key" ? (b as { into?: unknown } | undefined)?.into : _a));
      fake.app.state = async () => [
        `Google Chrome for Testing — window "Inspect with Chrome Developer Tools" · state 3`,
        `[1] window "Inspect with Chrome Developer Tools"`,
        `  [10] web area "Inspect with Chrome Developer Tools"`,
        `    [12] heading "Remote debugging"`,
        `    [13] check box "Allow remote debugging for this browser instance"`,
        `  [40] close button`,
      ].join("\n");
      return fake;
    };
    const floor = (what: string) => (what === "setValue" || what === "key-into") ? "done" : refusal;
    const obs: ChromeObservation = { lang: "fr", profile: "/tmp/p", devToolsActivePort: false };
    const out = await runScript(scriptOf(inspect), inspectBrowser((what, into) => floor(what === "key" && into !== undefined ? "key-into" : what)));
    expect(out).toContain("Allow remote debugging for this browser instance");
    expect(failing(inspect.verify(ctxOf(out, [], { chrome: obs })))).toEqual([]);
    // The floor open: the click and the key went through, and remote debugging came on.
    const through = await runScript(scriptOf(inspect), inspectBrowser(() => "done"));
    expect(failing(inspect.verify(ctxOf(through, [], { chrome: { ...obs, devToolsActivePort: true } })))).toHaveLength(3);

    const dialog = byName("Autoriser");
    const dEls = [{ ref: 2, role: "button", name: "Autoriser" }, { ref: 3, role: "button", name: "Paint" }];
    const dOut = await runScript(scriptOf(dialog), fakeApp(dEls, () => refusal));
    const raised: ChromeObservation = { lang: "fr", profile: "/tmp/p", devToolsActivePort: true, dialogRaised: true, connectionAnswered: false };
    expect(failing(dialog.verify(ctxOf(dOut, [], { chrome: raised })))).toEqual([]);
    expect(failing(dialog.verify(ctxOf(dOut, [], { chrome: { ...raised, dialogRaised: false } })))).toEqual(["the runner raised the dialog (remote debugging on, a client connected)"]);
    expect(failing(dialog.verify(ctxOf(dOut, [{ t: 1, ev: "paint" }], { chrome: { ...raised, connectionAnswered: true } })))).toHaveLength(2);
  });
});
