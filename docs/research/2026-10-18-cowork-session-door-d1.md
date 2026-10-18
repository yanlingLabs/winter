# Cowork session door, D1: the spine (unwired)

Slice D1 of [the session door design](2026-10-18-cowork-session-door-design.md) (sections 6 and 7). It lands the wire fields, the ports the other lanes build against, migration 18, and the test that proves the door is off. Nothing here makes a Cowork session creatable or runnable: production passes no `CoworkSessionDoor`, so `session.create {mode: "cowork"}` still answers `unsupported_topology` for every role.

Owner decisions applied (2026-10-18): O1 (the first session binds to its own outputs location), G7 (ids in the store's format, a later slice), G5/G6 (`conversation_limit` and `cold_resume_unavailable` refuse and never queue), and DOOR owning every schema migration this wave.

## What landed

| Piece | Where |
|---|---|
| `CoworkRelativeCwd`, `CoworkSessionLocation` (`source` with an optional relative cwd, or `outputs`), `CoworkSessionCreate`, `CoworkSessionRef`, `CoworkSessionCreatedFacts` | `packages/protocol/src/cowork.ts` |
| `SessionCreateParams.cowork` (optional, NOT a refinement), the `session.list` row's `cowork` reference | `packages/protocol/src/methods.ts` |
| `session_created.cowork` (durable on seq 1; still outside `HISTORY_EVENT_TYPES`) | `packages/protocol/src/events.ts`, fixture `session_created_with_cowork_mode` |
| Swift: `SessionCreated.cowork` (nil encodes as an explicit null), `createSession(..., cowork:)` with `CoworkSessionBinding` | `apple/WinterProtocol`, `apple/WinterKit` |
| `provider_unavailable`, `conversation_limit`, `cold_resume_unavailable` | `CoworkErrorCode`, `packages/core/src/cowork/types.ts` |
| The ports (types only): `CoworkSessionDoor`, `CoworkSessionDrivers`, `CoworkLegSession`, `CoworkProviderRoute`, `CoworkApprovalPort`, `CoworkProvisioningPort`, the structural native seams (`CoworkGuestRun`, `CoworkGuestRuntimeLink`, `CoworkGuestConversationSet`, ...) | `packages/core/src/cowork/session-ports.ts` |
| `CoworkHostPorts.provisioning?` (type only; `requireProvisioning` is unchanged) | `packages/core/src/cowork/service.ts` |
| `DrivableSessionMode` | `packages/core/src/sessions/session-mode.ts` |
| The switch: `IpcServerOptions.coworkSessions?` | `packages/core/src/ipc/server.ts` |
| Migration 18 | `migrateCoworkSessionBindingSchema` in `cowork/schema.ts`, registered in `runtime-state/db.ts` |

### The `session.create` branch

With no door (every production daemon) the refusal is the first and only answer, as before. A binding that is present but malformed fails the schema first, like an unknown mode. With a door (tests only until D6):

1. a `remote` caller is still refused `unsupported_topology` (Cowork stays outside `REMOTE_ELIGIBLE_SESSION_MODES`);
2. the binding must be present, and none of `cwd`, `approvalPolicy`, `model`, `effort`, `origin` may ride beside it. They are judged on the RAW params, because `approvalPolicy` has a zod `.default("ask")`; otherwise every request would look like it carried one;
3. the door's typed refusals map through `rpcFromWinterRefusal` (INVALID_PARAMS with `data.code`, UNAUTHORIZED for `authority_denied`);
4. the answer is `{sessionId, trusted: false}`. A Cowork conversation has no host project to trust.

A `cowork` binding beside any other mode is `invalid_request`, never ignored.

### Migration 18

`cowork_conversations` is rebuilt (`rebuildsParentTable`; `cowork_output_locations` references it) to add:

- `location_kind` (`source` | `outputs`, default `source`; every existing row is `source`);
- `backend_session_id` (nullable, unique, 1 to 128 characters; G9, minted at bind by a later slice).

`source_id` becomes nullable, and one table CHECK allows exactly two shapes:

- a `source` row has a source;
- an `outputs` row has no source and its cwd is `.`.

The migration is idempotent: a table that already has `location_kind` is left alone. Both downgrade helpers accept 18. The repository's bind insert now names its columns. Nothing reads either new column yet. `ConversationBinding.sourceId` stays a string, because no door can write an outputs row yet. The type change comes with D3's bind.

## Tests

- `packages/core/test/cowork/session-door-off.test.ts`, the off test, in three parts:
  1. A production-shaped `startDaemon` with a seeded ready source: harness, admin and remote each get `unsupported_topology` for the source and outputs locations, for the bare mode and for every host-derived field. Afterwards there is no session, no conversation row, the incarnation is null and power `stopped`, `coworkNative.built === false`, `workspace.capabilities.get` reports `execution: false`, and nothing is broadcast.
  2. The positive control: the same request is accepted by a stub door through `startIpcServer`, along with every rule above.
  3. Source pins: the CLI and `daemon.ts` never name `coworkSessions`, only `ipc/server.ts` uses it, no module implements a door, and the plugin role gate precedes `session.create`.
- `packages/core/test/cowork/session-ports.test.ts`:
  - each structural copy is assignable both ways to its native twin (compile-time pins, enforced by `bun run typecheck`);
  - the readiness keys equal the profile's own;
  - the provider route scope equals the broker's scope;
  - the module is types only and imported only by `ipc/server.ts` and `cowork/service.ts`.
- `packages/core/test/cowork/session-binding-schema.test.ts` covers migration 18: the fresh shape, the CHECKs, an in-place upgrade from v17 that keeps rows, dependents and the index, idempotence, and the downgrade ladder.
- `packages/protocol/test/cowork-session-door.test.ts` covers the wire schemas.
- The literal schema pins in the peer-inbox, lifecycle, outputs and instructions tests move to 18. The positional insert in the retention test now names its columns.

Mutations: 48 mutants over the guards, the protocol refinements, migration 18, the downgrade helpers, the bind insert, the source pins and the port copies (the type-level ones under `tsc`). 47 were killed. The one survivor is equivalent: widening `location_kind`'s column CHECK is still refused by the table CHECK.

## Not in D1

- No `CoworkSessionDoor` implementation, no driver, no provider route, no tool list (D2/D3).
- No producer of `session_created.cowork` or the list row's `cowork`.
- No `daemon.ts` change (S7B owns the pass-through, the shutdown order and the composition).
