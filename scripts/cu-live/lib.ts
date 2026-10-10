// The live ComputerV2 suite's PURE parts — everything here is a function of data (or of an injected process seam),
// unit-tested in `lib.test.ts` without a screen: the focus/Space/input/lock analysis of the monitor's samples, the
// fixture log, the script result markers, `top` parsing, the `CALL` lines the scripted model reads, the pass/fail
// table, and the stop-signal handler.

// ── the monitor (`cu-live-tool monitor`) ──────────────────────────────────────────────────────────────────────

/** One sample: the frontmost app, the active Space, the pointer, and the user's hardware input so far. */
export interface MonitorSample {
  t: number;
  front: string | null;
  frontPid: number | null;
  space: number | null;
  /** IOHIDSystem's idle counter — reported, NEVER used: a Unity app's HID tickles and synthetic events reset it. */
  hidIdleMs: number | null;
  /** The real pointer (global points); absent from an older monitor. */
  mouse?: [number, number] | null;
  /**
   * The monitor's listen-only session tap (`HardwareInput`): hardware-origin events (source pid 0) of the pointer,
   * button, scroll — and, with listen access, key — types counted since the tap started (`hwStart`); `hwLast` the
   * last one's time; `hwKeys` whether keys are watched. Absent when the tap could not start.
   */
  hw?: number;
  hwLast?: number | null;
  hwStart?: number;
  hwKeys?: boolean;
  /**
   * `CGSessionCopyCurrentDictionary()`'s view (`SessionState`): the screen is locked (`CGSSessionScreenIsLocked`), and
   * this login session is the one on the console. Absent from an older monitor.
   */
  locked?: boolean;
  onConsole?: boolean;
}

export function parseMonitorLine(line: string): MonitorSample | undefined {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.t !== "number") return undefined;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const m = Array.isArray(o.mouse) && o.mouse.length === 2 && o.mouse.every((v) => typeof v === "number" && Number.isFinite(v)) ? [o.mouse[0] as number, o.mouse[1] as number] as [number, number] : undefined;
    const hw = typeof o.hw === "number" && typeof o.hwStart === "number"
      ? { hw: o.hw, hwLast: num(o.hwLast), hwStart: o.hwStart, hwKeys: o.hwKeys === true }
      : {};
    const session = typeof o.locked === "boolean" && typeof o.onConsole === "boolean" ? { locked: o.locked, onConsole: o.onConsole } : {};
    return { t: o.t, front: typeof o.front === "string" ? o.front : null, frontPid: num(o.frontPid), space: num(o.space), hidIdleMs: num(o.hidIdleMs), ...(m === undefined ? {} : { mouse: m }), ...hw, ...session };
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

/** The stretches in [from, to] during which the user was away from their app or Space (consecutive violating samples
 *  are one excursion) — the desktop switch's "ONE visit, not back and forth" is counted on these. */
export function excursions(samples: readonly MonitorSample[], from: number, to: number, base: FocusBaseline): Array<{ start: number; end: number }> {
  const bad = new Set(focusViolations(samples, from, to, base).map((v) => v.t));
  const out: Array<{ start: number; end: number }> = [];
  let open: { start: number; end: number } | undefined;
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    if (bad.has(s.t)) {
      if (open === undefined) { open = { start: s.t, end: s.t }; out.push(open); } else open.end = s.t;
    } else open = undefined;
  }
  return out;
}

/**
 * When the USER's input happened in [from, to]: the hardware-only tap's count grew between two samples and its
 * last event falls in the window (an increase whose events all came before `from` is not this window's). Only
 * hardware-origin events count — never the HID idle counter (a Unity app's tickles reset it with no event at all)
 * and never a synthetic event (the helper's, a keep-awake app's).
 */
export function hardwareInputTimes(samples: readonly MonitorSample[], from: number, to: number): number[] {
  const out: number[] = [];
  let prev: MonitorSample | undefined;
  for (const s of samples) {
    if (s.hw === undefined) continue;
    if (prev !== undefined && s.hw > prev.hw! && s.t >= from) {
      const at = s.hwLast ?? s.t;
      if (at >= from && at <= to) out.push(at);
    }
    prev = s;
  }
  return out;
}

/** How long the user has given no hardware input, as of `now` (since the tap started if none yet); null without a tap. */
export function hardwareIdleMs(samples: readonly MonitorSample[], now: number): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.hw !== undefined && s.hwStart !== undefined) return Math.max(0, now - Math.max(s.hwStart, s.hwLast ?? s.hwStart));
  }
  return null;
}

/**
 * When the REAL pointer moved within [from, to]: the per-scenario rung-4 signal (the helper's pid-routed events
 * never move it; a HID-route fallback does). Not the user's-presence signal: a keep-awake app's synthetic warp
 * moves it too — presence is `hardwareInputTimes`.
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

/** `--unattended`: how long the Mac must have had no real input before the countdown (`--idle-seconds`). */
export const UNATTENDED_IDLE_MS = 180_000;
/** `--unattended`: the countdown banner's length once the gate passes (`--countdown-seconds`). */
export const COUNTDOWN_MS = 30_000;
/** `--unattended`: how often the idle gate looks again. */
export const UNATTENDED_POLL_MS = 5_000;

/** `cu-live-tool front`: what is in front, the active Space and its type (4 = a full-screen app's), HID idle. */
export interface FrontReading { front: string | null; frontPid: number | null; space: number | null; spaceType: number | null }

export function parseFrontReading(stdout: string): FrontReading | undefined {
  try {
    const o = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    if (typeof o.t !== "number") return undefined;
    return { front: typeof o.front === "string" ? o.front : null, frontPid: num(o.frontPid), space: num(o.space), spaceType: num(o.spaceType) };
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

// ── the screen is usable at all (not locked, on the console) ─────────────────────────────────────────────────────

/** `cu-live-tool session`: the screen is locked, and whether this login session is the one on the console. */
export interface SessionState { locked: boolean; onConsole: boolean }

/** The login window is the frontmost app exactly while the screen is locked (or nobody is logged in on the console). */
export const LOGIN_WINDOW_BUNDLE_ID = "com.apple.loginwindow";

export function parseSessionReading(stdout: string): SessionState | undefined {
  try {
    const o = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    return typeof o.locked === "boolean" && typeof o.onConsole === "boolean" ? { locked: o.locked, onConsole: o.onConsole } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a live run cannot use the screen right now — undefined when it can. A locked Mac (or one whose console belongs
 * to another login session, or whose state could not be read: `null`) is NEVER a go: the fixtures would open behind
 * the lock screen and every result would be meaningless. `front` (when known) corroborates: the login window in front
 * is the lock screen whatever the flags say.
 */
export function screenUnavailable(session: SessionState | null, front?: string | null): { what: string; waiting: string } | undefined {
  if (session === null) return { what: "the session state could not be read", waiting: "the session state could not be read — waiting for it to be readable" };
  if (!session.onConsole) return { what: "this login session is not the one on the console", waiting: "this login session is not the one on the console — waiting for it to come back" };
  if (session.locked) return { what: "the screen is locked", waiting: "the screen is locked — waiting for it to be unlocked" };
  if (front === LOGIN_WINDOW_BUNDLE_ID) return { what: "the login window is in front", waiting: "the login window is in front — waiting for the screen to be unlocked" };
  return undefined;
}

/** The first monitor sample in [from, to] that shows the screen unusable (locked, off the console, or the login window in front). */
export function screenUnavailableAt(samples: readonly MonitorSample[], from: number, to: number): { t: number; what: string } | undefined {
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    const why = screenUnavailable(s.locked === undefined || s.onConsole === undefined ? { locked: false, onConsole: true } : { locked: s.locked, onConsole: s.onConsole }, s.front);
    if (why !== undefined) return { t: s.t, what: why.what };
  }
  return undefined;
}

/**
 * The user's presence for the idle gate: whoever just unlocked the Mac is at it (a password or Touch ID is not always
 * a hardware event the tap sees), so the idle clock restarts when the screen stops being unavailable. `lastBlockedAt`
 * is the last time it was.
 */
export function idleAfterUnlock(hardwareIdle: number | null, now: number, lastBlockedAt: number | undefined): number | null {
  if (hardwareIdle === null || lastBlockedAt === undefined) return hardwareIdle;
  return Math.min(hardwareIdle, Math.max(0, now - lastBlockedAt));
}

/**
 * Whether the run may start now. A locked screen is never "go" (before anything else — a tap that could not start while
 * locked is the unlock's business, not a refusal): an unattended run waits for the unlock, and the wait counts toward
 * `maxWaitMs` like any other; a run someone started by hand refuses at once (nobody is waiting at a lock screen). Then
 * a run someone started by hand goes; an unattended one (an approved agent run) waits — polled every
 * `UNATTENDED_POLL_MS` — until the Mac has had `idleMs` with no real input (then the countdown banner,
 * `countdownDecision`), and gives up after `maxWaitMs`.
 */
export function idleGate(hardwareIdle: number | null, waitedMs: number, maxWaitMs: number, unattended: boolean, idleMs: number, session: SessionState | null): IdleDecision {
  const blocked = screenUnavailable(session);
  if (blocked !== undefined) {
    if (!unattended) return { kind: "refuse", reason: `${blocked.what} — the run was not started (an --unattended run waits for it)` };
    if (waitedMs + UNATTENDED_POLL_MS > maxWaitMs) return { kind: "refuse", reason: `--unattended: waited ${Math.round(waitedMs / 60_000)} min and ${blocked.what} — the run was not started` };
    return { kind: "wait", reason: blocked.waiting };
  }
  if (!unattended) return { kind: "go" };
  if (hardwareIdle === null) return { kind: "refuse", reason: "--unattended: the hardware input tap did not start, so it cannot tell whether someone is at the Mac" };
  if (hardwareIdle >= idleMs) return { kind: "go" };
  if (waitedMs + UNATTENDED_POLL_MS > maxWaitMs) {
    return { kind: "refuse", reason: `--unattended: waited ${Math.round(waitedMs / 60_000)} min and the Mac was never idle for ${idleMs / 1000} s and an untouched countdown — the run was not started` };
  }
  return { kind: "wait", reason: `waiting for ${idleMs / 1000} s with no hardware input (none for ${Math.round(hardwareIdle / 1000)} s)…` };
}

export type CountdownDecision = { kind: "wait"; remainingMs: number } | { kind: "go" } | { kind: "postpone"; at: number; why: string };

/**
 * The countdown banner, from the monitor's samples since it went up: ANY hardware input — the pointer, a click, a
 * scroll, a key — postpones the run (the idle gate starts over); only a countdown that ran out untouched starts it.
 */
export function countdownDecision(samples: readonly MonitorSample[], startedAt: number, now: number, countdownMs: number): CountdownDecision {
  const input = hardwareInputTimes(samples, startedAt, now);
  if (input.length > 0) return { kind: "postpone", at: Math.min(...input), why: "input from the mouse, trackpad or keyboard" };
  if (now - startedAt >= countdownMs) return { kind: "go" };
  return { kind: "wait", remainingMs: countdownMs - (now - startedAt) };
}

/** The run's notices (the result bundle's `--banner` mode): the countdown, then "running" for the whole run. */
export type BannerSpec = { kind: "countdown"; seconds: number; watchPid: number } | { kind: "running"; watchPid: number };

export function bannerOpenArgs(app: string, banner: BannerSpec): string[] {
  return ["-n", "-g", "-a", app, "--args", "--banner", JSON.stringify(banner)];
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

// ── stopping the run: SIGINT / SIGTERM / SIGHUP ───────────────────────────────────────────────────────────────

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export const STOP_SIGNALS: readonly StopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
/** The shell's convention, 128 + the signal number. */
export const STOP_EXIT_CODES: Readonly<Record<StopSignal, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
/** The cleanup's whole budget: when it is spent the runner kills what it still owns and exits. */
export const STOP_HARD_EXIT_MS = 20_000;

/** The process seams `installStopHandler` needs (all injectable, so a test needs no real signal or timer). */
export interface StopHandlerDeps {
  on: (signal: StopSignal, handler: () => void) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  exit: (code: number) => void;
  log: (line: string) => void;
  /** Synchronous last resort just before the hard exit: kill (SIGKILL) what the run still owns. */
  onHardExit?: () => void;
}

export interface StopState {
  /** The first signal received; undefined until one arrives. A later signal never replaces it. */
  readonly requested: StopSignal | undefined;
  /** The run's own cleanup has begun: its waits must no longer be cut short by `requested`. Set by the cleanup's first line. */
  inCleanup: boolean;
  /** 128 + the first signal's number (130 for SIGINT); 1 before any signal. */
  readonly exitCode: number;
  /** Resolves with the first signal (races the long awaits that cannot poll). */
  readonly stopped: Promise<StopSignal>;
}

/**
 * The runner's stop handler: the first SIGINT/SIGTERM/SIGHUP flags the run (the running work notices at its next check,
 * unwinds into its `finally` — the very cleanup an abort runs — and the process exits non-zero once the report is
 * written) and arms a hard exit `STOP_HARD_EXIT_MS` later; any further signal while that runs is logged and ignored,
 * never a second cleanup and never a second timer.
 */
export function installStopHandler(deps: StopHandlerDeps): StopState {
  let requested: StopSignal | undefined;
  let resolveStopped!: (s: StopSignal) => void;
  const stopped = new Promise<StopSignal>((resolve) => { resolveStopped = resolve; });
  const state: StopState = {
    get requested() { return requested; },
    inCleanup: false,
    get exitCode() { return requested === undefined ? 1 : STOP_EXIT_CODES[requested]; },
    stopped,
  };
  for (const signal of STOP_SIGNALS) {
    deps.on(signal, () => {
      if (requested !== undefined) {
        deps.log(`${signal} received while stopping (${requested}) — the cleanup is already running; ignored`);
        return;
      }
      requested = signal;
      deps.log(`${signal} received — stopping the run and cleaning up (exit ${STOP_EXIT_CODES[signal]}; a hard exit follows in ${STOP_HARD_EXIT_MS / 1000} s)`);
      deps.setTimeout(() => {
        deps.log(`the cleanup did not finish in ${STOP_HARD_EXIT_MS / 1000} s — killing what the run still owns and exiting`);
        try { deps.onHardExit?.(); } catch { /* best effort */ }
        deps.exit(STOP_EXIT_CODES[signal]);
      }, STOP_HARD_EXIT_MS);
      resolveStopped(signal);
    });
  }
  return state;
}
