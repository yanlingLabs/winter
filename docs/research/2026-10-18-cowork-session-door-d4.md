# Cowork session door D4a: durable, idempotent create and the schedule caller

Status: draft PR, stacked on D3 (#101) and APPROVALS (#84, merged into integration). Nothing here makes a Cowork session creatable or runnable in production. `createCoworkSessionDoor` exists, and nothing in `src` calls it. `startIpcServer` routes `session.create {mode: "cowork"}` to a door only when one is passed, and no production caller passes one. With no provider route, native starter, runtime offer or approval port, every create refuses `provider_unavailable` before anything is written. Production injects none of them.

D4 is split in two:

- **D4a (this PR):** the reservation, create, the schedule caller, the pins and the reader audit. The schedule lane (#90) waits only on this part.
- **D4b (stacked on D4a, section below):** IPC routing of stored Cowork rows to the door's drivers, the `session.list` `cowork` field, the CLI, `provisioning.admit`/`available` with truthful capabilities, and the `mode: "cowork"` approvals adapter.

## What D4a adds

| Module | Role |
|---|---|
| `cowork/session-door.ts` | `createCoworkSessionDoor`, the ONE implementation of `CoworkSessionDoor`, composing D3's driver table. `COWORK_SCHEDULE_CALLER` and `coworkScheduleDispatchView`. |
| `cowork/schema.ts`, `runtime-state/db.ts` | Migration 19 `cowork_session_reservations`. `RUNTIME_STATE_SCHEMA_VERSION` is 19, and both downgrade ladders accept v19. |
| `cowork/repository.ts` | `reserveConversation`, `completeReservation`, `withdrawReservation` and `isReservedSession`. A standalone `owner_id` is minted as `s_<12 hex>` (design G7). A bind admits a `preparing` source. |
| `sessions/store.ts` | `ensureCoworkSession` and `withdrawCoworkSession`. The reaper, the cleaner and `deleteSession` leave a Cowork row alone. |

## Create, in order, each step resumable

1. **Ports.** A missing route, starter, offer or approval port refuses `provider_unavailable`. Nothing is written.
2. **Shape.** Scope, ids and cwd are checked. An outputs location is `unsupported_topology` until D3b.
3. **Authority.** The caller is either a local user over a harness or admin connection with member authority, or the schedule caller (below). Every other caller is `authority_denied`, including remote, plugin, paired (even in scope) and runtime callers.
4. **Reserve.** In one runtime-state transaction, a row keyed by (principal, workspace, requestId) holds the session id, the scope and a digest of `{scope, workspaceId, location}`.
   - The same request again finds that row.
   - The same requestId with different content is `request_conflict`.
   - A standalone workspace reserves its `owner_id`. A second request for it is `conversation_limit`. A non-Cowork store row holding that id is `authority_denied` and is never adopted.
   - A Project reserves a fresh `s_<12 hex>` that no reservation, binding or session-store row holds.
5. **Store row** (`ensureCoworkSession`), created or found:
   - No row: it is admitted only for a reserved id.
   - A row that is not a Cowork row of this scope: `authority_denied`.
   - A row whose `session_created` never landed (`last_seq` 0, no log lines; `recoverAll` keeps such a row): the append runs now, once.
   - A log with lines but `last_seq` 0: `recovery_required`.
   - The row has `cwd` NULL and `dirs` `[]`. `session_created` carries `mode: "cowork"` and the display facts `{workspaceId, projectId, location, sourceId, policyRevision}`. Those facts are read from the same workspace the reservation saw, so a later policy change can leave them stale. They are display only: the binding is authority.
6. **Bind.**
   - A binding already present is found first (`boundHere`), and must match the request's workspace, source and cwd, or the answer is `request_conflict`. It is never replayed through `bindConversation`'s own idempotency key. That key's digest carries `expectedRevision`, which a landed bind has since advanced, so a replay would answer `request_conflict` for a landed bind.
   - Otherwise `bindConversation` runs. If it throws and nothing is bound, the failure is DEFINITE: the store row is withdrawn, THEN the reservation. A crash between the two leaves a pending reservation, which resumes. The request then starts over cleanly, and a standalone workspace is never stuck behind a dead reservation.
   - A non-`CoworkError` throw keeps the reservation pending.
7. **Complete.** The reservation is marked `bound` (idempotent, and only for a bound session of that workspace).

**Races.**
- The body has no await, so two creates in this process never interleave.
- Every step finds what another wrote, so even interleaved creates of one request mint one conversation. The mutant that inserts awaits survives the race test, which is the evidence for this.

**Tests** (`session-door.test.ts`):
- For both Project and standalone, a crash after each step resumes with the same id and no second row:
  - (a) reserved only;
  - (b) store row committed, no binding;
  - (c) INSERT landed but `session_created` did not;
  - (d) bound, but the reservation was never marked bound.
- Six concurrent creates of one request make one row.
- A definite refusal (a removed source) leaves no binding, row or reservation, and the retry is refused the same way.

## Bind admits a `preparing` source (owner decision O-D4-1, recommendation: accept)

A workspace is created stopped, and its sources become `ready` only when an incarnation acknowledges them. So a never-booted workspace has every source `preparing`, and the old `state !== "ready"` check refused every first create. That deadlocks: a guest boots only for a bound conversation.

The bind now admits `ready` or `preparing`, with `desired = 'present'`. A removed (`removing`), revoked (`unavailable`) or detached source still refuses `source_unavailable`, which a new repository test pins.

This grants nothing. At `mounted`, before any conversation set exists, the driver calls `authority.requireSource`, which demands that the source is `ready` and acknowledged at its current revision by THAT incarnation (`ackIncarnationId === workspace.incarnationId`). The old pin in `repository.test.ts` ("early" bind refuses `source_unavailable`) was changed in the open to the new rule.

I did not check what S7B's real stop path leaves in source state. The fixture stops by setting power directly, and nothing in D4a depends on it.

## The schedule caller (#90's NEED 1)

`COWORK_SCHEDULE_CALLER` is a frozen `CoworkConnection` (`{role: "host-schedule", connectionId: -1}`).

**Authority is by reference identity only.**
- The door checks `caller === COWORK_SCHEDULE_CALLER` before anything else, and `host.principal` is never consulted for it.
- A wire caller is always a fresh object literal the server builds per request. A pin fixes `ipc/server.ts`'s one `door.create` call to that literal.
- A look-alike object with the same fields is an ordinary connection with a role no user has, and is refused before any principal lookup.

**Its whole authority** (each clause pinned by a test and a killed mutant):
- the request id is `schedule:<occurrenceId>`, and the bare occurrence id is refused;
- an ENABLED schedule of THIS workspace has that occurrence in `dispatching` at this instant;
- that schedule targets the Project (a conversation target needs no create);
- the workspace is a Project;
- the location is the schedule's own source at its root (no `relativeCwd`).

Any failure to establish the window, including an unknown workspace, is the same `authority_denied`, so there is no oracle. Its reservations are keyed by the fixed principal id `host:schedule`.

**The id grammar.** The repository caps a request id at 200 characters, so an occurrence id fits only up to 191. Today's occurrence ids are `occurrence_<uuid>` (47 characters).

**Idempotency is limited to the dispatch window.** A replay of an existing reservation re-runs the authority check, so once the occurrence is handled (or released, or uncertain) even the same request is refused. That is right for the port, which creates only inside `beginDispatch`. #90 should know it.

**How the occurrence is read.** `coworkScheduleDispatchView` reads through the schedule service's public `list`/`status`, never its tables. `status` lists a schedule's 100 newest occurrences, and a dispatching one is its newest active one. It scans at most 100 pages of schedules.

**#90's NEED 2 (idempotent on requestId)** is met and pinned: "idempotent on requestId" and the end-to-end dispatch test through the real `createCoworkScheduleDoorPort` and `CoworkSchedules`.

**#90's optional `effective` ceiling** is NOT done. It is listed below. A schedule's effective ceiling (`schedules.effective`) is narrower than the workspace ceiling the binding records, and narrowing a binding's `restrictions` at create needs a binding-input change, which is not small.

## Migration 19

```
cowork_session_reservations(principal_id, workspace_id → cowork_workspaces, request_id, request_digest (64 hex),
  session_id UNIQUE CHECK(s_ + 12 lowercase hex), scope, state CHECK(pending|bound), created_at,
  PRIMARY KEY(principal_id, workspace_id, request_id))
```

- It is in `COWORK_TABLES`, before `cowork_workspaces` in drop order, so a populated table refuses both downgrades. A test proves a single reservation alone refuses them.
- The version pins in other lanes' tests (`peer-inbox-sqlite`, `storage-lifecycle`, `outputs`, `instructions`) and in `session-binding-schema` moved from 18 to 19. Each "newer than current" probe moved to 20. These are pin edits in other lanes' test files, reported for acceptance.

## Reader audit (cowork rows)

| Reader | Finding |
|---|---|
| Empty-session reaper (`emptySessionIds`), cleaner (`cleanerCandidateIds`) | Both would have taken a Cowork row (it has no main-thread message until its first turn). Both now exclude `mode = 'cowork'`. A test uses an empty Code row as the control. |
| `deleteSession` (user delete, reaper, cleaner) | Refuses a Cowork row (`unsupported_topology`). Deleting it would orphan the binding. The Cowork delete slice owns both halves. |
| Remote (`assertRemoteMayUseSession`, `session.list` remote filter, `sync`) | `cowork` is outside `REMOTE_ELIGIBLE_SESSION_MODES`, which already refuses it (`remote-chat-gate.test.ts` has the synthetic row). |
| `ListSessions`, `SendMessage` | Already Cowork-aware: no cwd, transcript or first message, and peers go through the peer inbox. |
| `recoverAll` pass-2 rebuild | Restores `mode` from `session_created`, so a rebuilt index still knows the row is Cowork. A logless `last_seq = 0` row is kept, and `ensureCoworkSession` resumes it. |
| `session.list`'s `cowork` field | D4b: derived from `cowork_conversations`. |
| The six `isUnrunnableStoredMode` refusal sites in `ipc/server.ts` | Unchanged (setPolicy, setModel, setEffort, workflow list/run and the record-less send refusal). D4b routes send, steer, interrupt and compact ahead of them, only with a door. |

## Pins

- `createCoworkSessionDoor` is named only by `session-door.ts` in `src`.
- `createCoworkSessionDrivers` is named by `session-driver.ts` and the door alone.
- No `src` module but the door names `CoworkSessionDoor` beyond the existing three.
- The reservation writers (`reserveConversation`, `completeReservation`, `withdrawReservation`, `isReservedSession`) and the Cowork-row writers (`ensureCoworkSession`, `withdrawCoworkSession`) are called only from `session-door.ts`.
- `COWORK_SCHEDULE_CALLER` is named only there.
- `daemon.ts` still only passes the option through. `createSession` still refuses `mode: "cowork"`.

## Mutations

42/44 killed (`door/d4a_mutations.py`). The two survivors are equivalent:
- **The await-inserting mutant:** create is race-safe even interleaved, as described above.
- **Dropping `desired === "present"` at bind:** every path that sets `desired = 'removed'` also sets `state = 'removing'`, which the state check refuses. It is kept as defense in depth.

## NEEDS FROM OTHER LANE

1. **Schedule lane (#90):** a direct reader `occurrence(workspaceId, occurrenceId)` returning `{state, scheduleId}`, so the dispatch view need not scan `list`/`status`. Not blocking.
2. **Schedule lane (#90):** note that the door's idempotency holds within the dispatch window (above).
3. **S7B, D6 composition (the flip, owner's word).** It must:
   - pass `COWORK_SCHEDULE_CALLER` to `createCoworkScheduleDoorPort` and `coworkScheduleDispatchView(schedules)` to the door;
   - build the door's approval port with `coworkApprovalPort({approvals, questions, gate, ...})`;
   - set `CoworkHostPorts.execution` beside the door it passes.
4. **S7B: confirm the port shape and the boot call (D4c made the post-COMMIT call; the coordinator asked S7B to match its reporting).**
   - `provision(workspaceId, operationId)` must be idempotent per operation.
   - Its `{status: "failed"}` concludes the creation `failed`. `applied` leaves the operation pending until the guest acknowledges the sources.
   - A throw is uncertain and is retried.
   - The host that supplies the port calls `CoworkWorkspaceService.resumeProvisioning()` once at boot.
   - Until both sides land, the pin stays: no production host supplies `provisioning`.

## Owner decisions

- **O-D4-1:** bind admits a `preparing` source (above). Recommendation: accept.
- **O-D4-2:** a definite bind refusal withdraws the row and the reservation (the request starts over) instead of keeping a refused-with-code reservation. Recommendation: accept. It keeps a standalone workspace from being stuck, and a retry is refused the same way while the cause lasts.
- **O-D4-3:** the schedule caller's idempotency is window-scoped. Recommendation: accept, since the port only creates inside `beginDispatch`.
- **O-D4-4:** the CLI lives under `winter workspace session create|list` instead of the design's `winter cowork session …`. Recommendation: accept. `workspace` and `project` are the existing Cowork CLI surface, there is no `cowork` verb, and adding one would split the Cowork commands across two roots.
- **O-D4-5:** a Cowork `session.steer` reaches only a live driver and never boots a guest, so `send` stays the one boot door. Recommendation: accept.

## Owed (listed, not done)

- The schedule `effective` ceiling on create (#90 optional).
- D4b items (top of this note). The LOWs from D3 still stand: duplicate JSON keys in sync lines, and the checked filter in `coworkToolsFor`.

## D4b: routing, list, CLI, provisioning, the approvals adapter

D4b is stacked on D4a. Nothing in it is reachable in production: each piece is reached only through a door or a port that no production caller passes.

| Piece | What it does |
|---|---|
| `ipc/server.ts` `coworkDriversOf` | Returns the door's driver table for a stored `cowork` row, and only when a door was passed. Without a door it returns undefined, and every Cowork answer stays exactly as before. The stored mode only routes: the drivers re-read the host binding, which is the authority, so a row with no binding is refused there. |
| `session.send` | Runs on `drivers.get ?? drivers.ensure`, after the same attachment check `hub.send` makes. Images and files were already refused as Code-only before any driver call. A driver refusal is the typed Cowork code. `send` is the ONE door that may start a guest. |
| `session.steer` | Reaches only a LIVE driver. With nothing live it answers `injected: false` and starts nothing, so a steer never boots a guest. It is in neither the remote nor the plugin method set. |
| `session.interrupt` | Asks only a live driver. Its typed `unsupported_topology` (D3 decision 2) reaches the client. With nothing live it answers `wasRunning: false` and starts nothing. |
| `session.compact` | Refuses `unsupported_topology` when a door exists (the host-query guest refuses slash text). |
| `session.list` | A Cowork row carries `cowork: {workspaceId, projectId}` from `cowork_conversations` (`CoworkRepository.conversationRef`), never from the log's display fact. If a row's reference cannot be read, that row lists without it, and the list itself still answers. Remote still never sees the row or reaches it (send, steer and interrupt are each refused). `sync.push` cannot create a Cowork row: a log it starts must begin with `session_created` `mode: "chat"`. |
| CLI | `winter workspace session create <workspaceId> --source ID [--cwd RELATIVE] --request-id ID [--json]` and `winter workspace session list <workspaceId> [--json]`. Parsing is strict, with no default request id. The create goes through `session.create {mode: "cowork"}` (scope `global`), which every production daemon refuses with `unsupported_topology`. List filters `session.list` by the row's workspace reference. The commands live under `workspace` (the existing Cowork surface) rather than a new `cowork` verb. |
| `cowork/service.ts` | When a host supplies S7B's `provisioning` port, `provisioning.admit` is the admission for creation and source additions, and it refuses while the port is unavailable. Otherwise the host's refusing `requireProvisioning` stays. `workspace.capabilities.get` reports `provisioning: provisioning.available()` and `execution: host.execution?.()`. Both are false on every production host. `provision()` is not called yet: it is owed with S7B's operation reporting. |
| Protocol | `CoworkCapabilities.provisioning` and `.execution` widen from `z.literal(false)` to `z.boolean()`. The Swift mirror already decodes `Bool`, and the Mac's `CoworkGate` already follows them. `protocol:generate` does not cover method results. |
| `coworkApprovalPort` (session-door.ts) | #84's 6-line adapter: `canUseToolFor({mode: "cowork", cowork: input.cowork, ...})`. The D3 driver suite now runs through it. The APPROVALS pin in `cowork-approval.test.ts` names it as the one other bridge constructor (pin edit for acceptance). |

D4b mutations: 24/25 killed (`door/d4b_mutations.py`). The one survivor, a fixed policy in the adapter, is equivalent: with `cowork` present the bridge returns from the Cowork matrix (step 1c) before `policyNow()` is ever read.

## D4c: provision after COMMIT

D4c is stacked on D4b. This is the coordinator's follow-up to the blocking NEED: `service.ts` now calls S7B's `provision(workspaceId, operationId)` itself. It runs only with the port, and no production host supplies one (pinned).

- **When.** After `workspace.create`/`project.create` commits, never inside the transaction. It runs one drive at a time per operation, and a replay or resume that arrives during a drive joins it.
- **`{status: "applied"}`.** Nothing is concluded. The operation stays `pending` until the guest acknowledges the sources, and the existing `acknowledgeSource` path concludes it `applied`.
- **`{status: "failed"}`.** `CoworkRepository.failCreationProvisioning` concludes the creation's operation `failed` (terminal), durably, with a `workspace_operation_changed {status: "failed", terminal: true}` (the same shape the instruction mutations already use). It applies only to a creation operation, and the port's reason text is never kept.
- **A throw, a rejection or a malformed answer.** These are UNCERTAIN. Nothing is concluded and the operation stays `pending`.
- **Recovery.** A replay of the same create re-drives a pending creation. `resumeProvisioning()` drives every pending creation (`pendingCreations()`, oldest first, bounded); it is the boot call for the host that supplies the port. A crash between COMMIT and `provision` therefore leaves a pending creation that the next boot or replay completes.
- **Tests.** `session-door-ipc.test.ts` "D4c" covers:
  - the call happens after COMMIT;
  - `applied` stays pending;
  - `failed` concludes and is announced, with no reason text kept;
  - uncertain answers stay pending, and resume and replay re-drive them;
  - one drive at a time;
  - with no port, nothing runs;
  - only a creation operation can fail this way.
- **Mutations.** 11/11 killed (`door/d4c_mutations.py`).

## Docs owed

- `docs/claude/cowork.md`: the door's create path and the schedule caller exist, unconstructed in production. Migration 19.
- `docs/cowork-status.md`: unchanged status. Still nothing is creatable or runnable.
