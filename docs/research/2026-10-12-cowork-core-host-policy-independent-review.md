# Independent Core host execution policy review

Reviewed base `f5534a8f`, policy head `2d73387ead384ce6039fc78d455b1c0351675073`, and narrow bridge correction `a17cd696391c0082c3dd42aca188b8519cbf1075` in `.worktrees/host-authority`. **Scoped acceptance through `a17cd696`: no remaining confirmed blocker in this reviewed Core policy change.** Later same-policy/idempotent refresh refinements are outside this acceptance.

This review applies the updated 2026-10-12 host policy: ordinary Code, approved escapes, hooks, LSP and third-party MCP processes keep their existing tool-owned sandboxes; Winter-owned Cowork workers/bridges remain subject to explicit confinement. Encryption/native key custody supplies the selected at-rest boundary. Static escape checks remain integrity guardrails with the documented same-user residual.

## Finding B1 — closed by the narrow correction

At `2d73387e`, `packages/core/src/runtime-sdk/host-code-broker.ts:390` defined the required floor as `ownedBridge === true && hasFloor(floor)`. An explicit Winter-owned bridge enrolled while storage was inactive therefore became an unprotected generation. `refreshForStorage` skipped that generation at line 1172 and subsequently cleared the live map at line 1246, allowing activation without stopping or confining the owned bridge.

The test called “ordinary live children do not require stop/descendant receipts” reproduced that behavior through injected adapters: its shared `enroll` helper passed `ownedBridge: true` at `packages/core/test/runtime-sdk/host-code-broker.test.ts:132`, while lines 443–449 accepted activation with an unresolved stop and process-exit promise. The retired-child test made the same classification mistake. This was an explicit bridge API/scaffold blocker, not evidence that a production Cowork worker had launched.

Commit `a17cd696` makes `ownedBridge: true` independently require a floor and rejects `owned-bridge-floor-unavailable` before admission or launch when storage is inactive. Its test helper now distinguishes ordinary and owned enrollment, and the added regression verifies rejection before spawn followed by protected enrollment only after activation. This closes B1 without restoring a persistent floor or ordinary-child restart debt to normal Code.

## Callgraph and retained behavior

- `create.ts` → `spawnHookFor("code")` validates storage identity but no longer requires experimental SDK floor/broker/output capabilities. `winter-session.ts:1076` reaches the normal SDK query with the ordinary options/settings/hooks pipeline. `session-driver.ts` no longer adds a second authority evaluator for ordinary Code.
- `session-driver.ts:693` registers the real driver table as a policy consumer. Code uses `beginHandoff`, waits for its current turn to become idle, ends the logical incarnation, waits for closure, and rebuilds options/run home for held work. `winter-session.ts:908`, `:1267` and `:1290` preserve queued messages in transcript order. Logical and backend identities remain stable; this is not a third-party descendant-stop receipt.
- `embedded.ts:274` requests existing Workers to end and awaits their actual `exited` promises. A kill request alone cannot acknowledge activation. The captured spawn closure and actual host use point still refuse active-storage Chat/Dispatch until full file/context coverage is accepted. Timeout/failure rolls tentative registration back and blocks provisioning.
- `mode-options.ts:1037` adds backing/control, runtime, run/socket and coordination paths to the existing Bash deny lists. `childSandboxConfigFor` renders those lists in the established SDK grammar. Core file/office/upload/diff/diagnostic consumers retain their canonical checks; `home-fence.ts:80` adds participating-home run roots to read protection.
- `hooks.ts:1080` limits Cowork/coordination escape checks to write-shaped targets, aliases and ancestor replacement/move. There is no injected persistent outer sandbox or tool sandbox-disabling argument.
- HookRunner and LspClient are byte-for-byte equal to local `origin/main` `cb6e48421e2892c0ae5c82c34955496a7bfc01ef`. LspManager differs only by retaining its constructor config as a private field; its process command/arguments path matches main. This source comparison does not substitute for platform execution comparisons.

## Independent verification

Against the original frozen policy head, these five suites passed with the repository's isolated preload: **180 pass, zero failures, 869 expectations, 5.62 seconds**.

```sh
# working directory: packages/core
bun test test/runtime-sdk/host-code-broker.test.ts \
  test/runtime-sdk/session-driver.test.ts \
  test/runtime-sdk/create.test.ts \
  test/runtime-sdk/cowork-host-fences.test.ts \
  test/runtime-sdk/daemon-path-fence.test.ts
```

Four additional scratch tests reused the actual Core implementations and the existing fake-runtime/table seam with isolated preloads. They passed against the narrow bridge correction, without native child/VM execution:

1. A message queued before activation plus send, delivery and steer during activation replayed exactly once in transcript order on the new incarnation, with the same backend identity.
2. A refresh deadline failure rolled registration back. The already-approved turn finished, then its held message replayed exactly once with the inactive-storage policy, rather than being dropped or silently provisioned.
3. An injected embedded Worker stayed live after its kill request. Activation remained pending until the actual `exited` promise settled; new/captured host spawn stayed gated during activation.
4. A missing Worker exit acknowledgment caused activation rejection and registration rollback even though kill had been requested.

The queue probes passed 10 expectations; the embedded probes passed nine. The first scratch-harness attempt had a dependency-resolution setup error before any tests ran; correcting its temporary dependency link resolved that setup failure. Author source files were not edited. The fixtures used temporary stores/FileSecretStore and fake runtime/Worker operations; no real Keychain, live Winter home/daemon, native broker worker or VM was launched.

## Acceptance limits

The author's 620-test report is separate evidence; it was not reproduced wholesale by this review. The tests above verify Core path policy, continuation and activation acknowledgments. They do not prove actual Swift build/test, useful SourceKit indexing, Chromium compatibility, SDK file/context coverage, durable subagent continuity across a real runtime restart, signed native custody, encrypted volume I/O, or production Cowork end-to-end behavior.

Protected Chat/Dispatch remains an interim refusal. The newer same-policy/idempotent activation refinement is deliberately unreviewed here; root and the designated reviewer will assess its final combined head. No push or author implementation edit was performed by this review.
