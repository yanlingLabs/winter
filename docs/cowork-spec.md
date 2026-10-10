# Cowork working specification

Status: specification in progress, 2026-10-10. Cowork is not implemented. The user requested a comparison of the architecture options before choosing a VM backend or sharing layout. Neither is selected by this document.

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

## Architecture decision still open

See the [VM options comparison](research/2026-10-10-cowork-vm-options.md). Keep four decisions separate:

1. Backend: Containerization, direct Virtualization.framework, a lower-level VMM, or an existing manager.
2. Controller placement: existing daemon, one shared helper, or per-VM helper.
3. Guest allocation: per workspace/Project, per conversation with shared Project storage, or shared VM with guest containers.
4. Guest OS: Linux for the general workload, versus a separate macOS guest requirement.

Concurrent Project conversations make one VM per Project a direct candidate: several conversation runtimes can share one mounted workspace. A VM per conversation is another candidate, but sharing a Project then requires a filesystem service or validated shared host directories. The same ordinary writable block disk must not be independently mounted by multiple guests.

## Remaining specification work

| Topic | What must be decided or demonstrated |
| --- | --- |
| Native integration | Compare embedded Containerization and direct VZ; validate signed daemon integration, asynchronous native calls and actual process topology before selecting an adapter. |
| Concurrent edits | Define file-write conflicts, Project-memory updates and Git operations over a shared checkout without silently serializing all conversations or inventing transaction isolation. |
| Project Git branches | Preserve dirty state. Do not silently switch a shared checkout's branch when another conversation starts. |
| Durable layout | Stable workspace, conversation, repository, grant and runtime identities; persistent memory/scratch/outputs; disposable OS temp data; environment/package persistence. |
| Lifecycle | Aggregate work across every conversation, subagent, shell, workflow, tool request and pending I/O using the guest. Close admission and flush durable state before stopping; a new turn cannot race an old stop acknowledgment. |
| Scheduling | Host-owned durable schedules should wake stopped guests. Define canonical IDs, one-shot/recurrence, timezone, occurrence deduplication, missed-run behavior and conversation targeting. Future timers alone must not retain a VM. |
| Access | Revalidate folder/repository grants on boot; define revocation, guest network access, host tools and credential brokers. |
| Product surfaces | Creation, workspace/Project selection, concurrent activity, boot/queue/recovery status, files/artifacts, schedules, archive and deletion behavior across supported clients. |
| Resource and update policy | CPU/RAM/disk admission limits, retention, image/runtime compatibility, safe updates and failure recovery. |
| Acceptance | Real guest execution and multi-conversation concurrency, crash/daemon-restart recovery, grant revocation, cold child continuation and measured readiness/resource usage. No VM benchmark has run yet. |

## Implemented prerequisite, not Cowork implementation

[Agent SDK PR #2](https://github.com/yanlingLabs/winter-agent-sdk/pull/2) merged as `ec8012b5` at reviewed head `27f1c43e`. It adds durable subagent continuation with current authority checks and interrupted-history repair. It has not been released or pinned into Winter in this work. Root-shutdown ownership/timeout handling, typed refusal codes, fork snapshot deduplication and a worktree re-entry case remain follow-ups.

The [implementation map](cowork-status.md) separates existing host/UI infrastructure from unimplemented Cowork execution. The [research record](research/2026-10-10-cowork-vm-research.md) preserves source evidence, earlier proposals and accepted changes. This specification must not be used to enable Cowork before its execution and acceptance gates are implemented.
