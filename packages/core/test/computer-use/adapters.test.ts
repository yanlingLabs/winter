// ComputerV2 Phase 2 — app adapters, the pure parts: the adapter table (names, classes, caps, unique guide ids, version
// conditions), the dictionary wrappers (`adapters/dict.ts`: names, marshalling, the refusals of an unsafe `{ ref }`,
// unwrappable parameters, the listing), delivery (dedupe, compaction), the policy's `access` on an act, the worker's
// `extras`/`dict` Proxies, and every built-in adapter's AppleScript held to the helper's own source rules.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { AppAdapters, purposeFor } from "../../src/computer-use/adapters";
import { AdapterDelivery } from "../../src/computer-use/adapters/delivery";
import {
  asNumber, asString, buildDictSource, camelName, checkRef, DICT_LISTING_CAP, dictListing, generateDict, parseDictType,
} from "../../src/computer-use/adapters/dict";
import { appleScriptText } from "../../src/computer-use/adapters/apps/common";
import { mountFor, parseMounts, trashDialogReason, trashRefusal } from "../../src/computer-use/adapters/apps/finder";
import { noteHtml } from "../../src/computer-use/adapters/apps/notes";
import { CHROMIUM_BUNDLE_IDS } from "../../src/computer-use/adapters/apps/chromium";
import {
  AdapterRegistry, adapterProblems, BUILTIN_ADAPTERS, compareVersions, DOC_MAX_BYTES, GUIDE_MAX_BYTES, SUMMARY_MAX_CHARS,
} from "../../src/computer-use/adapters/registry";
import type { AdapterScope, AppAdapter, ExtraDef } from "../../src/computer-use/adapters/types";
import { AutomationFailure } from "../../src/computer-use/errors";
import { ComputerPolicy, newRunGrants, type SessionFacts } from "../../src/computer-use/policy";
import type { ScriptingCommandsResult } from "../../src/computer-use/protocol";
import type { WorkerToHost } from "../../src/computer-use/worker/bridge";
import { createAutomationRuntime, type AutomationRuntime } from "../../src/computer-use/worker/runtime";
import { referenceProblems } from "./adapter-refs";
import type { Settings } from "../../src/settings";

const noop = async (): Promise<unknown> => undefined;
const extra = (over: Partial<ExtraDef> = {}): ExtraDef => ({ name: "go", access: "view", signature: "go(): Promise<void>", summary: "does it", run: noop, ...over });

// ── the table ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("an AppleScript result as the helper answers it (its display form)", () => {
  test("a string comes back as the string itself; any other value as displayed; a cut string is decoded", () => {
    // OSAScript.executeAndReturnDisplayValue's real answer for "TEXT:" & "a\"b" & tab & "c" & linefeed & "d\\e" & return & "f é 🎉".
    expect(appleScriptText("\"TEXT:a\\\"b\tc\nd\\\\e\rf é 🎉\"")).toBe("TEXT:a\"b\tc\nd\\e\rf é 🎉");
    // The user's "escape tabs and line breaks" preference: the escaped forms decode the same.
    expect(appleScriptText("\"a\\tb\\nc\\rd\"")).toBe("a\tb\nc\rd");
    // A literal backslash before a t stays one (it is always escaped itself).
    expect(appleScriptText("\"C:\\\\temp\"")).toBe("C:\\temp");
    expect(appleScriptText("\"\"")).toBe("");
    for (const other of ["true", "5", "{1, 2}", "date \"Saturday, 10 October 2026\"", "missing value"]) expect(appleScriptText(other)).toBe(other);
    expect(appleScriptText(null)).toBeNull();
    // Cut at the helper's cap: no closing quote (and possibly half an escape).
    expect(appleScriptText("\"TEXT:abc")).toBe("TEXT:abc");
    expect(appleScriptText("\"TEXT:ab\\")).toBe("TEXT:ab");
  });
});

describe("the adapter table", () => {
  test("the built-in table is valid: caps, names, classes, unique guide ids", () => {
    expect(adapterProblems(BUILTIN_ADAPTERS)).toEqual([]);
    const ids = BUILTIN_ADAPTERS.flatMap((a) => (a.guide === undefined ? [] : [a.guide.id]));
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of BUILTIN_ADAPTERS) {
      if (a.guide !== undefined) expect(Buffer.byteLength(a.guide.text)).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
      for (const e of a.extras) {
        expect(e.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
        if (e.doc !== undefined) expect(Buffer.byteLength(e.doc)).toBeLessThanOrEqual(DOC_MAX_BYTES);
        expect(e.signature.startsWith(`${e.name}(`)).toBe(true);
      }
    }
  });

  test("the built-in extras exist with their classes (never renamed)", () => {
    const r = new AdapterRegistry();
    const classes = (bundleId: string): Record<string, string> => Object.fromEntries(r.find(bundleId)!.extras.map((e) => [e.name, e.access]));
    expect(classes("com.apple.finder")).toEqual({ reveal: "click", selection: "view", trash: "full", openWith: "full" });
    expect(classes("com.apple.Safari")).toEqual({ tabs: "view", currentURL: "view", pageText: "view", openURL: "full", openWindow: "full" });
    expect(r.find("com.apple.SafariTechnologyPreview")).toBe(r.find("com.apple.Safari"));
    expect(classes("com.apple.mail")).toEqual({ messages: "view", unreadCount: "view", compose: "full" });
    expect(classes("com.apple.Notes")).toEqual({ list: "view", read: "view", search: "view", create: "full" });
    expect(classes("com.apple.dt.Xcode")).toMatchObject({ schemes: "view", build: "full" });
    // The Chromium family: a guide and NO extras — its scripting cannot name the bound window exactly, and Winter never
    // guesses which window to act in.
    for (const id of ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser", "org.chromium.Chromium"]) {
      expect(CHROMIUM_BUNDLE_IDS).toContain(id as never);
      expect(classes(id)).toEqual({});
      expect(r.find(id)?.guide?.id).toBe("chromium@2");
    }
    // Bundle ids are matched exactly (case aside), never by display name.
    expect(r.find("Finder")).toBeUndefined();
    expect(r.find("COM.APPLE.FINDER")).toBe(r.find("com.apple.finder"));
  });

  test("a bad table fails loudly: names, classes, caps, duplicate guide ids, two unconditioned adapters for one app", () => {
    const base: AppAdapter = { bundleIds: ["com.example.a"], guide: { id: "a@1", text: "x" }, extras: [extra()] };
    expect(adapterProblems([{ ...base, extras: [extra({ name: "Bad-name" })] }]).join()).toContain("not allowed");
    expect(adapterProblems([{ ...base, extras: [extra({ name: "then" })] }]).join()).toContain("not allowed");
    expect(adapterProblems([{ ...base, extras: [extra({ name: "dict" })] }]).join()).toContain("not allowed");
    expect(adapterProblems([{ ...base, extras: [extra(), extra()] }]).join()).toContain("twice");
    expect(adapterProblems([{ ...base, extras: [extra({ access: "admin" as never })] }]).join()).toContain("access class");
    expect(adapterProblems([{ ...base, extras: [extra({ summary: "x".repeat(121) })] }]).join()).toContain("summary");
    expect(adapterProblems([{ ...base, extras: [extra({ doc: "é".repeat(301) })] }]).join()).toContain("doc");
    expect(adapterProblems([{ ...base, guide: { id: "a@1", text: "x".repeat(2_001) } }]).join()).toContain("guide a@1");
    expect(adapterProblems([{ ...base, guide: { id: "a", text: "x" } }]).join()).toContain("<key>@<rev>");
    expect(adapterProblems([base, { ...base, bundleIds: ["com.example.b"] }]).join()).toContain("used twice");
    expect(adapterProblems([base, { ...base, guide: { id: "a@2", text: "y" } }]).join()).toContain("without version conditions");
    expect(() => new AdapterRegistry([{ ...base, extras: [extra({ name: "x y" })] }])).toThrow("invalid");
  });

  test("version conditions: per dot component, an unknown version never matches a conditioned adapter", () => {
    expect(compareVersions("10.2", "10.10")).toBe(-1);
    expect(compareVersions("26.0", "26")).toBe(0);
    expect(compareVersions("16.1.2", "16.1")).toBe(1);
    const old: AppAdapter = { bundleIds: ["com.example.v"], versions: { max: "15.99" }, guide: { id: "v@1", text: "old" }, extras: [] };
    const cur: AppAdapter = { bundleIds: ["com.example.v"], versions: { min: "16" }, guide: { id: "v@2", text: "new" }, extras: [] };
    const r = new AdapterRegistry([old, cur]);
    expect(r.find("com.example.v", "15.4")).toBe(old);
    expect(r.find("com.example.v", "16.0.1 (beta)")).toBe(cur);
    expect(r.find("com.example.v")).toBeUndefined();
    expect(r.versioned("com.example.v")).toBe(true);
    expect(r.versioned("com.apple.finder")).toBe(false);
  });
});

// ── the dictionary wrappers ───────────────────────────────────────────────────────────────────────────────────

const COMMANDS: ScriptingCommandsResult = {
  scriptable: true, bundleVersion: "42",
  commands: [
    { name: "check for new mail", suite: "Mail", eventCode: "emalchma", description: "Triggers a check for email.", params: [{ name: "for", type: "account", optional: true }] },
    { name: "reveal", suite: "Finder", eventCode: "miscmvis", direct: { type: "specifier", optional: false }, params: [] },
    { name: "close", suite: "Standard", eventCode: "coreclos", direct: { type: "specifier", optional: false }, params: [
      { name: "saving", type: "save options", optional: true, enumerators: ["yes", "no", "ask"] },
      { name: "saving in", type: "file", optional: true },
    ] },
    { name: "make", suite: "Standard", eventCode: "corecrel", params: [
      { name: "new", type: "type", optional: false }, { name: "at", type: "location specifier", optional: true },
      { name: "with properties", type: "record", optional: true },
    ] },
    { name: "import thing", suite: "X", eventCode: "xxxximpt", params: [{ name: "data", type: "record", optional: false }] },
    { name: "set when", suite: "X", eventCode: "xxxxwhen", direct: { type: "date", optional: false }, params: [] },
    { name: "open", suite: "Standard", eventCode: "aevtodoc", direct: { type: "file | list of file", optional: false }, params: [] },
    { name: "Open", suite: "X", eventCode: "xxxxopn2", params: [] },
    { name: "then", suite: "X", eventCode: "xxxxthen", params: [] },
    { name: "run", suite: "Standard", eventCode: "aevtoapp", params: [] },
    { name: "activate", suite: "Standard", eventCode: "miscactv", params: [] },
    { name: "do JavaScript", suite: "Safari", eventCode: "sfridojs", direct: { type: "text", optional: false }, params: [] },
    { name: "execute", suite: "Chromium", eventCode: "CrSuExJa", direct: { type: "specifier", optional: false }, params: [{ name: "javascript", type: "text", optional: false }] },
    { name: "go somewhere", suite: "X", eventCode: "GURLGURL", direct: { type: "text", optional: false }, params: [] },
    { name: "launch app", suite: "X", eventCode: "xxxxlnch", params: [] },
    { name: "search", suite: "X", eventCode: "xxxxsrch", params: [
      { name: "for", type: "text", optional: false }, { name: "limit", type: "integer", optional: true },
      { name: "exact", type: "boolean", optional: true }, { name: "tags", type: "list of text", optional: true },
    ] },
    { name: "bad", suite: "X", eventCode: "short", params: [] },
  ],
};

describe("dictionary wrappers: names and what is wrapped", () => {
  const info = generateDict(COMMANDS);
  const names = info.commands.map((c) => c.name);

  test("terminology in camelCase; a collision or a name every object answers gets the suffix 2", () => {
    expect(camelName("check for new mail")).toBe("checkForNewMail");
    expect(camelName("GetURL")).toBe("getURL");
    expect(names).toContain("checkForNewMail");
    expect(names).toContain("open");
    expect(names).toContain("open2"); // "Open" → open, taken
    expect(names).toContain("then2"); // `then` would make every handle a thenable
    expect(names).not.toContain("then");
    for (const n of names) expect(n).toMatch(/^[a-z][A-Za-z0-9]{0,47}$/);
  });

  test("dropped: run/activate, the helper's refused doors (JavaScript, open location), a bad event code, app/tell words", () => {
    for (const gone of ["run", "activate", "doJavaScript", "execute", "goSomewhere", "bad"]) expect(names).not.toContain(gone);
    expect(info.unwrapped.map((u) => u.term)).toContain("launch app");
  });

  test("a required parameter of another type means no wrapper (\"use applescript()\"); an optional one is not offered", () => {
    expect(names).not.toContain("importThing");
    expect(names).not.toContain("setWhen");
    expect(info.unwrapped.find((u) => u.term === "import thing")?.why).toContain('"data" parameter takes record');
    expect(info.unwrapped.find((u) => u.term === "set when")?.why).toContain("direct parameter takes date");
    const make = info.commands.find((c) => c.name === "make")!;
    expect(make.params.map((p) => p.key)).toEqual(["new", "at"]); // `with properties` (a record) left out
    const close = info.commands.find((c) => c.name === "close")!;
    expect(close.params.map((p) => p.key)).toEqual(["saving", "savingIn"]);
  });

  test("types: primitives, lists, alternatives, enumerations, the app's own classes as references", () => {
    expect(parseDictType("text")?.alts[0]?.kind).toBe("text");
    expect(parseDictType("list of text")?.alts[0]).toMatchObject({ kind: "text", list: true });
    expect(parseDictType("file | list of file")?.alts.map((a) => `${a.kind}${a.list ? "[]" : ""}`)).toEqual(["file", "file[]"]);
    expect(parseDictType("save options", ["yes", "no"])?.alts[0]).toMatchObject({ kind: "enum", enumerators: ["yes", "no"] });
    expect(parseDictType("message")?.alts[0]).toMatchObject({ kind: "ref", declared: "message" });
    expect(parseDictType("record")).toBeUndefined();
    expect(parseDictType("date | record")).toBeUndefined();
  });

  test("not scriptable, or an empty answer: no wrappers", () => {
    expect(generateDict({ scriptable: false, commands: [] }).commands).toEqual([]);
    expect(generateDict({ scriptable: true, commands: [] }).commands).toEqual([]);
  });
});

describe("dictionary wrappers: the source and its values", () => {
  const info = generateDict(COMMANDS);
  const cmd = (n: string) => info.commands.find((c) => c.name === n)!;

  test("tell application id \"<bundleId>\" / <terminology> <direct> <label value>… / end tell", () => {
    expect(buildDictSource("com.apple.finder", cmd("reveal"), [{ file: "/Users/x/My \"File\".txt" }]))
      .toBe('tell application id "com.apple.finder"\nreveal (POSIX file "/Users/x/My \\"File\\".txt")\nend tell');
    expect(buildDictSource("com.apple.mail", cmd("checkForNewMail"), [{ for: { ref: 'account "Work"' } }]))
      .toBe('tell application id "com.apple.mail"\ncheck for new mail for account "Work"\nend tell');
    expect(buildDictSource("com.apple.mail", cmd("checkForNewMail"), [])).toBe('tell application id "com.apple.mail"\ncheck for new mail\nend tell');
    expect(buildDictSource("x.y", cmd("close"), [{ ref: "document 1" }, { saving: "No", savingIn: { file: "/tmp/a" } }]))
      .toBe('tell application id "x.y"\nclose document 1 saving no saving in (POSIX file "/tmp/a")\nend tell');
    expect(buildDictSource("x.y", cmd("open"), [[{ file: "/a" }, { file: "/b" }]])).toContain("open {(POSIX file \"/a\"), (POSIX file \"/b\")}");
    expect(buildDictSource("x.y", cmd("make"), [{ new: { ref: "folder" }, at: { ref: "end of folders" } }])).toContain("make new folder at end of folders");
  });

  test("strings: backslash and quote escaped; newline, return and tab joined with variables set before the tell", () => {
    expect(asString('a"b\\c')).toBe('"a\\"b\\\\c"');
    const src = buildDictSource("x.y", cmd("search"), [{ for: "one\ntwo\tthree\rfour", limit: 5, exact: false, tags: ["a", "b"] }]);
    expect(src).toBe([
      "set winterLF to linefeed", "set winterCR to return", "set winterTAB to tab",
      'tell application id "x.y"',
      'search for ("one" & winterLF & "two" & winterTAB & "three" & winterCR & "four") limit 5 exact false tags {"a", "b"}',
      "end tell",
    ].join("\n"));
    expect(() => buildDictSource("x.y", cmd("search"), [{ for: "bell\u0007" }])).toThrow("control characters");
  });

  test("numbers: finite only, whole for an integer, negatives parenthesised, exponents as AppleScript writes them", () => {
    expect(asNumber(5, true)).toBe("5");
    expect(asNumber(-2.5, false)).toBe("(-2.5)");
    expect(asNumber(1e21, false)).toBe("1.0E+21");
    expect(asNumber(1.5e-7, false)).toBe("1.5E-7");
    expect(() => asNumber(Number.NaN, false)).toThrow("finite");
    expect(() => buildDictSource("x.y", cmd("search"), [{ for: "a", limit: 1.5 }])).toThrow("search()'s limit takes integer");
  });

  test("an enumeration takes one of its declared enumerators, emitted bare; anything else is refused", () => {
    expect(() => buildDictSource("x.y", cmd("close"), [{ ref: "window 1" }, { saving: "maybe" }])).toThrow('"yes" | "no" | "ask"');
  });

  test("{ file } is absolute only; a parameter refuses a value of the wrong type, an unknown key, a missing required one", () => {
    expect(() => buildDictSource("x.y", cmd("reveal"), [{ file: "relative/path" }])).toThrow("absolute");
    expect(() => buildDictSource("x.y", cmd("reveal"), ["just a string"])).toThrow("direct parameter takes");
    expect(() => buildDictSource("x.y", cmd("reveal"), [])).toThrow("needs its direct parameter");
    expect(() => buildDictSource("x.y", cmd("search"), [{}])).toThrow("needs { for }");
    expect(() => buildDictSource("x.y", cmd("search"), [{ for: "a", nope: 1 }])).toThrow('no parameter "nope"');
    expect(() => buildDictSource("x.y", cmd("checkForNewMail"), ["x", "y"])).toThrow("takes (params?)");
    expect(() => buildDictSource("bad id\"", cmd("checkForNewMail"), [])).toThrow("bundle id");
  });

  test("an unsafe { ref } is refused: another app, tell, raw codes, a comment, several lines, an open string, > 500 characters", () => {
    expect(checkRef('note "how to tell an app from an application"')).toBe('note "how to tell an app from an application"'); // inside a string: fine
    for (const bad of [
      'application "Terminal"', "window 1 of app \"Mail\"", "x\ntell", "«class ocid» 1", "<<class capp>>", "document 1 -- comment",
      "document 1 (* x *)", "note # x", 'note "open', "document 1 ¬", "x".repeat(501), "", "  ",
    ]) expect(() => checkRef(bad)).toThrow();
    expect(() => checkRef("tell window 1")).toThrow("tell");
    expect(() => checkRef(42)).toThrow("takes an AppleScript reference");
  });

  test("an optional direct parameter: a lone plain object is the parameters", () => {
    const res: ScriptingCommandsResult = { scriptable: true, commands: [{ name: "empty", suite: "F", eventCode: "fndrempt", direct: { type: "specifier", optional: true }, params: [{ name: "security", type: "boolean", optional: true }] }] };
    const empty = generateDict(res).commands[0]!;
    expect(buildDictSource("com.apple.finder", empty, [{ security: true }])).toContain("\nempty security true\n");
    expect(buildDictSource("com.apple.finder", empty, [{ ref: "trash" }])).toContain("\nempty trash\n");
    expect(buildDictSource("com.apple.finder", empty, [])).toContain("\nempty\n");
  });

  test("help(\"dict\"): every wrapper with its parameters, the unwrapped ones with \"use applescript()\", a search, the 6,000-byte cap", () => {
    const text = dictListing("Mail", info);
    expect(text).toContain("checkForNewMail({ for?: ref<account> }) — Triggers a check for email.");
    expect(text).toContain("close(direct: ref<specifier>, { saving?: \"yes\" | \"no\" | \"ask\", savingIn?: { file } })");
    expect(text).toContain("import thing — use applescript() (its \"data\" parameter takes record)");
    expect(dictListing("Mail", info, "mail")).toContain("checkForNewMail");
    expect(dictListing("Mail", info, "mail")).not.toContain("reveal(");
    expect(dictListing("Mail", info, "zzz")).toContain("nothing matches");
    const many: ScriptingCommandsResult = { scriptable: true, commands: Array.from({ length: 300 }, (_v, i) => ({ name: `do thing number ${i}`, suite: "X", eventCode: `xx${String(i).padStart(6, "0")}`, description: "d".repeat(150), params: [] })) };
    const cut = dictListing("Big", generateDict(many));
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(DICT_LISTING_CAP);
    expect(cut).toContain("narrow it with { search }");
    expect(dictListing("TextEdit", generateDict({ scriptable: false, commands: [] }))).toContain("is not scriptable");
  });
});

// ── delivery ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("delivery", () => {
  test("once per session per bundle id; forgotten on a MAIN-thread compaction and on clearSession", () => {
    const d = new AdapterDelivery();
    d.mark("s1", "com.apple.finder");
    expect(d.has("s1", "COM.APPLE.FINDER")).toBe(true);
    expect(d.has("s2", "com.apple.finder")).toBe(false);
    d.observe({ type: "continuity_warning", sessionId: "s1", threadId: "sub-1", warning: "compacted" } as unknown as SessionEvent);
    expect(d.has("s1", "com.apple.finder")).toBe(true);
    d.observe({ type: "continuity_warning", sessionId: "s1", warning: "other" } as unknown as SessionEvent);
    expect(d.has("s1", "com.apple.finder")).toBe(true);
    d.observe({ type: "continuity_warning", sessionId: "s1", threadId: "main", warning: "compacted" } as unknown as SessionEvent);
    expect(d.has("s1", "com.apple.finder")).toBe(false);
    d.mark("s1", "com.apple.finder");
    d.clearSession("s1");
    expect(d.has("s1", "com.apple.finder")).toBe(false);
  });
});

// ── the policy: an act's `access` ────────────────────────────────────────────────────────────────────────────

const FINDER = { bundleId: "com.apple.finder", name: "Finder" };
function policyFor(policy: SessionApprovalPolicy, apps: Record<string, unknown> = {}) {
  const approvals = new ApprovalBroker();
  const settings = { computerUse: { apps } } as unknown as Settings;
  const facts: SessionFacts = { policy, mode: "code" };
  return new ComputerPolicy({ settings: () => settings, saveAlwaysGrant: () => {}, approvals, emit: () => {}, session: () => facts, attended: () => true });
}
async function kindOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return e instanceof AutomationFailure ? `${e.kind}: ${e.message}` : String(e); }
}

describe("access classes through the policy", () => {
  test("view → observe; click → act at click; full → act at full", () => {
    expect(purposeFor("view", "extras.x")).toEqual({ kind: "observe" });
    expect(purposeFor("click", "extras.x")).toEqual({ kind: "act", primitive: "extras.x", access: "click" });
    expect(purposeFor("full", "extras.x")).toEqual({ kind: "act", primitive: "extras.x", access: "full" });
  });

  test("a click-only app: click extras run, full ones are NotAllowed naming the extra; a view-only app: only view", async () => {
    const click = policyFor("bypass", { "com.apple.finder": { access: "click" } });
    const run = newRunGrants("s1");
    expect(await kindOf(click.authorize(run, FINDER, purposeFor("click", "extras.reveal")))).toBe("ok");
    expect(await kindOf(click.authorize(run, FINDER, purposeFor("view", "extras.selection")))).toBe("ok");
    expect(await kindOf(click.authorize(run, FINDER, purposeFor("full", "extras.trash")))).toContain("NotAllowed: Finder is set to click only");
    expect(await kindOf(click.authorize(run, FINDER, purposeFor("full", "extras.trash")))).toContain("extras.trash does not");
    // The access replaces the primitive lookup: a "click"-named full extra is still full.
    expect(await kindOf(click.authorize(run, FINDER, { kind: "act", primitive: "click", access: "full" }))).toContain("NotAllowed");
    const view = policyFor("bypass", { "com.apple.finder": { access: "view" } });
    expect(await kindOf(view.authorize(run, FINDER, purposeFor("view", "extras.selection")))).toBe("ok");
    expect(await kindOf(view.authorize(run, FINDER, purposeFor("click", "extras.reveal")))).toContain("view only");
    const deny = policyFor("bypass", { "com.apple.finder": { access: "deny" } });
    expect(await kindOf(deny.authorize(run, FINDER, purposeFor("view", "extras.selection")))).toContain("Don't allow");
  });

  test("plan observes only; dont-ask needs an Always grant; bypass runs everything", async () => {
    const run = newRunGrants("s1");
    expect(await kindOf(policyFor("plan").authorize(run, FINDER, purposeFor("view", "extras.selection")))).toBe("ok");
    expect(await kindOf(policyFor("plan").authorize(run, FINDER, purposeFor("click", "extras.reveal")))).toContain("plan mode");
    expect(await kindOf(policyFor("dont-ask").authorize(run, FINDER, purposeFor("full", "extras.trash")))).toContain("no \"Always allow\" grant");
    expect(await kindOf(policyFor("dont-ask", { "com.apple.finder": { grant: "always" } }).authorize(run, FINDER, purposeFor("full", "extras.trash")))).toBe("ok");
    expect(await kindOf(policyFor("bypass").authorize(run, FINDER, purposeFor("full", "dict.delete")))).toBe("ok");
    expect(await kindOf(policyFor("bypass").authorize(run, { bundleId: "com.winter.app", name: "Winter" }, purposeFor("view", "extras.x")))).toContain("Refused");
  });
});

// ── the worker's Proxies ─────────────────────────────────────────────────────────────────────────────────────

function runtime(answer: (m: Extract<WorkerToHost, { op: "call" }>) => unknown) {
  const out: WorkerToHost[] = [];
  let rt!: AutomationRuntime;
  rt = createAutomationRuntime({
    post: (m) => {
      out.push(m);
      if (m.op === "call") setTimeout(() => rt.handle({ op: "reply", id: m.id, ok: true, value: answer(m) } as never), 1);
    },
  });
  const run = (runId: string, code: string): Promise<{ prints: string[]; error?: { name: string; message: string }; calls: Array<Extract<WorkerToHost, { op: "call" }>> }> => {
    const start = out.length;
    rt.handle({ op: "run", runId, code });
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        const mine = out.slice(start);
        const done = mine.find((m) => m.op === "done") as Extract<WorkerToHost, { op: "done" }> | undefined;
        if (done === undefined) return;
        clearInterval(tick);
        resolve({ prints: mine.filter((m) => m.op === "print").map((m) => (m as { text: string }).text), ...(done.error === undefined ? {} : { error: done.error }), calls: mine.filter((m) => m.op === "call") as never });
      }, 2);
    });
  };
  return { run };
}

describe("the worker: app.extras / app.dict / app.help", () => {
  const HANDLE = { targetId: "t1", name: "Finder", bundleId: "com.apple.finder", extras: [{ name: "reveal", access: "click" }, { name: "selection", access: "view" }], dict: ["reveal", "duplicate"] };

  test("a listed name is a function making one bridge call; the args are positional and JSON-plain", async () => {
    const { run } = runtime((m) => (m.primitive === "apps.open" ? HANDLE : m.primitive === "dict" ? { result: "ok" } : ["/a"]));
    const r = await run("r1", "const f = await apps.open('Finder')\nprint(await f.extras.selection())\nawait f.extras.reveal('/tmp', { deep: [1, 2] })\nprint(await f.dict.duplicate({ ref: 'item 1' }, { to: { file: '/b' } }))\nawait f.help('dict', { search: 'x', emit: false })");
    expect(r.error).toBeUndefined();
    const calls = r.calls.filter((c) => c.primitive !== "apps.open").map((c) => ({ p: c.primitive, t: c.target, a: c.args }));
    expect(calls).toEqual([
      { p: "extra", t: "t1", a: { name: "selection", args: [] } },
      { p: "extra", t: "t1", a: { name: "reveal", args: ["/tmp", { deep: [1, 2] }] } },
      { p: "dict", t: "t1", a: { name: "duplicate", args: [{ ref: "item 1" }, { to: { file: "/b" } }] } },
      { p: "help", t: "t1", a: { topic: "dict", search: "x", emit: false } },
    ]);
    expect(r.prints).toEqual(["[\n  \"/a\"\n]", "{\n  \"result\": \"ok\"\n}"]);
  });

  test("then, symbols, toJSON and unlisted names are never callable; has/ownKeys answer the list; nothing can be added", async () => {
    const { run } = runtime((m) => (m.primitive === "apps.open" ? HANDLE : undefined));
    const r = await run("r1", [
      "const f = await apps.open('Finder')",
      "print(typeof f.extras.then, typeof f.extras.toJSON, typeof f.extras[Symbol.iterator], typeof f.extras.nope, typeof f.dict.reveal)",
      "print('then' in f.extras, 'reveal' in f.extras, 'toString' in f.dict, Object.keys(f.extras).join(','), Object.keys(f.dict).join(','))",
      "const awaited = await f.extras",
      "print(awaited === f.extras, JSON.stringify(f.extras), JSON.stringify(f))",
      "f.extras.evil = () => 1",
      "print(typeof f.extras.evil)",
      "let threw = false; try { Object.defineProperty(f.dict, 'x', { value: 1 }) } catch { threw = true }",
      "print(threw, Object.isFrozen(f.extras))",
    ].join("\n"));
    expect(r.error).toBeUndefined();
    expect(r.prints).toEqual([
      "undefined undefined undefined undefined function",
      "false true false reveal,selection reveal,duplicate",
      "true {} {\"name\":\"Finder\",\"bundleId\":\"com.apple.finder\"}",
      "undefined",
      "true true",
    ]);
  });

  test("an app with nothing made for it has empty extras and dict", async () => {
    const { run } = runtime((m) => (m.primitive === "apps.open" ? { targetId: "t2", name: "Notes", bundleId: "com.apple.Notes" } : undefined));
    const r = await run("r1", "const n = await apps.open('Notes')\nprint(Object.keys(n.extras).length, Object.keys(n.dict).length, typeof n.help)");
    expect(r.prints).toEqual(["0 0 function"]);
  });
});

// ── the built-in adapters' own AppleScript, held to the helper's source rules ────────────────────────────────

/** A TS mirror of `CUAppleScriptPolicy.checkSource` (the helper is the check; this keeps Winter's own scripts clean):
 *  strings and comments out, then no bridge phrase, and every `application`/`app` names the bound app by id. */
function sourceProblems(source: string, bundleId: string): string[] {
  const strings: string[] = [];
  let code = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\"") {
      let s = "";
      for (i++; i < source.length && source[i] !== "\""; i++) { if (source[i] === "\\") i++; s += source[i]; }
      code += `\u0000${strings.length}\u0000`;
      strings.push(s);
    } else if (ch === "-" && source[i + 1] === "-") { while (i < source.length && source[i] !== "\n") i++; code += "\n"; }
    else code += ch;
  }
  const text = code.toLowerCase().replace(/\s+/g, " ");
  const problems: string[] = [];
  for (const phrase of ["use framework", "use script", "current application", "«", "<<", "activate", "do shell script", "display ", "do javascript", "execute", "open location", "delay", "run script", "load script", "choose ", "say ", "the clipboard", "system events", "keystroke"]) {
    if (text.includes(phrase)) problems.push(`uses "${phrase}"`);
  }
  for (const m of text.matchAll(/\b(?:application|app)\b\s*(id\s+)?(\S+)/g)) {
    const lit = /^\u0000(\d+)\u0000/.exec(m[2] ?? "");
    if (m[1] === undefined || lit === null || strings[Number(lit[1])]?.toLowerCase() !== bundleId.toLowerCase()) problems.push(`names an app other than application id "${bundleId}": ${m[0]}`);
  }
  if ((text.match(/\btell application id\b/g) ?? []).length !== 1) problems.push("not exactly one tell block");
  return problems;
}

/** The bound window's id the unit scopes report. */
const BOUND_WINDOW = 4242;
/** Every AppleScript an extra runs, with the given arguments, against a scope that answers with `answer` (a value, or
 *  one per script). */
async function scriptsOf(bundleId: string, def: ExtraDef, args: unknown[], answer: string | null | ((src: string, i: number) => string | null)): Promise<string[]> {
  const sources: string[] = [];
  const scope: AdapterScope = {
    app: { name: "App", bundleId, pid: 1 }, signal: new AbortController().signal, window: () => BOUND_WINDOW,
    applescript: async (src) => { sources.push(src); return typeof answer === "function" ? answer(src, sources.length - 1) : answer; },
    find: async () => [], snapshot: async () => "", act: async () => ({ rung: 1 }), waitFor: async () => ({ waitedMs: 0 }),
    openDocument: async () => ({ name: "TextEdit", bundleId: "com.apple.TextEdit" }), print: () => {}, say: () => {}, notice: () => {},
    clampWait: (ms) => Math.min(ms, 2_000), sleep: async () => true,
  };
  await def.run(scope, args);
  return sources;
}

describe("the built-in adapters' AppleScript", () => {
  const dir = mkdtempSync(join(tmpdir(), "winter-adapters-"));
  const file = join(dir, "a file \"quoted\".txt");
  writeFileSync(file, "x");
  /**
   * EVERY branch of every extra: its arguments, the workspaces it names, and what the fake app answers (per script).
   * Each generated script is held to the helper's source rules AND to the positive reference check: every window,
   * document and tab it touches is the bound window (window id BOUND_WINDOW) or an object the agent named.
   */
  const build = (src: string): string => (src.includes("set r to build d") ? "WS:App\tsar-1" : "App\tsucceeded\ttrue\t\n");
  const BRANCHES: Array<{ bundleId: string; extra: string; args: unknown[]; answer?: string | ((src: string) => string); workspaces?: string[] }> = [
    { bundleId: "com.apple.finder", extra: "reveal", args: [file], answer: "SELECTED" },
    { bundleId: "com.apple.finder", extra: "selection", args: [], answer: "SEL:file:///tmp/a.txt\n" },
    { bundleId: "com.apple.finder", extra: "trash", args: [[file]] },
    { bundleId: "com.apple.Safari", extra: "tabs", args: [] },
    { bundleId: "com.apple.Safari", extra: "currentURL", args: [], answer: "URL:https://x.test/" },
    { bundleId: "com.apple.Safari", extra: "pageText", args: [] },
    { bundleId: "com.apple.Safari", extra: "pageText", args: [{ tab: 2 }] },
    { bundleId: "com.apple.Safari", extra: "openURL", args: ["https://example.com/a?b=1"], answer: "TAB:3" },
    { bundleId: "com.apple.Safari", extra: "openURL", args: ["https://example.com/a", { newTab: false }], answer: "TAB:1" },
    { bundleId: "com.apple.Safari", extra: "openWindow", args: ["https://example.com/own"], answer: "WINDOW:77\tfalse" },
    { bundleId: "com.apple.mail", extra: "messages", args: [] },
    { bundleId: "com.apple.mail", extra: "messages", args: [{ unread: true }] },
    { bundleId: "com.apple.mail", extra: "messages", args: [{ mailbox: "Archive", limit: 5 }] },
    { bundleId: "com.apple.mail", extra: "unreadCount", args: [], answer: "3" },
    { bundleId: "com.apple.mail", extra: "compose", args: [{ to: ["a@example.com"], cc: "c@example.com", subject: "Hi \"there\"", body: "line 1\nline 2\ttab" }], answer: "12" },
    { bundleId: "com.apple.Notes", extra: "list", args: [] },
    { bundleId: "com.apple.Notes", extra: "list", args: [{ folder: "Work", limit: 3 }] },
    { bundleId: "com.apple.Notes", extra: "read", args: ["x-coredata://ABC-123/ICNote/p42"] },
    { bundleId: "com.apple.Notes", extra: "search", args: ["groceries"] },
    { bundleId: "com.apple.Notes", extra: "create", args: [{ title: "T", body: "one\ntwo" }] },
    { bundleId: "com.apple.Notes", extra: "create", args: [{ title: "T", body: "one", folder: "Work" }] },
    { bundleId: "com.apple.dt.Xcode", extra: "schemes", args: [] },
    { bundleId: "com.apple.dt.Xcode", extra: "build", args: [{ waitMs: 5_000 }], answer: build },
    { bundleId: "com.apple.dt.Xcode", extra: "build", args: [{ workspace: "App", waitMs: 5_000 }], answer: build, workspaces: ["App"] },
    { bundleId: "com.apple.dt.Xcode", extra: "buildStatus", args: [], answer: "App\tsucceeded\ttrue\t\n" },
    { bundleId: "com.apple.dt.Xcode", extra: "buildStatus", args: [{ id: "sar-1" }], answer: "App\tsucceeded\ttrue\t\n" },
    { bundleId: "com.apple.dt.Xcode", extra: "buildStatus", args: [{ workspace: "App" }], answer: "App\tsucceeded\ttrue\t\n", workspaces: ["App"] },
  ];

  test("the branch table covers every extra of every built-in adapter", () => {
    const covered = new Set(BRANCHES.map((b) => `${b.bundleId} ${b.extra}`));
    for (const a of BUILTIN_ADAPTERS) for (const e of a.extras) if (e.name !== "openWith") expect(covered).toContain(`${a.bundleIds[0]} ${e.name}`);
  });

  for (const b of BRANCHES) {
    test(`${b.bundleId} ${b.extra}(${JSON.stringify(b.args).slice(1, -1).slice(0, 60)}): the source rules, and every reference bound or named`, async () => {
      const def = BUILTIN_ADAPTERS.find((a) => a.bundleIds.includes(b.bundleId))!.extras.find((e) => e.name === b.extra)!;
      const sources = await scriptsOf(b.bundleId, def, b.args, b.answer ?? "1\t2\t3\t4");
      expect(sources.length).toBeGreaterThan(0);
      for (const src of sources) {
        expect(sourceProblems(src, b.bundleId)).toEqual([]);
        expect(referenceProblems(src, BOUND_WINDOW, { workspaces: b.workspaces ?? [] })).toEqual([]);
      }
    });
  }

  test("Notes' list and search read each note's folder on its own: one Notes can't name leaves the row's folder empty", async () => {
    const notes = BUILTIN_ADAPTERS.find((a) => a.bundleIds.includes("com.apple.Notes"))!;
    for (const [name, args] of [["list", []], ["search", ["groceries"]]] as const) {
      const def = notes.extras.find((e) => e.name === name)!;
      const [src] = await scriptsOf("com.apple.Notes", def, [...args], "");
      // Live: a note in Recently Deleted answered `name of container` with -1728 and failed the whole call.
      expect(src).toMatch(/set f to ""\n\s*try\n\s*set f to name of container of x\n\s*end try/);
      expect(src).not.toMatch(/winterText\(name of container of x\)/);
    }
  });

  test("Mail's messages() skips a message it can't read rather than failing the list", async () => {
    const def = BUILTIN_ADAPTERS.find((a) => a.bundleIds.includes("com.apple.mail"))!.extras.find((e) => e.name === "messages")!;
    const [src] = await scriptsOf("com.apple.mail", def, [], "");
    expect(src).toMatch(/set m to item i of ms\n\s*try\n\s*set out to out & \(id of m\)[^\n]*\n\s*end try/);
  });

  test("openWith runs no AppleScript (the service's background document open)", async () => {
    const def = BUILTIN_ADAPTERS[0]!.extras.find((e) => e.name === "openWith")!;
    expect(await scriptsOf("com.apple.finder", def, [file, "TextEdit"], null)).toEqual([]);
  });

  test("the positive check flags every reference that is not the bound window or a named object", () => {
    const ok = `tell application id "com.apple.Safari"\nset w to window id ${BOUND_WINDOW}\nset ct to current tab of w\nreturn URL of ct\nend tell`;
    expect(referenceProblems(ok, BOUND_WINDOW)).toEqual([]);
    for (const bad of [
      'tell application id "com.apple.Safari" to return URL of current tab of front window',
      'tell application id "com.apple.Safari" to return URL of front document',
      'tell application id "com.apple.Safari" to return URL of document 1',
      'tell application id "com.apple.Safari" to return URL of tab 1 of window 1',
      `tell application id "com.apple.Safari" to return URL of current tab of window id 999`,
      'tell application id "com.apple.dt.Xcode" to build workspace document 1',
      'tell application id "com.apple.dt.Xcode" to build workspace document "Other"',
      'tell application id "com.apple.finder" to return selection',
      'tell application id "com.apple.finder" to reveal (POSIX file "/tmp/x" as alias)\nreturn target of Finder window 1',
      "tell application id \"com.apple.Safari\"\nset w to window 1\nreturn URL of current tab of w\nend tell",
    ]) expect(referenceProblems(bad, BOUND_WINDOW, { workspaces: ["App"] }).length).toBeGreaterThan(0);
  });

  test("the mirror catches what the helper refuses", () => {
    expect(sourceProblems('tell application "Terminal"\nend tell', "x.y").length).toBeGreaterThan(0);
    expect(sourceProblems('tell application id "x.y"\nactivate\nend tell', "x.y")).toContain('uses "activate"');
    expect(sourceProblems('tell application id "x.y"\ndo shell script "ls"\nend tell', "x.y")).toContain('uses "do shell script"');
    expect(sourceProblems('tell application id "x.y"\nget name\nend tell', "x.y")).toEqual([]);
  });

  test("Finder's trash refuses system and home folders; Notes' HTML is escaped; bad arguments are TypeErrors", async () => {
    const home = "/Users/someone";
    for (const p of ["/", "/System/Library", "/Users", home, `${home}/Documents`, `${home}/.ssh/id_rsa`, `${home}/Library/Keychains/x`, `${home}/.winter-dev/x`]) {
      expect(trashRefusal(p, home)).toBeDefined();
    }
    expect(trashRefusal(`${home}/Documents/old.txt`, home)).toBeUndefined();
    expect(trashRefusal("/private/var/folders/x/T/cu/a.txt", home)).toBeUndefined();
    expect(noteHtml("<b>T</b>", "a & b\n\nc")).toBe("<div><h1>&lt;b&gt;T&lt;/b&gt;</h1></div><div>a &amp; b</div><div><br></div><div>c</div>");
    const finder = BUILTIN_ADAPTERS[0]!;
    await expect(scriptsOf("com.apple.finder", finder.extras.find((e) => e.name === "trash")!, [["relative.txt"]], null)).rejects.toThrow("absolute");
    await expect(scriptsOf("com.apple.finder", finder.extras.find((e) => e.name === "trash")!, [[join(dir, "missing.txt")]], null)).rejects.toThrow("no file or folder");
    await expect(scriptsOf("com.apple.finder", finder.extras.find((e) => e.name === "trash")!, [["/System"]], null)).rejects.toThrow("doesn't trash");
    const safari = BUILTIN_ADAPTERS[1]!;
    await expect(scriptsOf("com.apple.Safari", safari.extras.find((e) => e.name === "openURL")!, ["javascript:alert(1)"], null)).rejects.toThrow("http, https and file");
    await expect(scriptsOf("com.apple.Safari", safari.extras.find((e) => e.name === "pageText")!, [{ window: 2 }], null)).rejects.toThrow('no option "window"');
    await expect(scriptsOf("com.apple.Safari", safari.extras.find((e) => e.name === "openURL")!, ["https://x.test", { newTab: "yes" }], null)).rejects.toThrow("true or false");
  });

  test("results are parsed from the rows a script returns", async () => {
    const safari = BUILTIN_ADAPTERS[1]!;
    let value: unknown;
    const scope = (result: string): AdapterScope => ({
      app: { name: "Safari", bundleId: "com.apple.Safari", pid: 1 }, signal: new AbortController().signal,
      applescript: async () => result, find: async () => [], snapshot: async () => "", act: async () => ({ rung: 1 }),
      waitFor: async () => ({ waitedMs: 0 }), openDocument: async () => ({ name: "", bundleId: "" }), print: () => {}, say: () => {}, notice: () => {},
      clampWait: (ms) => ms, sleep: async () => true, window: () => BOUND_WINDOW,
    });
    value = await safari.extras.find((e) => e.name === "tabs")!.run(scope("1\ttrue\thttps://a.test/\tA\ttitle\n2\tfalse\t\t\n"), []);
    expect(value).toEqual([
      { tab: 1, current: true, url: "https://a.test/", title: "A\ttitle" },
      { tab: 2, current: false, url: "", title: "" },
    ]);
    const finder = BUILTIN_ADAPTERS[0]!;
    value = await finder.extras.find((e) => e.name === "selection")!.run({ ...scope("file:///tmp/a%20b.txt\nfile:///Users/x/Folder/\nnot a url\n"), app: { name: "Finder", bundleId: "com.apple.finder", pid: 1 } }, []);
    expect(value).toEqual(["/tmp/a b.txt", "/Users/x/Folder"]);
    await expect(safari.extras.find((e) => e.name === "openURL")!.run(scope("NOWINDOW"), ["https://x.test"])).rejects.toThrow("no window with the bound window's id");
  });
});

describe("AppAdapters wiring", () => {
  test("an extra adapter (a test daemon's own) joins the built-in table", () => {
    const own: AppAdapter = { bundleIds: ["dev.example.fixture"], guide: { id: "fixture@1", text: "hi" }, extras: [extra()] };
    const a = new AppAdapters({ extra: [own] });
    expect(a.registry.find("dev.example.fixture")).toBe(own);
    expect(a.registry.find("com.apple.finder")).toBeDefined();
  });
});

// ── the bound window, never the front one ────────────────────────────────────────────────────────────────────

describe("browser and window extras act on the BOUND window only", () => {
  const byName = (bundleId: string, name: string): ExtraDef => BUILTIN_ADAPTERS.find((a) => a.bundleIds.includes(bundleId))!.extras.find((e) => e.name === name)!;
  const scopeAnswering = (bundleId: string, answer: string | null, sources: string[] = []): AdapterScope => ({
    app: { name: bundleId === "com.apple.finder" ? "Finder" : bundleId === "com.apple.dt.Xcode" ? "Xcode" : "Safari", bundleId, pid: 1 },
    signal: new AbortController().signal, window: () => BOUND_WINDOW,
    applescript: async (src) => { sources.push(src); return answer; },
    find: async () => [], snapshot: async () => "", act: async () => ({ rung: 1 }), waitFor: async () => ({ waitedMs: 0 }),
    openDocument: async () => ({ name: "", bundleId: "" }), print: () => {}, say: () => {}, notice: () => {}, clampWait: (ms) => ms, sleep: async () => true,
  });
  const kind = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return "ok"; } catch (e) { return e instanceof AutomationFailure ? `${e.kind}: ${e.message}` : `${(e as Error).name}: ${(e as Error).message}`; }
  };

  test("a target with no known bound window: NoWindow before any AppleScript runs (the daemon's own scope)", async () => {
    const adapters = new AppAdapters();
    const scripts: string[] = [];
    const scope = {
      sessionId: "s1", callId: "c1", signal: new AbortController().signal, primitive: "extra", metric: { ts: 0, sessionId: "s1", callId: "c1", primitive: "extra", ms: 0, helperMs: 0 },
      privatePath: true, helperVersion: () => "1.7.0", helper: async () => { throw new Error("no"); }, authorize: async () => {},
      applescript: async (_t: unknown, src: string) => { scripts.push(src); return { result: null }; }, openDocument: async () => { throw new Error("no"); },
      builder: { text: () => {}, daemonLine: () => {}, guide: () => {}, notice: () => {}, markScreenRead: () => {} },
      clampWait: (ms: number) => ms, acted: () => {}, log: () => {},
    };
    const safari = { targetId: "t1", bundleId: "com.apple.Safari", name: "Safari", pid: 1 }; // no windowId
    for (const name of ["tabs", "currentURL", "pageText", "openURL"]) {
      const r = await kind(adapters.primitive(scope, safari, "extra", { name, args: name === "openURL" ? ["https://x.test"] : [] }));
      expect(r).toContain("NoWindow: Winter doesn't know which Safari window is bound");
    }
    expect(await kind(adapters.primitive(scope, { ...safari, targetId: "t2", bundleId: "com.apple.finder", name: "Finder" }, "extra", { name: "selection", args: [] }))).toContain("NoWindow");
    expect(await kind(adapters.primitive(scope, { ...safari, targetId: "t3", bundleId: "com.apple.dt.Xcode", name: "Xcode" }, "extra", { name: "build", args: [] }))).toContain("NoWindow");
    expect(scripts).toEqual([]);
    // With the bound id known, the script names THAT window.
    await adapters.primitive(scope, { ...safari, targetId: "t4", windowId: 108006 }, "extra", { name: "currentURL", args: [] });
    expect(scripts.at(-1)).toContain("window id 108006");
  });

  test("Safari: a bound window Safari can't find, or one that isn't a browser window, is NoWindow — nothing falls back", async () => {
    for (const name of ["tabs", "currentURL", "pageText", "openURL"]) {
      const args = name === "openURL" ? ["https://x.test"] : [];
      expect(await kind(byName("com.apple.Safari", name).run(scopeAnswering("com.apple.Safari", "NOWINDOW"), args))).toContain("NoWindow: Safari has no window with the bound window's id");
      expect(await kind(byName("com.apple.Safari", name).run(scopeAnswering("com.apple.Safari", "NOTBROWSER"), args))).toContain("NoWindow: the bound Safari window is not a browser window");
    }
    // The script checks the bound window exists and is a browser window BEFORE it reads or changes anything.
    const sources: string[] = [];
    await byName("com.apple.Safari", "openURL").run(scopeAnswering("com.apple.Safari", "TAB:3", sources), ["https://x.test"]);
    const src = sources[0]!;
    expect(src.indexOf(`if not (exists window id ${BOUND_WINDOW}) then return "NOWINDOW"`)).toBeGreaterThan(0);
    expect(src.indexOf("return \"NOTBROWSER\"")).toBeLessThan(src.indexOf("make new tab"));
    expect(src).toContain(`set current tab of w to tab ci of w`);
  });

  test("Safari openWindow: the agent's own window, found by its one new id; refused while Safari is the user's app", async () => {
    const own = byName("com.apple.Safari", "openWindow");
    expect(await own.run(scopeAnswering("com.apple.Safari", "WINDOW:108006"), ["file:///tmp/p.html"])).toEqual({ window: 108006 });
    expect(await kind(own.run(scopeAnswering("com.apple.Safari", "FRONTMOST"), ["file:///tmp/p.html"]))).toContain("NeedsForeground: Safari is the app the user is using");
    expect(await kind(own.run(scopeAnswering("com.apple.Safari", "AMBIGUOUS"), ["file:///tmp/p.html"]))).toContain("NoWindow: a new Safari window was made, but Winter could not tell which one");
    const sources: string[] = [];
    await own.run(scopeAnswering("com.apple.Safari", "WINDOW:1", sources), ["https://x.test"]);
    expect(sources[0]).toContain("set before to id of every window");
    expect(sources[0]).toContain("make new document with properties {URL:\"https://x.test\"}");
    expect(sources[0]).toContain("if (count of fresh) is not 1 then return \"AMBIGUOUS\"");
  });

  test("Finder: selection() only when the bound window is Finder's frontmost; reveal() shows the folder in the bound window, selecting only then", async () => {
    expect(await kind(byName("com.apple.finder", "selection").run(scopeAnswering("com.apple.finder", "NOTFRONT"), []))).toContain("NoWindow: Finder's scripting reads the selection of its frontmost window only");
    expect(await kind(byName("com.apple.finder", "selection").run(scopeAnswering("com.apple.finder", "NOWINDOW"), []))).toContain("NoWindow: Finder has no window with the bound window's id");
    const dir = mkdtempSync(join(tmpdir(), "winter-adapters-reveal-"));
    const file = join(dir, "x.txt");
    writeFileSync(file, "x");
    const sources: string[] = [];
    expect(await byName("com.apple.finder", "reveal").run(scopeAnswering("com.apple.finder", "SHOWN", sources), [file])).toEqual({ selected: false });
    expect(await byName("com.apple.finder", "reveal").run(scopeAnswering("com.apple.finder", "SELECTED"), [file])).toEqual({ selected: true });
    expect(sources[0]).toContain(`set target of Finder window id ${BOUND_WINDOW} to ((POSIX file ${JSON.stringify(dir)}) as alias)`);
    expect(sources[0]).toContain(`if (id of Finder window 1) is not ${BOUND_WINDOW} then return "SHOWN"`);
    expect(sources[0]!.indexOf("return \"SHOWN\"")).toBeLessThan(sources[0]!.indexOf("select ("));
  });

  test("Xcode: the bound window's own workspace (or one named); none there is NoWindow", async () => {
    const build = byName("com.apple.dt.Xcode", "build");
    expect(await kind(build.run(scopeAnswering("com.apple.dt.Xcode", "NOTWORKSPACE"), [{ waitMs: 0 }]))).toContain("NoWindow: the bound Xcode window shows no workspace");
    expect(await kind(build.run(scopeAnswering("com.apple.dt.Xcode", "NOWORKSPACE"), [{ workspace: "Gone", waitMs: 0 }]))).toContain('no open workspace named "Gone"');
    const sources: string[] = [];
    await byName("com.apple.dt.Xcode", "buildStatus").run(scopeAnswering("com.apple.dt.Xcode", "App\tsucceeded\ttrue\t\n", sources), [{ workspace: "App" }]);
    expect(sources[0]).toContain('set d to workspace document "App"');
    expect(sources[0]).not.toContain("window id");
  });
});

// ── the review's findings ────────────────────────────────────────────────────────────────────────────────────

describe("review fixes", () => {
  const def = (bundleId: string, name: string): ExtraDef => BUILTIN_ADAPTERS.find((a) => a.bundleIds.includes(bundleId))!.extras.find((e) => e.name === name)!;
  const failure = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return "ok"; } catch (e) { return e instanceof AutomationFailure ? `${e.kind}: ${e.message}` : `${(e as Error).name}: ${(e as Error).message}`; }
  };

  test("trash: a symbolic link is refused (Finder would trash what it points to) — and nothing runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-trash-link-"));
    const target = join(dir, "Precious");
    mkdirSync(target);
    const link = join(dir, "link-to-precious");
    symlinkSync(target, link);
    const sources: string[] = [];
    expect(await failure(scriptsOf("com.apple.finder", def("com.apple.finder", "trash"), [link], (src) => { sources.push(src); return null; })))
      .toContain("Refused: " + link + " is a symbolic link");
    expect(sources).toEqual([]);
  });

  test("trash: the floor is weighed on the REAL path, case-insensitively (a link in the path, a mixed-case spelling)", async () => {
    const home = "/Users/someone";
    for (const p of ["/SYSTEM/Library", "/system", "/USERS", "/Users/SOMEONE", "/users/someone/documents", `${home}/DeskTop`, `${home}/.SSH/id_rsa`, `${home}/library/keychains/login.keychain-db`, "/Private/Etc/hosts"]) {
      expect(trashRefusal(p, home)).toBeDefined();
    }
    expect(trashRefusal(`${home}/documents/old.txt`, home)).toBeUndefined();
    // A path whose parent is a link to a refused folder: refused once resolved (the extra resolves before the floor).
    const dir = mkdtempSync(join(tmpdir(), "winter-trash-real-"));
    const fakeHome = join(dir, "home");
    mkdirSync(join(fakeHome, "Documents"), { recursive: true });
    symlinkSync(fakeHome, join(dir, "via"));
    const { realpathSync } = await import("node:fs");
    expect(trashRefusal(realpathSync(join(dir, "via", "Documents")), realpathSync(fakeHome))).toBeDefined();
  });

  test("trash: refused where Finder would ask (a password, another user's item in a sticky folder, a network volume)", () => {
    const local = "/dev/disk3s1 on / (apfs, local, journaled)\n//me@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)\n/dev/disk5s1 on /Volumes/USB Stick (msdos, local, nodev, nosuid)\n";
    const mounts = parseMounts(local);
    expect(mountFor("/Users/x/a.txt", mounts)?.flags).toContain("local");
    expect(mountFor("/Volumes/share/a.txt", mounts)?.flags).not.toContain("local");
    expect(mountFor("/Volumes/USB Stick/a.txt", mounts)?.point).toBe("/Volumes/USB Stick");
    const ok = { writable: () => true, stat: () => ({ mode: 0o40755, uid: 501 }), uid: 501, mounts: () => local };
    expect(trashDialogReason("/Users/x/a.txt", { uid: 501 }, ok)).toBeUndefined();
    expect(trashDialogReason("/Users/x/a.txt", { uid: 501 }, { ...ok, writable: () => false })).toContain("administrator's password");
    expect(trashDialogReason("/private/tmp/a.txt", { uid: 0 }, { ...ok, stat: () => ({ mode: 0o41777, uid: 0 }) })).toContain("another user");
    expect(trashDialogReason("/private/tmp/a.txt", { uid: 501 }, { ...ok, stat: () => ({ mode: 0o41777, uid: 0 }) })).toBeUndefined();
    expect(trashDialogReason("/Volumes/share/a.txt", { uid: 501 }, ok)).toContain("not local");
    expect(trashDialogReason("/Volumes/USB Stick/a.txt", { uid: 501 }, ok)).toBeUndefined();
  });

  test("Safari openWindow: frontmost checked right before the window is made and right after; a late switch is reported", async () => {
    const sources: string[] = [];
    const notices: string[] = [];
    const scope: AdapterScope = {
      app: { name: "Safari", bundleId: "com.apple.Safari", pid: 1 }, signal: new AbortController().signal, window: () => BOUND_WINDOW,
      applescript: async (src) => { sources.push(src); return "WINDOW:108006\ttrue"; },
      find: async () => [], snapshot: async () => "", act: async () => ({ rung: 1 }), waitFor: async () => ({ waitedMs: 0 }),
      openDocument: async () => ({ name: "", bundleId: "" }), print: () => {}, say: () => {}, notice: (t) => notices.push(t),
      clampWait: (ms) => ms, sleep: async () => true,
    };
    expect(await def("com.apple.Safari", "openWindow").run(scope, ["https://x.test"])).toEqual({ window: 108006, frontmostAfter: true });
    expect(notices[0]).toContain("may now have their keyboard focus");
    const src = sources[0]!;
    const make = src.indexOf("make new document");
    expect(src.lastIndexOf('if frontmost then return "FRONTMOST"', make)).toBeGreaterThan(src.indexOf("set before to id of every window"));
    expect(src.indexOf("set frontAfter to frontmost")).toBeGreaterThan(make);
    const block = BUILTIN_ADAPTERS[1]!.guide!.text + def("com.apple.Safari", "openWindow").summary + (def("com.apple.Safari", "openWindow").doc ?? "");
    expect(block).not.toMatch(/background/i);
    expect(BUILTIN_ADAPTERS[1]!.guide!.text).toContain("prefer Winter's built-in browser (browsers.open)");
  });

  test("Safari openURL: the current tab is put back ONLY when Safari itself moved to the new tab", async () => {
    const sources: string[] = [];
    await scriptsOf("com.apple.Safari", def("com.apple.Safari", "openURL"), ["https://x.test"], (src) => { sources.push(src); return "TAB:3"; });
    expect(sources[0]).toContain("if (index of current tab of w) = n and ci is not n then set current tab of w to tab ci of w");
    expect(sources[0]).not.toMatch(/^\s*set current tab of w to tab ci of w$/m);
  });

  test("Xcode build: keeps the result its own build returned and polls THAT one by id — never the last result", async () => {
    const sources: string[] = [];
    let polls = 0;
    const out = await scriptsOf("com.apple.dt.Xcode", def("com.apple.dt.Xcode", "build"), [{ waitMs: 5_000 }], (src) => {
      sources.push(src);
      if (src.includes("set r to build d")) return "WS:App\tsar-7";
      polls++;
      return polls < 3 ? "App\trunning\tfalse\t\n" : "App\tsucceeded\ttrue\t\n";
    });
    expect(out.length).toBe(4);
    expect(sources[0]).toContain("set r to build d");
    expect(sources[0]).toContain("my winterText(id of r)");
    for (const poll of sources.slice(1)) {
      expect(poll).toContain('set r to scheme action result id "sar-7" of d');
      expect(poll).not.toContain("last scheme action result");
    }
    const r = await def("com.apple.dt.Xcode", "build").run({
      app: { name: "Xcode", bundleId: "com.apple.dt.Xcode", pid: 1 }, signal: new AbortController().signal, window: () => BOUND_WINDOW,
      applescript: async (src) => (src.includes("set r to build d") ? "WS:App\tsar-8" : "REPLACED"),
      find: async () => [], snapshot: async () => "", act: async () => ({ rung: 1 }), waitFor: async () => ({ waitedMs: 0 }),
      openDocument: async () => ({ name: "", bundleId: "" }), print: () => {}, say: () => {}, notice: () => {}, clampWait: (ms) => ms, sleep: async () => true,
    }, [{ waitMs: 5_000 }]);
    expect(r).toMatchObject({ id: "sar-8", status: "replaced", completed: true });
  });

  test("Mail compose: the hidden message is saved, then closed with saving yes (never ask)", async () => {
    const sources = await scriptsOf("com.apple.mail", def("com.apple.mail", "compose"), [{ to: "a@example.com", subject: "s", body: "b" }], "12");
    const src = sources[0]!;
    expect(src).toContain("visible:false");
    expect(src.indexOf("close m saving yes")).toBeGreaterThan(src.indexOf("save m"));
    expect(src).not.toContain("saving ask");
    expect(src).not.toMatch(/\bsend\b/);
  });

  test("Finder selection: refused unless the selection is PROVEN the bound window's (frontmost, not the Desktop folder, the insertion location its folder)", async () => {
    const sources: string[] = [];
    for (const [answer, words] of [["DESKTOP", "shows the Desktop folder"], ["NOTFOCUSED", "the user's focus in Finder is elsewhere"], ["UNPROVEN", "could not prove"], ["NOTFRONT", "frontmost window only"]] as const) {
      expect(await failure(def("com.apple.finder", "selection").run({
        app: { name: "Finder", bundleId: "com.apple.finder", pid: 1 }, signal: new AbortController().signal, window: () => BOUND_WINDOW,
        applescript: async (src) => { sources.push(src); return answer; },
        find: async () => [], snapshot: async () => "", act: async () => ({ rung: 1 }), waitFor: async () => ({ waitedMs: 0 }),
        openDocument: async () => ({ name: "", bundleId: "" }), print: () => {}, say: () => {}, notice: () => {}, clampWait: (ms) => ms, sleep: async () => true,
      }, []))).toContain(`NoWindow: `);
      expect(await failure(def("com.apple.finder", "selection").run({
        app: { name: "Finder", bundleId: "com.apple.finder", pid: 1 }, signal: new AbortController().signal, window: () => BOUND_WINDOW,
        applescript: async () => answer, find: async () => [], snapshot: async () => "", act: async () => ({ rung: 1 }), waitFor: async () => ({ waitedMs: 0 }),
        openDocument: async () => ({ name: "", bundleId: "" }), print: () => {}, say: () => {}, notice: () => {}, clampWait: (ms) => ms, sleep: async () => true,
      }, []))).toContain(words);
    }
    const src = sources[0]!;
    const read = src.indexOf("(get selection)");
    for (const proof of [`if (id of Finder window 1) is not ${BOUND_WINDOW} then return "NOTFRONT"`, "if boundURL is desktopURL then return \"DESKTOP\"", "if insertionURL is not boundURL then return \"NOTFOCUSED\""]) {
      expect(src.indexOf(proof)).toBeGreaterThan(0);
      expect(src.indexOf(proof)).toBeLessThan(read);
    }
  });

  test("the dictionary never offers quit or print (nor run, reopen, activate, launch); close, reply and forward stay", () => {
    const info = generateDict({ scriptable: true, commands: [
      { name: "quit", suite: "Standard", eventCode: "aevtquit", params: [] },
      { name: "print", suite: "Standard", eventCode: "aevtpdoc", direct: { type: "specifier", optional: false }, params: [] },
      { name: "close", suite: "Standard", eventCode: "coreclos", direct: { type: "specifier", optional: false }, params: [] },
      { name: "reply", suite: "Mail", eventCode: "emalrpms", direct: { type: "message", optional: false }, params: [] },
      { name: "forward", suite: "Mail", eventCode: "emalfwms", direct: { type: "message", optional: false }, params: [] },
    ] });
    expect(info.commands.map((c) => c.name)).toEqual(["close", "reply", "forward"]);
    expect(info.unwrapped).toEqual([]);
  });
});
