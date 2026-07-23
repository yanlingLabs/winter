export type WorkflowStatus = "running" | "completed" | "failed" | "stopped";
export interface WorkflowCounts { running: number; completed: number; total: number }
export interface WorkflowProgress { phase?: string; log?: string; counts: WorkflowCounts }
export interface AgentOpts { label?: string; model?: string; schema?: unknown }

/** Read-only projection of a run for list()/get()/RPC — no AbortController, plain-cloneable. */
export interface WorkflowRunView {
  runId: string;
  sessionId: string;
  name?: string;
  status: WorkflowStatus;
  counts: WorkflowCounts;
  phase?: string;
  result?: string;
  error?: string;
  startedAt: number;
}
