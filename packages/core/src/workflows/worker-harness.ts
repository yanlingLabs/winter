import { promptKey } from "./journal";
import { makeSemaphore } from "./semaphore";
import type { AgentOpts } from "./types";

export interface HarnessDeps {
  source: string;
  args: unknown;
  concurrency: number;
  agent: (prompt: string, opts?: AgentOpts) => Promise<unknown>;
  phase: (title: string) => void;
  log: (message: string) => void;
  /** Task A6: the loaded journal from a prior run (resume() only) — the ordered cache of that run's
   *  agent() results, keyed by call order. Absent/empty for a fresh (non-resumed) run. */
  resumeJournal?: Array<{ promptKey: string; value: unknown }>;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** Determinism guards (Global Constraints): a resumed prefix must be byte-stable, so time/randomness
 *  are withheld — a script that reaches for them fails loudly rather than silently non-determinate. */
const guardedMath = new Proxy(Math, {
  get(t, p) {
    if (p === "random") return () => { throw new Error("Math.random is withheld for determinism — pass a seed via args"); };
    return Reflect.get(t, p);
  },
});
const GuardedDate = new Proxy(Date, {
  get(t, p) {
    if (p === "now") return () => { throw new Error("Date.now is withheld for determinism — pass timestamps via args"); };
    return Reflect.get(t, p);
  },
  construct(t, argsList) {
    if (argsList.length === 0) throw new Error("argless new Date() is withheld for determinism — pass a timestamp via args");
    return Reflect.construct(t, argsList);
  },
});

export async function runWorkflow(deps: HarnessDeps): Promise<{ meta: unknown; result: unknown }> {
  // Bounds in-Worker fan-out to `concurrency` (per-run cap, Global Constraints); the runtime-side
  // per-run semaphore (runtime.ts, Task A5) is the authoritative bound — this one just keeps the
  // Worker from posting thousands of agent requests at once. See semaphore.ts for details.
  const sem = makeSemaphore(Math.max(1, deps.concurrency));

  // Resumability (Task A6, Global Constraints): the journal caches a prior run's agent() results by
  // CALL ORDER. `diverged` latches true on the first call whose (prompt,opts) no longer matches the
  // journal at that index (a changed call, or simply past the journal's recorded end) — that call
  // and everything after it runs live, even if some later index would have coincidentally matched.
  // The determinism guard above (Date/Math withheld) is what makes the untouched prefix byte-stable
  // enough for this positional match to be trustworthy.
  let callIndex = 0;
  const journal = deps.resumeJournal ?? [];
  let diverged = false;
  const agent = async (prompt: string, opts?: AgentOpts): Promise<unknown> => {
    const idx = callIndex++;
    const key = promptKey(prompt, opts);
    if (!diverged && journal[idx] && journal[idx].promptKey === key) return journal[idx].value; // cached prefix
    diverged = true; // first mismatch/new call → everything after runs live
    await sem.acquire();
    try { return await deps.agent(prompt, opts); } finally { sem.release(); }
  };
  /** A thunk that throws resolves to null — never rejects the batch (Global Constraints). */
  const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(thunks.map(async (t) => { try { return await t(); } catch { return null; } }));
  /** Each item flows through all stages independently (no barrier); a stage throw drops it to null. */
  const pipeline = async (items: unknown[], ...stages: Array<(x: unknown) => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(items.map(async (item) => {
      let cur = item;
      try { for (const stage of stages) cur = await stage(cur); return cur; } catch { return null; }
    }));
  const phase = (title: string) => deps.phase(String(title));
  const log = (message: string) => deps.log(String(message));
  /** budget — token-budget helpers (CC-parity, best-effort v1): a no-op accountant the script can
   *  call without erroring; real accounting is a later refinement. */
  const budget = { remaining: () => Infinity, spend: (_n: number) => {}, limit: (_n: number) => {} };

  const META = { value: undefined as unknown };

  // Minimal transform: capture `export const meta = …` into META.value; strip any other stray
  // `export `. The remaining body runs as an AsyncFunction body whose `return` yields the result.
  const transformed = deps.source
    .replace(/\bexport\s+(?:const|let|var)\s+meta\s*=/, "__META__.value =")
    .replace(/^[ \t]*export\s+/gm, "");

  const scope: Record<string, unknown> = {
    agent, parallel, pipeline, phase, log, budget, args: deps.args, __META__: META,
    JSON, Math: guardedMath, Date: GuardedDate, Array, Object, String, Number, Boolean, Promise, RegExp, Map, Set, console,
    // Shadow dangerous ambients so `typeof Bun === "undefined"` inside the body:
    Bun: undefined, process: undefined, require: undefined, fetch: undefined, globalThis: undefined, self: undefined,
  };
  const keys = Object.keys(scope);
  const fn = new AsyncFunction(...keys, `"use strict";\n${transformed}`);
  const result = await fn(...keys.map((k) => scope[k]));
  return { meta: META.value, result };
}
