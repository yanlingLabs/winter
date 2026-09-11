// P8a Task 12: the runtime spine, wired into a REAL daemon boot.
//
// Every test here boots `startDaemon` against a temp home (the `daemon-memory-rpc.test.ts` pattern)
// rather than calling the wiring helper directly, because the thing under test IS the boot order:
// that the store opens before anything can route on it, that recovery runs before the socket exists,
// that the reaper's deletions reach the runtime tables, and that a corrupt store costs the daemon
// its runtime routing and nothing else.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { memoryDirFor, repoRootFor, sanitizeProjectKey } from "../../src/agent/memory-dir";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import {
  RUNTIME_STATE_SCHEMA_VERSION, RuntimeSessionRecords, type MemoryKeyFs, RuntimeStateUnavailableError, backfillNativeSessions, createSqliteRuntimeDirectoryStore, openRuntimeStateDb,
  startRuntimeState, type RuntimeStateWiring,
} from "../../src/runtime-state";
import { Settings } from "../../src/settings";
import { EMPTY_SESSION_GRACE_MS, SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

let daemon: RunningDaemon | undefined;
// AWAITED: `stop()`'s tail drains the queued runtime deletions, closes `runtime-state.db` and
// releases the lock. Dropping it would let the NEXT test's `withTempHome` rm the home while this
// daemon still held a handle on it.
afterEach(async () => {
  const stopping = daemon?.stop();
  daemon = undefined;
  await stopping;
});

/** A daemon on a temp home. `agent: true` also starts the SettingsWatcher — daemon.ts builds it
 *  only when a provider exists, and the hot-reload assertions below need it. */
async function boot(home: string, opts: { agent?: boolean } = {}): Promise<RunningDaemon> {
  daemon = await startDaemon({
    home,
    secrets: new FileSecretStore(join(home, "test-secrets")),
    agentProvider: opts.agent ? { provider: new FakeProvider([]), model: "fake-1" } : null,
  });
  return daemon;
}

/** The runtime state a booted daemon must be carrying, or a failure that names why it is not. */
function online(d: RunningDaemon): RuntimeStateWiring {
  const rt = d.runtimeState;
  if ("unavailable" in rt) throw new Error(`runtime state unavailable: ${rt.unavailable.message}`);
  return rt;
}

const SETTINGS_BASE = { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } };

/** Write a COMPLETE v2 settings.json — a partial one would be rewritten by `loadSettings`'s v1
 *  migration and the assertion would be about the migration, not about the key under test. */
function writeSettings(home: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ ...SETTINGS_BASE, ...extra }, null, 2));
}

/** The manifest, and the one-shot marker: the two durable facts §17 phase 5 leaves behind. */
function manifestRows(rt: RuntimeStateWiring): Array<{ old_key: string; entry: string; new_key: string; status: string }> {
  return rt.db.db.query("SELECT old_key, entry, new_key, status FROM memory_key_manifest ORDER BY old_key, entry").all() as
    Array<{ old_key: string; entry: string; new_key: string; status: string }>;
}
function marker(rt: RuntimeStateWiring): unknown {
  return rt.db.db.query("SELECT value FROM schema_meta WHERE key = 'memory_keys_migrated'").get();
}

/** Backdate a session's `created_at` past the reaper's 10-minute grace, through the index's own
 *  handle — `SessionStore` has no door for it, and the reaper's age gate is what we need to cross. */
function backdate(home: string, sessionId: string): void {
  const db = new Database(join(home, "sessions", "index.db"));
  try {
    db.run("UPDATE sessions SET created_at = ? WHERE session_id = ?", [Date.now() - EMPTY_SESSION_GRACE_MS - 60_000, sessionId]);
  } finally {
    db.close();
  }
}

/** Poll until `fn` answers true, or fail with `what`. Used for the settings-watcher's debounce
 *  (150ms) plus the fs.watch latency behind it — never a fixed sleep. */
async function until(what: string, fn: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const receipted = (messageId: string, agoMs: number) => ({
  messageId,
  message: {
    messageId, from: { kind: "session", winterSessionId: "s_sender" }, fromGeneration: 1,
    to: { kind: "session", winterSessionId: "s_target" }, toGeneration: 1, body: "hi",
    notifyWhenIdle: false, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, hopCount: 0,
    senderPermissionClass: "prompts",
  },
  toGeneration: 1,
  claimedBy: "winter-agent",
  outcome: { status: "delivered", messageId },
  updatedAt: new Date(Date.now() - agoMs).toISOString(),
}) as never;

describe("daemon wiring — the store opens and recovery runs before the socket exists", () => {
  test("runtime-state.db is created at the current schema and the boot recovery finished before the socket did", async () => {
    await withTempHome(async (home, dirs) => {
      const d = await boot(home);
      const rt = online(d);

      expect(existsSync(dirs.runtimeStatePath)).toBe(true);
      expect(rt.db.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(rt.lastRecovery.ok).toBe(true);
      expect(rt.lastRecovery.steps).toHaveLength(12);
      // The boot path does NOT re-scan every session log: `SessionStore`'s constructor already ran
      // `recoverAll()` under this same lock, before any socket existed.
      expect(rt.lastRecovery.steps.find((s) => s.step === 1)?.detail).toMatchObject({ indexRecovery: "skipped-already-done" });
      // The ordering claim, measured rather than asserted by construction: the socket did not exist
      // until after recovery had finished.
      expect(new Date(rt.lastRecovery.finishedAt).getTime()).toBeLessThanOrEqual(statSync(dirs.socketPath).ctimeMs);
    });
  });

  // P8b Task 12 fix round 1 (F8): the DIRECTORY half of the same ordering claim. The router handle
  // is built after §13's twelve steps (a recorded plan conflict — see the Task 12 report), so
  // `directory.recover()` runs from the runtime-sdk construction site instead. Nothing in the
  // recovery report says when that happened, and the previous round proved only the HOOK. This
  // proves the daemon: both directory effects are already on disk by the time the socket exists.
  test("the directory is recovered AND its crash-left rows parked before the socket exists", async () => {
    await withTempHome(async (home, dirs) => {
      // What the previous daemon left behind, written before this one boots: a delivery claimed and
      // never receipted (§6.4 step 5's whole evidence), and a live-looking session row carrying the
      // `backendSessionId` the router would cold-resume from.
      const seed = openRuntimeStateDb(home);
      const seedDirectory = createSqliteRuntimeDirectoryStore(seed);
      const envelope = {
        messageId: "msg:be_prev:toolu_crash",
        from: buildSessionAddress("be_prev"), fromGeneration: 1,
        to: buildSessionAddress("be_other"), toGeneration: 1,
        body: "did this arrive?", notifyWhenIdle: false,
        createdAt: Date.now(), expiresAt: Date.now() + 600_000, hopCount: 0,
        senderPermissionClass: "prompts" as const,
      };
      await seedDirectory.deliveries.put({ messageId: envelope.messageId, message: envelope, toGeneration: 1, claimedBy: "winter-agent", updatedAt: ISO() });
      await seedDirectory.upsert({
        address: serializeRuntimeAddress(buildSessionAddress("be_prev")),
        parsed: buildSessionAddress("be_prev"),
        runtimeKind: "winter-agent", objectKind: "session", transport: "winter-session",
        displayName: "previous", status: "running", mode: "code", generation: 1,
        selection: {
          runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "openai/gpt-5.4", family: "openai",
          authFamily: "console-oauth", sdkVersion: "0.0.3", reason: "test", decidedAt: ISO(),
        },
        backendSessionId: "be_prev",
        capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
        updatedAt: ISO(),
      });
      seed.close();

      const d = await boot(home);
      const rt = online(d);
      const directory = rt.directory;

      // The socket exists, so a client could already be asking this daemon about a session — and
      // BOTH effects are already durable.
      expect(existsSync(dirs.socketPath)).toBe(true);
      expect((await directory.deliveries.get(envelope.messageId))?.outcome?.status).toBe("delivery_uncertain");
      expect(await directory.deliveries.claimedWithoutReceipt()).toHaveLength(0);

      const parked = (await directory.load()).find((e) => e.address === serializeRuntimeAddress(buildSessionAddress("be_prev")));
      // F3: no `backendSessionId` survives, so no delivery can cold-resume a session this daemon
      // never attached. A Norma session is resumed by its DRIVER, from the 8a record — which keeps
      // its own copy and is untouched here.
      expect(parked?.backendSessionId).toBeUndefined();
      expect(parked?.status).toBe("unavailable");
      // ⚠️ THE ORDER, NOT THE END STATE (round 2). Asserting the effects after `boot()` returns
      // leaves the whole recovery block free to migrate BELOW `startIpcServer` and stay green,
      // which is the drift this test exists to pin. The sweep stamps `updatedAt` itself, so the
      // sibling test's technique applies verbatim: the park is older than the socket.
      expect(new Date(parked!.updatedAt).getTime()).toBeLessThanOrEqual(statSync(dirs.socketPath).ctimeMs);
    });
  });

  test("a session left `running` by a previous daemon life comes back parked as unavailable", async () => {
    await withTempHome(async (home) => {
      const seed = openRuntimeStateDb(home);
      const records = new RuntimeSessionRecords(seed);
      records.create({
        winterSessionId: "s_prev", runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "gpt-5.4",
        backendRoot: join(home, "projects", "-prev"), transcriptProjectKey: "-prev", memoryProjectKey: "prev",
        tempProjectKey: "-prev", transcriptHealth: "unsupported", compatibilityLevel: "conversation",
        conformanceCorpusVersion: "legacy", versionProvenance: "legacy-unknown", capabilities: [],
        selection: { runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "gpt-5.4", family: "legacy", authFamily: "custom", sdkVersion: "unknown", reason: "test", decidedAt: ISO() },
      });
      records.transition("s_prev", "ready");
      records.bumpGeneration("s_prev", { runtimeKind: "winter-agent" });
      records.transition("s_prev", "running");
      seed.close();

      const rt = online(await boot(home));
      expect(rt.records.get("s_prev")!.state).toBe("unavailable");
      expect(rt.lastRecovery.markedUnavailable).toBe(1);
      expect(rt.records.list({ state: ["ready", "running", "idle"] })).toEqual([]);
    });
  });

  test("pre-existing native sessions gain a backfilled record carrying settings.provider.type", async () => {
    await withTempHome(async (home) => {
      writeSettings(home, { provider: { type: "openai-compatible", model: "gpt-x", baseUrl: "https://example.invalid/v1" } });
      const store = new SessionStore(home);
      const sessionId = store.createSession("work", { cwd: home });
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hello", clientName: "test" });
      store.close();

      const rt = online(await boot(home));
      const record = rt.records.get(sessionId);
      expect(record).toBeDefined();
      expect(record!.providerId).toBe("openai-compatible");
      expect(record!.versionProvenance).toBe("legacy-unknown");
      expect(rt.lastBackfill?.created).toContain(sessionId);
    });
  });
});

describe("daemon wiring — the runtime store is not readable by the model", () => {
  test("Task 17: on the Winter leg the runtimes/ directory is denied to the child's read tools AND to bash reads (the engine's read-tool denial, carried)", async () => {
    await withTempHome(async (home, dirs) => {
      const { controlPlaneDenyRules, sandboxConfigFor } = await import("../../src/runtime-sdk/mode-options");
      const deny = controlPlaneDenyRules(home);
      for (const tool of ["Read", "Glob", "Grep"]) expect(deny.some((r) => r.startsWith(`${tool}(`) && r.includes("/runtimes/**"))).toBe(true);
      expect(sandboxConfigFor(home).filesystem!.denyRead).toContain(dirs.runtimesDir);
    });
  });
});

describe("daemon wiring — the retention sweep reads settings live", () => {
  test("a narrowed deliveries window takes effect at the next sweep, with no daemon restart", async () => {
    await withTempHome(async (home) => {
      writeSettings(home);
      const rt = online(await boot(home, { agent: true }));

      await rt.directory.deliveries.put(receipted("old", 40 * 86_400_000));
      await rt.directory.deliveries.put(receipted("recent", 5 * 86_400_000));

      // The shipped 30-day window: the 40-day-old receipt goes, the 5-day-old one stays.
      expect(await rt.sweepNow()).toEqual({ deliveriesPruned: 1, leasesPruned: 0 });
      expect(await rt.directory.deliveries.get("recent")).toBeDefined();

      writeSettings(home, { runtimes: { retention: { deliveriesDays: 1 } } });
      await until("the sweep to observe the narrowed window", async () => (await rt.sweepNow()).deliveriesPruned === 1);
      expect(await rt.directory.deliveries.get("recent")).toBeUndefined();
    });
  });
});

describe("daemon wiring — the retention sweep runs at boot and on its own interval", () => {
  test("a receipt older than the window is already gone by the time the daemon is up", async () => {
    await withTempHome(async (home) => {
      writeSettings(home);
      // Seeded through a separate handle so the row predates the daemon's own boot entirely.
      const seed = openRuntimeStateDb(home);
      await createSqliteRuntimeDirectoryStore(seed).deliveries.put(receipted("ancient", 40 * 86_400_000));
      seed.close();

      const rt = online(await boot(home));
      expect(await rt.directory.deliveries.get("ancient")).toBeUndefined();
    });
  });

  test("the periodic pass keeps sweeping without anyone calling it", async () => {
    await withTempHome(async (home) => {
      writeSettings(home);
      const store = new SessionStore(home);
      const state = await startRuntimeState({ home, store, settings: () => Settings.parse(SETTINGS_BASE), sweepIntervalMs: 20 });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        // Written AFTER the boot sweep has already run, so only the interval can remove it.
        await rt!.directory.deliveries.put(receipted("stale", 40 * 86_400_000));
        await until("the interval sweep to prune it", async () => (await rt!.directory.deliveries.get("stale")) === undefined, 4000);
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });
});

describe("daemon wiring — deletion and teardown", () => {
  test("the reaper's deletion of an empty session removes that session's runtime rows too", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const doomed = store.createSession("work", { cwd: home });
      const kept = store.createSession("work", { cwd: home });
      store.append(kept, { type: "user_message", sessionId: kept, threadId: "main", text: "keep me", clientName: "test" });
      store.close();
      backdate(home, doomed);

      const rt = online(await boot(home));
      // Backfill saw it (it was still there), then the reaper deleted it — and the runtime rows went
      // with the session rather than outliving it.
      expect(rt.lastBackfill?.created).toContain(doomed);
      await rt.deletionsSettled();
      expect(rt.records.get(doomed)).toBeUndefined();
      expect(rt.records.get(kept)).toBeDefined();
    });
  });

  test("a deletion queued in the same tick as stop() still lands — teardown drains, then closes", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const sessionId = store.createSession("work", { cwd: home });
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hi", clientName: "test" });
      store.close();

      const d = await boot(home);
      const rt = online(d);
      expect(rt.records.get(sessionId)).toBeDefined();

      // Queued and deliberately NOT awaited — the shape a mint-time reap leaves behind when a
      // shutdown lands in the same tick. Without teardown's drain the handle would close over it
      // and the §16 delete would be lost for good.
      rt.onSessionDeleted(sessionId);
      await d.stop();
      daemon = undefined;

      const reopened = openRuntimeStateDb(home);
      try {
        expect(new RuntimeSessionRecords(reopened).get(sessionId)).toBeUndefined();
      } finally {
        reopened.close();
      }
    });
  });

  test("stop() closes the database — the handle refuses, a second open succeeds, no WAL is left behind", async () => {
    await withTempHome(async (home, dirs) => {
      const d = await boot(home);
      const rt = online(d);
      await d.stop();
      daemon = undefined;

      expect(() => rt.db.db.query("SELECT COUNT(*) AS n FROM runtime_sessions").get()).toThrow();
      // Brief step 1's "no -wal growth": a clean close checkpoints, so whatever is left on disk
      // carries no un-replayed frames.
      //
      // THE GC IS PART OF THE ASSERTION, not a workaround for it. `Database.close()` is
      // `sqlite3_close_v2`: with prepared statements still outstanding it leaves a ZOMBIE connection
      // whose checkpoint-and-unlink runs only once those statements are finalized — and in Bun that
      // happens when the `Statement` objects are collected. Without forcing that, this assertion
      // measures GC timing rather than SQLite's close, and any test added to this file can flip it
      // either way.
      //
      // SO THE PROPERTY ASSERTED IS NOW "after close AND A FULL COLLECTION, no un-replayed frames" —
      // slightly weaker than "a clean close checkpoints", and worth saying rather than glossing.
      // That the forced collection is what makes it pass is itself the evidence that no live
      // reference leaked (a still-REACHABLE statement leaves the WAL un-checkpointed through a GC);
      // only finalization was deferred. Harmless in production: the daemon exits right after
      // `stop()`, and an un-checkpointed WAL is replayed on the next open — which this same test
      // asserts by reopening and checking `integrity().ok`.
      Bun.gc(true);
      const wal = `${dirs.runtimeStatePath}-wal`;
      expect(existsSync(wal) && statSync(wal).size > 0).toBe(false);

      const reopened = openRuntimeStateDb(dirs.home);
      try {
        expect(reopened.integrity().ok).toBe(true);
        expect(reopened.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      } finally {
        reopened.close();
      }
    });
  });
});

describe("daemon wiring — a corrupt store costs runtime routing and nothing else", () => {
  test("the daemon boots, serves its socket, and reports the store as unavailable", async () => {
    await withTempHome(async (home, dirs) => {
      mkdirSync(join(home, "runtimes"), { recursive: true });
      writeFileSync(dirs.runtimeStatePath, "this is not a database");

      const d = await boot(home);
      expect(existsSync(d.socketPath)).toBe(true);
      const rt = d.runtimeState;
      expect("unavailable" in rt).toBe(true);
      expect((rt as { unavailable: Error }).unavailable).toBeInstanceOf(RuntimeStateUnavailableError);
    });
  });
});

// §17 phase 5 RUNS in this build (P8b-17). 8a shipped the flag refusing because the live memory path
// still derived today's key; all four preconditions now hold, and the two halves commit together —
// the trees move, the records follow, and `relocatedMemoryKey` is what `daemon.ts` threads into
// `memoryDirFor` so the very next memory read finds them. These tests boot a REAL daemon, because
// the thing under test is the wiring, not the migration (its own unit tests cover that).
describe("daemon wiring — the memory-key migration runs behind its flag", () => {
  /** A session whose memory tree sits under TODAY's key, so the migration has something to move. */
  function seedProject(home: string, store: SessionStore, name: string): { sessionId: string; cwd: string; oldKey: string; newKey: string } {
    const cwd = join(home, "work", name);
    mkdirSync(cwd, { recursive: true });
    const sessionId = store.createSession("work", { cwd });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: name, clientName: "test" });
    const oldKey = sanitizeProjectKey(repoRootFor(cwd));
    mkdirSync(join(home, "projects", oldKey, "memory"), { recursive: true });
    writeFileSync(join(home, "projects", oldKey, "memory", "MEMORY.md"), `# ${name}\n`);
    return { sessionId, cwd, oldKey, newKey: compatibilityKeys(cwd).memoryProjectKey };
  }

  const memoryBody = (home: string, key: string): string | undefined => {
    const path = join(home, "projects", key, "memory", "MEMORY.md");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };

  /** What the daemon's own MEMDIR resolution answers for a cwd, wired exactly as `daemon.ts` wires
   *  it — the whole point of P8b-17 is that this follows the migration. */
  const liveMemDir = (home: string, rt: RuntimeStateWiring, cwd: string): string =>
    memoryDirFor(cwd, { normaHome: home, relocatedKey: (k) => rt.relocatedMemoryKey(k) });

  test("booting with the flag ON relocates the tree, re-keys the record, and the live path follows it", async () => {
    await withTempHome(async (home) => {
      writeSettings(home, { runtimes: { migrations: { memoryKeys: true } } });
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      store.close();

      const rt = online(await boot(home));

      // The tree moved, whole and byte-identical, and NOTHING is left at the old key.
      expect(memoryBody(home, first.oldKey)).toBeUndefined();
      expect(memoryBody(home, first.newKey)).toBe("# alpha\n");
      expect(rt.records.get(first.sessionId)!.memoryProjectKey).toBe(first.newKey);
      expect(manifestRows(rt)).toEqual([{ old_key: first.oldKey, entry: "memory", new_key: first.newKey, status: "moved" }]);

      // THE HALF-SWITCH THAT MUST NOT EXIST: the daemon's own memory lookup resolves to where the
      // tree now is, so the agent never reads an empty directory and never starts a second MEMORY.md.
      expect(liveMemDir(home, rt, first.cwd)).toBe(join(home, "projects", first.newKey, "memory"));
      expect(readFileSync(join(liveMemDir(home, rt, first.cwd), "MEMORY.md"), "utf8")).toBe("# alpha\n");

      // One-shot: nothing left to do, so the marker is written and a later boot re-plans nothing.
      expect(marker(rt)).not.toBe(null);
    });
  });

  test("a home that already migrated does not re-plan or re-narrate at the next boot", async () => {
    await withTempHome(async (home) => {
      writeSettings(home, { runtimes: { migrations: { memoryKeys: true } } });
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      store.close();

      const firstBoot = await boot(home);
      expect(online(firstBoot).records.get(first.sessionId)!.memoryProjectKey).toBe(first.newKey);
      await firstBoot.stop();
      daemon = undefined;

      const lines: string[] = [];
      const store2 = new SessionStore(home);
      const live = Settings.parse({ ...SETTINGS_BASE, runtimes: { migrations: { memoryKeys: true } } });
      const state = await startRuntimeState({ home, store: store2, settings: () => live, log: (l) => lines.push(l) });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        expect(lines.some((l) => l.includes("memory-key migration"))).toBe(false);
        // The relocation is still known — it is read from the manifest at every boot, not from the
        // run that performed it, so the live path keeps finding the tree forever.
        expect(rt!.relocatedMemoryKey(first.oldKey)).toBe(first.newKey);
        expect(liveMemDir(home, rt!, first.cwd)).toBe(join(home, "projects", first.newKey, "memory"));
      } finally {
        await rt?.close();
        store2.close();
      }
    });
  });

  test("flipping the flag on a RUNNING daemon migrates immediately, and only once", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      const lines: string[] = [];
      const settingsWith = (memoryKeys: boolean) => Settings.parse({ ...SETTINGS_BASE, runtimes: { migrations: { memoryKeys } } });
      let live = settingsWith(false);

      const state = await startRuntimeState({ home, store, settings: () => live, log: (l) => lines.push(l) });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        // Flag off: nothing is planned, nothing is said, and the live path is the plain derivation.
        expect(lines.some((l) => l.includes("memory-key"))).toBe(false);
        expect(liveMemDir(home, rt!, first.cwd)).toBe(join(home, "projects", first.oldKey, "memory"));
        const quiet = lines.length;

        live = settingsWith(true);
        rt!.applySettings(live); // the settings-watcher's diff path — no restart anywhere
        expect(lines.slice(quiet).filter((l) => l.includes("memory-key migration"))).toHaveLength(1);
        expect(memoryBody(home, first.newKey)).toBe("# alpha\n");
        expect(rt!.records.get(first.sessionId)!.memoryProjectKey).toBe(first.newKey);
        expect(liveMemDir(home, rt!, first.cwd)).toBe(join(home, "projects", first.newKey, "memory"));

        // Every later settings change re-enters this path; it must not re-plan a finished migration.
        const after = lines.length;
        rt!.applySettings(settingsWith(true));
        live = settingsWith(false);
        rt!.applySettings(live);
        expect(lines).toHaveLength(after);
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });

  test("a home that pins settings.memory.directory is declined — nothing moves, and no marker forecloses it", async () => {
    await withTempHome(async (home) => {
      const pinned = join(home, "my-memdir");
      mkdirSync(pinned, { recursive: true });
      writeSettings(home, { memory: { directory: pinned }, runtimes: { migrations: { memoryKeys: true } } });
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      store.close();

      const rt = online(await boot(home));

      expect(memoryBody(home, first.oldKey)).toBe("# alpha\n"); // the user's tree, exactly where it was
      expect(memoryBody(home, first.newKey)).toBeUndefined();
      expect(rt.records.get(first.sessionId)!.memoryProjectKey).toBe(first.oldKey);
      expect(manifestRows(rt)).toEqual([]);
      // NOT marked done: clearing the override later must still get a migration.
      expect(marker(rt)).toBe(null);
    });
  });

  test("a torn apply is repaired at the next boot even with the flag turned back OFF", async () => {
    // THE REPAIR IS NOT THE MIGRATION. A process lost between the rename and the manifest commit
    // leaves a tree at the new key with its row still `planned` — invisible to `rollback`, which
    // reads `moved`, and to the relocation map the live path consults. If the user then turns the
    // flag off, nothing would ever settle it and the agent would read an empty directory forever.
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      // The crash, reproduced on disk: the rename landed, the commit did not.
      const rs0 = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs: rs0, store, home, providerId: "codex-oauth" });
        rs0.db.run("INSERT INTO memory_key_manifest (old_key, entry, new_key, status, planned_at, moved_at) VALUES (?, 'memory', ?, 'planned', ?, NULL)",
          [first.oldKey, first.newKey, ISO()]);
        mkdirSync(join(home, "projects", first.newKey), { recursive: true });
        renameSync(join(home, "projects", first.oldKey, "memory"), join(home, "projects", first.newKey, "memory"));
      } finally {
        rs0.close();
      }
      store.close();

      // Flag OFF at this boot, deliberately.
      writeSettings(home, { runtimes: { migrations: { memoryKeys: false } } });
      const rt = online(await boot(home));

      expect(manifestRows(rt)).toEqual([{ old_key: first.oldKey, entry: "memory", new_key: first.newKey, status: "moved" }]);
      expect(rt.records.get(first.sessionId)!.memoryProjectKey).toBe(first.newKey);
      expect(rt.relocatedMemoryKey(first.oldKey)).toBe(first.newKey);
      expect(liveMemDir(home, rt, first.cwd)).toBe(join(home, "projects", first.newKey, "memory"));
      expect(memoryBody(home, first.newKey)).toBe("# alpha\n");
      // Settled, so it is rollback-able — the state this manifest exists to guarantee.
      expect(marker(rt)).toBe(null); // and the migration itself was never run: no marker
    });
  });

  test("a refused project is retried on the next SETTINGS CHANGE once the obstruction is cleared — no restart", async () => {
    // P8b-29 replaced the one-attempt-per-process rule: a project refuses on its own, the manifest
    // records the state per entry, and re-running is idempotent — so the user who clears a collision
    // gets their migration at the next settings change rather than only at the next boot.
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const blocked = seedProject(home, store, "blocked");
      const fine = seedProject(home, store, "fine");
      mkdirSync(join(home, "projects", blocked.newKey, "memory"), { recursive: true });
      writeFileSync(join(home, "projects", blocked.newKey, "memory", "MEMORY.md"), "someone else's");
      const lines: string[] = [];
      const live = Settings.parse({ ...SETTINGS_BASE, runtimes: { migrations: { memoryKeys: true } } });

      const state = await startRuntimeState({ home, store, settings: () => live, log: (l) => lines.push(l) });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        // One project migrated, one refused — and the refusal is NAMED, once.
        expect(memoryBody(home, fine.newKey)).toBe("# fine\n");
        expect(memoryBody(home, blocked.oldKey)).toBe("# blocked\n");
        expect(lines.filter((l) => l.startsWith("memory-key migration refused"))).toHaveLength(1);
        expect(marker(rt!)).toBe(null); // nothing is marked done while something is still refused

        // An unrelated settings change must not repeat the refusal list.
        rt!.applySettings(live);
        expect(lines.filter((l) => l.startsWith("memory-key migration refused"))).toHaveLength(1);

        // The user clears the obstruction and touches settings: no restart, and it completes.
        rmSync(join(home, "projects", blocked.newKey, "memory"), { recursive: true, force: true });
        rt!.applySettings(live);
        expect(memoryBody(home, blocked.newKey)).toBe("# blocked\n");
        expect(rt!.records.get(blocked.sessionId)!.memoryProjectKey).toBe(blocked.newKey);
        expect(liveMemDir(home, rt!, blocked.cwd)).toBe(join(home, "projects", blocked.newKey, "memory"));
        expect(marker(rt!)).not.toBe(null);
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });

  test("an apply that throws after a committed move still leaves the live map describing what IS committed", async () => {
    // REVIEW r1, M-1. `apply` commits per entry, so a throw from a LATER entry leaves the manifest
    // and the records correctly saying `old -> new` while the in-process map does not — and the live
    // MEMDIR path would then resolve a directory that is no longer there and start a second
    // MEMORY.md beside the user's own. The rebuild is in a `finally` for exactly this.
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      const second = seedProject(home, store, "beta");
      const live = Settings.parse({ ...SETTINGS_BASE, runtimes: { migrations: { memoryKeys: true } } });
      const lines: string[] = [];

      // The second project's rename explodes AFTER the first one's has been committed.
      let renames = 0;
      const throwsOnSecond: MemoryKeyFs = {
        existsSync, statSync, readdirSync: (p, o) => readdirSync(p, o),
        mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
        renameSync: (from, to) => { if (++renames === 2) throw new Error("EACCES: simulated"); renameSync(from, to); },
      };
      const state = await startRuntimeState({
        home, store, settings: () => live, log: (l) => lines.push(l),
        memoryKeyFs: throwsOnSecond,
      });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        expect(lines.some((l) => l.includes("memory-key migration failed"))).toBe(true);
        // One of the two committed. Whichever it was, the live map and the manifest agree about it,
        // and the daemon's own MEMDIR lookup resolves where the tree actually is.
        const committed = manifestRows(rt!).filter((r) => r.status === "moved");
        expect(committed).toHaveLength(1);
        const moved = [first, second].find((p) => p.oldKey === committed[0]!.old_key)!;
        expect(rt!.relocatedMemoryKey(moved.oldKey)).toBe(moved.newKey);
        expect(liveMemDir(home, rt!, moved.cwd)).toBe(join(home, "projects", moved.newKey, "memory"));
        expect(existsSync(join(liveMemDir(home, rt!, moved.cwd), "MEMORY.md"))).toBe(true);
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });

  test("a boot repair that throws costs the repair and nothing else — the spine is still online", async () => {
    // REVIEW r1, M-2. The repair runs on EVERY boot of EVERY home, including the overwhelming
    // majority with an empty manifest, so it is the one new statement every user pays for. Unwrapped,
    // a throw there would fall to the outer catch and cost the whole runtime spine.
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      // An outstanding `planned` row, so the repair has something to look at — with an empty
      // manifest it never touches the filesystem at all and there is nothing to fail.
      const rs0 = openRuntimeStateDb(home);
      try {
        rs0.db.run("INSERT INTO memory_key_manifest (old_key, entry, new_key, status, planned_at, moved_at) VALUES (?, 'memory', ?, 'planned', ?, NULL)",
          [first.oldKey, first.newKey, ISO()]);
      } finally {
        rs0.close();
      }
      const lines: string[] = [];
      const explodes: MemoryKeyFs = {
        existsSync: () => { throw new Error("EIO: simulated"); },
        statSync, readdirSync: (p, o) => readdirSync(p, o),
        mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
        renameSync: (f, t) => { renameSync(f, t); },
      };
      const state = await startRuntimeState({
        home, store, settings: () => Settings.parse(SETTINGS_BASE), log: (l) => lines.push(l),
        memoryKeyFs: explodes,
      });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();                       // the spine is ONLINE
        expect(rt!.lastRecovery.ok).toBe(true);         // and fully recovered
        expect(lines.some((l) => l.includes("memory-key repair failed"))).toBe(true);
        // With the manifest unreadable the map is empty, which is the honest answer: the live path
        // derives today's key, exactly as on a home that never migrated.
        expect(rt!.relocatedMemoryKey("anything")).toBeUndefined();
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });

  test("the migration NEVER throws, and a table it reads being gone costs the relocation and nothing else", async () => {
    // RE-REVIEW NEW-7. `markerIsSet()` is a bare SELECT over `schema_meta`; sitting one line above
    // the `try` it was the single statement by which `runMemoryKeyMigration` could still throw —
    // and at boot that lands in `startRuntimeState`'s outer catch, which closes the handle and costs
    // the WHOLE runtime spine for a migration that had nothing to migrate. Both doors are asserted:
    // the hot path (which `settings-apply.ts` happens to wrap) and the boot path (which does not).
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      const lines: string[] = [];
      const settingsWith = (memoryKeys: boolean) => Settings.parse({ ...SETTINGS_BASE, runtimes: { migrations: { memoryKeys } } });
      let live = settingsWith(false);

      const state = await startRuntimeState({ home, store, settings: () => live, log: (l) => lines.push(l) });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        // The table the marker check reads goes away under the running daemon.
        rt!.db.db.run("DROP TABLE schema_meta");

        live = settingsWith(true);
        expect(() => rt!.applySettings(live)).not.toThrow();   // the contract, asserted on the statement that broke it
        expect(lines.some((l) => l.includes("memory-key migration failed"))).toBe(true);
        // The map is untouched and the live path still answers.
        expect(rt!.relocatedMemoryKey(first.oldKey)).toBeUndefined();
        expect(liveMemDir(home, rt!, first.cwd)).toBe(join(home, "projects", first.oldKey, "memory"));
      } finally {
        await rt?.close();
      }

      // AND AT BOOT, where nothing wraps the call: the spine must come up anyway.
      const bootLines: string[] = [];
      const booted = await startRuntimeState({ home, store, settings: () => settingsWith(true), log: (l) => bootLines.push(l) });
      const rt2 = "unavailable" in booted ? undefined : booted;
      try {
        expect(rt2).toBeDefined();                       // NOT `{ unavailable }`
        expect(rt2!.lastRecovery.ok).toBe(true);
        expect(bootLines.some((l) => l.includes("memory-key migration failed"))).toBe(true);
        expect(bootLines.some((l) => l.includes("runtime state could not be wired"))).toBe(false);
      } finally {
        await rt2?.close();
        store.close();
      }
    });
  });

  test("a relocation map that cannot be rebuilt keeps the LAST map and the spine online", async () => {
    // RE-REVIEW NEW-2's other half: the `finally` that rebuilds the map sits OUTSIDE the catch, so an
    // unguarded throw there escapes the same way.
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      const lines: string[] = [];
      const settingsWith = (memoryKeys: boolean) => Settings.parse({ ...SETTINGS_BASE, runtimes: { migrations: { memoryKeys } } });
      let live = settingsWith(false);

      const state = await startRuntimeState({ home, store, settings: () => live, log: (l) => lines.push(l) });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        rt!.db.db.run("DROP TABLE memory_key_manifest");

        live = settingsWith(true);
        expect(() => rt!.applySettings(live)).not.toThrow();
        expect(lines.some((l) => l.includes("memory-key migration failed"))).toBe(true);
        expect(lines.some((l) => l.includes("memory-key map could not be rebuilt"))).toBe(true);
        // The last known map is KEPT (nothing had been relocated, so it is empty) and the live path
        // still answers — the alternative, an offline spine, answers `undefined` for every key too
        // AND costs every other runtime feature.
        expect(rt!.relocatedMemoryKey(first.oldKey)).toBeUndefined();
        expect(liveMemDir(home, rt!, first.cwd)).toBe(join(home, "projects", first.oldKey, "memory"));
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });

  test("clearing settings.memory.directory on a RUNNING daemon un-declines the migration — no restart", async () => {
    await withTempHome(async (home) => {
      const pinned = join(home, "my-memdir");
      mkdirSync(pinned, { recursive: true });
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      const lines: string[] = [];
      const settingsWith = (directory?: string) =>
        Settings.parse({ ...SETTINGS_BASE, ...(directory === undefined ? {} : { memory: { directory } }), runtimes: { migrations: { memoryKeys: true } } });
      let live = settingsWith(pinned);

      const state = await startRuntimeState({ home, store, settings: () => live, log: (l) => lines.push(l) });
      const rt = "unavailable" in state ? undefined : state;
      try {
        expect(rt).toBeDefined();
        expect(memoryBody(home, first.oldKey)).toBe("# alpha\n");
        expect(lines.filter((l) => l.includes("declined"))).toHaveLength(1);

        // An unrelated settings edit re-enters this path: the decline must not narrate again.
        rt!.applySettings(settingsWith(pinned));
        expect(lines.filter((l) => l.includes("declined"))).toHaveLength(1);

        // The user clears the override. A decline is not an attempt, so this is answered LIVE.
        live = settingsWith(undefined);
        rt!.applySettings(live);
        expect(memoryBody(home, first.newKey)).toBe("# alpha\n");
        expect(rt!.records.get(first.sessionId)!.memoryProjectKey).toBe(first.newKey);
        expect(liveMemDir(home, rt!, first.cwd)).toBe(join(home, "projects", first.newKey, "memory"));
        expect(marker(rt!)).not.toBe(null);
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });
});
