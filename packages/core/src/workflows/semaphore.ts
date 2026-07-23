/** A simple counting semaphore. Two independent instances gate agent fan-out (Global Constraints):
 *  the Worker-side one (worker-harness.ts) throttles in-Worker dispatch so the Worker never posts
 *  thousands of agent requests at once; the runtime-side one (runtime.ts, per `LiveRun`, Task A5)
 *  is the authoritative per-run bound, since it wraps the actual bridge into the global
 *  SubagentManager pool. Both are constructed with the same `concurrency` cap. */
export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

export function makeSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = () => new Promise<void>((res) => { if (active < max) { active++; res(); } else queue.push(res); });
  const release = () => { active--; const n = queue.shift(); if (n) { active++; n(); } };
  return { acquire, release };
}
