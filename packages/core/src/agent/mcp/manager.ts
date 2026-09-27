import { realpathSync } from "node:fs";
import { McpStdioClient } from "./client";
import { readRawProjectMcpConfig, parseProjectMcpServers } from "./project-file";
import { projectScopeRootFor, projectScopeTrusted } from "../../runtime-sdk/run-home-input";
import type { TrustStore } from "../trust";

export interface McpServerStatus { name: string; status: "connected" | "failed"; toolNames: string[]; source: "user" | "project" | "plugin" }
export interface McpServerConfig { command: string; args?: string[]; env?: Record<string, string> }

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WS-24 — A STATUS PROBE, NOT A SECOND COPY OF EVERY SERVER.
//
// What reads this manager (the WS-24 inventory): `mcp.list` (the status + tool names the Mac's MCP tab
// and `winter mcp list` show), and `mcp.enable`/`mcp.disable`/`mcp.add`/`mcp.remove` (which re-probe or
// drop one name). Nothing else. It used to START every user stdio server at boot — and every trusted
// project's on the first `mcp.list {cwd}` — keep each one running for the daemon's life, and register its
// tools into the daemon's shared `ToolRegistry` as `mcp__<server>__<tool>`. No session ever reached those
// tools: every runtime child connects its OWN copy of the same servers (`runtime-sdk/external-mcp.ts`),
// the one door from the shared registry to a session is the `external` capability, which reads
// `plugin__…` rows only (`daemon.ts`), and the MCP-resources tools that once read these clients are
// retired. So the daemon ran a duplicate of each server — a second process holding whatever the server
// holds (a lock, a port, a login) — for a status line.
//
// Now each server is PROBED: connected, its `tools/list` read, and closed again (`probe`). `status` is
// that probe's answer ("connected" = the handshake and the tool listing succeeded when it was taken; the
// wire value is unchanged) and `toolNames` its listing — the same fields `mcp.list` always reported,
// from the same moments (boot for user servers, the first `mcp.list {cwd}` for a project's, and every
// `mcp.enable`/`mcp.add`), with no process left behind. The method names stay (`startAll`,
// `startOneUserServer`, `stopServer`, `stopAll`) because the `mcp.*` handlers call them; "start" now
// means "probe", "stop" means "forget".
//
// The client is still the daemon's own hand-written stdio client (`client.ts`, protocol 2024-11-05, stdio
// only). Replacing it with the agent SDK's `connectMcpServer` — every transport, the runtime's own
// version negotiation, the status a session's child would see — is now POSSIBLE: this build's pin
// (0.0.28) exports it from a public subpath, `@yanlinglabs/winter-agent-runtime/mcp-client`. WS-25 does
// the refactor; this manager is untouched here.
// ════════════════════════════════════════════════════════════════════════════════════════════════

type ProjectState = { kind: "none" } | { kind: "probed"; servers: McpServerStatus[] };
type ProbeResult = { status: "connected" | "failed"; toolNames: string[] };

export class McpManager {
  private statuses = new Map<string, McpServerStatus>();
  private projects = new Map<string, ProjectState>();
  private inFlight = new Map<string, Promise<void>>();
  constructor(private readonly deps: {
    trust: TrustStore;
    log?: (m: string) => void;
    /**
     * MEDIUM (fix wave, pre-merge review, finding 3): `settings.mcp.disabled`, read LIVE (never a
     * boot snapshot — same posture every other hot setting in this codebase has). `startAll`'s own
     * caller (`daemon.ts`) already pre-filters via `stdioMcpServersFor`, so this dep exists for
     * `doEnsureProject` — the manager's OWN `.mcp.json` reader, which had no such filter at all, so
     * merely RENDERING the UI (`mcp.list {cwd}`, which calls `ensureProject`) spawned a server the
     * toggle says is disabled. Absent (every existing test/caller that predates this fix) means
     * "nothing disabled" — the pre-existing behavior, unchanged.
     */
    disabled?: () => ReadonlySet<string>;
  }) {}

  /**
   * One server's probe: spawn it, handshake under WINTER_MCP_START_TIMEOUT_MS (default 10 s — a hung server
   * is a `"failed"` probe, never a hung `mcp.list`), read its `tools/list`, and close it again — its whole
   * process group, SIGKILL after a grace (`McpStdioClient.stop`) — ALWAYS, whether or not the handshake
   * succeeded (WS-24: nothing is left running). Every
   * failure is caught HERE and reported as `"failed"`, so one bad server never rejects the `Promise.all` its
   * caller runs it under.
   */
  private async probe(name: string, cfg: McpServerConfig, opts?: { label?: string; context?: string }): Promise<ProbeResult> {
    const client = new McpStdioClient(cfg);
    try {
      await client.start();
      return { status: "connected", toolNames: client.tools().map((t) => t.name) };
    } catch (e) {
      this.deps.log?.(`mcp: ${opts?.label ?? "server"} '${name}'${opts?.context ?? ""} failed to start: ${(e as Error).message}`);
      return { status: "failed", toolNames: [] };
    } finally {
      client.stop();
    }
  }

  async startAll(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.all(Object.entries(servers).map(async ([name, cfg]) => {
      const { status, toolNames } = await this.probe(name, cfg);
      this.statuses.set(name, { name, status, toolNames, source: "user" });
    }));
  }

  /**
   * MEDIUM (fix wave, pre-merge review, finding 3, symmetry): the single-entry mirror of `startAll` —
   * `mcp.enable`'s and `mcp.add`'s handlers (`ipc/server.ts`) use it so a just-(re-)enabled or just-added
   * USER-tier server reports a fresh status at once, never needing a daemon restart. WS-24: a re-probe.
   */
  async startOneUserServer(name: string, cfg: McpServerConfig): Promise<void> {
    const { status, toolNames } = await this.probe(name, cfg);
    this.statuses.set(name, { name, status, toolNames, source: "user" });
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
    await Promise.all(Object.entries(validated).map(async ([name, entry]) => {
      // Transport checked BEFORE `disabled` (deliberately): an http/sse entry was never probed by this
      // manager at all, disabled or not (no in-daemon client for those transports) — reported by
      // `mcp.list`'s own union for user servers, and connected by the session's own child directly.
      if (entry.type !== "stdio") {
        this.deps.log?.(`mcp: project server '${name}' (${dir}) is ${entry.type} — no in-daemon client, not probed by the daemon (the session's child connects to it directly)`);
        return;
      }
      if (disabled.has(name)) {
        servers.push({ name, status: "failed", toolNames: [], source: "project" });
        return;
      }
      const { status, toolNames } = await this.probe(name, { command: entry.command, args: entry.args, env: entry.env }, {
        label: "project server",
        context: ` (${dir})`,
      });
      servers.push({ name, status, toolNames, source: "project" });
    }));
    this.projects.set(dir, { kind: "probed", servers });
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
    for (const state of this.projects.values()) {
      if (state.kind === "probed") state.servers = state.servers.filter((s) => s.name !== name);
    }
  }

  /** Forget every recorded status (daemon shutdown). WS-24: nothing is left running to stop. */
  stopAll(): void {
    this.statuses.clear();
    this.projects.clear();
  }
}
