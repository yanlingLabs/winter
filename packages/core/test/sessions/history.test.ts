import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { HISTORY_EVENT_TYPES, readHistoryPage } from "../../src/sessions/history";

describe("readHistoryPage", () => {
  let home: string | undefined;
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function boot(): { store: SessionStore; sessionId: string } {
    home = mkdtempSync(join(tmpdir(), "norma-history-"));
    store = new SessionStore(home);
    const sessionId = store.createSession("global");
    return { store, sessionId };
  }

  test("the allowlist is exactly the 8 persisted foldable types", () => {
    // Widening cast: HISTORY_EVENT_TYPES is a ReadonlySet<SessionEvent["type"]>, so the plain
    // string[] literal below (not a member of that narrower union type) would otherwise fail
    // toEqual's generic inference (bound to the `expect(...)` receiver's type) under tsc.
    expect([...HISTORY_EVENT_TYPES].sort() as string[]).toEqual(
      [
        "agent_error", "approval_requested", "approval_resolved", "assistant_message",
        "tool_call", "tool_result", "turn_completed", "user_message",
      ].sort(),
    );
    // Security: the opaque reasoning_item is NOT allowlisted.
    expect(HISTORY_EVENT_TYPES.has("reasoning_item" as SessionEvent["type"])).toBe(false);
  });

  test("filters out non-allowlisted events; returns ascending page with oldestSeq/hasMore", () => {
    const { store, sessionId } = boot();
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hi", clientName: "cli" }); // seq 2
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: "opaque" });           // seq 3 (excluded)
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "yo" });                // seq 4
    const page = readHistoryPage(store, { sessionId });
    // session_created (seq 1) is not allowlisted; reasoning_item (seq 3) is excluded by construction.
    expect(page.events.map((e) => e.type)).toEqual(["user_message", "assistant_message"]);
    expect(page.events.every((e) => e.type !== "reasoning_item")).toBe(true);
    expect(page.oldestSeq).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  test("SECURITY: reasoning_item never appears under any beforeSeq/limit", () => {
    const { store, sessionId } = boot();
    for (let i = 0; i < 20; i++) {
      store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: `secret-${i}` });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `msg-${i}` });
    }
    for (const beforeSeq of [undefined, 5, 10, 25, 1000]) {
      for (const limit of [1, 5, 200, 500]) {
        const page = readHistoryPage(store, { sessionId, beforeSeq, limit });
        expect(page.events.some((e) => e.type === "reasoning_item")).toBe(false);
      }
    }
  });

  test("beforeSeq is EXCLUSIVE; paging walks older", () => {
    const { store, sessionId } = boot();
    for (let i = 0; i < 5; i++) store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `m${i}` });
    // seqs: session_created=1, then 2..6
    const newest = readHistoryPage(store, { sessionId, limit: 2 });
    expect(newest.events.map((e) => e.seq)).toEqual([5, 6]);
    expect(newest.hasMore).toBe(true);
    const older = readHistoryPage(store, { sessionId, beforeSeq: newest.oldestSeq!, limit: 2 });
    expect(older.events.map((e) => e.seq)).toEqual([3, 4]); // 5 is excluded (EXCLUSIVE)
    expect(older.hasMore).toBe(true);
  });

  test("tool_result output over the cap is truncated with a deterministic marker", () => {
    const { store, sessionId } = boot();
    const big = "x".repeat(70 * 1024); // > 64 KiB
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "c1", name: "bash", argsJson: "{}" });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "main", callId: "c1", output: big, isError: false });
    const p1 = readHistoryPage(store, { sessionId });
    const p2 = readHistoryPage(store, { sessionId });
    const r1 = p1.events.find((e) => e.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>;
    const r2 = p2.events.find((e) => e.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>;
    expect(r1.output).toContain(`…[truncated by history: ${70 * 1024} bytes total]`);
    expect(Buffer.byteLength(r1.output, "utf8")).toBeLessThan(65 * 1024);
    expect(r1.output).toBe(r2.output); // deterministic: refetches are byte-identical
  });

  test("byte budget caps page assembly but always keeps the newest event", () => {
    const { store, sessionId } = boot();
    const chunk = "y".repeat(30 * 1024);
    for (let i = 0; i < 20; i++) store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: chunk });
    const page = readHistoryPage(store, { sessionId, limit: 500 }); // 20 * 30KiB ≫ 256 KiB
    const bytes = Buffer.byteLength(JSON.stringify(page.events), "utf8");
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + JSON.stringify(page.events[0]).length);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.length).toBeLessThan(20);
    expect(page.hasMore).toBe(true);
    // never exceeds the budget except for the single-newest floor:
    const lastSeq = page.events[page.events.length - 1]!.seq;
    const all = store.read(sessionId, 0);
    expect(lastSeq).toBe(all[all.length - 1]!.seq); // newest is always present
  });

  test("single event larger than the whole budget is still returned (newest floor)", () => {
    const { store, sessionId } = boot();
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "z".repeat(300 * 1024) });
    const page = readHistoryPage(store, { sessionId });
    expect(page.events.length).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  test("empty allowlisted history yields empty page", () => {
    const { store, sessionId } = boot(); // only session_created (not allowlisted) exists
    const page = readHistoryPage(store, { sessionId });
    expect(page.events).toEqual([]);
    expect(page.oldestSeq).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  test("unknown session propagates the store's Error (handler maps NOT_FOUND)", () => {
    const { store } = boot();
    expect(() => readHistoryPage(store, { sessionId: "s_does_not_exist" })).toThrow("unknown session");
  });
});
