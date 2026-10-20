# Parent current-context callback adapter — source prerequisite

`packages/core/src/cowork/current-context-callback.ts` privately adapts the SDK
callback to the merged `CoworkCurrentContextResolver`. It has no daemon call site
or public Core export. The host supplies the existing canonical resolver deps and
protected-reader port; the adapter creates no registrations or filesystem walker.

The factory captures the host's fixed `trustedQuerySessionId`. Each callback
descriptor-validates a closed request and options object, checks the SDK-owned
query identity, refuses children and already aborted calls, and copies only the
bounded backend session/cwd/purpose/attempt lookup into the actual resolver.
`bindingId` is bounded correlation only. The resolver alone decides current
backend/root ownership and rechecks canonical policy, sources, grants, registration
and boot identity after the fresh read and reader cleanup. The adapter returns its
bounded primitive-only snapshot directly; refusals become the generic SDK
`required_context_unavailable` error, with no cached fallback or private diagnostics.

Winter's pinned SDK predates the callback type. The local structural contract
matches `packages/sdk/src/runtime-context.ts` at merged SDK commit
`8603da22d9fe7f1695166891cd29ccd254b1d21e`, whose public index exports the
handler/request/snapshot and parsers. A temporary compile-only check against that
commit's exact `git show` contract bytes passed two-way handler and request
assignability. No foreign checkout path is imported by product source, and no
package pin or installed dependency version changed. Full staged candidate closure
and actual query/profile wiring still need the later compile-only fixture gate.

Validation on base `d1853101` (merged Core mapper PR34): the adapter suite passed
14 tests / 320 assertions; planner, resolver, mapper and adapter together passed
106 tests / 1,833 assertions; `bun run typecheck:core` passed. Tests use real
disposable canonical DB/repository/runtime records and double only the protected
reader and owner/grant ports. They cover atomic host shared-file replacement,
current host publication facts, canonical drift during reader await, cleanup-time
final recheck, malformed/foreign/child refusal, cancellation, reader failure and
oversized results. The filesystem freshness test reads an ordinary temp fixture
file; it is not a native reader/view or transactional snapshot proof.

No guest profile, owner/view admission, reader execution, daemon registration,
native launch, activation, SDK release/pin change or ordinary Code behavior change
is implemented by this slice. Current native holds remain in force.
