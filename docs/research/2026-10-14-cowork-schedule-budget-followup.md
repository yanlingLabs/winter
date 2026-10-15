# Cowork schedule review LOW follow-ups — source, 2026-10-14

The accepted source freeze `55c61cf63a5d1b0c46010219dd4aa61437c59288`
remains unchanged. This follow-up covers C1–C5 in a separate source composition;
final parent identity and verification are recorded below. Corrected guidance13
is source accepted at the exact identity below. Migration13 precedes quarantine14. No schedule execution, provider,
native helper, GUI, VM, push or activation is added.

## C1: live capacity and retained history

The 100-job workspace limit now counts enabled, non-quarantined schedules.
Cancelled/handled/quarantined records do not consume new scheduling capacity.
Terminal records retain their canonical IDs, occurrence history and exact request
replay, and remain readable through existing paged list/status. Cancellation frees
a live slot without deleting history. A separate explicit retention/deletion policy
is future work; no automatic history deletion or expiry is inferred from this cap.

## C2: read-only inspection boundary

The daemon schedule service expects its canonical read-write authority DB.
Metadata reads that encounter malformed definitions may persist quarantine;
therefore they are not a general read-only audit API. An already-quarantined row
has a safe projection, but a read-only inspector encountering a previously unknown
invalid row must treat it as unavailable rather than assume quarantine was durably
written. A distinct read-only audit surface remains a named follow-up. No SQLite
read-only failure is evidence that quarantine succeeded. An actual read-only
SQLite test confirms that the inspection refuses, writes no quarantine and
preserves the invalid definition bytes.

## C3–C4: one retryable calendar budget per pass

A reconcile pass shares a ceiling of 4096 formatter calls and 256 computed cron
successors across all jobs and catch-up occurrences. Limits injected by host-only
tests can narrow these ceilings but cannot increase them. Calendar calculations run
outside SQLite write transactions. Before committing, the immediate transaction
rechecks the exact current definition/cursor and enabled state, preventing a
concurrent cancellation or timer from committing duplicate accounting.

Each completed successor permits committing exactly one due occurrence. If the
shared budget ends after partial progress, the durable first-unprocessed cursor and
coalesced count are preserved. If no successor completes, the existing cursor is
unchanged for retry. Budget exhaustion has its own typed error,
`schedule_budget_exhausted`; it never becomes `invalid_schedule` quarantine.
Fresh passes naturally prioritize the oldest remaining durable cursors. Invalid
JSON/spec/timezone/calendar definitions remain a separate durable quarantine case.
Persisted interval overflow is validated before arithmetic, so it cannot become
NaN and surface as a global SQLite failure.

Tests prove that two jobs share one budget, formatter work never holds a write
transaction, capacity can be reused after cancellation while terminal history
remains, and 1000 eligible missed cron occurrences finish across bounded passes
and an independent DB reopen with no duplicate or lost counts.

## C5: spring-forward policy

Cron skips a nonexistent local date/hour/minute during spring-forward. It does not
shift that minute to the end of the gap. For example, New York daily `30 2 * * *`
has no occurrence on 2026-03-08; the next eligible occurrence is 2026-03-09 02:30
EDT. Nonexistent wall minutes do not add eligible-occurrence missed counts.
Fall-back still represents each eligible local date/hour/minute tuple at most
once. Interval schedules remain elapsed-time schedules and do not use this policy.

## Final source and verification

Final worktree: `.worktrees/workspace-schedule-final14`; branch
`cowork/workspace-schedule-final14`.

Accepted corrected guidance13:
`6ca56d24cad15f564e225f605170dccfd195cb81`, tree
`1e341a672d291e859b83c4d73bcf0b91795642a6` (parent `1764fd1d`).
Only the accepted schedule55 delta was applied on top, producing local prerequisite
`4766a694395ac451ef5dc8e74b3f07ba1a56fc1e`; the sole conflict retained the corrected
parent's platform-specific unavailable behavior and pinned the current schema14
expectation. This follow-up applies only the C1–C5 patch to that source. The
independent new outbox mandatory committed-session port and workspace-watch lane
are intentionally outside this composition; Root owns the later combined product
composition. The migration list remains real12, real13, then14.

Executed with fixture homes, isolated coordination/clocks, FileSecretStore and
no provider/native test flag:

```sh
bun test ./packages/core/test/cowork/schedules.test.ts ./packages/core/test/ipc/cowork-schedules.test.ts ./packages/core/test/routines/store.test.ts ./packages/core/test/routines/scheduler.test.ts ./packages/core/test/routines/runner.test.ts ./packages/core/test/cowork/repository.test.ts ./packages/core/test/cowork/folder-grants.test.ts ./packages/core/test/runtime-state/db.test.ts ./packages/core/test/runtime-state/db-run-folder.test.ts ./packages/core/test/ipc/cowork-workspace-api.test.ts ./packages/core/test/ipc/remote-allowlist-parity.test.ts ./packages/cli/test/cowork-cli.test.ts ./packages/core/test/cowork/instructions.test.ts ./packages/core/test/cowork/durable-transaction.test.ts ./packages/core/test/ipc/cowork-instructions.test.ts
pnpm typecheck:core
pnpm typecheck:protocol
pnpm typecheck:cli
git diff --check
git diff --cached --check
```

**177 pass, 13 skip, 0 fail; 1527 assertions across 15 files.** The thirteen native
guidance tests remain gated/skipped and are not execution evidence from this
validation. All three typechecks exit0. Whitespace checks pass. Scheduling-only
patch development checks separately passed 24 tests/136 assertions; the final
composition result above is the current evidence.

No live Winter home/app/daemon, real credentials, native helper, provider, GUI,
VM, signing, release, SDK pin, push or activation occurred. `beginDispatch` remains
`unsupported_topology`; no successful wakeup or Code fallback was introduced.
This exact follow-up source still needs its independent review before promotion.
