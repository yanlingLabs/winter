/**
 * Office Stage C — THE HEADLESS AGENT GATE.
 *
 * Runs the office agent tools end to end with no human in the loop: a real daemon on a temp
 * `NORMA_HOME`, the real dev app, the real `NormaOfficeHelper`, the real vendored LibreOffice, and
 * the REAL AGENT reached through `norma -p` / `norma resume` with prompts phrased the way a user
 * would phrase them. Then it asserts on the resulting files' OWN BYTES and on live UI facts read
 * back through accessibility scripting.
 *
 *   bun run scripts/office-agent-gate.ts
 *   bun run verify:office-agent          (package.json alias)
 *
 * Posture mirrors `scripts/verify-workflow-compiled.ts`: standalone, never part of the `bun test`
 * sweep, real artifacts only, and it must stay green.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE EVIDENCE RULE, which is the entire point of this file
 *
 * **Every assertion is on a file's bytes or on the UI. Never on the agent's own prose.** This is
 * not a stylistic preference — it was demonstrated on this gate's very first probe. Asked to read a
 * spreadsheet with the app detached, the agent answered:
 *
 *     "I couldn't read budget.xlsx because the Sheets tool requires the Mac app to be open and
 *      showing this session. No document data was accessed."
 *
 * Fluent, accurate-sounding, and worth nothing as evidence — the fact was the tool's own ERROR
 * line. A verb that silently no-ops must NEVER read as a pass here, so nothing this gate believes
 * comes from the model's narration of what it did.
 *
 * Corollaries, each earned from a defect this arc actually shipped as a passing test:
 *  - **No assertion may hold against the pristine fixture.** The arc's #1 defect class, four
 *    separate occurrences, is a drill whose "after" state is identical to the untouched file. Every
 *    expected value here is computed from the SEEDED COPY's real bytes at runtime and every write
 *    assertion is paired with a `differsFromPristine` check that fails the step if the file did not
 *    actually change.
 *  - **Read-back happens after a full app restart.** An in-session read can be served by the
 *    document still open in memory, which proves nothing about what was saved. The gate quits the
 *    app, kills every helper, and relaunches before its read-back phase.
 *  - **A timeout is never a pass.** Every wait is bounded and a bound that expires is a failure
 *    naming what it was waiting for.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THREE VERDICT CLASSES, because "it failed" is not a diagnosis
 *
 * `ENV-FAIL`  the gate could not run truthfully (no AX trust, socket path too long, app died,
 *             daemon unreachable). NOT a verdict about any verb.
 * `FILE-FAIL` a verb's bytes are wrong. This is the real product signal.
 * `UI-SKIP`   a live UI fact was not observable. Reported OUTSIDE the pass/fail tally — never as a
 *             failure that "does not block", which would just train readers to ignore the section.
 *             So a flaky window can never be mistaken for a broken verb, nor the reverse.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * FIVE THINGS THIS GATE LEARNED THE HARD WAY (none of them in the ledger before Task 8)
 *
 * 1. **`sockaddr_un.sun_path` is 103 bytes** (bind probe: 103 OK, 104 "path too long"; confirmed
 *    independently in review). A `NORMA_HOME` under a deep temp root makes the app die ~2s after
 *    launch with exit 133 (SIGTRAP), NO crash report and NO log line. `assertSocketPathFits` is the
 *    preflight that turns that into one clear sentence, and the gate roots itself at a SHORT `/tmp`
 *    path.
 *
 *    ⚠️ **A CORRECTION, recorded because getting it wrong is instructive.** An earlier version of
 *    this header claimed the daemon "reports listening on a socket it never created" — that the
 *    over-long path produced `core.lock` and no `core.sock`. **That is FALSE and there is no such
 *    product bug.** Re-tested at a 127-byte socket path: while the daemon is running,
 *    `run/` contains a real `srw------- core.sock`. The original observation listed the directory
 *    AFTER killing the daemon, and the daemon REMOVES ITS SOCKET ON SHUTDOWN — so what looked like
 *    "never created" was ordinary cleanup. Wrong conclusion AND wrong supporting fact, from an
 *    instrument that measured after the fact rather than during it.
 *
 * 2. **The office tools need the app ATTACHED TO THIS SESSION**, and the app attaches to whatever
 *    session its window shows. Norma is `LSUIElement` — no window at launch — so this gate drives
 *    the `NORMA_GATE_SESSION` DEBUG door (added in Task 8) rather than AX-clicking an unnamed
 *    sidebar row by index, which could not tell the right row from any other.
 * 3. **The app mints its own `mode: "chat"` session on launch.** Office tools are
 *    `modes: ["code","dispatch"]` — never chat. Picking a session "the first one on disk" grabs the
 *    app's chat session and the CLI refuses with "chat sessions live in the Norma app". The gate
 *    creates its CODE session first and aims the door at that exact id.
 * 4. **`norma-dev` hardcodes the MAIN checkout.** `/opt/homebrew/bin/norma-dev` honours a preset
 *    `NORMA_HOME` but its last line execs `…/Norma v2/packages/cli/src/main.ts`. Driving this gate
 *    through it would test `main`'s CLI+core, not this branch's — green, and proving nothing. The
 *    gate invokes THIS TREE's `packages/cli/src/main.ts` directly.
 * 5. **`timeout(1)` does not exist on this host.** Every bound here is a TS `setTimeout`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE UI LEG, and why it is honestly the weakest one
 *
 * AX *reading* works from this driving process (`kTCCServiceAccessibility` is granted; the ledger's
 * earlier notes about AX being unavailable were about `kTCCServicePostEvent` — event SYNTHESIS —
 * which is a different TCC service this gate never needs). The two facts below have been observed
 * live and are what the gate asserts:
 *
 *     AXStaticText  "…/budget.xlsx"      the document tab's own chrome
 *     AXStaticText  "A1: NORMA GATE"     the formula bar, showing the REAL cell content
 *
 * The second is the strongest UI fact available anywhere in this app: not a static label, but the
 * document's own content read back through the live LibreOffice view.
 *
 * Caveats stated rather than hidden — this leg is the one part of the gate that is NOT reliable:
 *  - AppleScript's `entire contents` returns EMPTY on this app's SwiftUI hosting view while direct
 *    child traversal works — a silent false negative. The reader below is therefore **JXA**
 *    (`osascript -l JavaScript`) doing an explicit recursive walk and emitting JSON.
 *  - **The shell window is created unreliably in this Debug configuration, and ROOT CAUSE IS NOT
 *    ESTABLISHED.** What was measured, so the next person does not re-derive it:
 *      · when the window DOES appear, both facts above are present and stable for ~35-45s, then
 *        the window degrades and disappears while the app stays alive and LibreOffice keeps
 *        servicing the document;
 *      · the window frequently never appears at all, with the app attached and every office verb
 *        working — proving attachment and window presentation are independent;
 *      · this is NOT specific to the gate's door: launching with the PRE-EXISTING
 *        `NORMA_PANEL_SMOKE=1` produced no window either, on the same build;
 *      · it is not the spawn method — direct-exec, `open -n --env`, and a plain shell launch all
 *        reproduce it;
 *      · `tell application id "com.norma.app.dev" to activate` answers
 *        `Application isn't running (-600)` for a directly-exec'd bundle, so activation cannot be
 *        used to force the window up.
 *    ⟹ these observations are reported as `UI-SKIP`, OUTSIDE the verdict tally. The predicates are
 *    real and have been observed green, but until the window is fixed they cannot detect a
 *    regression, so counting them either way would be dishonest. Fixing the window presentation is
 *    a named follow-up for Task 9; restoring these to real verdicts belongs with it.
 *  - One measurement trap worth keeping: the AX reader takes the FIRST process matching the dev
 *    bundle id, so a LEFTOVER app instance makes it read the wrong window. That produced three
 *    consecutive "the window never appears" conclusions while the real instance was rendering the
 *    document perfectly. `ui.singleInstance` now asserts the invariant instead of assuming it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * REPRODUCING THE DELETION-RED (the house evidence standard: prove the gate can FAIL)
 *
 * A gate nobody has seen fail is not evidence. This one was proven by breaking a REAL mechanism —
 * not by mutating an expectation — in `apple/Norma/Sources/OfficeHelper/LOKBridge.swift`, at the
 * top of `sheetsSetOnDedicatedThread`'s per-cell write loop:
 *
 *     if ProcessInfo.processInfo.environment["NORMA_GATE_BREAK_SHEETS_SET"] == "1" {
 *         return cellAddresses.count      // skip every write, still report full success
 *     }
 *
 * That is precisely the failure this gate exists to catch: a verb that silently no-ops while
 * reporting success. Rebuild the Debug app, then `bun run scripts/office-agent-gate.ts
 * --break-sheets-set`.
 *
 * OBSERVED RESULT, and why it is the right red:
 *   - the TOOL reported success:   `↳ wrote 2 cells to Sheet1!A4:B4 in budget.xlsx`
 *   - the AGENT narrated success:  "Updated `Sheet1!A4:B4` with "QUARTERLY REVIEW" and `1234`."
 *   - the GATE went red anyway, naming the exact cells under test:
 *         sheets.set — saved bytes: A4=null (want "QUARTERLY REVIEW"), B4=null (want "1234")
 *   - the INDEPENDENT helper re-open leg went red too, showing the file's real content (rows 1-2
 *     only, no row 4) — two legs, one cause, neither derived from the other
 *   - every OTHER verb stayed green, so the break is scoped rather than a blanket failure, and
 *     `RESULT: FAIL` with exit 1
 *
 * The probe is reverted; the product tree contains none of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS GATE DOES NOT COVER — read this before trusting a green run
 *
 *  - It runs the office tools in **code** mode only; `dispatch` (their other declared mode) is not
 *    exercised, and `chat` correctly cannot reach them at all.
 *  - It needs a **logged-in GUI session**. This is an unattended *process*, not a headless CI job:
 *    it summons a real window on a real desktop.
 *  - It does not cover every verb — see `VERB_STEPS`. It covers at least one verb per family plus
 *    the two families' structural verbs, and characterizes three disclosed limitations.
 *  - It cannot prove a human's ⌘Z takes an edit back, because it does not: that is a real,
 *    user-facing limitation (spec §docs ruling 4 as amended) and the gate CHARACTERIZES it rather
 *    than asserting an ideal that does not hold.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "main.ts");
const APP_PROJECT_DIR = join(REPO_ROOT, "apple", "Norma");
const FIXTURE_DIR = join(REPO_ROOT, "apple", "Norma", "Tests", "NormaAppTests", "Fixtures", "office");

/** SHORT on purpose — see header note 1. `sockaddr_un.sun_path` is 103 bytes and a deep root is a
 *  silent 2-second app death. `GATE_ROOT` is short enough that even the app's own nested helper
 *  socket paths fit with room to spare. */
const GATE_ROOT = "/tmp/norma-office-gate";
const HOME_DIR = join(GATE_ROOT, "h");
const WORK_DIR = join(GATE_ROOT, "w");
const PRISTINE_DIR = join(GATE_ROOT, "p"); // untouched copies, for the differs-from-pristine check
const DERIVED_DATA = join(GATE_ROOT, "dd");

/** The one hard limit behind header note 1. */
const SUN_PATH_MAX = 103;

/** Bun's `spawnSync` default is 2,621,440 bytes and a clean Debug build emits ~4 MB on stdout;
 *  overflowing it SIGTERMs the child. 256 MB is not a guess about this build's size, it is
 *  headroom chosen so that growth in build verbosity can never silently re-break the command. */
const BUILD_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * How many file-evidence verdicts a complete run MUST report — pinned, not derived.
 *
 * Without this the tally's denominator is whatever `VERB_STEPS` happens to hold, so deleting a step
 * turns 8/8 into a green 7/7 and the gate silently stops testing something while still reporting
 * success. That is this arc's #1 defect class one level up: the SCORE itself going vacuous. Raise
 * it deliberately when adding a step.
 *
 * = VERB_STEPS.length (7) + the Phase 8 journal read-back (1).
 */
const EXPECTED_FILE_VERDICTS = 8;

const APP_BUNDLE_ID = "com.norma.app.dev";
const DAEMON_BOOT_TIMEOUT_MS = 60_000;
const APP_BOOT_TIMEOUT_MS = 90_000;
/** Office write verbs carry a 185s daemon-side deadline; a turn may legitimately take several
 *  model round trips on top of that. Generous, because the only thing this bound guards against is
 *  a genuine hang — never normal slowness, which would make a timeout indistinguishable from the
 *  finding it might be mimicking. */
const TURN_TIMEOUT_MS = 420_000;

// ── tiny output helpers ──────────────────────────────────────────────────────────────────────
const t0 = Date.now();
function log(line = ""): void { console.log(line); }
function step(line: string): void { console.log(`\n[${String(Date.now() - t0).padStart(7)}ms] ── ${line}`); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

type VerdictClass = "ENV-FAIL" | "FILE-FAIL" | "UI-SKIP";

/** Why the UI observations sit OUTSIDE the pass/fail tally rather than being a failure that never
 *  blocks. A permanent 2-of-3 FAIL that is documented as "ignore this" trains every future reader
 *  to ignore the UI section — which is this arc's own defect class relocated into the gate. The
 *  predicates are kept intact and reported honestly as UNAVAILABLE; restoring them to real
 *  verdicts is Task 9's window-presentation fix, not a thing this gate should paper over. */
const UI_SKIP_REASON =
  "The shell window is created unreliably in this Debug configuration (root cause unestablished; "
  + "not the gate's door — the pre-existing NORMA_PANEL_SMOKE loses its window too). These "
  + "predicates are REAL and have been observed green, but until that is fixed they cannot detect "
  + "a regression, so they are reported and NOT counted. Restoring them is Task 9's job.";
interface Verdict { name: string; ok: boolean; kind: VerdictClass; detail: string; }
const verdicts: Verdict[] = [];
function record(name: string, ok: boolean, kind: VerdictClass, detail: string): boolean {
  verdicts.push({ name, ok, kind, detail });
  log(`   [${ok ? "PASS" : `${kind === "UI-SKIP" ? "UNAVAIL" : "FAIL"}/${kind}`}] ${name} — ${detail}`);
  return ok;
}

/** Raised instead of exiting, so teardown always gets to run. See `GateExit`/`withTeardown`. */
class GateExit extends Error {
  constructor(readonly code: number) { super(`gate exit ${code}`); }
}

/**
 * An environment problem is never a verdict about a verb. Bail loudly and say which.
 *
 * THROWS rather than calling `process.exit`. `process.exit` inside the `try` skips the `finally`
 * outright, which is exactly how this gate came to leak a daemon, an app and its helpers on every
 * single run while its own teardown banner never printed once.
 */
function envFail(message: string): never {
  log(`\n╭─ ENV-FAIL ────────────────────────────────────────────────`);
  log(`│ ${message}`);
  log(`╰───────────────────────────────────────────────────────────`);
  log("\nRESULT: ENV-FAIL — the gate could not run truthfully. NO verb was judged.");
  throw new GateExit(2);
}

// ── preflight ────────────────────────────────────────────────────────────────────────────────

/** Header note 1, as a check that speaks. Without this the symptom is an app that dies 2s after
 *  launch with no crash report, no log line, and a daemon that claims to be listening. */
function assertSocketPathFits(label: string, path: string): void {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > SUN_PATH_MAX) {
    envFail(
      `${label} socket path is ${bytes} bytes; sockaddr_un.sun_path holds ${SUN_PATH_MAX}.\n`
      + `  ${path}\n`
      + `  This is NOT a configuration nit — it makes the Mac app die ~2s after launch with exit\n`
      + `  133 (SIGTRAP), no crash report and no log line. Root the gate somewhere shorter.`,
    );
  }
  log(`   socket path fits: ${bytes}/${SUN_PATH_MAX} bytes — ${path}`);
}

/** AX degrades to EMPTY DATA rather than an error when Accessibility trust is missing, so a naive
 *  UI assertion would silently read "tab not found" and produce a false red about the product.
 *  This probe gives that failure mode its own distinct verdict instead. */
function axTrustProbe(): { ok: boolean; detail: string } {
  const r = spawnSync("osascript", ["-e", 'tell application "System Events" to get name of first process'], {
    encoding: "utf8", timeout: 20_000,
  });
  if (r.error) return { ok: false, detail: `osascript failed to spawn: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, detail: `osascript exited ${r.status}: ${(r.stderr || "").trim()}` };
  const name = (r.stdout || "").trim();
  if (!name) return { ok: false, detail: "System Events returned EMPTY — Accessibility (TCC) is not granted to the invoking process" };
  return { ok: true, detail: `System Events answered "${name}"` };
}

// ── process plumbing ─────────────────────────────────────────────────────────────────────────

let daemon: ChildProcess | undefined;
let app: ChildProcess | undefined;

/**
 * Kill THIS GATE's office helpers — never every `NormaOfficeHelper` on the machine.
 *
 * The harness leaks helpers and a leaked helper poisons the next run's results, so this must be
 * thorough; but an unscoped `pkill -9 -f NormaOfficeHelper` also SIGKILLs the helper belonging to
 * `/Applications/Norma.app`, the user's daily driver — pulling LibreOffice out from under an office
 * tab they have open. That brushes the repo's "never kill a running Norma.app" hard rule, so the
 * pattern is scoped to the gate's own DerivedData path exactly as `stopApp` already scopes its own.
 */
function killHelpers(): void {
  spawnSync("pkill", ["-9", "-f", `${DERIVED_DATA}.*NormaOfficeHelper`], { encoding: "utf8" });
}

function gateEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // `--break-sheets-set` arms the DELETION-RED probe AND names sheets.set as the expected red.
    // Read this before assuming it works today:
    // the probe is deliberately NOT compiled into the shipped helper, so passing this flag against
    // an unmodified tree changes NOTHING and the gate stays green. Reproducing the red requires
    // re-applying the four-line patch documented in the gate's header ("REPRODUCING THE
    // DELETION-RED"), rebuilding, and then passing this flag. Stated plainly because a flag that
    // silently does nothing while claiming to break a verb would be its own kind of lie.
    ...(process.argv.includes("--break-sheets-set") ? { NORMA_GATE_BREAK_SHEETS_SET: "1" } : {}),
    NORMA_HOME: HOME_DIR,
    NORMA_PROFILE: "dev",
    // Belt and braces: nothing in this gate may ever reach `open -g -b com.norma.app` and launch
    // the user's DISTRIBUTION app, which is indistinguishable from their daily driver in the menu
    // bar. The CLI's autolaunch path is the only door to it and this closes it.
    NORMA_NO_AUTOLAUNCH: "1",
    ...extra,
  };
}

async function startDaemon(): Promise<void> {
  const sock = join(HOME_DIR, "run", "core.sock");
  assertSocketPathFits("daemon", sock);
  const logPath = join(GATE_ROOT, "daemon.log");
  daemon = spawn(process.execPath, [CLI_ENTRY, "daemon", "run"], {
    cwd: join(REPO_ROOT, "packages", "cli"),
    env: gateEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  let daemonLog = "";
  daemon.stdout?.on("data", (d: Buffer) => { daemonLog += d.toString(); });
  daemon.stderr?.on("data", (d: Buffer) => { daemonLog += d.toString(); });

  const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(sock)) { await sleep(1500); writeFileSync(logPath, daemonLog); return; }
    if (daemon.exitCode !== null) {
      writeFileSync(logPath, daemonLog);
      envFail(`the daemon exited ${daemon.exitCode} before opening its socket:\n${daemonLog.slice(-2000)}`);
    }
    await sleep(200);
  }
  writeFileSync(logPath, daemonLog);
  envFail(`the daemon never opened ${sock} within ${DAEMON_BOOT_TIMEOUT_MS}ms:\n${daemonLog.slice(-2000)}`);
}

/** Direct-exec of the app BINARY, never `open`: the binary inherits this env (which is how
 *  `NORMA_HOME` and the gate door reach it — `AppProfile.normaHome` reads raw `getenv` first) and
 *  yields a pid we can actually tear down. */
async function startApp(sessionId: string): Promise<void> {
  const appBinary = join(DERIVED_DATA, "Build", "Products", "Debug", "Norma.app", "Contents", "MacOS", "Norma");
  if (!existsSync(appBinary)) envFail(`the dev app binary is missing: ${appBinary}\n  build it first (the gate does this itself unless --no-build).`);

  // The stale-DerivedData scar, as a check: `xcodegen generate` mints a new DerivedData hash and a
  // stale path silently re-tests an old binary. Prove this one is newer than the sources we care
  // about rather than trusting the path.
  const builtAt = statSync(appBinary).mtime;
  log(`   app binary built ${builtAt.toISOString()}`);

  killHelpers();
  // EXACTLY ONE dev-app instance, or the UI leg measures the wrong process.
  //
  // This cost a wrong conclusion during development: a leftover instance from an earlier launch
  // was still running, the AX reader takes the FIRST process matching the bundle id, and it kept
  // reading that window-less leftover — producing "the window never appears" for three runs while
  // the real instance was rendering the document perfectly. A measurement artifact reported as a
  // product failure is exactly the class this gate exists to prevent, so the invariant is enforced
  // rather than assumed. Only ever `com.norma.app.dev` — the DIST app is never touched.
  spawnSync("pkill", ["-9", "-f", `${DERIVED_DATA}.*MacOS/Norma`], { encoding: "utf8" });
  await sleep(1500);

  const logPath = join(GATE_ROOT, "app.log");
  let appLog = "";
  app = spawn(appBinary, [], {
    env: gateEnv({ NORMA_GATE_SESSION: sessionId }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (d: Buffer) => { appLog += d.toString(); });
  app.stderr?.on("data", (d: Buffer) => { appLog += d.toString(); });

  const deadline = Date.now() + APP_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      writeFileSync(logPath, appLog);
      envFail(
        `the Mac app exited ${app.exitCode} during boot.\n`
        + (app.exitCode === 133
          ? "  Exit 133 is SIGTRAP and is ALMOST ALWAYS the sun_path limit — see the preflight.\n"
          : "")
        + appLog.slice(-2000),
      );
    }
    // What this actually waits for: the app process printing ANYTHING, which is the cheapest proof
    // it got past dyld and started running. It is deliberately NOT an attachment check — attachment
    // is proven later by a real verb (the only honest instrument for it), which `envFail`s on its
    // own. Said plainly because the previous comment here claimed to "poll a cheap verb" and did
    // not, which is the arc's "description contradicting the code" class.
    if (existsSync(join(HOME_DIR, "run", "core.sock"))) {
      await sleep(2000);
      writeFileSync(logPath, appLog);
      if (appLog.length > 0) return;
    }
    await sleep(500);
  }
  writeFileSync(logPath, appLog);
  envFail(`the Mac app never came up within ${APP_BOOT_TIMEOUT_MS}ms:\n${appLog.slice(-2000)}`);
}

function stopApp(): void {
  if (app && app.exitCode === null) { try { app.kill("SIGTERM"); } catch { /* gone */ } }
  spawnSync("pkill", ["-f", `${DERIVED_DATA}.*MacOS/Norma`], { encoding: "utf8" });
  app = undefined;
  killHelpers();
}

/**
 * Stop the daemon and WAIT for the child to be REAPED, then report exactly what happened.
 *
 * Two false readings had to be designed out, both observed live:
 *  - Fire-and-forget `SIGTERM` printed "daemon stopped" while the daemon was still resident;
 *    SIGTERM shutdown is asynchronous.
 *  - Polling `kill(pid, 0)` reports a ZOMBIE as alive. The daemon is our own child, so between its
 *    exit and our reaping it, the pid still exists — which produced a `⚠ LEAKED` line for a process
 *    that `ps` showed as already gone.
 *
 * Awaiting the child handle's own `close` event is the authority: it fires only after the process
 * is reaped, so it cannot see a zombie and cannot self-match anything.
 */
async function stopDaemon(): Promise<string> {
  const child = daemon;
  daemon = undefined;
  if (!child || child.pid === undefined) return "none-started";
  const pid = child.pid;
  if (child.exitCode !== null || child.signalCode !== null) return `pid ${pid} gone`;

  const closed = new Promise<boolean>((resolve) => {
    child.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 10_000);
  });
  try { child.kill("SIGTERM"); } catch { return `pid ${pid} gone`; }
  if (await closed) return `pid ${pid} gone`;

  // Still not reaped after 10s of asking politely.
  const killed = new Promise<boolean>((resolve) => {
    child.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 5_000);
  });
  try { child.kill("SIGKILL"); } catch { return `pid ${pid} gone`; }
  return (await killed) ? `pid ${pid} gone (SIGKILL)` : `pid ${pid} RESIDENT`;
}

// ── driving the REAL agent ───────────────────────────────────────────────────────────────────

interface TurnResult { stdout: string; timedOut: boolean; exitCode: number | null; }

/**
 * One real agent turn, phrased as a user would phrase it.
 *
 * Returns the CLI's stdout ONLY so failures can be diagnosed and so the tool's own `↳` result
 * lines can be quoted in evidence. **Nothing this gate asserts is derived from it** — see the
 * evidence rule in the header. The files and the UI are the evidence.
 */
async function agentTurn(sessionId: string | null, prompt: string): Promise<TurnResult> {
  const args = sessionId === null
    ? [CLI_ENTRY, "-p", prompt, "--auto"]
    : [CLI_ENTRY, "resume", sessionId, prompt, "--auto"];
  const child = spawn(process.execPath, args, { cwd: WORK_DIR, env: gateEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { stdout += d.toString(); });

  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    // Header note 5: `timeout(1)` does not exist on this host, so the bound lives here.
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(null); }, TURN_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
  });
  return { stdout: stripAnsi(stdout), timedOut, exitCode };
}

function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }

/**
 * The daemon's own UNTRUNCATED `tool_result` for the last matching tool call, read from the
 * session's append-only JSONL.
 *
 * **This exists because asserting a cell value from the CLI's stdout is not merely fragile, it is
 * STRUCTURALLY IMPOSSIBLE.** `packages/cli/src/main.ts:659` renders a tool result as
 * `e.output.split("\n")[0]?.slice(0, 120)` — the FIRST LINE, capped at 120 characters. A
 * multi-row `sheets read` therefore prints only its header (`↳ Sheet1!A1:B4 (values):`) and the
 * grid never reaches stdout at all. An earlier version of this step scraped stdout for the expected
 * value and "passed": the string it matched came from the MODEL'S markdown table, in a session that
 * had the same string in context from the `sheets.set` prompt ninety events earlier. The step
 * advertised as the independent fresh-open leg was satisfied by prose — the exact thing this whole
 * gate exists to make impossible, inside the gate.
 *
 * The session JSONL is the authoritative record (`packages/protocol/src/events.ts`:
 * `ToolResultEvent { callId, output, isError }`, `output` unbounded), so this sidesteps the CLI
 * layer entirely. Pairing is by `callId`, never by adjacency.
 */
function lastToolResultFromJournal(
  sessionId: string, toolName: string, argsSubstring: string,
): { output: string; isError: boolean } | null {
  const journal = join(HOME_DIR, "sessions", "global", `${sessionId}.jsonl`);
  if (!existsSync(journal)) return null;
  const wanted = new Set<string>();
  let latest: { output: string; isError: boolean } | null = null;
  for (const line of readFileSync(journal, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { type?: string; name?: string; argsJson?: string; callId?: string; output?: string; isError?: boolean };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "tool_call" && ev.name === toolName && (ev.argsJson ?? "").includes(argsSubstring) && ev.callId) {
      wanted.add(ev.callId);
    } else if (ev.type === "tool_result" && ev.callId && wanted.has(ev.callId)) {
      latest = { output: ev.output ?? "", isError: ev.isError === true };
    }
  }
  return latest;
}

// ── file-byte evidence ───────────────────────────────────────────────────────────────────────

/**
 * Read one entry out of an OOXML/ODF container as text. Both are zip archives, so this is the
 * "unzip + XML" leg for every family — the strongest proof available, because it is completely
 * independent of the daemon, the app, the helper and LibreOffice. If LibreOffice wrote it, this
 * sees it; if nothing wrote it, this sees that too.
 */
function zipEntry(file: string, entry: string): string {
  const r = spawnSync("unzip", ["-p", file, entry], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return "";
  return (r.stdout as Buffer).toString("utf8");
}

/** The #1 defect class in this arc, four occurrences, as a reusable guard: an assertion that would
 *  also hold against the untouched fixture proves nothing. Compared on raw bytes. */
function differsFromPristine(name: string): boolean {
  const live = join(WORK_DIR, name);
  const pristine = join(PRISTINE_DIR, name);
  if (!existsSync(live) || !existsSync(pristine)) return false;
  return !readFileSync(live).equals(readFileSync(pristine));
}

/**
 * Resolve ONE named cell of a worksheet to its value, following the shared-string table when the
 * cell is `t="s"`.
 *
 * Deliberately cell-addressed rather than "does this string appear anywhere in the file". The
 * loose version is a genuinely weaker assertion — it passes when the right value lands in the
 * WRONG cell, which is exactly the bystander-clobber failure mode this arc spent a whole round
 * closing — and it also produced a false red on this gate's first run: stripping tags glued
 * `<v>2</v><v>1234</v>` into "21234", so a digit-boundary match for 1234 failed while the file was
 * perfectly correct. Right conclusion, wrong supporting fact; the fix is to read the cell.
 */
function xlsxCell(file: string, sheetEntry: string, ref: string): string | null {
  const sheet = zipEntry(file, sheetEntry);
  const m = sheet.match(new RegExp(`<c r="${ref}"([^>]*)>([\\s\\S]*?)</c>`));
  if (!m) return null;
  const attrs = m[1];
  const inner = m[2];
  const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (v === undefined) {
    // An inline-string cell keeps its text in <is><t>…</t></is> rather than <v>.
    return inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? null;
  }
  // NOT /\bt="s"\b/ — the trailing \b can never match, because the character before it is a
  // quote and the character after is also non-word, so there is no word boundary there. That bug
  // made this reader return the raw shared-string INDEX ("2") instead of the string it points at.
  if (/\st="s"/.test(attrs)) {
    const shared = zipEntry(file, "xl/sharedStrings.xml");
    const items = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
      [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
    return items[Number(v)] ?? null;
  }
  return v;
}

/**
 * Resolve one cell's FONT ATTRIBUTES by walking the real style chain:
 * `<c r=… s="n">` -> `cellXfs[n]` -> `fontId` -> that `<font>`.
 *
 * Returned as a delta-able record so a step can assert what CHANGED rather than what is true —
 * which is the difference between a real check and this arc's #1 defect. `sheets.format` originally
 * asserted "A1 is bold" and passed against the UNTOUCHED fixture, because A1 (`s="1"` -> `xf#1` ->
 * `fontId="4"` -> `<font><b val="true"/>…`) SHIPS BOLD. A total no-op stayed green.
 */
function xlsxCellFont(file: string, sheetEntry: string, ref: string): { found: boolean; bold: boolean; italic: boolean; xml: string } {
  const miss = { found: false, bold: false, italic: false, xml: "" };
  const sheet = zipEntry(file, sheetEntry);
  const cell = sheet.match(new RegExp(`<c r="${ref}"([^>]*)>`));
  if (!cell) return miss;
  // A cell with no `s=` uses cellXf 0, exactly as the format does.
  const xfIndex = Number(cell[1].match(/\ss="(\d+)"/)?.[1] ?? "0");
  const styles = zipEntry(file, "xl/styles.xml");
  const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const xf = [...cellXfs.matchAll(/<xf\b[^>]*>/g)].map((x) => x[0])[xfIndex];
  if (!xf) return miss;
  const fontId = Number(xf.match(/fontId="(\d+)"/)?.[1] ?? "-1");
  const fontsBlock = styles.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)?.[1] ?? "";
  // Self-closing form FIRST in the alternation. With the paired form first, a `<font/>` gets
  // swallowed by `<font\b[\s\S]*?</font>` reaching forward to the NEXT font's closing tag, which
  // silently shifts every subsequent index by one — so a cell would be checked against the wrong
  // font. Zero self-closing fonts exist in today's fixtures, so this is latent, not live.
  const font = [...fontsBlock.matchAll(/<font\b[^>]*\/>|<font\b[\s\S]*?<\/font>/g)].map((x) => x[0])[fontId] ?? "";
  if (!font) return miss;
  // `<b/>` and `<b val="true"/>` both mean bold; `<b val="false"/>` explicitly does not.
  const on = (tag: string) => {
    const m = font.match(new RegExp(`<${tag}\\b([^>]*)>`));
    if (!m) return false;
    return !/val="false"/.test(m[1]);
  };
  return { found: true, bold: on("b"), italic: on("i"), xml: font };
}

function odpAllText(file: string): string { return zipEntry(file, "content.xml"); }
function docxAllText(file: string): string { return zipEntry(file, "word/document.xml"); }

/** Strip XML tags so an assertion is about CONTENT, not markup shape — LibreOffice legitimately
 *  re-splits a paragraph across runs on save, which would break a naive substring test on the raw
 *  XML while the visible text is exactly right. */
function xmlText(xml: string): string {
  return xml.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// ── UI evidence (JXA, because AppleScript's `entire contents` lies here) ─────────────────────

interface AxElement { d: number; role: string; name: string; }

const AX_READER = String.raw`
function run(argv) {
  const se = Application("System Events");
  const procs = se.applicationProcesses.whose({ bundleIdentifier: argv[0] })();
  if (procs.length === 0) return JSON.stringify({ ok: false, procCount: 0, reason: "no running process with bundle id " + argv[0] });
  // procs[0] is only meaningful when there is exactly ONE. See the gate's assertSingleAppInstance.
  const p = procs[0];
  const out = [];
  function walk(el, depth) {
    if (depth > 18) return;
    let role = null, name = null;
    try { role = el.role(); } catch (e) { return; }
    try { name = el.name(); } catch (e) { name = null; }
    if (name !== null && name !== undefined && String(name) !== "") out.push({ d: depth, role: String(role), name: String(name) });
    let kids = [];
    try { kids = el.uiElements(); } catch (e) { return; }
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
  }
  const wins = [];
  const ws = p.windows();
  for (let i = 0; i < ws.length; i++) { try { wins.push(String(ws[i].name())); } catch (e) { wins.push(""); } walk(ws[i], 0); }
  return JSON.stringify({ ok: true, procCount: procs.length, windows: wins, elements: out });
}
`;

function readAx(): { ok: boolean; reason?: string; procCount?: number; windows: string[]; elements: AxElement[] } {
  const scriptPath = join(GATE_ROOT, "ax-reader.js");
  writeFileSync(scriptPath, AX_READER);
  const r = spawnSync("osascript", ["-l", "JavaScript", scriptPath, APP_BUNDLE_ID], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0 || !r.stdout.trim()) {
    return { ok: false, reason: `osascript exited ${r.status}: ${(r.stderr || "").trim() || "(no output)"}`, windows: [], elements: [] };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    return { windows: [], elements: [], ...parsed };
  } catch (e) {
    return { ok: false, reason: `unparsable JXA output: ${r.stdout.slice(0, 400)}`, windows: [], elements: [] };
  }
}

/** Poll, because the shell mounts asynchronously and a single read races it. A bound that expires
 *  is reported as UI-SKIP naming what it waited for — never silently treated as absent. */
async function waitForAx(predicate: (els: AxElement[]) => boolean, budgetMs: number): Promise<{ hit: boolean; last: AxElement[]; reason?: string; windows?: string[] }> {
  const deadline = Date.now() + budgetMs;
  let last: AxElement[] = [];
  let reason: string | undefined;
  let windows: string[] = [];
  let polls = 0;
  while (Date.now() < deadline) {
    const snap = readAx();
    polls += 1;
    if (!snap.ok) { reason = snap.reason; } else {
      last = snap.elements; windows = snap.windows;
      if (predicate(last)) return { hit: true, last, windows };
    }
    // The window's own titles are the cheapest signal for WHY a UI fact is missing: an app with no
    // window at all is a different failure from an app whose window is up but unnamed inside.
    if (polls % 4 === 0) log(`      (ax poll ${polls}: windows=${JSON.stringify(windows)}, named=${last.length})`);
    await sleep(2500);
  }
  return { hit: false, last, reason, windows };
}

/**
 * THE UI LEG, asserted at the ONE moment it is reliably observable.
 *
 * Called immediately after the app comes up with the document tab already present — NOT at the end
 * of the run. That placement is measured, not stylistic: the shell window renders the document
 * correctly and stays readable for roughly 35-45 seconds, then degrades and disappears while the
 * app stays alive and LibreOffice keeps servicing the document. Asserting late produced two missing
 * UI observations on a run whose every byte was correct.
 *
 * The vanishing window is a REAL, pre-existing defect and is reported as such (see the gate's
 * summary) rather than hidden by this placement — but a gate must read a fact while the fact is
 * there, and a verb must never be condemned by a window that closed itself 80 seconds later.
 */
async function assertUiFacts(): Promise<void> {
  const tabWait = await waitForAx((els) => els.some((e) => e.name.includes("budget.xlsx")), 45_000);
  const snapProcs = readAx().procCount;
  if (snapProcs !== undefined && snapProcs !== 1) {
    record("ui.singleInstance", false, "UI-SKIP",
      `${snapProcs} processes share the dev bundle id — the AX reader cannot know which one it read. `
      + "Every UI verdict below would be untrustworthy.");
  } else {
    record("ui.singleInstance", true, "UI-SKIP", "exactly one dev-app process — the AX reader is looking at the right one");
  }
  record(
    "ui.documentTab", tabWait.hit, "UI-SKIP",
    tabWait.hit
      ? `an AX element names the open document: "${tabWait.last.find((e) => e.name.includes("budget.xlsx"))?.name}"`
      : `no AX element naming budget.xlsx within 45s${tabWait.reason ? ` (${tabWait.reason})` : ""}; windows=${JSON.stringify(tabWait.windows)}, ${tabWait.last.length} named elements`,
  );
  // The formula bar renders the REAL cell content of the REAL file — the strongest UI fact this app
  // offers, because it is the document's own content rather than a static label.
  const barWait = await waitForAx((els) => els.some((e) => /^[A-Z]+\d+:/.test(e.name)), 30_000);
  const bar = barWait.last.find((e) => /^[A-Z]+\d+:/.test(e.name))?.name ?? "";
  const pristineA1 = xlsxCell(join(PRISTINE_DIR, "budget.xlsx"), "xl/worksheets/sheet1.xml", "A1") ?? "";
  // Non-vacuous: the bar must name a cell AND carry that cell's real content, computed from the
  // fixture's own bytes rather than typed in from memory.
  const carriesContent = barWait.hit && pristineA1.length > 0 && bar.includes(pristineA1);
  record(
    "ui.formulaBar", carriesContent, "UI-SKIP",
    carriesContent
      ? `the formula bar shows the document's own live content: "${bar}" (contains cell A1's real value ${JSON.stringify(pristineA1)})`
      : `formula bar ${barWait.hit ? `read "${bar}" but it does not carry A1's real value ${JSON.stringify(pristineA1)}` : "not found in the AX tree"}`,
  );
}

// ── the verb steps ───────────────────────────────────────────────────────────────────────────

/**
 * One entry per verb family exercise. `prompt` is phrased the way a user would phrase it — the
 * gate is testing whether the AGENT picks the right verb from that vocabulary, not whether a
 * hand-built tool call works.
 *
 * `assert` runs AFTER the app has been fully restarted (see the phase order in `main`), so every
 * read-back is a genuine fresh open of the saved file.
 */
interface VerbStep {
  id: string;
  file: string;
  prompt: string;
  /** Returns [ok, detail]. Must consult the file's bytes, never the turn's stdout. */
  assert: () => [boolean, string];
  /** Set when a step deliberately characterizes a DISCLOSED limitation rather than an ideal. */
  characterization?: boolean;
}

/** Filled in `main` once the seeded copies exist, so every expected value is computed from the
 *  real bytes at runtime rather than from a constant someone typed from memory. */
let VERB_STEPS: VerbStep[] = [];

function buildVerbSteps(): VerbStep[] {
  const xlsx = join(WORK_DIR, "budget.xlsx");
  const odp = join(WORK_DIR, "deck.odp");
  const docx = join(WORK_DIR, "notes.docx");

  return [
    // ── sheets ───────────────────────────────────────────────────────────────────────────────
    {
      id: "sheets.set",
      file: "budget.xlsx",
      prompt: 'In budget.xlsx, put the text "QUARTERLY REVIEW" in cell A4 of Sheet1, and put the number 1234 in cell B4.',
      assert() {
        if (!differsFromPristine("budget.xlsx")) return [false, "the file is byte-identical to the pristine fixture — nothing was written"];
        // Cell-addressed on purpose: the right value in the WRONG cell must not pass.
        const a4 = xlsxCell(xlsx, "xl/worksheets/sheet1.xml", "A4");
        const b4 = xlsxCell(xlsx, "xl/worksheets/sheet1.xml", "B4");
        const ok = a4 === "QUARTERLY REVIEW" && b4 === "1234";
        return [ok, `saved bytes: A4=${JSON.stringify(a4)} (want "QUARTERLY REVIEW"), B4=${JSON.stringify(b4)} (want "1234")`];
      },
    },
    {
      id: "sheets.add_sheet",
      file: "budget.xlsx",
      prompt: 'Add a new sheet called "Forecast" to budget.xlsx.',
      assert() {
        const wb = zipEntry(xlsx, "xl/workbook.xml");
        const names = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]);
        const ok = names.includes("Forecast");
        // Non-vacuous by construction: the pristine fixture has exactly one sheet, "Sheet1".
        return [ok, `workbook sheets = [${names.join(", ")}]; expected "Forecast" among them`];
      },
    },
    {
      id: "sheets.format",
      file: "budget.xlsx",
      // Targets A2, NOT A1, and asks for italic as well as bold — both deliberate.
      // Pristine A1 SHIPS BOLD (s="1" -> xf#1 -> fontId=4 -> <b val="true"/>), so the original
      // "make A1 bold" step passed against the untouched fixture: a total no-op stayed green, the
      // arc's #1 defect class at its fifth occurrence. Pristine A2 carries font#0
      // (<font><sz val="10"/><name val="Arial"/></font>) — neither bold nor italic — and NO font in
      // the fixture is italic at all, so this cannot pass without a real change.
      prompt: "Make cell A2 of Sheet1 in budget.xlsx bold and italic.",
      assert() {
        const before = xlsxCellFont(join(PRISTINE_DIR, "budget.xlsx"), "xl/worksheets/sheet1.xml", "A2");
        const after = xlsxCellFont(xlsx, "xl/worksheets/sheet1.xml", "A2");
        if (!after.found) return [false, "cell A2 has no resolvable font in the saved workbook"];
        // Asserted as a DELTA against the pristine file read at runtime, never as a fixed truth:
        // the step fails if the fixture ever ships already-bold/italic, instead of silently
        // becoming vacuous the way its predecessor did.
        // `before.found` FIRST: xlsxCellFont returns {bold:false, italic:false} on ANY read failure,
        // so an unreadable pristine cell would otherwise look like an unstyled one and the vacuity
        // guard below would pass on a fiction.
        if (!before.found) {
          return [false, "cell A2's font could not be resolved in the PRISTINE fixture — the vacuity "
            + "guard cannot run, so this step's result would be meaningless"];
        }
        if (before.bold || before.italic) {
          return [false, `the pristine fixture already has A2 bold=${before.bold} italic=${before.italic} — `
            + "this step would be VACUOUS; retarget it at a cell the fixture does not already style"];
        }
        const ok = after.bold && after.italic;
        return [ok, `A2 font bold/italic: pristine=${before.bold}/${before.italic} -> saved=${after.bold}/${after.italic}`
          + ` (want true/true; saved font xml: ${after.xml.slice(0, 90)})`];
      },
    },

    // ── slides ───────────────────────────────────────────────────────────────────────────────
    {
      id: "slides.set_text",
      file: "deck.odp",
      prompt: 'In deck.odp, change the title of slide 2 to "Gate Verified Title".',
      assert() {
        if (!differsFromPristine("deck.odp")) return [false, "the file is byte-identical to the pristine fixture — nothing was written"];
        const text = xmlText(odpAllText(odp));
        const ok = text.includes("Gate Verified Title");
        // Non-vacuous both ways: the pristine deck's slide-2 title is "Norma T6 Slide Two", so the
        // NEW string cannot pre-exist and the OLD one must be gone from that slide.
        const oldGone = !text.includes("Norma T6 Slide Two");
        return [ok && oldGone, `saved odp ${ok ? "contains" : "MISSING"} "Gate Verified Title"; old title "Norma T6 Slide Two" ${oldGone ? "removed" : "STILL PRESENT"}`];
      },
    },
    {
      id: "slides.add_slide",
      file: "deck.odp",
      prompt: "Add one more slide to the end of deck.odp.",
      assert() {
        // `<draw:page[\s>]`, NOT `<draw:page\b` — `\b` matches before the hyphen of
        // `<draw:page-thumbnail>`, an element LibreOffice writes once per slide on save but which
        // the hand-built pristine fixture has none of. The loose pattern therefore counted 4 real
        // slides as 8 and produced a false red on this gate's first run while the file was exactly
        // right. Verified against the saved bytes: 4 `<draw:page`, 4 `<draw:page-thumbnail`.
        const countPages = (xml: string) => (xml.match(/<draw:page[\s>]/g) ?? []).length;
        const count = countPages(odpAllText(odp));
        const pristineCount = countPages(odpAllText(join(PRISTINE_DIR, "deck.odp")));
        // Counted from BOTH files at runtime — never a literal, and asserted as a DELTA.
        return [count === pristineCount + 1, `slide count ${pristineCount} (pristine) -> ${count} (saved); expected ${pristineCount + 1}`];
      },
    },

    // ── docs ─────────────────────────────────────────────────────────────────────────────────
    {
      id: "docs.replace",
      file: "notes.docx",
      prompt: 'In notes.docx, replace every occurrence of "NORMA GATE" with "NORMA GATE PASSED".',
      assert() {
        if (!differsFromPristine("notes.docx")) return [false, "the file is byte-identical to the pristine fixture — nothing was written"];
        const text = xmlText(docxAllText(docx));
        const ok = text.includes("NORMA GATE PASSED");
        return [ok, `saved docx text ${ok ? "contains" : "MISSING"} "NORMA GATE PASSED" (text: ${text.slice(0, 160)})`];
      },
    },
    {
      id: "docs.append",
      file: "notes.docx",
      prompt: 'Add a new paragraph at the end of notes.docx that says "Appended by the gate".',
      assert() {
        const text = xmlText(docxAllText(docx));
        const ok = text.includes("Appended by the gate");
        return [ok, `saved docx text ${ok ? "contains" : "MISSING"} "Appended by the gate"`];
      },
    },
  ];
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

function seedFixtures(): void {
  // Wipe the STATE dirs only — never DERIVED_DATA, so `--no-build` can reuse a build and a normal
  // run still gets a completely fresh home, workdir and pristine set.
  for (const d of [HOME_DIR, WORK_DIR, PRISTINE_DIR]) rmSync(d, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(PRISTINE_DIR, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });

  const seeds: Array<[string, string]> = [
    ["gate.xlsx", "budget.xlsx"],
    ["three-slide.odp", "deck.odp"],
    ["gate.docx", "notes.docx"],
  ];
  for (const [src, dst] of seeds) {
    const from = join(FIXTURE_DIR, src);
    if (!existsSync(from)) envFail(`committed fixture missing: ${from}`);
    // COPIES, twice: one the agent edits, one kept pristine for the differs-from-pristine guard.
    copyFileSync(from, join(WORK_DIR, dst));
    copyFileSync(from, join(PRISTINE_DIR, dst));
    log(`   seeded ${dst} <- ${src} (${statSync(from).size} bytes)`);
  }

  writeFileSync(join(HOME_DIR, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    // Secrets are keyed by PROFILE, not by NORMA_HOME — which is the whole reason a temp home can
    // authenticate at all without ever touching ~/.norma or ~/.norma-dev.
    provider: { type: "codex-oauth", model: "gpt-5.6-terra" },
  }, null, 2) + "\n");
}

function buildApp(): void {
  const gen = spawnSync("xcodegen", ["generate"], { cwd: APP_PROJECT_DIR, encoding: "utf8", timeout: 300_000, maxBuffer: BUILD_MAX_BUFFER });
  if (gen.status !== 0) envFail(`xcodegen generate failed:\n${gen.stdout}\n${gen.stderr}`);
  log("   xcodegen generate: ok");

  const build = spawnSync("xcodebuild", [
    "-project", "Norma.xcodeproj", "-scheme", "Norma", "-configuration", "Debug",
    // Pinned to arm64: a bare `platform=macOS` resolves to TWO destinations on this host and
    // xcodebuild warns "Using the first of multiple matching destinations". The repo is arm64-only
    // (the vendored LibreOffice/CEF libraries have no x86_64 slice), so naming it removes an
    // ambiguity rather than making a choice.
    "-destination", "platform=macOS,arch=arm64",
    // ALWAYS explicit: xcodegen mints a new DerivedData hash each run and a stale path silently
    // re-tests a days-old binary. That is in this repo's scar tissue.
    "-derivedDataPath", DERIVED_DATA, "build",
  ], {
    cwd: APP_PROJECT_DIR, encoding: "utf8", timeout: 1_800_000,
    // ⛔ THE FIELD WITHOUT WHICH THIS COMMAND CANNOT SUCCEED. Bun's `spawnSync` defaults to a
    // 2,621,440-byte maxBuffer and a clean Debug build of this app emits ~4 MB on stdout. When the
    // buffer fills, `spawnSync` SIGTERMs the child — so the gate KILLED ITS OWN BUILD, reported
    // `** BUILD INTERRUPTED **`, and blamed the app. `bun run verify:office-agent` had therefore
    // never once completed; every green run in the task report came from `--no-build` over a
    // by-hand build.
    maxBuffer: BUILD_MAX_BUFFER,
  });

  const stdout = build.stdout || "";
  const stderr = build.stderr || "";
  if (build.status !== 0 || build.error) {
    // `build.error` is the ONLY field that says ENOBUFS. Reading `status` alone told the operator
    // the app build failed when the truth was that the gate killed it — this arc's "a guard that
    // turns a loud crash into a silent wrong answer" class, in the gate's own plumbing.
    const harnessError = build.error ? `harness error: ${(build.error as Error).message}` : "";
    const signal = build.signal ? `killed by ${build.signal}` : "";
    // BUILD INTERRUPTED / BUILD FAILED are first-class markers: an interrupted build contains no
    // line matching `error:` at all, so filtering only for that printed nothing useful.
    const markers = stdout.split("\n").filter((l) =>
      l.includes("error:") || l.includes("** BUILD INTERRUPTED **") || l.includes("** BUILD FAILED **"))
      .slice(-15).join("\n");
    envFail(
      "xcodebuild (Debug) did not produce a build.\n"
      + [harnessError, signal].filter(Boolean).map((x) => `  ${x}\n`).join("")
      + (harnessError.includes("ENOBUFS")
        ? "  ENOBUFS means THE GATE killed the build, not the project — raise BUILD_MAX_BUFFER.\n"
        : "")
      + (markers || stderr.slice(-2000)),
    );
  }
  if (!stdout.includes("** BUILD SUCCEEDED **")) {
    envFail(`xcodebuild exited 0 but never printed "** BUILD SUCCEEDED **" — treat this as a failed build.\n${stdout.slice(-1500)}`);
  }
  log("   xcodebuild Debug: BUILD SUCCEEDED");
}

/** `panel.openTab` mints a tab DAEMON-SIDE that is indistinguishable from a user-opened one
 *  (`PanelOpenTabParams`' own doc). That is what puts the agent's later writes on the realistic
 *  ADOPTION path — the same path a human with the file open would produce — and it is what makes
 *  the document tab and its part strip render for the UI leg. */
async function openDocumentTab(sessionId: string, absPath: string): Promise<boolean> {
  const helper = join(GATE_ROOT, "open-tab.ts");
  writeFileSync(helper, `
import { KeychainSecretStore, TOKEN_NAMES } from ${JSON.stringify(join(REPO_ROOT, "packages/core/src/index"))};
import { NormaClient } from ${JSON.stringify(join(REPO_ROOT, "packages/cli/src/client"))};
const token = await new KeychainSecretStore().get(TOKEN_NAMES.harness);
if (!token) { console.error("NO_TOKEN"); process.exit(1); }
const c = await NormaClient.connect({ socketPath: process.env.NORMA_HOME + "/run/core.sock", token,
  clientName: "cli-office-gate", onEvent: () => {} });
const r = await c.request("panel.openTab", { sessionId: ${JSON.stringify(sessionId)},
  kind: "document", url: ${JSON.stringify(absPath)}, title: ${JSON.stringify(basename(absPath))} });
console.log(JSON.stringify(r));
process.exit(0);
`);
  const r = spawnSync(process.execPath, [helper], { cwd: REPO_ROOT, env: gateEnv(), encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) { log(`   panel.openTab failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`); return false; }
  log(`   panel.openTab -> ${r.stdout.trim()}`);
  return true;
}

function newestCodeSessionId(): string | undefined {
  const dir = join(HOME_DIR, "sessions", "global");
  if (!existsSync(dir)) return undefined;
  const files = spawnSync("ls", ["-t", dir], { encoding: "utf8" }).stdout.split("\n").filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const first = readFileSync(join(dir, f), "utf8").split("\n")[0];
    try {
      const ev = JSON.parse(first);
      // Header note 3: the app mints its own `mode: "chat"` session at launch and office tools are
      // never available in chat. Pick by MODE, never by "newest on disk".
      if (ev.type === "session_created" && ev.mode !== "chat") return ev.sessionId as string;
    } catch { /* skip */ }
  }
  return undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const noBuild = argv.includes("--no-build");
  // ONE flag, not two. `--break-sheets-set` both arms the probe (via gateEnv) and names the step
  // expected to go red. Previously these were separate (`--break-sheets-set` + `--break=<id>`) and
  // passing only the latter produced a green run plus the line "STILL PASSING (the gate is BLIND to
  // this break)" — which reads as a damning finding when in fact nothing had been broken.
  const breakVerb = argv.includes("--break-sheets-set") ? "sheets.set" : undefined;

  log("═══ Office Stage C — the headless agent gate ═══");
  log(`repo root : ${REPO_ROOT}`);
  log(`gate root : ${GATE_ROOT}`);
  if (breakVerb) log(`\n⚠ DELETION-RED MODE: the gate will assert as normal, but "${breakVerb}" is expected to FAIL.`);

  // ── Phase 0: preflight ─────────────────────────────────────────────────────────────────────
  step("Phase 0 — preflight");
  if (process.platform !== "darwin") envFail("this gate is macOS-only (it drives the real Mac app).");
  assertSocketPathFits("daemon", join(HOME_DIR, "run", "core.sock"));
  const ax = axTrustProbe();
  if (!ax.ok) {
    envFail(
      `Accessibility (TCC) is not usable from this process: ${ax.detail}\n`
      + "  The UI leg reads the app through System Events, and AX degrades to EMPTY DATA rather\n"
      + "  than erroring — so without this check a missing grant would read as 'the tab is absent'\n"
      + "  and blame the product for an environment problem.",
    );
  }
  log(`   AX trust: ${ax.detail}`);
  killHelpers();
  log("   pre-run pkill -9 -f NormaOfficeHelper: done");

  // ── Phase 1: seed ──────────────────────────────────────────────────────────────────────────
  step("Phase 1 — temp NORMA_HOME + fixture COPIES");
  seedFixtures();
  VERB_STEPS = buildVerbSteps();

  // ── Phase 2: build ─────────────────────────────────────────────────────────────────────────
  step("Phase 2 — build the DEV app (Debug, explicit -derivedDataPath)");
  if (noBuild && existsSync(join(DERIVED_DATA, "Build/Products/Debug/Norma.app"))) log("   --no-build: reusing the existing build");
  else buildApp();

  // ── Phase 3: daemon + code session ─────────────────────────────────────────────────────────
  step("Phase 3 — daemon on the temp home, then a CODE session");
  await startDaemon();
  log("   daemon listening");
  const first = await agentTurn(null, "Say READY and nothing else.");
  if (first.timedOut) envFail("the first agent turn timed out — provider credentials may be unusable for the dev profile.");
  const sessionId = newestCodeSessionId();
  if (!sessionId) envFail(`no code-mode session was created. CLI said:\n${first.stdout.slice(-1500)}`);
  log(`   code session: ${sessionId}`);

  // ── Phase 4: app through the door + a real document tab ────────────────────────────────────
  // ORDER IS LOAD-BEARING: the tab is created BEFORE the app launches.
  //
  // `panel.openTab` mints tab state DAEMON-side, so it does not need the app running — and giving
  // the app a tab to show before its panel ever opens is what keeps the window alive. Measured: a
  // panel that mounts with ZERO tabs tears the whole window down a few seconds later (the CEF
  // `DoClose` -> `performClose:` on the parent window class that `NORMA_PANEL_SMOKE`'s own comment
  // documents). With the tab already present the panel mounts onto real content instead.
  step("Phase 4 — open the document tab, THEN launch the DEV app through NORMA_GATE_SESSION");
  await openDocumentTab(sessionId, join(WORK_DIR, "budget.xlsx"));
  await startApp(sessionId);
  log("   app running");

  // ── The UI leg runs FIRST, before any agent turn. ───────────────────────────────────────────
  // Ordering is measured, not arbitrary. The window is readable for roughly 35-45s and a single
  // agent turn costs 20-40s, so asserting after the attach proof lands PAST the observable window
  // and loses both UI observations on a run whose every byte is correct — exactly what happened
  // before this move. The document tab was opened before the app launched, so these facts are
  // available the moment the shell renders; nothing is gained by waiting.
  step("Phase 4b — LIVE UI OBSERVATIONS through accessibility scripting (reported, NOT counted — see UI_SKIP_REASON)");
  await assertUiFacts();

  // The attach proof, using the only honest instrument there is: a real verb.
  const reach = await agentTurn(sessionId, "Use the sheets tool's info verb on budget.xlsx.");
  const attached = !reach.stdout.includes("office tools unavailable");
  if (!attached) {
    envFail(
      "the app never attached to the gate's session — every office verb would refuse.\n"
      + `  CLI said: ${reach.stdout.slice(-800)}`,
    );
  }
  log("   attach proof: office verbs are reachable");

  // ── Phase 5: drive every verb ──────────────────────────────────────────────────────────────
  step("Phase 5 — drive the REAL agent, one turn per verb family");
  const turnLog: Record<string, string> = {};
  for (const s of VERB_STEPS) {
    const t = await agentTurn(sessionId, s.prompt);
    turnLog[s.id] = t.stdout.slice(-1200);
    log(`   ${s.id.padEnd(18)} ${t.timedOut ? "TIMED OUT" : `exit=${t.exitCode}`}  «${s.prompt.slice(0, 62)}…»`);
    if (t.timedOut) log(`      (a timeout is NOT a pass and NOT a proof of failure — the byte check below decides)`);
  }

  // ── Phase 6: FULL RESTART, then read the bytes ─────────────────────────────────────────────
  // This restart is the point. An in-session read can be served by the document still open in the
  // helper's memory, which proves nothing about what was SAVED — a masking pattern this arc has
  // already shipped once.
  step("Phase 6 — quit the app, kill every helper, relaunch: the read-back must be a FRESH open");
  stopApp();
  await sleep(4000);
  killHelpers();
  // Same ordering rule as Phase 4 — the tab exists before the panel can mount empty.
  await openDocumentTab(sessionId, join(WORK_DIR, "budget.xlsx"));
  await startApp(sessionId);
  await sleep(3000);

  step("Phase 7 — FILE EVIDENCE (unzip + XML on the saved bytes)");
  for (const s of VERB_STEPS) {
    const [ok, detail] = s.assert();
    record(s.id, ok, "FILE-FAIL", detail);
  }

  // A helper re-open, corroborating the raw-bytes leg through the real stack.
  step("Phase 8 — helper re-open read-back (the same bytes, through LibreOffice)");
  const readBack = await agentTurn(sessionId, "Read cells A1:B4 of Sheet1 in budget.xlsx and show me the values.");
  turnLog["sheets.read (fresh open through the helper)"] = readBack.stdout.slice(-1200);

  // THE DAEMON'S OWN UNTRUNCATED tool_result, from the session JSONL — never the CLI's stdout,
  // which truncates every tool result to one 120-char line and therefore cannot carry a grid.
  const readEvent = lastToolResultFromJournal(sessionId, "sheets", '"verb":"read"');
  // Expected value read from the FILE at runtime, so the assertion cannot be satisfied by a string
  // the model saw in an earlier prompt.
  const expectedA4 = xlsxCell(join(WORK_DIR, "budget.xlsx"), "xl/worksheets/sheet1.xml", "A4");
  let ok = false;
  let detail: string;
  if (expectedA4 === null || expectedA4 === "") {
    // Guard, NOT evidence. A previous round's deletion-red went red HERE rather than on the tool
    // result, and was mistakenly recorded as proof that the read leg discriminates. Reported as its
    // own distinct outcome so it can never again be mistaken for the assertion under test.
    detail = "INCONCLUSIVE — cell A4 is empty/unreadable in the saved workbook, so there is no value "
      + "to look for. This is the guard firing, NOT the tool-result assertion; sheets.set's own "
      + "verdict is the one to read.";
  } else if (!readEvent) {
    detail = `the sheets read verb never dispatched — no tool_call/tool_result pair for "verb":"read" in the session journal`;
  } else if (readEvent.isError) {
    detail = `the read verb returned an ERROR: ${readEvent.output.slice(0, 300)}`;
  } else {
    ok = readEvent.output.includes(expectedA4);
    detail = ok
      ? `the freshly-reopened document's own untruncated tool_result carries A4's saved value ${JSON.stringify(expectedA4)}`
      : `the tool_result did NOT contain A4's saved value ${JSON.stringify(expectedA4)}. Full tool_result:\n${readEvent.output.slice(0, 600)}`;
  }
  record("sheets.read (fresh open through the helper)", ok, "FILE-FAIL", detail);

  step("Phase 10 — CHARACTERIZATIONS of disclosed limitations (these describe reality, not an ideal)");
  log("   docs/undo    : a human's ⌘Z CANNOT take back a `docs` edit and silently does nothing");
  log("                  (spec §docs ruling 4 as amended; sw::UndoManager::GetLastUndoInfo refuses");
  log("                  cross-view undo outside repair mode). The gate does not assert an undo");
  log("                  that the product does not offer.");
  log("   slides       : the structural verbs dispatch on the PRIMARY view, not an isolated agent");
  log("                  view — so add/delete/reorder can move the part a human is looking at.");
  log("   sheets       : `.uno:GoToCell` has a rare async straggler; a read can, rarely, move the");
  log("                  user's cell cursor.");
  log("   docs/replace : ruling 1's engine cross-check is WIRED BUT UNREACHABLE");
  log("                  (UNO_COMMAND_RESULT never arrives — setView's MoveShellToFirstShell puts");
  log("                  the callback-less agent view at the head of the list). The shipped");
  log("                  substitute is a full expected-text re-read, which is strictly stronger.");

  // ── Verdict ────────────────────────────────────────────────────────────────────────────────
  step("VERDICT");
  const fileVerdicts = verdicts.filter((v) => v.kind === "FILE-FAIL");
  const fileFails = fileVerdicts.filter((v) => !v.ok);
  // The denominator is PINNED. A run that reports fewer verdicts than expected has silently stopped
  // testing something, and a shrinking 7/7 would otherwise read as green.
  const countMismatch = fileVerdicts.length !== EXPECTED_FILE_VERDICTS;
  // UI verdicts are reported OUTSIDE the pass/fail tally — see UI_SKIP_REASON.
  const uiVerdicts = verdicts.filter((v) => v.kind === "UI-SKIP");
  const uiFails = uiVerdicts.filter((v) => !v.ok);
  log("");
  log("  ── file evidence (the gate's verdict) ──");
  for (const v of fileVerdicts) log(`  ${v.ok ? "PASS      " : "FILE-FAIL "} ${v.name}`);
  log("");
  log("  ── UI observations (NOT part of the verdict) ──");
  for (const v of uiVerdicts) log(`  ${v.ok ? "observed  " : "UI-SKIP   "} ${v.name}`);
  log("");
  log(`  file evidence : ${fileVerdicts.length - fileFails.length}/${fileVerdicts.length} passed  <- this decides the run`);
  if (countMismatch) {
    log(`  ⚠ EXPECTED ${EXPECTED_FILE_VERDICTS} file verdicts, got ${fileVerdicts.length} — the gate is`);
    log(`    testing LESS than it is supposed to. A shrunken tally is not a pass.`);
  }
  log(`  ui observed   : ${uiVerdicts.length - uiFails.length}/${uiVerdicts.length}`);
  if (uiFails.length > 0) {
    log("");
    log(`  ${uiFails.length} UI fact(s) were NOT observable this run. ${UI_SKIP_REASON}`);
  }

  if (breakVerb) {
    const broken = verdicts.find((v) => v.name === breakVerb);
    log(`\n  DELETION-RED CHECK for "${breakVerb}": ${broken ? (broken.ok ? "STILL PASSING (the gate is BLIND to this break)" : "correctly RED") : "no such step"}`);
    if (broken && !broken.ok) log(`    red message: ${broken.detail}`);
    if (broken?.ok) {
      log("    ⚠ Before reading that as the gate being blind: the probe is NOT compiled into a");
      log("      clean tree. Arming it also requires the four-line patch documented in this file's");
      log("      header. Without it, a green run here is the gate working correctly.");
    }
  }

  if (countMismatch) {
    log(`\nRESULT: FAIL — the gate reported ${fileVerdicts.length} file verdicts, not the pinned `
      + `${EXPECTED_FILE_VERDICTS}. Steps went missing; fix that before reading any other result.`);
    return 1;
  }
  if (fileFails.length > 0) {
    log("\n  Failing verbs, with the agent's own transcript for diagnosis ONLY (never evidence):");
    for (const v of fileFails) log(`\n  ── ${v.name}\n     ${v.detail}\n     transcript tail: ${(turnLog[v.name] ?? "(no transcript captured for this step)").slice(-500)}`);
    log(`\nRESULT: FAIL — ${fileFails.length} verb(s) did not change the file the way the prompt asked.`);
    return 1;
  }
  log("\nRESULT: PASS — the real agent, driven by user-phrased prompts, changed the real files'");
  log("  real bytes correctly through the real LibreOffice.");
  if (uiFails.length > 0) log(`  (${uiFails.length}/${uiVerdicts.length} UI observations unavailable — reported above, not counted.)`);
  return 0;
}

// Teardown must run whatever happens — a leaked app, daemon or helper poisons the NEXT run, and a
// leftover app instance is the exact measurement trap that cost three wrong conclusions.
//
// The exit code is RETURNED through the `finally` and applied afterwards. Calling `process.exit()`
// inside the `try` — which every exit path here used to do — skips the `finally` entirely: the
// teardown banner never printed once, and every run leaked its daemon, its app and its helpers.
async function withTeardown(): Promise<void> {
  let code = 0;
  try {
    code = await main();
  } catch (err) {
    if (err instanceof GateExit) {
      code = err.code;
    } else {
      console.error("\nunexpected gate error:", err);
      code = 3;
    }
  } finally {
    step("Teardown");
    stopApp();
    const daemonState = await stopDaemon();
    killHelpers();

    // Residuals REPORTED, not assumed from having called the kills.
    //
    // The app and helper legs match on `DERIVED_DATA`, which really is in their argv (it is part of
    // the binary path). **The daemon deliberately does NOT use `pgrep`**: its argv is
    // `bun <worktree>/packages/cli/src/main.ts daemon run` and the temp `NORMA_HOME` lives in its
    // ENVIRONMENT, not its arguments — so any `pgrep -f` pattern naming the home can never match
    // it and would report 0 whether or not one survived: a check blind to its own failure mode,
    // inside the fix for "teardown never runs". A pattern loose enough to match (`daemon run`) has
    // the opposite defect — it self-matches the shell running the check, which produced two phantom
    // "surviving daemon" readings during this work. The child handle's own `close` event is exact.
    const residual = (pattern: string) =>
      (spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout || "").trim().split("\n").filter(Boolean).length;
    const leftApp = residual(`${DERIVED_DATA}.*MacOS/Norma`);
    const leftHelpers = residual(`${DERIVED_DATA}.*NormaOfficeHelper`);
    const clean = leftApp === 0 && leftHelpers === 0 && !daemonState.includes("RESIDENT");
    log(`   residual: app=${leftApp} helpers=${leftHelpers} daemon=${daemonState}${clean ? " (clean)" : " ⚠ LEAKED"}`);
    if (!process.argv.includes("--keep")) {
      // The temp home, the workdir and the pristine set go; the build stays (it is expensive and
      // carries no state). `--keep` leaves everything for post-mortem.
      for (const d of [HOME_DIR, WORK_DIR, PRISTINE_DIR]) rmSync(d, { recursive: true, force: true });
      log(`   removed the temp NORMA_HOME, workdir and pristine set under ${GATE_ROOT}`);
    } else {
      log(`   --keep: left ${GATE_ROOT} in place`);
    }
  }
  process.exit(code);
}

// ^C during a ~4-minute run must not leak the app, daemon and helpers it has already started —
// the same leak C4 fixed for the normal exit paths. Best-effort and synchronous: a signal handler
// cannot await, so this uses the process-scoped kills rather than `stopDaemon`'s close-event wait.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`\n[${sig}] interrupted — tearing down before exit`);
    try { stopApp(); } catch { /* best effort */ }
    try { if (daemon?.pid) process.kill(daemon.pid, "SIGKILL"); } catch { /* gone */ }
    try { killHelpers(); } catch { /* best effort */ }
    process.exit(130);
  });
}

await withTeardown();
