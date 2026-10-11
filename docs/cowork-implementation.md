# Cowork implementation progress

The user authorized continuing until the accepted [Cowork specification](cowork-spec.md)
is fully implemented. This ledger tracks implementation and measured acceptance
separately. Cowork remains unavailable until its required gates pass.

## Reviewed groundwork

- The specification and offline probe have independent review acceptance. The
  [measurement record](research/2026-10-11-cowork-gate1-results.md) records the
  actual evidence and limits. This is not production availability.
- In-process native control, disposable Linux tool compartments, per-view RO
  mounts, independently exercised VZ host RO, direct folder writes, and cold-file
  persistence have scoped evidence. SDK restoration inside a VM is still required.
- Both 6.12.28 and the matched Apple-package 6.18.35 kernel completed the bounded
  memory workload and balloon protocol without observed host footprint return.
  Both negotiated neither free-page hinting nor reporting. The resource gate is open.

## Work in progress

| Area | Current work | Required before completion |
| --- | --- | --- |
| Canonical host state | Schema 8, workspace/source/policy/binding repository, durable receipts/outbox and pure authority checks | Controller acknowledgments, authority service wiring, lifecycle/recovery, typed public protocol |
| Host storage protection | Participating-home fences and migration exclusions | Register coordination homes before creating usable storage; refresh existing host sandbox profiles; native enforcement checks |
| Native VM integration | Production Swift/Node-API boundary and lifecycle | Real signed daemon integration, cancellation/ownership, admitted disks/shares, concurrent latency and memory return |
| Guest execution | Remote runtime transport and explicit confined execution posture | Immutable Linux runtime, real confined file/process/extension routes, guest run-home and instructions, cold parent/child restoration |
| Network and credentials | Interfaces and backend dependencies identified | Native userspace egress with no NAT bypass; host provider/auxiliary/MCP transport; GitHub connection and validated-ref gateway |
| Workspace behavior | Durable source/policy transitions being implemented | Live add/remove/revoke, context refresh and trust, artifact/export/backup retention, same-Project messaging |
| Product integration | Pending dependent runtime/authority slices | Mac/CLI/iOS flows, host schedules, producer/consumer protocol mirrors, kit/SDK version integration and end-to-end checks |

Internal repositories and fake backends do not enable a session creation door.
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
