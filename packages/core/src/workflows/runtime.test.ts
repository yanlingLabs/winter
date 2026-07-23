import { expect, test } from "bun:test";
import { WorkflowRuntime, type WorkflowRuntimeEvent } from "./runtime";
import { makeSemaphore } from "./semaphore";

function makeRuntime(over: Partial<ConstructorParameters<typeof WorkflowRuntime>[0]> = {}) {
  const events: Array<[string, WorkflowRuntimeEvent]> = [];
  const rt = new WorkflowRuntime({
    onEvent: (sid, ev) => events.push([sid, ev]),
    spawnAgent: async (_sid, prompt) => ({ ok: true, result: `[${prompt}]` }),
    ...over,
  });
  return { rt, events };
}

/** Test-only seam for the M4 case below: `serviceAgent` is protected (callable from a subclass with
 *  no cast) but `live` is private (needs one cast even from a subclass). Exposes just enough to
 *  drive serviceAgent directly against a seeded fake LiveRun, bypassing launch()'s real
 *  child-process spawn — see the M4 test for why that bypass is the right call here. */
class ServiceAgentHarness extends WorkflowRuntime {
  seedLiveRun(runId: string, run: any): void { (this as any).live.set(runId, run); }
  callServiceAgent(run: any, msg: any): Promise<any> { return this.serviceAgent(run, msg); }
}

test("a trivial script runs in the Worker and returns its result", async () => {
  const { rt } = makeRuntime();
  const runId = rt.launch({ sessionId: "s_1", source: `export const meta={name:"t",description:"d"};\nconst a=await agent("hi");\nreturn a;` });
  const view = await rt.await(runId);
  expect(view.status).toBe("completed");
  expect(view.result).toBe("[hi]");
});

test("phase/log emit progress events; the run tracks counts", async () => {
  const { rt, events } = makeRuntime();
  const runId = rt.launch({ sessionId: "s_1", source: `phase("triage"); log("scanning"); return 1;` });
  await rt.await(runId);
  const progress = events.filter(([, e]) => e.type === "progress").map(([, e]) => e as Extract<WorkflowRuntimeEvent, {type:"progress"}>);
  expect(progress.some((e) => e.progress.phase === "triage")).toBe(true);
  expect(progress.some((e) => e.progress.log === "scanning")).toBe(true);
});

test("stop() terminates a mid-run Worker", async () => {
  const { rt } = makeRuntime({ spawnAgent: async () => new Promise(() => {}) }); // never resolves
  const runId = rt.launch({ sessionId: "s_1", source: `await agent("forever"); return "unreachable";` });
  await new Promise((r) => setTimeout(r, 50));
  expect(rt.stop(runId)).toBe(true);
  const view = await rt.await(runId);
  expect(view.status).toBe("stopped");
});

test("a script eval error → failed, never crashes the process", async () => {
  const { rt } = makeRuntime();
  const runId = rt.launch({ sessionId: "s_1", source: `return (;` });
  const view = await rt.await(runId);
  expect(view.status).toBe("failed");
  expect(view.error).toBeDefined();
});

// --- Task A3′ review fold-ins -----------------------------------------------------------------
// I2 and M1 go through the real public API (launch/stop/await) with a single in-flight agent call
// — no interaction with the harness's own mirrored concurrency semaphore (worker-harness.ts), so the
// real sandboxed-subprocess default transport is fine here (each spawn is cheap in practice: the
// whole file runs in well under a second). M4 needs TWO agent calls contending for a parent-side
// semaphore of capacity 1 to observe its release-ordering fix; routing that through a real child
// would ALSO serialize at the child's own mirrored semaphore (worker-harness.ts's `agent()` wrapper
// shares the exact same `concurrency` value end to end — see WorkerInit/caps.concurrency), so the
// second call would never even be dispatched from the child while the first is, from its own view,
// still outstanding — regardless of whatever the parent-side fix does. M4 therefore calls the
// protected `serviceAgent` directly against a seeded fake LiveRun (via ServiceAgentHarness above),
// isolating exactly the parent-side fix under test.

test("I2: stop() aborts the run's own controller, cancelling an in-flight agent (not a throwaway controller)", async () => {
  let cancelled = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((res) => { resolveStarted = res; });
  const { rt } = makeRuntime({
    spawnAgent: (_sid, _prompt, _opts, signal) => {
      resolveStarted();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => { cancelled = true; resolve({ ok: false, result: "cancelled" }); });
      });
    },
  });
  const runId = rt.launch({ sessionId: "s_1", source: `await agent("forever"); return "unreachable";` });
  await started; // the in-flight agent's signal is now live — this is what stop() must cancel
  expect(rt.stop(runId)).toBe(true);
  const view = await rt.await(runId);
  expect(view.status).toBe("stopped");
  expect(cancelled).toBe(true); // pre-fix: a throwaway AbortController meant this never fired
});

test("M1: the post-teardown finally doesn't emit progress for a run that's already dead", async () => {
  let releaseAgent!: (v: { ok: boolean; result: string }) => void;
  const blocked = new Promise<{ ok: boolean; result: string }>((res) => { releaseAgent = res; });
  let resolveStarted!: () => void;
  const started = new Promise<void>((res) => { resolveStarted = res; });
  const { rt, events } = makeRuntime({
    // Deliberately ignores `signal` — this call resolves on its own schedule, independent of
    // stop()/abort, isolating M1's finally-guard from I2's abort-link (a separate fix).
    spawnAgent: () => { resolveStarted(); return blocked; },
  });
  const runId = rt.launch({ sessionId: "s_1", source: `await agent("slow"); return "unreachable";` });
  await started;
  expect(rt.stop(runId)).toBe(true);
  await rt.await(runId); // the run is fully torn down (status "stopped") while the agent call is still pending
  const progressBeforeRelease = events.filter(([, e]) => e.type === "progress").length;
  releaseAgent({ ok: true, result: "late" }); // let serviceAgent's finally run, well after teardown
  await new Promise((r) => setTimeout(r, 20)); // give its microtasks a tick to flush
  const progressAfterRelease = events.filter(([, e]) => e.type === "progress").length;
  expect(progressAfterRelease).toBe(progressBeforeRelease); // pre-fix: an extra progress event leaked out here
});

test("M4: a throwing onEvent doesn't leak the semaphore permit — a second call still proceeds, with no unhandled rejection", async () => {
  let throwOnNextProgress = true;
  const rt = new ServiceAgentHarness({
    onEvent: (_sid, ev) => {
      if (ev.type === "progress" && throwOnNextProgress) { throwOnNextProgress = false; throw new Error("boom from onEvent"); }
    },
    caps: { concurrency: 1, total: 1000 },
    spawnAgent: async (_sid, prompt) => ({ ok: true, result: `[${prompt}]` }),
  });

  // A seeded fake LiveRun — see the file-level comment above for why this bypasses launch().
  const runId = "wf_test_m4";
  const fakeRun = {
    runId, sessionId: "s_1", child: null, stdoutBuf: "", done: Promise.resolve(),
    running: 0, completed: 0, total: 0,
    sem: makeSemaphore(1), totalCap: 1000,
    journal: { append: () => {}, load: () => [] },
    abort: new AbortController(),
  };
  rt.seedLiveRun(runId, fakeRun);

  let firstRejected = false;
  await rt.callServiceAgent(fakeRun, { op: "agent", callId: 1, prompt: "first" }).catch(() => { firstRejected = true; });
  expect(firstRejected).toBe(true); // onEvent's throw does surface — handled right here, never floating/unhandled

  // Pre-fix, release() lived only in a finally the throw above never reached, so the permit leaked
  // and this would hang forever. clearTimeout below tidies the loser once the race settles either way.
  let timeoutId!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timed out waiting for the semaphore — permit leaked")), 300);
  });
  const second = await Promise.race([rt.callServiceAgent(fakeRun, { op: "agent", callId: 2, prompt: "second" }), timeout]);
  clearTimeout(timeoutId);
  expect(second).toEqual({ callId: 2, ok: true, value: "[second]" });
});
