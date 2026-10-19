import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import { CoworkAuthority } from "../../src/cowork/authority";
import { CoworkRepository } from "../../src/cowork/repository";
import type { CoworkGuestConversationContext, CoworkProviderRoute, CoworkProviderRouteScope } from "../../src/cowork/session-ports";
import type { SourceAccess } from "../../src/cowork/types";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { authorityFixtureSessions } from "./committed-sessions";

/*
 * Session door D3 test fixture: a real repository and authority with one folder source and bound conversations, in a temp
 * home. The workspace is left STOPPED (no incarnation), the way the driver finds it before a guest starts; `begin` is what a
 * native start does first (S7B's host): begin the incarnation and acknowledge the source.
 */

export const FIXTURE_BOOT_ID = "12345678-1234-4234-8234-123456789abc";
export const FIXTURE_MODEL = "winter-test/standin";

/** The stand-in route the tests inject (production injects none). Public metadata only. */
export function standinRoute(over: { model?: string; plan?: CoworkProviderRoute["plan"] } = {}): CoworkProviderRoute {
  const model = over.model ?? FIXTURE_MODEL;
  return {
    kind: "scripted-standin", model,
    plan: over.plan ?? (({ scope }: { scope: CoworkProviderRouteScope }) => ({ model, provider: { scope, selection: { providerId: "standin", modelKey: model, providerModelId: "standin-1", family: "standin", protocol: "scripted", capabilities: ["tools"] } } })),
  };
}

export interface DoorFixture {
  readonly home: string; readonly db: RuntimeStateDb; readonly records: CoworkRepository; readonly authority: CoworkAuthority;
  readonly workspaceId: string; readonly sourceId: string;
  /** Begins an incarnation as the native host does and returns the context it reports at `mounted`. */
  begin(incarnationId?: string): CoworkGuestConversationContext;
  /** Sets the workspace's power directly (the native power ledger's job; tests only). */
  power(to: "stopped" | "starting" | "running" | "draining" | "uncertain"): void;
  revoke(): void;
  close(): void;
}

export function doorFixture(opts: { policy?: ApprovalPolicy; toolClasses?: string[]; access?: SourceAccess; relativeCwd?: string; sessions?: readonly string[]; network?: "none" | "internet" } = {}): DoorFixture {
  const home = mkdtempSync(join(tmpdir(), "winter-door-d3-"));
  const db = openRuntimeStateDb(home), records = new CoworkRepository(db), access = opts.access ?? "read-write";
  const created = records.create({ principalId: "fixture", requestId: "create" }, { ownership: "project", title: "fixture", defaultPolicy: opts.policy ?? "ask",
    ceiling: { toolClasses: opts.toolClasses ?? ["read", "write", "execute"], hostServices: [], connectors: [], network: opts.network ?? "none" },
    sources: [{ kind: "folder", access, label: "fixture", detail: { grantRef: "grant", rootIdentity: "root" } }] });
  const workspaceId = created.workspaceId, source = records.sources(workspaceId)[0]!;
  let revoked = false;
  const authority = new CoworkAuthority(records, { folder: () => ({ rootIdentity: "root", writable: access === "read-write", revoked }), repository: () => undefined });
  // Bind under a first incarnation (the source must be ready), then stop it: the driver finds a stopped workspace.
  const first = records.beginIncarnation(workspaceId, "setup", records.get(workspaceId).configRevision);
  records.acknowledgeSource(first, source.sourceId, source.revision, "ready");
  const sessions = opts.sessions ?? ["conversation"];
  sessions.forEach((sessionId, index) => records.bindConversation({ principalId: "fixture", requestId: `bind-${index}`, expectedRevision: records.get(workspaceId).configRevision }, workspaceId,
    { sessionId, sourceId: source.sourceId, ...(opts.relativeCwd === undefined ? {} : { relativeCwd: opts.relativeCwd }) }, authorityFixtureSessions(...sessions)));
  const power = (to: string) => { db.db.run("UPDATE cowork_workspaces SET power=? WHERE workspace_id=?", [to, workspaceId]); };
  power("stopped");
  return {
    home, db, records, authority, workspaceId, sourceId: source.sourceId,
    begin(incarnationId = "incarnation") {
      const epoch = records.beginIncarnation(workspaceId, incarnationId, records.get(workspaceId).configRevision);
      const current = records.source(workspaceId, source.sourceId);
      records.acknowledgeSource(epoch, source.sourceId, current.revision, "ready");
      return { workspaceId, incarnationId, leaseEpoch: epoch.leaseEpoch, guestBootId: FIXTURE_BOOT_ID };
    },
    power,
    revoke() { revoked = true; },
    close() { db.close(); rmSync(home, { recursive: true, force: true }); },
  };
}
