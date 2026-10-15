# Cowork implementation progress

The user authorized continuing until the accepted [Cowork specification](cowork-spec.md)
is fully implemented. This ledger tracks implementation and measured acceptance
separately. Cowork remains unavailable until its required gates pass.

As of 2026-10-15. The dated 2026-10-12 text below is kept as the record of that
day; notes marked "Later status (2026-10-15)" and the
[later-status section](#later-status-2026-10-15) record what changed since.

## Current decisions and verified groundwork

- The later accepted architecture uses one sandboxed native worker per workspace,
  orchestrated by the daemon. Project conversations share that worker/VM. Separate
  private-disk encryption is deferred for the first version by the user on
  2026-10-12. Images are plaintext; VM isolation and host credential protection
  stay required. The
  [storage contract](cowork-storage-security.md) states the direct-backing-read
  residual, backup/format requirements and authenticated native launch
  capability. Ordinary canonical control records remain in the runtime-state DB;
  authenticated launch validates worker-consumed workspace/volume identity.

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
  `MADV_FREE` did not demonstrate reliable active return across the workload.
  The subsequently reviewed reclaim patch did: three live Linux cycles returned
  about 234–271 MiB of worker footprint while heartbeat, zero-fill reuse and
  retained-data checks passed. Root audited all 20 park/resume epochs and 296
  replacement sequences. This proves the restricted PL011-earlycon/RNG/balloon
  fixture, not asynchronous block/fs/network/vsock coordination or encrypted
  storage. See the [frozen evidence](https://github.com/yanlingLabs/winter/blob/b4088811/spikes/cowork-hvf/results/2026-10-11-linux-active-reclaim.json).
- The subsequent guarded RAW disk fixture also returned RAM during direct reads,
  writes and flushes. Root audited all epochs, mapping replacements, completion
  receipts and final disk words. Outstanding pins were observed during explicit
  post-I/O holds, not a proven blocked OS syscall. The separately built crypto
  kernel and cryptsetup toolset have not booted; neither encryption nor other
  asynchronous devices are covered by this result. See the [RAW evidence](https://github.com/yanlingLabs/winter/blob/159df65c/spikes/cowork-hvf/results/2026-10-12-raw-block-root-audit.json)
  and [scope and reproduction](https://github.com/yanlingLabs/winter/blob/159df65c/spikes/cowork-hvf/README.md).
- The runtime SDK guest-transport PR is merged. The agent SDK's explicit text
  Read/Write/Edit routes use a protected file-helper binding; the exact C worker
  passed its Linux CI compartment checks, including conditional writes and symlink
  races. Full confined runtime startup still refuses: file routes alone do not
  establish a supervisor, instruction/store access, shell or extension boundary.
- The agent SDK branch now also has a confined foreground-Bash process helper and
  a trusted protected-store bootstrap seam. The latter carries native ownership
  and prior-boot termination evidence into actual root/child stores, guards
  durable sidecars and reports retained ownership separately from a successful
  turn. Native ownership adapters and full guest startup remain absent. These
  changes are unreleased and not pinned in Winter.
- The standalone host-output adapter has an explicit Core constructor path and
  asynchronous first-use bundle verification. Source and compiled fixtures reach
  the local SDK registration through that path; they do not prove installed SDK
  support, production signing or a complete Workflow transport. See
  [host output](cowork-host-output.md) and [loading](host-output-loading.md).
- The synthetic native key-broker fixture generates random volume keys and wraps
  them under a broker key. Approved identity rebinding and wrapping-key rotation
  preserve the volume key. Its closed 32/96-byte formats and actual scoped delivery
  have evidence. Bounded child teardown distinguishes confirmed exit from retained
  ownership debt; receive deadlines survive EINTR and truncated datagrams refuse.
  The current receive-change build passed 33 Swift tests and a separate synthetic
  delivery/timeout rerun. Frozen earlier receipts remain distinct. It does not
  implement durable Keychain custody, production caller authorization or encrypted
  volumes. See the [native fixture](../apple/Cowork/WinterCoworkKeyBroker/README.md).
- The accepted native-host policy adds paths to the existing Bash sandbox and
  file checks, without applying an outer floor to ordinary Code, hooks or LSP.
  Approved escapes remain unwrapped with write-shaped integrity checks; tool
  sandbox-disabling flags are never injected. Activation refreshes captured
  policy while preserving queued work and session/backend identity; unchanged
  acknowledged paths leave running Code intact. No daemon restart is required.
  Core source review, platform parity and the nine-family SDK context contract
  are accepted. Core enables context contract version 1 only when the actual
  installed namespace advertises every required capability. The old pinned SDK
  still refuses protected embedding; no package release or pin update is implied.
  Actual candidate Workers passed hostile import/rule/skill checks and live policy
  updates without restart. Pre-existing commands retain their earlier sandbox
  profiles, an explicit activation-window residual in the storage contract.
- The guarded stream v3 source and signed-worker setup are independently reviewed.
  A real RAW-plus-stream run now has separate root/Astra byte, disk, pin and
  mapping audits: three live footprint drops of 238.406/236.281/236.063 MiB while
  both communication directions and disk threads progressed. Its original
  aggregate remains false for absent guest-TX EAGAIN; Linux HVC can wait inside
  the driver and still return a full write. The unconsumed host-sent suffix is
  explicit. This prompted the generic non-console port below for asynchronous
  runtime data traffic; the console evidence itself does not cover its new control
  queues. See [recorded results](https://github.com/yanlingLabs/winter/blob/18fafff1/docs/research/2026-10-12-cowork-stream-results.md).
- The generic non-console port now has independently accepted Linux evidence:
  real guest EAGAIN during a six-second sink stall while heartbeats and both disk
  threads continue; active footprint drops of 246.906/247.953/252.031 MiB with
  two-way stream work in every window. Byte/disk checks and 18 epochs/300 mapping
  replacements pass the separate audit. The original normal aggregate remains
  false because a memory sample split one disk ACK log line; the exact raw-byte
  reconstruction is separate. A second guest-close run acknowledges control while
  stalled and exits 77 with effects uncertain. That run exposed the telemetry
  defect corrected below; no live MMIO reset/host disconnect or full resource gate is claimed.
  See the [frozen audit](https://github.com/yanlingLabs/winter/blob/86e9cfb7/docs/research/2026-10-12-cowork-generic-fixture-independent-postrun-review.md).
- The separate sampler-channel correction has a clean passing live aggregate at
  build `477d204b`, with zero malformed or reconstructed telemetry. Independent
  audit and root replay verified all 1,568 request lifecycles, captured bytes and
  disk words, plus 19 epochs/302 replacements outside 128 frozen pins. Active
  footprint drops were 246.922/247.875/245.953 MiB. The earlier failed evidence
  remains unchanged. This still covers one RAW disk and the generic port, not
  the forthcoming two-volume production profile. See the
  [clean sampler audit](https://github.com/yanlingLabs/winter/blob/b8584b16/docs/research/2026-10-12-cowork-sampler-independent-postrun-review.md).
- The actual Winter runtime now cross-builds to Linux ARM64 using an explicit,
  version/hash-pinned Bun base and a private verified copy for compilation.
  SDK PR #4 (`c4227c45`) has designated source acceptance and all 12 CI checks
  passing. The binary's ELF interpreter and glibc dependencies are recorded;
  actual Linux execution, immutable image library pins and guest page-size checks
  remain open. No Linux package release or Winter dependency pin changed.
- Project peer messaging/discovery authority is merged into the feature
  composition through PR #23. Canonical membership, stale-index refusal,
  post-resume checks and host-path redaction are tested; durable cross-restart
  delivery, guest caller transport and raw transcript/output fences remain open.
- The native Code compatibility matrix is accepted: Swift build/test, actual
  SourceKit indexing, Chromium, Playwright and local Xcode package resolution
  match main in sandboxed/escaped modes, except intended protected sandbox reads.
  Native/embedded context-reader coverage is independently accepted at SDK
  `1971f9a6`; Core accepts it at `6c35a3a8`. The additional durable cron-prompt
  guard is pushed at `bbab87d9`, with focused tests and both typechecks passing;
  both full CI runs and all 12 checks pass at that newer head. The designated
  reviewer accepted it for a scoped foundations merge; release and pin remain separate. See the
  [embedded acceptance evidence](research/2026-10-12-cowork-embedded-context-acceptance.md).

## Work in progress

The feature composition now includes schema 10 volume filesystem preparation and
recovery through `9c48655d`. Format-once intent is durable before writable handoff;
unknown disks cannot regain virgin eligibility, and pending journal recovery cannot
confirm readiness. Actual disposable Linux ext4 tests passed (14 tests, one
Darwin-only skip), and the composed host suites passed 70 tests/540 assertions.
This does not establish guest mounts or a production native stop adapter. See
[Linux filesystem evidence](research/2026-10-12-cowork-filesystem-v2-linux-ci.md).

SDK PR #5 at `39ba77ec` now passes actual native ARM64 and x64 Linux supervisor CI jobs against
byte-identical service source. The real SDK Read/Edit/Write/Bash routes, two runtime
UIDs, plan/read-only mounts, cancellation/revocation and namespace descendant
cleanup passed; all 11 protocol tests passed on Linux. Earlier actual startup
failures exposed inherited mount-descriptor namespace ownership; the correction
clones detached mounts before unsharing and attaches those exact objects afterward.
A pathname-replacement regression preserves the admitted directory identity.
See [architecture-specific Linux evidence](research/2026-10-12-cowork-linux-supervisor-ci.md).
Full PR CI and designated re-review remain separate from these Linux job results.
Full guest startup is still disabled, and Winter's SDK pin is unchanged.

*Later status (2026-10-15):* agent SDK PR #5 is merged (2026-10-12, merge commit
`41ac3df21`), as are PR #4 (the Linux ARM64 guest runtime artifact) and PR #7
(guest provider turns through a private host proxy), both on 2026-10-12. Merged
is not released: confined-guest query startup still refuses on the SDK's `main`.

The two-disk fixture at `9a588735` is built and signed with 60 Python regressions
and two strict-C handoff runs passing, but has no independent launch-admission
receipt and has not run. The native review task was held after its agent turn
failed an automatic content check; no VM launch was substituted. Mac workspace management and ephemeral host-owned folder preparation are now
composed through `55eb17ee`, including both asynchronous picker ownership fixes.
Independent 171 Core/API tests and 21 Swift tests passed; two actual Debug app
builds succeeded. Preparation does not enable creation, durable grants or shares.
See [selection acceptance](research/2026-10-12-cowork-macos-selection-independent-review.md).
Git read transport through `0d575df0` reuses PR17 and performs real authenticated fixture
clone/fetch without forwarding credentials. Independent review found and corrected
mutable request-buffer aliasing and authority changes before result delivery; the
final synchronous authorization/result cut passed 23 independent tests/96 assertions.
See [delivery review](research/2026-10-12-cowork-github-read-delivery-independent-review.md). The composed Git/repository suite
passed 86 tests/432 assertions. It remains fixture-only until the isolated parser
helper, durable repository grants and guest source acknowledgments are connected.
Provider proxy/broker and the Git parser helper are progressing independently.

*Later status (2026-10-15):* the provider broker is merged. Winter PR #28
(`feat(cowork): broker concurrent provider turns with host-held credentials`)
merged into `main` on 2026-10-12 (merge commit `2cba23d2c`), and the broker source
(`packages/core/src/cowork/provider-broker.ts`) is also in `cowork/output-integration`.
Two native lanes, the Mac two-disk VM fixture admission and the native egress
broker, are on hold pending owner decision; not implemented.

| Area | Current work | Required before completion |
| --- | --- | --- |
| Canonical host state | Schema 10 repository, raw volumes and filesystem readiness journals, receipts/outbox, typed workspace metadata RPCs, remote allowlist mirrors and bounded cursor pages | Native controller acknowledgments, source provisioning, authority service wiring, lifecycle/recovery and paired-client scope adapter |
| Host storage protection | Retained-home fences, accepted Core/SDK path consumer, raw image owner/mode/identity and backup checks; deferred synthetic key-broker | Native descriptor consumer and stop proof; installed SDK integration; Workflow wiring; stop owned host effects on daemon loss |
| Native VM integration | VZ research foundations; reviewed Linux/HVF live reclaim with one RAW disk | Persistent RAW storage and remaining asynchronous devices, production signed worker admission, cancellation/ownership, direct shares, automatic resources and concurrent latency |
| Guest execution | Merged remote transport; confined text file and foreground-process helpers; protected-store bootstrap seam | Immutable runtime/supervisor, native ownership and termination adapters, complete process/extension routes, run-home/instructions and cold VM parent/child restoration |
| Network and credentials | Native egress and bounded Git publication foundations, isolated package receipts | Guest parser outside credential daemon; brokered sockets and providers/MCP; GitHub auth/private clone/service wiring; native resource bounds and revocation draining |
| Workspace behavior | Durable source/policy metadata transitions and replay-safe mutations | Real source admission and live add/remove/revoke, context refresh and trust, artifact/export/backup retention, same-Project messaging |
| Product integration | CLI metadata and guidance commands, with guidance content from `--content`, `--stdin` or `--content-file` (#37); Swift RPC methods; shared-guidance get/update/provenance, host schedule records, a durable per-conversation outbox and local watch leases (#36); bounded local reads of workspace outputs (#38); Mac workspace list, shared-guidance editor and schedules view (#39). Production create remains refused | Mac/CLI/iOS creation and execution, schedule creation (needs trusted ceiling and target inputs), guest integration, kit/SDK version integration and end-to-end checks |

Internal repositories and fake backends do not enable a session creation door.
Source/policy changes require the trusted controller to refresh its epoch before
issuing a new effect; old callbacks remain fenced. Empty schema 8 stores have an
explicit v7 rollback that preserves SDK layout (`winter migrate --cowork-schema
--rollback`); populated Cowork authority refuses rollback without data loss.
The release that first ships schema 8 must name this rollback command and its
populated-data refusal in its release notes; no release is being prepared yet.
Draft native and Git components remain isolated from production creation. Open
review work includes embedded and daemon-owned tool coverage, native
descendant termination evidence, and VM/admission
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

## Later status (2026-10-15)

Winter PRs #29-#39 merged into `cowork/output-integration` between 2026-10-12 and
2026-10-15, with the dates below. Creation and guest execution remain unavailable
after them.

| PR | Merged | Summary |
| --- | --- | --- |
| [#29](https://github.com/yanlingLabs/winter/pull/29) | 2026-10-12 | Compose Cowork guest queries with host approvals and projection: a guest-only query builder on canonical conversation identity with a one-use launch snapshot, composed with the approval bridge, permission gate, projector and SQLite checkpoints. |
| [#30](https://github.com/yanlingLabs/winter/pull/30) | 2026-10-13 | Record Cowork bypass parity and the required guest isolation checks. Documentation only; no code changed. |
| [#31](https://github.com/yanlingLabs/winter/pull/31) | 2026-10-13 | Plan current workspace context from canonical records: a parent-only planner that returns bounded facts and the required instruction scopes, not instruction bytes. |
| [#32](https://github.com/yanlingLabs/winter/pull/32) | 2026-10-13 | Resolve current parent guidance from canonical host records: a parent-only resolver over the planner and an injected protected guidance reader. |
| [#33](https://github.com/yanlingLabs/winter/pull/33) | 2026-10-13 | Preserve consistent repeated guidance imports, while still refusing cycles, invalid lineage, out-of-scope paths and contradictory repeated text. |
| [#34](https://github.com/yanlingLabs/winter/pull/34) | 2026-10-13 | Validate and map structured instruction snapshots onto the canonical workspace alias for the parent reader. |
| [#35](https://github.com/yanlingLabs/winter/pull/35) | 2026-10-14 | Adapt the SDK parent current-context callback to the Core resolver, with no cached fallback. |
| [#36](https://github.com/yanlingLabs/winter/pull/36) | 2026-10-15 | Persist guidance, schedules and workspace notifications: guidance get/update/provenance with revision and digest checks, durable host schedules, revision-only workspace events through a durable outbox, local watch leases; migrations 12, 13, 14. |
| [#37](https://github.com/yanlingLabs/winter/pull/37) | 2026-10-15 | `winter workspace instructions update` can read the new guidance from `--stdin` or `--content-file`. |
| [#38](https://github.com/yanlingLabs/winter/pull/38) | 2026-10-15 | Read workspace outputs through bounded local APIs (`workspace.output.list`, `workspace.file.stat`, `workspace.file.read`, `workspace.file.readRange`); schema 15. |
| [#39](https://github.com/yanlingLabs/winter/pull/39) | 2026-10-15 | Mac shared-guidance editor and schedules view in the workspace screen. |

Winter PRs #23, #24, #26 and #27 (messaging scope, format-once preparation, volume
journal recovery, durable Mac folder grants) merged into the same branch on
2026-10-12, before the numbered list above.

**Reader-only hosted run.** One hosted ARM run of the reader-only native check
succeeded on 2026-10-15: `yanlingLabs/winter-runtime-sdk` Actions run 38727104090,
workflow `reader-native-reviewed`, branch `cowork/reader-hosted-dependency-probe`,
head `2f7bd17c`, attempt 1. Its dependency probe returned the healthy record that
was recorded as the expectation before the run, with no outside canary visible, and
the reader case set passed (`readerCaseSetPassed: true`). This is one run on fixed
public data. It does not explain the earlier failed run (C59): the reader binary
was the same, but the compartment launcher, an added probe case and the runner
instance all differed, and one run does not separate them. It does not verify any
guided guest turn: `guidedGuestTurnVerified`, VM execution, production activation
and cleanup proof all remain false.

## Completion evidence still required

The immediate integration target is a developer-only real guest turn through the
same concrete host admission, disk ownership, worker and SDK transport intended
for production. The native profile has source-reviewed admitted descriptor intake for
both data and environment disks and distinct device registrations; its two-disk
worker still needs launch review and live reclaim coverage. The measured one-disk
fixture cannot stand in for that. Then connect an
immutable Linux supervisor/runtime image, durable format-once preparation,
protected stores and actual confined Read/Write/Edit/Bash. Test with credential-free
scripted host-provider traffic before introducing a real provider broker.
Unknown/restored disks must never be reformatted. The first cold-resume test must
use distinct host logical and SDK backend session IDs.

Keep unsupported tools and public creation refused during this integration.
In particular, protected child stores need separately admitted child identities
and lineage: a parent-scoped store cannot simply be reused for every subagent.
Host shares, shared guidance/memory/output mounts, networking and source readiness
must describe real prepared devices, not simulated acknowledgments. Complete
subagent restoration and all accepted source surfaces remain product requirements.

Follow all four gates in the main specification. In particular, demonstrate two
concurrent Project conversations and isolated cancellation; durable peer delivery;
real SDK child resumption after process and VM restart; revocation across all tool,
network and broker paths; code/session behavior preserved outside Cowork; and user
creation/control flows through Mac, CLI and paired iOS. Report tests, package builds,
CI, real-VM experiments, releases and production readiness as distinct results.
