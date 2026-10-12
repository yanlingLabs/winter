# Accepted native host execution policy: Core implementation

Base `f5534a8f`, branch `cowork/host-authority`. The 2026-10-12 policy decision supersedes the persistent outer Code/tool floor and ordinary-child first-activation restart debt described in earlier reports. It does not relax Cowork guest worker isolation or encrypted private storage/native key custody.

## Implemented behavior

Ordinary native Code follows its existing SDK permission/hooks/settings pipeline. `winter-session.ts` no longer automatically enrolls a Code incarnation into a host process broker merely because storage is active. `session-driver.ts` no longer constructs a second host policy evaluator for that circumstance. The installed SDK need not expose the experimental process broker or native output transport for ordinary Code to run.

HookRunner and LSP clients use their original main spawn paths, arguments, environment and tool sandboxes. Core supplies no persistent outer profile and no sandbox/GPU/Chromium/LSP override. MCP subprocesses remain on their own SDK path; their policy change and baseline verification belong to the SDK slice.

Canonical Core file/office/upload/diff/diagnostic checks remain. Sandboxed Bash gets active Cowork backing/control, runtime and run/socket roots plus coordination roots through the existing `sandboxConfigFor` denyRead/denyWrite arrays. `childSandboxConfigFor` spells those paths in the existing runtime grammar; no additional profile is created. File tools retain their narrow shared-artifact read exception. Approved escapes retain ordinary approval/main behavior with no extra Seatbelt. Cowork/coordination escape checks inspect write-shaped targets, aliases and ancestor replacement/move for integrity; read mentions and computed execution are not confidentiality enforcement.

Explicit broker facilities remain only behind `enroll({ ownedBridge: true, ... })` for intentionally Winter-owned worker/bridge operations. Their actual floor/output/authority requirements and bounded broker tests remain separate. No production native Code path passes this flag. Empty historical ordinary-child floors are no longer collected and cannot block activation.

## Activation and captured settings

The installed SDK has no live sandbox-settings refresh. Host storage registration is synchronous path authority; `refreshForStorage` now awaits policy consumers registered by the actual driver table and embedded host before provisioning may proceed.

- Code holds incoming/queued messages through the existing handoff machinery, lets its current turn finish, ends the logical incarnation and rebuilds its run home/Options on resume. Held work is replayed automatically on the refreshed incarnation with the same logical/backend identity. No daemon restart or assertion about escaped/native third-party descendants is required.
- Existing embedded Workers receive an end request and must settle their actual Worker `exited` promise before activation succeeds. A one-second embedded wait and the overall refresh deadline report pending/blocked activation on uncertainty. This acknowledges direct context-consumer closure; it does not prove arbitrary third-party descendants stopped.
- New or captured Chat/Dispatch embedded spawn paths continue to refuse active storage until complete file/context policy coverage is accepted. This interim gate remains independent of older SDKs ignoring new host flags.
- Consumer timeout/failure rolls back the tentative registration and prevents successful activation/provisioning. Held work remains in the normal logical transcript. Shutdown unregisters policy consumers; no timer clears security evidence or manufactures termination receipts.

A future independently accepted SDK live-policy control can avoid reincarnation, but is not a dependency of this installed-SDK fallback.

## Verification and limits

Focused regression: **620 pass, zero failures, 18 files, 2625 expectations**, including host broker, actual runtime topology, driver/queue/run-home behavior, embedded host/Worker fixtures, hooks, LSP, office and upload protection. After adding the participating-home run-root check, the affected authority/driver/fence suites were rerun: **150 pass, zero failures, four files, 775 expectations**. `pnpm typecheck:core` and `git diff --check` passed.

The new driver test finishes the current Code turn, queues another message during activation, observes a different rebuilt run folder with current sandbox denies, verifies the same backend identity and exactly one queued replay, and confirms there is no injected host process broker/floor. Native HookRunner/LSP fixtures demonstrate ordinary execution and successful activation after retired ordinary children. Real embedded Worker and real disposable-daemon fixtures confirm existing Worker closure and the retained interim embedded refusal.

These are Core policy/continuation checks, not a new production Cowork claim or a full durable subagent acceptance run. Swift build/test, useful SourceKit indexing and headless Chromium comparisons against current main belong to the independent SDK baseline. This Core report does not claim those platform workflows passed. No SDK pin/release, VM, live Winter app/daemon/home or real Keychain was used.

Encrypted private disks and signed native key custody provide the selected at-rest protection. Authenticated API plaintext access, approved same-user execution, arbitrary deletion/corruption, and delegated execution remain residuals. SDK file/context coverage, signed worker/storage integration and production end-to-end gates remain open.
