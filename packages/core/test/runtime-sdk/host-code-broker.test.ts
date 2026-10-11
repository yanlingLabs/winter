import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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
test("missing binding cannot erase active service-home floor", () => {
  const f = fixture({ withBinding: false });
  expect(() => f.enroll()).toThrow(HostCodeUnavailable);
  expect(() =>
    new HostCodeExecutionService(home, null).assertReady(home),
  ).toThrow("capability-missing");
  expect(() => f.service.assertReady(source)).toThrow("foreign-service-home");
});
test("inactive unregistered Code preserves resolved spawn posture", () => {
  const f = fixture({ active: false, withBinding: false }),
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
test("refresh deadline bounds stop and rolls registration back", async () => {
  const f = fixture({ active: false, stop: () => new Promise<void>(() => {}) }),
    g = f.enroll();
  f.spawnGeneration(g);
  mkdirSync(join(home, "cowork"));
  const start = Date.now();
  await expect(
    f.service.refreshForStorage(
      home,
      { coordinationDir: coordination, coworkStorageActive: true },
      25,
    ),
  ).rejects.toThrow("stop-unconfirmed");
  expect(Date.now() - start).toBeLessThan(500);
  expect(hostStorageFloorDescriptor(home).denyReadPaths).toHaveLength(0);
  f.exited.resolve(0);
});
test("old parent exit alone retains descendant activation debt", async () => {
  const f = fixture({ active: false }),
    g = f.enroll();
  f.spawnGeneration(g);
  g.dispose();
  f.exited.resolve(0);
  await Promise.resolve();
  await Promise.resolve();
  mkdirSync(join(home, "cowork"));
  await expect(
    f.service.refreshForStorage(
      home,
      { coordinationDir: coordination, coworkStorageActive: true },
      100,
    ),
  ).rejects.toThrow("retired-code-descendants-unconfirmed");
  expect(hostStorageFloorDescriptor(home).denyWritePaths).toHaveLength(0);
});

test("raw router queries cannot bypass enrollment and valid spawn survives option copies", () => {
  const f = fixture(),
    g = f.enroll();
  expect(() => f.service.assertQueryOptions({} as Options)).toThrow(
    "query-generation-not-enrolled",
  );
  expect(() => f.service.assertQueryOptions({ ...g.options })).not.toThrow();
  g.dispose();
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
  await pending;
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
  expect(() => f.enroll()).toThrow("native-output-transport-missing");
});
