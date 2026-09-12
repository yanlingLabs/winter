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
import type { McpSdkServerConfigWithInstance, SessionKey, SpawnClaudeCodeProcess } from "@yanlinglabs/winter-agent-sdk";
import type { AdvisorReviewer, ReviewerResolver } from "@yanlinglabs/winter-agent-sdk/tools";
import { createRuntimeSdk as createRouterSdk, D14_CLAUDE_OAUTH_APPROVED_DEFAULT, isSelectionRefusal, selectionVersionsFrom, selectRuntime, SelectionRefusedError } from "@yanlinglabs/winter-runtime-sdk";
import type { OfficialSdkModule, RuntimeDirectoryEntry, RuntimeDirectoryOptions, RuntimeDirectoryStore, RuntimeKind, RuntimeSdk, RuntimeSdkOptions, RuntimeSelection, SelectionInput, SelectionRefusal } from "@yanlinglabs/winter-runtime-sdk";
import type { PermissionClassLabel } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { SecretStore } from "../auth/secret-store";
import { retentionFromSettings } from "../runtime-state/retention";
import { winterOptionsFromSettings, type Settings } from "../settings";
import { NORMA_BRAND } from "./brand";
import { resolveWinterExecutable, type WinterExecutableUnavailable } from "./executable";
import { resolveClaudeExecutable, ClaudeExecutableUnavailable } from "./official-executable";
import { credentialPresenceFrom, keychainSeamFromSecretStore } from "./keychain";
import { familyListingFromCatalog } from "./provider-selection";
import { releaseAllHeld } from "./messaging";
import { NORMA_PEER_VERSIONS } from "./versions";

/**
 * P8c-1's own alias for the peer this daemon injects at `RuntimeSdkPeers.claude` — the router's own
 * `OfficialSdkModule` (its published barrel re-exports it via `seams/index.ts`'s wildcard; see
 * `versions.ts`'s header for why the SAME duck-typed shape is what a compiled `$bunfs` binary can
 * still see). Named locally so callers of `officialPeer()` need not reach into the router package
 * for a type that exists only to describe an injected module.
 */
export type OfficialPeer = OfficialSdkModule;

/**
 * P8c-14 (Neighbours' contracts, for lane 4): the router's `HandoffParticipants` +
 * `HandoffBarrierDeps.selectionInputFor`, bundled into ONE registration call — a LOCAL shape,
 * never imported from the router: `HandoffParticipants`/`HandoffSourceOwner`/
 * `HandoffDestinationRuntime` live in `store/handoff-barrier.d.ts`, which `dist/index.d.ts`'s own
 * barrel does not re-export (`package.json`'s `exports` map has exactly one entry, `"."`, same gap
 * `official-capabilities.ts`'s header documents for `createApprovalBridge`). The two members
 * structurally satisfy the router's own `HandoffBarrierDeps.participants`/`.selectionInputFor`
 * fields regardless — `createRuntimeSdk`'s parameter type is already imported (`RuntimeSdkOptions`),
 * so TypeScript checks the object literal built below against ITS real, unexported field types.
 */
export interface HandoffParticipants {
  source?(session: SessionKey, from: RuntimeKind): unknown;
  destination?(session: SessionKey, to: RuntimeKind): unknown;
  selectionInputFor?: (args: { session: SessionKey; from: RuntimeKind; to: RuntimeKind; persisted: RuntimeSelection }) => SelectionInput | Promise<SelectionInput>;
}

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
  /**
   * WS-10 §13's inbound class for a session this process holds NO live facet for (Task 12).
   *
   * ⚠️ WITHOUT IT EVERY UNATTACHED RECEIVER HOLDS ITS MAIL, FOREVER. The router's `receiverClass`
   * asks the attached handle's facet first; with no handle and no declaration it answers `unknown`,
   * and since the router's D2 an unknown class FAILS CLOSED — the message is held rather than
   * delivered under a guessed class. That is correct for a live session whose class this process
   * genuinely cannot read, and wrong for a session Norma itself launched and then parked: its
   * approval policy is a fact the daemon has.
   *
   * UNWIRED IN TASK 12 ON PURPOSE: the per-session policy lives with the session driver, which is
   * Task 16's. Nothing regresses in the meantime because nothing attaches yet. Task 16 fills this
   * from `permissionModeFor(policy)` → `classifyPermissionMode`, and `test/runtime-sdk/messaging.test.ts`
   * already pins both branches (declared ⇒ a parked session answers `unavailable`; undeclared ⇒ it
   * holds).
   */
  sessionPermissionClass?: (entry: RuntimeDirectoryEntry) => PermissionClassLabel | Promise<PermissionClassLabel>;
  log?: (line: string) => void;
}

export interface NormaRuntimeSdkOverrides {
  /** Test seam for `SHUTDOWN_QUERY_GRACE_MS`. */
  grace?: number;
  /** Test seam for the router factory — a spy wraps it to capture the `RuntimeSdkOptions` this
   *  file builds while still returning a REAL `RuntimeSdk`. */
  createRuntimeSdk?: (opts: RuntimeSdkOptions) => RuntimeSdk;
  /** Test seam for the official peer's import — a Winter-only test never pays for
   *  `@anthropic-ai/claude-agent-sdk` to load, and a peer-present test can hand in a fake module
   *  shaped like `OfficialSdkModule` without a real platform binary anywhere on disk. Defaults to
   *  `import("@anthropic-ai/claude-agent-sdk")`. */
  officialPeer?: () => Promise<OfficialPeer | undefined>;
}

/**
 * P8c-1: the lazy, memoized official peer.
 *
 * RESOLVED ONCE, BEFORE `createRuntimeSdk` — the router needs `peers.claude` AT CONSTRUCTION (its
 * own `hasClaudePeer`/version-matrix checks read it there), so "lazy" here means "resolved on the
 * daemon's own boot path rather than baked into a compiled artifact's import graph", not "deferred
 * past this function's own async body" (`createNormaRuntimeSdk` is already async — Task 1.1's own
 * note). A FAILED import (the optional platform package genuinely absent, or `@anthropic-ai/sdk` /
 * `@modelcontextprotocol/sdk` / `zod` peer mismatch) is logged ONCE, here, and answered as
 * `undefined` — a Winter-only daemon process is a normal outcome, never a crash.
 */
async function resolveOfficialPeer(load: () => Promise<unknown>, log?: (line: string) => void): Promise<OfficialPeer | undefined> {
  try {
    return (await load()) as OfficialPeer;
  } catch (err) {
    log?.(`the official peer (@anthropic-ai/claude-agent-sdk) did not load — the official leg is unavailable on this daemon process: ${err instanceof Error ? err.name : "unknown"}`);
    return undefined;
  }
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
   * P8c-1: the official peer this handle was constructed with — `undefined` on a Winter-only
   * daemon process. ALREADY RESOLVED (this call never imports anything); the `Promise` return is
   * the API shape the Interfaces block fixes, not a live import each time.
   */
  officialPeer(): Promise<OfficialPeer | undefined>;
  /** P8c-14: the SAME already-resolved value `officialPeer()` answers, without the `Promise`
   *  wrapper — `session-driver.ts`'s official-leg assembly must stay SYNCHRONOUS up to
   *  `drivers.set` (the same racing-resume invariant the Winter path already has), and awaiting a
   *  Promise that is in fact already settled would still cost a microtask inside that window. */
  officialPeerSync(): OfficialPeer | undefined;
  /**
   * P8c-3: THE ONE SITE for the official leg's executable ladder, re-resolved on EVERY call — same
   * hot-settings posture as `spawnHookFor`. Returns the typed `ClaudeExecutableUnavailable` rather
   * than throwing; a session on the official leg refuses at create instead.
   */
  claudeExecutableFor(): { path: string } | ClaudeExecutableUnavailable;
  /**
   * P8c-12: decides the leg for a NEW session (or reviews a resumed one's `persisted` record,
   * which the router returns BY IDENTITY — "the persisted selection wins", never re-decided).
   * Builds `SelectionInput` from the pinned catalog (`familyListingFromCatalog`, no live query
   * needed), this process's credential presence and whether the official peer resolved. Never
   * throws — the router's own `SelectionRefusedError` is unwrapped into the `SelectionRefusal`
   * value its own `refusal` field carries.
   */
  selectRuntimeFor(input: { mode: SessionMode; model?: string; persisted?: RuntimeSelection }): Promise<RuntimeSelection | SelectionRefusal>;
  /**
   * P8c-14 (Neighbours' contracts, for lane 4): registers the live handoff participants + the
   * fresh-selection reviewer, AFTER construction — `createRuntimeSdk({ handoff })` is fixed at
   * construction time, but the daemon's session-driver table (where a `HandoffSourceOwner`/
   * `HandoffDestinationRuntime` for a given session actually lives) exists only once THIS handle
   * has already returned. The router reads `handoff.participants`/`.selectionInputFor` lazily, at
   * handoff time, never at construction — so a mutable holder the constructor's own delegating
   * closures read from is sufficient; calling this more than once REPLACES the previous
   * registration (the last caller wins, same as any other hot-settings door in this file).
   */
  registerHandoffParticipants(p: HandoffParticipants): void;
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
  // `winterOptionsFromSettings` is THE door every Winter-leg consumer reads the `runtimes` block
  // through (fix wave F3 retired this file's own temporary copy of it).
  const model = winterOptionsFromSettings(deps.settings()).advisorModel;
  if (model === undefined) return {};
  const resolveReviewer: ReviewerResolver = () => {
    const live = winterOptionsFromSettings(deps.settings()).advisorModel ?? model;
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
  // P8c-1: resolved BEFORE the factory call — the router reads `peers.claude`/`hasClaudePeer` at
  // construction, so the import has to have already settled by the time `factory(...)` runs. This
  // function is already async (the note every 8b doc comment above makes), so nothing here changes
  // the daemon's own boot shape.
  const officialModule = await resolveOfficialPeer(overrides.officialPeer ?? (() => import("@anthropic-ai/claude-agent-sdk")), deps.log);
  const claudeExecutableResolution = resolveClaudeExecutable({
    setting: winterOptionsFromSettings(deps.settings()).claudeExecutable,
    env: process.env,
    execPath: process.execPath,
    exists: (p) => existsSync(p),
  });
  // P8c-14: the mutable holder `registerHandoffParticipants` (below) writes into; the router reads
  // `handoff.participants`/`.selectionInputFor` lazily at handoff time, so a delegating closure
  // here is enough — nothing calls a handoff before lane 4 registers, and this handle simply has
  // no participants until then (the router's own barrier reports "no participant" for either side).
  const handoffParticipants: { current: HandoffParticipants | undefined } = { current: undefined };
  const sdk = factory({
    // A `claude` peer is injected ONLY when the import actually resolved (P8c-1) — the namespace is
    // injected as an INSTANCE, same as `winter`; the router never imports either SDK by name.
    peers: { winter, ...(officialModule === undefined ? {} : { claude: officialModule }) },
    // P8b-4: host-declared, and the ONLY probe that answers inside a compiled `$bunfs` binary.
    // `NORMA_PEER_VERSIONS.claudeAgentSdk` is present only when the peer resolved (`versions.ts`).
    peerVersions: NORMA_PEER_VERSIONS,
    // Required even though the Winter leg resolves its own credentials runtime-side (surface map
    // §1.3): the field has no `?`, and the official leg is the only caller.
    keychain: keychainSeamFromSecretStore(deps.secrets),
    // R-1. Resolved once here, through the injected peer's own `resolveBrand`.
    brand: NORMA_BRAND,
    // P8c-3: the ladder's answer AT CONSTRUCTION TIME. Omitted (never a bare "claude") when it does
    // not resolve — the door then refuses ONLY a session that selects the official leg
    // (`claude_executable_unavailable`), and every Winter session proceeds unaffected. A later
    // `runtimes.claudeExecutable` edit takes effect for new sessions through `claudeExecutableFor()`
    // above; this constructor-time value is what the router itself launches with today.
    ...(claudeExecutableResolution instanceof ClaudeExecutableUnavailable ? {} : { vendoredOfficialRuntime: claudeExecutableResolution.path }),
    // 8a's durable store when the spine opened; the router's in-memory default when it did not.
    directoryStore: deps.directoryStore,
    capabilities: deps.capabilities,
    // §1.6: this is what fills `SeamContext.winterHome`, so the barrier and every later seam
    // resolve under the daemon's OWN home. Without it they fall back to
    // `resolveWinterHome(undefined, brand)` — which is `~/.norma` for a daemon booted on a temp
    // home with no `NORMA_HOME` in its environment, i.e. every test. `participants` is 8c's Task
    // 1.3/lane 4 concern; this handle passes none yet.
    handoff: {
      winterHome: deps.home,
      participants: {
        source: (session, from) => handoffParticipants.current?.source?.(session, from),
        destination: (session, to) => handoffParticipants.current?.destination?.(session, to),
      } as NonNullable<RuntimeSdkOptions["handoff"]>["participants"],
      selectionInputFor: (args) => {
        const fn = handoffParticipants.current?.selectionInputFor;
        if (fn !== undefined) return fn(args);
        // Unregistered (no lane-4 wiring yet, or a Winter-only test): the honest "unreviewed"
        // answer this deployment's OWN `selectRuntimeFor` would give for the session's PERSISTED
        // family — never a synthesized credential/catalog view (`HandoffBarrierDeps.
        // selectionInputFor`'s own doc: "ABSENT MEANS UNREVIEWED, NOT ASSUMED-FINE").
        return {
          mode: "code",
          requested: {},
          families: { active: undefined, families: [] },
          credentials: { byProvider: {} },
          hasClaudePeer: officialModule !== undefined,
          claudeOauthApproved: D14_CLAUDE_OAUTH_APPROVED_DEFAULT,
          persisted: args.persisted,
        };
      },
    },
    // P8c-1/P8c-2: the official branch's deployment-wide policy. `remoteConfig: "deny"` is R-7b-11's
    // own default (a session's own child never fetches remote feature configuration); `claudeOauth`
    // is left at the router's own default gate (D14/P8c-2: the official leg ships Code-only,
    // API-key auth, with Claude OAuth closed) — Norma states the auth-family gate at SELECTION time
    // (`claudeOauthApproved: false` on every `SelectionInput`, Task 1.3) rather than here twice.
    // `permissionMode: "default"` is the DEPLOYMENT floor a session with no other policy gets; a
    // live session's own `runtime.official.options.permissionMode` (Task 1.2) overrides it per the
    // P8b-7 map, and `bypassPermissions` is refused by the router itself either way.
    official: { env: { remoteConfig: "deny" }, permissionMode: "default" },
    // G-12. The WINTER adapter's `permissionClass` (Task 12) fails inbound delivery closed without
    // it; the OFFICIAL adapter has the identical fail-closed rule (the router's own messaging
    // README), so P8c-1 sets both from the SAME classifier — a message addressed to a session this
    // process holds no live facet for is classified by the record's policy, never by which leg the
    // record happens to be on.
    //
    // CARRY FOR TASKS 13/16: `directory` carries `retention` and nothing else, so the router's own
    // `RuntimeDirectoryRecoveryHooks` (`revalidateProcessIdentity`, `reattachSupervised`) stay
    // unset and its `recoverDirectory` reattaches nothing. That is correct for 8b/8c — 8a owns
    // recovery, and its twelve steps have already run by the time this handle exists — but the day
    // a Winter child must be re-adopted across a daemon restart (`PersistedWinterChild`, P8b-15),
    // this is the door those hooks come through.
    messaging: {
      directory: { retention: retentionFrom(deps.settings) },
      ...(deps.sessionPermissionClass === undefined
        ? {}
        : {
            messaging: {
              winter: { permissionClass: deps.sessionPermissionClass },
              official: { permissionClass: deps.sessionPermissionClass },
            },
          }),
    },
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
    // Task 12. `deps.directoryStore` is 8a's SQLite store when the spine opened and undefined when
    // it did not — in which case the sweep is this process's live sessions alone, which is the same
    // "degraded, never dead" posture the rest of this file takes.
    messaging: {
      releaseHeld: async (): Promise<void> => {
        await releaseAllHeld(sdk, deps.directoryStore, deps.log);
      },
    },
    spawnHookFor(_mode: SessionMode): WinterSpawnHook | WinterExecutableUnavailable {
      const resolution = resolveWinterExecutable({
        setting: winterOptionsFromSettings(deps.settings()).winterExecutable,
        env: process.env,
        execPath: process.execPath,
        home: deps.home,
        exists: (p) => existsSync(p),
      });
      return resolution.ok ? { pathToClaudeCodeExecutable: resolution.path } : resolution.error;
    },
    officialPeerSync(): OfficialPeer | undefined {
      return officialModule;
    },
    officialPeer(): Promise<OfficialPeer | undefined> {
      // Already resolved above; this is the accessor's own contract (a `Promise`, never a live
      // re-import) — see `officialModule`'s own doc comment.
      return Promise.resolve(officialModule);
    },
    claudeExecutableFor(): { path: string } | ClaudeExecutableUnavailable {
      const resolution = resolveClaudeExecutable({
        setting: winterOptionsFromSettings(deps.settings()).claudeExecutable,
        env: process.env,
        execPath: process.execPath,
        exists: (p) => existsSync(p),
      });
      return resolution instanceof ClaudeExecutableUnavailable ? resolution : { path: resolution.path };
    },
    async selectRuntimeFor(input: { mode: SessionMode; model?: string; persisted?: RuntimeSelection }): Promise<RuntimeSelection | SelectionRefusal> {
      const credentials = await credentialPresenceFrom(deps.secrets);
      try {
        return selectRuntime({
          mode: input.mode,
          requested: { ...(input.model === undefined ? {} : { model: input.model }) },
          families: familyListingFromCatalog(),
          credentials,
          hasClaudePeer: officialModule !== undefined,
          claudeOauthApproved: D14_CLAUDE_OAUTH_APPROVED_DEFAULT,
          ...(input.persisted === undefined ? {} : { persisted: input.persisted }),
          versions: selectionVersionsFrom(sdk.versions),
        });
      } catch (err) {
        if (err instanceof SelectionRefusedError) return err.refusal;
        if (typeof err === "object" && err !== null && isSelectionRefusal(err)) return err;
        throw err;
      }
    },
    registerHandoffParticipants(p: HandoffParticipants): void {
      handoffParticipants.current = p;
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
