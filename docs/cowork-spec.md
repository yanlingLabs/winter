# Cowork working specification

Status: working specification and recommended build, 2026-10-10. Cowork is not implemented. The accepted requirements below come from the user; the build and behavioral defaults that follow are recommendations for adoption, not additional user decisions or implementation results.

## Accepted behavior

| Requirement | Contract |
| --- | --- |
| Standalone ownership | One durable workspace per Cowork conversation. |
| Projects | A reusable workspace shared by its conversations. This scope covers workspace functionality, not a complete Project collaboration/organization product. |
| Project concurrency | Separate conversations may run concurrently against the same workspace. A workspace-wide conversation queue is not the selected behavior. |
| Project memory | Conversations share persistent Project memory. Their logical transcripts remain separate and are not automatically concatenated into one context. Shared files/memory do not establish confidentiality between conversations. |
| Execution | Winter's agent loop and its subagents run inside a VM. Guest OS and backend remain architecture choices. |
| Host process preference | Avoid a Winter-owned host process per conversation; prefer VM controllers inside the existing daemon. Apple-managed VM execution services must be distinguished from Winter-owned controller processes. |
| Workspace inputs | At least one explicitly allowed host directory or one selected GitHub repository. A GitHub account connection alone is not a selected repository. Combining directories and repositories is allowed. |
| Host folders | Granted writable folders are edited directly. Changes already made to host files survive VM deletion or rollback. |
| GitHub work | Selected repositories are cloned by guest execution into workspace storage and retain uncommitted work/local commits. Commit and push must be supported, with publication authority specified separately. |
| Activity | Preserve Code's Active/Background/Idle/Archived vocabulary and behavior. VM power is a separate state; an attached idle conversation must not be mistaken for busy guest compute. |
| Stop and resume | Prefer cold stop when genuinely quiescent, preserving durable files and logical agent continuation. Arbitrary processes, sockets and RAM are not promised to survive cold stop. |
| Subagents | Run inside the owning VM, inherit its access ceiling, and remain addressable by their durable identity after restart. |

## Recommended baseline

Use the Apple Containerization **library**, backed by Virtualization.framework, with Linux ARM64 guests on Winter's existing macOS 26 platform. Keep a small backend interface so direct VZ can replace the library if the feasibility work finds a concrete incompatibility. Avoid an external `container` CLI/service dependency in the shipped path.

Use **one VM per durable workspace**. A standalone conversation gets its own workspace/VM; a Project gets one workspace/VM used concurrently by its conversations. Run one Winter runtime process per conversation **inside the guest**, with that runtime's subagents in-process as today. Separate processes improve cancellation and context bookkeeping, while the Project VM remains the shared trust and failure boundary.

Load a native Swift controller into the existing daemon. Prefer a small Node-API adapter with asynchronous operation IDs and an event/FD channel; keep the binding thin and validate it in the signed compiled daemon. Native VM operations run on their required queues rather than invoking JavaScript directly from VZ callbacks. A shared native helper is a fallback only if embedded integration fails its gate, and would require revisiting the controller-placement preference. Apple-managed backing processes remain outside the promise about Winter-owned processes.

Containerization provides image/init/process machinery, and its inspected source has a writable-layer abstraction and an `exec` API for additional processes in a running environment. This supports the proposed shape without relying on experimental LinuxPod hotplug. It is not proof of Winter's durability, isolation or cancellation behavior. [Containerization overview](https://github.com/apple/containerization), [pinned process/storage source](https://github.com/apple/containerization/blob/bc994b88df46207fad7775b0eabc51947e315881/Sources/Containerization/LinuxContainer.swift), [Node-API support](https://bun.com/docs/runtime/node-api), [VZ queue contract](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/queue?language=objc)

```mermaid
flowchart TB
  UI[Mac, CLI and paired phone] --> D[Winter daemon]
  D --> V[Embedded native VM controller]
  D --> B[Provider, Git and approved host-tool brokers]
  V --> S[Standalone workspace VM]
  V --> P
  subgraph P[Project workspace VM]
    G[Guest supervisor] --> A[Conversation A runtime and subagents]
    G --> C[Conversation B runtime and subagents]
    A <--> F[Shared files, environment and Project memory]
    C <--> F
  end
  G <-->|Authenticated, versioned stream| D
  S <-->|Authenticated, versioned stream| D
```

See the [options comparison](research/2026-10-10-cowork-vm-options.md) for alternatives. Nested VMs, unrelated workspaces sharing one guest kernel, remote execution and macOS guests remain future directions unless a concrete requirement changes this baseline.

## Ownership and authority

| Owner | Responsibility |
| --- | --- |
| Host daemon | Workspace manifests, canonical UI transcript/events, approvals, grants, resource admission, schedules, credential authority and recovery UI |
| Native controller | VM objects and lifecycle, explicit disks/shares/network configuration, versioned transport, native resource cleanup |
| Guest supervisor | Conversation process launch, authenticated stream routing, task/process ownership, occupancy, drain/flush handshake and connection-loss handling |
| Guest conversation runtime | Agent loop, its own subagents and SDK store, tools and conversation-local control state |
| Workspace storage | Shared Project files/memory/environment plus distinct per-conversation state, scratch and outputs |

A workspace has one guest/disk owner but may have many active conversations. The owner lease prevents attaching its writable disks twice; it does not serialize Project conversations. Keep `workspaceId`, `sessionId`, `guestIncarnationId`, lease epoch, grant revision, image digest and runtime version separate.

The host determines workspace and launch identity from the authenticated channel and controller state. Guest-supplied IDs or claimed approvals are not authority. Run agent workloads non-root and keep the supervisor control interface out of their general tool surface. Cross-workspace grants remain denied even if guest code invents another workspace/session ID.

All Project mounts and shared memory belong to the Project's explicit grant set. Adding a folder grants the Project access, including its other conversations and subagents. Do not silently union supposedly private conversation grants. Distinct runtime homes and transcripts prevent accidental context mixing; they do not promise adversarial confidentiality inside one shared guest.

## Persistent storage and environment

Use a shared immutable base-image cache, a persistent writable environment layer per workspace, and a separate persistent data volume. Retain installed tools/packages and environment changes across normal cold stops. Pin the writable environment to its base-image digest; a new base cannot silently replace the lower layer beneath an old installation overlay.

Proposed guest layout:

| Location | Purpose and lifetime |
| --- | --- |
| `/workspace/repos/<repo-id>` | Persistent guest-cloned repositories, including dirty files, local commits and Git worktrees |
| `/workspace/folders/<grant-id>` | Explicit host-folder mounts; read-only/read-write as granted |
| `/workspace/.winter/conversations/<session-id>` | That conversation's durable SDK home, parent/child transcripts, metadata and replay state |
| `/workspace/.winter/memory` | Shared Project MEMDIR; standalone conversations get their own workspace memory |
| `/workspace/.winter/scratch/<session-id>` | Persistent conversation TMPDIR |
| `/workspace/outputs/<session-id>` | Durable outputs, accessible through the host artifact bridge |
| Guest `/tmp` | Disposable OS/boot scratch, with no cold-restart persistence promise |

The host owns the manifest and volume files beneath a Cowork workspace directory. Mount each ordinary writable disk into at most one guest. Materialize runtime configuration/run homes using guest paths, not host symlinks or Mac cwd strings. Separate conversation runtime identity from the shared Project memory path.

Scratch and outputs survive ordinary stop/archive. Reclaim only explicitly disposable caches automatically; deletion or retention policies must not silently remove uncommitted work, transcripts, memory or outputs. Workspace deletion never deletes granted host folders or their already-applied edits.

Image/runtime updates occur while stopped. Validate compatibility, retain the previous environment until migration or explicit rebuild succeeds, and preserve workspace data. A VM/image rollback cannot undo direct host-folder writes.

## Concurrent Project work

Run independent Project conversations concurrently. No workspace-wide turn queue is introduced.

Winter-managed edits use short per-path coordination and check the content revision read before replacing it. A known stale edit returns a conflict and preserves the competing content; the agent rereads before trying again. Show changed paths and other conversation activity. Arbitrary shell writes and external Mac editors remain shared-filesystem operations; managed coordination cannot guarantee that every program cooperates or prevent all lost updates.

Keep shared memory as durable, inspectable notes. Prefer separate append-only note files per update/conversation, with source conversation references. Coordinate revisions of shared indexes or summaries so two ordinary memory updates do not overwrite each other. This is new work over today's plain Markdown memory, not an existing transactional memory service.

## Repository behavior

At creation, choose explicit repositories and starting refs; create the checkout once. Standalone work may start on a conversation branch. Project conversations continue the workspace's current branches, HEADs, index and dirty state. Starting or reopening a conversation does not re-clone, reset, stash or switch branches.

Serialize managed Git index/ref mutations per repository while unrelated work continues. Managed commits use an explicit reviewed set of changes and relevant content/HEAD/index preconditions, rather than implicitly staging every concurrent Project change. If those preconditions changed, report the conflict and refresh the proposed operation.

Branch switching, checkout replacement, reset, rebase and similar operations must refuse while they conflict with active repository users, then offer explicit coordination. Do not silently pause every Project conversation. An explicitly requested separate worktree is available for divergent branch work; do not move all conversations into private worktrees by default.

Clone/fetch/local work follows the current workspace/tool policy. Push, PR creation, merge, protected-branch writes and history rewrites use their own current authority. An explicit user instruction or saved grant can authorize an action without asking again. Account connection alone grants neither every repository nor unrestricted publication. Branch-limited publication must be enforced by the Git broker; a repository-wide token alone does not establish a branch limit. Ordinary shell Git is not automatically covered by managed-operation guarantees.

## Credentials, host access and revocation

Keep provider/Git credentials on the host and expose scoped broker operations to the guest. Provider requests are constrained to approved providers/models and concrete destinations; Git requests to approved repositories/ref operations. Validate redirects and operation authority on the host. Existing host credential callbacks can transfer credential material to a runtime, so they cannot be reused unchanged to promise credential-free guest configuration.

Offer guest-native filesystem, shell, search and workflow execution first. Use an explicit Linux/VM execution posture; unsupported macOS sandbox code must fail rather than silently disable required protection or fall back to executing on the Mac. No automatic host home, SSH agent, Keychain or daemon-socket mount.

Recommend ordinary outbound Internet access for browsing and dependencies, while private host/LAN services need explicit capabilities or network grants. Local model endpoints are mapped deliberately through the host broker. This egress policy is a proposed product choice and needs enforcement tests; keeping credentials on the host alone does not control outbound data.

Host browser/office/computer capabilities are separate explicit opt-ins. They receive bounded artifacts or validated grant/location references, never arbitrary guest strings reinterpreted as privileged Mac paths. The artifact bridge exposes stable `{workspaceId, locationId, relativePath}` identities with traversal, symlink and content-size checks.

Revoke broker authority immediately. If a removed folder can remain accessible through open guest descriptors, stop affected work and restart the whole workspace VM without that share before reporting revocation complete. Other Project conversations receive the interruption reason because the grant/VM is shared. Files already read or changed cannot be recalled by unmounting. Removing Git remote authority preserves local checkout data unless deletion is separately requested.

## Activity, cold stop and recovery

Keep Code's activity derivation and attachment semantics. VM power is separate: `stopped`, `starting`, `running`, `quiescing`, `stopping`, `failed/recovery-required`. Reading the transcript does not require a live guest. An attached conversation may remain Active while its VM is stopped; an idle background label does not itself hold compute awake.

Recommend attempting automatic cold stop after **two minutes of continuous workspace-wide quiescence**. This is a tunable starting value, not the existing Code activity grace period or a measured optimum.

Occupancy includes every conversation turn, active subagent generation, task-owned process/shell, workflow/monitor, tool request, pending approval, queued input and filesystem operation in the workspace. Infrastructure such as init, the supervisor and idle runtime processes does not itself count as work. Unknown task ownership or an unresponsive guest is not idle.

Stop protocol: close new-work admission for the current epoch; drain guest work; flush parent/child/provider state and files; confirm host event ingestion through the final guest sequence; then stop and detach storage. Retain disk ownership until termination is confirmed. Input arriving before shutdown commits cancels quiescing; input after that boundary is durably queued for the next incarnation. Stale callbacks, schedule claims and stop acknowledgments cannot act on a newer epoch.

Pending approval callbacks keep the guest occupied in v1. Sleeping while waiting for approval requires a later durable suspend/rebind protocol; it cannot be obtained by treating a live callback as a host-only record. Scheduled work that needs missing authority should block visibly rather than silently become `auto`.

A new message or due schedule boots/resumes the workspace, revalidates grants/current policy and restores the same conversation/subagent identities. No live shell/socket/RAM continuity is promised. Clean stop has a durable flush contract; hard crashes recover from available durable state and mark uncertain effects for reconciliation. Event deduplication does not establish exactly-once external side effects.

On daemon loss, the replacement daemon must establish that the old guest has stopped before reopening its writable disks; a stale lease timestamp or dead controller PID alone is not proof. Corrupt/missing stores, disk exhaustion or incompatible images produce a recoverable error and preserve evidence instead of silently starting a new conversation.

## Host-owned scheduling

Put all timers and canonical schedule records in the daemon. Guest Cron and ScheduleWakeup tools must create/list/delete the same durable authority and report success only after host acceptance. Preserve one-shot versus recurring intent, timezone, target workspace/session, grant ceiling, overlap policy, occurrence ID and run status. Replace the current result-mirroring/process-local ID mapping path rather than layering another scheduler over it.

Recommended targeting: an agent-created wakeup continues its existing conversation; a user recurring routine normally creates a fresh conversation in a selected Project. A standalone schedule explicitly targets its existing conversation, since fresh standalone conversations otherwise mean new workspaces. Scheduling does not switch a shared checkout's branch; branch-sensitive jobs carry a precondition and block on mismatch.

Allow different Project conversations/jobs to overlap. For one recurring job, default to at most one active occurrence plus one coalesced pending occurrence, with missed counts visible. One-shots remain pending until handled, canceled or explicitly expired. Persist claims so daemon restarts cannot concurrently launch the same occurrence twice. An uncertain already-dispatched effect requires recovery, not blind replay.

Use current grants and policy within the schedule's saved authority ceiling; store credential references/intent rather than reusable credentials. Give schedule-origin turns explicit automated-turn protection so a terminal that merely watches them cannot abort them. The Mac and daemon must be able to run; local scheduling does not promise execution while the Mac is asleep or powered off.

Recommend pausing schedules targeting an archived conversation while other Project conversations continue. Archiving a Project pauses its jobs and drains its workspace when safe. Archive preserves data; deletion is separate.

## Resource policy and product surfaces

Start feasibility measurements at **2 vCPUs and 2 GiB RAM per workspace VM**, with workload limits below the full VM budget to leave guest overhead. Recommend an adjustable aggregate guest-memory ceiling initially around one quarter of physical RAM, subject to host headroom. These are provisional hypotheses, not measured capacity limits or a fixed conversation count.

Admit VMs and bound guest conversation/subagent/process fan-out against CPU, RAM and disk budgets. Capacity waiting is visible and distinct from serializing a Project's conversations. Never silently evict an occupied VM to start another. Preserve state on resource failures, and block destructive automatic cleanup when persistence is already failing.

The UI exposes workspace/Project identity, shared grants, running conversations, preparing/starting/ready/sleeping/recovery state, files/outputs, repo state and schedules. It must show that a Project grant or VM restart affects all its conversations. Mac creates local folder grants; paired clients can use authorized existing workspaces and supported repository flows. Phone control still targets the Mac's daemon/VM, not a phone-local guest.

Retain only the workspace portion of Projects in this scope. Keep Code behavior intact while adding an explicit Cowork mode; unknown/unsupported Cowork execution must not silently map to host Code execution. Do not enable a placeholder solely by changing an availability flag.

## Build order and acceptance gates

1. **Native/authority slice:** signed compiled daemon plus pinned Containerization, Linux guest and authenticated supervisor channel; disposable folder fixtures and mocked credentials only. Prove confinement/revocation and actual host/guest process topology before attaching user data.
2. **Durable execution slice:** Linux Winter artifact, guest run-home/transport, explicit guest sandbox posture, two concurrent Project conversations, independent cancellation, durable files/environment/memory, and real cold parent/child continuation. Release/pin the SDK prerequisite as a separate authorized integration step and complete shutdown/resume ownership gates needed for auto-stop.
3. **Workspace behavior:** folder/repo creation, shared edit/memory/Git coordination, provider/Git brokers, artifacts, image compatibility, quotas, crash recovery and resource admission.
4. **Scheduled/UI flows:** one canonical host scheduler, Mac/CLI/paired-client flows, activity parity, archive/delete behavior and end-to-end support through real supported creation doors.

Before exposing Cowork, verify: two unrelated guests cannot cross grants; two Project conversations really overlap; stopping one does not stop the other; revocation removes access after the required restart; idle detection includes detached work; wake/stop races start exactly one valid incarnation; dirty repos and memory survive cold stop; SDK SendMessage continues the same child after actual process/VM restart; schedule IDs survive daemon restart; disk-full and interrupted-effect recovery stay truthful; and events/approvals remain correctly associated with their conversations.

Measure first image provisioning, prepared VM boot, Winter-ready latency, repo setup and steady-state resource use separately. Apple's sub-second lightweight-guest startup description is not a Winter readiness benchmark. [Apple Containerization design](https://github.com/apple/containerization#design)

Implementation spans Winter's protocol/daemon/native packaging and Mac UI, agent SDK guest execution/lifecycle, runtime SDK Cowork/run-home/transport support, and iOS protocol/client surfaces. Apply the repository's protocol producer/consumer and Swift mirror checklists when implementation is authorized. No VM or implementation experiment is performed by this specification work.

## Implemented prerequisite, not Cowork implementation

[Agent SDK PR #2](https://github.com/yanlingLabs/winter-agent-sdk/pull/2) merged as `ec8012b5` at reviewed head `27f1c43e`. It adds durable subagent continuation with current authority checks and interrupted-history repair. It has not been released or pinned into Winter in this work. Root-shutdown ownership/timeout handling, typed refusal codes, fork snapshot deduplication and a worktree re-entry case remain follow-ups.

The [implementation map](cowork-status.md) separates existing host/UI infrastructure from unimplemented Cowork execution. The [research record](research/2026-10-10-cowork-vm-research.md) preserves source evidence, earlier proposals and accepted changes. This specification must not be used to enable Cowork before its execution and acceptance gates are implemented.
