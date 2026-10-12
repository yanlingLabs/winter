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
system `mke2fs`, `e2fsck` and `blkid` already installed:

```sh
WINTER_RUN_LINUX_FILESYSTEM_FIXTURE=1 python3 -I -S spikes/cowork-filesystem-bootstrap/test_bootstrap.py
```

The dedicated `cowork-filesystem-bootstrap.yml` workflow prepares that oracle on
Ubuntu 24.04. It has read-only repository permissions, no persistent checkout
credentials, no package installation and a five-minute job cap. Current local
results cover only four Mac protocol cases; five actual Linux cases are skipped,
not counted as formatting passes. No Linux worker was available and none was
started for this slice.

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
required. The fixture creates only two 16 MiB images; this does not validate scan
performance or physical disk admission at production capacities.

mke2fs gets a fixed argv, explicit ext4/4096/UUID/features and disabled lazy inode
and journal initialization, a clean environment/config and `/proc/self/fd/N` for
the pinned inherited descriptor. Its single `-F` is confined to these proven new
regular files, never a raw-device force option. fsync precedes readiness probes.
Read-only `blkid -p`, ext4 superblock UUID/block-count/block-size checks and
`e2fsck -f -n` must all succeed; no repair or UUID rewrite occurs. Receipts bind
the original plan and exact observed ext4/UUID/geometry plus flush confirmation.
They are observations, not native authenticity proof.

Before production, pin these dependencies and immutable bootstrap bytes into the
trusted image; implement the authenticated host-to-worker-to-bootstrap envelope,
exact Linux virtio block device/serial and FD mapping, one-shot delivery/lifetime,
protected readiness receipt and mount/user isolation. Remove the test adapter from
the production surface. Tool/supervisor service construction must wait until both
current-owner volumes are ready. Current product creation and guest SDK activation
remain disabled.

Sources: [mke2fs options](https://man7.org/linux/man-pages/man8/mke2fs.8.html),
[ext4 superblock layout](https://docs.kernel.org/filesystems/ext4/super.html).
