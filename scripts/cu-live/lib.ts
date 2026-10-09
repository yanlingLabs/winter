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
const UNATTENDED_IDLE_MS = 60_000;

/** Why the run must not start, from `cu-live-tool front`'s line (the active Space's type, HID idle); else undefined. */
export function startRefusal(frontLine: string, unattended: boolean): string | undefined {
  let o: Record<string, unknown>;
  try { o = JSON.parse(frontLine.trim().split("\n").at(-1) ?? "") as Record<string, unknown>; } catch { return "cu-live-tool front gave no reading"; }
  if (o.spaceType === 4) return "the active Space is a full-screen app's — start the run from a regular desktop";
  if (unattended) {
    if (typeof o.hidIdleMs !== "number") return "--unattended: no HID idle reading, so it cannot tell whether someone is at the Mac";
    if (o.hidIdleMs < UNATTENDED_IDLE_MS) return `--unattended: real input ${Math.round(o.hidIdleMs / 1000)} s ago — someone is at the Mac, so the run was not started`;
  }
  return undefined;
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
