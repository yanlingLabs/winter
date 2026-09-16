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
    s1.close();
    s2.close();
  });

  // WS-20 (review round 2, M5): `SessionStore`'s constructor-time `migrateBareModelColumnToTags`
  // now accepts `presentProviders`, threaded straight from the daemon boot hook
  // (`credentialPresenceFrom(secrets)`) — this proves it actually reaches the rewrite, using the
  // same "several serving providers, none named" ambiguity `settings-migration-v3.test.ts` and
  // `migrations-tags.test.ts` exercise for their own equivalent rewrites.
  test("presentProviders threads into the sessions.model column rewrite", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-model-col-")));
    const s1 = new SessionStore(home);
    const sid = s1.createSession("global", { cwd: "/tmp/proj", approvalPolicy: "auto" });
    // Writes a bare, genuinely ambiguous legacy model id directly (bypassing session.setModel's own
    // tag validation) — simulates a pre-WS-20 row surviving into a fresh store construction.
    (s1 as any).db.run("UPDATE sessions SET model = ? WHERE session_id = ?", ["gpt-5.6-terra", sid]);
    s1.close();
    const s2 = new SessionStore(home, { presentProviders: new Set(["openai"]) });
    expect(s2.meta(sid)?.model).toBe("openai/gpt-5.6-terra"); // presence-aware rule 5, not the fixed order
    s2.close();
  });
});
