# Private owning Core context bridge — design for review

2026-10-14. Read-only source inventory on merged Core
`f60298bb90efe103a54265a1f7dca8518a61f891` (PR35). This document does not add an
issuer, callback, profile, runtime registration, public export or execution path.
SDK composition `0bed853a1bad07d50994a780334965d5ff918851` remains a separate
accepted source prerequisite, not native admission.

## Existing mechanisms and missing issuer

- `packages/core/src/cowork/current-context-callback.ts:43` fixes a trusted query
  identity and invokes the real current-context resolver. It is an unwired factory;
  constructing it does not register/admit a guest.
- `current-context.ts:157` defines `currentRegistration(trustedQuerySessionId)` as a
  trusted owning-registration port. The planner checks canonical runtime records,
  logical conversation/workspace binding, generation, boot, incarnation, lease,
  source acknowledgments and current grants. No production issuer implements the
  owning registration today.
- `current-context-resolver.ts:199` creates a derived reader abort signal and its
  own canonical read ID, with final registration/policy/grant checks after reader
  inspection, mapping and cleanup. Those checks must stay intact.
- `structured-instruction-mapper.ts:70` maps the actual structured snapshot into
  the Core request, including only the reviewed shared logical alias. It is not
  a discovery parser or native read authority.
- `guest-runtime.ts` captures one-use canonical launches and guards transport
  lifetime, but `GuestRuntimeSupervisorPort` explicitly has no production native
  implementation. Its current launch scope lacks backend generation and a guided
  reader registration. A capability boolean, channel shape, class instance or
  prepared launch cannot substitute for a verified owning issuer.

## Smallest private contract

The canonical host/workspace controller must own one non-serializable parent
context owner per actual parent incarnation. The host's supervised sandboxed
worker/native bridge must supply independently verified runtime/channel admission;
guest JSON and ordinary SDK callback construction cannot create this owner.

The immutable capture must bind:

- canonical HomeIdentity and workspace ID;
- logical Winter parent ID, with no parent/child ambiguity;
- actual SDK `config.sessionId`, also the captured backend ID used as
  `trustedQuerySessionId`, and the canonical backend generation;
- boot ID, incarnation ID, lease epoch and owning launch/channel identity;
- the consumed SDK version/binding correlation, once, before Root bootstrap;
- Root's exact reader registration/view identities, selected source/revision/root/
  cwd, dedicated shared view and four required loader limits.

Preparation/correlation is allowed before launch, but the private owner's phase
must remain unavailable for context/reader dispatch until the actual admission is
verified. Current registration lookup must return unavailable on close, revocation,
replacement, stale generation/boot/incarnation/lease, unknown child or unsupported
kernel/profile. Every successful lookup must come from that owning controller and
current canonical records, not an arbitrary caller-provided registration object.
The existing planner's trusted port may return its bounded projection only after
these checks; it does not become a public registration endpoint.

No implementation or test-created native admission is proposed here. In particular,
do not add a public `registerContext(dto)` or export a preparation-bearing callback
factory through Cowork APIs, daemon methods, tool callbacks or shared configuration.
Root must first identify/implement the verified issuer and its private ownership
slot. Until then production context construction stays refused.

## Per-invocation adapter, not a shared signal registry

The private owning host query object keeps SDK preparation and its exact callback/
spawn hook together. On an actual SDK callback it checks the owning slot, exact SDK
backend query identity and parent-only request, then captures the ORIGINAL callback
signal. That identity is correlation only; it does not replace canonical authority.

Construct the existing resolver/handler with a per-invocation protected-reader
dependency that closes over this original signal and owner. Do not store one
mutable "current signal" on a reusable workspace or shared callback: concurrent
conversations/contexts must not borrow each other's handles.

When the resolver calls that reader with its canonical request and derived signal:

1. Compare canonical registration/request to the owner's immutable logical parent,
   SDK backend/generation, workspace, boot/incarnation/lease and selected views.
   Check the current owning slot before invoking the SDK private handle.
2. Call `readGuidedQueryInstructions(ownedPreparation, originalCallbackSignal)`.
   The resolver's derived signal is NOT an interchangeable lookup identity. Its
   timeout/cancellation may stop awaiting the read; callback completion/abort/exit
   closes the SDK scope. Root/native reader debt remains independent of a rejected
   Promise or EOF, and normal release waits for actual cleanup.
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

Packet parsing must remain in the sandboxed host worker/helper, never the credential
daemon. The host controller's canonical authority/ownership projection and the
worker's authenticated parser/reader surface are distinct responsibilities. Their
production transport placement is still required before this adapter can activate.

## Source tests after contract/issuer review

Use real canonical DB/repository/runtime rows with isolated homes/coordination and
injected reader/owner observations. These are source tests, not native proof.

- Bind actual SDK backend ID versus logical Winter parent, generation and current
  callback identity; reject caller DTO, wrong parent/child, wrong preparation,
  derived/foreign signal and stale boot/incarnation/lease before reader effects.
- Run two overlapping invocations and two same-workspace conversations to prove
  per-invocation closure ownership without introducing a workspace locking service.
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
