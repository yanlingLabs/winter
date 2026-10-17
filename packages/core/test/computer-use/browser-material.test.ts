// A Material-STYLE web app in a tab (our own minimal shapes of the ARIA patterns such component libraries use — no
// library code): an ARIA select (a combo box whose list box is drawn in an overlay at the end of the document), check
// boxes built from `role=checkbox` + `aria-checked` or drawn over a hidden native input, radios, a text field and a
// long text area, and a "Select file" button whose handler clicks a hidden file input.
//
// Two layers, as for the rest of the page runtime: the DECISIONS (`page-runtime/widgets.ts`) as pure functions over
// the facts the runtime reads off such markup; and the ENGINE's flows over the fake transport (whose scripted page
// plays what the runtime answers). The runtime's DOM glue itself runs only against a real Chromium (`e2e:browser`).
import { describe, expect, test } from "bun:test";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import { AutomationFailure } from "../../src/computer-use/errors";
import {
  ambiguousOptionSentence, capValue, checkedStateOf, comboShows, countPoints, matchOption, nameFromContent, NAME_FROM_CONTENT_ROLES, noOptionSentence, prefixPoints, pressTookEffect, valueWithLength, WHOLE_VALUE_CAP,
} from "../../src/computer-use/browser/page-runtime/widgets";
import { quote } from "../../src/computer-use/browser/state-format";
import type { FakePage } from "./browser-fake-transport";
import { harness } from "./browser-harness";

const LONG = "a".repeat(250);

/** The page as the runtime reads it (ids in tree order, so refs equal ids after the first state). */
const PAGE: FakePage = {
  url: "https://console.example.com/listing", title: "Store listing",
  nodes: [
    { id: 1, role: "main", children: [
      // <div role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="lang-label">English</div>
      { id: 2, role: "combo box", name: "Language", value: "English", states: ["collapsed"] },
      // <div role="checkbox" aria-checked="false">Accept the terms</div>
      { id: 3, role: "check box", name: "Accept the terms", states: ["unchecked"] },
      // a box whose press the page does not take where Winter presses
      { id: 4, role: "check box", name: "Mature content", states: ["unchecked"] },
      // <div class="checkbox-wrapper"> (no role) holding <input type="checkbox" style="opacity:0"> + its label
      { id: 5, role: "group", name: "Notify me" },
      { id: 6, role: "check box", name: "Notify me", states: ["unchecked"] },
      { id: 7, role: "radio button", name: "Public", states: ["checked"] },
      { id: 8, role: "radio button", name: "Unlisted", states: ["unchecked"] },
      { id: 9, role: "text field", name: "Title" },
      { id: 10, role: "text area", name: "Description", value: LONG },
      // <button>Select file</button> whose click handler calls a hidden <input type="file">'s click()
      { id: 11, role: "button", name: "Select file" },
    ] },
    // The open list, drawn in an overlay container at the end of <body> (read only while it is open).
    { id: 12, role: "list box", name: "Language", children: [
      { id: 13, role: "option", name: "English" }, { id: 14, role: "option", name: "French" }, { id: 15, role: "option", name: "German" },
    ] },
  ],
  editable: [9, 10],
  combos: { 2: { value: "English", options: [{ id: 13, text: "English" }, { id: 14, text: "French" }, { id: 15, text: "German" }] } },
  stuckChecks: [4],
  checkControls: { 5: 6 },
  tabOrder: [9, 10, 3, 11],
  fileChooserButtons: { 11: 16 },
  fileInputs: [16],
};

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

async function opened(page: Partial<FakePage> = {}) {
  const h = harness();
  const pg: FakePage = { ...PAGE, ...page };
  h.winter.pages[pg.url] = pg;
  const r = h.run();
  const tab = await h.engine.global(r.scope, "browsers.open", { url: pg.url }) as TabHandle;
  const p = (primitive: string, args: Record<string, unknown> = {}) => h.engine.primitive(r.scope, tab.targetId, primitive, args);
  const presses = (): Array<{ x: number; y: number }> => h.winter.sent.filter((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mousePressed").map((x) => ({ x: Number(x.params.x), y: Number(x.params.y) }));
  const keys = (): string[] => h.winter.sent.filter((x) => x.method === "Input.dispatchKeyEvent" && x.params.type !== "keyUp").map((x) => String(x.params.key));
  return { h, r, tab, p, presses, keys };
}

describe("the widget rules (pure, over Material-shaped facts)", () => {
  test("a check box or radio is named by its content (ARIA name from content), as buttons and options are", () => {
    // <div role="checkbox" aria-checked="false">Accept the terms</div> reads `check box "Accept the terms"` — before
    // (the leftover probes on a real Chromium, 2026-10-13) it read `check box (unchecked)` with its text as a child,
    // and find({ name: "Accept the terms" }) missed it.
    for (const role of ["checkbox", "radio", "switch", "button", "link", "option", "menuitemcheckbox", "menuitemradio"]) expect(nameFromContent(role)).toBe(true);
    // Never a field, a select or a container: their content is their value or their children.
    for (const role of ["textbox", "searchbox", "combobox", "listbox", "group", "list", "dialog", "slider", "spinbutton"]) expect(nameFromContent(role)).toBe(false);
    expect(nameFromContent(undefined)).toBe(false);
    expect(NAME_FROM_CONTENT_ROLES.has("checkbox") && NAME_FROM_CONTENT_ROLES.has("radio")).toBe(true);
  });

  test("checked: a native control's own state; a wrapper's aria-checked, else the native input it wraps or labels", () => {
    expect(checkedStateOf({ ariaChecked: "true" })).toBe("checked");
    expect(checkedStateOf({ ariaChecked: "false" })).toBe("unchecked");
    expect(checkedStateOf({ ariaChecked: "mixed" })).toBe("mixed");
    expect(checkedStateOf({ ariaChecked: null })).toBe("unchecked");
    // The wrapped-input shape: a role-less wrapper (or a role=checkbox with no aria-checked) over a hidden native input.
    expect(checkedStateOf({ ariaChecked: null, native: { checked: true, indeterminate: false } })).toBe("checked");
    expect(checkedStateOf({ ariaChecked: null, native: { checked: false, indeterminate: true } })).toBe("mixed");
    // A stated aria-checked is what a screen reader hears: it wins on a wrapper…
    expect(checkedStateOf({ ariaChecked: "false", native: { checked: true, indeterminate: false } })).toBe("unchecked");
    // …but never on the native control itself.
    expect(checkedStateOf({ ariaChecked: "false", native: { checked: true, indeterminate: false }, nativeIsSelf: true })).toBe("checked");
    expect(pressTookEffect("checkbox", false, true)).toBe(true);
    expect(pressTookEffect("checkbox", false, false)).toBe(false);
    expect(pressTookEffect("radio", true, true)).toBe(true);
    expect(pressTookEffect("radio", false, false)).toBe(false);
  });

  test("options: the visible text (case and spacing aside), else the value, else a containing text; the refusal names them", () => {
    const opts = [{ text: "English (United States)", value: "en-US" }, { text: "French", value: "fr" }, { text: "German", value: "de", disabled: true }];
    const pick = (want: string) => { const m = matchOption(opts, want); return "option" in m ? m.option.value : m; };
    expect(pick("  french ")).toBe("fr");
    expect(pick("EN-us")).toBe("en-US");
    expect(pick("united")).toBe("en-US");
    expect(pick("Klingon")).toEqual({ none: true });
    expect(pick("  ")).toEqual({ none: true });
    expect(noOptionSentence("Klingon", opts)).toBe('no option "Klingon" — the options are: "English (United States)", "French", "German"');
    expect(noOptionSentence("x", [])).toBe('no option "x" — the options are: (it lists none)');
    expect(comboShows("  French ", "french")).toBe(true);
    // Option texts containing one another, both ways: never "shown" by containment.
    expect(comboShows("Extra Small", "Small")).toBe(false);
    expect(comboShows("Small", "Extra Small")).toBe(false);
    expect(comboShows("Extra Small", "extra  small")).toBe(true);
    expect(comboShows("English", "French")).toBe(false);
    expect(comboShows(undefined, "French")).toBe(false);
  });

  test("a long value: cut at the cap by characters (never half a surrogate pair), with its length and where it reads whole", () => {
    expect(countPoints("a😀b")).toBe(3);
    expect(prefixPoints("a😀b", 2)).toBe("a😀");
    expect(capValue("abc", 200)).toEqual({ value: "abc" });
    expect(capValue("😀".repeat(201), 200)).toEqual({ value: "😀".repeat(200), length: 201 });
    expect(valueWithLength(5, LONG, undefined, 200, quote)).toBe(`"${"a".repeat(200)}…" (250 characters — state({within:5}) shows it whole)`);
    // The runtime cut it already and said how long it was.
    expect(valueWithLength(5, "a".repeat(200), 250, 200, quote)).toBe(`"${"a".repeat(200)}…" (250 characters — state({within:5}) shows it whole)`);
    // A within read's own cut has nowhere further to point.
    expect(valueWithLength(5, "b".repeat(WHOLE_VALUE_CAP), 9_000, WHOLE_VALUE_CAP, quote)).toBe(`"${"b".repeat(WHOLE_VALUE_CAP)}…" (9000 characters)`);
    expect(valueWithLength(5, "short", undefined, 200, quote)).toBe('"short"');
    // Past 8,000 a within read shows only its first 8,000 — never "whole" (the app path's wording).
    expect(valueWithLength(5, "c".repeat(200), 9_000, 200, quote)).toBe(`"${"c".repeat(200)}…" (9000 characters — state({within:5}) shows its first 8000)`);
  });
});

describe("A: an ARIA select (a combo box whose list is drawn elsewhere)", () => {
  test("reads as a combo box with its value; setValue opens it, presses the option, and the combo box shows it", async () => {
    const { r, p, presses } = await opened();
    expect(r.text()).toContain('[2] combo box "Language" value="English" (collapsed)');
    const before = presses().length;
    await p("setValue", { ref: 2, value: "french" });
    // One press opens the list, one presses "French" (its option's own point).
    expect(presses().slice(before)).toEqual([{ x: 20, y: 10 }, { x: 140, y: 70 }]);
    expect(await p("state", { full: true, emit: false })).toContain('[2] combo box "Language" value="French"');
  });

  test("no option matches: the list Winter opened is closed again and the refusal names the options", async () => {
    const { p, keys } = await opened();
    const e = await failure(p("setValue", { ref: 2, value: "Klingon" }));
    expect(e.message).toBe('[2]: no option "Klingon" — the options are: "English", "French", "German"');
    expect(keys()).toContain("Escape");
  });

  test("honest when the page does not take it: a list that never opens, an option press the combo box does not show", async () => {
    const shut = await opened({ combos: { 2: { value: "English", options: PAGE.combos![2]!.options, noOpen: true } } });
    expect((await failure(shut.p("setValue", { ref: 2, value: "French" }))).message).toBe("[2]: pressing the combo box did not open its list — state() shows what it did");
    const stuck = await opened({ combos: { 2: { value: "English", options: PAGE.combos![2]!.options, stuck: true } } });
    expect((await failure(stuck.p("setValue", { ref: 2, value: "French" }))).message)
      .toBe('[2]: pressed the option "French" but the combo box shows "English" — state() shows what happened');
  });
});

describe("A: options that contain one another", () => {
  const SIZES = { 2: { value: "Extra Small", options: [{ id: 13, text: "Small" }, { id: 14, text: "Extra Small" }, { id: 15, text: "Small Business" }] } };
  test("a combo box still showing \"Extra Small\" does not confirm \"Small\" (the page ignored the press)", async () => {
    const { p } = await opened({ combos: { 2: { ...SIZES[2], stuck: true } } });
    expect((await failure(p("setValue", { ref: 2, value: "Small" }))).message)
      .toBe('[2]: pressed the option "Small" but the combo box shows "Extra Small" — state() shows what happened');
  });

  test("a partial text names an option only when it is the one match; an ambiguous one is refused naming the candidates", async () => {
    expect(ambiguousOptionSentence("sm", [{ text: "Small" }, { text: "Small Business" }])).toBe('"sm" matches more than one option: "Small", "Small Business" — give the whole option text');
    const opts = SIZES[2].options;
    const m = matchOption(opts, "small b");
    expect("option" in m && m.option.text).toBe("Small Business");
    expect(matchOption(opts, "smal")).toEqual({ ambiguous: [opts[0]!, opts[2]!] });
    expect(matchOption(opts, "xtra")).toEqual({ option: opts[1]! });
    const { p } = await opened({ combos: SIZES });
    expect((await failure(p("setValue", { ref: 2, value: "smal" }))).message)
      .toBe('[2]: "smal" matches more than one option: "Small", "Small Business" — give the whole option text');
  });
});

describe("B: check boxes and radios built over ARIA or a hidden native input", () => {
  test("click() toggles a role=checkbox and states() says checked; a press the page did not take is said", async () => {
    const { r, p } = await opened();
    await p("click", { target: 3 });
    expect(await p("state", { full: true, emit: false })).toContain('[3] check box "Accept the terms" (checked)');
    expect(r.text()).not.toContain("is still");
    await p("click", { target: 4 });
    expect(r.text()).toContain("[4] still reads unchecked after the click — the page may not have taken the press there; state() shows what it did");
    // A radio already on stays on (no line); another one is checked by its press.
    await p("click", { target: 7 });
    await p("click", { target: 8 });
    expect(await p("state", { full: true, emit: false })).toContain('[8] radio button "Unlisted" (checked)');
    expect(r.text()).not.toMatch(/\[[78]\] is still/);
  });

  test("setValue(ref, bool) presses the native control a role-less wrapper holds, and refuses honestly when nothing changed", async () => {
    const { p, presses } = await opened();
    const before = presses().length;
    await p("setValue", { ref: 5, value: true });
    expect(presses().slice(before)).toEqual([{ x: 60, y: 30 }]); // [6]'s point, not the wrapper's
    expect(await p("state", { full: true, emit: false })).toContain('[6] check box "Notify me" (checked)');
  });

  test("setValue(ref, bool) on a slow page: a late flip is waited for; one that never comes is Uncertain, never a failure", async () => {
    const slow = await opened({ lateChecks: { 3: 1_200 } });
    await slow.p("setValue", { ref: 3, value: true });
    expect(await slow.p("state", { full: true, emit: false })).toContain('[3] check box "Accept the terms" (checked)');
    const { p } = await opened();
    const e = await failure(p("setValue", { ref: 4, value: true }));
    expect((e as AutomationFailure).kind).toBe("Uncertain");
    expect(e.message).toBe("[4] was pressed but still reads unchecked after 2.5 s — the page may apply it late or not have taken the press; check state() before pressing it again");
  });
});

describe("C: keys say what they did", () => {
  test("Tab names where the focus went, or that it did not move", async () => {
    const { r, p } = await opened();
    await p("key", { combo: "tab", into: 9 });
    expect(r.text()).toContain('pressed tab — the focus is now on [10] text area "Description"');
    const stuck = await opened({ stuckFocus: true });
    await stuck.p("key", { combo: "tab", into: 9 });
    expect(stuck.r.text()).toContain('pressed tab — the focus did not move (still [9] text field "Title")');
  });

  test("Space presses a focused check box (Return does not); cmd+a selects a field's whole text", async () => {
    const { r, p } = await opened();
    await p("key", { combo: "space", into: 3 });
    expect(r.text()).toContain('pressed space in [3] check box "Accept the terms" — it is now checked');
    await p("key", { combo: "return", into: 3 });
    expect(r.text()).toContain('pressed return in [3] check box "Accept the terms" — it did not change (still checked)');
    await p("type", { text: "hello", into: 9 });
    await p("key", { combo: "cmd+a", into: 9 });
    expect(r.text()).toContain('pressed cmd+a in [9] text field "Title" — all 5 characters are selected');
  });
});

describe("C/E follow-ups: a field that takes Tab, and the file-chooser wait only where one may open", () => {
  test("a Tab the field takes itself is not reported as ignored", async () => {
    const { r, p } = await opened({ tabInserts: [10] });
    await p("key", { combo: "tab", into: 10 });
    expect(r.text()).toContain('pressed tab — [10] text area "Description" took the key itself (its text changed; the focus stayed there)');
    expect(r.text()).not.toContain("the focus did not move");
  });

  test("an ordinary click does not wait for a file chooser (a late one is not pinned on it)", async () => {
    const { r, p } = await opened({ fileChooserButtons: {}, chooserFromAnyPress: 16 });
    await p("click", { target: 11 });
    expect(r.text()).not.toContain("the click opened the page's file chooser");
  });
});

describe("D: long values in a tab say their length; a within read shows them whole", () => {
  test("state() cuts at 200 with the helper's wording; state({ within }) shows it whole; find() says it too", async () => {
    const { r, p } = await opened();
    expect(r.text()).toContain(`[10] text area "Description" value="${"a".repeat(200)}…" (250 characters — state({within:10}) shows it whole)`);
    expect(await p("state", { within: 10, emit: false })).toContain(`[10] text area "Description" value="${LONG}"`);
    const found = await p("find", { query: "Description" }) as Array<{ ref: number; value?: string }>;
    expect(found[0]!.value).toBe(`${"a".repeat(200)}… (250 characters — state({within:10}) shows it whole)`);
    expect(r.text()).toMatch(/\n\[10\] text area "Description" value="a{200}…" \(250 characters — state\(\{within:10\}\) shows it whole\)/);
  });

  test("past 8,000 characters a within read cuts too, and says the length only", async () => {
    const huge = "b".repeat(9_000);
    const nodes = structuredClone(PAGE.nodes);
    nodes[0]!.children![8] = { id: 10, role: "text area", name: "Description", value: huge };
    const { p } = await opened({ nodes });
    expect(await p("state", { within: 10, emit: false })).toContain(`value="${"b".repeat(8_000)}…" (9000 characters)`);
  });
});

describe("E: a page's own \"Select file\" button", () => {
  test("the click's file chooser is said, naming the file input to upload() into; the next state's header names it too", async () => {
    const { r, p } = await opened();
    await p("click", { target: 11 });
    expect(r.text()).toContain("the click opened the page's file chooser — Winter held it, so nothing opened on screen; upload([16], paths) puts the files in (its file input)");
    expect(await p("state", { emit: false })).toContain("the page asked for a file — use upload([16], paths) on its file input");
  });
});
