import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, SessionEvent,
  SessionCreateResult, SessionAttachResult, SessionSendResult, SessionListResult,
  SessionAddDirResult, SessionSetCwdResult, TrustDirResult,
  BgListResult, BgPeekResult, BgKillResult, BgKillAllResult,
  SessionSteerResult, SessionInterruptResult, SessionCompactResult, SkillsListResult,
  ThreadSendResult, AgentStopResult,
  PluginsListResult, AskUserRespondResult, TaskListResult, ThreadListResult,
  PlanRespondResult, SessionSetPolicyResult, type ApprovalPolicy,
  SessionSetActivityResult, type SessionActivity,
  DaemonStatusResult, QuotaStateResult, TrustListResult, TrustRemoveResult,
  PluginRevokeTokenResult, PluginRestartResult,
  RoutinesCreateResult, RoutinesListResult, RoutinesUpdateResult, RoutinesDeleteResult,
  MemoryListResult, MemoryReadResult, MemoryDeleteResult,
  WorkflowListResult, WorkflowRunResult, WorkflowStopResult, WorkflowGetResult,
  ConnWriter, type WritableSocket,
} from "@norma/protocol";

/** Mirrors `RoutineSchema` (protocol/src/methods.ts) / `Routine` (core/src/routines/store.ts)
 *  field-for-field — a plain inline interface, matching this file's own convention of spelling
 *  out result shapes by hand rather than importing zod just for `z.infer` (no other method here
 *  does that either). */
export interface Routine {
  id: string;
  spec: string;
  prompt: string;
  policy: "auto" | "plan";
  cwd: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number;
  createdAt: number;
  lastResult: string | null;
  deferAttempts: number;
}

/** Mirrors `WorkflowRunViewSchema` (protocol/src/methods.ts) / `WorkflowRunView`
 *  (core/src/workflows/types.ts) field-for-field — same plain-inline-interface convention as
 *  `Routine` above (no z.infer import). */
export interface WorkflowRunView {
  runId: string;
  sessionId: string;
  name?: string;
  status: "running" | "completed" | "failed" | "stopped";
  counts: { running: number; completed: number; total: number };
  phase?: string;
  result?: string;
  error?: string;
  startedAt: number;
}

/** Mirrors `WorkflowSavedSchema` (protocol/src/methods.ts) / `ResolvedWorkflow`
 *  (core/src/workflows/store.ts) field-for-field — a saved (not-yet-running) workflow's identity. */
export interface SavedWorkflow {
  name: string;
  description: string;
  source: string;
}

export interface ConnectOptions {
  socketPath: string;
  token: string;
  clientName: string;
  role?: "harness" | "admin";
  timeoutMs?: number;
  onEvent: (event: SessionEvent) => void;
}

export class NormaClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  private timeoutMs: number;

  private constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }

  static async connect(opts: ConnectOptions): Promise<NormaClient> {
    const client = new NormaClient(opts.timeoutMs ?? 5000);
    client.socket = await Bun.connect({
      unix: opts.socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of client.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null && client.pending.has(msg.id)) {
              const p = client.pending.get(msg.id)!;
              client.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
              else p.resolve(msg.result);
            } else if (msg.method === METHODS.event) {
              const parsed = SessionEvent.safeParse(msg.params);
              if (parsed.success) opts.onEvent(parsed.data);
              // unknown/future event types are skipped for forward-compat
            }
          }
        },
        drain() {
          client.writer.onDrain();
        },
        close() {
          for (const p of client.pending.values()) p.reject(new Error("connection closed"));
          client.pending.clear();
        },
        error() {}, // close() follows and rejects pending; stub silences Bun's default stderr print
      },
    });
    client.writer = new ConnWriter(client.socket as unknown as WritableSocket);
    await client.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION,
      role: opts.role ?? "harness",
      token: opts.token,
      clientName: opts.clientName,
    });
    return client;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    // orb-regressions fix round 1 (2026-07-29): `params ?? {}` — JSON.stringify DROPS a key whose
    // value is undefined, so a params-less call used to emit a frame with no `params` key at all.
    // That is legal JSON-RPC 2.0, but every no-argument method's daemon schema is `z.object({})`
    // and `z.object({}).safeParse(undefined)` FAILS — the exact defect that killed the orb's
    // `session.dispatch` from the Swift client (see NormaClient.swift's own note). The daemon now
    // normalizes too (`parseParams`, ipc/server.ts), but this client must not depend on that: a
    // `norma` CLI can be pointed at an older daemon. Normalized HERE rather than at `listSessions`
    // (today's only params-less caller) so the whole class is closed for every future one.
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private validated(schema: { safeParse(v: unknown): any }, raw: unknown, method: string): any {
    const r = schema.safeParse(raw);
    if (!r.success) throw new Error(`invalid result from server for ${method}`);
    return r.data;
  }

  async createSession(scope: string, opts?: { cwd?: string; approvalPolicy?: ApprovalPolicy }): Promise<{ sessionId: string; trusted: boolean }> {
    const r = this.validated(SessionCreateResult, await this.request(METHODS.sessionCreate, { scope, ...opts }), METHODS.sessionCreate);
    return { sessionId: r.sessionId, trusted: r.trusted };
  }
  async trustDir(path: string): Promise<boolean> {
    return this.validated(TrustDirResult, await this.request(METHODS.trustDir, { path }), METHODS.trustDir).trusted;
  }
  async attach(sessionId: string, fromSeq = 0): Promise<number> {
    return this.validated(SessionAttachResult, await this.request(METHODS.sessionAttach, { sessionId, fromSeq }), METHODS.sessionAttach).lastSeq;
  }
  async send(sessionId: string, text: string): Promise<number> {
    return this.validated(SessionSendResult, await this.request(METHODS.sessionSend, { sessionId, text }), METHODS.sessionSend).seq;
  }
  async listSessions() {
    return this.validated(SessionListResult, await this.request(METHODS.sessionList), METHODS.sessionList);
  }
  async addDir(sessionId: string, path: string, persist = false): Promise<string[]> {
    return this.validated(SessionAddDirResult, await this.request(METHODS.sessionAddDir, { sessionId, path, persist }), METHODS.sessionAddDir).roots;
  }
  async setCwd(sessionId: string, cwd: string): Promise<string> {
    return this.validated(SessionSetCwdResult, await this.request(METHODS.sessionSetCwd, { sessionId, cwd }), METHODS.sessionSetCwd).cwd;
  }
  async bgList(sessionId: string): Promise<Array<{ taskId: string; command: string; status: string; exitCode: number | null; startedAt: number }>> {
    return this.validated(BgListResult, await this.request(METHODS.bgList, { sessionId }), METHODS.bgList).tasks;
  }
  async bgPeek(sessionId: string, taskId: string): Promise<{ chunk: string; status: string; exitCode: number | null }> {
    return this.validated(BgPeekResult, await this.request(METHODS.bgPeek, { sessionId, taskId }), METHODS.bgPeek);
  }
  async bgKill(sessionId: string, taskId: string): Promise<{ ok: true }> {
    return this.validated(BgKillResult, await this.request(METHODS.bgKill, { sessionId, taskId }), METHODS.bgKill);
  }
  async bgKillAll(sessionId: string): Promise<{ ok: true; killed: number }> {
    return this.validated(BgKillAllResult, await this.request(METHODS.bgKillAll, { sessionId }), METHODS.bgKillAll);
  }
  async steer(sessionId: string, text: string): Promise<{ injected: boolean }> {
    const r = this.validated(SessionSteerResult, await this.request(METHODS.sessionSteer, { sessionId, text }), METHODS.sessionSteer);
    return { injected: r.injected };
  }
  async interrupt(sessionId: string): Promise<{ wasRunning: boolean }> {
    const r = this.validated(SessionInterruptResult, await this.request(METHODS.sessionInterrupt, { sessionId }), METHODS.sessionInterrupt);
    return { wasRunning: r.wasRunning };
  }
  /** Live child-transcript view T3: thin wrapper over `thread.send` (same idiom as `send`/`steer`
   *  above) — the TUI's roster-select "message this agent" surface. `agent` is `agentId|name`; the
   *  running-vs-terminal dispatch (steer-queue vs. auto-resume) is entirely the daemon's call (see
   *  protocol/src/methods.ts's `ThreadSendResult` doc) — this method just round-trips it. */
  async sendToThread(sessionId: string, agent: string, text: string): Promise<{ ok: true; delivered: "queued" | "resumed"; agentId: string }> {
    return this.validated(ThreadSendResult, await this.request(METHODS.threadSend, { sessionId, agent, text }), METHODS.threadSend);
  }
  /** Live child-transcript view T3: thin wrapper over `agent.stop` — the roster-select `x` on a
   *  running row. Stopping an already-terminal agent is not an error (see `AgentStopResult`'s doc);
   *  the caller (app.tsx) renders whatever `status` comes back either way. */
  async agentStop(sessionId: string, agent: string): Promise<{ ok: true; status: "running" | "completed" | "failed" | "stopped" | "timeout" }> {
    return this.validated(AgentStopResult, await this.request(METHODS.agentStop, { sessionId, agent }), METHODS.agentStop);
  }
  async compact(sessionId: string): Promise<{ compacted: boolean; uptoSeq: number; summaryChars: number }> {
    const r = this.validated(SessionCompactResult, await this.request(METHODS.sessionCompact, { sessionId }), METHODS.sessionCompact);
    return { compacted: r.compacted, uptoSeq: r.uptoSeq, summaryChars: r.summaryChars };
  }
  async listSkills(cwd?: string): Promise<Array<{ name: string; description: string; source: string; path: string }>> {
    return this.validated(SkillsListResult, await this.request(METHODS.skillsList, { cwd }), METHODS.skillsList).skills;
  }
  async listMcp(cwd?: string): Promise<Array<{ name: string; status: string; toolNames: string[]; source: string }>> {
    const r = await this.request(METHODS.mcpList, { cwd });
    return r.servers;
  }
  async pluginsList(): Promise<{
    ok: true;
    plugins: Array<{
      name: string; description?: string; version?: string; skills: string[]; hasMcp: boolean; mcpEnabled: boolean; disabled: boolean;
      // Phase 4a Task 3 — consent-flow display data (all optional: older servers may omit them).
      tier?: "capability" | "platform"; requiredConsents?: string[]; consented?: string[]; legacy?: boolean;
      execPayload?: string[]; tccPermissions?: string[]; hardwarePermissions?: string[];
    }>;
  }> {
    return this.validated(PluginsListResult, await this.request(METHODS.pluginsList, {}), METHODS.pluginsList);
  }
  async askUserRespond(params: { sessionId: string; callId: string; answers: Record<string, string>; notes?: Record<string, string> }): Promise<{ ok: true; alreadyResolved: boolean }> {
    return this.validated(AskUserRespondResult, await this.request(METHODS.askUserRespond, params), METHODS.askUserRespond);
  }
  async taskList(params: { sessionId: string }): Promise<{ ok: true; tasks: Array<{ id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> }> {
    return this.validated(TaskListResult, await this.request(METHODS.taskList, params), METHODS.taskList);
  }
  async threadList(params: { sessionId: string }): Promise<{ ok: true; threads: Array<{ threadId: string; parentThreadId?: string; agentType?: string; status: "running" | "completed"; stopReason?: string }> }> {
    return this.validated(ThreadListResult, await this.request(METHODS.threadList, params), METHODS.threadList);
  }
  async planRespond(params: { sessionId: string; callId: string; approved: boolean; autoAccept?: boolean; feedback?: string }): Promise<{ ok: true; alreadyResolved: boolean }> {
    return this.validated(PlanRespondResult, await this.request(METHODS.planRespond, params), METHODS.planRespond);
  }
  async sessionSetPolicy(params: { sessionId: string; policy: ApprovalPolicy }): Promise<{ ok: true }> {
    return this.validated(SessionSetPolicyResult, await this.request(METHODS.sessionSetPolicy, params), METHODS.sessionSetPolicy);
  }
  /** Interactive-chrome convenience wrapper (2e-iii-b Task 6): the mode bar's shift+tab cycle
   *  calls this. Thin positional-arg alias over `sessionSetPolicy` (same `session.setPolicy` RPC). */
  async setPolicy(sessionId: string, policy: ApprovalPolicy): Promise<void> {
    await this.sessionSetPolicy({ sessionId, policy });
  }
  /** session-activity-hygiene T3: `session.setActivity` — the lifecycle write verb behind the TUI's
   *  `/background` and `/archive` and the `norma agents` roster's verbs.
   *
   *  activity-verb-semantics: FOUR values, ONE FLAG PER VERB. `"background"`/`"archived"` SET their
   *  own stored bit and leave the other alone; `"unbackground"` clears the background bit only; and
   *  `null` is RESUME — it clears the ARCHIVE bit only, so a session that was backgrounded before it
   *  was archived comes back backgrounded (matching `session.attach`, which has always cleared
   *  exactly the archive flag). `null` did clear BOTH until this round: any caller still sending it
   *  to un-background is now writing a resume.
   *
   *  An ARCHIVED session is IMMUTABLE except through resume: `"background"` and `"unbackground"` are
   *  REFUSED on one ("session is archived — resume it first"), `"archived"` is an idempotent success,
   *  and `null` is the one door out.
   *
   *  The returned `activity` is the daemon's POST-WRITE DERIVED state, not an echo of what was sent
   *  (a clear on a session whose detached bash task is still writing comes back `"background"`), and
   *  it is DECLARED on `SessionSetActivityResult` — `validated`'s safeParse strips anything the
   *  schema doesn't name, so an undeclared field would vanish here silently. Callers should report
   *  this value, never the value they asked for. */
  async sessionSetActivity(params: { sessionId: string; activity: "background" | "archived" | "unbackground" | null }): Promise<{ ok: true; activity?: SessionActivity }> {
    return this.validated(SessionSetActivityResult, await this.request(METHODS.sessionSetActivity, params), METHODS.sessionSetActivity);
  }
  /** Dashboard read methods (Phase 2f Task 6 — CLI riders over Task 3's new methods). */
  async daemonStatus(): Promise<{
    version: string; uptimeMs: number; socketPath: string;
    provider: { id: string; model: string } | null; sessionsCount: number; pluginsCount: number;
  }> {
    return this.validated(DaemonStatusResult, await this.request(METHODS.daemonStatus, {}), METHODS.daemonStatus);
  }
  async quotaState(): Promise<{ kind: "ok" | "limited"; resumeAt?: number; inputTokens: number; outputTokens: number }> {
    return this.validated(QuotaStateResult, await this.request(METHODS.quotaState, {}), METHODS.quotaState);
  }
  async trustList(): Promise<string[]> {
    return this.validated(TrustListResult, await this.request(METHODS.trustList, {}), METHODS.trustList).dirs;
  }
  async trustRemove(path: string): Promise<boolean> {
    return this.validated(TrustRemoveResult, await this.request(METHODS.trustRemove, { path }), METHODS.trustRemove).removed;
  }
  /** Phase 4b Task 2: `plugin_tokens` lives in the daemon's sqlite, not settings.json — the CLI
   *  never opens that database directly (locking risk), so disable/remove revoke via this
   *  harness-role RPC instead (mint stays daemon-side, Task 3). */
  async pluginRevokeToken(pluginId: string): Promise<{ ok: true }> {
    return this.validated(PluginRevokeTokenResult, await this.request(METHODS.pluginRevokeToken, { pluginId }), METHODS.pluginRevokeToken);
  }
  /** Final-review Fix 1: `norma plugin restart <id>` — forces a fresh spawn cycle for a plugin the
   *  daemon's supervisor is already tracking, including recovering one stuck "circuit-open"
   *  (nothing else ever clears that state). harness/admin role, same precedent as `pluginsList`
   *  above — NOT one of the six plugin-role verbs. */
  async restartPlugin(pluginId: string): Promise<{ ok: true }> {
    return this.validated(PluginRestartResult, await this.request(METHODS.pluginRestart, { pluginId }), METHODS.pluginRestart);
  }
  /** Phase 5 routines T3: management surface over the daemon's RoutineStore — the four
   *  `routines.*` RPCs, mirrored here like every other method in this file (harness/admin role,
   *  same precedent as `pluginsList`/`daemonStatus` above — no special gating). */
  async routinesCreate(params: { spec: string; prompt: string; policy?: "auto" | "plan"; cwd?: string }): Promise<{ routine: Routine }> {
    return this.validated(RoutinesCreateResult, await this.request(METHODS.routinesCreate, params), METHODS.routinesCreate);
  }
  async routinesList(): Promise<{ routines: Routine[] }> {
    return this.validated(RoutinesListResult, await this.request(METHODS.routinesList, {}), METHODS.routinesList);
  }
  async routinesUpdate(params: {
    id: string;
    patch: { spec?: string; prompt?: string; policy?: "auto" | "plan"; enabled?: boolean };
  }): Promise<{ routine: Routine }> {
    return this.validated(RoutinesUpdateResult, await this.request(METHODS.routinesUpdate, params), METHODS.routinesUpdate);
  }
  async routinesDelete(id: string): Promise<{ ok: true; removed: boolean }> {
    return this.validated(RoutinesDeleteResult, await this.request(METHODS.routinesDelete, { id }), METHODS.routinesDelete);
  }
  /** Phase 5b T4: the CLI/slash surface over T3's `memory.*` RPCs — list/read/delete only (write
   *  stays tool-only, per the brief: `norma memory list|show <name>|rm <name>`, no `write`/`add`
   *  subcommand; audit has no CLI surface yet either). Mirrors the routines.* quartet above:
   *  harness/admin role, no special gating, a store failure is a thrown RpcFailure (never a typed
   *  result union) for read/delete exactly like routines.create/update. */
  async memoryList(scope: "user" | "project", cwd?: string): Promise<{ facts: Array<{ name: string; description: string; type: string }> }> {
    return this.validated(MemoryListResult, await this.request(METHODS.memoryList, { scope, cwd }), METHODS.memoryList);
  }
  async memoryRead(scope: "user" | "project", name: string, cwd?: string): Promise<{ fact: { name: string; description: string; type: string; body: string } }> {
    return this.validated(MemoryReadResult, await this.request(METHODS.memoryRead, { scope, name, cwd }), METHODS.memoryRead);
  }
  async memoryDelete(scope: "user" | "project", name: string, cwd?: string): Promise<void> {
    await this.validated(MemoryDeleteResult, await this.request(METHODS.memoryDelete, { scope, name, cwd }), METHODS.memoryDelete);
  }
  /** CC-parity phase 3 (Workflows, Track C Task C2): the management/control surface over the
   *  daemon's WorkflowRuntime (live runs) + WorkflowStore (saved `.norma/workflows` scripts, C1)
   *  — mirrors the routines.* / memory.* quartets above: harness/admin role, no special gating
   *  (LOCAL-ONLY IN V1 — these four are not reachable over the remote/plugin roles,
   *  ipc/server.ts's allowlists). `workflowRun`'s `name`/`script` mirror the wire's own "exactly
   *  one required" contract (handler-enforced, not the zod schema — see methods.ts's
   *  WorkflowRunParams doc comment). */
  async workflowList(sessionId: string, cwd?: string): Promise<{ running: WorkflowRunView[]; saved: SavedWorkflow[] }> {
    return this.validated(WorkflowListResult, await this.request(METHODS.workflowList, { sessionId, cwd }), METHODS.workflowList);
  }
  async workflowRun(params: { sessionId: string; name?: string; script?: string; args?: unknown }): Promise<{ runId: string; status: "running" }> {
    return this.validated(WorkflowRunResult, await this.request(METHODS.workflowRun, params), METHODS.workflowRun);
  }
  async workflowStop(runId: string): Promise<{ ok: true; stopped: boolean }> {
    return this.validated(WorkflowStopResult, await this.request(METHODS.workflowStop, { runId }), METHODS.workflowStop);
  }
  async workflowGet(runId: string): Promise<{ run: WorkflowRunView }> {
    return this.validated(WorkflowGetResult, await this.request(METHODS.workflowGet, { runId }), METHODS.workflowGet);
  }
  close(): void { this.socket.end(); }
}
