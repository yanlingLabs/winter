// Winter Phase 10a (O4) — thin host adapter over Lane S's SDK functions, so its tests exercise
// WIRING against a FAKE `AnthropicConsoleSdk` — never a stub binary, never a real spawn. Lane S's
// own SDK repo tests the actual spawn/redaction behaviour; nothing here duplicates that. The
// refresh TIMER, however, is host-owned (no equivalent exists on the SDK side — see
// console-profile-broker.ts's own header), so it IS tested here, over a fake clock.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { readCredentialMaterial, writeCredentialMaterial } from "../../src/auth/credential-material";
import { credentialStoreOverSecretStore } from "../../src/providers/credential-store";
import { anthropicConfigDirFor, ANTHROPIC_PROFILE_NAME } from "../../src/runtime-sdk/official-options";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import {
  CONSOLE_BROKER_UNAVAILABLE_REASON,
  createConsoleProfileBroker,
  REAL_SDK,
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

/** A scripted `setTimeout`/`clearTimeout` pair: `fire()` runs the LATEST scheduled callback
 *  synchronously (simulating the clock reaching that delay), `delays` records every scheduled delay
 *  in order, and `cleared` records every handle passed to `clearTimeoutFn`. */
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

/**
 * Winter Phase 10a fix wave (F2): a fake `fs.watch` seam — records every registration, and lets a
 * test fire the LATEST one's callback directly (simulating a real fs event) without ever touching
 * a real filesystem watch. `closedCount` proves `stopWatcher()` actually closes the handle.
 */
function fakeWatchDir() {
  const registrations: { path: string; cb: () => void }[] = [];
  let closedCount = 0;
  const watchDirFn = (path: string, cb: () => void): { close(): void } => {
    registrations.push({ path, cb });
    return { close: () => { closedCount++; } };
  };
  const trigger = (): void => { registrations.at(-1)?.cb(); };
  return { watchDirFn, trigger, registrations, get closedCount() { return closedCount; } };
}

/**
 * Winter Phase 10a fix wave (F2): unlike `fakeTimers()` above (one pending slot — fine for the
 * refresh timer alone), the watcher can have its OWN debounce timer and poll timer pending AT THE
 * SAME TIME as each other (and, once a refresh actually runs, the refresh timer's own re-arm) — so
 * this tracks every pending timer and lets a test fire the one scheduled with a SPECIFIC delay
 * (`WATCHER_DEBOUNCE_MS` vs `WATCHER_POLL_MS` are distinct literals, so this disambiguates without
 * needing handle identity at the call site). Every watcher test below arranges its fake
 * `refreshAnthropicBearer` to never resolve, so no re-arm timer is ever scheduled to collide with
 * `WATCHER_POLL_MS` — see those tests' own comments.
 */
function fakeMultiTimers() {
  let nextId = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const cleared: unknown[] = [];
  const setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const id = ++nextId;
    pending.set(id, { fn, ms });
    return id;
  };
  const clearTimeoutFn = (h: unknown): void => { cleared.push(h); pending.delete(h as number); };
  const fireByDelay = async (ms: number): Promise<void> => {
    const entry = [...pending.entries()].find(([, e]) => e.ms === ms);
    if (entry === undefined) throw new Error(`fakeMultiTimers: no pending timer with delay ${ms} (pending: ${[...pending.values()].map((e) => e.ms).join(",")})`);
    pending.delete(entry[0]);
    entry[1].fn();
    await flush();
  };
  return { setTimeoutFn, clearTimeoutFn, fireByDelay, cleared, pendingDelays: () => [...pending.values()].map((e) => e.ms) };
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

// Fix wave 3 (M-A): every test in this file that actually reaches the SDK through `login()`/
// `logout()` needs `requiredWinterAgentSdkVersion: "0.0.9"` — the REAL pin is 0.0.7 today, below
// `CONSOLE_BROKER_SDK_MIN`, so without this override BOTH doors refuse
// `console_broker_sdk_unsupported` before ever reaching anything this file is actually testing (the
// dedicated gate describe block below covers that refusal itself). A plain object spread at each
// call site, not a shared default in `fakeSdk()`/a helper, so every test's own deps stay legible on
// their own.
const SDK_SUPPORTS_CONSOLE_BROKER = { requiredWinterAgentSdkVersion: "0.0.9" };

describe("createConsoleProfileBroker — login", () => {
  // Fix wave (F2 corrected design): the single login door is `ant auth login --profile winter`.
  test("refuses ant_executable_unavailable WITHOUT ever calling the sdk, once the version gate is satisfied", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")), sdk, ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    await expect(broker.login(() => {})).rejects.toThrow("ant_executable_unavailable");
    expect(calls).toEqual([]);
  });

  // Winter Phase 10a fix wave (M4): `official-session.ts`'s `open()` only ensures
  // `anthropicConfigDirFor(home)` for a session actually launched on the console arm — which (per
  // C1-interim) the pinned router refuses before that point is ever reached — so `login()` itself
  // must harden the directory, or the very first `winter login --anthropic-console` could hand
  // `ant auth login` a config dir that does not exist yet.
  test("login() creates AND hardens anthropicConfigDirFor(home) to 0700 before spawning", async () => {
    const home = freshHome();
    const dir = anthropicConfigDirFor(home);
    expect(existsSync(dir)).toBe(false);
    const { sdk } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk, ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    await broker.login(() => {});
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("login() re-hardens an already-existing, more-permissive anthropicConfigDirFor(home)", async () => {
    const home = freshHome();
    const dir = anthropicConfigDirFor(home);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    const { sdk } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk, ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    await broker.login(() => {});
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("calls sdk.startAnthropicConsoleBrokerLogin(store, options) with the right paths, profile, and onLine forwarded — options carry no claudeExecutable/claudeConfigDir at all (M-A)", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const lines: string[] = [];
    const onLine = (l: string) => lines.push(l);
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant",
      secrets: new FileSecretStore(join(home, "secrets")), sdk, ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    const handle = await broker.login(onLine);
    expect(calls.length).toBe(1);
    expect(calls[0]!.fn).toBe("startAnthropicConsoleBrokerLogin");
    const [, options] = calls[0]!.args as [unknown, AnthropicLoginOptions];
    expect(options.antExecutable).toBe("/bin/ant");
    expect(options.anthropicConfigDir).toBe(anthropicConfigDirFor(home));
    expect(options.profile).toBe(ANTHROPIC_PROFILE_NAME);
    expect(options.onLine).toBe(onLine);
    expect("claudeExecutable" in options).toBe(false);
    expect("claudeConfigDir" in options).toBe(false);
    // The handle the fake sdk returned is threaded straight back to the caller.
    expect(await handle.done).toEqual({ ok: true, profile: ANTHROPIC_PROFILE_NAME });
  });

  // Fix wave (F2 corrected design): moved off `login()` — omitting `antExecutable` now makes
  // `login()` refuse outright (its own describe block above), so `options` is never even built.
  // `refreshBearer()`'s door is UNCHANGED by this fix wave ("refresh is unchanged" — the
  // coordinator's own words) and still silently omits the field when unresolved, so that is the
  // one this premise is actually about.
  test("antExecutable is OMITTED from refreshBearer's options (not even undefined) when the resolver isn't supplied", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    await broker.refreshBearer();
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
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk, ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    const handle = await broker.login(() => {});
    await handle.submitCode("123456");
    expect(submitted).toEqual(["123456"]);
  });
});

// Winter Phase 10a fix wave 3 (M-A): the version gate `login()`/`logout()` both check FIRST, before
// even the antExecutable check — same F1 pattern as `official-options.ts`'s router-version gate:
// compared against the COMPILE-TIME PIN (`REQUIRED_WINTER_AGENT_SDK`), never a runtime probe.
// "Today it refuses, because the pin is 0.0.7" (the coordinator's own words) — the REAL, no-override
// pin case below pins exactly that, so this suite fails the moment someone bumps
// `REQUIRED_WINTER_AGENT_SDK` without ALSO raising `CONSOLE_BROKER_SDK_MIN` to match, or vice versa.
describe("createConsoleProfileBroker — the console-broker-SDK version gate (M-A)", () => {
  test("the REAL pin (0.0.9 since integration 3, no override) is at the floor, so login() and logout() both reach the sdk", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    await broker.login(() => {});
    await broker.logout();
    expect(calls.some((c) => c.fn === "startAnthropicConsoleBrokerLogin")).toBe(true);
    expect(calls.some((c) => c.fn === "logoutAnthropicConsole")).toBe(true);
  });

  test("a stubbed pin below the floor (0.0.8 — the daemon skips it) still refuses", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk,
      requiredWinterAgentSdkVersion: "0.0.8",
    });
    await expect(broker.login(() => {})).rejects.toThrow("console_broker_sdk_unsupported");
    expect(calls).toEqual([]);
  });

  test("a stubbed pin AT the floor (0.0.9) lets login() reach the sdk", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk,
      requiredWinterAgentSdkVersion: "0.0.9",
    });
    await broker.login(() => {});
    expect(calls.some((c) => c.fn === "startAnthropicConsoleBrokerLogin")).toBe(true);
  });

  test("a stubbed pin ABOVE the floor (0.0.10 — numeric, never lexicographic, comparison) also lets it reach the sdk", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk,
      requiredWinterAgentSdkVersion: "0.0.10",
    });
    await broker.logout();
    expect(calls.some((c) => c.fn === "logoutAnthropicConsole")).toBe(true);
  });

  test("refreshBearer() is completely unaffected by this gate — refresh is unchanged", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, secrets: new FileSecretStore(join(home, "secrets")), sdk });
    await broker.refreshBearer();
    expect(calls.some((c) => c.fn === "refreshAnthropicBearer")).toBe(true);
  });
});

describe("createConsoleProfileBroker — profileExists / refreshBearer / logout", () => {
  test("profileExists() forwards to sdk.anthropicConsoleProfileExists(anthropicConfigDir, profile) synchronously", () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, secrets: new FileSecretStore(join(home, "secrets")), sdk });
    expect(broker.profileExists()).toBe(true);
    expect(calls).toEqual([{ fn: "anthropicConsoleProfileExists", args: [anthropicConfigDirFor(home), ANTHROPIC_PROFILE_NAME] }]);
  });

  test("refreshBearer() forwards to sdk.refreshAnthropicBearer(store, options) and returns its result verbatim", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, secrets: new FileSecretStore(join(home, "secrets")), sdk });
    const result = await broker.refreshBearer();
    expect(result).toEqual({ ok: true, expiresAt: 123 });
    expect(calls[0]!.fn).toBe("refreshAnthropicBearer");
  });

  test("logout() forwards to sdk.logoutAnthropicConsole(store, options) and awaits it — options carry the resolved antExecutable (F2)", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk, ...SDK_SUPPORTS_CONSOLE_BROKER });
    await broker.logout();
    expect(calls[0]!.fn).toBe("logoutAnthropicConsole");
    const [, options] = calls[0]!.args as [unknown, AnthropicLoginOptions];
    expect(options.antExecutable).toBe("/bin/ant");
  });

  // Fix wave (F2 corrected design): logout() now needs ant resolved before any spawn (past the
  // M-A version gate, which this override satisfies so the test is about the ANT check, not that one).
  test("logout() refuses ant_executable_unavailable WITHOUT ever calling the sdk", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, secrets: new FileSecretStore(join(home, "secrets")), sdk, ...SDK_SUPPORTS_CONSOLE_BROKER });
    await expect(broker.logout()).rejects.toThrow("ant_executable_unavailable");
    expect(calls).toEqual([]);
  });

  // Fix round 1 item 1: a signed-out profile must never keep refreshing itself.
  test("logout() stops the refresher — no further timer firings on the fake clock", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
      ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    broker.startRefresher();
    await flush();
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(1);
    expect(timers.delays.length).toBe(1); // the seed refresh armed a next fire

    await broker.logout();
    expect(timers.cleared.length).toBe(1); // the pending timer was cleared, not left ticking

    // Starting a NEW refresher afterward still works (logout does not permanently wedge the
    // broker) — but nothing from the OLD chain ever fires again.
    broker.startRefresher();
    await flush();
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(2);
  });

  test("logout() stops the refresher even when logoutAnthropicConsole itself rejects", async () => {
    const home = freshHome();
    const timers = fakeTimers();
    const { sdk } = fakeSdk({ logoutAnthropicConsole: async () => { throw new Error("boom"); } });
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
      ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    broker.startRefresher();
    await flush();
    await expect(broker.logout()).rejects.toThrow("boom");
    expect(timers.cleared.length).toBe(1);
  });
});

// Winter Phase 10a fix wave (M3-clamp): `normalizeExpiresAtMs` discriminates seconds-vs-ms by
// comparing against a real-epoch-scale threshold (1e12 ms ~ year 2001) — so every test in this
// describe block that asserts an EXACT re-arm delay must use a REALISTIC (>1e12) `now`/`expiresAt`
// pair, never the small round numbers convenient elsewhere in this file (`1_000_000` et al. would
// themselves be misread as a seconds-unit value and multiplied by 1000). The delta between `now`
// and `expiresAt` — never their absolute scale — is what every delay assertion below actually
// pins, so shifting both by the same REALISTIC_NOW base changes nothing about what each test proves.
const REALISTIC_NOW = 1_700_000_000_000;

describe("createConsoleProfileBroker — startRefresher / stopRefresher (host-owned timer, fake clock)", () => {
  test("startRefresher() refreshes IMMEDIATELY, then arms the next fire 60s before the returned expiresAt", async () => {
    const home = freshHome();
    let now = REALISTIC_NOW;
    const { sdk, calls } = fakeSdk({ refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return { ok: true, expiresAt: now + 120_000 }; } });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
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
      home, secrets: new FileSecretStore(join(home, "secrets")),
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
    const expiries = [REALISTIC_NOW + 60_000, REALISTIC_NOW + 130_000]; // seed + one re-fire
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => ({ ok: true, expiresAt: expiries[call++] }) });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => REALISTIC_NOW, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    // M3-clamp: (REALISTIC_NOW + 60_000) - 60_000 - REALISTIC_NOW = 0, floored to
    // MIN_REARM_DELAY_MS (30_000) — never fires "as soon as possible" any more (see the dedicated
    // clamp test below for why).
    expect(timers.delays).toEqual([30_000]);
    await timers.fire();
    expect(timers.delays).toEqual([30_000, 70_000]); // (REALISTIC_NOW + 130_000) - 60_000 - REALISTIC_NOW, well above the floor
  });

  // Winter Phase 10a fix wave (M3-clamp): a computed re-arm delay of 0 (or negative) is exactly
  // the tight-loop risk the floor exists to prevent — a profile that keeps coming back
  // near-expired must never turn into a hot loop of refresh calls.
  test("M3-clamp: a computed delay of 0 (expiresAt exactly REFRESH_LEAD_MS away) is floored to MIN_REARM_DELAY_MS, never 0", async () => {
    const home = freshHome();
    // REALISTIC_NOW + 60_000 - 60_000 - REALISTIC_NOW = 0
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => ({ ok: true, expiresAt: REALISTIC_NOW + 60_000 }) });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => REALISTIC_NOW, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    expect(timers.delays).toEqual([30_000]);
  });

  // Winter Phase 10a fix wave (M3-clamp): a GENUINELY PAST expiresAt (e.g. clock skew, or a
  // malformed timestamp) must also floor to MIN_REARM_DELAY_MS — never fire immediately, which
  // would tight-loop against a broken profile.
  test("M3-clamp: an already-past expiresAt is floored to MIN_REARM_DELAY_MS, never a negative/zero delay", async () => {
    const home = freshHome();
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => ({ ok: true, expiresAt: REALISTIC_NOW - 500_000 }) }); // WAY before now()
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => REALISTIC_NOW, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    expect(timers.delays).toEqual([30_000]);
  });

  // Winter Phase 10a fix wave (M3-clamp): `expires_at`'s unit was never measured against a real
  // profile — a SECONDS-since-epoch value (this broker's own `now()` is always ms) must be
  // normalised to ms BEFORE the lead-time subtraction, or a seconds-unit profile would re-arm
  // ~1000x too soon (immediately, in practice, since any real seconds-unit timestamp is far
  // smaller than any real ms-unit `now()`).
  test("M3-clamp: a SECONDS-unit expiresAt is normalised to ms before the lead-time subtraction", async () => {
    const home = freshHome();
    const nowMs = 1_700_000_000_000; // a real ms-since-epoch `now` (year ~2023)
    const expiresAtSeconds = nowMs / 1000 + 120; // 120s from now, in SECONDS (well under the 1e12 threshold)
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => ({ ok: true, expiresAt: expiresAtSeconds }) });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => nowMs, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    // Normalised to ms: (nowMs + 120_000) - 60_000 - nowMs = 60_000 — NOT the ~1000x-too-soon
    // delay a raw seconds-as-ms misread would compute (which would floor to MIN_REARM_DELAY_MS
    // instead, making this assertion the one that actually distinguishes the two).
    expect(timers.delays).toEqual([60_000]);
  });

  // A genuine ms-unit expiresAt (comfortably above the 1e12 threshold for any real timestamp)
  // must be left untouched by the normalisation — this is the sibling proof to the seconds test
  // above, over the SAME code path.
  test("M3-clamp: a genuine ms-unit expiresAt is left untouched by the normalisation", async () => {
    const home = freshHome();
    const nowMs = 1_700_000_000_000;
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => ({ ok: true, expiresAt: nowMs + 120_000 }) });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => nowMs, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    expect(timers.delays).toEqual([60_000]);
  });

  test("a failed refresh retries after a fixed backoff rather than giving up", async () => {
    const home = freshHome();
    const results: AnthropicRefreshResult[] = [{ ok: false, reason: "ant_exit_1" }, { ok: true, expiresAt: 2_000_000 }];
    let call = 0;
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => results[call++]! });
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
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
      home, secrets: new FileSecretStore(join(home, "secrets")),
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
      home, secrets: new FileSecretStore(join(home, "secrets")),
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
    const broker = createConsoleProfileBroker({ home, secrets: new FileSecretStore(join(home, "secrets")), sdk });
    expect(() => broker.stopRefresher()).not.toThrow();
  });

  // Fix round 1 item 2: repeated calls (a duplicate shutdown-path stop, a manual stop before
  // logout's own internal one, etc.) must stay safe and never clear an already-cleared/stale handle.
  test("stopRefresher() is idempotent — repeated calls never throw and never double-clear", async () => {
    const home = freshHome();
    const { sdk } = fakeSdk();
    const timers = fakeTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    await flush();
    broker.stopRefresher();
    expect(timers.cleared.length).toBe(1);
    expect(() => broker.stopRefresher()).not.toThrow();
    expect(() => broker.stopRefresher()).not.toThrow();
    expect(timers.cleared.length).toBe(1); // no second clear — nothing left to clear
  });

  test("stopRefresher() called WHILE the seed refresh is still in flight prevents the first arm entirely", async () => {
    const home = freshHome();
    const timers = fakeTimers();
    let resolveRefresh!: (r: AnthropicRefreshResult) => void;
    const { sdk } = fakeSdk({ refreshAnthropicBearer: () => new Promise((resolve) => { resolveRefresh = resolve; }) });
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, now: () => 1_000_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startRefresher();
    broker.stopRefresher(); // the "starting" sentinel — clearTimeoutFn is never called for it
    resolveRefresh({ ok: true, expiresAt: 2_000_000 });
    await flush();
    expect(timers.delays).toEqual([]); // no timer was ever armed
  });
});

describe("UNAVAILABLE_SDK — explicit defensive fallback (no longer the default now that v0.0.6 is wired)", () => {
  test("the async calls reject with CONSOLE_BROKER_UNAVAILABLE_REASON, never a raw/unnamed error", async () => {
    const home = freshHome();
    // antExecutable + the version-gate override supplied so logout()'s own guards don't
    // short-circuit before ever reaching the SDK's own unavailable rejection — this test is about
    // THAT rejection, not either guard.
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets: new FileSecretStore(join(home, "secrets")), sdk: UNAVAILABLE_SDK,
      ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    await expect(broker.refreshBearer()).rejects.toThrow(CONSOLE_BROKER_UNAVAILABLE_REASON);
    await expect(broker.logout()).rejects.toThrow(CONSOLE_BROKER_UNAVAILABLE_REASON);
  });

  test("profileExists() answers a SAFE inert default rather than throwing — it must never crash daemon boot", () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")), sdk: UNAVAILABLE_SDK,
    });
    expect(broker.profileExists()).toBe(false);
  });

  test("startRefresher()/stopRefresher() never throw even though every refresh attempt rejects", async () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")), sdk: UNAVAILABLE_SDK,
    });
    expect(() => broker.startRefresher()).not.toThrow();
    await flush();
    expect(() => broker.stopRefresher()).not.toThrow();
  });

  test("UNAVAILABLE_SDK is exported directly, so a caller can identify the not-yet-wired state without constructing a broker", () => {
    expect(UNAVAILABLE_SDK.anthropicConsoleProfileExists("x", "winter")).toBe(false);
  });
});

describe("REAL_SDK — the default now that @yanlinglabs/winter-provider-runtime v0.0.6 is installed", () => {
  test("createConsoleProfileBroker's default sdk is REAL_SDK, not UNAVAILABLE_SDK — profileExists() no longer answers the inert default for a real (if nonexistent) config dir", () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({ home, secrets: new FileSecretStore(join(home, "secrets")) });
    // REAL_SDK's anthropicConsoleProfileExists is a plain file-exists check; a fresh temp home has
    // no credentials file yet, so this still reads `false` — but for a DIFFERENT reason than
    // UNAVAILABLE_SDK's hardcoded stub, which the next assertion distinguishes directly.
    expect(broker.profileExists()).toBe(false);
    expect(REAL_SDK).not.toBe(UNAVAILABLE_SDK);
    expect(REAL_SDK.anthropicConsoleProfileExists).not.toBe(UNAVAILABLE_SDK.anthropicConsoleProfileExists);
  });

  test("REAL_SDK's async calls are wired to the installed package, not the UNAVAILABLE_SDK rejection", async () => {
    const home = freshHome();
    const store = credentialStoreOverSecretStore(new FileSecretStore(join(home, "secrets")));
    // No `antExecutable` supplied: the real SDK's own typed "not installed/resolved" answer (never
    // a spawn, never CONSOLE_BROKER_UNAVAILABLE_REASON) — proving REAL_SDK, not UNAVAILABLE_SDK, is
    // actually in the loop.
    await expect(REAL_SDK.refreshAnthropicBearer(store, {
      anthropicConfigDir: join(home, "anthropic-config"),
    })).resolves.toEqual({ ok: false, reason: expect.stringContaining("ant") });
  });
});

// Winter Phase 10a fix wave (F2): the watcher — reacts to the console profile appearing/
// disappearing from ANY process/door, not just the one this broker instance's own login()/
// logout() ran. Every test below arranges `refreshAnthropicBearer` to never resolve UNLESS a test
// specifically needs a real re-arm timer to prove `stopRefresher()` clears it (the one disappear
// test) — see `fakeMultiTimers`'s own doc for why that avoids a delay collision with
// `WATCHER_POLL_MS`. `500`/`60000` below mirror the source's own private `WATCHER_DEBOUNCE_MS`/
// `WATCHER_POLL_MS` constants (not exported — these tests observe behavior, not the constants).
describe("createConsoleProfileBroker — startWatcher / stopWatcher (F2)", () => {
  test("startWatcher() creates AND hardens <anthropicConfigDir>/credentials/ to 0700, and registers on it", () => {
    const home = freshHome();
    const credentialsDir = join(anthropicConfigDirFor(home), "credentials");
    expect(existsSync(credentialsDir)).toBe(false);
    const { sdk } = fakeSdk();
    const watch = fakeWatchDir();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn,
    });
    broker.startWatcher();
    expect(existsSync(credentialsDir)).toBe(true);
    expect(statSync(credentialsDir).mode & 0o777).toBe(0o700);
    expect(watch.registrations).toEqual([{ path: credentialsDir, cb: expect.any(Function) }]);
  });

  test("profile appears via an fs.watch event (debounced) -> refreshBearer runs and the refresher starts", async () => {
    const home = freshHome();
    let exists = false;
    const { sdk, calls } = fakeSdk({
      anthropicConsoleProfileExists: () => exists,
      refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return new Promise<AnthropicRefreshResult>(() => {}); },
    });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startWatcher();
    exists = true; // e.g. `ant auth login --profile winter`, run by a totally separate process
    watch.trigger();
    await timers.fireByDelay(500); // the debounce window elapses
    expect(calls.length).toBe(0); // fix wave 3 (M-B): not yet — the CONFIRM check hasn't fired
    await timers.fireByDelay(1_000); // the confirm window elapses, presence still reads `true`
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(1);
    // The refresher is now marked running (its seed refresh never resolves in this fake, so it
    // stays "starting" forever) — a direct startRefresher() call afterward is a no-op, proving the
    // watcher's OWN reaction is what started it, not a coincidence of the test calling it directly.
    broker.startRefresher();
    await flush();
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(1);
  });

  // Fix wave 3 (Minor, M-B): a flicker shorter than the confirm window (e.g. `ant` momentarily
  // unlinking and recreating the profile file as part of its own refresh) must never be treated as
  // a real transition — the confirm check re-reads presence, and a reverted flicker reads as
  // unchanged from `watcherKnownExists`, so nothing fires.
  test("a transient appearance that reverts before the confirm window elapses fires nothing", async () => {
    const home = freshHome();
    let exists = false;
    const { sdk, calls } = fakeSdk({
      anthropicConsoleProfileExists: () => exists,
      refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return new Promise<AnthropicRefreshResult>(() => {}); },
    });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startWatcher();
    exists = true; // flickers on
    watch.trigger();
    await timers.fireByDelay(500);
    exists = false; // ...and reverts BEFORE the confirm check ever runs
    await timers.fireByDelay(1_000);
    expect(calls.length).toBe(0); // never treated as a real transition
  });

  test("profile appears via the poll fallback alone (no fs.watch event at all) -> refreshBearer runs and the refresher starts", async () => {
    const home = freshHome();
    let exists = false;
    const { sdk, calls } = fakeSdk({
      anthropicConsoleProfileExists: () => exists,
      refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return new Promise<AnthropicRefreshResult>(() => {}); },
    });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startWatcher();
    exists = true;
    // Never call watch.trigger() — only the poll (armed by startWatcher() itself) ever fires.
    await timers.fireByDelay(60_000);
    expect(calls.length).toBe(0); // fix wave 3 (M-B): the poll is no longer undebounced/unconfirmed
    await timers.fireByDelay(1_000); // the confirm window elapses, presence still reads `true`
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(1);
  });

  test("profile disappears -> stopRefresher runs and the anthropic:console bearer material is deleted (never anthropic:default), WITHOUT spawning logoutAnthropicConsole again", async () => {
    const home = freshHome();
    let exists = true;
    const secrets = new FileSecretStore(join(home, "secrets"));
    // Fix wave 3 (M-B): seed BOTH accounts — the console bearer (what the watcher should delete)
    // AND the user's own api-key (what it must NEVER touch), proving the watcher discriminates by
    // account, not by "any anthropic material".
    await writeCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, { kind: "bearer", token: "tok" });
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-untouched" });
    const { sdk, calls } = fakeSdk({
      anthropicConsoleProfileExists: () => exists,
      refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return { ok: true, expiresAt: REALISTIC_NOW + 150_000 }; },
    });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets,
      sdk, now: () => REALISTIC_NOW, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    // Simulate daemon.ts's own boot-time call (profile already exists) BEFORE the watcher starts —
    // a REAL re-arm timer this test can prove gets cleared, distinct from the watcher's own poll.
    broker.startRefresher();
    await flush();
    expect(timers.pendingDelays()).toContain(90_000); // 150_000 - REFRESH_LEAD_MS (60_000)
    broker.startWatcher(); // captures watcherKnownExists = true; no false transition
    expect(timers.pendingDelays()).toContain(60_000); // the watcher's own poll, now also pending

    exists = false; // e.g. `winter logout --anthropic-console`, run by a totally separate process
    watch.trigger();
    await timers.fireByDelay(500);
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME)).not.toBeNull(); // fix wave 3 (M-B): not yet — awaiting confirm
    await timers.fireByDelay(1_000); // the confirm window elapses, presence still reads `false`

    expect(timers.pendingDelays()).not.toContain(90_000); // the refresh re-arm was cleared
    expect(timers.pendingDelays()).toContain(60_000); // the watcher's OWN poll is unaffected
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME)).toBeNull();
    // The api-key slot is a COMPLETELY different account — never touched by this reaction.
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME)).toEqual({ kind: "api-key", key: "sk-ant-untouched" });
    expect(calls.every((c) => c.fn !== "logoutAnthropicConsole")).toBe(true);
  });

  // Fix wave 3 (M-B): a delete must never fire when there is nothing of the right KIND to delete —
  // an absent account, or (defensively) an account holding some other kind, both leave the slot
  // alone rather than calling `store.delete` unconditionally.
  test("profile disappears with NO console material ever stored -> the delete is a harmless no-op", async () => {
    const home = freshHome();
    let exists = true;
    const secrets = new FileSecretStore(join(home, "secrets"));
    const { sdk } = fakeSdk({ anthropicConsoleProfileExists: () => exists });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets, sdk, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startWatcher();
    exists = false;
    watch.trigger();
    await timers.fireByDelay(500);
    await timers.fireByDelay(1_000);
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME)).toBeNull();
  });

  test("stopWatcher() closes the fs.watch handle and cancels a pending debounce AND the poll timer", async () => {
    const home = freshHome();
    const { sdk } = fakeSdk({ refreshAnthropicBearer: async () => new Promise<AnthropicRefreshResult>(() => {}) });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startWatcher();
    expect(watch.closedCount).toBe(0);
    watch.trigger(); // arm a pending debounce timer too, not just the poll
    expect(timers.pendingDelays().sort()).toEqual([500, 60_000]);
    broker.stopWatcher();
    expect(watch.closedCount).toBe(1);
    expect(timers.pendingDelays()).toEqual([]);
  });

  test("startWatcher() is idempotent — a second call does not re-register fs.watch", () => {
    const home = freshHome();
    const { sdk } = fakeSdk();
    const watch = fakeWatchDir();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn,
    });
    broker.startWatcher();
    broker.startWatcher();
    expect(watch.registrations.length).toBe(1);
  });

  test("a burst of fs.watch events within the debounce window coalesces into ONE reaction", async () => {
    const home = freshHome();
    let exists = false;
    const { sdk, calls } = fakeSdk({
      anthropicConsoleProfileExists: () => exists,
      refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return new Promise<AnthropicRefreshResult>(() => {}); },
    });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startWatcher();
    exists = true;
    watch.trigger();
    watch.trigger();
    watch.trigger();
    // Each trigger cleared the previous debounce timer and armed a fresh one — only ONE is ever
    // actually pending at a time, not three.
    expect(timers.pendingDelays().filter((d) => d === 500).length).toBe(1);
    await timers.fireByDelay(500);
    await timers.fireByDelay(1_000); // the confirm window elapses, presence still reads `true`
    expect(calls.filter((c) => c.fn === "refreshAnthropicBearer").length).toBe(1);
  });

  test("starting the watcher when the profile ALREADY exists captures that as the baseline — no false 'appeared' reaction from starting, nor from a no-op fs event afterward", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk({
      anthropicConsoleProfileExists: () => true, // already present when the watcher starts
      refreshAnthropicBearer: async () => { calls.push({ fn: "refreshAnthropicBearer", args: [] }); return new Promise<AnthropicRefreshResult>(() => {}); },
    });
    const watch = fakeWatchDir();
    const timers = fakeMultiTimers();
    const broker = createConsoleProfileBroker({
      home, secrets: new FileSecretStore(join(home, "secrets")),
      sdk, watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    broker.startWatcher();
    expect(calls.length).toBe(0); // no refresh just from starting
    watch.trigger(); // presence unchanged (still true) — a no-op fs event
    await timers.fireByDelay(500);
    expect(calls.length).toBe(0);
  });
});

// Winter Phase 10a fix wave 3 (M-B): the pinned end-to-end proof the coordinator asked for by
// name — the user's OWN `anthropic:default` api-key material must read back BYTE-IDENTICAL after a
// full console lifecycle runs alongside it (login, a refresh that writes the console bearer, the
// watcher noticing an external disappearance, and logout()) — never merely "not deleted", but the
// exact same `CredentialMaterial` object at every checkpoint.
describe("createConsoleProfileBroker — M-B: the api-key slot survives a full console lifecycle byte-identical", () => {
  test("anthropic:default survives login -> refresh -> watcher-disappear -> logout", async () => {
    const home = freshHome();
    const secrets = new FileSecretStore(join(home, "secrets"));
    const apiKeyMaterial = { kind: "api-key" as const, key: "sk-ant-untouched" };
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, apiKeyMaterial);

    let exists = false;
    const timers = fakeMultiTimers();
    const watch = fakeWatchDir();
    const { sdk } = fakeSdk({
      startAnthropicConsoleBrokerLogin: async () => {
        exists = true; // the real `ant auth login` would have just written the profile file
        return { submitCode: async () => {}, done: Promise.resolve({ ok: true, profile: ANTHROPIC_PROFILE_NAME }) };
      },
      anthropicConsoleProfileExists: () => exists,
      refreshAnthropicBearer: async () => {
        // The real SDK writes the console bearer material as a SIDE EFFECT of a successful
        // refresh (its own doc: "writes the bearer material anthropic:console") — simulated here.
        await writeCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, { kind: "bearer", token: "bearer-tok" });
        return { ok: true, expiresAt: REALISTIC_NOW + 150_000 };
      },
      logoutAnthropicConsole: async () => { exists = false; },
    });
    const broker = createConsoleProfileBroker({
      home, antExecutable: () => "/bin/ant", secrets, sdk, now: () => REALISTIC_NOW,
      watchDirFn: watch.watchDirFn, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
      ...SDK_SUPPORTS_CONSOLE_BROKER,
    });
    broker.startWatcher();

    await broker.login(() => {});
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME)).toEqual(apiKeyMaterial);
    // Let the watcher itself catch up to the appear (its own `watcherKnownExists` started `false`,
    // captured at `startWatcher()` time, BEFORE this login ran) — otherwise the disappear check
    // below sees no transition at all (`false === false`) and never arms a confirm.
    watch.trigger();
    await timers.fireByDelay(500);
    await timers.fireByDelay(1_000);

    await broker.refreshBearer();
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME)).toEqual({ kind: "bearer", token: "bearer-tok" });
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME)).toEqual(apiKeyMaterial);

    // The watcher notices an EXTERNAL disappearance (e.g. `winter logout --anthropic-console` run
    // from a separate process) — confirm-delayed, same as every other watcher test in this file.
    exists = false;
    watch.trigger();
    await timers.fireByDelay(500);
    await timers.fireByDelay(1_000);
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME)).toBeNull();
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME)).toEqual(apiKeyMaterial);

    await broker.logout();
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME)).toEqual(apiKeyMaterial);
  });
});
