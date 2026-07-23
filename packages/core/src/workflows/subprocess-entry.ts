import { runWorkflow } from "./worker-harness";
import type { BridgeRequest, BridgeResponse, WorkerInit } from "./bridge";
import type { AgentOpts } from "./types";

export function runWorkflowSubprocess(): void {
  const IN = process.stdin;
  const OUT = process.stdout;
  // Defense-in-depth (belt-and-suspenders under the seatbelt). Do NOT null `process` — the entry
  // needs stdio; the SCRIPT can't see it anyway (worker-harness shadows it in the script scope).
  for (const g of ["Bun", "fetch", "XMLHttpRequest", "WebSocket"]) {
    try { (globalThis as Record<string, unknown>)[g] = undefined; } catch { /* non-configurable */ }
  }

  const post = (m: BridgeRequest) => OUT.write(JSON.stringify(m) + "\n");

  // NDJSON stdin reader → async queue
  let buf = "";
  const queue: Array<WorkerInit | BridgeResponse> = [];
  const waiters: Array<(v: WorkerInit | BridgeResponse) => void> = [];
  const next = (): Promise<WorkerInit | BridgeResponse> =>
    new Promise((res) => { const q = queue.shift(); if (q !== undefined) res(q); else waiters.push(res); });
  IN.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let obj: WorkerInit | BridgeResponse;
      try { obj = JSON.parse(line); } catch { continue; }
      const w = waiters.shift(); if (w) w(obj); else queue.push(obj);
    }
  });
  IN.resume();

  let nextCallId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const agent = (prompt: string, opts?: AgentOpts) =>
    new Promise<unknown>((resolve, reject) => {
      const callId = nextCallId++;
      pending.set(callId, { resolve, reject });
      post({ op: "agent", callId, prompt, opts });
    });

  async function pumpResponses(): Promise<void> {
    for (;;) {
      const r = (await next()) as BridgeResponse;
      const p = pending.get(r.callId);
      if (!p) continue;
      pending.delete(r.callId);
      r.ok ? p.resolve(r.value) : p.reject(new Error(r.error));
    }
  }

  (async () => {
    const init = (await next()) as WorkerInit;   // FIRST line is the init
    void pumpResponses();                          // all later lines are agent replies
    try {
      const { result } = await runWorkflow({
        source: init.source, args: init.args, concurrency: init.concurrency,
        agent,
        phase: (title) => post({ op: "phase", title }),
        log: (message) => post({ op: "log", message }),
        resumeJournal: init.resumeJournal,
      });
      post({ op: "done", result });
    } catch (e) {
      post({ op: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      // stdin's data listener keeps the loop alive; exit explicitly so the parent's `close` fires.
      // 50ms lets the terminal stdout line flush (proven in the spike).
      setTimeout(() => process.exit(0), 50);
    }
  })();
}

// DEV/TEST default spawn runs this file DIRECTLY (`bun subprocess-entry.ts`): self-exec here.
// COMPILED path imports runWorkflowSubprocess via the barrel and calls it from main.ts, so the
// import.meta.main guard keeps a barrel import side-effect-free.
if (import.meta.main) runWorkflowSubprocess();
