// The freshness measurement's SAMPLER, run inside `winter-core-live __helper-freshness <socket> <home> <params>`:
// the test daemon identity is the only one a live-test helper answers, so the captures come from this binary over
// ONE connection, on a fixed schedule. Per tick it asks the helper for a still through its own off-Space path
// (`test.capture` source `skylight`: SLSHWCaptureWindowListInRect, 0x800) and, while a phase has the stream on,
// for the latest frame of a desktop-independent ScreenCaptureKit stream (`test.stream` + `test.capture` source
// `stream`). Every capture is a PNG in the run's home; one JSON line per capture goes to stdout, then `{done:true}`.

export interface FreshPhase { name: string; ms: number; stream: boolean }
export interface FreshSamplerParams {
  windowId: number;
  /** Inside the helper's home (the run's temp dir): the helper writes nothing anywhere else. */
  dir: string;
  phases: FreshPhase[];
  intervalMs: number;
  /** In the window's own points: the part of the window the decoder needs. */
  rect?: [number, number, number, number];
  fps?: number;
}
export interface FreshTick { atMs: number; phase: string; sources: Array<"skylight" | "stream">; first: boolean; last: boolean }

/** The schedule: one tick every `intervalMs` through each phase in turn (offsets from the start). */
export function freshSchedule(phases: readonly FreshPhase[], intervalMs: number): FreshTick[] {
  const out: FreshTick[] = [];
  let start = 0;
  for (const p of phases) {
    const n = Math.max(1, Math.floor(p.ms / intervalMs));
    for (let i = 0; i < n; i++) out.push({ atMs: start + i * intervalMs, phase: p.name, sources: p.stream ? ["skylight", "stream"] : ["skylight"], first: i === 0, last: i === n - 1 });
    start += p.ms;
  }
  return out;
}

/** The standard measurement: stream OFF 10 s → ON 20 s → OFF 10 s, a tick every 500 ms. */
export const FRESH_PHASES: FreshPhase[] = [
  { name: "off-before", ms: 10_000, stream: false },
  { name: "stream-on", ms: 20_000, stream: true },
  { name: "off-after", ms: 10_000, stream: false },
];

/** A JSON-RPC client on the helper's socket, as the daemon: `hello`, then calls answered by id. */
async function connect(socketPath: string, home: string, protocol: number): Promise<{ call(method: string, params: unknown, timeoutMs?: number): Promise<{ result?: unknown; error?: unknown }>; close(): void }> {
  let buf = "";
  let nextId = 1;
  const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  let sock: { write(s: string): void; end(): void } | undefined;
  await Bun.connect({
    unix: socketPath,
    socket: {
      open(s) { sock = s; },
      data(_s, chunk) {
        buf += new TextDecoder().decode(chunk);
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
            if (typeof msg.id === "number") { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
          } catch { /* a notification or noise */ }
        }
      },
      close() { for (const w of waiting.values()) w({ error: "closed" }); waiting.clear(); },
      error() { for (const w of waiting.values()) w({ error: "socket error" }); waiting.clear(); },
    },
  });
  const call = (method: string, params: unknown, timeoutMs = 10_000): Promise<{ result?: unknown; error?: unknown }> => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: "timeout" }); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    sock!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const hello = await call("hello", { protocol, client: "daemon", home });
  if (hello.result === undefined) throw new Error(`the helper refused hello: ${JSON.stringify(hello.error)}`);
  return { call, close: () => sock?.end() };
}

export async function runFreshSampler(socketPath: string, home: string, params: FreshSamplerParams, protocol: number): Promise<void> {
  const out = (o: unknown): void => { process.stdout.write(`${JSON.stringify(o)}\n`); };
  const helper = await connect(socketPath, home, protocol);
  const schedule = freshSchedule(params.phases, params.intervalMs);
  const t0 = Date.now();
  let seq = 0;
  let streaming = false;
  try {
    for (const tick of schedule) {
      const wait = t0 + tick.atMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const wantStream = tick.sources.includes("stream");
      if (wantStream !== streaming) {
        const r = await helper.call("test.stream", { windowId: params.windowId, on: wantStream, fps: params.fps ?? 10 }, 15_000);
        streaming = wantStream && r.error === undefined;
        out({ event: "stream", on: wantStream, t: Date.now(), ok: r.error === undefined, ...(r.error === undefined ? {} : { error: r.error }) });
      }
      for (const source of tick.sources) {
        const file = `${params.dir}/${String(++seq).padStart(4, "0")}-${tick.phase}-${source}.png`;
        const before = Date.now();
        const r = await helper.call("test.capture", { windowId: params.windowId, source, path: file, ...(params.rect === undefined ? {} : { rect: params.rect }) });
        const after = Date.now();
        const res = (r.result ?? {}) as { width?: number; height?: number; frameAgeMs?: number };
        out({ event: "capture", phase: tick.phase, source, file, t: Math.round((before + after) / 2), ms: after - before, ok: r.error === undefined,
          ...(r.error === undefined ? { width: res.width, height: res.height, ...(res.frameAgeMs === undefined ? {} : { frameAgeMs: res.frameAgeMs }) } : { error: r.error }) });
      }
    }
  } finally {
    if (streaming) await helper.call("test.stream", { windowId: params.windowId, on: false }, 15_000);
    helper.close();
  }
  out({ done: true, captures: seq, ms: Date.now() - t0 });
}
