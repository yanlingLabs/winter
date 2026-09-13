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
}

/** 60s before expiry (P10a-4's own rule); on a FAILED refresh, retry after this same window rather
 *  than giving up — the profile/network condition that caused the failure may well have cleared by
 *  then, and a broker that silently stops retrying forever is worse than one that retries too
 *  often. */
const REFRESH_LEAD_MS = 60_000;

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

  return {
    async login(onLine: (line: string) => void): Promise<AnthropicLoginHandle> {
      if (!deps.claudeExecutable()) throw new Error("claude_executable_unavailable");
      // Winter Phase 10a fix wave (M4): harden `anthropicConfigDirFor(home)` 0700 BEFORE the
      // login child ever spawns — `official-session.ts`'s `open()` only ensures this directory
      // for a session actually launched on the console arm, which (per C1-interim) never happens
      // against the pinned router yet; without this, the very first `winter login
      // --anthropic-console` could hand `claude auth login --console` a config dir that does not
      // exist at all, or one left over-permissive by something else. Same helper, same 0700 shape
      // as every other caller of `ensureOfficialConfigDir` — never a second, hand-rolled mkdir/chmod.
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
