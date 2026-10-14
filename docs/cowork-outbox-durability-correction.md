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
2. Require Darwin/arm64 explicitly before opening flush descriptors, then verify
   owned regular file/held directory identities. There is no filesystem-type
   allowlist/check in this implementation.
3. Complete the exact reviewed file and directory FULLFSYNC requests. Any failed
   request refuses ACK; no ordinary-fsync or unsupported-operation fallback is
   used. Only disposable APFS behavior was measured. ExFAT/SMB refusal or other
   filesystem success has not been demonstrated, and is not inferred from this
   strict OS-return-value check.
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

## Follow-up binding and maintenance review

B1: `bindConversation` requires a mandatory trusted committed-session port; no
optional/default-true path exists. The production adapter is the actual open
SessionStore's `hasCommittedSession`, which requires an index row with initial
event sequence >=1 outside any open index transaction. Session creation/index
commit must finish first; binding follows synchronously, without an await or
reentrant lifecycle operation and while that same host-owned store remains open.
The stores are separate databases; no cross-database atomic commit is claimed.
Binding rechecks the port inside its canonical transaction. Pure authority-unit
fixtures declare explicit inventories; actual outbox integration uses real rows
and checks absent, empty and uncommitted-row rejection. No production Cowork
session create/bind caller is implemented or enabled by this API correction.

B2/B4: Retry windows use a monotonic performance clock rather than Date.now.
Drain metrics report `deferred` sessions during backoff distinctly from new
failures. Actual expiry/reset coverage also changes the wall clock to ensure it
cannot prematurely expire a retry. Recovery clears the backoff. New metadata does
not by itself reset a failure for the first immutable pending change.

B3: Boot reaping and live deletion now share the same canonical retirement hook.
The boot path is wired before its reaper runs. An actual disposable old session
reaper test checks both runtime-cleanup notification and canonical fanout cleanup.

B5: Pruning errors report `pruneBlocked` separately after successful delivery and
ACK; they cannot mark those deliveries failed or install message retry backoff.
Actual disposable SQL trigger failure tests pin this separation.

B6: The OS/architecture guard is explicit, but a filesystem-type admission policy
is not implemented. Current evidence is measured APFS OS-request completion, not
an ExFAT/SMB denial test, proof for other filesystems, or hardware power-cut proof.
Exact reviewed native/SQLite primitives remain byte-identical.

Follow-up verification: 660 tests passed / 2 skipped / 0 failed with 4859 assertions
across 26 files. The skips are the unsupported-host-only case on this Darwin/arm64
machine and the existing candidate SDK confined-posture fixture gate. Core,
protocol and CLI typechecks pass. The three reviewed durability/descriptor helper
hashes remain unchanged.

The broader context regression now distinguishes a rejected same-connection
nested write (context_unavailable, policy/workspace unchanged) from a real second
SQLite connection's committed policy change. WAL snapshot isolation preserves one
coherent old plan while its read transaction is open; the next plan sees the new
revision. A separate actual external-connection commit across the protected-reader
await is refused by final canonical revalidation. No nested-write guard was relaxed.

Final recovery audit: an existing index row cannot cause the outbox consumer to
recreate a missing/empty/uninitialized JSONL. Require the existing matching
seq-1 session_created header before append. The actual missing-log consumer test
checks blocked delivery, pending receipt, preserved active binding and no file
recreation. Ordinary Code's append behavior is unchanged.

The final recovery-guard composition reran the same 26-file set: 660 passed,
2 skipped, 0 failed, 4862 assertions. Core typecheck passed after the guard;
protocol/CLI typechecks passed on the preceding binding/maintenance freeze.
