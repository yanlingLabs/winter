# Cowork specification review disposition

An independent read-only review of specification commit `c7fd1f87` found a coherent product direction but five unresolved execution/integration contracts. Source was checked against Winter `c7fd1f87`, agent SDK checkout `27f1c43e` and runtime SDK checkout `c542420`; the SDK checkout is not a claim about Winter's released pin. The revisions below update the [main specification](../cowork-spec.md) and add its normative [execution companion](../cowork-execution-contracts.md).

Status: independent re-review of `21e3e5f4` accepted C1/C2 and R-a–g, in addition to the earlier acceptance of B1–B5, H1–H5 and R1–R8 at `da073e0d`. No remaining blocker or contradiction with accepted product choices was found; the reviewed specification is ready to plan all four gates. Five non-blocking planning details from that acceptance are recorded below. This is not implementation approval or proof that any feasibility gate passed. No VM was launched, dependency installed, live app/daemon changed, SDK released or pin bumped during these review responses.

| Finding | Specification disposition | Remaining validation |
| --- | --- | --- |
| B1: same-UID tools can change control state | Protected supervisor/runtime plane, separate confined tool identities, immutable code/config, hidden SDK stores, read-only shared guidance and approved write service; host owns current and authenticated saved authority | Linux confinement across every execution path; aliases, inherited handles, ptrace/proc/socket attacks; plan read-only views and narrowing transitions |
| B2: guest can drive host sessions | Explicit caller/target/workspace authorization matrix for messaging, lists, stop and spawn; guest-to-host denied; host-to-guest requires delegation; Dispatch creation names an already authorized workspace | Guessed IDs, aliases, children, resumed identities, discovery filtering, target-policy checks and card attribution |
| B3: missing policy/approval matrix | Six Cowork policies, Project capability ceiling, explicit connector rules, auto reviewer behavior, no SDK blanket sandbox shortcut replacing host checks, unattended blocking/denial and no host escape | Each policy/tool/connector row, saved rules, reviewer failures, running-process policy narrowing and card timeouts |
| B4: host readers cannot read guest volume | Guest router materializes genuine run homes; authenticated file/image/diff channel; inventory of host reader migrations; host-backed shared guidance/memory/outputs for stopped reads | Real guest run-home authenticity, no host stat of guest paths, no SDK-home symlinks, stopped shared reads, visible guest-only wake, unavailable backing recovery |
| B5: extension and trust surface missing | Linux tool-side stdio/hooks/plugins/LSP; host-proxied HTTP MCP credentials; explicit host Office/browser/computer/Xcode; plain guidance admission separated from executable trust | New clones remain executable-untrusted, platform mismatch refusal, secrets stay host-side, config refresh/cancellation and guest process ownership |
| H1: daemon lifetime affects every VM | Explicit bounded quit/restart/update checkpoint/stop before stores close; crash/uncertain-effect recovery; no live-VZ adoption claim; old-guest disk ownership remains mandatory | Signed daemon exit/SIGKILL, backing-service cleanup, fast relaunch, updater occupancy and timeout behavior |
| H2: provider broker is not just auth injection | New normalized host-provider transport runs provider-runtime adapters on host; covers Console/Codex/other adapters, subagents, advisor, digest and keyed search | Auth/header/endpoint parity, refresh, cancellation, streaming/retry boundaries and provider-state continuity |
| H3: NAT does not enforce private-network grants | Embedded host-owned userspace endpoint, candidate VZ file-handle attachment, no parallel direct NAT/bridge path | Gate-1 integration/throughput plus direct-IP/raw/UDP/IPv6/DNS/rebinding/proxy-bypass tests |
| H4: mounted-folder compatibility | Signed app/daemon TCC/bookmark handoff is explicit; separate OS-native dependency/build outputs; filesystem/watch/lock tests; no invisible overlays or routine copies | Protected/external/network folders, revocation, Mac and Linux native artifacts, APFS/virtiofs compatibility and concurrent access |
| H5: GitHub connection and branch enforcement are new | Host auth/Keychain/repository selection plus smart-HTTP gateway validating actual ref updates and GitHub branch/ruleset metadata; private clone included | Multi-ref/non-fast-forward/delete/default/protected ref handling, redirects, LFS/submodule scope, credential isolation and revoked access |
| R1: editable seed can erase publication default | Generate obligation from canonical host publication policy every relevant turn/resume; shared WINTER.md is optional editable/narrowing guidance | Deleted/old seed files, policy changes, user overrides, source revision changes and unchanged authority |
| R2: standalone cleanup could delete sole data | Conversation deletion detaches/archives workspace; explicit workspace deletion is separate; reapers/cleaners cannot delete volumes | Empty sessions with valuable files, dirty repos, retained disk UI and stop/ownership before deletion |
| R3: overlapping host grants undecided | Allow explicit overlapping folder grants, including Code; state shared-file consequences; no inferred session/credential authority | Independent grant revocation, same-folder concurrent editing and exclusive VM-disk ownership |
| R4: other Linux/host-path gaps | Workflow Linux confinement, composer image transfer, location-based file index, guest inference/LSP, host-backed memory/Dreamer binding | End-to-end checks for each inventory row; unsupported platform behavior remains explicit |
| R5: mutable guest runtime | Digest-verified immutable Linux runtime/supervisor/router image, required version handshake, accurate queued-input feature reporting | Tool attempts to replace/shadow binaries/imports, wrong versions, cold state compatibility |
| R6: per-daemon counter is not machine-wide | Logged-in-user participating-daemon admission ledger; total host pressure observation; fake backend by default in tests and explicit disposable real-VM opt-in | Dev/dist/custom-home races, owner crash, stale records, nonparticipating consumers and cleanup |
| R7: backup consistency and write amplification | Keep sole durable state backed up by default; consistent generation-bound export includes volumes/manifest/shared snapshot; no unverified Time Machine amplification claim | Running vs stopped restore, concurrent host writes, actual sparse-image transfer size, disk-full/export failure and parent/child continuation |
| R8: Mac sleep/wake | Bounded pre-sleep checkpoint, no display-sleep shutdown, wake reconciliation before new work, no blind stream/effect replay | Forced/lid/long sleep, network changes, approval waits, active writes and wake/stop/message races |

## Corrections and deliberate distinctions

- Current cwd admission uses `statSync`; the original review's `existsSync` shorthand was not copied into the source inventory.
- Apple documents runtime directory-share changes, but that does not establish Containerization hook effectiveness or open-handle revocation.
- Controller-process exit is treated as a loss/recovery boundary. No unsupported guarantee that PID death proves guest/storage termination is made.
- Apple's Time Machine overview does not prove that every sparse ext4 modification recopies the whole image, or that incremental copies are block-efficient. Measure actual backup/restore behavior.
- Reusing Code instruction filenames/order does not make additional-root discovery, mandatory subagent guidance or context refresh already work. The plain-guidance/executable-trust split is a stated Cowork change.
- The policy matrix does not claim a remote connector's read-only annotation proves no side effects. Local plan-mode filesystem writes are separately prevented by the execution view.
- Moving shared guidance/memory/outputs to canonical host-backed files preserves their guest paths and direct-access/no-mirroring behavior. Repositories and real SDK stores remain on the guest data volume.

## Re-review of da073e0d: later planning contracts and refinements

The [host protocol inventory](../cowork-host-protocol.md) and expanded [execution contracts](../cowork-execution-contracts.md) address this second review. The prior review's readiness judgment applies to its reviewed commit, not automatically to later edits.

| Finding | Documented disposition | Remaining validation |
| --- | --- | --- |
| C1: new host tree is outside current fences | Canonical authority moves to protected runtime-state DB tables; manifest is nonauthoritative. Extend common host read/write/escape fences over Cowork and coordination paths, including other homes/aliases/ancestors. Preserve non-bypassable control-storage denial on raw host execution. Define coordinated B/home migration, explicit C exclusions and no guest re-keying. | Host Code/Dispatch raw tools and computed-path escapes, bounded permitted shared reads, source/destination ownership, consistent DB/volume/shared snapshots, migration resume/rollback and unsupported downgrade |
| C2: host/wire inventory missing | New normative record/RPC/event tables with WorkspacePolicy and HomeIdentity, source/membership revisions, standalone owner reservation, content-bound request idempotency, canonical outbox, per-method paired decisions, four allowlist mirrors and iOS kit integration | Producer/consumer schemas, denied fields/roles, safe projections, event classification, index rebuild/crash fanout, remote source operations and consumer release checks |
| R-a: trusted filesystem methods bypass compartment | Ordinary file tools execute through a helper inside the caller's effective tool identity/view; no broad runtime handles are passed; protected-instruction writes remain explicit broker operations | Concurrent symlink/rename/ancestor races, narrowed child/plan views, existing handles, notebook/image/search/diff paths |
| R-b: native packet stack shares daemon load/failure | Native dedicated queues/threads, bounded queues/backpressure; explicitly same crash domain as controller/provider transport; aggregate CPU/memory/event-loop/tail-latency gates | Concurrent guests, model streams, traffic/lifecycle churn and UI/approval responsiveness; saturation never disables enforcement |
| R-c: automatic guidance remains injection risk | Record influence within already granted sources/egress, without falsely claiming separately approved risk; expose admitted guidance provenance/revision/refresh | Source changes/resume provenance and safe paired path projection; no claim metadata prevents injection |
| R-d: global ledger location/test isolation | Fixed per-user Coordination path outside supported homes, overlap refusal, host fences, persisted home identity plus observed PID/start/boot identity; test backend never touches real ledger | PID reuse, stale/unknown owner, relocation vs duplicate copied identity, early dependency injection and isolated multi-daemon tests |
| R-e: host shares can fill Mac volume | Automatic backing-filesystem pressure guard with tunable 5 GiB reserve, write admission block and visible emergency halt/read-only/stop; no automatic data deletion. Explicit reactive/not-hard-quota and incomplete-write limits | Multi-guest/host-write overshoot, metadata exhaustion, failed checkpoint/marker/remount, adequate measured reserve margin or quota-capable backing before exposure |
| R-f: Git gateway cannot constrain unrelated credentials | Limit feature-ref enforcement claim to Winter-held credentials; independent credentials plus outbound access remain outside that guarantee, without authorizing policy evasion | Gateway rejection vs alternative-route distinction and honest capability descriptions |
| R-g: Quit stops owned work/schedules | Warn on active/unknown occupancy or enabled Cowork schedules, identify affected work and offer cancel/quit; 30 seconds bounds graceful drain only, not termination proof | Idle scheduled-only work, independent profiles, user restart/update, incomplete flush and retained disk ownership |

Follow-up internal checks clarified that `session_created` stays outside history as today while preserving live/replay stream control; broker authority is revoked immediately before pending filesystem cleanup completes; canonical Project/standalone policy exists once in WorkspacePolicy; guidance provenance uses safe source-relative paths remotely; and migration cannot blindly skip user artifacts named `index.db` or SQLite sidecar names. These are specification corrections, not passing runtime tests.

## Acceptance of 21e3e5f4 and planning follow-ups

The final independent review accepted all documented findings at `21e3e5f4` and found no remaining blocker. It judged gates 1–4 ready for planning while explicitly leaving all feasibility tests open. The following non-blocking details were then added to the host protocol contract as planning requirements; they are not a claim of additional external review or implemented transport behavior.

1. `workspace.watch` has an explicit negotiated wire kind, peer/transport-generation ownership, bounded subscription set, lease/renewal, detach/revocation/expiry cleanup and refetch on reconnect. It is not an ordinary single RPC reply or a sessionless SessionEvent.
2. Remote frames are capped at 512 KiB after complete WireEnvelope encoding; content chunks at 256 KiB decoded; list/snapshot pages at 100 entries/256 KiB inner JSON. Final encoding checks and generation-bound chunking keep them under the current 1 MiB transport ceiling.
3. Default approval policy initializes new conversations, while publication changes apply to existing ones: broker narrowing is immediate and generated guidance refreshes at the next safe turn/resume boundary.
4. The external admission ledger binds HomeIdentity to canonical path, volume/directory identity and host installation. Copying DB bytes is not registration. Migration Assistant/new-Mac restore uses an explicit recovery/relocation transaction with grant revalidation; local identity tracking does not prove an unreachable old Mac stopped.
5. A named daemon-side `assertRemoteMayUseWorkspace` resolves and checks workspace/project/source/location/file/export/delegation/subscription scope, including each chunk and stream renewal/emission. Cowork session gating delegates through its canonical binding; unknown records/modes fail closed.

## Review evidence and boundaries

### Subsequent storage decision

During implementation review the user selected **"Encrypt at rest"** when asked
how to protect private VM data from commands approved outside Code's sandbox.
The reviewer relayed the exact choice and its helper-only Keychain custody,
ciphertext-at-rest and detectable-not-preventable corruption/deletion limits.
Fence-only protection and blocking Code escapes while Cowork data exists were
the rejected alternatives. The new [storage contract](../cowork-storage-security.md)
records this as a subsequent product decision, not a property of the earlier
plaintext probes or a passed gate. The reviewer subsequently narrowed their
control-record extension to integrity protection for broker/worker-consumed
manifest, workspace/volume identity and key version, not control-record
encryption or a helper-backed database. Selected Mac folders and shared
instructions/memory/outputs remain plaintext. Host transcript/diff copies need
their own explicit treatment. The separate later worker decision below changes
process topology; active RAM return remains mandatory and unproven with Linux.

This supersedes the earlier C1 wording insofar as it implied that path/IPC
denials could prevent every same-user delegation escape. Fences stay defense
in depth. Helper authentication, encrypted block I/O, integrity/recovery and
sealed broker-consumed identity records are new mandatory implementation gates.
Authenticated Winter API requests can still ask a guest to return plaintext;
this is an explicit residual alongside host transcript/diff copies. A native
launcher handing the genuine Core instance an inherited capability descriptor
is the candidate for broker launch admission, not a code-signature-only check.

### Subsequent worker decision

The designated reviewer relayed the user's explicit **yes** to one sandboxed
VMM worker per workspace on 2026-10-11. This supersedes the earlier embedded
controller and shared daemon/network crash-domain baseline, including R-b's
historical disposition above. Project conversations continue sharing one VM.
The daemon orchestrates; guest-facing parsers stay outside its credential
process. Workers require hardened signatures/library validation, no debugger
entitlement, a verified sandbox, scoped storage/shares and brokered networking.

The next candidate is pinned libkrun/HVF. Its stock macOS `MADV_FREE` handler
is not proof of active memory return; the existing bare-metal discard experiment
is not Linux/device/concurrent-vCPU proof. A separate minimal key/launch broker
and workspace-derived worker keys are the current architecture proposal, not
an already implemented or independently accepted mechanism. Keep the prior
plaintext/VZ receipts as evidence of their tested scope only.

The companion links exact current source consumers and pinned SDK/router evidence, plus primary Apple/Linux/GitHub documentation. A second architecture review checked Linux control-state protection and cross-mode/policy behavior; separate source and platform reviews checked reader placement, extension/trust integration, lifecycle, networking and storage claims. Their refinements are reflected in plan-mode read-only mounts, pending narrowing transitions, explicit Workflow behavior, supervisor-owned mount setup, host-backed-file validation and export-generation consistency.

Documentation validation covers local links/anchors and whitespace. Runtime, security, performance, signed packaging, cross-process recovery and hardware feasibility tests are still required during a separately authorized implementation phase. Independent re-review may identify additional specification gaps; the recorded dispositions are not a substitute for that review.
