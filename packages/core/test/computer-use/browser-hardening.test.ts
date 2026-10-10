// The browser engine's hardening (the Phase 2 review's findings), each pinned over FAKE backends that enforce the CDP
// allowlist and the world rules: native pickers, a hostile page's oversized answers, the site floor on where a tab
// landed, redaction, the release sequence, holds, staged uploads, cancellation mid-input, clipboard keys, world
// identity, orphans, paste into frames, dialogs, bare hosts, idle detaches.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserEngine, checkTabUrl, HOLDS_GLOBAL, HOLDS_PER_SESSION } from "../../src/computer-use/browser/engine";
import { browserForBundleId, familyForBundleId, familyInfo, familyName, familyOfBackendId } from "../../src/computer-use/browser/families";
import { parseCombo } from "../../src/computer-use/browser/input";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import { checkUploadFiles, stageUploads, uploadStagingRoot } from "../../src/computer-use/browser/upload-paths";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import { FakeCdpTransport, type FakePage } from "./browser-fake-transport";
import { harness } from "./browser-harness";

async function failure(p: Promise<unknown>): Promise<AutomationFailure | Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}
const kind = (e: Error): string | undefined => (e as AutomationFailure).kind;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const FORM: FakePage = {
  url: "https://form.example/", title: "Form",
  nodes: [{
    id: 1, role: "main", children: [
      { id: 2, role: "text field", name: "Name", value: "", showEmptyValue: true },
      { id: 9, role: "pop-up button", name: "Country", value: "France" },
      { id: 10, role: "date field", name: "Arrival", value: "" },
      { id: 11, role: "color well", name: "Colour", value: "#000000" },
      { id: 12, role: "button", name: "Send" },
    ],
  }],
  editable: [2],
  pickers: { 9: "a pop-up menu", 10: "a date picker", 11: "a color picker" },
};

describe("H1: native pickers are never opened", () => {
  test("click, drag, type and key on a <select>, a date or a color input are Refused naming setValue; nothing is pressed", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    const before = h.winter.sent.length;
    const select = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: 3 }));
    expect(kind(select)).toBe("Refused");
    expect(select.message).toBe("[3] opens a pop-up menu when pressed or keyed — use setValue(ref, value) instead");
    const date = await failure(h.engine.primitive(r.scope, t.targetId, "type", { text: "2026-10-10", into: 4 }));
    expect(kind(date)).toBe("Refused");
    expect(date.message).toContain("opens a date picker");
    const color = await failure(h.engine.primitive(r.scope, t.targetId, "key", { combo: "space", into: 5 }));
    expect(kind(color)).toBe("Refused");
    expect(color.message).toContain("opens a color picker");
    const drag = await failure(h.engine.primitive(r.scope, t.targetId, "drag", { from: 6, to: 3 }));
    expect(kind(drag)).toBe("Refused");
    const sentSince = h.winter.sent.slice(before);
    expect(sentSince.some((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed")).toBe(false);
    expect(sentSince.some((s) => s.method === "Input.dispatchKeyEvent")).toBe(false);
    // setValue is the way: it sets the value with no input event.
    await h.engine.primitive(r.scope, t.targetId, "setValue", { ref: 3, value: "Japan" });
    await h.engine.primitive(r.scope, t.targetId, "setValue", { ref: 4, value: "2026-10-10" });
    const s = await h.engine.primitive(r.scope, t.targetId, "state", { full: true }) as string;
    expect(s).toContain('[3] pop-up button "Country" value="Japan"');
    // An ordinary button still clicks.
    await h.engine.primitive(r.scope, t.targetId, "click", { target: 6 });
  });

  test("a pixel click on a picker is Refused too (the point is hit-tested first); the focused picker refuses keys with no into", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = { ...FORM, focused: 10 };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    const img = await h.engine.primitive(r.scope, t.targetId, "screenshot", {}) as { width: number; height: number };
    // The fake places element n at (10n, 5n) CSS px: the select (id 9) at (90, 45).
    const px = [90 * img.width / 1200, 45 * img.height / 800];
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: px }));
    expect(kind(e)).toBe("Refused");
    expect(e.message).toBe("that control opens a pop-up menu when pressed or keyed — use setValue(ref, value) instead");
    const k = await failure(h.engine.primitive(r.scope, t.targetId, "key", { combo: "down" }));
    expect(kind(k)).toBe("Refused");
    expect(k.message).toContain("opens a date picker");
    expect(h.winter.sent.some((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed")).toBe(false);
  });
});

describe("H1 (B-app's notes): file inputs, right-clicks, and the editing keys' macOS commands", () => {
  test("a file input refuses a press, naming upload()", async () => {
    const h = harness();
    h.winter.pages["https://f.example/"] = { url: "https://f.example/", title: "F", nodes: [{ id: 8, role: "file input", name: "File" }], fileInputs: [8], pickers: { 8: "a file chooser" } };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://f.example/" }) as TabHandle;
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: 1 }));
    expect(kind(e)).toBe("Refused");
    expect(e.message).toBe("[1] opens a file chooser when pressed or keyed — use upload(ref, paths) instead");
  });

  test("a right-click asks the element's frame to stop the browser's own context menu; a left click does not", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    const pointArgs = (): Array<Record<string, unknown>> => h.winter.sent
      .filter((s) => s.method === "Runtime.callFunctionOn" && (s.params.arguments as Array<{ value: unknown }>)[0]!.value === "point")
      .map((s) => (s.params.arguments as Array<{ value: Record<string, unknown> }>)[1]!.value);
    await h.engine.primitive(r.scope, t.targetId, "click", { target: 6 });
    expect(pointArgs().pop()!.guardMenu).toBeUndefined();
    await h.engine.primitive(r.scope, t.targetId, "click", { target: 6, button: "right" });
    expect(pointArgs().pop()!.guardMenu).toBe(true);
    const press = h.winter.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed").pop()!;
    expect(press.params.button).toBe("right");
  });

  test("cmd+a, cmd+z, cmd+shift+z and the deletion keys carry their macOS editing commands on the key event", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    const commandsOf = async (combo: string): Promise<unknown> => {
      await h.engine.primitive(r.scope, t.targetId, "key", { combo, into: 2 });
      return h.winter.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.params.type !== "keyUp").pop()!.params.commands;
    };
    expect(await commandsOf("cmd+a")).toEqual(["selectAll"]);
    expect(await commandsOf("cmd+z")).toEqual(["undo"]);
    expect(await commandsOf("cmd+shift+z")).toEqual(["redo"]);
    expect(await commandsOf("backspace")).toEqual(["deleteBackward"]);
    expect(await commandsOf("alt+backspace")).toEqual(["deleteWordBackward"]);
    expect(await commandsOf("delete")).toEqual(["deleteForward"]);
    expect(await commandsOf("shift+left")).toEqual(["moveLeftAndModifySelection"]);
    // Return, Tab and Escape keep the page's own handling (submit, focus): no command.
    expect(await commandsOf("return")).toBeUndefined();
    expect(await commandsOf("tab")).toBeUndefined();
  });
});

describe("H2: a hostile page's oversized answers never wedge the tab", () => {
  test("a frame tree too large for the link: the tab still opens from its target info and works", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    h.winter.failFrameTree = "too_large";
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    expect(h.winter.sent.some((s) => s.method === "Target.getTargetInfo")).toBe(true);
    expect(r.text()).toContain('[3] pop-up button "Country"');
    await h.engine.primitive(r.scope, t.targetId, "click", { target: 6 });
    h.winter.failFrameTree = "refused";
    h.chrome.failFrameTree = "refused";
    h.chrome.addTab(FORM, { tabKey: "5" });
    await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:5" });
  });

  test("an oversized state answer is a clear error, and the next state works", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    h.winter.oversizeOnce = "snapshot";
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "state", { full: true }));
    expect(e.message).toBe("the browser's answer was too large or unreadable — read less at once (state({ within }), a region screenshot)");
    const s = await h.engine.primitive(r.scope, t.targetId, "state", { full: true }) as string;
    expect(s).toContain('[6] button "Send"');
  });

  test("a navigation whose event never arrived (dropped as over-size) still reads as a new page with stale refs", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    await h.engine.primitive(r.scope, t.targetId, "state", {});
    // A new document with no event at all.
    const ft = h.winter.tabs.get("w1")!;
    ft.doc++;
    ft.page = h.winter.page("https://form.example/next");
    const s = await h.engine.primitive(r.scope, t.targetId, "state", {}) as string;
    expect(s.split("\n")[0]).toContain(" · new page");
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: 6 }));
    expect(kind(e)).toBe("StaleRef");
  });
});

describe("M1: the site floor meets where a tab landed before anything of it prints", () => {
  test("open: a redirect onto a listed host is refused and its page never printed", async () => {
    const h = harness({ policy: "auto", dangerousAdded: ["evil.example"] });
    h.winter.pages["https://ok.example/"] = { url: "https://evil.example/landing", title: "Evil", nodes: [{ id: 1, role: "heading", name: "Secret landing", level: 1 }] };
    const r = h.run();
    const e = await failure(h.engine.global(r.scope, "browsers.open", { url: "https://ok.example/" }));
    expect(kind(e)).toBe("NotAllowed");
    expect(e.message).toContain("evil.example");
    expect(r.text()).not.toContain("Secret landing");
  });

  test("tab: a user tab on a listed host is refused before its state prints (the rows' URL is the one checked)", async () => {
    const h = harness({ policy: "bypass", dangerousAdded: ["evil.example"] });
    h.chrome.addTab({ url: "https://evil.example/x", title: "Evil", nodes: [{ id: 1, role: "heading", name: "Secret landing", level: 1 }] }, { tabKey: "5" });
    const r = h.run();
    const e = await failure(h.engine.global(r.scope, "browsers.tab", { tab: "chrome:5" }));
    expect(kind(e)).toBe("NotAllowed");
    expect(r.text()).not.toContain("Secret landing");
  });

  test("tab, bound again: a tab that moved onto a listed host since prints nothing", async () => {
    const h = harness({ policy: "bypass", dangerousAdded: ["evil.example"] });
    h.chrome.addTab({ url: "https://ok.example/", title: "OK", nodes: [{ id: 1, role: "text", name: "fine" }] }, { tabKey: "5" });
    const r = h.run();
    await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:5" });
    h.chrome.pages["https://evil.example/x"] = { url: "https://evil.example/x", title: "Evil", nodes: [{ id: 1, role: "heading", name: "Secret landing", level: 1 }] };
    h.chrome.navigateTo("5", "https://evil.example/x");
    const r2 = h.run();
    const e = await failure(h.engine.global(r2.scope, "browsers.tab", { tab: "chrome:5" }));
    expect(kind(e)).toBe("NotAllowed");
    expect(r2.text()).not.toContain("Secret landing");
  });
});

describe("M2: token-bearing URLs and titles are redacted wherever they print", () => {
  const TOKEN_URL = "https://app.example/cb?code=Zx81kQ2mPq&state=ok#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl&token_type=bearer";
  const TOKEN_TITLE = "Signed in — key sk-live0123456789abcdefABCDEF";
  test("the header, url(), title(), tab rows and the timeout label carry no token", async () => {
    const h = harness();
    h.winter.pages["https://app.example/start"] = { url: TOKEN_URL, title: TOKEN_TITLE, nodes: [{ id: 1, role: "text", name: "hi" }] };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://app.example/start" }) as TabHandle;
    const all = (): string => r.text();
    expect(all()).toContain("code=<redacted>");
    expect(all()).toContain("access_token=<redacted>");
    expect(all()).toContain("state=ok");
    const url = await h.engine.primitive(r.scope, t.targetId, "url", {}) as string;
    const title = await h.engine.primitive(r.scope, t.targetId, "title", {}) as string;
    expect(url).toBe("https://app.example/cb?code=<redacted>&state=ok#access_token=<redacted>&token_type=bearer");
    expect(title).toBe("Signed in — key <redacted>");
    h.chrome.addTab({ url: TOKEN_URL, title: TOKEN_TITLE, nodes: [] }, { tabKey: "5" });
    const rows = await h.engine.global(r.scope, "browsers.tabs", {}) as Array<{ url: string; title: string }>;
    const listed = await h.engine.global(r.scope, "browsers.tabs", { browser: "chrome" }) as Array<{ url: string; title: string }>;
    for (const row of [...rows, ...listed]) {
      expect(row.url).not.toContain("Zx81kQ2mPq");
      expect(row.url).not.toContain("eyJhbGci");
      expect(row.title).not.toContain("sk-live");
    }
    expect(h.engine.label("s1", t.targetId)).toBe('Tab "Signed in — key <redacted>"');
    for (const secret of ["Zx81kQ2mPq", "eyJhbGci", "sk-live0123"]) expect(all()).not.toContain(secret);
    // The URL the model was shown still binds the tab.
    const again = await h.engine.global(r.scope, "browsers.tab", { tab: { url: listed[0]!.url }, browser: "chrome" }) as TabHandle;
    expect(again.id).toBe("chrome:5");
  });
});

describe("M3: a released tab is left as it was found", () => {
  test("the file chooser, focus emulation, auto-attach and the enabled domains are turned off BEFORE the detach", async () => {
    const h = harness();
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    const r = h.run();
    await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:5" });
    r.end();
    const n = h.chrome.sent.length;
    h.engine.turnEnded("s1");
    await tick(10);
    // The fake records a command only while the tab is attached: each of these reached the tab before the detach.
    const after = h.chrome.sent.slice(n).map((s) => `${s.method}${s.params.enabled === false || s.params.autoAttach === false ? " off" : ""}`);
    expect(after).toEqual([
      "Page.setInterceptFileChooserDialog off", "Emulation.setFocusEmulationEnabled off", "Target.setAutoAttach off",
      "Network.disable", "Runtime.disable", "Page.disable",
    ]);
    expect(h.chrome.tabs.get("5")!.attached).toBe(false);
  });
});

describe("M4: holds", () => {
  test("a built-in tab's hold goes at turn end and is taken again on its next use", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/" }) as TabHandle;
    expect(h.winter.tabs.get("w1")!.attached).toBe(true);
    r.end();
    h.engine.turnEnded("s1");
    await tick(10);
    expect(h.winter.tabs.get("w1")!.attached).toBe(false);
    expect(h.winter.tabs.get("w1")!.closed).toBe(false);
    const r2 = h.run();
    await h.engine.primitive(r2.scope, t.targetId, "state", {});
    expect(h.winter.tabs.get("w1")!.attached).toBe(true);
  });

  test(`past ${HOLDS_PER_SESSION} held tabs in a session the least recently used is let go, with a note; it works again on its next use`, async () => {
    const h = harness();
    const r = h.run();
    const handles: TabHandle[] = [];
    for (let i = 1; i <= HOLDS_PER_SESSION + 1; i++) handles.push(await h.engine.global(r.scope, "browsers.open", { url: `https://t${i}.example/` }) as TabHandle);
    await tick(10);
    expect(h.winter.tabs.get("w1")!.attached).toBe(false);
    expect([...h.winter.tabs.values()].filter((t) => t.attached).length).toBe(HOLDS_PER_SESSION);
    expect(r.text()).toContain(`let go of winter:w1 (the least recently used of more than ${HOLDS_PER_SESSION} in this session held tabs) — it stays open; using it again takes it back`);
    await h.engine.primitive(r.scope, handles[0]!.targetId, "state", {});
    expect(h.winter.tabs.get("w1")!.attached).toBe(true);
  });

  test(`past ${HOLDS_GLOBAL} in all, the least recently used IDLE tab is let go — never one another run is using, however old`, async () => {
    const h = harness();
    // b opens first (its tabs are the oldest) and its run is still going: it holds their locks.
    const rb = h.run("b");
    for (let i = 0; i < HOLDS_PER_SESSION; i++) await h.engine.global(rb.scope, "browsers.open", { url: `https://b${i}.example/` });
    // a opens next; its run ends, so its tabs are idle.
    const ra = h.run("a");
    for (let i = 0; i < HOLDS_PER_SESSION; i++) await h.engine.global(ra.scope, "browsers.open", { url: `https://a${i}.example/` });
    ra.end();
    const tabs = [...h.winter.tabs.values()];
    expect(tabs.every((t) => t.attached)).toBe(true);
    const c = h.run("c");
    await h.engine.global(c.scope, "browsers.open", { url: "https://c0.example/" });
    await tick(10);
    // b's tabs are older but locked by its running script: a's oldest goes instead.
    expect(tabs.slice(0, HOLDS_PER_SESSION).every((t) => t.attached)).toBe(true);
    expect(tabs[HOLDS_PER_SESSION]!.attached).toBe(false);
    expect(tabs.slice(HOLDS_PER_SESSION + 1).every((t) => t.attached)).toBe(true);
    expect(c.text()).toContain(`(the least recently used of more than ${HOLDS_GLOBAL} in all held tabs)`);
  });
});

describe("M5: uploads hand the browser a private copy", () => {
  test("the staged copy is passed, under the home's cache; it goes at the session's end and at the next daemon start", async () => {
    const h = harness();
    h.winter.pages["https://f.example/"] = { url: "https://f.example/", title: "F", nodes: [{ id: 8, role: "file input", name: "File" }], fileInputs: [8] };
    writeFileSync(join(h.cwd, "a.txt"), "hello");
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://f.example/" }) as TabHandle;
    await h.engine.primitive(r.scope, t.targetId, "upload", { ref: 1, paths: "a.txt" });
    const files = h.winter.sent.find((s) => s.method === "DOM.setFileInputFiles")!.params.files as string[];
    expect(files[0]!.startsWith(join(uploadStagingRoot(h.home), "s1") + "/")).toBe(true);
    expect(files[0]!.endsWith("/a.txt")).toBe(true);
    expect(readFileSync(files[0]!, "utf8")).toBe("hello");
    h.engine.sessionEnded("s1", "idle");
    expect(existsSync(files[0]!)).toBe(false);
    // A daemon start clears whatever an earlier run left.
    const r2 = h.run();
    const t2 = await h.engine.global(r2.scope, "browsers.open", { url: "https://f.example/" }) as TabHandle;
    await h.engine.primitive(r2.scope, t2.targetId, "upload", { ref: 1, paths: "a.txt" });
    expect(readdirSync(uploadStagingRoot(h.home)).length).toBe(1);
    new BrowserEngine({ registry: new BrowserBackendRegistry(), mintWinterTab: () => "x", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({}), home: h.home }).stop();
    expect(existsSync(uploadStagingRoot(h.home))).toBe(false);
  });

  test("a file swapped after the checks is refused, not copied", () => {
    const h = harness();
    writeFileSync(join(h.cwd, "a.txt"), "checked");
    writeFileSync(join(h.cwd, "evil.txt"), "swapped in");
    const checked = checkUploadFiles("a.txt", { cwd: h.cwd, home: h.home, denyRead: [] });
    renameSync(join(h.cwd, "evil.txt"), join(h.cwd, "a.txt"));
    let err: unknown;
    try { stageUploads(checked, h.home, "s1"); } catch (e) { err = e; }
    expect((err as AutomationFailure).kind).toBe("NotAllowed");
    expect((err as Error).message).toBe("a.txt changed while it was being uploaded — try again");
    expect(existsSync(join(uploadStagingRoot(h.home), "s1")) ? readdirSync(join(uploadStagingRoot(h.home), "s1")) : []).toEqual([]);
  });
});

describe("M6: a cancelled run stops its input between events", () => {
  test("typing stops at the next key once the run is cancelled", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    let downs = 0;
    h.winter.onSend = (method, params) => { if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && ++downs === 5) r.abort.abort(); };
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "type", { text: "a".repeat(100), into: 2 }));
    expect(kind(e)).toBe("Cancelled");
    expect(downs).toBe(5);
  });

  test("a drag stops between moves and still lets the button go", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    let moves = 0;
    h.winter.onSend = (method, params) => { if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1 && ++moves === 2) r.abort.abort(); };
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "drag", { from: 2, to: 6 }));
    expect(kind(e)).toBe("Cancelled");
    expect(moves).toBe(2);
    const last = h.winter.sent.filter((s) => s.method === "Input.dispatchMouseEvent").pop()!;
    expect(last.params.type).toBe("mouseReleased");
  });

  test("key repeats stop too", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    let downs = 0;
    h.winter.onSend = (method, params) => { if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown" && ++downs === 3) r.abort.abort(); };
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "key", { combo: "backspace", repeat: 50, into: 2 }));
    expect(kind(e)).toBe("Cancelled");
    expect(downs).toBe(3);
  });
});

describe("L1: clipboard keys are refused", () => {
  test("cmd/ctrl + c, x, v and shift+insert are Refused, naming paste() and text()", () => {
    for (const combo of ["cmd+v", "cmd+c", "cmd+x", "ctrl+v", "ctrl+c", "cmd+shift+v"]) {
      let err: unknown;
      try { parseCombo(combo); } catch (e) { err = e; }
      expect((err as AutomationFailure).kind).toBe("Refused");
      expect((err as Error).message).toBe("copy, cut and paste keys would use the user's clipboard — use paste(text) to put text in, and text() or state() to read it");
    }
    expect(() => parseCombo("shift+insert")).toThrow("that key pastes from the user's clipboard — use paste(text)");
    expect(parseCombo("cmd+a").commands).toEqual(["selectAll"]);
    expect(parseCombo("v").def.key).toBe("v");
  });
});

describe("L3/L4: world identity", () => {
  test("a context named \"winter\" the engine did not create is never used; its own world is", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    // Another extension's world, named "winter", appears in the top frame after a navigation.
    h.winter.navigateTo("w1", FORM.url);
    h.winter.emit(h.winter.tabs.get("w1")!, "Runtime.executionContextCreated", { context: { id: 9_999, uniqueId: "foreign", name: "winter", origin: "", auxData: { frameId: "top", isDefault: false, type: "isolated" } } });
    // The fake refuses any call into a world it did not make for the engine: this works only through the engine's own.
    await h.engine.primitive(r.scope, t.targetId, "state", {});
    expect(h.winter.sent.some((s) => (s.method === "Runtime.evaluate" && s.params.contextId === 9_999) || (s.method === "Runtime.callFunctionOn" && s.params.executionContextId === 9_999))).toBe(false);
  });

  test("a destroyed context is matched by its unique id: the same number from another process is not ours", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url }) as TabHandle;
    const worlds = (): number => h.winter.sent.filter((s) => s.method === "Page.createIsolatedWorld").length;
    const made = h.winter.sent.filter((s) => s.method === "Page.createIsolatedWorld").length;
    const ctx = [...h.winter.tabs.get("w1")!.contexts.entries()].find(([, c]) => c.frameId === "top")!;
    const id = Number(ctx[0].split(":")[1]);
    h.winter.emit(h.winter.tabs.get("w1")!, "Runtime.executionContextDestroyed", { executionContextId: id, executionContextUniqueId: "another-process" });
    await h.engine.primitive(r.scope, t.targetId, "state", {});
    expect(worlds()).toBe(made);
    h.winter.emit(h.winter.tabs.get("w1")!, "Runtime.executionContextDestroyed", { executionContextId: id, executionContextUniqueId: `u-${id}` });
    await h.engine.primitive(r.scope, t.targetId, "state", {});
    expect(worlds()).toBe(made + 1);
  });

  test("the fake transport enforces the amended rules: no reload script, no non-http(s) navigation", async () => {
    const f = new FakeCdpTransport("winter", "winter");
    f.addTab(FORM, { tabKey: "1" });
    await f.attach("1", { sessionId: "s" });
    await expect(f.send("1", "Page.reload", { scriptToEvaluateOnLoad: "1" })).rejects.toThrow("scriptToEvaluateOnLoad");
    await expect(f.send("1", "Page.navigate", { url: "javascript:alert(1)" })).rejects.toThrow("only http(s) and about:blank");
    await expect(f.send("1", "Page.navigate", { url: "data:text/html,x" })).rejects.toThrow("only http(s) and about:blank");
  });
});

describe("L5: an orphan whose session is mid-turn", () => {
  test("is adopted as that session's agent tab — so its turn's end closes it", async () => {
    const registry = new BrowserBackendRegistry();
    const late = new FakeCdpTransport("chrome", "chrome");
    late.addTab({ url: "https://busy.example/", title: "B", nodes: [] }, { tabKey: "2", sessionId: "s-busy", agent: true });
    const engine = new BrowserEngine({
      registry, mintWinterTab: () => "x", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({}), home: "/nonexistent",
      turnRunning: (sid) => sid === "s-busy",
    });
    registry.register(late, { family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", instanceKey: "chrome-1" });
    await tick(10);
    expect(late.tabs.get("2")!.closed).toBe(false);
    engine.turnEnded("s-busy");
    await tick(10);
    expect(late.tabs.get("2")!.closed).toBe(true);
    engine.stop();
  });
});

describe("L6: an html or markdown paste goes to the focused field's own frame", () => {
  test("the page's paste event is raised in the out-of-process frame that holds the field", async () => {
    const h = harness();
    h.winter.pages["https://ed.example/"] = {
      url: "https://ed.example/", title: "Editor", nodes: [{ id: 6, role: "iframe", name: "Editor", frame: true, origin: "docs.example" }],
      frames: [{ frameId: "f1", ownerId: 6, nodes: [{ id: 1, role: "text area", name: "Body", value: "" }], editable: [1], oopif: true, url: "https://docs.example/" }],
    };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://ed.example/" }) as TabHandle;
    await h.engine.primitive(r.scope, t.targetId, "paste", { text: "<b>hi</b>", format: "html", into: 2 });
    const paste = h.winter.sent.find((s) => s.method === "Runtime.callFunctionOn" && (s.params.arguments as Array<{ value: unknown }>)[0]!.value === "pasteEvent")!;
    expect(paste.session).toBe("S-f1");
  });
});

describe("L8: url() and title() while a page dialog is open", () => {
  test("answer at once from what the engine tracks, sending nothing into the paused page", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://p.example/" }) as TabHandle;
    h.winter.openDialog("w1", "alert", "hi");
    const n = h.winter.sent.length;
    expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("https://p.example/");
    expect(typeof await h.engine.primitive(r.scope, t.targetId, "title", {})).toBe("string");
    expect(h.winter.sent.slice(n).filter((s) => s.method.startsWith("Runtime."))).toEqual([]);
  });
});

describe("L9: a bare host gets a scheme", () => {
  test("http for this Mac's own servers, https for the rest; a word alone is not a URL", () => {
    expect(checkTabUrl("example.com/docs?q=1", "goto()")).toBe("https://example.com/docs?q=1");
    expect(checkTabUrl("sub.example.co.uk:8443", "goto()")).toBe("https://sub.example.co.uk:8443/");
    expect(checkTabUrl("localhost:3000/app", "goto()")).toBe("http://localhost:3000/app");
    expect(checkTabUrl("127.0.0.1:8080", "goto()")).toBe("http://127.0.0.1:8080/");
    expect(checkTabUrl("[::1]:5173/", "goto()")).toBe("http://[::1]:5173/");
    expect(checkTabUrl("10.0.0.2", "goto()")).toBe("https://10.0.0.2/");
    expect(() => checkTabUrl("hello", "goto()")).toThrow(TypeError);
    expect(() => checkTabUrl("javascript:alert(1)", "goto()")).toThrow("a javascript: URL is refused");
  });
});

describe("L10: network events need no buffers", () => {
  test("Network.enable asks the browser to keep no bodies", async () => {
    const h = harness();
    await h.engine.global(h.run().scope, "browsers.open", { url: "https://a.example/" });
    expect(h.winter.sent.find((s) => s.method === "Network.enable")!.params).toEqual({ maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
  });
});

describe("lane D: idle detaches and families", () => {
  test("families: Chrome for Testing and Edge's channels are known; bundle ids match without regard to case; names are stable", () => {
    expect(browserForBundleId("com.google.chrome.for.testing")).toEqual({ bundleId: "com.google.chrome.for.testing", family: "chrome", name: "Google Chrome for Testing" });
    expect(browserForBundleId("COM.GOOGLE.CHROME")).toEqual({ bundleId: "com.google.Chrome", family: "chrome", name: "Google Chrome" });
    for (const id of ["com.microsoft.edgemac.Beta", "com.microsoft.edgemac.dev", "COM.MICROSOFT.EDGEMAC.CANARY"]) {
      expect(familyForBundleId(id)?.family).toBe("edge");
      expect(familyForBundleId(id)?.name).toBe("Microsoft Edge");
    }
    expect(familyName("chrome")).toBe("Google Chrome");
    expect(familyName("brave")).toBe("Brave");
    expect(familyName("netscape")).toBeUndefined();
    expect(familyInfo("chrome")!.bundleIds[0]).toBe("com.google.Chrome");
    expect(familyInfo("winter")!.bundleIds).toEqual([]);
    expect(familyForBundleId("com.apple.Safari")).toBeUndefined();
    expect(familyOfBackendId("edge#2")).toBe("edge");
    expect(familyOfBackendId("netscape")).toBeUndefined();
  });

  test("a handoff() tab whose debugger idled out works on the next turn — and still closes at that turn's end", async () => {
    const h = harness();
    h.winter.pages[FORM.url] = FORM;
    h.chrome.pages[FORM.url] = FORM;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: FORM.url, browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, t.targetId, "handoff", {});
    r.end();
    h.engine.turnEnded("s1");
    const key = t.id.split(":")[1]!;
    // Six minutes later the extension lets the debugger go (a synthetic top-level Inspector.detached) …
    h.chrome.detachIdle(key);
    expect(h.chrome.tabs.get(key)!.attached).toBe(false);
    // … and says `stopped` (not closed): the tab is kept.
    h.chrome.goneTab(key, "stopped");
    h.chrome.tabs.get(key)!.closed = false;
    // The same handle works — no re-binding: the next primitive attaches again.
    const r2 = h.run();
    const s = await h.engine.primitive(r2.scope, t.targetId, "state", { full: true }) as string;
    expect(s).toContain('"Send"');
    expect(h.chrome.tabs.get(key)!.attached).toBe(true);
    r2.end();
    h.engine.turnEnded("s1");
    expect(h.chrome.tabs.get(key)!.closed).toBe(true);
  });

  test("only closed or crashed loses an agent tab; a stopped one keeps its binding and re-attaches", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    const key = t.id.split(":")[1]!;
    h.chrome.goneTab(key, "stopped");
    h.chrome.tabs.get(key)!.closed = false;
    h.chrome.tabs.get(key)!.attached = false;
    await h.engine.primitive(r.scope, t.targetId, "state", {});
    h.chrome.goneTab(key, "crashed");
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "state", {}));
    expect(kind(e)).toBe("TargetLost");
    expect(e.message).toContain("crashed");
  });
});

describe("lane D: a navigation the browser carries out across a detach", () => {
  const PAGES = (t: FakeCdpTransport): void => {
    t.pages["https://a.example/"] = { url: "https://a.example/", title: "A", nodes: [{ id: 1, role: "button", name: "On A" }] };
    t.pages["https://b.example/"] = { url: "https://b.example/", title: "B", nodes: [{ id: 1, role: "button", name: "On B" }] };
  };
  for (const how of ["resolve", "reject"] as const) {
    test(`goto, back and reload succeed when the debugger is let go for the navigation (the command ${how === "resolve" ? "answers" : "fails tab_gone"})`, async () => {
      const h = harness();
      PAGES(h.chrome);
      const r = h.run();
      const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
      const key = t.id.split(":")[1]!;
      const ft = h.chrome.tabs.get(key)!;
      ft.navigateByDetach = how;
      await h.engine.primitive(r.scope, t.targetId, "goto", { url: "https://b.example/" });
      expect(ft.attached).toBe(true);
      expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("https://b.example/");
      const s = await h.engine.primitive(r.scope, t.targetId, "state", {}) as string;
      expect(s).toContain('button "On B"');
      expect(s.split("\n")[0]).toContain(" · new page");
      await h.engine.primitive(r.scope, t.targetId, "back", {});
      expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("https://a.example/");
      await h.engine.primitive(r.scope, t.targetId, "reload", {});
      expect((await h.engine.primitive(r.scope, t.targetId, "state", { full: true }) as string)).toContain('button "On A"');
      expect(r.text()).not.toContain("still loading");
    });
  }

  test("the tab between documents refuses an attach for a moment: it is attached again once it can be", async () => {
    const h = harness();
    PAGES(h.chrome);
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    const ft = h.chrome.tabs.get(t.id.split(":")[1]!)!;
    ft.navigateByDetach = "reject";
    h.chrome.onSend = (method) => { if (method === "Page.navigate") ft.betweenUntil = Date.now() + 250; };
    await h.engine.primitive(r.scope, t.targetId, "goto", { url: "https://b.example/" });
    expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("https://b.example/");
  });

  test("a tab that really closed during the navigation is TargetLost; a refused navigation with no detach stays an error", async () => {
    const h = harness();
    PAGES(h.chrome);
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    const key = t.id.split(":")[1]!;
    const ft = h.chrome.tabs.get(key)!;
    h.chrome.failNextNavigate = "net::ERR_NAME_NOT_RESOLVED";
    const net = await failure(h.engine.primitive(r.scope, t.targetId, "goto", { url: "https://nope.invalid/" }));
    expect(net.message).toContain("net::ERR_NAME_NOT_RESOLVED");
    ft.navigateByDetach = "reject";
    h.chrome.onSend = (method) => {
      if (method !== "Page.navigate") return;
      ft.betweenUntil = Date.now() + 60_000;
      setTimeout(() => h.chrome.goneTab(key, "closed"), 50);
    };
    const t0 = Date.now();
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "goto", { url: "https://b.example/" }));
    expect(kind(e)).toBe("TargetLost");
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test("an ENDED world is answered in Chrome's words, and the engine reads again in a fresh one", async () => {
    const h = harness();
    PAGES(h.chrome);
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    const ft = h.chrome.tabs.get(t.id.split(":")[1]!)!;
    // The world ends with no event the engine saw.
    for (const [k, c] of [...ft.contexts]) if (c.frameId === "top") { ft.contexts.delete(k); ft.endedContexts.add(k); }
    const s = await h.engine.primitive(r.scope, t.targetId, "state", { full: true }) as string;
    expect(s).toContain('button "On A"');
  });
});

describe("world rule: Runtime is enabled in a frame's session before its world is made", () => {
  test("a frame attached afresh is used only once Runtime is on in its session (a key into it waits for the setup)", async () => {
    const h = harness();
    h.winter.pages["https://ed.example/"] = {
      url: "https://ed.example/", title: "Editor", nodes: [{ id: 6, role: "iframe", name: "Editor", frame: true, origin: "docs.example" }],
      frames: [{ frameId: "f1", ownerId: 6, nodes: [{ id: 1, role: "text area", name: "Body", value: "" }], editable: [1], oopif: true, url: "https://docs.example/" }],
    };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://ed.example/" }) as TabHandle;
    const ft = h.winter.tabs.get("w1")!;
    ft.focused = "f1:1";
    // The frame's target comes back in a new session whose setup is slow to enable Runtime.
    h.winter.commandDelay = (method, session) => (session === "S-f1" && method === "Page.enable" ? 150 : 0);
    h.winter.reattachChild("w1", "f1");
    await h.engine.primitive(r.scope, t.targetId, "type", { text: "hi" });
    const order = h.winter.sent.filter((s) => s.session === "S-f1").map((s) => s.method);
    const lastEnable = order.lastIndexOf("Runtime.enable");
    const lastWorld = order.lastIndexOf("Page.createIsolatedWorld");
    expect(lastEnable).toBeGreaterThanOrEqual(0);
    expect(lastEnable).toBeLessThan(lastWorld);
  });
});
