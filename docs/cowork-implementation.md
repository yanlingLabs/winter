# Cowork implementation progress

The user authorized continuing until the accepted [Cowork specification](cowork-spec.md)
is fully implemented. This ledger tracks implementation and measured acceptance
separately. Cowork remains unavailable until its required gates pass.

## Current decisions and verified groundwork

- The later accepted architecture uses one sandboxed native worker per workspace,
  orchestrated by the daemon. Project conversations share that worker/VM. Private
  disks must be encrypted before activation; keys stay outside Core/Bun. The
  [storage contract](cowork-storage-security.md) states the direct-backing-read
  guarantee, authenticated-API/plaintext-copy limits and proposed native launch
  capability. Ordinary canonical control records remain in the runtime-state DB;
  integrity protects broker-consumed workspace/volume/key-version records.

- The specification and offline probe have independent review acceptance. The
  [measurement record](research/2026-10-11-cowork-gate1-results.md) records the
  actual evidence and limits. This is not production availability.
- The historical VZ probe's in-process native control, disposable Linux tool compartments, per-view RO
  mounts, independently exercised VZ host RO, direct folder writes, and cold-file
  persistence have scoped evidence. SDK restoration inside a VM is still required.
- Both 6.12.28 and the matched Apple-package 6.18.35 kernel completed the bounded
  memory workload and balloon protocol without observed host footprint return.
  Both negotiated neither free-page hinting nor reporting. Acknowledged, aligned
  page donations likewise produced no observed return. The user explicitly
  requires RAM return during active work; idle shutdown is insufficient. The
  resource gate is open. The worker topology is now accepted; backend adoption
  still requires validation.
- A sandboxed libkrun/HVF worker has booted real ARM64 Linux with no disk, share,
  NIC or vsock. Bounded allocation/free/reuse and retained-data/heartbeat checks
  passed. Instrumentation confirms aligned 2–4 MiB free-page reports; stock
  `MADV_FREE` still does not demonstrate reliable active return across the workload.
  Safe vCPU/device parking and backing replacement remain unvalidated.
- The runtime SDK guest-transport PR is merged. The agent SDK's explicit text
  Read/Write/Edit routes use a protected file-helper binding; the exact C worker
  passed its Linux CI compartment checks, including conditional writes and symlink
  races. Full confined runtime startup still refuses: file routes alone do not
  establish a supervisor, instruction/store access, shell or extension boundary.

## Work in progress

| Area | Current work | Required before completion |
| --- | --- | --- |
| Canonical host state | Schema 8, workspace/source/policy/binding repository, durable receipts/outbox and pure authority checks | Controller acknowledgments, authority service wiring, lifecycle/recovery, typed public protocol |
| Host storage protection | Retained-home fences and Core/SDK authority consumer; proposed native key/launch broker | Actual encrypted disks and sealed launch records; native output/Workflow producer wiring; preserve ordinary Code behavior and real SDK hook ordering; stop owned host effects on daemon loss |
| Native VM integration | VZ lifecycle/Node-API foundations; bounded Linux/HVF worker baseline and reporting evidence | Verified active reclaim, real signed worker admission/sandbox, cancellation/ownership, admitted encrypted disks/shares and concurrent latency |
| Guest execution | Merged remote transport; confined text file routes and Linux helper evidence | Immutable Linux runtime/supervisor, complete file/process/extension routes, guest run-home/instructions, cold parent/child restoration |
| Network and credentials | Native egress and bounded Git publication foundations, isolated package receipts | Guest parser outside credential daemon; brokered sockets and providers/MCP; GitHub auth/private clone/service wiring; native resource bounds and revocation draining |
| Workspace behavior | Durable source/policy transitions being implemented | Live add/remove/revoke, context refresh and trust, artifact/export/backup retention, same-Project messaging |
| Product integration | Pending dependent runtime/authority slices | Mac/CLI/iOS flows, host schedules, producer/consumer protocol mirrors, kit/SDK version integration and end-to-end checks |

Internal repositories and fake backends do not enable a session creation door.
Source/policy changes require the trusted controller to refresh its epoch before
issuing a new effect; old callbacks remain fenced. Empty schema 8 stores have an
explicit v7 rollback that preserves SDK layout (`winter migrate --cowork-schema
--rollback`); populated Cowork authority refuses rollback without data loss.
The release that first ships schema 8 must name this rollback command and its
populated-data refusal in its release notes; no release is being prepared yet.
Draft native and Git components remain isolated from production creation. Open
review work includes native output teardown/descriptor ownership, unintended
unprotected Code observation limits, real SDK callback ordering, and VM/admission
recovery after worker loss or sleep. An accepted specification, merged transport,
compiled helper or passing fixture is not a claim those integrations are complete.
The admission ledger's v2 migration preserves the accounting phase before a
heartbeat-only interruption. A fresh heartbeat from the exact still-live owner
and verified home restores that phase, including draining; it neither frees
capacity nor establishes guest readiness/disk ownership. Harder uncertainty and
legacy rows with no saved phase remain blocked. Verified stop evidence is bound
to the exact owner/incarnation independently of wall-clock changes. A native
worker service still needs to supply that protected evidence in production;
dead daemon PIDs alone are not substituted for VM termination.
Tests use injected temporary homes, grants, credentials and coordination. Real-VM
experiments remain opt-in, disposable and sequential; none touches the live
Winter installation or deliberately creates host memory pressure.

## Completion evidence still required

Follow all four gates in the main specification. In particular, demonstrate two
concurrent Project conversations and isolated cancellation; durable peer delivery;
real SDK child resumption after process and VM restart; revocation across all tool,
network and broker paths; code/session behavior preserved outside Cowork; and user
creation/control flows through Mac, CLI and paired iOS. Report tests, package builds,
CI, real-VM experiments, releases and production readiness as distinct results.
