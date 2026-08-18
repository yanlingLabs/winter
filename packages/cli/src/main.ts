import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolveNormaHome, KeychainSecretStore, startDaemon, TOKEN_NAMES, loadSettings, CORE_VERSION, runWorkflowSubprocess, runFunctionsExecSubprocess, isFunctionsExecWorkerInvocation, resolveNormaProfile } from "@norma/core";
import type { Settings } from "@norma/core";
import { METHODS, type ApprovalPolicy, type Task } from "@norma/protocol";
import { POLICY_ORDER } from "./tui/policy-order";
import { NormaClient } from "./client";
import { checkCodeSession, filterCodeSessions, sessionModeMarker } from "./session-mode";
import { applyEvent, isStalled, type WatchdogState } from "./watchdog";
import { streamAction } from "./stream-state";
import { updateSubagents, type CliSubagent } from "./subagent-state";
import { decodeKey, footerKeyAction } from "./keys";
import {
  DIM,
  RESET,
  SPINNER_FRAMES,
  NONTTY_TASK_LINE,
  NONTTY_SPAWN_LINE,
  NONTTY_FINISH_LINE,
  agentFinishLines,
  agentSpawnLine,
  renderAgentsFooter,
  renderModeBar,
  renderStatusLine,
  renderTaskBlock,
  physicalRows,
  trackLineStart,
  truncateStatusLine,
  turnSummaryLine,
  upsertTask,
  type FooterSelection,
} from "./task-block";
import {
  applyFreshPluginConsent,
  buildConsentBlock,
  installNeedsConsentHint,
  installPlugin,
  missingConsents,
  removePluginDir,
  removePluginFromSettings,
  revokePluginTokenBestEffort,
  setPluginEnabled,
  stripPluginConsents,
} from "./plugin-cli";
import { parseModelArgs, validateEffort, validateModelSlug } from "./model-cli";
import { formatElapsed, formatTokens } from "./task-display";
import { formatRoutineDetail } from "./routines-cli";
import { runAgentsCommand } from "./agents-cli";
import { mountAgents } from "./tui/agents-view";
import { MEMORY_USAGE, formatDeleted, formatFactDetail, parseMemoryArgs, runMemoryRoute } from "./memory-cli";
import { formatOptionLines, isOtherChoice, parseQuestionAnswer } from "./questions";
import { parsePlanResponse } from "./plan-response";
import { makeEventBridge, type EventBridge } from "./tui/event-bridge";

const AQUA = "\x1b[38;2;53;214;232m";

/** A raw-mode control-key listener (2e-iii-b Task 6) that owns stdin ONLY while a turn is running
 *  on a TTY (esc-interrupt, shift+tab policy cycle, ↑/↓/Enter footer selection — see §0/§4/§7).
 *  It yields cleanly to any COOKED-mode line reader (readLine/askYesNo, and the y/N approval read)
 *  via a suspend/resume counter: those need line-buffered stdin, so while any of them holds it the
 *  raw handler detaches and cooked mode is restored, then re-attaches when they're done (if a turn
 *  is still running). `activeKeyListener` is the module-level handle those readers reach for — null
 *  outside a turn and on non-TTY, so their suspend/resume calls are safe no-ops there (this is what
 *  keeps the non-TTY `-p` path byte-unchanged). */
interface KeyListener {
  beginTurn(): void; // a turn started → we want the raw handler on
  endTurn(): void; // the turn ended → detach (the composer read owns cooked stdin next)
  suspend(): void; // a cooked-mode reader is taking stdin — detach + restore cooked mode
  resume(): void; // that reader finished — re-attach iff a turn is still running and nobody else holds it
  destroy(): void; // final teardown — detach, restore cooked mode, pause stdin
}
let activeKeyListener: KeyListener | null = null;
// Set synchronously (then reset on the next microtask) by the pending-approval stdin reader (the
// `process.stdin.on("data", …)` installed in run() when approvals are possible) for the exact "data"
// dispatch of a chunk it consumes as a y/N answer. A concurrently-active readLine() — the idle
// composer "› " read, or an ask_user answer read — shares that SAME "data" event, so without this it
// would ALSO submit the chunk as input: a background-agent approval answered while the composer sits
// idle both resolves the approval AND sends "y" as a chat message, starting a spurious turn (the
// live-gate scout bug). LOAD-BEARING INVARIANT: that approval reader is installed once at startup, so
// it is always EARLIER in stdin's listener array than any per-call readLine() onData; Node fires
// "data" listeners in registration order, so the approval reader sets this flag before readLine()
// checks it. Moving/reordering that registration (or making it per-turn) silently reintroduces the
// double-consume with NO test failure — keep it installed before the composer loop.
let approvalConsumedChunk = false;

/** True for exactly the span of the chat composer's `readLine("› ")` call (final-review Finding 1).
 *  readLine() writes its prompt text directly to stdout, bypassing `emit()`'s tracking, so the
 *  closure-local `atLineStart` a repaint would consult is stale-true for the whole wait — an event
 *  arriving mid-composer (bg_task_output from a still-running background task, task_updated from a
 *  co-attached window, …) would otherwise look "safe" to `repaintBlockIfSafe` and paint/erase the
 *  pinned block right under the live prompt, corrupting it. `repaintBlockIfSafe` below is the ONLY
 *  place this is checked — gating it is sufficient to keep the whole erase/repaint cycle inert
 *  during the composer (see the comment on that function), so events can still update state and
 *  emit() can still print transcript text (which just scrolls the prompt down, harmlessly) while
 *  this is true. Module-level (not a runTurnSession local) only because that's where the flag is
 *  read from; it's set/cleared from inside runTurnSession's chat loop, the sole writer. */
let composerActive = false;

function makeKeyListener(onChunk: (chunk: Buffer) => void): KeyListener {
  let attached = false; // raw "data" handler currently on stdin
  let wantActive = false; // a turn is running → we WANT the raw handler on
  let suspendDepth = 0; // cooked-mode readers currently holding stdin (counter, not bool: readLine + a queued approval can both hold it)
  let destroyed = false;
  const handler = (chunk: Buffer) => onChunk(chunk);
  // Reconcile the desired attach state after any input to the four levers above. The raw handler
  // is on iff a turn wants it, no cooked reader holds stdin, we're not torn down, and we're a TTY.
  function sync(): void {
    const shouldAttach = wantActive && suspendDepth === 0 && !destroyed && process.stdin.isTTY;
    if (shouldAttach && !attached) {
      process.stdin.setRawMode(true);
      process.stdin.on("data", handler);
      process.stdin.resume();
      attached = true;
    } else if (!shouldAttach && attached) {
      process.stdin.off("data", handler);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      attached = false;
    }
  }
  return {
    beginTurn() { wantActive = true; sync(); },
    endTurn() { wantActive = false; sync(); },
    suspend() { suspendDepth++; sync(); },
    resume() { if (suspendDepth > 0) suspendDepth--; sync(); },
    destroy() {
      destroyed = true; wantActive = false; sync();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    },
  };
}

async function readSecret(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  let buf = "";
  try {
    for await (const chunk of stdin) {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") { process.stdout.write("\n"); return buf; }
        if (ch === "") { process.stdout.write("\n"); process.exit(130); } // Ctrl-C
        if (ch === "" || ch === "\b") { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        buf += ch;
        process.stdout.write("*");
      }
    }
    return buf;
  } finally {
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
  }
}

// Single y/N question on stdin, reusing the same non-raw "read a chunk, check for a leading y"
// pattern the approval_requested prompt below uses. TTY-guarded by callers; resolves false on EOF.
async function askYesNo(promptText: string): Promise<boolean> {
  activeKeyListener?.suspend(); // yield raw stdin → cooked, so the whole "y\n" line arrives as one chunk
  process.stdout.write(promptText);
  const stdin = process.stdin;
  return new Promise((resolvePromise) => {
    const onData = (d: Buffer) => { cleanup(); resolvePromise(String(d).trim().toLowerCase() === "y"); };
    const onEnd = () => { cleanup(); resolvePromise(false); };
    function cleanup() { stdin.off("data", onData); stdin.off("end", onEnd); activeKeyListener?.resume(); }
    stdin.once("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

// Reads one line of free-form text from stdin — same one-shot "data"/"end" pattern as askYesNo,
// but returns the raw trimmed text instead of parsing y/n. Used for ask_user question answers AND
// the chat composer. Suspends the raw control-key listener (Task 6) while it owns stdin so it gets
// a cooked, line-buffered read. TTY-guarded by callers. Returns the trimmed line, or `null` on EOF
// (ctrl+D / closed stdin) — the composer uses null to mean "exit", distinct from "" (empty line →
// re-prompt); the question-menu callers coalesce null to "" since EOF there is just an empty answer.
async function readLine(promptText: string): Promise<string | null> {
  activeKeyListener?.suspend();
  process.stdout.write(promptText);
  const stdin = process.stdin;
  return new Promise((resolvePromise) => {
    const done = (v: string | null) => { cleanup(); resolvePromise(v); };
    const onData = (d: Buffer) => {
      // A chunk the pending-approval reader consumed this same dispatch (its handler ran first and
      // set the flag) is a y/N answer, NOT input for this read — skip it and keep listening (hence
      // `.on`, not `.once`: a skipped chunk must re-arm) for the real next line. Every RESOLVE path
      // still funnels through done()→cleanup()→stdin.off, so the `.on` listener is removed exactly
      // once a real line lands — no leaked listener on the happy path (flag false → resolve once).
      if (approvalConsumedChunk) return;
      done(String(d).trim());
    };
    const onEnd = () => done(null);
    function cleanup() { stdin.off("data", onData); stdin.off("end", onEnd); activeKeyListener?.resume(); }
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

async function getToken(): Promise<string> {
  const t = await new KeychainSecretStore().get(TOKEN_NAMES.harness);
  if (!t) throw new Error("no harness token — is the daemon installed? run: norma daemon run");
  return t;
}

function socketPath(): string {
  return join(resolveNormaHome(), "run", "core.sock");
}

const AUTOLAUNCH_POLL_MS = 200;
const AUTOLAUNCH_TIMEOUT_MS = 8000;

// Lifecycle Task 5: the pure core behind "norma auto-launches Norma.app when the daemon is down."
// fs/exec/clock/env are all seams (deps) so the 3 outcomes are unit-testable with zero real process
// launches — connect() below wires the real ones. Dev is unaffected: my bun daemon already has the
// socket live → "already-up" before anything else runs; without it and without an installed app
// bundle in the dev tree → "no-app", and the caller preserves today's getToken() dev-hint error.
export async function ensureDaemonReachable(deps: {
  socketExists: () => boolean;
  appBundlePresent: () => boolean; // `open -Ra "Norma"` / bundle-id lookup succeeds
  launchApp: () => void; // `open -g -b com.norma.app` — comes up as the menu-bar agent, no window
  sleepMs: (ms: number) => Promise<void>;
  now: () => number;
  noAutoLaunch: boolean; // NORMA_NO_AUTOLAUNCH — escape hatch for scripts/CI, always "no-app"
}): Promise<"already-up" | "launched" | "no-app"> {
  if (deps.socketExists()) return "already-up";
  if (deps.noAutoLaunch || !deps.appBundlePresent()) return "no-app";
  deps.launchApp();
  const deadline = deps.now() + AUTOLAUNCH_TIMEOUT_MS;
  while (deps.now() < deadline) {
    // A real scheduler handoff before each check: the socket is created by a separate OS process
    // (the app finishing its launch), not by anything on our own microtask chain. Production's
    // sleepMs (Bun.sleep) already yields for real, but relying on that alone starves this check
    // when a poll cycle's delay resolves synchronously (e.g. an instantly-resolving test stub) —
    // a chain of already-resolved-promise awaits never lets a pending macrotask (here, the daemon
    // actually coming up) run. Confirmed empirically: without this line, the second unit test
    // below (socket appears via a mocked setTimeout) times out and throws instead of returning
    // "launched", even though nothing else about the loop's logic changes.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (deps.socketExists()) return "launched";
    await deps.sleepMs(AUTOLAUNCH_POLL_MS);
  }
  if (deps.socketExists()) return "launched";
  throw new Error("Norma isn't responding — open Norma.app manually, or run: norma daemon run");
}

function appBundlePresent(): boolean {
  // Only a REAL install counts — never a Debug build. mdfind/`open -Ra` also match Xcode
  // DerivedData Debug builds (Spotlight-indexed), which would auto-launch a dev build and
  // break the "dev is unaffected" invariant. DerivedData is never under /Applications.
  return existsSync("/Applications/Norma.app") || existsSync(join(homedir(), "Applications", "Norma.app"));
}

async function connect(name: string, onEvent: (e: any) => void = () => {}): Promise<NormaClient> {
  await ensureDaemonReachable({
    socketExists: () => existsSync(socketPath()),
    appBundlePresent,
    launchApp: () => { Bun.spawnSync(["open", "-g", "-b", "com.norma.app"]); },
    sleepMs: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    noAutoLaunch: !!process.env.NORMA_NO_AUTOLAUNCH,
  });
  // "no-app" falls through here unchanged: getToken() throws its existing dev-hint error below,
  // byte-identical to before this task (the daemon's actually-down error path is untouched).
  return NormaClient.connect({ socketPath: socketPath(), token: await getToken(), clientName: name, onEvent });
}

/** Phase 4b Task 2: connect + call `plugin.revokeToken` + close, for
 *  `revokePluginTokenBestEffort` (plugin-cli.ts) — a down daemon (no socket, no harness token
 *  yet, …) surfaces as a rejected promise, which the caller tolerates rather than treats as fatal. */
async function revokePluginTokenViaDaemon(pluginId: string): Promise<void> {
  const c = await connect(`cli-plugin-revoke-${pluginId}`);
  try {
    await c.pluginRevokeToken(pluginId);
  } finally {
    c.close();
  }
}

// Canned prompt for `norma init`: surveys the project and writes/updates a NORMA.md at its root.
export const INIT_PROMPT =
  "Survey this project to understand it: read the README, the package manifest (package.json/pyproject/Cargo.toml/etc.), and skim the directory structure and a few key source files. Then write a concise NORMA.md at the project root capturing: what this project is, how to build/test/run it, and the key conventions a new contributor should follow. If a NORMA.md already exists, read it and UPDATE it rather than clobbering. Keep it tight and factual.";

// T5 — the dim "how to resume" hint printed after the Ink TUI exits (every Ink chat exit, not just a
// resumed one — mirrors CC's own "you can resume this conversation" chrome). Pure + exported so
// mount.test.ts can assert the EXIT-SEQUENCE ORDERING (mouse-off → unmount → leave escape → this
// hint) through an injected sink, without spinning up a real Ink instance or importing this whole
// module's `import.meta.main`-gated CLI dispatch. Uses the same raw DIM/RESET escapes (task-block.ts)
// this file already writes with elsewhere, rather than a fresh Chalk instance, for one convention.
export function formatResumeHint(sessionId: string): string {
  return `${DIM}\nResume this session with:\n  norma resume ${sessionId}\n${RESET}`;
}

// Chat mode Slice B1 Task 4: the TTY question_asked handler's per-question headline. `header` is
// OPTIONAL since Slice B1 — chat's `AskQuestion` omits it for its simplified card (`header === nil`
// is the wire signal, see `packages/protocol/src/events.ts`'s `QuestionSchema`). A bare template
// literal (`${AQUA}${q.header}${RESET} — ${q.question}`) interpolates the literal string
// "undefined" for a header-less question, giving "undefined — Which tier?". header-present output
// is byte-identical to before this feature (only the header segment takes AQUA, same as always);
// header-less just colors the question itself, with no "— " prefix. Pure + exported (mirrors
// `formatResumeHint` above) so this is unit-testable without a TTY/readline round-trip.
export function formatQuestionHeadlineLine(header: string | undefined, question: string): string {
  return header ? `${AQUA}${header}${RESET} — ${question}` : `${AQUA}${question}${RESET}`;
}

// Branch review (chat-mode Slice B1, FIX 1 — defense in depth): a stored API key containing a
// non-printable or non-ASCII character can make Bun's real `fetch` throw with the header's VALUE
// embedded verbatim in its own error text (confirmed live against both Exa's `x-api-key` and
// Brave's `X-Subscription-Token` headers) — that text would otherwise become model-visible tool
// output AND land in the session JSONL. `readSecret`'s `.trim()` does NOT strip Unicode category
// Cf codepoints like U+200B (zero-width space) — the single most common artifact of copying a
// token off a web page — so this checks every character explicitly rather than trusting trim.
// Pure + exported (mirrors `formatQuestionHeadlineLine` above) so it's unit-testable without a
// stdin/readSecret round-trip. Returns an explanatory message (not just "invalid") or null when
// the key is clean printable ASCII (0x20-0x7e).
export function invisibleKeyCharWarning(key: string): string | null {
  for (const ch of key) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp > 0x7e) {
      return "that key contains a non-printable or non-ASCII character — often a stray invisible character (like a zero-width space) picked up when copying from a web page. Copy it again and re-paste.";
    }
  }
  return null;
}

// Turn-watching runner (2e-iii-b Task 6 — refactored from the former `runHeadlessAgent`). Wires
// the client, the pinned-block/event machinery, the raw control-key listener, and the stall
// watchdog ONCE, then either runs a SINGLE turn and exits (chat:false — `-p`, `resume id text`,
// `init`; byte-identical to before on the non-TTY path, incl. exit codes + the bg grace-kill) or
// LOOPS (chat:true — bare `norma`, `resume <id>` with no text): after each turn it erases the block
// and shows the `› ` composer, sends the next line, and watches again. ctrl+C / ctrl+D (EOF) tears
// down cleanly (timers cleared, terminal restored, client closed).
async function runTurnSession(opts: { promptOverride?: string; forceAuto?: boolean; existingSessionId?: string; chat: boolean }): Promise<void> {
  const { promptOverride, forceAuto = false, existingSessionId, chat } = opts;

  // Ink TUI cutover (Phase 3a Task 6): the new Ink renderer owns the interactive chat TTY unless the
  // NORMA_LEGACY_CLI escape hatch is set. Everything else — one-shot `-p`, piped/non-TTY, the escape
  // hatch — keeps the byte-identical legacy path below. Decided here (not just at the connect point)
  // because the legacy-only resize handler further down would otherwise paint the pinned block over
  // Ink's surface; `inkMode` gates it off. `bridge` is the connect-time `onEvent` sink that <App>
  // subscribes to (buffers attach-replay until the App mounts). Both are inert on the legacy path.
  const inkMode = chat && !!process.stdout.isTTY && process.env.NORMA_LEGACY_CLI !== "1";
  const bridge: EventBridge | null = inkMode ? makeEventBridge() : null;

  // -p teardown: mirrors Claude Code's headless grace-kill. Any bg tasks still running when the
  // turn completes get a grace period (NORMA_BG_PRINT_WAIT_MS, default 5000ms; 0 = poll until none
  // are running rather than racing a fixed timer) before we force-kill whatever remains. One-shot
  // (chat:false) only — chat mode leaves bg tasks running across turns and tears down via
  // teardownAndExit instead. Uses the enclosing closures (c/sessionId/wdTimer/spinnerTimer).
  async function endHeadlessTurn(exitCode: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    if (wdTimer) clearInterval(wdTimer); // normal completion — stop watching for a stall that didn't happen
    clearInterval(spinnerTimer); // stop the status-line spinner/elapsed tick — the turn is over
    const running = (await c.bgList(sessionId)).filter((t) => t.status === "running");
    if (running.length) {
      const waitMs = Number(process.env.NORMA_BG_PRINT_WAIT_MS ?? 5000);
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        while ((await c.bgList(sessionId)).some((t) => t.status === "running")) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      await c.bgKillAll(sessionId);
    }
    eraseBlockIfPinned(); // clear the pinned chrome (status/tasks/footer/mode bar) before exit — the transcript above stays
    keyListener.destroy(); // restore cooked mode / pause stdin (no-op on non-TTY, so byte-unchanged there)
    c.close();
    process.exit(exitCode);
  }

  // One-shot needs a prompt up front (argv[3] for `-p`, else the promptOverride); chat starts from
  // the composer, so it never reads argv[3] (in `resume <id>` chat, argv[3] is the SESSION id).
  const oneShotPrompt = promptOverride ?? process.argv[3];
  if (!chat && !oneShotPrompt) {
    console.error('usage: norma -p "<prompt>" [--auto|--plan]');
    process.exit(1);
  }
  const auto = forceAuto || process.argv.includes("--auto");
  const plan = process.argv.includes("--plan"); // plan mode: agent must present a plan before editing; ignored if --auto also set
  let policy: ApprovalPolicy = auto ? "auto" : plan ? "plan" : "ask"; // seeds the mode bar; shift+tab cycles it live
  let policyInFlight = false; // in-flight guard — one setPolicy RPC at a time (repeat shift+tab ignored until it settles)
  const pending: string[] = []; // callIds awaiting a y/n on stdin, oldest first
  let sessionId = ""; // set below, before send() — turn_completed can only fire after that
  // T5 resume replay: set ONLY on the Ink `norma resume <id>` route (see the `existingSessionId`
  // branch below) — the seq `<App>`'s replay is expected to reach before it clears its "Resuming
  // conversation…" line. Left `undefined` on every other route (fresh session, legacy/
  // NORMA_LEGACY_CLI chat resume, non-TTY, resumeOneShot) — mountTui/`<App>` treat that exactly like
  // today (no resuming line, ever).
  let resumeTargetSeq: number | undefined;
  // TUI renderer T5 (status chrome): the resume route's per-session model/effort overrides + the
  // row's activity, off the SAME `listSessions()` read the mode gate below already performs (no new
  // wire read). Undefined on every other route — the chrome then shows the global settings values,
  // which IS the daemon's resolution for an override-less session (engine.ts `meta.model || base`).
  let sessionModelOverride: string | undefined;
  let sessionEffortOverride: string | undefined;
  let initialActivity: import("@norma/protocol").SessionActivity | undefined;
  const wd: WatchdogState = { turnRunning: false, toolsInFlight: 0, approvalsPending: 0, lastEventAt: Date.now() };
  let wdTimer: ReturnType<typeof setInterval> | undefined; // one session-long stall poll; cleared on teardown
  let exiting = false; // guard to ensure a single exit path wins (stall watchdog vs endHeadlessTurn vs ctrl+C)
  let streaming = false; // an assistant line is mid-stream on stdout (deltas printed, no newline yet)
  let resolveTurn: (() => void) | null = null; // chat: the main turn_completed resolves this to advance the loop

  // Pinned block (CC parity): TTY-only. `tasks` mirrors the session's current task list (upsert on
  // task_updated). `atLineStart` tracks whether the last byte written to stdout was a newline (the
  // ONLY safe moment to erase+redraw — never mid a streamed delta or bg-task-output chunk, both of
  // which can end without one). `pinnedLineLengths` (Task 6, replacing the old plain `pinnedLines`
  // counter) stores each currently-painted block line's VISIBLE length, so the erase step can
  // compute how many PHYSICAL rows the block occupies at the CURRENT terminal width — correct even
  // after a resize re-wraps already-drawn lines (§8). Non-TTY (piped/-p) is untouched:
  // eraseBlockIfPinned/repaintBlockIfSafe are no-ops there (isTTY gate), so `emit()` degenerates to
  // a plain write and the non-TTY branches keep their exact one-line-per-update output.
  let tasks: Task[] = [];
  let subagents: CliSubagent[] = []; // live child threads of the current turn (2e-ii)
  const selection: FooterSelection = { selectedThreadId: "main", focusIndex: null }; // Task 6 thread selector (footer)
  let atLineStart = true;
  let pinnedLineLengths: number[] = [];

  // Live turn status (Task 4): drives the "⠋ Working… (14s · ↑ 1.2k ↓ 842 tokens)" line printed
  // above the task rows while a turn is running — Claude Code parity. turnRunning/turnStartMs
  // reset on turn_started; streamedChars is a rough token-count proxy while a turn is in flight
  // (the provider's real outputTokens is only known once turn_completed reports it); spinnerIdx is
  // advanced independently by the tick timer below.
  let turnRunning = false;
  let turnStartMs = 0;
  let streamedChars = 0;
  let lastInTokens = 0;
  let lastOutTokens = 0;
  let spinnerIdx = 0;

  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, ""); // visible length = ANSI-stripped length

  function eraseBlockIfPinned(): void {
    if (pinnedLineLengths.length > 0) {
      // §8: count the PHYSICAL rows the painted block occupies at the CURRENT width (a resize may
      // have re-wrapped it since it was drawn) from each line's stored visible length — not the
      // logical line count, which would cursor-up too few rows and strand wrapped fragments.
      const rows = physicalRows(pinnedLineLengths, process.stdout.columns);
      process.stdout.write(`\x1b[${rows}A\x1b[0J`);
      pinnedLineLengths = [];
    }
  }
  function repaintBlockIfSafe(): void {
    // composerActive gate (Finding 1): the `› ` composer owns the screen for the span of its
    // readLine() call — never paint/erase the pinned block during it (see the module-level doc
    // comment). eraseBlockIfPinned() is left ungated deliberately: `pinnedLineLengths` is already
    // empty by the time composerActive goes true (the chat loop erases before showing the prompt),
    // and since repaint never runs while this flag is set, it stays empty — so eraseBlockIfPinned
    // is a no-op for the whole span anyway, with no separate gate needed there.
    if (composerActive || !process.stdout.isTTY || !atLineStart) return;
    // Width passed per-repaint (not cached): terminal resizes between repaints pick up the new
    // width; truncation keeps 1 logical line == 1 physical row so the erase count stays exact.
    const columns = process.stdout.columns;
    const lines: string[] = [];
    if (turnRunning) {
      const activeForm = tasks.find((t) => t.status === "in_progress")?.activeForm ?? "Working";
      const statusLine = renderStatusLine({
        activeForm,
        elapsedMs: Date.now() - turnStartMs,
        inTokens: lastInTokens,
        outTokens: turnRunning ? Math.ceil(streamedChars / 4) : lastOutTokens,
        spinnerFrame: SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]!,
      });
      lines.push(truncateStatusLine(statusLine, columns));
    }
    // Task 6 composition (design §1): [status line][task tree][agents footer][mode bar]. The 2e-ii
    // subagent block is gone (absorbed into the footer). The footer renders itself only while a
    // turn runs OR a subagent is alive; the mode bar always renders in interactive TTY (this whole
    // function is isTTY-gated). Each renderer already truncates every row to one physical line at
    // this width and colors its own spans — no outer wrap here.
    lines.push(...renderTaskBlock(tasks, columns));
    lines.push(...renderAgentsFooter(subagents, selection, turnRunning, Date.now(), columns));
    lines.push(renderModeBar(policy, columns));
    if (lines.length === 0) return;
    for (const l of lines) process.stdout.write(`${l}\n`);
    // Store each line's VISIBLE (ANSI-stripped) length so eraseBlockIfPinned's physical-row math is
    // width-exact regardless of how the terminal is later resized.
    pinnedLineLengths = lines.map((l) => stripAnsi(l).length);
  }
  function refreshBlock(): void { eraseBlockIfPinned(); repaintBlockIfSafe(); }
  // Spinner/elapsed tick: advances the animation frame and, only while a turn is actually running
  // on a TTY, asks for a repaint. refreshBlock() itself only ever erases+redraws at a safe stream
  // boundary (atLineStart) via repaintBlockIfSafe, so a tick landing mid-delta is a harmless no-op
  // — this timer never needs to know about streaming state. unref() so a live process never keeps
  // running just because this timer is still armed; cleared explicitly wherever the CLI tears down
  // (see endHeadlessTurn and the stall-watchdog exit path below).
  const spinnerTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
    if (turnRunning && process.stdout.isTTY) refreshBlock();
  }, 120);
  spinnerTimer.unref?.();
  // Every stdout write in this event loop funnels through here so the block is always erased
  // before new content lands and (if we're at a safe fresh-line boundary afterwards) redrawn
  // below it — this is what keeps it "pinned" without ever tearing a partial line.
  function emit(text: string): void {
    eraseBlockIfPinned();
    process.stdout.write(text);
    atLineStart = trackLineStart(atLineStart, text);
    repaintBlockIfSafe();
  }

  // --- interactive controls (Task 6) ---

  // shift+tab cycles plan→dont-ask→ask→accept-edits→auto→bypass→plan (restrictiveness order, SP-
  // policies Task 13) via the session.setPolicy RPC; the mode bar updates only on success (repaint).
  // An in-flight guard drops repeat presses until the RPC settles; a failure prints a dim one-line
  // notice and leaves the bar unchanged. Cycle order is the shared POLICY_ORDER (./tui/policy-order,
  // a zero-dep module — importing it here does NOT pull in app.tsx's Ink graph), so app.tsx's footer
  // cycler and this raw cycler can never drift.
  async function cyclePolicy(): Promise<void> {
    if (policyInFlight) return;
    policyInFlight = true;
    const order = POLICY_ORDER;
    const next = order[(order.indexOf(policy) + 1) % order.length]!;
    try {
      await c.setPolicy(sessionId, next);
      policy = next;
      refreshBlock();
    } catch {
      emit(`${DIM}couldn't switch to ${next} mode${RESET}\n`);
    } finally {
      policyInFlight = false;
    }
  }

  // The footer's row order — main first, then LIVE subagents in first-seen order — kept in exact
  // lockstep with renderAgentsFooter's filtered rows (both drop "done" rows) so footerKeyAction's
  // index math and the enter→select thread-id resolution line up with what's actually on screen.
  const currentRowThreadIds = (): string[] =>
    ["main", ...subagents.filter((s) => s.status !== "done").map((s) => s.threadId)];

  // Apply a thread switch (enter in footer focus): select the thread, CLEAR focus (caller-must-
  // remember invariant), print the dim context line via emit(), repaint.
  function switchThread(threadId: string): void {
    selection.selectedThreadId = threadId;
    selection.focusIndex = null;
    if (threadId === "main") emit(`${DIM}→ viewing main${RESET}\n`);
    else {
      const item = subagents.find((s) => s.threadId === threadId);
      emit(`${DIM}→ viewing ${item?.agentType ?? ""}: ${item?.label ?? ""}${RESET}\n`);
    }
    refreshBlock();
  }

  // Dispatch one decoded control key through the pure footerKeyAction decision table, then apply
  // the resulting KeyAction against the live FooterSelection / policy / session (the effectful half
  // keys.ts deliberately leaves to the caller).
  function onKey(key: ReturnType<typeof decodeKey>): void {
    const rowThreadIds = currentRowThreadIds();
    const action = footerKeyAction(key, selection, rowThreadIds);
    switch (action.kind) {
      case "focusFooter": {
        // Seed focus on the currently-selected row; −1 (selection isn't a live row) → 0 (main).
        const idx = rowThreadIds.indexOf(selection.selectedThreadId);
        selection.focusIndex = idx === -1 ? 0 : idx;
        refreshBlock();
        break;
      }
      case "moveFocus":
        selection.focusIndex = action.index;
        refreshBlock();
        break;
      case "exitFocus":
        selection.focusIndex = null;
        refreshBlock();
        break;
      case "select":
        switchThread(action.threadId);
        break;
      case "interrupt":
        void c.interrupt(sessionId); // wires the mode bar's "esc to interrupt" for real
        break;
      case "cyclePolicy":
        void cyclePolicy();
        break;
      case "none":
        break;
    }
  }

  // The raw control-key listener (owns stdin only while a turn runs — see makeKeyListener). ctrl+C
  // is handled here because raw mode swallows the terminal's SIGINT: chat → clean exit 0, one-shot
  // → 130 (the conventional interrupted-process code).
  const keyListener = makeKeyListener((chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString();
    if (s === "\x03") { void teardownAndExit(chat ? 0 : 130); return; }
    onKey(decodeKey(chunk));
  });
  activeKeyListener = keyListener;

  // Clean shutdown for ctrl+C / ctrl+D (EOF) and any other non-turn-completion exit: stop the
  // timers, wipe the pinned chrome, restore the terminal, close the socket. `exiting` makes the
  // first caller win over a racing watchdog/turn-completion.
  async function teardownAndExit(code: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    clearInterval(spinnerTimer);
    if (wdTimer) clearInterval(wdTimer);
    eraseBlockIfPinned();
    keyListener.destroy();
    c.close();
    process.exit(code);
  }

  // Resize (design §8, hard requirement): erase-then-repaint immediately so aggressive mid-turn
  // resizing leaves no stranded fragments. eraseBlockIfPinned reads the CURRENT columns against the
  // stored visible lengths (a width shrink that re-wrapped the block is cleared exactly); the
  // repaint re-truncates to the new width. Finding 1 consolidation: this used to gate on
  // `turnRunning` itself (between turns the composer owns the screen, so a resize there must NOT
  // paint chrome under it) — that's now subsumed by repaintBlockIfSafe's own composerActive gate,
  // so refreshBlock() alone is enough here: mid-turn it repaints as before, and during the composer
  // it's a no-op via that same gate (no separate turnRunning check needed).
  if (process.stdout.isTTY && !inkMode) {
    process.stdout.on("resize", () => { if (process.stdout.isTTY) refreshBlock(); });
  }

  const c = await connect(chat ? "cli-chat" : "cli-p", inkMode ? (e) => bridge!.push(e) : (e) => {
    const sa = streamAction(streaming, e as { type: string; threadId?: string }, selection.selectedThreadId);
    streaming = sa.streaming;
    // ↓ out-tokens proxy stays keyed to the MAIN thread (the status line describes the main turn),
    // NOT to write_delta — a selected SUBAGENT's deltas stream to the transcript but must not grow
    // the main turn's estimate; and the main turn keeps counting even while a subagent is selected.
    if (e.type === "assistant_delta" && (e as { threadId?: string }).threadId === "main") {
      streamedChars += (e as { delta: string }).delta.length;
    }
    if (sa.action === "write_delta") {
      emit(`${AQUA}${(e as { delta: string }).delta}${RESET}`);
    } else if (sa.action === "close_line") emit("\n");
    applyEvent(wd, e, Date.now());
    const nextSubagents = updateSubagents(subagents, e as { type: string; threadId?: string });
    if (nextSubagents !== subagents) {
      subagents = nextSubagents;
      // Child turn_started/turn_completed hit no emit() branch below (their branches are
      // main-guarded), so repaint here; delta-driven token growth rides the 120ms spinner tick.
      if ((e.type === "turn_started" || e.type === "turn_completed") && process.stdout.isTTY) refreshBlock();
    }
    if (e.type === "turn_started" && e.threadId === "main") {
      // Task-4 review fix: MAIN-thread only. runThread() emits turn_started/turn_completed for
      // every spawned subagent CHILD thread too (broadcast to all harnesses with a non-"main"
      // threadId — same reason stream-state.ts guards deltas on "main"). Without this guard a
      // child's turn_started reset the parent's clock/token estimate and a child's turn_completed
      // flipped turnRunning off mid-parent-turn — the status line flickered/vanished while the
      // real turn was still running.
      turnRunning = true;
      turnStartMs = Date.now();
      streamedChars = 0;
      refreshBlock(); // show the status line immediately rather than waiting up to 120ms for the first tick
    } else if (e.type === "assistant_message") {
      if (sa.action === "close_then_print_full") { emit("\n"); emit(`${AQUA}${e.text}${RESET}\n`); }
      else if (sa.action === "print_full") emit(`${AQUA}${e.text}${RESET}\n`);
      else emit("\n");
    }
    else if (e.type === "tool_call") emit(`${DIM}⚙ ${e.name} ${e.argsJson.slice(0, 120)}${RESET}\n`);
    else if (e.type === "tool_result") emit(`${DIM}  ↳ ${e.isError ? "ERROR: " : ""}${e.output.split("\n")[0]?.slice(0, 120) ?? ""}${RESET}\n`);
    else if (e.type === "approval_requested") {
      emit(`approve ${e.toolName}? ${DIM}${e.summary}${RESET} [y/N] `);
      const wasEmpty = pending.length === 0;
      pending.push(e.callId);
      // Yield raw stdin → cooked so the whole "y\n" line reaches the approval reader (only on the
      // first of a batch; the reader resumes the key listener once the batch fully drains).
      if (wasEmpty) activeKeyListener?.suspend();
    } else if (e.type === "approval_resolved") {
      // Finding 2: the approval may have been resolved WITHOUT this stdin reader ever seeing a
      // "y\n" — another attached window answered it, or the server-side broker timed it out. If
      // it's still sitting in our local `pending` queue, unwind it exactly as the cooked reader
      // below does for a normal answer: drop it (wherever it is in the queue — not necessarily the
      // head, so a stale entry ahead of a still-live one can't misdirect the next keystroke) and,
      // once that drains `pending` back to empty, resume the raw key listener. Without this, a
      // resolved-elsewhere approval leaves `pending` and the suspended raw listener stuck for the
      // rest of the turn, and the next typed line gets consumed answering the stale entry instead
      // of whatever it was actually meant for.
      const idx = pending.indexOf(e.callId);
      if (idx !== -1) {
        pending.splice(idx, 1);
        if (pending.length === 0) activeKeyListener?.resume();
      }
    } else if (e.type === "directory_added") emit(`${DIM}+ dir ${e.path}${e.persisted ? " (remembered)" : ""}${RESET}\n`);
    else if (e.type === "bg_task_started") emit(`${DIM}▶ bg ${e.taskId} started: ${e.command.slice(0, 80)}${RESET}\n`);
    else if (e.type === "bg_task_output") emit(`${DIM}${e.chunk}${RESET}`);
    else if (e.type === "bg_task_exited") emit(`${DIM}■ bg ${e.taskId} exited (${e.killed ? "killed" : "exit " + e.exitCode})${RESET}\n`);
    else if (e.type === "question_asked") {
      // No TTY → skip rendering entirely (do NOT block reading stdin); the QuestionBroker
      // times out server-side and the engine proceeds with its "best judgment" fallback.
      if (process.stdin.isTTY) {
        void (async () => {
          const answers: Record<string, string> = {};
          const notes: Record<string, string> = {}; // Task 3 (CC parity): optional per-question free-text note
          for (const q of e.questions) {
            emit(`\n${formatQuestionHeadlineLine(q.header, q.question)}\n`);
            // Task 3: each option's numbered line, plus (when present) its `preview` rendered as
            // extra indented "┆"-rail lines right under it — formatOptionLines is pure/TTY-only
            // (questions.ts); every returned line still goes through emit() so the pinned block's
            // erase/reprint bookkeeping (which every emit() call re-derives) stays correct.
            q.options.forEach((o: { label: string; description?: string; preview?: string }, i: number) => {
              for (const line of formatOptionLines(i + 1, o)) emit(line);
            });
            emit(`  ${q.options.length + 1}) Other (type your answer)\n`);
            // The prompt text is written via emit() (so the block's erase/reprint bookkeeping
            // stays accurate) and readLine() itself is given "" — it still does its own raw,
            // un-tracked stdout write for whatever text it's passed, which would desync
            // atLineStart if we let it print the real prompt.
            const promptText = q.multiSelect ? "choose (comma-separated numbers or text): " : "choose (number or text): ";
            emit(promptText);
            const input = (await readLine("")) ?? ""; // readLine now returns null on EOF; "" here (empty answer)
            if (isOtherChoice(input, q.options.length)) {
              // M1: choosing "Other" BY ITS MENU NUMBER isn't itself an answer — that digit is a
              // selection, not free text. Re-prompt for the real answer so the model never sees
              // the literal number as if the user had typed it as their response.
              emit("your answer: ");
              answers[q.question] = ((await readLine("")) ?? "").trim();
            } else {
              answers[q.question] = parseQuestionAnswer(input, q.options.map((o: { label: string }) => o.label), q.multiSelect);
            }
            // Task 3 (CC parity): a single optional free-text note per question, separate from the
            // answer itself (e.g. "why I picked this"). Blank input means "skip" — nothing is
            // collected, so a no-note run sends the exact same `{ sessionId, callId, answers }`
            // payload as before this feature (notes omitted below, not sent as `{}`).
            emit("note (enter to skip): ");
            const note = ((await readLine("")) ?? "").trim();
            if (note !== "") notes[q.question] = note;
          }
          await c.askUserRespond({
            sessionId, callId: e.callId, answers,
            ...(Object.keys(notes).length > 0 ? { notes } : {}),
          });
        })();
      }
    } else if (e.type === "plan_presented") {
      // No TTY → skip rendering entirely (do NOT block reading stdin); the server-side timeout
      // resolves the plan and the engine proceeds, same guard as question_asked above.
      if (process.stdin.isTTY) {
        void (async () => {
          emit(`\n${AQUA}Plan${RESET}\n${e.plan}\n\n`);
          emit(`  1) approve — I'll approve each edit\n  2) approve + auto-accept edits\n  3) reject (type: 3 <reason>)\n`);
          emit("choose (number or text): ");
          const input = (await readLine("")) ?? "";
          const r = parsePlanResponse(input);
          await c.planRespond({ sessionId, callId: e.callId, ...r });
        })();
      }
    } else if (e.type === "plan_resolved") {
      emit(`${DIM}${e.approved ? `plan approved${e.autoAccept ? " (auto-accept edits)" : ""}` : "plan rejected"}${RESET}\n`);
    } else if (e.type === "task_updated") {
      tasks = upsertTask(tasks, e.task);
      // TTY: the per-line print is replaced by the pinned block (upserted above); non-TTY
      // (headless consumers parse this) keeps the exact original one-line-per-update output.
      if (process.stdout.isTTY) refreshBlock();
      else emit(NONTTY_TASK_LINE(e.task.status, e.task.subject));
    } else if (e.type === "worktree_entered") {
      emit(`${DIM}⛿ entered worktree ${e.name} (branch ${e.branch})${RESET}\n`);
    } else if (e.type === "worktree_exited") {
      emit(`${DIM}⟲ left worktree ${e.name}${e.removed ? " (removed)" : ""}${RESET}\n`);
    } else if (e.type === "thread_started") {
      // Task 5 (2e-iii-b): TTY gets the CC-style "Agent(label) agentType" line (subagents was
      // just updated above, so the freshly-pushed CliSubagent's label is already there); non-TTY
      // keeps the exact original literal (headless consumers parse this).
      const label = subagents.find((s) => s.threadId === e.threadId)?.label ?? "";
      emit(process.stdout.isTTY
        ? `${agentSpawnLine(label, e.agentType)}\n`
        : NONTTY_SPAWN_LINE(e.agentType));
    } else if (e.type === "thread_completed") {
      // Task 5: read finish stats from `subagents` BEFORE they're pruned — updateSubagents (run
      // earlier in this handler) only flips this entry to "done" here; the prune to [] happens
      // later, on the MAIN thread's own turn_completed — so the item is still present... for a
      // SYNC child. A run_in_background child (4h-ii-a) finishes AFTER the main turn already
      // pruned the list, so `item` is undefined and the label/stats are gone — fall back to the
      // threadId so the finish line stays identifiable (`Agent "th_…" finished`) instead of
      // `Agent ""`. Proper per-thread stats for bg agents are a Phase-3 TUI concern (its state
      // model won't prune on main turn_completed).
      const item = subagents.find((s) => s.threadId === e.threadId);
      emit(process.stdout.isTTY
        ? `${agentFinishLines(item?.label ?? e.threadId, item?.activeMs ?? 0, item?.toolCalls ?? 0).join("\n")}\n`
        : NONTTY_FINISH_LINE(e.stopReason));
      // §4 snap-back: if the just-finished subagent was the one being viewed, selection returns to
      // main (and a live focus highlight follows to the main row). The dim context line goes through
      // emit() so the block bookkeeping stays correct.
      if (selection.selectedThreadId === e.threadId) {
        selection.selectedThreadId = "main";
        if (selection.focusIndex !== null) selection.focusIndex = 0;
        emit(`${DIM}→ viewing main${RESET}\n`);
      }
    } else if (e.type === "agent_error") {
      console.error(`agent error: ${e.message}`);
    } else if (e.type === "turn_completed" && e.threadId === "main") {
      // Task-4 review fix (MAIN-thread only — see turn_started above). This ALSO fixes a
      // pre-existing latent bug the review surfaced: a subagent CHILD's turn_completed always
      // fires BEFORE the main thread's own (children are awaited inside the main tool loop), so an
      // unguarded endHeadlessTurn() would c.close()/exit the CLI the instant the FIRST subagent
      // finished — while the main turn was still running. The threadId guard closes both.
      if (process.stdout.isTTY) {
        // Task 5: printed BEFORE the bookkeeping below so it lands above the final block teardown.
        // Non-TTY prints nothing extra here (unchanged).
        const activeForm = tasks.filter((t) => t.status === "in_progress").at(-1)?.activeForm ?? "Worked";
        emit(`${turnSummaryLine(activeForm, Date.now() - turnStartMs, e.inputTokens, e.outputTokens)}\n`);
      }
      turnRunning = false;
      lastInTokens = e.inputTokens;
      lastOutTokens = e.outputTokens;
      refreshBlock(); // safety net: status line gone (turn over), task rows reflect final state (and disappear if all done)
      if (chat) {
        // Chat: don't exit — disarm the key listener (the composer read owns cooked stdin next) and
        // hand control back to the loop, which erases the block and shows the `› ` composer.
        keyListener.endTurn();
        resolveTurn?.();
        resolveTurn = null;
      } else {
        void endHeadlessTurn(e.stopReason === "end_turn" ? 0 : 1);
      }
    }
  });

  const cwd = process.cwd();
  if (existingSessionId) {
    sessionId = existingSessionId;
    // Plan-immunity Task 2: this is the CLI's one attach/resume choke point (both the `resume <id>`
    // chat route and the resumeOneShot route flow through here) — CLIENT-side mode gate, same
    // reasoning as `case "send"`/`case "watch"` (product-surface rule, not a security boundary;
    // session-mode.ts's file doc). The not-found message stays byte-identical to before.
    const { sessions } = (await c.listSessions()) as {
      sessions: Array<{
        sessionId: string; scope: string; lastSeq: number; mode?: string;
        // T5 status chrome: the row's per-session model/effort overrides + derived activity
        // (SessionSummary fields the daemon already serves — methods.ts SessionListResult).
        model?: string; effort?: string; activity?: import("@norma/protocol").SessionActivity;
      }>;
    };
    const check = checkCodeSession(sessions, existingSessionId);
    if (!check.ok) { console.error(check.message); c.close(); process.exit(1); }
    const info = check.row;
    sessionModelOverride = info.model;
    sessionEffortOverride = info.effort;
    initialActivity = info.activity;
    console.log(`${DIM}↻ resuming ${existingSessionId} — ${info.scope}, ${info.lastSeq} events${RESET}`);
    // Attach from the tip (info.lastSeq) on every route EXCEPT the Ink resume route: attaching from
    // 0 there replays the whole session so `<App>` can render the full transcript back (T5), with a
    // "Resuming conversation…" line shown until the replay catches up to `resumeTargetSeq` (the seq
    // this very attach() call returns — the daemon's current tip, regardless of the fromSeq it was
    // asked to replay from). Every other route (legacy/NORMA_LEGACY_CLI chat resume, non-TTY,
    // resumeOneShot) keeps attaching from the tip — attaching from 0 there would replay every
    // historical turn_completed event on this session, tripping endHeadlessTurn immediately
    // (unchanged concern from before this task; inkMode is false on all of those routes anyway).
    const attachFromSeq = inkMode ? 0 : info.lastSeq;
    const attachedLastSeq = await c.attach(sessionId, attachFromSeq);
    if (inkMode) resumeTargetSeq = attachedLastSeq;
  } else {
    const created = await c.createSession("global", { cwd, approvalPolicy: auto ? "auto" : plan ? "plan" : "ask" });
    sessionId = created.sessionId;
    if (!created.trusted) {
      const wantTrust = process.argv.includes("--trust")
        || (process.stdout.isTTY && !process.argv.includes("--no-trust") && (await askYesNo(`Do you trust the files in ${cwd}? Norma may grant directory access declared there. [y/N] `)));
      if (wantTrust) { await c.trustDir(cwd); console.log(`${DIM}trusted ${cwd}${RESET}`); }
    }
    await c.attach(sessionId);
  }

  // Ink cutover (Phase 3a Task 6): with the session bootstrapped (created/attached/trusted/resumed
  // and the policy seeded) — the SAME setup the legacy path uses — hand the interactive TTY to the
  // Ink renderer and skip ALL the legacy-only machinery below (the y/N approval reader, the stall
  // watchdog, the raw key-listener turn loop). The bridge was wired as this client's onEvent sink at
  // connect, so it already holds any attach-replay backlog; <App> flushes it on subscribe. The Ink
  // module graph is loaded here (dynamic import) so the non-TTY/-p/legacy branches never touch it.
  // waitUntilExit resolves when Ink unmounts (its default Ctrl+C exit); we then tear down the
  // dangling legacy timers/listener and exit cleanly, exactly as the legacy chat teardown does.
  if (inkMode) {
    const { mountTui } = await import("./tui/mount");
    // Welcome-banner data. Version: the unified @norma/core CORE_VERSION (also correct for a
    // compiled binary, which has no adjacent package.json to read). Model: the resolved provider
    // model the daemon will use, read from settings.json (same source as `norma model`), best-effort
    // with an inert fallback so missing settings never blocks the interactive session.
    const version = CORE_VERSION;
    let model = "";
    let effort: string | undefined;
    try {
      const s = loadSettings(join(resolveNormaHome(), "settings.json"));
      model = s.provider.model;
      effort = s.provider.reasoningEffort; // T5 status chrome: the global effort half
    } catch { /* keep fallback */ }
    await mountTui({
      client: c, bridge: bridge!, sessionId, cwd, initialPolicy: policy, version, model,
      // T5 status chrome: global effort + the resume route's per-session overrides/activity seed
      // (all undefined on the fresh-session route — see their declarations above).
      effort, sessionModelOverride, sessionEffortOverride, initialActivity,
      ...(resumeTargetSeq !== undefined ? { resumeTargetSeq } : {}),
    }).waitUntilExit();
    // T5: printed AFTER waitUntilExit resolves — mountTui's own teardown has already written the
    // LEAVE escape by then (mount.ts's HARD CONSTRAINT 3 ordering), so this lands in the NORMAL
    // buffer, never the alt screen.
    process.stdout.write(formatResumeHint(sessionId));
    clearInterval(spinnerTimer);
    keyListener.destroy();
    c.close();
    process.exit(0);
  }

  // Persistent y/N approval reader. Installed unconditionally: chat because shift+tab can cycle
  // the policy INTO "ask" mid-session, and one-shot because approvals are possible under EVERY
  // policy since the Workflow launch gate cards even in auto (gate.ts's pre-auto-allow "ask" —
  // the historic `!auto` condition made a `-p --auto` Workflow launch unanswerable: the card
  // rendered, piped "y" lines were discarded, and the broker timed out at 300s into a denial).
  // When no approval is pending it early-returns — so during a running turn it coexists
  // harmlessly with the raw key listener (a keystroke just no-ops here), and during the composer
  // read it ignores the typed message. When an approval IS pending the raw key listener is
  // suspended (below), so this cooked handler reads the whole "y\n" line; on the last pending
  // approval it hands stdin back to the key listener.
  {
    process.stdin.on("data", async (d) => {
      if (pending.length === 0) return;
      // Claim this chunk for the approval BEFORE any concurrently-armed readLine() onData (which is
      // later in the listener array) runs for the same "data" event, so it skips instead of also
      // submitting the answer as input. Reset on the next microtask — after both synchronous "data"
      // handlers for this chunk have run, and before the user's real next line can arrive.
      approvalConsumedChunk = true;
      queueMicrotask(() => { approvalConsumedChunk = false; });
      // SP-approvals T7: this legacy non-TUI reader stays plain y/N — it never renders or parses
      // `approval_requested.options` (that's the Ink TUI's pending-cards.tsx ApprovalCard only), so
      // a "y" here always means allow-once (no optionId), same as before this feature existed.
      const yes = String(d).trim().toLowerCase() === "y";
      const callId = pending.shift();
      if (callId) await c.request(METHODS.approvalRespond, { sessionId, callId, approved: yes });
      if (pending.length === 0) activeKeyListener?.resume();
    });
  }

  // Stall watchdog: one session-long poll. If the turn is running with nothing in flight (no tool
  // executing, no approval awaiting a human) and no event has landed for thresholdMs, assume the
  // turn is wedged and abort. Between turns (chat) wd.turnRunning is false, so it never false-fires.
  const thresholdMs = Number(process.env.NORMA_TURN_STALL_MS ?? 180000);
  wdTimer = setInterval(() => {
    if (isStalled(wd, Date.now(), thresholdMs)) {
      if (exiting) return;
      exiting = true;
      clearInterval(wdTimer);
      clearInterval(spinnerTimer);
      eraseBlockIfPinned();
      keyListener.destroy();
      console.error(`\n[stalled: no progress for ${Math.round((Date.now() - wd.lastEventAt) / 1000)}s — aborting]`);
      void c.interrupt(sessionId).finally(() => process.exit(2));
    }
  }, 5000);
  wdTimer.unref?.(); // don't let the poll tick keep the process alive after normal completion

  // Sends one prompt and waits for the MAIN turn_completed. In chat the handler resolves this so
  // the loop continues; in one-shot the handler calls endHeadlessTurn → process.exit, so this
  // await never returns (the process is gone). The key listener is armed for the turn's duration.
  async function runOneTurn(text: string): Promise<void> {
    keyListener.beginTurn();
    const done = new Promise<void>((resolve) => { resolveTurn = resolve; });
    await c.send(sessionId, text);
    await done;
  }

  if (chat) {
    // ctrl+C during the COOKED composer read raises SIGINT (raw mode is off there) → clean exit;
    // during a turn raw mode swallows SIGINT and the \x03 key handler covers it.
    process.on("SIGINT", () => { void teardownAndExit(0); });
    for (;;) {
      eraseBlockIfPinned(); // drop any lingering chrome before the composer
      atLineStart = true;
      composerActive = true; // Finding 1: block painting/erasing suspended for the span of this read
      const line = await readLine("› ");
      composerActive = false; // the composer resolved (line submitted or EOF) — the gate lifts immediately
      if (line === null) { await teardownAndExit(0); return; } // ctrl+D / EOF → exit
      if (line === "") continue; // empty line → re-prompt (no send)
      await runOneTurn(line);
    }
  }

  await runOneTurn(oneShotPrompt!); // one-shot: never returns — exits via the turn_completed branch above
  await new Promise(() => {}); // safety net if runOneTurn ever resolves unexpectedly
}

// Final-review Findings 3+4: pure arg-routing decision, factored out of the `import.meta.main`
// block below so it's cheaply unit-testable without any process/stdin/socket machinery. `argv` is
// the USER-supplied args (i.e. `process.argv.slice(2)` — argv[0] is the first real arg, not the
// binary/script path); `isTTY` is `process.stdin.isTTY && process.stdout.isTTY` from the caller.
//
//  - bare (`argv` empty) or a single bare `--auto`/`--plan` flag → "chat" (no sessionId): a fresh
//    session, policy seeded by whichever flag is present — runTurnSession reads `--auto`/`--plan`
//    back out of `process.argv` itself, so this route carries no policy field of its own.
//  - `resume <id>` with nothing after it, or with EXACTLY one of `--auto`/`--plan` and nothing
//    else, → "chat" WITH that sessionId (Finding 3: previously "--auto" was sent as literal prompt
//    text). A flag followed by more text (`resume <id> --auto and then some`) is NOT this case —
//    that's real prompt text starting with a flag-shaped word, unchanged below.
//  - `resume <id> <anything else>` → "resumeOneShot" (existing continue-headless behavior).
//  - everything else (subcommands, `-p`, `resume` with no id, …) → "fallthrough": defer to the
//    switch statement's existing handling, untouched.
//
// Finding 4: the two "chat" outcomes reachable with NO existing session (bare / --auto / --plan)
// require `isTTY` — a script piping into bare `norma` must keep seeing the original usage output,
// not silently open a chat loop it can't drive. (`resume <id>` chat entry is pre-existing,
// unflagged behavior and isn't gated here — see the fix report.)
export type CliRoute =
  | { kind: "chat"; existingSessionId?: string }
  | { kind: "resumeOneShot"; sessionId: string; text: string }
  | { kind: "version" }
  | { kind: "fallthrough" };

const isPolicyFlag = (s: string | undefined): boolean => s === "--auto" || s === "--plan";

export function routeCliInvocation(argv: string[], isTTY: boolean): CliRoute {
  const [cmd, sub, ...rest] = argv;
  if (cmd === undefined || isPolicyFlag(cmd)) {
    return isTTY ? { kind: "chat" } : { kind: "fallthrough" };
  }
  // App→CLI handoff Task 2: a real version flag. LEADING position only — as a later argv word
  // (`resume <id> -v`) it's someone else's argument, unchanged. Deliberately NOT gated on isTTY:
  // scripts are exactly who asks for --version. The matching `switch (cmdKey)` case prints/exits.
  if (cmd === "--version" || cmd === "-v") return { kind: "version" };
  if (cmd === "resume" && sub !== undefined) {
    const text = rest.join(" ");
    if (text === "" || isPolicyFlag(text)) return { kind: "chat", existingSessionId: sub };
    return { kind: "resumeOneShot", sessionId: sub, text };
  }
  return { kind: "fallthrough" };
}

// Plan-immunity Task 2, fix round 1 (whole-branch review, Important): the first pass gated
// send/watch/resume but left EIGHT more session-targeted verbs reaching chat/dispatch sessions
// with no check at all — proven live against a real daemon (`norma steer <chatId> "..."` injected
// a real user_message into a chat session's JSONL; `norma steer <dispatchId> "..."` started a real
// dispatch turn from the terminal; `norma bg peek <chatId> <task>` read chat output into the
// terminal). Each verb's logic is pulled out of its `case` block into its own small function here —
// client + params in, a plain discriminated result out, no console.log/process.exit inside — so the
// gate is directly unit-testable with a fake `NormaClient` (`test/cli-verb-gates.test.ts`, same
// recorded-calls double as tui/commands.test.ts's own `makeClient`) instead of only reachable by
// hand through a real CLI invocation. Every `case` block below stays a thin, obviously-correct
// wrapper: resolve argv, call the route function, print/exit on the result exactly as before this
// fix — the console output strings are byte-identical to what each case block printed previously.
export async function runAddDirRoute(c: NormaClient, sessionId: string, path: string, persist: boolean): Promise<{ ok: true; roots: string[] } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  return { ok: true, roots: await c.addDir(sessionId, path, persist) };
}

export async function runCdRoute(c: NormaClient, sessionId: string, cwd: string): Promise<{ ok: true; cwd: string } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  return { ok: true, cwd: await c.setCwd(sessionId, cwd) };
}

export async function runSteerRoute(c: NormaClient, sessionId: string, text: string): Promise<{ ok: true; injected: boolean } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  const r = await c.steer(sessionId, text);
  return { ok: true, injected: r.injected };
}

export async function runInterruptRoute(c: NormaClient, sessionId: string): Promise<{ ok: true; wasRunning: boolean } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  const r = await c.interrupt(sessionId);
  return { ok: true, wasRunning: r.wasRunning };
}

export async function runCompactRoute(c: NormaClient, sessionId: string): Promise<{ ok: true; compacted: boolean; uptoSeq: number; summaryChars: number } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  const r = await c.compact(sessionId);
  return { ok: true, ...r };
}

export async function runBgListRoute(c: NormaClient, sessionId: string): Promise<{ ok: true; tasks: Array<{ taskId: string; command: string; status: string; exitCode: number | null; startedAt: number }> } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  return { ok: true, tasks: await c.bgList(sessionId) };
}

export async function runBgPeekRoute(c: NormaClient, sessionId: string, taskId: string): Promise<{ ok: true; chunk: string; status: string; exitCode: number | null } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  const r = await c.bgPeek(sessionId, taskId);
  return { ok: true, ...r };
}

export async function runBgKillRoute(c: NormaClient, sessionId: string, taskId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
  const check = checkCodeSession(sessions, sessionId);
  if (!check.ok) return { ok: false, message: check.message };
  await c.bgKill(sessionId, taskId);
  return { ok: true };
}

// Guarded so `main.ts` can be imported (e.g. by tests, for INIT_PROMPT/runTurnSession) without
// executing the CLI — import.meta.main is true only when this file is the entry point.
if (import.meta.main) {
  // Workflow worker subprocess (COMPILED path): the daemon self-spawns `<norma-core> __workflow-worker`
  // already wrapped in sandbox-exec; THIS process is the sandboxed worker. Route straight to the entry
  // and never fall through to daemon-connect / TUI. (In dev/test the runtime spawns the entry .ts
  // directly, so this branch is only exercised by the compiled binary.)
  if (process.argv.slice(2).length === 1 && process.argv.slice(2)[0] === "__workflow-worker") {
    runWorkflowSubprocess();
    await new Promise(() => {});   // entry drives itself to process.exit(); block everything below
  }
  if (isFunctionsExecWorkerInvocation(process.argv.slice(2))) {
    runFunctionsExecSubprocess();
    await new Promise(() => {}); // entry drives itself to process.exit(); block everything below
  }

  const argv = process.argv.slice(2);
  const isTTY = !!(process.stdin.isTTY && process.stdout.isTTY);
  const route = routeCliInvocation(argv, isTTY);

  if (argv[0] === "-p") {
    await runTurnSession({ chat: false }); // one-shot; never resolves normally — exits via process.exit()
  }
  if (route.kind === "chat" && route.existingSessionId === undefined) {
    // bare `norma`, or `norma --auto`/`--plan` (Finding 3) → persistent chat mode on a fresh
    // session (loops until ctrl+C/ctrl+D); Finding 4 — routeCliInvocation already gated this on
    // isTTY, so a non-TTY bare/--auto/--plan invocation falls through to the switch below instead.
    await runTurnSession({ chat: true });
  }

  const [cmd, sub] = argv;

  // Two-word subcommands use "cmd sub"; single-word commands match on cmd alone.
  const cmdKey = cmd === "daemon" ? `daemon ${sub ?? ""}`.trim() : (cmd ?? "");

  switch (cmdKey) {
  case "--version":
  case "-v": {
    // Handoff Task 2: thin dispatcher for routeCliInvocation's {kind:"version"} (the pure, tested
    // decision — both spellings land here because cmdKey is just argv[0] for non-daemon commands).
    console.log(`norma ${CORE_VERSION}`);
    process.exit(0);
  }
  case "daemon run": {
    // Whole-branch review: register the shutdown handlers HERE, not (only) in daemon.ts. daemon.ts's
    // SIGTERM/SIGINT handlers live under `if (import.meta.main)`, which is FALSE for the compiled
    // binary and this CLI entry (main.ts is `import.meta.main`, daemon.ts is not) — so without this
    // block a SIGTERM'd daemon died leaving a STALE socket file, sending the app's DaemonSupervisor
    // into `.connectOnly` on the next launch (engine permanently down). `daemon.stop()` releases the
    // lock, which unlinks the socket — the clean-quit path. (SIGKILL/crash still leave a stale
    // socket, which is why the supervisor's socketExists is also now a liveness probe, not a
    // presence check.)
    const daemon = await startDaemon();
    const shutdown = () => { daemon.stop(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    break; // keeps running; the open listening socket keeps the event loop alive
  }
  case "ping": {
    const c = await connect("cli-ping");
    const profileTag = resolveNormaProfile() === "dev" ? " (dev)" : "";
    console.log(`${AQUA}◍ norma-core is up${profileTag}${RESET} ${DIM}(${socketPath()})${RESET}`);
    c.close();
    break;
  }
  case "sessions": {
    // Plan-immunity Task 2 (mode×surface matrix): this is a plain INVENTORY, not a picker — it
    // stays a truthful listing of every session that exists, chat/dispatch/cowork included, just
    // visibly MARKED as not-for-here via `sessionModeMarker` rather than hidden (contrast the
    // TUI's `/sessions`, and `resume`'s no-id picker below, which HIDE non-code rows — see
    // session-mode.ts's file doc for why the two surfaces differ).
    const c = await connect("cli-sessions");
    const { sessions } = (await c.listSessions()) as any;
    for (const s of sessions) console.log(`${AQUA}${s.sessionId}${RESET} ${DIM}${s.scope} · ${s.lastSeq} events${process.stdout.isTTY && s.title ? ` — ${s.title}` : ""}${RESET}${sessionModeMarker(s.mode)}`);
    c.close();
    break;
  }
  case "agents": {
    // session-activity-hygiene T9. Thin on purpose — everything provable lives in agents-cli.ts
    // (main.ts's dispatch can't be driven by a unit test; see main.test.ts's header). Note this
    // route NEVER attaches: `connect`'s onEvent is the roster's only event source, and it works
    // without an attachment because `session_activity` fans out globally (this task's core half).
    await runAgentsCommand({
      connect: (name, onEvent) => connect(name, onEvent),
      isTTY: !!process.stdout.isTTY,
      log: (line) => console.log(line),
      mount: mountAgents,
    });
    break;
  }
  case "status": {
    const c = await connect("cli-status");
    const s = await c.daemonStatus();
    const provider = s.provider ? `${s.provider.id} (${s.provider.model})` : "(none configured)";
    const profileTag = resolveNormaProfile() === "dev" ? " (dev)" : "";
    console.log(`${AQUA}norma-core v${s.version}${profileTag}${RESET} ${DIM}up ${formatElapsed(s.uptimeMs)} · ${s.socketPath}${RESET}`);
    console.log(`${DIM}provider: ${provider} · sessions: ${s.sessionsCount} · plugins: ${s.pluginsCount}${RESET}`);
    c.close();
    break;
  }
  case "quota": {
    const c = await connect("cli-quota");
    const q = await c.quotaState();
    const state = q.kind === "ok" ? "ok" : `limited (resumes ${new Date(q.resumeAt ?? 0).toLocaleString()})`;
    console.log(`${AQUA}quota: ${state}${RESET} ${DIM}${formatTokens(q.inputTokens)} in / ${formatTokens(q.outputTokens)} out${RESET}`);
    c.close();
    break;
  }
  case "send": {
    // usage: norma send <sessionId|new> <text...>
    const args = process.argv.slice(3);
    const target = args[0];
    const text = args.slice(1).join(" ");
    if (!target || !text) { console.error("usage: norma send <sessionId|new> <text…>"); process.exit(1); }
    const c = await connect("cli-send");
    let sessionId: string;
    if (target === "new") {
      // `createSession` here passes no `mode` — the daemon defaults that to code (absent = code,
      // the R-slice convention), so `send new` always creates a code session. No gate needed.
      sessionId = (await c.createSession("global")).sessionId;
    } else {
      // Plan-immunity Task 2: CLIENT-side mode gate (product-surface rule among same-user local
      // clients, NOT a security boundary — the daemon-side gate is reserved for the remote role;
      // see session-mode.ts's file doc). `attach`/`send` don't otherwise learn `mode`, so look the
      // target up via session.list first.
      const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
      const check = checkCodeSession(sessions, target);
      if (!check.ok) { console.error(check.message); c.close(); process.exit(1); }
      sessionId = target;
    }
    await c.attach(sessionId);
    await c.send(sessionId, text);
    console.log(`${AQUA}sent to ${sessionId}${RESET}`);
    c.close();
    break;
  }
  case "add-dir": {
    const sessionId = process.argv[3];
    const path = process.argv[4];
    if (!sessionId || !path) { console.error("usage: norma add-dir <sessionId> <path> [--persist]"); process.exit(1); }
    const c = await connect("cli-add-dir");
    const result = await runAddDirRoute(c, sessionId, path, process.argv.includes("--persist"));
    if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
    console.log(`${AQUA}+ dir ${path} → ${result.roots.length} roots${RESET}`);
    c.close();
    break;
  }
  case "trust": {
    const arg = process.argv[3];
    if (arg === "--list") {
      // Protocol has no daemon.trustList method (kept minimal) — read ~/.norma/trust.json directly.
      const trustPath = join(resolveNormaHome(), "trust.json");
      let dirs: string[] = [];
      if (existsSync(trustPath)) {
        try {
          const raw = JSON.parse(readFileSync(trustPath, "utf8"));
          dirs = Array.isArray(raw?.trustedDirs) ? raw.trustedDirs.map(String) : [];
        } catch { /* corrupt/unreadable file — treat as empty */ }
      }
      if (dirs.length === 0) console.log("(none)");
      else for (const d of dirs) console.log(d);
    } else if (arg === "list") {
      // Phase 2f Task 6: same listing, but over the daemon's trust.list RPC (Task 3) instead of
      // reading the file directly — requires the daemon to be running, unlike --list above.
      const c = await connect("cli-trust-list");
      const dirs = await c.trustList();
      c.close();
      if (dirs.length === 0) console.log("(none)");
      else for (const d of dirs) console.log(d);
    } else if (arg === "remove") {
      const path = process.argv[4];
      if (!path) { console.error("usage: norma trust remove <path>"); process.exit(1); }
      const c = await connect("cli-trust-remove");
      const removed = await c.trustRemove(resolve(path));
      console.log(removed ? `${AQUA}untrusted ${resolve(path)}${RESET}` : `${DIM}already untrusted: ${resolve(path)}${RESET}`);
      c.close();
    } else if (arg) {
      const c = await connect("cli-trust");
      await c.trustDir(resolve(arg));
      console.log(`${AQUA}trusted ${resolve(arg)}${RESET}`);
      c.close();
    } else {
      console.error("usage: norma trust <dir> | norma trust --list | norma trust list | norma trust remove <path>");
      process.exit(1);
    }
    break;
  }
  case "cd": {
    const sessionId = process.argv[3];
    const cwd = process.argv[4];
    if (!sessionId || !cwd) { console.error("usage: norma cd <sessionId> <path>"); process.exit(1); }
    const c = await connect("cli-cd");
    const result = await runCdRoute(c, sessionId, cwd);
    if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
    console.log(`${AQUA}cwd → ${result.cwd}${RESET}`);
    c.close();
    break;
  }
  case "steer": {
    const sessionId = process.argv[3];
    const text = process.argv.slice(4).join(" ");
    if (!sessionId || !text) { console.error("usage: norma steer <sessionId> <text…>"); process.exit(1); }
    const c = await connect("cli-steer");
    const result = await runSteerRoute(c, sessionId, text);
    if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
    console.log(`${AQUA}steered${RESET} ${result.injected ? "(injected)" : "(queued for next turn)"}`);
    c.close();
    break;
  }
  case "interrupt": {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error("usage: norma interrupt <sessionId>"); process.exit(1); }
    const c = await connect("cli-interrupt");
    const result = await runInterruptRoute(c, sessionId);
    if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
    console.log(`${AQUA}interrupted${RESET} ${result.wasRunning ? "(was running)" : "(nothing running)"}`);
    c.close();
    break;
  }
  case "compact": {
    const sid = process.argv[3];
    if (!sid) { console.error("usage: norma compact <sessionId>"); process.exit(1); }
    const c = await connect("cli-compact");
    const result = await runCompactRoute(c, sid);
    if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
    console.log(result.compacted ? `${AQUA}compacted${RESET} (through seq ${result.uptoSeq}, ${result.summaryChars} char summary)` : "nothing to compact yet");
    c.close();
    process.exit(0);
  }
  case "skills": {
    const c = await connect("cli-skills");
    const rows = await c.listSkills(process.cwd());
    if (!rows.length) console.log("no skills installed");
    for (const s of rows) console.log(`${AQUA}${s.name}${RESET}  ${DIM}(${s.source})${RESET}  — ${s.description}`);
    c.close();
    process.exit(0);
  }
  case "mcp": {
    const c = await connect("cli-mcp");
    const servers = await c.listMcp(process.cwd());
    if (!servers.length) console.log("no MCP servers configured");
    for (const s of servers) {
      console.log(`${AQUA}${s.name}${RESET}  ${DIM}(${s.source}, ${s.status})${RESET}  ${s.toolNames.map((t) => `mcp__${s.name}__${t}`).join(", ")}`);
    }
    c.close();
    process.exit(0);
  }
  case "plugin": {
    const sub = process.argv[3];
    const home = resolveNormaHome();
    const settingsPath = join(home, "settings.json");
    const pluginsRoot = join(home, "plugins");

    if (sub === "list") {
      const c = await connect("cli-plugin-list");
      const res = await c.pluginsList();
      for (const p of res.plugins) {
        const mcp = !p.hasMcp ? "no mcp" : p.mcpEnabled ? "mcp: enabled" : `mcp: DISABLED (norma plugin enable ${p.name} to allow — code execution)`;
        const flags = p.disabled ? " [disabled]" : "";
        const tierTag = p.tier ? ` ${DIM}[${p.tier}]${RESET}` : "";
        // Task 3: tier + consent state — "consented" (every required class recorded), "needs
        // consent: exec,tcc" (fixed exec/tcc/hardware order, only the classes still missing), or
        // nothing at all for legacy plugins / manifest plugins that require no consent.
        const missing = missingConsents(p.requiredConsents ?? [], p.consented ?? []);
        const consentState = (p.requiredConsents?.length ?? 0) === 0 ? "" : missing.length > 0 ? `  ${DIM}needs consent: ${missing.join(",")}${RESET}` : `  ${DIM}consented${RESET}`;
        console.log(`${AQUA}${p.name}${RESET}${p.version ? ` ${DIM}v${p.version}${RESET}` : ""}${tierTag}${flags}  skills: ${p.skills.join(", ") || "(none)"}  ${DIM}${mcp}${RESET}${consentState}`);
      }
      if (res.plugins.length === 0) console.log("no plugins installed");
      c.close();
      process.exit(0);
    }

    if (sub === "install") {
      const url = process.argv[4];
      if (!url) { console.error("usage: norma plugin install <git-url> [name]"); process.exit(1); }
      let installed: { name: string; target: string };
      try {
        installed = installPlugin({ url, name: process.argv[5], pluginsRoot });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const { PluginStore } = await import("@norma/core");
      const info = new PluginStore({ normaHome: home }).list().find((p) => p.name === installed.name);
      console.log(`${AQUA}installed ${installed.name}${RESET}  skills: ${info?.skills.join(", ") || "(none)"}`);
      // hasMcp alone misses a manifest-only plugin (contributes.mcpServers, no .mcp.json) — that
      // installs with hasMcp:false, so also check requiredConsents (installNeedsConsentHint).
      if (info && installNeedsConsentHint(info)) console.log(`this plugin requests exec/etc — run ${AQUA}norma plugin enable ${installed.name}${RESET} to review and consent`);
      break; // NEVER touches settings
    }

    if (sub === "enable") {
      const name = process.argv[4];
      if (!name) { console.error("usage: norma plugin enable <name>"); process.exit(1); }
      if (!existsSync(join(pluginsRoot, name))) { console.error(`no such plugin: ${name}`); process.exit(1); }

      // Direct PluginStore read (not the daemon RPC) — mirrors `install` above and keeps `enable`
      // usable without a running daemon, exactly like it was pre-4a. `consents` comes straight
      // from the settings file we're about to (maybe) write back to.
      const { loadSettings, saveSettings, PluginStore } = await import("@norma/core");
      const settings = loadSettings(settingsPath);
      const info = new PluginStore({ normaHome: home, consents: settings.plugins?.consents }).list().find((p) => p.name === name);
      if (!info) { console.error(`no such plugin: ${name}`); process.exit(1); }

      const missing = missingConsents(info.requiredConsents, info.consented);
      if (missing.length > 0) {
        // No silent consent in scripts (design spec §1) — an unattended `enable` of a plugin with
        // outstanding exec/tcc/hardware consent refuses rather than guessing.
        if (!isTTY) {
          console.error(`exec consent requires an interactive terminal — run: norma plugin enable ${name}`);
          process.exit(1);
        }
        for (const line of buildConsentBlock(info)) console.log(line);
        const answer = await readLine('type "yes" to consent: ');
        if (answer !== "yes") {
          console.log("aborted — no changes made");
          process.exit(1);
        }
        // Full re-disclosure means a fresh consent covers every required class, not just the
        // ones that were missing — matches the block just printed above. `settings` above was
        // read BEFORE the `readLine` prompt; writing it back here would clobber any settings.json
        // edit made during that human-scale wait, so re-read fresh at write time instead
        // (applyFreshPluginConsent — final-review fix).
        saveSettings(settingsPath, applyFreshPluginConsent(() => loadSettings(settingsPath), name, info.requiredConsents, Date.now()));
        console.log(`${AQUA}${name} enabled${RESET} — restart the daemon to apply`);
        process.exit(0);
      }

      saveSettings(settingsPath, setPluginEnabled(settings, name, true));
      console.log(`${AQUA}${name} enabled${RESET} — restart the daemon to apply`);
      process.exit(0);
    }

    if (sub === "disable") {
      const name = process.argv[4];
      if (!name) { console.error("usage: norma plugin disable <name>"); process.exit(1); }
      if (!existsSync(join(pluginsRoot, name))) { console.error(`no such plugin: ${name}`); process.exit(1); }
      const { loadSettings, saveSettings } = await import("@norma/core");
      const settings = stripPluginConsents(setPluginEnabled(loadSettings(settingsPath), name, false), name);
      saveSettings(settingsPath, settings);
      // Phase 4b Task 2: best-effort revoke of the plugin's daemon-side token (Tier-2 platform
      // plugins only have one, but revoking is harmless/no-op for Tier-1 — the daemon just deletes
      // a row that never existed). A down daemon is tolerated, never blocks the disable.
      const revoked = await revokePluginTokenBestEffort(revokePluginTokenViaDaemon, name);
      if (!revoked.ok) console.log(`${DIM}${revoked.note}${RESET}`);
      console.log(`${AQUA}${name} disabled${RESET} — restart the daemon to apply`);
      break;
    }

    if (sub === "remove") {
      const name = process.argv[4];
      if (!name) { console.error("usage: norma plugin remove <name>"); process.exit(1); }
      try {
        removePluginDir(pluginsRoot, name);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const { loadSettings, saveSettings } = await import("@norma/core");
      saveSettings(settingsPath, removePluginFromSettings(loadSettings(settingsPath), name));
      // Phase 4b Task 2: same best-effort token revoke as disable (see comment there) — removing
      // the plugin dir must not silently leave a stale, still-valid token in the daemon's sqlite.
      const revoked = await revokePluginTokenBestEffort(revokePluginTokenViaDaemon, name);
      if (!revoked.ok) console.log(`${DIM}${revoked.note}${RESET}`);
      console.log(`${AQUA}removed ${name}${RESET}`);
      break;
    }

    if (sub === "restart") {
      const name = process.argv[4];
      if (!name) { console.error("usage: norma plugin restart <name>"); process.exit(1); }
      const c = await connect(`cli-plugin-restart-${name}`);
      try {
        await c.restartPlugin(name);
      } catch (err) {
        console.error((err as Error).message);
        c.close();
        process.exit(1);
      }
      console.log(`${AQUA}${name} restart requested${RESET}`);
      c.close();
      process.exit(0);
    }

    console.error("usage: norma plugin list | install <git-url> [name] | enable <name> | disable <name> | remove <name> | restart <name>");
    process.exit(1);
  }
  case "bg": {
    const bgSub = process.argv[3];
    const bgSessionId = process.argv[4];
    const bgTaskId = process.argv[5];
    if (!bgSessionId || (bgSub !== "list" && !bgTaskId)) {
      console.error("usage: norma bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>");
      process.exit(1);
    }
    const c = await connect("cli-bg");
    if (bgSub === "list") {
      const result = await runBgListRoute(c, bgSessionId);
      if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
      for (const t of result.tasks) console.log(`${AQUA}${t.taskId}${RESET} ${DIM}${t.status} · ${t.command.slice(0, 80)}${RESET}`);
      if (result.tasks.length === 0) console.log(`${DIM}(no bg tasks)${RESET}`);
    } else if (bgSub === "peek") {
      const result = await runBgPeekRoute(c, bgSessionId, bgTaskId!);
      if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
      console.log(`${AQUA}${result.status}${RESET} ${DIM}exit=${result.exitCode ?? "-"}${RESET}`);
      if (result.chunk) process.stdout.write(result.chunk);
    } else if (bgSub === "kill") {
      const result = await runBgKillRoute(c, bgSessionId, bgTaskId!);
      if (!result.ok) { console.error(result.message); c.close(); process.exit(1); }
      console.log(`${AQUA}killed ${bgTaskId}${RESET}`);
    } else {
      console.error("usage: norma bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>");
      c.close();
      process.exit(1);
    }
    c.close();
    break;
  }
  case "routines": {
    // usage: norma routines [list] | routines create "<spec>" [--policy auto|plan] -- <prompt…>
    //        | routines delete <id> | routines enable <id> | routines disable <id>
    // Argument validation happens BEFORE connecting (mirrors `bg`'s fail-fast usage check just
    // above) — a bad invocation never opens a daemon socket at all.
    const routinesUsage = 'usage: norma routines [list] | routines create "<spec>" [--policy auto|plan] -- <prompt…> | routines delete <id> | routines enable <id> | routines disable <id>';
    const createUsage = 'usage: norma routines create "<spec>" [--policy auto|plan] -- <prompt…>';
    const routinesSub = process.argv[3];

    if (routinesSub === "create") {
      const spec = process.argv[4];
      const tail = process.argv.slice(5);
      const dashIdx = tail.indexOf("--");
      if (!spec || dashIdx === -1) { console.error(createUsage); process.exit(1); }
      const flags = tail.slice(0, dashIdx);
      const prompt = tail.slice(dashIdx + 1).join(" ").trim();
      let policy: "auto" | "plan" | undefined;
      const policyIdx = flags.indexOf("--policy");
      if (policyIdx !== -1) {
        const val = flags[policyIdx + 1];
        if (val !== "auto" && val !== "plan") { console.error(createUsage); process.exit(1); }
        policy = val;
      }
      if (!prompt) { console.error(createUsage); process.exit(1); }
      const c = await connect("cli-routines");
      try {
        const { routine } = await c.routinesCreate({ spec, prompt, ...(policy ? { policy } : {}) });
        console.log(`${AQUA}created ${routine.id}${RESET} ${DIM}${formatRoutineDetail(routine)}${RESET}`);
      } catch (err) {
        console.error((err as Error).message);
        c.close();
        process.exit(1);
      }
      c.close();
      break;
    }

    if (routinesSub === "delete") {
      const id = process.argv[4];
      if (!id) { console.error("usage: norma routines delete <id>"); process.exit(1); }
      const c = await connect("cli-routines");
      const { removed } = await c.routinesDelete(id);
      if (!removed) {
        console.error(`no routine found with id ${id}`);
        c.close();
        process.exit(1);
      }
      console.log(`${AQUA}deleted ${id}${RESET}`);
      c.close();
      break;
    }

    if (routinesSub === "enable" || routinesSub === "disable") {
      const id = process.argv[4];
      if (!id) { console.error(`usage: norma routines ${routinesSub} <id>`); process.exit(1); }
      const c = await connect("cli-routines");
      try {
        const { routine } = await c.routinesUpdate({ id, patch: { enabled: routinesSub === "enable" } });
        console.log(`${AQUA}${routinesSub}d ${routine.id}${RESET} ${DIM}${formatRoutineDetail(routine)}${RESET}`);
      } catch (err) {
        console.error((err as Error).message);
        c.close();
        process.exit(1);
      }
      c.close();
      break;
    }

    if (routinesSub === undefined || routinesSub === "list") {
      const c = await connect("cli-routines");
      const { routines } = await c.routinesList();
      if (routines.length === 0) console.log(`${DIM}(no routines)${RESET}`);
      for (const r of routines) console.log(`${AQUA}${r.id}${RESET} ${DIM}${formatRoutineDetail(r)}${RESET}`);
      c.close();
      break;
    }

    console.error(routinesUsage);
    process.exit(1);
  }
  case "memory": {
    // usage: norma memory [list] [--project] | show <name> [--project] | rm <name> [--project]
    // Argument validation (parseMemoryArgs) happens BEFORE connecting — mirrors `routines`' own
    // fail-fast usage check just above: a bad invocation never opens a daemon socket.
    const route = parseMemoryArgs(process.argv.slice(3), process.cwd());
    if (route.kind === "usage") { console.error(MEMORY_USAGE); process.exit(1); }

    const c = await connect("cli-memory");
    try {
      const result = await runMemoryRoute(c, route);
      if (result.kind === "list") {
        if (result.facts.length === 0) console.log(`${DIM}(no memory facts)${RESET}`);
        for (const f of result.facts) console.log(`${AQUA}${f.name}${RESET} ${DIM}${formatFactDetail(f)}${RESET}`);
      } else if (result.kind === "show") {
        console.log(`${AQUA}${result.fact.name}${RESET} ${DIM}${formatFactDetail(result.fact)}${RESET}`);
        console.log(result.fact.body);
      } else {
        console.log(`${AQUA}${formatDeleted(result.name, result.scope)}${RESET}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      c.close();
      process.exit(1);
    }
    c.close();
    break;
  }
  case "watch": {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error("usage: norma watch <sessionId>"); process.exit(1); }
    const c = await connect("cli-watch", (e) => {
      if (e.type === "user_message") console.log(`${AQUA}❯${RESET} [${e.clientName}] ${e.text}`);
      else console.log(`${DIM}· ${e.type}${"clientName" in e ? ` (${e.clientName})` : ""}${RESET}`);
    });
    // Plan-immunity Task 2: CLIENT-side mode gate, same reasoning as `case "send"` above (product-
    // surface rule, not a security boundary — session-mode.ts's file doc).
    const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; mode?: string }> };
    const check = checkCodeSession(sessions, sessionId);
    if (!check.ok) { console.error(check.message); c.close(); process.exit(1); }
    await c.attach(sessionId, 0);
    console.log(`${DIM}watching ${sessionId} — ctrl-c to stop${RESET}`);
    await new Promise(() => {}); // run until interrupted
    break; // unreachable, but keeps the switch uniform
  }
  case "daemon install": {
    const { installDaemon } = await import("./launchd");
    // process.execPath = the bun binary in dev, the compiled `norma` binary in production.
    const binary = process.execPath;
    if (binary.endsWith("/bun")) {
      console.error("daemon install requires the compiled norma binary (Task 16); in dev use: norma daemon run");
      process.exit(1);
    }
    await installDaemon(binary, resolveNormaHome());
    console.log(`${AQUA}installed launchd agent${RESET} — daemon starts at login and stays alive`);
    break;
  }
  case "daemon uninstall": {
    const { uninstallDaemon } = await import("./launchd");
    await uninstallDaemon();
    console.log("launchd agent removed");
    break;
  }
  case "daemon status": {
    const { daemonStatus } = await import("./launchd");
    console.log(await daemonStatus());
    break;
  }
  case "login": {
    const { KeychainSecretStore, CodexAuthStore, runLoginFlow, CODEX, OPENAI_API_KEY_SECRET, WEB_SEARCH_API_KEY_SECRET, EXA_API_KEY_SECRET, profileDisplayName } = await import("@norma/core");
    console.log(`${AQUA}${profileDisplayName()} login${RESET}`);
    const secrets = new KeychainSecretStore();
    if (process.argv.includes("--api-key")) {
      const key = (await readSecret("Paste your OpenAI API key: ")).trim();
      if (!key.startsWith("sk-")) { console.error("that does not look like an API key"); process.exit(1); }
      // Fold-in (chat-mode Slice B1 final re-review, same class as FIX 1 above, worse sink): this
      // is the ONE key-entry path that predates invisibleKeyCharWarning and therefore lacked it —
      // --web-search-key and --exa-key below already reject before ever reaching a fetch header.
      // This is prevention at the input boundary only: OpenAICompatibleProvider's OWN error-handling
      // sink for an invalid header (confirmed live: `Header '14' has invalid value: 'Bearer
      // ...'`) is untouched here and remains a follow-up — that message flows through
      // engine.ts into an `agent_error` SessionEvent PERSISTED to the session JSONL, and can become
      // a parent-model-visible tool_result via a dispatched child's errorMessage. Catching a bad key
      // at `norma login` time is strictly better than fixing it after the fact, but does not make
      // the provider sink itself safe against a key that reaches it some other way.
      const invisibleWarning = invisibleKeyCharWarning(key);
      if (invisibleWarning) { console.error(invisibleWarning); process.exit(1); }
      await secrets.set(OPENAI_API_KEY_SECRET, key);
      console.log(`${AQUA}API key stored in Keychain${RESET} — set provider type in ~/.norma/settings.json (openai-compatible)`);
      break;
    }
    // 4g Task 6: web_search's Brave Search API key. Mirrors the --api-key branch above exactly
    // (readSecret → validate → secrets.set → confirm → break) — the only difference is the
    // validation, since Brave keys carry no known "sk-"-style prefix to sniff, so this just
    // rejects an empty paste instead of a format check.
    if (process.argv.includes("--web-search-key")) {
      const key = (await readSecret("Paste your Brave Search API key: ")).trim();
      if (!key) { console.error("that does not look like an API key"); process.exit(1); }
      // Branch review FIX 1 (defense in depth): reject before it ever reaches a fetch header.
      const invisibleWarning = invisibleKeyCharWarning(key);
      if (invisibleWarning) { console.error(invisibleWarning); process.exit(1); }
      await secrets.set(WEB_SEARCH_API_KEY_SECRET, key);
      console.log(`${AQUA}Brave Search API key stored in Keychain${RESET} — web_search is ready to use`);
      break;
    }
    // B1-T5: Search's Exa API key. Same shape as the --web-search-key branch above — chat's
    // Search tool and code's web_search each keep their own keychain secret so the two can never
    // be confused for one another.
    if (process.argv.includes("--exa-key")) {
      const key = (await readSecret("Paste your Exa API key: ")).trim();
      if (!key) { console.error("that does not look like an API key"); process.exit(1); }
      // Branch review FIX 1 (defense in depth): reject before it ever reaches a fetch header.
      const invisibleWarning = invisibleKeyCharWarning(key);
      if (invisibleWarning) { console.error(invisibleWarning); process.exit(1); }
      await secrets.set(EXA_API_KEY_SECRET, key);
      console.log(`${AQUA}Exa API key stored in Keychain${RESET} — Search is ready to use in Chat`);
      break;
    }
    const tokens = await runLoginFlow({
      clientId: CODEX.clientId,
      authorizeUrl: CODEX.authorizeUrl,
      tokenUrl: CODEX.tokenUrl,
      callbackPort: CODEX.callbackPort,
      scope: CODEX.scope,
      openBrowser: async (url) => { Bun.spawn(["open", url]); },
    });
    await new CodexAuthStore(secrets).save(tokens);
    console.log(`${AQUA}◍ signed in with ChatGPT${RESET} ${DIM}(account ${tokens.accountId ?? "unknown"})${RESET}`);
    break;
  }
  case "logout": {
    const { KeychainSecretStore, CODEX_SECRET_NAMES } = await import("@norma/core");
    const secrets = new KeychainSecretStore();
    // Phase 1a simplification: SecretStore gains delete() in 1b — empty value de-authorizes everywhere today.
    for (const name of Object.values(CODEX_SECRET_NAMES)) {
      await secrets.set(name, "");
    }
    console.log("signed out");
    break;
  }
  case "provider": {
    const { loadSettings, resolveNormaHome } = await import("@norma/core");
    const s = loadSettings(join(resolveNormaHome(), "settings.json"));
    console.log(`${AQUA}${s.provider.type}${RESET} ${DIM}model ${s.provider.model}${RESET}`);
    break;
  }
  case "model": {
    // Direct settings.json read/write (no daemon RPC needed) — mirrors `provider` above and
    // `plugin enable/disable`'s direct-write pattern. The whole point of this command (spec:
    // "changing models must NOT require a daemon restart") is that a running daemon picks the
    // new value up on its NEXT turn via providers/manager.ts's live model resolver — no restart,
    // no RPC round-trip needed here at all.
    const { loadSettings, saveSettings, resolveNormaHome, setProviderModel, setReasoningEffort, CODEX_MODELS } = await import("@norma/core");
    const settingsPath = join(resolveNormaHome(), "settings.json");
    const settings = loadSettings(settingsPath);
    const action = parseModelArgs(process.argv.slice(3));

    if (action.kind === "usageError") {
      console.error(action.message);
      process.exit(1);
    }

    if (action.kind === "show") {
      const effortSuffix = settings.provider.reasoningEffort ? `  ${DIM}effort: ${settings.provider.reasoningEffort}${RESET}` : "";
      console.log(`${AQUA}${settings.provider.model}${RESET}${effortSuffix}`);
      if (settings.provider.type === "codex-oauth") {
        console.log(`${DIM}available (codex-oauth):${RESET}`);
        for (const m of CODEX_MODELS) {
          const active = m.id === settings.provider.model;
          console.log(`  ${active ? `${AQUA}*${RESET}` : " "} ${m.id}`);
        }
      }
      process.exit(0);
    }

    let next = settings;
    if (action.kind === "setModel" || action.kind === "setModelAndEffort") {
      const err = validateModelSlug(settings.provider.type, action.slug);
      if (err) { console.error(err); process.exit(1); }
      next = setProviderModel(next, action.slug);
    }
    if (action.kind === "setEffort" || action.kind === "setModelAndEffort") {
      const err = validateEffort(action.effort);
      if (err) { console.error(err); process.exit(1); }
      next = setReasoningEffort(next, action.effort as NonNullable<Settings["provider"]["reasoningEffort"]>);
    }
    saveSettings(settingsPath, next);
    const changed = [
      action.kind === "setModel" || action.kind === "setModelAndEffort" ? `model ${next.provider.model}` : null,
      action.kind === "setEffort" || action.kind === "setModelAndEffort" ? `effort ${next.provider.reasoningEffort}` : null,
    ].filter(Boolean).join(", ");
    console.log(`${AQUA}updated${RESET} ${DIM}(${changed}) — takes effect next turn, no daemon restart needed${RESET}`);
    process.exit(0);
    break; // unreachable (every branch exits) — guards against silent fallthrough if exit behavior ever changes
  }
  case "output-style": {
    // Direct settings.json read/write (no daemon RPC needed) — mirrors `case "model"` above: an
    // output-style switch must not require a daemon restart (the daemon re-resolves
    // settings.outputStyle, live, on the session's next turn — same live-getter precedent as the
    // provider model).
    const { parseOutputStyleArgs } = await import("./output-style-cli");
    const { loadSettings, saveSettings, resolveNormaHome, setOutputStyle, OutputStyleStore, TrustStore } = await import("@norma/core");
    const action = parseOutputStyleArgs(process.argv.slice(3));
    const home = resolveNormaHome();
    const settingsPath = join(home, "settings.json");

    if (action.action === "help") {
      console.log("Usage: norma output-style [name]\n  (no arg)  list available styles\n  <name>    set the active output style");
      break;
    }

    // loadSettings throws its own helpful error (mirrors `case "model"` above, which loads
    // unguarded the same way) if settings.json is missing/unparseable — a Norma install always
    // has one, so this never fabricates a fallback Settings object; a missing/invalid file fails
    // the exact same way `norma model` would.
    const settings = loadSettings(settingsPath);
    const store = new OutputStyleStore({ normaHome: home, trust: new TrustStore(join(home, "trust.json")) });
    const cwd = process.cwd();
    const current = settings.outputStyle ?? "default";

    if (action.action === "list") {
      for (const s of store.list(cwd)) {
        console.log(`${s.name === current ? "*" : " "} ${s.name.padEnd(14)} ${s.description}`);
      }
      break;
    }

    // set
    if (!store.resolve(action.name, cwd)) {
      console.error(`Unknown output style: ${action.name}`);
      console.error(`Available: ${store.list(cwd).map((s) => s.name).join(", ")}`);
      process.exitCode = 1;
      break;
    }
    saveSettings(settingsPath, setOutputStyle(settings, action.name));
    console.log(`Output style set to: ${action.name}`);
    break;
  }
  case "workflow": {
    // CC-parity phase 3 (Workflows), Track C Task C3. `list`/`save` are file-direct (WorkflowStore,
    // C1) — mirrors `case "output-style"` just above: reading/writing `.norma/workflows/*.js`
    // never needs the daemon up, exactly like an output-style switch never needing a restart.
    // `run` is the one exception: workflows actually EXECUTE in the daemon (WorkflowRuntime,
    // core/src/workflows/runtime.ts, C2), so it goes through NormaClient/connect() like every
    // other daemon-RPC case (`memory`, `routines`, …) instead of touching files directly.
    const { parseWorkflowArgs } = await import("./workflow-cli");
    const action = parseWorkflowArgs(process.argv.slice(3));

    if (action.action === "help") {
      console.log("Usage: norma workflow [list] | run <name> [json-args] | save <name> [file]\n  (no arg)     list saved workflows (+ running runs, if a daemon is already up)\n  run <name>   run a saved workflow; json-args (a JSON string) seeds its `args` binding\n  save <name>  save a workflow script from <file> (or stdin, if omitted) to ~/.norma/workflows/<name>.js");
      break;
    }

    const { WorkflowStore, TrustStore } = await import("@norma/core");
    const home = resolveNormaHome();
    const store = new WorkflowStore({ normaHome: home, trust: new TrustStore(join(home, "trust.json")) });
    const cwd = process.cwd();

    if (action.action === "list") {
      const saved = store.list(cwd);
      if (saved.length === 0) console.log(`${DIM}(no saved workflows)${RESET}`);
      for (const w of saved) console.log(`${AQUA}${w.name}${RESET} ${DIM}(${w.source}) — ${w.description}${RESET}`);

      // Best-effort daemon augmentation, ONLY if a daemon is ALREADY up (a direct existsSync
      // check — never connect()'s own autolaunch: unlike `run`, a plain `list` must not have the
      // side effect of spawning Norma.app). workflow.list is session-scoped server-side
      // (WorkflowRegistry.list(sessionId) filters strictly to that session's own runs), so this
      // creates a session the same way `run` does below; wrapped in try/catch because the
      // file-direct saved list above already answered the primary ask — a down/flaked daemon must
      // never turn a successful `list` into a failed one.
      if (existsSync(socketPath())) {
        try {
          const c = await connect("cli-workflow-list");
          try {
            const { sessionId } = await c.createSession("global", { cwd });
            const { running } = await c.workflowList(sessionId, cwd);
            if (running.length > 0) {
              console.log(`${DIM}running:${RESET}`);
              for (const r of running) console.log(`${AQUA}${r.runId}${RESET} ${DIM}${r.name ?? "(inline script)"} · ${r.status}${RESET}`);
            }
          } finally {
            c.close();
          }
        } catch {
          // daemon flaked between the exists-check and connect()/hello — best-effort, never fatal.
        }
      }
      break;
    }

    if (action.action === "save") {
      try {
        const source = action.file !== undefined ? readFileSync(action.file, "utf8") : await Bun.stdin.text();
        store.save(action.name, source);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      console.log(`${AQUA}saved${RESET} ${DIM}${action.name} → ${join(home, "workflows", `${action.name}.js`)}${RESET}`);
      break;
    }

    // run — the only verb that needs the daemon: workflows execute there, never locally.
    let args: unknown;
    if (action.args !== undefined) {
      try {
        args = JSON.parse(action.args);
      } catch {
        console.error(`invalid JSON args: ${action.args}`);
        process.exit(1);
      }
    }
    const c = await connect("cli-workflow-run");
    try {
      const { sessionId } = await c.createSession("global", { cwd });
      const { runId } = await c.workflowRun({ sessionId, name: action.name, args });
      console.log(`${AQUA}${runId}${RESET} ${DIM}running${RESET}`);
    } catch (err) {
      // Unknown workflow name (or any other RPC failure, e.g. no WorkflowRuntime configured) comes
      // back as a rejected request (client.ts's request() rejects with the server's RpcFailure
      // message) — same "caller's try/catch prints .message and exits 1" idiom as `case "memory"`.
      console.error((err as Error).message);
      c.close();
      process.exit(1);
    }
    c.close();
    break;
  }
  case "init": {
    await runTurnSession({ promptOverride: INIT_PROMPT, forceAuto: true, chat: false }); // force auto: writes NORMA.md without approval prompts
    break;
  }
  case "resume": {
    const sid = process.argv[3];
    if (!sid) {
      // picker: list resumable sessions. Plan-immunity Task 2: this is a PICKER (same shape as the
      // TUI's `/sessions` — its own inline comment is the same phrase), not the plain `norma
      // sessions` inventory, so it HIDES non-code rows (`filterCodeSessions`) rather than marking
      // them — showing a row here that `resume <id>` would immediately refuse below is the
      // shown-but-broken shape this slice keeps closing. See session-mode.ts's file doc.
      const c = await connect("cli-resume");
      const { sessions } = (await c.listSessions()) as { sessions: Array<{ sessionId: string; scope: string; lastSeq: number; title?: string; mode?: string }> };
      const rows = filterCodeSessions(sessions);
      if (!rows.length) console.log("no sessions yet");
      for (const r of rows) console.log(`${r.sessionId}  ${DIM}${r.scope}  ${r.lastSeq} events${process.stdout.isTTY && r.title ? ` — ${r.title}` : ""}${RESET}`);
      c.close(); process.exit(0);
    }
    // `route` was computed from this same `argv` up front (routeCliInvocation), so — sid being
    // truthy here means `sub !== undefined` held there too — it's necessarily "chat" or
    // "resumeOneShot", never "fallthrough". Finding 4 hygiene: previously this was two consecutive
    // unconditional `if`s with no `else`/`return` between them, so the chat call (below) fell
    // through into the one-shot call with empty prompt text right after — harmless only because
    // runTurnSession(chat:true) never returns in normal operation (teardownAndExit always
    // process.exit()s), not a guarantee. (A bare top-level `return` isn't legal here — this file's
    // dispatch runs at module top level, not inside a function — so the fix is this if/else rather
    // than a literal `return`.)
    if (route.kind === "chat") {
      // No message, or exactly `--auto`/`--plan` (Finding 3 — previously sent as literal prompt
      // text) → resume INTO chat mode on this session (§0). runTurnSession does its own existence
      // check + "↻ resuming …" line; policy seeds from that flag (default ask) via the same
      // process.argv read runTurnSession already does for the bare-chat path.
      await runTurnSession({ existingSessionId: sid, chat: true });
    } else if (route.kind === "resumeOneShot") {
      await runTurnSession({ promptOverride: route.text, forceAuto: true, existingSessionId: sid, chat: false }); // continue the existing session (auto, one-shot)
    }
    break;
  }
  case "provider-smoke": {
    const { loadSettings, resolveNormaHome, createProvider, KeychainSecretStore } = await import("@norma/core");
    const s = loadSettings(join(resolveNormaHome(), "settings.json"));
    const active = await createProvider(s, new KeychainSecretStore());
    const promptIdx = process.argv.indexOf("--prompt");
    const prompt = promptIdx > 0 ? process.argv[promptIdx + 1]! : "Reply with exactly: norma provider smoke OK";
    console.log(`${DIM}provider=${active.provider.id} model=${active.model}${RESET}`);
    let text = "";
    for await (const e of active.provider.streamTurn({
      model: active.model,
      input: [{ type: "message", role: "user", content: prompt }],
    })) {
      if (e.type === "text_delta") { text += e.delta; process.stdout.write(e.delta); }
      else if (e.type === "error") { console.error(`\n${e.code}: ${e.message}`); process.exit(1); }
      else if (e.type === "usage") console.log(`\n${DIM}usage: ${e.inputTokens} in / ${e.outputTokens} out${RESET}`);
    }
    process.exit(text.length > 0 ? 0 : 1);
  }
  default:
    console.log(`norma ${CORE_VERSION} — commands:
  daemon run | daemon install | daemon uninstall | daemon status
  ping | sessions | status | quota | send <sessionId|new> <text> | watch <sessionId> | add-dir <sessionId> <path> [--persist] | cd <sessionId> <path>
  steer <sessionId> <text> | interrupt <sessionId> | compact <sessionId>
  agents                                          live roster of background/active sessions (stop, background, archive, resume)
  resume [id] [msg]   list sessions, or continue an existing one
  trust <dir> [--list] | trust list | trust remove <path>
  skills                                          list discovered skills for this directory
  mcp                                              list configured MCP servers and their tools
  plugin list | install <git-url> [name] | enable <name> | disable <name> | remove <name> | restart <name>
  bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>
  routines [list] | routines create "<spec>" [--policy auto|plan] -- <prompt>
    | routines delete <id> | routines enable <id> | routines disable <id>       manage scheduled routines
  memory [list] [--project] | show <name> [--project] | rm <name> [--project]  manage saved memory facts
  login [--api-key] [--web-search-key] [--exa-key] | logout | provider | provider-smoke [--prompt <text>]
  init                                            generate/update NORMA.md by surveying the project
  -p "<prompt>" [--auto|--plan] [--trust|--no-trust]   headless agent turn (asks for tool approval unless --auto/--plan)`);
  }
}
