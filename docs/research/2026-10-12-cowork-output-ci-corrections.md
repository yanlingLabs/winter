# Cowork integration CI fixture corrections

Isolated branch `cowork/output-ci-corrections`, source base `0890df2ee5f69b434935abe07bca6b414e08607d`; worktree `.worktrees/output-ci-corrections`. Root owns the separate CLI formatter correction. This leaf changes only selected test fixtures and their test-owned lifecycle helper; production session authority, Git executor/broker, publication permission/deadlines, SDK/native source, and availability gates are unchanged.

## Session listing diagnosis and correction

The retained CI log `review/output-integration-ci-38299072772.log` shows the capability parity test expecting two Code session IDs and receiving the no-visible-sessions answer. The exact selected test reproduced locally before editing.

The fixture passed a fabricated `s_dispatch` context while supplying a real `SessionStore.meta`. `agent/tools/list-sessions.ts` now checks the real caller record before revealing target metadata; a missing caller fails closed. This is the intended authority behavior, not a production listing regression. The fixture now mints a real Dispatch record and uses that ID on both registry and capability doors. The existing equality and both target-ID assertions are preserved. An added regression proves that a missing caller still cannot disclose a background Code session through either door.

`test/capabilities/sessions.test.ts` plus `test/cowork/session-messaging.test.ts`: **19 passed, 0 failed, 102 assertions**. The Cowork-to-host, unbound/cross-Project, stale binding, index downgrade and canonical-record failure refusals remain covered. No authority fallback was broadened.

## Git diagnosis and correction

The same CI log records the combined create/advance/CAS/replay test timing out at its unchanged 5-second test deadline, and a later unhandled `command_failed` error associated with an executor timer/source-scope refusal. The exact selected create/advance and source-scope tests passed locally before editing. A reviewer-only profile of the exact fixture and actual executor/broker counted **38 serial real Git commands**, completing locally in **315 ms**; twelve commands prepare the disposable fixture. Retained profile: `out/ci-diagnosis/profile.test.ts` and `profile.log`. These local measurements do not prove why the CI command stalled or that the later error had the same cause.

A concrete test lifecycle gap was present: `afterEach` removed disposable directories without cancelling or draining outstanding Git/publication work. A 15-second executor deadline can outlive a timed-out 5-second test. Removing its cwd/quarantine while that work continues permits later errors and effects against disposed fixtures. The test-only `GitFixtureLifetime` now owns cancellation and observes pending command/publication rejection immediately while preserving the exact promise/error returned to test callers. Teardown aborts and drains those operations before deleting directories. Late continuations cannot launch another command after closing. Both test cancellation and caller cancellation reach the unchanged executor through combined signals.

The negative assertion helper now awaits rejection normally, then checks both the `GitPublicationError` class and exact code/message. This keeps a rejection owned by its awaited test instead of asking a promise matcher to synchronously pump outstanding Git work. While developing the new helper regression, prematurely invoking such a matcher before initiating its cancellation stalled that single mocked test; only that owned test process was terminated and the regression was corrected to close before asserting the settled rejection. No production process was touched.

The long combined scenario is split into creation/replay/reauthorization and advancing an existing feature ref. All original creation/replay/revocation assertions are retained. The advance fixture seeds a real local feature ref, runs the same broker graph/CAS update, and additionally verifies the final remote OID, one push, and empty quarantine. No test deadline is raised. This reduces serial work per test without changing publication semantics or weakening assertions. Actual CI timing/error causality and the next full CI outcome remain unverified; the patch is not labelled a proven CI flake fix.

New deterministic lifecycle tests exercise abort/drain before cleanup, abandoned workflow rejection, refusal of late command effects, original error identity and caller cancellation, with injected commands only. Existing executor tests retain real disposable helper group/output-pipe cancellation evidence; those are not native Cowork ownership proofs.

## Validation and limits

Commands from the isolated worktree:

```sh
cd packages/core
bun test test/capabilities/sessions.test.ts test/cowork/session-messaging.test.ts
bun test test/cowork/git/broker.test.ts test/cowork/git/executor.test.ts test/cowork/git/fixture-lifetime.test.ts
cd ../..
bun run typecheck:core
git diff --check
```

Results: **19 session tests / 102 assertions** and **37 Git/lifecycle tests / 252 assertions**, zero failures and no unhandled error in the focused Git run. Core typecheck and whitespace validation exit 0. Retained logs are `out/ci-diagnosis/git-tests.log` and `core-types.log`. The broad 8,856-test CI suite was not repeated locally; Root owns the next CI run.

Only disposable stores, fake executors and local file-protocol Git repositories were used. No real credentials/network, daemon/live app/home/Keychain, native helper, privileged/mount/VM activity, held-lane retry, SDK pin/release or push occurred. Temporary dependency links point to the existing frozen integration installation and are removed after checks. The production Git entry still reports host-auth/service integration unavailable.
