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
import { credentialStoreOverSecretStore } from "../providers/credential-store";
import type { CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import type { SecretStore } from "./secret-store";
import { keychainService } from "../profile";
import { ANTHROPIC_PROFILE_NAME, anthropicConfigDirFor, officialConfigDirFor } from "../runtime-sdk/official-options";

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
 *  wiring (`daemon.ts`, O6) passes nothing and gets `UNAVAILABLE_SDK` until the controller wires the
 *  real `@yanlinglabs/winter-provider-runtime` import after its v0.0.6 publish. */
export interface AnthropicConsoleSdk {
  startAnthropicConsoleBrokerLogin(store: CredentialStore, options: AnthropicLoginOptions): Promise<AnthropicLoginHandle>;
  refreshAnthropicBearer(store: CredentialStore, options: AnthropicLoginOptions): Promise<AnthropicRefreshResult>;
  anthropicConsoleProfileExists(anthropicConfigDir: string, profile: string): boolean;
  logoutAnthropicConsole(store: CredentialStore, options: AnthropicLoginOptions): Promise<void>;
}

/** The refusal reason every async SDK call answers with while no real package is wired — a NAMED,
 *  typed reason (never a raw "not implemented" the caller has to string-match blindly). */
export const CONSOLE_BROKER_UNAVAILABLE_REASON = "console_broker_unavailable";

/**
 * controller wires the real SDK exports after the v0.0.6 publish
 * (`@yanlinglabs/winter-provider-runtime`'s `adapters/anthropic/console-broker.ts`, Lane S).
 * Until then this is what every production `ConsoleProfileBroker` actually calls: the three ASYNC
 * calls a caller already awaits/catches reject with `CONSOLE_BROKER_UNAVAILABLE_REASON`; the one
 * SYNC call (`anthropicConsoleProfileExists`) answers a SAFE, INERT default (`false`) instead of
 * throwing — it runs at daemon BOOT (O6), unconditionally, and a throw there would crash boot
 * rather than simply reporting "no profile yet" (the honest answer before the real SDK exists).
 */
export const UNAVAILABLE_SDK: AnthropicConsoleSdk = {
  startAnthropicConsoleBrokerLogin: () => Promise.reject(new Error(CONSOLE_BROKER_UNAVAILABLE_REASON)),
  refreshAnthropicBearer: () => Promise.reject(new Error(CONSOLE_BROKER_UNAVAILABLE_REASON)),
  anthropicConsoleProfileExists: () => false,
  logoutAnthropicConsole: () => Promise.reject(new Error(CONSOLE_BROKER_UNAVAILABLE_REASON)),
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
  /** Test seam — defaults to `UNAVAILABLE_SDK` (see that constant's own doc). */
  sdk?: AnthropicConsoleSdk;
}

/** 60s before expiry (P10a-4's own rule); on a FAILED refresh, retry after this same window rather
 *  than giving up — the profile/network condition that caused the failure may well have cleared by
 *  then, and a broker that silently stops retrying forever is worse than one that retries too
 *  often. */
const REFRESH_LEAD_MS = 60_000;

export function createConsoleProfileBroker(deps: ConsoleProfileBrokerDeps): ConsoleProfileBroker {
  const sdk = deps.sdk ?? UNAVAILABLE_SDK;
  const store = credentialStoreOverSecretStore(deps.secrets);
  const anthropicConfigDir = anthropicConfigDirFor(deps.home);
  const claudeConfigDir = officialConfigDirFor(deps.home);
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
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

  /** Arms the NEXT fire at the given absolute time (ms since epoch, `now()`'s own units) — never
   *  negative (a past `at` fires as soon as possible, never "in the past"). */
  function armAt(at: number): void {
    if (timer === undefined) return; // stopRefresher() ran while a refresh was in flight
    timer = setT(runOnce, Math.max(0, at - now()));
  }

  /** One refresh attempt, then re-arm: 60s before the fresh `expiresAt` on success, or after a
   *  fixed `REFRESH_LEAD_MS` backoff on a failure/thrown rejection (never a permanent give-up —
   *  see `REFRESH_LEAD_MS`'s own doc). */
  function runOnce(): void {
    doRefresh()
      .then((result) => {
        if (timer === undefined) return; // stopped while this refresh was in flight
        armAt(result.ok && result.expiresAt !== undefined ? result.expiresAt - REFRESH_LEAD_MS : now() + REFRESH_LEAD_MS);
      })
      .catch(() => {
        if (timer === undefined) return;
        armAt(now() + REFRESH_LEAD_MS);
      });
  }

  return {
    async login(onLine: (line: string) => void): Promise<AnthropicLoginHandle> {
      if (!deps.claudeExecutable()) throw new Error("claude_executable_unavailable");
      return sdk.startAnthropicConsoleBrokerLogin(store, optionsFor(onLine));
    },

    profileExists(): boolean {
      return sdk.anthropicConsoleProfileExists(anthropicConfigDir, ANTHROPIC_PROFILE_NAME);
    },

    async refreshBearer(): Promise<AnthropicRefreshResult> {
      return doRefresh();
    },

    async logout(): Promise<void> {
      await sdk.logoutAnthropicConsole(store, optionsFor());
    },

    startRefresher(): void {
      if (timer !== undefined) return;
      timer = "starting"; // closes the re-entrancy window until runOnce's own armAt overwrites it
      runOnce();
    },

    stopRefresher(): void {
      if (typeof timer !== "undefined" && timer !== "starting") clearT(timer);
      timer = undefined;
    },
  };
}
