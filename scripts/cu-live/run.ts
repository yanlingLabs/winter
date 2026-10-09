#!/usr/bin/env bun
/**
 * The LIVE ComputerV2 end-to-end suite: the real stack — a daemon → the sandboxed automation worker → the signed dev
 * helper → real windows — driven with no LLM and no human, asserting what is otherwise checked by eye.
 *
 *   WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live              # the fixture scenarios + perf (~2-3 min of screen)
 *   WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live --real-apps  # + Safari, TextEdit, Finder, Preview (temp docs only)
 *   bun run e2e:cu-live --dry-run                            # builds, self-tests, the no-screen plumbing check
 *   WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live --apps "VRoid Studio,com.figma.Desktop"   # + the generic focus check
 *     on ANY installed app (a Unity app: --apps "VRoid Studio"); --real-apps adds VS Code and Chrome when installed
 *   options: --only <text> (scenarios whose name contains it; a|b for either), --yes (no countdown), --keep-temp,
 *            --report <file.json> (every check + failing outputs), --script <file.js> (one ad-hoc script),
 *            --unattended (an agent's run: no countdown; waits — every 5 s, up to --max-wait <90s|45m|3h>, default 3h —
 *            until 60 s with no real input). From a full-screen app's Space any run moves the user to a regular desktop
 *            and returns them to that app and Space at the end (an abort too).
 *            --no-done-window (CI: no end-of-run completion window; else it shows after the cleanup, 30 min at most),
 *            --helper-app <path to "Winter Computer Use Dev.app"> (else $WINTER_COMPUTER_USE_APP, else dist/dev/)
 *
 * WHAT RUNS (all isolated — nothing touches ~/.winter*, the Keychain, or the user's own daemon and helper):
 *   - a temp home `$TMPDIR/winter-cu-live-*`, and `winter-core-live` on it: the real daemon, compiled from
 *     `daemon-entry.ts`, signed as the dev daemon (the helper accepts only that), with a FILE secret store;
 *   - a SECOND instance of the dev helper for that home (`open -n -g --env WINTER_CU_HOME=<home>`): the dev helper
 *     honours WINTER_CU_HOME, and TCC keys its Accessibility/Screen Recording grants on its designated requirement,
 *     so the instance already holds them — the runner itself needs no grant;
 *   - two fixture apps (`swift/Fixture`): "Winter CU Fixture" (the target, launched in the background, one window in
 *     full screen = on its own Space) and "Winter CU User App" (frontmost: the user's app);
 *   - `cu-live-tool monitor`: the frontmost app, the active Space and the HID idle time every 20 ms (+ every
 *     activation) — every scenario asserts the user's frontmost app and Space never change, from its start until 3 s
 *     after it, and a drop of the HID idle time (real input) aborts the run;
 *   - `cu-live-viewprobe`: the helper's mirror stream (`view.*`), checked for frames, blank frames and repeats;
 *   - two sessions on the agent SDK's prompt-scripted double (`winter-test/calls`): `bypass` (no cards) and `ask`
 *     (the per-app card, answered here).
 * Every window, Space and process it made is closed at the end, whatever happened.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { METHODS, type SessionEvent } from "../../packages/protocol/src/index";
import { resolvePlatformPackageWinter } from "../../packages/core/src/runtime-sdk/executable";
import { buildAll, FIXTURE_MAIN, OUT_DIR, REPO_ROOT, type Built } from "./build";
import { DaemonClient } from "./client";
import {
  parseDuration, check, computerV2Message, describeViolations, focusViolations, hidInputTimes, markerFacts, pointerMoves, idleGate, parseFrontReading, startPlan, describeStartPlan, UNATTENDED_POLL_MS, type FrontReading, doneWindowModel, doneWindowOpenArgs, parseFixtureLog, parseMonitorLine, parseTopDelta,
  renderTable, statusOf, summarizeTop, type Check, type FixtureEvent, type FocusBaseline, type MonitorSample, type ScenarioResult,
} from "./lib";
import { REAL_APP_SCENARIOS, realAppsPreflight, type RealAppsRun } from "./real-apps";
import { expectedCardSummary, PRELUDE, SCENARIOS, scriptOf, type ImageStats, type ProbeEvent, type Scenario } from "./scenarios";
import { DEFAULT_GENERIC_APPS, describePlan, GENERIC_PRELUDE, genericScenario, offSpacePlan, offSpaceSkipReason, onDesktopPlan, visualSkipReason, parseApps, resolveApp, restorePlan, SCRIPTS, type GenericApp, type ResolveDeps } from "./generic";

// ── thresholds (env overrides) ───────────────────────────────────────────────────────────────────────────────────
const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const LIMITS = {
  idleCpu: num("CU_LIVE_IDLE_CPU_MAX", 1.0),          // % of one core, mean over the idle windows
  idleWakeups: num("CU_LIVE_IDLE_WAKEUPS_MAX", 50),    // per second, worst window
  streamCpu: num("CU_LIVE_STREAM_CPU_MAX", 30),        // the helper while a changing window is streamed
};
const WATCH_AFTER_MS = 3_000;
const MONITOR_INTERVAL_MS = 20;

interface Options { dryRun: boolean; realApps: boolean; only?: string; yes: boolean; keepTemp: boolean; helperApp?: string; apps?: string; report?: string; script?: string; unattended: boolean; noDoneWindow: boolean; maxWaitMs: number }

function parseOptions(argv: string[]): Options {
  const o: Options = { dryRun: false, realApps: false, yes: false, keepTemp: false, unattended: false, noDoneWindow: false, maxWaitMs: 3 * 3_600_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--real-apps") o.realApps = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--keep-temp") o.keepTemp = true;
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--helper-app") o.helperApp = argv[++i];
    else if (a === "--apps") o.apps = argv[++i];
    else if (a === "--report") o.report = argv[++i];
    else if (a === "--unattended") { o.unattended = true; o.yes = true; }
    else if (a === "--no-done-window") o.noDoneWindow = true;
    else if (a === "--max-wait") {
      const ms = parseDuration(argv[++i] ?? "");
      if (ms === undefined) throw new Error("--max-wait takes a duration: 90s, 45m, 3h");
      o.maxWaitMs = ms;
    }
    else if (a === "--script") { o.script = argv[++i]; o.only = "script"; }
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Each failing scenario's ComputerV2 output (capped), for `--report`. */
const failedOutputs = new Map<string, string>();
const log = (line: string): void => { process.stderr.write(`e2e:cu-live: ${line}\n`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sh(cmd: string, args: string[], input?: string, env?: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, ...(env === undefined ? {} : { env }) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * The per-user temp dir (`getconf DARWIN_USER_TEMP_DIR`) — the one a LaunchServices-launched helper sees as its
 * `NSTemporaryDirectory()`. The run dir must live there: only a home inside `<it>/winter-cu-live-*` makes the dev
 * helper a live-test instance (`HelperIdentity.isLiveTestHome`), whatever `$TMPDIR` this shell has.
 */
function userTempDir(): string {
  const dir = sh("getconf", ["DARWIN_USER_TEMP_DIR"]).stdout.trim();
  return dir.length > 0 && existsSync(dir) ? realpathSync(dir) : realpathSync(tmpdir());
}

function makeRunDir(): string {
  return realpathSync(mkdtempSync(join(userTempDir(), "winter-cu-live-")));
}

/** A unix socket path is at most 103 bytes (`sockaddr_un`); the per-user temp dir alone is ~57, so the run dir's
 *  home is one letter and the helper's `<home>/run/computer-use.sock` still fits. Refused here, not by the helper. */
const SOCKET_PATH_MAX = 103;
function homeIn(root: string): string {
  const home = join(root, "h");
  const socket = join(home, "run", "computer-use.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`the helper's socket path would be ${Buffer.byteLength(socket)} bytes (limit ${SOCKET_PATH_MAX}): ${socket}`);
  return home;
}

/** `cu-live-tool image-stats` on every screenshot the live daemon wrote since `since` (`<home>/cu-live-shots`). */
function shotsSince(tool: string, home: string, since: number): ImageStats[] {
  const dir = join(home, "cu-live-shots");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => Number(f.split("-")[0]) >= since).sort(); } catch { return []; }
  return files.map((f) => {
    const r = sh(tool, ["image-stats", join(dir, f)]);
    try {
      const o = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as Partial<ImageStats> & { error?: string };
      if (o.error !== undefined || typeof o.width !== "number") return { file: f, width: 0, height: 0, stddevLuma: 0, blank: true, sentinelPixels: 0, error: o.error ?? "undecodable" };
      return { file: f, width: o.width, height: o.height ?? 0, stddevLuma: o.stddevLuma ?? 0, blank: o.blank === true, sentinelPixels: o.sentinelPixels ?? 0 };
    } catch {
      return { file: f, width: 0, height: 0, stddevLuma: 0, blank: true, sentinelPixels: 0, error: (r.stderr || r.stdout).trim().slice(0, 200) };
    }
  });
}

async function until<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out (${ms} ms) waiting for ${what}`);
    await sleep(25);
  }
}

/** One call to the live-test helper as its (test) daemon: `winter-core-live __helper-call`. */
function helperCall(built: Pick<Built, "daemon">, socket: string, home: string, method: string, params: unknown): { accepted?: boolean; result?: unknown; error?: unknown } {
  const r = sh(built.daemon, ["__helper-call", socket, home, method, JSON.stringify(params)], undefined, { ...cleanEnv(), WINTER_CU_LIVE_TESTS: "1" });
  try { return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as { accepted?: boolean; result?: unknown; error?: unknown }; } catch { return { error: (r.stderr || r.stdout).trim().slice(0, 200) }; }
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WINTER_")) env[k] = v;
  return env;
}

/** Every running process whose executable is `exe` (`pgrep -f` on its full path). */
function pidsOf(exe: string): number[] {
  return sh("pgrep", ["-f", exe]).stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The dev helper app: the option, `$WINTER_COMPUTER_USE_APP`, else this checkout's `dist/dev`. Must be the DEV build. */
function helperAppPath(o: Options): string {
  const candidates = [o.helperApp, process.env.WINTER_COMPUTER_USE_APP, join(REPO_ROOT, "dist", "dev", "Winter Computer Use Dev.app")].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const id = sh("plutil", ["-extract", "CFBundleIdentifier", "raw", join(p, "Contents", "Info.plist")]).stdout.trim();
    if (id !== "com.winter.computeruse.dev") throw new Error(`${p} is ${id || "not an app"}, not the dev helper (com.winter.computeruse.dev)`);
    return p;
  }
  throw new Error("no dev helper found — run `bun run dev:helper` (and grant it Accessibility + Screen Recording once), or pass --helper-app");
}

// ── child processes the run owns ─────────────────────────────────────────────────────────────────────────────────

/** A line-producing child: every stdout line is parsed and kept with its arrival time. */
class LineProcess<T> {
  readonly items: T[] = [];
  readonly stderr: string[] = [];
  private buf = "";
  constructor(readonly child: ChildProcess, parse: (line: string) => T | undefined) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const v = parse(line);
        if (v !== undefined) this.items.push(v);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { this.stderr.push(...d.split("\n").filter(Boolean)); if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200); });
  }
  async stop(ms = 3_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { this.child.stdin?.end(); } catch { /* closed */ }
    this.child.kill("SIGTERM");
    const t0 = Date.now();
    while (this.child.exitCode === null && this.child.signalCode === null && Date.now() - t0 < ms) await sleep(25);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

interface Fixtures {
  runId: string;
  logPath: string;
  mainPid?: number;
  userPid?: number;
  seq: number;
}

function fixtureEvents(f: Fixtures): FixtureEvent[] {
  try { return parseFixtureLog(readFileSync(f.logPath, "utf8")); } catch { return []; }
}

function launchFixture(app: string, role: "main" | "user", f: Fixtures, background: boolean): void {
  const args = ["-n", ...(background ? ["-g"] : []), "--env", `WINTER_CU_FIXTURE_LOG=${f.logPath}`, "--env", `WINTER_CU_FIXTURE_ROLE=${role}`, "--env", `WINTER_CU_FIXTURE_RUN=${f.runId}`, "-a", app];
  const r = sh("open", args);
  if (r.status !== 0) throw new Error(`open ${app} failed: ${r.stderr.trim()}`);
}

async function postCommand(tool: string, f: Fixtures, role: "main" | "user", cmd: string, args: Record<string, unknown> = {}, ms = 5_000): Promise<FixtureEvent> {
  const seq = String(++f.seq);
  const r = sh(tool, ["post", "--run", f.runId, "--role", role, "--cmd", cmd, "--args", JSON.stringify(args), "--seq", seq]);
  if (r.status !== 0) throw new Error(`cu-live-tool post ${cmd} failed: ${r.stderr.trim()}`);
  return await until(`the ${role} fixture's ack of ${cmd}`, ms, () => fixtureEvents(f).find((e) => e.role === role && (e.ev === "cmd.ack" || e.ev === "cmd.error") && String(e.seq) === seq));
}

async function dumpState(tool: string, f: Fixtures): Promise<Record<string, unknown> | undefined> {
  const t0 = Date.now();
  await postCommand(tool, f, "main", "dump");
  const state = await until("the fixture's state dump", 5_000, () => fixtureEvents(f).filter((e) => e.role === "main" && e.ev === "state" && e.t >= t0 - 5).at(-1));
  return state as Record<string, unknown>;
}

async function topDelta(pid: number, windows: number, seconds: number): Promise<ReturnType<typeof parseTopDelta>> {
  const proc = Bun.spawn(["top", "-l", String(windows + 1), "-s", String(seconds), "-c", "d", "-pid", String(pid), "-stats", "pid,cpu,idlew"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parseTopDelta(out, pid);
}

// ── the dry run: builds, self-tests, and the plumbing with no screen ───────────────────────────────────────────

async function startLiveDaemon(built: Pick<Built, "daemon">, home: string): Promise<{ proc: LineProcess<Record<string, unknown>>; socket: string; pid: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WINTER_")) env[k] = v;
  const winter = process.env.WINTER_RUNTIME_EXECUTABLE ?? resolvePlatformPackageWinter();
  if (winter === undefined) throw new Error("no `winter` runtime (the npm platform package) — run `bun install`, or set WINTER_RUNTIME_EXECUTABLE");
  Object.assign(env, {
    WINTER_HOME: home, WINTER_PROFILE: "dev", WINTER_CU_LIVE_TESTS: "1", WINTER_RUNTIME_EXECUTABLE: winter, TMPDIR: `${userTempDir()}/`,
    WINTER_LOGIN_SHELL_PATH: "off", WINTER_KEYCHAIN_SERVICE: `com.winter.core.test-cu-live-${randomBytes(6).toString("hex")}`,
  });
  const child = spawn(built.daemon, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  const proc = new LineProcess<Record<string, unknown>>(child, (l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } });
  const ready = await until("the live daemon to come up", 60_000, () => {
    if (child.exitCode !== null) throw new Error(`winter-core-live exited (${child.exitCode}): ${proc.stderr.slice(-5).join(" | ")}`);
    return proc.items.find((i) => i.ready === true);
  });
  return { proc, socket: String(ready.socket), pid: Number(ready.pid) };
}

async function openSession(client: DaemonClient, cwd: string, policy: "bypass" | "ask"): Promise<string> {
  const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "cu-live", mode: "code", cwd, model: "winter-test/calls", approvalPolicy: policy });
  await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
  return sessionId;
}

/** Send one scripted turn and wait for its end; answers the ComputerV2 cards with `answer` (ask sessions). */
async function runTurn(client: DaemonClient, sessionId: string, text: string, ms: number, answer?: Scenario["answer"]): Promise<{ output: string; isError: boolean; cards: SessionEvent[] }> {
  const from = client.events.length;
  const cards: SessionEvent[] = [];
  const answered = new Set<string>();
  const span: [number, number] = [Date.now(), Number.POSITIVE_INFINITY];
  actionWindows.push(span);
  try {
    await client.call(METHODS.sessionSend, { sessionId, text });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && (e as { threadId?: string }).threadId === "main", ms, from, () => {
      for (let i = from; i < client.events.length; i++) {
        const e = client.events[i]! as SessionEvent & { callId?: string; toolName?: string };
        if (e.type !== "approval_requested" || e.sessionId !== sessionId || e.callId === undefined || answered.has(e.callId)) continue;
        answered.add(e.callId);
        cards.push(e);
        // Only the per-app card is approved; any other card (a foreground request would hand over the real pointer) is denied.
        const approved = answer !== undefined && answer !== false && (e as { summary?: string }).summary === expectedCardSummary();
        void client.call(METHODS.approvalRespond, { sessionId, callId: e.callId, approved, ...(approved ? { optionId: answer } : {}) }).catch(() => {});
      }
    });
  } finally {
    span[1] = Date.now();
  }
  const events = client.events.slice(from).filter((e) => e.sessionId === sessionId);
  const call = events.find((e): e is Extract<SessionEvent, { type: "tool_call" }> => e.type === "tool_call" && /computer_?v2/i.test((e as { name: string }).name));
  const result = call === undefined ? undefined : events.find((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result" && e.callId === call.callId);
  if (result === undefined) return { output: `(no ComputerV2 result in the turn — ${call === undefined ? "the call was never made" : "no result"})`, isError: true, cards };
  return { output: result.output, isError: result.isError, cards };
}

async function dryRun(built: Built, o: Options): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const selfTest = (name: string, cmd: string, args: string[]): void => {
    const t0 = Date.now();
    const r = sh(cmd, args);
    results.push({ name, group: "self-test", status: r.status === 0 && /SELFTEST OK/.test(r.stdout) ? "pass" : "fail", ms: Date.now() - t0, checks: [check(name, r.status === 0, (r.stdout + r.stderr).trim().slice(-300))] });
  };
  selfTest("fixture --self-test", join(built.fixtureMain, "Contents", "MacOS", "WinterCUFixture"), ["--self-test"]);
  selfTest("cu-live-tool self-test", built.tool, ["self-test"]);
  selfTest("cu-live-viewprobe self-test", built.viewProbe, ["self-test"]);
  results.push(await plumbingCheck(built));
  results.push(await peerCheck(built, o));
  // The START plan (read-only, no wait): what a live run would do from where the user is now.
  const reading = parseFrontReading(sh(built.tool, ["front"]).stdout);
  results.push(reading === undefined
    ? { name: "plan: the start", group: "plan", status: "fail", ms: 0, checks: [check("cu-live-tool front gave a reading", false)] }
    : { name: "plan: the start", group: "plan", status: "pass", ms: 0, checks: [check("cu-live-tool front gave a reading", true)], note: `${describeStartPlan(startPlan(reading))}; ${o.unattended ? `waits for 60 s with no input (now ${Math.round((reading.hidIdleMs ?? 0) / 1000)} s)` : "starts at once"}` });
  // The generic app checks' PLAN (no screen): which apps would run, and what each would do.
  const deps = liveResolveDeps();
  for (const a of [...parseApps(o.apps), ...(o.realApps ? DEFAULT_GENERIC_APPS.map((d, i) => ({ query: d.query, key: `default${i}` })) : [])]) {
    const found = resolveApp(a.query, deps);
    results.push(found === undefined
      ? { name: `plan: ${a.query}`, group: "plan", status: "skip", ms: 0, checks: [], note: "not installed (by bundle id, LaunchServices name, or bundle names) — the live run skips it" }
      : { name: `plan: ${a.query}`, group: "plan", status: "pass", ms: 0, checks: [check("installed", true)], note: `${found.path} (${found.bundleId}, via ${found.via}) — ${describePlan(a)}` });
  }
  return results;
}

/**
 * Which dev helpers accept the suite's TEST identities — no screen, no script (so no Esc tap): the dev helper's
 * executable is run as a plain child on two temp homes, as `verify:computer-helper` does. On an ordinary home it must
 * close both the test daemon (`winter-core-live __peer-hello`) and the test probe unanswered; on a live-test home
 * (`<user temp>/winter-cu-live-*`) it must accept both. A helper built before the live-test rule fails the second
 * half — rebuild it from this branch (`bun run dev:helper`; its TCC grants survive, its requirement is stated).
 */
async function peerCheck(built: Built, o: Options): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: Check[] = [];
  let helperApp: string;
  try { helperApp = helperAppPath(o); } catch (err) {
    return { name: "the dev helper accepts the test identities only on a live-test home", group: "identity", status: "skip", ms: 0, checks: [], note: err instanceof Error ? err.message : String(err) };
  }
  const exe = join(helperApp, "Contents", "MacOS", "Winter Computer Use Dev");
  const normalRoot = realpathSync(mkdtempSync(join(userTempDir(), "winter-cu-x-")));
  const liveRoot = makeRunDir();
  try {
    for (const [label, root, expectAccepted] of [["an ordinary temp home", normalRoot, false], ["a live-test home", liveRoot, true]] as const) {
      const home = homeIn(root);
      mkdirSync(home);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WINTER_")) env[k] = v;
      const helper = new LineProcess<string>(spawn(exe, [], { env: { ...env, WINTER_CU_HOME: home, TMPDIR: `${userTempDir()}/` }, stdio: ["ignore", "pipe", "pipe"] }), (l) => l);
      try {
        const socket = join(home, "run", "computer-use.sock");
        await until(`the helper's socket (${label})`, 10_000, () => {
          if (helper.child.exitCode !== null) throw new Error(`the dev helper exited (${helper.child.exitCode}): ${helper.stderr.slice(-3).join(" | ")}`);
          return existsSync(socket);
        });
        const hello = sh(built.daemon, ["__peer-hello", socket, home], undefined, { ...env, WINTER_CU_LIVE_TESTS: "1" });
        const daemonAnswer = JSON.parse(hello.stdout.trim() || "{}") as { accepted?: boolean };
        const probe = spawnSync(built.viewProbe, ["--socket", socket, "--home", home, "--session", "s_identitycheck"], { input: "", encoding: "utf8", timeout: 8_000 });
        const probeAccepted = probe.status === 0 && /"ev":"subscribed"/.test(probe.stdout ?? "");
        checks.push(check(`${label}: the test daemon is ${expectAccepted ? "accepted" : "refused"}`, daemonAnswer.accepted === expectAccepted, hello.stdout.trim().slice(0, 200)));
        checks.push(check(`${label}: the test probe is ${expectAccepted ? "accepted" : "refused"}`, probeAccepted === expectAccepted, `exit ${probe.status}: ${(probe.stdout ?? "").trim().slice(0, 160)}`));
      } finally {
        await helper.stop(5_000);
      }
    }
  } catch (err) {
    checks.push(check("the identity check ran", false, err instanceof Error ? err.message : String(err)));
  } finally {
    rmSync(normalRoot, { recursive: true, force: true });
    rmSync(liveRoot, { recursive: true, force: true });
  }
  return { name: "the dev helper accepts the test identities only on a live-test home", group: "identity", status: statusOf(checks), ms: Date.now() - t0, checks };
}

/**
 * The plumbing, with no helper and no window: the signed daemon on a temp home, the scripted double, ComputerV2 in the
 * sandboxed worker. `apps.list()` must fail as HelperUnavailable — proof that nothing was launched.
 */
export async function plumbingCheck(built: Pick<Built, "daemon">): Promise<ScenarioResult> {
  const t0 = Date.now();
  const root = makeRunDir();
  const home = homeIn(root);
  mkdirSync(home);
  let daemon: Awaited<ReturnType<typeof startLiveDaemon>> | undefined;
  const checks: Check[] = [];
  try {
    daemon = await startLiveDaemon(built, home);
    checks.push(check("the signed live daemon came up on a temp home", true));
    const client = await DaemonClient.connect(daemon.socket);
    await client.hello(readFileSync(join(home, "test-secrets", "harness-token"), "utf8").trim(), "cu-live");
    const sid = await openSession(client, root, "bypass");
    const code = `print("CULIVE " + JSON.stringify({ sum: 1 + 1 }));\nlet unavailable = null;\ntry { await apps.list({ emit: false }); } catch (e) { unavailable = e.name; }\nprint("CULIVE " + JSON.stringify({ unavailable }));`;
    const turn = await runTurn(client, sid, computerV2Message(code, 30_000), 90_000);
    const facts = markerFacts(turn.output);
    checks.push(check("the scripted double called ComputerV2, and the sandboxed worker ran the script", facts.sum === 2, turn.output.slice(-300)));
    checks.push(check("with no helper running, nothing was launched (HelperUnavailable)", facts.unavailable === "HelperUnavailable", String(facts.unavailable)));
    client.close();
  } catch (err) {
    checks.push(check("the plumbing ran", false, err instanceof Error ? err.message : String(err)));
  } finally {
    await daemon?.proc.stop();
    rmSync(root, { recursive: true, force: true });
  }
  return { name: "daemon + scripted model + worker (no screen)", group: "plumbing", status: statusOf(checks), ms: Date.now() - t0, checks };
}

// ── the live run ─────────────────────────────────────────────────────────────────────────────────────────────────

class Aborted extends Error {}


/** When ComputerV2 turns ran ([sent, completed]): the helper's own background events land inside these. */
const actionWindows: Array<[number, number]> = [];
const ACTION_SLACK_MS = 1_500;

/** The `front` reading the run starts from — after the unattended idle wait (every 5 s, up to --max-wait). */
async function waitToStart(built: Pick<Built, "tool">, o: Options): Promise<FrontReading> {
  const t0 = Date.now();
  let logged = 0;
  for (;;) {
    const reading = parseFrontReading(sh(built.tool, ["front"]).stdout);
    const d = idleGate(reading, Date.now() - t0, o.maxWaitMs, o.unattended);
    if (d.kind === "go") {
      if (reading === undefined) throw new Error("cu-live-tool front gave no reading");
      return reading;
    }
    if (d.kind === "refuse") throw new Error(d.reason);
    if (Date.now() - logged >= 60_000) { log(d.reason); logged = Date.now(); }
    await sleep(UNATTENDED_POLL_MS);
  }
}

async function liveRun(built: Built, o: Options): Promise<ScenarioResult[]> {
  const helperApp = helperAppPath(o);
  const results: ScenarioResult[] = [];
  const root = makeRunDir();
  const home = homeIn(root);
  const work = join(root, "w");
  mkdirSync(home);
  mkdirSync(work);
  const f: Fixtures = { runId: `cu-live-${process.pid}-${Date.now()}`, logPath: join(root, "fixture.jsonl"), seq: 0 };
  writeFileSync(f.logPath, "");
  const clipboard = sh("pbpaste", []).stdout;   // text only; restored at the end (cmd+c in a scenario overwrites it)
  let monitor: LineProcess<MonitorSample> | undefined;
  let probe: LineProcess<ProbeEvent> | undefined;
  let daemon: Awaited<ReturnType<typeof startLiveDaemon>> | undefined;
  let helperPid: number | undefined;
  let client: DaemonClient | undefined;
  let askClient: DaemonClient | undefined;
  let realApps: RealAppsRun | undefined;
  let baseline: FocusBaseline | undefined;
  let offspaceMethod = "?";
  let activateUser: () => Promise<void> = async () => { throw new Error("the helper is not up yet"); };
  /** A full-screen start: the app and Space to return the user to at the end (abort included). */
  let returnTo: { pid: number; bundleId: string | null; space: number } | undefined;
  let returnHome: (() => Promise<string>) | undefined;
  let inputWatchFrom = Number.POSITIVE_INFINITY;
  const runStartedAt = Date.now();
  const abortIfInput = (): void => {
    if (monitor === undefined) return;
    const now = Date.now();
    // Real input: the pointer moved, a key or click reached the user's app (in front), or the HID idle counter
    // dropped while no ComputerV2 turn was working — the helper's SkyLight-routed background events (rung 3)
    // reset that counter too, so a drop during a turn (or just after it) is the helper, not you.
    const hid = hidInputTimes(monitor.items, inputWatchFrom, now).filter((t) => !actionWindows.some(([a, b]) => t >= a && t <= b + ACTION_SLACK_MS));
    const moved = pointerMoves(monitor.items, inputWatchFrom, now);
    const leaked = fixtureEvents(f).filter((e) => e.role === "user" && (e.ev === "user.key" || e.ev === "user.mouse") && e.t >= inputWatchFrom);
    const first = [...hid, ...moved, ...leaked.map((e) => e.t)].sort((x, y) => x - y)[0];
    if (first !== undefined) {
      const what = [hid.length > 0 ? "keyboard/trackpad" : "", moved.length > 0 ? "the pointer moved" : "", leaked.length > 0 ? "your app got input" : ""].filter(Boolean).join(", ");
      throw new Aborted(`real input at ${new Date(first).toISOString()} (${what}) — the run was stopped so nothing acts against you`);
    }
  };
  try {
    // ── setup ──────────────────────────────────────────────────────────────────────────────────────────────────
    // Before anything launches: unattended (an approved agent run), wait until nobody is at the Mac; then the plan —
    // where the user is, and, from a full-screen app's Space, where to return them at the end.
    const reading = await waitToStart(built, o);
    // Nothing of an earlier run may stay up: a fixture a crashed run left (binds resolve the fixture by NAME, so a
    // second "Winter CU Fixture" is picked up), or the previous run's completion window. Every process of the
    // suite's fixture binary (its own executable name, whatever checkout built it) is closed.
    const leftovers = sh("pgrep", ["-x", "WinterCUFixture"]).stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of leftovers) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    if (leftovers.length > 0) {
      await until("earlier fixture processes to exit", 5_000, () => leftovers.every((p) => !processAlive(p))).catch(() => undefined);
      log(`closed ${leftovers.length} fixture process(es) an earlier run left (a completion window included)`);
    }
    const plan = startPlan(reading);
    if (plan.kind === "refuse") throw new Error(plan.reason);
    log(`start: ${describeStartPlan(plan)}`);
    if (plan.kind === "from-fullscreen") returnTo = plan.returnTo;
    monitor = new LineProcess<MonitorSample>(spawn(built.tool, ["monitor", "--interval-ms", String(MONITOR_INTERVAL_MS)], { stdio: ["pipe", "pipe", "pipe"] }), parseMonitorLine);
    await until("the monitor's first sample", 5_000, () => monitor!.items.length > 0);
    const spaceBefore = monitor.items.at(-1)!.space;
    // The user's Space for this run: where they are, or — from full screen — the regular desktop the run moves them to.
    let homeSpace: number | null = returnTo === undefined ? spaceBefore : null;
    // From here on real input stops the run (setup included: moving the user is no reason to act against them).
    inputWatchFrom = Date.now();

    // The daemon and the helper instance FIRST: on macOS 26 a background process's activation requests are ignored
    // (cooperative activation), so the runner puts the user's app in front through the live-test helper's
    // Accessibility (`test.activate`), falling back to LaunchServices' `lsappinfo setfront`.
    log("starting the live daemon and a dev helper instance for its temp home…");
    daemon = await startLiveDaemon(built, home);
    const socket = join(home, "run", "computer-use.sock");
    const helperExe = join(helperApp, "Contents", "MacOS", "Winter Computer Use Dev");
    const helpersBefore = new Set(pidsOf(helperExe));
    const opened = sh("open", ["-n", "-g", "-j", "--env", `WINTER_CU_HOME=${home}`, "-a", helperApp]);
    if (opened.status !== 0) throw new Error(`open the dev helper failed: ${opened.stderr.trim()}`);
    await until("the helper's socket", 15_000, () => existsSync(socket));
    helperPid = await until("the helper instance's pid", 5_000, () => {
      // The process holding the socket, confirmed as a dev helper; else the one dev helper that was not running before.
      const byPath = sh("lsof", ["-t", "--", socket]).stdout.trim().split("\n").map(Number).find((p) => Number.isInteger(p) && p > 0 && pidsOf(helperExe).includes(p));
      const fresh = pidsOf(helperExe).filter((p) => !helpersBefore.has(p));
      return byPath ?? (fresh.length === 1 ? fresh[0] : undefined);
    });
    const status = helperCall(built, socket, home, "status", {});
    log(`helper instance pid ${helperPid}: ${JSON.stringify((status.result as { permissions?: unknown } | undefined)?.permissions ?? status)}`);
    /** Put `pid` in front and wait for the monitor to see it (and, when given, the Space). */
    const bringToFront = async (pid: number, what: string, space?: number | null): Promise<string> => {
      const routes: string[] = [];
      const ok = (): boolean => {
        const last = monitor!.items.at(-1);
        return last !== undefined && last.frontPid === pid && (space === undefined || space === null || last.space === space);
      };
      for (const route of ["helper test.activate", "lsappinfo setfront", "helper test.activate", "lsappinfo setfront", "helper test.activate"] as const) {
        if (ok()) break;
        if (route === "helper test.activate") {
          const r = helperCall(built, socket, home, "test.activate", { pid });
          routes.push(`${route}: ${r.error !== undefined ? JSON.stringify(r.error).slice(0, 80) : JSON.stringify(r.result)}`);
        } else {
          const asn = sh("lsappinfo", ["find", `pid=${pid}`]).stdout.match(/ASN:[^\s"]+/)?.[0];
          const r = asn === undefined ? { status: 1, stderr: "no ASN" } : sh("lsappinfo", ["setfront", asn]);
          routes.push(`${route}: ${r.status === 0 ? "ok" : String(r.stderr).trim().slice(0, 80)}`);
        }
        const t0 = Date.now();
        while (!ok() && Date.now() - t0 < 4_000) await sleep(50);
      }
      if (!ok()) {
        const last = monitor!.items.at(-1);
        const message = `could not bring ${what} (pid ${pid}${space === undefined || space === null ? "" : `, Space ${space}`}) to the front: now ${last?.front ?? "?"} (pid ${last?.frontPid ?? "?"}), Space ${last?.space ?? "?"} (${routes.join("; ")})`;
        log(message);
        throw new Error(message);
      }
      return routes.join("; ");
    };
    activateUser = async () => { await bringToFront(f.userPid!, "the user's app", baseline?.space ?? homeSpace); };
    if (returnTo !== undefined) {
      const back = returnTo;
      returnHome = () => bringToFront(back.pid, `your full-screen app (${back.bundleId ?? "pid " + back.pid})`, back.space);
    }
    abortIfInput();

    log("launching the user's app and the fixture…");
    launchFixture(built.fixtureUser, "user", f, false);
    f.userPid = Number((await until("the user's app", 15_000, () => fixtureEvents(f).find((e) => e.role === "user" && e.ev === "launched"))).pid);
    launchFixture(built.fixtureMain, "main", f, true);
    f.mainPid = Number((await until("the fixture", 15_000, () => fixtureEvents(f).find((e) => e.role === "main" && e.ev === "launched"))).pid);
    log(`the user's app in front: ${await bringToFront(f.userPid, "the user's app")}`);
    abortIfInput();
    const landedOn = monitor.items.at(-1)!.space;
    if (returnTo !== undefined) {
      // From full screen: the user's app opened on a regular desktop (a full-screen app's Space takes no other
      // window) and bringing it in front moved the user there. That desktop is the run's Space.
      const here = parseFrontReading(sh(built.tool, ["front"]).stdout);
      if (landedOn === null || landedOn === returnTo.space || here?.spaceType === 4) {
        throw new Error(`could not move you to a regular desktop from full screen (now Space ${landedOn ?? "?"}, type ${here?.spaceType ?? "?"})`);
      }
      homeSpace = landedOn;
      log(`moved you from full screen (Space ${returnTo.space}) to a regular desktop (Space ${landedOn}); you go back at the end`);
    } else if (spaceBefore !== null && landedOn !== null && landedOn !== spaceBefore) {
      // On a desktop the user's app opens where the user is; anywhere else nothing could bring them back.
      throw new Error(`the run started on Space ${spaceBefore}, but the user's app opened on Space ${landedOn}`);
    }
    // The off-Space window: the fixture moves its OWN window to another regular Space (an existing desktop, else one
    // it creates — private SkyLight, which may be allowed for one's own connection), falling back to full screen
    // (its own Space; macOS switches to it, and bringing the user's app back to front returns the user's Space).
    log("putting a fixture window on another Space…");
    await postCommand(built.tool, f, "main", "offspace", {}, 15_000);
    const placed = await until("the fixture's off-Space window", 15_000, () => fixtureEvents(f).find((e) => e.role === "main" && e.ev === "offspace"));
    offspaceMethod = String(placed.method);
    log(`off-Space window: ${offspaceMethod}${placed.error ? ` (earlier attempts: ${String(placed.error)})` : ""}`);
    await sleep(800);
    log(`back to your Space: ${await bringToFront(f.userPid, "the user's app on your Space", homeSpace)}`);
    await sleep(500);
    abortIfInput();
    const now = monitor.items.at(-1)!;
    baseline = { frontPid: f.userPid, front: now.front, space: now.space };
    log(`baseline: frontmost ${baseline.front} (pid ${baseline.frontPid}), Space ${baseline.space ?? "?"}`);

    // One connection per session: a client is attached to ONE session at a time (a second attach moves it).
    const token = readFileSync(join(home, "test-secrets", "harness-token"), "utf8").trim();
    client = await DaemonClient.connect(daemon.socket);
    await client.hello(token, "cu-live");
    askClient = await DaemonClient.connect(daemon.socket);
    await askClient.hello(token, "cu-live-ask");
    const mainSid = await openSession(client, work, "bypass");
    const askSid = await openSession(askClient, work, "ask");
    probe = new LineProcess<ProbeEvent>(spawn(built.viewProbe, ["--socket", socket, "--home", home, "--session", mainSid, "--max-fps", "10", "--max-width", "480"], { stdio: ["pipe", "pipe", "pipe"] }),
      (l) => { try { return JSON.parse(l) as ProbeEvent; } catch { return undefined; } });
    await until("the mirror probe's subscription", 10_000, () => {
      const err = probe!.items.find((p) => p.ev === "error");
      if (err !== undefined) throw new Error(`the view probe failed: ${JSON.stringify(err)}`);
      return probe!.items.some((p) => p.ev === "subscribed");
    });
    if (o.realApps) {
      realApps = realAppsPreflight(root, log);
      // Opening documents can bring an app forward (that is part of what is tested later): give the user back
      // their app before the scenarios start.
      await sleep(2_000);
      await activateUser();
    }
    abortIfInput();

    // ── scenarios ──────────────────────────────────────────────────────────────────────────────────────────────
    /** One scenario: its before-commands, the ComputerV2 call, the 3 s watch, then every check. */
    const runScenario = async (s: Scenario): Promise<{ result: ScenarioResult; facts: Record<string, unknown>; output: string; since: number; end: number }> => {
      const t0 = Date.now();
      let facts: Record<string, unknown> = {};
      let output = "";
      let since = t0;
      let end = t0;
      let result: ScenarioResult;
      try {
        abortIfInput();
        for (const c of s.before ?? []) await postCommand(built.tool, f, c.role, c.cmd, c.args ?? {});
        since = Date.now();
        const sid = s.session === "ask" ? askSid : mainSid;
        const timeout = s.timeoutMs ?? 60_000;
        const turn = await runTurn(s.session === "ask" ? askClient! : client!, sid, computerV2Message(scriptOf(s), timeout), timeout + 60_000, s.answer);
        const t1 = Date.now();
        // A rung-4 fallback DURING the action is this scenario's failure: the real pointer moved, or keys/clicks
        // reached the user's app (which is in front). Not the HID idle counter: SkyLight's background pid route
        // (rung 3) resets it like real input. After the action, real input (that counter) stops the run.
        const moved = pointerMoves(monitor!.items, since, t1);
        inputWatchFrom = t1;
        while (Date.now() < t1 + WATCH_AFTER_MS) { abortIfInput(); await sleep(50); }
        end = Date.now();
        output = turn.output;
        facts = markerFacts(turn.output);
        const state = s.dump === true ? await dumpState(built.tool, f) : undefined;
        const events = fixtureEvents(f);
        const checks = s.verify({
          output: turn.output, isError: turn.isError, facts, events, since,
          ...(state === undefined ? {} : { state }), probe: probe!.items.filter((p) => p.t >= since), metrics: readMetrics(home, since),
          shots: shotsSince(built.tool, home, since),
        });
        if (s.session === "ask") checks.push(...cardChecks(turn.cards, s.foregroundCard === true));
        const leaked = events.filter((e) => e.role === "user" && (e.ev === "user.key" || e.ev === "user.mouse") && e.t >= since && e.t <= t1);
        checks.push(check("the real pointer stayed put and your app got no keys or clicks (no rung-4 fallback)", moved.length === 0 && leaked.length === 0,
          [moved.length > 0 ? `pointer moved at +${moved.map((t) => t - since).join(", +")} ms` : "", leaked.length > 0 ? `your app got ${leaked.map((e) => e.ev).join(", ")}` : ""].filter(Boolean).join("; ")));
        const focus = focusChecks(monitor!.items, since, t1 + WATCH_AFTER_MS, baseline!, s.allowExcursionMs);
        checks.push(...focus.checks);
        // Whether the deliberate self-activation REALLY took (macOS 14+ may refuse it) — else the scenario proves less.
        const steals = events.filter((e) => e.role === "main" && e.ev === "activated" && e.t >= since);
        const note = typeof facts.skipped === "string" ? `skipped: ${facts.skipped}`
          : s.allowExcursionMs === undefined ? (s.name.startsWith("bind off-Space") ? `off-Space by ${offspaceMethod}` : undefined)
            : steals.length === 0 ? "no steal attempt was logged"
              : `steal ${steals.some((e) => e.took === true) ? "TOOK" : "did not take (macOS refused the activation)"}; your app was away ${focus.longestAwayMs} ms`;
        const status = statusOf(checks) === "pass" && typeof facts.skipped === "string" ? "skip" : statusOf(checks);
        result = { name: s.name, group: s.group, status, ms: Date.now() - t0, checks, ...(note === undefined ? {} : { note }) };
      } catch (err) {
        if (err instanceof Aborted) throw err;
        end = Date.now();
        result = { name: s.name, group: s.group, status: "fail", ms: Date.now() - t0, checks: [check("ran", false, err instanceof Error ? err.message : String(err))] };
      }
      // Never carry a stolen focus into the next scenario.
      if (monitor!.items.at(-1)?.frontPid !== baseline!.frontPid) {
        await activateUser().catch((e: unknown) => log(`could not restore your app: ${e instanceof Error ? e.message : String(e)}`));
        await sleep(500);
      }
      if (result.status === "fail") failedOutputs.set(result.name, output.slice(0, 6_000));
      return { result, facts, output, since, end };
    };

    // `--script <file>`: run ONE ad-hoc ComputerV2 script (after the prelude) on the fixture and print its output —
    // for working out what a scenario sees. Nothing else runs.
    const scenarios: Scenario[] = o.script !== undefined
      ? [{ name: `script ${o.script}`, group: "script", code: readFileSync(o.script, "utf8"), verify: (ctx) => [check("ran", !ctx.isError, ctx.output.slice(-300))] }]
      : [...SCENARIOS, ...(o.realApps ? REAL_APP_SCENARIOS : [])].filter((s) => o.only === undefined || o.only.toLowerCase().split("|").some((part) => s.name.toLowerCase().includes(part)));
    for (const s of scenarios) {
      const r = await runScenario(s);
      if (o.script !== undefined) log(`script output:\n${r.output}`);
      results.push(r.result);
    }

    // ── any app (`--apps`, and with --real-apps VS Code and Chrome when installed) ─────────────────────────────
    const deps = liveResolveDeps();
    const wanted = [...parseApps(o.apps), ...(o.realApps ? DEFAULT_GENERIC_APPS.map((d, i) => ({ query: d.query, key: `default${i}`, optional: true })) : [])];
    const genericApps: GenericApp[] = [];
    for (const w of wanted) {
      const found = resolveApp(w.query, deps);
      if (found !== undefined) genericApps.push({ query: w.query, key: w.key, bundleId: found.bundleId });
      else if (!("optional" in w)) results.push({ name: `${w.query}: resolve`, group: `app ${w.query}`, status: "skip", ms: 0, checks: [], note: "not installed (by bundle id, LaunchServices name, or bundle names)" });
    }
    const windows: Array<{ result: ScenarioResult; since: number; end: number }> = [];
    for (const a of genericApps) {
      const rows = await runGenericApp(a, runScenario, async (code) => {
        const turn = await runTurn(client!, mainSid, computerV2Message(`${GENERIC_PRELUDE}\n${code}`, 30_000), 90_000);
        return { output: turn.output, isError: turn.isError, facts: markerFacts(turn.output) };
      }, async () => {
        await activateUser();
        await sleep(500);
        inputWatchFrom = Date.now();
      });
      for (const r of rows) { results.push(r.result); windows.push(r); }
    }
    // The route behind each failure: the helper's own act/bind log lines in that action's window, plus the rungs the
    // daemon's metrics recorded (one `log show` for the whole run).
    const failed = windows.filter((w) => w.result.status === "fail");
    if (failed.length > 0) attachRoutes(failed, helperPid!, runStartedAt, home);

    // ── performance ────────────────────────────────────────────────────────────────────────────────────────────
    if (o.only === undefined) {
      // The streaming measurement runs inside a turn that keeps working in the canvas: the helper streams a window
      // at full rate only while it is being worked in (idle after 3 s → 1 fps; after the turn, a stream that has
      // not changed pauses, peeking every 30 s) — measured without a turn, "streaming" was a paused mirror.
      const streamTurn = (): Promise<unknown> => runTurn(client!, mainSid, computerV2Message(`${PRELUDE}
const canvas = await apps.open(${JSON.stringify(FIXTURE_MAIN.name)}, { window: "Fixture Canvas" });
await canvas.screenshot({ emit: false });
const t0 = Date.now();
while (Date.now() - t0 < 14000) { await canvas.click([4, 4]); await sleep(700); }
report({ ok: true });`, 40_000), 100_000);
      results.push(...await perf(built, f, helperPid, daemon.pid, probe, monitor, baseline, abortIfInput, streamTurn));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: err instanceof Aborted ? "ABORTED" : "setup", group: "run", status: "fail", ms: 0, checks: [check(err instanceof Aborted ? "no real input during the run" : "the run's setup", false, message)] });
  } finally {
    log("cleaning up…");
    const cleanup: Check[] = [];
    const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
      try { await fn(); cleanup.push(check(name, true)); } catch (err) { cleanup.push(check(name, false, err instanceof Error ? err.message : String(err))); }
    };
    if (realApps !== undefined) await step("closed what the real-apps scenarios opened", () => realApps!.cleanup());
    for (const role of ["main", "user"] as const) {
      const pid = role === "main" ? f.mainPid : f.userPid;
      if (pid === undefined) continue;
      await step(`quit the ${role === "main" ? "fixture" : "user's app"}`, async () => {
        await postCommand(built.tool, f, role, "quit", {}, 5_000).catch(() => undefined);
        const t0 = Date.now();
        while (processAlive(pid) && Date.now() - t0 < 8_000) await sleep(50);
        if (processAlive(pid)) { process.kill(pid, "SIGTERM"); await sleep(500); }
        if (processAlive(pid)) throw new Error(`pid ${pid} is still running`);
      });
    }
    // From a full-screen start (an abort included): back to the user's full-screen app and its Space — while the
    // helper (test.activate) is still up, after the fixtures (one of them full screen) are gone.
    if (returnHome !== undefined) await step(`returned you to your full-screen app and Space ${returnTo!.space}`, async () => { log(`back to full screen: ${await returnHome!()}`); });
    if (probe !== undefined) await step("stopped the mirror probe", () => probe!.stop());
    client?.close();
    askClient?.close();
    if (daemon !== undefined) await step("stopped the live daemon", () => daemon!.proc.stop(10_000));
    if (helperPid !== undefined) await step("quit the helper instance", async () => {
      try { process.kill(helperPid!, "SIGTERM"); } catch { /* gone */ }
      const t0 = Date.now();
      while (processAlive(helperPid!) && Date.now() - t0 < 5_000) await sleep(50);
      if (processAlive(helperPid!)) throw new Error(`helper pid ${helperPid} is still running`);
    });
    if (clipboard.length > 0) await step("restored the clipboard's text", () => { sh("pbcopy", [], clipboard); });
    if (monitor !== undefined && returnTo !== undefined && returnHome !== undefined) {
      await sleep(800);
      const last = monitor.items.at(-1);
      cleanup.push(check("you are back in your full-screen app, on its Space", last !== undefined && last.space === returnTo.space && last.frontPid === returnTo.pid, `Space ${last?.space}, frontmost ${last?.front} (pid ${last?.frontPid})`));
    } else if (monitor !== undefined && baseline !== undefined) {
      await sleep(800);
      const last = monitor.items.at(-1);
      cleanup.push(check("you are back on your Space", last === undefined || baseline.space === null || last.space === baseline.space, `Space ${last?.space}`));
    }
    await monitor?.stop();
    if (!o.keepTemp) rmSync(root, { recursive: true, force: true });
    else log(`kept ${root}`);
    results.push({ name: "cleanup", group: "run", status: statusOf(cleanup), ms: 0, checks: cleanup });
  }
  return results;
}

// ── any app: the generic focus check ────────────────────────────────────────────────────────────────────────────

type Row = { result: ScenarioResult; since: number; end: number };
type RunScenario = (s: Scenario) => Promise<Row & { facts: Record<string, unknown>; output: string }>;
type SetupTurn = (code: string) => Promise<{ output: string; isError: boolean; facts: Record<string, unknown> }>;

/** The real lookups `resolveApp` uses: Spotlight, each bundle's Info.plist (plutil), and the app folders. */
function liveResolveDeps(): ResolveDeps {
  const plists = new Map<string, Record<string, unknown> | undefined>();
  return {
    mdfind: (query) => sh("mdfind", [query]).stdout.split("\n"),
    infoPlist: (appPath) => {
      if (!plists.has(appPath)) {
        const r = sh("plutil", ["-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")]);
        let v: Record<string, unknown> | undefined;
        try { v = r.status === 0 ? JSON.parse(r.stdout) as Record<string, unknown> : undefined; } catch { v = undefined; }
        plists.set(appPath, v);
      }
      return plists.get(appPath);
    },
    dirs: ["/Applications", join(homedir(), "Applications"), "/System/Applications"],
    listApps: (dir) => {
      const out: string[] = [];
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const e of entries) {
        if (e.endsWith(".app")) out.push(join(dir, e));
        else if (!e.startsWith(".")) {
          try { for (const sub of readdirSync(join(dir, e))) if (sub.endsWith(".app")) out.push(join(dir, e, sub)); } catch { /* not a folder */ }
        }
      }
      return out;
    },
  };
}

/** The pids of a running app by bundle id (LaunchServices' own table — `lsappinfo`, no Apple Event). */
function appPids(bundleId: string): number[] {
  const out = sh("lsappinfo", ["info", "-only", "pid", bundleId]).stdout;
  return [...out.matchAll(/"pid"\s*=\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
}

/**
 * One app, every action its own asserted row: bind on this desktop; the on-desktop plan; off-Space (only for an app
 * this run launched, through its window's full-screen button — a SETUP turn, not asserted, after which the user is
 * brought back to their Space); then the app is left as found.
 */
async function runGenericApp(a: GenericApp, runScenario: RunScenario, setupTurn: SetupTurn, returnUser: () => Promise<void>): Promise<Row[]> {
  const rows: Row[] = [];
  const group = `app ${a.query}`;
  const skipRow = (label: string, reason: string): Row => ({ result: { name: `${a.query}: ${label}`, group, status: "skip", ms: 0, checks: [], note: reason }, since: 0, end: 0 });
  // An app the bind LAUNCHES may activate itself as it starts (Chrome does); the guardian puts your app back — the
  // same allowance as the fixture's own self-activation scenarios.
  const bind = await runScenario({ ...genericScenario(a, "bind on this desktop", "bind"), allowExcursionMs: 500 });
  rows.push(bind);
  if (bind.facts.installed === false) return rows;
  const wasRunning = typeof bind.facts.wasRunning === "boolean" ? bind.facts.wasRunning : undefined;
  const bundleId = typeof bind.facts.bundleId === "string" ? bind.facts.bundleId : undefined;
  if (bind.facts.bound === true) {
    const refs = Number(bind.facts.refs ?? 0);
    for (const step of onDesktopPlan(refs)) {
      const skipped = visualSkipReason(wasRunning, bind.facts.onScreen, step.action);
      rows.push(skipped !== undefined ? skipRow(step.label, skipped) : await runScenario(genericScenario(a, step.label, step.action)));
    }
    if (refs >= 4) rows.push(skipRow("no accessibility tree: a coordinate click + a wheel scroll", `the app has an accessibility tree (${refs} refs)`));
    const reason = offSpaceSkipReason(wasRunning);
    if (reason !== undefined) rows.push(skipRow("off-Space", reason));
    else {
      const setup = await setupTurn(SCRIPTS.fullScreen(a));
      if (typeof setup.facts.skipped === "string") rows.push(skipRow("off-Space", String(setup.facts.skipped)));
      else if (setup.isError || setup.facts.fullScreen !== true) {
        rows.push({ result: { name: `${a.query}: off-Space setup (its full-screen button)`, group, status: "fail", ms: 0, checks: [check("full screen", false, setup.output.slice(-200))] }, since: 0, end: 0 });
        await returnUser().catch(() => undefined);
      } else {
        await returnUser();
        for (const step of offSpacePlan()) rows.push(await runScenario(genericScenario(a, step.label, step.action, true)));
      }
    }
  } else {
    rows.push(skipRow("the remaining actions", "the bind failed"));
  }
  // Leave it as found.
  const plan = restorePlan(wasRunning, bind.output);
  const t0 = Date.now();
  const checks: Check[] = [];
  if (plan.quit && bundleId !== undefined) {
    for (const pid of appPids(bundleId)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    await until(`${a.query} to quit`, 10_000, () => appPids(bundleId).length === 0).catch(() => undefined);
    checks.push(check("quit the app this run launched", appPids(bundleId).length === 0, `still running: ${appPids(bundleId).join(", ")}`));
  } else if (plan.closeOpenedWindow) {
    const closed = await setupTurn(SCRIPTS.closeOpened(a));
    checks.push(check("closed the window this run opened", closed.facts.closed === true, closed.output.slice(-200)));
  } else {
    checks.push(check("nothing to undo: the app was already running and no window was opened", true));
  }
  rows.push({ result: { name: `${a.query}: left as found`, group, status: statusOf(checks), ms: Date.now() - t0, checks }, since: 0, end: 0 });
  return rows;
}

/** `log show`'s timestamp ("2026-10-09 11:15:17.723456+0100") as epoch ms. */
export function parseLogTimestamp(ts: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(\d{2})$/.exec(ts.trim());
  return m === null ? Number.NaN : Date.parse(`${m[1]}T${m[2]!.slice(0, 12)}${m[3]}:${m[4]}`);
}

/** The route behind each failed action: the helper's act/bind log lines in its window, and the daemon's rungs. */
function attachRoutes(failed: Row[], helperPid: number, since: number, home: string): void {
  const d = new Date(since - 2_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const out = sh("log", ["show", "--style", "ndjson", "--start", start, "--predicate", `subsystem == "com.winter.computeruse" AND processIdentifier == ${helperPid}`]).stdout;
  const lines = out.split("\n").flatMap((l) => {
    try {
      const o = JSON.parse(l) as { timestamp?: string; category?: string; eventMessage?: string };
      return o.timestamp !== undefined && o.eventMessage !== undefined ? [{ t: parseLogTimestamp(o.timestamp), category: o.category ?? "", message: o.eventMessage }] : [];
    } catch { return []; }
  });
  for (const w of failed) {
    const helper = lines.filter((l) => l.t >= w.since - 200 && l.t <= w.end && (l.category === "act" || l.category === "bind")).slice(0, 3).map((l) => l.message);
    const rungs = readMetrics(home, w.since).filter((m) => typeof m.ts === "number" && m.ts <= w.end && (m.rung !== undefined || m.error !== undefined))
      .map((m) => `${String(m.primitive)}${m.rung !== undefined ? ` rung ${String(m.rung)}` : ""}${m.error !== undefined ? ` ${String(m.error)}` : ""}`);
    const route = [rungs.length > 0 ? `routes: ${rungs.join(", ")}` : "", helper.length > 0 ? `helper: ${helper.join(" | ")}` : ""].filter(Boolean).join(" · ");
    if (route.length > 0) w.result.note = [w.result.note, route].filter(Boolean).join(" · ");
  }
}

function readMetrics(home: string, since: number): Record<string, unknown>[] {
  try {
    return readFileSync(join(home, "logs", "automation-metrics.jsonl"), "utf8").split("\n").flatMap((l) => {
      try { const o = JSON.parse(l) as Record<string, unknown>; return typeof o.ts === "number" && o.ts >= since ? [o] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function cardChecks(cards: readonly SessionEvent[], foregroundCard = false): Check[] {
  const c = cards[0] as (SessionEvent & { summary?: string; toolName?: string; options?: Array<{ id: string }> }) | undefined;
  const summaries = cards.map((e) => String((e as { summary?: string }).summary));
  const perApp = summaries.filter((x) => x === expectedCardSummary()).length;
  const others = summaries.filter((x) => x !== expectedCardSummary());
  return [
    check("the per-app card was raised", c !== undefined, "no approval_requested"),
    check("it names the app and its bundle id", c?.summary === expectedCardSummary(), String(c?.summary)),
    check("it offers once / this session / always", JSON.stringify((c?.options ?? []).map((x) => x.id)) === JSON.stringify(["once", "session", "always"]), JSON.stringify(c?.options)),
    foregroundCard
      // The scenario provokes a foreground request (denied by the rig): one per-app card, and only the
      // foreground card besides it.
      ? check("one per-app card, plus only the foreground card", perApp === 1 && others.every((x) => /bring .* to the front/.test(x)), JSON.stringify(summaries))
      : check("one card for the call", cards.length === 1, `${cards.length} cards`),
  ];
}

/** The focus check: nothing changes — or, for a scenario that provokes a self-activation, one short excursion back. */
function focusChecks(samples: readonly MonitorSample[], from: number, to: number, base: FocusBaseline, allowExcursionMs?: number): { checks: Check[]; longestAwayMs: number } {
  const v = focusViolations(samples, from, to, base);
  const lastInWindow = samples.filter((s) => s.t >= from && s.t <= to).at(-1);
  if (allowExcursionMs === undefined) {
    return { checks: [check("your frontmost app and Space never changed (sampled every 20 ms, until 3 s after)", v.length === 0, describeViolations(v, from))], longestAwayMs: 0 };
  }
  let longest = 0;
  let start: number | undefined;
  let prevT: number | undefined;
  for (const s of samples.filter((x) => x.t >= from && x.t <= to)) {
    const bad = v.some((x) => x.t === s.t);
    if (bad && start === undefined) start = s.t;
    if (!bad && start !== undefined) { longest = Math.max(longest, s.t - start); start = undefined; }
    prevT = s.t;
  }
  if (start !== undefined && prevT !== undefined) longest = Math.max(longest, prevT - start + 1);
  return {
    checks: [
      check(`any jump away from your app was undone within ${allowExcursionMs} ms`, longest <= allowExcursionMs, `away for ${longest} ms: ${describeViolations(v, from)}`),
      check("your app is frontmost again afterwards", lastInWindow === undefined || lastInWindow.frontPid === base.frontPid, `frontmost pid ${lastInWindow?.frontPid}`),
    ],
    longestAwayMs: longest,
  };
}

async function perf(built: Built, f: Fixtures, helperPid: number, daemonPid: number, probe: LineProcess<ProbeEvent>, monitor: LineProcess<MonitorSample>, base: FocusBaseline, abortIfInput: () => void, streamTurn: () => Promise<unknown>): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  // Streaming: the canvas animates while a turn works in it; the probe is subscribed to the session's frames.
  let t0 = Date.now();
  await postCommand(built.tool, f, "main", "animate", { on: true });
  const turn = streamTurn().catch((e: unknown) => e);
  await sleep(2_500);
  const stream = summarizeTop(await topDelta(helperPid, 2, 5), 5);
  await turn;
  await postCommand(built.tool, f, "main", "animate", { on: false });
  abortIfInput();
  const framesWhileStreaming = probe.items.filter((p) => p.ev === "frame" && p.t >= t0).length;
  out.push({
    name: "helper CPU while streaming a changing window", group: "perf", ms: Date.now() - t0,
    status: stream !== undefined && stream.cpuMean <= LIMITS.streamCpu && framesWhileStreaming > 0 ? "pass" : "fail",
    checks: [check("frames streamed", framesWhileStreaming > 0, "no frames"), check(`helper CPU ≤ ${LIMITS.streamCpu}%`, stream !== undefined && stream.cpuMean <= LIMITS.streamCpu, JSON.stringify(stream))],
    note: stream === undefined ? undefined : `helper ${stream.cpuMean.toFixed(1)}% CPU (max ${stream.cpuMax.toFixed(1)}%), ${framesWhileStreaming} frames`,
  });
  // Idle: no subscriber, nothing running.
  await probe.stop();
  await sleep(5_000);
  t0 = Date.now();
  const [helperIdle, daemonIdle] = await Promise.all([topDelta(helperPid, 3, 5), topDelta(daemonPid, 3, 5)]);
  abortIfInput();
  for (const [who, samples] of [["helper", helperIdle], ["daemon", daemonIdle]] as const) {
    const s = summarizeTop(samples, 5);
    const checks = [
      check(`${who} idle CPU ≤ ${LIMITS.idleCpu}%`, s !== undefined && s.cpuMean <= LIMITS.idleCpu, JSON.stringify(s)),
      check(`${who} idle wakeups ≤ ${LIMITS.idleWakeups}/s`, s !== undefined && s.wakeupsPerSecondMax <= LIMITS.idleWakeups, JSON.stringify(s)),
    ];
    out.push({ name: `${who} idle after the scenarios`, group: "perf", ms: Date.now() - t0, status: statusOf(checks), checks, note: s === undefined ? undefined : `${s.cpuMean.toFixed(2)}% CPU, ${s.wakeupsPerSecondMax.toFixed(1)} wakeups/s` });
  }
  const v = focusViolations(monitor.items, t0, Date.now(), base);
  out.push({ name: "focus unchanged through the perf phase", group: "perf", ms: 0, status: v.length === 0 ? "pass" : "fail", checks: [check("unchanged", v.length === 0, describeViolations(v, t0))] });
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  if (process.platform !== "darwin") throw new Error("macOS only");
  if (!o.dryRun && process.env.WINTER_CU_LIVE_TESTS !== "1") {
    console.error("e2e:cu-live: refusing to start — this suite takes over the screen. Set WINTER_CU_LIVE_TESTS=1 to run it (or pass --dry-run).");
    process.exit(2);
  }
  const built = buildAll(log);
  const startedAt = Date.now();
  const results = o.dryRun ? await dryRun(built, o) : await (async () => {
    console.error([
      "",
      "  ComputerV2 LIVE end-to-end suite",
      "  It uses the screen for about 2-3 minutes (longer with --real-apps): windows appear, one goes full screen on",
      "  its own Space and you are brought back to yours. DON'T type, click or move the mouse until it finishes —",
      "  real input stops the run. Your clipboard's text is restored at the end (rich clipboard content is not).",
      "  Start it from a regular desktop, not from a full-screen app (the user's app must open on your Space).",
      "  Nothing touches ~/.winter*, the Keychain, or your own Winter.",
      "",
    ].join("\n"));
    if (!o.yes) for (let i = 5; i > 0; i--) { process.stderr.write(`  starting in ${i}… (ctrl+C to cancel)\r`); await sleep(1_000); }
    process.stderr.write("\n");
    try {
      return await liveRun(built, o);
    } catch (err) {
      // liveRun reports its own setup errors and aborts as rows; anything escaping it still ends the run in red.
      return [{ name: "error", group: "run", status: "fail", ms: 0, checks: [check("the run finished", false, err instanceof Error ? err.message : String(err))] }] satisfies ScenarioResult[];
    }
  })();
  console.log(renderTable(results));
  // `--report <file>`: every row's checks in full, plus each failing scenario's tool output (capped) — what the
  // table's one cut-short detail column cannot hold.
  // A live run always leaves a report (out/cu-live/last-run.json unless --report says where) — the completion
  // window names it.
  const report = o.report ?? (o.dryRun ? undefined : join(OUT_DIR, "last-run.json"));
  if (report !== undefined) writeFileSync(report, `${JSON.stringify({ results, outputs: Object.fromEntries(failedOutputs) }, null, 2)}\n`);
  // After the cleanup (liveRun has returned): the completion window, so the user knows the run ended. Never during
  // the run, never for a dry run, never with --no-done-window (CI).
  if (!o.dryRun && !o.noDoneWindow) {
    const model = doneWindowModel(results, Date.now() - startedAt, Date.now(), report ?? "");
    const shown = sh("open", doneWindowOpenArgs(built.fixtureDone, model));
    if (shown.status !== 0) log(`the completion window did not open: ${shown.stderr.trim()}`);
  }
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`e2e:cu-live: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
