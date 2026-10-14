# Canonical workspace guidance source slice — 2026-10-14

This implements a Mac-local host guidance owner and bounded get/update/provenance
RPCs. It does not enable Cowork provisioning, execution, paired guidance access,
guest discovery or protected reader/owner admission. Native Mac two-disk and
native egress holds remain unchanged. No live Winter home, credential service,
GUI, VM, release, pin or push was used. Tests use disposable homes, fixture secret
stores and isolated coordination from the normal test preload.

## Composition and ownership

Branch `cowork/workspace-instructions`, worktree `.worktrees/workspace-instructions`.
Started from merged Core `f60298bb`. Schedule schema12 `ecf14b3f` was cherry-picked
as `21e80392`; workspace event slice `7678e77a` as `1de676a6`. The sole composition
conflict combined daemon startup so both existing schedule and outbox startup run.
Reviewed descriptor/file/fullsync primitives are the separate two-file leaf
`d4b80a01`; the source guidance delta builds on that leaf. Schema13 is guidance;
schedule quarantine work is reserving14. No guest SDK/Ubuntu/reader/stub source was
changed here.

## Actual caller path

`daemon.ts` constructs `CoworkWorkspaceService` with the daemon-selected home and
its existing ApprovalBroker/SessionHub. Service attempts to construct
`CoworkInstructions`; unsupported platforms or a
noncanonical runtime-state DB disable that optional port without crashing daemon
boot. Guidance RPCs then return `unsupported_topology`.
Initialization is a trusted host provisioning method with no RPC equivalent.
Default provisioning stays disabled and missing instructions stay
`recovery_required`; daemon construction does not seed or enroll backing data.

`workspace.instructions.get/provenance/update` enter through the existing typed
COWORK_RPC dispatch and host-resolved local user. All three currently exclude
COWORK_REMOTE_METHODS and the Swift Gateway mirror and explicitly refuse paired
and runtime principals in the service. The CLI has corresponding instructions
commands; Swift adds typed requests/results but was not built/run under the native
UI/test-host restriction. The legacy management/project/session paths remain gated.

Guidance RPC input accepts only workspace ID, request ID, expected instruction
revision, expected SHA-256 and bounded content. There are no host paths, root
identities, grant handles, approval tokens or approved booleans. Content is at most
65,536 UTF-8 bytes, with NUL and lossy Unicode rejected; output is base64 with a
single revision/digest and bounded JSON wrapper. Provenance names only the actual
canonical workspace guidance alias `/workspace/.winter/WINTER.md`. It explicitly
returns `sourceDiscovery: unavailable`; no repository/import provenance is invented.
`refreshState: refresh-required` records the actual remaining guided-refresh gate,
not successful live injection.

## Authority and filesystem behavior

Schema13 records canonical home/workspace ownership, directory identities,
current guidance vnode/digest/size, and pending replacement debt in the protected
runtime-state DB. Manifest, text and imported transcript do not confer authority.
Root registration does not follow client paths: host home is canonicalized at
construction and tied to the canonical DB location, then every home/path component
is opened from `/` by held directory descriptor. Private home/Cowork directories
must be user-owned0700; shared guidance must be user-owned regular0600 with one
link. Unknown existing Cowork trees cannot be enrolled by initialization; an exact
existing canonical volume ancestor may be reused. Missing expected directories or
files fail instead of producing empty replacements.

Reads use literal WINTER.md with O_RDONLY|O_NONBLOCK|O_NOFOLLOW|CLOEXEC, followed by
regular-file/link/size/mode/UTF-8 checks and pre/post stat/entry/ancestor identity
checks. Writes create a UUID temporary name with existing O_EXCL descriptor API,
write bounded bytes and request full sync, persist replacement debt, revalidate
current file and held ancestry, rename within the same held directory, full-sync
the directory, and confirm target vnode/digest before finalizing instruction and
workspace revisions/receipt/outbox in one DB transaction. There are no path-based
write fallbacks or general rename APIs. Normal direct user edits, including atomic
editor saves, are observed under the unchanged canonical directory and advance
instruction revision/outbox. Guidance is editable content, never host authority.

Pending debt survives ordinary process restart in the DB. Exact recorded
replacement vnode/digest, unchanged ancestry, repeated sync requests and the
current revision finalize the write. When the target exactly matches the still
recorded before vnode/digest and ancestry, one durable transaction marks the
operation failed, clears pending ownership and deletes the mutation; only then is
the recorded temp entry removed. A direct editor save matching neither image may
supersede the operation only when a descriptor-relative O_DIRECTORY|NOFOLLOW
probe reports ENOENT for the recorded temp. All other results are present/unknown
and retain recovery_required. No temp is replayed and no replacement subtree is
adopted. Cleanup consults canonical mutation ownership after a thrown transaction
return, including SQLite pragma restoration errors after COMMIT.

The update rereads the before vnode/digest immediately before rename and refuses
an already visible editor save. Read and rename are separate requests, so an
editor save after this check can still race replacement. This is a documented
same-user residual, not a race-free compare-and-swap. A later editor save after
rename and before finalization is reconciled as superseded only under the exact
neither-image/temp-gone rule above.

Agent edits have a separate internal owner method, not user RPC or generic file
tool access. It freezes a copy of principal and exact proposed content/revision/
digest, verifies canonical binding/source/capability/policy, creates an actual
ApprovalBroker wait/card showing workspace ID, expected revision/digest and
proposed content/hash, and rechecks after the answer. The method never accepts a reusable approval DTO. Aborts, denial, changed
binding/grants/policy, revision or file content refuse the original write. The
exact committed request replay checks existing operation state before creating
another prompt; substituted replay content refuses. The future authenticated
guest-owner channel still must wire this method; its runtime principal shape is not itself native caller admission.

## Durability evidence and limits

Pinned Bun1.3.14 revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4` source maps
fsyncSync to the fsync operation at
[node_fs_binding.zig:162](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/node/node_fs_binding.zig#L162),
which calls plain system.fsync on non-Windows at
[node_fs.zig:3938](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/node/node_fs.zig#L3938).
The separate reviewed `instruction-fullsync.ts` therefore also requests Darwin
fcntl F_FULLFSYNC51, with two fixed args and a correctly stack-placed zero vararg
for Apple arm64. [Apple fcntl documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
explains the stronger request and its hardware limitations. The openat wrapper
must never gain mode-requiring flags without changing/reviewing its binding.

Actual disposable local APFS (`statfs.type=26`) owned-file and held-directory
F_FULLFSYNC requests completed successfully on that Bun revision. No fallback was
used. This is completed OS request evidence, not hardware power-cut proof or
support for all homes/filesystems. Unsupported fullsync fails visibly; exFAT/SMB
were not tested. Special-device substitution may have an effect at open before
fstat can reject it. Protected0700 roots and the guest read-only instruction view
exclude tool-side substitution; direct same-user tampering is an explicit residual.
No claim of same-user confidentiality or an atomic global filesystem snapshot is
made. Held descriptors contain operations to the checked vnodes; identity checks
refuse concurrent replacement and leave recovery debt rather than promise all
rename races are atomically serialized.

The runtime-state default synchronous=NORMAL is preserved for ordinary Code.
Guidance-owned canonical transactions use `durableCoworkTransaction` to temporarily
set/read-back FULL/fullfsyncON/checkpoint_fullfsyncON, commit synchronously with
immediate ownership, then restore/read-back original connection settings. Caller
transactions and thenable-returning bodies refuse. [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)
and [fullfsync](https://www.sqlite.org/pragma.html#pragma_fullfsync) document the
requested semantics. Tests prove actual configuration and rollback/restoration,
not a direct VFS trace or storage-device behavior. Root/outbox owner is separately
reviewing reuse for its canonical mutations/ACKs.

## Validation

From packages/core, after exact primitive review for disposable Darwin calls:

```sh
WINTER_COWORK_INSTRUCTION_FS_FIXTURE=1 bun test test/cowork/instructions.test.ts test/cowork/durable-transaction.test.ts test/ipc/cowork-instructions.test.ts test/cowork/repository.test.ts test/cowork/workspace-events.test.ts test/ipc/cowork-workspace-api.test.ts
```

Earlier composed checkpoint: **64 passed,817 assertions,no skips/failures**.
Final owned instruction/durable-transaction/Unix-RPC focus after Unicode validation
correction: **14 passed,112 assertions,no skips/failures**. This includes real files,
SQLite, Unix RPC, SessionHub/JSONL, APFS file/directory fullsync, external editor
saves, symlink/hardlink/ancestor replacement, visible pre-rename debt,
post-replacement restart reconciliation, stable event deduplication, actual
ApprovalBroker content substitution and post-approval revision/grant refusals.
Default portable invocation skips the Darwin file/approval/fullsync cases and
Darwin file RPC case; it does not present skipped filesystem proof as passed.
Before corrections there were seven such cases. The correction focus adds five
file cases; future Darwin arm64 CI must opt in and exercise all twelve.

CLI `bun test test/cowork-cli.test.ts`: **15 passed,152 assertions**, including
existing private-daemon management and strict new guidance parser/display controls.
Core and CLI no-emit typechecks passed at the pre-freeze checkpoint; final
protocol/Core/CLI typechecks and diff check must accompany the reviewed freeze.
Swift protocol/request source was updated but not compiled or executed here.

## Remaining integration gates

- Whole service and scoped SQLite helper still require exact independent review.
- Trusted workspace provisioning must call initialize once; current default host
  deliberately cannot create/provision a workspace or mark a source ready.
- Reader/owning registration/SDK callback must load and refresh canonical guidance;
  current callback remains unwired and native reader proof remains incomplete.
- Authenticated guest tool path must call updateAgent; no generic permission mode,
  runtime-shaped JSON object or guidance paragraph authorizes host writes.
- Paired guidance reads/updates need their explicit four mirrors and per-record
  authority/transport handling. This source is Mac-local.
- Shared memory/output consumers,
  migration/export consistency, other filesystem validation and full guest E2E
  remain separate work. None is replaced by these source/file fixture passes.

## Reviewer correction freeze

Corrections from reviewer45 G1/W1/M3 and requested L2/L3/L6/L7/L10/L11 preserve the
reviewed filesystem and fullsync leaf bytes and scoped SQLite helper unchanged.
G1 tests exercise real journal-before-rename abort, post-COMMIT restoration throw,
post-rename editor supersession and retained-temp refusal. W1 uses actual isolated
daemon boot with symlinked runtime DB and valid Unix guidance RPC; L10 uses valid
strict params and exact ERR.UNAUTHORIZED for every remote method. Descriptor
fault tests observe stable /dev/fd counts; approval replay tests observe no new
approval event/card. Canonical owner reads no longer call the repository's write
wrapper, preserving composition with durable outbox transactions.

Read/provenance can observe direct user edits and create a revision, operation and
per-conversation outbox fanout; repeated unchanged reads are coalesced by exact
vnode/digest equality. Repeated real edits still create unbounded operation rows;
retention/cleanup is future integration work (L1). Remaining LOWs are initial
file/DB failure orphan handling (L4), pre-journal process-crash temp sweep (L5),
more distinct content/topology error codes (L8), stdin/file CLI input rather than
argv content (L12), and populated schema downgrade corpus (L13). None is claimed
fixed by these focused corrections. The pre-rename read/rename residual (M3) stays
explicit. Swift source remains unexecuted; no native test host, GUI, VM or held
lane was invoked.

Correction freeze validation: **71 pass,899 assertions,0 skip/fail** across the six
Core instruction/durable-transaction/RPC/repository/event/API files in the command
above; CLI **15 pass,152 assertions,0 fail**. Default three-file portable focus:
**9 pass,12 skip,61 assertions,0 fail**. Protocol/Core/CLI no-emit typechecks and
diff check pass. Recovery tests reopen the actual SQLite file through a separate
RuntimeStateDb connection. No pending temp is inferred absent from an exception.
