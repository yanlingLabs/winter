// WS-23: the compiled-artifact proof for EMBEDDED chat — one chat turn, through a real daemon, inside
// the `bun build --compile` binary.
//
// WHY THIS EXISTS. An embedded session runs in a Bun Worker constructed from a plain relative path to
// a SECOND compile entrypoint (`cli/src/embedded-worker.ts`); in dev the same code constructs it from an
// absolute source path. `bun test` only ever sees the dev leg, and the two differ exactly where it
// hurts — a `new URL(…, import.meta.url).href` spelling hangs silently in a compiled binary (WS-23
// spike #1), and a Worker entry that did not make it into `$bunfs` fails only at the first session. So
// the embedded topology is discharged only by running the real artifact, as the workflow worker (C1)
// and the runtime spine (P8b-18) already are.
//
// WHAT IT DOES. Boots the REAL daemon (`startDaemon`, what `winter-core daemon run` calls) on a
// caller-supplied temp `WINTER_HOME` with a `FileSecretStore` under it — nothing touches the macOS
// Keychain — and with settings that name a `winter` executable that does NOT exist, so the chat turn can
// only have run embedded. It then speaks JSON-RPC to the daemon's own socket like any client: create a
// chat session on the scripted `winter-test/echo` double, attach, send, wait for `turn_completed`. It
// reports the turn's event kinds, whether the session's Worker was live, the daemon's own compiled
// flag, and that `stop()` left no Worker behind.
//
// Reached ONLY by `scripts/verify-embedded-compiled.ts` through the static `__embedded-probe` argv
// route in `packages/cli/src/main.ts` (beside `__runtime-state-probe`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnWriter, LineDecoder, METHODS, PROTOCOL_VERSION, encodeLine, type SessionEvent, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../auth/secret-store";
import { startDaemon, type RunningDaemon } from "../daemon";
import { isCompiledDaemon } from "./embedded";

export type EmbeddedProbeResult =
  | {
      ok: true;
      compiled: boolean;
      backendSessionId: string;
      /** The session's Worker was listed by the embedded host while its turn ran. */
      workerLive: boolean;
      /** Main-thread event kinds of the one turn, in order. */
      turn: string[];
      /** How many embedded Workers the host still listed after `stop()` resolved (must be 0). */
      workersAfterStop: number;
    }
  | { ok: false; error: string };

type RpcReply = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** The smallest NDJSON JSON-RPC client that can drive one turn — the probe's own, never a test helper. */
async function connect(socketPath: string): Promise<{ call<T>(method: string, params?: unknown): Promise<T>; events: SessionEvent[]; close(): void }> {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: RpcReply) => void>();
  const events: SessionEvent[] = [];
  let nextId = 1;
  let writer!: ConnWriter;
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        for (const line of decoder.push(chunk)) {
          const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown } & RpcReply;
          if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          } else if (msg.method === METHODS.event) events.push(msg.params as SessionEvent);
        }
      },
      drain() {
        writer.onDrain();
      },
    },
  });
  writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    events,
    async call<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      const reply = new Promise<RpcReply>((resolve) => pending.set(id, resolve));
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      const r = await reply;
      if (r.error) throw new Error(`${method}: ${r.error.message}`);
      return r.result as T;
    },
    close(): void {
      try {
        socket.end();
      } catch {
        /* already closed */
      }
    },
  };
}

export async function runEmbeddedProbe(input: { home: string | undefined }): Promise<EmbeddedProbeResult> {
  if (!input.home) return { ok: false, error: "WINTER_HOME is required (the probe never touches a real home)" };
  const home = input.home;
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      schemaVersion: 3,
      provider: { model: "winter-test/echo" },
      // A binary that does not exist: chat must not need one. (A code session on this daemon refuses.)
      runtimes: { winterExecutable: join(home, "no-such-winter-binary") },
    }),
  );
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "probe-secrets")), agentProvider: null });
    const client = await connect(daemon.socketPath);
    try {
      await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "embedded-probe" });
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "probe", mode: "chat", model: "winter-test/echo" });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      await client.call(METHODS.sessionSend, { sessionId, text: "hello from the compiled probe" });
      const deadline = Date.now() + 30_000;
      while (!client.events.some((e) => e.type === "turn_completed" && e.sessionId === sessionId)) {
        if (Date.now() > deadline) return { ok: false, error: `no turn_completed within 30 s; saw: ${client.events.map((e) => e.type).join(",")}` };
        await Bun.sleep(20);
      }
      const rt = daemon.runtimeState;
      const backendSessionId = "unavailable" in rt ? undefined : rt.records.get(sessionId)?.backendSessionId;
      if (backendSessionId === undefined) return { ok: false, error: "the chat session has no backend session id" };
      const workerLive = daemon.embedded.live().includes(backendSessionId);
      const turn = daemon.sessions
        .read(sessionId)
        .map((e) => e.type)
        .filter((t) => ["user_message", "turn_started", "assistant_message", "turn_completed", "agent_error"].includes(t));
      const host = daemon.embedded;
      client.close();
      const stopping = daemon.stop();
      daemon = undefined;
      await stopping;
      return { ok: true, compiled: isCompiledDaemon(), backendSessionId, workerLive, turn, workersAfterStop: host.live().length };
    } finally {
      client.close();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  } finally {
    if (daemon !== undefined) await daemon.stop();
  }
}
