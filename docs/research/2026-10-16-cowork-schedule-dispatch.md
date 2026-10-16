# Cowork schedule dispatch boundary behind an injected port, 2026-10-16

Base: `f1dfbc23` on `cowork/output-integration`. Branch: `cowork/schedule-dispatch`.

This is the durable host state machine between a claimed schedule occurrence and
whatever will eventually execute it. It is not execution: nothing here creates a
conversation, boots a guest, wakes a VM, calls the Code routine runner or proves
that work ran. Production still constructs `CoworkSchedules` without a port, so
`beginDispatch` still refuses with `unsupported_topology` and
`workspace.schedule.status` still reports `execution: "unavailable"`.

## What changed

- `packages/core/src/cowork/schedule-dispatch.ts` (new, types only): the
  `CoworkScheduleDispatchPort` interface (`start(occurrence, token)`), its input,
  result and receipt types, and the host's outcome type. No runtime code, no
  implementation.
- `packages/core/src/cowork/schedules.ts`: an optional sixth constructor argument
  (the port), a real `beginDispatch`, a receipt-gated `handled`, a new `uncertain`
  transition, and `recover()` refactored onto a shared `release()` helper with
  identical behavior. No schema change, no new enum value, no new error code, no
  change to `tick()`, `claim()`, `cancel()`, `status()` or any RPC handler.
- `packages/core/test/cowork/schedules.test.ts`: the two raw-SQL boundary fakes are
  replaced by a counting fake port; 19 new tests (43 in the file, up from 24).

## State machine (existing columns and states only)

```
pending --claim--> claimed --beginDispatch--> dispatching --handled(receipt)--> handled
   ^                  |                          |  \--uncertain(token)-----------> uncertain
   |  (recover, or    |  (begin-time recheck     |  \--recover()/cancel()---------> uncertain
   |   blocked begin) |   refused)               |
   +------------------+--------------------------+ (port RETURNED not-started)
```

`beginDispatch(occurrenceId, token)`:

1. No port: throws `unsupported_topology` before reading or writing anything.
2. One immediate transaction: the occurrence must be `claimed` and the stored token
   must equal the presented one (else `request_conflict`, nothing written). The
   schedule must still be enabled and parseable. Then `blockedReason` is re-run in
   full (archive, current grants and policy, source revocation, branch
   precondition, shutdown). A refusal returns the claim to `pending`, clears the
   token, stores the reason and returns `{ status: "blocked", reason }` without
   calling the port. Otherwise the row flips `claimed -> dispatching` in that same
   transaction and the effective ceiling is computed there.
3. Outside any transaction the port's `start` runs. The fake port in the tests
   asserts the row was already `dispatching` with the claim token and that
   `db.inTransaction` was false at that instant.
4. The answer is classified exactly once, before any transaction, inside a
   try/catch: each field is read a single time and any throw while reading counts as
   untrustworthy, never as `not-started`, and the port's error text is neither kept
   nor returned. Then a short transaction settles it, always guarded on
   `state='dispatching' AND claim_token=?`:
   - a well-formed ack echoing the occurrence and token: the row stays
     `dispatching`, the host mints a frozen receipt and returns `started`;
   - the port RETURNED `{ kind: "not-started" }`: back to
     `pending`/`execution_unavailable` (token cleared, any coalesced pending folded
     in), `not-started`. This is the only answer that reaches `pending`;
   - the port threw or rejected, answered `{ kind: "uncertain" }`, or the answer is
     malformed, hostile (a throwing getter or proxy trap) or echoes the wrong
     occurrence or token: `uncertain`/`recovery_required`;
   - the row is no longer `dispatching` (cancel or recovery got there first):
     nothing is touched, `uncertain` is returned.

`handled(occurrenceId, token, receipt)` requires the receipt this very instance
minted for this very claim (private WeakMap, single use) and the row still being
`dispatching` with that token. A one-shot schedule becomes `handled` only through
this path. `uncertain(occurrenceId, token)` lets the execution owner report that it
can no longer vouch for dispatching work. `recover()` is unchanged in effect:
`claimed -> pending` with the coalesced interval folded, `dispatching ->
uncertain`; it never replays.

## Crash windows

| Window | Durable state afterwards | Outcome |
| --- | --- | --- |
| after claim, before begin | `claimed`; recovery returns it to `pending` | old token dead, a fresh claim may dispatch, port called once |
| after begin, port in flight | `dispatching`; recovery makes it `uncertain` | a late ack changes nothing, port never called again |
| after the port ack, before `handled` | `dispatching`; recovery makes it `uncertain` | the receipt is refused, a one-shot stays `enabled` |
| port returns `not-started` | `pending`, `execution_unavailable`, token cleared | retry needs a new claim and token |
| port throws or rejects | `uncertain`, `recovery_required`, token spent | never replayed; the error text is not kept |
| any answer after a cancel | stays `uncertain` | never clobbered back to `pending` |

## REVIEW NEEDED

1. **The safe direction is structural.** Coordinator ruling: only a returned
   `{ kind: "not-started" }` returns the occurrence to `pending`. A throw or
   rejection, `{ kind: "uncertain" }`, and any malformed or mismatched ack are
   `uncertain`/`recovery_required` and never replayed, because an effect may exist.
   A port that knows nothing launched must say so by returning `not-started`, never
   by throwing. (An earlier revision of this slice read a throw as "nothing
   launched", which depended on a doc-comment promise; that was reversed.) Costs: a
   transient start failure that surfaces as an exception needs recovery, and the
   host cannot tell a port bug from a real launch.
2. **What "handled" means.** The receipt is the port's start acknowledgement.
   `handled` is a separate call so the crash window between them is real. Until it
   is called the occurrence stays `dispatching` and holds the job's single active
   slot (the `cowork_schedule_active` index), which is what keeps overlap at "one
   active plus one coalesced pending". Whether the future execution owner calls
   `handled` at start-ack or at turn completion is not decided here. If it is at
   completion, any daemon restart during a long run yields `uncertain`, by design.
3. **The receipt is not persisted** (no column exists and none was added). It is an
   in-memory, per-instance proof, so after a restart or on a second handle
   `handled` is impossible and recovery is the only path. That is the intended
   "never replay, never silently complete" behavior, but it is a constraint on the
   future owner: it must hold the receipt from `beginDispatch`.
4. **Signature changes, and the mixed sync/async shape is deliberate.**
   `beginDispatch` returns `Promise<CoworkScheduleDispatchOutcome>` (was `never`).
   Chosen: keep it MIXED. Every precondition failure (`unsupported_topology` with
   no port, `request_conflict` for an unknown, reused or wrong-token claim) still
   throws SYNCHRONOUSLY, before any write, so the pre-existing contract is
   unchanged; only the port wait is asynchronous. The returned promise settles to
   an outcome and rejects only on a store failure, which leaves the row
   `dispatching` for `recover()` to mark uncertain. A caller therefore needs
   `try { await beginDispatch(...) }`, not a bare `.then()` chain. This is written
   in the method's doc comment. `handled` gained a required third parameter.
   Nothing in `src/` calls either.
5. **Type-only import.** The rule that nothing in `src/` imports a new module is
   bent in one place: `schedules.ts` has a single `import type` from
   `schedule-dispatch.ts`, erased at runtime, because the constructor must name the
   port type. The module itself has no runtime code.
6. **No auto-dispatch and no timeout.** `tick()` still only materializes
   occurrences and records reasons; nothing drives claim -> dispatch. The reason
   `execution_unavailable` is still the "not blocked" sentinel, so with a port a
   dispatchable pending occurrence reads `execution_unavailable` too. `start` has
   no timeout here; a hung port leaves `dispatching` until `recover()`.
7. **`handled` and `uncertain` are unreachable in production, on purpose, and an
   uncertain one-shot stays `enabled`.** Nothing in
   `src/` calls them, and without a port no receipt can be minted, so `handled`
   always refuses. That is a delta from before, when the two-argument `handled` was
   callable on any `dispatching` row (reachable only through raw SQL in tests). An
   occurrence made `uncertain` (by a throw, recovery, cancellation or the owner)
   leaves a one-shot schedule `enabled` and keeps the job's active slot until a
   recovery path, which does not exist in this slice, resolves it: it is neither
   retried nor marked handled.
8. **The construction pin reads the syntax tree.** The anti-wiring test parses every
   `src/` file with the TypeScript compiler API (`typescript` is a root dev
   dependency) and, for every `new CoworkSchedules(...)` (parenthesized or cast
   included), fails if the argument count reaches the port's parameter index (read
   from the constructor declaration itself) or any argument is a spread. It also
   fails on any other use of the class name outside an import, a type position or a
   `new` (an alias, an `extends`, `Reflect.construct`, a namespace member, an
   `import { CoworkSchedules as X }`). Comments, string and template literals and
   line breaks cannot fool it, and it asserts nothing about where the port parameter
   sits, so another lane may append or insert constructor parameters. The REAL
   backstop is the set of text bans: outside `schedules.ts` and the types module no
   `src/` file may mention the port types, the module path, `beginDispatch`,
   `.handled(` or `.uncertain(`; without a driver calling those, an injected port
   dispatches nothing whatever the construction looks like. Known and accepted: a
   setter-style assignment to the private `port` field of a constructed instance
   (via a cast) names none of the banned things and is not caught by the AST scan;
   it too could dispatch nothing without a banned call.
9. **Anti-wiring pin location.** The pin is a new test in `schedules.test.ts`
   rather than an edit to the two existing pin tests, to avoid cross-lane conflicts.

## Tests and mutation checks

`bun test test/cowork` from `packages/core`: see the PR for the final count;
`schedules.test.ts` has 43 tests. `bun run typecheck` exits 0.

Mutations were applied one at a time, the schedule test file (or only the pin test,
for the `P` rows) run, and the source restored. The script is kept in the lane
scratch folder, not committed.

| Mutation | Result |
| --- | --- |
| skip the begin-time `blockedReason` recheck | killed |
| skip the claim-token compare | killed |
| begin skips the quarantine check | killed (quarantine-after-claim test) |
| `handled` skips the `dispatching` state check | killed |
| `handled` skips the receipt | killed |
| a port THROW goes back to `pending` (with and without the `dispatching` guard) | killed |
| an uncertain or malformed answer is accepted as started | killed |
| `{ kind: "uncertain" }` treated as started | killed (uncertain answer carrying a valid receipt) |
| `kind` matched case-insensitively | killed (`"STARTED"`) |
| any non-started answer treated as `not-started` | killed |
| run reference, token echo or occurrence echo unchecked | killed (three mutations) |
| the `not-started` path skips the `dispatching` guard | killed |
| `release` does not fold the pending interval | killed |
| the answer is read unguarded INSIDE the settle transaction (the original defect) | killed (throwing-getter answers) |
| pin: a 6th argument, multi-line with comments, apostrophes in comments, a template literal with a paren, a variable named `port` | killed |
| pin: a spread of a 6-element tuple, a spread of a short array, a spread with the plain call kept | killed |
| pin: subclass `super(...)`, alias, `Reflect.construct`, `new (CoworkSchedules)(...)`, a cast, an import alias, a namespace member | killed |
| pin: the port type imported into `service.ts` | killed |
| pin: another lane appends a 7th constructor parameter after the port | not tripped (expected) |
| pin: another lane inserts a parameter before the port, or adds a 4th argument in `service.ts` | not tripped (expected) |
| pin: setter-style `port` assignment via a cast | not caught, by design (see note 8) |

## Still deferred

The admitted guest Cron/ScheduleWakeup bridge, the protected execution owner,
authenticated query dispatch, real fresh Project-conversation creation, the
production branch reader, automated-turn protection, approval and end-to-end
behavior, and uncertain external-effect reconciliation UI all remain required
production work. The native two-disk admission and egress holds are untouched.
