// WS-17 row 11, STRONG FORM: "the session index is disposable — losing it costs nothing."
//
// The weak form ("`SessionStore` rebuilds `index.db` from the JSONL logs") has been true since
// Phase 0. The strong form is what the runtime spine needs and what this file proves: the runtime
// state lives in a DIFFERENT database, so deleting `sessions/index.db` and letting `SessionStore`
// rebuild it must leave `runtime-state.db` BYTE-FOR-BYTE unchanged — every runtime session row,
// every generation, every projection cursor, every directory entry and cursor — and every backend
// uuid must still resolve to the same winter session afterwards.
//
// WHY THAT IS THE INTERESTING CLAIM. The index rebuild is a destructive operation on the product's
// own store: it drops the table and re-derives it from disk, and re-derivation LOSES columns the log
// never carried (`cwd`, `origin`, `approvalPolicy` all reset — `recoverAll`'s pass 2 restores only
// `mode`). If the runtime mapping lived there, or were derived from it, a rebuild would silently
// discard the mapping between a product session and the runtime that executed it — and a
// backend-uuid lookup would start answering "unknown" for sessions whose transcripts are right
// there on disk. Keeping the two stores separate is what makes the index disposable; this test is
// what keeps it that way.
import { describe, expect, test } from "bun:test";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { RuntimeDirectoryEntry } from "@yanlinglabs/winter-runtime-sdk";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectionCheckpoints, RuntimeSessionRecords, createSqliteRuntimeDirectoryStore, openRuntimeStateDb,
  type RuntimeStateDb,
} from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

const RUNTIME_TABLES = [
  "runtime_sessions", "runtime_generations", "runtime_projection_cursors", "directory_entries", "directory_cursors",
] as const;

/** Every row of the five tables the proof pins, as stable JSON. */
function snapshot(rs: RuntimeStateDb): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of RUNTIME_TABLES) {
    out[table] = JSON.stringify(rs.db.query(`SELECT * FROM ${table}`).all());
  }
  return out;
}

describe("WS-17 row 11 — the session index is disposable, strong form", () => {
  test("deleting sessions/index.db rebuilds the product index and leaves runtime-state.db untouched", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const created: Array<{ sessionId: string; uuid: string }> = [];
      for (const n of [1, 2, 3]) {
        const sessionId = store.createSession("work", { cwd: join(home, "work", `p${n}`), model: `model-${n}` });
        store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `hello ${n}`, clientName: "test" });
        store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: n, outputTokens: n });
        created.push({ sessionId, uuid: `11111111-0000-4000-8000-00000000000${n}` });
      }

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        const checkpoints = new ProjectionCheckpoints(rs);
        const directory = createSqliteRuntimeDirectoryStore(rs);

        for (const { sessionId, uuid } of created) {
          records.create({
            winterSessionId: sessionId, runtimeKind: "winter-agent", backendSessionId: uuid, providerId: "codex-oauth",
            modelRef: "gpt-5.4", backendRoot: join(home, "projects", `-p-${sessionId}`), transcriptProjectKey: `-p-${sessionId}`,
            memoryProjectKey: `p-${sessionId}`, tempProjectKey: `-p-${sessionId}`, transcriptHealth: "clean",
            compatibilityLevel: "agent-state", conformanceCorpusVersion: "2026-09", versionProvenance: "recorded",
            sdkVersion: "0.0.2", engineVersion: "0.0.2", providerCatalogVersion: "1", providerAdapterVersion: "1",
            capabilities: ["resume"],
            selection: { runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "gpt-5.4", family: "gpt", authFamily: "custom", sdkVersion: "0.0.2", reason: "test", decidedAt: ISO() },
          });
          records.transition(sessionId, "ready");
          const { generation } = records.bumpGeneration(sessionId, { runtimeKind: "winter-agent", backendSessionId: uuid });
          checkpoints.begin({ winterSessionId: sessionId, generation, sourceId: "src-1" });
          checkpoints.complete(
            { winterSessionId: sessionId, generation, sourceId: "src-1" },
            { runtimeKind: "winter-agent", backendSessionId: uuid, backendCursor: "42", lastWinterSeq: 3 },
            { first: 1, last: 3 },
          );
          const address = serializeRuntimeAddress(buildSessionAddress(sessionId));
          await directory.upsert({
            address, objectKind: "session", runtimeKind: "winter-agent", status: "idle", mode: "code",
            capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true }, updatedAt: ISO(),
          } as RuntimeDirectoryEntry);
          await directory.cursors.set(address, `cursor-${sessionId}`);
        }

        const before = snapshot(rs);
        const listedBefore = store.list().map((r) => r.sessionId).sort();
        expect(listedBefore.length).toBe(3);

        // THE OPERATION: the index is thrown away, exactly as `winter doctor --repair rebuild-index`
        // does it, and the store rebuilds itself from the JSONL logs on construction.
        const indexPath = join(home, "sessions", "index.db");
        expect(existsSync(indexPath)).toBe(true);
        rmSync(indexPath, { force: true });
        rmSync(`${indexPath}-wal`, { force: true });
        rmSync(`${indexPath}-shm`, { force: true });
        const rebuilt = new SessionStore(home);

        // 1. The product side really did rebuild — every session is listed again, from JSONL alone.
        expect(rebuilt.list().map((r) => r.sessionId).sort()).toEqual(listedBefore);
        for (const { sessionId } of created) expect(rebuilt.read(sessionId).length).toBe(3);

        // 2. The runtime side is byte-identical: not one row of the five tables moved.
        expect(snapshot(rs)).toEqual(before);

        // 3. And the mapping still answers — the whole point of keeping it out of the index.
        for (const { sessionId, uuid } of created) {
          expect(records.byBackendSessionId(uuid)!.winterSessionId).toBe(sessionId);
          expect(records.get(sessionId)!.state).toBe("ready");
          expect(checkpoints.latest(sessionId)!.backendCursor).toBe("42");
        }
      } finally {
        rs.close();
      }
    });
  });

  test("the rebuild is genuinely destructive on the product side — the proof is not vacuous", async () => {
    // If the rebuild lost nothing, "runtime-state.db survived it" would be an empty claim. It DOES
    // lose product columns the log never carried, which is exactly why the runtime mapping must not
    // live there.
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const sessionId = store.createSession("work", { cwd: join(home, "work", "p"), model: "model-1" });
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hi", clientName: "test" });
      expect(store.meta(sessionId).cwd).toBe(join(home, "work", "p"));

      rmSync(join(home, "sessions", "index.db"), { force: true });
      const rebuilt = new SessionStore(home);
      expect(rebuilt.meta(sessionId).cwd).toBeNull();
    });
  });
});
