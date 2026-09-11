// P8b Task 12 — THE ONE DOOR that makes a live Winter session reachable by `SendMessage`.
//
// A session that is not attached here is, to the router, a durable row and nothing more: the
// directory can address it, and delivery falls through to a COLD RESUME (a whole second `winter`
// process replaying the transcript) or to `unavailable`. Attaching is what turns the row into a
// receiver — and, per WS-10 §12's amendment, what makes the session's own CHILDREN addressable at
// all, because a child engine has no facet of its own and is only ever reached through its owner's.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE HANDLE CARRIES A *WRAPPER* FACET RATHER THAN `query.messaging` ITSELF
//
// The router's Winter adapter picks ONE of two doors, in this order (measured in the shipped
// `dist/index.js`, `deliverIntoSession`):
//
//     if (handle.messaging !== undefined) return handle.messaging.deliver(message);
//     if (handle.push      !== undefined) { push(renderAttributedTurn(message, owner)); … }
//
// so the two fields are not additive — `messaging` SHADOWS `push` for session delivery. That forces
// a choice, and both naive answers are wrong:
//
//  * `push` only. Session delivery lands in the host queue (right), but `handle.messaging` is then
//    undefined, and the adapter's `childDelivery` answers a typed `unavailable` for every child
//    ("a child is only addressable through its owner"), while `canSubscribeIdle` answers `false`,
//    so `notify_when_idle` against a Norma session is refused. Two live surfaces lost.
//  * `query.messaging` raw. Children and idle work, but a delivered message goes over the control
//    pipe into the spawned child's own messaging runtime — which surface map §2.5 records as
//    answering `messaging_unavailable` ("no messaging runtime is registered in that process, which
//    retrying cannot change"). It also bypasses the host prompt queue, and P8b-5 makes that queue
//    the ONLY way a later user turn reaches a Winter session.
//
// So the handle carries a facet that is the session's own everywhere EXCEPT `deliver`, which
// renders the envelope and pushes it into the host queue — exactly P8b-5's `steer` path, because a
// delivery is a mid-turn push by construction. Children, idle notices, notification drains and the
// sender-class probe all reach the real `Query.messaging` untouched.
//
// THE RENDERING IS DUPLICATED, AND THAT IS A KNOWN COST. `renderAttributedTurn` lives in the
// router's `messaging/attribution.ts`, which the published package does NOT re-export (its `exports`
// map has one entry, `"."`, and the root barrel omits the attribution helpers). It is rebuilt below
// from the primitives the SDK *does* publish, and pinned by a byte-comparison test against the
// router's own push path (`test/runtime-sdk/messaging.test.ts`), so a drift in the frame format
// fails a test rather than silently changing what every model reads.
import {
  AGENT_MESSAGE_TAG,
  buildSessionAddress,
  delivered,
  deliveryUncertain,
  unavailable,
  escapeAttributionAttribute,
  escapeAttributionText,
  queued,
  refused,
  serializeRuntimeAddress,
} from "@yanlinglabs/winter-agent-sdk/messaging";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { Query, SessionMessagingFacet } from "@yanlinglabs/winter-agent-sdk";
import type {
  AttachedWinterSession,
  RuntimeDirectoryEntry,
  RuntimeDirectoryStore,
  RuntimeSdk,
  SerializedRuntimeAddress,
} from "@yanlinglabs/winter-runtime-sdk";
import type { NormaRuntimeSdk } from "./create";
import { NORMA_PEER_VERSIONS } from "./versions";

/** The router's own `LiveSessionStatus`, which its barrel does not re-export (`messaging/sessions.d.ts`
 *  declares it, `index.d.ts` omits it). Same declaration, not a widening. */
type LiveSessionStatus = ListedRuntimeObject["status"];

/** What a session that has never named its runtime choice records. NOT an invention of facts: every
 *  field is a literal "not stated", and `reason` says so in the one place an operator reads it
 *  (`RuntimeSelection.reason` is what a host renders for "why is this session on that runtime").
 *  Task 16 passes the 8a record's OWN selection and this is never reached in the daemon. */
const UNSTATED_SELECTION = {
  runtimeKind: "winter-agent",
  providerId: "unstated",
  modelRef: "unstated/unstated",
  family: "unstated",
  authFamily: "custom",
  sdkVersion: NORMA_PEER_VERSIONS.winterAgentSdk,
  reason: "attached without a persisted runtime selection; the session's own record is authoritative",
} as const;

/** Every capability a live, attached Winter session has. `resume` is true because the session's
 *  backend transcript outlives the child (P8b-24's `resumable`), `reply`/`message` because the host
 *  queue is a real input stream, `notifyWhenIdle` because the wrapper forwards the facet's own
 *  idle surface. */
const LIVE_CAPABILITIES = { message: true, resume: true, notifyWhenIdle: true, reply: true } as const;

/** The session facts a caller may state at attach. Everything here has a correct answer when it is
 *  absent — an attach that states only the four pinned members is legal and is what a test uses. */
export interface WinterSessionAttachment {
  /** Norma's OWN session id (the product id the phone and the Mac app address). Never the address:
   *  it is carried so a host-side map can go from a Norma session to its live `Query` — which is
   *  what Task 13's `TaskStop` walks to reach a child through its owner's facet. */
  sessionId: string;
  /** The BACKEND (Winter) session id — `Options.sessionId`, the id the runtime reports at
   *  `system/init`. THIS is the facet target and the directory address (surface map §6.1). */
  backendSessionId: string;
  /** The live session. Only `messaging` is read; the rest of `Query` is the caller's business. */
  query: Pick<Query, "messaging">;
  /** The session's host prompt queue sink (`HostPromptQueue.push`). A delivered message becomes the
   *  session's next user turn through THIS and nothing else (P8b-5). */
  push: (text: string) => void;
  /** The name `SendMessage`'s `to:` resolves — WS-10 §11 rule 5's leased display name. Absent means
   *  the session is addressable by its canonical address only. */
  displayName?: string;
  title?: string;
  /** `code` | `dispatch` | `chat`. The vocabulary is the host's (WS-15 §2). */
  mode?: string;
  cwd?: string;
  /** WS-10 §12's incarnation counter; a resume bumps it. Default 1. */
  generation?: number;
  /** This session's persisted runtime choice (8a's record). See `UNSTATED_SELECTION`. */
  selection?: RuntimeDirectoryEntry["selection"];
  /** The LIVE status, when the host tracks one. It decides `delivered` vs `queued` exactly as the
   *  router's own push path does, and it is where P8b-24's `unavailable` (a `resumable` session)
   *  is reported from. */
  status?: () => LiveSessionStatus;
  /** Where a failed directory write is reported. `detach()` returns void and must never throw, so a
   *  park that rejects has nowhere else to be heard (round 2, N-new-2). */
  log?: (line: string) => void;
}

export interface WinterSessionAttachHandle {
  /** Re-record the directory row from the session's live status (F6). */
  refresh(): void;
  /** Remove the live handle and park the directory row `exited`. NEVER `forget()` — the row is what
   *  lets WS-10 §11 rule 5 answer "that name referred to something that has gone" instead of "no
   *  such agent", and the released lease is the only memory of it. Idempotent. */
  detach(): void;
  /** The canonical address this session was recorded under. */
  readonly address: SerializedRuntimeAddress;
  /**
   * The durable half.
   *
   * Attaching the live handle is SYNCHRONOUS (the registry is a map), but recording the directory
   * row is I/O — and a delivery that arrives between the two answers `not_found`. Rather than
   * hiding that window behind a promise-returning `attach` (the pinned interface is synchronous, so
   * Task 16 can attach inside a frame handler without awaiting), the window is NAMED: `ready`
   * resolves when every directory write this handle has queued so far has landed. A test awaits it;
   * the daemon does not have to.
   */
  readonly ready: Promise<void>;
}

/** What Task 16 is handed so it never imports this module's internals (interfaces block). */
export interface WinterMessagingDeps {
  attach: typeof attachWinterSession;
}

/**
 * The router's `renderAttributedTurn`, rebuilt from the SDK primitives the package publishes.
 *
 * Byte-identical by test, not by hope — see this file's header. The `owner` check is the router's
 * `unattributableReason`: an envelope whose sender claims to be a CHILD of some other session must
 * not be rendered into this one's turn stream, because the frame it produces is what the model
 * reads as provenance.
 */
function unattributableReason(message: GlobalAgentMessage, owner: { winterSessionId: string }): string | undefined {
  let from: string;
  try {
    from = serializeRuntimeAddress(message.from);
  } catch {
    return "the envelope's `from` is not a canonical address";
  }
  if (message.from.objectKind === "agent") {
    const senderOwner = message.from.parentWinterSessionId ?? message.from.winterSessionId;
    if (senderOwner !== owner.winterSessionId) {
      return `the envelope claims to come from "${from}", which this session does not own`;
    }
  }
  return undefined;
}

export function renderAttributedTurn(message: GlobalAgentMessage, owner: { winterSessionId: string }): string {
  const from = serializeRuntimeAddress(message.from);
  const summary = message.summary !== undefined ? `\n<summary>${escapeAttributionText(message.summary)}</summary>` : "";
  const open =
    `<${AGENT_MESSAGE_TAG} from="${escapeAttributionAttribute(from)}" message-id="${escapeAttributionAttribute(message.messageId)}"` +
    ` sender-permission-class="${escapeAttributionAttribute(message.senderPermissionClass)}">`;
  return `${open}${summary}\n${escapeAttributionText(message.body)}\n</${AGENT_MESSAGE_TAG}>`;
}

/**
 * The facet the router sees: the session's own, with `deliver` re-pointed at the host prompt queue.
 *
 * EXPLICIT MEMBERS, never `{ ...facet, deliver }`: a facet method is free to be bound to its own
 * `Query`, and a spread copies the function without its receiver.
 */
function bridgedFacet(
  facet: SessionMessagingFacet,
  push: (text: string) => void,
  owner: { winterSessionId: string },
  /** The LIVE status, already defaulted — see `liveStatusOf`. Both handle shapes must read the same
   *  answer or they disagree about the same delivery (F6). */
  status: () => LiveSessionStatus,
  /** Set SYNCHRONOUSLY by `detach()`, cleared never. While it is true the handle is still attached
   *  (so the router cannot cold-resume) but the session is going away, so a delivery is refused
   *  rather than pushed into a queue that is about to close (F2). */
  parking: () => boolean,
): SessionMessagingFacet {
  return {
    listReachable: () => facet.listReachable(),
    steerChild: (id, msg) => facet.steerChild(id, msg),
    resumeChild: (id, msg) => facet.resumeChild(id, msg),
    subscribeIdle: (id, opts) => facet.subscribeIdle(id, opts),
    senderClass: (): Promise<PermissionClassLabel> => facet.senderClass(),
    readNotifications: (opts) => facet.readNotifications(opts),
    onIdleNotice: (handler) => facet.onIdleNotice(handler),

    async deliver(message: GlobalAgentMessage): Promise<DeliveryOutcome> {
      // Defence in depth: the adapter already ran this check before it chose this door, so a
      // refusal here means something reached the facet another way.
      const refusal = unattributableReason(message, owner);
      if (refusal !== undefined) return refused(message.messageId, refusal);
      // F2: `detach()` has been called and the row has not been parked yet. The handle is still
      // registered ON PURPOSE — dropping it here is what would let the router's `coldResume` open a
      // second `winter` process on this transcript — so the refusal happens at the door instead.
      if (parking()) {
        return unavailable(message.messageId, false, `${owner.winterSessionId} is ending; its input stream is closing and nothing was delivered`);
      }
      try {
        push(renderAttributedTurn(message, owner));
      } catch (error) {
        // The router's own push path answers `delivery_uncertain` for a failed push, and the two
        // handle shapes must not disagree about the same failure. (A closed queue did NOT deliver;
        // the honest narrowing of that case belongs with the sink that knows it is closed — Task
        // 16's `WinterSession`, which holds while `resumable` rather than throwing.)
        return deliveryUncertain(message.messageId, `the input-stream push failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // `liveOutcome`, the router's own: a turn is already running, so the pushed text is QUEUED
      // behind it rather than being read now.
      return status() === "running" ? queued(message.messageId) : delivered(message.messageId);
    },
  };
}

/**
 * Make a live Winter session a messaging receiver.
 *
 * Two writes, in this order and deliberately: the live handle first (a map write that cannot fail),
 * then the durable directory row. The reverse would advertise a receiver in the directory that this
 * process cannot yet deliver to.
 */
export function attachWinterSession(runtime: NormaRuntimeSdk, session: WinterSessionAttachment): WinterSessionAttachHandle {
  const parsed: RuntimeAddress = buildSessionAddress(session.backendSessionId);
  const address = serializeRuntimeAddress(parsed) as SerializedRuntimeAddress;
  const generation = session.generation ?? 1;
  const owner = { winterSessionId: session.backendSessionId };

  /**
   * The ONE status both handle shapes read (F6).
   *
   * The router computes `handle.status?.() ?? entry.status` for a push-only handle, so a row stamped
   * `"running"` at attach and never refreshed made a push-only handle answer `queued` where the
   * wrapper answered `delivered` — the same class of divergence the byte-compare test exists to
   * prevent, one field over. `"idle"` is the honest default for a session that has not said: a
   * turn is not running, so the pushed text is read next rather than queued behind one.
   */
  const liveStatusOf = (): LiveSessionStatus => session.status?.() ?? "idle";

  /** F2: flipped synchronously by `detach()`, read by the wrapper's `deliver`. */
  let parking = false;
  const log = session.log ?? ((): void => {});

  const handle: AttachedWinterSession = {
    messaging: bridgedFacet(session.query.messaging, session.push, owner, liveStatusOf, () => parking),
    status: liveStatusOf,
  };

  const entry = (live: boolean): RuntimeDirectoryEntry => ({
    address,
    parsed,
    runtimeKind: "winter-agent",
    objectKind: "session",
    // P8b-1: every mode is a spawned `winter` child in 8b, so every Norma session is a
    // `winter-session`. `winter-thread` becomes reachable only if path (b) ever lands.
    transport: "winter-session",
    ...(session.displayName === undefined ? {} : { displayName: session.displayName }),
    ...(session.title === undefined ? {} : { title: session.title }),
    // F6: the row mirrors the live answer, so `listReachable` does not report every attached
    // session as "running" forever and the two handle shapes never disagree.
    status: live ? liveStatusOf() : "exited",
    mode: session.mode ?? "code",
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    generation,
    selection: session.selection ?? { ...UNSTATED_SELECTION, decidedAt: new Date().toISOString() },
    // ⚠️ PARKED ROWS CARRY NO BACKEND ID, AND THAT IS THE POINT.
    //
    // `backendSessionId` is the router's COLD-RESUME source: with a handle gone and an id present,
    // its Winter adapter opens `peers.winter.query({ prompt, options: { resume: <id> } })` — a whole
    // second `winter` process, spawned from inside a delivery, that the daemon never tracked, never
    // budgeted in `dispose()`'s shutdown grace and never gave a projector to. Norma's session
    // lifecycle is the DAEMON's (P8b-24: the next `send`/`steer` resumes, host-driven), so a parked
    // row answers the honest non-retryable `unavailable` — "no transcript to resume" — instead. The
    // id itself is not lost: 8a's `runtime_sessions` record is where it lives for the product.
    ...(live ? { backendSessionId: session.backendSessionId } : {}),
    capabilities: live ? { ...LIVE_CAPABILITIES } : { message: false, resume: false, notifyWhenIdle: false, reply: false },
    updatedAt: new Date().toISOString(),
  });

  // `directory.record` THROWS `UnaddressableEntryError` for a non-canonical address — the one
  // messaging error a Winter-only host can still hit (surface map §8.5). It is raised out of
  // `ready`, never swallowed: a session recorded under an address nothing can resolve would be
  // listed and unreachable, which is precisely what that class exists to prevent.
  // The live handle FIRST — a map write that cannot fail — then the durable row, which is I/O
  // (N1: the code now reads in the order its own explanation gives).
  const detachHandle = runtime.sdk.messaging.attachWinterSession(address, handle);
  let chain: Promise<void> = runtime.sdk.directory.record(entry(true));

  let detached = false;
  return {
    address,
    get ready(): Promise<void> {
      return chain;
    },
    /** Re-record the row from the session's LIVE status (F6). Task 16 calls it at every state
     *  change; the row is the only thing a push-only handle and `listReachable` can read. */
    refresh(): void {
      if (detached) return;
      chain = chain.then(() => runtime.sdk.directory.record(entry(true)), () => runtime.sdk.directory.record(entry(true)));
    },
    detach(): void {
      if (detached) return;
      detached = true;
      // ⚠️ ORDER IS THE WHOLE FIX (F2). Dropping the live handle first leaves a window in which the
      // directory still says `running` WITH a `backendSessionId` and no handle answers — and the
      // router's `deliverIntoSession` reads exactly that as "cold-resume this transcript", spawning
      // a second `winter` process the daemon never tracked. So: latch `parking` synchronously (the
      // wrapper refuses from this instruction onward), park the row, and only then let the handle
      // go. A delivery in the window meets a typed `unavailable`; none of them meets a spawn.
      parking = true;
      const park = (): Promise<void> => runtime.sdk.directory.record(entry(false));
      // ⚠️ AND A PARK THAT FAILS KEEPS THE HANDLE (round 2, N-new-2). Releasing it on the rejection
      // path would land in exactly the state this whole ordering exists to prevent: a row saying
      // `running`, WITH a `backendSessionId`, and nothing attached — i.e. cold-resumable. Holding
      // the handle instead leaves the row wrong but UNREACHABLE, because the `parking` latch above
      // refuses every delivery for the rest of this handle's life. A leaked registry entry for a
      // session that is over is a bounded cost; an untracked `winter` process is not.
      chain = chain.then(park, park).then(
        () => { detachHandle(); },
        (error: unknown) => {
          log(`could not park ${address} (${error instanceof Error ? error.name : "unknown"}) — the handle stays registered so nothing can cold-resume it`);
        },
      );
    },
  };
}

/**
 * `releaseHeld()` with no argument — the ONE messaging fact `settings-apply.ts` needs.
 *
 * The router's own door is `messaging.releaseHeld(receiver)`: it takes ONE address, sweeps that
 * receiver's mailbox, re-decides every held message and delivers what is now acceptable. A settings
 * change has no receiver — it changes the answer for ALL of them (a narrowed retention window can
 * free a name a sender is holding a message for) — so this iterates.
 *
 * WHERE THE RECEIVERS COME FROM, and why it is a union of two sources:
 *  * `store.mailboxes.receivers()` is the exact question "who is holding mail", and it is DURABLE —
 *    it includes receivers whose holds predate this daemon. It is only reachable when the host
 *    injected a store; the router's in-memory fallback is private to it.
 *  * `messaging.winterAdapter.sessions.addresses()` is every session live in THIS process. With no
 *    injected store (a daemon whose 8a spine would not open) this is the whole sweep, which is the
 *    honest degraded answer rather than no sweep at all.
 *
 * NEVER THROWS: one receiver whose re-evaluation fails must not stop the others, and the caller is
 * a settings diff that has nothing to do about it.
 */
export async function releaseAllHeld(
  sdk: Pick<RuntimeSdk, "messaging">,
  store?: Pick<RuntimeDirectoryStore, "mailboxes">,
  log?: (line: string) => void,
): Promise<DeliveryOutcome[]> {
  const receivers = new Set<SerializedRuntimeAddress>();
  try {
    for (const address of (await store?.mailboxes.receivers()) ?? []) receivers.add(address);
  } catch (error) {
    log?.(`releaseHeld could not list held receivers: ${error instanceof Error ? error.name : "unknown"}`);
  }
  for (const address of sdk.messaging.winterAdapter.sessions.addresses()) receivers.add(address);

  const outcomes: DeliveryOutcome[] = [];
  for (const receiver of receivers) {
    try {
      outcomes.push(...(await sdk.messaging.releaseHeld(receiver)));
    } catch (error) {
      log?.(`releaseHeld failed for one receiver: ${error instanceof Error ? error.name : "unknown"}`);
    }
  }
  return outcomes;
}

/**
 * The live messaging facet for one attached session, by its BACKEND id (P8b Task 13's door).
 *
 * Task 13's `task_stop` reaches a child through its OWNING session's facet — "a child engine has no
 * facet surface of its own" (surface map §9.2) — and the only registry of live facets is the one
 * `attachWinterSession` writes into. The address construction lives here so no other module has to
 * know that a Norma session is addressed by its backend id.
 *
 * The facet that comes back is the WRAPPER from `attachWinterSession`: `steerChild`/`resumeChild`
 * reach the real `Query.messaging` untouched, and only `deliver` is re-pointed at the host queue.
 */
export function attachedFacetFor(runtime: Pick<NormaRuntimeSdk, "sdk">, backendSessionId: string): SessionMessagingFacet | undefined {
  const address = serializeRuntimeAddress(buildSessionAddress(backendSessionId)) as SerializedRuntimeAddress;
  return runtime.sdk.messaging.winterAdapter.sessions.get(address)?.messaging;
}

/**
 * Park every session row the previous daemon left behind (fix round 1, F3).
 *
 * ⚠️ WHY `directory.recover()` IS NOT ENOUGH ON ITS OWN. The router's recovery marks a previously
 * live row `status: "unavailable"` and KEEPS its `backendSessionId`, and `deliverIntoSession`
 * refuses only `"archived"` — so every session row from the last boot stays cold-resumable from
 * inside a delivery. Today nothing actually spawns, because Norma supplies no `resumeOptions` and
 * the SDK cannot resolve a `winter` executable without being handed one. That is safety by accident
 * of an unresolvable binary, which is the same shape CLAUDE.md calls out for `reasoning_item` ("an
 * accident of a missing protocol variant, not policy"). This makes it policy.
 *
 * A Norma session is resumed by its DRIVER, from the 8a `runtime_sessions` record — which keeps its
 * own `backendSessionId` and is untouched here — on the next `send`/`steer` (P8b-24). The directory
 * row's copy exists only to let the router resume behind the daemon's back, so a row this process
 * has not attached does not get one.
 *
 * Never throws: a directory that will not answer costs the sweep, never the boot.
 */
export async function parkRecoveredSessions(
  runtime: Pick<NormaRuntimeSdk, "sdk">,
  log?: (line: string) => void,
): Promise<number> {
  let parked = 0;
  try {
    const attached = new Set(runtime.sdk.messaging.winterAdapter.sessions.addresses());
    for (const entry of await runtime.sdk.directory.list()) {
      // ⚠️ SCOPE CARRY (round 2, N-new-4): `session` rows only, which is COMPLETE as shipped —
      // nothing in `packages/core/src` records an `objectKind: "agent"` directory row yet. It stops
      // being complete the moment Task 16/17 starts recording children: the router's `childDelivery`
      // routes an `agent` row whose `transport` is `winter-session` into the SAME
      // `deliverIntoSession`/`coldResume` door, so a child row left behind by a crashed daemon would
      // reopen the restart door one row kind over. Widen this predicate in the same change that
      // starts writing those rows.
      if (entry.runtimeKind !== "winter-agent" || entry.objectKind !== "session") continue;
      if (attached.has(entry.address)) continue;
      // A row with no backend id has no resume source, which is the ONLY thing this sweep removes —
      // so it is already parked, whatever its status says (`detach()` leaves `exited`, this sweep
      // leaves `unavailable`, and neither should overwrite the other's account of what happened).
      if (entry.backendSessionId === undefined) continue;
      const { backendSessionId: _dropped, ...rest } = entry;
      try {
        await runtime.sdk.directory.record({
          ...rest,
          // `archived` is the ONE status the router refuses before `coldResume`, and the one
          // `isResolvableFrom` excludes — so re-stamping such a row `unavailable` would silently
          // un-archive it for name resolution and soften its refusal text. Nothing in this daemon
          // records an archived directory row today; this is a forward guard (round 2, N-new-3).
          status: entry.status === "archived" ? "archived" : "unavailable",
          capabilities: { message: false, resume: false, notifyWhenIdle: false, reply: false },
          updatedAt: new Date().toISOString(),
        });
        parked += 1;
      } catch (error) {
        log?.(`could not park ${entry.address} (${error instanceof Error ? error.name : "unknown"})`);
      }
    }
  } catch (error) {
    log?.(`could not sweep the directory for unattached sessions (${error instanceof Error ? error.name : "unknown"})`);
  }
  return parked;
}
