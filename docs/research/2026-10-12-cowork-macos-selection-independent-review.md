# Independent Mac folder-selection review

Reviewed `55eb17eed0f7d76014d18364e32d81e86a9aaad0` in `<workspace>/.worktrees/macos-selections`, including the prior `b0c2ca58` UI findings. **Accepted for the implemented ephemeral local folder-preparation scope; no blocking finding.** This is not provisioning, source-sharing, VM or execution admission.

## Prior findings closed

`CoworkWorkspaceView.swift` now captures a preparation generation plus the initiating workspace/revision. A completed preparation checks that context before application, releases late receipts, and changes its loading/error state only while it still owns that generation. Dismissal, a later creation sheet, selected-record changes and disappearance invalidate the context. Staged preparation IDs are revoked when invalidated. `CoworkWorkspaceModel.add(_:workspaceId:expectedRevision:)` additionally rejects a changed target/revision before a mutation RPC. The original workspace-retargeting and Cancel → New → late-selection paths no longer apply to the new form or workspace.

Removal text now says dependent work is blocked immediately and distinguishes the later detach acknowledgment; restart text also distinguishes cleanup from the immediate refusal. The prior misleading wording is corrected.

## Host boundary reviewed

- The IPC server checks authenticated roles before dispatch. Local preparation methods are absent from the remote inventory; service checks additionally require a local-user principal. The default host derives that principal from the already authenticated harness/admin role, not clientName or request fields. Preparations bind both principal and server-generated connection ID. This is existing local token authority, not signed-app identity or proof of a picker gesture.
- The protocol bounds decoded bookmarks to 64 KiB, and the registry rejects noncanonical base64, invalid labels/access, stale/malformed/non-file bookmarks and inaccessible directories. Its projection contains an opaque selection ID and display facts; bookmark, path, native scope, descriptor, grant and root IDs stay host-side.
- Checked the CoreFoundation FFI against the installed SDK's `CFURL.h`: resolution options `0x8300` disable UI, mounting and implicit scope start. CF references use integer-width values without rounding through JavaScript numbers; stale output is one byte, string/path outputs are bounded, owned CF objects are released, and successful explicit scope starts are balanced. A false scope-start does not claim an extension; actual directory and permission checks are still required.
- Protected-root checks include current literal/canonical ancestor, descendant and alias spellings. Directory traversal uses component-relative no-follow/CLOEXEC opens. The held directory identity is checked against a second intake resolution and on every selection/grant lookup; changed path, identity, permissions or protected-root registration refuses. This does not remove the documented same-user mutation/path race or become native share enforcement.
- Monotonic expiry does not extend on replay. Limits are 16 live entries per principal/connection, 128 globally and 4096 replay receipts. A changed request conflicts; expired/revoked replay cannot remint authority. Revocation, expiry, connection close and shutdown close descriptor/scope and clear retained bookmark bytes. Receipt tombstones remain bounded until connection close. Close is idempotent and prevents future issuance.
- The default host retains `requireProvisioning` refusal and no creation ceiling. Capabilities literally report repository preparation, provisioning and execution false. No source-ready acknowledgment, durable grant adoption, disk activation or mount is added. A later durable consumer must own and journal grants independently of the current connection-scoped lifetime before these controls can be enabled.

## Evidence and limits

Independent Core run: **171 tests passed, zero failures, 1124 assertions** across folder selections, workspace IPC API and protocol methods. It includes a real disposable Swift bookmark producer/CoreFoundation resolver, held-descriptor cleanup, replacement/relocation, protected-root changes, scoped replay/expiry and local/remote RPC checks. No real user-selected folder, app, production daemon, Keychain or VM was used.

Independent Swift run: **21 focused tests passed, zero failures** (14 model, 7 typed client), using `swift test --package-path apple/WinterKit --scratch-path <test-temp>/build --jobs 2 --filter 'Cowork(Client|WorkspaceModel)Tests'`. TMPDIR/build were isolated and removed afterward. The new tests cover the preparation context, explicit-target refusal, real disposable bookmark production, old-daemon fallback and local-only request inventory.

The first test attempt stopped before executing tests because ignored dependencies had been removed. The successful rerun temporarily linked installed dependencies from `output-integration`, explicitly pointed the Core protocol dependency at the reviewed checkout, and removed only review-created links afterward. Frozen source and worktree remained unchanged.

Retained final app-build log independently hashes to `f19df9f043c6b1b7a20b98e640f68ba9ca0f38a4c8b881926e61993914c7a288` and contains `** BUILD SUCCEEDED **`. This verifies the supplied build evidence, not a new independent app build or launch. No live picker/TCC, rendered view, accessibility or signed production-app behavior was exercised. Async view ownership is source-reviewed and helper/model-tested, not a live SwiftUI interaction test.

Independent test evidence is saved beside this report as `2026-10-12-cowork-macos-selection-independent-tests.{log,json}` and `2026-10-12-cowork-macos-selection-independent-swift-tests.{log,json}`. Logs normalize personal checkout and temporary prefixes.

The unrelated native fixture review remains held after an automatic cybersecurity flag. No retry or native launch-admission receipt is part of this review.
