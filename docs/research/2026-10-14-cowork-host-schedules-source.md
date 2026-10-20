# Cowork host schedule authority — source slice, 2026-10-14

Base: `f60298bb90efe103a54265a1f7dca8518a61f891` on
`cowork/output-integration`. Implementation branch:
`cowork/workspace-schedule-authority` in workspace worktree
`.worktrees/workspace-schedule-authority`.

This is metadata/timer authority implementation. It is not guest execution,
worker admission, SDK publication, VM wakeup proof or production activation.
Native two-disk admission and egress holds remain unchanged.

## Implemented

- Protected runtime-state schema12 adds canonical schedules and occurrences.
  Existing source/home/workspace authority is preserved. Empty-authority
  downgrades include the new tables; populated authority is refused.
- A schedule explicitly names its workspace plus existing conversation or fresh
  Project-conversation intent, source, one-shot/recurring timing, saved timezone,
  policy, capability ceiling, overlap policy and optional branch precondition.
  It accepts no guest cwd, host path, reusable credential or runtime manifest.
- Host acceptance uses content-bound request replay, current canonical target
  ownership, current source grants and capability intersection. Policies are
  compared exactly, never ranked. Bypass is saved unchanged when currently
  authorized. Later policy mismatch blocks until an explicitly designed update.
- Occurrences are materialized before execution. SQLite immediate transactions
  and partial unique indexes enforce one active plus one coalesced pending per
  job, with visible missed counts and stable occurrence identity. A second
  independent DB handle cannot claim the same occurrence twice.
- Host-owner recovery returns a pre-dispatch claim to pending and merges its
  coalesced pending interval. Dispatching state becomes uncertain/recovery-required;
  it cannot be replayed or marked handled by a stale claim. One-shots have no
  implicit expiry and stay pending until handled or cancelled.
- Saved IANA timezone cron uses the existing routine grammar without changing
  historical Code's local-time semantics; DST gaps/folds are tested.
- The existing daemon routine timer drives metadata ticks, including with no
  provider or guest. Cowork metadata tick failure does not stop ordinary Code
  routines. beginShutdown closes new Cowork claims and materialization before
  daemon drain. Recovery runs only at owning daemon startup.
- Local `workspace.schedule.create/list/cancel/status` RPCs and strict CLI routes
  read and mutate the same records. Reads are paged/bounded; status says
  `execution: unavailable`. Four existing paired remote allowlist mirrors remain
  unchanged/deny these methods and are pinned by a negative source parity test.

## Explicitly deferred

The source tick never creates a host Code session, calls the Code routine runner,
claims a successful wakeup or launches a guest. `beginDispatch` always refuses
with typed `unsupported_topology`. Due work stays `pending` with a typed reason
(`execution_unavailable`, archive, source/grant refusal or branch mismatch/missing
admitted branch reader). Tests that exercise the post-dispatch crash window
explicitly inject that future state into SQLite; they perform no dispatch.

The admitted guest Cron/ScheduleWakeup bridge, protected execution owner,
authenticated query dispatch, actual fresh Project conversation creation,
current branch reader, automated-turn protection, approval/E2E behavior and
uncertain external-effect recovery remain required production work. Schedule
metadata does not provide VM power, source mount or tool authority. Paired
scheduling administration and unattended paired-principal scope retention are
also deferred; local metadata is the deliberate initial surface. No Swift
schedule/client surface or native execution is claimed by this slice.

## Validation

All tests use disposable homes, injected clocks/coordination, no provider and
FileSecretStore for daemon credentials. Existing test preload isolates the
Keychain service identity; no live Winter home, daemon, app, native worker, VM,
GUI, production credentials or signing/release process was used.

Executed from the worktree root:

```sh
bun test ./packages/core/test/cowork/schedules.test.ts ./packages/core/test/ipc/cowork-schedules.test.ts ./packages/core/test/routines/store.test.ts ./packages/core/test/routines/scheduler.test.ts ./packages/core/test/routines/runner.test.ts ./packages/core/test/cowork/repository.test.ts ./packages/core/test/cowork/folder-grants.test.ts ./packages/core/test/runtime-state/db.test.ts ./packages/core/test/runtime-state/db-run-folder.test.ts ./packages/core/test/ipc/cowork-workspace-api.test.ts ./packages/core/test/ipc/remote-allowlist-parity.test.ts ./packages/cli/test/cowork-cli.test.ts
pnpm typecheck:core
pnpm typecheck:protocol
pnpm typecheck:cli
git diff --check
```

Final result: **154 pass, 0 fail; 1364 assertions across 12 files**. Core,
protocol and CLI typechecks exit0. Diff whitespace check passes.

The new schedule files have 14 tests: duplicate independent-handle claims;
pre/post-dispatch restart; missed coalescing; one-shot retention; current grants,
source revocation, archived workspace/conversation, branch mismatch, narrower
saved/current ceilings, policy change, standalone identity, bypass preservation,
schema11 upgrade, shutdown, unavailable execution, no Code fallback, real isolated
daemon UnixRPC restart and remote exclusion. Existing routine regressions include
Cowork tick failure leaving Code routine behavior intact.
