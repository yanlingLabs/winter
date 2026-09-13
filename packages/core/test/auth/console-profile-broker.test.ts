// Winter Phase 10a (O4) — thin host adapter over Lane S's SDK functions, so its tests exercise
// WIRING against a FAKE `AnthropicConsoleSdk` — never a stub binary, never a real spawn. Lane S's
// own SDK repo tests the actual spawn/redaction behaviour; nothing here duplicates that. The
// refresh TIMER, however, is host-owned (no equivalent exists on the SDK side — see
// console-profile-broker.ts's own header), so it IS tested here, over a fake clock.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { anthropicConfigDirFor, ANTHROPIC_PROFILE_NAME, officialConfigDirFor } from "../../src/runtime-sdk/official-options";
import {
  CONSOLE_BROKER_UNAVAILABLE_REASON,
  createConsoleProfileBroker,
  UNAVAILABLE_SDK,
  type AnthropicConsoleSdk,
  type AnthropicLoginHandle,
  type AnthropicLoginOptions,
  type AnthropicRefreshResult,
} from "../../src/auth/console-profile-broker";

const roots: string[] = [];
function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), "winter-console-broker-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Drains the microtask queue past any depth a `.then()`/`async` chain can create — a fixed count
 *  of `await Promise.resolve()` calls is fragile (it depends on exactly how many `.then()` hops the
 *  implementation happens to use); yielding to a real macrotask via `setTimeout(0)` is robust
 *  regardless. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake `AnthropicConsoleSdk` that records every call it receives, so tests assert on the
 *  options/args this door built without any real process ever spawning. */
function fakeSdk(overrides: Partial<AnthropicConsoleSdk> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string, args: unknown[]) => calls.push({ fn, args });
  const sdk: AnthropicConsoleSdk = {
    startAnthropicConsoleBrokerLogin: async (store, options) => {
      record("startAnthropicConsoleBrokerLogin", [store, options]);
      return { submitCode: async () => {}, done: Promise.resolve({ ok: true, profile: ANTHROPIC_PROFILE_NAME }) };
    },
    refreshAnthropicBearer: async (store, options) => {
      record("refreshAnthropicBearer", [store, options]);
      return { ok: true, expiresAt: 123 };
    },
    anthropicConsoleProfileExists: (dir, profile) => {
      record("anthropicConsoleProfileExists", [dir, profile]);
      return true;
    },
    logoutAnthropicConsole: async (store, options) => {
      record("logoutAnthropicConsole", [store, options]);
    },
    ...overrides,
  };
  return { sdk, calls };
}

describe("createConsoleProfileBroker — login", () => {
  test("refuses claude_executable_unavailable WITHOUT ever calling the sdk", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => undefined, secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    await expect(broker.login(() => {})).rejects.toThrow("claude_executable_unavailable");
    expect(calls).toEqual([]);
  });

  test("calls sdk.startAnthropicConsoleBrokerLogin(store, options) with the right paths, profile, and onLine forwarded", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const lines: string[] = [];
    const onLine = (l: string) => lines.push(l);
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", antExecutable: () => "/bin/ant",
      secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    const handle = await broker.login(onLine);
    expect(calls.length).toBe(1);
    expect(calls[0]!.fn).toBe("startAnthropicConsoleBrokerLogin");
    const [, options] = calls[0]!.args as [unknown, AnthropicLoginOptions];
    expect(options.claudeExecutable).toBe("/bin/claude");
    expect(options.antExecutable).toBe("/bin/ant");
    expect(options.anthropicConfigDir).toBe(anthropicConfigDirFor(home));
    expect(options.claudeConfigDir).toBe(officialConfigDirFor(home));
    expect(options.profile).toBe(ANTHROPIC_PROFILE_NAME);
    expect(options.onLine).toBe(onLine);
    // The handle the fake sdk returned is threaded straight back to the caller.
    expect(await handle.done).toEqual({ ok: true, profile: ANTHROPIC_PROFILE_NAME });
  });

  test("antExecutable is OMITTED from options (not even undefined) when the resolver isn't supplied", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    await broker.login(() => {});
    const options = calls[0]!.args[1] as AnthropicLoginOptions;
    expect("antExecutable" in options).toBe(false);
  });

  test("submitCode on the returned handle is the sdk's own — this door does not intercept it", async () => {
    const home = freshHome();
    const submitted: string[] = [];
    const { sdk } = fakeSdk({
      startAnthropicConsoleBrokerLogin: async (): Promise<AnthropicLoginHandle> => ({
        submitCode: async (code) => { submitted.push(code); },
        done: Promise.resolve({ ok: true, profile: ANTHROPIC_PROFILE_NAME }),
      }),
    });
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    const handle = await broker.login(() => {});
    await handle.submitCode("123456");
    expect(submitted).toEqual(["123456"]);
  });
});

describe("createConsoleProfileBroker — profileExists / refreshBearer / logout", () => {
  test("profileExists() forwards to sdk.anthropicConsoleProfileExists(anthropicConfigDir, profile) synchronously", () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => undefined, secrets: new FileSecretStore(join(home, "secrets")), sdk });
    expect(broker.profileExists()).toBe(true);
    expect(calls).toEqual([{ fn: "anthropicConsoleProfileExists", args: [anthropicConfigDirFor(home), ANTHROPIC_PROFILE_NAME] }]);
  });

  test("refreshBearer() forwards to sdk.refreshAnthropicBearer(store, options) and returns its result verbatim", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    const result = await broker.refreshBearer();
    expect(result).toEqual({ ok: true, expiresAt: 123 });
    expect(calls[0]!.fn).toBe("refreshAnthropicBearer");
  });

  test("logout() forwards to sdk.logoutAnthropicConsole(store, options) and awaits it", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    await broker.logout();
    expect(calls[0]!.fn).toBe("logoutAnthropicConsole");
  });
});

describe("createConsoleProfileBroker — startRefresher / stopRefresher (host-owned timer, fake clock)", () => {
  /** A scripted `setTimeout`/`clearTimeout` pair: `fire()` runs the LATEST scheduled callback
   *  synchronously (simulating the clock reaching that delay), `delays` records every scheduled
   *  delay in order, and `cleared` records every handle passed to `clearTimeoutFn`. */
  function fakeTimers() {
    const delays: number[] = [];
    const cleared: unknown[] = [];
    let pending: (() => void) | undefined;
    let nextHandle = 0;
    const setTimeoutFn = (fn: () => void, ms: number): unknown => {
      delays.push(ms);
      pending = fn;
      return ++nextHandle;
    };
    const clearTimeoutFn = (h: unknown): void => { cleared.push(h); };
    const fire = async (): Promise<void> => {
      const fn = pending;
      pending = undefined;
      fn?.();
      // Let the refresh promise chain (`doRefresh().then(...)`) settle before the caller inspects
      // `delays`/re-fires.
      await flush();
    };
    return { delays, cleared, setTimeoutFn, clearTimeoutFn, fire };
  }

  test("startRefresher() refreshes IMMEDIATELY, then arms the next fire 60s before the returned expiresAt", async () => {
    const home = freshHome();
    let now = 1_000_000;
    const { sdk, calls } = fakeSdk({ refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return { ok: true, expiresAt: now + 120_000 }; } });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => now, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush(); // let the seed refresh's promise settle
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(1);
    expect(timers.delays).toEqual([60_000]); // 120_000 - 60_000 (REFRESH_LEAD_MS)
  });

  test("a second startRefresher() before stopRefresher() is a no-op — never a second refresh chain", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 0, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    broker.startRefresher();
    await flush();
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(1);
  });

  test("each successive fire re-arms based on ITS OWN fresh expiresAt", async () => {
    const home = freshHome();
    let call = 0;
    const expiries = [1_060_000, 1_130_000]; // seed + one re-fire
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => ({ ok: true, expiresAt: expiries[call++] }) });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    expect(timers.delays).toEqual([0]); // 1_060_000 - 60_000 - 1_000_000 = 0 (clamped, not negative)
    await timers.fire();
    expect(timers.delays).toEqual([0, 70_000]); // 1_130_000 - 60_000 - 1_000_000
  });

  test("a failed refresh retries after a fixed backoff rather than giving up", async () => {
    const home = freshHome();
    const results: AnthropicRefreshResult[] = [{ ok: false, reason: "ant_exit_1" }, { ok: true, expiresAt: 2_000_000 }];
    let call = 0;
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => results[call++]! });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    expect(timers.delays).toEqual([60_000]); // backoff, not a permanent stop
  });

  test("a rejected refresh (thrown) ALSO retries after the same backoff", async () => {
    const home = freshHome();
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => { throw new Error("boom"); } });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    expect(timers.delays).toEqual([60_000]);
  });

  test("stopRefresher() clears the pending timer and allows a fresh chain to start again", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    broker.stopRefresher();
    expect(timers.cleared.length).toBe(1);
    broker.startRefresher();
    await flush();
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(2);
  });

  test("stopRefresher() with no refresher running is a harmless no-op", () => {
    const home = freshHome();
    const { sdk } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    expect(() => broker.stopRefresher()).not.toThrow();
  });

  test("stopRefresher() called WHILE the seed refresh is still in flight prevents the first arm entirely", async () => {
    const home = freshHome();
    const timers = fakeTimers();
    let resolveRefresh!: (r: AnthropicRefreshResult) => void;
    const { sdk } = fakeSdk({ refreshAnthropicBearer: () => new Promise((resolve) => { resolveRefresh = resolve; }) });
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    broker.stopRefresher(); // the "starting" sentinel — clearTimeoutFn is never called for it
    resolveRefresh({ ok: true, expiresAt: 2_000_000 });
    await flush();
    expect(timers.delays).toEqual([]); // no timer was ever armed
  });
});

describe("UNAVAILABLE_SDK — the default before the real package publishes (controller wires it after v0.0.6)", () => {
  test("the async calls reject with CONSOLE_BROKER_UNAVAILABLE_REASON, never a raw/unnamed error", async () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")) });
    await expect(broker.refreshBearer()).rejects.toThrow(CONSOLE_BROKER_UNAVAILABLE_REASON);
    await expect(broker.logout()).rejects.toThrow(CONSOLE_BROKER_UNAVAILABLE_REASON);
  });

  test("profileExists() answers a SAFE inert default rather than throwing — it must never crash daemon boot", () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")) });
    expect(broker.profileExists()).toBe(false);
  });

  test("startRefresher()/stopRefresher() never throw even though every refresh attempt rejects", async () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")) });
    expect(() => broker.startRefresher()).not.toThrow();
    await flush();
    expect(() => broker.stopRefresher()).not.toThrow();
  });

  test("UNAVAILABLE_SDK is exported directly, so a caller can identify the not-yet-wired state without constructing a broker", () => {
    expect(UNAVAILABLE_SDK.anthropicConsoleProfileExists("x", "winter")).toBe(false);
  });
});
