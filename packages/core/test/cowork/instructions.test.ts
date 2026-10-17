import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync, symlinkSync, linkSync, statfsSync, readdirSync, existsSync, fstatSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { CoworkInstructionUpdate, CoworkInstructionRead, CoworkInstructionProvenance, CoworkInstructionMetadata, COWORK_INSTRUCTION_MAX_BYTES } from "@yanlinglabs/winter-protocol";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, downgradeCoworkRuntimeStateToV7 } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkInstructions, type InstructionUpdate } from "../../src/cowork/instructions";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { CoworkWorkspaceEvents } from "../../src/cowork/workspace-events";
import { ApprovalBroker } from "../../src/agent/approvals";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { CoworkError, type CoworkErrorCode } from "../../src/cowork/types";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const user = { kind: "local-user" as const, id: "user" };
const supported = process.platform === "darwin" && process.arch === "arm64";
const unavailable: CoworkErrorCode = supported ? "recovery_required" : "unsupported_topology";
const grants = { folder: () => ({ rootIdentity: "root", writable: true, revoked: false }), repository: () => undefined };
export function instructionFixture(checkpoint: (phase: string) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-instructions-")); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = openRuntimeStateDb(home); cleanups.push(() => db.close());
  const records = new CoworkRepository(db), store = new SessionStore(home); cleanups.push(() => store.close());
  const hub = new SessionHub(store), broker = new ApprovalBroker();
  const made = records.create({ principalId: user.id, requestId: "create" }, { ownership: "project", title: "Fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }], ceiling: { toolClasses: ["read", "write"], hostServices: ["workspace.instructions.update"], connectors: [], network: "none" } });
  const workspaceId = made.workspaceId;
  let owned: CoworkInstructions | undefined;
  const owner = () => owned ??= new CoworkInstructions(records, home, grants, { broker, emit: (sessionId, event) => { hub.append(sessionId, event); } }, checkpoint);
  const root = join(resolve(home), "cowork/workspaces", workspaceId, "shared/instructions"), path = join(root, "WINTER.md");
  const host: CoworkHostPorts = { principal: () => user, grants, selection: () => undefined, creationCeiling: () => undefined, requireProvisioning: () => { throw new CoworkError("unsupported_topology"); } };
  const service = new CoworkWorkspaceService(records, host, undefined, home);
  return { home, db, records, store, hub, broker, get owner() { return owner(); }, workspaceId, root, path, host, service,
    input(content: string, requestId = "change"): InstructionUpdate { const value = owner().get(user, workspaceId); return { workspaceId, content, requestId, expectedInstructionRevision: value.instructionRevision, expectedDigest: value.digest }; },
    bind() { const epoch = records.beginIncarnation(workspaceId, "fixture-incarnation", records.get(workspaceId).configRevision), sourceId = made.value.sources[0]!.sourceId; records.acknowledgeSource(epoch, sourceId, 1, "ready"); const sessionId = store.createSession("global", { mode: "code" }); records.bindConversation({ principalId: "user", requestId: "bind", expectedRevision: records.get(workspaceId).configRevision }, workspaceId, { sessionId, sourceId }, store); return { kind: "runtime" as const, id: "runtime", sessionId, workspaceId }; },
  };
}
const fixture = instructionFixture;
function refusal(fn: () => unknown, code: CoworkErrorCode) { try { fn(); throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(CoworkError); expect((error as CoworkError).code).toBe(code); } }
const native = process.platform === "darwin" && process.arch === "arm64" && process.env.WINTER_COWORK_INSTRUCTION_FS_FIXTURE === "1" ? test : test.skip;
test("strict content schema refuses client paths/approval flags and bounds UTF-8 before effects", () => {
 const valid = { workspaceId: "workspace", requestId: "request", expectedInstructionRevision: 1, expectedDigest: "a".repeat(64), content: "guidance" };
 expect(CoworkInstructionUpdate.safeParse(valid).success).toBe(true);
 expect(CoworkInstructionMetadata.safeParse({ workspaceId: "workspace", instructionRevision: 1, digest: valid.expectedDigest, bytes: 0, refreshState: "unavailable" }).success).toBe(true);
 expect(CoworkInstructionUpdate.safeParse({ ...valid, content: "\ufeffvalid-bom" }).success).toBe(true);
 for (const field of ["path", "root", "approved", "approvalId", "expectedRevision"]) expect(CoworkInstructionUpdate.safeParse({ ...valid, [field]: "attacker" }).success).toBe(false);
 expect(CoworkInstructionUpdate.safeParse({ ...valid, content: "😀".repeat(COWORK_INSTRUCTION_MAX_BYTES / 4) }).success).toBe(true);
 expect(CoworkInstructionUpdate.safeParse({ ...valid, content: "😀".repeat(COWORK_INSTRUCTION_MAX_BYTES / 4 + 1) }).success).toBe(false);
 expect(CoworkInstructionUpdate.safeParse({ ...valid, content: "bad\0content" }).success).toBe(false);
 expect(CoworkInstructionUpdate.safeParse({ ...valid, content: "\ud800" }).success).toBe(false);
});
test("schema13 retains authority and missing backing remains unavailable without seeding", () => {
 const f = fixture(); expect(f.db.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION); expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(16);
 refusal(() => f.owner.get(user, f.workspaceId), unavailable); expect(() => downgradeCoworkRuntimeStateToV7(f.home)).toThrow("Cowork authority"); expect(f.db.integrity().ok).toBe(true);
 expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_directories").get()).toEqual({ n: 0 });
});
test("management service refuses runtime/paired guidance calls before backing access", () => {
 const f = fixture(); refusal(() => f.service.call({ role: "harness", connectionId: 1 }, "workspace.instructions.get", { workspaceId: f.workspaceId }), unavailable);
 f.host.principal = () => ({ kind: "paired-user", id: "phone", workspaceIds: new Set([f.workspaceId]), repositoryAuthorities: new Set() });
 refusal(() => f.service.call({ role: "remote", connectionId: 2 }, "workspace.instructions.get", { workspaceId: f.workspaceId }), "authority_denied");
 f.host.principal = () => ({ kind: "runtime", id: "guest", workspaceId: f.workspaceId, sessionId: "session" });
 refusal(() => f.service.call({ role: "harness", connectionId: 3 }, "workspace.instructions.update", {}), "authority_denied");
});
test("unsupported platform is typed before any filesystem admission and leaves service usable", () => {
 const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
 try {
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  refusal(() => new CoworkInstructions(f.records, f.home, grants), "unsupported_topology");
  const service = new CoworkWorkspaceService(f.records, f.host, undefined, f.home);
  expect(service.instructions).toBeUndefined(); refusal(() => service.call({ role: "harness", connectionId: 1 }, "workspace.instructions.get", { workspaceId: f.workspaceId }), "unsupported_topology");
  expect(f.records.get(f.workspaceId).state).toBe("retained"); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_directories").get()).toEqual({ n: 0 });
 } finally { Object.defineProperty(process, "platform", descriptor); }
});
native("real files update and replay; normal external editor saves advance revisions and safe provenance", () => {
 const f = fixture(); f.owner.initialize(f.workspaceId, "shared:first"); const first = f.owner.get(user, f.workspaceId); expect(CoworkInstructionRead.parse(first).contentBase64).toBe(Buffer.from("shared:first").toString("base64"));
 const input = f.input("shared:new"), receipt = f.owner.update(user, input); expect(readFileSync(f.path, "utf8")).toBe("shared:new"); expect(receipt.value.instructionRevision).toBe(2); expect(f.owner.update(user, input)).toEqual(receipt);
 refusal(() => f.owner.update(user, { ...input, content: "substitute" }), "request_conflict");
 const replacement = join(f.root, "editor-save"); writeFileSync(replacement, "direct-user", { mode: 0o600 }); renameSync(replacement, f.path);
 const observed = f.owner.get(user, f.workspaceId); expect(observed.instructionRevision).toBe(3); expect(Buffer.from(observed.contentBase64, "base64").toString()).toBe("direct-user");
 const provenance = CoworkInstructionProvenance.parse(f.owner.provenance(user, f.workspaceId)); expect(provenance.sourceDiscovery).toBe("unavailable"); expect(JSON.stringify(provenance)).not.toContain(f.home);
 const reopened = new CoworkInstructions(f.records, f.home, grants); expect(reopened.get(user, f.workspaceId)).toEqual(observed); refusal(() => reopened.initialize(f.workspaceId, "empty"), "request_conflict");
});
native("size, symlink, hardlink, missing data and replaced ancestor refuse actual backing access", () => {
 for (const attack of ["symlink", "hardlink", "large", "ancestor", "missing"] as const) {
  const f = fixture(); f.owner.initialize(f.workspaceId, "original"); const outside = join(f.home, `outside-${attack}`); writeFileSync(outside, "outside", { mode: 0o600 });
  if (attack === "ancestor") { renameSync(f.root, `${f.root}-moved`); symlinkSync(dirname(outside), f.root); }
  else { rmSync(f.path); if (attack === "symlink") symlinkSync(outside, f.path); if (attack === "hardlink") linkSync(outside, f.path); if (attack === "large") writeFileSync(f.path, "x".repeat(COWORK_INSTRUCTION_MAX_BYTES + 1), { mode: 0o600 }); }
  refusal(() => f.owner.get(user, f.workspaceId), "recovery_required"); expect(readFileSync(outside, "utf8")).toBe("outside");
 }
 const f = fixture(); mkdirSync(f.root, { recursive: true, mode: 0o700 }); refusal(() => f.owner.initialize(f.workspaceId, "not-a-seed"), "recovery_required");
});
native("journal and pre-replace ancestry failures abort known unapplied debt but retain refused orphan", () => {
 for (const faultPhase of ["journal-durable", "before-replace"]) {
  let attacked = false; const f = fixture(phase => { if (phase === faultPhase && !attacked) { attacked = true; renameSync(f.root, `${f.root}-held`); mkdirSync(f.root, { mode: 0o700 }); writeFileSync(f.path, "unauthorized replacement", { mode: 0o600 }); } });
  f.owner.initialize(f.workspaceId, "old"); refusal(() => f.owner.update(user, f.input("new")), "recovery_required");
  expect(readFileSync(f.path, "utf8")).toBe("unauthorized replacement"); expect(readFileSync(join(`${f.root}-held`, "WINTER.md"), "utf8")).toBe("old");
  expect(f.db.db.query("SELECT status FROM cowork_operations WHERE method='workspace.instructions.update'").get()).toEqual({ status: "failed" }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 0 });
  expect(f.db.db.query("SELECT pending_operation FROM cowork_instructions").get()).toEqual({ pending_operation: null });
  expect(readdirSync(`${f.root}-held`).filter(name => name.startsWith("instruction-") && name.endsWith(".tmp"))).toHaveLength(1); expect(readdirSync(f.root)).toEqual(["WINTER.md"]);
  refusal(() => f.owner.get(user, f.workspaceId), "recovery_required");
 }
});
native("postreplacement crash reconciles only exact persisted vnode+digest and emits one instruction event", () => {
 let crash = true; const f = fixture(phase => { if (phase === "file-replaced" && crash) { crash = false; throw new Error("crash"); } }); f.owner.initialize(f.workspaceId, "old");
 const runtime = f.bind(), pump = new CoworkWorkspaceEvents(f.records, f.store, f.hub); pump.drain(); const input = f.input("committed"); refusal(() => f.owner.update(user, input), "recovery_required"); expect(readFileSync(f.path, "utf8")).toBe("committed");
 const owner = new CoworkInstructions(f.records, f.home, grants), value = owner.get(user, f.workspaceId); expect(value.instructionRevision).toBe(2); const { contentBase64, encoding, ...metadata } = value; expect(owner.update(user, input).value).toEqual(metadata);
 pump.drain(); const events = f.store.read(runtime.sessionId).filter(event => event.type === "workspace_instructions_changed"); expect(events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain("committed");
});
native("actual Broker approval binds copied content and rechecks revision/grants after waiting", async () => {
 const f = fixture(); f.owner.initialize(f.workspaceId, "old"); const runtime = f.bind(), input = f.input("approved-original"), controller = new AbortController();
 const original = { ...input };
 const pending = f.owner.updateAgent(runtime, input, controller.signal); input.content = "mutated-caller-input";
 const approval = f.broker.list(runtime.sessionId)[0]!; expect(approval.summary).toContain(f.workspaceId); expect(approval.summary).toContain(original.expectedDigest); expect(approval.summary).toContain("approved-original"); expect(approval.summary).not.toContain("mutated-caller-input"); f.broker.resolve(runtime.sessionId, approval.callId, true, "fixture-user"); const receipt = await pending; expect(readFileSync(f.path, "utf8")).toBe("approved-original");
 const count = f.store.read(runtime.sessionId).filter(event => event.type === "approval_requested").length;
 expect(await f.owner.updateAgent(runtime, original, controller.signal)).toEqual(receipt); expect(f.broker.list(runtime.sessionId)).toHaveLength(0);
 expect(f.store.read(runtime.sessionId).filter(event => event.type === "approval_requested")).toHaveLength(count);
 await expect(f.owner.updateAgent(runtime, { ...original, content: "replay substitution" }, controller.signal)).rejects.toThrow("request_conflict"); expect(f.broker.list(runtime.sessionId)).toHaveLength(0);
 const stale = f.owner.updateAgent(runtime, f.input("must-not-apply", "stale"), controller.signal), oldApproval = f.broker.list(runtime.sessionId)[0]!;
 f.owner.update(user, f.input("user-change", "user-change")); f.broker.resolve(runtime.sessionId, oldApproval.callId, true, "fixture-user"); await expect(stale).rejects.toThrow("revision_conflict"); expect(readFileSync(f.path, "utf8")).toBe("user-change");
 const revoked = f.owner.updateAgent(runtime, f.input("revoked", "revoked"), controller.signal), revokeApproval = f.broker.list(runtime.sessionId)[0]!;
 f.records.removeSource({ principalId: "user", requestId: "revoke", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, f.records.binding(runtime.sessionId).sourceId, true);
 f.broker.resolve(runtime.sessionId, revokeApproval.callId, true, "fixture-user"); await expect(revoked).rejects.toThrow("source_unavailable"); expect(readFileSync(f.path, "utf8")).toBe("user-change");
});

native("reviewed fullsync completes for owned file and held APFS directory on pinned Bun", () => {
  const f = fixture();
  expect(Bun.version).toBe("1.3.14"); expect(Bun.revision.startsWith("0d9b296a")).toBe(true);
  const fsType = statfsSync(f.home).type;
  expect(fsType).toBe(0x1a);
  // initialize requests file F_FULLFSYNC and held-directory F_FULLFSYNC; update
  // does the same around descriptor-relative rename. No fallback is used.
  f.owner.initialize(f.workspaceId, "fullsync"); f.owner.update(user, f.input("fullsync-new"));
  console.info(JSON.stringify({ fixture: "instruction-fullsync", bun: Bun.version, bunRevision: Bun.revision, filesystemType: fsType, fileRequestCompleted: true, directoryRequestCompleted: true, hardwarePowerCutProof: false }));
});

native("known no-rename checkpoint and real renameat errors abort debt without changing the saved file", () => {
 for (const phase of ["journal-durable", "before-replace", "rename-error"] as const) {
  let fault = true, temporary = ""; const f = fixture(current => { if (fault && current === (phase === "rename-error" ? "before-replace" : phase)) { fault = false; const debt = f.db.db.query<any, []>("SELECT * FROM cowork_instruction_mutations").get()!; temporary = debt.temporary_name; if (phase === "rename-error") rmSync(join(f.root, temporary)); else throw new Error("known no rename"); } });
  f.owner.initialize(f.workspaceId, "old"); const input = f.input("new"); refusal(() => f.owner.update(user, input), "recovery_required");
  expect(readFileSync(f.path, "utf8")).toBe("old"); expect(f.owner.get(user, f.workspaceId).instructionRevision).toBe(1);
  expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "failed" }); expect(f.db.db.query("SELECT pending_operation FROM cowork_instructions").get()).toEqual({ pending_operation: null });
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 0 }); expect(existsSync(join(f.root, temporary))).toBe(false);
  expect(f.db.db.query("SELECT payload_json FROM cowork_outbox WHERE kind='workspace_operation_changed'").get()).toEqual({ payload_json: JSON.stringify({ status: "failed", terminal: true }) });
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_outbox WHERE kind='workspace_instructions_changed'").get()).toEqual({ n: 0 }); expect(f.owner.update(user, { ...input, requestId: "retry-new-request" }).value.instructionRevision).toBe(2);
 }
});
native("SQLite restoration throw after journal COMMIT aborts safely or preserves temp if durable abort fails", () => {
 for (const abortFails of [false, true]) {
  const f = fixture(); f.owner.initialize(f.workspaceId, "old"); const input = f.input("new"), run = f.db.db.run.bind(f.db.db); let thrown = false, temporary = "";
  f.db.db.run = ((...args: any[]) => { if (abortFails && String(args[0]).startsWith("UPDATE cowork_operations SET status='failed'")) throw new Error("abort SQL unavailable"); const result = (run as any)(...args); if (!thrown && args[0] === "PRAGMA main.synchronous = 1") { thrown = true; temporary = f.db.db.query<any, []>("SELECT * FROM cowork_instruction_mutations").get()!.temporary_name; throw new Error("post-COMMIT restore failure"); } return result; }) as typeof f.db.db.run;
  try { refusal(() => f.owner.update(user, input), "recovery_required"); } finally { f.db.db.run = run; }
  expect(thrown).toBe(true); expect(existsSync(join(f.root, temporary))).toBe(abortFails); expect(readFileSync(f.path, "utf8")).toBe("old");
  expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: abortFails ? "pending" : "failed" });
  const reopened = openRuntimeStateDb(f.home); cleanups.push(() => reopened.close());
  const restarted = new CoworkInstructions(new CoworkRepository(reopened), f.home, grants); expect(restarted.get(user, f.workspaceId).instructionRevision).toBe(1);
  expect(existsSync(join(f.root, temporary))).toBe(false); expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "failed" }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 0 });
 }
});
native("editor save after rename supersedes debt only when recorded temp is gone", () => {
 for (const retainedTemp of [false, true]) {
  let edited = false; const f = fixture(phase => { if (phase === "file-replaced" && !edited) { edited = true; const editor = join(f.root, "editor"); writeFileSync(editor, "editor wins", { mode: 0o600 }); renameSync(editor, f.path); if (retainedTemp) { const debt = f.db.db.query<any, []>("SELECT * FROM cowork_instruction_mutations").get()!; writeFileSync(join(f.root, debt.temporary_name), "ambiguous", { mode: 0o600 }); } } });
  f.owner.initialize(f.workspaceId, "old"); refusal(() => f.owner.update(user, f.input("new")), "recovery_required");
  const owner = new CoworkInstructions(f.records, f.home, grants);
  if (retainedTemp) { refusal(() => owner.get(user, f.workspaceId), "recovery_required"); expect(f.db.db.query("SELECT status FROM cowork_operations WHERE method='workspace.instructions.update'").get()).toEqual({ status: "pending" }); }
  else { const value = owner.get(user, f.workspaceId); expect(Buffer.from(value.contentBase64, "base64").toString()).toBe("editor wins"); expect(value.instructionRevision).toBe(2); expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "superseded" }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_outbox WHERE kind='workspace_instructions_changed'").get()).toEqual({ n: 1 }); }
  expect(readFileSync(f.path, "utf8")).toBe("editor wins");
 }
});
/** Process death after the journal commit and before renameat. The update's checkpoint throws and the abort SQL is
 * unavailable, so (exactly as after a real crash) the pending operation, the journal row and the recorded temp remain. */
function crashBeforeRename(content = "proposal") {
 let crashed = false;
 const f = fixture(phase => { if (phase === "before-replace" && !crashed) { crashed = true; throw new Error("crash before renameat"); } });
 f.owner.initialize(f.workspaceId, "old"); const input = f.input(content), run = f.db.db.run.bind(f.db.db);
 f.db.db.run = ((...args: any[]) => { if (String(args[0]).startsWith("UPDATE cowork_operations SET status='failed'")) throw new Error("process died"); return (run as any)(...args); }) as typeof f.db.db.run;
 try { refusal(() => f.owner.update(user, input), "recovery_required"); } finally { f.db.db.run = run; }
 const debt = f.db.db.query<any, []>("SELECT * FROM cowork_instruction_mutations").get()!, temp = join(f.root, debt.temporary_name);
 expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "pending" });
 expect(readFileSync(temp, "utf8")).toBe(content); expect(readFileSync(f.path, "utf8")).toBe("old");
 return { f, input, temp, debt };
}
const editorSave = (f: ReturnType<typeof fixture>, content = "editor wins") => { const editor = join(f.root, "editor"); writeFileSync(editor, content, { mode: 0o600 }); renameSync(editor, f.path); };
const count = (f: ReturnType<typeof fixture>, kind: string) => (f.db.db.query<any, [string]>("SELECT count(*) AS n FROM cowork_outbox WHERE kind=?").get(kind) as { n: number }).n;
native("crash before rename then a user save: the verified orphan temp is removed, the user's file wins and the update is superseded", () => {
 for (const save of ["editor replacement", "in-place write"] as const) {
  const { f, input, temp } = crashBeforeRename();
  if (save === "editor replacement") editorSave(f); else writeFileSync(f.path, "editor wins");
  const saved = statSync(f.path);
  const owner = new CoworkInstructions(f.records, f.home, grants), value = owner.get(user, f.workspaceId);
  expect(Buffer.from(value.contentBase64, "base64").toString()).toBe("editor wins"); expect(value.instructionRevision).toBe(2);
  expect(readFileSync(f.path, "utf8")).toBe("editor wins"); expect(statSync(f.path).ino).toBe(saved.ino); expect(statSync(f.path).mtimeMs).toBe(saved.mtimeMs);
  expect(existsSync(temp)).toBe(false); expect(readdirSync(f.root)).toEqual(["WINTER.md"]);
  expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "superseded" });
  expect(f.db.db.query("SELECT pending_operation FROM cowork_instructions").get()).toEqual({ pending_operation: null }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 0 });
  expect(f.db.db.query("SELECT payload_json FROM cowork_outbox WHERE kind='workspace_operation_changed'").get()).toEqual({ payload_json: JSON.stringify({ status: "superseded", terminal: true }) });
  expect(count(f, "workspace_instructions_changed")).toBe(1);
  // The replay of the superseded request is refused, never silently re-applied; a new request works on the user's file.
  refusal(() => owner.update(user, input), "recovery_required"); expect(readFileSync(f.path, "utf8")).toBe("editor wins");
  expect(owner.update(user, { ...f.input("after repair", "retry-new-request") }).value.instructionRevision).toBe(3); expect(readFileSync(f.path, "utf8")).toBe("after repair");
 }
});
native("crash before rename then a user save: a temp that is not the recorded file is never removed and recovery stays required", () => {
 for (const tamper of ["overwritten in place", "same-length overwrite", "recreated with the same bytes", "extra hard link", "symlink", "directory"] as const) {
  const { f, temp } = crashBeforeRename(), outside = join(f.home, "outside-target"); writeFileSync(outside, "outside", { mode: 0o600 });
  if (tamper === "overwritten in place") writeFileSync(temp, "tampered!");
  if (tamper === "same-length overwrite") writeFileSync(temp, "PROPOSAL");
  if (tamper === "recreated with the same bytes") { rmSync(temp); writeFileSync(temp, "proposal", { mode: 0o600 }); }
  if (tamper === "extra hard link") linkSync(temp, join(f.root, "alias"));
  if (tamper === "symlink") { rmSync(temp); symlinkSync(outside, temp); }
  if (tamper === "directory") { rmSync(temp); mkdirSync(temp, { mode: 0o700 }); }
  editorSave(f); const saved = statSync(f.path);
  const owner = new CoworkInstructions(f.records, f.home, grants);
  refusal(() => owner.get(user, f.workspaceId), "recovery_required"); refusal(() => owner.get(user, f.workspaceId), "recovery_required");
  const kept = lstatSync(temp); expect(tamper === "symlink" ? kept.isSymbolicLink() : tamper === "directory" ? kept.isDirectory() : kept.isFile()).toBe(true);
  if (tamper === "extra hard link") expect(lstatSync(join(f.root, "alias")).ino).toBe(kept.ino);
  if (tamper === "overwritten in place") expect(readFileSync(temp, "utf8")).toBe("tampered!");
  if (tamper === "same-length overwrite") expect(readFileSync(temp, "utf8")).toBe("PROPOSAL");
  expect(readFileSync(outside, "utf8")).toBe("outside"); expect(readFileSync(f.path, "utf8")).toBe("editor wins"); expect(statSync(f.path).ino).toBe(saved.ino);
  expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "pending" }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 1 });
  expect(count(f, "workspace_operation_changed")).toBe(0); expect(f.records.get(f.workspaceId).instructionRevision).toBe(1);
 }
});
native("a crash during the orphan repair itself leaves the existing superseded state and the next recovery completes it once", () => {
 const { f, temp } = crashBeforeRename(); editorSave(f);
 let crashed = false; const owner = new CoworkInstructions(f.records, f.home, grants, undefined, phase => { if (phase === "orphan-temporary-removed" && !crashed) { crashed = true; throw new Error("crash after unlink"); } });
 refusal(() => owner.get(user, f.workspaceId), "recovery_required"); expect(crashed).toBe(true);
 expect(existsSync(temp)).toBe(false); expect(readFileSync(f.path, "utf8")).toBe("editor wins");
 expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "pending" }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 1 });
 const restarted = new CoworkInstructions(f.records, f.home, grants), value = restarted.get(user, f.workspaceId);
 expect(Buffer.from(value.contentBase64, "base64").toString()).toBe("editor wins"); expect(value.instructionRevision).toBe(2);
 expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "superseded" }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 0 });
 expect(count(f, "workspace_operation_changed")).toBe(1); expect(count(f, "workspace_instructions_changed")).toBe(1); expect(restarted.get(user, f.workspaceId).instructionRevision).toBe(2);
});
native("immediate pre-rename editor conflict aborts known unapplied debt and next read absorbs the user save", () => {
 let edited = false; const f = fixture(phase => { if (phase === "before-replace" && !edited) { edited = true; const editor = join(f.root, "editor"); writeFileSync(editor, "editor wins", { mode: 0o600 }); renameSync(editor, f.path); } });
 f.owner.initialize(f.workspaceId, "old"); refusal(() => f.owner.update(user, f.input("new")), "revision_conflict");
 expect(readFileSync(f.path, "utf8")).toBe("editor wins");
 expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "failed" }); expect(f.db.db.query("SELECT pending_operation FROM cowork_instructions").get()).toEqual({ pending_operation: null });
 expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 0 }); expect(readdirSync(f.root).filter(name => name.startsWith("instruction-") && name.endsWith(".tmp"))).toEqual([]);
 const value = new CoworkInstructions(f.records, f.home, grants).get(user, f.workspaceId); expect(Buffer.from(value.contentBase64, "base64").toString()).toBe("editor wins"); expect(value.instructionRevision).toBe(2);
});
native("directory validation fault closes its actual just-opened root descriptor", () => {
 const root = statSync("/", { bigint: true });
 const holdsRoot = (fd: number) => { try { const value = fstatSync(fd, { bigint: true }); return value.isDirectory() && value.dev === root.dev && value.ino === root.ino; } catch { return false; } };
 const rootFds = () => readdirSync("/dev/fd").map(Number).filter(holdsRoot);
 let fault = false, before = new Set<number>(), opened: number[] = [];
 const f = fixture(phase => { if (phase === "directory-opened" && fault) { opened = rootFds().filter(fd => !before.has(fd)); throw new Error("identity fault"); } }); f.owner.initialize(f.workspaceId, "old"); fault = true;
 // Other asynchronous sockets can close between observations; global FD count
 // is not ownership evidence. Track the root vnode opened by this exact call.
 for (let i = 0; i < 10; i++) {
  before = new Set(rootFds()); opened = [];
  refusal(() => f.owner.get(user, f.workspaceId), "recovery_required");
  expect(opened).toHaveLength(1);
  try { const current = fstatSync(opened[0]!, { bigint: true }); expect(current.isDirectory() && current.dev === root.dev && current.ino === root.ino).toBe(false); }
  catch (error) { expect(error).toMatchObject({ code: "EBADF" }); }
 }
});

native("known no-rename abort refuses changed canonical mutation and preserves original conflict and temp", () => {
 let edited = false; const f = fixture(phase => { if (phase === "before-replace" && !edited) { edited = true; const editor = join(f.root, "editor"); writeFileSync(editor, "editor wins", { mode: 0o600 }); renameSync(editor, f.path); f.db.db.run("UPDATE cowork_instruction_mutations SET temporary_name='instruction-00000000-0000-0000-0000-000000000000.tmp'"); } });
 f.owner.initialize(f.workspaceId, "old"); refusal(() => f.owner.update(user, f.input("new")), "revision_conflict");
 expect(f.db.db.query("SELECT status FROM cowork_operations WHERE request_id='change'").get()).toEqual({ status: "pending" }); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_instruction_mutations").get()).toEqual({ n: 1 });
 expect(readdirSync(f.root).filter(name => name.startsWith("instruction-") && name.endsWith(".tmp"))).toHaveLength(1); expect(readFileSync(f.path, "utf8")).toBe("editor wins");
});
