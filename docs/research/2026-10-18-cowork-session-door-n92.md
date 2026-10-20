# Cowork session door: the #92 host-side DOOR rows

Status: draft PRs, stacked on D3b (#110). Built against the folded #92 design (`cowork/n2-extensions-design` at `da3d248bf`; the coordinator confirmed M1 final). Nothing here is reachable in production. No native host calls the new seam before S7B's contract text version 3 exists, and no production caller constructs the driver.

Slices:
- N2, folder shares acknowledged at `shares_mounted`;
- N1, migrations 20 (#97) and 21 (#92 rows);
- N3 (cold resume) and N4 (held-input messaging): they wait for ac25214's `cowork/guest-messaging` agent-sdk draft and are coordinated with it directly.

## N2: folder shares become `ready` at `shares_mounted` (#92 sections 2.5 and 8)

- **The seam.** `CoworkGuestStartRequest.sharesMounted?(context, mounted: CoworkMountedShare[])` is a new optional member beside `conversations`. The v3 native host calls it at the guest's `shares_mounted`, BEFORE it asks for the set. Each `{sourceId, revision}` is host-mapped from the share tag, never a guest id.
- **`coworkAcknowledgeMountedShares`** (session-driver.ts) acknowledges each entry `ready` under the incarnation's current epoch (`refreshEpoch`, then `acknowledgeSource`). It accepts 1 to 12 distinct entries. Each must be a present FOLDER source of the workspace, `preparing`, at the share's revision.
- **Refusals.** Anything else throws typed, and the driver surfaces its own code over the host's bootstrap fault. Calling it after the set is `recovery_required`.
- **What it unlocks.** A source conversation whose source no incarnation acknowledged is refused `source_unavailable` at the set (`requireSource`, unchanged), so shares are what make a folder conversation runnable for the first time.

**Tests.** session-driver "#92 N2" (four tests):
- a mounted share makes the source `ready` for THIS incarnation and the turn runs;
- with no report, the set refuses;
- a stale revision, an unknown source, a repeat or an empty report each give their own code, and nothing is acknowledged or launched;
- a repository source is never acknowledged by a share;
- a report after the set is refused.

**Mutations: 6/7 killed** (`door/n2_mutations.py`). The one survivor is equivalent: dropping the revision check, which `acknowledgeSource` repeats (its `selected.revision !== revision` is `stale_acknowledgment`).

**NEEDS.** S7B (`native/host.ts`, with the v3 contract): call `request.sharesMounted(context, mounted)` when `shares_mounted` arrives and before `conversations`, mapping each folder share's tag to its `{sourceId, revision}` from the `shares` records it prepared. Treat a throw as the bootstrap fault `share_mount_failed`. Its `CoworkNativeHostDeps` twin pin then grows this member.
