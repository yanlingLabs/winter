# Independent GitHub read delivery-cut review

Frozen source: `0d575df0b626ee86807e2ad406a27ea900e8a22a`. **Accepted for the implemented fixture-only read scope; no remaining blocker found in the reviewed corrections.** This supersedes the provisional acceptance of `05f38ffe`, whose subsequent final-continuation failure remains recorded in its amended review and separate evidence.

The complete `GitReadAuthority.authorize` contract and transport `recheck` are now synchronous. Repository/account/task-scope ports remain synchronous protected snapshots; refresh/network work cannot be hidden inside admission. The transport's final sequence performs the current-authority check, copies the owned result and returns without awaiting between those steps. Secret lookup, HTTP and body/parser waits remain bounded and followed by current checks. Periodic rechecks are synchronous, and the abort promise has an explicit rejection sink for an initial synchronous refusal before a raced await. The owned request snapshot introduced in `05f38ffe` remains intact.

Independent verification used an archive of this exact commit, with a local protocol dependency and installed external dependencies. No active author worktree or implementation file was changed; temporary files/links were removed. **23 tests passed, zero failures, 96 assertions** across the two read test files:

- 17 source tests, including real disposable loopback clone/fetch and strict fsck.
- The three original independent authority/body regressions, with direct `authorize` evaluation wrapped in a Promise solely to preserve the existing rejection matcher under its newly synchronous API.
- Two synchronous-scope variants that assert canonical stopped state actually occurred before refusal.
- One queued-stop ordering regression. A temporarily replaced and finally restored `Buffer.from` observes the power state when the transport makes its exact owned response copy immediately before return. The same probe fails on `05f38ffe` because the stop already occurred at that copy; it passes on `0d575df0` because a successful copy occurs while power is still `starting`, with the queued stop occurring afterward.

The last distinction matters: observing stopped state when the caller resumes from `await read()` is not sufficient to reject a correctly completed read. A queued event may run after synchronous result commitment but before the caller continuation. The earlier caller-only diagnostic is retained, but is not the acceptance oracle for this correction. Completed bytes cannot be retracted. Production channel composition must synchronously recheck current authority at its actual delivery/enqueue decision; this fixture transport is not that authenticated channel.

Evidence beside this report:

- `2026-10-12-cowork-github-read-delivery-independent-probes.ts` — combined six-probe fragment appended only in the disposable checkout.
- `2026-10-12-cowork-github-read-delivery-independent-tests.log` and `.json` — exact commit, command and passing result.
- `2026-10-12-cowork-github-read-final-cut-order-probe.ts`, `-tests.log` and `-tests.json` — the same ordering check's failure on `05f38ffe`.

Default production availability/read refusal is preserved. In-process packet/pack parsing, real account/grant storage and revocation composition, authenticated guest dispatch, resource-confined parser/helper admission and durable source completion remain outside this acceptance. No real account, external authenticated network, app or VM was used. The separate native fixture task remains held after an automatic cybersecurity flag; no retry or native launch admission occurred.
