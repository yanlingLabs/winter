# Independent GitHub read-slice review

Frozen source: `a242e538984bf328f89830530cf69449d948ec1c`, including its committed prerequisites. **Changes required: two confirmed defects.** The production refusal is intact; these findings concern correctness of the explicitly enabled fixture implementation and its proposed authorization boundary. The subsequent parser-helper work is outside this review.

## Confirmed findings

1. **High: canonical authority can become invalid during the final scope await, including the transport's final delivery check.** `packages/core/src/cowork/git/read-authority.ts:33` evaluates `this.check(caller, request)` before awaiting `this.scope(...)`. It then reads the workspace and returns a grant without checking power, incarnation, source or binding validity again. The later workspace read does not validate those fields, and power is absent from the returned grant comparison. A deterministic disposable-DB regression changes workspace power to `stopped` in the second scope lookup: authorization resolves instead of refusing. A second regression applies the same transition in the final transport recheck and the transport returns the full advertisement successfully. An explicit `revoke()` call would cancel a pending read, but does not make the claimed independent current-authority recheck correct. Perform the final canonical check after the last asynchronous resolution, and ensure account/repository snapshots are current at that same final decision; add source, power/incarnation, binding and account-revision regressions.

2. **Medium: Buffer input remains aliased after request validation.** `read-transport.ts:48` uses `requestInput.body?.slice()` as its request snapshot. Node `Buffer` satisfies the Uint8Array check, but its `slice()` returns a shared-memory view. Validation runs before authorization/SecretStore awaits; changing the caller's Buffer during an await changes the later POST without revalidation. The third regression supplies a valid upload-pack Buffer, overwrites the original with `0x58` during SecretStore retrieval and observes those invalid bytes in the outgoing request; the read still succeeds. Copy into owned bytes with `Uint8Array.from` or `Buffer.from` before validation. This finding is request-body integrity, not a demonstrated ability to choose host URLs/headers or perform publication.

The author was notified of both exact reproductions. This report does not pre-accept a correction or parser-helper follow-up.

## Independent evidence

Created a disposable archive of the exact commit, including Core/protocol source, and appended the review probes only to that copy's existing `read-authority.test.ts`. Dependency links used installed packages from `output-integration`, with the protocol dependency explicitly pointed at the frozen copy. Original worktrees and implementation files were not edited; the temporary checkout and links were removed.

`bun test test/cowork/git/read-authority.test.ts test/cowork/git/read-transport.test.ts`: **12 existing tests passed, 3 independent regressions failed, 82 assertions**. Both authorization refusal expectations resolve unexpectedly, and the body-ownership expectation observes mutated bytes. Existing tests include actual Git clone and incremental fetch through loopback fake upstream/broker servers, then strict fsck. The sentinel secret and repositories were disposable; no GitHub account, real credential, external authenticated network, app or VM was used.

Evidence beside this report:

- `2026-10-12-cowork-github-read-independent-probes.ts` — append-only regression fragment for the frozen test file, reusing its fixture setup/teardown.
- `2026-10-12-cowork-github-read-independent-tests.log` — full normalized failing run.
- `2026-10-12-cowork-github-read-independent-tests.json` — commit, command and result metadata.

Two earlier scratch-setup attempts failed because the requested scratch-parent directories did not exist; neither executed tests. The final run above uses a successfully created disposable directory. No such setup failure is counted as source validation.

## Boundaries preserved and remaining limits

The default transport reports unavailable and refuses before authority, secret or network access without the host-only fixture constructor option. No production caller is wired by this commit. A missing session ID is expressly host preparation authority; a future authenticated dispatcher must inject caller identity and must never accept this omission as a guest choice.

Host-resolved repository metadata determines the canonical GitHub destination and SecretStore slot. There is no guest URL/header/helper route, redirect following or receive-pack operation. Errors suppress upstream text; plain token/auth reflection is refused. Caller/source/grant revisions, task-source scope, ready acknowledgment and effective runtime read capabilities are otherwise checked. Pending reads support explicit revoke, periodic checks, cancellation, byte/concurrency/deadline limits and final-response buffering. No source readiness is acknowledged by a completed read.

The real Git fixture demonstrates clone/fetch data flow through this transport with fake host custody, disabled ambient credential/config helpers and no credential stored in the clone config. It uses an injected authority and local processes; it does not establish real GitHub account authorization, an authenticated Linux worker channel, guest namespace confinement or a durable source-operation completion ACK. The fixture Git process helper itself has no per-child output/deadline/reap budget; the enclosing test timeout is not native process resource-confinement evidence.

Packet/pack parsing still runs in-process. Response and object budgets and asynchronous zlib output bounds are useful preflight checks, but cannot admit this parser into the credential daemon. The default production refusal must remain until the separately implemented helper, actual authority/account composition, resource confinement and source completion path are independently reviewed. This review did not execute or review that newer helper.

The unrelated native fixture review remains held after an automatic cybersecurity flag; no retry or native launch admission occurred.
