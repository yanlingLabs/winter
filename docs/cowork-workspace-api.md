# Cowork workspace metadata API slice

Implemented on 2026-10-11 in the isolated `cowork/workspace-api` worktree, based on
`cowork/host-authority` at `10296d6b`. This is a host metadata/control slice of the
accepted [host protocol](cowork-host-protocol.md). It does not pass the native,
encrypted storage, active memory-return, execution or UI gates.

## Implemented surface

The daemon builds `CoworkWorkspaceService` over the canonical runtime-state DB.
The schema/method inventory is `packages/protocol/src/cowork.ts`; RPC routing is
in `packages/core/src/ipc/server.ts`. Swift typed records/requests live in
`apple/WinterProtocol/Sources/WinterProtocol/Cowork.swift`, with Mac and paired
client adapters in WinterKit and WinterSessionKit. All four allowlist mirrors
now contain 40 methods (the preceding 25 plus 15 workspace routes).

| Methods | Result/authority |
| --- | --- |
| `workspace.list/get`, `project.list/get` | Explicit complete snapshots or bounded summaries for oversized legacy records. Each includes workspace identity/revisions; summaries include policy metadata/counts, source count and detail methods. List filtering and each lookup use the same current-authority gate. Pages contain at most 100 entries and fit the byte budget. |
| `workspace.create`, `project.create` | Host-admitted initial selections and ceiling; durable preparing receipt and reserved standalone owner identity or Project identity. Production is blocked by `unsupported_topology`; paired creation remains unsupported pending persisted peer creation-admission. |
| `workspace.update`, `project.update` | Title only, expected workspace configuration revision; metadata applies in the transaction and its operation is immediately applied. |
| `workspace.source.list/get` | Complete source identities, desired membership, readiness, revisions, restart/trust status and safe reason. List pages shrink to the byte budget. Source/workspace scope must match. |
| `workspace.policy.get` | Bounded canonical policy metadata plus up to 100 capability entries per page. Current workspace scope is mandatory; cursor/optional expected revision bind the current policy revision. |
| `workspace.source.addFolder` | Local user only, opaque host picker-selection ID. No Mac path, bookmark, root identity or grant reference is accepted from RPC. Production provisioning remains blocked. |
| `workspace.source.addRepository` | Current workspace scope plus host-resolved admitted repository/account authority; paired account scope is checked again on every request. Production provisioning remains blocked. |
| `workspace.source.remove/revoke` | Durable desired-state narrowing. Ordinary removal preserves the final-source/replacement invariant; security revocation may make the final source unavailable. Guest cleanup/effect is pending, never implied by the DB receipt. |
| `workspace.setDefaultPolicy`, `project.setDefaultPolicy`, `workspace.setCapabilityCeiling`, `workspace.setPublicationPolicy` | Local user only; one canonical workspace policy. Defaults do not rewrite existing bindings. Ceiling expansion cannot exceed the host's current admitted ceiling. True ceiling subsets and manual publication remain available for security narrowing. Receipts discriminate complete policy details from bounded policy summaries. Guest transition/application remains pending. |
| `workspace.operation.get` | Safe persisted status/revision/terminal flag, scoped to its canonical workspace; no stored raw receipt/grant details are disclosed. |

Mutation idempotency is scoped to the host-authenticated principal, actual RPC
method and workspace; normalized arguments and expected revision are bound to
its digest. A repeated creation returns its original recorded projection even
if the workspace has subsequently changed. Operation status is queried
separately. No RPC accepts caller-supplied principal identities, grants or
capability ceilings at creation.

Policy expansion admission runs only for a new effect, after the repository's
principal/method/workspace-scoped, content-bound receipt lookup and revision
checks. An exact retry returns its original receipt even if later narrowing
makes its old arguments look like widening. Current caller/workspace authority
is still checked before lookup; changed arguments conflict and a new widening
request must pass current host admission.

`CoworkHostPorts` is an in-process host injection, never a settings/RPC payload.
It resolves the principal, current grant records, opaque selection and creation
ceiling, and enforces the provisioning gate. The production default recognizes
only authenticated harness/admin local user roles, denies all source grant
resolution/provisioning, and denies paired workspace operations without an
explicit host scope resolver. A shared gateway remote token or client name is
not a paired peer identity. Runtime principals and plugin callers cannot use
this administration surface. Principal/role resolution precedes parameter parsing.
Paired missing-record errors are normalized to authority_denied, matching an
existing out-of-scope record; local users retain typed not_found recovery errors.
The member operation level means scoped workspace mutations, not narrowing-only
authority; repository additions still require separately admitted repository authority.

Responses explicitly omit host roots, bookmarks, grant/account references,
backing paths and incarnation details. The 128 KiB inner JSON budget leaves room
for worst-case base64 slash escaping and the paired outer envelope below 512
KiB. Mutation responses and complete workspace aggregates are checked inside
the SQLite transaction before commit, so a response-budget refusal rolls back
the mutation, operation and outbox writes. Expansion admission reserves maximum
revision widths, source lifecycle fields and both single-entry list wrappers,
including their continuation cursors. A small source/policy receipt cannot
commit an aggregate that makes subsequent workspace/Project reads fail. List
pages shrink to fit the same budget; a cursor outside the current scope is
refused.

Source removal/revocation, capability ceilings that are subsets of the current
ceiling, and manual publication bypass aggregate admission, while retaining
receipt validation. True ceiling subsets also bypass expansion admission
against the host's latest ceiling; retaining unrelated legacy capabilities
must not prevent removing network access. Actual ceiling/publication widening
still requires the applicable host admission and complete aggregate budget.
Policy mutation values discriminate `detailState: complete` from bounded
`detailState: summary` values containing `detailReason: response_limit`, recorded
policy metadata/counts and `detailMethod: workspace.policy.get`. This keeps
security narrowing available even when the full policy receipt exceeds the
budget. Summaries use the persisted receipt policy, so later mutations never
change an idempotent retry's original revision or projection.
Their get/list reads return an explicit `detailState: summary` and
`detailReason: response_limit`; the complete variant uses `detailState: complete`.
Summary DTOs reject full `policy`/`sources` fields and include bounded policy
metadata/counts, source count, and scoped source/policy detail method names.
Counts or missing details never mean an empty capability grant, and summaries
remain visible alongside healthy workspaces. Creation receipts require complete
snapshots. Scoped source pages and policy capability pages retrieve all details
without silently truncating them. Detail cursors are opaque and bind the
workspace, detail kind, current desired configuration/policy revision and
SHA-256 content generation. A source readiness/detach acknowledgment that leaves
`configRevision` unchanged still invalidates the old content cursor with
`stale_cursor`; clients restart detail pagination instead of skipping a source.
Cross-workspace and cross-kind cursors are refused. Changed revisions return
`revision_conflict`; optional `expectedRevision` checks use desired configuration
or policy revision respectively. Narrowing the ceiling restores complete reads
when the aggregate fits again.

## Explicitly unsupported integration

No worker, VM, runtime or guest path is launched/read by this service. A source
is preparing until an internal controller supplies a matching incarnation,
lease/config/grant/source acknowledgment. The fixture controller is not native
mount enforcement or effective guest revocation evidence. Production creation
and source expansion stay closed until the reviewed prerequisite gates and
production host adapter are available.

The remaining host-protocol methods are **not registered**: workspace/Project
archive, restore and deletion; Project member listing; source folder
reauthorization/access/trust changes; instruction reads/writes/provenance;
conversation binding/retarget; delegation; rooted files; export; workspace watch
and renewal/detach. Corresponding new session events, outbox delivery into
conversation streams, Gateway workspace-watch wire kinds and subscription
leases are not exposed by this slice. Existing session doors still exclude
Cowork execution; ordinary Code/Chat/Dispatch behavior remains covered by their
existing gates. Production paired peer-to-workspace resolution and paired
repository-only creation admission also remain integration work. No app/iOS
availability switch, SDK release/pin or product release is performed.

## Verification

Run the real-daemon fixture tests with the core package preload: it installs a
private per-process temp root, explicit isolated Cowork coordination before
initialization, throwaway credential service, file-secret stores and isolated
legacy/git homes. The injected host adapter uses opaque fixture selections;
there are no actual folders, repositories, credentials or VM effects involved.

```sh
cd packages/core
bun test test/ipc/cowork-workspace-api.test.ts test/cowork/repository.test.ts \
  test/ipc/remote-allowlist-parity.test.ts test/ipc/remote-role.test.ts \
  test/ipc/remote-chat-gate.test.ts
# 75 tests, 757 assertions passed; actual Unix socket, daemon stop/restart and canonical DB.

# From repository root
bun run typecheck:core
bun run typecheck:protocol
# Both passed.
```

Swift verification builds WinterProtocol, WinterSessionKit and WinterKit and
runs six `CoworkClientTests` plus `GatewayGateTests/testG7` (seven tests passed), using a disposable
`TMPDIR`. It exercises typed RPC/error propagation, full workspace/source/policy
projection decoding, opaque source selections, canonical Project policy routing,
workspace/policy-receipt complete/summary discrimination, paged recovery, the real serialized envelope
budget and the fourth allowlist mirror. This is
focused host API/client proof, not a full VM feasibility or product E2E verdict.

```sh
python3 - <<'PYTHON'
import os, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix="winter-workspace-swift-") as scratch:
    raise SystemExit(subprocess.call([
        "swift", "test", "--package-path", "apple/WinterKit", "--filter",
        "CoworkClientTests|GatewayGateTests/testG7",
    ], env=dict(os.environ, TMPDIR=scratch)))
PYTHON
```
