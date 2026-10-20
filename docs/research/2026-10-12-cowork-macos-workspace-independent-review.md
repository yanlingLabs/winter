# Independent macOS workspace-management review

Reviewed frozen commit `b0c2ca58a16aca5492c4e1ac30a82ccac91d1525` in `<workspace>/.worktrees/macos-workspaces`. Source remained unchanged and the worktree clean. This review covers the metadata model, SwiftUI surface, typed requests, and shell wiring. It excludes the subsequent source-selection implementation.

## Findings

1. **Medium, blocks enabling the issuer: delayed source authorization can target another workspace.** `apple/Winter/Sources/AppShell/CoworkWorkspaceView.swift:169` starts an untracked task and only sets the view-local `selecting` flag. Workspace row buttons remain enabled because the entire view is disabled only by `model.busy` (`:114`), and authorization does not set that model flag. Start Add on workspace A, suspend the issuer, select B and finish loading B, then complete issuance: `:176` calls `model.add(selection)`, whose implementation reads the current selected workspace (`CoworkWorkspaceModel.swift:125`). The resulting mutation targets B. Capture the initiating workspace identity/revision and reject completion after that context changes; an explicit target API would also prevent silently retargeting. Add a suspended-issuer regression that switches workspaces before completion and asserts that no add RPC reaches B.

2. **Medium, blocks enabling the issuer: cancelled creation can receive a late selection in a new sheet.** The explicit Cancel button (`CoworkWorkspaceView.swift:145`) stays enabled during selection; `interactiveDismissDisabled` does not disable that button. Cancel while issuance awaits, open New again (which clears the arrays at `:54`), then resolve the original issuer. `:175` appends the old selection to the new creation form without checking a creation generation, presentation state, or cancellation. Use a generation/token and invalidate it on cancellation, new presentation and view teardown; discard/release late selections through the issuer's cleanup contract. Test Cancel → New → original completion, including issuer failure. No grant or selection cleanup mechanism is implemented by this frozen seam.

   Both races are **unreachable in the frozen production composition**, which passes no issuer (`ShellSidebar.swift:726`). They are requirements for the ongoing source-selection integration, not claims that the current disabled picker can issue a grant.

3. **Low, current metadata UX: removal/restart copy misstates when dependent work becomes unavailable.** `CoworkWorkspaceView.swift:125` says the source stops being available after backend acknowledgment; `:98` says a restart is required before the change takes effect. `packages/core/src/cowork/repository.ts:167` immediately changes remove/revoke state to `removing`/`unavailable`, clears acknowledgment and revokes trust. `authority.ts:43` immediately refuses dependent source authority. Guest detachment/convergence can await acknowledgment or restart, but the host refusal already applies. Describe these separately, including removal as well as explicit revocation. This is an inaccurate explanation, not a host authority bypass.

## Scope accepted

No blocking model-state or request-replay defect was found in the currently enabled metadata-only composition. MainActor isolation plus the busy guard serializes list/detail/mutation operations. Source pages are bound to the workspace config revision and published only after complete pagination and policy retrieval; duplicate IDs and repeated cursors refuse. Selection clears old details. Mutations retain stable request IDs for the same intent/revision, including lost responses and committed creates with failed follow-up reads. A recorded receipt remains distinguishable from guest acknowledgment. The model does not claim runtime readiness or create a conversation.

The Core replay implementation checks the recorded request before current-revision validation (`repository.ts:104`), matching the client's preserved ID and expected revision on an unchanged retry. Revision conflicts remain server-enforced. The UI permits last-source security revocation independently of normal removal. Production New/Add controls stay disabled, with explicit explanation; execution remains unavailable.

## Independent validation and limits

- Ran `swift test --package-path apple/WinterKit --scratch-path <test-temp>/build --jobs 2 --filter 'Cowork(Client|WorkspaceModel)Tests'` against the exact frozen checkout: **16 passed, zero failures** (10 model, 6 typed client tests).
- Temporary build/TMPDIR were isolated and removed. These tests use scripted/local test transports; no live daemon, app, VM, Keychain or source picker was launched.
- Evidence: `2026-10-12-cowork-macos-workspace-independent-tests.log` and `2026-10-12-cowork-macos-workspace-independent-tests.json` beside this report. Public logs contain no personal absolute path prefixes.
- The two asynchronous view findings are source-derived interleavings, not executed SwiftUI reproductions. Existing model tests do not cover the view-local issuer lifecycle.
- No full app target build, rendered UI/accessibility validation, real issuer, provisioning, or Cowork execution acceptance is claimed. The author's full-target prerequisite failure remains disclosed in its report; focused Swift package tests do not close that gate.

The separate native fixture review remains held after an automatic cybersecurity flag. It was not retried and this UI review grants no native sandbox/VM admission.
