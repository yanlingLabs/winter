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

## N1: migrations 20 and 21 (records only)

DOOR owns every migration. Neither migration has a production writer or reader yet; each is idempotent (a rewound `user_version` replays it without effect), and every new table is Cowork authority (`COWORK_TABLES`, each child listed before the table it references), so a populated row refuses both downgrades. `RUNTIME_STATE_SCHEMA_VERSION` is 21; the downgrade ladders accept 8..21 and refuse 22.

**Migration 20, content-out (#97).** The definitions are that lane's, unchanged:
- `cowork_exports.content_digest`: NULL, or lowercase 64-hex (the SHA-256 of `integrity.json`). NULL means no binding.
- `cowork_export_output_ids(export_id → cowork_exports, opaque_id = 's' + 16 lowercase hex, session_id)`, with primary key `(export_id, opaque_id)` and `UNIQUE (export_id, session_id)`. There is no foreign key on `session_id`.
- #97's `SqliteExportContentBinding` writes these tables with its own statements, so DOOR adds no repository method.

**Migration 21, #92 section 8 (DOOR rows):**
- `cowork_conversations` gains:
  - `runtime_uid` and `tool_uid`: 1000..65533, the tool uid never equals the runtime uid, and each is unique per workspace through partial unique indexes.
  - `store_state`: `none|started|created|lost`, default `none`. The backfill sets `started` wherever a `backend_session_id` is recorded, so a resume is never told "fresh" over a real store.
  - `last_incarnation_id`.
- `cowork_workspaces` gains:
  - `store_volume_uuid`: a lowercase 8-4-4-4-12 UUID, the guest's own `UUID` grammar.
  - `browse_uid`: 1000..65533.
- `cowork_guest_uids(workspace_id, uid, role runtime|tool|browse, session_id, allocated_at, retired_at, released_at)`:
  - The primary key `(workspace_id, uid)` allocates each uid once per workspace.
  - Each conversation has one uid per role, and each workspace has one browse uid. A browse uid has no session, and the others need one.
  - `released_at` needs `retired_at`.
  - **L7 keep rule:** a trigger refuses to delete a row until `released_at` is set, because a uid is kept until its owner's files are proven removed.
- `cowork_guest_boots(workspace_id, incarnation_id, lease_epoch > 0, guest_boot_id UNIQUE (36 characters), recorded_at, ended_proof, ended_at)`:
  - The primary key is `(workspace_id, incarnation_id)`.
  - `ended_proof` is one of `orderly-receipt|new-boot|owner-recover`, and it is set together with `ended_at`. A guest-written marker is not a value the schema accepts.
- `cowork_peer_inbox` gains:
  - `offer_count`: default 0, never negative;
  - `acked_hold_token`: NULL or 64 lowercase hex;
  - `commit_confirmed_at`;
  - `commit_outcome`: `folded|queued|started|already|lost`.

**Choices made here and open to review:**
- The three `ended_proof` names are DOOR's wording of the D1 evidence kinds: an orderly release receipt, a later boot's evidence, and an owner recover. S7B may rename them before anything writes the column.
- The per-workspace uid range excludes the workspace gid only through the allocator, not through the schema.

**One repository fix.** `CoworkRepository.create` inserted into `cowork_workspaces` by position, which would break when a column is added. It now names its columns. No other positional insert into an altered table exists in `src` or `test` on this branch. Other lanes should name columns too.

**Tests:**
- `test/cowork/n1-schema.test.ts` (new, 9 tests) covers the fresh shape, every CHECK and key, the L7 rule, the upgrade from a v19 store (rows survive, and the backfill applies only where a backend is recorded), the replay no-op and the ladder.
- Version and column pins were bumped in the peer-inbox-sqlite, session-binding-schema, storage-lifecycle, outputs, instructions and session-door tests.

**Mutations: 33/33 killed** (`door/n1_mutations.py`).

**NEEDS:**
- PEER-INBOX (`cowork/peer-inbox-sqlite.ts`): the ledger methods over the new columns (`offer` increments `offer_count`, `ack` stores `acked_hold_token` atomically, `confirmCommitted(receiptId, outcome)` sets `commit_confirmed_at` and `commit_outcome` together, plus `deliveredUnconfirmed` and the prune guard).
- S7B: write `cowork_guest_boots` at `hello` and its end proof after release, and write and re-send `store_volume_uuid`.
- DOOR (N3) owns the uid allocator and the `store_state` transitions.

## Review fold (a3f8bf13 on #111 and #114)

**N2:**
- **MED: a mixed report.** `CoworkRepository.acknowledgeMountedShares` checks every entry first and then acknowledges all of them in ONE transaction. A report with any bad entry leaves every source `preparing`, publishes nothing and concludes no operation.
- **LOW: the gaps found in review.** The over-12 limit and the workspace check now have tests. `conversations` refuses with the first refusal once a `sharesMounted` report has been refused, even if the host ignored that refusal.
- **Mutations (guards):** 4/5 killed. The survivor removes the transaction while keeping the validate-first loop. It is equivalent: validation runs before any write, and every entry shares one epoch.

**N1:**
- `cowork_peer_inbox.commit_outcome` carries `CHECK ((commit_confirmed_at IS NULL) = (commit_outcome IS NULL))`.
- `guest_boot_id` must be a lowercase UUID, the native `GUEST_BOOT` grammar.
- The rule for N3 is recorded in the schema doc: a guest uid is allocated ONLY through `cowork_guest_uids`, in the same transaction that writes it to a conversation or workspace.

**CLI (from dc).** The usage no longer names `winter workspace session create|list`, which is unreachable until a daemon carries a door (pinned). The parser stays.
