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
//  1. `spawnHookFor(mode)` — P8b-1's single topology site. Code: path (a), one spawned `winter`
//     child per session. Chat and dispatch (WS-23): path (b), the runtime EMBEDDED in this process,
//     one Bun Worker per session (`embedded.ts`) — the change to this one function's return value
//     P8b-1 promised, with nothing else in the daemon moving.
//  2. `trackQuery`/`untrack`/`dispose` — G-14's ordering. Every live `Query` ends BEFORE the router
//     disposes and, in `daemon.ts`, before the 8a spine closes: a draining child's last frames
//     write delivery receipts into `runtime-state.db`, and a closed store loses them.
//  3. The settings-derived options. Winter's hard rule is that no setting may require a restart, but
//     `createRuntimeSdk` takes PLAIN VALUES for retention (Winter map §8.3). The door this file uses
//     to keep it live is a getter-backed retention object (the router reads the property at recovery
//     time, not at construction), noted at its definition.
//
// WS-23: the handle serves ONE runtime. The official `claude` peer and everything this file built for
// it (the peer import and its version guard, the executable ladder, the credential seam, the advisor
// resolver, the capability-schema bridge, the handoff participants) is gone.
import { existsSync } from "node:fs";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import type { McpSdkServerConfigWithInstance, SpawnClaudeCodeProcess } from "@yanlinglabs/winter-agent-sdk";
import { createRuntimeSdk as createRouterSdk, isSelectionRefusal, selectionVersionsFrom, selectRuntime, SelectionRefusedError } from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeDirectoryEntry, RuntimeDirectoryOptions, RuntimeDirectoryStore, RuntimeSdk, RuntimeSdkOptions, RuntimeSelection, SelectionInput, SelectionRefusal } from "@yanlinglabs/winter-runtime-sdk";
import type { PermissionClassLabel } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { SecretStore } from "../auth/secret-store";
import { retentionFromSettings } from "../runtime-state/retention";
import { winterOptionsFromSettings, type Settings } from "../settings";
import { buildCoreBrand } from "./brand";
import { resolveWinterExecutable, type WinterExecutableUnavailable } from "./executable";
import { EmbeddedRuntimeUnavailable, embeddedVersionCheck, runsEmbedded, type EmbeddedSessionHost } from "./embedded";
import { credentialPresenceFrom } from "./keychain";
import { familyListingFromCatalog } from "./provider-selection";
import { splitTag, WINTER_TEST_PREFIX } from "./model-tag";
import { releaseAllHeld } from "./messaging";
import { daemonResolveEndpoint } from "../providers/registry";
import { WINTER_PEER_VERSIONS } from "./versions";
import type { RecoveryReport, RunHomeFor, RunHomeOutcome } from "@yanlinglabs/winter-runtime-sdk";
import { runHomeHandleOf } from "./run-home-support";

/** `RuntimeDirectoryRetention` is not on the router's barrel; this is the same type. */
type RuntimeDirectoryRetention = NonNullable<RuntimeDirectoryOptions["retention"]>;

/** The three session modes, as `agent/tools/registry.ts`'s `Mode` already spells them. */
export type SessionMode = "code" | "dispatch" | "chat";

/**
 * How long `dispose()` waits for ONE live session to end before it aborts that one.
 *
 * 300 ms, AND THE NUMBER IS ARITHMETIC, not taste (P8b-32). The whole of teardown has to fit inside
 * `DaemonSupervisor.gracefulExitTimeout` — 5.0 s as of P8d-6, `apple/Winter/Sources/App/DaemonSupervisor.swift`
 * — after which the app SIGKILLs the daemon; a teardown that overruns is killed mid-drain, so
 * `lock.release()` never runs, the socket file is left on disk, and the supervisor drops to
 * `.connectOnly` on the next launch. That 5.0 s only reaches this budget because P8d-6 PAIRED the
 * raise with escaping `applicationWillTerminate`'s own ~5 s force-quit window: `AppDelegate`'s
 * `applicationShouldTerminate` now returns `.terminateLater` while `terminateGracefully()` runs,
 * then calls `reply(toApplicationShouldTerminate:)` — without that move, the app-side clock the
 * daemon is racing was never 5.0 s to begin with. 8a already spends 3500 ms of that budget on its
 * own deletion drain (`RUNTIME_SHUTDOWN_DRAIN_MS`, raised in the same P8d-6 pairing), and the two
 * are SEQUENTIAL in `daemon.ts`'s `stop()`:
 *
 *     SHUTDOWN_QUERY_GRACE_MS (300) + RUNTIME_SHUTDOWN_DRAIN_MS (3500) = 3800 < 5000
 *
 * `create.test.ts` asserts that inequality, so the next edit to either number trips a test instead
 * of shipping a stale socket. In the ordinary case — a child that ends when its prompt queue closes
 * — this costs microseconds; the budget is only reached by a straggler, and a straggler is ABORTED
 * rather than merely abandoned (G-14's "aborts stragglers"). Overridable per call for tests.
 */
export const SHUTDOWN_QUERY_GRACE_MS = 300;

/** What `Options` needs to spawn a child (P8b-1). `spawnClaudeCodeProcess` is left to the SDK's
 *  `defaultSpawn` on path (a) (code); path (b) (chat, dispatch — WS-23's embedded Worker) fills it in
 *  here and nowhere else, and `pathToClaudeCodeExecutable` is then only a label (the SDK hands it to
 *  the hook as `command` and resolves nothing). */
export interface WinterSpawnHook {
  pathToClaudeCodeExecutable: string;
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess;
}

export interface WinterRuntimeSdkDeps {
  /** The daemon's `WINTER_HOME`. Winter's home is the SAME directory under `CORE_BRAND`. */
  home: string;
  /** THE LIVE settings holder — never a boot snapshot. `null` on a daemon whose settings.json
   *  would not parse (the daemon runs with the agent disabled rather than refusing to start). */
  settings: () => Settings | null | undefined;
  secrets: SecretStore;
  /** 8a's SQLite directory store. `undefined` ⇒ the spine is offline and the router falls back to
   *  its own in-memory store: messaging works for this process's lifetime, receipts are not
   *  durable. That is a degraded daemon, never a dead one. */
  directoryStore?: RuntimeDirectoryStore;
  /** Tasks 6–7's capability servers, handle-wide. `[]` is valid and is what the daemon passes: Winter's
   *  capability servers ride each session's own `Options.mcpServers` instead (P8b-36). */
  capabilities: readonly McpSdkServerConfigWithInstance[];
  /**
   * WS-10 §13's inbound class for a session this process holds NO live facet for (Task 12).
   *
   * ⚠️ WITHOUT IT EVERY UNATTACHED RECEIVER HOLDS ITS MAIL, FOREVER. The router's `receiverClass`
   * asks the attached handle's facet first; with no handle and no declaration it answers `unknown`,
   * and since the router's D2 an unknown class FAILS CLOSED — the message is held rather than
   * delivered under a guessed class. That is correct for a live session whose class this process
   * genuinely cannot read, and wrong for a session Winter itself launched and then parked: its
   * approval policy is a fact the daemon has.
   *
   * UNWIRED IN TASK 12 ON PURPOSE: the per-session policy lives with the session driver, which is
   * Task 16's. Nothing regresses in the meantime because nothing attaches yet. Task 16 fills this
   * from `permissionModeFor(policy)` → `classifyPermissionMode`, and `test/runtime-sdk/messaging.test.ts`
   * already pins both branches (declared ⇒ a parked session answers `unavailable`; undeclared ⇒ it
   * holds).
   */
  sessionPermissionClass?: (entry: RuntimeDirectoryEntry) => PermissionClassLabel | Promise<PermissionClassLabel>;
  /**
   * WS-21 (spec §3.1): present ONLY when the linked router applies run homes (`daemon.ts` passes it
   * when `linkedRunHomeBuilder()` answers). The router is then created with `requireRunHome: true` —
   * every generation without a run home is refused `run_home_required` — with this host builder for its
   * OWN cold-resume path, and (L2's Contract A) with `handoff.winterHome` set, which `requireRunHome`
   * needs (the option is always stated with `deps.home`). Absent (router 0.0.11, every test double):
   * the router is created exactly as before.
   */
  runHomeFor?: RunHomeFor;
  /**
   * WS-23: the daemon's embedded-session host (`embedded.ts`), where chat and dispatch Workers are
   * spawned and — at shutdown — ended (`daemon.ts` owns it and drains it before the stores close).
   * ABSENT (a test double, a harness that never runs a session) ⇒ chat and dispatch refuse typed
   * (`embedded_runtime_unavailable`); they never fall back to the spawned binary.
   */
  embedded?: EmbeddedSessionHost;
  log?: (line: string) => void;
}

export interface WinterRuntimeSdkOverrides {
  /** Test seam for `SHUTDOWN_QUERY_GRACE_MS`. */
  grace?: number;
  /** Test seam for the router factory — a spy wraps it to capture the `RuntimeSdkOptions` this
   *  file builds while still returning a REAL `RuntimeSdk`. */
  createRuntimeSdk?: (opts: RuntimeSdkOptions) => RuntimeSdk;
}

/** `Name: message`, first line only, capped — an import failure's message names a missing global
 *  or module, never credential material, but a bundler stack can be long and multi-line. The bare
 *  name alone (`ReferenceError`) was what the dist log carried for a week: undiagnosable. */
export function describeLoadError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const first = (err.message ?? "").split("\n")[0]!.trim();
  const text = first === "" ? err.name : `${err.name}: ${first}`;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export interface WinterRuntimeSdk {
  /** The router handle itself. Every later lane reaches `query`/`messaging`/`directory` here. */
  readonly sdk: RuntimeSdk;
  /**
   * P8b-1: THE ONE SITE for the spawn topology, re-resolved on EVERY call.
   *
   * CODE: the spawned `winter` binary. `settings.runtimes.winterExecutable` is hot, so a newly built
   * binary is picked up by the next session with no restart. CHAT and DISPATCH (WS-23): the embedded
   * runtime, one Worker per session — no binary is resolved for them at all, so
   * `winter_executable_unavailable` cannot apply; their refusal is `EmbeddedRuntimeUnavailable`
   * (a version-locked set that does not agree, or no embedded host wired). Returns the typed error
   * rather than throwing and NEVER falls back to the other topology — a session refuses at create.
   */
  spawnHookFor(mode: SessionMode): WinterSpawnHook | WinterExecutableUnavailable | EmbeddedRuntimeUnavailable;
  /**
   * P8c-12: the router's selection for a NEW session (or a resumed one's `persisted` record, which
   * the router returns BY IDENTITY — "the persisted selection wins", never re-decided). Builds
   * `SelectionInput` from the pinned catalog (`familyListingFromCatalog`, no live query needed) and
   * this process's credential presence. WS-23: there is no official runtime to route to, so the input
   * says so (`hasClaudePeer: false`) and every family — Claude included — selects the Winter runtime.
   * Never throws — the router's own `SelectionRefusedError` is unwrapped into the `SelectionRefusal`
   * value its own `refusal` field carries.
   */
  selectRuntimeFor(input: { mode: SessionMode; model?: string; persisted?: RuntimeSelection }): Promise<RuntimeSelection | SelectionRefusal>;
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
   * is holding a message for).
   *
   * ZERO-ARGUMENT, and that is the whole point: the router's own `messaging.releaseHeld(receiver)`
   * takes ONE address, and a settings change has no receiver — it changes the answer for all of
   * them. Task 12 fills this with `releaseAllHeld` (`runtime-sdk/messaging.ts`), which iterates the
   * durable mailbox's receivers unioned with this process's live sessions.
   */
  readonly messaging: { releaseHeld: () => Promise<void> };
  /** G-14: end (then abort) every tracked session, THEN dispose the router. Idempotent, and a
   *  CONCURRENT second call awaits the first rather than returning early — its caller would
   *  otherwise close the stores a still-draining child is writing into. */
  dispose(): Promise<void>;
  /**
   * WS-21 (spec §3.8; L2 fix round 1): the router's verdict on one run home — `safe` (the ONLY outcome
   * that disposes it), `quarantined` (its working copy was preserved under `<home>/cache/quarantine/`; the
   * folder is kept, recorded, and its session marked `repair-required`), `pending` (not settled; kept for
   * boot recovery). `undefined` when the linked router has no run homes (0.0.11) — optional so a test
   * double need not implement it.
   */
  runHomeOutcome?(runId: string): RunHomeOutcome | undefined;
  /**
   * WS-21 (spec §3.8): the router's crash-recovery reconcile of one recorded root, through its own
   * live store (it recomputes the claude-ready decorations first). `undefined` when the linked router
   * has no such door (0.0.11) — recovery then keeps its pre-WS-21 behaviour. Optional for test doubles.
   */
  reconcileRootForRecovery?(root: string): Promise<RecoveryReport> | undefined;
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

export async function createWinterRuntimeSdk(deps: WinterRuntimeSdkDeps, overrides: WinterRuntimeSdkOverrides = {}): Promise<WinterRuntimeSdk> {
  const factory = overrides.createRuntimeSdk ?? createRouterSdk;
  // test-keychain-isolation fix: built from `deps.home` — the daemon's ACTUAL home — rather than
  // reusing the frozen, env-only `CORE_BRAND` singleton. `CORE_BRAND` resolves its `keychainService`
  // once at module load from `WINTER_HOME`/`WINTER_PROFILE` env vars alone, which a daemon booted
  // via `startDaemon({ home })` (every real-binary e2e test) never sets — so the singleton could
  // never see `deps.home` and therefore could never honour `WINTER_KEYCHAIN_SERVICE`'s default-home
  // guard for it. This IS the value the router hands to a spawned Winter child (`brand.keychainService`
  // seeds the child's OWN Bun.secrets read, including the D30 advisor default fallback with no
  // explicit `authRef` — see `mode-options.ts`'s `buildWinterOptions` header), so it is the one that
  // must be home-aware.
  const homeAwareBrand = buildCoreBrand(undefined, deps.home);
  // WS-23: THE WINTER PEER ALONE. The official `claude` peer, its executable, its credential seam, its
  // advisor resolver, its capability bridge and its handoff participants are gone with the leg they
  // served; the router routes every family to the Winter runtime (`hasClaudePeer: false` below).
  const sdk = factory({
    peers: { winter },
    // P8b-4: host-declared, and the ONLY probe that answers inside a compiled `$bunfs` binary.
    peerVersions: { winterAgentSdk: WINTER_PEER_VERSIONS.winterAgentSdk },
    // R-1. Resolved once here, through the injected peer's own `resolveBrand`.
    brand: homeAwareBrand,
    // 8a's durable store when the spine opened; the router's in-memory default when it did not.
    directoryStore: deps.directoryStore,
    capabilities: deps.capabilities,
    // §1.6: this is what fills `SeamContext.winterHome`, so the session store `reviewSwitch` reads and
    // `reconcileRootForRecovery` writes resolve under the daemon's OWN home — without it they fall back
    // to `resolveWinterHome(undefined, brand)`, which is `~/.winter` for a daemon booted on a temp home
    // with no `WINTER_HOME` in its environment, i.e. every test. A `requireRunHome` router refuses to
    // construct without it.
    handoff: {
      winterHome: deps.home,
      // Winter Phase 10b (D1-6, R6-R8 review, CRITICAL): without this `reviewSwitch` falls back to
      // `defaultEndpointResolver()` — a registry with NO adapters registered, which reports
      // `readableState: "none"` for every model and silently over-warns a real lossless
      // exposed-reasoning transfer (measured: DeepSeek -> GLM came back `warned-lossy` with no resolver
      // injected). `daemonResolveEndpoint()` is the daemon's own catalog-backed registry
      // (`providers/registry.ts`), memoised for the process's life.
      resolveEndpoint: daemonResolveEndpoint(),
    },
    // G-12. The WINTER adapter's `permissionClass` (Task 12) fails inbound delivery closed without it.
    //
    // CARRY FOR TASKS 13/16: `directory` carries `retention` and nothing else, so the router's own
    // `RuntimeDirectoryRecoveryHooks` (`revalidateProcessIdentity`, `reattachSupervised`) stay
    // unset and its `recoverDirectory` reattaches nothing. That is correct — 8a owns recovery, and its
    // twelve steps have already run by the time this handle exists — but the day a Winter child must
    // be re-adopted across a daemon restart (`PersistedWinterChild`, P8b-15), this is the door those
    // hooks come through.
    messaging: {
      directory: { retention: retentionFrom(deps.settings) },
      ...(deps.sessionPermissionClass === undefined
        ? {}
        : { messaging: { winter: { permissionClass: deps.sessionPermissionClass } } }),
    },
    // WS-21 (spec §3.1): only when the linked router applies run homes. `RuntimeSdkOptions` of the
    // published 0.0.11 does not declare these, hence the widening; an older router never sees them.
    ...(deps.runHomeFor === undefined ? {} : ({ requireRunHome: true, runHomeFor: deps.runHomeFor } as Record<string, unknown>)),
  } as RuntimeSdkOptions);

  const buildSelectionInput = async (input: { mode: SessionMode; model?: string; persisted?: RuntimeSelection }): Promise<SelectionInput> => {
    const credentials = await credentialPresenceFrom(deps.secrets);
    // WS-20: `requested.model` is ALWAYS a provider-qualified tag now — the router (0.0.8+)
    // refuses a bare id typed (`bare-model-id`) — so `requested.provider` is sent alongside it,
    // split from the SAME tag, never independently guessed. Skipped for the winter-test double
    // (not a catalog tag at all) and when no model is named yet.
    //
    // `splitTag` THROWS on anything not shaped like "<providerId>/<modelId>" — a bare id reaching
    // this function directly (every real RPC door validates via `ModelTagSchema` first, so this is
    // a defense-in-depth path, not the common one) must still resolve to the router's own typed
    // `bare-model-id` refusal, never an uncaught `TypeError`. Caught here and passed through as a
    // bare `model` with no `provider` — the SAME shape `selectRuntime` itself treats as
    // provider-less — so the router is the one that refuses it, not this function pre-empting it.
    const requestedModel = input.model === undefined || input.model.startsWith(WINTER_TEST_PREFIX)
      ? {}
      : (() => {
          try {
            return { model: input.model!, provider: splitTag(input.model!).providerId };
          } catch {
            return { model: input.model! };
          }
        })();
    return {
      mode: input.mode,
      requested: requestedModel,
      families: familyListingFromCatalog(),
      credentials,
      // WS-23: no official runtime exists, so a Claude model routes to the Winter runtime (the router's
      // own `R-7b-1-no-peer` rule) — never to a peer this daemon cannot launch.
      hasClaudePeer: false,
      // claude.ai subscription auth never shipped, and the one runtime left never takes it (D28).
      claudeOauthApproved: false,
      ...(input.persisted === undefined ? {} : { persisted: input.persisted }),
      versions: selectionVersionsFrom(sdk.versions),
    };
  };

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
    // Task 12. `deps.directoryStore` is 8a's SQLite store when the spine opened and undefined when
    // it did not — in which case the sweep is this process's live sessions alone, which is the same
    // "degraded, never dead" posture the rest of this file takes.
    messaging: {
      releaseHeld: async (): Promise<void> => {
        await releaseAllHeld(sdk, deps.directoryStore, deps.log);
      },
    },
    spawnHookFor(mode: SessionMode): WinterSpawnHook | WinterExecutableUnavailable | EmbeddedRuntimeUnavailable {
      if (runsEmbedded(mode)) {
        const embedded = deps.embedded;
        if (embedded === undefined) return new EmbeddedRuntimeUnavailable("this daemon was built without an embedded-session host; chat and dispatch cannot start");
        // Checked on every call, not only at boot: the values are constants, so this costs nothing,
        // and it keeps the refusal at the one topology site rather than a boot flag someone must read.
        const versionRefusal = embeddedVersionCheck();
        if (versionRefusal !== undefined) return versionRefusal;
        return { pathToClaudeCodeExecutable: "winter-embedded", spawnClaudeCodeProcess: (options) => embedded.spawn(options) };
      }
      const resolution = resolveWinterExecutable({
        setting: winterOptionsFromSettings(deps.settings()).winterExecutable,
        env: process.env,
        execPath: process.execPath,
        home: deps.home,
        exists: (p) => existsSync(p),
      });
      return resolution.ok ? { pathToClaudeCodeExecutable: resolution.path } : resolution.error;
    },
    async selectRuntimeFor(input: { mode: SessionMode; model?: string; persisted?: RuntimeSelection }): Promise<RuntimeSelection | SelectionRefusal> {
      try {
        return selectRuntime(await buildSelectionInput(input));
      } catch (err) {
        if (err instanceof SelectionRefusedError) return err.refusal;
        if (typeof err === "object" && err !== null && isSelectionRefusal(err)) return err;
        throw err;
      }
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
    runHomeOutcome(runId: string): RunHomeOutcome | undefined {
      return runHomeHandleOf(sdk)?.runHomeOutcome(runId);
    },
    reconcileRootForRecovery(root: string): Promise<RecoveryReport> | undefined {
      return runHomeHandleOf(sdk)?.reconcileRootForRecovery(root);
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
