import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";

describe("SessionHub.addObserver", () => {
  test("observer sees appended events across sessions; unsubscribe stops delivery; no events appended by observing", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "winter-test-")));
    const hub = new SessionHub(store);
    const a = store.createSession("global", {});
    const seen: string[] = [];
    const off = hub.addObserver((e) => seen.push(`${e.sessionId}:${e.type}`));
    const before = store.lastSeq(a);
    hub.append(a, { type: "user_message", sessionId: a, threadId: "main", text: "hi", clientName: "t" });
    expect(seen).toContain(`${a}:user_message`);
    expect(store.lastSeq(a)).toBe(before + 1); // observing appended nothing extra
    off();
    hub.append(a, { type: "user_message", sessionId: a, threadId: "main", text: "again", clientName: "t" });
    expect(seen.filter((s) => s.endsWith("user_message")).length).toBe(1);
  });
});
