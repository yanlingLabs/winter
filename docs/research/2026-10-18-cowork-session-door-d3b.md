# Cowork session door D3b: the outputs location (O1)

Status: draft PR, stacked on D4c (#109), D4b (#108), D4a (#107) and D3 (#101). Nothing here makes a Cowork session creatable or runnable in production: no production caller passes a door. D3b makes the first-session working root that owner decision O1 chose run end to end behind the door. That root is a conversation bound to its OWN `/workspace/outputs/<sessionId>`, with the workspace's sources left honestly `preparing`, since N2 has no shares.

**This supersedes D3 owner decision 4** ("keep the redundant outputs check"). The driver's `conversationLocation !== "source"` refusal is gone, because the outputs row is now a supported location. D3's "outputs row refuses" test is rewritten in the open (see Tests).

## Shape: one DOOR-only reader; `binding()` stays source-only

About 20 other-lane modules read `CoworkRepository.binding()`, including git authority, schedules, the peer inbox, messaging, outputs.ts, the browser engine and the guided owner. They all keep failing closed on an outputs row (`unsupported_topology`), which is the right default until each lane decides what an outputs conversation means for it.

The DOOR's run path reads the new `CoworkRepository.conversation()` instead. It returns a discriminated `CoworkConversation`: `{location: "source", …ConversationBinding}` or `{location: "outputs", sourceId: absent}`. It is used by:
- door create;
- the driver's `ensure` and conversations callback;
- the set builder;
- the approval ports;
- the guest-runtime descriptor and `assertCurrent`.

| Piece | What changes |
|---|---|
| `cowork/types.ts` | `CoworkOutputsConversation`, `CoworkConversation`. |
| `cowork/repository.ts` | `conversation()`. `bindOutputsConversation()` has the same ownership rules as `bindConversation`: the store row must be committed, a standalone workspace binds only its reserved id, and the bind takes the workspace's default policy and ceiling. It names no source and touches no source state. |
| `cowork/conversation-set.ts` | `coworkGuestRootFor`, `coworkGuestOutputsRootFor` and `coworkOutputsOf`. An outputs conversation's single root is `{id: "outputs", guestPath: /workspace/outputs/<sid>, source: same, readOnly: plan}`. **`coworkConversationCeiling` is the DOOR's ceiling rule for either location.** It is the same intersection as `CoworkAuthority.effectiveCapabilities`, which reads `binding()` and stays untouched (another lane owns it). |
| `cowork/approval-ports.ts` | Takes either location. An outputs conversation has NO admitted root, so its own folder classifies as `outputs` (#84's cells: Read allow, Write/Edit on the admitted-root row, Bash pathless), never `admitted`. Cards say source revision 0. |
| `cowork/guest-runtime.ts` | The descriptor and `assertCurrent` read `conversation()`. `GuestRuntimeLaunch.source` is `null` for outputs. A launch admitted for one location never spawns or keeps running as the other. |
| `cowork/session-driver.ts` | Either location. A location change between `ensure` and the set is `stale_acknowledgment`. |
| `cowork/session-door.ts` | `create` accepts `{kind: "outputs"}`. The digest names the location, so a source request and an outputs request under one request id conflict. The facts carry `location: "outputs", sourceId: null`. |
| `cowork/session-ports.ts` | `CoworkApprovalPort` input `binding` is a `CoworkConversation`. The adapter reads only its policy. |

## Plan view: not expressible in host-query-v1 yet

The native `conversationOf` (S7B's `native/protocol.ts`, mirroring the guest supervisor's `host_query_config`) refuses any `/workspace/.winter` root for a conversation with a runtime. So the epoch-scoped plan scratch cannot be mounted, and `planViewMounted` is false by construction. A plan write to scratch stays `plan_view_missing`, which is fail-closed.

The pin `session-driver.test.ts` "plan view: not expressible …" checks three things:
- the real validator refuses a read-only `.winter/scratch/<sid>` or `.winter/memory` extra root, while a non-`.winter` control root passes;
- the driver never names `planViewMounted`.

The coordinator's decision is a separate view class OUTSIDE `.winter`, `/workspace/plan/<sid>/<epoch>`, read-write under plan only, where a later epoch never mounts an earlier one's view. That is a cross-lane slice after D3b:
- agent-sdk: profile and supervisor;
- S7B: `conversationOf` and the per-epoch directory;
- APPROVALS: a `planScratch` class;
- DOOR: mount it and set `planViewMounted`.

## Tests

| Test | What it proves |
|---|---|
| `session-driver` "D3b: an outputs-located conversation (O1) runs a full turn …" | Through the real native validator, the source is still `preparing` before and after. The one root is the own outputs folder, writable, and the launch cwd. A relative `Write report.md` cards and is allowed. A Write into another conversation's outputs is denied without a card. `binding()` still refuses the row. |
| `session-driver` "D3b: under plan …" | Under plan the outputs root is read-only and the runtime runs plan. |
| `session-driver` "D3b: … location changed between ensure and the set …" | Such a change is refused stale and nothing runs. |
| `guest-runtime` (two tests) | An outputs launch carries no source and the outputs cwd. Changing location in either direction is stale at spawn and at the next input of a running lifetime. |
| `approval-ports` "D3b …" | The own folder is `outputs`, others are `protected`, and a source passed with an outputs conversation is refused. |
| `session-door` (three D3b tests) | Outputs create for Project and standalone, idempotent, with sources untouched. Request conflicts in both directions. The outputs bind's own rules. The DOOR ceiling rule (restrictions intersected, inactive refused). |
| Rewritten | The D3 driver refusal test no longer refuses an outputs row (its title says so). The D4a "refusals before anything is written" drops the outputs case. `conversation-backend`'s title. |

Mutations: 16/18 killed (`door/d3b_mutations.py`). Both survivors are equivalent:
- **`assertCurrent`'s outputs-without-source branch.** The location-equality check before it already refuses every location change.
- **A lax outputs reader in `conversation()`.** Migration 18's CHECK makes an outputs row with a source or a non-root cwd unrepresentable.

## Other lanes' files touched (types only, for acceptance)

`guest-context-owner.test.ts` and `guest-runtime.test.ts`: `launch.source!` where the launch is a source launch (the field is now nullable). No assertion changed.

## NEEDS FROM OTHER LANE

1. **S7B (routed by the coordinator):** the native host creates `/workspace/outputs/<sid>` on data.ext4, group-owned for the workspace, before the set is sent. The supervisor's `source_directory` opens it strictly, so until then an outputs conversation fails at the guest's root open.
2. **The plan-view slice** (above), cross-lane.
3. **APPROVALS, LOW:** a card for an outputs conversation reads "source revision 0". A location-aware wording would be clearer.
4. **Other lanes, when they want outputs conversations:** read `conversation()` (or keep refusing). Nothing is owed until a lane asks.

## Docs owed

- `docs/claude/cowork.md`: the outputs location runs behind the door. `binding()` is source-only and `conversation()` is the DOOR's reader. The plan view is not expressible in host-query-v1 yet.
