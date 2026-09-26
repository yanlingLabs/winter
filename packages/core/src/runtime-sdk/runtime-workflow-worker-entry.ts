// WS-23: the RUNTIME's workflow worker, run from `winter-core`. An embedded session's Workflow tool
// spawns `<command> --bridge` under the seatbelt (`embedded.ts`'s `runtimeWorkflowWorkerCommand`):
// compiled, `winter-core __runtime-workflow-worker --bridge`, which `cli/src/main.ts` routes here;
// in dev and tests, `bun <this file> __runtime-workflow-worker --bridge`, which self-executes below.
//
// NOT the daemon's own workflow worker (`workflows/subprocess-entry.ts`, argv `__workflow-worker`):
// the runtime's worker speaks the runtime's bridge (`workflowWorkerMain`, R5-15), a different program.
import { workflowWorkerMain } from "@yanlinglabs/winter-agent-runtime/workflow-worker";

/** Run the runtime's workflow worker on this process's stdio, then exit with its code. */
export async function runRuntimeWorkflowWorker(): Promise<never> {
  let code: number;
  try {
    code = await workflowWorkerMain(process.argv, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  } catch (err) {
    process.stderr.write(`winter-core: fatal (runtime workflow worker): ${err instanceof Error ? err.message : String(err)}\n`);
    code = 1;
  }
  process.exit(code);
}

// `void`, not a top-level await: the barrel imports this module, and a TLA would make every importer async.
if (import.meta.main) void runRuntimeWorkflowWorker();
