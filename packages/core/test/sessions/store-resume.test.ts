import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";

// Documents resume-after-restart at the storage layer: a normal daemon restart (index.db
// and logs survive on disk, nothing deleted) must still list the session with its cwd intact
// and replay its events — this is what `winter resume` relies on to reattach after a kill/restart.
describe("resume after restart (storage)", () => {
  test("a fresh store on the same home preserves cwd + events", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-resume-")));
    const s1 = new SessionStore(home);
    const sid = s1.createSession("global", { cwd: "/tmp/proj", approvalPolicy: "auto" });
    s1.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "codename is Falcon", clientName: "t" });
    // simulate daemon restart: brand-new store object, same home (index.db + logs on disk)
    const s2 = new SessionStore(home);
    const listed = s2.list().find((r) => r.sessionId === sid);
    expect(listed).toBeTruthy();
    expect(s2.meta(sid)?.cwd).toBe("/tmp/proj"); // cwd preserved (Pass-1 from surviving index.db)
    expect(s2.read(sid).some((e) => e.type === "user_message" && (e as any).text === "codename is Falcon")).toBe(true);
  });
});
