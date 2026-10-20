import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkOutputs } from "../../src/cowork/outputs";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { SessionStore } from "../../src/sessions/store";
import { CoworkError } from "../../src/cowork/types";
export const outputUser = { kind: "local-user" as const, id: "fixture-user" };
export function outputFixture(checkpoint: (phase: string) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-output-fixture-")), db = openRuntimeStateDb(home), records = new CoworkRepository(db), store = new SessionStore(home);
  const grants = { folder: () => ({ rootIdentity: "root", writable: true, revoked: false }), repository: () => undefined };
  const made = records.create({ principalId: outputUser.id, requestId: "create" }, { ownership: "project", title: "Output fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }], ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
  const workspaceId = made.workspaceId, epoch = records.beginIncarnation(workspaceId, "fixture-incarnation", records.get(workspaceId).configRevision), sourceId = made.value.sources[0]!.sourceId;
  records.acknowledgeSource(epoch, sourceId, 1, "ready");
  function bind(requestId: string) { const sessionId = store.createSession("global", { mode: "code" }); records.bindConversation({ principalId: outputUser.id, requestId, expectedRevision: records.get(workspaceId).configRevision }, workspaceId, { sessionId, sourceId }, store); return sessionId; }
  const sessionId = bind("bind-first");
  // Authority fixture transition only: no worker was ever launched or mounted.
  db.transaction(() => db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [workspaceId]));
  const host: CoworkHostPorts = { principal: () => outputUser, grants, selection: () => undefined, creationCeiling: () => undefined, requireProvisioning: () => { throw new Error("must never provision"); } };
  const service = new CoworkWorkspaceService(records, host, undefined, home);
  let instance: CoworkOutputs | undefined;
  return { home, db, records, store, grants, workspaceId, sessionId, host, service, bind,
    root: join(resolve(home), "cowork/workspaces", workspaceId, "shared/outputs", sessionId),
    get outputs() { return instance ??= new CoworkOutputs(records, home, grants, checkpoint); },
    initialize() { this.outputs.initialize(workspaceId, sessionId, store); return this.outputs.list(outputUser, { workspaceId }).locations[0]!; },
    close() { store.close(); db.close(); rmSync(home, { force: true, recursive: true }); },
  };
}
