import { TRANSIENT_EVENT_TYPES, type SessionEvent } from "@norma/protocol";
import { HISTORY_EVENT_TYPES, capEvent } from "./history";

// ================================================================================================
// The policy for the LIVE + REPLAY event stream of a REMOTE-role connection (the phone).
//
// `session.history` has been allowlist-guarded and size-capped since it shipped; the live/replay
// feed — the OTHER half of the same transcript, reaching the same phone over the same link — never
// got the same treatment. Everything below closes that asymmetry. It is enforced DAEMON-side, in
// `ipc/server.ts`'s `session.attach` HubClient, for the same reason `assertRemoteMayUseSession` and
// the relay-config anti-rollback rule are daemon-side: the Swift Gateway is one client of this
// socket, not the boundary. Any remote-role connection (norma-probe, norma-fake-phone, a future
// non-Swift or non-Mac-mediated client) is covered by construction, and the guard cannot be
// bypassed by a client that simply never updates.
//
// HARNESS/ADMIN/PLUGIN CONNECTIONS ARE UNTOUCHED. The Mac app and the CLI still receive every event
// byte-identically — this policy is scoped to `authedRole === "remote"` at the one call site.
// ================================================================================================

/** Structural events that are NOT phone CONTENT (the transcript never renders any of them) but that
 *  the stream above the daemon depends on. All three are tiny, fixed-shape, and carry no user text
 *  and no filesystem path — `session_created` is `{scope, mode}`, the harness pair is
 *  `{clientName}` — so carrying them costs nothing and leaks nothing. **Do not "clean this up" by
 *  dropping them here**; each is load-bearing in a way that is invisible from this file:
 *
 *  - `harness_attached` / `harness_detached`: `hub.attach` appends a `harness_attached` for the
 *    attach itself and returns ITS seq; the Swift gateway's `attachAndReplay` uses that seq as the
 *    replay batch's TERMINATOR (`awaitReplayBatch` waits for `collected.last.seq >= target`) and
 *    only then computes the honest content watermark. Filter them daemon-side and the terminator
 *    never arrives, so EVERY attach — every chat open, every reconnect — burns the collector's full
 *    5s watchdog first. The gateway drops them itself one hop later
 *    (`Gateway.isHarnessNoise`), which is where the "no harness_attached/detached leak" guarantee
 *    (SP2a gate G1) is actually enforced.
 *  - `session_created`: seq 1 of every session, and therefore the ONLY thing a fresh session has to
 *    replay. Two real-transport E2E scenarios (`IrohE2ETests` B and D) pin it as the vehicle for
 *    the attach-ordering contract — "the attach's own replay must precede its rpcResponse" — and
 *    dropping it also flips a brand-new session's resume verdict (an empty content batch makes the
 *    watermark fall back to `fromSeq`). Nothing is gained by excluding a two-field event. */
const STREAM_CONTROL_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set<SessionEvent["type"]>([
  "harness_attached",
  "harness_detached",
  "session_created",
]);

/** The event types a REMOTE-role connection may receive on the live/replay stream.
 *
 *  Allowlist, never a denylist — an unknown future type stays out until deliberately added, and
 *  adding one REQUIRES confirming the per-event cap bounds its large strings at every depth
 *  (`capEvent` walks strings at ANY depth, which is what admitted `question_asked`'s nested
 *  `options[].description`). Chief exclusion: `reasoning_item`, whose `itemJson` wraps the
 *  provider's opaque `encrypted_content` — CLAUDE.md: the session JSONL is its only sink.
 *
 *  **Why this is NOT simply `HISTORY_EVENT_TYPES` (read before editing).** History's allowlist
 *  governs replay of PERSISTED events, so it excludes the transients BY CONSTRUCTION — they are
 *  never on disk to be paged. Reusing it verbatim here would drop every `assistant_delta` one hop
 *  UPSTREAM of the phone client that was just fixed to accept them, silently restoring the
 *  no-streaming-on-iOS bug with a fully green suite, because nothing else covers a transient
 *  traversing this seam. The live policy is therefore history's allowlist PLUS
 *  `TRANSIENT_EVENT_TYPES` (the canonical eight, hoisted into `@norma/protocol` so the daemon and
 *  both Swift clients derive from ONE definition) PLUS the three stream-control types above.
 *
 *  The transient half is SPREAD, never re-listed: that is what discharges CLAUDE.md's
 *  protocol-checklist addendum ("a new transient variant must be added to `TRANSIENT_EVENT_TYPES`
 *  *and* to `REMOTE_STREAM_EVENT_TYPES`") by construction — the one edit in `@norma/protocol`
 *  reaches both lists. Do not replace the spread with literals to "make the set explicit": the
 *  parity tests pin the RESULT, and they cannot catch a type that was never added to a hand-copy.
 *
 *  Deliberately absent, and verified harmless: `session_titled`, `turn_started`, and the rest of the
 *  lifecycle/opaque surface. The phone's transcript folds exactly
 *  `HISTORY_EVENT_TYPES ∪ {assistant_delta}` and `default: break`s on everything else
 *  (`norma-ios` `Transcript.apply`); a non-cacheable persisted type doesn't touch its
 *  `mergedEnvelopes`/`maxFoldedSeq` bookkeeping either (`CodeSessionModel.applyEvent`), so dropping
 *  one upstream is a pure no-op for the phone UI. If the phone ever WANTS one of them (a
 *  turn-lifecycle signal, a live title), it has to be added here deliberately — it will not just
 *  start working. */
export const REMOTE_STREAM_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set<SessionEvent["type"]>([
  ...HISTORY_EVENT_TYPES,
  ...TRANSIENT_EVENT_TYPES,
  ...STREAM_CONTROL_EVENT_TYPES,
]);

/** Applies the remote live/replay policy to one event.
 *
 *  Returns `null` when the event must not cross the wire to a remote client, otherwise the event
 *  bounded by `capEvent` — the SAME helper and the same two constants `session.history` uses, so
 *  live and history hand the phone byte-identical bytes for the same event.
 *
 *  **Why the size cap is not optional.** The phone transport's de-framer has a hard 1 MiB limit
 *  (`LengthPrefix.unwrap`, `IrohConn.readLoop`) and its overflow path is a SILENT KILL: the read
 *  loop catches, `cont.finish()`es the inbound stream, and the phone simply reconnects — no error
 *  frame, no log, nothing on either end that names the cause. A single oversized event (a
 *  `tool_call` whose `argsJson` carries a large file write is the easy one; tool OUTPUT is capped
 *  at 64 KiB by the tool registry, tool ARGUMENTS are not) therefore kills the connection, and if
 *  that event sits inside the attach replay window it kills it again on every reconnect — an
 *  unbreakable loop that presents exactly as "it reconnects every time I open a chat".
 *  `session.history` has guarded against this since it shipped (see `WHOLE_EVENT_CEILING`'s own
 *  comment, which describes this same hazard); the live/replay path had no guard at all.
 *
 *  Events are never rewritten in place: `capEvent` returns the SAME reference when nothing needed
 *  capping (the overwhelmingly common case), so the fan-out to other clients is unaffected. */
export function filterRemoteStreamEvent(event: SessionEvent): SessionEvent | null {
  if (!REMOTE_STREAM_EVENT_TYPES.has(event.type)) return null;
  return capEvent(event);
}
