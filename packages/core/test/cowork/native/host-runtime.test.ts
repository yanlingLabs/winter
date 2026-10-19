import { afterEach, describe, expect, test } from "bun:test";
import { CoworkNativeHostError, type CoworkNativeConversationContext } from "../../../src/cowork/native/host";
import { guidedConversation, toolsOnlySet } from "./conversation-fixtures";
import { cleanupHarnesses, createHarness, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });

// N2 S7B part 1 (DOOR's host needs): the runtime class is no longer dropped, and the caller supplies the conversation set.
const bytesOf = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 5));
async function started(h: Harness = createHarness()) {
  const running = await h.host.start(h.workspaceId);
  return { h, running, link: running.runtime(0), session: h.launcher.last };
}

describe("guest to host: OUT and ERR bytes reach every handler, in order, none dropped", () => {
  test("frames arrive in order with their stream and end flag, to several handlers, and an unsubscribe stops one", async () => {
    const { link, session, h } = await started();
    const first: string[] = [], second: string[] = [];
    link.onData((stream, bytes, end) => first.push(`${stream}:${text(bytes)}:${end}`));
    const off = link.onData((stream, bytes, end) => second.push(`${stream}:${text(bytes)}:${end}`));
    session.emitRuntime("out", bytesOf("a")); session.emitRuntime("err", bytesOf("b")); session.emitRuntime("out", bytesOf("c"), true);
    await settle();
    expect(first).toEqual(["out:a:false", "err:b:false", "out:c:true"]);
    expect(second).toEqual(first);
    off();
    session.emitRuntime("err", bytesOf("d"), true);
    await settle();
    expect(first.at(-1)).toBe("err:d:true"); expect(second).toHaveLength(3);
    expect(h.host.runtimeViolations(h.workspaceId)).toBe(0);
  });
  test("a thousand frames after the sealed filter took over are all delivered", async () => {
    const { link, session } = await started();
    let received = 0;
    link.onData(() => { received += 1; });
    for (let i = 0; i < 1000; i++) session.emitRuntime("out", new Uint8Array([i & 255]));
    await settle();
    expect(received).toBe(1000);
  });
  test("a handler that throws does not stop the others or the host", async () => {
    const { link, session } = await started();
    const seen: string[] = [];
    link.onData(() => { throw new Error("consumer fault"); });
    link.onData((_s, bytes) => seen.push(text(bytes)));
    session.emitRuntime("out", bytesOf("x")); session.emitRuntime("out", bytesOf("y"));
    await settle();
    expect(seen).toEqual(["x", "y"]);
  });
  test("a guest that breaks the contract is dropped and counted, never delivered: a repeated sequence number, a gap, a frame after the end (an IN frame from the guest cannot even be parsed: bad_direction)", async () => {
    const { link, session, h } = await started();
    const seen: string[] = [];
    link.onData((_s, bytes) => seen.push(text(bytes)));
    session.emitRuntime("out", bytesOf("ok"));
    session.emitRuntimeFrame({ class: "runtime", seq: 1, conversation: 0, stream: "out", end: false, payload: bytesOf("replay") });
    session.emitRuntimeFrame({ class: "runtime", seq: 9, conversation: 0, stream: "out", end: false, payload: bytesOf("gap") });
    session.emitRuntime("err", bytesOf("fin"), true);
    session.emitRuntime("err", bytesOf("after-end"));
    await settle();
    expect(seen.slice(0, 1)).toEqual(["ok"]);
    expect(seen).not.toContain("replay"); expect(seen).not.toContain("gap"); expect(seen).not.toContain("after-end");
    expect(h.host.runtimeViolations(h.workspaceId)).toBe(3);
  });
});

describe("host to guest: IN bytes are framed, chunked and flow-controlled", () => {
  test("a send becomes runtime IN frames numbered from 1, at most 256 KiB each, the end flag on the last only", async () => {
    const { link, session } = await started();
    await link.send(new Uint8Array(600 * 1024).fill(7));
    await link.send(bytesOf("tail"), true);
    const frames = session.runtimeIn;
    expect(frames.map(frame => frame.seq)).toEqual([1, 2, 3, 4]);
    expect(frames.map(frame => frame.payload.length)).toEqual([256 * 1024, 256 * 1024, 88 * 1024, 4]);
    expect(frames.every(frame => frame.stream === "in" && frame.conversation === 0)).toBe(true);
    expect(frames.map(frame => frame.end)).toEqual([false, false, false, true]);
    await expect(link.send(bytesOf("more"))).rejects.toBeDefined(); // the IN stream ended
  });
  test("an empty send does nothing, an empty send with end closes the stream with one empty frame", async () => {
    const { link, session } = await started();
    await link.send(new Uint8Array(0));
    expect(session.runtimeIn).toHaveLength(0);
    await link.send(new Uint8Array(0), true);
    expect(session.runtimeIn.map(frame => [frame.payload.length, frame.end])).toEqual([[0, true]]);
  });
  test("the frame carries a copy of the bytes: changing the caller's buffer afterwards changes nothing", async () => {
    const { link, session } = await started();
    const buffer = bytesOf("abc");
    await link.send(buffer);
    buffer.fill(0);
    expect(text(session.runtimeIn[0]!.payload)).toBe("abc");
  });
  test("a sender waits once 1 MiB is unanswered and resumes when the guest reads (an OUT frame with payload)", async () => {
    const { link, session } = await started();
    await link.send(new Uint8Array(1_048_576));
    let released = false;
    const waiting = link.send(bytesOf("blocked")).then(() => { released = true; });
    await settle();
    expect(released).toBe(false);
    expect(session.runtimeIn).toHaveLength(4);
    session.emitRuntime("err", new Uint8Array(0), true); // an empty frame (the end flag alone) does not show the guest is reading
    await settle();
    expect(released).toBe(false);
    session.emitRuntime("out", bytesOf("r"));
    await waiting;
    expect(released).toBe(true);
    expect(text(session.runtimeIn.at(-1)!.payload)).toBe("blocked");
  });
  test("a guest that never reads fails the sender with timeout after the stall bound, and frees its waiter", async () => {
    const h = createHarness({ timeouts: { runtimeStallMs: 60 } });
    const { link } = await started(h);
    await link.send(new Uint8Array(1_048_576));
    await expect(link.send(bytesOf("x"))).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("the caller supplies the conversation set", () => {
  test("a request's set wins over deps.conversations and receives the bound context, including the guest boot id", async () => {
    const h = createHarness();
    const contexts: CoworkNativeConversationContext[] = [];
    const running = await h.host.start(h.workspaceId, { conversations: context => { contexts.push(context); return { profile: "host-query-guided-v1", conversations: [guidedConversation(context, "conv-caller", "backend-caller", 1000)] }; } });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ workspaceId: h.workspaceId, incarnationId: running.incarnationId, leaseEpoch: 1, guestBootId: running.guestBootId });
    expect(running.guestBootId).not.toBe("");
    expect(h.launcher.last.conversationSets).toHaveLength(1);
    expect(JSON.stringify(h.launcher.last.conversationSets[0]!.conversations)).toContain("conv-caller");
  });
  test("a request that returns null sends no set and the start still works, without a runtime link", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId, { conversations: () => null });
    expect(h.launcher.last.conversationSets).toHaveLength(0);
    expect(() => running.runtime(0)).toThrow(CoworkNativeHostError);
  });
  test("a tools-only set (no profile) also has no runtime link", async () => {
    const h = createHarness({ conversations: toolsOnlySet });
    const running = await h.host.start(h.workspaceId);
    expect(() => running.runtime(0)).toThrow(CoworkNativeHostError);
  });
  test("without a request the host still uses deps.conversations", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    expect(h.launcher.last.conversationSets).toHaveLength(1);
    expect(running.runtime(0)).toBeDefined();
  });
});

describe("ended settles however the incarnation ends", () => {
  test("an orderly stop releases and resolves ended with the same outcome; a later send is refused", async () => {
    const { running, link, h } = await started();
    const outcome = await running.stop("user");
    expect(outcome).toEqual({ released: true, evidence: "orderly-receipt" });
    expect(await link.ended).toEqual(outcome);
    expect(await running.ended).toEqual(outcome);
    await expect(link.send(bytesOf("late"))).rejects.toMatchObject({ code: "closed" });
    expect(h.host.activeWorkspaces()).toEqual([]);
  });
  test("a channel that ends under a running guest resolves ended as NOT released (ownership stays) and wakes a blocked sender", async () => {
    const { running, link, session } = await started();
    await link.send(new Uint8Array(1_048_576));
    const blocked = link.send(bytesOf("x")).then(() => "sent", (error: CoworkNativeHostError) => error.code);
    await settle();
    session.eof();
    expect(await blocked).toBe("closed");
    const outcome = await running.ended;
    expect(outcome.released).toBe(false);
  });
  test("a stop that is not orderly resolves ended as not released", async () => {
    const h = createHarness({ behavior: { stop: "uncertain" } });
    const { running } = await started(h);
    const outcome = await running.stop("user");
    expect(outcome.released).toBe(false);
    expect(await running.ended).toEqual(outcome);
  });
});
