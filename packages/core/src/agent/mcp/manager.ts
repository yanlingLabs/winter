import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { connectMcpServer as sdkConnectMcpServer, createElicitationAsker, McpConnectError, type ConnectMcpServerOptions, type ConnectedMcpClient, type McpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-client";
import { readRawProjectMcpConfig, parseProjectMcpServers, type McpOAuthSetting } from "./project-file";
import { projectScopeRootFor, projectScopeTrusted } from "../../runtime-sdk/run-home-input";
import type { TrustStore } from "../trust";

/**
 * One row of the probe's report. `status` is the last probe's answer (WS-25 adds `"needs-auth"`: an
 * http/sse server that refused the probe for want of a sign-in). `transport` is set on every http/sse row
 * (a stdio row never needed it, and keeps its pre-WS-25 shape).
 */
export interface McpServerStatus {
  name: string;
  status: "connected" | "failed" | "needs-auth";
  toolNames: string[];
  source: "user" | "project" | "plugin";
  transport?: "http" | "sse";
}

/** The versionNegotiation the SDK accepts, as Winter's configs spell it (agent/mcp/project-file.ts). */
type VersionNegotiation = "legacy" | "auto" | { pin: string };

/**
 * What the manager can probe. The stdio shape keeps its pre-WS-25 spelling (`{ command, args?, env? }`,
 * `type` optional) so every existing caller -- `stdioMcpServersFor`'s answer, the tests -- still fits.
 */
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; versionNegotiation?: VersionNegotiation }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; versionNegotiation?: VersionNegotiation; oauth?: McpOAuthSetting };

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WS-24 — A STATUS PROBE, NOT A SECOND COPY OF EVERY SERVER.
//
// What reads this manager (the WS-24 inventory): `mcp.list` (the status + tool names the Mac's MCP tab
// and `winter mcp list` show), and `mcp.enable`/`mcp.disable`/`mcp.add`/`mcp.remove` (which re-probe or
// drop one name). Nothing else. Each server is PROBED: connected, its `tools/list` read, and closed again
// (`probe`) — no process or connection is kept (every session's child connects its own copy), and nothing
// is registered anywhere. `status` is that probe's answer and `toolNames` its listing, from the same
// moments as ever (boot for user stdio servers, the first `mcp.list {cwd}` for a project's, and every
// `mcp.enable`/`mcp.add`). The method names stay (`startAll`, `startOneUserServer`, `stopServer`,
// `stopAll`) because the `mcp.*` handlers call them; "start" means "probe", "stop" means "forget".
//
// WS-25 — THE RUNTIME'S OWN CLIENT, EVERY TRANSPORT. The probe no longer speaks through the daemon's
// hand-written 2024-11-05 stdio client (`client.ts`, retired): it connects through the agent SDK's public
// `@yanlinglabs/winter-agent-runtime/mcp-client` — the client a session's child uses, with the runtime's
// version negotiation, its stdio transport (explicit env allowlist, process-GROUP kill on close) and its
// cause-classified `McpConnectError`. So a status line and a session now fail, and succeed, for the same
// reasons.
//
//   - HTTP/SSE servers are probed too, LAZILY: never at boot (`startAll` is awaited by the daemon's boot and
//     must not wait on the network), but on the first `mcp.list` that finds one unprobed
//     (`ensureRemote`), and again after anything that changes its answer (`forgetRemote` — a sign-in or a
//     sign-out, an add, an enable). Only when the daemon wires `remote` (production does); a manager
//     without it keeps the pre-WS-25 behaviour of never connecting an http/sse server (the `mcp.list`
//     overlay reports it `"unmanaged"`), which is what every bare test harness gets.
//   - A sign-in rides the probe: `remote.oauthStore` is the daemon's ONE MCP OAuth store
//     (`runtime-sdk/mcp-oauth-store.ts`), so an http/sse server without a static `Authorization` header
//     connects with the stored bearer, and a missing or dead sign-in rejects `needs_auth` BEFORE any
//     request — reported `"needs-auth"`. The probe never refreshes on its own: the SDK refreshes an expired,
//     refreshable token in this process through `refreshMcpOAuthToken`'s single-flight, which is keyed on
//     the store OBJECT — the same object the daemon's refresh handler and its sign-in doors use, so a probe
//     and a session asking at once post ONE refresh (a rotating refresh token survives).
//   - A stdio probe needs a directory to start in (the runtime never starts one in the host's cwd): a
//     project's server starts in the project directory, as a session's would; a USER server — which has no
//     session — starts in the user's home directory (`stdioCwd`, overridable for tests).
// ════════════════════════════════════════════════════════════════════════════════════════════════

type ProjectState = { kind: "none" } | { kind: "probed"; servers: McpServerStatus[] };
type ProbeResult = { status: McpServerStatus["status"]; toolNames: string[]; tools?: McpProbedTool[] };

/**
 * WS-26: one action as the server's last successful `tools/list` described it — kept for the connector
 * permissions (`agent/mcp/connector-permissions.ts`): its description for the settings page, and whether
 * the server marked it read-only (`annotations.readOnlyHint === true`; anything else — false, absent, no
 * annotations at all — is `false`, which fails toward ask).
 */
export interface McpProbedTool {
  name: string;
  description?: string;
  readOnly: boolean;
}
export type McpConnect = (opts: ConnectMcpServerOptions) => Promise<ConnectedMcpClient>;

export class McpManager {
  private statuses = new Map<string, McpServerStatus>();
  private projects = new Map<string, ProjectState>();
  private inFlight = new Map<string, Promise<void>>();
  /** WS-25: user http/sse probes in flight, by name — two `mcp.list` calls join one probe. */
  private remoteInFlight = new Map<string, Promise<void>>();
  /**
   * WS-26: each server's actions as its last SUCCESSFUL probe listed them — user servers by name, a
   * project's by canonical dir then name. Kept apart from `statuses` (whose rows `mcp.list` returns as
   * they are) and deliberately STALE-TOLERANT: a failed or `needs-auth` probe, and `forgetRemote` (a
   * sign-in or sign-out), leave the last listing in place, because a stale answer about read-only is fine
   * while a missing one fails toward ask. Only `stopServer` (disable/remove) and `stopAll` drop it.
   */
  private userTools = new Map<string, McpProbedTool[]>();
  private projectTools = new Map<string, Map<string, McpProbedTool[]>>();
  constructor(private readonly deps: {
    trust: TrustStore;
    log?: (m: string) => void;
    /**
     * MEDIUM (fix wave, pre-merge review, finding 3): `settings.mcp.disabled`, read LIVE (never a
     * boot snapshot — same posture every other hot setting in this codebase has). `startAll`'s own
     * caller (`daemon.ts`) already pre-filters via `stdioMcpServersFor`, so this dep exists for
     * `doEnsureProject` — the manager's OWN project-file reader, which had no such filter at all, so
     * merely RENDERING the UI (`mcp.list {cwd}`, which calls `ensureProject`) spawned a server the
     * toggle says is disabled. Absent (every existing test/caller that predates this fix) means
     * "nothing disabled" — the pre-existing behavior, unchanged.
     */
    disabled?: () => ReadonlySet<string>;
    /**
     * WS-25: probe http/sse servers too (this file's header), with the daemon's ONE MCP OAuth store.
     * Absent: an http/sse server is never connected by the daemon (the pre-WS-25 behaviour).
     */
    remote?: { oauthStore: () => McpOAuthStore };
    /** WS-25: the directory a USER stdio server's probe starts in (default: the user's home directory). */
    stdioCwd?: string;
    /** Test seam: the SDK's `connectMcpServer`. */
    connect?: McpConnect;
  }) {}

  /**
   * The probe's WHOLE budget — the connect AND the `tools/list` together (fix round 1, I2):
   * WINTER_MCP_START_TIMEOUT_MS (default 10 s). A server that hangs at either step is a `"failed"` probe
   * within it, never a stalled daemon boot or a hung `mcp.list` (the MCP client's own request timeout is 60 s).
   */
  private timeoutMs(): number {
    const raw = Number(process.env.WINTER_MCP_START_TIMEOUT_MS ?? 10_000);
    return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
  }

  /**
   * One server's probe: connect it and read its `tools/list`, both inside ONE budget (`timeoutMs`), and
   * close it again —
   * ALWAYS, whether or not the listing succeeded (WS-24: nothing is left running; the SDK's stdio close
   * ends the server's whole process group). Every failure is caught HERE and reported (`"failed"`, or
   * `"needs-auth"` for a refused sign-in), so one bad server never rejects the `Promise.all` its caller runs
   * it under. The log line names the server and the SDK's typed code only — never a URL's query, a header
   * or anything a server sent.
   */
  private async probe(name: string, cfg: McpServerConfig, cwd: string, opts?: { label?: string; context?: string }): Promise<ProbeResult> {
    const remote = cfg.type === "http" || cfg.type === "sse";
    let client: ConnectedMcpClient | undefined;
    const budget = this.timeoutMs();
    const deadline = Date.now() + budget;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client = await (this.deps.connect ?? sdkConnectMcpServer)({
        name,
        config: toSdkConfig(cfg),
        connectTimeoutMs: budget,
        // No host UI answers a probe's elicitation: every one is declined deterministically, never left hanging.
        elicitationAsk: createElicitationAsker(undefined),
        ...(remote ? {} : { cwd }),
        ...(remote && this.deps.remote !== undefined ? { oauthStore: this.deps.remote.oauthStore() } : {}),
      });
      // What is LEFT of the one budget bounds the listing: the connect's timeout never covered it.
      const remaining = Math.max(0, deadline - Date.now());
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpConnectError("timeout", `mcp probe: '${name}' did not list its tools within ${budget}ms`)), remaining);
      });
      const tools = await Promise.race([client.listTools(), expired]);
      return {
        status: "connected",
        toolNames: tools.map((t) => t.name),
        tools: tools.map((t) => ({
          name: t.name,
          ...(typeof t.description === "string" && t.description !== "" ? { description: t.description } : {}),
          readOnly: t.annotations?.readOnlyHint === true,
        })),
      };
    } catch (e) {
      const code = e instanceof McpConnectError ? e.code : e instanceof Error ? e.name : "unknown";
      if (code === "needs_auth") {
        this.deps.log?.(`mcp: ${opts?.label ?? "server"} '${name}'${opts?.context ?? ""} needs sign-in (winter mcp login ${name})`);
        return { status: "needs-auth", toolNames: [] };
      }
      this.deps.log?.(`mcp: ${opts?.label ?? "server"} '${name}'${opts?.context ?? ""} failed to start (${code})`);
      return { status: "failed", toolNames: [] };
    } finally {
      clearTimeout(timer);
      await client?.close().catch(() => { /* a probe's close never fails the probe */ });
    }
  }

  private row(name: string, cfg: McpServerConfig, result: ProbeResult, source: McpServerStatus["source"]): McpServerStatus {
    return { name, status: result.status, toolNames: result.toolNames, source, ...(cfg.type === "http" || cfg.type === "sse" ? { transport: cfg.type } : {}) };
  }

  /** WS-26: record a user server's listing — only a successful probe replaces the last one. */
  private noteUserTools(name: string, result: ProbeResult): void {
    if (result.tools !== undefined) this.userTools.set(name, result.tools);
  }

  /** Boot: probe the user servers given (the daemon passes its stdio ones — `stdioMcpServersFor`). */
  async startAll(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.all(Object.entries(servers).map(async ([name, cfg]) => {
      const result = await this.probe(name, cfg, this.userCwd());
      this.noteUserTools(name, result);
      this.statuses.set(name, this.row(name, cfg, result, "user"));
    }));
  }

  private userCwd(): string {
    return this.deps.stdioCwd ?? homedir();
  }

  /**
   * MEDIUM (fix wave, pre-merge review, finding 3, symmetry): the single-entry mirror of `startAll` —
   * `mcp.enable`'s and `mcp.add`'s handlers (`ipc/server.ts`) use it so a just-(re-)enabled or just-added
   * USER-tier server reports a fresh status at once, never needing a daemon restart. WS-24: a re-probe.
   */
  async startOneUserServer(name: string, cfg: McpServerConfig): Promise<void> {
    const result = await this.probe(name, cfg, this.userCwd());
    this.noteUserTools(name, result);
    this.statuses.set(name, this.row(name, cfg, result, "user"));
  }

  /** WS-25: whether this manager probes http/sse servers at all (`deps.remote`). */
  get probesRemote(): boolean {
    return this.deps.remote !== undefined;
  }

  /**
   * WS-25: the LAZY http/sse probe of the USER servers given (`mcp.list` passes the live user scope's,
   * disabled ones excluded). Probes each name not yet recorded; a recorded one is kept until `forgetRemote`.
   * A no-op without `deps.remote`. Concurrent calls for one name join one probe.
   */
  async ensureRemote(servers: Record<string, McpServerConfig>): Promise<void> {
    if (this.deps.remote === undefined) return;
    await Promise.all(Object.entries(servers).map(([name, cfg]) => {
      if (cfg.type !== "http" && cfg.type !== "sse") return Promise.resolve();
      if (this.statuses.has(name)) return Promise.resolve();
      const pending = this.remoteInFlight.get(name);
      if (pending) return pending;
      const p = this.probe(name, cfg, this.userCwd())
        .then((result) => { this.noteUserTools(name, result); this.statuses.set(name, this.row(name, cfg, result, "user")); })
        .finally(() => this.remoteInFlight.delete(name));
      this.remoteInFlight.set(name, p);
      return p;
    }));
  }

  /**
   * Trust-gated project `.winter/mcp.json` probe. Idempotent per canonicalized cwd (a "none" or
   * "probed" record short-circuits future calls). SECURITY: an untrusted dir returns WITHOUT
   * recording anything — nothing is read/spawned, and a later `trust.trust(dir)` + another
   * `ensureProject` call will retry. Defensive: a missing/malformed file degrades to a recorded
   * "none" rather than throwing. Every probe is individually guarded so one bad server doesn't block
   * its siblings. CONCURRENCY: two calls for the same canonicalized dir join a single in-flight run
   * (via `inFlight`) so a project's servers are never probed twice at once. NOTE: deliberately NOT
   * declared `async` — an `async` method always wraps its return value in a brand-new promise, which
   * would defeat the guard (concurrent callers must get back the literal same promise object).
   */
  ensureProject(cwd: string): Promise<void> {
    let dir: string;
    try { dir = realpathSync(cwd); } catch { dir = cwd; }
    if (this.projects.has(dir)) return Promise.resolve(); // already probed or recorded "none"
    const pending = this.inFlight.get(dir);
    if (pending) return pending; // an ensureProject is already running for this dir — join it
    const p = this.doEnsureProject(dir).finally(() => this.inFlight.delete(dir));
    this.inFlight.set(dir, p);
    return p;
  }

  private async doEnsureProject(dir: string): Promise<void> {
    if (!projectScopeTrusted(dir, this.deps.trust)) return; // untrusted → not recorded (retry after trust)

    // WS-21 (spec §4.4): the project file is `<project root>/.winter/mcp.json` (the repo-root `.mcp.json`
    // is no longer read) — the root the run home's builder reads it at.
    // R.3 residual: the project scope's root (`projectScopeRootFor`: a linked worktree's own top).
    const read = readRawProjectMcpConfig(projectScopeRootFor(dir));
    if (read.kind !== "ok" || Object.keys(read.servers).length === 0) {
      this.projects.set(dir, { kind: "none" }); // missing/malformed/empty file → record none
      return;
    }

    // PARITY FIX (controller-directed): PER-ENTRY validation (`parseProjectMcpServers`, shared with
    // `runtime-sdk/external-mcp.ts` and `mcp-cli.ts`'s `mcp get`) — an entry that doesn't fit ANY
    // recognized shape (stdio/http/sse) is skipped and logged BY NAME, never taking its siblings
    // down with it.
    const { servers: validated, skipped } = parseProjectMcpServers(read.servers);
    for (const { name, reason } of skipped) {
      this.deps.log?.(`mcp: project server '${name}' (${dir}) skipped — ${reason}`);
    }

    // MEDIUM (fix wave, pre-merge review, finding 3): a name in `settings.mcp.disabled` is never
    // probed here — the same withholding `stdioMcpServersFor` already applies to `startAll`'s user
    // servers. Still RECORDED (never started, `toolNames: []`) rather than omitted entirely, so
    // `mcp.list`'s own settings overlay has a row to rewrite to `status: "disabled"`.
    const disabled = this.deps.disabled?.() ?? new Set<string>();
    const servers: McpServerStatus[] = [];
    const tools = this.projectTools.get(dir) ?? new Map<string, McpProbedTool[]>();
    await Promise.all(Object.entries(validated).map(async ([name, entry]) => {
      const remote = entry.type !== "stdio";
      // Transport checked BEFORE `disabled` (deliberately): without `deps.remote` an http/sse entry is
      // never probed by this manager at all, disabled or not — the session's own child connects it.
      if (remote && this.deps.remote === undefined) {
        this.deps.log?.(`mcp: project server '${name}' (${dir}) is ${entry.type} — not probed by the daemon (the session's child connects to it directly)`);
        return;
      }
      const cfg: McpServerConfig = entry;
      if (disabled.has(name)) {
        servers.push(this.row(name, cfg, { status: "failed", toolNames: [] }, "project"));
        return;
      }
      // A project's stdio server starts in the project directory, as a session's child would start it.
      const result = await this.probe(name, cfg, dir, { label: "project server", context: ` (${dir})` });
      if (result.tools !== undefined) tools.set(name, result.tools);
      servers.push(this.row(name, cfg, result, "project"));
    }));
    if (tools.size > 0) this.projectTools.set(dir, tools);
    this.projects.set(dir, { kind: "probed", servers });
  }

  /**
   * WS-26: a server's actions as its last successful probe listed them — the user-scope listing and, with a
   * `cwd`, that project's (already probed; this never probes). `undefined` when no listing of the name is
   * known. SYNC — a permission decision reads it on every connector call and must never wait on a probe.
   */
  toolsFor(server: string, cwd?: string): McpProbedTool[] | undefined {
    const rows = this.listingsFor(server, cwd);
    if (rows.length === 0) return undefined;
    if (rows.length === 1) return rows[0];
    const merged = new Map<string, McpProbedTool>();
    for (const row of rows) {
      for (const t of row) {
        const seen = merged.get(t.name);
        // The same name in two scopes: read-only only if EVERY listing says so (fail toward ask).
        merged.set(t.name, seen === undefined ? t : { ...seen, readOnly: seen.readOnly && t.readOnly });
      }
    }
    return [...merged.values()];
  }

  /**
   * WS-26: did the server mark this action read-only? `true`/`false` when a listing names the action,
   * `undefined` when none does (an unknown server, an unprobed one, a tool its listing lacks). When the
   * name is listed in more than one scope, every listing that names the tool must say read-only.
   */
  readOnlyHint(server: string, tool: string, cwd?: string): boolean | undefined {
    let answer: boolean | undefined;
    for (const row of this.listingsFor(server, cwd)) {
      const t = row.find((x) => x.name === tool);
      if (t === undefined) continue;
      answer = (answer ?? true) && t.readOnly;
    }
    return answer;
  }

  /**
   * WS-26 (review r1, minor 6): the read-only answer from ONE scope's listing — the user scope's, or the
   * project's for `cwd` — for a caller that knows which scope the name resolves to for a session (local >
   * project > user). `undefined` when that scope has no listing naming the tool (a project whose servers
   * were never probed included): toward ask, never borrowed from another scope's same-named server.
   */
  readOnlyHintIn(scope: "user" | { project: string }, server: string, tool: string): boolean | undefined {
    let row: McpProbedTool[] | undefined;
    if (scope === "user") {
      row = this.userTools.get(server);
    } else {
      let dir: string;
      try { dir = realpathSync(scope.project); } catch { dir = scope.project; }
      row = this.projectTools.get(dir)?.get(server);
    }
    return row?.find((t) => t.name === tool)?.readOnly;
  }

  /** WS-26: whether any status (any probe outcome) is recorded for a USER server of this name. */
  hasUserStatus(name: string): boolean {
    return this.statuses.has(name);
  }

  private listingsFor(server: string, cwd?: string): McpProbedTool[][] {
    const out: McpProbedTool[][] = [];
    const user = this.userTools.get(server);
    if (user !== undefined) out.push(user);
    if (cwd) {
      let dir: string;
      try { dir = realpathSync(cwd); } catch { dir = cwd; }
      const project = this.projectTools.get(dir)?.get(server);
      if (project !== undefined) out.push(project);
    }
    return out;
  }

  /**
   * SYNC/PURE: returns already-known statuses without spawning/reading anything. User servers
   * (source "user") are always included; project servers (source "project") for `cwd` are included
   * only if `ensureProject(cwd)` has already recorded a "probed" state for it — this method does NOT
   * call `ensureProject` itself (callers, e.g. the daemon's request handler, must
   * `await ensureProject(cwd)` first).
   */
  list(cwd?: string): McpServerStatus[] {
    const out = [...this.statuses.values()];
    if (cwd) {
      let dir: string;
      try { dir = realpathSync(cwd); } catch { dir = cwd; }
      const state = this.projects.get(dir);
      if (state?.kind === "probed") out.push(...state.servers);
    }
    return out;
  }

  /**
   * MEDIUM (fix wave, pre-merge review, finding 3): a RUNTIME `mcp.disable`/`mcp.remove` drops the name's
   * recorded status — user tier AND every probed project's row under the same name — so `mcp.list`
   * reports it from the settings overlay (disabled, or gone) rather than from a stale probe. WS-24: there
   * is no process to stop any more (a probe closes what it opens). A name with no record anywhere is a
   * no-op.
   */
  stopServer(name: string): void {
    this.statuses.delete(name);
    this.userTools.delete(name);
    for (const tools of this.projectTools.values()) tools.delete(name);
    for (const state of this.projects.values()) {
      if (state.kind === "probed") state.servers = state.servers.filter((s) => s.name !== name);
    }
  }

  /**
   * WS-25: a sign-in or a sign-out changed what a probe of an http/sse server would answer — forget every
   * recorded http/sse status so the next `mcp.list` probes them again: user rows are dropped (re-probed by
   * `ensureRemote`), and every probed PROJECT that recorded one is forgotten whole (its next
   * `ensureProject` re-reads it). A sign-in is keyed by URL and the manager keeps no URLs, so this forgets
   * them all rather than guess — a re-probe is one `tools/list`. Stdio rows never carry a sign-in and stay.
   */
  forgetRemote(): void {
    for (const [name, row] of this.statuses) {
      if (row.transport !== undefined) this.statuses.delete(name);
    }
    for (const [dir, state] of this.projects) {
      if (state.kind === "probed" && state.servers.some((s) => s.transport !== undefined)) this.projects.delete(dir);
    }
  }

  /** Forget every recorded status (daemon shutdown). WS-24: nothing is left running to stop. */
  stopAll(): void {
    this.statuses.clear();
    this.projects.clear();
    this.userTools.clear();
    this.projectTools.clear();
  }
}

/** A Winter config onto the SDK's process-transport config: copies only, never a shared object. */
function toSdkConfig(cfg: McpServerConfig): ConnectMcpServerOptions["config"] {
  const negotiation = cfg.versionNegotiation === undefined ? {} : { versionNegotiation: typeof cfg.versionNegotiation === "string" ? cfg.versionNegotiation : { pin: cfg.versionNegotiation.pin } };
  if (!("command" in cfg)) {
    return {
      type: cfg.type,
      url: cfg.url,
      ...(cfg.headers === undefined ? {} : { headers: { ...cfg.headers } }),
      ...(cfg.oauth === undefined ? {} : { oauth: structuredClone(cfg.oauth) as NonNullable<Extract<ConnectMcpServerOptions["config"], { type: "http" }>["oauth"]> }),
      ...negotiation,
    };
  }
  return {
    type: "stdio",
    command: cfg.command,
    ...(cfg.args === undefined ? {} : { args: [...cfg.args] }),
    ...(cfg.env === undefined ? {} : { env: { ...cfg.env } }),
    ...negotiation,
  };
}
