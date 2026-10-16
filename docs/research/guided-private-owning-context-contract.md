# Private owning Core context bridge — design, reviewed

2026-10-14 (inventory), **reviewed 2026-10-16; Slice A implemented in this PR.**
Read-only source inventory on merged Core `f60298bb90efe103a54265a1f7dca8518a61f891`
(PR35). SDK composition `0bed853a1bad07d50994a780334965d5ff918851` remains a
separate accepted source prerequisite, not native admission.

Slice A (the private owning slot, `packages/core/src/cowork/guest-context-owner.ts`)
is source only. It adds no issuer, callback registration, profile, public export,
barrel entry, daemon method or execution path. Its evidence port is an abstract
interface with no implementation anywhere in `src/`, so production context
construction stays refused. Slice B (the per-invocation reader adapter) is next.

## Existing mechanisms and missing issuer

- `packages/core/src/cowork/current-context-callback.ts:43` fixes a trusted query
  identity and invokes the real current-context resolver. It is an unwired factory;
  constructing it does not register/admit a guest.
- `current-context.ts:159` defines `currentRegistration(trustedQuerySessionId)` as a
  trusted owning-registration port. The planner checks canonical runtime records,
  logical conversation/workspace binding, generation, boot, incarnation, lease,
  source acknowledgments and current grants. Slice A is the first implementation
  of that port, and it is only reachable through a private slot; no production
  issuer feeds it.
- `current-context-resolver.ts:199` creates a derived reader abort signal and its
  own canonical read ID, with final registration/policy/grant checks after reader
  inspection, mapping and cleanup. Those checks must stay intact.
- `structured-instruction-mapper.ts:65` maps the actual structured snapshot into
  the Core request, including only the reviewed shared logical alias. It is not
  a discovery parser or native read authority.
- `guest-runtime.ts` captures one-use canonical launches and guards transport
  lifetime, but `GuestRuntimeSupervisorPort` explicitly has no production native
  implementation. Its launch scope lacks the backend generation and a guided
  reader registration. A capability boolean, channel shape, class instance or
  prepared launch cannot substitute for a verified owning issuer.

## Bound identities (F5)

Three identities are bound, each by its own authority, and none stands in for
another:

- **Core `launchId`**: minted by the supervisor for one prepared launch. The slot
  captures it and requires the evidence to repeat it.
- **Root `registrationId`**: Root's identity of the retained reader registration.
  The slot never mints it; the evidence reports it, and an optional captured plan
  must match it.
- **SDK `bindingId`**: the SDK's runtime-context correlation, supplied once as
  plain data. Core keeps no ledger of binding IDs across owners; the SDK's
  process-local consumed set stays the only replay set.

The logical Winter session ID, the SDK backend session ID (also the trusted
query ID) and the backend generation are distinct and are all captured.

## Smallest private contract

The canonical host/workspace controller owns one non-serializable parent context
owner per actual parent incarnation. The host's supervised sandboxed worker/native
bridge must supply independently verified runtime/channel admission; guest JSON
and ordinary SDK callback construction cannot create this owner.

The immutable capture binds, from canonical rows only:

- canonical HomeIdentity (`launch.scope.homeId`, compared with the recorded identity)
  and workspace ID;
- logical Winter parent ID, with no parent/child ambiguity;
- actual SDK `config.sessionId`, also the captured backend ID used as
  `trustedQuerySessionId`, and the canonical backend generation read from the
  runtime row (`GuestRuntimeScope` does not carry it);
- boot ID, incarnation ID, lease epoch and owning launch ID;
- the selected source ID/revision/root/access, the canonical cwd and the frozen
  capabilities;
- optionally, inert and unused for authority: Root's reader registration ID, the
  exact views and the four loader limits.

**F4.** The `trustedQuerySessionId == backendSessionId` invariant is enforced at
capture: the launch's SDK session ID must equal the scope's backend ID and the
canonical runtime row's backend ID, or the capture is refused.

Phases are one way with no revival: `open` then exactly one of `closed`,
`revoked` or `replaced`. A lookup returns a registration only when the phase is
open, the host-supplied lifetime is held, the evidence matches the capture
exactly (profile, owner mirror, launch, binding, kernel), this owner is the
registry's current owner for its backend session, and canonical records still
agree. Anything else returns `undefined` and never throws.

**F6.** The correlation is write-once, not immutable: it is unset until the host
supplies `{ version: 1, bindingId }` once, and a second call is refused even when
identical. The lifetime holder is write-once the same way. A lookup is unavailable
until both exist.

**F7.** "Unknown child" and "unsupported kernel/profile" are not decided by Core
lookup. A child is refused because its canonical runtime row names a parent, and
a foreign or unknown backend identity fails the canonical comparison. Kernel and
profile support are enforced via the evidence: the port must report profile
`host-query-guided-v1` and `pidfs` and `peerPidfd` both `true`. Core cannot
observe a kernel; it only refuses evidence that does not say so.

**F8.** Extra capture fields (home ID, launch ID, cwd, reader plan) stay inside the
owner. The port's return type is the closed 13-field `CoworkContextRegistration`,
returned as a fresh deep-frozen copy on every call. Grants, policy and source
revocation stay with the existing planner, which is unchanged.

**F3.** Lookup is synchronous, pure and cheap. It uses `recordedHomeIdentity()`,
never `homeIdentity()`: the latter is a durable writer that throws
`authority_denied` inside a transaction, and the planner calls the registration
port inside its read transaction. The independent supervisor `bootId(workspaceId)`
dep is reused instead of implementing `currentBootId`.

### Evidence port seam (F11)

`CoworkGuestOwnerEvidencePort.evidence(capture)` is synchronous and never cached;
it is called at every lookup. It returns data, not a decision: profile, Root
registration ID, a seven-field owner mirroring the runtime's
`LinuxGuidedReaderOwner` (workspace, logical session, backend session,
incarnation, lease epoch, boot, generation), the launch ID, the SDK binding ID and
a kernel record. It has no implementation in `src/`; an anti-wiring test pins
that and pins that no `src/` file imports the slot.

What a positive test proves: the slot's own logic (phases, write-once attachments,
registry currency, closed shapes, canonical agreement) against a FAKE port. It
never proves issuer authenticity, kernel facts or native admission. A real port
must report what the native owner has just verified (its descriptor-based owner
check), and its authenticity is a separate review.

Core's SDK pin (0.0.53) has no guided module, so the slot imports no SDK guided
type; the correlation and evidence are plain-data mirrors of the SDK shapes.

## Per-invocation adapter (Slice B, not in this PR)

**F1.** Core cannot call the SDK's private `readGuidedQueryInstructions`, and its
SDK pin does not contain it. The per-invocation reader adapter therefore sits
behind an abstract `readFrame(signal)` port, supplied by whoever holds the SDK
side; Core never reaches a private SDK handle.

**F9.** That adapter is not additive to the existing callback factory. The factory
(`createCoworkRuntimeContextHandler`) takes one protected reader at construction;
the guided reader must close over a specific invocation's original callback
signal and owner, so the guided path needs its own per-invocation composition
that reuses the resolver and mapper rather than being threaded through the shared
factory.

On an actual SDK callback the private owning host query object checks the owning
slot, exact SDK backend query identity and parent-only request, then captures the
ORIGINAL callback signal. That identity is correlation only; it does not replace
canonical authority.

Construct the existing resolver/handler with a per-invocation protected-reader
dependency that closes over this original signal and owner. Do not store one
mutable "current signal" on a reusable workspace or shared callback: concurrent
conversations/contexts must not borrow each other's handles.

When the resolver calls that reader with its canonical request and derived signal:

1. Compare canonical registration/request to the owner's immutable logical parent,
   SDK backend/generation, workspace, boot/incarnation/lease and selected views.
   Check the current owning slot before calling the `readFrame` port.
2. Call `readFrame(originalCallbackSignal)`. The resolver's derived signal is NOT
   an interchangeable lookup identity. Its timeout/cancellation may stop awaiting
   the read; callback completion/abort/exit closes the SDK scope. Root/native
   reader debt remains independent of a rejected Promise or EOF, and normal
   release waits for actual cleanup.
3. Inspect bounded closed reader-frame data and compare owner/views/limits with the
   fixed owning registration and canonical request. The SDK and admitted runtime
   own wire read correlation; Core's canonical read ID is distinct from the SDK's
   generated read ID. Never silently rewrite one into evidence for the other.
4. Pass only `frame.snapshot` to `mapStructuredCoworkInstructions(snapshot,
   canonicalRequest)`. Preserve the actual loader/mapper semantics and final Core
   checks; do not add another walker or parse instruction text headings.
5. Return the primitive snapshot from the existing handler directly. Do not run an
   external owner/getter/mapper callback AFTER the resolver's final canonical guard,
   because that callback could invalidate the just-checked authority.

**F10.** Parsing boundary: the frame is guest-controlled bytes. It is parsed only
inside the sandboxed host worker/helper, never in the credential daemon. The host
controller's canonical authority/ownership projection and the worker's
authenticated parser/reader surface are distinct responsibilities, and Core
receives only the already-parsed, closed, bounded `frame.snapshot` data. Their
production transport placement is still required before this adapter can activate.

## Open SDK-side decision (F2)

This slot does NOT lift the SDK host guard (`query.ts` around lines 804-813 and
960 in the SDK checkout). Whether and how that guard is lifted, and the SDK's
generation-expiry and replay policy, remain open SDK-side decisions. Slice A
encodes only rules already in code and docs: one-way phases, a write-once
correlation per owner, monotonic canonical counters instead of a TTL, and at most
one owner per backend session.

## Source tests (Slice A, in this PR)

`packages/core/test/cowork/guest-context-owner.test.ts` uses the real canonical
DB, repository and runtime rows, launches from the real supervisor's
`prepareQuery` with a port that is never opened, and a FAKE evidence port. It
covers backend ID versus logical parent versus generation, forged objects and
DTOs, wrong parent/child, stale boot/incarnation/lease, zero reader calls through
the real callback handler (equal trusted and backend IDs), per-owner isolation,
revocation during the reader await with the real resolver, no throw on any lookup,
no home-identity mint inside a transaction, write-once correlation, supersede and
terminal behavior, non-serializability and the anti-wiring grep. The existing
callback, planner, resolver, mapper and guest-runtime suites run unmodified.

## Source tests after the issuer and Slice B

- Run two overlapping invocations and two same-workspace conversations through the
  per-invocation adapter to prove closure ownership without a workspace locking
  service.
- Validate the actual structured mapper's alias/import/provenance behavior and
  reject owner/view/limit mismatches, dropped/skipped data and post-read revocation.
- Cover derived timeout/normal reader cleanup versus original callback abort,
  late replies and independent unresolved Root reader debt; zero provider dispatch
  after required context refusal.
- Preserve existing Core callback/planner/resolver tests and ordinary Code behavior.

Actual issuer, channel/kernel/native view/teardown evidence, guarded Root delivery,
full source/artifact packet and profile activation remain separate. No SDK pin,
release, C DATA application, VM/root/native execution or held-task workaround is
authorized by this design.
