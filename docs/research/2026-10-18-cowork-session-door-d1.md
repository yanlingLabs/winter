# Cowork session door, D1: the spine (unwired)

Slice D1 of [the session door design](2026-10-18-cowork-session-door-design.md) (sections 6 and 7). It lands the wire fields, the ports the other lanes build against, migration 18, and the test that proves the door is off. Nothing here makes a Cowork session creatable or runnable: production passes no `CoworkSessionDoor`, so `session.create {mode: "cowork"}` still answers `unsupported_topology` for every role.

Owner decisions applied (2026-10-18): O1 (the first session binds to its own outputs location), G7 (ids in the store's format, a later slice), G5/G6 (`conversation_limit` and `cold_resume_unavailable` refuse and never queue), and DOOR owning every schema migration this wave.

## What landed

| Piece | Where |
|---|---|
| `CoworkRelativeCwd`, `CoworkSessionLocation` (`source` with an optional relative cwd, or `outputs`), `CoworkSessionCreate`, `CoworkSessionRef`, `CoworkSessionCreatedFacts` | `packages/protocol/src/cowork.ts` |
| `SessionCreateParams.cowork` (optional, NOT a refinement), the `session.list` row's `cowork` reference | `packages/protocol/src/methods.ts` |
| `session_created.cowork` (durable on seq 1; still outside `HISTORY_EVENT_TYPES`) | `packages/protocol/src/events.ts`, fixture `session_created_with_cowork_mode` |
| Swift: `SessionCreated.cowork` (a nil binding is omitted from the encoding, never written as null), `createSession(..., cowork:)` with `CoworkSessionBinding` | `apple/WinterProtocol`, `apple/WinterKit` |
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

Migration 18 also creates S7B's `cowork_home_binding` (needed by #87). It is the singleton record of which prepared Mac home this Cowork home is bound to, and its text is identical to `COWORK_HOME_BINDING_DDL` in `cowork/host-env/stores.ts`. It is written once and never updated. It is listed in `COWORK_TABLES` ahead of the `cowork_home_identity` table it references, so a populated binding refuses both downgrades.

The migration is idempotent: the binding table is `IF NOT EXISTS`, and a conversations table that already has `location_kind` is left alone. Both downgrade helpers accept 18. The repository's bind insert now names its columns. Nothing reads either new column yet. `ConversationBinding.sourceId` stays a string, because no door can write an outputs row yet. The type change comes with D3's bind.

## Tests

- `packages/core/test/cowork/session-door-off.test.ts`, the off test, in three parts:
  1. A production-shaped `startDaemon` with a seeded ready source. Harness, admin and remote each get `unsupported_topology` for the source and outputs locations, for the bare mode and for every host-derived field. A plugin cannot even connect: no plugin token verifies, whichever token it presents. Afterwards there is no session and no conversation row, the incarnation is null, power is `stopped`, `coworkNative.built === false`, `workspace.capabilities.get` reports `execution: false`, and nothing is broadcast.
  2. The positive control. A stub door through `startIpcServer` accepts the same request. Every rule above is checked: the caller's own role and connection id, remote refused, missing binding, raw host-derived fields, a binding beside another mode, malformed bindings, and typed door refusals.
  3. Source pins:
     - the CLI never names `coworkSessions`;
     - `daemon.ts` may name it only as S7B's pass-through: the option's declaration, its type-only import, and `coworkSessions: opts.coworkSessions`;
     - otherwise only `ipc/server.ts` and the spine name the door;
     - no module implements, casts or constructs one;
     - the plugin method gate excludes `session.create`.
- `packages/core/test/cowork/session-ports.test.ts`:
  - each structural copy is assignable both ways to its native twin (compile-time pins, enforced by `bun run typecheck`);
  - the readiness keys equal the profile's own;
  - the provider route scope equals the broker's scope;
  - the module is types only, and every src importer imports it type-only. Other lanes may add importers without editing this test.
- `packages/core/test/cowork/session-binding-schema.test.ts` covers migration 18: the fresh shape, the CHECKs, an in-place upgrade from v17 that keeps rows, dependents and the index, idempotence, and the downgrade ladder.
- `packages/protocol/test/cowork-session-door.test.ts` covers the wire schemas.
- The literal schema pins in the peer-inbox, lifecycle, outputs and instructions tests move to 18. The positional insert in the retention test now names its columns.

Mutations: 51 mutants in one catalogue run, plus 6 for the home binding fold (all 6 killed: the table missing, not authority, wrong drop order, singleton, reference, a required column). They cover the guards, the protocol refinements, migration 18, the downgrade helpers, the bind insert, the source pins and the port copies (the type-level ones under `tsc`). 50 were killed. The one survivor is equivalent: widening `location_kind`'s column CHECK is still refused by the table CHECK, which already admits only the two shapes.

### Where the off test differs from design section 6

Both differences need an owner decision.

1. **No `plugin` send.** Section 6 lists `plugin` among the roles that send the request. No plugin connection can exist: `TokenAuthority.verify` refuses every plugin token ("plugin tokens arrive in Phase 4"). The test therefore asserts that a plugin hello is refused for each of the three real tokens, and pins that `PLUGIN_ALLOWED_METHODS` excludes `session.create`. Recommendation: accept, and send as `plugin` once plugin tokens exist.
2. **A thinner positive control.** Section 6's control expects three things: "a row exists, the binding is `active`, a fake launcher is called only at the first send". None of those can exist before a real door. A stub cannot mint a Cowork row, because `SessionStore.createSession` refuses the mode without a reservation, and the reservation is D3's. The D1 control instead proves the same request reaches an injected door verbatim and is answered `{sessionId, trusted: false}`. Recommendation: accept, and move the row, binding and launcher assertions to D3, where the real door and driver land.

## Not in D1

- No `CoworkSessionDoor` implementation, no driver, no provider route, no tool list (D2/D3).
- No producer of `session_created.cowork` or the list row's `cowork`.
- No `daemon.ts` change (S7B owns the pass-through, the shutdown order and the composition).

## Review fixes (2026-10-19)

The DOOR review rejected D1 at `863e1496`. One commit fixes it:

- **HIGH: a sync import could author a Cowork binding.** A paired phone may call `sync.push`, and its batch check accepted a chat `session_created` that carried `cowork`. Since D1 that field is parsed, stored and broadcast. Now `sync.push` refuses any pushed `session_created` that carries `cowork`, at any seq, and `SessionStore.appendSynced` refuses it too, whether in the parsed event or in the raw line. The test sits beside the existing "sync imports cannot author host workspace authority events" pin. The protocol comment and design section 7.1 now say that `session_created.cowork` is a display fact: consumers check the `cowork_conversations` row, never the log field alone.
- **MEDIUM: the rebuild tests could not see a lost constraint.** The upgrade test compared the rebuilt table with the same DDL text, so dropping a foreign key or a CHECK went unnoticed. A new test judges against the v17 text itself. For both a fresh store and an upgraded one, it checks that:
  - the foreign key list equals v17's;
  - every v17 CHECK clause is present;
  - a bad policy, a bad state, a zero revision, a dangling source and a dangling workspace are each refused.
- **LOW:**
  - The binding-beside-another-mode refusal now has a no-door test, so it is shown to hold on every production daemon.
  - `cowork_home_binding` is write-once in the schema: triggers abort an UPDATE, a DELETE and a second INSERT, including `OR REPLACE`. S7B's store only reads and inserts. The table text is exported as `COWORK_HOME_BINDING_TABLE`, so S7B's `COWORK_HOME_BINDING_DDL` can be pinned equal to it once both have merged.
  - A nil `SessionCreated.cowork` is omitted from the Swift encoding, not written as null. The wording above is corrected.
  - The doc comment that had drifted away from `coworkSessionUnsupported` in `ipc/server.ts` is back on it.

Mutations: the reviewer's surviving mutants are now killed. A3 is killed by the no-door test, and A4–A7 by the v17-constraint test. Of the 9 new mutants, 8 are killed. They cover:
- the sync and `appendSynced` refusals;
- each trigger, and the triggers never being installed;
- a dropped revision CHECK.

The one survivor was a raw-key clause in `sync.push`, which turned out to be equivalent: a `cowork` key that is not a valid binding already fails the schema. The clause is removed. `appendSynced` keeps its raw-line check, because its raw line and its parsed event are separate inputs.
