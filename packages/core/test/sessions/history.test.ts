import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { HISTORY_EVENT_TYPES, readHistoryPage, capEventForTest, WHOLE_EVENT_CEILING } from "../../src/sessions/history";

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

  test("the allowlist is exactly the 10 persisted foldable types", () => {
    // Widening cast: HISTORY_EVENT_TYPES is a ReadonlySet<SessionEvent["type"]>, so the plain
    // string[] literal below (not a member of that narrower union type) would otherwise fail
    // toEqual's generic inference (bound to the `expect(...)` receiver's type) under tsc.
    expect([...HISTORY_EVENT_TYPES].sort() as string[]).toEqual(
      [
        "agent_error", "approval_requested", "approval_resolved", "assistant_message",
        "question_asked", "question_resolved", "tool_call", "tool_result", "turn_completed", "user_message",
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

  test("multibyte cap: UTF-8 back-off never splits a character (mid-character boundary)", () => {
    const { store, sessionId } = boot();
    const emoji = "\u{1F600}"; // 😀 — a 4-byte UTF-8 scalar (U+10000 and above always encode to 4 bytes)
    // A leading single ASCII byte shifts every emoji's byte offset by 1, so the default 64 KiB
    // (65536-byte, an exact multiple of 4) cap lands ONE byte INTO a character instead of neatly on
    // a boundary — forcing the back-off loop to actually back off rather than trivially no-op.
    const big = "a" + emoji.repeat(20 * 1024); // 1 + 80*1024 bytes ≫ 64 KiB
    const totalBytes = Buffer.byteLength(big, "utf8");
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "c1", name: "bash", argsJson: "{}" });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "main", callId: "c1", output: big, isError: false });
    const p1 = readHistoryPage(store, { sessionId });
    const p2 = readHistoryPage(store, { sessionId });
    const r1 = p1.events.find((e) => e.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>;
    const r2 = p2.events.find((e) => e.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>;
    const marker = `\n…[truncated by history: ${totalBytes} bytes total]`;
    expect(r1.output.endsWith(marker)).toBe(true);
    const head = r1.output.slice(0, r1.output.length - marker.length);
    // No replacement character — the back-off never leaves a partial multi-byte sequence dangling.
    expect(head).not.toContain("�");
    // Lossless round-trip: re-encoding the head to UTF-8 bytes and decoding it back reproduces it
    // exactly — the byte-level confirmation that the cut landed exactly on a character boundary
    // (a mid-character cut would corrupt this round-trip, not just risk a stray replacement char).
    expect(Buffer.from(head, "utf8").toString("utf8")).toBe(head);
    expect(r1.output).toBe(r2.output); // deterministic: refetches are byte-identical
  });

  test("user_message.text over the cap is truncated (generalized cap, not just tool_result)", () => {
    const { store, sessionId } = boot();
    const big = "m".repeat(2 * 1024 * 1024); // > 1 MiB paste
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: big, clientName: "cli" });
    const p1 = readHistoryPage(store, { sessionId });
    const p2 = readHistoryPage(store, { sessionId });
    const m1 = p1.events.find((e) => e.type === "user_message") as Extract<SessionEvent, { type: "user_message" }>;
    const m2 = p2.events.find((e) => e.type === "user_message") as Extract<SessionEvent, { type: "user_message" }>;
    expect(m1.text).toContain(`…[truncated by history: ${2 * 1024 * 1024} bytes total]`);
    expect(Buffer.byteLength(JSON.stringify(m1), "utf8")).toBeLessThan(256 * 1024);
    expect(m1.text).toBe(m2.text); // deterministic: refetches are byte-identical
  });

  test("tool_call.argsJson over the cap is truncated", () => {
    const { store, sessionId } = boot();
    const bigArgs = JSON.stringify({ blob: "q".repeat(70 * 1024) }); // > 64 KiB
    const bigArgsBytes = Buffer.byteLength(bigArgs, "utf8");
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "c1", name: "write", argsJson: bigArgs });
    const p1 = readHistoryPage(store, { sessionId });
    const p2 = readHistoryPage(store, { sessionId });
    const c1 = p1.events.find((e) => e.type === "tool_call") as Extract<SessionEvent, { type: "tool_call" }>;
    const c2 = p2.events.find((e) => e.type === "tool_call") as Extract<SessionEvent, { type: "tool_call" }>;
    expect(c1.argsJson).toContain(`…[truncated by history: ${bigArgsBytes} bytes total]`);
    expect(Buffer.byteLength(c1.argsJson, "utf8")).toBeLessThan(65 * 1024);
    expect(c1.argsJson).toBe(c2.argsJson); // deterministic: refetches are byte-identical
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

  test("DEEP CAP: a giant NESTED string (question option description) is truncated with the marker", () => {
    const { store, sessionId } = boot();
    const big = "q".repeat(70 * 1024); // > 64 KiB, nested two levels down
    store.append(sessionId, {
      type: "question_asked", sessionId, threadId: "main", callId: "q1",
      questions: [{
        question: "Pick one", header: "Choice", multiSelect: false,
        options: [{ label: "A", description: big }, { label: "B" }],
      }],
    });
    const p1 = readHistoryPage(store, { sessionId });
    const p2 = readHistoryPage(store, { sessionId });
    const q1 = p1.events.find((e) => e.type === "question_asked") as any;
    const desc = q1.questions[0].options[0].description as string;
    expect(desc).toContain(`…[truncated by history: ${70 * 1024} bytes total]`);
    expect(Buffer.byteLength(desc, "utf8")).toBeLessThan(65 * 1024);
    expect(q1.questions[0].options[1].label).toBe("B"); // small nested strings untouched
    expect(JSON.stringify(p1.events)).toBe(JSON.stringify(p2.events)); // deep determinism
  });

  test("DEEP CAP: no-op events keep the same reference shape (no gratuitous copies)", () => {
    const { store, sessionId } = boot();
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "small", clientName: "cli" });
    const page = readHistoryPage(store, { sessionId });
    // Behavioral proxy for the same-reference no-op: the event round-trips byte-identically.
    expect(page.events[0]!.type).toBe("user_message");
    expect((page.events[0] as any).text).toBe("small");
  });

  test("question events appear in pages, ascending, resolved carries answers/by", () => {
    const { store, sessionId } = boot();
    store.append(sessionId, {
      type: "question_asked", sessionId, threadId: "main", callId: "q1",
      questions: [{ question: "Deploy?", header: "Deploy", multiSelect: false,
        options: [{ label: "Yes" }, { label: "No" }] }],
    });
    store.append(sessionId, {
      type: "question_resolved", sessionId, threadId: "main", callId: "q1",
      answers: { "Deploy?": "Yes" }, by: "cli",
    });
    const page = readHistoryPage(store, { sessionId });
    expect(page.events.map((e) => e.type)).toEqual(["question_asked", "question_resolved"]);
    const resolved = page.events[1] as any;
    expect(resolved.answers["Deploy?"]).toBe("Yes");
    expect(resolved.by).toBe("cli");
  });

  test("DEEP CAP (unit): capEventForTest walks arrays and objects at any depth", () => {
    const big = "z".repeat(70 * 1024);
    const event = {
      type: "question_asked", sessionId: "s", threadId: "main", callId: "q", seq: 1, ts: 1,
      questions: [{
        question: "Q", header: "H", multiSelect: false,
        options: [{ label: "A", description: big }, { label: "B" }],
      }],
    } as any;
    const capped = capEventForTest(event, 64 * 1024) as any;
    expect(capped.questions[0].options[0].description).toContain("…[truncated by history:");
    expect(capped).not.toBe(event); // copy on change
    // Sibling untouched by the change elsewhere in the spine keeps its original reference.
    expect(capped.questions[0].options[1]).toBe(event.questions[0].options[1]);
    const small = { type: "user_message", sessionId: "s", threadId: "main", text: "ok", seq: 2, ts: 1 } as any;
    expect(capEventForTest(small, 64 * 1024)).toBe(small); // SAME reference on no-op
  });

  test("WHOLE-EVENT CEILING: a question_asked with many large options serializes under the ceiling, structure intact, deterministic", () => {
    const { store, sessionId } = boot();
    // 4 questions x 4 options, each description > 64 KiB — every description survives the
    // per-string pass at ~70 KiB (under outputCap would shrink it, but here it's already over),
    // so the aggregate is ~16 x 70 KiB (well over a MiB) before the whole-event ceiling kicks in.
    const big = "d".repeat(70 * 1024);
    const questions = Array.from({ length: 4 }, (_, qi) => ({
      question: `Question number ${qi}`, header: `Q${qi}`, multiSelect: false,
      options: Array.from({ length: 4 }, (_, oi) => ({ label: `opt${qi}-${oi}`, description: big })),
    }));
    store.append(sessionId, { type: "question_asked", sessionId, threadId: "main", callId: "q1", questions });
    const p1 = readHistoryPage(store, { sessionId });
    const p2 = readHistoryPage(store, { sessionId });
    const q1 = p1.events.find((e) => e.type === "question_asked") as any;
    // Aggregate is bounded under the ceiling (and far under the phone transport's 1 MiB hard
    // frame limit) even though 16 independently-64KiB-capped descriptions would otherwise total
    // several MiB and ride the newest-event floor straight past the page byte budget.
    expect(Buffer.byteLength(JSON.stringify(q1), "utf8")).toBeLessThan(WHOLE_EVENT_CEILING);
    // Structure intact: all 4 questions and all 4 options per question survive — strings
    // shortened, not dropped.
    expect(q1.questions.length).toBe(4);
    for (const q of q1.questions) {
      expect(q.options.length).toBe(4);
      for (const o of q.options) {
        expect(typeof o.description).toBe("string");
        expect(o.description.length).toBeGreaterThan(0);
      }
    }
    // Page determinism: two reads of the same page are byte-identical.
    expect(JSON.stringify(p1.events)).toBe(JSON.stringify(p2.events));
  });
});
