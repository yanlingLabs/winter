# Provider final correction independent review — 2026-10-12

**Accepted for the bounded private-provider adapter/protocol scope. No remaining material finding in these deltas.**

Reviewed SDK `02277e1040af5080d3f33e989e9bef0f8c00e076..44e0563a2d9510f6f90bf2ba824f5bcf0bd2b061` in `.worktrees/sdk-provider-proxy`, and Core `843b84613c8ecf3dc325f7b3b469b20b884265c4..3b6b1c4416fbbba284a90906e28957833ae825af` in `.worktrees/output-integration`. Core's checkout is now `196d885c`; explicitly verified the reviewed broker, focused tests, integration test and fixture Worker are unchanged from `3b6b1c44`. Subsequent grant integration is outside this verdict.

## Findings checked

- Core `packages/core/src/cowork/provider-broker.ts:169` returns terminal `done`/`error` events after the single bounded adapter pull, without awaiting another finalizer deadline. `:103` retains the exact invocation slot until pending work and `iterator.return()` settle with `done:true`; rejected, ignored or nonterminal finalization does not release capacity. Map identity protects exactly-once release.
- Invocation cancellation remains scoped. Pending work and late canceled output cannot become an event or retire unrelated turns. SDK `packages/runtime/src/guest/provider-client.ts:47` attaches one monotonic ordinal to begin/next/cancel; the counter survives cancellation. Its capacity error remains typed/retryable without closing the binding or automatically replaying a request.
- Core `provider-broker.ts:66` consumes ordinals through a contiguous watermark and bounded 128-entry reorder window. Duplicates/old frames refuse, a canceled ordinal above a gap remains consumed when that gap fills, and 5,000 sequential invocations do not exhaust a lifetime ID set. Capacity refusals consume their ordinal; later attempts use new ordinals. Limits are 8 invocations per binding and 32 across the broker.
- Explicit close still aborts every owned turn, retaining pending/finalizer debt and releasing each proven-ended slot once. No timer is used as termination proof.

## Independent validation

Using existing frozen dependency installations and repository test preloads:

```text
SDK: bun test packages/runtime/src/guest/provider-client.test.ts
10 passed, 0 failed, 55 assertions

Core, with COWORK_PROVIDER_PROXY_CANDIDATE pointing to the reviewed SDK worktree:
bun test packages/core/test/cowork/provider-broker.test.ts packages/core/test/cowork/provider-broker.integration.test.ts
21 passed, 0 failed, 10234 assertions
(18 broker tests plus 3 actual-adapter/fixture-Worker/SDK-fold cases)

SDK: bun run typecheck
Both tsconfig.typecheck.json and tsconfig.sdk-fence.json exited 0.

Core: bun run typecheck:core
Exited 0 on the current integrated checkout, whose provider files match the reviewed leaf.
```

The timing test delivers a terminal event after roughly four seconds while holding the finalizer another four; it passes without blocking another invocation. Existing OpenAI/Anthropic continuation and partial-failure cases exercise actual shipped adapters through private Worker framing and the SDK fold, with fetch replaced by fixture responses. No external provider/network, native helper, VM, privileged operation, real credential or held task was used.

Preserved the pre-existing SDK `.DS_Store` modification and Core's untracked grant review report. No source edit, commit, push, release or pin change was made. This accepts the correction, not native channel authentication, canonical production admission, complete guest execution or Cowork activation. Updated private-protocol artifacts still require rebuilding from the accepted source; existing artifact receipts cannot be relabelled.
