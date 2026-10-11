# Cowork gate-1 guest fixtures

This disposable Linux fixture tests an initial control/tool separation candidate.
It is not a Cowork runtime, an SDK integration, or a complete production sandbox.
The native controller executes the trusted `run.sh` as guest root; only `confine`
launches the untrusted shell suite. Root/native exec by itself is not confinement.

## Bundle and invocation

Build `confine.c` and `memprobe.c` on Linux, or cross-compile them without installing
guest compilers:

```sh
zig cc -target aarch64-linux-musl -O2 -Wall -Wextra -Werror -static confine.c -o confine
zig cc -target aarch64-linux-musl -O2 -Wall -Wextra -Werror -static memprobe.c -o memprobe
```

Bake `run.sh`, `tool-smoke.sh`, `confine`, and `memprobe` into an Alpine arm64 rootfs
at `/opt/cowork-fixture/`. The controller's separate initfs must contain a compatible
Containerization `vminitd` and `vmexec`; an Alpine rootfs is not that initfs.
BusyBox provides the required shell/file/process commands. The supervisor needs
guest namespace and mount privilege; lack of that privilege returns unsupported.
Do not grant those capabilities to tool processes.

The host attaches only a newly created disposable directory at `/workspace/source`.
Before attachment, create `.cowork-gate1-disposable` containing the exact text
`cowork-gate1-disposable-v1` (an optional trailing newline is accepted). The host
also creates `seed.txt` containing `source-seed`, makes it mode0666, creates
`seed-alias -> seed.txt`, and sets the source directory mode2777. Its parent remains
the host's private mode0700 `mkdtemp` directory. The guest driver does not change
the host directory owner, group or mode. Run:

```sh
/bin/sh /opt/cowork-fixture/run.sh
```

The fixture writes files within this selected source. Never use a real checkout,
user folder, Winter home, or credential store.
The driver creates and deletes its guest-only control fixture under
`/var/lib/cowork-fixture/`; it leaves source evidence for the host to inspect.
Two tool identities share supplemental GID 10000. Guest-only memory/scratch
directories use that group with setgid permissions. The source uses host-prepared
world-writable test DAC within a private disposable host parent because the first
live Apple virtiofs run rejected guest `chgrp` with `EPERM`. This exercises the
namespace/control/plan boundary while leaving host-owner/ACL identity mapping
unproven; `host_source_identity_mapping` explicitly records that observation.
It is not the production permission scheme. Writable fixture mount views are
intentionally shared data, not confidentiality boundaries.

Host verification must read both files directly from the original attached host
directory and assert their complete contents:

| File | Content including trailing newline |
| --- | --- |
| `.cowork-gate1-10001-auto-share.txt` | `guest-10001-auto\n` |
| `.cowork-gate1-10002-auto-share.txt` | `guest-10002-auto\n` |

The guest's `direct_share_write` record only proves the guest supervisor observed
the write. Host observation establishes the direct host-share round trip; it is
not a synchronization-loop test. Both identities currently run sequentially, so
this does not establish simultaneous runtime/SDK conversation behavior.

## Installed candidate boundary

`confine` creates fresh mount, PID, IPC, UTS and network namespaces, marks mount
propagation private, and builds a minimal chroot. The tool view includes read-only
utility/library directories and a read-only directory skeleton. It exposes the
selected source and Project memory writable under `auto`, and read-only under
`plan`; scratch and a private bounded `/tmp` remain writable. Shared workspace
instructions have a read-only file bind. Protected supervisor files and SDK/control
stores are omitted. It remounts utility/data binds with `nosuid` and `nodev`.

Tools run as UID/GID 10001 or 10002, with workspace supplemental GID 10000, zero
capability sets and bounding set, `no_new_privs`, a fresh `/proc` in their PID
namespace, and a cleared launch environment. Descriptors above stderr are closed.
The installed seccomp filter rejects alternate syscall architectures, x32 syscalls,
mount/namespace/control syscalls, ptrace/process-memory access, vsock socket creation,
and several other kernel control surfaces. Ordinary syscalls remain allowed.
This targeted filter is a feasibility fixture, not a reviewed production syscall
allowlist. It does not implement host provider/Git/network broker policies.
The guest has no NIC for this initial smoke; AF_VSOCK denial prevents tools from
opening the trusted init control transport. Existing inherited handles are also
closed before dropping authority.

The suite uses real shell writes with computed paths, instruction symlink/hardlink
aliases, deletion/chmod/replacement, protected ancestor rename, read-only source
alias/rename/deletion attempts, process namespaces, environment/descriptor probes,
and actual mount/ptrace/unshare/vsock syscall probes. The trusted driver checks
control/SDK/instruction/source seed integrity after all tools exit. A shared
instruction symlink through the writable source must remain read-only; repository
`WINTER.md` stays an ordinary writable source file under `auto`.

Each fresh view is independently installed. These tests do not establish safe
live policy transitions, source revocation with stale handles, arbitrary descriptor
admission/race handling, narrow subagent launch rules, SDK file-tool delegation,
concurrent tool ownership, broker authentication or complete guest kernel security.
The production contracts still require those mechanisms and tests.

## Result contract

Stdout is NDJSON. `kind=check` records have `id`, `status` (`pass`, `fail`,
`unsupported`) and stable `detail`; tool checks also include policy/UID.
`kind=observation` syscall records expose the actual result and Linux errno.
`kind=summary,id=guest_suite` is the final guest outcome. Stderr contains diagnostic
text. Exit0 means this suite's required assertions passed; exit77 means required
confinement was unavailable; exit1 means an assertion failed. Argument misuse
returns64. Unsupported Landlock is an optional observation and does not fail this
mount/identity/seccomp candidate. No summary proves the entire Cowork gate passed.

The host harness must treat a missing summary, process crash, timeout, malformed
JSON, or required unsupported result as incomplete/failure for its corresponding
gate assertion, not as a skip that turns into success.

## Optional memory workload

```sh
/opt/cowork-fixture/memprobe 128 30
```

Allocates and touches 128 MiB, reports `before`/`allocated` RSS, holds 30 seconds,
frees, reports `freed`, then remains alive another 30 seconds before reporting
`after_free_hold`. `SIGUSR1` frees early; `SIGTERM`/`SIGINT` frees and exits.
MiB is bounded 1..512 and each hold is bounded 1..300 seconds. This intentionally
has no dependency on Python or a runtime allocator. Run it only in the disposable
guest and use an allocation below the configured memory ceiling.

Guest RSS reduction establishes process-page release only. Compare separate host
resident-memory measurements and any balloon operation observations before making
a host-memory-return claim. CPU scheduling, guest ceiling, host backing and balloon
behavior are distinct measurements; `/proc/meminfo` alone cannot substitute for
host resident-memory evidence. This workload does not change the ceiling or balloon.

## Pinned source inspection

Inspected the raw source at Apple Containerization commit
`bc994b88df46207fad7775b0eabc51947e315881` on 2026-10-11:

| Source | Finding |
| --- | --- |
| [`kernel/config-arm64`](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/kernel/config-arm64#L185) | Namespace options include user/PID/network/IPC/UTS (lines185–191). |
| [`kernel/config-arm64`](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/kernel/config-arm64#L666) | Seccomp and seccomp filter enabled (lines666–667). |
| [`kernel/config-arm64`](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/kernel/config-arm64#L3047) | `CONFIG_VIRTIO_BALLOON=y` (line3047) and `CONFIG_VIRTIO_FS=y` (line3371). This is not a successful balloon integration test. |
| [`kernel/config-arm64`](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/kernel/config-arm64#L120) | PSI is explicitly unset (line120); no `LANDLOCK` entry was found. Neither statement is a runtime probe of a downloaded kernel. |
| [`scripts/build-initfs.sh`](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/scripts/build-initfs.sh#L75) | Stages `vminitd`/`vmexec` into the init rootfs and builds ext4; a prebuilt/built matching initfs can be supplied separately. |
| [`Makefile`](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Makefile#L422) | Default prebuilt-kernel acquisition extracts a Kata kernel. Its configuration must be probed separately from the in-repo arm64 configuration. |

Line references above are from a direct raw-GitHub fetch; all downloaded binaries
must be recorded by their own digests. The suite reports the running guest kernel
release and probes actual seccomp/namespace availability during launch. Landlock ABI
is probed using its version-query syscall. The configuration's `IKCONFIG_PROC`
setting does not guarantee a particular supplied kernel exposes `/proc/config.gz`.

## Host identity and coverage limits

Apple documents that VZ shared-directory operations use the effective Mac user's
identity, retain that user's host permission limits, and ignore guest requests to
change host UID/GID. The observed guest `chgrp` failure fits those restrictions.
The direct owner-only probe uses ordinary confined mounts; no additional ID mapping
is required for that tested fixture. Do not generalize that result to mixed file
owners, host ACL fidelity, simultaneous execution or arbitrary filesystems. Those
remain future coverage within the same mandatory tool/control boundary. Do not
recursively change selected user files or make them world-writable to work around
an unvalidated mapping. [Apple VZ shared-filesystem permission policy](https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdevice?language=objc)

## Optional direct owner-only VZ source probe

Stage `run-direct.sh` and `tool-direct.sh` alongside the existing `confine` binary.
The host creates `strict-source/` inside the attached disposable source, at mode
0755, with `seed.txt` containing `source-seed` at mode0644 and
`seed-alias -> seed.txt`. Keep the effective Mac user as owner and preserve the
disposable parent marker. Run:

```sh
/bin/sh /opt/cowork-fixture/run-direct.sh
```

This uses ordinary `auto`/`plan` views, with no ID mapping and no host chmod/chgrp.
The two distinct kernel tool UIDs remain in the supervisor's original user
namespace. Source/seed/created-file guest UID/GID values are observations rather
than host ownership assertions: apparent values changed by guest request/cache
context in the initial live probe while independent Mac ownership stayed unchanged.
That projection behavior is a live observation; Apple documents host-side identity
and permission enforcement but does not specify these guest `stat` projections.
The guest driver asserts modes only and reports before/after guest owner projections.
Authoritative owner/group preservation is exclusively an independent Mac check.
Each UID actually edits/reopens the owner-only seed, creates/reopens a new mode0644 file,
and edits a shared file created by the first UID. Plan must read the latest seed
while mutations fail. This tests whether VZ's documented use of the effective Mac
UID permits the requested file access despite distinct guest UIDs. [Apple VZ permission behavior](https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdevice?language=objc)

The separate final `summary,id=direct_strict_source` reports pass/unsupported/fail,
with exit0/77/1. Missing launcher/confinement gives unsupported; unsuccessful
actual file operations give failed assertions. Success covers the owner-only
fixture, not general ACL fidelity, mixed owners or simultaneous execution.
Host verification must independently assert original source/seed metadata and
contents: seed `direct-seed-10002\n`, files
`direct-created-10001.txt`/`direct-created-10002.txt` with
`direct-created-<uid>\n`, and `direct-shared-existing.txt` with
`direct-shared-10002\n`. Created files must be mode0644 and host-owned, and
`direct-plan-created.txt`/`direct-seed-moved.txt` must remain absent.
The direct driver accepts an existing regular seed regardless of its contents so
this disposable probe can be repeated against the same fixture.
