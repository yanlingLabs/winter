import { COWORK_GUEST_FILE_LIMITS, createCoworkGuestFileClient, parseCoworkGuestFileRequest, type CoworkGuestFileAuthorityPort, type CoworkGuestFileClient, type CoworkGuestFileFramePort } from "./guest-file-channel";
import { CoworkError, type CoworkErrorCode } from "./types";

/*
 * Guest file channel, HOST TRANSPORT: the frame port the Core client (`guest-file-channel.ts`) is injected with, over ONE
 * byte-stream pair of an incarnation's runtime link. Design: docs/research/2026-10-18-cowork-guest-file-channel-transport.md.
 *
 * NOT ACTIVATED. Nothing under src/ imports this module and the stream pair it needs (`CoworkGuestFileStreamLink`) has no
 * implementation anywhere in src/: the native host does not yet carry the two file streams (the note's NEEDS FROM OTHER LANE),
 * and the guest side does not exist. `session.create {mode: "cowork"}` keeps answering `unsupported_topology`. A test with a
 * fake guest proves this module's own logic and nothing about the guest, the native relay or confinement.
 *
 * It uses no NIC, no virtio socket, no socket and no network, and none of the reserved provider class: it is a framer over two byte
 * streams that the caller hands in.
 *
 * Wire (on the link): host to guest, the Core client's REQUEST LINES exactly as `parseCoworkGuestFileRequest` accepts them
 * (one canonical JSON object and a newline, at most 16 KiB), one `send` per request; guest to host, RESPONSE LINES in the
 * client's own response format (at most 384 KiB), in any chunking, several lines per chunk allowed. A reply is routed to its
 * caller by `requestId` and handed on UNPARSED: the client's strict parser is the only judge of its content.
 *
 * Fences: the port is built for ONE incarnation (workspace, session, incarnation) and sends nothing for another. At most
 * `maxInFlight` requests are outstanding (so at most 64 KiB of requests unanswered, far under the 1 MiB runtime IN rule), and
 * an aborted request KEEPS its slot until the guest answers it, so aborts cannot grow the guest's backlog. The channel is
 * fail-closed: a reply that cannot be attributed to an outstanding request, is not UTF-8, is longer than the response
 * frame bound, or a stream end, or a failed send, closes it; every outstanding and later call answers `file_unavailable`
 * (`response_too_large` for the oversize line). There is no resynchronization and no retry; the owner builds a new port for
 * the next incarnation.
 */

export const COWORK_GUEST_FILE_TRANSPORT_LIMITS = Object.freeze({
  /** Requests outstanding at once. 4 x 16 KiB of request lines is far under the runtime IN in-flight rule (1 MiB). */
  maxInFlight: 4,
  /** One link `send` carries at most this many bytes (the host's runtime chunk). A request line is at most 16 KiB. */
  chunkBytes: 256 * 1024,
});

/** The incarnation's file stream pair. Not implemented anywhere in src/: the native host supplies it (see the note). */
export interface CoworkGuestFileStreamLink {
  /** Host to guest. Resolves when the bytes are handed to the launcher channel; rejects if the stream is gone. */
  send(bytes: Uint8Array): Promise<void>;
  /** Guest to host, in order; `end` is true once, after the last bytes. Returns an unsubscribe. */
  onData(handler: (bytes: Uint8Array, end: boolean) => void): () => void;
}
/** The one incarnation this port may speak for. */
export interface CoworkGuestFileLinkScope { readonly workspaceId: string; readonly sessionId: string; readonly incarnationId: string }
export interface CoworkGuestFilePort extends CoworkGuestFileFramePort {
  /** Stops the port: unsubscribes, fails everything outstanding with `file_unavailable`. Idempotent. */
  close(): void;
}

interface Entry { waiter: { resolve(line: string): void; reject(error: CoworkError): void } | null }

const refusal = (code: CoworkErrorCode): CoworkError => new CoworkError(code);

export function createCoworkGuestFilePort(deps: { readonly link: CoworkGuestFileStreamLink; readonly scope: CoworkGuestFileLinkScope }): CoworkGuestFilePort {
  const link = deps?.link, scope = deps?.scope;
  if (link === null || typeof link !== "object" || typeof link.send !== "function" || typeof link.onData !== "function" || scope === null || typeof scope !== "object"
    || typeof scope.workspaceId !== "string" || typeof scope.sessionId !== "string" || typeof scope.incarnationId !== "string") throw refusal("invalid_request");
  const bound = Object.freeze({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, incarnationId: scope.incarnationId });
  const send = link.send.bind(link), responseBound = COWORK_GUEST_FILE_LIMITS.responseFrameBytes, slots = COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight;
  const outstanding = new Map<string, Entry>(), queue: { go(): void; fail(error: CoworkError): void }[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pieces: Buffer[] = [], held = 0, closed: CoworkError | null = null, unsubscribe: () => void = () => {}, used = 0;

  /** Fail-closed teardown. The first reason wins. */
  function close(code: CoworkErrorCode): void {
    if (closed) return;
    closed = refusal(code);
    try { unsubscribe(); } catch { /* the stream is already gone */ }
    for (const entry of outstanding.values()) entry.waiter?.reject(refusal(code));
    outstanding.clear();
    for (const waiting of queue.splice(0)) waiting.fail(refusal(code));
    pieces = []; held = 0; used = 0;
  }
  /** Hand the slot to the next waiting sender, or free it. */
  function release(): void { const next = queue.shift(); if (next) next.go(); else if (used > 0) used--; }
  function route(line: Buffer): void {
    let id: unknown, text: string;
    try {
      text = decoder.decode(line);
      const parsed: unknown = JSON.parse(text.slice(0, -1));
      const descriptor = parsed !== null && typeof parsed === "object" ? Object.getOwnPropertyDescriptor(parsed, "requestId") : undefined;
      id = descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch { return close("file_unavailable"); }
    const entry = typeof id === "string" ? outstanding.get(id) : undefined;
    if (entry === undefined) return close("file_unavailable"); // not an outstanding request: no way to attribute it, so no way to resynchronize
    outstanding.delete(id as string);
    entry.waiter?.resolve(text);
    release();
  }
  function receive(bytes: Uint8Array, end: boolean): void {
    if (closed) return;
    if (!(bytes instanceof Uint8Array)) return close("file_unavailable");
    let rest = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (;;) {
      const newline = rest.indexOf(0x0a);
      if (newline < 0) {
        if (held + rest.length > responseBound) return close("response_too_large");
        if (rest.length > 0) { pieces.push(Buffer.from(rest)); held += rest.length; }
        break;
      }
      if (held + newline + 1 > responseBound) return close("response_too_large");
      const line = Buffer.concat([...pieces, rest.subarray(0, newline + 1)]);
      pieces = []; held = 0; rest = rest.subarray(newline + 1);
      route(line);
      if (closed) return;
    }
    // Bytes of a line the guest never finished are not a reply.
    if (end) close("file_unavailable");
  }
  const stop: unknown = link.onData(receive);
  if (typeof stop !== "function") { close("invalid_request"); throw refusal("invalid_request"); }
  unsubscribe = stop as () => void;

  async function slot(signal: AbortSignal): Promise<void> {
    // The slot is taken here, synchronously, so two senders in one tick cannot both pass the check.
    if (used < slots && queue.length === 0) { used++; return; }
    await new Promise<void>((go, fail) => {
      const waiting = { go: () => { signal.removeEventListener("abort", onAbort); go(); }, fail: (error: CoworkError) => { signal.removeEventListener("abort", onAbort); fail(error); } };
      const onAbort = () => { const at = queue.indexOf(waiting); if (at >= 0) queue.splice(at, 1); fail(refusal("file_unavailable")); };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(waiting);
    });
  }

  return Object.freeze({
    async send(frame: string, signal: AbortSignal): Promise<string> {
      if (closed) throw refusal("file_unavailable"); // whatever closed it, a later call only learns that the channel is gone
      if (!(signal instanceof AbortSignal)) throw refusal("invalid_request");
      if (signal.aborted) throw refusal("file_unavailable");
      let request;
      try { request = parseCoworkGuestFileRequest(frame); } catch { throw refusal("invalid_request"); }
      // This port speaks for one incarnation only.
      if (request.workspaceId !== bound.workspaceId || request.sessionId !== bound.sessionId) throw refusal("authority_denied");
      if (request.incarnationId !== bound.incarnationId) throw refusal("stale_file");
      if (outstanding.has(request.requestId)) throw refusal("invalid_request");
      const bytes = Buffer.from(frame, "utf8");
      if (bytes.length > COWORK_GUEST_FILE_TRANSPORT_LIMITS.chunkBytes) throw refusal("invalid_request");
      await slot(signal);
      if (closed as CoworkError | null) throw refusal("file_unavailable"); // close() may have run while this call awaited the slot
      if (signal.aborted) { release(); throw refusal("file_unavailable"); }
      const entry: Entry = { waiter: null };
      const reply = new Promise<string>((resolve, reject) => {
        // An abort detaches the caller but keeps the slot: the guest still owes an answer, and its backlog stays bounded.
        const onAbort = () => { const waiter = entry.waiter; entry.waiter = null; waiter?.reject(refusal("file_unavailable")); };
        entry.waiter = { resolve: line => { signal.removeEventListener("abort", onAbort); resolve(line); }, reject: error => { signal.removeEventListener("abort", onAbort); reject(error); } };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      // Registered BEFORE the bytes leave: a reply may arrive before `send` resolves.
      outstanding.set(request.requestId, entry);
      try { await send(bytes); } catch { close("file_unavailable"); }
      return reply;
    },
    close: () => close("file_unavailable"),
  });
}

/** The client over a link: the port above, with the host authority port the caller supplies. Unwired like both. */
export function createCoworkGuestFileClientOverLink(deps: {
  readonly link: CoworkGuestFileStreamLink; readonly scope: CoworkGuestFileLinkScope; readonly authority: CoworkGuestFileAuthorityPort; readonly requestId?: () => string;
}): { readonly client: CoworkGuestFileClient; close(): void } {
  const port = createCoworkGuestFilePort({ link: deps.link, scope: deps.scope });
  return Object.freeze({ client: createCoworkGuestFileClient({ frames: port, authority: deps.authority, ...(deps.requestId === undefined ? {} : { requestId: deps.requestId }) }), close: () => port.close() });
}
