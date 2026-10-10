import { describe, expect, test } from "bun:test";
import { FRESH_PHASES, freshSchedule } from "./fresh-sampler";
import {
  analyzeFreshness, cellBit, decodeCounter, decodeSlot, describeFreshnessPlan, FIXTURE_FRESH_LAYOUT, freshnessTable, idealCounter, idealSlot,
  lagMs, PAGE_FRESH_LAYOUT, prefTypeFlag, SAFARI_PREF_KEYS, SAFARI_PREFS_DOMAIN, safariPrefsPlan, verdictOf, type CaptureRecord, type DecodeLine,
} from "./freshness";

/** The lumas the fixture's cells produce for `value` (FreshCode: 16 bits MSB first + odd parity), black = 1. */
function lumasFor(value: number, dark = 12, light = 243): number[] {
  const bits = Array.from({ length: 16 }, (_, i) => (value >> (15 - i)) & 1);
  const parity = bits.reduce((a, b) => a + b, 0) % 2;
  return [...bits, parity].map((b) => (b === 1 ? dark : light));
}
const slotLumas = (slot: number): number[] => Array.from({ length: 16 }, (_, i) => (i === slot ? 8 : 250));

describe("decoding a capture's cells", () => {
  test("the counter: 16 bits and odd parity; a muddy cell or a wrong parity is unreadable", () => {
    for (const v of [0, 1, 5, 0x8001, 0xffff, 12_345]) expect(decodeCounter(lumasFor(v))).toBe(v);
    const bad = lumasFor(5);
    bad[16] = bad[16] === 12 ? 243 : 12;
    expect(decodeCounter(bad)).toBeNull();
    const muddy = lumasFor(5);
    muddy[3] = 128;
    expect(decodeCounter(muddy)).toBeNull();
    expect(decodeCounter(lumasFor(5).slice(0, 16))).toBeNull();
    expect(decodeCounter([...lumasFor(5).slice(0, 16), -1])).toBeNull();
    expect([cellBit(0), cellBit(80), cellBit(81), cellBit(174), cellBit(175), cellBit(-1)]).toEqual([1, 1, null, null, 0, null]);
  });

  test("the CSS slot: exactly one dark cell of 16", () => {
    expect(decodeSlot(slotLumas(0))).toBe(0);
    expect(decodeSlot(slotLumas(15))).toBe(15);
    expect(decodeSlot(Array(16).fill(250))).toBeNull();
    expect(decodeSlot(slotLumas(3).map((l, i) => (i === 9 ? 8 : l)))).toBeNull();
  });

  test("the truth is the wall clock: lag in ms, signed, the counter wrapping at 16 bits", () => {
    const t = 1_791_552_423_456;
    expect(idealCounter(t)).toBe(Math.floor(t / 100) & 0xffff);
    expect(lagMs("counter", idealCounter(t), t)).toBe(0);
    expect(lagMs("counter", (idealCounter(t) - 7) & 0xffff, t)).toBe(700);
    expect(lagMs("counter", (idealCounter(t) + 1) & 0xffff, t)).toBe(-100);
    expect(lagMs("counter", 0xffff, 6_553_600)).toBe(100); // 65536 → 0 wraps: the value before is 100 ms behind
    expect(idealSlot(1_600 * 99 + 250)).toBe(2);
    expect(lagMs("slot", 0, 1_600 * 99 + 250)).toBe(200);
    expect(lagMs("slot", 3, 1_600 * 99 + 250)).toBe(-100);
  });
});

describe("the per-phase verdicts", () => {
  test("fresh when it changes in most captures with a small lag; stale when one image repeats", () => {
    expect(verdictOf(20, 20, 50)).toBe("fresh");
    expect(verdictOf(20, 1, null)).toBe("stale");
    expect(verdictOf(20, 4, 3_000)).toBe("partly fresh");
    expect(verdictOf(20, 15, 4_000)).toBe("partly fresh");
    expect(verdictOf(0, 0, null)).toBe("no captures");
    // A 16-slot band that showed all 16 states over 40 captures is fresh (the live a2 css row), not partly.
    expect(verdictOf(40, 16, 0, 16)).toBe("fresh");
    expect(verdictOf(40, 16, 0)).toBe("partly fresh");
    expect(verdictOf(40, 6, 0, 16)).toBe("partly fresh");
  });

  test("analyzeFreshness: per phase × source × region, from the sampler's records, the tool's lines and the ticks", () => {
    const captures: CaptureRecord[] = [];
    const decodes: DecodeLine[] = [];
    const t0 = 1_791_552_000_000;
    // OFF: the native band paints (fresh), the DOM band froze at one value (stale); ON: the DOM band paints again.
    for (let i = 0; i < 10; i++) {
      const phase = i < 5 ? "off-before" : "stream-on";
      const t = t0 + i * 500;
      const file = `${String(i).padStart(4, "0")}-${phase}-skylight.png`;
      captures.push({ phase, source: "skylight", file: `/h/fresh/a1/${file}`, t, ok: true });
      const frozen = idealCounter(t0);
      decodes.push({ file, ok: true, regions: {
        native: { hash: `n${i}`, lumas: lumasFor(idealCounter(t)) },
        dom: phase === "off-before" ? { hash: "frozen", lumas: lumasFor(frozen) } : { hash: `d${i}`, lumas: lumasFor(idealCounter(t - 100)) },
        canvas: { hash: "c", lumas: Array(17).fill(128) },
        css: { hash: `s${i}`, lumas: slotLumas(idealSlot(t)) },
      } });
    }
    captures.push({ phase: "stream-on", source: "stream", file: "/h/fresh/a1/0099-stream-on-stream.png", t: t0 + 9_000, ok: false, error: "no frame yet" });
    const ticks = [{ t: t0 + 1_000, native: idealCounter(t0 + 1_000), dom: idealCounter(t0) }, { t: t0 + 2_000, native: idealCounter(t0 + 2_000), dom: idealCounter(t0) }];
    const cells = analyzeFreshness(FIXTURE_FRESH_LAYOUT, captures, decodes, ticks);
    const get = (region: string, phase: string, source = "skylight") => cells.find((c) => c.region === region && c.phase === phase && c.source === source)!;
    expect(get("native", "off-before")).toMatchObject({ verdict: "fresh", unique: 5, images: 5, decoded: 5, lagMedianMs: 0, renderLagMedianMs: 0 });
    expect(get("dom", "off-before")).toMatchObject({ verdict: "stale", unique: 1 });
    expect(get("dom", "off-before").lagMaxMs).toBe(2_000);
    expect(get("dom", "off-before").renderLagMedianMs).toBe(1_000); // the page itself stopped advancing its DOM
    expect(get("dom", "stream-on")).toMatchObject({ verdict: "fresh", lagMedianMs: 100 });
    expect(get("canvas", "off-before")).toMatchObject({ decoded: 0, verdict: "stale" });
    expect(get("css", "stream-on")).toMatchObject({ verdict: "fresh", lagMedianMs: 0 });
    expect(get("native", "stream-on", "stream")).toMatchObject({ captures: 1, images: 0, verdict: "no captures" });
    const table = freshnessTable([{ variant: "a1 default", cells }]);
    expect(table.split("\n")[0]).toContain("variant");
    expect(table).toContain("a1 default  native  off-before  skylight  fresh");
  });

  test("the two layouts: the fixture window (native band + page under the web view's top) and the page alone", () => {
    expect(FIXTURE_FRESH_LAYOUT.regions.map((r) => [r.name, r.y])).toEqual([["native", 12], ["dom", 64], ["canvas", 108], ["css", 152]]);
    expect(PAGE_FRESH_LAYOUT.regions.map((r) => [r.name, r.y])).toEqual([["dom", 8], ["canvas", 52], ["css", 96]]);
    for (const l of [FIXTURE_FRESH_LAYOUT, PAGE_FRESH_LAYOUT]) {
      for (const r of l.regions) expect(r.cells).toBe(r.kind === "slot" ? 16 : 17);
      expect(l.sentinel).toEqual({ x: 8, y: 8, size: 48 });
    }
  });
});

describe("the sampler's schedule", () => {
  test("OFF 10 s → ON 20 s → OFF 10 s at 500 ms: 20 / 40 / 20 ticks, the stream only while ON", () => {
    const s = freshSchedule(FRESH_PHASES, 500);
    expect(s.length).toBe(80);
    expect(s.filter((t) => t.phase === "off-before").length).toBe(20);
    expect(s.filter((t) => t.phase === "stream-on").every((t) => t.sources.includes("stream"))).toBe(true);
    expect(s.filter((t) => t.phase !== "stream-on").every((t) => t.sources.length === 1 && t.sources[0] === "skylight")).toBe(true);
    expect(s[20]).toMatchObject({ atMs: 10_000, phase: "stream-on", first: true });
    expect(s.at(-1)).toMatchObject({ atMs: 39_500, phase: "off-after", last: true });
  });
});

describe("Safari's WebKit preferences: recorded, set NO, restored exactly", () => {
  test("restore writes each original back with its own type, and deletes a key that was absent", () => {
    const plan = safariPrefsPlan("/U/x/Safari", {
      [SAFARI_PREF_KEYS[0]]: { present: false },
      [SAFARI_PREF_KEYS[1]]: { present: true, type: "bool", value: "1" },
      [SAFARI_PREF_KEYS[2]]: { present: true, type: "int", value: "3" },
    });
    expect(plan.apply).toEqual(SAFARI_PREF_KEYS.map((k) => ["write", "/U/x/Safari", k, "-bool", "NO"]));
    expect(plan.restore).toEqual([
      ["delete", "/U/x/Safari", SAFARI_PREF_KEYS[0]],
      ["write", "/U/x/Safari", SAFARI_PREF_KEYS[1], "-bool", "YES"],
      ["write", "/U/x/Safari", SAFARI_PREF_KEYS[2], "-int", "3"],
    ]);
    expect(() => safariPrefsPlan("/d", {})).toThrow("no recorded original");
    expect(SAFARI_PREFS_DOMAIN).toContain("Containers/com.apple.Safari");
  });

  test("defaults read-type → the write flag; a type it cannot restore is undefined (the mode then refuses)", () => {
    expect(prefTypeFlag("Type is boolean")).toBe("bool");
    expect(prefTypeFlag("Type is integer\n")).toBe("int");
    expect(prefTypeFlag("Type is string")).toBe("string");
    expect(prefTypeFlag("Type is dictionary")).toBeUndefined();
    expect(prefTypeFlag("")).toBeUndefined();
  });

  test("the dry run's plan names both fixture variants, and Safari only when asked", () => {
    expect(describeFreshnessPlan({ safari: false, safariPrefs: false }).join("\n")).toContain("_setWindowOcclusionDetectionEnabled:NO");
    expect(describeFreshnessPlan({ safari: false, safariPrefs: false }).length).toBe(1);
    expect(describeFreshnessPlan({ safari: true, safariPrefs: true })[1]).toContain("originals restored exactly");
  });
});

import { mkdtempSync, existsSync as fileExists, writeFileSync as writeFile, rmSync as removeAll } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { measureFixtureVariant, measureSafariWithPrefs, restoreSafariPrefsIfInterrupted, safariPrefsBackupPath, type FreshDeps } from "./freshness-run";

/** Fake plumbing: records every call; `defaults` answers from a fake Safari plist; Safari "runs" until quit. */
function fakeDeps(prefs: Record<string, { type: string; value: string }>, extra: Partial<FreshDeps> = {}) {
  const calls: string[] = [];
  let safariUp = true;
  let windowsCalls = 0;
  const safariWindowIds = new Set<number>([1]);
  const outDir = mkdtempSync(joinPath(tmpdir(), "cu-fresh-test-"));
  const d: FreshDeps = {
    tool: "/t/cu-live-tool", home: outDir, root: outDir, webDir: joinPath(import.meta.dir, "fixture-web"),
    log: () => undefined,
    sh: (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "pgrep") return { status: safariUp ? 0 : 1, stdout: safariUp ? "4242\n" : "", stderr: "" };
      if (cmd === "open") { if (args.join(" ") === "-g -a Safari") safariUp = true; return { status: 0, stdout: "", stderr: "" }; }
      if (cmd === "defaults") {
        const [verb, , key] = args;
        if (verb === "read" && key === undefined) return { status: 0, stdout: "{}", stderr: "" };
        if (verb === "read-type") return prefs[key!] ? { status: 0, stdout: `Type is ${prefs[key!]!.type}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "does not exist" };
        if (verb === "read") return { status: 0, stdout: `${prefs[key!]?.value ?? ""}\n`, stderr: "" };
        if (verb === "write") { prefs[key!] = { type: args[3]!.slice(1) === "bool" ? "boolean" : "integer", value: args[4] === "NO" ? "0" : args[4] === "YES" ? "1" : args[4]! }; return { status: 0, stdout: "", stderr: "" }; }
        if (verb === "delete") { delete prefs[key!]; return { status: 0, stdout: "", stderr: "" }; }
      }
      // Safari's windows: the user's (1), plus the test's own (2) from File › New Window until its close button.
      if (args[0] === "windows") { windowsCalls++; return { status: 0, stdout: [...safariWindowIds].map((id) => `{"id":${id},"layer":0}\n`).join(""), stderr: "" }; }
      return { status: 0, stdout: "", stderr: "" };
    },
    post: async (cmd) => { calls.push(`post ${cmd}`); return undefined; },
    events: () => [],
    returnUser: async () => { calls.push("returnUser"); },
    turn: async (code) => {
      if (code.includes("Quit Safari")) { calls.push("quit Safari"); safariUp = false; return { output: "", isError: false, facts: {} }; }
      calls.push("turn");
      if (code.includes(`"New Window"`)) { safariWindowIds.add(2); return { output: "", isError: false, facts: { made: true, id: 2 } }; }
      // The page loaded in the test's window; the fake window never goes full screen.
      if (code.includes("full screen button") && !code.includes("close button")) return { output: "", isError: false, facts: { title: "Fixture Fresh", fullScreen: false } };
      if (code.includes("close button")) { safariWindowIds.delete(2); return { output: "", isError: false, facts: { closed: true } }; }
      return { output: "", isError: false, facts: {} };
    },
    sample: async () => [],
    monitor: () => [],
    baseline: { frontPid: 1, front: "x", space: 1 },
    abortIfInput: () => undefined,
    sleep: async () => undefined,
    ...extra,
  };
  return { d, calls, outDir, prefs, windowsCalls: () => windowsCalls };
}

describe("the Safari preference mode, end to end on fake plumbing", () => {
  test("record → quit → write NO → relaunch → measure → quit → restore EXACTLY (absent deleted) → relaunch; backup removed", async () => {
    const { SAFARI_PREF_KEYS: K } = await import("./freshness");
    const prefs: Record<string, { type: string; value: string }> = { [K[1]]: { type: "boolean", value: "1" } };
    const { d, calls, outDir } = fakeDeps(prefs);
    const r = await measureSafariWithPrefs(d, outDir, "Safari, WebKitPreferences NO");
    expect(r.ok).toBe(false); // the fake window never goes full screen: nothing measured, but everything undone
    expect(r.error).toContain("full screen");
    // File › New Window, the title check + full-screen press, then closing ONLY that window (verified gone).
    expect(calls.filter((c) => c === "turn").length).toBe(3);
    // The page opened only AFTER the test's own window existed (so it tabs into that window, never the user's).
    expect(calls.findIndex((c) => c.startsWith("open -g -a Safari file:"))).toBeGreaterThan(calls.indexOf("turn"));
    const q1 = calls.indexOf("quit Safari"), w1 = calls.findIndex((c) => c.startsWith("defaults write") && c.endsWith("-bool NO"));
    const relaunch1 = calls.indexOf("open -g -a Safari");
    expect(q1).toBeGreaterThan(-1);
    expect(w1).toBeGreaterThan(q1);           // written only once Safari has quit
    expect(relaunch1).toBeGreaterThan(w1);
    expect(calls.filter((c) => c === "quit Safari").length).toBe(2);
    // Restored exactly: the absent keys deleted, the present one back to YES (a bool).
    expect(prefs).toEqual({ [K[1]]: { type: "boolean", value: "1" } });
    expect(calls.at(-1)).toBe("open -g -a Safari");
    expect(fileExists(safariPrefsBackupPath(outDir))).toBe(false);
    removeAll(outDir, { recursive: true, force: true });
  });

  test("a backup an interrupted run left is restored first, then removed", async () => {
    const { SAFARI_PREF_KEYS: K } = await import("./freshness");
    const prefs: Record<string, { type: string; value: string }> = { [K[0]]: { type: "boolean", value: "0" }, [K[1]]: { type: "boolean", value: "0" }, [K[2]]: { type: "boolean", value: "0" } };
    const { d, calls, outDir } = fakeDeps(prefs);
    writeFile(safariPrefsBackupPath(outDir), JSON.stringify({ domain: "/U/S", originals: { [K[0]]: { present: false }, [K[1]]: { present: false }, [K[2]]: { present: true, type: "int", value: "2" } } }));
    expect(await restoreSafariPrefsIfInterrupted(d, outDir)).toEqual([]);
    expect(prefs).toEqual({ [K[2]]: { type: "integer", value: "2" } });
    expect(calls.indexOf("quit Safari")).toBeLessThan(calls.findIndex((c) => c.startsWith("defaults delete")));
    expect(fileExists(safariPrefsBackupPath(outDir))).toBe(false);
    removeAll(outDir, { recursive: true, force: true });
  });

  test("a preference of a type it cannot restore stops the mode before anything changes", async () => {
    const { SAFARI_PREF_KEYS: K } = await import("./freshness");
    const prefs: Record<string, { type: string; value: string }> = { [K[0]]: { type: "dictionary", value: "{}" } };
    const { d, calls, outDir } = fakeDeps(prefs);
    const r = await measureSafariWithPrefs(d, outDir, "x");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nothing was changed");
    expect(calls.some((c) => c.startsWith("defaults write") || c === "quit Safari")).toBe(false);
    removeAll(outDir, { recursive: true, force: true });
  });
});

describe("a fixture variant on fake plumbing", () => {
  test("start (a2 asks for occlusion detection off) → off-Space → return the user → sample → stop; the user returned after", async () => {
    const t = Date.now();
    const events = [
      { t: t + 1, role: "main", ev: "fresh.ready", window: 777 },
      { t: t + 2, role: "main", ev: "fresh.occlusionDetection", enabled: false, supported: true },
      { t: t + 3, role: "main", ev: "fresh.offspace", method: "fullscreen" },
      { t: t + 4, role: "main", ev: "fresh.occlusion", visible: false },
    ];
    let posted: Array<[string, unknown]> = [];
    let sampled: unknown;
    const { d, calls } = fakeDeps({}, {
      events: () => events,
      post: async (cmd, args) => { posted.push([cmd, args]); return undefined; },
      sample: async (p) => { sampled = p; return [JSON.stringify({ done: true, captures: 0 })]; },
    });
    const r = await measureFixtureVariant(d, "a2", false);
    expect(r).toMatchObject({ ok: true, windowId: 777, placement: "fullscreen", occlusion: [{ visible: false }] });
    expect(posted.map((p) => p[0])).toEqual(["freshStart", "freshOffspace", "freshStop"]);
    expect(posted[0]![1]).toEqual({ occlusionDetection: false });
    expect(sampled).toMatchObject({ windowId: 777, intervalMs: 500, rect: [0, 0, 640, 240] });
    expect(calls.filter((c) => c === "returnUser").length).toBe(2);
  });
});
