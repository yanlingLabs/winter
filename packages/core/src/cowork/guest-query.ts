import type { CanUseTool, Options } from "@yanlinglabs/winter-agent-sdk";
import { CoworkGuestRuntimeSupervisor } from "./guest-runtime";
import { CoworkError } from "./types";

/** Explicit host callbacks only. Never accept the ordinary host Options bag here. */
export interface CoworkGuestQueryCallbacks {
  canUseTool: CanUseTool;
  abortController: AbortController;
  stderr?: (chunk: string) => void;
}
/** The current SDK pin does not declare/serialize executionPosture. The supervisor
 * independently carries it in its fixed launch descriptor; this field also lets a
 * future compatible SDK retain the posture. It is not an SDK admission claim. */
export type CoworkGuestQueryOptions = Readonly<Options & { executionPosture: "confined-guest" }>;

function fixedList<T>(values: T[]): T[] { Object.freeze(values); return values; }

/** Candidate host query composition. No daemon registration, local fallback or
 * native authority is added: the supervisor still refuses absent/unadmitted ports.
 * SDK spawn argv/env are intentionally ignored; only its canonical prepared launch
 * reaches the trusted supervisor port. Guest stores/run homes belong to that port,
 * never to the ordinary host run-home builder or credential resolver. */
export function buildCoworkGuestQueryOptions(
  supervisor: CoworkGuestRuntimeSupervisor,
  sessionId: string,
  callbacks: CoworkGuestQueryCallbacks,
): CoworkGuestQueryOptions {
  if (!(supervisor instanceof CoworkGuestRuntimeSupervisor) || !callbacks ||
      Object.keys(callbacks).some(key => !["canUseTool", "abortController", "stderr"].includes(key)) ||
      typeof callbacks.canUseTool !== "function" || !(callbacks.abortController instanceof AbortController) ||
      (callbacks.stderr !== undefined && typeof callbacks.stderr !== "function")) throw new CoworkError("invalid_request");
  const prepared = supervisor.prepareQuery(sessionId), { runtime, limits } = prepared.launch;
  const canUseTool = callbacks.canUseTool, abortController = callbacks.abortController, stderr = callbacks.stderr;
  return Object.freeze({
    executionPosture: runtime.executionPosture,
    sessionId: runtime.sessionId, model: runtime.model, cwd: runtime.cwd,
    persistSession: runtime.persistSession, permissionMode: runtime.permissionMode,
    ...(runtime.resume === undefined ? {} : { resume: runtime.resume }),
    pathToClaudeCodeExecutable: "winter-confined-guest",
    spawnClaudeCodeProcess: () => {
      if (abortController.signal.aborted) throw new CoworkError("authority_denied");
      return prepared.spawn();
    },
    env: Object.freeze({}), settingSources: fixedList([]), tools: fixedList([...runtime.tools]),
    // allowedTools pre-approves calls. Keep approval decisions in the explicitly
    // supplied bridge instead of deriving pre-approval from the visibility ceiling.
    allowedTools: fixedList([...runtime.allowedTools]), plugins: fixedList([]), skills: fixedList([]),
    mcpServers: Object.freeze({}), strictMcpConfig: true,
    permissions: Object.freeze({ disableBypassPermissionsMode: runtime.permissionMode !== "bypassPermissions" }),
    allowDangerouslySkipPermissions: runtime.permissionMode === "bypassPermissions",
    includePartialMessages: true, maxBufferSize: limits.frameBytes,
    canUseTool, abortController, ...(stderr === undefined ? {} : { stderr }),
  });
}
