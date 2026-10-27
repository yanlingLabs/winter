import { expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { COWORK_FILE_CHUNK_DEFAULT_BYTES, COWORK_FILE_CHUNK_MAX_BYTES, CoworkOutputPath } from "@yanlinglabs/winter-protocol";
import { GUEST_RUNTIME_TRANSPORT_LIMITS } from "../../src/cowork/guest-runtime";
import * as channel from "../../src/cowork/guest-file-channel";
import {
  COWORK_GUEST_FILE_CHANNEL_VERSION, COWORK_GUEST_FILE_ERROR_CODES, COWORK_GUEST_FILE_LIMITS, COWORK_GUEST_FILE_OPERATIONS, COWORK_GUEST_FILE_REQUEST_KEYS,
  COWORK_GUEST_FILE_RESPONSE_KEYS, createCoworkGuestFileClient, parseCoworkGuestFileRequest, parseCoworkGuestFileResponse, parseCoworkGuestRelativePath,
  type CoworkGuestFileAuthorityPort, type CoworkGuestFileClient, type CoworkGuestFileFramePort, type CoworkGuestFileRequest, type CoworkGuestFileScope,
} from "../../src/cowork/guest-file-channel";
import { CoworkError } from "../../src/cowork/types";

const WORKSPACE = "workspace-one", SESSION = "session-one", LOCATION = "location-one", INCARNATION = "incarnation-one", REVISION = 3;
const GENERATION = "a".repeat(64), OTHER_GENERATION = "b".repeat(64);
const binding = { workspaceId: WORKSPACE, sessionId: SESSION, locationId: LOCATION, relativePath: "src/a.txt", incarnationId: INCARNATION, sourceRevision: REVISION };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = (length: number, seed = 7) => Uint8Array.from({ length }, (_value, index) => (index * 31 + seed) & 0xff);
const SECRET = "SECRET-GUEST-FILE-CONTENT";

/** What a code looks like to a caller: the CoworkError code, "resolved" if the call returned. */
async function codeOf(call: Promise<unknown>): Promise<string> {
  try { await call; } catch (error) { return error instanceof CoworkError ? error.code : `non-cowork:${String(error)}`; }
  return "resolved";
}
function codeSync(call: () => unknown): string {
  try { call(); } catch (error) { return error instanceof CoworkError ? error.code : `non-cowork:${String(error)}`; }
  return "returned";
}

/** Synchronous host records as the client sees them through the port. */
class FakeAuthority implements CoworkGuestFileAuthorityPort {
  incarnationId: string | null = INCARNATION;
  sourceRevision = REVISION;
  revoked = false;
  malformed: unknown = undefined;
  scopes: CoworkGuestFileScope[] = [];
  check(scope: CoworkGuestFileScope) {
    this.scopes.push(scope);
    if (this.revoked) throw new CoworkError("authority_denied");
    if (this.malformed !== undefined) return this.malformed as never;
    return { incarnationId: this.incarnationId, sourceRevision: this.sourceRevision };
  }
}

/** An honest guest holding one file. */
function honest(file: Uint8Array, generation = GENERATION) {
  return (frame: string): string => {
    const request = parseCoworkGuestFileRequest(frame);
    const head = { version: 1, requestId: request.requestId, op: request.op, ok: true, workspaceId: request.workspaceId, sessionId: request.sessionId, locationId: request.locationId,
      relativePath: request.relativePath, incarnationId: request.incarnationId, sourceRevision: request.sourceRevision, generation, bytes: file.length, kind: "file" };
    if (request.op === "stat") return line(head);
    if (request.expectedGeneration !== generation) return line({ version: 1, requestId: request.requestId, op: request.op, ok: false, code: "stale_file" });
    const offset = request.op === "readRange" ? request.offset : 0;
    if (offset > file.length) return line({ version: 1, requestId: request.requestId, op: request.op, ok: false, code: "invalid_request" });
    const slice = file.subarray(offset, Math.min(file.length, offset + request.maxBytes));
    return line({ ...head, offset, nextOffset: offset + slice.length, eof: offset + slice.length === file.length, contentBase64: Buffer.from(slice).toString("base64"), encoding: "base64" });
  };
}

type Respond = (frame: string, signal: AbortSignal) => Promise<string> | string;
function rig(respond: Respond) {
  const authority = new FakeAuthority(), frames: string[] = [], signals: AbortSignal[] = [];
  let next = 0;
  const port: CoworkGuestFileFramePort = { async send(frame, signal) { frames.push(frame); signals.push(signal); return respond(frame, signal); } };
  const client: CoworkGuestFileClient = createCoworkGuestFileClient({ frames: port, authority, requestId: () => uuid(++next) });
  return { client, authority, frames, signals };
}
const stat = binding;
const read = { ...binding, expectedGeneration: GENERATION };
const range = (offset: number, maxBytes?: number) => ({ ...read, offset, ...(maxBytes === undefined ? {} : { maxBytes }) });

// ---------------------------------------------------------------- request frames

test("the client sends one canonical closed request line per operation, in key order, and fills the default chunk size", async () => {
  const file = bytes(10), guest = rig(honest(file));
  await guest.client.stat(stat); await guest.client.read(read); await guest.client.readRange(range(4, 3));
  expect(guest.frames.length).toBe(3);
  const [first, second, third] = guest.frames.map(frame => { expect(frame.endsWith("\n")).toBe(true); expect(frame.indexOf("\n")).toBe(frame.length - 1); return JSON.parse(frame) as Record<string, unknown>; });
  expect(Object.keys(first!)).toEqual([...COWORK_GUEST_FILE_REQUEST_KEYS.stat]);
  expect(Object.keys(second!)).toEqual([...COWORK_GUEST_FILE_REQUEST_KEYS.read]);
  expect(Object.keys(third!)).toEqual([...COWORK_GUEST_FILE_REQUEST_KEYS.readRange]);
  expect(second!.maxBytes).toBe(65536); expect(third!.maxBytes).toBe(3); expect(third!.offset).toBe(4);
  expect([first!.requestId, second!.requestId, third!.requestId]).toEqual([uuid(1), uuid(2), uuid(3)]);
  for (const frame of guest.frames) expect(Object.isFrozen(parseCoworkGuestFileRequest(frame))).toBe(true);
});

test("the request parser is closed: unknown, missing, mistyped, duplicate, respelled and prototype keys are all invalid_request", () => {
  const good = { version: 1, requestId: uuid(1), op: "readRange", ...binding, expectedGeneration: GENERATION, offset: 0, maxBytes: 10 };
  expect(parseCoworkGuestFileRequest(line(good)).op).toBe("readRange");
  const refused = (raw: unknown) => expect(codeSync(() => parseCoworkGuestFileRequest(raw))).toBe("invalid_request");
  refused(line({ ...good, extra: 1 }));
  for (const key of Object.keys(good)) { const copy: Record<string, unknown> = { ...good }; delete copy[key]; refused(line(copy)); }
  refused(line({ ...good, version: 2 })); refused(line({ ...good, op: "list" })); refused(line({ ...good, requestId: "not-a-uuid" }));
  refused(line({ ...good, sourceRevision: 0 })); refused(line({ ...good, sourceRevision: "3" })); refused(line({ ...good, offset: -1 })); refused(line({ ...good, offset: 1.5 }));
  refused(line({ ...good, maxBytes: 0 })); refused(line({ ...good, maxBytes: COWORK_GUEST_FILE_LIMITS.chunkMaxBytes + 1 })); refused(line({ ...good, expectedGeneration: "ABC" }));
  refused(line({ ...good, relativePath: "../x" })); refused(line({ ...good, workspaceId: "" }));
  refused(JSON.stringify(good)); refused(`${JSON.stringify(good)}\n\n`); refused(`${JSON.stringify(good)}\n${JSON.stringify(good)}\n`); refused(`${JSON.stringify(good, null, 1)}\n`);
  refused(`{"version":1,"version":1,"requestId":"${uuid(1)}"}\n`);
  refused(line(good).replace('"op":"readRange"', '"op":"readRang\\u0065"'));
  refused(line(good).replace('"offset":0', '"offset":0.0'));
  refused(line(good).replace(/^\{/, '{"__proto__":{},')); refused(line(good).replace(/^\{/, '{"constructor":1,'));
  refused(undefined); refused(null); refused(Buffer.from(line(good))); refused("x".repeat(COWORK_GUEST_FILE_LIMITS.requestFrameBytes + 1));
});

// ---------------------------------------------------------------- honest round trips

test("stat, read and a ranged read of an honest guest return exactly the bytes, as frozen results with private buffers", async () => {
  const file = bytes(1000), guest = rig(honest(file));
  const info = await guest.client.stat(stat);
  expect(info).toEqual({ ...binding, generation: GENERATION, bytes: 1000, kind: "file" }); expect(Object.isFrozen(info)).toBe(true);
  const first = await guest.client.read({ ...read, maxBytes: 100 });
  expect(first.offset).toBe(0); expect(first.nextOffset).toBe(100); expect(first.eof).toBe(false); expect([...first.content]).toEqual([...file.subarray(0, 100)]);
  expect(Object.isFrozen(first)).toBe(true); expect(first.content.buffer.byteLength).toBe(first.content.length); expect(first.content.byteOffset).toBe(0);
  const middle = await guest.client.readRange(range(400, 50));
  expect([...middle.content]).toEqual([...file.subarray(400, 450)]); expect(middle.nextOffset).toBe(450); expect(middle.eof).toBe(false);
});

test("a whole file read in chunks reassembles exactly, for empty, tiny, exact-multiple and ragged sizes", async () => {
  for (const size of [0, 1, 99, 100, 200, 201]) {
    const file = bytes(size), guest = rig(honest(file)), info = await guest.client.stat(stat), out: number[] = [];
    let offset = 0, eof = false, calls = 0;
    while (!eof) { const chunk = await guest.client.readRange(range(offset, 100)); out.push(...chunk.content); offset = chunk.nextOffset; eof = chunk.eof; calls++; expect(calls).toBeLessThan(10); }
    expect(info.bytes).toBe(size); expect(out).toEqual([...file]); expect(offset).toBe(size);
  }
  // Reading AT the end is an empty eof chunk, not an error.
  const guest = rig(honest(bytes(100))), tail = await guest.client.readRange(range(100, 10));
  expect(tail.content.length).toBe(0); expect(tail.eof).toBe(true); expect(tail.nextOffset).toBe(100);
});

test("a guest-reported error code reaches the caller as that code; any other code is file_unavailable", async () => {
  for (const code of COWORK_GUEST_FILE_ERROR_CODES) {
    const guest = rig(frame => { const r = parseCoworkGuestFileRequest(frame); return line({ version: 1, requestId: r.requestId, op: r.op, ok: false, code }); });
    expect(await codeOf(guest.client.stat(stat))).toBe(code);
  }
  for (const code of ["authority_denied", "not_found", "recovery_required", "", "FILE_MISSING", 7, null]) {
    const guest = rig(frame => { const r = parseCoworkGuestFileRequest(frame); return line({ version: 1, requestId: r.requestId, op: r.op, ok: false, code }); });
    expect(await codeOf(guest.client.stat(stat))).toBe("file_unavailable");
  }
});

// ---------------------------------------------------------------- closed response parse

function chunkRequest(op: "read" | "readRange" = "readRange", offset = 4, maxBytes = 4): CoworkGuestFileRequest {
  return parseCoworkGuestFileRequest(line(op === "read" ? { version: 1, requestId: uuid(9), op, ...binding, expectedGeneration: GENERATION, maxBytes }
    : { version: 1, requestId: uuid(9), op, ...binding, expectedGeneration: GENERATION, offset, maxBytes }));
}
const statRequest = () => parseCoworkGuestFileRequest(line({ version: 1, requestId: uuid(9), op: "stat", ...binding }));
const statFrame = (over: Record<string, unknown> = {}) => ({ version: 1, requestId: uuid(9), op: "stat", ok: true, ...binding, generation: GENERATION, bytes: 10, kind: "file", ...over });
/** A valid chunk reply to chunkRequest(): 10-byte file, bytes 4..8. */
const chunkFrame = (over: Record<string, unknown> = {}) => ({ ...statFrame({ op: "readRange" }), offset: 4, nextOffset: 8, eof: false, contentBase64: Buffer.from(bytes(4)).toString("base64"), encoding: "base64", ...over });
const parseCode = (raw: unknown, request: CoworkGuestFileRequest) => codeSync(() => parseCoworkGuestFileResponse(raw, request));

test("the response parser accepts exactly the closed frames and refuses everything else as file_unavailable", () => {
  expect(parseCoworkGuestFileResponse(line(statFrame()), statRequest()).bytes).toBe(10);
  const ok = parseCoworkGuestFileResponse(line(chunkFrame()), chunkRequest());
  expect("content" in ok && [...ok.content]).toEqual([...bytes(4)]);
  const refusedStat = (raw: unknown) => expect(parseCode(raw, statRequest())).toBe("file_unavailable");
  const refusedChunk = (raw: unknown) => expect(parseCode(raw, chunkRequest())).toBe("file_unavailable");
  // Unknown and missing keys.
  refusedStat(line(statFrame({ extra: 1 }))); refusedChunk(line(chunkFrame({ extra: 1 })));
  for (const key of Object.keys(statFrame())) { const copy: Record<string, unknown> = statFrame(); delete copy[key]; refusedStat(line(copy)); }
  for (const key of Object.keys(chunkFrame())) { const copy: Record<string, unknown> = chunkFrame(); delete copy[key]; refusedChunk(line(copy)); }
  // A stat reply is not a chunk reply and vice versa.
  refusedStat(line(chunkFrame({ op: "stat" }))); refusedChunk(line(statFrame({ op: "readRange" })));
  // Wrong types and values, key by key.
  const wrong: Record<string, unknown> = { version: 2, requestId: uuid(8), op: "list", ok: "true", workspaceId: 5, sessionId: "", locationId: null, relativePath: 3, incarnationId: ["a"], sourceRevision: "3",
    generation: "xyz", bytes: 1.5, kind: "directory", offset: -1, nextOffset: "8", eof: "false", contentBase64: 5, encoding: "hex" };
  for (const [key, value] of Object.entries(wrong)) {
    if (key in statFrame()) refusedStat(line(statFrame({ [key]: value })));
    refusedChunk(line(chunkFrame({ [key]: value })));
  }
  refusedChunk(line(chunkFrame({ bytes: -1 }))); refusedChunk(line(chunkFrame({ bytes: Number.MAX_SAFE_INTEGER + 2 }))); refusedChunk(line(chunkFrame({ sourceRevision: 0 })));
  refusedChunk(line(chunkFrame({ contentBase64: "AAA" }))); refusedChunk(line(chunkFrame({ contentBase64: "AAAA====" }))); refusedChunk(line(chunkFrame({ contentBase64: "AB==" })));
  refusedChunk(line(chunkFrame({ contentBase64: " AAAA" }))); refusedChunk(line(chunkFrame({ contentBase64: "AA\nA" })));
  // Not a canonical single line.
  const text = line(chunkFrame()), raw = text.slice(0, -1);
  refusedChunk(raw); refusedChunk(`${raw}\r\n`); refusedChunk(`${text}${text}`); refusedChunk(`\n${text}`); refusedChunk(`${raw} \n`); refusedChunk(`${JSON.stringify(chunkFrame(), null, 1)}\n`);
  refusedChunk(text.replace('"op":"readRange"', '"op":"readRang\\u0065"')); refusedChunk(text.replace('"bytes":10', '"bytes":1e1')); refusedChunk(text.replace('"bytes":10', '"bytes":10.0'));
  refusedChunk(text.replace(/^\{/, `{"ok":false,`)); // duplicate key
  refusedChunk("{]\n"); refusedChunk("[]\n"); refusedChunk('"x"\n'); refusedChunk("null\n"); refusedChunk("\n"); refusedChunk("");
  for (const value of [undefined, null, 5, {}, [], Buffer.from(text), new Uint8Array(4)]) refusedChunk(value);
});

test("key order is free: the parsers accept a frame whose keys arrive in any order, and the client emits the listed order", () => {
  const reversed = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).reverse());
  const response = parseCoworkGuestFileResponse(line(reversed(chunkFrame())), chunkRequest());
  expect("content" in response && [...response.content]).toEqual([...bytes(4)]);
  expect(parseCode(line(reversed(statFrame())), statRequest())).toBe("returned");
  const request = { version: 1, requestId: uuid(1), op: "readRange", ...binding, expectedGeneration: GENERATION, offset: 0, maxBytes: 10 };
  expect(parseCoworkGuestFileRequest(line(reversed(request))).op).toBe("readRange");
  expect(parseCode(line(reversed({ version: 1, requestId: uuid(9), op: "readRange", ok: false, code: "file_missing" })), chunkRequest())).toBe("file_missing");
});

test("prototype-slot keys, ill-formed strings (raw or escaped) and deep nesting are refused before anything is read from the frame", () => {
  const text = line(chunkFrame());
  for (const key of ["__proto__", "constructor", "prototype"]) expect(parseCode(text.replace(/^\{/, `{"${key}":1,`), chunkRequest())).toBe("file_unavailable");
  // The echoed path is attacker-chosen: with it ill-formed the reply must be refused as unparseable, not merely as
  // "bound to another path" (authority_denied).
  expect(parseCode(text.replace('"relativePath":"src/a.txt"', '"relativePath":"src/\\ud800.txt"'), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(text.replace('"relativePath":"src/a.txt"', `"relativePath":"src/\ud800.txt"`), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(text.replace('"workspaceId":"workspace-one"', '"workspaceId\\ud800":"workspace-one"'), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(line({ version: 1, requestId: uuid(9), op: "readRange", ok: false, code: "file_missing\ud800" }), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(line(chunkFrame({ relativePath: { a: { b: 1 } } })), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(`{"a":{"b":{}}}\n`, chunkRequest())).toBe("file_unavailable");
  expect(parseCode(`${"[".repeat(100000)}\n`, chunkRequest())).toBe("file_unavailable");
});

test("a reply must be for this request: version, request id and operation, in success and error frames alike", () => {
  const failure = (over: Record<string, unknown>) => line({ version: 1, requestId: uuid(9), op: "readRange", ok: false, code: "file_missing", ...over });
  expect(parseCode(failure({}), chunkRequest())).toBe("file_missing");
  expect(parseCode(failure({ requestId: uuid(8) }), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(failure({ op: "read" }), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(failure({ version: 2 }), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(failure({ extra: true }), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(failure({ ok: 0 }), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(line(chunkFrame({ requestId: uuid(8) })), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(line(chunkFrame({ op: "read" })), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(line(chunkFrame({ version: 2 })), chunkRequest())).toBe("file_unavailable");
});

// ---------------------------------------------------------------- bounds

test("the named bounds equal the host-backed output read bounds and fit the guest transport frame", () => {
  const limits = COWORK_GUEST_FILE_LIMITS;
  expect(limits.chunkMaxBytes).toBe(COWORK_FILE_CHUNK_MAX_BYTES); expect(limits.chunkDefaultBytes).toBe(COWORK_FILE_CHUNK_DEFAULT_BYTES);
  expect<number>(limits.base64MaxChars).toBe(4 * Math.ceil(limits.chunkMaxBytes / 3));
  expect(Buffer.from(new Uint8Array(limits.chunkMaxBytes)).toString("base64").length).toBe(limits.base64MaxChars);
  expect(limits.responseFrameBytes).toBeLessThanOrEqual(GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes);
  expect(limits.requestFrameBytes).toBeLessThan(limits.responseFrameBytes);
  // The same 384 KiB inner budget the host-backed file responses use (service.ts), checked against its source text.
  expect(readFileSync(join(import.meta.dir, "..", "..", "src", "cowork", "service.ts"), "utf8")).toContain('"workspace.file.") ? 384 * 1024');
});

test("an oversized body is response_too_large at every layer: the frame, the base64 text and the decoded bytes", async () => {
  const request = chunkRequest("readRange", 0, COWORK_GUEST_FILE_LIMITS.chunkMaxBytes);
  const limit = COWORK_GUEST_FILE_LIMITS.responseFrameBytes;
  // Frame: one byte over, as UTF-16 length and as UTF-8 length with a short UTF-16 length.
  expect(parseCode(`${"x".repeat(limit)}\n`, request)).toBe("response_too_large");
  expect(parseCode(`${"\u00e9".repeat(limit / 2)}\n`, request)).toBe("response_too_large");
  // AT the bound it is still parsed (and refused as unparseable, not as too large).
  expect(parseCode(`${"x".repeat(limit - 1)}\n`, request)).toBe("file_unavailable");
  // Base64 text one group over the bound for 256 KiB, in a frame that is otherwise valid and under the frame bound.
  const huge = line(chunkFrame({ bytes: 1 << 30, offset: 0, nextOffset: 0, contentBase64: "A".repeat(COWORK_GUEST_FILE_LIMITS.base64MaxChars + 4) }));
  expect(Buffer.byteLength(huge)).toBeLessThan(limit);
  expect(parseCode(huge, request)).toBe("response_too_large");
  // The size is decided from the LENGTH, before anything is decoded: text that is not even base64 is still "too large", not "unparseable".
  expect(parseCode(line(chunkFrame({ bytes: 1 << 30, offset: 0, nextOffset: 0, contentBase64: "!".repeat(COWORK_GUEST_FILE_LIMITS.base64MaxChars + 4) })), request)).toBe("response_too_large");
  expect(parseCode(line(chunkFrame({ bytes: 1 << 30, offset: 0, nextOffset: 0, contentBase64: "!".repeat(COWORK_GUEST_FILE_LIMITS.base64MaxChars) })), request)).toBe("file_unavailable");
  // Base64 longer than THIS request allows (1 KiB asked, 2 KiB sent) though the frame and the global bound are fine.
  const small = chunkRequest("readRange", 0, 1024);
  expect(parseCode(line(chunkFrame({ bytes: 4096, offset: 0, nextOffset: 2048, contentBase64: Buffer.from(bytes(2048)).toString("base64") })), small)).toBe("response_too_large");
  // Decoded bytes over what was asked while the base64 text length still fits: 3 bytes decode from the 4 characters allowed for 1.
  const one = chunkRequest("readRange", 0, 1);
  expect(parseCode(line(chunkFrame({ bytes: 3, offset: 0, nextOffset: 3, eof: true, contentBase64: Buffer.from(bytes(3)).toString("base64") })), one)).toBe("response_too_large");
  expect(parseCode(line(chunkFrame({ bytes: 1, offset: 0, nextOffset: 1, eof: true, contentBase64: Buffer.from(bytes(1)).toString("base64") })), one)).toBe("returned");
  // Through the client the oversized body never returns.
  const guest = rig(frame => { const r = parseCoworkGuestFileRequest(frame); return line({ ...chunkFrame({ requestId: r.requestId, offset: 0, nextOffset: 3, bytes: 3, eof: true, contentBase64: Buffer.from(SECRET).toString("base64").slice(0, 4) }) }); });
  expect(await codeOf(guest.client.readRange(range(0, 1)))).toBe("response_too_large");
});

test("a maximal chunk with the worst escaped path fits both frame bounds and round trips", async () => {
  const worst = Array.from({ length: 16 }, () => '"'.repeat(255)).join("/"); // 4095 bytes, every character JSON-escaped
  expect(Buffer.byteLength(worst)).toBe(4095); expect(parseCoworkGuestRelativePath(worst)).toBe(worst);
  const file = bytes(COWORK_GUEST_FILE_LIMITS.chunkMaxBytes), seen: string[] = [];
  const guest = rig(frame => { seen.push(frame); return honest(file)(frame); });
  const chunk = await guest.client.readRange({ ...range(0, COWORK_GUEST_FILE_LIMITS.chunkMaxBytes), relativePath: worst });
  expect(chunk.content.length).toBe(COWORK_GUEST_FILE_LIMITS.chunkMaxBytes); expect(chunk.eof).toBe(true); expect(chunk.relativePath).toBe(worst);
  expect(Buffer.byteLength(seen[0]!)).toBeLessThan(COWORK_GUEST_FILE_LIMITS.requestFrameBytes);
  const reply = honest(file)(seen[0]!);
  expect(Buffer.byteLength(reply)).toBeLessThan(COWORK_GUEST_FILE_LIMITS.responseFrameBytes); expect(Buffer.byteLength(reply)).toBeGreaterThan(COWORK_GUEST_FILE_LIMITS.base64MaxChars);
});

test("a bad chunk size, offset or path is invalid_request and nothing is sent or asked of the authority", async () => {
  const guest = rig(honest(bytes(10)));
  for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, COWORK_GUEST_FILE_LIMITS.chunkMaxBytes + 1])
    expect(await codeOf(guest.client.readRange(range(0, maxBytes as number)))).toBe("invalid_request");
  for (const offset of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "0", undefined, null]) expect(await codeOf(guest.client.readRange({ ...read, offset } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.read({ ...read, maxBytes: 0 }))).toBe("invalid_request");
  expect(await codeOf(guest.client.read({ ...read, expectedGeneration: "g" }))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat({ ...stat, sourceRevision: 0 }))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat({ ...stat, incarnationId: "" }))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat({ ...stat, relativePath: "x".repeat(1_000_000) }))).toBe("invalid_request");
  expect(guest.frames.length).toBe(0); expect(guest.authority.scopes.length).toBe(0);
  expect(await codeOf(guest.client.readRange(range(0, COWORK_GUEST_FILE_LIMITS.chunkMaxBytes)))).toBe("resolved"); expect(await codeOf(guest.client.readRange(range(0, 1)))).toBe("resolved");
});

test("client input is closed: unknown keys, accessors, symbols, a wrong-op field, a non-object and bad options are invalid_request", async () => {
  const guest = rig(honest(bytes(10)));
  expect(await codeOf(guest.client.stat({ ...stat, extra: 1 } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat({ ...stat, maxBytes: 5 } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.read({ ...read, offset: 0 } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat({ ...stat, [Symbol("x")]: 1 } as never))).toBe("invalid_request");
  const accessor = { ...stat }; Object.defineProperty(accessor, "workspaceId", { enumerable: true, get: () => WORKSPACE });
  expect(await codeOf(guest.client.stat(accessor as never))).toBe("invalid_request");
  const { workspaceId: _omitted, ...missing } = stat; expect(await codeOf(guest.client.stat(missing as never))).toBe("invalid_request");
  for (const input of [null, undefined, 5, "x", [], [stat]]) expect(await codeOf(guest.client.stat(input as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat(stat, { signal: {} } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat(stat, { signal: new AbortController().signal, extra: 1 } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat(stat, null as never))).toBe("invalid_request");
  expect(guest.frames.length).toBe(0);
  expect(await codeOf(guest.client.stat(stat, {}))).toBe("resolved"); expect(await codeOf(guest.client.stat(stat, { signal: undefined }))).toBe("resolved");
});

test("construction refuses a missing or non-function port, and a request id that is not a v4 uuid", async () => {
  const authority = new FakeAuthority(), frames: CoworkGuestFileFramePort = { send: async () => "" };
  for (const deps of [undefined, null, {}, { frames }, { authority }, { frames: {}, authority }, { frames, authority: {} }, { frames: { send: 1 }, authority }, { frames, authority, requestId: 5 }])
    expect(codeSync(() => createCoworkGuestFileClient(deps as never))).toBe("invalid_request");
  const client = createCoworkGuestFileClient({ frames: { send: async () => { throw new Error("never"); } }, authority, requestId: () => "not-a-uuid" });
  expect(await codeOf(client.stat(stat))).toBe("invalid_request"); expect(authority.scopes.length).toBe(0);
  // The default generator yields v4 uuids and a different one per call.
  const sent: string[] = [], real = createCoworkGuestFileClient({ frames: { send: async frame => { sent.push(frame); return honest(bytes(1))(frame); } }, authority });
  await real.stat(stat); await real.stat(stat);
  expect(new Set(sent.map(frame => parseCoworkGuestFileRequest(frame).requestId)).size).toBe(2);
});

// ---------------------------------------------------------------- path validation

const VALID_PATHS = ["a", "src/a.txt", ".hidden", "a/.b/c..d", "a b/c\u00e9/\u4e2d\u6587.txt", "a\\b", "~/x", "C:/x", "-rf", "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/a/b/c/d/e/f".split("/").slice(0, 32).join("/"),
  "x".repeat(255), `${"x".repeat(255)}/${"y".repeat(255)}`, "\u00e9".repeat(127), Array.from({ length: 16 }, () => "z".repeat(255)).join("/")];
const INVALID_PATHS: unknown[] = ["", "/", "/abs", "/etc/passwd", "a//b", "a/", "/a/", ".", "./a", "a/./b", "a/.", "..", "../a", "a/../b", "a/..", "a/b/../..", "a\0b", "\0", "a\nb", "a\rb", "a\tb", "a\u001bb", "a\u007fb", "a\u0085b", "a\u009fb",
  "a\ud800b", "\udc00", "a/\ud83d", "x".repeat(256), "\u00e9".repeat(128), "x".repeat(4097), Array.from({ length: 17 }, () => "z".repeat(255)).join("/"), Array.from({ length: 33 }, () => "a").join("/"),
  undefined, null, 5, {}, ["a"], Buffer.from("a")];

test("relative guest paths: no absolute path, dot or dot-dot component, NUL or control character, ill-formed string or bound overrun", () => {
  for (const path of VALID_PATHS) expect(`${JSON.stringify(path)}:${codeSync(() => parseCoworkGuestRelativePath(path))}`).toBe(`${JSON.stringify(path)}:returned`);
  for (const path of INVALID_PATHS) expect(`${JSON.stringify(path)?.slice(0, 40)}:${codeSync(() => parseCoworkGuestRelativePath(path))}`).toBe(`${JSON.stringify(path)?.slice(0, 40)}:invalid_request`);
  expect(Buffer.byteLength(Array.from({ length: 32 }, () => "a").join("/"))).toBe(63); expect(parseCoworkGuestRelativePath(Array.from({ length: 32 }, () => "a").join("/"))).toBeTruthy();
  const exact = `${"x".repeat(255)}/`.repeat(15) + "x".repeat(4095 - 15 * 256);
  expect(Buffer.byteLength(exact)).toBe(4095); expect(parseCoworkGuestRelativePath(exact)).toBe(exact); expect(codeSync(() => parseCoworkGuestRelativePath(`${exact}xx`))).toBe("invalid_request");
});
test("every client operation refuses an invalid path with invalid_request before a frame is sent", async () => {
  const guest = rig(honest(bytes(1)));
  for (const path of ["/etc/passwd", "../x", "a/../b", "a\0b", "a\nb", "a\ud800", "a//b", ""]) {
    expect(await codeOf(guest.client.stat({ ...stat, relativePath: path }))).toBe("invalid_request");
    expect(await codeOf(guest.client.read({ ...read, relativePath: path }))).toBe("invalid_request");
    expect(await codeOf(guest.client.readRange({ ...range(0), relativePath: path }))).toBe("invalid_request");
  }
  expect(guest.frames.length).toBe(0); expect(guest.authority.scopes.length).toBe(0);
});
test("the guest path validator is never looser than the protocol's CoworkOutputPath", () => {
  for (const path of [...VALID_PATHS, ...INVALID_PATHS]) if (codeSync(() => parseCoworkGuestRelativePath(path)) === "returned") expect(CoworkOutputPath.safeParse(path).success).toBe(true);
  // ...and strictly tighter where it matters: the protocol accepts control characters, the guest channel does not.
  expect(CoworkOutputPath.safeParse("a\nb").success).toBe(true); expect(codeSync(() => parseCoworkGuestRelativePath("a\nb"))).toBe("invalid_request");
});

// ---------------------------------------------------------------- offset and eof consistency

test("offset, length and eof must add up exactly or the reply is file_incomplete", () => {
  const request = chunkRequest(); // readRange offset 4, maxBytes 4
  const inconsistent: Record<string, Record<string, unknown>> = {
    "offset is not the requested offset": { offset: 3, nextOffset: 7 },
    "offset alone is not the requested offset": { offset: 3 },
    "offset is the end of the file instead": { offset: 10 },
    "nextOffset is not offset plus length": { nextOffset: 9 },
    "nextOffset is short of offset plus length": { nextOffset: 7 },
    "nextOffset runs past the file": { bytes: 6 },
    "eof is claimed before the end": { eof: true },
    "eof is withheld at the end": { bytes: 8, eof: false },
    "a short chunk that is not the end": { contentBase64: Buffer.from(bytes(3)).toString("base64"), nextOffset: 7 },
    "a longer chunk than the file leaves": { bytes: 7, nextOffset: 8, eof: false },
    "no progress and no end": { contentBase64: "", nextOffset: 4 },
    "empty and eof short of the file": { contentBase64: "", nextOffset: 4, eof: true },
    "offset beyond the file": { bytes: 2, offset: 4, nextOffset: 8 },
  };
  for (const [name, over] of Object.entries(inconsistent)) expect(`${name}:${parseCode(line(chunkFrame(over)), request)}`).toBe(`${name}:file_incomplete`);
  // The consistent shapes around them.
  expect(parseCode(line(chunkFrame()), request)).toBe("returned");
  expect(parseCode(line(chunkFrame({ bytes: 8, eof: true })), request)).toBe("returned");
  expect(parseCode(line(chunkFrame({ bytes: 6, eof: true, nextOffset: 6, contentBase64: Buffer.from(bytes(2)).toString("base64") })), request)).toBe("returned");
  expect(parseCode(line(chunkFrame({ bytes: 4, eof: true, nextOffset: 4, contentBase64: "" })), request)).toBe("returned");
  // `read` is offset 0.
  const first = chunkRequest("read", 0, 4);
  expect(parseCode(line(chunkFrame({ op: "read" })), first)).toBe("file_incomplete");
  expect(parseCode(line(chunkFrame({ op: "read", offset: 0, nextOffset: 4 })), first)).toBe("returned");
  expect(parseCode(line(chunkFrame({ op: "read", offset: 0, nextOffset: 0, bytes: 0, eof: true, contentBase64: "" })), first)).toBe("returned");
});

test("an inconsistent guest reply through the client is file_incomplete and returns no bytes", async () => {
  const guest = rig(frame => { const r = parseCoworkGuestFileRequest(frame); return line(chunkFrame({ requestId: r.requestId, op: "readRange", offset: 0, nextOffset: 3, bytes: 100, eof: true, contentBase64: Buffer.from(SECRET).toString("base64").slice(0, 4) })); });
  expect(await codeOf(guest.client.readRange(range(0, 4)))).toBe("file_incomplete");
});

// ---------------------------------------------------------------- authority sandwich

test("authority is asked before the frame leaves and again when the reply arrives, with the exact bound scope", async () => {
  const order: string[] = [], authority = new FakeAuthority();
  const client = createCoworkGuestFileClient({ frames: { send: async frame => { order.push("send"); return honest(bytes(5))(frame); } },
    authority: { check: scope => { order.push("check"); return authority.check(scope); } }, requestId: () => uuid(1) });
  await client.readRange(range(2, 2));
  expect(order).toEqual(["check", "send", "check"]);
  expect(authority.scopes.length).toBe(2);
  for (const scope of authority.scopes) expect(scope).toEqual({ operation: "readRange", ...binding });
  expect(Object.isFrozen(authority.scopes[0])).toBe(true);
});

test("revocation while the call is in flight discards the bytes: authority_denied, for every operation, whatever the guest said", async () => {
  for (const [name, call] of [["stat", (c: CoworkGuestFileClient) => c.stat(stat)], ["read", (c: CoworkGuestFileClient) => c.read(read)], ["readRange", (c: CoworkGuestFileClient) => c.readRange(range(0, 5))]] as const) {
    const guest = rig(frame => { guest.authority.revoked = true; return honest(Buffer.from(SECRET))(frame); });
    let error: unknown;
    try { await call(guest.client); } catch (caught) { error = caught; }
    expect(`${name}:${(error as CoworkError | undefined)?.code}`).toBe(`${name}:authority_denied`);
    expect(String(error)).not.toContain(SECRET); expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET);
    expect(guest.frames.length).toBe(1); expect(guest.authority.scopes.length).toBe(2);
  }
  // Revocation also beats a guest error, a malformed reply and a transport failure: nothing about the files is learned.
  const frames: Record<string, Respond> = {
    "a guest error": frame => { const r = parseCoworkGuestFileRequest(frame); return line({ version: 1, requestId: r.requestId, op: r.op, ok: false, code: "file_missing" }); },
    "garbage": () => "not json\n", "an oversized frame": () => "x".repeat(COWORK_GUEST_FILE_LIMITS.responseFrameBytes + 10), "a thrown transport": () => { throw new Error("boom"); }, "a non-string": () => 5 as never,
  };
  for (const [name, respond] of Object.entries(frames)) {
    const guest = rig((frame, signal) => { guest.authority.revoked = true; return respond(frame, signal); });
    expect(`${name}:${await codeOf(guest.client.stat(stat))}`).toBe(`${name}:authority_denied`);
  }
});

test("authority that is revoked, throwing, a promise or malformed before the call sends nothing", async () => {
  const guest = rig(honest(bytes(5)));
  guest.authority.revoked = true;
  expect(await codeOf(guest.client.stat(stat))).toBe("authority_denied"); expect(guest.frames.length).toBe(0);
  guest.authority.revoked = false;
  for (const malformed of [null, 5, "ok", [], Promise.resolve({ incarnationId: INCARNATION, sourceRevision: REVISION }), {}, { incarnationId: INCARNATION }, { sourceRevision: REVISION },
    { incarnationId: 7, sourceRevision: REVISION }, { incarnationId: INCARNATION, sourceRevision: "3" }, { incarnationId: INCARNATION, sourceRevision: 3.5 },
    { get incarnationId() { return INCARNATION; }, sourceRevision: REVISION }]) {
    guest.authority.malformed = malformed;
    expect(await codeOf(guest.client.stat(stat))).toBe("authority_denied");
  }
  expect(guest.frames.length).toBe(0);
  guest.authority.malformed = undefined;
  expect(await codeOf(guest.client.stat(stat))).toBe("resolved");
  const throwing = createCoworkGuestFileClient({ frames: { send: async () => "" }, authority: { check: () => { throw new Error("db down"); } } });
  expect(await codeOf(throwing.stat(stat))).toBe("authority_denied");
});

test("a stale incarnation or source revision is stale_file before the call (nothing sent) and after it (bytes discarded)", async () => {
  const before = rig(honest(bytes(5)));
  before.authority.incarnationId = "incarnation-two";
  expect(await codeOf(before.client.stat(stat))).toBe("stale_file"); expect(before.frames.length).toBe(0);
  before.authority.incarnationId = INCARNATION; before.authority.sourceRevision = REVISION + 1;
  expect(await codeOf(before.client.stat(stat))).toBe("stale_file"); expect(before.frames.length).toBe(0);
  // Changed while the call was in flight.
  const incarnation = rig(frame => { incarnation.authority.incarnationId = "incarnation-two"; return honest(Buffer.from(SECRET))(frame); });
  expect(await codeOf(incarnation.client.read(read))).toBe("stale_file");
  const revision = rig(frame => { revision.authority.sourceRevision = REVISION + 1; return honest(Buffer.from(SECRET))(frame); });
  expect(await codeOf(revision.client.readRange(range(0, 4)))).toBe("stale_file");
  expect(await codeOf(revision.client.stat({ ...stat, sourceRevision: REVISION + 1 }))).toBe("resolved"); // the caller re-binds to the new revision
  // The incarnation stopped (null) in flight: the bound incarnation is gone.
  const stopped = rig(frame => { stopped.authority.incarnationId = null; return honest(Buffer.from(SECRET))(frame); });
  expect(await codeOf(stopped.client.stat(stat))).toBe("stale_file");
  // Revoked beats stale when both happen.
  const both = rig(frame => { both.authority.incarnationId = "incarnation-two"; both.authority.revoked = true; return honest(bytes(5))(frame); });
  expect(await codeOf(both.client.stat(stat))).toBe("authority_denied");
});

test("a workspace with no running incarnation is file_unavailable before the call: wake it, nothing is sent", async () => {
  const guest = rig(honest(bytes(5)));
  guest.authority.incarnationId = null;
  expect(await codeOf(guest.client.stat(stat))).toBe("file_unavailable"); expect(guest.frames.length).toBe(0);
});

test("a reply bound to another incarnation, source revision or generation is stale_file, and to another scope is authority_denied", async () => {
  const echo = (over: Record<string, unknown>) => rig(frame => line({ ...JSON.parse(honest(bytes(10))(frame)), ...over }));
  expect(await codeOf(echo({ incarnationId: "incarnation-two" }).client.stat(stat))).toBe("stale_file");
  expect(await codeOf(echo({ sourceRevision: REVISION + 1 }).client.stat(stat))).toBe("stale_file");
  expect(await codeOf(echo({ sourceRevision: REVISION - 1 }).client.read(read))).toBe("stale_file");
  expect(await codeOf(echo({ generation: OTHER_GENERATION }).client.read(read))).toBe("stale_file");
  expect(await codeOf(echo({ generation: OTHER_GENERATION }).client.readRange(range(0, 4)))).toBe("stale_file");
  expect(await codeOf(echo({ generation: OTHER_GENERATION }).client.stat(stat))).toBe("resolved"); // stat reports the generation; it has nothing to compare
  for (const over of [{ workspaceId: "workspace-two" }, { sessionId: "session-two" }, { locationId: "location-two" }, { relativePath: "src/b.txt" }, { relativePath: "src/a.txt/" }, { relativePath: "../a.txt" }]) {
    expect(`${JSON.stringify(over)}:${await codeOf(echo(over).client.stat(stat))}`).toBe(`${JSON.stringify(over)}:authority_denied`);
    expect(`${JSON.stringify(over)}:${await codeOf(echo(over).client.read(read))}`).toBe(`${JSON.stringify(over)}:authority_denied`);
  }
  // A guest that says "stale_file" for itself is believed (it knows its own generation).
  const guest = rig(honest(bytes(10), OTHER_GENERATION));
  expect(await codeOf(guest.client.read(read))).toBe("stale_file");
});

test("crossed replies between concurrent calls are refused by request id, not delivered to the wrong caller", async () => {
  const pending: { frame: string; resolve: (reply: string) => void }[] = [];
  const guest = rig(frame => new Promise<string>(resolve => { pending.push({ frame, resolve }); }));
  const a = guest.client.readRange(range(0, 4)), b = guest.client.readRange(range(4, 4));
  await Promise.resolve(); await Promise.resolve();
  expect(pending.length).toBe(2);
  const file = bytes(10), replyA = honest(file)(pending[0]!.frame), replyB = honest(file)(pending[1]!.frame);
  pending[0]!.resolve(replyB); pending[1]!.resolve(replyA);
  expect(await codeOf(a)).toBe("file_unavailable"); expect(await codeOf(b)).toBe("file_unavailable");
  // In order they succeed.
  const ok = rig(honest(file)), both = await Promise.all([ok.client.readRange(range(0, 4)), ok.client.readRange(range(4, 4))]);
  expect([...both[0].content]).toEqual([...file.subarray(0, 4)]); expect([...both[1].content]).toEqual([...file.subarray(4, 8)]);
});

// ---------------------------------------------------------------- abort and transport failure

const settles = (promise: Promise<unknown>, ms = 1000) => Promise.race([codeOf(promise), new Promise<string>(resolve => setTimeout(() => resolve("hung"), ms))]);

test("an abort leaves no partial result: before the call, while it is pending, and after the reply was already in hand", async () => {
  const early = new AbortController(); early.abort();
  const before = rig(honest(bytes(5)));
  expect(await codeOf(before.client.stat(stat, { signal: early.signal }))).toBe("file_unavailable"); expect(before.frames.length).toBe(0); expect(before.authority.scopes.length).toBe(0);
  // Pending forever: the abort answers promptly and the transport is told through the same signal.
  const controller = new AbortController(), hung = rig(() => new Promise<string>(() => {}));
  const call = hung.client.read(read, { signal: controller.signal });
  await Promise.resolve(); controller.abort();
  expect(await settles(call)).toBe("file_unavailable"); expect(hung.signals[0]).toBe(controller.signal); expect(hung.signals[0]!.aborted).toBe(true);
  // The port aborts the signal, synchronously, from inside send() and still answers with perfectly valid bytes.
  const synchronous = new AbortController(), valid = rig(frame => { synchronous.abort(); return honest(Buffer.from(SECRET))(frame); });
  expect(await settles(valid.client.readRange(range(0, 4), { signal: synchronous.signal }))).toBe("file_unavailable");
  // Aborted asynchronously from inside send() before the valid reply resolves.
  const later = new AbortController(), slow = rig(async frame => { later.abort(); await Promise.resolve(); return honest(Buffer.from(SECRET))(frame); });
  expect(await settles(slow.client.readRange(range(0, 4), { signal: later.signal }))).toBe("file_unavailable");
  // An un-aborted signal changes nothing.
  const live = new AbortController(), fine = rig(honest(bytes(5)));
  expect((await fine.client.stat(stat, { signal: live.signal })).bytes).toBe(5); expect(fine.signals[0]).toBe(live.signal);
});

test("an abort that lands after the reply settled but before the call continues still leaves no result", async () => {
  // The abort listener is removed the moment the reply settles; this abort comes one microtask later, so only the check
  // made after the await can see it. The port is a bare thenable so no async wrapper adds hops between the two.
  const controller = new AbortController(), authority = new FakeAuthority();
  const port: CoworkGuestFileFramePort = { send: (frame: string) => ({ then(resolve: (value: string) => void) {
    resolve(honest(Buffer.from(SECRET))(frame)); queueMicrotask(() => controller.abort());
  } }) as never };
  const client = createCoworkGuestFileClient({ frames: port, authority, requestId: () => uuid(1) });
  expect(await settles(client.readRange(range(0, 4), { signal: controller.signal }))).toBe("file_unavailable");
  expect(controller.signal.aborted).toBe(true);
  // Without the abort the same port returns the bytes.
  const quiet = createCoworkGuestFileClient({ frames: { send: (frame: string) => ({ then(resolve: (value: string) => void) { resolve(honest(bytes(10))(frame)); } }) as never }, authority, requestId: () => uuid(1) });
  expect((await quiet.readRange(range(0, 4))).content.length).toBe(4);
});

test("deep nesting is refused before JSON.parse is ever asked to read the frame", () => {
  const request = chunkRequest(), spy = spyOn(JSON, "parse");
  try {
    expect(parseCode(`{"a":{"b":{"c":1}}}\n`, request)).toBe("file_unavailable");
    expect(parseCode(`{"a":[[1]]}\n`, request)).toBe("file_unavailable");
    expect(spy).not.toHaveBeenCalled();
    expect(parseCode(`{"a":1}\n`, request)).toBe("file_unavailable"); expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

test("a reply or failure that arrives after an abort is dropped without an unhandled rejection", async () => {
  const unhandled: unknown[] = [], record = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  try {
    const controller = new AbortController(), failing = rig(() => new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("late transport failure")), 10)));
    const call = failing.client.stat(stat, { signal: controller.signal }); await Promise.resolve(); controller.abort();
    expect(await settles(call)).toBe("file_unavailable");
    const replying = new AbortController(), reply = rig(frame => new Promise<string>(resolve => setTimeout(() => resolve(honest(bytes(5))(frame)), 10)));
    const second = reply.client.stat(stat, { signal: replying.signal }); await Promise.resolve(); replying.abort();
    expect(await settles(second)).toBe("file_unavailable");
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", record); }
});

test("transport failures carry no message; only read-failure codes pass through and a revoked scope still wins", async () => {
  const throwing = (error: unknown): Respond => () => { throw error; };
  expect(await codeOf(rig(throwing(new Error(`secret ${SECRET} /guest/private/key`))).client.stat(stat))).toBe("file_unavailable");
  const leaked = rig(throwing(new Error(SECRET)));
  let caught: unknown; try { await leaked.client.stat(stat); } catch (error) { caught = error; }
  expect((caught as CoworkError).message).toBe("file_unavailable"); expect(String(caught)).not.toContain(SECRET);
  for (const code of ["file_missing", "file_unavailable", "stale_file", "file_incomplete", "response_too_large"] as const) expect(await codeOf(rig(throwing(new CoworkError(code))).client.stat(stat))).toBe(code);
  for (const code of ["authority_denied", "invalid_request", "not_found", "revision_conflict"] as const) expect(await codeOf(rig(throwing(new CoworkError(code))).client.stat(stat))).toBe("file_unavailable");
  expect(await codeOf(rig(throwing(undefined)).client.stat(stat))).toBe("file_unavailable"); expect(await codeOf(rig(throwing("text")).client.stat(stat))).toBe("file_unavailable");
  expect(await codeOf(rig(() => Promise.reject(new Error("no"))).client.stat(stat))).toBe("file_unavailable");
  for (const reply of [undefined, null, 5, {}, Buffer.from(line(statFrame())), new Uint8Array(3)]) expect(await codeOf(rig(() => reply as never).client.stat(stat))).toBe("file_unavailable");
});

// ---------------------------------------------------------------- review follow-ups

const listeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
const sized = (...sizes: number[]) => sizes.map(size => "é".repeat(Math.floor(size / 2)) + (size % 2 ? "x" : "")).join("/");
const edge = (last: number) => [...Array(15).fill("x".repeat(255)), "x".repeat(100), "x".repeat(last)].join("/");

test("an authority answer that throws while it is read (a Proxy trap) is authority_denied, before and after the call", async () => {
  const hostile = (trap: string) => new Proxy({ incarnationId: INCARNATION, sourceRevision: REVISION }, { [trap]() { throw new Error(`${trap} trap`); } });
  for (const trap of ["get", "getOwnPropertyDescriptor"]) {
    const before = rig(honest(bytes(5)));
    before.authority.malformed = hostile(trap);
    expect(`${trap}:${await codeOf(before.client.stat(stat))}`).toBe(`${trap}:authority_denied`); expect(before.frames.length).toBe(0);
    // Fine when asked first, hostile when the reply arrives: the bytes are discarded as a denial.
    const after = rig(frame => { after.authority.malformed = hostile(trap); return honest(Buffer.from(SECRET))(frame); });
    let error: unknown; try { await after.client.read(read); } catch (caught) { error = caught; }
    expect(`${trap}:${(error as CoworkError | undefined)?.code}`).toBe(`${trap}:authority_denied`); expect(String(error)).not.toContain(SECRET);
  }
  // A getter on a plain answer that throws is the same denial, and so is a `then` getter that throws.
  for (const answer of [{ get incarnationId(): string { throw new Error("getter"); }, sourceRevision: REVISION }, { incarnationId: INCARNATION, get then(): never { throw new Error("then getter"); }, sourceRevision: REVISION }]) {
    const guest = rig(honest(bytes(5))); guest.authority.malformed = answer;
    expect(await codeOf(guest.client.stat(stat))).toBe("authority_denied");
  }
});

test("an asynchronous authority port is denied and its rejection never goes unhandled", async () => {
  const unhandled: unknown[] = [], record = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  try {
    const answers: Record<string, () => unknown> = {
      "async function that throws": async () => { throw new Error("db down"); },
      "a rejected promise": () => Promise.reject(new Error("db down")),
      "a thenable that rejects": () => ({ then(_resolve: unknown, reject: (reason: unknown) => void) { reject(new Error("db down")); } }),
      "a thenable whose then throws": () => ({ then() { throw new Error("then threw"); } }),
      "a promise that would have resolved to a valid answer": () => Promise.resolve({ incarnationId: INCARNATION, sourceRevision: REVISION }),
    };
    for (const [name, check] of Object.entries(answers)) {
      const sent: string[] = [];
      const before = createCoworkGuestFileClient({ frames: { send: async frame => { sent.push(frame); return honest(bytes(5))(frame); } }, authority: { check: check as never }, requestId: () => uuid(1) });
      expect(`${name}:${await codeOf(before.stat(stat))}`).toBe(`${name}:authority_denied`); expect(sent.length).toBe(0);
      // Asked fine first, asynchronous when the reply arrives.
      let asked = 0;
      const after = createCoworkGuestFileClient({ frames: { send: async frame => { sent.push(frame); return honest(Buffer.from(SECRET))(frame); } },
        authority: { check: () => (++asked === 1 ? { incarnationId: INCARNATION, sourceRevision: REVISION } : check() as never) }, requestId: () => uuid(1) });
      expect(`${name}:${await codeOf(after.stat(stat))}`).toBe(`${name}:authority_denied`); expect(sent.length).toBe(1);
    }
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", record); }
});

test("maxBytes: undefined is the default chunk size, exactly like an absent maxBytes; no other undefined field is accepted", async () => {
  const guest = rig(honest(bytes(10)));
  await guest.client.read({ ...read, maxBytes: undefined }); await guest.client.readRange({ ...range(2), maxBytes: undefined }); await guest.client.read(read); await guest.client.readRange(range(2));
  expect(guest.frames.map(frame => (JSON.parse(frame) as { maxBytes: number }).maxBytes)).toEqual([65536, 65536, 65536, 65536]);
  const before = guest.frames.length;
  expect(await codeOf(guest.client.readRange({ ...read, offset: undefined } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.read({ ...read, expectedGeneration: undefined } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat({ ...stat, sourceRevision: undefined } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.stat({ ...stat, relativePath: undefined } as never))).toBe("invalid_request");
  expect(await codeOf(guest.client.read({ ...read, maxBytes: null } as never))).toBe("invalid_request");
  const accessor = { ...read }; Object.defineProperty(accessor, "maxBytes", { enumerable: true, get: () => undefined });
  expect(await codeOf(guest.client.read(accessor as never))).toBe("invalid_request");
  expect(guest.frames.length).toBe(before);
});

test("the path boundary is exact: 4096 UTF-8 bytes are accepted, 4097 are refused, by bytes and not by characters", async () => {
  const ascii = edge(155), over = edge(156);
  expect(Buffer.byteLength(ascii)).toBe(4096); expect(ascii.length).toBe(4096); expect(parseCoworkGuestRelativePath(ascii)).toBe(ascii);
  expect(Buffer.byteLength(over)).toBe(4097); expect(codeSync(() => parseCoworkGuestRelativePath(over))).toBe("invalid_request");
  // Multibyte: the same byte totals in far fewer UTF-16 characters, so only the byte rule can tell them apart.
  const wide = sized(...Array(15).fill(255), 100, 155), wideOver = sized(...Array(15).fill(255), 100, 156);
  expect(Buffer.byteLength(wide)).toBe(4096); expect(wide.length).toBeLessThan(4096); expect(parseCoworkGuestRelativePath(wide)).toBe(wide);
  expect(Buffer.byteLength(wideOver)).toBe(4097); expect(wideOver.length).toBeLessThan(4096); expect(codeSync(() => parseCoworkGuestRelativePath(wideOver))).toBe("invalid_request");
  // 255 bytes per component is the same kind of edge.
  expect(parseCoworkGuestRelativePath(sized(255))).toBeTruthy(); expect(codeSync(() => parseCoworkGuestRelativePath(sized(256)))).toBe("invalid_request");
  // End to end, and through the request parser.
  const guest = rig(honest(bytes(5)));
  expect((await guest.client.stat({ ...stat, relativePath: ascii })).relativePath).toBe(ascii); expect((await guest.client.stat({ ...stat, relativePath: wide })).relativePath).toBe(wide);
  expect(await codeOf(guest.client.stat({ ...stat, relativePath: over }))).toBe("invalid_request"); expect(await codeOf(guest.client.stat({ ...stat, relativePath: wideOver }))).toBe("invalid_request");
  expect(guest.frames.length).toBe(2);
  expect(parseCoworkGuestFileRequest(guest.frames[0]!).relativePath).toBe(ascii);
  expect(codeSync(() => parseCoworkGuestFileRequest(guest.frames[0]!.replace(ascii, over)))).toBe("invalid_request");
});

test("the client leaves no abort listener on a long-lived signal: success, failure, guest error, revocation, garbage, abort", async () => {
  const controller = new AbortController(), signal = controller.signal, options = { signal };
  const ok = rig(honest(bytes(10)));
  for (let i = 0; i < 5; i++) await ok.client.stat(stat, options);
  expect(listeners(signal)).toBe(0);
  const failing = rig(() => { throw new Error("boom"); });
  for (let i = 0; i < 5; i++) expect(await codeOf(failing.client.stat(stat, options))).toBe("file_unavailable");
  expect(listeners(signal)).toBe(0);
  const failed = rig(() => Promise.reject(new Error("later")));
  expect(await codeOf(failed.client.stat(stat, options))).toBe("file_unavailable"); expect(listeners(signal)).toBe(0);
  const guestError = rig(frame => { const r = parseCoworkGuestFileRequest(frame); return line({ version: 1, requestId: r.requestId, op: r.op, ok: false, code: "file_missing" }); });
  expect(await codeOf(guestError.client.stat(stat, options))).toBe("file_missing"); expect(listeners(signal)).toBe(0);
  const revoked = rig(frame => { revoked.authority.revoked = true; return honest(bytes(5))(frame); });
  expect(await codeOf(revoked.client.stat(stat, options))).toBe("authority_denied"); expect(listeners(signal)).toBe(0);
  const garbage = rig(() => "garbage\n");
  expect(await codeOf(garbage.client.stat(stat, options))).toBe("file_unavailable"); expect(listeners(signal)).toBe(0);
  // Several in flight on one signal, then all settled.
  const gates: ((reply: string) => void)[] = [], concurrent = rig(frame => new Promise<string>(resolve => { gates.push(reply => resolve(reply)); void frame; }));
  const calls = [concurrent.client.stat(stat, options), concurrent.client.stat(stat, options), concurrent.client.stat(stat, options)];
  expect(listeners(signal)).toBe(3);
  gates.forEach((open, index) => open(honest(bytes(10))(concurrent.frames[index]!)));
  await Promise.all(calls); expect(listeners(signal)).toBe(0);
  // A pending reply that never settles: the abort itself removes its listener.
  const lc = new AbortController(), hung = rig(() => new Promise<string>(() => {}));
  const pending = hung.client.stat(stat, { signal: lc.signal });
  expect(listeners(lc.signal)).toBe(1); lc.abort(); expect(await codeOf(pending)).toBe("file_unavailable"); expect(listeners(lc.signal)).toBe(0);
  // Aborted before the call: nothing is ever registered.
  const early = new AbortController(); early.abort();
  expect(await codeOf(ok.client.stat(stat, { signal: early.signal }))).toBe("file_unavailable"); expect(listeners(early.signal)).toBe(0);
  expect(controller.signal.aborted).toBe(false);
});

test("abort wins over revocation, and a call has no deadline of its own: the caller passes AbortSignal.timeout", async () => {
  const controller = new AbortController(), guest = rig(frame => { guest.authority.revoked = true; controller.abort(); return honest(bytes(5))(frame); });
  expect(await codeOf(guest.client.stat(stat, { signal: controller.signal }))).toBe("file_unavailable");
  const revokedOnly = rig(frame => { revokedOnly.authority.revoked = true; return honest(bytes(5))(frame); });
  expect(await codeOf(revokedOnly.client.stat(stat))).toBe("authority_denied");
  // No signal: a reply that never comes is waited for indefinitely.
  const silent = rig(() => new Promise<string>(() => {}));
  expect(await settles(silent.client.stat(stat), 80)).toBe("hung");
  // With a deadline signal the same call ends, and leaves no listener behind.
  const deadline = AbortSignal.timeout(30);
  expect(await settles(silent.client.stat(stat, { signal: deadline }), 1000)).toBe("file_unavailable"); expect(listeners(deadline)).toBe(0);
});

test("the per-request base64 bound is decided from the length alone, separately from the global bound", () => {
  const small = chunkRequest("readRange", 0, 1024), allowed = 4 * Math.ceil(1024 / 3);
  expect(allowed).toBe(1368);
  const frame = (text: string) => line(chunkFrame({ bytes: 4096, offset: 0, nextOffset: 0, contentBase64: text }));
  expect(parseCode(frame("!".repeat(allowed + 1)), small)).toBe("response_too_large");
  expect(parseCode(frame("!".repeat(allowed + 4)), small)).toBe("response_too_large");
  expect(parseCode(frame("!".repeat(allowed)), small)).toBe("file_unavailable"); // within the bound, so it is only "not base64"
  // The same text is within the global bound, so a global-only check could not tell these apart.
  expect(allowed + 4).toBeLessThan(COWORK_GUEST_FILE_LIMITS.base64MaxChars);
  const max = chunkRequest("readRange", 0, COWORK_GUEST_FILE_LIMITS.chunkMaxBytes);
  expect(parseCode(frame("!".repeat(COWORK_GUEST_FILE_LIMITS.base64MaxChars + 1)), max)).toBe("response_too_large");
  expect(parseCode(frame("!".repeat(COWORK_GUEST_FILE_LIMITS.base64MaxChars)), max)).toBe("file_unavailable");
});

test("a frame must end in a newline: any other last character is refused, for requests and for responses", () => {
  const response = line(chunkFrame()).slice(0, -1), request = line({ version: 1, requestId: uuid(1), op: "stat", ...binding }).slice(0, -1);
  expect(response.endsWith("}")).toBe(true);
  expect(parseCode(`${response}\n`, chunkRequest())).toBe("returned"); expect(codeSync(() => parseCoworkGuestFileRequest(`${request}\n`))).toBe("returned");
  for (const tail of ["x", " ", "\r", " ", "\0", "}", "\\n", "\n\n"]) {
    expect(`${JSON.stringify(tail)}:${parseCode(`${response}${tail}`, chunkRequest())}`).toBe(`${JSON.stringify(tail)}:file_unavailable`);
    expect(`${JSON.stringify(tail)}:${codeSync(() => parseCoworkGuestFileRequest(`${request}${tail}`))}`).toBe(`${JSON.stringify(tail)}:invalid_request`);
  }
  // The terminator is not optional even where the text before it is complete JSON.
  expect(parseCode(response, chunkRequest())).toBe("file_unavailable"); expect(parseCode(`${response}x`, chunkRequest())).toBe("file_unavailable");
  expect(parseCode("\n", chunkRequest())).toBe("file_unavailable");
});

test("revisions are safe integers everywhere: a request, a reply echo and an authority answer past 2^53-1 are refused", async () => {
  const big = Number.MAX_SAFE_INTEGER + 1, top = Number.MAX_SAFE_INTEGER;
  const good = { version: 1, requestId: uuid(1), op: "stat", ...binding };
  expect(parseCoworkGuestFileRequest(line({ ...good, sourceRevision: top })).sourceRevision).toBe(top);
  expect(codeSync(() => parseCoworkGuestFileRequest(line({ ...good, sourceRevision: big })))).toBe("invalid_request");
  // A reply echoing a revision that is not a safe integer is unparseable; a safe one that differs is merely stale.
  expect(parseCode(line(chunkFrame({ sourceRevision: big })), chunkRequest())).toBe("file_unavailable");
  expect(parseCode(line(chunkFrame({ sourceRevision: top })), chunkRequest())).toBe("stale_file");
  // The authority's own answer.
  const guest = rig(honest(bytes(5)));
  guest.authority.malformed = { incarnationId: INCARNATION, sourceRevision: big };
  expect(await codeOf(guest.client.stat(stat))).toBe("authority_denied"); expect(guest.frames.length).toBe(0);
  guest.authority.malformed = { incarnationId: INCARNATION, sourceRevision: top };
  expect(await codeOf(guest.client.stat(stat))).toBe("stale_file");
  // The top of the range works end to end.
  const edgeGuest = rig(honest(bytes(5))); edgeGuest.authority.sourceRevision = top;
  expect((await edgeGuest.client.stat({ ...stat, sourceRevision: top })).sourceRevision).toBe(top);
  expect(await codeOf(edgeGuest.client.stat({ ...stat, sourceRevision: big }))).toBe("invalid_request");
});

// ---------------------------------------------------------------- drift and anti-wiring

test("drift guard: the frame definition equals the pinned literal", () => {
  // Pinned independently of the module. The guest side copies these values later and carries its own drift test; change both together.
  expect(COWORK_GUEST_FILE_CHANNEL_VERSION).toBe(1);
  expect([...COWORK_GUEST_FILE_OPERATIONS]).toEqual(["stat", "read", "readRange"]);
  expect([...COWORK_GUEST_FILE_ERROR_CODES]).toEqual(["file_missing", "file_unavailable", "stale_file", "file_incomplete", "response_too_large", "invalid_request"]);
  const binding6 = ["workspaceId", "sessionId", "locationId", "relativePath", "incarnationId", "sourceRevision"];
  expect(Object.fromEntries(Object.entries(COWORK_GUEST_FILE_REQUEST_KEYS).map(([key, value]) => [key, [...value]])) as Record<string, string[]>).toEqual({
    stat: ["version", "requestId", "op", ...binding6], read: ["version", "requestId", "op", ...binding6, "expectedGeneration", "maxBytes"],
    readRange: ["version", "requestId", "op", ...binding6, "expectedGeneration", "offset", "maxBytes"] });
  const head = ["version", "requestId", "op", "ok", ...binding6, "generation", "bytes", "kind"];
  expect(Object.fromEntries(Object.entries(COWORK_GUEST_FILE_RESPONSE_KEYS).map(([key, value]) => [key, [...value]])) as Record<string, string[]>).toEqual({
    error: ["version", "requestId", "op", "ok", "code"], stat: head, chunk: [...head, "offset", "nextOffset", "eof", "contentBase64", "encoding"] });
  expect({ ...COWORK_GUEST_FILE_LIMITS }).toEqual({ pathBytes: 4096, pathComponents: 32, componentBytes: 255, chunkMaxBytes: 262144, chunkDefaultBytes: 65536, base64MaxChars: 349528,
    requestFrameBytes: 16384, responseFrameBytes: 393216, frameDepth: 1 });
  for (const frozen of [COWORK_GUEST_FILE_OPERATIONS, COWORK_GUEST_FILE_ERROR_CODES, COWORK_GUEST_FILE_REQUEST_KEYS, COWORK_GUEST_FILE_REQUEST_KEYS.stat, COWORK_GUEST_FILE_REQUEST_KEYS.read, COWORK_GUEST_FILE_REQUEST_KEYS.readRange,
    COWORK_GUEST_FILE_RESPONSE_KEYS, COWORK_GUEST_FILE_RESPONSE_KEYS.error, COWORK_GUEST_FILE_RESPONSE_KEYS.stat, COWORK_GUEST_FILE_RESPONSE_KEYS.chunk, COWORK_GUEST_FILE_LIMITS]) expect(Object.isFrozen(frozen)).toBe(true);
  // The guest may only report codes that already exist, never authority_denied, and the module adds no code of its own.
  expect(COWORK_GUEST_FILE_ERROR_CODES).not.toContain("authority_denied");
  expect(Object.keys(channel).sort()).toEqual(["COWORK_GUEST_FILE_CHANNEL_VERSION", "COWORK_GUEST_FILE_ERROR_CODES", "COWORK_GUEST_FILE_LIMITS", "COWORK_GUEST_FILE_OPERATIONS", "COWORK_GUEST_FILE_REQUEST_KEYS",
    "COWORK_GUEST_FILE_RESPONSE_KEYS", "createCoworkGuestFileClient", "parseCoworkGuestFileRequest", "parseCoworkGuestFileResponse", "parseCoworkGuestRelativePath"]);
});

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("anti-wiring: no src file imports the channel, it has no barrel export, neither port has an implementation and it reaches no SDK or filesystem", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "guest-file-channel.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  // The transport (guest-file-port.ts) is the one module that may name the channel; its own test pins that nothing imports it.
  const port = join(packages, "core", "src", "cowork", "guest-file-port.ts");
  expect(readFileSync(port, "utf8")).toMatch(/from "\.\/guest-file-channel"/);
  for (const file of sources.filter(candidate => candidate !== module && candidate !== port)) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["guest-file-channel", "createCoworkGuestFileClient", "CoworkGuestFileFramePort", "CoworkGuestFileAuthorityPort", "parseCoworkGuestFileRequest", "parseCoworkGuestFileResponse",
      "parseCoworkGuestRelativePath", "COWORK_GUEST_FILE_", "CoworkGuestFileClient"])
      expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/guest-file-channel|from "\.\/cowork/);
  const own = readFileSync(module, "utf8");
  expect(own).not.toMatch(/implements\s+CoworkGuestFile(Frame|Authority)Port|:\s*CoworkGuestFile(Frame|Authority)Port\s*=\s*\{|class\s+\w+[^{]*CoworkGuestFile(Frame|Authority)Port|\bsend\s*\([^)]*\)\s*(:[^{\n]*)?\{|\bcheck\s*\([^)]*\)\s*(:[^{\n]*)?\{/);
  // The only import is the existing error type: no authority, repository, filesystem, process, protocol or SDK module.
  expect([...own.matchAll(/from "([^"]+)"/g)].map(match => match[1]!)).toEqual(["./types"]);
  for (const forbidden of ["@yanlinglabs", "node:", "require(", "import(", "Bun.", "process.", "homeIdentity", "readFileSync", "openat", "fetch("]) expect(`${forbidden}:${own.includes(forbidden)}`).toBe(`${forbidden}:false`);
  // No new error code: every code the module throws already exists.
  const types = readFileSync(join(packages, "core", "src", "cowork", "types.ts"), "utf8");
  for (const code of new Set([...own.matchAll(/CoworkError\("([a-z_]+)"/g)].map(match => match[1]!).concat([...own.matchAll(/"(file_[a-z_]+|authority_denied|invalid_request|stale_file|response_too_large)"/g)].map(match => match[1]!))))
    expect(`${code}:${types.includes(`"${code}"`)}`).toBe(`${code}:true`);
});
