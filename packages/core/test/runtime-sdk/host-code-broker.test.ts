import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SpawnClaudeCodeProcess,
  SpawnRuntimeOptions,
} from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import {
  HostCodeExecutionService,
  installedHostCodeAdapter,
  HostCodeUnavailable,
  withHostCodeBinding,
  withResolvedHostCodeSpawn,
  type HostCodeBinding,
  type HostCodeRequest,
  type HostCodeSdkAdapter,
} from "../../src/runtime-sdk/host-code-broker";
import {
  hostStorageFloorDescriptor,
  registerHostStorageFences,
  registerHostStoragePolicyConsumer,
} from "../../src/runtime-sdk/host-storage-fence";
let root: string,
  home: string,
  source: string,
  temp: string,
  coordination: string,
  unregister: (() => void) | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "winter-core-broker-")));
  home = join(root, "home");
  source = join(root, "source");
  temp = join(root, "temp");
  coordination = join(root, "coordination");
  for (const path of [home, source, temp, coordination]) mkdirSync(path);
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
  rmSync(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture({
  active = true,
  ownedBridge = true,
  withBinding = true,
  authorize = async () => true,
  stop = async () => {},
} = {}) {
  if (active) {
    mkdirSync(join(home, "cowork"));
    unregister = registerHostStorageFences(home, {
      coordinationDir: coordination,
      coworkStorageActive: true,
    });
  }
  let resolver!: Parameters<
      HostCodeSdkAdapter["register"]
    >[0]["resolveCurrentContext"],
    disposed = 0,
    revision = "policy-a",
    spawned: SpawnRuntimeOptions | undefined;
  const applied: SpawnRuntimeOptions[] = [],
    exited = deferred<number>();
  const adapter: HostCodeSdkAdapter = {
    register(input) {
      resolver = input.resolveCurrentContext;
      return {
        generationId: input.generationId,
        dispose() {
          disposed++;
        },
        drained: Promise.resolve({
          status: "confirmed" as const,
          generationId: input.generationId,
          coverage: "registered-process-close-only" as const,
          confirmedProcessCount: 0,
        }),
        async handle() {
          return {};
        },
      };
    },
    applyFloor(options, floor) {
      expect(floor.denyWritePaths).toContain(join(home, "cowork"));
      applied.push(options);
      return { ...options, command: "floor-exec" };
    },
    // Fixture adapter contract. Production consumes the SDK-owned selector, tested by the
    // explicit real-SDK ordering/limits fixture rather than duplicating constants in Core.
    executionLimits: (name, input) => ({
      timeoutMs: name === "Workflow" ? 0 : name === "Monitor" ? input.persistent === true ? 2147483647 : Number(input.timeout_ms) : Math.min(typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : 120000, 600000),
      maxStreamedBytes: 5 * 1024 ** 3,
    }),
    buildPwdCaptureScript: (command, path) => `host-wrapper:${command}:${path}`,
    buildRunInputs: (input) => input,
  };
  const spawn: SpawnClaudeCodeProcess = (options) => {
    spawned = options;
    return {
      exited: exited.promise,
    } as unknown as ReturnType<SpawnClaudeCodeProcess>;
  };
  const service = new HostCodeExecutionService(home, adapter, spawn),
    abort = new AbortController();
  const binding: HostCodeBinding = {
    home,
    sessionId: "logical",
    backendSessionId: "backend",
    allowedCwds: [source],
    tempDir: temp,
    policyRevision: () => revision,
    authorize,
  };
  const base = { sandbox: { enabled: false } } as Options,
    options = withBinding ? withHostCodeBinding(base, binding) : base;
  const enroll = (opts = options) =>
    service.enroll({
      ...(ownedBridge ? { ownedBridge: true as const } : {}),
      options: opts,
      sessionId: "logical",
      backendSessionId: "backend",
      generation: 1,
      abort,
      isCurrent: () => true,
      stop,
    });
  const spawnGeneration = (g: ReturnType<typeof enroll>) =>
    g.options.spawnClaudeCodeProcess!({
      command: "resolved-winter",
      args: [],
      cwd: source,
      env: {
        HOME: home,
        WINTER_HOME: "private-run",
        WINTER_STORE_HOME: "private-store",
        SECRET_CONTEXT: "host-owned",
      },
      signal: abort.signal,
    } as unknown as SpawnRuntimeOptions);
  const call = (
    g: ReturnType<typeof enroll>,
    threadId = "main",
    name = "Bash",
    input: Record<string, unknown> = { command: "cat note" },
  ) => {
    g.observe({
      type: "tool_call",
      sessionId: "logical",
      callId: "call",
      threadId,
      name,
      argsJson: JSON.stringify(input),
    } as NewSessionEvent);
    g.noteHook({
      tool_name: name,
      tool_use_id: "call",
      session_id: "backend",
      cwd: source,
    });
  };
  const resolve = (
    g: ReturnType<typeof enroll>,
    extra: Partial<HostCodeRequest> = {},
    callerSessionId = "backend",
  ) =>
    resolver(
      {
        version: 1,
        generationId: g.generationId,
        sessionId: "backend",
        toolUseId: "call",
        kind: "command",
        cwd: source,
        command: "cat note",
        timeoutMs: 120000,
        maxStreamedBytes: 5 * 1024 ** 3,
        sandboxIntent: "ordinary",
        ...extra,
      },
      { signal: abort.signal, callerSessionId, generationId: g.generationId },
    );
  return {
    service,
    enroll,
    spawnGeneration,
    call,
    resolve,
    binding,
    options,
    adapter,
    abort,
    exited,
    applied,
    get spawned() {
      return spawned;
    },
    get disposed() {
      return disposed;
    },
    setRevision(value: string) {
      revision = value;
    },
  };
}
test("explicit owned bridge requires binding while ordinary Code needs no broker capability", () => {
  const f = fixture({ withBinding: false });
  expect(() => f.enroll()).toThrow(HostCodeUnavailable);
  expect(() =>
    new HostCodeExecutionService(home, null).assertReady(home),
  ).not.toThrow();
  expect(() => f.service.assertReady(source)).toThrow("foreign-service-home");
});
test("explicit owned bridge refuses inactive storage before launch rather than becoming an ordinary unprotected child", async () => {
  const f = fixture({ active: false, ownedBridge: true });
  expect(() => f.enroll()).toThrow("owned-bridge-floor-unavailable");
  expect(f.applied).toHaveLength(0);
  expect(f.spawned).toBeUndefined();
  // No failed-enrollment live/retired entry may later disappear through ordinary activation.
  mkdirSync(join(home, "cowork"));
  const remove = await f.service.refreshForStorage(home, { coordinationDir: coordination, coworkStorageActive: true });
  try { const bridge = f.enroll(); expect(bridge.protectedStorage).toBe(true); f.spawnGeneration(bridge); expect(f.applied).toHaveLength(1); bridge.dispose(); }
  finally { remove(); f.exited.resolve(0); }
});
test("inactive unregistered Code preserves resolved spawn posture", () => {
  const f = fixture({ active: false, ownedBridge: false, withBinding: false }),
    g = f.enroll();
  f.spawnGeneration(g);
  expect(f.applied).toHaveLength(0);
  expect(f.spawned?.command).toBe("resolved-winter");
  g.dispose();
  f.exited.resolve(0);
});
test("executable and environment resolution precede floor and spawn", () => {
  const f = fixture(),
    g = f.enroll(
      withResolvedHostCodeSpawn(f.options, (options) => ({
        ...options,
        command: "host-resolved-runtime",
        env: { ...options.env, RESOLVED_ENV: "trusted" },
      })),
    );
  f.spawnGeneration(g);
  expect(f.applied[0]?.command).toBe("host-resolved-runtime");
  expect(f.applied[0]?.env.RESOLVED_ENV).toBe("trusted");
  expect(f.spawned?.command).toBe("floor-exec");
  g.dispose();
  f.exited.resolve(0);
});
test("admission binds exact query/input/cwd/policy and host environment", async () => {
  const f = fixture(),
    g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  await expect(f.resolve(g, {}, "foreign")).rejects.toThrow(
    "foreign-query-generation",
  );
  await expect(f.resolve(g, { command: "cat control" })).rejects.toThrow(
    "command-not-observed",
  );
  await expect(f.resolve(g, { cwd: temp })).rejects.toThrow("cwd-outside");
  await expect(f.resolve(g, { timeoutMs: 600000 })).rejects.toThrow(
    "limits-not-admitted",
  );
  await expect(
    f.resolve(g, { sandboxIntent: "override-requested" }),
  ).rejects.toThrow("intent-not-observed");
  const result = await f.resolve(g);
  expect(result.commandOptions.env).toEqual({
    HOME: home,
    WINTER_HOME: "private-run",
    WINTER_STORE_HOME: "private-store",
    SECRET_CONTEXT: "host-owned",
    TMPDIR: temp,
  });
  expect(result.commandOptions.settings).toEqual({ enabled: false });
  expect(result.floor).toEqual(hostStorageFloorDescriptor(home));
  await expect(f.resolve(g)).rejects.toThrow("call-already-admitted");
  f.setRevision("changed");
  await expect(f.resolve(g)).rejects.toThrow("permission-context-changed");
  g.dispose();
  f.exited.resolve(0);
});
test("nested descendant matches immediate tracked thread", async () => {
  const f = fixture(),
    g = f.enroll();
  f.spawnGeneration(g);
  g.observe({
    type: "tool_call",
    sessionId: "logical",
    callId: "outer-call",
    threadId: "main",
    name: "Agent",
    argsJson: JSON.stringify({ subagent_type: "general-purpose" }),
  } as NewSessionEvent);
  await g.completeHook(
    {
      tool_name: "Agent",
      tool_use_id: "outer-call",
      session_id: "backend",
      cwd: source,
    },
    f.abort.signal,
  );
  g.observe({
    type: "thread_started",
    sessionId: "logical",
    threadId: "outer-call",
  } as NewSessionEvent);
  g.observe({
    type: "tool_call",
    sessionId: "logical",
    callId: "inner-call",
    threadId: "outer-call",
    name: "Agent",
    argsJson: JSON.stringify({ subagent_type: "general-purpose" }),
  } as NewSessionEvent);
  await g.completeHook(
    {
      tool_name: "Agent",
      tool_use_id: "inner-call",
      session_id: "backend",
      cwd: source,
    },
    f.abort.signal,
  );
  g.observe({
    type: "thread_started",
    sessionId: "logical",
    threadId: "inner-call",
  } as NewSessionEvent);
  f.call(g, "inner-call");
  expect(
    (await f.resolve(g, { parentToolUseId: "inner-call", agentId: "advisory" }))
      .scope.parentToolUseId,
  ).toBe("inner-call");
  await expect(f.resolve(g, { parentToolUseId: "outer-call" })).rejects.toThrow(
    "foreign-descendant",
  );
  g.observe({
    type: "thread_completed",
    sessionId: "logical",
    threadId: "inner-call",
  } as NewSessionEvent);
  await expect(f.resolve(g, { parentToolUseId: "inner-call" })).rejects.toThrow(
    "unobserved-active",
  );
  g.dispose();
  f.exited.resolve(0);
});
test("policy changes while host permission awaits invalidate admission", async () => {
  const permission = deferred<boolean>(),
    f = fixture({ authorize: () => permission.promise }),
    g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  const pending = f.resolve(g);
  f.setRevision("new-policy");
  permission.resolve(true);
  await expect(pending).rejects.toThrow("call-or-policy-changed");
  g.dispose();
  f.exited.resolve(0);
});
test("host rebuilds pwd capture and rejects aliases/outside scratch", async () => {
  const f = fixture(),
    g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  const path = join(temp, ".bash-cwd-11111111-1111-1111-1111-111111111111");
  symlinkSync(join(source, "note"), path);
  await expect(f.resolve(g, { pwdCapturePath: path })).rejects.toThrow(
    "pwd-capture-alias",
  );
  await expect(
    f.resolve(g, {
      pwdCapturePath: join(
        source,
        ".bash-cwd-11111111-1111-1111-1111-111111111111",
      ),
    }),
  ).rejects.toThrow("path-not-admitted");
  rmSync(path);
  expect((await f.resolve(g, { pwdCapturePath: path })).executionCommand).toBe(
    `host-wrapper:cat note:${path}`,
  );
  g.dispose();
  f.exited.resolve(0);
});
test("Workflow derives immutable host worker and binds run", async () => {
  const f = fixture();
  f.binding.immutableWorkflowWorker = (runId, call) =>
    runId === "known" && call.callId === "call"
      ? {
          command: {
            file: "/trusted/runtime",
            args: ["__workflow-worker", "--bridge"],
          },
          home,
        }
      : undefined;
  const g = f.enroll();
  f.spawnGeneration(g);
  f.call(g, "main", "Workflow", { action: "run" });
  await expect(
    f.resolve(g, {
      kind: "workflow",
      command: undefined,
      workflowRunId: "other",
      timeoutMs: 0,
    }),
  ).rejects.toThrow("immutable-workflow");
  expect(
    (
      await f.resolve(g, {
        kind: "workflow",
        command: undefined,
        workflowRunId: "known",
        timeoutMs: 0,
      })
    ).workflow?.command.file,
  ).toBe("/trusted/runtime");
  g.dispose();
  f.exited.resolve(0);
});
test("terminal call and disposed generation cannot replay", async () => {
  const f = fixture(),
    g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  g.observe({
    type: "tool_result",
    sessionId: "logical",
    callId: "call",
  } as NewSessionEvent);
  await expect(f.resolve(g)).rejects.toThrow("unobserved-active");
  g.dispose();
  await expect(f.resolve(g)).rejects.toThrow("stale-generation");
  expect(f.disposed).toBeGreaterThan(0);
  f.exited.resolve(0);
});
test("ordinary live children do not require stop/descendant receipts for storage activation", async () => {
  const f = fixture({ active: false, ownedBridge: false, stop: () => new Promise<void>(() => {}) }), g = f.enroll();
  f.spawnGeneration(g); mkdirSync(join(home, "cowork"));
  const start = Date.now();
  const remove = await f.service.refreshForStorage(home, { coordinationDir: coordination, coworkStorageActive: true }, 25);
  try { expect(Date.now() - start).toBeLessThan(500); expect(hostStorageFloorDescriptor(home).denyReadPaths.length).toBeGreaterThan(0); }
  finally { remove(); f.exited.resolve(0); }
});
test("activation stays blocked when a logical host policy consumer cannot acknowledge refresh", async () => {
  mkdirSync(join(home, "cowork"));
  const removeConsumer = registerHostStoragePolicyConsumer(() => new Promise<void>(() => {}));
  try {
    await expect(new HostCodeExecutionService(home, null).refreshForStorage(home, { coordinationDir: coordination, coworkStorageActive: true }, 15)).rejects.toThrow("host-storage-policy-refresh-pending");
    expect(hostStorageFloorDescriptor(home).denyReadPaths).toHaveLength(0);
  } finally { removeConsumer(); }
});
test("paths changed during policy acknowledgment cannot be cached as successfully acknowledged", async () => {
  const f = fixture({ ownedBridge: false }), other = join(root, "new-participant");
  let calls = 0;
  const removeConsumer = registerHostStoragePolicyConsumer(async () => { calls++; mkdirSync(join(other, "cowork"), { recursive: true }); });
  const options = { coordinationDir: coordination, participatingHomes: [other], coworkStorageActive: true };
  let remove: (() => void) | undefined, repeatRemove: (() => void) | undefined;
  try {
    await expect(f.service.refreshForStorage(home, options)).rejects.toThrow("host-storage-policy-changed-during-refresh");
    remove = await f.service.refreshForStorage(home, options);
    expect(calls).toBe(2);
    repeatRemove = await f.service.refreshForStorage(home, options);
    expect(calls).toBe(2);
  } finally { repeatRemove?.(); remove?.(); removeConsumer(); }
});
test("reordered and duplicate participating-home paths retain the acknowledged policy", async () => {
  const f = fixture({ ownedBridge: false }), first = join(root, "first-participant"), second = join(root, "second-participant");
  for (const path of [first, second]) mkdirSync(join(path, "cowork"), { recursive: true });
  let calls = 0;
  const removeConsumer = registerHostStoragePolicyConsumer(async () => { calls++; });
  let remove: (() => void) | undefined, repeatRemove: (() => void) | undefined;
  try {
    remove = await f.service.refreshForStorage(home, { coordinationDir: coordination, participatingHomes: [first, second], coworkStorageActive: true });
    repeatRemove = await f.service.refreshForStorage(home, { coordinationDir: coordination, participatingHomes: [second, first, second], coworkStorageActive: true });
    expect(calls).toBe(1);
  } finally { repeatRemove?.(); remove?.(); removeConsumer(); }
});
test("ordinary retired children never impose first-activation restart debt", async () => {
  const f = fixture({ active: false, ownedBridge: false }), g = f.enroll(); f.spawnGeneration(g); g.dispose(); f.exited.resolve(0);
  await Promise.resolve(); await Promise.resolve(); mkdirSync(join(home, "cowork"));
  const remove = await f.service.refreshForStorage(home, { coordinationDir: coordination, coworkStorageActive: true }, 100);
  try { expect(hostStorageFloorDescriptor(home).denyWritePaths.length).toBeGreaterThan(0); } finally { remove(); }
});
test("ordinary router queries use SDK policy without automatic Cowork broker enrollment", () => {
  const f = fixture({ ownedBridge: false }), g = f.enroll();
  expect(g.protectedStorage).toBe(false);
  expect(() => f.service.assertQueryOptions({} as Options)).not.toThrow();
  expect(() => f.service.assertQueryOptions({ ...g.options })).not.toThrow(); g.dispose();
});
test("parallel starts for one observed call have only one admission", async () => {
  const permission = deferred<boolean>(),
    f = fixture({ authorize: () => permission.promise }),
    g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  const a = f.resolve(g),
    b = f.resolve(g);
  permission.resolve(true);
  const results = await Promise.allSettled([a, b]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  g.dispose();
  f.exited.resolve(0);
});

test("a thread label without an observed Agent parent is not descendant authority", async () => {
  const f = fixture(),
    g = f.enroll();
  f.spawnGeneration(g);
  g.observe({
    type: "thread_started",
    sessionId: "logical",
    threadId: "invented-parent",
  } as NewSessionEvent);
  f.call(g, "invented-parent");
  await expect(
    f.resolve(g, { parentToolUseId: "invented-parent" }),
  ).rejects.toThrow("descendant-authority-not-observed");
  g.dispose();
  f.exited.resolve(0);
});

test("actual host canUseTool callback is called once and produces a bound receipt", async () => {
  const f = fixture();
  let callbacks = 0;
  const receipts: unknown[] = [];
  f.options.canUseTool = async (_name, input) => {
    callbacks++;
    return { behavior: "allow", updatedInput: input };
  };
  f.binding.recordPromptResult = (receipt) => {
    receipts.push(receipt);
  };
  const g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  const result = await g.options.canUseTool!(
    "Bash",
    { command: "cat note" },
    { toolUseID: "call", requestId: "host-request", signal: f.abort.signal },
  );
  expect(result?.behavior).toBe("allow");
  expect(callbacks).toBe(1);
  expect(receipts).toEqual([
    {
      generationId: g.generationId,
      sessionId: "backend",
      toolUseId: "call",
      threadId: "main",
      toolName: "Bash",
      input: { command: "cat note" },
      cwd: source,
      policyRevision: "policy-a",
      ancestors: [],
      result: { behavior: "allow", updatedInput: { command: "cat note" } },
    },
  ]);
  await expect(
    g.options.canUseTool!(
      "Bash",
      { command: "other" },
      { toolUseID: "call", requestId: "host-request", signal: f.abort.signal },
    ),
  ).rejects.toThrow("prompt-call-not-observed");
  expect(callbacks).toBe(1);
  g.dispose();
  f.exited.resolve(0);
});
test("permission change while host callback awaits never records an old receipt", async () => {
  const f = fixture(),
    permission = deferred<void>();
  let recorded = false;
  f.options.canUseTool = async (_name, input) => {
    await permission.promise;
    return { behavior: "allow", updatedInput: input };
  };
  f.binding.recordPromptResult = () => {
    recorded = true;
  };
  const g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  const pending = g.options.canUseTool!(
    "Bash",
    { command: "cat note" },
    { toolUseID: "call", requestId: "host-request", signal: f.abort.signal },
  );
  f.setRevision("changed");
  permission.resolve();
  await expect(pending).rejects.toThrow("host-prompt-context-changed");
  expect(recorded).toBe(false);
  g.dispose();
  f.exited.resolve(0);
});
test("fulfilled uncertain broker drain evidence cannot authorize storage refresh", async () => {
  const f = fixture(),
    register = f.adapter.register;
  f.adapter.register = (input) => ({
    ...register(input),
    drained: Promise.resolve({
      status: "uncertain",
      generationId: input.generationId,
      coverage: "registered-process-close-only",
      confirmedProcessCount: 0,
    }),
  });
  const g = f.enroll();
  f.spawnGeneration(g);
  f.exited.resolve(0);
  await Promise.resolve();
  await expect(
    f.service.refreshForStorage(
      home,
      { coordinationDir: coordination, coworkStorageActive: true },
      100,
    ),
  ).rejects.toThrow("broker-descendants-unconfirmed");
  expect(hostStorageFloorDescriptor(home).denyWritePaths).toContain(
    join(home, "cowork"),
  );
});

test("completed host callback is required; early broker calls and duplicate reviews refuse", async () => {
  const f = fixture(),
    review = deferred<{}>();
  let reviewerCalls = 0;
  f.binding.buildHookContext = () => ({ policy: { version: 1 } });
  f.options.hooks = {
    PreToolUse: [
      {
        matcher: "Bash",
        failClosed: true,
        hooks: [
          async () => {
            reviewerCalls++;
            return review.promise;
          },
        ],
      },
    ],
  };
  f.adapter.buildHookEntries = () => [{ id: "pre-review" }];
  f.adapter.createHookStage = (input) => ({
    async preToolUse(call) {
      const invoker = input.invoker as {
        invoke(request: { hookId: string; input: unknown }): Promise<unknown>;
      };
      // SDK runner failure can be nonblocking; Core must independently refuse incomplete evidence.
      try {
        await invoker.invoke({ hookId: "pre-review", input: call.input });
      } catch {}
      return { decision: "no_opinion" };
    },
  });
  const g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  await expect(f.resolve(g)).rejects.toThrow("host-pre-hooks-pending");
  expect(reviewerCalls).toBe(0);
  const hook = g.options.hooks!.PreToolUse![0]!.hooks[0]!;
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "backend",
    tool_use_id: "call",
    tool_name: "Bash",
    tool_input: { command: "cat note" },
    cwd: source,
    transcript_path: "fixture-only",
  } as Parameters<typeof hook>[0];
  const first = hook(input, "call", { signal: f.abort.signal }),
    duplicate = hook(input, "call", { signal: f.abort.signal });
  await expect(f.resolve(g)).rejects.toThrow("host-pre-hooks-pending");
  expect(reviewerCalls).toBe(1);
  review.resolve({});
  await Promise.all([first, duplicate]);
  expect((await f.resolve(g)).scope.toolUseId).toBe("call");
  expect(reviewerCalls).toBe(1);
  g.dispose();
  f.exited.resolve(0);
});
test("installed-adapter enrollment refuses absent bounded native output transport", () => {
  const f = fixture();
  f.adapter.requiresNativeOutput = true;
  expect(() => f.enroll()).toThrow("owned-bridge-capability-unavailable");
});

test("authorized background Agent lineage survives launch ACK, but not thread completion", async () => {
  const f = fixture(),
    g = f.enroll();
  f.spawnGeneration(g);
  g.observe({
    type: "tool_call",
    sessionId: "logical",
    callId: "agent",
    threadId: "main",
    name: "Agent",
    argsJson: JSON.stringify({
      subagent_type: "general-purpose",
      run_in_background: true,
    }),
  } as NewSessionEvent);
  await g.completeHook(
    {
      tool_name: "Agent",
      tool_use_id: "agent",
      session_id: "backend",
      cwd: source,
    },
    f.abort.signal,
  );
  g.observe({
    type: "thread_started",
    sessionId: "logical",
    threadId: "agent",
  } as NewSessionEvent);
  g.observe({
    type: "tool_result",
    sessionId: "logical",
    callId: "agent",
    threadId: "main",
    output: "async_launched",
    isError: false,
  } as NewSessionEvent);
  f.call(g, "agent");
  expect(
    (await f.resolve(g, { parentToolUseId: "agent" })).scope.parentToolUseId,
  ).toBe("agent");
  await expect(
    f.resolve(g, { toolUseId: "agent", parentToolUseId: undefined }),
  ).rejects.toThrow("unobserved-active-call");
  g.observe({
    type: "thread_completed",
    sessionId: "logical",
    threadId: "agent",
  } as NewSessionEvent);
  await expect(f.resolve(g, { parentToolUseId: "agent" })).rejects.toThrow(
    "unobserved-active-call",
  );
  g.dispose();
  f.exited.resolve(0);
});

test("observed or denied Agent launches never grant descendant authority", async () => {
  const f = fixture();
  f.binding.authorize = async (call) => call.name !== "Agent";
  f.options.canUseTool = async () => ({
    behavior: "deny",
    message: "host refused launch",
  });
  const g = f.enroll();
  f.spawnGeneration(g);
  g.observe({
    type: "tool_call",
    sessionId: "logical",
    callId: "agent",
    threadId: "main",
    name: "Agent",
    argsJson: JSON.stringify({ subagent_type: "general-purpose" }),
  } as NewSessionEvent);
  g.noteHook({
    tool_name: "Agent",
    tool_use_id: "agent",
    session_id: "backend",
    cwd: source,
  });
  g.observe({
    type: "thread_started",
    sessionId: "logical",
    threadId: "agent",
  } as NewSessionEvent);
  f.call(g, "agent");
  await expect(f.resolve(g, { parentToolUseId: "agent" })).rejects.toThrow(
    "descendant-authority-not-observed",
  );
  await g.completeHook(
    {
      tool_name: "Agent",
      tool_use_id: "agent",
      session_id: "backend",
      cwd: source,
    },
    f.abort.signal,
  );
  const denied = await g.options.canUseTool!(
    "Agent",
    { subagent_type: "general-purpose" },
    { toolUseID: "agent", requestId: "launch-card", signal: f.abort.signal },
  );
  expect(denied?.behavior).toBe("deny");
  await expect(f.resolve(g, { parentToolUseId: "agent" })).rejects.toThrow(
    "descendant-authority-not-observed",
  );
  g.dispose();
  f.exited.resolve(0);
});

test("host-approved modified command is sealed and the old command loses authority", async () => {
  const f = fixture();
  f.options.canUseTool = async () => ({
    behavior: "allow",
    updatedInput: { command: "cat approved" },
  });
  let receipt: unknown;
  f.binding.recordPromptResult = (value) => {
    receipt = value;
  };
  const g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  await g.options.canUseTool!(
    "Bash",
    { command: "cat note" },
    { toolUseID: "call", requestId: "edit-card", signal: f.abort.signal },
  );
  expect(receipt).toMatchObject({ input: { command: "cat approved" } });
  await expect(f.resolve(g)).rejects.toThrow("command-not-observed-call");
  expect(
    (await f.resolve(g, { command: "cat approved" })).scope.toolUseId,
  ).toBe("call");
  g.dispose();
  f.exited.resolve(0);
});

test("completed call IDs cannot be reused while old authorization is awaiting", async () => {
  const permission = deferred<boolean>(),
    f = fixture({ authorize: () => permission.promise }),
    g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  const pending = f.resolve(g);
  g.observe({
    type: "tool_result",
    sessionId: "logical",
    callId: "call",
    threadId: "main",
  } as NewSessionEvent);
  expect(() => f.call(g, "main", "Bash", { command: "replacement" })).toThrow(
    "ambiguous-or-unbounded-tool-calls",
  );
  permission.resolve(true);
  await expect(pending).rejects.toThrow("stale-generation");
  // Authority closes immediately, while the session owns asynchronous process teardown after logging.
  expect(f.abort.signal.aborted).toBe(false);
  g.dispose();
  f.exited.resolve(0);
});

test("approved input replacement during authorization cannot admit the old command", async () => {
  const permission = deferred<boolean>(),
    f = fixture({ authorize: () => permission.promise });
  f.options.canUseTool = async () => ({
    behavior: "allow",
    updatedInput: { command: "cat approved" },
  });
  const g = f.enroll();
  f.spawnGeneration(g);
  f.call(g);
  const pending = f.resolve(g);
  await g.options.canUseTool!(
    "Bash",
    { command: "cat note" },
    { toolUseID: "call", requestId: "edit-card", signal: f.abort.signal },
  );
  permission.resolve(true);
  await expect(pending).rejects.toThrow(
    "call-or-policy-changed-during-admission",
  );
  expect(
    (await f.resolve(g, { command: "cat approved" })).scope.toolUseId,
  ).toBe("call");
  g.dispose();
  f.exited.resolve(0);
});

test("Agent lineage awaits the exact completed host permission receipt", async () => {
  const f = fixture(),
    permission = deferred<void>();
  let receipt = false;
  f.binding.authorize = async (call) => call.name !== "Agent" || receipt;
  f.binding.recordPromptResult = () => {
    receipt = true;
  };
  f.options.canUseTool = async (_name, input) => {
    await permission.promise;
    return { behavior: "allow", updatedInput: input };
  };
  const g = f.enroll();
  f.spawnGeneration(g);
  g.observe({
    type: "tool_call",
    sessionId: "logical",
    callId: "agent",
    threadId: "main",
    name: "Agent",
    argsJson: JSON.stringify({ subagent_type: "general-purpose" }),
  } as NewSessionEvent);
  await g.completeHook(
    {
      tool_name: "Agent",
      tool_use_id: "agent",
      session_id: "backend",
      cwd: source,
    },
    f.abort.signal,
  );
  g.observe({
    type: "thread_started",
    sessionId: "logical",
    threadId: "agent",
  } as NewSessionEvent);
  f.call(g, "agent");
  const pending = g.options.canUseTool!(
    "Agent",
    { subagent_type: "general-purpose" },
    { toolUseID: "agent", requestId: "launch-card", signal: f.abort.signal },
  );
  await expect(f.resolve(g, { parentToolUseId: "agent" })).rejects.toThrow(
    "descendant-authority-not-observed",
  );
  expect(receipt).toBe(false);
  permission.resolve();
  await pending;
  expect(receipt).toBe(true);
  expect(
    (await f.resolve(g, { parentToolUseId: "agent" })).scope.parentToolUseId,
  ).toBe("agent");
  g.dispose();
  f.exited.resolve(0);
});

test("matching current cwd outside initial roots reaches host approval without adding a write root", async () => {
  let admittedCwd: string | undefined;
  const f = fixture(), outside = join(root, "approved-other-directory");
  mkdirSync(outside);
  f.binding.authorize = async (_call, cwd) => { admittedCwd = cwd; return true; };
  const g = f.enroll();
  f.spawnGeneration(g);
  f.call(g, "main", "Bash", { command: "cat note", dangerouslyDisableSandbox: true });
  // The prior approved command may legitimately cd into this separate fixture directory.
  g.noteHook({ tool_name: "Bash", tool_use_id: "call", session_id: "backend", cwd: outside });
  const result = await f.resolve(g, { cwd: outside, sandboxIntent: "override-requested" });
  expect(admittedCwd).toBe(outside);
  expect(result.commandOptions.cwd).toBe(outside);
  expect(result.commandOptions.dangerouslyDisableSandbox).toBe(true);
  expect(result.commandOptions.writableRoots).toEqual([source, temp]);
  expect(result.commandOptions.writableRoots).not.toContain(outside);
  expect(result.floor).toEqual(hostStorageFloorDescriptor(home));
  g.dispose(); f.exited.resolve(0);
});
test("matching cwd outside initial roots does not bypass a current host denial", async () => {
  const f = fixture({ authorize: async () => false }), g = f.enroll();
  f.spawnGeneration(g); f.call(g);
  g.noteHook({ tool_name: "Bash", tool_use_id: "call", session_id: "backend", cwd: temp });
  await expect(f.resolve(g, { cwd: temp })).rejects.toThrow("current-permission-denied");
  g.dispose(); f.exited.resolve(0);
});

test("unprotected Code ignores broker observation limits and adds no hook authority", async () => {
  const f = fixture({ active: false, ownedBridge: false, withBinding: false }), g = f.enroll();
  expect(g.protectedStorage).toBe(false); expect(g.options.hooks).toBeUndefined();
  const oversized = JSON.stringify({ prompt: "x".repeat(262145) });
  for (let i = 0; i < 17000; i++) g.observe({ type: "tool_call", sessionId: "logical", callId: "same-call", threadId: "main", name: "Agent", argsJson: i === 0 ? oversized : "[]" } as NewSessionEvent);
  expect(f.abort.signal.aborted).toBe(false); g.dispose(); f.abort.abort();
  expect(() => g.noteHook({})).not.toThrow();
  await expect(g.completeHook({}, f.abort.signal)).resolves.toBeUndefined();
});
test("host hook transformedInput replaces the whole original input and object order is structural", async () => {
  const f = fixture(); let authorized: Record<string, unknown> | undefined;
  f.binding.authorize = async call => { authorized = call.input; return true; };
  f.binding.buildHookContext = () => ({});
  f.options.hooks = { PreToolUse: [{ matcher: "Bash", failClosed: true, hooks: [async () => ({})] }] };
  f.adapter.buildHookEntries = () => [{ id: "transform" }];
  f.adapter.createHookStage = input => ({ async preToolUse() {
    const invoker = input.invoker as { invoke(request: { hookId: string; input: unknown }): Promise<unknown> };
    await invoker.invoke({ hookId: "transform", input: { dangerouslyDisableSandbox: true, timeout: 600000, command: "old" } });
    return { decision: "allow", transformedInput: { command: "safe" } };
  } });
  const g = f.enroll(); f.spawnGeneration(g);
  f.call(g, "main", "Bash", { command: "old", timeout: 600000, dangerouslyDisableSandbox: true });
  await g.options.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: "PreToolUse", session_id: "backend", tool_use_id: "call", tool_name: "Bash", tool_input: { timeout: 600000, command: "old", dangerouslyDisableSandbox: true }, cwd: source } as never, "call", { signal: f.abort.signal });
  const result = await f.resolve(g, { command: "safe" });
  expect(authorized).toEqual({ command: "safe" }); expect(result.commandOptions.dangerouslyDisableSandbox).toBeUndefined(); expect(result.commandOptions.timeoutMs).toBe(120000);
  g.dispose(); f.exited.resolve(0);
});
test("host prompt input equality accepts reordered object keys", async () => {
  const f = fixture(); f.options.canUseTool = async (_name, input) => ({ behavior: "allow", updatedInput: input });
  const g = f.enroll(); f.spawnGeneration(g); f.call(g, "main", "Bash", { command: "cat note", timeout: 1000 });
  expect((await g.options.canUseTool!("Bash", { timeout: 1000, command: "cat note" }, { toolUseID: "call", signal: f.abort.signal, suggestions: [] } as never))?.behavior).toBe("allow");
  await expect(f.resolve(g, { timeoutMs: 1000 })).resolves.toBeDefined(); g.dispose(); f.exited.resolve(0);
});
test("execution limits come from the trusted SDK selector including finite fractional timeouts", async () => {
  const f = fixture(); f.adapter.executionLimits = () => ({ timeoutMs: 777.25, maxStreamedBytes: 4096 });
  const g = f.enroll(); f.spawnGeneration(g); f.call(g);
  const result = await f.resolve(g, { timeoutMs: 777.25, maxStreamedBytes: 4096 });
  expect(result.commandOptions.timeoutMs).toBe(777.25); expect(result.commandOptions.maxStreamedBytes).toBe(4096); g.dispose(); f.exited.resolve(0);
});

test("projected host tool names preserve the raw SDK identity rather than guessing an inverse", async () => {
  const f = fixture(), g = f.enroll(); f.spawnGeneration(g);
  g.observe({type:"tool_call",sessionId:"logical",callId:"call",threadId:"main",name:"bash",argsJson:JSON.stringify({command:"cat note"})} as NewSessionEvent, "Bash");
  g.noteHook({tool_name:"Bash",tool_use_id:"call",session_id:"backend",cwd:source});
  await expect(f.resolve(g)).resolves.toBeDefined();
  g.observe({type:"tool_call",sessionId:"logical",callId:"custom",threadId:"main",name:"bash",argsJson:JSON.stringify({command:"cat note"})} as NewSessionEvent);
  expect(() => g.noteHook({tool_name:"Bash",tool_use_id:"custom",session_id:"backend",cwd:source})).toThrow("hook-call-not-authenticated");
  g.dispose(); f.exited.resolve(0);
});

// The agent runtime is loaded on the first adapter probe, not at module load (about 17 MB and 60 ms per daemon). These pin both halves:
// it is not a static import, and the lazy `require` is a LITERAL string so a bundler/compiler resolves it into the built winter-core.
test("host-code-broker has no static import of the agent runtime, and its lazy require is a literal the bundler can resolve", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/runtime-sdk/host-code-broker.ts"), "utf8");
  expect(source).not.toMatch(/^import[^;]*["']@yanlinglabs\/winter-agent-runtime["']/m);
  expect(source).toContain('require("@yanlinglabs/winter-agent-runtime")');
});

test("the first probe resolves the runtime (no module-not-found) and constructing the service does not probe", () => {
  expect(() => installedHostCodeAdapter()).not.toThrow();
  const service = new HostCodeExecutionService("/nonexistent-home-for-lazy-probe-test");
  expect((service as unknown as { resolvedAdapter?: unknown }).resolvedAdapter).toBeUndefined(); // lazy: nothing probed yet
  void (service as unknown as { adapter: unknown }).adapter;
  expect((service as unknown as { resolvedAdapter?: unknown }).resolvedAdapter).toBeDefined();   // first use probes once
});
