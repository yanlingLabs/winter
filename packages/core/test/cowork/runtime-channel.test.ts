// Session door D3: the supervisor's channel over the native runtime class of one incarnation (bytes only).
import { expect, test } from "bun:test";
import { GUEST_RUNTIME_TRANSPORT_LIMITS, type GuestRuntimeLaunch } from "../../src/cowork/guest-runtime";
import { coworkGuestRuntimeChannel } from "../../src/cowork/runtime-channel";
import type { CoworkGuestRuntimeLink, CoworkGuestStopOutcome } from "../../src/cowork/session-ports";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const launch = { protocolVersion: 1, launchId: "launch-1", scope: { workspaceId: "w", incarnationId: "i", leaseEpoch: 1, configRevision: 1, grantRevision: 1, homeId: "h", bootId: "b", sessionId: "s", backendSessionId: "be", bindingRevision: 1, policyRevision: 1, instructionRevision: 1 } } as unknown as Readonly<GuestRuntimeLaunch>;

function link() {
  const ended = deferred<CoworkGuestStopOutcome>(), sent: { bytes: Uint8Array; end: boolean }[] = [];
  let handler: ((stream: "out" | "err", bytes: Uint8Array, end: boolean) => void) | undefined, unsubscribed = 0;
  const value: CoworkGuestRuntimeLink = {
    async send(bytes, end = false) { sent.push({ bytes: new Uint8Array(bytes), end }); },
    onData(h) { handler = h; return () => { unsubscribed++; handler = undefined; }; },
    ended: ended.promise,
  };
  return { value, ended, sent, emit: (stream: "out" | "err", bytes: Uint8Array, end = false) => handler!(stream, bytes, end), unsubscribed: () => unsubscribed, subscribed: () => handler !== undefined };
}
async function drain(stream: AsyncIterable<string>): Promise<string[]> { const out: string[] = []; for await (const chunk of stream) out.push(chunk); return out; }
const utf8 = (text: string) => new TextEncoder().encode(text);

test("OUT and ERR decode as UTF-8 streams: a character split across frames arrives whole, in order", async () => {
  const l = link(), stops: boolean[] = [], channel = coworkGuestRuntimeChannel({ link: l.value, launch, stop: force => stops.push(force) });
  const bytes = utf8("café \u{1F600}\n");
  l.emit("out", bytes.subarray(0, 4)); l.emit("out", bytes.subarray(4, 7)); l.emit("out", bytes.subarray(7), true);
  l.emit("err", utf8("warn\n"), true);
  expect((await drain(channel.stdout)).join("")).toBe("café \u{1F600}\n");
  expect((await drain(channel.stderr!)).join("")).toBe("warn\n");
  expect(await channel.runtimeExited).toEqual({ code: null, signal: null });
  expect(stops).toEqual([]);
  expect(l.subscribed()).toBe(false);
});

test("the runtime exits when OUT ends, before the incarnation's stop outcome is known; termination waits for that outcome", async () => {
  const l = link(), channel = coworkGuestRuntimeChannel({ link: l.value, launch, stop: () => {} });
  let terminated = false; void channel.termination.then(() => { terminated = true; });
  l.emit("out", utf8("x\n"), true);
  expect(await channel.runtimeExited).toEqual({ code: null, signal: null });
  await Bun.sleep(5); expect(terminated).toBe(false);
  l.ended.resolve({ released: true, evidence: "orderly-receipt" });
  expect(await channel.termination).toEqual({ scope: launch.scope, launchId: "launch-1", outcome: "confirmed-stopped", storeOwnerReleased: true });
});

test("only a released outcome is confirmed-stopped; unreleased and a failed outcome are uncertain and keep the store owner", async () => {
  for (const settle of [(l: ReturnType<typeof link>) => l.ended.resolve({ released: false, reason: "drain-timeout" }), (l: ReturnType<typeof link>) => l.ended.reject(new Error("lost"))]) {
    const l = link(), channel = coworkGuestRuntimeChannel({ link: l.value, launch, stop: () => {} });
    settle(l);
    expect(await channel.termination).toEqual({ scope: launch.scope, launchId: "launch-1", outcome: "uncertain", storeOwnerReleased: false });
    // The incarnation is over: unended streams end, and the runtime has exited.
    expect(await drain(channel.stdout)).toEqual([]);
    expect(await channel.runtimeExited).toEqual({ code: null, signal: null });
  }
});

test("IN is sent in pieces of at most chunkBytes, in order; endInput is the stream's end flag; stop reaches the native owner", async () => {
  const l = link(), stops: boolean[] = [], channel = coworkGuestRuntimeChannel({ link: l.value, launch, stop: force => stops.push(force) });
  const big = "a".repeat(GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes * 2 + 10);
  await Promise.all([channel.send(big), channel.send("tail\n")]);
  await channel.endInput();
  expect(l.sent.map(entry => [entry.bytes.length, entry.end])).toEqual([[GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes, false], [GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes, false], [10, false], [5, false], [0, true]]);
  expect(new TextDecoder().decode(l.sent[3]!.bytes)).toBe("tail\n");
  channel.stop(false); channel.stop(false); channel.stop(true);
  expect(stops).toEqual([false, true]);
  await expect(channel.send(1 as unknown as string)).rejects.toThrow("invalid_request");
});

test("a reader that falls behind past the bound fails closed: the stream throws and the incarnation is asked to stop", async () => {
  const l = link(), stops: boolean[] = [], channel = coworkGuestRuntimeChannel({ link: l.value, launch, stop: force => stops.push(force), bufferBytes: 1024 });
  l.emit("out", utf8("x".repeat(600))); l.emit("out", utf8("y".repeat(600)));
  expect(stops).toEqual([true]);
  await expect(drain(channel.stdout)).rejects.toThrow("response_too_large");
});

test("invalid UTF-8 fails closed, and a stream is consumed once", async () => {
  const l = link(), stops: boolean[] = [], channel = coworkGuestRuntimeChannel({ link: l.value, launch, stop: force => stops.push(force) });
  l.emit("out", new Uint8Array([0xff, 0x0a]));
  await expect(drain(channel.stdout)).rejects.toThrow("invalid_request");
  await expect(drain(channel.stdout)).rejects.toThrow("recovery_required");
  expect(() => coworkGuestRuntimeChannel({ link: {} as CoworkGuestRuntimeLink, launch, stop: () => {} })).toThrow("unsupported_topology");
});

test("a decoded piece never exceeds chunkBytes, even when a held partial character is prepended", async () => {
  const l = link(), channel = coworkGuestRuntimeChannel({ link: l.value, launch, stop: () => {} });
  const emoji = utf8("\u{1F600}");
  l.emit("out", emoji.subarray(0, 3));
  l.emit("out", new Uint8Array([...emoji.subarray(3), ...utf8("z".repeat(GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes - 1))]), true);
  const pieces = await drain(channel.stdout);
  expect(pieces.every(piece => Buffer.byteLength(piece) <= GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes)).toBe(true);
  expect(pieces.join("")).toBe(`\u{1F600}${"z".repeat(GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes - 1)}`);
});
