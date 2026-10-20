# Independent native child lifecycle review

Reviewed workspace checkout: `.worktrees/key-broker-lifecycle`, head `40d6828a6e9d0b523cec6d9918a01076bf982fb1`, base `fecd004adb6cb18681bcf1e634e00e6c70e576b7`.

Disposition: **scoped acceptance; no blocker found for the synthetic fixture-only sole-reaper lifecycle change.** This is not production worker admission, custody, descendant containment, or atomic PID-handle signaling acceptance.

## Ownership and signaling

All paths below are relative to `apple/Cowork/WinterCoworkKeyBroker/` in the reviewed checkout.

- `Sources/KeyBrokerNative/include/key_broker_native.h:8` introduces an opaque handle originating from this component's spawn; resume/wait accept no external PID. `Sources/KeyBrokerNative/native.c:104` checks default SIGCHLD/no-auto-reap policy before admission and frees only pre-spawn allocation on failed spawn.
- Under the documented sole-reaper contract, an unreaped child retains its PID after exit. The serialized fresh WNOHANG probe at `native.c:93` precedes SIGKILL, and `:120` precedes SIGCONT. ECHILD records lost ownership rather than signaling a possibly reused PID; other ownership errors become uncertainty. Both terminal states refuse further native signals (`:85`, `:117`).
- Default SIGCHLD disposition alone cannot prohibit another thread's `waitpid(-1, ...)` or concurrent signal-policy mutation. The implementation and README explicitly exclude these cases and do not claim pidfd-style atomicity. Acceptance depends on preserving that fixture process contract.

## Deadlines, locks and retained lifetime

- `native.c:73` uses CLOCK_MONOTONIC deadlines and WNOHANG probes. EINTR does not reset the initial or post-kill deadline. `:84` bounds accepted budgets to 10 seconds / 1 second, with fixture defaults 2,000 / 250 ms. Successful kill is distinguished from successful reap, including ESRCH and unconfirmed post-kill outcomes (`:96`). There is no blocking waitpid teardown path.
- `native.c:116` and `:131` use try-lock admission to handle operations; Swift serializes its public operations with an additional try-lock (`Sources/KeyBrokerCore/OwnedChild.swift:108`, `:115`). A busy operation is refused without letting a second lifecycle operation take ownership. Neither layer claims an elapsed wall-clock guarantee against OS scheduling or stalled system calls.
- `OwnedChild.swift:103` releases admission only on confirmed native exit. Timeout with confirmed reap still throws a timeout while releasing the slot; uncertain/lost ownership retains the native operations and debt. The ledger counts active reservations plus debt against 16 slots and never evicts debt (`:46`).
- Initialization validates the suspended executed image after attaching native ownership; a failed validation invokes bounded teardown (`:87`). Throwing initialization and later deinit cannot signal again after an uncertain/lost state. Native object destruction releases memory only (`:43`). Normal deinit attempts immediate termination with the 250 ms reap window (`:124`), retaining unconfirmed ownership instead of marking the child gone.

## Key delivery and evidence

The key-delivery path still validates the owned executed image after READY and before raw material flows (`Sources/KeyBrokerCore/NativeLaunch.swift:135`). The lifecycle diff removes the earlier `reaped=true`-on-negative-wait behavior. `Sources/FixtureBroker/main.swift:80` now requires zero unresolved debt and zero active admissions before emitting its successful 32/96-byte delivery receipt. The underlying frame-format and key custody behavior were not changed by this slice.

Read-only evidence checks verified every listed source hash (nine), every listed fixture binary hash (four), and the unchanged frozen format-evidence hash against `results/2026-10-12-lifecycle.json`.

Recorded evidence, not rerun here: timeout fixture exit 0, status 137 after kill with confirmed reap and zero debt; native wait elapsed 2.0022005 seconds, whole fixture elapsed 2.463770834 seconds. The separate full 32/96-byte delivery fixture exited 0 in 1.076174084 seconds with zero unresolved debt. Recorded Swift result is 29 tests / zero failures, including 15 injected native scenarios. The record keeps productionReady, realVM and actualKeychain false and includes the original absent `/usr/bin/sleep` preflight erratum.

This review reran only:

```sh
swift test --skip-build --package-path apple/Cowork/WinterCoworkKeyBroker --filter OwnedChildTests
```

Observed: **nine injected/pure ownership tests, zero failures**, including the 15-scenario native syscall double. The existing built test suite was used; this is not a fresh build or a repeat of either process fixture. No new native child fixture, VM, Keychain, live Winter home or daemon run occurred. The reviewed worktree remained clean; only this new review document was written in the root documentation checkout.

## Non-blocking scope limits

- The native C ABI's returned busy result is an operation refusal; the Swift owner prevents a concurrent caller from latching it as a successful reap. Direct concurrent C-handle consumers would need their own reviewed ownership contract.
- Debt is process-local and has no automatic/durable reconciliation; a future production helper must preserve appropriate custody and admission after restart.
- The pre-existing `ready()` helper at `native.c:187` retries interrupted poll calls with the original timeout, so an EINTR stream can extend pipe-read deadlines. This diff repairs native child wait/teardown attempts and does not establish a whole-broker I/O deadline. The recorded outer Python runner bound is separate evidence, not a production I/O guarantee.
