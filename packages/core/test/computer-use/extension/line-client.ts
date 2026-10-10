// A fake `winter-browser-host` for the daemon-side tests: NDJSON over the daemon's real unix socket.
export class LineClient {
  private buffer = "";
  private readonly lines: Record<string, any>[] = [];
  private wake: (() => void) | undefined;
  ended = false;

  private constructor(private readonly socket: { write(s: string): number; end(): void }) {}

  static async connect(path: string): Promise<LineClient> {
    let client: LineClient | undefined;
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_s, chunk) {
          client!.buffer += new TextDecoder().decode(chunk);
          let nl: number;
          while ((nl = client!.buffer.indexOf("\n")) >= 0) {
            const line = client!.buffer.slice(0, nl);
            client!.buffer = client!.buffer.slice(nl + 1);
            client!.lines.push(JSON.parse(line));
          }
          client!.wake?.();
        },
        close() { client!.ended = true; client!.wake?.(); },
        error() { client!.ended = true; client!.wake?.(); },
      },
    });
    client = new LineClient(socket as unknown as { write(s: string): number; end(): void });
    return client;
  }

  send(message: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  writeRaw(text: string): void {
    this.socket.write(text);
  }

  async next(timeoutMs = 2000): Promise<Record<string, any> | "eof" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (this.ended) return "eof";
      const left = deadline - Date.now();
      if (left <= 0) return "timeout";
      await new Promise<void>((r) => { this.wake = r; setTimeout(r, Math.min(left, 50)); });
    }
    return this.lines.shift()!;
  }

  async request(id: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any> | "eof" | "timeout"> {
    this.send({ id, method, params });
    return await this.next();
  }

  /** True once the daemon closed the connection (within `timeoutMs`). */
  async closed(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return this.ended;
  }

  close(): void {
    this.socket.end();
  }
}
