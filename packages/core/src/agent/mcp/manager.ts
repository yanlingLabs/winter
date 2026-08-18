import { z } from "zod";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { McpStdioClient } from "./client";
import type { ToolRegistry } from "../tools/registry";
import type { TrustStore } from "../trust";

export interface McpServerStatus { name: string; status: "connected" | "failed"; toolNames: string[]; source: "user" | "project" | "plugin" }
export interface McpServerConfig { command: string; args?: string[]; env?: Record<string, string> }

const ProjectMcpConfig = z.object({
  mcpServers: z.record(z.string(), z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
});
type ProjectState = { kind: "none" } | { kind: "started"; servers: McpServerStatus[]; clients: Array<{ name: string; client: McpStdioClient }>; toolNames: string[] };
type StartOneResult = { status: "connected" | "failed"; toolNames: string[]; client?: McpStdioClient };

export class McpManager {
  private clients = new Map<string, McpStdioClient>();
  private statuses = new Map<string, McpServerStatus>();
  private projects = new Map<string, ProjectState>();
  private inFlight = new Map<string, Promise<void>>();
  private pluginState: Array<{ display: string; status: McpServerStatus["status"]; toolNames: string[]; client?: McpStdioClient }> = [];
  private pluginToolNames: string[] = []; // full `mcp__<plugin>_<server>__<tool>` names, for stopAll teardown
  constructor(private readonly deps: { registry: ToolRegistry; trust: TrustStore; log?: (m: string) => void }) {}

  /**
   * Shared per-server bring-up used by startAll/doEnsureProject/startPlugins: spawn the client,
   * handshake under NORMA_MCP_START_TIMEOUT_MS, register its tools as
   * `mcp__<serverKey>__<tool>`, and report a status. Every failure (start timeout/error, or —
   * in "throw" collision mode — a registration throw) is caught HERE so one bad server never
   * rejects the `Promise.all` its caller runs it under.
   *
   * `opts.onCollision` controls what happens when a tool name is already registered:
   *  - "skip" (project/plugin bring-up): pre-check `registry.has(full)` and skip + log just
   *    that one tool (collisions are expected across namespaces there) — the whole server still
   *    ends up "connected" as long as it started. A register() throw (e.g. a race) is likewise
   *    caught per-tool and skipped, never failing the server.
   *  - "throw" (startAll/user servers): no pre-check — `registry.register` is called directly
   *    and left free to throw, which the outer catch below turns into a whole-server "failed"
   *    (this fail-fast semantics is pinned by an existing test: a server whose OWN tool list has
   *    an internal duplicate name is entirely marked failed, not partially registered).
   */
  private async startOne(
    serverKey: string,
    cfg: McpServerConfig,
    opts?: { scope?: string; onCollision?: "skip" | "throw"; label?: string; context?: string },
  ): Promise<StartOneResult> {
    const client = new McpStdioClient(cfg, this.deps.log);
    const label = opts?.label ?? "server";
    try {
      await client.start();
      const toolNames: string[] = [];
      for (const t of client.tools()) {
        const full = `mcp__${serverKey}__${t.name}`;
        if (opts?.onCollision === "skip") {
          if (this.deps.registry.has(full)) {
            this.deps.log?.(`mcp: ${label} tool '${full}' collides — skipped`);
            continue;
          }
          try {
            this.deps.registry.register({
              name: full,
              description: t.description,
              args: z.object({}).passthrough(),
              rawParameters: t.inputSchema,
              scope: opts?.scope,
              run: (a, ctx) => client.callTool(t.name, a, ctx.signal),
            });
          } catch (e) {
            this.deps.log?.(`mcp: register '${full}' failed: ${(e as Error).message}`);
            continue;
          }
        } else {
          this.deps.registry.register({
            name: full,
            description: t.description,
            args: z.object({}).passthrough(),
            rawParameters: t.inputSchema,
            scope: opts?.scope,
            run: (a, ctx) => client.callTool(t.name, a, ctx.signal),
          });
        }
        toolNames.push(t.name);
      }
      return { status: "connected", toolNames, client };
    } catch (e) {
      this.deps.log?.(`mcp: ${label} '${serverKey}'${opts?.context ?? ""} failed to start: ${(e as Error).message}`);
      client.stop();
      return { status: "failed", toolNames: [] };
    }
  }

  async startAll(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.all(Object.entries(servers).map(async ([name, cfg]) => {
      const { status, toolNames, client } = await this.startOne(name, cfg, { onCollision: "throw" });
      if (client) this.clients.set(name, client);
      this.statuses.set(name, { name, status, toolNames, source: "user" });
    }));
  }

  /**
   * Trust-gated project `.mcp.json` bring-up. Idempotent per canonicalized cwd (a "none" or
   * "started" record short-circuits future calls). SECURITY: an untrusted dir returns WITHOUT
   * recording anything — nothing is read/spawned/registered, and a later `trust.trust(dir)` +
   * another `ensureProject` call will retry and start it. Defensive: a missing/malformed
   * `.mcp.json` degrades to a recorded "none" rather than throwing. Every server start is
   * individually guarded (via `startOne`) so one bad server doesn't block its siblings.
   * CONCURRENCY: two calls for the same canonicalized dir join a single in-flight run (via
   * `inFlight`) so a project's servers are never spawned twice / a first run's clients never
   * get orphaned by a second run overwriting `projects`. NOTE: deliberately NOT declared
   * `async` — an `async` method always wraps its return value in a brand-new promise, which
   * would defeat the guard (concurrent callers must get back the literal same promise object,
   * not two different promises that merely resolve at the same time).
   */
  ensureProject(cwd: string): Promise<void> {
    let dir: string;
    try { dir = realpathSync(cwd); } catch { dir = cwd; }
    if (this.projects.has(dir)) return Promise.resolve(); // already started or recorded "none"
    const pending = this.inFlight.get(dir);
    if (pending) return pending; // an ensureProject is already running for this dir — join it
    const p = this.doEnsureProject(dir).finally(() => this.inFlight.delete(dir));
    this.inFlight.set(dir, p);
    return p;
  }

  private async doEnsureProject(dir: string): Promise<void> {
    if (!this.deps.trust.isTrusted(dir)) return; // untrusted → not recorded (retry after trust)

    let cfg: z.infer<typeof ProjectMcpConfig>;
    try {
      cfg = ProjectMcpConfig.parse(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")));
    } catch {
      this.projects.set(dir, { kind: "none" }); // missing/malformed → record none
      return;
    }
    const servers = cfg.mcpServers ?? {};
    if (Object.keys(servers).length === 0) {
      this.projects.set(dir, { kind: "none" });
      return;
    }

    const state: ProjectState = { kind: "started", servers: [], clients: [], toolNames: [] };
    await Promise.all(Object.entries(servers).map(async ([name, sc]) => {
      const { status, toolNames, client } = await this.startOne(name, sc, {
        scope: dir,
        onCollision: "skip",
        label: "project server",
        context: ` (${dir})`,
      });
      if (client) state.clients.push({ name, client });
      for (const t of toolNames) state.toolNames.push(`mcp__${name}__${t}`);
      state.servers.push({ name, status, toolNames, source: "project" });
    }));
    this.projects.set(dir, state);
  }

  /**
   * Start the MCP servers of EXPLICITLY ENABLED plugins. Boot-time, like user servers — the
   * daemon passes only consented plugins (consent is `settings.plugins.enabled` +, per-exec-class,
   * `pluginMcpEligible`, checked by the caller); this method does not itself consult any
   * consent/trust store. Tools are namespaced per-plugin-per-server as
   * `mcp__<plugin>_<server>__<tool>` (GLOBAL scope — no `scope` field — unlike project servers,
   * which are cwd-scoped). Each server is started via the shared `startOne` helper in "skip"
   * collision mode, so one bad/colliding server never blocks its siblings or the rest of the
   * plugin list.
   *
   * Two sources per plugin (design spec §2 — "mcpServers may now come from the manifest instead
   * of .mcp.json (both accepted; manifest wins on conflict)"):
   *  - `manifestServers` present (norma-plugin.json `contributes.mcpServers`, passed by the
   *    caller): those servers are started and `<dir>/.mcp.json` is IGNORED entirely for this
   *    plugin — manifest wins, no merge.
   *  - `manifestServers` absent: falls back to the legacy `<dir>/.mcp.json` path, unchanged. A
   *    missing/malformed file there is defensive: logged and skipped, never throws.
   */
  async startPlugins(
    plugins: Array<{
      name: string; dir: string;
      manifestServers?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>;
    }>,
  ): Promise<void> {
    for (const { name, dir, manifestServers } of plugins) {
      let servers: Array<[string, McpServerConfig]>;
      if (manifestServers) {
        servers = manifestServers.map((s): [string, McpServerConfig] => [s.name, { command: s.command, args: s.args, env: s.env }]);
      } else {
        let cfg: z.infer<typeof ProjectMcpConfig>;
        try {
          cfg = ProjectMcpConfig.parse(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")));
        } catch {
          this.deps.log?.(`plugin ${name}: no/invalid .mcp.json — no servers started`);
          continue;
        }
        servers = Object.entries(cfg.mcpServers ?? {});
      }
      await Promise.all(servers.map(async ([server, sc]) => {
        // serverKey namespaces the tools per-plugin: mcp__<plugin>_<server>__<tool>
        const serverKey = `${name}_${server}`;
        const entry = await this.startOne(serverKey, sc, { onCollision: "skip", label: "plugin" });
        this.pluginState.push({ display: `${name}:${server}`, status: entry.status, toolNames: entry.toolNames, client: entry.client });
        for (const t of entry.toolNames) this.pluginToolNames.push(`mcp__${serverKey}__${t}`);
      }));
    }
  }

  /**
   * SYNC/PURE: returns already-known statuses without spawning/reading anything. User servers
   * (source "user") and plugin servers (source "plugin") are always included; project servers
   * (source "project") for `cwd` are included only if `ensureProject(cwd)` has already recorded
   * a "started" state for it — this method does NOT call `ensureProject` itself (callers, e.g.
   * the daemon's request handler, must `await ensureProject(cwd)` first).
   */
  list(cwd?: string): McpServerStatus[] {
    const out = [...this.statuses.values()];
    if (cwd) {
      let dir: string;
      try { dir = realpathSync(cwd); } catch { dir = cwd; }
      const state = this.projects.get(dir);
      if (state?.kind === "started") out.push(...state.servers);
    }
    out.push(...this.pluginState.map((p): McpServerStatus => ({ name: p.display, status: p.status, toolNames: p.toolNames, source: "plugin" })));
    return out;
  }

  /**
   * The same three-source union `list(cwd)` reports statuses for, but paired with the actual
   * client each entry is addressed by (`list_mcp_resources`/`read_mcp_resource`'s `server` arg) —
   * user servers by their config name, a trusted+started project's servers by their config name
   * (scoped to `cwd`, same "started" gate as `list()`), plugin servers by their `display`
   * ("<plugin>:<server>") since that's the only name a caller of THIS manager instance has to
   * address them by. Live/SYNC — no spawning, mirrors `list()`.
   */
  private visibleClients(cwd?: string): Array<{ name: string; client: McpStdioClient }> {
    const out: Array<{ name: string; client: McpStdioClient }> = [];
    for (const [name, client] of this.clients) out.push({ name, client });
    if (cwd) {
      let dir: string;
      try { dir = realpathSync(cwd); } catch { dir = cwd; }
      const state = this.projects.get(dir);
      if (state?.kind === "started") out.push(...state.clients);
    }
    for (const p of this.pluginState) if (p.client) out.push({ name: p.display, client: p.client });
    return out;
  }

  /**
   * Resource-capable, currently-alive servers visible for `cwd` (MCP resources — CC parity:
   * ListMcpResourcesTool's "across every resource-capable connected server" fan-out when its
   * `server` arg is omitted). A dead client (crashed after connecting) is excluded — same "not
   * currently usable" bar `execute()`'s own dead-client callTool would eventually hit.
   */
  resourceServers(cwd?: string): Array<{ name: string; client: McpStdioClient }> {
    return this.visibleClients(cwd).filter((e) => !e.client.dead && e.client.resourcesCapable());
  }

  /**
   * Look up ANY visible server by name (regardless of resource capability) — lets
   * list_mcp_resources/read_mcp_resource's scoped (`server` given) path distinguish "unknown
   * server" from "server has no resources" instead of collapsing both into one message.
   */
  findServer(cwd: string | undefined, name: string): McpStdioClient | undefined {
    return this.visibleClients(cwd).find((e) => e.name === name && !e.client.dead)?.client;
  }

  stopAll(): void {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
    for (const state of this.projects.values()) {
      if (state.kind === "started") {
        for (const { client } of state.clients) client.stop();
        for (const n of state.toolNames) this.deps.registry.unregister(n);
      }
    }
    this.projects.clear();
    for (const p of this.pluginState) p.client?.stop();
    for (const n of this.pluginToolNames) this.deps.registry.unregister(n);
    this.pluginState = [];
    this.pluginToolNames = [];
  }
}
