import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }
// MCP resources (CC parity: ListMcpResourcesTool/ReadMcpResourceTool) — standard `resources/list`
// / `resources/read` result shapes.
export interface McpResourceInfo { uri: string; name?: string; description?: string; mimeType?: string }
export interface McpResourceContent { uri: string; mimeType?: string; text?: string; blob?: string }

/** A tool result's content blocks, surfaced structurally so callers can ATTACH images rather than
 *  flatten everything to text. `callTool()` (string) is kept unchanged for existing callers. */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | { type: "other"; raw: unknown };

/** Per-call ceiling. The SDK's own default is 60s (DEFAULT_REQUEST_TIMEOUT_MSEC), which would be a
 *  REGRESSION here: the hand-rolled client this replaces had no per-request timeout at all, so a
 *  tool legally running longer than a minute works today. 10 minutes preserves every realistic
 *  call while still closing the infinite-hang hole. `resetTimeoutOnProgress` means a server that
 *  reports progress is never killed mid-work. Genuinely long operations should become TASKS,
 *  not synchronous calls holding a turn open. */
const DEFAULT_CALL_TIMEOUT_MS = 600_000;
function callTimeoutMs(): number { return Number(process.env.NORMA_MCP_CALL_TIMEOUT_MS ?? DEFAULT_CALL_TIMEOUT_MS); }

export class McpStdioClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private _tools: McpToolInfo[] = [];
  private _dead = false;
  // Set from the initialize handshake's OWN result.capabilities.resources — presence (even `{}`)
  // means the server declares resources support, per the MCP spec. Absent (undefined) → false.
  private _resourcesCapable = false;

  constructor(
    private readonly cfg: { command: string; args?: string[]; env?: Record<string, string> },
    private readonly log?: (m: string) => void,
  ) {}

  get dead(): boolean { return this._dead; }
  tools(): McpToolInfo[] { return this._tools; }
  resourcesCapable(): boolean { return this._resourcesCapable; }

  async start(timeoutMs = Number(process.env.NORMA_MCP_START_TIMEOUT_MS ?? 10000)): Promise<void> {
    // env: the SDK's getDefaultEnvironment() passes only 6 keys (HOME/LOGNAME/PATH/SHELL/TERM/USER).
    // Norma has always passed the FULL parent environment; servers rely on inherited credentials,
    // so the full env is passed explicitly. Tightening this is deliberate future hardening.
    // stderr: the SDK default is "inherit", which would leak server stderr into the daemon's own
    // stderr. "pipe" keeps it ours to route.
    const transport = new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args ?? [],
      env: { ...process.env, ...this.cfg.env } as Record<string, string>,
      stderr: "pipe",
    });
    this.transport = transport;
    // stderr is "pipe" above, so something must CONSUME it. The SDK pipes the child's stderr into
    // a PassThrough (client/stdio.js: `_process.stderr.pipe(_stderrStream)`), which keeps the
    // kernel pipe drained — so a chatty server does not block — but a PassThrough nobody reads
    // just accumulates in memory for the life of the process. The hand-rolled client this replaces
    // attached a no-op `stderr.on("data")` for the same reason. `log` is undefined until the
    // manager passes one, so today this drains-and-discards — matching the old behaviour — and
    // becomes real logging the moment a logger is wired.
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trimEnd();
      if (text) this.log?.(`mcp stderr: ${text}`);
    });

    const client = new Client({ name: "norma", version: "0.0.1" });
    this.client = client;
    // A malformed line (e.g. a bare `null`) surfaces here as a zod error and is NON-FATAL — the
    // connection survives and later requests still succeed. Swallowing it here preserves the
    // old hand-rolled behaviour ("a bare null line is ignored, not a crash").
    client.onerror = (e: unknown) => this.log?.(`mcp: ${(e as Error)?.message ?? String(e)}`);
    client.onclose = () => this.die();

    const handshake = (async () => {
      await client.connect(transport);
      const caps = client.getServerCapabilities();
      this._resourcesCapable = !!(caps && typeof caps === "object" && "resources" in caps);
      this._tools = await this.listAllTools();
    })();

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`mcp start timeout after ${timeoutMs}ms`)), timeoutMs); });
    try { await Promise.race([handshake, timeout]); }
    catch (e) { this.stop(); throw e; }
    finally { clearTimeout(timer!); }
  }

  /** `tools/list` is PAGINATED and the SDK does NOT follow `nextCursor` for you — v1's listTools
   *  issues exactly one request. Looping here is what closes the silent-truncation hole the
   *  hand-rolled client also had. */
  private async listAllTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.client!.listTools(cursor === undefined ? {} : { cursor }, { timeout: callTimeoutMs() });
      for (const t of res.tools ?? []) {
        out.push({ name: String(t.name), description: String(t.description ?? ""), inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> });
      }
      cursor = res.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    if (this._dead) throw new Error("mcp server is not running");
    const res: any = await this.client!.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: callTimeoutMs(), resetTimeoutOnProgress: true },
    );
    const content: any[] = res?.content ?? [];
    const text = content.map((c) => (c?.type === "text" ? String(c.text ?? "") : "[non-text content omitted]")).join("");
    return text || (res?.isError ? "[mcp tool error]" : "");
  }

  /** Structured sibling of `callTool`. Same request, but the content blocks are returned intact so
   *  a caller holding a ToolContext can attach images instead of dropping them. */
  async callToolContent(name: string, args: unknown, signal?: AbortSignal): Promise<{ blocks: McpContentBlock[]; isError: boolean }> {
    if (this._dead) throw new Error("mcp server is not running");
    const res: any = await this.client!.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: callTimeoutMs(), resetTimeoutOnProgress: true },
    );
    const blocks: McpContentBlock[] = (res?.content ?? []).map((c: any): McpContentBlock => {
      if (c?.type === "text") return { type: "text", text: String(c.text ?? "") };
      if (c?.type === "image") return { type: "image", data: String(c.data ?? ""), mimeType: String(c.mimeType ?? "image/png") };
      if (c?.type === "audio") return { type: "audio", data: String(c.data ?? ""), mimeType: String(c.mimeType ?? "audio/wav") };
      if (c?.type === "resource_link") return { type: "resource_link", uri: String(c.uri ?? ""), name: c.name !== undefined ? String(c.name) : undefined, mimeType: c.mimeType !== undefined ? String(c.mimeType) : undefined };
      return { type: "other", raw: c };
    });
    return { blocks, isError: !!res?.isError };
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceInfo[]> {
    if (this._dead) throw new Error("mcp server is not running");
    const out: McpResourceInfo[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.client!.listResources(cursor === undefined ? {} : { cursor }, { signal, timeout: callTimeoutMs() });
      for (const r of res.resources ?? []) {
        out.push({
          uri: String(r?.uri ?? ""),
          name: r?.name !== undefined ? String(r.name) : undefined,
          description: r?.description !== undefined ? String(r.description) : undefined,
          mimeType: r?.mimeType !== undefined ? String(r.mimeType) : undefined,
        });
      }
      cursor = res.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    if (this._dead) throw new Error("mcp server is not running");
    const res: any = await this.client!.readResource({ uri }, { signal, timeout: callTimeoutMs() });
    const contents: any[] = res?.contents ?? [];
    return contents.map((c) => ({
      uri: String(c?.uri ?? uri),
      mimeType: c?.mimeType !== undefined ? String(c.mimeType) : undefined,
      text: typeof c?.text === "string" ? c.text : undefined,
      blob: typeof c?.blob === "string" ? c.blob : undefined,
    }));
  }

  stop(): void {
    try { void this.client?.close(); } catch { /* ignore */ }
    try { void this.transport?.close(); } catch { /* ignore */ }
    this.die();
  }

  private die(): void { this._dead = true; }
}
