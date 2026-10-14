# Cowork outbox durability correction plan

This branch starts at frozen source `7678e77afac608bb478e1a081da0cf4d690231ba`.
It preserves that source for independent review. The frozen source's 404 passing
headless tests demonstrate process-restart reconciliation, ordering and access
boundaries; they do not demonstrate storage-device behavior after power loss.

## Observed gap

The frozen consumer calls `SessionStore.flushLog` before acknowledging a delivered
change in runtime-state SQLite. That method calls Node/Bun `fsyncSync`. Reviewer 45
identified the pinned Bun Darwin implementation as plain `system.fsync`; it does
not issue Apple's `F_FULLFSYNC` request. Consequently the frozen source must not
claim stable-media append-before-ACK ordering merely from the plain fsync call.

The canonical runtime-state connection currently uses WAL and
`synchronous=NORMAL` (`runtime-state/db.ts:354`). The correction must not change
ordinary Code's global connection settings or unrelated filesystem behavior.
Strengthening the log's ordering prerequisite before Cowork ACK is independent of
any further authority-transaction durability review.

## Narrow correction

Reuse the instruction owner's reviewed owned-FD durability helper; do not create a
second fcntl ABI binding or broad filesystem fallback. The reviewed helper is `fullSyncInstructionFd(fd)` from leaf
`d4b80a01af42d09e4b35161f5b300e1ade130f27`, cherry-picked here as `5086ceda`.
Its reviewed source SHA-256 is
`4321ffea8057aa359c1ddbc043b45dd1a38864a0858aee8badfa2f00791743b3`.
Actual disposable APFS directory FULLFSYNC succeeded; no directory fallback is
used. The helper requests plain fsync followed by FULLFSYNC and refuses failed
OS requests. Expected sequence:

1. Open the canonical, existing conversation log and hold its containing directory.
   Never recreate a missing log or directory as a durability shortcut.
2. Require the reviewed supported-filesystem policy using the held identities.
   Unsupported filesystems must leave the exact outbox delivery pending.
3. Complete the helper's reviewed file flush request. Sync directory metadata by
   its reviewed APFS rule: measured directory FULLFSYNC if supported, or the
   explicitly reviewed file FULLFSYNC plus ordinary directory fsync combination.
4. Only after these calls succeed, acknowledge that immutable workspace change
   and its exact JSONL event sequence. A failure leaves the first delivery pending
   and blocks later changes in that logical conversation.

Only Cowork outbox flushing changes. Ordinary session append, Code tools,
permission floors, native/VM admission and global SQLite policy remain outside
this correction. Runtime/sync authorship denial and current per-frame workspace
scope authorization must remain intact.

## Required evidence

The narrow primitive was accepted for disposable invocation. Use actual disposable conversation logs,
SQLite and SessionHub on the reviewed local filesystem. No live Winter paths,
Keychain, GUI/test host, native VM or worker are required. Exercise actual helper
success, unsupported filesystem refusal where testable, missing log handling,
append-before-ACK reconciliation and both existing process-crash windows. An
injected flush or filesystem success must not count as primitive evidence.

Record the exact helper/source commit, filesystem observations, OS calls/outcomes
and combined headless suite. A completed OS flush request is not a power-cut test
or a claim that hardware honored its cache-flush promise. Swift validation and
production activation remain separate gates.

## Current correction evidence

Actual outbox-owned JSONL plus held directory requests completed on APFS
(`statfs` type 26 / `0x1a`), Bun `1.3.14` revision
`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`. The explicit disposable fixture ACKed
exact event sequence 3 only after both calls returned successfully. The affected
outbox suite passed 14 tests / 91 assertions, including both process-crash windows,
real replay/current scope gates and missing canonical log refusal. No flush
success was injected. Core source typecheck passed.

This is not a hardware power-cut test. Other filesystem OS flush behavior remains
unmeasured. The exact shared `durableCoworkTransaction` source from guidance freeze
`b0f83df0bb96b53e37ad32ef3a6769b8de4509e6` is included unchanged (SHA-256
`486ae95a14881cd48038cfca86e33a9da66586149fe73824255a2a8f29cae4f0`). It scopes
FULL/fullfsync/checkpoint_fullfsync to canonical Cowork repository writes,
delivery ACKs and cleanup, then restores the original per-connection settings.
It rejects caller transactions/thenables and verifies configuration before and
afterward. The combined affected source suite passes 413 tests / 2345 assertions
across 16 files; Core/protocol/CLI typechecks pass. The new helper and integrated
source remain pending exact independent review. Read-back/OS requests do not prove
hardware honored a flush or establish power-cut behavior.

## Reviewer 45 corrections

O1: Explicit host deletion cleanup and post-recovery missing-session retirement
stop notification fanout, remove abandoned deliveries and preserve workspace/data.
Blocked live deliveries use exponential retry backoff capped at five minutes.
Keep 100 delivered receipts per conversation and prune old outbox rows only when
no delivery remains; unbound journal entries remain. Actual >100 pending-change
coverage checks ordered bounded draining and receipt/journal retention.

O2: Reconcile event payloads with `isDeepStrictEqual`, normalizing absent optional
fields to the persisted JSON wire shape. Actual reordered JSONL/legacy optional
field restart coverage pins this boundary without treating key order as content.

O3: The exact reviewed F_FULLFSYNC helper is reused. The instruction owner's
shared scoped SQLite durability wrapper is adopted byte-for-byte for
mutation/ACK/cleanup transactions, with final source acceptance pending exact
independent review.

O4: Per-frame authorization is preserved. No attach authorization cache is added.

O5/O6: These are ordinary admitted history SessionEvents, not stream-control types.
Source inspection verified old `v-web-kit1` WinterSessionClient's opaque JSONValue
path. Current workspace iOS source similarly ignores unknown transcript types,
but its cacheableTypes excludes workspace metadata and all-metadata old history
pages may repeat because the cache floor is unchanged. No iOS files were edited.
WinterKit ServerMessage.swift:95/110 catches strict enum errors per frame and
returns unknownEvent; WinterClient.swift:236/241 routes subsequent lines and
:302 emits the unknown frame without closing the transport. Swift runtime testing
was not performed.
