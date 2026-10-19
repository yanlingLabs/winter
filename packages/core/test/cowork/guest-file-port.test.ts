import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { COWORK_GUEST_FILE_LIMITS, parseCoworkGuestFileRequest, type CoworkGuestFileAuthorityPort } from "../../src/cowork/guest-file-channel";
import * as portModule from "../../src/cowork/guest-file-port";
import { COWORK_GUEST_FILE_TRANSPORT_LIMITS, createCoworkGuestFileClientOverLink, createCoworkGuestFilePort, type CoworkGuestFileStreamLink } from "../../src/cowork/guest-file-port";
import { COWORK_NATIVE_LIMITS } from "../../src/cowork/native/protocol";
import { CoworkError } from "../../src/cowork/types";

const W = "workspace-one", S = "session-one", L = "location_00000000-0000-4000-8000-000000000001", INC = "incarnation-one", REV = 3, GEN = "a".repeat(64);
const scope = { workspaceId: W, sessionId: S, incarnationId: INC };
const binding = { workspaceId: W, sessionId: S, locationId: L, relativePath: "src/a.txt", incarnationId: INC, sourceRevision: REV };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const bytes = (length: number) => Uint8Array.from({ length }, (_v, i) => (i * 31 + 7) & 0xff);
const requestLine = (n: number, over: Record<string, unknown> = {}) => line({ version: 1, requestId: uuid(n), op: "stat", ...binding, ...over });
const quiet = <T>(promises: Promise<T> | Promise<T>[]) => { for (const p of Array.isArray(promises) ? promises : [promises]) p.catch(() => {}); };
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

async function codeOf(call: Promise<unknown>): Promise<string> {
  try { await call; } catch (error) { return error instanceof CoworkError ? error.code : `non-cowork:${String(error)}`; }
  return "resolved";
}
const settles = (promise: Promise<unknown>, ms = 1000) => Promise.race([codeOf(promise), new Promise<string>(resolve => setTimeout(() => resolve("hung"), ms))]);

/** An honest guest holding one file: the request line in, the reply line out. */
function honest(file: Uint8Array) {
  return (text: string): string => {
    const r = parseCoworkGuestFileRequest(text);
    const head = { version: 1, requestId: r.requestId, op: r.op, ok: true, workspaceId: r.workspaceId, sessionId: r.sessionId, locationId: r.locationId, relativePath: r.relativePath,
      incarnationId: r.incarnationId, sourceRevision: r.sourceRevision, generation: GEN, bytes: file.length, kind: "file" };
    if (r.op === "stat") return line(head);
    const offset = r.op === "readRange" ? r.offset : 0, slice = file.subarray(offset, Math.min(file.length, offset + r.maxBytes));
    return line({ ...head, offset, nextOffset: offset + slice.length, eof: offset + slice.length === file.length, contentBase64: Buffer.from(slice).toString("base64"), encoding: "base64" });
  };
}

/** The stream pair, in memory: what the host sends is recorded; the fake guest answers in the chunking the test picks. */
class FakeLink implements CoworkGuestFileStreamLink {
  sent: Buffer[] = [];
  handler: ((bytes: Uint8Array, end: boolean) => void) | null = null;
  unsubscribed = 0;
  failSend = false;
  constructor(private readonly guest: ((request: string) => string | undefined) | null = null, public chunk = Number.POSITIVE_INFINITY) {}
  async send(data: Uint8Array): Promise<void> {
    if (this.failSend) throw new Error("stream gone");
    const copy = Buffer.from(data); this.sent.push(copy);
    const reply = this.guest?.(copy.toString("utf8"));
    if (reply !== undefined) queueMicrotask(() => this.emitText(reply));
  }
  onData(handler: (bytes: Uint8Array, end: boolean) => void): () => void { this.handler = handler; return () => { this.handler = null; this.unsubscribed++; }; }
  emit(data: Uint8Array, end = false): void { this.handler?.(data, end); }
  emitText(text: string): void { const data = Buffer.from(text); for (let i = 0; i < data.length; i += this.chunk) this.emit(data.subarray(i, i + this.chunk)); }
}
const live = { incarnationId: INC as string | null, sourceRevision: REV, revoked: false };
const authority = (state = live): CoworkGuestFileAuthorityPort => ({ check: () => { if (state.revoked) throw new CoworkError("authority_denied"); return { incarnationId: state.incarnationId, sourceRevision: state.sourceRevision }; } });

// ---------------------------------------------------------------- the client over a link

test("a whole file crosses the link: stat then ranged reads, whatever the reply chunking", async () => {
  const file = bytes(600 * 1024);
  for (const chunk of [Number.POSITIVE_INFINITY, 65536, 4093, 7]) {
    const link = new FakeLink(honest(file), chunk), stack = createCoworkGuestFileClientOverLink({ link, scope, authority: authority({ ...live }) });
    const info = await stack.client.stat(binding), out = Buffer.alloc(info.bytes); let offset = 0, eof = false, calls = 0;
    while (!eof) {
      const part = await stack.client.readRange({ ...binding, expectedGeneration: info.generation, offset, maxBytes: 256 * 1024 });
      out.set(part.content, offset); offset = part.nextOffset; eof = part.eof; calls++;
    }
    expect(calls).toBe(3); expect([...out]).toEqual([...file]);
    stack.close();
  }
});

test("what leaves the host is exactly the client's request line, one send per request, never bigger than a chunk", async () => {
  const link = new FakeLink(honest(bytes(10))), stack = createCoworkGuestFileClientOverLink({ link, scope, authority: authority({ ...live }), requestId: (() => { let n = 0; return () => uuid(++n); })() });
  await stack.client.stat(binding); await stack.client.read({ ...binding, expectedGeneration: GEN }); await stack.client.readRange({ ...binding, expectedGeneration: GEN, offset: 2, maxBytes: 3 });
  expect(link.sent.length).toBe(3);
  for (const sent of link.sent) {
    const text = sent.toString("utf8");
    expect(text.endsWith("\n")).toBe(true); expect(text.indexOf("\n")).toBe(text.length - 1);
    expect(sent.length).toBeLessThanOrEqual(COWORK_GUEST_FILE_LIMITS.requestFrameBytes); expect(sent.length).toBeLessThanOrEqual(COWORK_GUEST_FILE_TRANSPORT_LIMITS.chunkBytes);
    expect(parseCoworkGuestFileRequest(text).workspaceId).toBe(W);
  }
  expect(link.sent.map(sent => parseCoworkGuestFileRequest(sent.toString("utf8")).op)).toEqual(["stat", "read", "readRange"]);
});

test("the authority sandwich still holds over the link: revoked in flight discards the reply, a stale incarnation too", async () => {
  const state = { ...live }, link = new FakeLink(text => { state.revoked = true; return honest(Buffer.from("SECRET"))(text); });
  const stack = createCoworkGuestFileClientOverLink({ link, scope, authority: authority(state) });
  expect(await codeOf(stack.client.stat(binding))).toBe("authority_denied");
  const second = { ...live }, other = new FakeLink(text => { second.incarnationId = "incarnation-two"; return honest(bytes(4))(text); });
  expect(await codeOf(createCoworkGuestFileClientOverLink({ link: other, scope, authority: authority(second) }).client.stat(binding))).toBe("stale_file");
  // A reply the guest bound to another incarnation never gets past the client's parser.
  const wrong = new FakeLink(text => honest(bytes(4))(text).replace(`"incarnationId":"${INC}"`, '"incarnationId":"incarnation-two"'));
  expect(await codeOf(createCoworkGuestFileClientOverLink({ link: wrong, scope, authority: authority({ ...live }) }).client.stat(binding))).toBe("stale_file");
});

test("an oversized reply closes the channel and the call answers response_too_large; the next call finds it closed", async () => {
  const link = new FakeLink(() => "x".repeat(COWORK_GUEST_FILE_LIMITS.responseFrameBytes + 1)), stack = createCoworkGuestFileClientOverLink({ link, scope, authority: authority({ ...live }) });
  expect(await codeOf(stack.client.stat(binding))).toBe("response_too_large");
  expect(await codeOf(stack.client.stat(binding))).toBe("file_unavailable"); expect(link.sent.length).toBe(1); expect(link.unsubscribed).toBe(1);
});

// ---------------------------------------------------------------- the port

test("the port speaks for one incarnation only: another workspace, session or incarnation sends nothing", async () => {
  const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), signal = new AbortController().signal;
  expect(await codeOf(port.send(requestLine(1, { workspaceId: "workspace-two" }), signal))).toBe("authority_denied");
  expect(await codeOf(port.send(requestLine(2, { sessionId: "session-two" }), signal))).toBe("authority_denied");
  expect(await codeOf(port.send(requestLine(3, { incarnationId: "incarnation-two" }), signal))).toBe("stale_file");
  for (const frame of ["", "garbage\n", requestLine(4).slice(0, -1), requestLine(4).replace('"op":"stat"', '"op":"list"')]) expect(await codeOf(port.send(frame, signal))).toBe("invalid_request");
  expect(await codeOf(port.send(requestLine(5), {} as never))).toBe("invalid_request");
  expect(link.sent.length).toBe(0);
  // A request id that is already outstanding is refused rather than shadowed.
  const first = port.send(requestLine(6), signal); await ticks();
  expect(await codeOf(port.send(requestLine(6), signal))).toBe("invalid_request"); expect(link.sent.length).toBe(1);
  quiet(first); port.close();
});

test("construction refuses a bad link or scope, and a link whose subscription is not an unsubscribe", () => {
  const link = new FakeLink();
  for (const deps of [undefined, null, {}, { link }, { scope }, { link: {}, scope }, { link: { send: 1, onData: 1 }, scope }, { link, scope: { workspaceId: W } }, { link, scope: { ...scope, incarnationId: 5 } }])
    expect((() => { try { createCoworkGuestFilePort(deps as never); return "built"; } catch (error) { return (error as CoworkError).code; } })()).toBe("invalid_request");
  expect((() => { try { createCoworkGuestFilePort({ link: { send: async () => {}, onData: () => 5 as never }, scope }); return "built"; } catch (error) { return (error as CoworkError).code; } })()).toBe("invalid_request");
});

test("at most maxInFlight requests are outstanding; replies in any order route to the right caller and free the next", async () => {
  const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), signal = new AbortController().signal, k = COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight;
  const guest = honest(bytes(5)), calls = Array.from({ length: k + 2 }, (_v, i) => port.send(requestLine(i + 1), signal));
  await ticks();
  expect(link.sent.length).toBe(k);
  // Answer the THIRD first: only its caller resolves, with its own reply, and one queued request goes out.
  link.emitText(guest(link.sent[2]!.toString("utf8")));
  expect(parseCoworkGuestFileRequest((await calls[2]!) && link.sent[2]!.toString("utf8")).requestId).toBe(uuid(3));
  await ticks(); expect(link.sent.length).toBe(k + 1);
  expect(await settles(calls[0]!, 30)).toBe("hung");
  for (let i = 0; i < link.sent.length; i++) if (i !== 2) link.emitText(guest(link.sent[i]!.toString("utf8")));
  await ticks(); expect(link.sent.length).toBe(k + 2);
  link.emitText(guest(link.sent[k + 1]!.toString("utf8")));
  const replies = await Promise.all(calls);
  replies.forEach((reply, index) => expect((JSON.parse(reply) as { requestId: string }).requestId).toBe(uuid(index + 1)));
  port.close();
});

test("two replies in one chunk, and a reply split mid character, are both delivered whole", async () => {
  const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), signal = new AbortController().signal;
  const a = port.send(requestLine(1), signal), b = port.send(requestLine(2, { relativePath: "déjà/vu.txt" }), signal); await ticks();
  const guest = honest(bytes(3)), ra = guest(link.sent[0]!.toString("utf8")), rb = guest(link.sent[1]!.toString("utf8"));
  const both = Buffer.from(rb + ra), accent = both.indexOf(Buffer.from("é"));
  link.emit(both.subarray(0, accent + 1)); link.emit(both.subarray(accent + 1));
  expect([await a, await b]).toEqual([ra, rb]);
  port.close();
});

test("an abort detaches the caller but keeps the slot until the guest answers; a late reply is not a fault", async () => {
  const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), k = COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight, guest = honest(bytes(2));
  // Pre-aborted: nothing is sent.
  const dead = new AbortController(); dead.abort();
  expect(await codeOf(port.send(requestLine(90), dead.signal))).toBe("file_unavailable"); expect(link.sent.length).toBe(0);
  // Fill every slot, abort them all.
  const controllers = Array.from({ length: k }, () => new AbortController()), aborted = controllers.map((c, i) => port.send(requestLine(i + 1), c.signal));
  await ticks(); expect(link.sent.length).toBe(k);
  controllers.forEach(c => c.abort());
  for (const call of aborted) expect(await codeOf(call)).toBe("file_unavailable");
  // The guest still owes k answers, so a new request WAITS (it is not sent) until one arrives.
  const next = port.send(requestLine(50), new AbortController().signal); await ticks();
  expect(link.sent.length).toBe(k);
  link.emitText(guest(link.sent[0]!.toString("utf8"))); // late reply for an aborted request: dropped, channel stays open
  await ticks(); expect(link.sent.length).toBe(k + 1);
  link.emitText(guest(link.sent[k]!.toString("utf8")));
  expect((JSON.parse(await next) as { requestId: string }).requestId).toBe(uuid(50));
  quiet(next); port.close();
});

test("a queued request that is aborted is never sent and gives up its place to the next one", async () => {
  const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), k = COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight, guest = honest(bytes(2));
  const full = Array.from({ length: k }, (_v, i) => port.send(requestLine(i + 1), new AbortController().signal)); quiet(full); await ticks();
  const abort = new AbortController(), queued = port.send(requestLine(10), abort.signal), follower = port.send(requestLine(11), new AbortController().signal); quiet(queued); quiet(follower); await ticks();
  expect(link.sent.length).toBe(k); abort.abort();
  expect(await codeOf(queued)).toBe("file_unavailable"); expect(link.sent.length).toBe(k);
  // Freeing a slot goes to the NEXT request, not to the aborted one.
  link.emitText(guest(link.sent[0]!.toString("utf8"))); await ticks();
  expect(link.sent.length).toBe(k + 1); expect(parseCoworkGuestFileRequest(link.sent[k]!.toString("utf8")).requestId).toBe(uuid(11));
  port.close();
});

test("the port leaves no abort listener on a long-lived signal", async () => {
  const link = new FakeLink(honest(bytes(3))), port = createCoworkGuestFilePort({ link, scope }), controller = new AbortController();
  for (let i = 1; i <= 6; i++) await port.send(requestLine(i), controller.signal);
  expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  // A request that WAITED for a slot, then got it and was answered, leaves nothing on its signal either.
  const gated = new FakeLink(), gate = createCoworkGuestFilePort({ link: gated, scope }), shared = new AbortController(), reply = honest(bytes(3));
  const first = Array.from({ length: COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight }, (_v, i) => gate.send(requestLine(300 + i), new AbortController().signal)), waiter = gate.send(requestLine(310), shared.signal);
  await ticks(); expect(getEventListeners(shared.signal, "abort").length).toBe(1);
  gated.emitText(reply(gated.sent[0]!.toString("utf8"))); await ticks();
  expect(gated.sent.length).toBe(COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight + 1);
  gated.emitText(reply(gated.sent[gated.sent.length - 1]!.toString("utf8"))); await waiter;
  expect(getEventListeners(shared.signal, "abort").length).toBe(0); quiet(first); gate.close();
  const queuedSignal = new AbortController(), full = Array.from({ length: COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight }, (_v, i) => port.send(requestLine(100 + i), new AbortController().signal));
  const link2 = new FakeLink(), port2 = createCoworkGuestFilePort({ link: link2, scope });
  const hold = Array.from({ length: COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight }, (_v, i) => port2.send(requestLine(200 + i), new AbortController().signal)), waiting = port2.send(requestLine(250), queuedSignal.signal);
  quiet(hold); quiet(waiting); quiet(full); await ticks(); expect(getEventListeners(queuedSignal.signal, "abort").length).toBe(1);
  port2.close(); expect(await codeOf(waiting)).toBe("file_unavailable"); expect(getEventListeners(queuedSignal.signal, "abort").length).toBe(0);
  quiet(full); quiet(hold); port.close();
});

test("the channel is fail closed: anything that cannot be attributed ends it, for every outstanding and later call", async () => {
  const bad: Record<string, () => Uint8Array> = {
    "garbage": () => Buffer.from("not json\n"),
    "json without a request id": () => Buffer.from(line({ version: 1 })),
    "a request id nobody sent": () => Buffer.from(line({ requestId: uuid(99) })),
    "an array": () => Buffer.from("[]\n"),
    "invalid UTF-8": () => Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]),
    // Valid JSON once a lenient decoder has replaced the stray byte: a fatal decoder must still refuse it.
    "a stray invalid byte inside otherwise valid JSON": () => Buffer.concat([Buffer.from(`{"requestId":"${uuid(1)}","x":"`), Buffer.from([0xff]), Buffer.from('"}\n')]),
    "a lone BOM before the frame": () => Buffer.from(`\ufeff{"requestId":"${uuid(99)}"}\n`),
    "a request id behind an accessor-looking key": () => Buffer.from('{"__proto__":{"requestId":"x"}}\n'),
  };
  for (const [name, make] of Object.entries(bad)) {
    const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), signal = new AbortController().signal;
    const a = port.send(requestLine(1), signal), b = port.send(requestLine(2), signal); await ticks();
    link.emit(make());
    expect(`${name}:${await codeOf(a)}:${await codeOf(b)}`).toBe(`${name}:file_unavailable:file_unavailable`);
    expect(await codeOf(port.send(requestLine(3), signal))).toBe("file_unavailable"); expect(link.sent.length).toBe(2); expect(link.unsubscribed).toBe(1);
  }
  // The stream ends, even in the middle of a line.
  for (const partial of [false, true]) {
    const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), call = port.send(requestLine(1), new AbortController().signal); await ticks();
    if (partial) link.emit(Buffer.from('{"requestId":')); link.emit(new Uint8Array(0), true);
    expect(await codeOf(call)).toBe("file_unavailable"); expect(link.unsubscribed).toBe(1);
  }
  // A failed send ends it too.
  const broken = new FakeLink(); broken.failSend = true;
  const port = createCoworkGuestFilePort({ link: broken, scope });
  expect(await codeOf(port.send(requestLine(1), new AbortController().signal))).toBe("file_unavailable");
  expect(await codeOf(port.send(requestLine(2), new AbortController().signal))).toBe("file_unavailable");
});

test("the reply bound is exact: a line of exactly the response frame bound is delivered, one byte more closes the channel", async () => {
  const bound = COWORK_GUEST_FILE_LIMITS.responseFrameBytes;
  const reply = (id: string, total: number) => { const head = `{"requestId":"${id}","pad":"`, tail = '"}\n'; return head + "x".repeat(total - head.length - tail.length) + tail; };
  for (const [total, expected] of [[bound, "resolved"], [bound + 1, "response_too_large"]] as const) {
    const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), call = port.send(requestLine(1), new AbortController().signal); await ticks();
    const text = reply(uuid(1), total), data = Buffer.from(text);
    for (let i = 0; i < data.length; i += 100_000) link.emit(data.subarray(i, i + 100_000));
    expect(`${total}:${await codeOf(call)}`).toBe(`${total}:${expected}`);
    if (expected === "resolved") expect((await call).length).toBe(bound);
  }
  // Bytes that never reach a newline are bounded too.
  const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), call = port.send(requestLine(1), new AbortController().signal); await ticks();
  for (let sent = 0; sent <= bound; sent += 65536) link.emit(Buffer.alloc(65536, 0x78));
  expect(await codeOf(call)).toBe("response_too_large");
});

test("a chunk the link reuses after handing it over cannot change a reply that is still being assembled", async () => {
  const link = new FakeLink(), port = createCoworkGuestFilePort({ link, scope }), call = port.send(requestLine(1), new AbortController().signal); await ticks();
  const reply = Buffer.from(honest(bytes(40))(link.sent[0]!.toString("utf8"))), half = reply.length >> 1, scratch = Buffer.from(reply.subarray(0, half));
  link.emit(scratch); scratch.fill(0x7a);
  link.emit(reply.subarray(half));
  expect(await call).toBe(reply.toString("utf8"));
});

test("a reply that arrives before send() resolves is still routed, and close() fails what is outstanding, once", async () => {
  const link = new FakeLink(), reply = honest(bytes(2));
  link.send = async (data: Uint8Array) => { link.sent.push(Buffer.from(data)); link.emitText(reply(Buffer.from(data).toString("utf8"))); };
  const port = createCoworkGuestFilePort({ link, scope });
  expect(JSON.parse(await port.send(requestLine(1), new AbortController().signal)).requestId).toBe(uuid(1));
  const quiet = new FakeLink(), other = createCoworkGuestFilePort({ link: quiet, scope }), pending = other.send(requestLine(1), new AbortController().signal); await ticks();
  other.close(); other.close();
  expect(await codeOf(pending)).toBe("file_unavailable"); expect(quiet.unsubscribed).toBe(1);
  expect(await codeOf(other.send(requestLine(2), new AbortController().signal))).toBe("file_unavailable");
});

// ---------------------------------------------------------------- pins

test("drift guard: the transport bounds equal their pinned literals and sit under the native runtime rules", () => {
  expect({ ...COWORK_GUEST_FILE_TRANSPORT_LIMITS }).toEqual({ maxInFlight: 4, chunkBytes: 262144 });
  expect(Object.isFrozen(COWORK_GUEST_FILE_TRANSPORT_LIMITS)).toBe(true);
  // Requests unanswered stay far below the guest relay's runtime IN in-flight rule, and a request and a reply each fit one runtime payload.
  expect(COWORK_GUEST_FILE_TRANSPORT_LIMITS.maxInFlight * COWORK_GUEST_FILE_LIMITS.requestFrameBytes).toBeLessThanOrEqual(COWORK_NATIVE_LIMITS.runtimeInFlightBytes / 8);
  expect(COWORK_GUEST_FILE_LIMITS.responseFrameBytes + COWORK_NATIVE_LIMITS.runtimePrefixBytes).toBeLessThanOrEqual(COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime);
  expect(COWORK_GUEST_FILE_TRANSPORT_LIMITS.chunkBytes).toBeLessThanOrEqual(COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime - COWORK_NATIVE_LIMITS.runtimePrefixBytes);
  // The guest resolves a location id by matching a delivered root id: the ids the repository mints satisfy both id rules.
  expect(L).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
  expect(Object.keys(portModule).sort()).toEqual(["COWORK_GUEST_FILE_TRANSPORT_LIMITS", "createCoworkGuestFileClientOverLink", "createCoworkGuestFilePort"]);
});

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("anti-wiring: nothing in src imports the port, the stream pair has no implementation, and it reaches no socket, NIC, vsock or provider class", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "guest-file-port.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  for (const file of sources.filter(candidate => candidate !== module)) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["guest-file-port", "createCoworkGuestFilePort", "createCoworkGuestFileClientOverLink", "CoworkGuestFileStreamLink", "CoworkGuestFilePort", "COWORK_GUEST_FILE_TRANSPORT_LIMITS"])
      expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  const own = readFileSync(module, "utf8");
  expect(own).not.toMatch(/implements\s+CoworkGuestFileStreamLink|:\s*CoworkGuestFileStreamLink\s*=\s*\{|class\s+\w+[^{]*CoworkGuestFileStreamLink/);
  expect([...own.matchAll(/from "([^"]+)"/g)].map(match => match[1]!)).toEqual(["./guest-file-channel", "./types"]);
  for (const forbidden of ["@yanlinglabs", "node:", "require(", "import(", "Bun.", "process.", "fetch(", "vsock", "dgram", "listen(", "connect(", "native/", "\"provider\"", "homeIdentity"]) expect(`${forbidden}:${own.includes(forbidden)}`).toBe(`${forbidden}:false`);
});
