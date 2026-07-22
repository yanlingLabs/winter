import { expect, test } from "bun:test";
import { WorkflowRegistry } from "./registry";

test("register → running, complete → terminal, takeForNotification exactly once", () => {
  const reg = new WorkflowRegistry();
  const abort = new AbortController();
  reg.register({ runId: "wf_1", sessionId: "s_1", name: "triage", abort });
  expect(reg.get("wf_1")?.status).toBe("running");
  reg.setCounts("wf_1", { running: 2, completed: 1, total: 3 });
  reg.complete("wf_1", { ok: true, result: "done" });
  expect(reg.get("wf_1")?.status).toBe("completed");
  expect(reg.list("s_1")[0]).toMatchObject({ runId: "wf_1", status: "completed", counts: { total: 3 }, result: "done" });
  expect(reg.takeForNotification("wf_1")?.runId).toBe("wf_1");
  expect(reg.takeForNotification("wf_1")).toBeUndefined(); // single-consumer
});

test("stop fires abort + flips to stopped only when running; unknown ids are no-ops", () => {
  const reg = new WorkflowRegistry();
  const abort = new AbortController();
  reg.register({ runId: "wf_2", sessionId: "s_1", abort });
  expect(reg.stop("wf_2")).toBe(true);
  expect(abort.signal.aborted).toBe(true);
  expect(reg.get("wf_2")?.status).toBe("stopped");
  expect(reg.stop("wf_2")).toBe(false); // already terminal
  expect(reg.stop("nope")).toBe(false); // unknown
});

test("stop() sets status BEFORE firing abort — a synchronous abort listener observes 'stopped', not stale 'running'", () => {
  const reg = new WorkflowRegistry();
  const abort = new AbortController();
  reg.register({ runId: "wf_3", sessionId: "s_1", abort });
  let observed: string | undefined;
  // The runtime registers its teardown→settle cascade on this abort signal; abort() runs listeners
  // synchronously, so whatever it reads out of the registry must already be terminal.
  abort.signal.addEventListener("abort", () => { observed = reg.get("wf_3")?.status; });
  reg.stop("wf_3");
  expect(observed).toBe("stopped"); // was "running" before the ordering fix
});
