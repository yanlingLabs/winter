// The live ComputerV2 suite's PURE parts — everything here is a function of data, unit-tested in `lib.test.ts`
// without a screen: the focus/Space/input analysis of the monitor's samples, the fixture log, the script result
// markers, `top` parsing, the `CALL` lines the scripted model reads, and the pass/fail table.

// ── the monitor (`cu-live-tool monitor`) ──────────────────────────────────────────────────────────────────────

/** One sample: the frontmost app, the active Space, and how long since the last HID (real) input. */
export interface MonitorSample {
  t: number;
  front: string | null;
  frontPid: number | null;
  space: number | null;
  hidIdleMs: number | null;
  /** The real pointer (global points); absent from an older monitor. */
  mouse?: [number, number] | null;
}

export function parseMonitorLine(line: string): MonitorSample | undefined {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.t !== "number") return undefined;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const m = Array.isArray(o.mouse) && o.mouse.length === 2 && o.mouse.every((v) => typeof v === "number" && Number.isFinite(v)) ? [o.mouse[0] as number, o.mouse[1] as number] as [number, number] : undefined;
    return { t: o.t, front: typeof o.front === "string" ? o.front : null, frontPid: num(o.frontPid), space: num(o.space), hidIdleMs: num(o.hidIdleMs), ...(m === undefined ? {} : { mouse: m }) };
  } catch {
    return undefined;
  }
}

/** What must not change while ComputerV2 works: the user's frontmost app and the Space they are looking at. */
export interface FocusBaseline { frontPid: number; front: string | null; space: number | null }

export interface FocusViolation { t: number; what: string }

/**
 * Every sample in [from, to] whose frontmost app or active Space differs from the baseline. A jump-and-back shows
 * as a violation even when the last sample is fine — that is the point of sampling every ~20 ms (the monitor also
 * reports every activation the moment it happens). A Space the monitor could not read (null) is not judged.
 */
export function focusViolations(samples: readonly MonitorSample[], from: number, to: number, base: FocusBaseline): FocusViolation[] {
  const out: FocusViolation[] = [];
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    if (s.frontPid !== base.frontPid) out.push({ t: s.t, what: `frontmost became ${s.front ?? "?"} (pid ${s.frontPid ?? "?"})` });
    else if (base.space !== null && s.space !== null && s.space !== base.space) out.push({ t: s.t, what: `active Space became ${s.space}` });
  }
  return out;
}

/**
 * The times real HID input happened in [from, to]: the HID idle counter only grows between samples, so a DROP means
 * a keyboard, mouse or trackpad event (the helper's background input never goes through the HID system). `slackMs`
 * absorbs the counter's own jitter.
 */
export function hidInputTimes(samples: readonly MonitorSample[], from: number, to: number, slackMs = 60): number[] {
  const out: number[] = [];
  let prev: MonitorSample | undefined;
  for (const s of samples) {
    if (prev !== undefined && s.t >= from && s.t <= to && s.hidIdleMs !== null && prev.hidIdleMs !== null && s.hidIdleMs + slackMs < prev.hidIdleMs) out.push(s.t);
    prev = s;
  }
  return out;
}

/**
 * When the REAL pointer moved within [from, to]: the rung-4 signal. Synthetic pid-routed events never move it,
 * while SkyLight's pid route resets the HID idle time like real input would — so `hidInputTimes` cannot tell
 * the helper's background events from a rung-4 fallback, and this can.
 */
export function pointerMoves(samples: readonly MonitorSample[], from: number, to: number): number[] {
  const out: number[] = [];
  let prev: MonitorSample | undefined;
  for (const s of samples) {
    if (prev !== undefined && s.t >= from && s.t <= to && s.mouse && prev.mouse && (s.mouse[0] !== prev.mouse[0] || s.mouse[1] !== prev.mouse[1])) out.push(s.t);
    if (s.mouse) prev = s;
  }
  return out;
}

/** `--unattended`: how long the Mac must have had no real input before a run may start. */
export const UNATTENDED_IDLE_MS = 60_000;
/** `--unattended`: how often the idle gate looks again. */
export const UNATTENDED_POLL_MS = 5_000;

/** `cu-live-tool front`: what is in front, the active Space and its type (4 = a full-screen app's), HID idle. */
export interface FrontReading { front: string | null; frontPid: number | null; space: number | null; spaceType: number | null; hidIdleMs: number | null }

export function parseFrontReading(stdout: string): FrontReading | undefined {
  try {
    const o = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    if (typeof o.t !== "number") return undefined;
    return { front: typeof o.front === "string" ? o.front : null, frontPid: num(o.frontPid), space: num(o.space), spaceType: num(o.spaceType), hidIdleMs: num(o.hidIdleMs) };
  } catch {
    return undefined;
  }
}

/** `--max-wait`: "90", "90s", "45m", "3h" → milliseconds; undefined when malformed. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Math.round(n * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1_000));
}

export type IdleDecision = { kind: "go" } | { kind: "wait"; reason: string } | { kind: "refuse"; reason: string };

/**
 * Whether the run may start now. A run someone started by hand goes at once; an unattended one (an approved agent
 * run) waits — polled every `UNATTENDED_POLL_MS` — until the Mac has had `UNATTENDED_IDLE_MS` with no real input, and
 * gives up after `maxWaitMs`.
 */
export function idleGate(reading: FrontReading | undefined, waitedMs: number, maxWaitMs: number, unattended: boolean): IdleDecision {
  if (!unattended) return { kind: "go" };
  if (reading === undefined || reading.hidIdleMs === null) return { kind: "refuse", reason: "--unattended: no HID idle reading, so it cannot tell whether someone is at the Mac" };
  if (reading.hidIdleMs >= UNATTENDED_IDLE_MS) return { kind: "go" };
  if (waitedMs + UNATTENDED_POLL_MS > maxWaitMs) {
    return { kind: "refuse", reason: `--unattended: waited ${Math.round(waitedMs / 60_000)} min and the Mac was never idle for ${UNATTENDED_IDLE_MS / 1000} s — the run was not started` };
  }
  return { kind: "wait", reason: `waiting for ${UNATTENDED_IDLE_MS / 1000} s with no input (last input ${Math.round(reading.hidIdleMs / 1000)} s ago)…` };
}

/** Where the user is when the run starts, and where they go back to at its end. */
export type StartPlan =
  | { kind: "desktop"; space: number | null }
  | { kind: "from-fullscreen"; returnTo: { pid: number; bundleId: string | null; space: number } }
  | { kind: "refuse"; reason: string };

/**
 * On a regular desktop the run starts where the user is. On a full-screen app's Space (no other window can open
 * there) the run records that app and Space, moves the user to a regular desktop — the user's-app fixture opens on
 * one, and `test.activate` brings it in front — and at the end (an abort included) activates the recorded app again
 * and checks the active Space is the recorded one.
 */
export function startPlan(reading: FrontReading): StartPlan {
  if (reading.spaceType !== 4) return { kind: "desktop", space: reading.space };
  if (reading.frontPid === null || reading.space === null) return { kind: "refuse", reason: "the active Space is a full-screen app's, but there is no frontmost app or Space id to return the user to" };
  return { kind: "from-fullscreen", returnTo: { pid: reading.frontPid, bundleId: reading.front, space: reading.space } };
}

export function describeStartPlan(plan: StartPlan): string {
  switch (plan.kind) {
    case "desktop": return `starts on your regular desktop (Space ${plan.space ?? "?"}) and stays there`;
    case "from-fullscreen": return `you are in full screen (${plan.returnTo.bundleId ?? "pid " + plan.returnTo.pid}, Space ${plan.returnTo.space}): the run moves you to a regular desktop, then returns you to that app and Space at the end (an abort too)`;
    case "refuse": return `refuses: ${plan.reason}`;
  }
}

/** Collapse a violation list into one readable line (first time, count). */
export function describeViolations(v: readonly FocusViolation[], t0: number): string {
  if (v.length === 0) return "";
  const first = v[0]!;
  return `${first.what} at +${Math.round(first.t - t0)} ms (${v.length} sample${v.length === 1 ? "" : "s"})`;
}

// ── the fixture log ───────────────────────────────────────────────────────────────────────────────────────────

export interface FixtureEvent { t: number; role: string; ev: string; [field: string]: unknown }

/** The fixture's JSONL log; a torn last line (the fixture mid-write) is skipped. */
export function parseFixtureLog(text: string): FixtureEvent[] {
  const out: FixtureEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const o = JSON.parse(line) as FixtureEvent;
      if (typeof o.t === "number" && typeof o.ev === "string") out.push(o);
    } catch { /* torn line */ }
  }
  return out;
}

export function eventsSince(events: readonly FixtureEvent[], since: number, ev: string, role = "main"): FixtureEvent[] {
  return events.filter((e) => e.t >= since && e.ev === ev && e.role === role);
}

/** The last `field.change`/`web.input` value of `id` since `since`, if any. */
export function lastValue(events: readonly FixtureEvent[], since: number, ev: string, id: string): string | undefined {
  const hits = events.filter((e) => e.t >= since && e.ev === ev && e.id === id);
  const v = hits.at(-1)?.value;
  return typeof v === "string" ? v : undefined;
}

// ── the scripted model and the scripts' result markers ────────────────────────────────────────────────────────

/** One `CALL <Tool> <json>` line of a `winter-test/calls` prompt (the JSON is one line by construction). */
export function callLine(tool: string, input: unknown): string {
  return `CALL ${tool} ${JSON.stringify(input)}`;
}

/** The message a scenario sends: load ComputerV2 (deferred), then run the script. */
export function computerV2Message(code: string, timeoutMs: number): string {
  return [callLine("ToolSearch", { query: "select:ComputerV2" }), callLine("ComputerV2", { code, timeoutMs })].join("\n");
}

/** A script reports its facts as `print("CULIVE " + JSON.stringify(x))`; the fence around screen data keeps the line. */
export const MARKER = "CULIVE";

export function extractMarkers(output: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of output.split("\n")) {
    const at = line.indexOf(`${MARKER} {`);
    if (at < 0) continue;
    try {
      const o = JSON.parse(line.slice(at + MARKER.length + 1)) as unknown;
      if (o !== null && typeof o === "object" && !Array.isArray(o)) out.push(o as Record<string, unknown>);
    } catch { /* not ours */ }
  }
  return out;
}

/** Merge every marker of one output into one fact object (later keys win). */
export function markerFacts(output: string): Record<string, unknown> {
  return Object.assign({}, ...extractMarkers(output));
}

// ── `top -c d` ────────────────────────────────────────────────────────────────────────────────────────────────

export interface TopSample { cpu: number; idlew: number }

/** `top -l N -s S -c d -pid P -stats pid,cpu,idlew` → the per-interval samples (the first, absolute one dropped). */
export function parseTopDelta(out: string, pid: number): TopSample[] {
  const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f[0] === String(pid));
  return rows.slice(1).map((f) => ({ cpu: Number(f[1]), idlew: Number(f[2]) })).filter((s) => Number.isFinite(s.cpu) && Number.isFinite(s.idlew));
}

export interface PerfSummary { cpuMean: number; cpuMax: number; wakeupsPerSecondMax: number }

export function summarizeTop(samples: readonly TopSample[], intervalS: number): PerfSummary | undefined {
  if (samples.length === 0) return undefined;
  const cpus = samples.map((s) => s.cpu);
  return {
    cpuMean: cpus.reduce((a, b) => a + b, 0) / cpus.length,
    cpuMax: Math.max(...cpus),
    wakeupsPerSecondMax: Math.max(...samples.map((s) => s.idlew / intervalS)),
  };
}

// ── results ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Check { name: string; ok: boolean; detail?: string }
export type Status = "pass" | "fail" | "skip";
export interface ScenarioResult { name: string; group: string; status: Status; ms: number; checks: Check[]; note?: string }

export function statusOf(checks: readonly Check[]): Status {
  return checks.every((c) => c.ok) ? "pass" : "fail";
}

export function check(name: string, ok: boolean, detail?: string): Check {
  return ok ? { name, ok } : { name, ok, ...(detail === undefined ? {} : { detail }) };
}

/** A fixed-width table: group, scenario, status, time, and the first failing check (or the note). */
export function renderTable(results: readonly ScenarioResult[]): string {
  const rows = results.map((r) => {
    const failing = r.checks.find((c) => !c.ok);
    const why = failing !== undefined ? `${failing.name}${failing.detail ? `: ${failing.detail}` : ""}` : (r.note ?? "");
    return [r.group, r.name, r.status.toUpperCase(), `${(r.ms / 1000).toFixed(1)}s`, why.replace(/\s+/g, " ").slice(0, 110)];
  });
  const head = ["group", "scenario", "result", "time", "detail"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line), "", `${passed} passed, ${failed} failed, ${skipped} skipped`].join("\n");
}

/** A string with mixed case, symbols and non-ASCII — what typing must deliver EXACTLY (spaces included). */
export const MIXED_TEXT = "Ada Lovelace — ÆØÅ ✓ Ünïcödé 日本語 #42 @x $&*()[]{} 'q' \"dq\" tab-less";

// ── the end-of-run completion window (the fixture bundle's `--done` mode) ─────────────────────────────────────

/** What the completion window shows — the JSON `WinterCUFixture --done` reads (`DoneModel` in Done.swift). */
export interface DoneWindowModel {
  status: "pass" | "fail" | "aborted";
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  finishedAt: number;
  path: string;
}

/**
 * Red (aborted) when the run itself stopped — real input, a setup error, anything the runner caught as a "run" row
 * other than its cleanup; amber when any row failed; green only when nothing did.
 */
export function doneWindowModel(results: readonly ScenarioResult[], durationMs: number, finishedAt: number, path: string): DoneWindowModel {
  const count = (s: Status): number => results.filter((r) => r.status === s).length;
  const stopped = results.some((r) => r.group === "run" && r.status === "fail" && r.name !== "cleanup");
  const status = stopped ? "aborted" : count("fail") > 0 ? "fail" : "pass";
  return { status, passed: count("pass"), failed: count("fail"), skipped: count("skip"), durationMs: Math.max(0, Math.round(durationMs)), finishedAt, path };
}

/** `open` arguments: a fresh instance of the fixture bundle, in the background (never activated), in `--done` mode. */
export function doneWindowOpenArgs(fixtureApp: string, model: DoneWindowModel): string[] {
  return ["-n", "-g", "-a", fixtureApp, "--args", "--done", JSON.stringify(model)];
}

// ── a permission prompt on the user's screen ──────────────────────────────────────────────────────────────────

/**
 * Apps whose coming to the front means macOS put a permission or security prompt in front of the user: TCC's
 * (Automation, Screen Recording — UserNotificationCenter), an authorization (SecurityAgent), Gatekeeper's
 * (CoreServicesUIAgent). A test must never raise one; when one shows, the run stops rather than failing rows.
 */
export const PROMPT_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.apple.UserNotificationCenter", "com.apple.SecurityAgent", "com.apple.coreservices.uiagent",
]);

/** The first sample in [from, to] whose frontmost app is a permission prompt's. */
export function promptAppeared(samples: readonly MonitorSample[], from: number, to: number): { t: number; front: string } | undefined {
  const hit = samples.find((s) => s.t >= from && s.t <= to && s.front !== null && PROMPT_BUNDLE_IDS.has(s.front));
  return hit === undefined ? undefined : { t: hit.t, front: hit.front! };
}
