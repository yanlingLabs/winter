# Canonical current-context planning

`CoworkCurrentContextPlanner` is a host-only, parent-only prerequisite for the
required-context callback. It returns deterministic host facts and instruction
scope descriptors. It is **not** an SDK `RequiredContextSnapshot` resolver: it
returns no instruction bytes, installs no callback and activates no query,
guest profile, child factory, provider, publication action or VM.

Construct it only for an existing host-owned query registration. Its
`trustedQuerySessionId` comes from the owning SDK query/backend binding, never
from the guest init frame, nonce or request. The current registration port must
represent the authenticated owning Linux launch/view, boot and incarnation; this
TypeScript shape does not establish native ownership. The adapter reads the actual
`RuntimeSessionRecords` over the same canonical runtime-state DB, derives the
logical conversation-to-backend relation and checks backend generation/state,
workspace/binding ownership, incarnation and boot. A resumed lookup's backend ID
must be reached through that canonical relation. Any `agentId` is refused now;
no unknown-child wait or provisional registration exists. Future child admission
must resolve ordered registration before its first context request.

Each call rereads workspace, binding, policy, current sources and grants. SQLite
reads use one synchronous transaction; there is no cached plan and no equality
check against old config/grant/instruction revisions. New source/policy state can
refresh within the same authenticated boot. A ready source also needs its current
acknowledgment, readable grant and exact host-registered view root/revision/access.
Removed/revoked/unavailable bound sources block planning immediately. External
grant and registration ports are independent mutable authorities: two grant
snapshots are compared, followed by a final metadata/registration/boot guard with
no later grant callbacks. A detected change refuses rather than mixing records.
These checks do **not** make external authority globally atomic or detect every
concurrent/ABA change; that stronger guarantee requires the provider's monotonic
grant generation/revision. Revalidate current authority before subsequent effects.

The lookup cwd is bounded lexical discovery data inside the binding's source root,
not a source/grant selector or system-authored text. Canonical folder and repository
root spellings share `coworkGuestSourceRoot` with launch planning. The protected
reader must additionally enforce physical path containment inside the guest.
In-source directories/worktrees are within this scope; separate persistent
worktree roots or another attached source require canonical owning-source/view
registration and future reader handling. This planner does not enable those paths.
Shared guidance is always required at `/workspace/.winter/WINTER.md`; the plan
names a guidance-only import scope and never proposes the broad `.winter` tree,
which also contains stores, as an import root. Source guidance admission is
independent of executable configuration trust, including for untrusted sources.

The future **protected guest-router instruction-snapshot port** must load bytes
in the owning guest filesystem using the Runtime SDK's accepted guidance-only
`loadInstructionSnapshot` resolver. It must implement an admitted guidance-only
root/alias mapping (such as the contract's protected `/run/winter/shared-instructions`
view), preserve Code filenames/order/import/read checks and the required shared
file contract, and load no executable settings, hooks, MCP or items. No such port
or RPC is registered by this change. Bind its request to the exact planned
session/boot/incarnation/current generation, pass cancellation, then recompute
and validate canonical authority after the asynchronous read. Reject a changed
plan, NUL/oversized text, missing shared file or invalid provenance; return no
partial/cached fallback. One resolver must own text bounds and neutralization,
and derive the final SDK revision from exactly the host facts plus instruction
bytes/provenance of that generation. This plan's revision is diagnostic provenance,
not a token that can authorize that read. The 128 KiB plan limit and raw instruction
reserve do not replace the final facts+instructions, provenance/envelope and
rendered-context bounds.

Publication default mirrors `CoworkRepository.githubOnly`: a removing folder
still counts until detached. Added folders narrow automatic publication immediately.
For the configured GitHub-only policy, an active feature-commit/push completion
obligation requires at least one current publication candidate and remains subject
to task/guidance narrowing and current host authority. Without a candidate, the
plan reports automatic completion unavailable, distinct from a manual policy,
and directs respect for current session/task limits and reporting blocked publication.
The unavailable fact is neutral about local commits; plan policy remains read-only.
Removing a seed paragraph does not erase that policy. Candidate repositories still
need the Git broker's task/source/ref/destination checks; this plan grants nothing
and cannot execute publication. Local read-write GitHub checkout admission requires
readable repository authority, while **remote push** additionally requires writable
repository authority. A remote write revocation removes publication candidates
without revoking local checkout access. No source labels/titles, private host roots,
credential/store locations or standalone grant/authority handles enter visible
facts/output. A folder grantRef appears only as a canonical admitted guest path
segment, never as guest-supplied host authority. Guest paths retain their
canonical admitted-root spellings; private
identity metadata is only hashed for change detection. Facts and revision have a
literal golden regression and deterministic ordering. SDK pins, protocol events,
release versions and production availability remain unchanged.
