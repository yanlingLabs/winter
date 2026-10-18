# Cowork peer-inbox SQLite store and schema 17 (unwired)

Status: source and tests. `packages/core/src/cowork/peer-inbox-sqlite.ts` is the durable `PeerInboxStore` for the
receipt ledger of [2026-10-16-cowork-peer-inbox.md](2026-10-16-cowork-peer-inbox.md). Nothing in `src/` imports it,
nothing constructs it in a production path, and there is no RPC, protocol change or daemon wiring. The only
production-path effects are the schema-17 migration (two empty tables) and the backup exclusion in
`RuntimeStateDb.backup()`. The native-worker integration slice (S7) rebases on this one.

## What was built

| Piece | Where |
| --- | --- |
| `SqlitePeerInboxStore` (the port, over the runtime-state database) | `src/cowork/peer-inbox-sqlite.ts` |
| `migrateCoworkPeerInboxSchema` (v17), `COWORK_BACKUP_EXCLUDED_TABLES`, both tables in `COWORK_TABLES` | `src/cowork/schema.ts` |
| `RUNTIME_STATE_SCHEMA_VERSION` 16 to 17, migration entry, downgrade ladder to 17, backup exclusion | `src/runtime-state/db.ts` |
| Conformance case for an unreadable body and the `makeBodyUnreadable` harness hook (store-generic) | `test/cowork/peer-inbox-conformance.ts` |
| SQLite tests, kill-9 child | `test/cowork/peer-inbox-sqlite.test.ts`, `test/cowork/fixtures/peer-inbox-kill-child.ts` |

Schema numbers: runtime-state 16 to **17**. Tables: `cowork_peer_inbox` (one row per accepted send) and
`cowork_peer_inbox_sequences` (the per-recipient counter). No foreign keys: a session id here is a name, never
authority (and the ledger tests run the store over a database separate from the records).

## Design decisions

- **The body is a BLOB column of the record's own row**, not a separate file store. That makes the hard-crash
  leftovers the spec describes for a separate body store (an orphan body, a terminal record that still holds one)
  unrepresentable: a record and its body commit in one transaction, and `CHECK(state IN ('accepted','blocked') OR
  body IS NULL)` forbids a terminal row with a body, so reaching a terminal state and releasing the body are one
  `UPDATE`. `quick_check` at open refuses a file that violates the CHECK, so the file cannot even open with a leaked
  body. `audit()` still reports all three lists (orphans are always 0); an unresolved row with no body is damage,
  reported and never swept.
- **Counters are their own table** so a sequence number is never reused after `remove` or a restart
  (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`), never `MAX(sequence)+1`.
- **Every mutation runs in `durableCoworkTransaction`** (IMMEDIATE, `synchronous=FULL`, fullfsync on Darwin), so
  the cap check and the insert are one operation across two live connections, and "returns means committed".
- **Handles are derived** (`pib_<receipt id>`, present only while the row holds a body). No record query selects
  the body; only `readBody` reads it, decodes with a fatal UTF-8 decoder and `ignoreBOM`, and throws on any read or
  decode error. Absence is `undefined`.
- **Backups.** `RuntimeStateDb.backup()` writes `VACUUM INTO <name>.tmp`, empties both tables in that copy, checkpoints
  (TRUNCATE), vacuums (so the freed pages are gone from the file; `freelist_count` is 0), proves them empty, and only
  then renames it to its real name. If it cannot prove it, the copy is deleted and the backup throws. A process that
  dies in between leaves only a `.tmp` (or its `-journal`), never a body-bearing file under a backup's name; the next
  backup into the same directory deletes a `.tmp` whose owner pid is gone or that is over ten minutes old, and
  `doctor restore-backup` refuses a `.tmp` as incomplete. Export manifests are built from named rows and never read
  these tables (a test pins it). Migration B treats any row as Cowork authority through `COWORK_TABLES` and refuses
  the copy.
- **The doctor's raw-copy snapshot (owner decision, 2026-10-18).** When `doctor restore-backup` cannot open the current
  file it byte-copies it (plus `-wal`/`-shm`) before overwriting. That copy can hold owed bodies, so when it CAN be
  opened it is scrubbed with the same routine (`scrubExcludedTables`), on a working copy that replaces the snapshot
  only on success. When it cannot be opened or scrubbed, with or without a valid SQLite header, the raw copy is KEPT
  byte-for-byte and the restore RUNS: the file may be corrupt or written by a newer Winter, and the copy can be the
  user's only good data. The command output (`detail`, and the additive `warning` field of the result) then says
  plainly that the pre-restore copy is unscrubbed, may contain undelivered Cowork peer messages, and gives its path.
  An earlier revision deleted such a copy or refused the restore; the owner overruled both.
- **Downgrade.** A populated inbox is owed delivery and is retained, like every Cowork table: both downgrade
  functions refuse while any inbox row exists. An empty inbox is dropped with the rest. Counter rows alone do not
  block it (they carry no authority; a drained inbox keeps them so numbers are not reused).
- **Workspace deletion.** `purgeWorkspace(workspaceId, now)` deletes every row addressed to a session of the
  workspace (and those recipients' counters) and ends every unresolved row it sent as `refused: sender_gone`
  with the body released, which is the ledger's own transition. Membership is the `cowork_conversations` row
  whatever its state. It joins the caller's transaction if one is open.

## Checklist mapping (the spec's "Checklist for the SQLite store slice")

| Item | Where it is met |
| --- | --- |
| Harness, both suites over it | `sqliteHarness()`; `runPeerInboxStoreConformance("sqlite")` and `definePeerInboxLedgerTests` |
| Unreadable-body hook and case | `makeBodyUnreadable` (required on the harness; the in-memory harness implements it too); conformance case "readBody throws..."; plus real SQLite decode-error and closed-database cases |
| Open-time sweep | constructor releases a terminal row's body; tested on a table copy without the CHECK; unresolved-without-body reported, never swept |
| Kill test | `kill -9` of a child mid-append, mid-terminal-update and mid-remove, then reopen: integrity ok, `audit()` clean, counters never behind a row, whole bodies |
| Backups | `backup()` exclusion, fail-closed, writable and readonly handles, marker absent from the bytes |
| Schema 17 | `COWORK_TABLES`, ladder, version, idempotent `user_version` rewind, v16-to-17 upgrade, downgrade v7 and v6 |

Existing tests that pinned the literal 16 (`outputs`, `instructions`, `storage-lifecycle`) now pin 17. The ledger's
anti-wiring test now allows exactly one other module to name the ledger (the SQLite store), and requires that
nothing else names the store.

## Open points

1. **Freed pages and the WAL.** `PRAGMA secure_delete=FAST` is pinned on every runtime-state open (it is this
   runtime's default, SQLite 3.51; the pin stops a different build from silently turning it off). With it, the body
   pages freed at delivery are zeroed in the main file. The WAL keeps the OLD frames (which can hold the body) until
   the next checkpoint; a TRUNCATE checkpoint clears them (tested). This unwired store adds no checkpoint calls.
   **Known point for the wiring slice:** decide whether delivery should be followed by a checkpoint, or accept WAL
   residue until the normal one.
2. **The pre-restore snapshot excludes the inbox when it can.** The `backup()` path always; the raw-copy path whenever
   the copy can be opened. A copy that cannot be opened is kept unscrubbed and flagged (see above), so it may still
   hold owed messages.
3. **Restore empties the inbox, the counters and the dedupe records.** Re-read against the ledger
   (`peer-inbox.ts`): it promises no exactly-once execution, says plainly that a pruned send identity is forgotten
   and that a restarted sender's replay is a new send, and keeps terminal dedupe records only boundedly (24 h, last
   100). Nothing assumes dedupe survives a restore, so a sender that retries after a restore produces a duplicate
   delivery, not a loss (at-least-once). Senders must be written for that.
4. **No automatic purge hook yet.** There is no workspace delete path in `CoworkRepository`; whoever adds one must
   call `purgeWorkspace` in the same transaction.
5. **A file that violates the table's CHECK takes down the WHOLE runtime-state database, not just Cowork.**
   `quick_check` at open reports it, `openRuntimeStateDb` throws `corrupt`, and everything in the file (sessions,
   leases, all of it) is unavailable until restored. It needs an external writer that ignores constraints
   (`PRAGMA ignore_check_constraints`, or another tool) to occur; this code never produces it.
6. **`discardedBy` is stored** (audit only) and never projected to a sender, as the ledger already guarantees.
7. The store is not safe to back a ledger until the S7 integration constructs it over the same database as the
   Cowork records (it works over any `RuntimeStateDb`).
