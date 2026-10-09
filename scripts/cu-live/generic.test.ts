// The generic app check's PLANNING, with no screen: which element is harmless, which field is editable, what undoes a
// press, the destructive-name denylist, the restore steps — run twice, as TypeScript and as the transpiled JavaScript
// the scripts carry into the sandboxed worker (`PLANNING`), so the two cannot drift.
import { describe, expect, test } from "bun:test";
import {
  describePlan, GENERIC_PRELUDE, genericScenario, isDestructiveName, looksLikeBundleId, normalizeAppName, offSpacePlan, offSpaceSkipReason, onDesktopPlan, visualSkipReason,
  parseApps, pickEditable, pickPressable, PLANNING, refCount, resolveApp, restorePlan, SCRIPTS, secureFocused, TYPE_MARKER, type PlanElement, type ResolveDeps,
} from "./generic";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLogTimestamp } from "./run";
import { scriptOf } from "./scenarios";

type Planning = { isDestructiveName: typeof isDestructiveName; pickPressable: typeof pickPressable; pickEditable: typeof pickEditable; secureFocused: typeof secureFocused; refCount: typeof refCount };
const embedded = new Function(`${PLANNING}\nreturn { isDestructiveName, pickPressable, pickEditable, secureFocused, refCount };`)() as Planning;
const impls: Array<[string, Planning]> = [["TypeScript", { isDestructiveName, pickPressable, pickEditable, secureFocused, refCount }], ["embedded JavaScript", embedded]];

const el = (ref: number, role: string, name?: string, extra: Partial<PlanElement> = {}): PlanElement => ({ ref, role, ...(name === undefined ? {} : { name }), ...extra });

for (const [label, p] of impls) {
  describe(`the planning (${label})`, () => {
    test("the destructive-name denylist: anything that destroys, sends, pays, signs, ends, leaves or confirms", () => {
      for (const n of ["Delete", "Move to Trash", "Close Window", "Quit", "Send", "Buy Now", "Remove", "Sign In", "Log Out", "Publish", "OK", "Allow", "Empty Trash", "Uninstall", "Submit", "Reset", "Clear All", "Download"]) {
        expect({ n, d: p.isDestructiveName(n) }).toEqual({ n, d: true });
      }
      for (const n of ["Sidebar", "Show Inspector", "General", "Tab 2", "Bold", "Design", "Posts", "Explorer", "Toggle Minimap", undefined]) {
        expect({ n, d: p.isDestructiveName(n) }).toEqual({ n, d: false });
      }
    });

    test("pressable: a tab first, undone by re-selecting the tab that was selected; never the selected one", () => {
      const plan = p.pickPressable({ tab: [el(1, "tab", "General", { states: ["selected"] }), el(2, "tab", "Advanced")], button: [el(9, "button", "Show Sidebar")] });
      expect(plan).toEqual({ element: el(2, "tab", "Advanced"), undo: "reselect", reselect: el(1, "tab", "General", { states: ["selected"] }) });
    });

    test("pressable: a tab group with nothing selected is not reversible — the next kind is used", () => {
      const plan = p.pickPressable({ tab: [el(1, "tab", "A"), el(2, "tab", "B")], "check box": [el(5, "check box", "Word Wrap")] });
      expect(plan).toEqual({ element: el(5, "check box", "Word Wrap"), undo: "press-again" });
    });

    test("pressable: disabled, unnamed, destructive and non-toggle buttons are never chosen", () => {
      expect(p.pickPressable({
        "check box": [el(1, "check box", "Enabled", { states: ["disabled"] }), el(2, "check box", "")],
        button: [el(3, "button", "Delete"), el(4, "button", "Save"), el(5, "button", "New Tab"), el(6, "button", "Close")],
      })).toBeUndefined();
      expect(p.pickPressable({ button: [el(4, "button", "Save"), el(7, "button", "Toggle Panel")] })).toEqual({ element: el(7, "button", "Toggle Panel"), undo: "press-again" });
    });

    test("pressable: only elements of the asked role count (find matches by role, but be strict)", () => {
      expect(p.pickPressable({ tab: [el(1, "menu item", "Tab")], button: [el(2, "close button", "Show Panel")] })).toBeUndefined();
    });

    test("editable: an EMPTY, enabled, non-sensitive field — a search field first; never one holding text", () => {
      const byRole = {
        "text area": [el(1, "text area", "Editor", { value: "" })],
        "text field": [el(2, "text field", "Title", { value: "My document" }), el(3, "text field", "Password", { value: "" }), el(4, "text field", "Name", { value: "", states: ["disabled"] })],
        "search field": [el(5, "search field", "Search", { value: "" })],
      };
      expect(p.pickEditable(byRole)).toEqual(el(5, "search field", "Search", { value: "" }));
      expect(p.pickEditable({ "text field": byRole["text field"], "text area": byRole["text area"] })).toEqual(el(1, "text area", "Editor", { value: "" }));
      expect(p.pickEditable({ "text field": [el(2, "text field", "Title", { value: "x" }), el(6, "text field", "One-time code")] })).toBeUndefined();
    });

    test("a focused secure field stops typing in the app; the ref count of a state", () => {
      expect(p.secureFocused([el(1, "secure text field", "Password", { states: ["focused"] })])).toBe(true);
      expect(p.secureFocused([el(1, "secure text field", "Password")])).toBe(false);
      expect(p.refCount("Code — window\n[1] window\n  [14] text area\n  [15] button \"Run\"")).toBe(3);
      expect(p.refCount("Unity — window (no accessibility)")).toBe(0);
    });
  });
}

describe("the generic run's plan", () => {
  test("the AX press re-finds the element once on StaleRef (VS Code redraws), then retries", () => {
    const code = SCRIPTS.press({ query: "x", key: "k" });
    expect(code).toContain('e.name !== "StaleRef"');
    expect(code).toContain("re-found after StaleRef");
  });

  test("--apps: trimmed, deduplicated (case-insensitively), each with its own key", () => {
    expect(parseApps(" VRoid Studio, com.microsoft.VSCode ,vroid studio,,")).toEqual([{ query: "VRoid Studio", key: "app0" }, { query: "com.microsoft.VSCode", key: "app1" }]);
    expect(parseApps(undefined)).toEqual([]);
  });

  test("the on-desktop steps; the no-AX click only when the tree is (almost) empty", () => {
    expect(onDesktopPlan(30).map((s) => s.action)).toEqual(["state", "press", "type", "rightClick", "scroll", "screenshot"]);
    expect(onDesktopPlan(1).map((s) => s.action).at(-1)).toBe("noAx");
    expect(offSpacePlan().map((s) => s.action)).toEqual(["state", "press", "type", "screenshot"]);
  });

  test("off-Space only for an app the run launched; the user's own windows are never moved", () => {
    expect(offSpaceSkipReason(true)).toContain("already running");
    expect(offSpaceSkipReason(undefined)).toContain("unknown");
    expect(offSpaceSkipReason(false)).toBeUndefined();
  });

  test("visual steps skip for an already-running app with no window on this desktop (VS Code with none open)", () => {
    expect(visualSkipReason(true, false, "screenshot")).toContain("never moves your windows");
    expect(visualSkipReason(true, false, "noAx")).toContain("this desktop");
    expect(visualSkipReason(true, false, "state")).toBeUndefined();
    expect(visualSkipReason(true, true, "screenshot")).toBeUndefined();
    expect(visualSkipReason(false, false, "screenshot")).toBeUndefined();
    expect(visualSkipReason(true, undefined, "screenshot")).toBeUndefined();
  });

  test("restore: quit what the run launched; otherwise close only a window the run opened", () => {
    expect(restorePlan(false, "")).toEqual({ quit: true, closeOpenedWindow: false });
    expect(restorePlan(true, "opened a new Code window; the existing one is on another Space")).toEqual({ quit: false, closeOpenedWindow: true });
    expect(restorePlan(true, "bound Code's window")).toEqual({ quit: false, closeOpenedWindow: false });
  });

  test("every generic script is valid JavaScript with its prelude, and never types outside the marker", () => {
    const a = { query: "VRoid Studio", key: "app0" };
    for (const action of Object.keys(SCRIPTS) as Array<keyof typeof SCRIPTS>) {
      const s = genericScenario(a, action, action);
      expect(s.prelude).toBe(GENERIC_PRELUDE);
      expect(() => new Function("apps", "screen", "print", "sleep", "show", `return (async () => {${scriptOf(s)}})`)).not.toThrow();
    }
    expect(SCRIPTS.type(a)).toContain(JSON.stringify(TYPE_MARKER));
    expect(SCRIPTS.type(a)).not.toMatch(/\.type\((?!"WinterCU-Marker)/);
    expect(genericScenario(a, "x", "state", true).name).toBe("VRoid Studio (off-Space): x");
  });

  test("bundle-id detection, name normalisation and the plan line", () => {
    expect(looksLikeBundleId("com.microsoft.VSCode")).toBe(true);
    expect(looksLikeBundleId("net.pixiv.vroid.macosx")).toBe(true);
    expect(looksLikeBundleId("VRoid Studio")).toBe(false);
    expect(normalizeAppName("VRoid Studio")).toBe(normalizeAppName("VRoidStudio.app"));
    expect(normalizeAppName("Visual Studio Code")).toBe("visualstudiocode");
    expect(describePlan({ query: "VRoid Studio", key: "app0" })).toContain("off-Space via its full-screen button only if the run launched it");
  });
});

describe("resolving --apps names (bundle id, LaunchServices, bundle names)", () => {
  /** A fake app folder: "VRoidStudio.app" (no space in the FILE name) whose names say "VRoid Studio". */
  function fakeApps(): { dir: string; deps: (mdfind?: (q: string) => string[]) => ResolveDeps; cleanup(): void } {
    const dir = mkdtempSync(join(tmpdir(), "cu-live-apps-"));
    const plist = (id: string, name: string, exe: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleName</key><string>${name}</string><key>CFBundleExecutable</key><string>${exe}</string></dict></plist>\n`;
    for (const [file, id, name, exe] of [["VRoidStudio.app", "net.pixiv.vroid.macosx", "VRoid Studio", "VRoid Studio"], ["Other.app", "com.example.other", "Other", "Other"]]) {
      mkdirSync(join(dir, file!, "Contents"), { recursive: true });
      writeFileSync(join(dir, file!, "Contents", "Info.plist"), plist(id!, name!, exe!));
    }
    mkdirSync(join(dir, "Utilities", "Nested Tool.app", "Contents"), { recursive: true });
    writeFileSync(join(dir, "Utilities", "Nested Tool.app", "Contents", "Info.plist"), plist("com.example.nested", "Nested Tool", "nested"));
    const deps = (mdfind: (q: string) => string[] = () => []): ResolveDeps => ({
      mdfind,
      infoPlist: (app) => {
        const r = spawnSync("plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" });
        return r.status === 0 ? JSON.parse(r.stdout) as Record<string, unknown> : undefined;
      },
      dirs: [dir],
      listApps: (d) => readdirSync(d).flatMap((e) => (e.endsWith(".app") ? [join(d, e)] : readdirSync(join(d, e)).filter((x) => x.endsWith(".app")).map((x) => join(d, e, x)))),
    });
    return { dir, deps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test('"VRoid Studio" resolves to VRoidStudio.app by its bundle names when Spotlight finds nothing by that name', () => {
    const f = fakeApps();
    try {
      const hit = resolveApp("VRoid Studio", f.deps());
      expect(hit).toEqual({ path: join(f.dir, "VRoidStudio.app"), bundleId: "net.pixiv.vroid.macosx", name: "VRoid Studio", via: "bundle names" });
      expect(resolveApp("vroidstudio", f.deps())?.bundleId).toBe("net.pixiv.vroid.macosx");
      expect(resolveApp("Nested Tool", f.deps())?.bundleId).toBe("com.example.nested");
      expect(resolveApp("Missing App", f.deps())).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test("a bundle id resolves first, through Spotlight, and must match the bundle's own id", () => {
    const f = fakeApps();
    try {
      const spotlight = (q: string): string[] => (q === "kMDItemCFBundleIdentifier == 'net.pixiv.vroid.macosx'" ? [join(f.dir, "VRoidStudio.app")] : []);
      expect(resolveApp("net.pixiv.vroid.macosx", f.deps(spotlight))).toMatchObject({ bundleId: "net.pixiv.vroid.macosx", via: "bundle id" });
      // Spotlight naming a bundle with a different id is not trusted.
      expect(resolveApp("com.example.liar", f.deps(() => [join(f.dir, "Other.app")]))).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test("LaunchServices by display name comes before the folder scan, and its hit must carry the name", () => {
    const f = fakeApps();
    try {
      const queries: string[] = [];
      const spotlight = (q: string): string[] => { queries.push(q); return q.includes("kMDItemDisplayName == 'VRoid Studio*'cd") ? [join(f.dir, "VRoidStudio.app")] : []; };
      expect(resolveApp("VRoid Studio", f.deps(spotlight))).toMatchObject({ via: "LaunchServices", bundleId: "net.pixiv.vroid.macosx" });
      expect(queries[0]).toContain("kMDItemContentType == 'com.apple.application-bundle'");
      // A display-name hit whose names don't match (a prefix match on something else) falls through to the scan.
      expect(resolveApp("Other", f.deps(() => [join(f.dir, "VRoidStudio.app")]))).toMatchObject({ via: "bundle names", bundleId: "com.example.other" });
    } finally { f.cleanup(); }
  });

  test("helper log timestamps (log show --style ndjson) parse to epoch ms", () => {
    expect(parseLogTimestamp("2026-10-09 11:15:17.723456+0100")).toBe(Date.parse("2026-10-09T10:15:17.723Z"));
    expect(Number.isNaN(parseLogTimestamp("junk"))).toBe(true);
  });
});
