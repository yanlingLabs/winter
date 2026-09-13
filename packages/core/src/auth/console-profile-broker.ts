// Winter Phase 10a (O4, P10a-2/P10a-4/P10a-6) — REVISED per the user's ruling "the providers system
// always lives on the agent SDKs, not on the daemon" (2026-09-13): this module is a THIN HOST
// ADAPTER, never a spawner. Every actual `claude`/`ant` spawn, stdout/stderr line streaming, bearer
// write, and refresh timer lives in the SDK repo (`@yanlinglabs/winter-provider-runtime`'s
// `adapters/anthropic/console-oauth.ts`, Lane S) as five free functions: `startProviderLogin`,
// `refreshAnthropicBearer`, `anthropicConsoleProfileExists`, `logoutAnthropicConsole`,
// `createAnthropicBearerRefresher`. This file's only job is to build the `options`/`store` those
// functions need from Winter's own daemon state (`home`, the resolved executables, the Keychain)
// and call through an INJECTABLE `sdk` dependency, so:
//
//   - this module's own tests exercise the WIRING (right function, right args, right threading of
//     the returned handle) against a FAKE `AnthropicConsoleSdk` — never a stub binary, never a real
//     spawn, and never a second copy of Lane S's own spawn/redaction/timer logic;
//   - production gets the real functions once `@yanlinglabs/winter-provider-runtime` publishes them
//     (pinned version TBD — the controller wires the real import at that point; see
//     `UNAVAILABLE_SDK` below, which is what runs until then).
import { credentialStoreOverSecretStore } from "../providers/credential-store";
import type { CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import type { SecretStore } from "./secret-store";
import { keychainService } from "../profile";
import { ANTHROPIC_PROFILE_NAME, anthropicConfigDirFor, officialConfigDirFor } from "../runtime-sdk/official-options";

/** The options bag every one of the five SDK functions below takes, per the coordinator's pinned
 *  shape. `claudeExecutable` is a plain (possibly empty) string rather than `string | undefined` —
 *  the HOST decides whether a missing executable refuses (see `login`'s own guard below) rather
 *  than pushing that judgment call into the SDK function, which has no Winter-specific concept of
 *  "unavailable" to refuse with. */
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

/** `startProviderLogin`'s own return shape (coordinator's message): the login is already RUNNING
 *  (stdin open, per the M2 code-paste protocol) by the time this handle comes back — `submitCode`
 *  supplies the pasted code, `done` resolves once the child actually exits. */
export interface AnthropicLoginHandle {
  submitCode(code: string): Promise<void>;
  done: Promise<{ ok: true; profile: string } | { ok: false; reason: string }>;
}

export interface AnthropicBearerRefresher {
  start(): void;
  stop(): void;
}

export interface AnthropicRefreshResult {
  ok: boolean;
  expiresAt?: number;
}

/** The SDK surface this adapter drives. Injectable so this file's own tests use a FAKE; production
 *  wiring (`daemon.ts`, O6) passes nothing and gets `UNAVAILABLE_SDK` until the controller wires the
 *  real package import. */
export interface AnthropicConsoleSdk {
  startProviderLogin(provider: "anthropic", store: CredentialStore, options: AnthropicLoginOptions): Promise<AnthropicLoginHandle>;
  refreshAnthropicBearer(store: CredentialStore, options: AnthropicLoginOptions): Promise<AnthropicRefreshResult>;
  anthropicConsoleProfileExists(anthropicConfigDir: string, profile: string): boolean;
  logoutAnthropicConsole(store: CredentialStore, options: AnthropicLoginOptions): Promise<void>;
  createAnthropicBearerRefresher(
    store: CredentialStore,
    options: AnthropicLoginOptions,
    clock: { now?: () => number; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (handle: unknown) => void },
  ): AnthropicBearerRefresher;
}

/** The refusal reason every async SDK call answers with while no real package is wired — a NAMED,
 *  typed reason (never a raw "not implemented" the caller has to string-match blindly). */
export const CONSOLE_BROKER_UNAVAILABLE_REASON = "console_broker_unavailable";

/**
 * controller wires the real SDK exports after the v0.0.6 publish (`@yanlinglabs/winter-provider-runtime`
 * `adapters/anthropic/console-oauth.ts`, Lane S). Until then this is what every production
 * `ConsoleProfileBroker` actually calls: the two ASYNC calls a caller already awaits/catches
 * (`login`/`refreshBearer`/`logout`) reject with `CONSOLE_BROKER_UNAVAILABLE_REASON`; the two SYNC
 * calls (`anthropicConsoleProfileExists`, `createAnthropicBearerRefresher`) answer with a SAFE,
 * INERT default instead of throwing — `profileExists()` runs at daemon BOOT (O6), unconditionally,
 * and a throw there would crash boot rather than simply reporting "no profile yet" (the honest
 * answer before the real SDK exists at all).
 */
export const UNAVAILABLE_SDK: AnthropicConsoleSdk = {
  startProviderLogin: () => Promise.reject(new Error(CONSOLE_BROKER_UNAVAILABLE_REASON)),
  refreshAnthropicBearer: () => Promise.reject(new Error(CONSOLE_BROKER_UNAVAILABLE_REASON)),
  anthropicConsoleProfileExists: () => false,
  logoutAnthropicConsole: () => Promise.reject(new Error(CONSOLE_BROKER_UNAVAILABLE_REASON)),
  createAnthropicBearerRefresher: () => ({ start: () => {}, stop: () => {} }),
};

/** The host-facing door `ipc/server.ts` (O6) and `winter login --anthropic-console` (O7) call —
 *  Winter-shaped (no `store`/`options` plumbing visible to a caller), everything else identical in
 *  spirit to the plan's original pinned interface. `startRefresher`/`stopRefresher` replace the
 *  original `scheduleRefresh` free function (superseded by this same-shaped scope change): the SDK
 *  owns the actual timer now, this door only starts/stops the ONE refresher instance it owns. */
export interface ConsoleProfileBroker {
  login(onLine: (line: string) => void): Promise<AnthropicLoginHandle>;
  profileExists(): boolean;
  refreshBearer(): Promise<AnthropicRefreshResult>;
  logout(): Promise<void>;
  /** No-op if already running (one refresher per broker instance — same "one login at a time"
   *  precedent the plan's own O4 brief stated for the pre-scope-change design). */
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
  /** Test seam — defaults to `UNAVAILABLE_SDK` (see that constant's own doc). */
  sdk?: AnthropicConsoleSdk;
}

export function createConsoleProfileBroker(deps: ConsoleProfileBrokerDeps): ConsoleProfileBroker {
  const sdk = deps.sdk ?? UNAVAILABLE_SDK;
  const store = credentialStoreOverSecretStore(deps.secrets);
  const anthropicConfigDir = anthropicConfigDirFor(deps.home);
  const claudeConfigDir = officialConfigDirFor(deps.home);
  let refresher: AnthropicBearerRefresher | undefined;

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

  return {
    async login(onLine: (line: string) => void): Promise<AnthropicLoginHandle> {
      if (!deps.claudeExecutable()) throw new Error("claude_executable_unavailable");
      return sdk.startProviderLogin("anthropic", store, optionsFor(onLine));
    },

    profileExists(): boolean {
      return sdk.anthropicConsoleProfileExists(anthropicConfigDir, ANTHROPIC_PROFILE_NAME);
    },

    async refreshBearer(): Promise<AnthropicRefreshResult> {
      return sdk.refreshAnthropicBearer(store, optionsFor());
    },

    async logout(): Promise<void> {
      await sdk.logoutAnthropicConsole(store, optionsFor());
    },

    startRefresher(): void {
      if (refresher) return;
      refresher = sdk.createAnthropicBearerRefresher(store, optionsFor(), { now: deps.now });
      refresher.start();
    },

    stopRefresher(): void {
      refresher?.stop();
      refresher = undefined;
    },
  };
}
