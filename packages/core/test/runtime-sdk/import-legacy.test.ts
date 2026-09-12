// Winter Phase 8c (P8c-6): the engine-era import door. Unit coverage for `convertEngineEraLog`
// (the pure conversion, over a golden fixture set) and `importEngineEraSession` (the whole
// mechanism: convert, write, patch the SAME record). The real-binary proof that a converted
// transcript actually RESUMES on `winter` lives in `test/e2e/import-legacy-real-child.test.ts` —
// this file never spawns a child.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { transcriptProjectKey, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import type { SessionEvent } from "@winter/protocol";
import { convertEngineEraLog, importEngineEraSession, ImportLegacySessionError } from "../../src/runtime-sdk/import-legacy";
import { openRuntimeStateDb, RuntimeSessionRecords, backfillNativeSessions } from "../../src/runtime-state";
import { sessionLegOf } from "../../src/runtime-sdk/leg";
import { SessionStore } from "../../src/sessions/store";
import { withTempHome } from "../runtime-state/support";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "import");

function readFixture(name: string): { events: SessionEvent[]; opts: { sessionId: string; backendSessionId: string; cwd: string; version: string } } {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

describe("convertEngineEraLog", () => {
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))) {
    test(`golden: ${file}`, () => {
      const { events, opts } = readFixture(file);
      const entries = convertEngineEraLog(events, opts);
      // Snapshot-shaped, not snapshot-tested (uuids are fresh every run): assert structure, chain
      // integrity and role alternation rather than byte-for-byte equality against a stored golden.
      expect(entries.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      let prevUuid: string | null = null;
      for (const e of entries) {
        expect(typeof e.uuid).toBe("string");
        expect(seen.has(e.uuid as string)).toBe(false);
        seen.add(e.uuid as string);
        expect(e.parentUuid).toBe(prevUuid);
        expect(e.sessionId).toBe(opts.backendSessionId);
        expect(e.cwd).toBe(opts.cwd);
        expect(e.isSidechain).toBe(false);
        expect(["user", "assistant"]).toContain(e.type);
        prevUuid = e.uuid as string;
      }
    });
  }

  test("reasoning_item is dropped, never converted", () => {
    const events: SessionEvent[] = [
      { type: "user_message", sessionId: "s1", seq: 1, ts: 1, threadId: "main", text: "hi", clientName: "cli" },
      { type: "reasoning_item", sessionId: "s1", seq: 2, ts: 2, threadId: "main", itemJson: '{"secret":true}' },
      { type: "assistant_message", sessionId: "s1", seq: 3, ts: 3, threadId: "main", text: "hello" },
    ];
    const entries = convertEngineEraLog(events, { sessionId: "s1", backendSessionId: "be-1", cwd: "/tmp/x", version: "unknown" });
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  test("a subagent's own thread (threadId !== main) is skipped", () => {
    const events: SessionEvent[] = [
      { type: "user_message", sessionId: "s1", seq: 1, ts: 1, threadId: "main", text: "hi", clientName: "cli" },
      { type: "user_message", sessionId: "s1", seq: 2, ts: 2, threadId: "child-1", text: "sub", clientName: "cli" },
      { type: "assistant_message", sessionId: "s1", seq: 3, ts: 3, threadId: "child-1", text: "sub reply" },
    ];
    const entries = convertEngineEraLog(events, { sessionId: "s1", backendSessionId: "be-1", cwd: "/tmp/x", version: "unknown" });
    expect(entries).toHaveLength(1);
    expect((entries[0]!.message as { content: string }).content).toBe("hi");
  });

  test("consecutive assistant_message + tool_call coalesce into ONE assistant entry; consecutive tool_results coalesce into ONE user entry", () => {
    const events: SessionEvent[] = [
      { type: "user_message", sessionId: "s1", seq: 1, ts: 1, threadId: "main", text: "do it", clientName: "cli" },
      { type: "assistant_message", sessionId: "s1", seq: 2, ts: 2, threadId: "main", text: "sure" },
      { type: "tool_call", sessionId: "s1", seq: 3, ts: 3, threadId: "main", callId: "c1", name: "Bash", argsJson: '{"command":"ls"}' },
      { type: "tool_call", sessionId: "s1", seq: 4, ts: 4, threadId: "main", callId: "c2", name: "Read", argsJson: '{"path":"/a"}' },
      { type: "tool_result", sessionId: "s1", seq: 5, ts: 5, threadId: "main", callId: "c1", output: "ok1", isError: false },
      { type: "tool_result", sessionId: "s1", seq: 6, ts: 6, threadId: "main", callId: "c2", output: "boom", isError: true },
      { type: "assistant_message", sessionId: "s1", seq: 7, ts: 7, threadId: "main", text: "done" },
    ];
    const entries = convertEngineEraLog(events, { sessionId: "s1", backendSessionId: "be-1", cwd: "/tmp/x", version: "unknown" });
    // user(do it), assistant(sure + tool_use c1 + tool_use c2), user(tool_result c1 + tool_result c2), assistant(done)
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant"]);
    const turn2 = entries[1]!.message as { content: unknown[] };
    expect(turn2.content).toEqual([
      { type: "text", text: "sure" },
      { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "c2", name: "Read", input: { path: "/a" } },
    ]);
    const turn3 = entries[2]!.message as { content: unknown[] };
    expect(turn3.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "ok1" },
      { type: "tool_result", tool_use_id: "c2", content: "boom", error: true },
    ]);
  });

  test("a corrupt argsJson still produces a tool_use block rather than aborting the import", () => {
    const events: SessionEvent[] = [
      { type: "tool_call", sessionId: "s1", seq: 1, ts: 1, threadId: "main", callId: "c1", name: "Bash", argsJson: "{not json" },
    ];
    const entries = convertEngineEraLog(events, { sessionId: "s1", backendSessionId: "be-1", cwd: "/tmp/x", version: "unknown" });
    expect(entries).toHaveLength(1);
    const content = (entries[0]!.message as { content: { input: unknown }[] }).content;
    expect(content[0]!.input).toEqual({ raw: "{not json" });
  });
});

describe("importEngineEraSession", () => {
  test("converts, appends via the compat store, and patches the SAME record — never a new one", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      mkdirSync(join(home, "work"), { recursive: true });
      const cwd = join(home, "work", "proj");
      mkdirSync(cwd, { recursive: true });
      const sid = store.createSession("work", { cwd, model: "gpt-5.4" });
      store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "hello", clientName: "cli" });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "hi there" });
      store.append(sid, { type: "turn_completed", sessionId: sid, threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 } as SessionEvent);

      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const records = new RuntimeSessionRecords(rs);
        const before = records.get(sid)!;
        expect(sessionLegOf(before)).toBe("engine");

        const appended: { key: SessionKey; entries: SessionStoreEntry[] }[] = [];
        const result = await importEngineEraSession(
          { home, store, records, compatStore: { append: async (key, entries) => { appended.push({ key, entries }); } } },
          sid,
        );

        expect(result.entries).toBeGreaterThan(0);
        expect(appended).toHaveLength(1);
        expect(appended[0]!.key).toEqual({ projectKey: transcriptProjectKey(cwd), sessionId: result.backendSessionId });

        const after = records.get(sid)!;
        expect(after.winterSessionId).toBe(sid); // SAME Winter session id — never a new record
        expect(sessionLegOf(after)).toBe("winter");
        expect(after.backendSessionId).toBe(result.backendSessionId);
        expect(after.transcriptHealth).toBe("clean");
        expect(after.compatibilityLevel).toBe("conversation");
        expect(after.importedFrom).toBe("engine-era");
        expect(after.state).toBe("ready");
      } finally {
        rs.close();
      }
    });
  });

  test("m2 (whole-branch review): two concurrent imports of the SAME session run the conversion ONCE", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      mkdirSync(join(home, "work-m2"), { recursive: true });
      const cwd = join(home, "work-m2", "proj");
      mkdirSync(cwd, { recursive: true });
      const sid = store.createSession("work-m2", { cwd, model: "gpt-5.4" });
      store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "hello", clientName: "cli" });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "hi there" });

      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const records = new RuntimeSessionRecords(rs);
        expect(sessionLegOf(records.get(sid))).toBe("engine");

        let appendCalls = 0;
        const compatStore = {
          append: async (): Promise<void> => {
            appendCalls++;
            // Yield so the SECOND concurrent call's own read of the record races the first's
            // write — exactly the shape the in-flight map exists to close (without it, both calls
            // would see `sessionLegOf === "engine"` before either has transitioned the record).
            await Bun.sleep(20);
          },
        };
        const deps = { home, store, records, compatStore };
        const [a, b] = await Promise.all([importEngineEraSession(deps, sid), importEngineEraSession(deps, sid)]);

        expect(appendCalls).toBe(1); // ONE real conversion, never two backend transcripts
        expect(a).toEqual(b); // both callers got the SAME result
        expect(sessionLegOf(records.get(sid))).toBe("winter");
        expect(records.get(sid)!.backendSessionId).toBe(a.backendSessionId);

        // A LATER, non-concurrent call on the now-imported session gets its ordinary refusal — the
        // in-flight entry must have been cleared once the promise settled, not memoized forever.
        await expect(importEngineEraSession(deps, sid)).rejects.toThrow(ImportLegacySessionError);
      } finally {
        rs.close();
      }
    });
  });

  test("refuses a session that has no runtime record", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        await expect(importEngineEraSession({ home, store, records }, "s_nope")).rejects.toThrow(ImportLegacySessionError);
      } finally {
        rs.close();
      }
    });
  });

  test("refuses a session that is already on the Winter or official leg", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const cwd = join(home, "work2");
      mkdirSync(cwd, { recursive: true });
      const sid = store.createSession("work2", { cwd });
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        records.create({
          winterSessionId: sid, runtimeKind: "winter-agent", backendSessionId: "be-already",
          providerId: "openai", modelRef: "gpt-5.4", backendRoot: join(home, "projects", "x"),
          transcriptProjectKey: "x", memoryProjectKey: "x", tempProjectKey: "x",
          transcriptHealth: "clean", compatibilityLevel: "agent-state", conformanceCorpusVersion: "unverified",
          versionProvenance: "recorded", sdkVersion: "0.0.4", engineVersion: "0.0.4",
          providerCatalogVersion: "test", providerAdapterVersion: "test", capabilities: [],
          selection: { runtimeKind: "winter-agent", providerId: "openai", modelRef: "gpt-5.4", family: "test", authFamily: "api-key", sdkVersion: "0.0.4", reason: "test", decidedAt: new Date().toISOString() },
        });
        await expect(importEngineEraSession({ home, store, records }, sid)).rejects.toThrow(ImportLegacySessionError);
      } finally {
        rs.close();
      }
    });
  });
});
