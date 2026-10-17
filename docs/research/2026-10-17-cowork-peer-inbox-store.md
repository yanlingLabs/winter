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
- **Backups.** `RuntimeStateDb.backup()` empties both tables in the copy it writes and vacuums it (so the freed
  pages that held bodies are not in the file), then proves them empty. If it cannot, the copy is deleted and the
  backup throws. Export manifests are built from named rows and never read these tables (a test pins it). Migration
  B treats any row as Cowork authority through `COWORK_TABLES` and refuses the copy.
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

1. **Freed pages keep bytes in the live database file** until reused or vacuumed; there is no secure deletion
   (`secure_delete` is off) and the WAL holds earlier page images until a checkpoint. The owner's decision was
   deletion at delivery, kept out of backups, no extra encryption; the backup copy is vacuumed, the live file is not.
   Say if `secure_delete` for these statements is wanted.
2. **A pre-restore snapshot loses the inbox.** `doctor`'s `restore-backup` takes `current.backup()` of the file it
   replaces; that snapshot now excludes owed messages too, which follows from "excluded from backups" but means the
   replaced file's owed messages are not recoverable from it.
3. **Restoring a backup empties the inbox and forgets the counters and dedupe.** By design; senders must retry.
4. **No automatic purge hook yet.** There is no workspace delete path in `CoworkRepository`; whoever adds one must
   call `purgeWorkspace` in the same transaction.
5. **`discardedBy` is stored** (audit only) and never projected to a sender, as the ledger already guarantees.
6. The store is not safe to back a ledger until the S7 integration constructs it over the same database as the
   Cowork records (it works over any `RuntimeStateDb`).
