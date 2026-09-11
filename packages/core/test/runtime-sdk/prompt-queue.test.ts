import { test, expect } from "bun:test";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";

test("push before iterate: items are buffered and drained in order", async () => {
  const q = createHostPromptQueue();
  q.push("one");
  q.push("two");
  expect(q.pending).toBe(2);

  const it = q[Symbol.asyncIterator]();
  expect(await it.next()).toEqual({ value: "one", done: false });
  expect(await it.next()).toEqual({ value: "two", done: false });
  expect(q.pending).toBe(0);
});

test("iterate before push: a parked next() resolves on the push", async () => {
  const q = createHostPromptQueue();
  const it = q[Symbol.asyncIterator]();
  const parked = it.next();
  // `pending` counts ITEMS, never parked readers — a reader waiting is not a message waiting.
  expect(q.pending).toBe(0);

  q.push("late");
  expect(await parked).toEqual({ value: "late", done: false });
  expect(q.pending).toBe(0);   // handed straight to the reader, never through the buffer
});

test("close with pending items drains them, THEN ends", async () => {
  const q = createHostPromptQueue();
  q.push("a");
  q.push("b");
  q.close();
  expect(q.closed).toBe(true);
  expect(q.pending).toBe(2);

  const seen: string[] = [];
  for await (const t of q) seen.push(t);
  expect(seen).toEqual(["a", "b"]);
});

test("close ends a parked reader immediately", async () => {
  const q = createHostPromptQueue();
  const it = q[Symbol.asyncIterator]();
  const parked = it.next();
  q.close();
  expect(await parked).toEqual({ value: undefined, done: true });
});

test("push after close throws — a message nobody will read is a caller bug", () => {
  const q = createHostPromptQueue();
  q.close();
  expect(() => q.push("x")).toThrow("prompt queue closed");
});

test("close is idempotent", () => {
  const q = createHostPromptQueue();
  q.close();
  expect(() => q.close()).not.toThrow();
  expect(q.closed).toBe(true);
});

test("for await sees items in order across pushes interleaved with reads", async () => {
  const q = createHostPromptQueue();
  const seen: string[] = [];
  const consumer = (async () => { for await (const t of q) seen.push(t); })();

  q.push("1");
  await Promise.resolve();
  q.push("2");
  await Promise.resolve();
  q.push("3");
  q.close();
  await consumer;
  expect(seen).toEqual(["1", "2", "3"]);
});

test("two concurrent next() calls are served in the order they asked", async () => {
  const q = createHostPromptQueue();
  const it = q[Symbol.asyncIterator]();
  const first = it.next();
  const second = it.next();

  q.push("alpha");
  q.push("beta");
  expect(await first).toEqual({ value: "alpha", done: false });
  expect(await second).toEqual({ value: "beta", done: false });
});

test("the consumer walking away closes the queue (surface map §2.5 way 2)", async () => {
  const q = createHostPromptQueue();
  q.push("only");
  for await (const _t of q) break;   // an explicit break calls the iterator's return()
  expect(q.closed).toBe(true);
  // Without this, a session whose iteration ended would keep accepting pushes into a buffer nothing
  // will ever read — a "message delivered" that was silently dropped.
  expect(() => q.push("after")).toThrow("prompt queue closed");
});
