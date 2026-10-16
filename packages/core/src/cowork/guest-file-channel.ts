import { CoworkError, type CoworkErrorCode } from "./types";

/*
 * Guest file channel, READ SIDE (stat, read, ranged read): versioned DTOs, a strict closed frame parser and a fenced
 * Core client over an injected frame port.
 *
 * SOURCE ONLY. Nothing under src/ imports this module, it has no barrel export, and neither port has an
 * implementation anywhere in src/ (an anti-wiring test pins all three). The guest side does not exist yet. A test with a
 * fake guest proves this module's own logic; it never proves frame authenticity, guest confinement or native admission.
 *
 * Core OWNS this schema (see the research note next to it): the guest implementation later copies it and carries a drift
 * test, never the other way round. The guest resolves its own paths and applies its own traversal/symlink/size limits;
 * Core never sends a guest path to a privileged Mac filesystem API. Everything a guest returns is untrusted bytes and
 * is parsed here as such.
 *
 * Wire: ONE line per frame, a single JSON object and a newline, canonical `JSON.stringify` spelling (a parsed frame is
 * re-serialized and must equal its own text, which refuses duplicate keys, whitespace and alternate escapes/number
 * spellings). Every operation binds workspace, session, location, relative path, incarnation and source revision;
 * the response must echo all of them.
 *
 * The client sandwiches the call: authority BEFORE the frame leaves, and authority, incarnation and source revision
 * AGAIN when the reply arrives and before one byte of it is parsed or returned. A revoked or changed binding discards
 * the bytes. Errors reuse the existing CoworkErrorCode taxonomy; no code is added.
 */

export const COWORK_GUEST_FILE_CHANNEL_VERSION = 1;
export const COWORK_GUEST_FILE_OPERATIONS = Object.freeze(["stat", "read", "readRange"] as const);
export type CoworkGuestFileOperation = typeof COWORK_GUEST_FILE_OPERATIONS[number];
/** The ONLY codes a guest may report. The guest never gets to say `authority_denied`: revocation is a host fact. */
export const COWORK_GUEST_FILE_ERROR_CODES = Object.freeze(["file_missing", "file_unavailable", "stale_file", "file_incomplete", "response_too_large", "invalid_request"] as const);
export type CoworkGuestFileErrorCode = typeof COWORK_GUEST_FILE_ERROR_CODES[number];

const keys = <const T extends readonly string[]>(...values: T): Readonly<T> => Object.freeze(values);
const BINDING = ["workspaceId", "sessionId", "locationId", "relativePath", "incarnationId", "sourceRevision"] as const;
export const COWORK_GUEST_FILE_REQUEST_KEYS = Object.freeze({
  stat: keys("version", "requestId", "op", ...BINDING),
  read: keys("version", "requestId", "op", ...BINDING, "expectedGeneration", "maxBytes"),
  readRange: keys("version", "requestId", "op", ...BINDING, "expectedGeneration", "offset", "maxBytes"),
});
const STAT_RESPONSE = ["version", "requestId", "op", "ok", ...BINDING, "generation", "bytes", "kind"] as const;
export const COWORK_GUEST_FILE_RESPONSE_KEYS = Object.freeze({
  error: keys("version", "requestId", "op", "ok", "code"),
  stat: keys(...STAT_RESPONSE),
  chunk: keys(...STAT_RESPONSE, "offset", "nextOffset", "eof", "contentBase64", "encoding"),
});
export const COWORK_GUEST_FILE_LIMITS = Object.freeze({
  /** Path bounds: the same as the host-backed output reads (docs/cowork-output-reads.md). */
  pathBytes: 4096, pathComponents: 32, componentBytes: 255,
  /** Decoded bytes per chunk: the same 256 KiB ceiling and 64 KiB default as the host-backed output reads. */
  chunkMaxBytes: 256 * 1024, chunkDefaultBytes: 64 * 1024,
  /** Base64 of chunkMaxBytes: 4 * ceil(262144 / 3). */
  base64MaxChars: 349528,
  /** A request is ids + a path of at most 4096 bytes (8192 escaped); a response adds at most base64MaxChars. Both
   * stay under the 1 MiB guest runtime transport frame. */
  requestFrameBytes: 16 * 1024, responseFrameBytes: 384 * 1024,
  /** Frames are flat objects: one level of braces. */
  frameDepth: 1,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];

export interface CoworkGuestFileBinding {
  readonly workspaceId: string; readonly sessionId: string; readonly locationId: string; readonly relativePath: string;
  /** The workspace incarnation the caller believes is current. */
  readonly incarnationId: string;
  /** The source revision the caller believes is current. */
  readonly sourceRevision: number;
}
export type CoworkGuestFileRequest =
  | (CoworkGuestFileBinding & { readonly version: 1; readonly requestId: string; readonly op: "stat" })
  | (CoworkGuestFileBinding & { readonly version: 1; readonly requestId: string; readonly op: "read"; readonly expectedGeneration: string; readonly maxBytes: number })
  | (CoworkGuestFileBinding & { readonly version: 1; readonly requestId: string; readonly op: "readRange"; readonly expectedGeneration: string; readonly offset: number; readonly maxBytes: number });
export interface CoworkGuestFileStat extends CoworkGuestFileBinding {
  /** Opaque guest generation token (64 hex). Equal tokens mean the guest saw an unchanged file; never a content digest claim. */
  readonly generation: string; readonly bytes: number; readonly kind: "file";
}
export interface CoworkGuestFileChunk extends CoworkGuestFileStat {
  readonly offset: number; readonly nextOffset: number; readonly eof: boolean;
  /** Decoded bytes, a private copy. Untrusted content. */
  readonly content: Uint8Array;
}
export interface CoworkGuestFileStatInput extends CoworkGuestFileBinding {}
export interface CoworkGuestFileReadInput extends CoworkGuestFileBinding { readonly expectedGeneration: string; readonly maxBytes?: number }
export interface CoworkGuestFileReadRangeInput extends CoworkGuestFileReadInput { readonly offset: number }

const bad = (): never => { throw new CoworkError("file_unavailable"); };
const invalid = (): never => { throw new CoworkError("invalid_request"); };

/** Relative guest path: at most 4096 UTF-8 bytes, 32 components, 255 bytes each; no absolute path, empty/`.`/`..`
 * component, NUL or other control character (C0, DEL, C1), nor ill-formed string. Strictly tighter than the
 * protocol's CoworkOutputPath. A drift test pins that every path accepted here is accepted there. */
export function parseCoworkGuestRelativePath(value: unknown): string {
  const limits = COWORK_GUEST_FILE_LIMITS;
  // UTF-16 length never exceeds the byte length, so this cheap check precedes the byte count.
  if (typeof value !== "string" || value.length === 0 || value.length > limits.pathBytes || !value.isWellFormed() || CONTROL.test(value) || Buffer.byteLength(value, "utf8") > limits.pathBytes) return invalid();
  const parts = value.split("/");
  if (parts.length > limits.pathComponents || parts.some(part => part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > limits.componentBytes)) return invalid();
  return value;
}

/** Conservative brace/bracket nesting bound over the RAW text, string-aware, before any parser recurses. */
function nestsWithin(body: string, max: number): boolean {
  let depth = 0, inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (inString) { if (c === 0x5c) i++; else if (c === 0x22) inString = false; continue; }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) { if (++depth > max) return false; }
    else if (c === 0x7d || c === 0x5d) { if (--depth < 0) return false; }
  }
  return depth === 0 && !inString;
}
/** No key that could be mistaken for a prototype slot and no ill-formed string (a lone surrogate that arrived as an
 * escape, which the raw check cannot see), at any level, keys included. */
function cleanData(value: unknown): void {
  if (typeof value === "string") { if (!value.isWellFormed()) bad(); return; }
  if (value === null || typeof value !== "object") return;
  if (!Array.isArray(value) && (DANGEROUS_KEYS.some(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !key.isWellFormed()))) bad();
  for (const child of Object.values(value)) cleanData(child);
}
/** One bounded canonical line to its parsed plain object. Oversize is `response_too_large`; every other fault is `file_unavailable`. */
function strictLine(raw: unknown, maxBytes: number): Record<string, unknown> {
  if (typeof raw !== "string") return bad();
  // UTF-16 length never exceeds the byte length, so check it first and never measure an arbitrarily long string.
  if (raw.length > maxBytes || Buffer.byteLength(raw, "utf8") > maxBytes) throw new CoworkError("response_too_large");
  // The terminator is the last character. Any OTHER newline is JSON whitespace (or an illegal raw newline in a string), so it
  // fails the exact re-serialization compare below; there is no separate "one line" check to keep in step with it.
  if (!raw.endsWith("\n") || !raw.isWellFormed()) return bad();
  const body = raw.slice(0, -1);
  if (!nestsWithin(body, COWORK_GUEST_FILE_LIMITS.frameDepth)) return bad();
  const parsed: unknown = JSON.parse(body);
  // Exact re-serialization: JSON.parse keeps the LAST of duplicate keys, so a duplicate, whitespace, an alternate
  // escape or number spelling changes the text and is refused.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(parsed) !== body) return bad();
  cleanData(parsed);
  return parsed as Record<string, unknown>;
}
/** Exact key set, own DATA properties only, plain prototype. Returns a null-prototype copy of the listed keys. */
function closedKeys(value: unknown, listed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
  // Unknown keys are refused here; a missing one has no data descriptor below.
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !listed.includes(key))) return bad();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of listed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return bad();
    copy[key] = descriptor.value;
  }
  return copy;
}
const idOf = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : bad();
const uuidOf = (value: unknown): string => typeof value === "string" && UUID_V4.test(value) ? value : bad();
const digestOf = (value: unknown): string => typeof value === "string" && DIGEST.test(value) ? value : bad();
const revisionOf = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : bad();
const countOf = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad();
const maxBytesOf = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= COWORK_GUEST_FILE_LIMITS.chunkMaxBytes ? value : bad();

/** Strict parse of a REQUEST line (what the guest side will receive). Any fault is `invalid_request`. */
export function parseCoworkGuestFileRequest(raw: unknown): CoworkGuestFileRequest {
  try {
    const parsed = strictLine(raw, COWORK_GUEST_FILE_LIMITS.requestFrameBytes), op = Object.hasOwn(parsed, "op") ? parsed.op : undefined;
    if (op !== "stat" && op !== "read" && op !== "readRange") return bad();
    const frame = closedKeys(parsed, COWORK_GUEST_FILE_REQUEST_KEYS[op]);
    if (frame.version !== COWORK_GUEST_FILE_CHANNEL_VERSION) return bad();
    const base = { version: 1 as const, requestId: uuidOf(frame.requestId), workspaceId: idOf(frame.workspaceId), sessionId: idOf(frame.sessionId), locationId: idOf(frame.locationId),
      relativePath: parseCoworkGuestRelativePath(frame.relativePath), incarnationId: idOf(frame.incarnationId), sourceRevision: revisionOf(frame.sourceRevision) };
    if (op === "stat") return Object.freeze({ ...base, op });
    const expectedGeneration = digestOf(frame.expectedGeneration), maxBytes = maxBytesOf(frame.maxBytes);
    if (op === "read") return Object.freeze({ ...base, op, expectedGeneration, maxBytes });
    return Object.freeze({ ...base, op, expectedGeneration, offset: countOf(frame.offset), maxBytes });
  } catch { return invalid(); }
}

const base64Chars = (bytes: number) => 4 * Math.ceil(bytes / 3);
/** Strict parse of GUEST-CONTROLLED RESPONSE bytes against the request that was sent. Returns the stat or chunk, or
 * throws a CoworkError: `response_too_large` (frame, base64 or decoded body over its bound), `file_unavailable` (anything
 * not exactly the closed frame), a guest-reported code from COWORK_GUEST_FILE_ERROR_CODES, `authority_denied` (the reply
 * is bound to another workspace/session/location/path), `stale_file` (another incarnation, source revision or generation)
 * and `file_incomplete` (offset, length and eof do not add up). Nothing is returned for a refused frame.
 *
 * The client runs its own authority/incarnation/revision recheck BEFORE it calls this: that recheck, not this
 * frame's echo, is what revokes a call. The echo compares here only stop a reply meant for another binding. */
export function parseCoworkGuestFileResponse(raw: unknown, request: CoworkGuestFileRequest): CoworkGuestFileStat | CoworkGuestFileChunk {
  try {
    const parsed = strictLine(raw, COWORK_GUEST_FILE_LIMITS.responseFrameBytes), ok = Object.hasOwn(parsed, "ok") ? parsed.ok : undefined;
    if (ok === false) {
      const failure = closedKeys(parsed, COWORK_GUEST_FILE_RESPONSE_KEYS.error);
      if (failure.version !== COWORK_GUEST_FILE_CHANNEL_VERSION || failure.requestId !== request.requestId || failure.op !== request.op) return bad();
      const code = COWORK_GUEST_FILE_ERROR_CODES.find(candidate => candidate === failure.code);
      if (code === undefined) return bad();
      throw new CoworkError(code);
    }
    if (ok !== true) return bad();
    const chunked = request.op !== "stat", frame = closedKeys(parsed, chunked ? COWORK_GUEST_FILE_RESPONSE_KEYS.chunk : COWORK_GUEST_FILE_RESPONSE_KEYS.stat);
    if (frame.version !== COWORK_GUEST_FILE_CHANNEL_VERSION || frame.requestId !== request.requestId || frame.op !== request.op) return bad();
    // 1. Types and bounds of every field, before any comparison.
    const echo = { workspaceId: idOf(frame.workspaceId), sessionId: idOf(frame.sessionId), locationId: idOf(frame.locationId), incarnationId: idOf(frame.incarnationId), sourceRevision: revisionOf(frame.sourceRevision) };
    const generation = digestOf(frame.generation), bytes = countOf(frame.bytes);
    if (typeof frame.relativePath !== "string" || frame.kind !== "file") return bad();
    let chunk: { offset: number; nextOffset: number; eof: boolean; content: Uint8Array } | undefined;
    if (chunked) {
      const wanted = (request as Extract<CoworkGuestFileRequest, { maxBytes: number }>).maxBytes, encoded = frame.contentBase64;
      if (typeof encoded !== "string" || frame.encoding !== "base64" || typeof frame.eof !== "boolean") return bad();
      // Oversize is decided from the LENGTH, before anything is decoded.
      if (encoded.length > base64Chars(wanted)) throw new CoworkError("response_too_large");
      // Node/Bun decode leniently (padding, whitespace, URL-safe letters): only the canonical spelling survives the round trip.
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.toString("base64") !== encoded) return bad();
      if (decoded.length > wanted) throw new CoworkError("response_too_large");
      chunk = { offset: countOf(frame.offset), nextOffset: countOf(frame.nextOffset), eof: frame.eof, content: new Uint8Array(decoded) };
    }
    // 2. The reply must be for THIS binding.
    if (echo.workspaceId !== request.workspaceId || echo.sessionId !== request.sessionId || echo.locationId !== request.locationId || frame.relativePath !== request.relativePath) throw new CoworkError("authority_denied");
    if (echo.incarnationId !== request.incarnationId || echo.sourceRevision !== request.sourceRevision) throw new CoworkError("stale_file");
    if (request.op !== "stat" && generation !== request.expectedGeneration) throw new CoworkError("stale_file");
    const stat = { workspaceId: echo.workspaceId, sessionId: echo.sessionId, locationId: echo.locationId, relativePath: request.relativePath, incarnationId: echo.incarnationId, sourceRevision: echo.sourceRevision, generation, bytes, kind: "file" as const };
    if (chunk === undefined) return Object.freeze(stat);
    // 3. Offset, length and eof must add up exactly: the guest returns min(maxBytes, bytes - offset) bytes from the
    // requested offset (a shorter, longer or shifted chunk is incomplete), and eof is true exactly at the end. That also
    // keeps nextOffset within the file (and refuses an offset beyond it: the length could never be negative).
    const offset = request.op === "readRange" ? request.offset : 0, wanted = (request as Extract<CoworkGuestFileRequest, { maxBytes: number }>).maxBytes;
    if (chunk.offset !== offset || chunk.nextOffset !== offset + chunk.content.length || chunk.eof !== (chunk.nextOffset === bytes)
      || chunk.content.length !== Math.min(wanted, bytes - offset)) throw new CoworkError("file_incomplete");
    return Object.freeze({ ...stat, offset: chunk.offset, nextOffset: chunk.nextOffset, eof: chunk.eof, content: chunk.content });
  } catch (error) { if (error instanceof CoworkError) throw error; return bad(); }
}

/** ABSTRACT seam only: no implementation exists anywhere in src/. One request line out, one response line back. The
 * returned string is guest-controlled bytes. The signal is the caller's; honour it to stop work early. */
export interface CoworkGuestFileFramePort { send(frame: string, signal: AbortSignal): Promise<string> }
/** What the authority port is asked about: exactly the bound operation. */
export interface CoworkGuestFileScope extends CoworkGuestFileBinding { readonly operation: CoworkGuestFileOperation }
/** The CURRENT host records for that scope. `incarnationId` is null while the workspace has no running incarnation. */
export interface CoworkGuestFileLive { readonly incarnationId: string | null; readonly sourceRevision: number }
/** ABSTRACT seam only: no implementation exists anywhere in src/. Synchronous and host-owned: it answers from current records
 * and THROWS when the principal/workspace/session/location may not read (revoked, deleting, unknown). A throw, a promise or
 * a malformed answer is a denial. It is called before the frame is sent and again when the reply arrives. */
export interface CoworkGuestFileAuthorityPort { check(scope: CoworkGuestFileScope): CoworkGuestFileLive }
export interface CoworkGuestFileClientDeps {
  readonly frames: CoworkGuestFileFramePort;
  readonly authority: CoworkGuestFileAuthorityPort;
  /** Test seam: a fresh UUID v4 per call (default `crypto.randomUUID`). */
  readonly requestId?: () => string;
}
export interface CoworkGuestFileCallOptions { readonly signal?: AbortSignal }
export interface CoworkGuestFileClient {
  stat(input: CoworkGuestFileStatInput, options?: CoworkGuestFileCallOptions): Promise<CoworkGuestFileStat>;
  /** The first chunk (offset 0). */
  read(input: CoworkGuestFileReadInput, options?: CoworkGuestFileCallOptions): Promise<CoworkGuestFileChunk>;
  readRange(input: CoworkGuestFileReadRangeInput, options?: CoworkGuestFileCallOptions): Promise<CoworkGuestFileChunk>;
}

/** A transport failure never carries its message; only codes the caller may see for a failed read pass through. */
const TRANSPORT_CODES: readonly CoworkErrorCode[] = ["file_missing", "file_unavailable", "stale_file", "file_incomplete", "response_too_large"];

/** Copy the caller's input into a request candidate: own DATA properties only, no key beyond the operation's, the default
 * chunk size filled in. Validation is the request parser's: the client sends only what that parser accepts. */
function candidate(op: CoworkGuestFileOperation, input: unknown, requestId: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid();
  const wanted: readonly string[] = COWORK_GUEST_FILE_REQUEST_KEYS[op].filter(key => key !== "version" && key !== "requestId" && key !== "op");
  if (Reflect.ownKeys(input).some(key => typeof key !== "string" || !wanted.includes(key))) return invalid();
  const out: Record<string, unknown> = { version: COWORK_GUEST_FILE_CHANNEL_VERSION, requestId, op };
  for (const key of wanted) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    // `maxBytes` is the one optional field: absent, or explicitly `undefined` (an optional property passed through), is the default.
    if (key === "maxBytes" && (descriptor === undefined || ("value" in descriptor && descriptor.value === undefined))) { out[key] = COWORK_GUEST_FILE_LIMITS.chunkDefaultBytes; continue; }
    if (descriptor === undefined) return invalid();
    // No string in a request is longer than the path bound; stop an absurd one before it is ever serialized.
    if (!("value" in descriptor) || (typeof descriptor.value === "string" && descriptor.value.length > COWORK_GUEST_FILE_LIMITS.pathBytes)) return invalid();
    out[key] = descriptor.value;
  }
  return out;
}
function callSignal(options: unknown): AbortSignal {
  if (options === undefined) return new AbortController().signal;
  if (options === null || typeof options !== "object" || Array.isArray(options) || Reflect.ownKeys(options).some(key => key !== "signal")) return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
  if (descriptor === undefined || descriptor.value === undefined) return new AbortController().signal;
  return "value" in descriptor && descriptor.value instanceof AbortSignal ? descriptor.value : invalid();
}
/** Race `pending` against `signal`. The loser is ignored: a late reply is never parsed and cannot be a result. */
function raced(pending: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CoworkError("file_unavailable"));
    // The port may already have aborted the signal while being called, before this listener could exist.
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/** Unwired client. Each call validates its input, checks authority, sends one canonical request line, rechecks authority,
 * incarnation and source revision when the reply arrives, and only then parses it. An abort at any point answers
 * `file_unavailable` with no result; a reply that arrives after the abort is dropped unparsed. */
export function createCoworkGuestFileClient(deps: CoworkGuestFileClientDeps): CoworkGuestFileClient {
  const frames = deps?.frames, authority = deps?.authority, generate = deps?.requestId ?? (() => globalThis.crypto.randomUUID());
  if (frames === null || typeof frames !== "object" || typeof frames.send !== "function" || authority === null || typeof authority !== "object" || typeof authority.check !== "function" || typeof generate !== "function") return invalid();
  const send = frames.send.bind(frames), check = authority.check.bind(authority);
  const aborted = (): never => { throw new CoworkError("file_unavailable"); };

  /** Current records against the bound request. `phase` only decides what a vanished incarnation means: before the call the
   * workspace is simply not running (wake it); after the call the bound incarnation is gone, so the reply is stale. */
  function verify(request: CoworkGuestFileRequest, phase: "before" | "after"): void {
    let incarnation: unknown, revision: unknown;
    // The port's answer is untrusted shape: a Proxy trap, a getter or a hostile `then` can throw anywhere while it is read.
    // Everything from the call to the last read is one try, and any throw is a denial.
    try {
      const live: unknown = check(Object.freeze({ operation: request.op, workspaceId: request.workspaceId, sessionId: request.sessionId, locationId: request.locationId,
        relativePath: request.relativePath, incarnationId: request.incarnationId, sourceRevision: request.sourceRevision }));
      if (live !== null && (typeof live === "object" || typeof live === "function") && typeof (live as { then?: unknown }).then === "function") {
        // An asynchronous port is a denial, and its eventual rejection must not escape as an unhandled one.
        try { Promise.resolve(live).then(undefined, () => {}); } catch { /* a hostile then: already denied */ }
        throw new CoworkError("authority_denied");
      }
      if (live === null || typeof live !== "object") throw new CoworkError("authority_denied");
      const incarnationField = Object.getOwnPropertyDescriptor(live, "incarnationId"), revisionField = Object.getOwnPropertyDescriptor(live, "sourceRevision");
      if (!incarnationField || !("value" in incarnationField) || !revisionField || !("value" in revisionField)) throw new CoworkError("authority_denied");
      incarnation = incarnationField.value; revision = revisionField.value;
    } catch { throw new CoworkError("authority_denied"); }
    if (!Number.isSafeInteger(revision) || (incarnation !== null && typeof incarnation !== "string")) throw new CoworkError("authority_denied");
    if (incarnation === null) throw new CoworkError(phase === "before" ? "file_unavailable" : "stale_file");
    if (incarnation !== request.incarnationId || revision !== request.sourceRevision) throw new CoworkError("stale_file");
  }

  async function call(op: CoworkGuestFileOperation, input: unknown, options: unknown): Promise<CoworkGuestFileStat | CoworkGuestFileChunk> {
    const signal = callSignal(options), requestId = generate();
    let line: string;
    try { line = `${JSON.stringify(candidate(op, input, requestId))}\n`; } catch (error) { if (error instanceof CoworkError) throw error; return invalid(); }
    // The client sends only what the strict request parser accepts: input validation lives in one place.
    const request = parseCoworkGuestFileRequest(line);
    if (signal.aborted) return aborted();
    verify(request, "before");
    let raw: unknown, failed = false, failure: unknown;
    try { raw = await raced(new Promise<unknown>(resolve => resolve(send(line, signal))), signal); } catch (error) { failed = true; failure = error; }
    if (signal.aborted) return aborted();
    // The recheck comes first: a revoked or changed binding answers authority_denied/stale_file and the reply, a
    // transport failure or a guest error is never looked at, so nothing about the guest's files leaks after revocation.
    verify(request, "after");
    if (failed) {
      const code = failure instanceof CoworkError ? TRANSPORT_CODES.find(candidateCode => candidateCode === (failure as CoworkError).code) : undefined;
      throw new CoworkError(code ?? "file_unavailable");
    }
    return parseCoworkGuestFileResponse(raw, request);
  }
  return Object.freeze({
    stat: (input: CoworkGuestFileStatInput, options?: CoworkGuestFileCallOptions) => call("stat", input, options) as Promise<CoworkGuestFileStat>,
    read: (input: CoworkGuestFileReadInput, options?: CoworkGuestFileCallOptions) => call("read", input, options) as Promise<CoworkGuestFileChunk>,
    readRange: (input: CoworkGuestFileReadRangeInput, options?: CoworkGuestFileCallOptions) => call("readRange", input, options) as Promise<CoworkGuestFileChunk>,
  });
}
