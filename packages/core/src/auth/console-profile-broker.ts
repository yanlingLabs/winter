// Winter Phase 10a (O4, P10a-2/4/6) — thin host adapter over the Anthropic Console SDK functions
// (per the user's ruling "the providers system always lives on the agent SDKs, not on the
// daemon"), REVISED to the exact shapes Lane S shipped in
// `packages/provider-runtime/src/adapters/anthropic/console-broker.ts` (branch `p10a/console-
// retire`, commits 7e86f01+77864b2):
//
//   startAnthropicConsoleBrokerLogin(store, options) -> { submitCode(code): Promise<void>;
//     done: Promise<{ok:true;profile:string}|{ok:false;reason:string}> }   (redacts URL query
//     strings in the streamed lines itself — this file does not re-sanitize)
//   refreshAnthropicBearer(store, options) -> Promise<{ok:true;expiresAt:number}|{ok:false;reason:string}>
//   anthropicConsoleProfileExists(anthropicConfigDir, profile) -> boolean
//   logoutAnthropicConsole(store, options) -> Promise<void>
//
// TWO DOORS EXIST in the SDK for starting a login (`startAnthropicConsoleBrokerLogin`'s own handle,
// and `credential-api.ts`'s `startProviderLogin("anthropic", store, options)` with a
// `readConsoleCode` callback folding the two-phase flow into one promise) — this adapter uses the
// HANDLE door: `provider.login` (ipc/server.ts, O6) already starts a login and keeps the returned
// handle for a later `provider.loginCode` to call `submitCode` on, which is a straight match for
// `startAnthropicConsoleBrokerLogin`'s own shape and needed no rework of the already-shipped RPC
// wiring. `startProviderLogin`'s folded-promise shape would need `provider.loginCode` to resolve a
// pending `readConsoleCode` promise instead of calling a handle method — a real alternative, not
// used here.
//
// NO REFRESH TIMER EXISTS IN THE SDK (Lane S's own note: "did not add a timer") — the small
// `setTimeout` loop in `startRefresher`/`stopRefresher` below is HOST lifecycle wiring (deciding
// *when* to call `refreshAnthropicBearer` again), not provider logic, and stays in core under the
// same ruling that moved the spawn/redaction/write logic to the SDK.
//
// P10a integration (v0.0.6 pin flip): `@yanlinglabs/winter-provider-runtime` published these five
// names at 0.0.6 exactly as Lane S described above — wired below as `REAL_SDK`, now the default
// `sdk` dependency. `UNAVAILABLE_SDK` stays as an explicit, still-tested defensive fallback shape
// (never the default any more) rather than being deleted outright.
import fs from "node:fs";
import { join } from "node:path";
import { credentialStoreOverSecretStore } from "../providers/credential-store";
import {
  DEFAULT_ANTHROPIC_CONSOLE_PROFILE,
  anthropicConsoleProfileExists as sdkAnthropicConsoleProfileExists,
  logoutAnthropicConsole as sdkLogoutAnthropicConsole,
  refreshAnthropicBearer as sdkRefreshAnthropicBearer,
  startAnthropicConsoleBrokerLogin as sdkStartAnthropicConsoleBrokerLogin,
  type CredentialStore,
} from "@yanlinglabs/winter-provider-runtime";
import type { SecretStore } from "./secret-store";
import { keychainService } from "../profile";
import { ANTHROPIC_PROFILE_NAME, anthropicConfigDirFor, ensureOfficialConfigDir, officialConfigDirFor } from "../runtime-sdk/official-options";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../runtime-sdk/keychain";

// Tripwire (Winter Phase 10a, v0.0.6 wiring): Winter's own profile name (`ANTHROPIC_PROFILE_NAME`,
// `runtime-sdk/official-options.ts`) is a separate literal from the SDK's own default — they are
// both `"winter"` today by coincidence of the two repos agreeing, not by one importing the other
// (`optionsFor` below always passes `ANTHROPIC_PROFILE_NAME` explicitly, so the SDK's default is
// never actually consulted at runtime). This throws at import time rather than letting the two
// drift silently the day either repo renames its default.
if (DEFAULT_ANTHROPIC_CONSOLE_PROFILE !== ANTHROPIC_PROFILE_NAME) {
  throw new Error(
    `console-profile-broker: ANTHROPIC_PROFILE_NAME (${JSON.stringify(ANTHROPIC_PROFILE_NAME)}) no longer matches ` +
      `@yanlinglabs/winter-provider-runtime's DEFAULT_ANTHROPIC_CONSOLE_PROFILE (${JSON.stringify(DEFAULT_ANTHROPIC_CONSOLE_PROFILE)})`,
  );
}

/** The options bag every SDK function below takes, per Lane S's pinned shape. `claudeExecutable`
 *  is a plain (possibly empty) string rather than `string | undefined` — the HOST decides whether a
 *  missing executable refuses (see `login`'s own guard below) rather than pushing that judgment
 *  call into the SDK function, which has no Winter-specific concept of "unavailable" to refuse
 *  with. */
export interface AnthropicLoginOptions {
  claudeExecutable: string;
  antExecutable?: string;
  anthropicConfigDir: string;
  claudeConfigDir: string;
  profile?: string;
  service?: string;
  onLine?: (line: string) => void;
  spawn?: typeof Bun.spawn;
  now?: () => number;
}

/** `startAnthropicConsoleBrokerLogin`'s own return shape: the login is already RUNNING (stdin
 *  open, per the M2 code-paste protocol) by the time this handle comes back — `submitCode`
 *  supplies the pasted code, `done` resolves once the child actually exits. */
export interface AnthropicLoginHandle {
  submitCode(code: string): Promise<void>;
  done: Promise<{ ok: true; profile: string } | { ok: false; reason: string }>;
}

export interface AnthropicRefreshResult {
  ok: boolean;
  expiresAt?: number;
  reason?: string;
}

/** The SDK surface this adapter drives. Injectable so this file's own tests use a FAKE; production
 *  wiring (`daemon.ts`, O6) passes nothing and gets `REAL_SDK` — the real
 *  `@yanlinglabs/winter-provider-runtime` v0.0.6 exports, wired below. */
export interface AnthropicConsoleSdk {
  startAnthropicConsoleBrokerLogin(store: CredentialStore, options: AnthropicLoginOptions): Promise<AnthropicLoginHandle>;
  refreshAnthropicBearer(store: CredentialStore, options: AnthropicLoginOptions): Promise<AnthropicRefreshResult>;
  anthropicConsoleProfileExists(anthropicConfigDir: string, profile: string): boolean;
  logoutAnthropicConsole(store: CredentialStore, options: AnthropicLoginOptions): Promise<void>;
}

/** The refusal reason every async SDK call answers with while no real package is wired — a NAMED,
 *  typed reason (never a raw "not implemented" the caller has to string-match blindly). Callers
 *  that only need the CODE (e.g. a wire `reason` field) should match on this constant; it is a
 *  substring of every `UNAVAILABLE_SDK` error message below, never the whole message. */
export const CONSOLE_BROKER_UNAVAILABLE_REASON = "console_broker_unavailable";

/** Fix round 1 item 4: the exact package + minimum version `UNAVAILABLE_SDK`'s own error messages
 *  name — confirmed by reading the SDK worktree's own `packages/provider-runtime/package.json`
 *  (name `@yanlinglabs/winter-provider-runtime`; Lane S's `console-broker.ts` ships in it). The
 *  controller bumps this constant only if the carrying package ever changes — the version floor is
 *  "≥ 0.0.6" per the coordinator's own note (the exact tag Lane S's work publishes under). */
const REQUIRED_PROVIDER_RUNTIME = "@yanlinglabs/winter-provider-runtime >= 0.0.6";

function unavailableSdkError(): Error {
  return new Error(`${CONSOLE_BROKER_UNAVAILABLE_REASON}: ${REQUIRED_PROVIDER_RUNTIME} is not installed/wired yet — the controller wires the real import after that package publishes`);
}

/**
 * DEFENSIVE FALLBACK ONLY (Winter Phase 10a, v0.0.6 wiring): `@yanlinglabs/winter-provider-runtime`
 * v0.0.6 IS installed and its `console-broker.ts` exports ARE wired below as `REAL_SDK` — this is no
 * longer the default `sdk` a production broker gets (see `createConsoleProfileBroker`). It is kept,
 * exported, and still covered by tests only as the deliberate "SDK unavailable" shape a caller can
 * still ask for explicitly (`sdk: UNAVAILABLE_SDK`) — e.g. a build that strips the optional peer, or
 * a future defensive check this file does not currently perform. The three ASYNC calls reject with
 * `unavailableSdkError()` (named package + version, never a bare "not implemented"); the one SYNC
 * call (`anthropicConsoleProfileExists`) answers a SAFE, INERT default (`false`) instead of throwing
 * — it runs at daemon BOOT (O6), unconditionally, and a throw there would crash boot.
 */
export const UNAVAILABLE_SDK: AnthropicConsoleSdk = {
  startAnthropicConsoleBrokerLogin: () => Promise.reject(unavailableSdkError()),
  refreshAnthropicBearer: () => Promise.reject(unavailableSdkError()),
  anthropicConsoleProfileExists: () => false,
  logoutAnthropicConsole: () => Promise.reject(unavailableSdkError()),
};

/**
 * THE REAL SDK (Winter Phase 10a, v0.0.6 wiring): `@yanlinglabs/winter-provider-runtime`'s
 * `adapters/anthropic/console-broker.ts` (Lane S), now the default `sdk` dependency for every
 * production `ConsoleProfileBroker` (`createConsoleProfileBroker` below never wires `UNAVAILABLE_SDK`
 * itself — only a caller that passes it explicitly, or a test, does). `startAnthropicConsoleBrokerLogin`
 * returns its handle SYNCHRONOUSLY on the real SDK (`Bun.spawn` can throw before any process exists,
 * per its own doc comment) — wrapped in `Promise.resolve` here only to satisfy this file's
 * pre-existing `AnthropicConsoleSdk` interface, which every caller already awaits.
 */
export const REAL_SDK: AnthropicConsoleSdk = {
  startAnthropicConsoleBrokerLogin: (store, options) => Promise.resolve(sdkStartAnthropicConsoleBrokerLogin(store, options)),
  refreshAnthropicBearer: (store, options) => sdkRefreshAnthropicBearer(store, options),
  anthropicConsoleProfileExists: (anthropicConfigDir, profile) => sdkAnthropicConsoleProfileExists(anthropicConfigDir, profile),
  logoutAnthropicConsole: (store, options) => sdkLogoutAnthropicConsole(store, options),
};

/** The host-facing door `ipc/server.ts` (O6) and `winter login/logout --anthropic-console` (O7)
 *  call — Winter-shaped (no `store`/`options` plumbing visible to a caller). */
export interface ConsoleProfileBroker {
  login(onLine: (line: string) => void): Promise<AnthropicLoginHandle>;
  profileExists(): boolean;
  refreshBearer(): Promise<AnthropicRefreshResult>;
  logout(): Promise<void>;
  /** Refreshes once immediately and re-arms itself 60s before whatever `expiresAt` that (or each
   *  subsequent) refresh reports; a failed attempt retries after a fixed backoff. No-op if already
   *  running (one refresher per broker instance). HOST-OWNED — see this module's own header for
   *  why no equivalent exists on the SDK side. */
  startRefresher(): void;
  stopRefresher(): void;
  /**
   * Winter Phase 10a fix wave (F2): watches the console profile's own credential file for
   * appearing or disappearing, from ANY process or door — a CLI `winter login`/`logout
   * --anthropic-console` (a separate, short-lived process from the daemon), the daemon's own
   * RPC-driven `provider.login`/`provider.logout`, or a human running `ant auth login`/`logout
   * --profile winter` directly — and reacts the same way that door's own call already would:
   * `startRefresher()` (its own seed refresh IS `refreshBearer()`, bundled) on appear, and
   * `stopRefresher()` + deleting the bearer material on disappear.
   *
   * Exists because the CLI's login/logout doors build their OWN, short-lived broker instance in a
   * SEPARATE PROCESS from the daemon (`main.ts`'s own header: "NOT an RPC — the daemon may not
   * even be running") — a daemon that booted before that CLI process ran, or is simply a different
   * process from it, has no other way to learn the profile changed. Idempotent: a second
   * `startWatcher()` while already running, or `stopWatcher()` while already stopped, is a no-op.
   */
  startWatcher(): void;
  stopWatcher(): void;
}

export interface ConsoleProfileBrokerDeps {
  /** WINTER_HOME. */
  home: string;
  claudeExecutable: () => string | undefined;
  antExecutable?: () => string | undefined;
  /** The daemon's OWN SecretStore — bridged to the SDK's `CredentialStore` via
   *  `credentialStoreOverSecretStore` (`providers/credential-store.ts`), the SAME bridge
   *  `providers/manager.ts` already uses for the daemon's own OpenAI/anthropic api-key and
   *  codex-oauth material — one bridge, never a second one duplicated here. */
  secrets: SecretStore;
  now?: () => number;
  /** Test seams for `startRefresher`'s timer — default to the real `setTimeout`/`clearTimeout`. */
  setTimeoutFn?: (fn: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Test/defensive seam — defaults to `REAL_SDK` (the wired `@yanlinglabs/winter-provider-runtime`
   *  v0.0.6 exports); tests pass a fake, and a caller can still pass `UNAVAILABLE_SDK` explicitly
   *  (see that constant's own doc). */
  sdk?: AnthropicConsoleSdk;
  /** Winter Phase 10a fix wave (F2): test seam for the watcher's `fs.watch` call — mirrors
   *  `settings-watcher.ts`'s own `watch?` seam shape exactly. Defaults to the real `fs.watch`. */
  watchDirFn?: (path: string, cb: () => void) => { close(): void };
}

/** 60s before expiry (P10a-4's own rule); on a FAILED refresh, retry after this same window rather
 *  than giving up — the profile/network condition that caused the failure may well have cleared by
 *  then, and a broker that silently stops retrying forever is worse than one that retries too
 *  often. */
const REFRESH_LEAD_MS = 60_000;

/** Winter Phase 10a fix wave (F2): the watcher's debounce window after an `fs.watch` event fires —
 *  short enough to react quickly, long enough to coalesce a burst (e.g. a login writing the profile
 *  file in more than one syscall) into one check. */
const WATCHER_DEBOUNCE_MS = 500;

/** Winter Phase 10a fix wave (F2): the watcher's fallback poll interval — self-heals against a
 *  missed or coalesced `fs.watch` event (macOS `fs.watch` is not perfectly reliable) without being
 *  so frequent it is meaningfully more expensive than the `fs.watch` path itself. */
const WATCHER_POLL_MS = 60_000;

/**
 * Winter Phase 10a fix wave (M3-clamp): `armAt`'s own floor on the NEXT fire delay — never sooner
 * than this, regardless of how close (or already past) the computed `at` is. Two independent
 * failure modes land here: (1) `expires_at`'s UNIT was never actually measured against a real
 * profile (the ledger's own open doubt) — `normalizeExpiresAtMs` below handles a seconds-unit
 * value, but a genuinely malformed/garbage value could still compute an `at` far in the past; (2)
 * even a correctly-computed `at` a few seconds from `now()` (a profile refreshed just under the
 * 60s `REFRESH_LEAD_MS` window) would otherwise re-arm almost immediately, and if THAT refresh
 * again returns a near-expired token, the broker tight-loops calling `ant`/the SDK. 30s is short
 * enough that a legitimately fast-expiring token still gets refreshed well ahead of time, and long
 * enough that a malformed timestamp can never turn into a hot loop.
 */
const MIN_REARM_DELAY_MS = 30_000;

/**
 * Winter Phase 10a fix wave (M3-clamp): `expires_at`/`AnthropicRefreshResult.expiresAt`'s unit was
 * never actually measured against a real console profile — the ledger's own open doubt ("expires_at
 * unit assumed ms"). A SECONDS-since-epoch value (`ant`'s underlying JSON field, and many OAuth
 * token responses generally) would otherwise be treated as ms and compute an `at` roughly 1000x too
 * soon — every SECONDS-unit epoch value for decades on either side of "now" is many orders of
 * magnitude below 1e12 ms-since-epoch (year 2001), and every genuine ms-since-epoch value for the
 * foreseeable future is comfortably above it, so this is an unambiguous discriminator, never a
 * heuristic that could misfire on a real value.
 */
function normalizeExpiresAtMs(expiresAt: number): number {
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

export function createConsoleProfileBroker(deps: ConsoleProfileBrokerDeps): ConsoleProfileBroker {
  const sdk = deps.sdk ?? REAL_SDK;
  const store = credentialStoreOverSecretStore(deps.secrets);
  const anthropicConfigDir = anthropicConfigDirFor(deps.home);
  const claudeConfigDir = officialConfigDirFor(deps.home);
  const now = deps.now ?? Date.now;
  // Belt-and-braces (fix round 1 item 2): the REAL timer is `unref()`'d so a forgotten
  // `stopRefresher()` can never by itself keep the daemon process alive — `stop()` still calls it
  // explicitly (see `daemon.ts`) for a clean, immediate shutdown rather than waiting on the next
  // event-loop turn's unref to matter. Injected fake timers (tests) are untouched — this branch
  // only ever runs the real `setTimeout`.
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearT = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const optionsFor = (onLine?: (line: string) => void): AnthropicLoginOptions => {
    const ant = deps.antExecutable?.();
    return {
      claudeExecutable: deps.claudeExecutable() ?? "",
      ...(ant === undefined ? {} : { antExecutable: ant }),
      anthropicConfigDir,
      claudeConfigDir,
      profile: ANTHROPIC_PROFILE_NAME,
      service: keychainService(),
      ...(onLine === undefined ? {} : { onLine }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    };
  };

  async function doRefresh(): Promise<AnthropicRefreshResult> {
    return sdk.refreshAnthropicBearer(store, optionsFor());
  }

  // `undefined` = not running; a real timer handle = running and waiting; the string "starting" =
  // running but the seeding refresh hasn't resolved yet (closes the window where a second
  // `startRefresher()` call during that gap would start a SECOND chain).
  let timer: unknown | "starting" | undefined;

  /** Arms the NEXT fire at the given absolute time (ms since epoch, `now()`'s own units) — clamped
   *  to `MIN_REARM_DELAY_MS` (M3-clamp), never merely `>= 0`: a past or near-past `at` (a malformed
   *  timestamp, or a token refreshed just under the lead window) fires no sooner than the floor,
   *  never "as soon as possible". */
  function armAt(at: number): void {
    if (timer === undefined) return; // stopRefresher() ran while a refresh was in flight
    timer = setT(runOnce, Math.max(MIN_REARM_DELAY_MS, at - now()));
  }

  /** One refresh attempt, then re-arm: 60s before the fresh `expiresAt` on success (its unit
   *  normalised first — M3-clamp), or after a fixed `REFRESH_LEAD_MS` backoff on a failure/thrown
   *  rejection (never a permanent give-up — see `REFRESH_LEAD_MS`'s own doc). */
  function runOnce(): void {
    doRefresh()
      .then((result) => {
        if (timer === undefined) return; // stopped while this refresh was in flight
        armAt(result.ok && result.expiresAt !== undefined ? normalizeExpiresAtMs(result.expiresAt) - REFRESH_LEAD_MS : now() + REFRESH_LEAD_MS);
      })
      .catch(() => {
        if (timer === undefined) return;
        armAt(now() + REFRESH_LEAD_MS);
      });
  }

  // Winter Phase 10a fix wave (F2): the console profile's own credentials directory —
  // `<anthropicConfigDir>/credentials/` — is what the watcher below watches, and what `login()`/
  // `logout()` (both now `ant`-driven, per the corrected P10a-6 design) need present before either
  // door spawns anything.
  const credentialsDir = join(anthropicConfigDir, "credentials");
  const watchDir = deps.watchDirFn ?? ((p: string, cb: () => void) => {
    const w = fs.watch(p, () => cb());
    return { close: () => w.close() };
  });

  // Watcher state — deliberately separate from the refresh timer's own `timer` slot above (a
  // different concern: THIS is "has the profile appeared/disappeared", not "when to refresh next").
  let watcherRunning = false;
  let watchHandle: { close(): void } | undefined;
  let debounceTimer: unknown;
  let pollTimer: unknown;
  let watcherKnownExists = false;

  function watcherProfileExists(): boolean {
    return sdk.anthropicConsoleProfileExists(anthropicConfigDir, ANTHROPIC_PROFILE_NAME);
  }

  /**
   * The level-triggered core: recompute presence and react ONLY on an actual flip — never on every
   * fs event/poll tick (a burst of unrelated writes inside `credentialsDir`, or a poll landing
   * while nothing changed, must not re-fire `startRefresher()`/re-delete already-deleted material).
   * Appear -> `startRefresherImpl()` (its own seed refresh already IS `refreshBearer()`, bundled —
   * see that function's own doc). Disappear -> `stopRefresherImpl()` + delete the bearer material
   * via the SAME `store.delete` the SDK's own `logoutAnthropicConsole` would call — NEVER by
   * spawning `logoutAnthropicConsole`/`ant auth logout` again here: either this disappearance IS
   * this broker's OWN `logout()` call (which already ran that spawn once — a second one is pure
   * waste) or it is an external removal with nothing left to log out of (a spawn against an
   * already-gone profile is pointless at best).
   */
  function reactToPresenceChange(): void {
    if (!watcherRunning) return;
    const exists = watcherProfileExists();
    if (exists === watcherKnownExists) return;
    watcherKnownExists = exists;
    if (exists) {
      startRefresherImpl();
    } else {
      stopRefresherImpl();
      void store.delete({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME }).catch(() => {});
    }
  }

  function schedulePoll(): void {
    if (!watcherRunning) return;
    pollTimer = setT(() => {
      reactToPresenceChange();
      schedulePoll();
    }, WATCHER_POLL_MS);
  }

  function onFsEvent(): void {
    if (!watcherRunning) return;
    if (debounceTimer !== undefined) clearT(debounceTimer);
    debounceTimer = setT(() => {
      debounceTimer = undefined;
      reactToPresenceChange();
    }, WATCHER_DEBOUNCE_MS);
  }

  return {
    async login(onLine: (line: string) => void): Promise<AnthropicLoginHandle> {
      // Fix wave (F2 corrected design): the single login door is `ant auth login --profile
      // winter` (SDK 0.0.8, in flight) — `claude auth login --console` was measured NOT to write
      // the profile file at all (it mints a Console API key into CLAUDE_CONFIG_DIR instead), so
      // `antExecutable`, not `claudeExecutable`, is what this door actually needs resolved.
      if (!deps.antExecutable?.()) throw new Error("ant_executable_unavailable");
      // Winter Phase 10a fix wave (M4): harden `anthropicConfigDirFor(home)` 0700 BEFORE the
      // login child ever spawns — `official-session.ts`'s `open()` only ensures this directory
      // for a session actually launched on the console arm, which (per C1-interim) never happens
      // against the pinned router yet; without this, the very first `winter login
      // --anthropic-console` could hand the login a config dir that does not exist at all, or one
      // left over-permissive by something else. Same helper, same 0700 shape as every other caller
      // of `ensureOfficialConfigDir` — never a second, hand-rolled mkdir/chmod.
      ensureOfficialConfigDir(anthropicConfigDir);
      return sdk.startAnthropicConsoleBrokerLogin(store, optionsFor(onLine));
    },

    profileExists(): boolean {
      return sdk.anthropicConsoleProfileExists(anthropicConfigDir, ANTHROPIC_PROFILE_NAME);
    },

    async refreshBearer(): Promise<AnthropicRefreshResult> {
      return doRefresh();
    },

    async logout(): Promise<void> {
      // Fix wave (F2 corrected design): same single door as login() above — `logout()` also needs
      // `ant` resolved BEFORE any spawn, never a partial/best-effort logout that clears Winter's
      // own bearer material while leaving `ant`'s own on-disk profile dangling (the exact stale-
      // access shape `OfficialConsoleProfileMissing`, F3, exists to keep closed).
      if (!deps.antExecutable?.()) throw new Error("ant_executable_unavailable");
      // Fix round 1 item 1: a signed-out profile has nothing left to refresh — running
      // `stopRefresher()` FIRST (before the SDK call, which may itself throw) guarantees the timer
      // is never left ticking against a profile this call is in the middle of tearing down,
      // regardless of whether `logoutAnthropicConsole` itself succeeds.
      stopRefresherImpl();
      await sdk.logoutAnthropicConsole(store, optionsFor());
    },

    startRefresher(): void {
      startRefresherImpl();
    },

    stopRefresher(): void {
      stopRefresherImpl();
    },

    startWatcher(): void {
      if (watcherRunning) return;
      watcherRunning = true;
      ensureOfficialConfigDir(credentialsDir);
      watcherKnownExists = watcherProfileExists();
      try {
        watchHandle = watchDir(credentialsDir, onFsEvent);
      } catch {
        // fs.watch can throw synchronously (e.g. the dir vanished between the mkdir above and
        // here) — the poll below is a complete fallback on its own, so this is never fatal.
        watchHandle = undefined;
      }
      schedulePoll();
    },

    stopWatcher(): void {
      watcherRunning = false;
      watchHandle?.close();
      watchHandle = undefined;
      if (debounceTimer !== undefined) { clearT(debounceTimer); debounceTimer = undefined; }
      if (pollTimer !== undefined) { clearT(pollTimer); pollTimer = undefined; }
    },
  };

  function startRefresherImpl(): void {
    if (timer !== undefined) return;
    timer = "starting"; // closes the re-entrancy window until runOnce's own armAt overwrites it
    runOnce();
  }

  function stopRefresherImpl(): void {
    if (typeof timer !== "undefined" && timer !== "starting") clearT(timer);
    timer = undefined;
  }
}
