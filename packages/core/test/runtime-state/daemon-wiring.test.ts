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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { repoRootFor, sanitizeProjectKey } from "../../src/agent/memory-dir";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import {
  RuntimeSessionRecords, RuntimeStateUnavailableError, createSqliteRuntimeDirectoryStore, openRuntimeStateDb,
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
  test("runtime-state.db is created at schema 1 and the boot recovery finished before the socket did", async () => {
    await withTempHome(async (home, dirs) => {
      const d = await boot(home);
      const rt = online(d);

      expect(existsSync(dirs.runtimeStatePath)).toBe(true);
      expect(rt.db.schemaVersion()).toBe(1);
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
      const wal = `${dirs.runtimeStatePath}-wal`;
      expect(existsSync(wal) && statSync(wal).size > 0).toBe(false);

      const reopened = openRuntimeStateDb(dirs.home);
      try {
        expect(reopened.integrity().ok).toBe(true);
        expect(reopened.schemaVersion()).toBe(1);
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

// §17 phase 5 is REFUSED in this build (review r1, Important 2): the live memory path
// (`memoryDirFor`) still derives today's key, so relocating a user's memory now would leave the
// agent reading an empty directory — one-way, with no CLI rollback. The plan/apply code and its unit
// tests stay (they are 8b's); what this build must do is say so and move nothing.
describe("daemon wiring — the memory-key migration is refused in this build", () => {
  /** A session whose memory tree sits under TODAY's key, so the migration has something to move. */
  function seedProject(home: string, store: SessionStore, name: string): { sessionId: string; oldKey: string; newKey: string } {
    const cwd = join(home, "work", name);
    mkdirSync(cwd, { recursive: true });
    const sessionId = store.createSession("work", { cwd });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: name, clientName: "test" });
    const oldKey = sanitizeProjectKey(repoRootFor(cwd));
    mkdirSync(join(home, "projects", oldKey, "memory"), { recursive: true });
    writeFileSync(join(home, "projects", oldKey, "memory", "MEMORY.md"), `# ${name}\n`);
    return { sessionId, oldKey, newKey: compatibilityKeys(cwd).memoryProjectKey };
  }

  const memoryBody = (home: string, key: string): string | undefined => {
    const path = join(home, "projects", key, "memory", "MEMORY.md");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };

  test("booting with the flag ON moves nothing, plans nothing, and marks nothing", async () => {
    await withTempHome(async (home) => {
      writeSettings(home, { runtimes: { migrations: { memoryKeys: true } } });
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      store.close();

      const rt = online(await boot(home));

      expect(memoryBody(home, first.oldKey)).toBeDefined(); // the user's memory is where it was
      expect(memoryBody(home, first.newKey)).toBeUndefined();
      expect(rt.records.get(first.sessionId)!.memoryProjectKey).toBe(first.oldKey);
      // Not even a PLAN: a `planned` manifest row is a promise to move something.
      expect(rt.db.db.query("SELECT COUNT(*) AS n FROM memory_key_manifest").get()).toEqual({ n: 0 });
      expect(rt.db.db.query("SELECT value FROM schema_meta WHERE key = 'memory_keys_migrated'").get()).toBe(null);
    });
  });

  test("flipping the flag on a running daemon says so exactly once; flipping it back says nothing", async () => {
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
        const quiet = lines.length; // whatever boot said; the flag was off, so it said nothing about it

        live = settingsWith(true);
        rt!.applySettings(live); // the settings-watcher's diff path
        expect(lines.slice(quiet)).toHaveLength(1);
        expect(lines[quiet]).toContain("not enabled in this build");

        live = settingsWith(false);
        rt!.applySettings(live);
        expect(lines).toHaveLength(quiet + 1); // an off flag is not an event

        expect(memoryBody(home, first.oldKey)).toBeDefined();
        expect(rt!.db.db.query("SELECT COUNT(*) AS n FROM memory_key_manifest").get()).toEqual({ n: 0 });
      } finally {
        await rt?.close();
        store.close();
      }
    });
  });
});
