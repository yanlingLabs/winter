// THE ONE `createRuntimeSdk` handle for the whole daemon (P8b Task 5).
//
// Everything on the Winter leg goes through this object: every session's `query()`, the global
// messaging router, the runtime directory. It is built ONCE at boot (`daemon.ts`, between the
// runtime spine and the tool registry) and disposed ONCE at shutdown — the router's own
// `dispose()` is a use-after-shutdown latch and nothing more (surface map §1.11), so ending the
// live sessions before it is the HOST's job, which is what this module's `dispose()` is.
//
// WHY A WRAPPER RATHER THAN `createRuntimeSdk` AT THE CALL SITE. Three things the daemon has to do
// exactly once, in exactly one place, and that a raw handle cannot carry:
//
//  1. `spawnHookFor(mode)` — P8b-1's single topology site. Path (a) today (one spawned `winter`
//     child per session); when the SDK publishes its engine, path (b) is a change to this one
//     function's return value and nothing else in the daemon moves.
//  2. `trackQuery`/`untrack`/`dispose` — G-14's ordering. Every live `Query` ends BEFORE the router
//     disposes and, in `daemon.ts`, before the 8a spine closes: a draining child's last frames
//     write delivery receipts into `runtime-state.db`, and a closed store loses them.
//  3. The settings-derived options. Norma's hard rule is that no setting may require a restart, but
//     `createRuntimeSdk` takes PLAIN VALUES for retention and the advisor (Norma map §8.3). The two
//     doors this file uses to keep them live are a getter-backed retention object (the router reads
//     the property at recovery time, not at construction) and a resolver closure for the advisor
//     model (re-read on every call). Both are noted at their definitions.
import { existsSync } from "node:fs";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import type { McpSdkServerConfigWithInstance, Query, SpawnClaudeCodeProcess } from "@yanlinglabs/winter-agent-sdk";
import type { AdvisorReviewer, ReviewerResolver } from "@yanlinglabs/winter-agent-sdk/tools";
import { createRuntimeSdk as createRouterSdk } from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeDirectoryOptions, RuntimeDirectoryStore, RuntimeSdk, RuntimeSdkOptions } from "@yanlinglabs/winter-runtime-sdk";
import type { SecretStore } from "../auth/secret-store";
import { retentionFromSettings } from "../runtime-state/retention";
import type { Settings } from "../settings";
import { NORMA_BRAND } from "./brand";
import { resolveWinterExecutable, type WinterExecutableUnavailable } from "./executable";
import { keychainSeamFromSecretStore } from "./keychain";
import { NORMA_PEER_VERSIONS } from "./versions";

/** `RuntimeDirectoryRetention` is not on the router's barrel; this is the same type. */
type RuntimeDirectoryRetention = NonNullable<RuntimeDirectoryOptions["retention"]>;

/** The three session modes, as `agent/tools/registry.ts`'s `Mode` already spells them. */
export type SessionMode = "code" | "dispatch" | "chat";

/**
 * How long `dispose()` waits for ONE live session to end before it stops waiting for that one.
 *
 * ⚠️ TENSION WITH THE APP'S GRACE PERIOD, recorded rather than silently resolved: 8a's
 * `RUNTIME_SHUTDOWN_DRAIN_MS` is 1500 ms precisely because `DaemonSupervisor.gracefulExitTimeout`
 * (2.0 s, `apple/Norma/Sources/App/DaemonSupervisor.swift`) SIGKILLs the daemon after that, and a
 * teardown budgeted above it is force-killed mid-drain with the lock still on disk. 5000 ms is the
 * controller's ruling (P8b-11) and is what ships; in the ordinary case — a child that ends when its
 * prompt queue closes — this costs microseconds, and the budget is only reached by a straggler. A
 * straggler therefore pushes `stop()` past the app's grace. Overridable per call for tests.
 */
export const SHUTDOWN_QUERY_GRACE_MS = 5_000;

/** What `Options` needs to spawn a child (P8b-1). `spawnClaudeCodeProcess` is left to the SDK's
 *  `defaultSpawn` on path (a); path (b) fills it in here and nowhere else. */
export interface WinterSpawnHook {
  pathToClaudeCodeExecutable: string;
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess;
}

export interface NormaRuntimeSdkDeps {
  /** The daemon's `NORMA_HOME`. Winter's home is the SAME directory under `NORMA_BRAND`. */
  home: string;
  /** THE LIVE settings holder — never a boot snapshot. `null` on a daemon whose settings.json
   *  would not parse (the daemon runs with the agent disabled rather than refusing to start). */
  settings: () => Settings | null | undefined;
  secrets: SecretStore;
  /** 8a's SQLite directory store. `undefined` ⇒ the spine is offline and the router falls back to
   *  its own in-memory store: messaging works for this process's lifetime, receipts are not
   *  durable. That is a degraded daemon, never a dead one. */
  directoryStore?: RuntimeDirectoryStore;
  /** Tasks 6–7's capability servers. `[]` is valid and is what Task 5 passes. */
  capabilities: readonly McpSdkServerConfigWithInstance[];
  /**
   * Who reviews, when `settings.runtimes.advisorModel` names a model.
   *
   * NOT WIRED IN 8b, and the honest reason is worth stating: on a Winter-only host the router's
   * `advisor` option is forwarded only into the official leg (surface map §1.8), and the Winter
   * leg's advisor is configured through its own `Options.advisor` instead — so this option is inert
   * either way in this phase. The seam exists so that the shape is right and the model name is
   * already flowing; with no reviewer the resolver answers `undefined`, which is WS-06 §4's
   * ordinary "no reviewer resolvable" tool error and never a throw.
   */
  advisorReviewer?: (model: string) => AdvisorReviewer;
  log?: (line: string) => void;
}

export interface NormaRuntimeSdkOverrides {
  /** Test seam for `SHUTDOWN_QUERY_GRACE_MS`. */
  grace?: number;
  /** Test seam for the router factory — a spy wraps it to capture the `RuntimeSdkOptions` this
   *  file builds while still returning a REAL `RuntimeSdk`. */
  createRuntimeSdk?: (opts: RuntimeSdkOptions) => RuntimeSdk;
}

export interface NormaRuntimeSdk {
  /** The router handle itself. Every later lane reaches `query`/`messaging`/`directory` here. */
  readonly sdk: RuntimeSdk;
  /**
   * P8b-1: THE ONE SITE for the spawn topology, re-resolved on EVERY call.
   *
   * `settings.runtimes.winterExecutable` is hot, so a newly built binary is picked up by the next
   * session with no restart. Returns the typed `WinterExecutableUnavailable` rather than throwing
   * and NEVER falls back to anything — a session on the Winter leg refuses at create instead.
   */
  spawnHookFor(mode: SessionMode): WinterSpawnHook | WinterExecutableUnavailable;
  /** Register a live session so shutdown can end it. `end` closes the prompt queue, awaits the
   *  iteration and aborts a straggler — it is the session's own, and it must be idempotent. */
  trackQuery(sessionId: string, query: Query, end: () => Promise<void>): void;
  /** Forget a session that ended on its own. WITHOUT THIS the map would grow for the daemon's
   *  whole lifetime and shutdown would `end()` sessions that finished hours ago. */
  untrack(sessionId: string): void;
  /**
   * The ONE messaging fact `settings-apply.ts` needs (a retention change can free a name a sender
   * is holding a message for). Task 12 (`runtime-sdk/messaging.ts`) fills this in; until then the
   * hop is a typed no-op and `daemon.ts` already passes the handle, so that task is one line here.
   * Whatever Task 12 widens this to must keep a zero-argument `releaseHeld` — the router's own
   * `messaging.releaseHeld(receiver)` takes an address and is NOT this shape.
   */
  readonly messaging?: { releaseHeld?: () => void | Promise<void> };
  /** G-14: end every tracked session, THEN dispose the router. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * TEMPORARY — the ONE door this file reads the `runtimes` block through.
 *
 * Task 15's `settings.ts` will export `winterOptionsFromSettings(settings)` in a pending fix round;
 * when it lands, delete this helper and call that. Until then the optional chains live here and
 * nowhere else. Blank-is-absent is the convention the whole block shares (`settings.ts`'s own doc:
 * the keys are plain `z.string()` so that clearing a field is never a boot failure).
 */
function winterOptionsFrom(s: Settings | null | undefined): { winterExecutable?: string; advisorModel?: string } {
  return {
    winterExecutable: s?.runtimes?.winterExecutable?.trim() || undefined,
    advisorModel: s?.runtimes?.advisorModel?.trim() || undefined,
  };
}

/**
 * G-12 / P8b-11: retention is passed EXPLICITLY, from the same `retentionFromSettings` door 8a's
 * own sweep reads (absent block ⇒ the shipped 30/7 days).
 *
 * GETTERS, NOT VALUES, and it costs nothing: the router stores this object and reads
 * `retention.deliveries` / `retention.nameLeases` inside `recoverDirectory` (measured — the shipped
 * `dist/index.js` reads the properties at prune time, not at construction), so a settings change
 * reaches the next recovery pass with no restart. Worst case — a router that did snapshot them —
 * this behaves exactly like the plain values it replaces.
 */
function retentionFrom(settings: () => Settings | null | undefined): RuntimeDirectoryRetention {
  return {
    get deliveries(): number { return retentionFromSettings(settings() ?? undefined).deliveriesMs; },
    get nameLeases(): number { return retentionFromSettings(settings() ?? undefined).nameLeasesMs; },
  };
}

/**
 * `settings.runtimes.advisorModel` set ⇒ an `advisor` option whose resolver NAMES that model;
 * unset ⇒ no `advisor` key at all, which is the router's own default standing advisor.
 *
 * The model is re-read inside the resolver, so changing it on a running daemon takes effect at the
 * next review. WHETHER the key exists is fixed at construction, though — the router takes a plain
 * value (Norma map §8.3) — so going from "no advisorModel" to "an advisorModel" on a running daemon
 * does not grow the key. Recorded as a known limit; it costs nothing today because the option is
 * inert on a Winter-only host (see `advisorReviewer` above).
 */
function advisorFrom(deps: NormaRuntimeSdkDeps): { advisor?: NonNullable<RuntimeSdkOptions["advisor"]> } {
  const model = winterOptionsFrom(deps.settings()).advisorModel;
  if (model === undefined) return {};
  const resolveReviewer: ReviewerResolver = () => {
    const live = winterOptionsFrom(deps.settings()).advisorModel ?? model;
    const provider = deps.advisorReviewer?.(live);
    return provider === undefined ? undefined : { provider, model: live };
  };
  return { advisor: { resolveReviewer } };
}

/** Await `end()`, but never longer than `ms`, and never fail because it did. A session that will
 *  not end must not hold the whole daemon's teardown, and a rejecting `end` is a straggler too.
 *
 *  A straggler is LOGGED, because a `stop()` that suddenly takes seconds is otherwise silent and
 *  the operator has nothing to correlate it with — and because passing the grace is the one thing
 *  that can push teardown past the app's own SIGKILL deadline (see `SHUTDOWN_QUERY_GRACE_MS`). */
function endWithin(sessionId: string, end: () => Promise<void>, ms: number, log?: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log?.(`session ${sessionId} did not end within ${ms}ms — disposing anyway`);
      resolve();
    }, ms);
    const done = (): void => { clearTimeout(timer); resolve(); };
    try { void end().then(done, (err: unknown) => { log?.(`session ${sessionId} failed to end: ${(err as Error)?.name ?? "unknown"}`); done(); }); } catch { done(); }
  });
}

export async function createNormaRuntimeSdk(deps: NormaRuntimeSdkDeps, overrides: NormaRuntimeSdkOverrides = {}): Promise<NormaRuntimeSdk> {
  const factory = overrides.createRuntimeSdk ?? createRouterSdk;
  const sdk = factory({
    // A Winter-only host: no `claude` peer in 8b (P8b-4). The namespace is injected as an
    // INSTANCE — the router never imports either SDK by name.
    peers: { winter },
    // P8b-4: host-declared, and the ONLY probe that answers inside a compiled `$bunfs` binary.
    peerVersions: NORMA_PEER_VERSIONS,
    // Required even though the Winter leg resolves its own credentials runtime-side (surface map
    // §1.3): the field has no `?`, and the official leg is the only caller.
    keychain: keychainSeamFromSecretStore(deps.secrets),
    // R-1. Resolved once here, through the injected peer's own `resolveBrand`.
    brand: NORMA_BRAND,
    // 8a's durable store when the spine opened; the router's in-memory default when it did not.
    directoryStore: deps.directoryStore,
    capabilities: deps.capabilities,
    // §1.6: this is what fills `SeamContext.winterHome`, so the barrier and every later seam
    // resolve under the daemon's OWN home. Without it they fall back to
    // `resolveWinterHome(undefined, brand)` — which is `~/.norma` for a daemon booted on a temp
    // home with no `NORMA_HOME` in its environment, i.e. every test. `participants` is 8c's.
    handoff: { winterHome: deps.home },
    // G-12. `official.permissionClass` is deliberately omitted until 8c (C-14): there is no
    // official peer in 8b and it gates inbound delivery to official sessions only.
    messaging: { directory: { retention: retentionFrom(deps.settings) } },
    ...advisorFrom(deps),
  });

  // sessionId → that session's own `end`. Keyed by session so a resumed session replaces its
  // predecessor's entry rather than accumulating one.
  const live = new Map<string, () => Promise<void>>();
  let disposed = false;

  return {
    sdk,
    spawnHookFor(_mode: SessionMode): WinterSpawnHook | WinterExecutableUnavailable {
      const resolution = resolveWinterExecutable({
        setting: winterOptionsFrom(deps.settings()).winterExecutable,
        env: process.env,
        execPath: process.execPath,
        home: deps.home,
        exists: (p) => existsSync(p),
      });
      return resolution.ok ? { pathToClaudeCodeExecutable: resolution.path } : resolution.error;
    },
    trackQuery(sessionId: string, _query: Query, end: () => Promise<void>): void {
      live.set(sessionId, end);
    },
    untrack(sessionId: string): void {
      live.delete(sessionId);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const grace = overrides.grace ?? SHUTDOWN_QUERY_GRACE_MS;
      const ends = [...live.entries()];
      live.clear();
      // ALL of them, in parallel, each under its own budget — then, and only then, the router.
      await Promise.all(ends.map(([sessionId, end]) => endWithin(sessionId, end, grace, deps.log)));
      await sdk.dispose();
    },
  };
}
