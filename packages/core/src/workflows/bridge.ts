import type { AgentOpts } from "./types";

/** Worker → daemon. `agent` is request/reply (awaits a BridgeResponse keyed by callId); `log`/
 *  `phase` are one-way; `done`/`error` are terminal one-way. `parallel`/`pipeline` need NO op of
 *  their own — the harness implements them in-Worker as JS wrappers over agent() (see worker-harness). */
export type BridgeRequest =
  | { op: "agent"; callId: number; prompt: string; opts?: AgentOpts }
  | { op: "log"; message: string }
  | { op: "phase"; title: string }
  | { op: "done"; result: unknown }
  | { op: "error"; message: string };

/** daemon → Worker: the reply to an `agent` request. `value` is the agent's final report (or its
 *  parsed structured output when opts.schema was set). */
export type BridgeResponse =
  | { callId: number; ok: true; value: unknown }
  | { callId: number; ok: false; error: string };

/** The single init message the daemon posts to the Worker on spawn. `resumeJournal` (Task A6) is
 *  the ordered cache of prior agent() results; empty for a fresh run. */
export interface WorkerInit {
  source: string;
  args: unknown;
  concurrency: number;
  resumeJournal?: Array<{ promptKey: string; value: unknown }>;
}
