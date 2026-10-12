# Disposable Linux filesystem bootstrap preparation

This is a closed protocol and actual ext4 file fixture, **not a production guest
bootstrap or a passed live VM gate**. `FixtureBootstrap` cannot open paths or
accept block devices. It receives an exact two-FD pair of newly `O_EXCL`-created,
0600, single-link Linux regular files from the test harness. Full Linux formatting
requires explicit `WINTER_RUN_LINUX_FILESYSTEM_FIXTURE=1`; Darwin refuses before
native-envelope authentication or any helper execution. No mount, loop device,
`sudo`, host Mac disk tool, Docker/VM start, key or network is used.

Run protocol/read-only file tests on this Mac:

```sh
python3 -I -S spikes/cowork-filesystem-bootstrap/test_bootstrap.py
```

Run the actual Linux oracle only on an isolated disposable Linux runner with
system `mke2fs`, `e2fsck`, `dumpe2fs` and `blkid` already installed:

```sh
WINTER_RUN_LINUX_FILESYSTEM_FIXTURE=1 python3 -I -S spikes/cowork-filesystem-bootstrap/test_bootstrap.py
```

The dedicated `cowork-filesystem-bootstrap.yml` workflow prepares that oracle on
Ubuntu 24.04. It has read-only repository permissions, no persistent checkout
credentials, no package installation and a five-minute job cap. Current local
results cover only six Mac protocol cases; nine actual Linux cases are skipped,
not counted as formatting passes. The earlier v1 fixture at `85d5198e` passed its five Linux cases in CI; that
evidence remains unchanged. This corrected v2 fixture has not run on Linux;
no local Linux worker, Docker or VM was started.

The closed plan has protocol version, operation nonce, home/workspace, exact
controller/worker/incarnation/lease/runtime-image digest and exactly two ordered
volume targets. Each target binds volume/creation/purpose, host file identity,
capacity, sectors/block size, expected ext4 UUID and `format-new`/`probe-existing`.
Native intake's metadata struct proves descriptor identity/geometry only; it does
not grant bootstrap authority. A separate protected signed-worker envelope must
authenticate this plan, with fixed native IDs `winter-data` and
`winter-environment`. Untrusted guest/runtime/model packets never initiate format.

The fixture authenticator is a test-owned exact plan and opaque object proof. It
is explicitly unsuitable for production. The operation is consumed before any
formatting work; both disks preflight before the first write. `format-new` must
scan the entire capacity for zero bytes within a five-second virgin check, so
foreign data or an existing filesystem refuses, including data near the end.
`probe-existing` is read-only and never invokes mke2fs. Each pair has a 60-second
service budget; helpers use the remaining budget capped at 20 seconds and are
killed/reaped by `subprocess.run` on timeout. Blocking kernel I/O such as fsync is
not made cancellable by Python; independent native worker recovery remains
required. Most cases create two 16 MiB images; one lazy-inode-table case creates
new 256 MiB data + 16 MiB environment images to inspect a second block group. These cases do not validate scan
performance or physical disk admission at production capacities.

Protocol v2 pins exactly `64bit,dir_index,dir_nlink,extent,extra_isize,filetype,
flex_bg,has_journal,huge_file,large_file,metadata_csum,sparse_super`. Receipts report
the observed compatibility set; unknown/extra/missing persistent features refuse.
Live `needs_recovery` is separately reported in `transientFilesystemFeatures`,
which is explicitly empty for clean observations. Only that transient feature is
allowlisted; duplicate/unknown flags refuse. mke2fs gets fixed argv,
ext4/4096/256-byte inodes/UUID and exactly those features, `lazy_itable_init=1`,
`lazy_journal_init=0`, a clean config/environment and `/proc/self/fd/N` for the
pinned descriptor. Lazy inode initialization is authorized only for canonical new
sparse zero-guaranteed creation. The durable v2 zero-provenance contract requires
`noinit_itable` at every eventual mount: trusted mounting must refuse omission.
There is no mount here, so the receipt declares a required contract, not observed
mount enforcement. Imported/migrated/legacy images cannot acquire this contract.
Legacy v1 minimal-feature history remains readable with an explicit compatibility
error, never reinterpretation or automatic feature upgrade/reformat.
The formatter's single `-F` is confined to proven new
regular files, never a raw-device force option. fsync precedes readiness probes.
Normal read-only probe uses `blkid -p`, ext4 superblock UUID/block-count/block-size
and `dumpe2fs -h` feature/geometry/clean-state checks. It does not run e2fsck.
Only explicit trusted `checkMode=full-read-only` (repair/uncertain shutdown) invokes
`e2fsck -f -n`; no repair or UUID rewrite occurs. Receipts bind
the original plan and exact observed ext4/UUID/geometry plus flush confirmation.
`checked` records header/check completion, never permission to mount. A normal
probe can report pending journal replay without forcing e2fsck; Core refuses
ready confirmation with `journal_recovery_required` while that flag is present.
Full read-only checking also reports it and cannot silently clear recovery debt.
A separately approved immutable recovery/mount path must replay the journal, then
a fresh clean observation can confirm readiness. No mount or journal replay is
performed here. Earlier v2 receipts without the explicit field preserve format
history only; current confirmation/readiness requires a fresh explicit state
observation. Unknown features and error state remain refusals. The Linux-only
debugfs case sets the real recovery bit on a disposable regular file and checks
normal observation/read-only byte preservation; it is skipped on this Mac.
They are observations, not native authenticity proof. Failed/interrupted probe-only work
retains one previous confirmed receipt while current-owner readiness is false;
a fresh nonce safely retries read-only probing. Format uncertainty still requires
recovery and can never reissue format authority.

DISCARD/punch-hole or explicit compaction, plus a physical free-space/admission
and runtime write guard, remain a separate required native v1 gate. This change
neither implements native reclaim of disk blocks nor claims sparse logical size
is physical capacity reservation. The large inode-table test checks actual bytes,
feature masks, lazy group flags and allocation; it is not native DISCARD proof.

Before production, pin these dependencies and immutable bootstrap bytes into the
trusted image; implement the authenticated host-to-worker-to-bootstrap envelope,
exact Linux virtio block device/serial and FD mapping, one-shot delivery/lifetime,
protected readiness receipt and mount/user isolation. Remove the test adapter from
the production surface. Tool/supervisor service construction must wait until both
current-owner volumes are ready. Current product creation and guest SDK activation
remain disabled.

Sources: [mke2fs options](https://man7.org/linux/man-pages/man8/mke2fs.8.html),
[ext4 superblock layout](https://docs.kernel.org/filesystems/ext4/super.html).

## Protocol 3 journal-only follow-up

Current plans require protocol 3, per-target readyOperationId and optional priorReplay
owner/operation debt. Normal known-ready targets may carry replay-journal-then-probe,
with host-issued writable permission and actual old-writer stop proof on uncertain
retry. Both targets preflight read-only before any write. Clean targets never invoke
fsck; clean+needs_recovery requires a separately admitted immutable kernel replay
adapter. It mounts the exact owned block FD in a private namespace with fixed
nosuid/nodev/noexec/noatime and errors=remount-ro,noinit_itable options, syncfs,
normal unmount, then a fresh clean probe. Receipts bind journalReplay:"kernel-mount"
or "none" and consistent journalReplayed. No e2fsck preen, interactive override,
full repair or reformat is used.

The previous -Ejournal_only +DEVNULL test failed in
[CI38256511895/job114835873624](https://github.com/yanlinglabs/winter/actions/runs/38256511895/job/114835873624).
That evidence/source remains historical; no -p/-y workaround is accepted.

The fixture-only regular-file adapter configures an unused loop atomically from
its pinned image FD. CLR_FD/autoclear is insufficient: the helper normal-unmounts,
closes its opener, and observes ENXIO; the Python owner repeats the kernel status
check after actual helper reap. Timeout or uncertainty retains helper, descriptors
and files without kill-based proof or retry. The standalone block helper also
retains a mounted namespace on syncfs/unmount failure.

Build and review exact source/artifacts BEFORE privileged execution:

```sh
python3 -I -S spikes/cowork-filesystem-bootstrap/build_kernel_replay.py --out out/kernel-replay-reviewed
```

Independently admit the source commit, complete receipt SHA and no-effect parent
SHA before privilege. The receipt includes test_bootstrap.py because the runner
dynamically executes it, plus the stager itself. The supported Root boundary is
this **literal stdlib-only hash gate**, rather than executing a mutable checkout
Python file under sudo and checking it later. Fill the two REVIEWED values only
from independent review; calculating a fresh digest is not approval.

```sh
sudo /usr/bin/python3 -I -S -B -c '
import hashlib,os,stat,sys
source,digest,*arguments=sys.argv[1:]
fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
    identity=os.fstat(fd)
    if not stat.S_ISREG(identity.st_mode) or identity.st_nlink!=1 or identity.st_size>4194304:raise SystemExit("parent identity refused")
    data=os.pread(fd,4194305,0)
finally:os.close(fd)
if len(data)!=identity.st_size or hashlib.sha256(data).hexdigest()!=digest:raise SystemExit("unreviewed parent refused")
sys.argv=[source,*arguments]
exec(compile(data,"<reviewed-no-effect-parent>","exec"),{"__name__":"__main__","__file__":source})
' spikes/cowork-filesystem-bootstrap/stage_kernel_replay.py "$REVIEWED_PARENT_SHA256" --source spikes/cowork-filesystem-bootstrap --artifacts out/kernel-replay-reviewed --receipt out/kernel-replay-reviewed/build.json --approved-receipt-sha256 "$REVIEWED_RECEIPT_SHA256"
```

The hash-admitted parent imports only isolated system stdlib. It reads and checks
all source/artifact bytes before repository execution, stages exact Root-owned
readonly copies beneath fixed `/tmp` (never inherited TMPDIR), verifies root-owned
non-symlink `/` and `/tmp` ancestry with no unprotected writable parent, verifies
the entire staged closure, then starts its isolated
-I-S-B runner with a clean environment. No original checkout source executes in
the privileged fixture. Direct privileged runner invocation is unsupported and
refuses before repository imports. Source staging performs no mount/loop effect;
it is distinct from still-required execution-scope admission. Staged source trees
stay for audit and do not auto-delete uncertain filesystem fixture state.


The Root Linux runner must already provide ext4, loop-control/unused loop devices,
mount namespaces, standard Python, cc/static libc and debugfs. No installation,
modprobe, Docker or host/guest share is introduced. Normal nonprivileged CI keeps
running test_bootstrap.py; the kernel fixture is separately refused/skipped until
explicit review. The stronger fixture constructs a committed nonempty JBD2
transaction via debugfs, requires original data unchanged before replay, and then
requires actual journal payload in the target block plus a clean exact probe.
This is constructed-journal coverage, not a real power-loss/crash proof. A corrupt
journal case requires failure and retains its files. Neither has run locally.
and Linux CI. Previous v2 evidence remains historical, not a protocol-3 execution pass.
The fixture remains regular-file-only and cannot authenticate production native grants.
