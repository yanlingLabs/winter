# Protocol and remote

*Read this before changing a `SessionEvent` variant or field, adding an RPC method, or touching what a remote (phone) client sees.*

## Protocol change checklist

A new or changed **`SessionEvent` variant**, in order:

1. `packages/protocol/src/events.ts` — the zod schema.
2. `packages/protocol/scripts/generate.ts` — a canonical fixture.
3. `pnpm protocol:generate` — schema + fixtures, synced into `apple/WinterProtocol`'s test bundle.
4. `packages/core/src/projector/event-coverage.ts` — BOTH `satisfies` maps (`SUBAGENT_TRANSCRIPT_INCLUDE`, `PROJECTED_EVENT_COVERAGE`); core's `tsc` fails until updated.
5. `apple/WinterProtocol` — mirror the Swift type; `RoundTripTests.swift` asserts the exact fixture count.
6. `apple/WinterKit` — `WinterClient.swift`'s `seq`/`sessionId` switches are exhaustive: a new variant breaks compilation THERE, not in WinterProtocol.
7. Build WinterKit AND the app; WinterProtocol's `swift test` never catches 6.

- A new **RPC method** skips 2–3 and 5 (`generate.ts` reads only `events.ts`): schema in `methods.ts`, handler in `packages/core/src/ipc/server.ts`, a Swift call site if needed, the four remote mirrors below if remote-reachable.
- **A new FIELD trips no compile-time trap**: sweep its PRODUCERS by meaning in both languages (`WinterChatKit`'s `ChatEngine` is a second producer, via `sync.push`) and ask whether a consumer's fallback silently accepts the old shape.
- The hello's client `capabilities` (`CLIENT_CAPABILITY_ISLAND`) and `tty`, and `island.pending`/`island.changed`, are local-only ([island](./island.md)): no event changed, nothing remote.
- A new **transient** goes in `TRANSIENT_EVENT_TYPES`, which `REMOTE_STREAM_EVENT_TYPES` spreads. Left out, remote clients never see it; the parity tests pin "exactly the current set" and cannot catch that.

## Remote allowlists

- FOUR lists in lockstep: `REMOTE_ALLOWED_METHODS` (`packages/core/src/ipc/server.ts`, 25 entries) + `packages/core/test/ipc/remote-allowlist-parity.test.ts` + Swift `Gateway.remoteAllowedMethods` (`apple/WinterKit/Sources/WinterKit/Gateway/Gateway.swift`) + `GatewayGateTests`' count.
- `REMOTE_ELIGIBLE_SESSION_MODES` (`code`/`dispatch`/`chat`): `assertRemoteMayUseSession` gates every bare-`sessionId` method, daemon-side.

## History and the remote stream

- `session.history` → `HISTORY_EVENT_TYPES` (`packages/core/src/sessions/history.ts`, 15 types): an ALLOWLIST, never a denylist; `reasoning_item` never passes (`test/sessions/history.test.ts` pins it); `thinking_block` and the wake pair (`wake_armed`/`wake_ended`; an old phone decodes them opaquely and skips them) are in. On both phone paths `phoneViewOf` replaces a `computer-wake` message's text with one daemon line built from that pair on the log (`sessions/wake-phone-line.ts`): the model's note and the fence never reach the phone. A new type needs `capEvent` to bound its strings at every depth (64 KiB/string, 160 KiB/event): the phone transport dies SILENTLY past 1 MiB.
- The remote live/replay stream is a SECOND allowlist, same obligation: `REMOTE_STREAM_EVENT_TYPES` = history ∪ `TRANSIENT_EVENT_TYPES` ∪ {`harness_attached`, `harness_detached`, `session_created`} + `capEvent` (`packages/core/src/sessions/remote-stream.ts`), one `createRemoteStreamFilter()` per remote `HubClient` (`ipc/server.ts`, `authedRole === "remote"`). History's set alone kills streaming. The three controls stay: the harness pair terminates the Gateway's replay (`awaitReplayBatch`; else a 5 s watchdog per attach), `session_created` is a fresh session's only replay (`IrohE2ETests`). The guard is the daemon's, not the Gateway's.

## Thinking pill

- `packages/core/src/projector/thinking.ts`: `system/reasoning_progress` frames → a transient `thinking_delta` (start/delta, the CURRENT title on each text-carrying delta) + one persisted `thinking_block` per block.
- Titles are derived ONCE, in the daemon, by fixed rules, no model call (`projector/thinking-title.ts`'s `decideTitle`): `summary`/`exposed` weigh standalone `**bold**` headings against an activity read from the prose; `update` is its own text; else "Thinking". Ported to `apple/WinterChatKit`'s `ThinkingTitleRule.swift`; `packages/core/test/projector/fixtures/thinking-titles.json` pins both — change all three. A streaming block is titled only from CLOSED text; `end` persists the whole-text derivation.
- Both phone paths withhold the text (`sessions/history.ts`'s `phoneViewOf`); the per-client filter forwards a title only when first seen or changed; log and Mac keep it all. `sync.push` refuses a `thinking_delta` (never in a log), accepts a `thinking_block` as sent.

## Phone mirror

A phone attached to a session sees Winter.app's own computer-use mirror of it, live. Frames never touch the daemon, the log, `session.history` or the event stream.

- **Gate** (`session.mirror {sessionId, watch}`, `packages/core/src/ipc/server.ts`): `watch: false` is never refused; else `assertRemoteMayUseSession`, caller attached to THAT session, chat → off, `{mirror}` = `computerUse.enabled && computerUse.mirror`, unreadable settings fail CLOSED. Renewed every 10 s; a refused renewal ends the watch; 30 s unrenewed drops it (`MirrorWire.renewEvery`/`lease`).
- **Wire**: the Gateway special-cases it like `session.attach` onto `WireKind.mirror` (no `seq`/`streamID`; payload `MirrorUpdate`, `WinterSessionKit`'s `MirrorWire.swift`) → `WinterSessionClient.mirror`. View-only (acks ride the session stream).
- **Source** (`apple/Winter/Sources/Mirror/`): `MirrorCoordinator` tees each session's sink to `RemoteMirrorHub`. A watch is a viewer in its own right (`addRemoteViewer`): subscribed over the one helper connection whether or not a Mac window shows the session, at the phone's caps (5 fps, 640 px) unless a visible window wants more, ref-counted beside windows, kept `remoteViewerGrace` (5 s) after the last phone leaves; an unseen panel decodes no pictures. Helper rules unchanged ([computer-use](./computer-use.md)).
- **Sizing** (`MirrorWire`): `RemoteMirrorRelay` (one per watch, off the Gateway and main actors) fits pictures to 640 px / ≤ 96 KB (else dropped), refuses envelopes over 256 KB, 5 fps while the agent acts, 1 fps after 3 s idle. Pictures ride their OWN low-priority uni stream (`RemoteConn.sendSide`; fallback the session stream), each acked by the phone (`WireKind.mirrorAck`), ≤ `maxUnackedPictures` (2) unacked, only the newest held back — a buffered QUIC write says nothing about the phone. `MirrorMailbox` never drops a control update; pictures collapse to the newest, cursors are bounded.
- A watch ends on `watch: false`, lease expiry, connection close, an attach elsewhere, revocation or eviction; scope: the attached session's own mirror only.

## Transient events

- ONE constant: `TRANSIENT_EVENT_TYPES` (`packages/protocol/src/events.ts`, 14 types) ↔ Swift `SessionEvent.transientTypes`/`.isTransient`, pinned by literal parity tests both sides (`remote-live-stream.test.ts`, `SessionEventTransientTests`). `WinterClient`, `WinterSessionClient` and the remote-stream filter DERIVE from it — never hand-copy.
- The daemon stamps a transient with the store's CURRENT `lastSeq` (`packages/core/src/sessions/hub.ts`): a client that dedupes by seq or advances its cursor on one drops them all, forever, silently.
