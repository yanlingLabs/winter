import { spawn, type ChildProcess } from "node:child_process";

export interface McpToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }
// MCP resources (CC parity: ListMcpResourcesTool/ReadMcpResourceTool) — standard `resources/list`
// / `resources/read` result shapes.
export interface McpResourceInfo { uri: string; name?: string; description?: string; mimeType?: string }
export interface McpResourceContent { uri: string; mimeType?: string; text?: string; blob?: string }

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, rej) => {
    if (signal.aborted) return rej(new Error("aborted"));
    signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
  });
}

export class McpStdioClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  private _tools: McpToolInfo[] = [];
  private _dead = false;
  // Set from the initialize handshake's OWN result.capabilities.resources — presence (even `{}`)
  // means the server declares resources support, per the MCP spec. Absent (undefined) → false.
  private _resourcesCapable = false;
  constructor(private readonly cfg: { command: string; args?: string[]; env?: Record<string, string> }) {}

  get dead(): boolean { return this._dead; }
  tools(): McpToolInfo[] { return this._tools; }
  resourcesCapable(): boolean { return this._resourcesCapable; }

  async start(timeoutMs = Number(process.env.WINTER_MCP_START_TIMEOUT_MS ?? 10000)): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], { env: { ...process.env, ...this.cfg.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.on("error", (e) => this.die(e instanceof Error ? e : new Error(String(e))));
    child.on("exit", () => this.die(new Error("mcp server exited")));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    // stderr captured but not fatal:
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", () => { /* could log to daemon log */ });

    const handshake = (async () => {
      const initRes = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "winter", version: "0.0.1" } });
      this._resourcesCapable = !!(initRes && typeof initRes === "object" && initRes.capabilities && typeof initRes.capabilities === "object" && "resources" in initRes.capabilities);
      this.notify("notifications/initialized", {});
      const res = await this.request("tools/list", {});
      this._tools = (res?.tools ?? []).map((t: any) => ({ name: String(t.name), description: String(t.description ?? ""), inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> }));
    })();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`mcp start timeout after ${timeoutMs}ms`)), timeoutMs); });
    try { await Promise.race([handshake, timeout]); } finally { clearTimeout(timer!); }
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    if (this._dead) throw new Error("mcp server is not running");
    const p = this.request("tools/call", { name, arguments: args ?? {} });
    const res = signal ? await Promise.race([p, abortPromise(signal)]) : await p;
    const content: any[] = res?.content ?? [];
    const text = content.map((c) => (c?.type === "text" ? String(c.text ?? "") : "[non-text content omitted]")).join("");
    return text || (res?.isError ? "[mcp tool error]" : "");
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceInfo[]> {
    if (this._dead) throw new Error("mcp server is not running");
    const p = this.request("resources/list", {});
    const res = signal ? await Promise.race([p, abortPromise(signal)]) : await p;
    const resources: any[] = res?.resources ?? [];
    return resources.map((r) => ({
      uri: String(r?.uri ?? ""),
      name: r?.name !== undefined ? String(r.name) : undefined,
      description: r?.description !== undefined ? String(r.description) : undefined,
      mimeType: r?.mimeType !== undefined ? String(r.mimeType) : undefined,
    }));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    if (this._dead) throw new Error("mcp server is not running");
    const p = this.request("resources/read", { uri });
    const res = signal ? await Promise.race([p, abortPromise(signal)]) : await p;
    const contents: any[] = res?.contents ?? [];
    return contents.map((c) => ({
      uri: String(c?.uri ?? uri),
      mimeType: c?.mimeType !== undefined ? String(c.mimeType) : undefined,
      text: typeof c?.text === "string" ? c.text : undefined,
      blob: typeof c?.blob === "string" ? c.blob : undefined,
    }));
  }

  stop(): void { try { this.child?.stdin?.end(); this.child?.kill("SIGTERM"); } catch { /* ignore */ } this.die(new Error("stopped")); }

  private request(method: string, params: unknown): Promise<any> {
    if (this._dead) return Promise.reject(new Error("mcp server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  private notify(method: string, params: unknown): void {
    try { this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); } catch { /* ignore */ }
  }
  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error?.message ?? "mcp error"));
        else p.resolve(msg.result);
      }
      // server-initiated notifications (no id / unknown id) are ignored
    }
  }
  private die(err: Error): void {
    if (this._dead) return;
    this._dead = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
