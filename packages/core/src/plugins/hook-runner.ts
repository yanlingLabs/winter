/**
 * HookRunner — pure process mechanics for ONE plugin hook invocation (Phase 4f design §Protocol,
 * plan Task 1). Spawns `sh -c <command>` with the event JSON on stdin, races the exit against a
 * timeout, caps stdout/stderr, and maps the exit-code protocol (0=ok / 2=blocked+stderr-reason /
 * anything else=error) to a `HookResult`. This class NEVER throws — every path (spawn failure,
 * timeout, non-zero exit, stream-read failure) resolves a `HookResult`; callers (HookRegistry /
 * the engine facade, Tasks 2-3) can await it unconditionally.
 *
 * Deliberately has NO opinion on: which hooks run for an event, sequencing/short-circuiting
 * across multiple hooks, fail-open policy, or where results get injected (system-reminder vs.
 * blocked tool_result) — that's HookRegistry + the engine facade (Task 2/3).
 */

/** One hook, resolved to something directly spawnable — plugin id (for env/logging), the shell
 *  command from winter-plugin.json, the plugin's directory (cwd), and an optional per-hook
 *  timeout override (falls back to `DEFAULT_TIMEOUT_MS` below). */
export interface HookSpec {
  pluginId: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
}

/** The JSON object written to the child's stdin. `event`/`sessionId`/`pluginId`/`ts` are common to
 *  every hook event; per-event extra fields (toolName, argsJson, stdout, ...) ride along via the
 *  index signature — callers building a payload for a specific event add those directly. */
export type HookEventPayload = {
  event: string;
  sessionId: string;
  pluginId: string;
  ts: number;
} & Record<string, unknown>;

export interface HookResult {
  status: "ok" | "blocked" | "error" | "timeout";
  reason?: string;
  stdout: string;
}

/** F2 (design doc): fail-open default — a hook that neither errors nor is given a manifest
 *  `timeoutMs` gets 10s before it's killed and treated as "timeout" (fail-open at the call site,
 *  not here — this class just reports the outcome). */
const DEFAULT_TIMEOUT_MS = 10_000;
const STDOUT_CAP = 8192;
const STDERR_CAP = 1024;

/**
 * Bounded, deadline-guarded stream collector (4f whole-branch C1). Replaces
 * `new Response(stream).text().slice(0, cap)` on the normal-exit path, which had two failure modes:
 *   (a) UNBOUNDED HANG — `.text()` reads to EOF, but a hook that backgrounds a process inheriting
 *       our stdout/stderr (`sleep 5 & …`, a daemon, …) keeps the pipe's write end open after `sh`
 *       exits, so EOF never arrives and the read blocks for the grandchild's whole lifetime. `sh`
 *       has already exited and the grandchild is reparented to launchd (we hold no pid), so killing
 *       is not an option — the fix is to STOP READING, not to kill.
 *   (b) UNBOUNDED MEMORY — `.text()` materializes the entire stream as one string before slicing;
 *       an unbounded producer (`yes … & …`) grows RSS without limit → daemon OOM.
 * This helper (1) accumulates at most `cap` bytes (decoded incrementally, TextDecoder streaming),
 * then cancels the reader and returns; (2) races the whole read against `deadlineMs` — on deadline
 * it cancels the reader and returns whatever was captured (partial-ok); (3) CATCHES every rejection
 * path internally (cancel / abandoned read / stream error). It NEVER throws and ALWAYS resolves a
 * string — an unhandled rejection here would reintroduce the daemon-crash class fixed in 04696ad.
 * `reader.cancel()` closes our read end, which is also what lets an orphaned flooding grandchild die
 * (it gets SIGPIPE on its next write). NB it cannot bound a *bounded* producer's peak RSS: Bun
 * eagerly drains+buffers a finite child's full stdout into memory before `proc.exited` resolves, so
 * that spike predates collection; this helper bounds the collected string (no second full-size copy)
 * and is the only thing that saves an UNBOUNDED producer or a grandchild-held pipe.
 */
async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number, deadlineMs: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  let out = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The read loop is its own task so the deadline can win the race WITHOUT awaiting a stuck read().
  // Its body try/catches, so it resolves (never rejects) even on a stream error mid-read.
  const readLoop = (async () => {
    const decoder = new TextDecoder(); // UTF-8; {stream:true} keeps multibyte sequences intact across chunks
    try {
      while (out.length < cap) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) out += decoder.decode(value, { stream: true });
      }
    } catch {
      /* stream errored mid-read — keep whatever we already decoded */
    }
  })();

  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); });
  try {
    await Promise.race([readLoop, deadline]);
  } catch {
    /* defensive — readLoop already swallows, but never let this throw */
  }
  if (timer !== undefined) clearTimeout(timer); // don't keep the event loop alive on the fast path

  // Whether we hit the cap, hit EOF, or hit the deadline: cancel to release our read end. Do NOT
  // await cancel() (on the grandchild-held path the underlying read is stuck; awaiting could re-hang)
  // and swallow its rejection. readLoop may still be pending (its read() is stuck) — attach a catch so
  // it can never surface as an unhandled rejection, and let it resolve on its own once cancel lands.
  readLoop.catch(() => {});
  void reader.cancel().catch(() => {});
  return out.slice(0, cap);
}

export class HookRunner {
  async run(spec: HookSpec, payload: HookEventPayload): Promise<HookResult> {
    const startTime = Date.now(); // for the stream-read deadline below (remaining timeout budget)
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["sh", "-c", spec.command], {
        cwd: spec.cwd,
        env: {
          ...process.env,
          WINTER_SESSION_ID: payload.sessionId,
          WINTER_PLUGIN_ID: spec.pluginId,
          WINTER_HOOK_EVENT: payload.event,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      // Spawn itself threw (e.g. `cwd` doesn't exist, `sh` missing) — never propagate, report it
      // the same shape as any other hook failure.
      return { status: "error", stdout: "", reason: err instanceof Error ? err.message : String(err) };
    }

    // Fire-and-forget: write/end the stdin payload as a CONCURRENT task, not one the timeout race
    // below awaits. Bun's FileSink write()/end() are typed `number | Promise<number>` — a bare
    // `.catch()` can't chain on the sync-number fast path, so this async IIFE (whose `await`
    // normalizes both) is what reliably contains a rejection. If this write were awaited here
    // (pre-C3-fix), a non-draining-but-alive hook + a payload above the pipe-buffer threshold
    // (~512-600KB) would block it forever — BEFORE the race/timer below is ever constructed — so
    // the timeout would never fire and run() would hang unboundedly. Not awaiting it means the
    // race is always armed immediately, regardless of whether the write drains. A write blocked on
    // a hung hook gets unblocked when the timeout path SIGKILLs the child below: the pipe breaks,
    // the write rejects (EPIPE), and that rejection is caught right here — never an unhandled
    // rejection (C1 stays closed). A normal, well-behaved child still receives the full payload +
    // EOF, since write+end complete long before any realistic timeout fires.
    void (async () => {
      try {
        await proc.stdin.write(JSON.stringify(payload));
        await proc.stdin.end();
      } catch {
        // Child gone early (exit before reading stdin) or pipe closed by our own SIGKILL on
        // timeout — either way irrelevant to the outcome decided below; swallow it.
      }
    })();

    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    // Fast path (process exited before the timer fired): clear it so it can't fire later and keep
    // the process/event-loop alive for no reason.
    if (timer !== undefined) clearTimeout(timer);

    if (timedOut) {
      try {
        // SIGKILL, not the default SIGTERM: a hook can trivially install `trap '' TERM` (or simply
        // ignore it) and a SIGTERM would then never actually stop it, leaving `await proc.exited`
        // below blocked forever and defeating the timeout entirely. SIGKILL cannot be trapped or
        // ignored. A timed-out hook gets no grace period — going straight to SIGKILL (rather than
        // TERM-then-KILL escalation) keeps this simple, which is the right tradeoff for v1.
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // Don't resolve "timeout" until the process is actually dead — await its real exit rather
      // than trusting that kill() is synchronous/instantaneous.
      await proc.exited;
      return { status: "timeout", stdout: "" };
    }

    // Normal-exit collection (C1). `proc` has already exited (the race resolved with timedOut=false)
    // and proc.exitCode is set — so classification below is UNCHANGED. But the stdout/stderr streams
    // can still block to EOF if the hook backgrounded a process inheriting them (see readCapped's
    // doc). Deadline = the hook's OWN remaining timeout budget (floored at 500ms), so a normal fast
    // hook — whose streams are already closed — completes instantly, while a grandchild-held or
    // unbounded stream is abandoned after at most that budget with whatever was captured (partial-ok).
    // stdout+stderr are read CONCURRENTLY so a blocked pair costs one deadline, not two. A lost or
    // partial stderr on the blocked path just leaves `reason` undefined → "no reason given" downstream
    // (acceptable). readCapped never throws, so no try/catch is needed here.
    const readDeadline = Math.max(500, timeoutMs - (Date.now() - startTime));
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, STDOUT_CAP, readDeadline),
      readCapped(proc.stderr, STDERR_CAP, readDeadline),
    ]);

    const exitCode = proc.exitCode;
    if (exitCode === 0) return { status: "ok", stdout };
    if (exitCode === 2) return { status: "blocked", stdout, reason: stderr.trim() || undefined };
    return { status: "error", stdout, reason: stderr.trim() || `exited with code ${exitCode}` };
  }
}
