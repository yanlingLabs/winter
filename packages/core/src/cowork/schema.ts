import type { Database } from "bun:sqlite";

/** Reverse dependency order also permits removing an unused additive schema on explicit rollback. */
export const COWORK_TABLES = ["cowork_exports", "cowork_workspace_images", "cowork_output_directory_intents", "cowork_output_locations", "cowork_output_directories", "cowork_schedule_quarantines", "cowork_instruction_mutations", "cowork_instructions", "cowork_instruction_directories", "cowork_schedule_occurrences", "cowork_schedules", "cowork_folder_grants", "cowork_volumes", "cowork_volume_directories", "cowork_outbox_deliveries", "cowork_outbox", "cowork_conversations", "cowork_projects", "cowork_policies", "cowork_sources", "cowork_operations", "cowork_workspaces", "cowork_home_identity"] as const;

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
