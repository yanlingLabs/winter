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
afterEach(() => {
  daemon?.stop();
  daemon = undefined;
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
        rt?.close();
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

  test("stop() closes the database — the handle refuses, and a second open succeeds", async () => {
    await withTempHome(async (home, dirs) => {
      const d = await boot(home);
      const rt = online(d);
      d.stop();
      daemon = undefined;

      expect(() => rt.db.db.query("SELECT COUNT(*) AS n FROM runtime_sessions").get()).toThrow();
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

describe("daemon wiring — the memory-key migration is opt-in, hot, and runs once", () => {
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

  test("flipping runtimes.migrations.memoryKeys on a RUNNING daemon migrates without a restart", async () => {
    await withTempHome(async (home) => {
      writeSettings(home);
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      store.close();

      const rt = online(await boot(home, { agent: true }));
      expect(memoryBody(home, first.oldKey)).toBeDefined(); // untouched while the flag is off
      expect(memoryBody(home, first.newKey)).toBeUndefined();

      writeSettings(home, { runtimes: { migrations: { memoryKeys: true } } });
      await until("the memory tree to move to its compatibility key", () => memoryBody(home, first.newKey) !== undefined);
      expect(memoryBody(home, first.oldKey)).toBeUndefined();
      expect(rt.records.get(first.sessionId)!.memoryProjectKey).toBe(first.newKey);
    });
  });

  test("a second boot does not migrate again — the schema_meta marker is the guard", async () => {
    await withTempHome(async (home) => {
      writeSettings(home, { runtimes: { migrations: { memoryKeys: true } } });
      const store = new SessionStore(home);
      const first = seedProject(home, store, "alpha");
      store.close();

      const one = online(await boot(home));
      expect(memoryBody(home, first.newKey)).toBeDefined();
      expect(one.db.db.query("SELECT value FROM schema_meta WHERE key = 'memory_keys_migrated'").get()).toBeTruthy();
      daemon!.stop();
      daemon = undefined;

      // A project that appears AFTER the migration ran is deliberately left where it is: §17 phase 5
      // is a one-time relocation, and the marker is what makes "once" true across boots.
      const store2 = new SessionStore(home);
      const second = seedProject(home, store2, "beta");
      store2.close();

      await boot(home);
      expect(memoryBody(home, second.oldKey)).toBeDefined();
      expect(memoryBody(home, second.newKey)).toBeUndefined();
    });
  });
});
