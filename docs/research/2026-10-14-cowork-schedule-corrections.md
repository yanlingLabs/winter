# Cowork schedule review corrections — source, 2026-10-14

The reviewed schedule prerequisite `ecf14b3fe01ebef9820c65741e22709c9574af2c`
remains frozen. Corrections were first developed as an uncommitted patch in
`.worktrees/workspace-schedule-corrections` (patch SHA256
`061827f5c618dd67475e83fcd84f450fa169d4e48ff7da152755f1f68c394f41`).
That intermediate 12→14 schema was never frozen, promoted or activated.

Final source composition is `.worktrees/workspace-schedule-composition14`, branch
`cowork/workspace-schedule-composition14`, based on guidance commit
`b0f83df0bb96b53e37ad32ef3a6769b8de4509e6`, tree
`f54fbbf47934a72b938dd4e4f65f6f4142eed55e`. That base already contains schedule12,
outbox delivery and the reviewed host-file primitive. The final migration list
contains the real canonical guidance13 followed by additive quarantine14; no
migration slot is invented or skipped. The guidance service/SQLite helper's whole
source review remains independently pending; this composition does not admit it
for activation.

## Review dispositions

- **S1:** Cron now advances beyond the previous local date/hour/minute tuple.
  Daily `30 1 * * *` in New York fires at the first 01:30 and next on the next day,
  never again at the repeated 01:30. Each-minute and quarter-hour patterns preserve
  their normal sequence before the fold and skip only previously represented
  wall tuples after the fold. Spring gaps still skip nonexistent minutes.
- **S2:** Each due schedule has an independent immediate transaction, with a
  current-row recheck after the due snapshot. Invalid JSON, closed schema/spec,
  timezone or calendar definition is durably quarantined with closed reason
  `invalid_schedule`, preserving the original bytes. Other schedules advance.
  A safe quarantine DTO carries identity/revision/reason without the invalid
  definition; status/list/cancel remain usable. Quarantine prevents new claims.
  Storage errors are not reclassified as invalid schedule data.
- **S3:** Recovery's merge now spells out
  `claimed.missed_count + pending.missed_count + 1`. The original SQL `+=`
  already retained the claimed count; the explicit expression and new nonzero
  counts on both records make that invariant independently checkable.
- **S4:** Host creation admits at most 100 canonical schedule records per
  workspace, including retained cancelled records; exact accepted retries do
  not consume capacity. New schedules above the bound return `schedule_limit`.
  Sparse cron skips nonmatching calendar months/days, rejects impossible
  month/day combinations before any timezone-format scan, and caps each search
  at 4096 formatter evaluations. The longest Gregorian leap-century gap fixture
  resolves with fewer than 1000 evaluations. Negative tests cover backward clock,
  invalid timezone, interval overflow, oversized metadata, invalid cursor and
  actual second-handle cancellation after the due snapshot.
- **S5:** The daemon has no admitted branch provider. Branch-sensitive schedules
  continue to return `branch_state_unavailable`; the source-only injected branch
  mismatch tests do not prove a guest branch reader. This remains named follow-up.
- **S6:** Schedule metadata remains local-only. Actual service tests reject
  local-principal-on-remote, paired-principal-on-harness and paired remote calls,
  even with workspace scope. The internal host recheck principal does not extend
  the paired lane. Paired administration/unattended authority needs its own
  admitted scope/credential design and all four mirror updates.

`beginDispatch` still always returns typed `unsupported_topology`. No native
execution, Code fallback, guest wakeup, fresh conversation or successful dispatch
receipt was added. Pending and uncertain effects retain their earlier semantics.

## Verification

Final composition checks, with disposable homes, isolated coordination/clocks,
FileSecretStore and no provider:

```sh
bun test ./packages/core/test/cowork/schedules.test.ts ./packages/core/test/ipc/cowork-schedules.test.ts ./packages/core/test/routines/store.test.ts ./packages/core/test/routines/scheduler.test.ts ./packages/core/test/routines/runner.test.ts ./packages/core/test/cowork/repository.test.ts ./packages/core/test/cowork/folder-grants.test.ts ./packages/core/test/runtime-state/db.test.ts ./packages/core/test/runtime-state/db-run-folder.test.ts ./packages/core/test/ipc/cowork-workspace-api.test.ts ./packages/core/test/ipc/remote-allowlist-parity.test.ts ./packages/cli/test/cowork-cli.test.ts ./packages/core/test/cowork/instructions.test.ts ./packages/core/test/cowork/durable-transaction.test.ts ./packages/core/test/ipc/cowork-instructions.test.ts
pnpm typecheck:core
pnpm typecheck:protocol
pnpm typecheck:cli
git diff --check
```

**170 pass, 7 skip, 0 fail; 1474 assertions across 15 files.** The seven native
instruction filesystem tests remain gated/skipped; their native behavior is not
claimed by this validation. All three typechecks exit0. The scheduling-specific
source tests include actual SQLite independent handles and real isolated daemon
UnixRPC; the RPC poison test verifies durable safe quarantine across restart while
healthy timers advance, without exposing the invalid payload.

No live Winter home/app/daemon, real credentials, native helper, GUI, VM, signing,
release, SDK pin, push, PR or production activation was used. Native egress and
Mac two-disk holds remain intact. This document records source/test evidence;
independent review of this exact composition and guidance13 remains required
before any PR promotion or activation.
