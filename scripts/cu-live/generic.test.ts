// The generic app check's PLANNING, with no screen: which element is harmless, which field is editable, what undoes a
// press, the destructive-name denylist, the restore steps — run twice, as TypeScript and as the transpiled JavaScript
// the scripts carry into the sandboxed worker (`PLANNING`), so the two cannot drift.
import { describe, expect, test } from "bun:test";
import {
  describePlan, GENERIC_PRELUDE, genericScenario, installedQuery, isDestructiveName, looksLikeBundleId, offSpacePlan, offSpaceSkipReason, onDesktopPlan,
  parseApps, pickEditable, pickPressable, PLANNING, refCount, restorePlan, SCRIPTS, secureFocused, TYPE_MARKER, type PlanElement,
} from "./generic";
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

  test("installed lookups and the plan line", () => {
    expect(looksLikeBundleId("com.microsoft.VSCode")).toBe(true);
    expect(looksLikeBundleId("VRoid Studio")).toBe(false);
    expect(installedQuery("com.google.Chrome")).toBe("kMDItemCFBundleIdentifier == 'com.google.Chrome'");
    expect(installedQuery("VRoid Studio")).toContain("kMDItemDisplayName == 'VRoid Studio.app'");
    expect(describePlan({ query: "VRoid Studio", key: "app0" })).toContain("off-Space via its full-screen button only if the run launched it");
  });

  test("helper log timestamps (log show --style ndjson) parse to epoch ms", () => {
    expect(parseLogTimestamp("2026-10-09 11:15:17.723456+0100")).toBe(Date.parse("2026-10-09T10:15:17.723Z"));
    expect(Number.isNaN(parseLogTimestamp("junk"))).toBe(true);
  });
});
