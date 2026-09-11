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
import type { McpSdkServerConfigWithInstance, SpawnClaudeCodeProcess } from "@yanlinglabs/winter-agent-sdk";
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
 * How long `dispose()` waits for ONE live session to end before it aborts that one.
 *
 * 300 ms, AND THE NUMBER IS ARITHMETIC, not taste (P8b-32). The whole of teardown has to fit inside
 * `DaemonSupervisor.gracefulExitTimeout` — 2.0 s, `apple/Norma/Sources/App/DaemonSupervisor.swift` —
 * after which the app SIGKILLs the daemon; a teardown that overruns is killed mid-drain, so
 * `lock.release()` never runs, the socket file is left on disk, and the supervisor drops to
 * `.connectOnly` on the next launch. 8a already spends 1500 ms of that budget on its own deletion
 * drain (`RUNTIME_SHUTDOWN_DRAIN_MS`), and the two are SEQUENTIAL in `daemon.ts`'s `stop()`:
 *
 *     SHUTDOWN_QUERY_GRACE_MS (300) + RUNTIME_SHUTDOWN_DRAIN_MS (1500) = 1800 < 2000
 *
 * `create.test.ts` asserts that inequality, so the next edit to either number trips a test instead
 * of shipping a stale socket. In the ordinary case — a child that ends when its prompt queue closes
 * — this costs microseconds; the budget is only reached by a straggler, and a straggler is ABORTED
 * rather than merely abandoned (G-14's "aborts stragglers"). Overridable per call for tests.
 */
export const SHUTDOWN_QUERY_GRACE_MS = 300;

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
  /**
   * Register a live session so shutdown can end it — GRACEFULLY FIRST, THEN BY FORCE.
   *
   * `end` is the session's own graceful teardown (close the prompt queue, await the iteration); it
   * must be idempotent. `abort` is the session's `AbortController` — the same one its `Options`
   * carry — and it is what makes G-14's "aborts stragglers" true rather than delegated: if `end`
   * has not resolved when the grace expires, `dispose()` calls `abort.abort()` itself. That matters
   * because Winter's `Query` has NO `close()`: once this process stops holding the session, nothing
   * can reach the child again, and the cost G-14 names is a leaked child surviving the daemon.
   *
   * Registering after `dispose()` has run is refused (and the query aborted immediately) rather
   * than silently recorded — an entry added to a drained map would never be ended at all.
   */
  trackQuery(sessionId: string, abort: AbortController, end: () => Promise<void>): void;
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
  /** G-14: end (then abort) every tracked session, THEN dispose the router. Idempotent, and a
   *  CONCURRENT second call awaits the first rather than returning early — its caller would
   *  otherwise close the stores a still-draining child is writing into. */
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

/**
 * Await `end()`, but never longer than `ms` — and when the budget runs out, ABORT.
 *
 * G-14's wording is "closes queues, awaits iterations with a bounded grace, aborts stragglers", and
 * the abort is the half that cannot be delegated: Winter's `Query` has no `close()`, so a child
 * that outlives this function is unreachable for the rest of the process's life and then survives
 * it. `abort.abort()` is the session's own controller — the one its `Options` carry — so the child
 * sees a cancelled turn and exits rather than being orphaned mid-turn.
 *
 * Never fails because a session misbehaved: a rejecting `end` is a straggler too, and a session
 * that will not end must not hold the whole daemon's teardown. Both cases are LOGGED — a `stop()`
 * that suddenly takes longer is otherwise silent, and passing the grace is the one thing that can
 * push teardown past the app's SIGKILL deadline (see `SHUTDOWN_QUERY_GRACE_MS`).
 */
function endWithin(sessionId: string, abort: AbortController, end: () => Promise<void>, ms: number, log?: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log?.(`session ${sessionId} did not end within ${ms}ms — aborting it`);
      try { abort.abort(); } catch { /* an already-aborted controller is the outcome we wanted */ }
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
    //
    // CARRY FOR TASKS 13/16: `directory` carries `retention` and nothing else, so the router's own
    // `RuntimeDirectoryRecoveryHooks` (`revalidateProcessIdentity`, `reattachSupervised`) stay
    // unset and its `recoverDirectory` reattaches nothing. That is correct for 8b — 8a owns
    // recovery, and its twelve steps have already run by the time this handle exists — but the day
    // a Winter child must be re-adopted across a daemon restart (`PersistedWinterChild`, P8b-15),
    // this is the door those hooks come through.
    messaging: { directory: { retention: retentionFrom(deps.settings) } },
    ...advisorFrom(deps),
  });

  // sessionId → that session's graceful teardown and its abort controller. Keyed by session so a
  // resumed session replaces its predecessor's entry rather than accumulating one.
  const live = new Map<string, { abort: AbortController; end: () => Promise<void> }>();
  // THE IN-FLIGHT dispose, not a boolean. A bare latch would let a second `stop()` — the app's
  // SIGTERM racing the CLI's own shutdown is a real shape — return IMMEDIATELY while the first is
  // still draining, and its caller would then close the session store and `runtime-state.db`
  // underneath a child that is still appending into both. That is precisely the ordering G-14
  // exists to guarantee, so the second caller awaits the first instead.
  let disposing: Promise<void> | undefined;

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
    trackQuery(sessionId: string, abort: AbortController, end: () => Promise<void>): void {
      if (disposing !== undefined) {
        // The map has already been drained, so an entry added here would never be ended. Task 16's
        // idle timer and resume paths run off timers that outlive `server.stop()`, so this is
        // reachable — and a silent no-op is the one answer that leaves a live child with nobody
        // holding it.
        deps.log?.(`session ${sessionId} started during shutdown — aborting it immediately`);
        try { abort.abort(); } catch { /* already aborted: the outcome we wanted */ }
        return;
      }
      live.set(sessionId, { abort, end });
    },
    untrack(sessionId: string): void {
      live.delete(sessionId);
    },
    dispose(): Promise<void> {
      if (disposing !== undefined) return disposing;
      disposing = (async () => {
        const grace = overrides.grace ?? SHUTDOWN_QUERY_GRACE_MS;
        const sessions = [...live.entries()];
        live.clear();
        // ALL of them, in parallel, each under its own budget — then, and only then, the router.
        await Promise.all(sessions.map(([sessionId, s]) => endWithin(sessionId, s.abort, s.end, grace, deps.log)));
        await sdk.dispose();
      })();
      return disposing;
    },
  };
}
