import type { Routine, RoutineStore } from "./store";

/** The daemon-side "fire a routine headless" bridge — implemented in routines/runner.ts against
 *  the real engine/session machinery (the SAME internal path `winter -p` turns use), with a fake
 *  implementation swapped in for this module's own unit tests. */
export interface RoutineRunner {
  runHeadless(opts: {
    prompt: string;
    policy: "auto" | "plan";
    cwd: string;
    origin: string;
  }): Promise<{ ok: boolean; quotaLimited?: boolean; resultText?: string; error?: string }>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const RESULT_TEXT_CAP = 200;

/** Daemon-owned scheduler (phase 5 routines T2, design doc §2): a periodic tick fires every due,
 *  enabled routine as a headless turn, in parallel, capped by an optional maxConcurrent(), with
 *  quota-aware backoff and an append-only audit trail.
 *
 *  Concurrency model: `tick()` snapshots `store.due(now())` once, then launches every routine not
 *  already in flight — up to `maxConcurrent()` (undefined = unlimited, the USER-DECIDED default —
 *  see the design doc header). A routine beyond the cap is simply left for a LATER tick() call; it
 *  is never queued to fire later within the SAME tick once a slot frees up (that would let one slow
 *  routine's completion silently chain-fire another mid-tick, defeating the point of a cap). Firing
 *  itself is via `Promise.all` over synchronously-invoked calls, so N due routines all reach their
 *  `runner.runHeadless()` call before any of their promises can settle — true parallelism, not a
 *  sequential await-loop with a friendly name.
 *
 *  In-flight guard: `inFlight` is a plain Set<routineId>, added to at the START of a fire (before
 *  the first await) and removed in a `finally` at the end. Two overlapping `tick()` calls (a slow
 *  routine still running when the next 30s tick fires, or two tests calling tick() back-to-back
 *  without awaiting the first) therefore can never double-fire the same routine: the routine's
 *  `nextRunAt` in the store doesn't move until its fire actually records (recordRun/recordDefer),
 *  so a second tick's `due()` query would still list it — the in-flight Set is what actually
 *  excludes it.
 *
 *  `tick()` NEVER throws (a daemon-owned setInterval callback that throws would surface as an
 *  unhandled rejection and could take the process down) — both the `due()` read and each
 *  individual fire are isolated in their own try/catch. */
export function makeRoutineScheduler(deps: {
  store: RoutineStore;
  runner: RoutineRunner;
  audit: (line: object) => void;
  maxConcurrent?: () => number | undefined;
  now?: () => number;
}): { tick(): Promise<void>; start(intervalMs?: number): void; stop(): void; runningCount(): number } {
  const now = deps.now ?? (() => Date.now());
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Fires exactly one routine: audit "fire" → runner.runHeadless → route the outcome to
   *  recordRun/recordDefer + the matching audit line. Never throws — a rejected runner promise
   *  (the interface promises a typed result, but a misbehaving implementation could still reject)
   *  is caught and treated identically to an `{ ok: false, error }` result: recordRun with the
   *  error text, NO defer-backoff (design doc §2: "errors do NOT defer-backoff — next normal
   *  schedule"), and an `{op:"error"}` audit line. */
  async function fireOne(routine: Routine): Promise<void> {
    const origin = `routine/${routine.id}`;
    inFlight.add(routine.id);
    try {
      deps.audit({ op: "fire", id: routine.id, spec: routine.spec, origin });
      let outcome: { ok: boolean; quotaLimited?: boolean; resultText?: string; error?: string };
      try {
        outcome = await deps.runner.runHeadless({
          prompt: routine.prompt,
          policy: routine.policy,
          cwd: routine.cwd,
          origin,
        });
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (outcome.ok) {
        deps.store.recordRun(routine.id, { resultText: (outcome.resultText ?? "").slice(0, RESULT_TEXT_CAP), nowMs: now() });
      } else if (outcome.quotaLimited) {
        deps.store.recordDefer(routine.id, { nowMs: now() });
        deps.audit({ op: "defer", id: routine.id, reason: "quota" });
      } else {
        const errorText = outcome.error ?? "unknown error";
        deps.store.recordRun(routine.id, { resultText: errorText.slice(0, RESULT_TEXT_CAP), nowMs: now() });
        deps.audit({ op: "error", id: routine.id, error: errorText });
      }
    } finally {
      inFlight.delete(routine.id);
    }
  }

  async function tick(): Promise<void> {
    try {
      const due = deps.store.due(now());
      const cap = deps.maxConcurrent?.();
      const toFire: Routine[] = [];
      for (const routine of due) {
        if (inFlight.has(routine.id)) continue; // already firing from an earlier, still-overlapping tick
        if (cap !== undefined && inFlight.size + toFire.length >= cap) break; // cap reached — leave the rest for a later tick
        toFire.push(routine);
      }
      await Promise.all(toFire.map((routine) => fireOne(routine)));
    } catch (err) {
      console.error(`[routines] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    tick,
    start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
      if (timer) return; // already started — idempotent, mirrors stop()
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.(); // never keeps the daemon process alive on its own
    },
    stop(): void {
      if (timer) { clearInterval(timer); timer = null; }
    },
    runningCount(): number { return inFlight.size; },
  };
}
