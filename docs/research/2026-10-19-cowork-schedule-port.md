# Cowork schedule dispatch port over the session door, 2026-10-19

Branch `cowork/schedule-port`, stacked on the session door spine (`cowork/session-door-d1`). SOURCE ONLY: the module is
imported by no `src/` file, no production code constructs it, `CoworkSchedules` is still built without a port (so
`beginDispatch` refuses `unsupported_topology` and `workspace.schedule.status` says `execution: "unavailable"`), and
`session.create {mode: "cowork"}` still answers `unsupported_topology` because no door is passed to `startIpcServer`.

## What it is

`packages/core/src/cowork/schedule-door-port.ts` exports `createCoworkScheduleDoorPort({ door, scope, caller })`, a
`CoworkScheduleDispatchPort`. The door is typed as a structural slice, `CoworkScheduleDoor` (`create`, plus the drivers' `get`
and `ensure`); the real door satisfies it, and the slice keeps the door's own type name out of this module (the door lane's
source pin).

One occurrence is one prompt delivered to one conversation:

- conversation target: `drivers.get(sessionId) ?? await drivers.ensure(sessionId)`, then `send(prompt, "schedule")`;
- Project target: `door.create` under `requestId = "schedule:<occurrenceId>"`, then ensure, then send. The request id is
  per occurrence, so a retry after a refusal replays the same create (the door's idempotency is its own contract).
- the send is accepted, not awaited: the turn is not waited for, and `queued: true` is accepted too. The host keeps the occurrence
  `dispatching` until its owner calls `handled(receipt)` or `uncertain`.

## Outcome map (the host reads a THROW as uncertain, so the port returns every answer)

| Door outcome | Port answer | Durable result |
| --- | --- | --- |
| send accepted | `started`, `runRef` = the conversation's session id | `dispatching`, receipt minted |
| `provider_unavailable`, `conversation_limit`, `cold_resume_unavailable`, `unsupported_topology`, `authority_denied`, `source_unavailable`, `not_found` from create, get/ensure or send | `not-started` | `pending` / `execution_unavailable`, token cleared |
| `recovery_required`, any other `CoworkError`, a plain `Error`, a non-error throw, a malformed session | `uncertain` | `uncertain` / `recovery_required`, never replayed |
| a session id outside the host's run-reference shape | `not-started`, BEFORE any send | `pending` |

## REVIEW NEEDED

1. **The definite-refusal set is an allowlist.** Everything outside it is uncertain, including a failure BEFORE the send
   (a plain error from `ensure`), because the port cannot prove what the door did. Recommend: keep. The cost is a stuck slot
   after an odd door error until a recovery path exists (none in this slice).
2. **The caller identity.** `door.create` authorizes against a connection; the schedule path has no connection. The caller is
   injected (`deps.caller`) and never built from a schedule's content. Which host-internal principal the door accepts for an
   unattended create is the DOOR lane's call (NEEDS FROM OTHER LANE: a documented host-internal caller, or a
   `door.createForSchedule`).
3. **The effective ceiling is not enforced by this port.** `input.effective` (current grants intersect the saved ceiling)
   is not handed to the door: a fresh conversation takes the workspace's own ceiling and default policy (a schedule's saved policy
   was already required to equal it at creation). Narrowing a conversation below the workspace needs a door parameter.
4. **Automated-turn protection** is only the client name `"schedule"`; the protection itself belongs to the driver.
5. **No timeout** on `send`; a hung door leaves `dispatching` until `recover()`.

## Pin

`schedules.test.ts` now lets exactly one more module name the boundary types: this one (the single implementation, as a
factory returning an object literal). Driver verbs (`beginDispatch`, `.handled(`, `.uncertain(`) stay owner-only, and
`schedule-door-port.test.ts` proves no `src/` file imports or names the module, that it imports only `./types` at runtime,
and that it never touches the owner, `Bun.`, `node:` or `process.env`.

## Validation

`schedule-door-port.test.ts` drives the real `CoworkSchedules` state machine with a fake door: the full path for both targets,
every definite code at each of create, ensure and send, the uncertain matrix, retry with the same create request id, and
no-port behaviour. No guest, VM, provider, app or daemon was involved.
