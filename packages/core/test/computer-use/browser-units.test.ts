// The browser engine's pure parts: the backend registry's ids, the agent-tab close rule, the tab state format and
// diffs, the site floor's rows and rule matching, upload paths, the screenshot scale mapping, key combos, URL checks,
// the committed page-runtime bundle (stale = fail), and the tool description with and without vision.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPageRuntimeModule } from "../../../../scripts/build-page-runtime";
import { checkTabUrl } from "../../src/computer-use/browser/engine";
import { transportFailure } from "../../src/computer-use/browser/tab-driver";
import { TransportError } from "../../src/computer-use/browser/transport";
import { keyEvents, parseCombo } from "../../src/computer-use/browser/input";
import { shouldCloseAgentTab } from "../../src/computer-use/browser/lifecycle";
import { PAGE_RUNTIME_SOURCE } from "../../src/computer-use/browser/page-runtime/bundle.generated";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import { fitsBudget, imageSize, scaleFor, toCss } from "../../src/computer-use/browser/scale";
import { ruleAllowsSite, siteCardSummary, siteRow } from "../../src/computer-use/browser/site-policy";
import { bodyLines, diffState, FULL_STATE_LINE_CAP, fullState, makeSnapshot, nodeLine, type TabNode } from "../../src/computer-use/browser/state-format";
import { checkUploadPaths, UPLOAD_MAX_FILES } from "../../src/computer-use/browser/upload-paths";
import { computerV2Description } from "../../src/computer-use/description";
import { AutomationFailure } from "../../src/computer-use/errors";
import { FakeCdpTransport, fakeJpeg } from "./browser-fake-transport";

const node = (ref: number, role: string, o: Partial<TabNode> = {}): TabNode => ({ ref, role, states: [], children: [], ...o });

describe("the backend registry", () => {
  test("ids are per family, stable per instance key, #2 for another instance; a replaced registration's unregister is a no-op", () => {
    const r = new BrowserBackendRegistry();
    const a = new FakeCdpTransport("chrome", "chrome");
    const b = new FakeCdpTransport("chrome", "chrome");
    const first = r.register(a, { family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", instanceKey: "i1" });
    const second = r.register(b, { family: "chrome", name: "Google Chrome (2)", bundleId: "com.google.Chrome", instanceKey: "i2" });
    expect([first.id, second.id]).toEqual(["chrome", "chrome#2"]);
    // The same key (a service worker restarting) gets the same id back, replacing the stale entry.
    const again = new FakeCdpTransport("chrome", "chrome");
    const third = r.register(again, { family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", instanceKey: "i1" });
    expect(third.id).toBe("chrome");
    expect(r.get("chrome")).toBe(again);
    first.unregister();
    expect(r.get("chrome")).toBe(again);
    third.unregister();
    expect(r.get("chrome")).toBeUndefined();
    expect(r.list().map((x) => [x.id, x.connected])).toEqual([["chrome", false], ["chrome#2", true]]);
    // The id survives a disconnect: the next registration of i1 is "chrome" again, never #3.
    expect(r.register(new FakeCdpTransport("chrome", "chrome"), { family: "chrome", name: "Google Chrome", instanceKey: "i1" }).id).toBe("chrome");
  });

  test("a noted-unavailable family is listed with its reason until one of it connects", () => {
    const r = new BrowserBackendRegistry();
    let changes = 0;
    r.onChange(() => changes++);
    r.noteUnavailable({ family: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", reason: "update Winter for Chrome" });
    expect(r.list()).toEqual([{ id: "edge", family: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", connected: false, reason: "update Winter for Chrome" }]);
    r.register(new FakeCdpTransport("edge", "edge"), { family: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", instanceKey: "e" });
    expect(r.list()).toEqual([{ id: "edge", family: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", connected: true }]);
    expect(changes).toBe(2);
  });
});

describe("shouldCloseAgentTab (the user's ruling)", () => {
  const user = { family: "chrome" as const };
  test("turn end closes an unmarked agent tab; keep and handoff survive it", () => {
    expect(shouldCloseAgentTab({ ...user, event: "turn-ended", kept: false })).toBe(true);
    expect(shouldCloseAgentTab({ ...user, event: "turn-ended", kept: true })).toBe(false);
    expect(shouldCloseAgentTab({ ...user, event: "turn-ended", kept: false, handoff: true })).toBe(false);
  });
  test("deletion and archiving close; idle end and daemon stop close nothing", () => {
    for (const event of ["session-deleted", "session-archived"] as const) {
      expect(shouldCloseAgentTab({ ...user, event, kept: false })).toBe(true);
      expect(shouldCloseAgentTab({ ...user, event, kept: false, handoff: true })).toBe(true);
      expect(shouldCloseAgentTab({ ...user, event, kept: true })).toBe(false);
    }
    for (const event of ["idle-ended", "daemon-stop"] as const) expect(shouldCloseAgentTab({ ...user, event, kept: false })).toBe(false);
  });
  test("after a restart: closed unless its session runs a turn (a handoff does not survive)", () => {
    expect(shouldCloseAgentTab({ ...user, event: "restart-orphan", kept: false, handoff: true })).toBe(true);
    expect(shouldCloseAgentTab({ ...user, event: "restart-orphan", kept: false, turnRunning: true })).toBe(false);
  });
  test("a built-in tab is never closed by the rule", () => {
    for (const event of ["turn-ended", "session-deleted", "session-archived", "restart-orphan"] as const) {
      expect(shouldCloseAgentTab({ family: "winter", event, kept: false })).toBe(false);
    }
  });
});

describe("the tab state format", () => {
  test("lines: roles, quoted names, values (empty shown, secure redacted), levels, items, states, hosts, frame origins", () => {
    expect(nodeLine(node(2, "heading", { name: "Your cart", level: 2 }))).toBe('[2] heading "Your cart" (level 2)');
    expect(nodeLine(node(3, "link", { name: "Continue shopping", href: "shop.example.com" }))).toBe('[3] link "Continue shopping" → shop.example.com');
    expect(nodeLine(node(4, "text field", { name: "Coupon", value: "", showEmptyValue: true }))).toBe('[4] text field "Coupon" value=""');
    expect(nodeLine(node(6, "iframe", { name: "Payment", origin: "pay.example.com" }))).toBe('[6] iframe "Payment" (pay.example.com)');
    expect(nodeLine(node(7, "text field", { name: "Card number", value: "<redacted>", secure: true }))).toBe('[7] text field "Card number" value=<redacted>');
    expect(nodeLine(node(8, "check box", { name: "Gift wrap", states: ["unchecked"] }))).toBe('[8] check box "Gift wrap" (unchecked)');
    expect(nodeLine(node(9, "list", { name: "Recs", items: 3 }))).toBe('[9] list "Recs" (3 items)');
    expect(nodeLine(node(10, "text field", { name: "Q", value: "say \"hi\"\n" }))).toBe('[10] text field "Q" value="say \\"hi\\"\\n"');
  });

  test("the header: title, URL cut at 200, focus, settle, new page; the dialog line comes first after it", () => {
    const text = fullState({
      title: "Checkout — Shop", url: `https://shop.example.com/${"x".repeat(300)}`, focusedRef: 12, settle: { settled: true, ms: 120 }, newPage: true,
      dialog: { type: "confirm", message: "Leave this page?", okRef: 91, cancelRef: 92 },
    }, [node(1, "main")], false);
    const [h, d] = text.split("\n");
    expect(h).toMatch(/^Tab "Checkout — Shop" — https:\/\/shop\.example\.com\/x+… · focused \[12\] · settled 120 ms · new page$/);
    expect(h!.length).toBeLessThan(300);
    expect(d).toBe('dialog confirm "Leave this page?" — [91] button "OK" · [92] button "Cancel"');
    expect(fullState({ title: "T", url: "u", settle: { settled: false, ms: 1500 } }, [], false).split("\n")[0]).toBe('Tab "T" — u · not settled after 1500 ms');
  });

  test("past 300 lines: out-of-view content folds first, then the largest subtree; the focus path stays", () => {
    const items = Array.from({ length: 400 }, (_, i) => node(100 + i, "text", { name: `row ${i}`, off: i >= 50 }));
    const roots = [node(1, "main", { children: [node(2, "list", { children: items }), node(3, "text field", { name: "Search", states: ["focused"] })] })];
    const lines = bodyLines(roots, 3, true);
    expect(lines.length).toBeLessThanOrEqual(300);
    expect(lines.some((l) => l.includes("… 350 more out of view — scroll, or state({within:2})"))).toBe(true);
    expect(lines.some((l) => l.includes('[3] text field "Search"'))).toBe(true);
    const full = bodyLines(roots, 3, false);
    expect(full.some((l) => /\[2\] list \(400 more — state\(\{within:2\}\)\)/.test(l))).toBe(true);
  });

  test("full: true is everything the read saw, up to its hard cap, and says where it was cut", () => {
    const items = Array.from({ length: 400 }, (_, i) => node(100 + i, "text", { name: `row ${i}` }));
    const roots = [node(1, "main", { children: [node(2, "list", { children: items }), node(3, "text field", { name: "Search" })] })];
    const whole = fullState({ title: "T", url: "u" }, roots, false, undefined, true).split("\n").slice(1);
    expect(whole.length).toBe(403);
    expect(whole.some((l) => l.includes('"row 399"'))).toBe(true);
    expect(whole.some((l) => l.includes("more — state("))).toBe(false);
    expect(whole.some((l) => l.includes("the full state is cut"))).toBe(false);
    // The ordinary state folds to 300 as ever.
    expect(fullState({ title: "T", url: "u" }, roots, false).split("\n").length).toBeLessThanOrEqual(301);
    // Past the cap: folded the same way, and the last line says so.
    const capped = bodyLines(roots, undefined, false, 50, true);
    expect(capped.at(-1)).toBe('… the full state is cut at 50 lines: 400 elements are folded behind the "more" markers above — read each with state({within})');
    expect(FULL_STATE_LINE_CAP).toBe(4_000);
  });

  test("diffs: + added, ~ changed facets, - removed; over half changed is reported for the full fallback", () => {
    const a = makeSnapshot("s1", [node(1, "main", { children: [node(2, "text field", { name: "Coupon", value: "", showEmptyValue: true }), node(3, "button", { name: "Old" })] })]);
    const b = makeSnapshot("s2", [node(1, "main", { children: [node(2, "text field", { name: "Coupon", value: "SAVE10" }), node(4, "button", { name: "New" })] })]);
    const d = diffState({ title: "T", url: "u" }, a, b);
    expect(d.text.split("\n").slice(1)).toEqual(['+ [4] button "New"', '~ [2] value "" → "SAVE10"', "- [3]"]);
    expect(d.changedRatio).toBe(3 / 4);
    const same = diffState({ title: "T", url: "u" }, a, makeSnapshot("s3", [node(1, "main", { children: [node(2, "text field", { name: "Coupon", value: "", showEmptyValue: true }), node(3, "button", { name: "Old" })] })]));
    expect(same.text.split("\n")[1]).toBe("(no changes)");
  });
});

describe("the site floor", () => {
  test("the rows: ask, accept-edits and plan card; auto, bypass, dont-ask, Dispatch and chat block", () => {
    for (const p of ["ask", "accept-edits", "plan"] as const) expect(siteRow({ policy: p, mode: "code" })).toBe("card");
    for (const p of ["auto", "bypass", "dont-ask"] as const) expect(siteRow({ policy: p, mode: "code" })).toBe("block");
    expect(siteRow({ policy: "ask", mode: "dispatch" })).toBe("block");
    expect(siteCardSummary("evil.example", "Google Chrome")).toBe("Allow Winter to use evil.example in Google Chrome? It is on the dangerous-domains list.");
  });
  test("a standing WebFetch(domain:…) rule matches its host and subdomains; nothing else does", () => {
    expect(ruleAllowsSite(["WebFetch(domain:evil.example)"], "https://evil.example/x")).toBe(true);
    expect(ruleAllowsSite(["WebFetch(domain:evil.example)"], "https://a.evil.example/x")).toBe(true);
    expect(ruleAllowsSite(["WebFetch(domain:evil.example)"], "https://notevil.example/x")).toBe(false);
    expect(ruleAllowsSite(["Bash", "WebFetch"], "https://evil.example/")).toBe(false);
  });
});

describe("upload paths", () => {
  const roots = () => {
    const home = mkdtempSync(join(tmpdir(), "winter-up-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-up-cwd-"));
    const tmp = mkdtempSync(join(tmpdir(), "winter-up-tmp-"));
    return { home, cwd, tmp, r: { home, cwd, tmpDir: tmp, denyRead: [join(cwd, "deny")] } };
  };
  test("relative paths resolve in the cwd; the temp dir counts; directories, too many and the deny list are refused", () => {
    const { cwd, tmp, r } = roots();
    writeFileSync(join(cwd, "a.txt"), "a");
    writeFileSync(join(tmp, "b.txt"), "b");
    mkdirSync(join(cwd, "dir"));
    mkdirSync(join(cwd, "deny"));
    writeFileSync(join(cwd, "deny", "c.txt"), "c");
    expect(checkUploadPaths(["a.txt", join(tmp, "b.txt")], r).map((p) => p.split("/").pop())).toEqual(["a.txt", "b.txt"]);
    const kinds = (paths: unknown): string => { try { checkUploadPaths(paths, r); return "ok"; } catch (e) { return e instanceof AutomationFailure ? e.kind : (e as Error).name; } };
    expect(kinds("dir")).toBe("NotAllowed");
    expect(kinds("deny/c.txt")).toBe("NotAllowed");
    expect(kinds(Array.from({ length: UPLOAD_MAX_FILES + 1 }, () => "a.txt"))).toBe("NotAllowed");
    expect(kinds(42)).toBe("TypeError");
    expect(kinds("missing.txt")).toBe("NotAllowed");
  });
});

describe("screenshots", () => {
  test("the scale meets the long edge and the tile cap; a JPEG's size is read from its header; points map to CSS px", () => {
    const budget = { maxLongEdge: 1568, tile: 28, maxTiles: 1568, quality: 0.8 };
    const s = scaleFor({ width: 1200, height: 800 }, 2, budget);
    const w = Math.round(1200 * s * 2), h = Math.round(800 * s * 2);
    expect(fitsBudget(w, h, budget)).toBe(true);
    expect(Math.max(w, h)).toBeGreaterThan(1000);
    expect(imageSize(fakeJpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(toCss({ width: 600, height: 400, css: { x: 0, y: 0, width: 1200, height: 800 } }, 300, 200)).toEqual({ x: 600, y: 400 });
    expect(toCss({ width: 100, height: 100, css: { x: 50, y: 60, width: 200, height: 200 } }, 50, 50)).toEqual({ x: 150, y: 160 });
  });
});

describe("keys and URLs", () => {
  test("combos: modifiers, named keys, printable keys, mac editing commands; bad names are TypeErrors", () => {
    const save = parseCombo("cmd+s");
    expect(save.modifiers).toBe(4);
    expect(save.def.key).toBe("s");
    const [down, up] = keyEvents(save);
    expect(down).toMatchObject({ type: "rawKeyDown", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 4 });
    expect(down.text).toBeUndefined();
    expect(up).toMatchObject({ type: "keyUp" });
    expect(keyEvents(parseCombo("return"))[0]).toMatchObject({ type: "keyDown", key: "Enter", text: "\r" });
    expect(parseCombo("shift+tab").modifiers).toBe(8);
    expect(parseCombo("cmd+a").commands).toEqual(["selectAll"]);
    expect(() => parseCombo("hyper+x")).toThrow(TypeError);
    expect(() => parseCombo("cmd+nosuchkey")).toThrow(TypeError);
  });
  test("tab URLs: http(s) or about:blank only — another scheme is NotAllowed, a non-URL a TypeError", () => {
    expect(checkTabUrl("https://example.com", "goto()")).toBe("https://example.com/");
    expect(checkTabUrl("about:blank", "goto()")).toBe("about:blank");
    for (const bad of ["file:///etc/hosts", "javascript:alert(1)", "chrome://settings", "about:srcdoc", "data:text/html,x"]) {
      expect(() => checkTabUrl(bad, "goto()")).toThrow(AutomationFailure);
    }
    for (const bad of ["not a url", 7]) expect(() => checkTabUrl(bad, "goto()")).toThrow(TypeError);
  });
  test("transport failures read as the model's kinds; an oversized or unreadable answer says to read less", () => {
    expect(transportFailure(new TransportError("disconnected", "x"), "Winter's browser")).toMatchObject({ kind: "BrowserUnavailable", message: "Winter's browser can't be reached: Winter isn't running — ask the user to open Winter" });
    expect(transportFailure(new TransportError("tab_gone", "x"), "Google Chrome")).toMatchObject({ kind: "TargetLost" });
    expect(transportFailure(new TransportError("protocol_mismatch", "x", { side: "extension" }), "Google Chrome").message).toContain("update Winter for Chrome");
    expect(transportFailure(new TransportError("cdp_error", "x", { cdpCode: -32603, cdpMessage: "too big" }), "Winter's browser").message).toContain("too large or unreadable");
    expect(transportFailure(new TransportError("cdp_error", "x", { cdpCode: -32000, cdpMessage: "No node with given id" }), "Winter's browser").message).toBe("No node with given id");
  });
});

describe("the page runtime bundle", () => {
  test("the committed bundle.generated.ts is what build-page-runtime makes from main.ts (run `bun run build:page-runtime`)", async () => {
    const fresh = await renderPageRuntimeModule();
    const committed = (await Bun.file(join(import.meta.dir, "..", "..", "src", "computer-use", "browser", "page-runtime", "bundle.generated.ts")).text());
    expect(committed).toBe(fresh);
  });
  test("the runtime never reaches for I/O: no fetch, postMessage, storage, cookies or sockets in its source", () => {
    for (const banned of ["fetch(", "postMessage", "localStorage", "sessionStorage", "indexedDB", "document.cookie", "XMLHttpRequest", "WebSocket", "sendBeacon"]) {
      expect(PAGE_RUNTIME_SOURCE.includes(banned)).toBe(false);
    }
  });
});

describe("the tool description", () => {
  const full = computerV2Description({ vision: true });
  const blind = computerV2Description({ vision: false });
  test("snapshots, with and without vision", () => {
    expect(full).toMatchSnapshot();
    expect(blind).toMatchSnapshot();
  });
  test("Target, App, Tab and browsers are declared; handoff and keep say the ruling's words; BrowserUnavailable is listed", () => {
    expect(full).toContain("interface Target {");
    expect(full).toContain("interface App extends Target {");
    expect(full).toContain("interface Tab extends Target {");
    expect(full).toContain("declare const browsers: {");
    expect(full).toContain("  handoff(): Promise<void>;   // keep this tab (yours, still in Winter's group) for your next turn only — call it again each turn you still need it");
    expect(full).toContain("// hand this tab to the user: it leaves Winter's group and Winter never closes it");
    expect(full).toContain("Tabs you open in the user's own browser close when your turn ends unless you call keep() (give it to the user) or handoff() (keep it for your next turn).");
    expect(full).toContain("`BrowserUnavailable`");
    expect(full).toContain("the built-in browser needs no approval");
  });
  test("without vision: no Image, Point, screenshot, show or appAt — and points read as refs", () => {
    for (const s of ["type Image", "type Point", "screenshot(", "declare function show", "appAt("]) expect(blind.includes(s)).toBe(false);
    expect(blind).toContain("click(t: Ref, o?:");
  });
  test("it never names the old Browser tool, nor varies with the browsers connected", () => {
    expect(/`Browser`|Browser tool/.test(full)).toBe(false);
  });
});
