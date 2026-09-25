// `createWinterRuntimeSdk` against a REAL router handle (the in-memory directory store the router
// itself ships for hermetic hosts) and a `FileSecretStore` in a temp dir. No child process is
// spawned anywhere here: the topology is exercised through `spawnHookFor`'s RESOLUTION only, which
// is a pure function of settings/env/paths.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createInMemoryRuntimeDirectoryStore, type RuntimeSdk, type RuntimeSdkOptions } from "@yanlinglabs/winter-runtime-sdk";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { DEFAULT_DELIVERIES_DAYS, DEFAULT_NAME_LEASES_DAYS } from "../../src/runtime-state/retention";
import { RUNTIME_SHUTDOWN_DRAIN_MS } from "../../src/runtime-state/wiring";
import { buildCoreBrand, CORE_BRAND } from "../../src/runtime-sdk/brand";
import { createWinterRuntimeSdk, SHUTDOWN_QUERY_GRACE_MS, type WinterRuntimeSdk, type WinterRuntimeSdkDeps } from "../../src/runtime-sdk/create";
import { WinterExecutableUnavailable } from "../../src/runtime-sdk/executable";
import { WINTER_PEER_VERSIONS } from "../../src/runtime-sdk/versions";
import type { Settings } from "../../src/settings";

const DAY_MS = 86_400_000;

let home: string;
let secretsDir: string;
let settings: Settings | null;
let envBefore: string | undefined;
let handles: WinterRuntimeSdk[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "p8b-create-"));
  secretsDir = join(home, "test-secrets");
  settings = null;
  handles = [];
  // The env door is a real input to `spawnHookFor`; a developer machine that happens to export it
  // would otherwise make the "nothing resolves" case pass for the wrong reason.
  envBefore = process.env.WINTER_RUNTIME_EXECUTABLE;
  delete process.env.WINTER_RUNTIME_EXECUTABLE;
});
afterEach(async () => {
  for (const h of handles) await h.dispose();
  if (envBefore === undefined) delete process.env.WINTER_RUNTIME_EXECUTABLE;
  else process.env.WINTER_RUNTIME_EXECUTABLE = envBefore;
  rmSync(home, { recursive: true, force: true });
});

/** A settings object with just the block under test — `runtimes` is `.optional()`, so `null` (no
 *  settings at all) is a case every consumer must answer for and several tests below use it.
 *  `handoff` (fix wave, C2/P8c-18) defaults in here — none of this file's own cases are about that
 *  setting, so every call site naming a `runtimes` block before it existed keeps compiling. */
function withRuntimes(runtimes: Omit<NonNullable<Settings["runtimes"]>, "handoff"> & { handoff?: NonNullable<Settings["runtimes"]>["handoff"] }): Settings {
  return { schemaVersion: 2, runtimes: { handoff: { crossRuntime: false }, ...runtimes } } as unknown as Settings;
}

function deps(extra: Partial<WinterRuntimeSdkDeps> = {}): WinterRuntimeSdkDeps {
  return {
    home,
    settings: () => settings,
    secrets: new FileSecretStore(secretsDir),
    directoryStore: createInMemoryRuntimeDirectoryStore(),
    capabilities: [],
    ...extra,
  };
}

/** Build a handle and capture the exact `RuntimeSdkOptions` this file handed the router. The real
 *  factory still runs, so every assertion is against a genuinely-constructed handle. */
async function build(
  extra: Partial<WinterRuntimeSdkDeps> = {},
  grace?: number,
): Promise<{ handle: WinterRuntimeSdk; opts: RuntimeSdkOptions; disposeOrder: string[] }> {
  const { createRuntimeSdk } = await import("@yanlinglabs/winter-runtime-sdk");
  const disposeOrder: string[] = [];
  let captured: RuntimeSdkOptions | undefined;
  const handle = await createWinterRuntimeSdk(deps(extra), {
    ...(grace === undefined ? {} : { grace }),
    createRuntimeSdk: (opts) => {
      captured = opts;
      const real = createRuntimeSdk(opts);
      // A proxy rather than a spread: `RuntimeSdk` exposes getters, and spreading would freeze them.
      return new Proxy(real, {
        get(target, prop, receiver): unknown {
          if (prop === "dispose") return async () => { disposeOrder.push("sdk.dispose"); await real.dispose(); };
          return Reflect.get(target, prop, receiver);
        },
      }) as RuntimeSdk;
    },
  });
  handles.push(handle);
  if (captured === undefined) throw new Error("the factory was never called");
  return { handle, opts: captured, disposeOrder };
}

describe("createWinterRuntimeSdk — the options it hands the router", () => {
  test("constructs a real handle; messaging and directory are live", async () => {
    const { handle, opts } = await build();
    expect(handle.sdk.messaging).toBeDefined();
    expect(typeof handle.sdk.messaging.send).toBe("function");
    expect(handle.sdk.directory).toBeDefined();
    // Resolved through the injected peer's own `resolveBrand`, and it is OURS.
    expect(handle.sdk.brand.mcpServerName).toBe("winter");
    expect(handle.sdk.brand.homeDirName).toBe(".winter");
    // test-keychain-isolation fix: no longer the frozen `CORE_BRAND` singleton by identity — it is
    // built fresh from THIS call's own `deps.home` (`buildCoreBrand(undefined, home)`) so its
    // `keychainService` can honour `WINTER_KEYCHAIN_SERVICE` for a non-default home (P9c-15's
    // guard), which a module-load-time singleton with no home in scope never could. Every other
    // field is unchanged from `CORE_BRAND`.
    expect(opts.brand).not.toBe(CORE_BRAND);
    expect(opts.brand).toEqual(buildCoreBrand(undefined, home));
    expect(opts.brand!.presetName).toBe("winter_code");
  });

  // WS-23: the official `claude` leg is retired — the router is handed the Winter peer alone, and none
  // of the options that configured the other leg (its executable, its credential seam, its policy, its
  // capability-schema bridge, its advisor resolver, its handoff participants).
  test("WS-23: the Winter peer alone — no claude peer, no official options, nothing for the other leg", async () => {
    const { opts } = await build();
    expect(Object.keys(opts.peers)).toEqual(["winter"]);
    expect(opts.peerVersions).toEqual({ winterAgentSdk: WINTER_PEER_VERSIONS.winterAgentSdk });
    const loose = opts as unknown as Record<string, unknown>;
    for (const key of ["vendoredOfficialRuntime", "official", "toInputShape", "advisor", "keychain"]) expect(key in loose).toBe(false);
    expect(Object.keys(opts.handoff ?? {}).sort()).toEqual(["resolveEndpoint", "winterHome"]);
  });

  test("WS-23: a Claude catalog model with an Anthropic key selects the Winter runtime, in Code mode too", async () => {
    // A real key in this temp home's file store: before WS-23 this exact input routed Code mode to
    // the official leg (D13-2). With the peer declared absent, the router's own rule sends it to Winter.
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-test" });
    const { handle } = await build({ secrets });
    const decided = await handle.selectRuntimeFor({ mode: "code", model: "anthropic/claude-sonnet-5" });
    if ("refused" in decided) throw new Error(`selection refused: ${decided.reason}`);
    expect(decided.runtimeKind).toBe("winter-agent");
    expect(decided.providerId).toBe("anthropic");
    expect(decided.modelRef).toBe("anthropic/claude-sonnet-5");
  });

  test("the Winter permission class is forwarded when declared — and only the Winter adapter's", async () => {
    const sessionPermissionClass = () => "unknown" as const;
    const { opts } = await build({ sessionPermissionClass });
    expect(opts.messaging?.messaging?.winter?.permissionClass).toBe(sessionPermissionClass);
    expect(Object.keys(opts.messaging?.messaging ?? {})).toEqual(["winter"]);
  });

  test("the directory store, [] capabilities and the daemon's own home", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const { opts } = await build({ directoryStore: store });
    expect(opts.directoryStore).toBe(store);
    expect(opts.capabilities).toEqual([]);
    // §1.6: the seams must resolve under the daemon's home, not `resolveWinterHome()`'s default.
    expect(opts.handoff?.winterHome).toBe(home);
    // No permission class declared ⇒ no messaging-policy block at all.
    expect(opts.messaging?.messaging).toBeUndefined();
  });

  // Winter Phase 10b (D1-6, R6-R8 review, CRITICAL): without this the barrier's own
  // `reviewSwitch`/`plan().review` fall back to the router's OWN unconfigured default. `daemonResolveEndpoint()`
  // is memoised (`providers/registry.test.ts` pins that), so identity equality proves it is genuinely
  // THIS module's resolver reaching the router, not a fresh/different function that merely behaves
  // similarly.
  test("D1-6: the review's resolveEndpoint is the daemon's own registry-backed resolver", async () => {
    const { daemonResolveEndpoint } = await import("../../src/providers/registry");
    const { opts } = await build();
    expect(opts.handoff?.resolveEndpoint).toBe(daemonResolveEndpoint());
  });

  test("an offline spine passes no store — the router falls back to its own in-memory one", async () => {
    const { handle, opts } = await build({ directoryStore: undefined });
    expect(opts.directoryStore).toBeUndefined();
    expect(handle.sdk.directory).toBeDefined(); // still a working handle, just not durable
  });
});

describe("createWinterRuntimeSdk — retention (G-12)", () => {
  test("an absent runtimes block still passes the shipped 30/7 windows, in ms", async () => {
    settings = null;
    const { opts } = await build();
    const retention = opts.messaging?.directory?.retention;
    expect(retention?.deliveries).toBe(DEFAULT_DELIVERIES_DAYS * DAY_MS);
    expect(retention?.nameLeases).toBe(DEFAULT_NAME_LEASES_DAYS * DAY_MS);
  });

  test("the configured windows are mapped days → ms, and are HOT", async () => {
    settings = withRuntimes({ retention: { deliveriesDays: 3, nameLeasesDays: 1 }, migrations: { memoryKeys: false }, winterLeg: { chat: false, dispatch: false, code: false }, winterIdleTimeoutSec: 900 });
    const { opts } = await build();
    const retention = opts.messaging?.directory?.retention;
    expect(retention?.deliveries).toBe(3 * DAY_MS);
    expect(retention?.nameLeases).toBe(1 * DAY_MS);

    // No restart, no rebuild: the same object answers with the new windows (the router reads the
    // property at recovery time, not at construction).
    settings = withRuntimes({ retention: { deliveriesDays: 90, nameLeasesDays: 14 }, migrations: { memoryKeys: false }, winterLeg: { chat: false, dispatch: false, code: false }, winterIdleTimeoutSec: 900 });
    expect(retention?.deliveries).toBe(90 * DAY_MS);
    expect(retention?.nameLeases).toBe(14 * DAY_MS);
  });

  // The assertion above is on the object THIS FILE built, which is live by construction — it would
  // pass identically against a router that snapshotted the numbers. This one drives the REAL router:
  // a released name lease is pruned or kept by `directory.recover()` according to the window that is
  // live at the moment of the pass, on ONE handle that is never rebuilt.
  test("the router itself honours a window changed after construction", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const address = serializeRuntimeAddress(buildSessionAddress("s_lease"));
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
    await store.names.claim({ name: "alpha", address, generation: 1, claimedAt: tenDaysAgo });
    await store.names.release("alpha", address, tenDaysAgo);

    const wide = { retention: { deliveriesDays: 30, nameLeasesDays: 30 }, migrations: { memoryKeys: false }, winterLeg: { chat: false, dispatch: false, code: false }, winterIdleTimeoutSec: 900 };
    settings = withRuntimes(wide);
    const { handle } = await build({ directoryStore: store });

    await handle.sdk.directory.recover();
    expect(await store.names.lookup("alpha")).toHaveLength(1); // 10 days old, 30-day window: kept

    settings = withRuntimes({ ...wide, retention: { deliveriesDays: 30, nameLeasesDays: 1 } });
    await handle.sdk.directory.recover();
    expect(await store.names.lookup("alpha")).toHaveLength(0); // same handle, narrowed window: gone
  });
});

describe("spawnHookFor — P8b-1's one topology site", () => {
  test("an explicit WINTER_RUNTIME_EXECUTABLE that is missing on disk ⇒ the typed refusal, never a throw and never a fallback", async () => {
    // P9a fix wave (M1 class): "nothing configured" is no longer a refusal in a tree where the
    // platform package is installed (the ladder's last rung finds it), so the deterministic refusal
    // is an explicit path that does not exist — P8b-2 says an explicit path never falls through.
    process.env.WINTER_RUNTIME_EXECUTABLE = join(home, "missing-winter");
    const { handle } = await build();
    const hook = handle.spawnHookFor("chat");
    expect(hook).toBeInstanceOf(WinterExecutableUnavailable);
    expect((hook as WinterExecutableUnavailable).code).toBe("winter_executable_unavailable");
    // It names what it looked at, so a user can see where to drop the binary.
    expect((hook as WinterExecutableUnavailable).tried.some((p) => p.startsWith(home))).toBe(true);
  });

  test("WINTER_RUNTIME_EXECUTABLE naming an existing file ⇒ the spawn hook", async () => {
    const bin = join(home, "winter-bin");
    writeFileSync(bin, "#!/bin/sh\n");
    process.env.WINTER_RUNTIME_EXECUTABLE = bin;
    const { handle } = await build();
    expect(handle.spawnHookFor("code")).toEqual({ pathToClaudeCodeExecutable: bin });
    // Path (a): the SDK's own `defaultSpawn` stays in charge until the engine is published.
    expect((handle.spawnHookFor("code") as { spawnClaudeCodeProcess?: unknown }).spawnClaudeCodeProcess).toBeUndefined();
  });

  test("it RE-RESOLVES on every call: the setting is hot and wins over the env", async () => {
    const envBin = join(home, "env-winter");
    const settingBin = join(home, "setting-winter");
    writeFileSync(envBin, "#!/bin/sh\n");
    writeFileSync(settingBin, "#!/bin/sh\n");
    process.env.WINTER_RUNTIME_EXECUTABLE = envBin;

    const { handle } = await build();
    expect(handle.spawnHookFor("dispatch")).toEqual({ pathToClaudeCodeExecutable: envBin });

    settings = withRuntimes({ retention: { deliveriesDays: 30, nameLeasesDays: 7 }, migrations: { memoryKeys: false }, winterLeg: { chat: false, dispatch: false, code: false }, winterExecutable: settingBin, winterIdleTimeoutSec: 900 });
    // Same handle, no rebuild, no restart.
    expect(handle.spawnHookFor("dispatch")).toEqual({ pathToClaudeCodeExecutable: settingBin });
  });

  test("every mode resolves the same binary in 8b (the topology is one decision, not three)", async () => {
    const bin = join(home, "winter-bin");
    writeFileSync(bin, "#!/bin/sh\n");
    process.env.WINTER_RUNTIME_EXECUTABLE = bin;
    const { handle } = await build();
    for (const mode of ["chat", "dispatch", "code"] as const) {
      expect(handle.spawnHookFor(mode)).toEqual({ pathToClaudeCodeExecutable: bin });
    }
  });
});

describe("the shutdown budget (P8b-32)", () => {
  // THE WHOLE POINT OF THE NUMBER. Teardown is sequential in `daemon.ts`'s `stop()` — this grace,
  // then 8a's deletion drain — and the sum must fit inside `DaemonSupervisor.gracefulExitTimeout`
  // (5.0 s since Winter Phase 8d's P8d-6 — the app's quit runs behind `.terminateLater`, so macOS's
  // own ~5 s window no longer binds; it was 2.0 s before), past which the app SIGKILLs the daemon,
  // `lock.release()` never runs and the socket file is left on disk. Asserted so that editing EITHER
  // constant trips a test — the two moved TOGETHER in 8d (1500→3500 ms beside 2.0→5.0 s).
  test("300 ms, and 300 + the 3500 ms drain is inside the app's 5.0 s SIGKILL grace (P8d-6)", () => {
    expect(SHUTDOWN_QUERY_GRACE_MS).toBe(300);
    expect(RUNTIME_SHUTDOWN_DRAIN_MS).toBe(3_500);
    expect(SHUTDOWN_QUERY_GRACE_MS + RUNTIME_SHUTDOWN_DRAIN_MS).toBeLessThan(5_000);
  });
});

describe("dispose — G-14: every Query ends BEFORE the router disposes", () => {
  test("two tracked sessions are both awaited, and both finish first", async () => {
    const { handle, disposeOrder } = await build();
    const end = (name: string) => async (): Promise<void> => {
      await Bun.sleep(20);
      disposeOrder.push(name);
    };
    handle.trackQuery("s1", new AbortController(), end("s1"));
    handle.trackQuery("s2", new AbortController(), end("s2"));

    await handle.dispose();
    expect(disposeOrder).toHaveLength(3);
    expect(disposeOrder.slice(0, 2).sort()).toEqual(["s1", "s2"]);
    expect(disposeOrder[2]).toBe("sdk.dispose");
  });

  // G-14 is "awaits iterations with a bounded grace, ABORTS stragglers", and the abort is the half
  // that cannot be delegated: Winter's `Query` has no `close()`, so a child that outlives this is
  // unreachable for the rest of the process's life and then survives it.
  test("an end that never resolves is bounded, ABORTED, and logged — and the router still disposes", async () => {
    const lines: string[] = [];
    const { handle, disposeOrder } = await build({ log: (line) => lines.push(line) }, 50);
    const abort = new AbortController();
    handle.trackQuery("stuck", abort, () => new Promise<void>(() => {}));
    expect(abort.signal.aborted).toBe(false);

    const started = Date.now();
    await handle.dispose();
    const elapsed = Date.now() - started;
    expect(abort.signal.aborted).toBe(true); // the child is cancelled, not merely abandoned
    expect(disposeOrder).toEqual(["sdk.dispose"]);
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1_000);
    // A `stop()` that suddenly takes longer must not be silent — passing the grace is the one thing
    // that can push teardown past the app's SIGKILL deadline, and the operator needs the session id.
    expect(lines).toEqual(["session stuck did not end within 50ms — aborting it"]);
  });

  test("a session that ends inside the grace is NOT aborted", async () => {
    const { handle } = await build({}, 50);
    const abort = new AbortController();
    handle.trackQuery("polite", abort, async () => { await Bun.sleep(5); });
    await handle.dispose();
    expect(abort.signal.aborted).toBe(false);
  });

  test("an end that REJECTS is a straggler, not a failure: teardown completes", async () => {
    const { handle, disposeOrder } = await build({}, 50);
    handle.trackQuery("angry", new AbortController(), () => Promise.reject(new Error("child already gone")));
    await handle.dispose();
    expect(disposeOrder).toEqual(["sdk.dispose"]);
  });

  test("untrack removes a session that ended on its own — shutdown never re-ends it", async () => {
    const { handle, disposeOrder } = await build();
    handle.trackQuery("done", new AbortController(), async () => { disposeOrder.push("should-not-run"); });
    handle.untrack("done");
    await handle.dispose();
    expect(disposeOrder).toEqual(["sdk.dispose"]);
  });

  test("dispose is idempotent (the app's SIGTERM path can race its own shutdown)", async () => {
    const { handle, disposeOrder } = await build();
    await handle.dispose();
    await handle.dispose();
    expect(disposeOrder).toEqual(["sdk.dispose"]);
  });

  // A LATCH WOULD NOT BE ENOUGH. A second `stop()` while the first is still draining must not
  // return early: its caller goes straight on to close the session store and `runtime-state.db`,
  // underneath a child that is still appending into both.
  test("a CONCURRENT second dispose awaits the first — it never returns mid-drain", async () => {
    const { handle, disposeOrder } = await build();
    handle.trackQuery("slow", new AbortController(), async () => {
      await Bun.sleep(30);
      disposeOrder.push("slow");
    });

    const first = handle.dispose();
    const second = handle.dispose();
    await second;
    // The second call did not come back before the drain finished…
    expect(disposeOrder).toEqual(["slow", "sdk.dispose"]);
    await first;
    // …and the router was still disposed exactly once.
    expect(disposeOrder.filter((s) => s === "sdk.dispose")).toHaveLength(1);
  });

  // Task 16's idle timer and resume paths run off timers that outlive `server.stop()`, so a session
  // CAN be started after the drain. A silent no-op is the one answer that leaves a live child with
  // nobody holding it.
  test("trackQuery after dispose aborts the query immediately and says so", async () => {
    const lines: string[] = [];
    const { handle } = await build({ log: (line) => lines.push(line) });
    await handle.dispose();

    const abort = new AbortController();
    let endCalled = false;
    handle.trackQuery("late", abort, async () => { endCalled = true; });
    expect(abort.signal.aborted).toBe(true);
    expect(endCalled).toBe(false);
    expect(lines).toEqual(["session late started during shutdown — aborting it immediately"]);
  });
});

// WS-21 L3.3 (spec §3.1): a router that applies run homes is created with `requireRunHome: true` and the
// host's `runHomeFor` (its own cold-resume path) — ONLY when the host supplies one, which `daemon.ts`
// does only when the linked router exports `buildRunHome`. On router 0.0.11 nothing changes.
describe("createWinterRuntimeSdk — run homes (WS-21)", () => {
  test("no runHomeFor: the router is created exactly as before (no requireRunHome, no runHomeFor)", async () => {
    const { opts } = await build();
    expect("requireRunHome" in opts).toBe(false);
    expect("runHomeFor" in opts).toBe(false);
  });

  test("with runHomeFor: requireRunHome true and the builder handed through verbatim", async () => {
    const runHomeFor = async () => { throw new Error("never called by construction"); };
    const { opts } = await build({ runHomeFor });
    expect((opts as unknown as { requireRunHome?: boolean }).requireRunHome).toBe(true);
    expect((opts as unknown as { runHomeFor?: unknown }).runHomeFor).toBe(runHomeFor);
    // L2: `requireRunHome` also requires an explicit `handoff.winterHome` (the store then lives in `<home>/sdk`).
    expect(opts.handoff?.winterHome).toBe(home);
  });

  // R.1: this used to pin router 0.0.11 (both answers undefined). The linked router now HAS both doors, and
  // the handle forwards them: an unknown run id is `pending` (never `safe` — nothing is disposed on a
  // guess), and a recovery reconcile of a root with nothing in it reports `clean`.
  test("runHomeOutcome / reconcileRootForRecovery forward the linked router's own doors (a run-home router)", async () => {
    const runHomeFor = async () => { throw new Error("never called by these doors"); };
    const { handle } = await build({ runHomeFor });
    expect(handle.runHomeOutcome?.("an-unknown-run")).toBe("pending");
    const root = mkdtempSync(join(tmpdir(), "winter-create-recover-"));
    const report = await handle.reconcileRootForRecovery?.(root);
    expect(report?.outcome).toBe("clean");
    expect(report?.transcripts).toEqual([]);
  });
});
