# Format-once volume readiness preparation

Candidate starts from composition `51a1a832`, in `cowork/volume-filesystems`.
This is host journal and closed Linux fixture preparation, not native/bootstrap
acceptance or a production readiness claim. Product creation, actual guest SDK
activation and per-workspace encryption remain disabled/deferred as applicable.

`packages/core/src/cowork/volumes.ts` retains the existing canonical disk owner and
native-stop records. Schema 10 adds fixed expected ext4 UUID, virgin-format
eligibility and bounded bootstrap journal to the same `cowork_volumes` rows.
Migration preserves prior volume/creation/file/owner identities while setting all
schema9 volumes recovery-required, UUID-null and ineligible: prior records prove
allocation, not safe formatting provenance. Existing directories/data are not
modified by migration. Empty-only stopped-daemon downgrade still refuses any
populated Cowork authority; older schema writers refuse v10.

New allocations alone receive format eligibility. Writable open before a
consumed bootstrap intent burns it, without touching content. The trusted
controller orders allocate → claim → prepareFilesystems → open/transfer both FDs
→ bootstrap effect → confirmFilesystems. Preparation does current authorization,
identity/geometry/backup rechecks and a top-level IMMEDIATE commit before effects:
exact home/workspace, volume/creation/purpose/identity, controller/worker/
incarnation/lease/image and random operation nonce bind both targets and UUIDs.
`unformatted → formatting → ready` is one-shot. Ready disks use only
`ready → probing → ready`. A new owner/incarnation needs a new probe receipt.
In-flight, migrated, unknown, mismatched or uncertainty states never autoformat.
Crash after intent commit conservatively retains ownership and consumed state;
explicit failFilesystems narrows to recovery-required. Stop/release never restores
format eligibility. Explicit recovery/restore UX is a later gate.

`volume-filesystem.ts` defines the closed version1 protocol and mandatory trusted
filesystem authority. Absent port refuses preparation/confirmation/readiness.
Confirmation must match both exact target observations (ext4, UUID, geometry,
flush and successful non-repairing checks) AND receive positive protected native
verification; untrusted guest JSON alone cannot confirm ready. Native intake's
32-byte FD metadata struct proves identity/geometry, not the format envelope's
authority. The planned signed-worker envelope must authenticate the separate
home/workspace/creation/owner/incarnation/UUID/action/nonce fields. Worker/helper
packet parsing, immutable image provenance and independent recovery stay required.

`spikes/cowork-filesystem-bootstrap/bootstrap.py` prepares an explicit fixture-only
receiver. No production block-device constructor or arbitrary path API exists.
Only newly O_EXCL-created Linux regular files, exact ordered descriptors, a closed
plan and test-owned exact-plan authenticator can run. Both images preflight before
formatting; the full zero scan rejects foreign bytes/previous ext4, including
bytes at the end. Consumed requests cannot retry after a partial effect. Fixed
mke2fs argv uses explicit UUID/4096/ext4 features, nodiscard and disabled lazy
initialization, followed by fsync, read-only blkid, exact superblock geometry/UUID
and e2fsck -f -n. Probe-only preserves complete file digests. The actual Linux
fixture uses two new 16 MiB files; scan deadline5s/image, service deadline60s/pair,
helper timeout≤20s/remaining budget, retained output≤4096bytes/helper. Kernel I/O
is not proven cancellable; independent worker stop/recovery remains mandatory.
These small bounds do not prove capacity scan/disk-pressure performance in
production. [mke2fs options](https://man7.org/linux/man-pages/man8/mke2fs.8.html),
[ext4 layout](https://docs.kernel.org/filesystems/ext4/super.html).

Verified locally: 82 host tests /575 assertions across five focused suites;
Core TypeScript and diff check pass. Cases cover consumed pair intent,
mandatory receipt refusal, prior exposure, crash/reopen, current-owner probe,
stale receipts, UUID/creation/identity/geometry/flush/owner/extension mismatch,
outer transaction refusal, v9 migration, malformed journal/ready-without-receipt,
current authority loss and identity drift. Existing real tmutil tests act only on
new disposable image items, never Mac disk formatting. Mac Python protocol tests:
4 pass, 5 Linux formatting cases skipped. Actual Linux mke2fs/blkid/e2fsck execution
has NOT occurred; no running Linux worker was available and no Docker/VM was
started. A dedicated read-only Ubuntu CI workflow is prepared but unrun/unpushed.
Mock native proofs and Mac protocol success are not protected receipt or Linux
formatting evidence. Logs/source hashes are retained separately; earlier failing
setup/schema/typecheck observations stay in /tmp rather than being called passes.

Before production: independently review journal/protocol, run the isolated Linux
CI oracle, integrate exact authenticated signed-worker envelope and immutable
bootstrap with fixed `winter-data`/`winter-environment` device identity, provide
trusted native readiness receipt, mount/protect private volumes and ensure both
current-owner ready before tool/supervisor construction. No SDK/release pin,
live home, Keychain, real credentials, encryption or live VM changes occurred.
