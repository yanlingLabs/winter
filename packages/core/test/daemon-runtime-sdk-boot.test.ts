// P8b Task 5: the Winter runtime handle, wired into a REAL daemon boot.
//
// The thing under test is the BOOT ORDER and the SHUTDOWN ORDER, so every test here calls
// `startDaemon` against a temp home rather than `createWinterRuntimeSdk` directly (the unit tests in
// `test/runtime-sdk/create.test.ts` do that): that the handle is built after the runtime spine and
// gets ITS directory store, that a spine which would not open costs durability and nothing else,
// and that teardown ends the Winter sessions while the stores they write into are still open.
//
// No child process is spawned anywhere here — no `sdk.query()`, no real `winter` binary.
import { afterEach, describe, expect, test } from "bun:test";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import { isWinterMcpServerInstance, type Query, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import type { CapabilitySession } from "../src/capabilities";
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

describe("daemon boot — the Winter handle", () => {
  test("a booted daemon carries a defined handle, and it reads the SPINE's directory store", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      const handle = d.runtimeSdk;
      expect(handle).toBeDefined();
      if (handle === undefined) return;
      // The brand reached the router: this handle speaks Winter, not Winter.
      expect(handle.sdk.brand.mcpServerName).toBe("winter");
      expect(handle.sdk.brand.homeDirName).toBe(".winter");
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
      const before = process.env.WINTER_RUNTIME_EXECUTABLE;
      // P9a fix wave (M1 class): a dev checkout now HAS a winter on the ladder's last rung (the
      // installed platform package), so "nothing configured" is no longer a refusal in this tree.
      // An EXPLICIT env path that is missing on disk is the deterministic refusal (P8b-2: an explicit
      // path is authoritative and never falls through) — the daemon's own answer, no ambient tree.
      process.env.WINTER_RUNTIME_EXECUTABLE = join(home, "missing-winter");
      try {
        const d = await boot(home);
        const hook = d.runtimeSdk?.spawnHookFor("chat");
        // The refusal — never a throw, and never a silent fallback to another binary.
        expect(hook).toBeInstanceOf(Error);
        expect((hook as { code?: string }).code).toBe("winter_executable_unavailable");
      } finally {
        if (before === undefined) delete process.env.WINTER_RUNTIME_EXECUTABLE;
        else process.env.WINTER_RUNTIME_EXECUTABLE = before;
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

      // Both halves of step 6(b), captured from the ACTUAL operator-facing output.
      const said: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
      let d: RunningDaemon;
      try { d = await boot(home); } finally { console.error = realError; }

      expect(existsSync(d.socketPath)).toBe(true);
      // (i) THE SPINE names the reason, because the spine is what failed…
      expect(said.some((l) => l.startsWith("runtime-state: runtime state unavailable") && l.includes("RuntimeStateUnavailableError"))).toBe(true);
      // …(ii) and the ROUTER says nothing, because it constructed fine. This half is the one that
      // would catch a future change turning a degraded spine into a dead router.
      expect(said.filter((l) => l.startsWith("runtime-sdk: winter runtime sdk unavailable"))).toEqual([]);

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

// P8b Tasks 6-7 (P8b-36): the daemon's capability servers, built PER SESSION.
//
// `RuntimeSdkOptions.capabilities` is handle-wide and construction-time, which is exactly what a
// per-session capability set must not be: `callTool(name, args)` carries no session identity, so a
// shared instance would have to look one up — and a daemon-wide slot cross-attributes the moment two
// Winter sessions run turns concurrently. Because `ctx.mode` comes from the same place and resolves
// `browser`'s read-only chat subset, that is a security bug, not only an identity one.
//
// So the handle is built with `capabilities: []` (proved below through the router's own per-query
// collision guard, which throws BEFORE the leg is picked and before anything is spawned), and the
// daemon exposes `buildSessionCapabilities(session)` for Task 16's driver to put on each session's
// own `Options.mcpServers`.
describe("daemon boot — the capability servers (Tasks 6-7, P8b-36)", () => {
  /** True iff the ROUTER HANDLE is holding a capability server called `name`. */
  function handleHoldsCapability(d: RunningDaemon, name: string): boolean {
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

  const session = (over: Partial<CapabilitySession> = {}): CapabilitySession =>
    ({ sessionId: "s_cap", mode: "code", cwd: "/tmp", roots: ["/tmp"], ...over });

  test("the handle carries NO handle-wide capabilities — they are per session", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      expect(d.runtimeSdk).toBeDefined();
      for (const key of ["winter__sessions", "winter__browser", "winter__office", "winter__research", "winter__web", "winter__computer"]) {
        expect(handleHoldsCapability(d, key), `${key} is on the handle and should not be`).toBe(false);
      }
    });
  });

  test("buildSessionCapabilities returns this session's servers, wired from the daemon's own deps", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      const servers = d.buildSessionCapabilities(session());
      // KEYED BY NAME — the record IS `Options.mcpServers`' shape, and the child derives each tool's
      // wire name from the key, so the key set is the thing to assert. Computer use is off in this
      // temp home, so six servers, not seven — plus `external` (Phase 8c Lane 3, Task 3.4), which is
      // ALWAYS present (kept, advertising zero tools, same "inert not absent" contract every other
      // capability server already follows) since this daemon boot wires no `CapabilityDeps.external`.
      expect(Object.keys(servers)).toEqual([
        "winter__sessions", "winter__browser", "winter__office", "winter__research", "winter__web",
        "winter__lsp",   // fix wave F7: the `lsp` capability server
        "winter__external",   // Phase 8c Lane 3 Task 3.4: plugin-contributed tools (none wired here)
      ]);
      for (const [key, s] of Object.entries(servers)) {
        // The invariant N1 exists to make unrepresentable: key === the config's own name.
        expect(key).toBe(s.name);
        expect(s.type).toBe("sdk");
        // Wire-safe is not enough: an instance the router cannot call is completely inert.
        expect(isWinterMcpServerInstance(s.instance)).toBe(true);
        for (const tool of (s.instance as WinterMcpServerInstance).listTools()) {
          // The router refuses any capability tool whose schema is not a JSON-Schema object.
          expect(tool.inputSchema["type"]).toBe("object");
        }
      }
    });
  });

  test("the computer server follows the LIVE computerUse.enabled setting — no restart (M2)", async () => {
    await withTempHome(async (home) => {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ computerUse: { enabled: true } }));
      const d = await boot(home);
      expect(Object.keys(d.buildSessionCapabilities(session()))).toContain("winter__computer");
    });
  });

  test("two sessions get INDEPENDENT servers, each carrying its own mode", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      const code = d.buildSessionCapabilities(session({ sessionId: "s_code", mode: "code" }));
      const chat = d.buildSessionCapabilities(session({ sessionId: "s_chat", mode: "chat" }));
      const browserOf = (servers: Readonly<Record<string, { instance: unknown }>>): WinterMcpServerInstance =>
        servers["winter__browser"]!.instance as WinterMcpServerInstance;
      // Both alive at once; the chat one advertises the READ-ONLY browser schema, the code one the
      // full schema. Nothing is shared between them.
      const codeSchema = JSON.stringify(browserOf(code).listTools()[0]!.inputSchema);
      const chatSchema = JSON.stringify(browserOf(chat).listTools()[0]!.inputSchema);
      expect(codeSchema).not.toBe(chatSchema);
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
      // draining child would be appending its last events and writing its delivery receipts — BOTH
      // stores `stop()` closes must still answer. Each probe uses the daemon's OWN handle: a second
      // instance over the same home would answer whether or not the daemon's had been closed.
      let runtimeStateAnswered: boolean | undefined;
      let directoryAnswered: boolean | undefined;
      let sessionStoreAnswered: boolean | undefined;
      handle.trackQuery("s_shutdown", new AbortController(), async () => {
        await Bun.sleep(5);
        try {
          rt.db.db.query("SELECT value FROM schema_meta LIMIT 1").get();
          runtimeStateAnswered = true;
        } catch { runtimeStateAnswered = false; } // a closed `runtime-state.db` throws here
        try {
          // The receipt path itself: a write through the router's directory, which is 8a's store.
          await handle.sdk.directory.record(entryFor("s_shutdown"));
          directoryAnswered = true;
        } catch { directoryAnswered = false; }
        try {
          // The event path: `store.close()` is the handle Task 5 MOVED onto the async tail, and a
          // draining child appends its final `SessionEvent`s through this exact instance. A closed
          // bun:sqlite Database throws on use, so this read is the ordering assertion.
          d.sessions.list();
          sessionStoreAnswered = true;
        } catch { sessionStoreAnswered = false; }
      });

      const stopping = daemon?.stop();
      daemon = undefined;
      await stopping;
      expect(runtimeStateAnswered).toBe(true);
      expect(directoryAnswered).toBe(true);
      expect(sessionStoreAnswered).toBe(true);
      // And afterwards it really is closed — otherwise the three assertions above would be vacuous.
      expect(() => d.sessions.list()).toThrow();
    });
  });

  test("stop() with one well-behaved tracked session completes inside the app's SIGKILL grace", async () => {
    await withTempHome(async (home) => {
      const d = await boot(home);
      expect(d.runtimeSdk).toBeDefined();
      d.runtimeSdk?.trackQuery("s_grace", new AbortController(), async () => { await Bun.sleep(10); });

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
