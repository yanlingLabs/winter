/// <reference lib="webworker" />
import { runWorkflow } from "./worker-harness";
import type { BridgeRequest, BridgeResponse, WorkerInit } from "./bridge";
import type { AgentOpts } from "./types";

// Defense-in-depth global neutralization (the harness ALSO shadows these as locals — Task A2).
// Best-effort per the spec's containment model; the Worker isolation + terminate() is the real fence.
for (const g of ["Bun", "process", "fetch", "XMLHttpRequest", "WebSocket"]) {
  try { (globalThis as Record<string, unknown>)[g] = undefined; } catch { /* non-configurable → ignore */ }
}

const post = (m: BridgeRequest) => (self as unknown as Worker).postMessage(m);
let nextCallId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

self.onmessage = (ev: MessageEvent) => {
  const init = ev.data as WorkerInit | BridgeResponse;
  if ("op" in (init as object) === false && "callId" in (init as object)) {
    const r = init as BridgeResponse;
    const p = pending.get(r.callId);
    if (!p) return;
    pending.delete(r.callId);
    r.ok ? p.resolve(r.value) : p.reject(new Error(r.error));
    return;
  }
  const wi = init as WorkerInit;
  self.onmessage = handleResponse; // subsequent messages are only agent replies
  void boot(wi);
};

function handleResponse(ev: MessageEvent) {
  const r = ev.data as BridgeResponse;
  const p = pending.get(r.callId);
  if (!p) return;
  pending.delete(r.callId);
  r.ok ? p.resolve(r.value) : p.reject(new Error(r.error));
}

const agent = (prompt: string, opts?: AgentOpts) =>
  new Promise<unknown>((resolve, reject) => {
    const callId = nextCallId++;
    pending.set(callId, { resolve, reject });
    post({ op: "agent", callId, prompt, opts });
  });

async function boot(init: WorkerInit): Promise<void> {
  try {
    const { result } = await runWorkflow({
      source: init.source, args: init.args, concurrency: init.concurrency,
      agent, phase: (title) => post({ op: "phase", title }), log: (message) => post({ op: "log", message }),
      resumeJournal: init.resumeJournal,
    });
    post({ op: "done", result });
  } catch (e) {
    post({ op: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
