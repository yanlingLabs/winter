# Independent GitHub read correction review

Frozen correction: `05f38ffea44db1204b23f714fa347e235ed2e44c`, following refused `a242e538`. **The original direct-callback and Buffer findings are closed, but overall acceptance is held by the subsequent final-continuation finding below.** The original failed evidence remains unchanged in `2026-10-12-cowork-github-read-independent-*`.

Follow-up: the outer authorizer and transport recheck still return through async continuations. A queued canonical stop during the final scope snapshot runs before the final response copy. `2026-10-12-cowork-github-read-final-cut-order-probe.ts` independently observes power `stopped` when that exact result buffer is copied; its targeted test fails on this commit (log/JSON share the final-cut-order prefix). This is distinct from a stop after a synchronous result commit, which cannot retract completed bytes. The earlier final-continuation caller-only probe is retained as diagnostic evidence but alone would be too strong for a correctly linearized synchronous cut. See the subsequent delivery review for the later correction; the 22-test result below remains accurate but does not close this additional case.

`GitHubReadGrantResolver.repository` and `sourceScope` now return synchronous protected snapshots. Network calls and credential refresh must occur outside authorization. The authorizer captures task scope and a copied repository/account snapshot, takes final snapshots, then verifies current canonical workspace/source/incarnation/binding/policy state without an intervening await. Copying the initial account record also prevents mutation of a resolver-owned object from rewriting the previously captured epoch. Missing or asynchronous resolver values fail closed under the stricter contract; callers cannot retain the old asynchronous API and consider themselves integrated. Production composition must implement real current protected records and advance account/task-scope revisions on changes and restores.

The transport now uses `Uint8Array.from(requestInput.body)` after the input-size check. This creates owned bytes for Node Buffer inputs as well as ordinary Uint8Array inputs before validation and asynchronous work. Later caller mutations no longer alter the validated POST.

Independent validation used a disposable archive of the exact correction with its own protocol source and temporary links to installed dependencies. Implementation files and the author's active parser-helper worktree were not edited. The archive and links were removed afterward.

`bun test test/cowork/git/read-authority.test.ts test/cowork/git/read-transport.test.ts`: **22 passed, zero failures, 94 assertions**:

- All 17 corrected source tests passed, including real local clone/fetch, account/task-scope changes, final transport stop and Buffer ownership.
- All three original independent regressions passed unchanged. The two old asynchronous-scope probes now refuse the unsupported async port early; their pass alone would not prove the final canonical check.
- Two additional variants use the new synchronous scope contract and assert that canonical power actually became `stopped`. Both the direct authorizer and the final transport-delivery check refuse. These variants confirm closure of the original late-stop behavior without relying on early malformed-port refusal.

Evidence beside this report: `2026-10-12-cowork-github-read-correction-independent-probes.ts`, `2026-10-12-cowork-github-read-correction-independent-tests.log` and `2026-10-12-cowork-github-read-correction-independent-tests.json`. The original probe fragment is also required to reproduce the combined 22-test run. Public evidence normalizes checkout and temporary prefixes.

The default transport still refuses production before authority/secret/network work unless the host-only fixture option is supplied. Packet/pack parsing remains in-process at this frozen commit. This acceptance does not cover the subsequent parser helper, native process confinement, actual GitHub account authorization, authenticated guest dispatch, durable source operations, ready acknowledgment or production activation. The fixture Git child-process lifecycle limitation recorded in the first report also remains; the test is not native resource-confinement proof.

No app, VM, live account, real credentials or external authenticated network was used. The separate native fixture review remains held after an automatic cybersecurity flag; no retry or native launch-admission receipt occurred.
