import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import type { ToolContext } from "../../src/agent/tools/registry";

/**
 * b2-agent-browser T7 — **the live-gate walk, driven as far as a machine can drive it.**
 *
 * Spec §10 owes the user seven gates. Six of them have a daemon half, and until this file NOTHING in
 * the repo composed that half end to end: `browser.test.ts` fakes all four deps,
 * `browser-approvals.test.ts` fakes `dispatch` (so no command ever leaves the process),
 * `browser-wiring.test.ts` proves the deps point at the real daemon but never completes a round trip,
 * and the app-side tests (`PanelCommandConsumerTests`, `PanelCommandInteractionTests`) drive the
 * consumer against a fake CDP driver with no daemon in sight. The seam nobody crossed is the one in
 * the middle:
 *
 *   tool → PanelCommandRegistry.dispatch → hub.broadcastTransient → the socket → an ATTACHED CLIENT
 *   → `panel.commandResult` → PanelCommandRegistry.resolve → the tool's own outcome mapping.
 *
 * Every row below crosses it for real: a second process-local client connects over the daemon's own
 * unix socket, attaches to the session, receives the `panel_command` transient as a
 * `session.event` notification and answers it with the real RPC. What that client CANNOT be is CEF —
 * so it stands in for the consumer, and each row is careful to test only what the DAEMON is
 * responsible for on the far side of that answer (does the command arrive with the right shape; is
 * the app's verdict passed through untouched; does the tool fail fast when nobody can answer).
 *
 * The app's own half — CDP, the sensitive floor's field inspection, the scheme door — is pinned in
 * `apple/Winter/Tests/WinterAppTests`, and the composition of BOTH halves against real Chromium is the
 * human's gate. What is closed here is the gap between them.
 */

// ================================================================================================
// Harness
// ================================================================================================

/** Minimal raw NDJSON client, with the one addition this file needs over the copies in
 *  `browser-wiring.test.ts` / `session-list-signals.test.ts`: it can act as a PANEL CONSUMER —
 *  answering `panel_command` transients with `panel.commandResult`. (Each daemon-IPC test file in
 *  this repo carries its own client; the convention is recorded in settings-hot-e2e.test.ts.) */
class GateClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  /** Every `session.event` notification this client has been delivered, in order. */
  readonly events: any[] = [];
  /** Every `panel_command` it has seen — the wire shape, exactly as the Mac app would decode it. */
  readonly commands: any[] = [];
  /**
   * How this client answers a command. `null` means "say nothing" — the stand-in for an app that is
   * present but wedged, which is the only way to reach the tool's timeout branch without waiting out
   * a real 15–30s deadline.
   */
  answerWith: (cmd: any) => { ok: boolean; result?: string; imageBase64?: string } | null =
    () => ({ ok: true, result: "ok" });

  static async connect(socketPath: string, token: string, clientName: string): Promise<GateClient> {
    const c = new GateClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.method === METHODS.event) {
              c.events.push(msg.params);
              if (msg.params?.type === "panel_command") c.onCommand(msg.params);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
    return c;
  }

  private onCommand(cmd: any): void {
    this.commands.push(cmd);
    const answer = this.answerWith(cmd);
    if (!answer) return;
    // Fire and forget, exactly as the app does (`PanelCommandConsumer.answer` sends and never awaits
    // the daemon's `{ok:true}`) — the tool is awaiting the REGISTRY, not this RPC's reply.
    void this.request(METHODS.panelCommandResult, {
      sessionId: cmd.sessionId, commandId: cmd.commandId,
      ok: answer.ok,
      ...(answer.result !== undefined && { result: answer.result }),
      ...(answer.imageBase64 !== undefined && { imageBase64: answer.imageBase64 }),
    });
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async newSession(cwd: string, extra?: Record<string, unknown>): Promise<string> {
    const { result } = await this.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto", ...extra });
    return result.sessionId as string;
  }

  attach(sessionId: string): Promise<any> {
    return this.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
  }

  eventsOfType(type: string): any[] { return this.events.filter((e) => e.type === type); }

  close(): void { this.socket.end(); }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Poll until `pred` holds or the budget runs out. Used only for facts that cross the socket, where
 *  "it happened" is observable but "it has arrived" is not synchronous. */
async function until(pred: () => boolean, budgetMs = 4_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a socket-delivered fact");
    await sleep(5);
  }
}

/** The async twin of `until`, for a fact that has to be ASKED for (an RPC) rather than observed on
 *  the event stream. Returns the first answer that satisfies `pred`. */
async function untilAnswer<T>(ask: () => Promise<T>, pred: (v: T) => boolean, budgetMs = 4_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await ask();
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for an RPC-observable fact");
    await sleep(10);
  }
}

/** One `browser` tool call, as a scripted turn: the call, then a plain text round to end the turn. */
function browserTurn(args: Record<string, unknown>, callId = "c1"): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId, name: "browser", argsJson: JSON.stringify(args) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// Task 17: the b2-t7 gate walk (REAL engine turns through the daemon's registry) retired with the
// engine; the browser CAPABILITY's panel-command sequence is pinned by test/capabilities.
