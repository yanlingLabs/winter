import type { Database } from "bun:sqlite";

/** Tables that hold message bodies or per-recipient message counters. `RuntimeStateDb.backup()` empties them in the
 * copy it writes, so a backup never carries an owed message body (owner decision, 2026-10-16). */
export const COWORK_BACKUP_EXCLUDED_TABLES = ["cowork_peer_inbox_sequences", "cowork_peer_inbox"] as const;

/** Reverse dependency order also permits removing an unused additive schema on explicit rollback. */
export const COWORK_TABLES = ["cowork_guest_boots", "cowork_guest_uids", "cowork_export_output_ids", "cowork_session_reservations", "cowork_peer_inbox_sequences", "cowork_peer_inbox", "cowork_exports", "cowork_workspace_images", "cowork_output_directory_intents", "cowork_output_locations", "cowork_output_directories", "cowork_schedule_quarantines", "cowork_instruction_mutations", "cowork_instructions", "cowork_instruction_directories", "cowork_schedule_occurrences", "cowork_schedules", "cowork_folder_grants", "cowork_volumes", "cowork_volume_directories", "cowork_outbox_deliveries", "cowork_outbox", "cowork_conversations", "cowork_projects", "cowork_policies", "cowork_sources", "cowork_operations", "cowork_workspaces", "cowork_home_binding", "cowork_home_identity"] as const;

/** Host authority only. A guest manifest or rebuilt session index never populates these tables. */
export function migrateCoworkSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_home_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), home_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cowork_workspaces (
      workspace_id TEXT PRIMARY KEY, ownership TEXT NOT NULL CHECK(ownership IN ('standalone','project')),
      owner_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('retained','archived','deleting','deleted')),
      config_revision INTEGER NOT NULL CHECK(config_revision>0), grant_revision INTEGER NOT NULL CHECK(grant_revision>0),
      instruction_revision INTEGER NOT NULL CHECK(instruction_revision>0),
      incarnation_id TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),
      power TEXT NOT NULL CHECK(power IN ('stopped','starting','running','draining','uncertain')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cowork_policies (
      workspace_id TEXT PRIMARY KEY REFERENCES cowork_workspaces(workspace_id), policy_id TEXT NOT NULL UNIQUE,
      default_policy TEXT NOT NULL CHECK(default_policy IN ('plan','dont-ask','ask','accept-edits','auto','bypass')),
      publication TEXT NOT NULL CHECK(publication IN ('github-only-feature-branches','manual')),
      ceiling_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      default_revision INTEGER NOT NULL CHECK(default_revision>0), publication_revision INTEGER NOT NULL CHECK(publication_revision>0)
    );
    CREATE TABLE IF NOT EXISTS cowork_projects (
      project_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES cowork_workspaces(workspace_id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cowork_sources (
      source_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      location_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('folder','githubRepository')),
      label TEXT NOT NULL, detail_json TEXT NOT NULL,
      desired TEXT NOT NULL CHECK(desired IN ('present','removed')),
      state TEXT NOT NULL CHECK(state IN ('preparing','ready','unavailable','removing','detached')),
      access TEXT NOT NULL CHECK(access IN ('read-only','read-write')), revision INTEGER NOT NULL CHECK(revision>0),
      ack_revision INTEGER, ack_incarnation_id TEXT, reason TEXT, restart_required INTEGER NOT NULL DEFAULT 0,
      trust TEXT NOT NULL DEFAULT 'untrusted' CHECK(trust IN ('untrusted','trusted','revoked')),
      trust_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      operation_id TEXT REFERENCES cowork_operations(operation_id),
      UNIQUE(workspace_id,source_id)
    );
    CREATE INDEX IF NOT EXISTS cowork_sources_workspace ON cowork_sources(workspace_id);
    CREATE TABLE IF NOT EXISTS cowork_conversations (
      session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      project_id TEXT REFERENCES cowork_projects(project_id), source_id TEXT NOT NULL,
      relative_cwd TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('plan','dont-ask','ask','accept-edits','auto','bypass')),
      restrictions_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN ('active','archived','deleted')), created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id,source_id) REFERENCES cowork_sources(workspace_id,source_id)
    );
    CREATE INDEX IF NOT EXISTS cowork_conversations_workspace ON cowork_conversations(workspace_id);
    CREATE TABLE IF NOT EXISTS cowork_operations (
      operation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, method TEXT NOT NULL, scope TEXT NOT NULL,
      request_id TEXT NOT NULL, request_digest TEXT NOT NULL, workspace_id TEXT REFERENCES cowork_workspaces(workspace_id),
      status TEXT NOT NULL CHECK(status IN ('pending','applied','blocked','failed','superseded')),
      result_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(principal_id,method,scope,request_id)
    );
    CREATE TABLE IF NOT EXISTS cowork_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      operation_id TEXT NOT NULL REFERENCES cowork_operations(operation_id), revision INTEGER NOT NULL,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cowork_outbox_deliveries (
      change_id TEXT NOT NULL REFERENCES cowork_outbox(change_id), session_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','delivered')), event_seq INTEGER,
      PRIMARY KEY(change_id,session_id)
    );
  `);
}

/** v9 storage records are canonical. A raw image is never authority or evidence of ext4 readiness. */
export function migrateCoworkVolumeSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_volume_directories (
      relative_path TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('planned','created')),
      device TEXT, inode TEXT, uid INTEGER, mode INTEGER,
      CHECK((device IS NULL)=(inode IS NULL)), CHECK((device IS NULL)=(uid IS NULL)), CHECK((device IS NULL)=(mode IS NULL)),
      CHECK((state='created')=(device IS NOT NULL)), CHECK(mode IS NULL OR mode=448)
    );
    CREATE TABLE IF NOT EXISTS cowork_volumes (
      volume_id TEXT PRIMARY KEY, home_id TEXT NOT NULL REFERENCES cowork_home_identity(home_id),
      workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id), creation_id TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL CHECK(purpose IN ('data','environment')), format TEXT NOT NULL CHECK(format='raw-ext4-v1'),
      format_version INTEGER NOT NULL CHECK(format_version=1), capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes>=16777216 AND capacity_bytes<=274877906944 AND capacity_bytes%4096=0),
      sector_bytes INTEGER NOT NULL CHECK(sector_bytes=512), filesystem_block_bytes INTEGER NOT NULL CHECK(filesystem_block_bytes=4096),
      state TEXT NOT NULL CHECK(state IN ('planned','creating','allocated')),
      filesystem_state TEXT NOT NULL CHECK(filesystem_state='unformatted'),
      device TEXT, inode TEXT, uid INTEGER, mode INTEGER,
      owner_json TEXT, last_stop_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id,purpose),
      CHECK((device IS NULL)=(inode IS NULL)), CHECK((device IS NULL)=(uid IS NULL)), CHECK((device IS NULL)=(mode IS NULL)),
      CHECK(mode IS NULL OR mode=384), CHECK(state!='planned' OR device IS NULL), CHECK(state!='allocated' OR device IS NOT NULL), CHECK(owner_json IS NULL OR state='allocated')
    );
  `);
}


/** v10 preserves old ownership/identity but never invents virgin formatting provenance. */
export function migrateCoworkFilesystemSchema(db: Database): void {
  // Tests can rewind user_version without rebuilding their already-current tables.
  if (db.query("PRAGMA table_info(cowork_volumes)").all().some((row: any) => row.name === "filesystem_uuid")) return;
  db.exec(`ALTER TABLE cowork_volumes RENAME TO cowork_volumes_v9;
    CREATE TABLE cowork_volumes (
      volume_id TEXT PRIMARY KEY, home_id TEXT NOT NULL REFERENCES cowork_home_identity(home_id),
      workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id), creation_id TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL CHECK(purpose IN ('data','environment')), format TEXT NOT NULL CHECK(format='raw-ext4-v1'),
      format_version INTEGER NOT NULL CHECK(format_version=1), capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes>=16777216 AND capacity_bytes<=274877906944 AND capacity_bytes%4096=0),
      sector_bytes INTEGER NOT NULL CHECK(sector_bytes=512), filesystem_block_bytes INTEGER NOT NULL CHECK(filesystem_block_bytes=4096),
      state TEXT NOT NULL CHECK(state IN ('planned','creating','allocated')),
      filesystem_state TEXT NOT NULL CHECK(filesystem_state IN ('unformatted','formatting','probing','ready','recovery-required')),
      filesystem_uuid TEXT, format_eligible INTEGER NOT NULL DEFAULT 0 CHECK(format_eligible IN (0,1)), filesystem_journal_json TEXT,
      device TEXT, inode TEXT, uid INTEGER, mode INTEGER,
      owner_json TEXT, last_stop_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(format_eligible=0 OR (filesystem_state='unformatted' AND filesystem_uuid IS NOT NULL)),
      CHECK(filesystem_state NOT IN ('formatting','probing','ready') OR (filesystem_uuid IS NOT NULL AND filesystem_journal_json IS NOT NULL)),
      UNIQUE(workspace_id,purpose),
      CHECK((device IS NULL)=(inode IS NULL)), CHECK((device IS NULL)=(uid IS NULL)), CHECK((device IS NULL)=(mode IS NULL)),
      CHECK(mode IS NULL OR mode=384), CHECK(state!='planned' OR device IS NULL), CHECK(state!='allocated' OR device IS NOT NULL), CHECK(owner_json IS NULL OR state='allocated')
    );

    INSERT INTO cowork_volumes(volume_id,home_id,workspace_id,creation_id,purpose,format,format_version,capacity_bytes,sector_bytes,filesystem_block_bytes,state,filesystem_state,device,inode,uid,mode,owner_json,last_stop_id,created_at,updated_at)
      SELECT volume_id,home_id,workspace_id,creation_id,purpose,format,format_version,capacity_bytes,sector_bytes,filesystem_block_bytes,state,'recovery-required',device,inode,uid,mode,owner_json,last_stop_id,created_at,updated_at FROM cowork_volumes_v9;
    DROP TABLE cowork_volumes_v9;
  `);
}


/** Protected, source-bound local grants. Never reconstruct from a guest/storage manifest. */
export function migrateCoworkFolderGrantSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_folder_grants (
    grant_ref TEXT PRIMARY KEY, home_id TEXT NOT NULL REFERENCES cowork_home_identity(home_id),
    workspace_id TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
    principal_id TEXT NOT NULL, selection_id TEXT NOT NULL UNIQUE,
    root_identity TEXT NOT NULL, root_device TEXT NOT NULL, root_inode TEXT NOT NULL,
    root_path TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('read-only','read-write')),
    bookmark BLOB NOT NULL CHECK(typeof(bookmark)='blob' AND length(bookmark)<=65536),
    state TEXT NOT NULL CHECK(state IN ('active','revoked')), revision INTEGER NOT NULL CHECK(revision>0),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(state='revoked' OR (length(bookmark)>0 AND length(root_path)>0 AND length(root_path)<=4096)),
    FOREIGN KEY(workspace_id,source_id) REFERENCES cowork_sources(workspace_id,source_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS cowork_folder_grants_root ON cowork_folder_grants(workspace_id,root_device,root_inode) WHERE state='active';
  CREATE INDEX IF NOT EXISTS cowork_folder_grants_scope ON cowork_folder_grants(workspace_id,source_id);`);
}

/** Host-owned timer authority. Independent of VM power and guest SDK snapshots. */
export function migrateCoworkScheduleSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_schedules (
    schedule_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
    principal_id TEXT NOT NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL,
    definition_json TEXT NOT NULL, next_due INTEGER, state TEXT NOT NULL CHECK(state IN ('enabled','cancelled','handled')),
    revision INTEGER NOT NULL CHECK(revision>0), created_at INTEGER NOT NULL,
    UNIQUE(workspace_id,principal_id,request_id)
  );
  CREATE TABLE IF NOT EXISTS cowork_schedule_occurrences (
    occurrence_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES cowork_schedules(schedule_id),
    due_at INTEGER NOT NULL, latest_due_at INTEGER NOT NULL, missed_count INTEGER NOT NULL DEFAULT 0 CHECK(missed_count>=0),
    state TEXT NOT NULL CHECK(state IN ('pending','claimed','dispatching','uncertain','handled','cancelled')),
    claim_token TEXT, reason TEXT, UNIQUE(schedule_id,due_at)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS cowork_schedule_pending ON cowork_schedule_occurrences(schedule_id) WHERE state='pending';
  CREATE UNIQUE INDEX IF NOT EXISTS cowork_schedule_active ON cowork_schedule_occurrences(schedule_id) WHERE state IN ('claimed','dispatching','uncertain');`);
}

/** Canonical host shared guidance and crash-visible file replacement debt. */
export function migrateCoworkInstructionSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_instruction_directories (
    relative_path TEXT PRIMARY KEY, identity_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cowork_instructions (
    workspace_id TEXT PRIMARY KEY REFERENCES cowork_workspaces(workspace_id),
    home_id TEXT NOT NULL REFERENCES cowork_home_identity(home_id),
    file_identity_json TEXT NOT NULL, digest TEXT NOT NULL CHECK(length(digest)=64),
    bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=65536), pending_operation TEXT,
    refresh_state TEXT NOT NULL CHECK(refresh_state IN ('refresh-required','unavailable'))
  );
  CREATE TABLE IF NOT EXISTS cowork_instruction_mutations (
    operation_id TEXT PRIMARY KEY REFERENCES cowork_operations(operation_id),
    workspace_id TEXT NOT NULL REFERENCES cowork_instructions(workspace_id),
    expected_revision INTEGER NOT NULL CHECK(expected_revision>0),
    before_digest TEXT NOT NULL CHECK(length(before_digest)=64), after_digest TEXT NOT NULL CHECK(length(after_digest)=64),
    temporary_name TEXT NOT NULL, file_identity_json TEXT NOT NULL, after_bytes INTEGER NOT NULL CHECK(after_bytes>=0 AND after_bytes<=65536)
  );`);
}

/** Schedule poison records are retained, never interpreted as runnable authority. */
export function migrateCoworkScheduleQuarantineSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_schedule_quarantines (
    schedule_id TEXT PRIMARY KEY REFERENCES cowork_schedules(schedule_id),
    reason TEXT NOT NULL CHECK(reason='invalid_schedule'), quarantined_at INTEGER NOT NULL
  );`);
}

/** Recorded host-backed output locations; neither directory contents nor manifests create authority. */
export function migrateCoworkOutputSchema(db: Database): void {
  // A journal of directories initialization is ABOUT to create, committed durably before the filesystem effect.
  // An intent is not authority: it only lets a retry adopt its own unrecorded crash/failure leftover.
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_output_directory_intents (
    relative_path TEXT PRIMARY KEY, home_id TEXT NOT NULL REFERENCES cowork_home_identity(home_id), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cowork_output_directories (
    relative_path TEXT PRIMARY KEY, home_id TEXT NOT NULL REFERENCES cowork_home_identity(home_id), identity_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cowork_output_locations (
    location_id TEXT PRIMARY KEY, home_id TEXT NOT NULL REFERENCES cowork_home_identity(home_id),
    workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
    session_id TEXT NOT NULL UNIQUE REFERENCES cowork_conversations(session_id),
    relative_path TEXT NOT NULL UNIQUE REFERENCES cowork_output_directories(relative_path),
    revision INTEGER NOT NULL CHECK(revision=1), created_at TEXT NOT NULL,
    UNIQUE(workspace_id,session_id)
  );`);
}

/** v16 storage-lifecycle bookkeeping. Records only: neither table grants access or starts anything, and an
 * imported manifest never populates them. Image pins: docs/cowork-spec.md ("Pin the writable environment to
 * its base-image digest; a new base cannot silently replace the lower layer"; "Image/runtime updates occur
 * while stopped"). Exports: docs/cowork-execution-contracts.md ("bound to one recorded export generation"). */
export function migrateCoworkStorageLifecycleSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_workspace_images (
      workspace_id TEXT PRIMARY KEY REFERENCES cowork_workspaces(workspace_id),
      base_image_digest TEXT NOT NULL CHECK(length(base_image_digest)=64 AND base_image_digest NOT GLOB '*[^0-9a-f]*'),
      runtime_image_digest TEXT NOT NULL CHECK(length(runtime_image_digest)=64 AND runtime_image_digest NOT GLOB '*[^0-9a-f]*'),
      pending_update_json TEXT, revision INTEGER NOT NULL CHECK(revision>0),
      pinned_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cowork_exports (
      export_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      generation INTEGER NOT NULL CHECK(generation>0),
      state TEXT NOT NULL CHECK(state IN ('prepared','complete','failed')),
      manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id,generation)
    );
  `);
}

/** v17 same-Project peer-message inbox: a dedicated table (not the `cowork_operations` log). One row per accepted
 * send. The body lives in `body` only while the message is owed: the CHECK makes a terminal row with a body
 * unrepresentable, so releasing the body and reaching a terminal state are one statement. The table is excluded
 * from backups (COWORK_BACKUP_EXCLUDED_TABLES) and never encrypted separately (owner decisions, 2026-10-16).
 * No foreign keys: a session id here is a name, never authority. The per-recipient counter is its own table so a
 * sequence number is never reused after rows are removed or pruned. */
export function migrateCoworkPeerInboxSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_peer_inbox_sequences (
      recipient_session_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL CHECK(last_sequence>0)
    );
    CREATE TABLE IF NOT EXISTS cowork_peer_inbox (
      receipt_id TEXT PRIMARY KEY,
      sender_session_id TEXT NOT NULL, sender_incarnation TEXT NOT NULL, send_id TEXT NOT NULL,
      recipient_session_id TEXT NOT NULL, digest TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size>=0), body BLOB,
      sequence INTEGER NOT NULL CHECK(sequence>0),
      state TEXT NOT NULL CHECK(state IN ('accepted','delivered','blocked','refused')),
      reason TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
      offered_incarnation TEXT, offered_lease_epoch INTEGER,
      delivered_incarnation TEXT, delivered_lease_epoch INTEGER,
      discarded_by TEXT, accepted_at REAL NOT NULL, updated_at REAL NOT NULL,
      version INTEGER NOT NULL CHECK(version>0),
      UNIQUE(sender_session_id,sender_incarnation,send_id),
      UNIQUE(recipient_session_id,sequence),
      CHECK((offered_incarnation IS NULL)=(offered_lease_epoch IS NULL)),
      CHECK((delivered_incarnation IS NULL)=(delivered_lease_epoch IS NULL)),
      CHECK(body IS NULL OR length(body)=size),
      CHECK(state IN ('accepted','blocked') OR body IS NULL)
    );
    CREATE INDEX IF NOT EXISTS cowork_peer_inbox_recipient ON cowork_peer_inbox(recipient_session_id,state,sequence);
    CREATE INDEX IF NOT EXISTS cowork_peer_inbox_sender ON cowork_peer_inbox(sender_session_id);
  `);
}

/** S7B's home binding table, byte for byte its `COWORK_HOME_BINDING_DDL` (cowork/host-env/stores.ts). */
/** S7B's `COWORK_HOME_BINDING_DDL` (cowork/host-env/stores.ts) must equal this text; the twin pin lands with whichever
 *  of the two merges second. */
export const COWORK_HOME_BINDING_TABLE = `CREATE TABLE IF NOT EXISTS cowork_home_binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  home_id TEXT NOT NULL UNIQUE REFERENCES cowork_home_identity(home_id),
  canonical_path TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  directory_id TEXT NOT NULL,
  origin_machine_id TEXT NOT NULL,
  origin_installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
/** Written once, enforced by the schema: an UPDATE, a DELETE or a second INSERT (an `OR REPLACE` included) aborts. Dropping the table (a downgrade of an
 *  EMPTY store) drops these with it. */
const COWORK_HOME_BINDING_WRITE_ONCE = `
CREATE TRIGGER IF NOT EXISTS cowork_home_binding_no_update BEFORE UPDATE ON cowork_home_binding BEGIN SELECT RAISE(ABORT, 'cowork_home_binding is written once'); END;
CREATE TRIGGER IF NOT EXISTS cowork_home_binding_no_delete BEFORE DELETE ON cowork_home_binding BEGIN SELECT RAISE(ABORT, 'cowork_home_binding is written once'); END;
CREATE TRIGGER IF NOT EXISTS cowork_home_binding_no_replace BEFORE INSERT ON cowork_home_binding WHEN EXISTS (SELECT 1 FROM cowork_home_binding) BEGIN SELECT RAISE(ABORT, 'cowork_home_binding is written once'); END;`;

/** v18, session door spine (D1; docs/research/2026-10-18-cowork-session-door-design.md, gaps G1 and G9). Rebuilds
 * `cowork_conversations` (SQLite's generalized ALTER TABLE: the registration sets `rebuildsParentTable`, so foreign keys are
 * off around the transaction and `foreign_key_check` must be no worse at the end) to add two facts:
 *  - `location_kind`: where the conversation works. `source` (every existing row) binds a workspace source; `outputs` binds
 *    the conversation's own outputs location, the first-session working root (owner decision O1, 2026-10-18), and has NO
 *    source and the location's own root as its cwd. The CHECK makes any other combination unrepresentable.
 *  - `backend_session_id`: the guest runtime's durable backend identity (G9), minted at bind by a later slice; NULL for
 *    every existing row. Unique when present. A Cowork conversation never gets a host `runtime_sessions` record.
 * It also creates `cowork_home_binding` for S7B (N2 integration; its store is `createCoworkHomeBindingStore` in
 * cowork/host-env/stores.ts, which exports the same text as `COWORK_HOME_BINDING_DDL`): the singleton record of which
 * prepared Mac home this Cowork home is bound to (canonical path, volume and directory ids, the machine and installation
 * it was first prepared on). Written once: triggers abort any UPDATE, DELETE or replacing INSERT of it. It is Cowork authority
 * (COWORK_TABLES), so a populated binding refuses both downgrades.
 * Records only: nothing reads the new conversation columns yet, and no row can be created through any door.
 * Idempotent: the binding table is `IF NOT EXISTS`, and a conversations table that already has `location_kind` is left
 * alone (fixtures that rewind only `user_version` replay this). */
export function migrateCoworkSessionBindingSchema(db: Database): void {
  db.exec(COWORK_HOME_BINDING_TABLE);
  db.exec(COWORK_HOME_BINDING_WRITE_ONCE);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(cowork_conversations)").all().map(column => column.name);
  if (columns.includes("location_kind")) return;
  db.exec(`
    DROP TABLE IF EXISTS cowork_conversations_v18;
    CREATE TABLE cowork_conversations_v18 (
      session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      project_id TEXT REFERENCES cowork_projects(project_id),
      location_kind TEXT NOT NULL DEFAULT 'source' CHECK(location_kind IN ('source','outputs')),
      source_id TEXT,
      relative_cwd TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('plan','dont-ask','ask','accept-edits','auto','bypass')),
      restrictions_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN ('active','archived','deleted')), created_at TEXT NOT NULL,
      backend_session_id TEXT UNIQUE CHECK(backend_session_id IS NULL OR length(backend_session_id) BETWEEN 1 AND 128),
      CHECK((location_kind='source' AND source_id IS NOT NULL) OR (location_kind='outputs' AND source_id IS NULL AND relative_cwd='.')),
      FOREIGN KEY(workspace_id,source_id) REFERENCES cowork_sources(workspace_id,source_id)
    );
    INSERT INTO cowork_conversations_v18(session_id,workspace_id,project_id,location_kind,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at,backend_session_id)
      SELECT session_id,workspace_id,project_id,'source',source_id,relative_cwd,policy,restrictions_json,revision,state,created_at,NULL FROM cowork_conversations;
    DROP TABLE cowork_conversations;
    ALTER TABLE cowork_conversations_v18 RENAME TO cowork_conversations;
    CREATE INDEX IF NOT EXISTS cowork_conversations_workspace ON cowork_conversations(workspace_id);
  `);
}

/** v19, session door D4 (docs/research/2026-10-18-cowork-session-door-d4.md): the durable first step of a Cowork
 * `session.create`. One row per (principal, workspace, requestId) reserves the conversation's session id and the digest of
 * the request it answers, in one runtime-state transaction, BEFORE the session store row or the binding exist. A retry
 * finds it and resumes at the missing step (store row, then binding); a different request under the same id is
 * `request_conflict`. `session_id` is unique, so two requests can never reserve one id, and a standalone workspace's
 * single conversation (its `owner_id`) is reserved at most once. `state` is `pending` until the binding commits, then
 * `bound`. It is Cowork authority (COWORK_TABLES), so a populated table refuses both downgrades.
 * Records only: no production door constructs the module that writes it. Idempotent (`IF NOT EXISTS`). */
export function migrateCoworkSessionReservationSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_session_reservations (
    principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
    request_id TEXT NOT NULL, request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
    session_id TEXT NOT NULL UNIQUE CHECK(session_id GLOB 's_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND length(session_id)=14),
    scope TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','bound')), created_at INTEGER NOT NULL,
    PRIMARY KEY(principal_id,workspace_id,request_id)
  );`);
}

const columnsOf = (db: Database, table: string): string[] => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(column => column.name);

/** v20, content-out (#97; definitions from that lane, DOOR owns the migration): an export's content binding.
 *  - `cowork_exports.content_digest`: lowercase hex SHA-256 of the bundle's exact `integrity.json` bytes, written once while
 *    the row is `prepared`; NULL means no binding (the restorer refuses).
 *  - `cowork_export_output_ids`: the export's reverse map from opaque output ids (`s` + 16 lowercase hex, random per session
 *    folder per export, never derived from the session id) to session ids. No foreign key on `session_id`: a session can be
 *    deleted while its export stays valid. Cowork authority (COWORK_TABLES), listed before `cowork_exports`.
 * Idempotent (rewound `user_version` replays it). */
export function migrateCoworkExportBindingSchema(db: Database): void {
  if (!columnsOf(db, "cowork_exports").includes("content_digest")) {
    db.exec("ALTER TABLE cowork_exports ADD COLUMN content_digest TEXT CHECK (content_digest IS NULL OR (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'))");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_export_output_ids (
    export_id TEXT NOT NULL REFERENCES cowork_exports(export_id),
    opaque_id TEXT NOT NULL CHECK (length(opaque_id) = 17 AND opaque_id GLOB 's*' AND substr(opaque_id, 2) NOT GLOB '*[^0-9a-f]*'),
    session_id TEXT NOT NULL,
    PRIMARY KEY (export_id, opaque_id),
    UNIQUE (export_id, session_id)
  );`);
}

/** v21, #92 host side (design section 8, DOOR rows; records only, nothing reads them yet):
 *  - `cowork_conversations`: stable guest `runtime_uid`/`tool_uid` (L7, allocated once at bind), the four-state
 *    `store_state` (`none` at bind, `started` write-ahead before the first set, `created` at the first completed turn, `lost`
 *    when the store is gone; section 3.2) and `last_incarnation_id`. Existing rows whose guest already received a set (a
 *    recorded backend) start as `started`, never `none`, so a later resume can never be told "fresh" over a real store.
 *  - `cowork_workspaces`: the data volume's `store_volume_uuid` (kept and re-sent; CR4 step 9) and the per-workspace
 *    `browse_uid` (4b.3).
 *  - KNOWN GAP, dev rows only (no backfill, deliberately): before v21 every conversation's set carried the fixed pair
 *    2001/2002 and nothing recorded it, so a pre-v21 conversation with a guest store has NO `cowork_guest_uids` row and a
 *    NULL `runtime_uid`/`tool_uid`. A backfill is not safe: several conversations of one workspace may all have stores
 *    owned by 2001/2002, and the table allows one owner per (workspace, uid). The first conversation to resume allocates
 *    the lowest free pair (2001/2002 when free), any other gets a different pair, and its old store is not owned by the new
 *    uids. That affects only pre-v21 dev stores (production has never created a Cowork guest store); such a store is
 *    recreated, never migrated in place. Every store created after v21 has its rows.
 *  - RULE for N3 (the allocator): a guest uid (runtime, tool or browse) is ONLY ever allocated through `cowork_guest_uids`,
 *    in the same transaction that writes it to `cowork_conversations`/`cowork_workspaces`; no column is ever set to a uid
 *    that has no row there, and no row is deleted before `released_at` (the trigger below).
 *  - `cowork_guest_uids`: the allocation table. One row per (workspace, uid), never reused while its owner's files may
 *    remain: a row is deleted only once `released_at` is set, and `released_at` needs `retired_at`.
 *  - `cowork_guest_boots`: the host's durable record of each guest boot at `hello`, and its end proof (the D1 evidence)
 *    after release; `endedGuestBoots` is built only from rows with a proof.
 *  - `cowork_peer_inbox` (PEER-INBOX's table; its columns come through DOOR's migration): `offer_count`,
 *    `acked_hold_token`, `commit_confirmed_at` and `commit_outcome` (4.5; `commit_confirmed_at` and `commit_outcome` are set together, enforced by a CHECK).
 * Idempotent. */
export function migrateCoworkResumeSchema(db: Database): void {
  const conversations = columnsOf(db, "cowork_conversations");
  if (!conversations.includes("runtime_uid")) db.exec("ALTER TABLE cowork_conversations ADD COLUMN runtime_uid INTEGER CHECK (runtime_uid IS NULL OR runtime_uid BETWEEN 1000 AND 65533)");
  if (!conversations.includes("tool_uid")) db.exec("ALTER TABLE cowork_conversations ADD COLUMN tool_uid INTEGER CHECK (tool_uid IS NULL OR (tool_uid BETWEEN 1000 AND 65533 AND tool_uid != runtime_uid))");
  if (!conversations.includes("store_state")) {
    db.exec("ALTER TABLE cowork_conversations ADD COLUMN store_state TEXT NOT NULL DEFAULT 'none' CHECK (store_state IN ('none','started','created','lost'))");
    db.exec("UPDATE cowork_conversations SET store_state='started' WHERE backend_session_id IS NOT NULL");
  }
  if (!conversations.includes("last_incarnation_id")) db.exec("ALTER TABLE cowork_conversations ADD COLUMN last_incarnation_id TEXT");
  const workspaces = columnsOf(db, "cowork_workspaces");
  if (!workspaces.includes("store_volume_uuid")) db.exec("ALTER TABLE cowork_workspaces ADD COLUMN store_volume_uuid TEXT CHECK (store_volume_uuid IS NULL OR (length(store_volume_uuid) = 36 AND store_volume_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'))");
  if (!workspaces.includes("browse_uid")) db.exec("ALTER TABLE cowork_workspaces ADD COLUMN browse_uid INTEGER CHECK (browse_uid IS NULL OR browse_uid BETWEEN 1000 AND 65533)");
  const peer = columnsOf(db, "cowork_peer_inbox");
  if (!peer.includes("offer_count")) db.exec("ALTER TABLE cowork_peer_inbox ADD COLUMN offer_count INTEGER NOT NULL DEFAULT 0 CHECK (offer_count >= 0)");
  if (!peer.includes("acked_hold_token")) db.exec("ALTER TABLE cowork_peer_inbox ADD COLUMN acked_hold_token TEXT CHECK (acked_hold_token IS NULL OR (length(acked_hold_token) = 64 AND acked_hold_token NOT GLOB '*[^0-9a-f]*'))");
  if (!peer.includes("commit_confirmed_at")) db.exec("ALTER TABLE cowork_peer_inbox ADD COLUMN commit_confirmed_at REAL");
  if (!peer.includes("commit_outcome")) db.exec("ALTER TABLE cowork_peer_inbox ADD COLUMN commit_outcome TEXT CHECK (commit_outcome IS NULL OR commit_outcome IN ('folded','queued','started','already','lost')) CHECK ((commit_confirmed_at IS NULL) = (commit_outcome IS NULL))");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS cowork_conversations_runtime_uid ON cowork_conversations(workspace_id, runtime_uid) WHERE runtime_uid IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS cowork_conversations_tool_uid ON cowork_conversations(workspace_id, tool_uid) WHERE tool_uid IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cowork_guest_uids (
      workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      uid INTEGER NOT NULL CHECK (uid BETWEEN 1000 AND 65533),
      role TEXT NOT NULL CHECK (role IN ('runtime','tool','browse')),
      session_id TEXT, allocated_at TEXT NOT NULL, retired_at TEXT, released_at TEXT,
      PRIMARY KEY (workspace_id, uid),
      CHECK ((role = 'browse') = (session_id IS NULL)),
      CHECK (released_at IS NULL OR retired_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cowork_guest_uids_owner ON cowork_guest_uids(workspace_id, session_id, role) WHERE session_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS cowork_guest_uids_browse ON cowork_guest_uids(workspace_id) WHERE role = 'browse';
    CREATE TRIGGER IF NOT EXISTS cowork_guest_uids_kept BEFORE DELETE ON cowork_guest_uids WHEN OLD.released_at IS NULL
      BEGIN SELECT RAISE(ABORT, 'a guest uid is kept until its files are proven removed'); END;
    CREATE TABLE IF NOT EXISTS cowork_guest_boots (
      workspace_id TEXT NOT NULL REFERENCES cowork_workspaces(workspace_id),
      incarnation_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
      guest_boot_id TEXT NOT NULL UNIQUE CHECK (length(guest_boot_id) = 36 AND guest_boot_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
      recorded_at TEXT NOT NULL,
      ended_proof TEXT CHECK (ended_proof IS NULL OR ended_proof IN ('orderly-receipt','new-boot','owner-recover')),
      ended_at TEXT,
      PRIMARY KEY (workspace_id, incarnation_id),
      CHECK ((ended_proof IS NULL) = (ended_at IS NULL))
    );`);
}
