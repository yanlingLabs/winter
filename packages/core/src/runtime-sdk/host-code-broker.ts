import { hostToolNameFor } from "./tool-names";
import { canonicalHostJson } from "./host-code-json";
import * as sdk from "@yanlinglabs/winter-agent-sdk";
import * as runtime from "@yanlinglabs/winter-agent-runtime";
import type {
  Options,
  SpawnClaudeCodeProcess,
  SpawnRuntimeOptions,
  PermissionResult,
  HookCallback,
  HookJSONOutput,
} from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { randomUUID, createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  hostStorageFloorDescriptor,
  type HostStorageFloorDescriptor,
  registerHostStorageFences,
  type HostStorageFenceOptions,
} from "./host-storage-fence";

export class HostCodeUnavailable extends Error {
  readonly code = "winter_leg_unavailable" as const;
  constructor(readonly reason: string) {
    super(
      `Code host execution is unavailable (${reason}); protected Cowork storage requires an enrolled runtime generation`,
    );
    this.name = "HostCodeUnavailable";
  }
}
export interface HostCodeRequest {
  version: 1;
  generationId: string;
  sessionId: string;
  toolUseId: string;
  agentId?: string;
  parentToolUseId?: string;
  kind: "command" | "workflow";
  cwd: string;
  command?: string;
  workflowRunId?: string;
  pwdCapturePath?: string;
  timeoutMs: number;
  maxStreamedBytes: number;
  sandboxIntent?: "ordinary" | "override-requested";
}
export interface HostCodeCall {
  callId: string;
  threadId: string;
  name: string;
  input: Record<string, unknown>;
}
export interface HostCodeHookDecision {
  decision: "allow" | "deny" | "ask" | "defer" | "no_opinion";
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
}
export interface HostCodeInvocation extends HostCodeCall {
  ancestors?: readonly HostCodeCall[];
  scope?: HostCodeContext["scope"];
  preHookDecision?: HostCodeHookDecision;
}
export interface HostCodeContext {
  scope: {
    generationId: string;
    sessionId: string;
    toolUseId: string;
    agentId?: string;
    parentToolUseId?: string;
  };
  commandOptions: Record<string, unknown>;
  floor: HostStorageFloorDescriptor;
  executionCommand?: string;
  workflow?: {
    command: { file: string; args: string[] };
    home?: string;
    winterHome?: string;
  };
}
export interface HostCodeDrainEvidence {
  generationId: string;
  coverage: "registered-process-close-only";
  confirmedProcessCount: number;
  status: "confirmed" | "uncertain";
}
export interface HostCodePromptReceipt {
  generationId: string;
  sessionId: string;
  toolUseId: string;
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  policyRevision: string;
  agentId?: string;
  ancestors?: readonly HostCodeCall[];
  preHookDecision?: HostCodeHookDecision;
  result: PermissionResult;
}
export interface HostCodeRegistration {
  generationId: string;
  dispose?(): void;
  stopAll?(): void;
  drained?: Promise<HostCodeDrainEvidence>;
  handle(
    subtype: string,
    payload: unknown,
    context: {
      signal: AbortSignal;
      callerSessionId: string;
      generationId: string;
    },
  ): Promise<unknown>;
}
/** Required SDK APIs are capability checked, never recreated in Core or accepted from a wire marker. */
export interface HostCodeOutputTransport {
  stdoutFd: number;
  stderrFd: number;
  closeWriters(): void;
  pause(): void;
  resume(): void;
  start(
    stdout: (chunk: Buffer) => void,
    stderr: (chunk: Buffer) => void,
  ): Promise<unknown>;
  dispose(): void;
}
export type HostCodeOutputTransportFactory =
  () => Promise<HostCodeOutputTransport>;
export interface HostCodeSdkAdapter {
  requiresNativeOutput?: boolean;
  applyFloor(
    options: SpawnRuntimeOptions,
    floor: HostStorageFloorDescriptor,
  ): SpawnRuntimeOptions;
  register(input: {
    generationId: string;
    createOutputTransport?: HostCodeOutputTransportFactory;
    resolveCurrentContext(
      request: HostCodeRequest,
      context: {
        signal: AbortSignal;
        callerSessionId: string;
        generationId: string;
      },
    ): Promise<HostCodeContext>;
  }): HostCodeRegistration;
  executionLimits(name: string, input: Record<string, unknown>): { timeoutMs: number; maxStreamedBytes: number };
  buildPwdCaptureScript(command: string, path: string): string;
  buildRunInputs(input: Record<string, unknown>): Record<string, unknown>;
  buildHookEntries?(config: unknown): Array<{ id: string }>;
  createHookStage?(input: Record<string, unknown>): {
    preToolUse(
      call: Record<string, unknown>,
      context: Record<string, unknown>,
    ): Promise<HostCodeHookDecision>;
  };
}
export function installedHostCodeAdapter(): HostCodeSdkAdapter | undefined {
  const client = sdk as unknown as Record<string, unknown>,
    server = runtime as unknown as Record<string, unknown>;
  if (
    client.MANDATORY_FLOOR_CONTRACT_VERSION !== 1 ||
    client.HOST_CODE_PROCESS_BROKER_VERSION !== 1 ||
    typeof client.applyMandatoryFloorToSpawnOptions !== "function" ||
    typeof server.createHostCodeProcessRegistration !== "function" ||
    typeof server.buildPwdCaptureScript !== "function" ||
    typeof server.buildHostSandboxRunInputs !== "function" ||
    server.HOST_CODE_EXECUTION_LIMITS_VERSION !== 1 ||
    typeof server.hostCodeExecutionLimitsFor !== "function"
  )
    return undefined;
  return {
    requiresNativeOutput: true,
    applyFloor:
      client.applyMandatoryFloorToSpawnOptions as HostCodeSdkAdapter["applyFloor"],
    register:
      server.createHostCodeProcessRegistration as HostCodeSdkAdapter["register"],
    executionLimits: server.hostCodeExecutionLimitsFor as HostCodeSdkAdapter["executionLimits"],
    buildPwdCaptureScript:
      server.buildPwdCaptureScript as HostCodeSdkAdapter["buildPwdCaptureScript"],
    buildRunInputs:
      server.buildHostSandboxRunInputs as HostCodeSdkAdapter["buildRunInputs"],
    buildHookEntries:
      server.buildHookEntriesFromConfig as HostCodeSdkAdapter["buildHookEntries"],
    createHookStage:
      server.createHostCodeHookStage as HostCodeSdkAdapter["createHookStage"],
  };
}
export const HOST_CODE_BINDING: unique symbol = Symbol(
  "winter.hostCodeBinding",
);
const HOST_CODE_RESOLVED_SPAWN: unique symbol = Symbol(
  "winter.hostCodeResolvedSpawn",
);
/** Trusted executable/env resolver. Floor application happens AFTER this callback, before the one actual spawn. */
export function withResolvedHostCodeSpawn(
  options: Options,
  resolveSpawn: (options: SpawnRuntimeOptions) => SpawnRuntimeOptions,
): Options {
  return Object.assign(options, { [HOST_CODE_RESOLVED_SPAWN]: resolveSpawn });
}
export type HostCodeAuthority = Pick<
  HostCodeBinding,
  | "policyRevision"
  | "authorize"
  | "immutableWorkflowWorker"
  | "recordPromptResult"
  | "forgetCall"
  | "dispose"
  | "buildHookContext"
>;
/** Host-only per-incarnation facts. The permission callback reads current daemon policy and grants.
 * It may not accept a runtime-authored approval or environment as an authorization result. */
export interface HostCodeBinding {
  home: string;
  sessionId: string;
  backendSessionId: string;
  allowedCwds: readonly string[];
  tempDir: string;
  outDir?: string;
  policyRevision(): string;
  authorize(
    invocation: HostCodeInvocation,
    cwd: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  recordPromptResult?(receipt: HostCodePromptReceipt): void;
  forgetCall?(callId: string): void;
  dispose?(): void;
  buildHookContext?(
    invocation: HostCodeInvocation,
    cwd: string,
  ): Record<string, unknown>;
  immutableWorkflowWorker?(
    runId: string,
    invocation: HostCodeInvocation,
  ):
    | {
        command: { file: string; args: string[] };
        home?: string;
        winterHome?: string;
      }
    | undefined;
}
export function withHostCodeBinding(
  options: Options,
  binding: HostCodeBinding,
): Options {
  return Object.assign(options, { [HOST_CODE_BINDING]: binding });
}
function bindingOf(options: Options): HostCodeBinding | undefined {
  return (options as { [HOST_CODE_BINDING]?: HostCodeBinding })[
    HOST_CODE_BINDING
  ];
}
function hasFloor(floor: HostStorageFloorDescriptor): boolean {
  return (
    floor.denyReadPaths.length +
      floor.denyReadRegexes.length +
      floor.denyWritePaths.length +
      floor.denyWriteRegexes.length >
    0
  );
}
function fingerprint(floor: HostStorageFloorDescriptor): string {
  return createHash("sha256").update(JSON.stringify(floor)).digest("hex");
}
function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new HostCodeUnavailable("cwd-not-absolute");
  let canonical: string;
  try {
    canonical = realpathSync(path);
    if (!lstatSync(canonical).isDirectory()) throw new Error();
  } catch {
    throw new HostCodeUnavailable("cwd-unavailable");
  }
  return canonical;
}
function sameInputCommand(
  invocation: HostCodeInvocation,
  request: HostCodeRequest,
): boolean {
  return (
    ["Bash", "Monitor"].includes(invocation.name) &&
    typeof invocation.input.command === "string" &&
    invocation.input.command === request.command
  );
}

export interface HostCodeGeneration {
  options: Options;
  readonly protectedStorage: boolean;
  generationId: string;
  observe(event: NewSessionEvent, runtimeToolName?: string): void;
  noteHook(input: unknown): void;
  /** Runs only after the existing host pre-hooks completed; absence of permission is no grant. */
  completeHook(input: unknown, signal: AbortSignal): Promise<void>;
  dispose(): void;
}
interface LiveGeneration {
  generation: HostCodeGeneration;
  stop: () => Promise<void>;
  processExit?: Promise<unknown>;
  floor: string;
  confirmed: boolean;
  descendantsConfirmed: boolean;
  unprotected: boolean;
  registration?: HostCodeRegistration;
}

/** One service per daemon; cross-home coordinator must collect equivalent enrollment receipts from
 * every participating daemon before provisioning. This service never materializes storage itself. */
export class HostCodeExecutionService {
  private readonly live = new Map<string, LiveGeneration>();
  private refreshing = false;
  private readonly enrolledSpawns = new WeakSet<SpawnClaudeCodeProcess>();
  private readonly embeddedSpawns = new WeakSet<SpawnClaudeCodeProcess>();
  private retiredUnprotected = false;
  private readonly retiredProtectedFloors = new Set<string>();
  private retiredFloorOverflow = false;
  constructor(
    readonly home: string,
    private readonly adapter:
      | HostCodeSdkAdapter
      | undefined
      | null = installedHostCodeAdapter(),
    private readonly spawn: SpawnClaudeCodeProcess = sdk.defaultSpawn,
    private readonly lifecycle?: {
      createOutputTransport?: HostCodeOutputTransportFactory;
      confirmDescendantsStopped?(generationId: string): Promise<boolean>;
      confirmRetiredDescendantsStopped?(): Promise<boolean>;
    },
  ) {}
  assertReady(home: string): void {
    if (resolve(home) !== resolve(this.home))
      throw new HostCodeUnavailable("foreign-service-home");
    if (this.refreshing)
      throw new HostCodeUnavailable("floor-refresh-in-progress");
    if (hasFloor(hostStorageFloorDescriptor(home))) {
      if (!this.adapter)
        throw new HostCodeUnavailable("sdk-floor-broker-capability-missing");
      if (
        this.adapter.requiresNativeOutput &&
        !this.lifecycle?.createOutputTransport
      )
        throw new HostCodeUnavailable("native-output-transport-missing");
    }
  }
  /** The router also has host-internal cold-resume paths; none may bypass generation enrollment. */
  protectedStorageActive(): boolean {
    return hasFloor(hostStorageFloorDescriptor(this.home));
  }
  assertQueryOptions(options: Options | undefined): void {
    this.assertReady(this.home);
    if (!hasFloor(hostStorageFloorDescriptor(this.home))) return;
    const spawn = options?.spawnClaudeCodeProcess;
    if (
      !spawn ||
      (!this.enrolledSpawns.has(spawn) && !this.embeddedSpawns.has(spawn))
    )
      throw new HostCodeUnavailable("query-generation-not-enrolled");
  }
  trustEmbeddedSpawn(spawn: SpawnClaudeCodeProcess): SpawnClaudeCodeProcess {
    this.embeddedSpawns.add(spawn);
    return spawn;
  }
  assertAuthority(authority: HostCodeAuthority | undefined): void {
    this.assertReady(this.home);
    if (hasFloor(hostStorageFloorDescriptor(this.home)) && !authority)
      throw new HostCodeUnavailable("host-policy-authority-missing");
  }
  enroll(input: {
    options: Options;
    sessionId: string;
    backendSessionId: string;
    generation: number;
    abort: AbortController;
    isCurrent: () => boolean;
    stop: () => Promise<void>;
  }): HostCodeGeneration {
    const binding = bindingOf(input.options),
      home = this.home;
    this.assertReady(home);
    if (this.refreshing)
      throw new HostCodeUnavailable("floor-refresh-in-progress");
    const floor = hostStorageFloorDescriptor(home);
    const required = hasFloor(floor);
    if (required && (!binding || !this.adapter))
      throw new HostCodeUnavailable("host-policy-or-sdk-capability-missing");
    if (
      binding &&
      (resolve(binding.home) !== resolve(home) ||
        binding.sessionId !== input.sessionId ||
        binding.backendSessionId !== input.backendSessionId)
    )
      throw new HostCodeUnavailable("foreign-host-session-binding");
    if (
      required &&
      (input.options as { executionPosture?: string }).executionPosture ===
        "confined-guest"
    )
      throw new HostCodeUnavailable("guest-host-delegation-denied");
    const id = `${input.sessionId}:${input.generation}:${randomUUID()}`,
      calls = new Map<string, HostCodeInvocation>(),
      usedCallIds = new Set<string>(),
      lineage = new Map<string, { call: HostCodeInvocation; policy: string }>(),
      admittedCalls = new Set<string>(),
      hooks = new Map<
        string,
        {
          cwd: string;
          policy: string;
          completed?: boolean;
          decision?: HostCodeHookDecision;
          effectiveInput?: Record<string, unknown>;
          responses?: Map<
            string,
            {
              input: Record<string, unknown>;
              promise: Promise<HookJSONOutput>;
              complete: boolean;
              result?: HookJSONOutput;
              error?: unknown;
            }
          >;
        }
      >(),
      threads = new Set<string>();
    const ancestryFor = (threadId: string): HostCodeCall[] => {
      const ancestors: HostCodeCall[] = [];
      let actor = threadId === "main" ? undefined : threadId;
      while (actor !== undefined) {
        const admitted = lineage.get(actor),
          ancestor = admitted?.call;
        if (
          !ancestor ||
          !["Agent", "Task"].includes(ancestor.name) ||
          admitted?.policy !== binding!.policyRevision() ||
          !threads.has(actor) ||
          ancestors.length >= 32 ||
          ancestors.some((previous) => previous.callId === actor)
        )
          throw new HostCodeUnavailable("descendant-authority-not-observed");
        ancestors.push(ancestor);
        actor = ancestor.threadId === "main" ? undefined : ancestor.threadId;
      }
      return ancestors;
    };
    let closed = false,
      invalidated = false,
      canonicalEnv: Record<string, string> | undefined,
      registration: HostCodeRegistration | undefined;
    const requireCurrent = () => {
      if (
        closed ||
        invalidated ||
        input.abort.signal.aborted ||
        !input.isCurrent() ||
        this.refreshing
      )
        throw new HostCodeUnavailable("stale-generation");
    };
    const originalPre = input.options.hooks?.PreToolUse ?? [];
    const needsHostHooks = required && originalPre.length > 0;
    if (
      needsHostHooks &&
      (!this.adapter?.buildHookEntries ||
        !this.adapter.createHookStage ||
        !binding?.buildHookContext)
    )
      throw new HostCodeUnavailable("host-hook-consumer-capability-missing");
    let replayHostHooks:
      | ((
          call: HostCodeInvocation,
          hook: NonNullable<ReturnType<typeof hooks.get>>,
          signal: AbortSignal,
        ) => Promise<void>)
      | undefined;
    const admitLineage = async (
      call: HostCodeInvocation,
      hook: NonNullable<ReturnType<typeof hooks.get>>,
      signal: AbortSignal,
      agentId?: string,
    ) => {
      if (!["Agent", "Task"].includes(call.name)) return;
      if (needsHostHooks) await replayHostHooks!(call, hook, signal);
      if (hook.decision?.decision === "deny" || hook.decision?.interrupt)
        return;
      const policy = hook.policy,
        cwd = canonicalDirectory(hook.cwd);
      if (binding!.policyRevision() !== policy) return;
      const ancestors = ancestryFor(call.threadId),
        effectiveInput = hook.effectiveInput ?? call.input;
      const admitted: HostCodeInvocation = {
        ...call,
        input: structuredClone(effectiveInput),
        ancestors,
        scope: {
          generationId: id,
          sessionId: input.backendSessionId,
          toolUseId: call.callId,
          ...(agentId === undefined ? {} : { agentId }),
          ...(call.threadId === "main"
            ? {}
            : { parentToolUseId: call.threadId }),
        },
        ...(hook.decision ? { preHookDecision: hook.decision } : {}),
      };
      const allowed = await binding!.authorize(admitted, cwd, signal);
      requireCurrent();
      if (
        signal.aborted ||
        calls.get(call.callId) !== call ||
        hooks.get(call.callId) !== hook ||
        binding!.policyRevision() !== policy ||
        (hook.effectiveInput ?? call.input) !== effectiveInput ||
        canonicalDirectory(hook.cwd) !== cwd ||
        ancestors.some(
          (ancestor) =>
            lineage.get(ancestor.callId)?.call !== ancestor ||
            !threads.has(ancestor.callId),
        )
      )
        throw new HostCodeUnavailable("lineage-changed-during-admission");
      if (allowed === true)
        lineage.set(call.callId, { call: admitted, policy });
    };
    if (required) {
      registration = this.adapter!.register({
        generationId: id,
        ...(this.lifecycle?.createOutputTransport
          ? { createOutputTransport: this.lifecycle.createOutputTransport }
          : {}),
        resolveCurrentContext: async (request, context) => {
          requireCurrent();
          if (
            context.signal.aborted ||
            context.generationId !== id ||
            context.callerSessionId !== input.backendSessionId ||
            request.generationId !== id ||
            request.sessionId !== input.backendSessionId
          )
            throw new HostCodeUnavailable("foreign-query-generation");
          const call = calls.get(request.toolUseId),
            hook = hooks.get(request.toolUseId);
          if (!call || !hook)
            throw new HostCodeUnavailable("unobserved-active-call");
          if (needsHostHooks)
            await replayHostHooks!(call, hook, context.signal);
          if (hook.decision?.decision === "deny" || hook.decision?.interrupt)
            throw new HostCodeUnavailable("host-pre-hook-denied");
          const effectiveCall: HostCodeInvocation = {
            ...call,
            input: hook.effectiveInput ?? call.input,
          };
          const parent = call.threadId === "main" ? undefined : call.threadId;
          if (
            request.parentToolUseId !== parent ||
            (parent !== undefined && !threads.has(parent))
          )
            throw new HostCodeUnavailable("foreign-descendant-call");
          const ancestors = ancestryFor(call.threadId);
          const scope: HostCodeContext["scope"] = {
            generationId: id,
            sessionId: input.backendSessionId,
            toolUseId: call.callId,
            ...(request.agentId === undefined
              ? {}
              : { agentId: request.agentId }),
            ...(parent === undefined ? {} : { parentToolUseId: parent }),
          };
          const invocation: HostCodeInvocation = {
            ...effectiveCall,
            ancestors,
            scope,
            ...(hook.decision ? { preHookDecision: hook.decision } : {}),
          };
          const cwd = canonicalDirectory(hook.cwd),
            claimed = canonicalDirectory(request.cwd);
          // A previously approved Code escape may have changed the runtime cwd. The
          // matching host hook supplies current cwd; it is evaluated by host authority below.
          // Starting directories remain the sandbox write roots, never inferred from this cwd.
          if (cwd !== claimed)
            throw new HostCodeUnavailable("cwd-outside-current-host-binding");
          if (binding!.policyRevision() !== hook.policy)
            throw new HostCodeUnavailable("permission-context-changed");
          if (
            request.kind === "command" &&
            !sameInputCommand(effectiveCall, request)
          )
            throw new HostCodeUnavailable("command-not-observed-call");
          if (
            request.kind === "workflow" &&
            (call.name !== "Workflow" || !request.workflowRunId)
          )
            throw new HostCodeUnavailable("workflow-not-observed-call");
          if (!canonicalEnv)
            throw new HostCodeUnavailable("spawn-environment-unobserved");
          if (admittedCalls.has(call.callId))
            throw new HostCodeUnavailable("call-already-admitted");
          if (
            (await binding!.authorize(invocation, cwd, context.signal)) !== true
          )
            throw new HostCodeUnavailable("current-permission-denied");
          requireCurrent();
          if (admittedCalls.has(call.callId))
            throw new HostCodeUnavailable("call-already-admitted");
          if (
            calls.get(call.callId) !== call ||
            hooks.get(call.callId) !== hook ||
            (hook.effectiveInput ?? call.input) !== effectiveCall.input ||
            context.signal.aborted ||
            ancestors.some(
              (ancestor) =>
                lineage.get(ancestor.callId)?.call !== ancestor ||
                !threads.has(ancestor.callId),
            ) ||
            binding!.policyRevision() !== hook.policy
          )
            throw new HostCodeUnavailable(
              "call-or-policy-changed-during-admission",
            );
          if (
            canonicalDirectory(hook.cwd) !== cwd ||
            canonicalDirectory(request.cwd) !== claimed
          )
            throw new HostCodeUnavailable("cwd-changed-during-admission");
          const latest = hostStorageFloorDescriptor(binding!.home);
          if (fingerprint(latest) !== fingerprint(floor))
            throw new HostCodeUnavailable("floor-generation-stale");
          const env = {
            ...canonicalEnv,
            TMPDIR: binding!.tempDir,
            ...(binding!.outDir ? { OUTDIR: binding!.outDir } : {}),
          };
          const options = this.adapter!.buildRunInputs({
            cwd,
            env,
            settings: input.options.sandbox ?? {},
            writableRoots: [
              ...binding!.allowedCwds,
              binding!.tempDir,
              ...(binding!.outDir ? [binding!.outDir] : []),
            ],
            home: canonicalEnv.HOME ?? binding!.home,
            winterHome: canonicalEnv.WINTER_HOME,
            storeHome: canonicalEnv.WINTER_STORE_HOME,
          });
          const limits = this.adapter!.executionLimits(call.name, effectiveCall.input);
          const admittedTimeout = limits.timeoutMs, admittedOutput = limits.maxStreamedBytes;
          if (
            !Number.isFinite(request.timeoutMs) ||
            request.timeoutMs !== admittedTimeout ||
            request.maxStreamedBytes !== admittedOutput
          )
            throw new HostCodeUnavailable("execution-limits-not-admitted");
          const escape = effectiveCall.input.dangerouslyDisableSandbox === true;
          if ((request.sandboxIntent === "override-requested") !== escape)
            throw new HostCodeUnavailable("sandbox-intent-not-observed-call");
          const result: HostCodeContext = {
            scope,
            commandOptions: {
              ...options,
              timeoutMs: admittedTimeout,
              maxStreamedBytes: admittedOutput,
              ...(escape ? { dangerouslyDisableSandbox: true } : {}),
            },
            floor,
          };
          if (request.pwdCapturePath !== undefined) {
            if (
              call.name !== "Bash" ||
              effectiveCall.input.run_in_background === true ||
              !isAbsolute(request.pwdCapturePath) ||
              dirname(resolve(request.pwdCapturePath)) !==
                canonicalDirectory(binding!.tempDir) ||
              !/^\.bash-cwd-[0-9a-f-]{36}$/.test(
                basename(request.pwdCapturePath),
              )
            )
              throw new HostCodeUnavailable("pwd-capture-path-not-admitted");
            try {
              const st = lstatSync(request.pwdCapturePath);
              if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)
                throw new HostCodeUnavailable("pwd-capture-alias");
            } catch (error) {
              if (error instanceof HostCodeUnavailable) throw error;
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw new HostCodeUnavailable("pwd-capture-unavailable");
            }
            result.executionCommand = this.adapter!.buildPwdCaptureScript(
              request.command!,
              request.pwdCapturePath,
            );
          }
          if (request.kind === "workflow") {
            const worker = binding!.immutableWorkflowWorker?.(
              request.workflowRunId!,
              invocation,
            );
            if (!worker)
              throw new HostCodeUnavailable(
                "immutable-workflow-worker-unavailable",
              );
            result.workflow = {
              ...worker,
              command: {
                file: worker.command.file,
                args: [...worker.command.args],
              },
            };
          }
          admittedCalls.add(call.callId);
          return result;
        },
      });
    }
    const entry: LiveGeneration = {
      generation: undefined as unknown as HostCodeGeneration,
      stop: input.stop,
      floor: fingerprint(floor),
      confirmed: false,
      descendantsConfirmed: false,
      unprotected: !required,
      registration,
    };
    const prune = () => {
      if (!closed || (entry.processExit && !entry.confirmed)) return;
      if (
        entry.processExit &&
        entry.registration &&
        !entry.descendantsConfirmed
      )
        return;
      if (entry.processExit) {
        if (entry.unprotected) this.retiredUnprotected = true;
        else if (this.retiredProtectedFloors.size < 1024)
          this.retiredProtectedFloors.add(entry.floor);
        else this.retiredFloorOverflow = true;
      }
      this.live.delete(id);
    };
    const drainConfirmed = (receipt: HostCodeDrainEvidence) =>
      receipt.status === "confirmed" &&
      receipt.generationId === id &&
      receipt.coverage === "registered-process-close-only" &&
      Number.isSafeInteger(receipt.confirmedProcessCount) &&
      receipt.confirmedProcessCount >= 0;
    void registration?.drained?.then(
      (receipt) => {
        entry.descendantsConfirmed = drainConfirmed(receipt);
        if (entry.descendantsConfirmed) prune();
      },
      () => {},
    );
    const resolveSpawn = (
      input.options as {
        [HOST_CODE_RESOLVED_SPAWN]?: (
          options: SpawnRuntimeOptions,
        ) => SpawnRuntimeOptions;
      }
    )[HOST_CODE_RESOLVED_SPAWN];
    const previousSpawn = input.options.spawnClaudeCodeProcess;
    if (
      required &&
      !resolveSpawn &&
      previousSpawn !== undefined &&
      previousSpawn !== this.spawn
    )
      throw new HostCodeUnavailable("opaque-spawn-hook-cannot-preserve-floor");
    const wrapped: SpawnClaudeCodeProcess = (options) => {
      requireCurrent();
      const resolved = resolveSpawn ? resolveSpawn(options) : options;
      canonicalEnv = { ...resolved.env };
      const actual = required
        ? this.adapter!.applyFloor(resolved, floor)
        : resolved;
      const process = (
        resolveSpawn ? this.spawn : (previousSpawn ?? this.spawn)
      )(actual);
      entry.processExit = process.exited;
      void process.exited.then(
        () => {
          entry.confirmed = true;
          prune();
        },
        () => {
          entry.confirmed = false;
        },
      );
      return process;
    };
    const options = {
      ...input.options,
      spawnClaudeCodeProcess: wrapped,
      ...(registration ? { hostCodeProcessBroker: registration } : {}),
    } as Options;
    const canUseTool = input.options.canUseTool;
    if (required && canUseTool)
      options.canUseTool = async (toolName, toolInput, context) => {
        requireCurrent();
        if (
          !["Bash", "Monitor", "Workflow", "Agent", "Task"].includes(toolName)
        )
          return canUseTool(toolName, toolInput, context);
        const call = calls.get(context.toolUseID),
          hook = hooks.get(context.toolUseID);
        if (call && hook && needsHostHooks)
          await replayHostHooks!(call, hook, context.signal);
        if (
          !call ||
          !hook ||
          call.name !== toolName ||
          canonicalHostJson(hook.effectiveInput ?? call.input) !==
            canonicalHostJson(toolInput)
        )
          throw new HostCodeUnavailable("prompt-call-not-observed");
        const revision = binding!.policyRevision(),
          cwd = canonicalDirectory(hook.cwd);
        if (hook.decision?.decision === "deny")
          throw new HostCodeUnavailable("host-pre-hook-denied");
        const actualContext =
          hook.decision?.decision === "ask" && hook.decision.message
            ? { ...context, decisionReason: hook.decision.message }
            : context;
        lineage.delete(call.callId);
        const result = await canUseTool(toolName, toolInput, actualContext);
        requireCurrent();
        if (
          context.signal.aborted ||
          calls.get(call.callId) !== call ||
          hooks.get(call.callId) !== hook ||
          hook.policy !== revision ||
          binding!.policyRevision() !== revision ||
          canonicalDirectory(hook.cwd) !== cwd
        )
          throw new HostCodeUnavailable("host-prompt-context-changed");
        if (
          result?.behavior === "allow" &&
          !context.signal.aborted &&
          calls.get(call.callId) === call &&
          hooks.get(call.callId) === hook &&
          hook.policy === revision &&
          binding!.policyRevision() === revision &&
          canonicalDirectory(hook.cwd) === cwd
        ) {
          const approvedInput = structuredClone(
            result.updatedInput ?? toolInput,
          );
          hook.effectiveInput = approvedInput;
          if (hook.decision?.transformedInput)
            hook.decision = {
              ...hook.decision,
              transformedInput: approvedInput,
            };
          binding!.recordPromptResult?.({
            generationId: id,
            sessionId: input.backendSessionId,
            toolUseId: call.callId,
            threadId: call.threadId,
            toolName,
            ...(context.agentID === undefined
              ? {}
              : { agentId: context.agentID }),
            input: approvedInput,
            cwd,
            policyRevision: revision,
            ancestors: ancestryFor(call.threadId),
            ...(hook.decision ? { preHookDecision: hook.decision } : {}),
            result,
          });
          await admitLineage(call, hook, context.signal, context.agentID);
        }
        return result;
      };
    const generation: HostCodeGeneration = {
      options,
      generationId: id,
      protectedStorage: required,
      observe: (event, runtimeToolName) => {
        if (!required || closed) return;
        try {
          if (event.sessionId !== input.sessionId)
            throw new HostCodeUnavailable("foreign-projected-session");
          if (event.type === "thread_started") threads.add(event.threadId);
          else if (event.type === "thread_completed") {
            threads.delete(event.threadId);
            lineage.delete(event.threadId);
            for (const [callId, call] of calls)
              if (call.threadId === event.threadId) {
                calls.delete(callId);
                hooks.delete(callId);
                admittedCalls.delete(callId);
                binding?.forgetCall?.(callId);
              }
          } else if (
            event.type === "tool_call" &&
            ["Bash", "Monitor", "Workflow", "Agent", "Task"].includes(runtimeToolName ?? event.name)
          ) {
            const name = runtimeToolName ?? event.name;
            if (runtimeToolName !== undefined && (hostToolNameFor(name) ?? name) !== event.name) throw new HostCodeUnavailable("projected-tool-name-mismatch");
            if (
              usedCallIds.has(event.callId) ||
              usedCallIds.size >= 16384 ||
              calls.size >= 512 ||
              lineage.size >= 512 ||
              event.argsJson.length > 262144
            ) {
              throw new HostCodeUnavailable("ambiguous-or-unbounded-tool-calls");
            }
            let data: unknown;
            try {
              data = JSON.parse(event.argsJson);
            } catch {
              throw new HostCodeUnavailable("tool-call-input-invalid");
            }
            if (!data || typeof data !== "object" || Array.isArray(data))
              throw new HostCodeUnavailable("tool-call-input-invalid");
            usedCallIds.add(event.callId);
            calls.set(event.callId, {
              callId: event.callId,
              threadId: event.threadId,
              name,
              input: data as Record<string, unknown>,
            });
          } else if (event.type === "tool_result") {
            calls.delete(event.callId);
            hooks.delete(event.callId);
            admittedCalls.delete(event.callId);
            binding?.forgetCall?.(event.callId);
          }
        } catch (error) { invalidated = true; throw error; }
      },
      noteHook: (value) => {
        if (!required) return;
        requireCurrent();
        const pre = value as {
          session_id?: unknown;
          tool_use_id?: unknown;
          tool_name?: unknown;
          cwd?: unknown;
        };
        if (
          !["Bash", "Monitor", "Workflow", "Agent", "Task"].includes(
            String(pre.tool_name),
          )
        )
          return;
        if (
          typeof pre.tool_use_id !== "string" ||
          !calls.has(pre.tool_use_id) ||
          calls.get(pre.tool_use_id)!.name !== pre.tool_name ||
          pre.session_id !== input.backendSessionId ||
          typeof pre.cwd !== "string"
        )
          throw new HostCodeUnavailable("hook-call-not-authenticated");
        const previous = hooks.get(pre.tool_use_id),
          policy = binding!.policyRevision();
        if (previous && previous.cwd === pre.cwd && previous.policy === policy)
          return;
        hooks.set(pre.tool_use_id, {
          cwd: pre.cwd,
          policy,
          completed: !needsHostHooks,
        });
      },
      completeHook: async (value, signal) => {
        generation.noteHook(value);
        if (!required) return;
        const callId = (value as { tool_use_id?: string }).tool_use_id;
        const call = callId === undefined ? undefined : calls.get(callId);
        const hook = callId === undefined ? undefined : hooks.get(callId);
        if (!call || !hook)
          throw new HostCodeUnavailable("hook-call-not-authenticated");
        await admitLineage(call, hook, signal);
      },
      dispose: () => {
        if (closed) return;
        closed = true;
        registration?.dispose?.();
        registration?.stopAll?.();
        calls.clear();
        lineage.clear();
        usedCallIds.clear();
        hooks.clear();
        admittedCalls.clear();
        binding?.dispose?.();
        threads.clear();
        prune();
      },
    };
    if (needsHostHooks) {
      const entries = this.adapter!.buildHookEntries!({
        PreToolUse: originalPre.map((group) => ({
          source: "sdk",
          hookCount: group.hooks.length,
          ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
          ...(group.timeout === undefined ? {} : { timeoutSec: group.timeout }),
          ...(group.failClosed ? { failClosed: true } : {}),
        })),
      });
      let callbackIndex = 0;
      options.hooks = {
        ...options.hooks,
        PreToolUse: originalPre.map((group) => ({
          ...group,
          hooks: group.hooks.map((callback) => {
            const hookId = entries[callbackIndex++]!.id;
            return async (value, toolUseId, callbackContext) => {
              const pre = value as unknown as {
                tool_use_id: string;
                tool_name: string;
                tool_input: Record<string, unknown>;
                cwd: string;
              };
              if (
                !["Bash", "Monitor", "Workflow", "Agent", "Task"].includes(
                  pre.tool_name,
                )
              )
                return callback(value, toolUseId, callbackContext);
              generation.noteHook(value);
              const call = calls.get(pre.tool_use_id),
                hook = hooks.get(pre.tool_use_id);
              if (!call || !hook || toolUseId !== call.callId)
                throw new HostCodeUnavailable(
                  "host-pre-hook-call-not-observed",
                );
              hook.responses ??= new Map();
              const existing = hook.responses.get(hookId);
              if (existing) {
                if (
                  canonicalHostJson(existing.input) !==
                  canonicalHostJson(pre.tool_input)
                )
                  throw new HostCodeUnavailable("host-pre-hook-input-changed");
                return existing.promise;
              }
              const record = {
                input: structuredClone(pre.tool_input),
                complete: false,
                promise: undefined as unknown as Promise<HookJSONOutput>,
                result: undefined as HookJSONOutput | undefined,
                error: undefined as unknown,
              };
              record.promise = (async () => {
                try {
                  const result = await callback(
                    value,
                    toolUseId,
                    callbackContext,
                  );
                  record.result = structuredClone(result);
                  return result;
                } catch (error) {
                  record.error = error;
                  throw error;
                } finally {
                  record.complete = true;
                }
              })();
              hook.responses.set(hookId, record);
              return record.promise;
            };
          }),
        })),
      };
      replayHostHooks = async (call, hook, signal) => {
        if (hook.completed) return;
        const policy = hook.policy,
          cwd = canonicalDirectory(hook.cwd);
        const scope: HostCodeContext["scope"] = {
          generationId: id,
          sessionId: input.backendSessionId,
          toolUseId: call.callId,
          ...(call.threadId === "main"
            ? {}
            : { parentToolUseId: call.threadId }),
        };
        const invocation: HostCodeInvocation = {
          ...call,
          scope,
          ancestors: ancestryFor(call.threadId),
        };
        const context = binding!.buildHookContext!(invocation, cwd);
        let pending = false,
          invalid = false;
        const stage = this.adapter!.createHookStage!({
          entries,
          sessionId: input.backendSessionId,
          trustedWorkspace: true,
          invoker: {
            invoke: async (request: {
              hookId: string;
              input?: Record<string, unknown>;
            }) => {
              const record = hook.responses?.get(request.hookId);
              if (!record?.complete) {
                pending = true;
                throw new HostCodeUnavailable("host-pre-hooks-pending");
              }
              if (
                canonicalHostJson(record.input) !==
                canonicalHostJson(request.input ?? call.input)
              ) {
                invalid = true;
                throw new HostCodeUnavailable(
                  "host-pre-hook-input-not-observed",
                );
              }
              if (record.error !== undefined) throw record.error;
              return record.result;
            },
          },
        });
        const decision = await stage.preToolUse(
          { toolName: call.name, input: call.input, toolUseId: call.callId },
          { ...context, signal },
        );
        requireCurrent();
        if (pending) throw new HostCodeUnavailable("host-pre-hooks-pending");
        if (invalid)
          throw new HostCodeUnavailable("host-pre-hook-input-not-observed");
        if (
          signal.aborted ||
          hooks.get(call.callId) !== hook ||
          calls.get(call.callId) !== call ||
          binding!.policyRevision() !== policy ||
          canonicalDirectory(hook.cwd) !== cwd
        )
          throw new HostCodeUnavailable("host-pre-hook-context-changed");
        hook.decision = decision;
        hook.effectiveInput = structuredClone(decision.transformedInput ?? call.input);
        hook.completed = true;
      };
    }
    this.enrolledSpawns.add(options.spawnClaudeCodeProcess!);
    entry.generation = generation;
    this.live.set(id, entry);
    return generation;
  }
  /** Called only with an empty/new or already protected root. Sensitive files are created afterward by
   * the storage service, which must also obtain enrollment acknowledgments from other daemons. */
  async refreshForStorage(
    home: string,
    options: HostStorageFenceOptions,
    timeoutMs = 5000,
  ): Promise<() => void> {
    if (resolve(home) !== resolve(this.home))
      throw new HostCodeUnavailable("foreign-service-home");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new HostCodeUnavailable("invalid-refresh-deadline");
    if (this.refreshing)
      throw new HostCodeUnavailable("floor-refresh-in-progress");
    if (!this.adapter)
      throw new HostCodeUnavailable("sdk-floor-broker-capability-missing");
    this.refreshing = true;
    let unregister: (() => void) | undefined;
    try {
      unregister = registerHostStorageFences(home, options);
      const deadline = Date.now() + timeoutMs;
      const targetFloor = fingerprint(hostStorageFloorDescriptor(this.home));
      for (const entry of this.live.values()) {
        entry.generation.dispose();
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new HostCodeUnavailable("old-code-stop-unconfirmed");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const draining = (async () => {
          await entry.stop();
          if (!entry.processExit)
            throw new HostCodeUnavailable("old-code-process-unobserved");
          await entry.processExit;
          // A parent PID exit or a kill request is not a descendant-stop receipt.
          if (entry.unprotected || entry.floor !== targetFloor) {
            if (
              !this.lifecycle?.confirmDescendantsStopped ||
              (await this.lifecycle.confirmDescendantsStopped(
                entry.generation.generationId,
              )) !== true
            )
              throw new HostCodeUnavailable("old-code-descendants-unconfirmed");
          } else if (entry.registration) {
            if (!entry.registration.drained)
              throw new HostCodeUnavailable("broker-descendants-unconfirmed");
            const receipt = await entry.registration.drained;
            if (
              receipt.status !== "confirmed" ||
              receipt.generationId !== entry.generation.generationId ||
              receipt.coverage !== "registered-process-close-only"
            )
              throw new HostCodeUnavailable("broker-descendants-unconfirmed");
          }
          return true;
        })();
        let confirmed: boolean;
        try {
          confirmed = await Promise.race([
            draining,
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), remaining);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!confirmed)
          throw new HostCodeUnavailable("old-code-stop-unconfirmed");
      }
      if (
        this.retiredUnprotected ||
        this.retiredFloorOverflow ||
        [...this.retiredProtectedFloors].some((floor) => floor !== targetFloor)
      ) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new HostCodeUnavailable("old-code-stop-unconfirmed");
        if (!this.lifecycle?.confirmRetiredDescendantsStopped)
          throw new HostCodeUnavailable("retired-code-descendants-unconfirmed");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const receipt = await Promise.race([
            this.lifecycle.confirmRetiredDescendantsStopped(),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), remaining);
            }),
          ]);
          if (receipt !== true)
            throw new HostCodeUnavailable(
              "retired-code-descendants-unconfirmed",
            );
        } finally {
          if (timer) clearTimeout(timer);
        }
        this.retiredUnprotected = false;
        this.retiredProtectedFloors.clear();
        this.retiredFloorOverflow = false;
      }
      this.live.clear();
      return unregister;
    } catch (error) {
      unregister?.();
      throw error;
    } finally {
      this.refreshing = false;
    }
  }
}
