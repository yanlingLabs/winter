// P8b Task 5: the Winter runtime handle, wired into a REAL daemon boot.
//
// The thing under test is the BOOT ORDER and the SHUTDOWN ORDER, so every test here calls
// `startDaemon` against a temp home rather than `createNormaRuntimeSdk` directly (the unit tests in
// `test/runtime-sdk/create.test.ts` do that): that the handle is built after the runtime spine and
// gets ITS directory store, that a spine which would not open costs durability and nothing else,
// and that teardown ends the Winter sessions while the stores they write into are still open.
//
// No child process is spawned anywhere here — no `sdk.query()`, no real `winter` binary.
import { afterEach, describe, expect, test } from "bun:test";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { Query } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeDirectoryEntry } from "@yanlinglabs/winter-runtime-sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { RuntimeStateUnavailableError, type RuntimeStateWiring } from "../src/runtime-state";
import { withTempHome } from "./runtime-state/support";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  const stopping = daemon?.stop();
  daemon = undefined;
  await stopping;
});

async function boot(home: string): Promise<RunningDaemon> {
  daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
  return daemon;
}

function online(d: RunningDaemon): RuntimeStateWiring {
  const rt = d.runtimeState;
  if ("unavailable" in rt) throw new Error(`runtime state unavailable: ${rt.unavailable.message}`);
  return rt;
}

/** A minimal directory row — enough to prove WHICH store the handle is reading. */
function entryFor(sessionId: string): RuntimeDirectoryEntry {
  return {
    address: serializeRuntimeAddress(buildSessionAddress(sessionId)),
    parsed: buildSessionAddress(sessionId),
    runtimeKind: "winter-agent", objectKind: "session", transport: "winter-session",
    status: "running", mode: "chat", generation: 1,
    selection: {
      runtimeKind: "winter-agent", providerId: "anthropic", modelRef: "anthropic/claude-opus-5",
      family: "claude", authFamily: "api-key", sdkVersion: "0.0.2", engineVersion: "1.2.3",
      reason: "d13-row-2", decidedAt: "2026-09-11T00:00:00.000Z",
    },
    capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
    updatedAt: "2026-09-11T00:00:01.000Z",
  };
}

const FAKE_QUERY = {} as Query;

describe("daemon boot — the Winter handle", () => {
  test("a booted daemon carries a defined handle, and it reads the SPINE's directory store", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      const handle = d.runtimeSdk;
      expect(handle).toBeDefined();
      if (handle === undefined) return;
      // The brand reached the router: this handle speaks Norma, not Winter.
      expect(handle.sdk.brand.mcpServerName).toBe("norma");
      expect(handle.sdk.brand.homeDirName).toBe(".norma");
      expect(handle.sdk.messaging).toBeDefined();

      // THE WIRE THAT MATTERS: a row written through 8a's own store is visible through the router's
      // directory. If the handle had been built with the router's in-memory default (or with a
      // second SQLite handle), this list would be empty.
      await online(d).directory.upsert(entryFor("s_boot"));
      const listed = await handle.sdk.directory.list();
      expect(listed.map((o) => o.address)).toContain(serializeRuntimeAddress(buildSessionAddress("s_boot")));
    });
  });

  test("spawnHookFor on a real daemon refuses in the typed way when no binary is configured", async () => {
    await withTempHome(async (home) => {
      const before = process.env.NORMA_WINTER_EXECUTABLE;
      delete process.env.NORMA_WINTER_EXECUTABLE;
      try {
        const d = await boot(home);
        const hook = d.runtimeSdk?.spawnHookFor("chat");
        // A dev checkout has no `winter` beside `process.execPath` and none under the temp home, so
        // the daemon's own answer is the refusal — never a throw, and never a silent fallback.
        expect(hook).toBeInstanceOf(Error);
        expect((hook as { code?: string }).code).toBe("winter_executable_unavailable");
      } finally {
        if (before === undefined) delete process.env.NORMA_WINTER_EXECUTABLE;
        else process.env.NORMA_WINTER_EXECUTABLE = before;
      }
    });
  });

  // THE RULING THIS TEST RECORDS (task brief step 6b): a corrupt `runtime-state.db` leaves the
  // handle DEFINED, backed by the router's own in-memory directory. Messaging therefore works for
  // this process's lifetime and receipts are not durable — the same "runtime routing degraded, boot
  // continues" posture 8a's spine already takes, rather than a second, harsher one.
  test("a corrupt runtime-state.db: the daemon boots, and the handle is DEFINED with an in-memory directory", async () => {
    await withTempHome(async (home, dirs) => {
      mkdirSync(join(home, "runtimes"), { recursive: true });
      writeFileSync(dirs.runtimeStatePath, "this is not a database");

      const d = await boot(home);
      expect(existsSync(d.socketPath)).toBe(true);
      // The reason is named — by the spine, which is what actually failed.
      const rt = d.runtimeState;
      expect("unavailable" in rt).toBe(true);
      expect((rt as { unavailable: Error }).unavailable).toBeInstanceOf(RuntimeStateUnavailableError);

      expect(d.runtimeSdk).toBeDefined();
      const handle = d.runtimeSdk;
      if (handle === undefined) return;
      // It is a WORKING directory, just not a durable one: a row recorded through it reads back
      // within this process, and nothing was written to the corrupt file.
      await handle.sdk.directory.record(entryFor("s_degraded"));
      const listed = await handle.sdk.directory.list();
      expect(listed.map((o) => o.address)).toContain(serializeRuntimeAddress(buildSessionAddress("s_degraded")));
    });
  });
});

// P8b Tasks 6-7: the capability servers, as the ROUTER received them.
//
// THE BLIND SPOT THIS BLOCK EXISTS TO CLOSE. `createRuntimeSdk` derives every capability server's
// descriptors at construction — it calls `instance.listTools()` and refuses any tool whose
// `inputSchema` is not a JSON-Schema object — and `daemon.ts` SWALLOWS that refusal (the handle
// becomes undefined and the daemon boots with the Winter leg refusing). So a malformed capability
// would pass every unit test in `test/capabilities/` AND leave a daemon that looks healthy. Two
// assertions are needed together: the handle is DEFINED, and the router is actually holding the
// server names the daemon declared.
//
// The names are read through the router's own per-query collision guard
// (`assertNoCapabilityCollision`), which throws BEFORE the leg is picked and before anything is
// spawned — so this is a real read of the router's capability record, with no child process.
describe("daemon boot — the capability servers (Tasks 6-7)", () => {
  /** True iff the router is holding a capability server called `name`.
   *
   *  The probe never spawns anything: the collision guard runs before the leg is picked, and a
   *  NON-colliding probe dies one step later on executable resolution (the platform package is
   *  private and not on npm — P8b-2 — and this call passes no `pathToClaudeCodeExecutable`). The
   *  `abortController` is pre-aborted belt-and-braces, so even a machine that somehow resolved one
   *  would end the query immediately. Only the COLLISION message counts as a yes. */
  function holdsCapability(d: RunningDaemon, name: string): boolean {
    const abortController = new AbortController();
    abortController.abort();
    try {
      d.runtimeSdk!.sdk.query({
        prompt: "unreachable",
        options: { abortController, mcpServers: { [name]: { type: "sdk", name, instance: {} } } },
      });
      return false;
    } catch (err) {
      return (err as Error).message.includes("is the name of a capability server this handle forwards");
    }
  }

  test("the declared servers reached the router, and the handle survived construction", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      // If ANY capability declaration were malformed, `createRuntimeSdk` would have thrown
      // `RuntimeLaunchInputError` and daemon.ts would have logged and continued with `undefined`.
      expect(d.runtimeSdk).toBeDefined();
      // `sessions` is unconditional; `computer` follows the boot-time `computerUse.enabled`, which
      // is off in this temp home, so it must NOT be there.
      expect(holdsCapability(d, "sessions")).toBe(true);
      expect(holdsCapability(d, "computer")).toBe(false);
      // A name the daemon never declared collides with nothing.
      expect(holdsCapability(d, "not-a-capability")).toBe(false);
    });
  });

  test("the computer server follows the BOOT-TIME computerUse.enabled setting", async () => {
    await withTempHome(async (home) => {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ computerUse: { enabled: true } }));
      const d = await boot(home);
      expect(d.runtimeSdk).toBeDefined();
      expect(holdsCapability(d, "computer")).toBe(true);
    });
  });

  test("the per-call session binding is the daemon's own, and starts unbound", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      expect(d.capabilitySessions.current()).toBeUndefined();
      const release = d.capabilitySessions.bind({ sessionId: "s_bound", mode: "chat", cwd: home, roots: [home] });
      expect(d.capabilitySessions.current()?.sessionId).toBe("s_bound");
      release();
      expect(d.capabilitySessions.current()).toBeUndefined();
    });
  });
});

describe("daemon shutdown — G-14's ordering, on a real daemon", () => {
  test("stop() ends the tracked session BEFORE the 8a spine closes (receipts need the store)", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      const handle = d.runtimeSdk;
      expect(handle).toBeDefined();
      if (handle === undefined) return;
      const rt = online(d);

      // The invariant, measured rather than spied: inside the session's own teardown — the moment a
      // draining child would be writing its delivery receipts — the runtime store must still answer.
      let storeAnswered: boolean | undefined;
      let directoryAnswered: boolean | undefined;
      handle.trackQuery("s_shutdown", FAKE_QUERY, async () => {
        await Bun.sleep(5);
        try {
          rt.db.db.query("SELECT value FROM schema_meta LIMIT 1").get();
          storeAnswered = true;
        } catch { storeAnswered = false; } // a closed `runtime-state.db` throws here
        try {
          // The receipt path itself: a write through the router's directory, which is 8a's store.
          await handle.sdk.directory.record(entryFor("s_shutdown"));
          directoryAnswered = true;
        } catch { directoryAnswered = false; }
      });

      const stopping = daemon?.stop();
      daemon = undefined;
      await stopping;
      expect(storeAnswered).toBe(true);
      expect(directoryAnswered).toBe(true);
    });
  });

  test("stop() with one well-behaved tracked session completes inside the app's SIGKILL grace", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      expect(d.runtimeSdk).toBeDefined();
      d.runtimeSdk?.trackQuery("s_grace", FAKE_QUERY, async () => { await Bun.sleep(10); });

      const started = Date.now();
      const stopping = daemon?.stop();
      daemon = undefined;
      await stopping;
      // `DaemonSupervisor.gracefulExitTimeout` is 2.0 s (see runtime-state/wiring.ts's own note):
      // past it the app SIGKILLs the daemon, and the lock — i.e. the socket file — is left on disk.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(existsSync(d.socketPath)).toBe(false); // the lock was released, so the socket is gone
    });
  });
});
