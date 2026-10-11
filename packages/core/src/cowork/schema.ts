import type { Database } from "bun:sqlite";

/** Reverse dependency order also permits removing an unused additive schema on explicit rollback. */
export const COWORK_TABLES = ["cowork_outbox_deliveries", "cowork_outbox", "cowork_conversations", "cowork_projects", "cowork_policies", "cowork_sources", "cowork_operations", "cowork_workspaces", "cowork_home_identity"] as const;

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
