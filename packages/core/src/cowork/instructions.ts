import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, readSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CoworkInstructionUpdate, COWORK_INSTRUCTION_MAX_BYTES } from "@yanlinglabs/winter-protocol";
import { AT_FDCWD, FdError, createFileAt, mkdirAt, openDirAt, unlinkAt } from "../computer-use/browser/fd-fs";
import { ApprovalBroker } from "../agent/approvals";
import type { EventInput } from "../sessions/store";
import { CoworkAuthority, type CoworkGrantResolver, type CoworkPrincipal } from "./authority";
import type { CoworkRepository } from "./repository";
import { CoworkError } from "./types";
import { coworkHostDecision } from "./host-policy";
import { durableCoworkTransaction } from "./durable-transaction";
import { fullSyncInstructionFd } from "./instruction-fullsync";
import { openInstructionAt, openTemporaryAt, replaceInstructionAt } from "./instruction-fs";

type Identity = { device: string; inode: string; uid: number; mode: number };
type Row = Record<string, any>;
export interface InstructionAgentApproval { broker: ApprovalBroker; emit(sessionId: string, event: EventInput): void }
export interface InstructionUpdate { workspaceId: string; requestId: string; expectedInstructionRevision: number; expectedDigest: string; content: string }
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const same = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code: "recovery_required" | "authority_denied" | "request_conflict" | "invalid_request" = "recovery_required"): never => { throw new CoworkError(code); };
function identity(fd: number, directory: boolean): Identity {
  const st = fstatSync(fd, { bigint: true });
  if (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1n || st.size < 0n || st.size > BigInt(COWORK_INSTRUCTION_MAX_BYTES)) fail();
  return { device: String(st.dev), inode: String(st.ino), uid: Number(st.uid), mode: Number(st.mode & 0o7777n) };
}
interface Tree { directory: number; entries: { fd: number; name: string; relative: string; identity: Identity }[]; close(): void }
interface Content { identity: Identity; digest: string; bytes: Buffer }

/** Owns only canonical host guidance. It never reads arbitrary guest-source files,
 * launches a worker, or enrolls a source/volume. Home comes from daemon bootstrap;
 * there is no path, root identity, approval flag or content authority in the RPC.
 * The service never automatically initializes missing backing data. */
export class CoworkInstructions {
  private readonly home: string;
  private readonly authority: CoworkAuthority;
  constructor(readonly records: CoworkRepository, home: string, grants: CoworkGrantResolver,
    private readonly approval?: InstructionAgentApproval,
    /** Host-only fault/race injection, never settings/client input. */
    private readonly checkpoint: (phase: string) => void = () => {}) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new CoworkError("unsupported_topology");
    this.home = realpathSync(home);
    if (realpathSync(records.rs.path) !== join(this.home, "runtimes", "runtime-state.db")) fail("authority_denied");
    this.authority = new CoworkAuthority(records, grants);
  }
  private one(sql: string, ...args: any[]): Row | null { return this.records.rs.db.query<Row, any[]>(sql).get(...args); }
  private run(sql: string, ...args: any[]) { return this.records.rs.db.run(sql, args); }
  private now() { return new Date().toISOString(); }
  private scope(workspaceId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(workspaceId)) fail("invalid_request");
    if (!["retained", "archived"].includes(this.records.get(workspaceId).state)) fail("authority_denied");
  }
  private owner(workspaceId: string): Row {
    this.scope(workspaceId);
    const row = this.one("SELECT * FROM cowork_instructions WHERE workspace_id=?", workspaceId);
    if (!row || row.home_id !== this.one("SELECT home_id FROM cowork_home_identity WHERE singleton=1")?.home_id) fail();
    return row!;
  }
  private tree(workspaceId: string, create = false): Tree {
    this.scope(workspaceId);
    const entries: Tree["entries"] = [];
    const close = () => { for (const entry of entries.splice(0).reverse()) closeSync(entry.fd); };
    const remember = (fd: number, name: string, relative: string): Identity => {
      // Own the descriptor even if fstat/identity validation throws.
      try { this.checkpoint("directory-opened"); const actual = identity(fd, true); entries.push({ fd, name, relative, identity: actual }); return actual; }
      catch (error) { closeSync(fd); throw error; }
    };
    try {
      // Walk EVERY absolute-home component from '/', never resolve an untrusted
      // ancestor through a path-based open. Root/system ancestor modes are observed;
      // the selected home and Cowork tree are private user-owned directories.
      let fd = openDirAt(AT_FDCWD, "/");
      remember(fd, "/", "@root");
      const homeSegments = this.home.split("/").filter(Boolean);
      for (const name of homeSegments) {
        fd = openDirAt(fd, name); remember(fd, name, "@ancestor");
      }
      const homeIdentity = identity(fd, true);
      if (homeIdentity.uid !== process.geteuid?.() || homeIdentity.mode !== 0o700) fail();
      entries.at(-1)!.relative = ".";
      this.checkDirectory(".", homeIdentity, create, true);
      let relative = "";
      for (const name of ["cowork", "workspaces", workspaceId, "shared", "instructions"]) {
        relative = relative ? `${relative}/${name}` : name;
        const created = create ? mkdirAt(fd, name, 0o700) : false;
        fd = openDirAt(fd, name);
        const actual = remember(fd, name, relative);
        if (actual.uid !== process.geteuid?.() || actual.mode !== 0o700) fail();
        this.checkDirectory(relative, actual, create, created);
      }
      const tree = { directory: fd, entries, close };
      this.assertTree(tree); return tree;
    } catch (error) { close(); if (error instanceof CoworkError) throw error; return fail(); }
  }
  private checkDirectory(relative: string, actual: Identity, create: boolean, created: boolean): void {
    const recorded = this.one("SELECT identity_json FROM cowork_instruction_directories WHERE relative_path=?", relative);
    if (recorded) { if (!same(JSON.parse(recorded.identity_json), actual)) fail(); return; }
    // Reuse an independently recorded canonical storage ancestor only when its
    // exact identity matches. Never enroll an unknown preexisting subtree.
    const volume = this.one("SELECT * FROM cowork_volume_directories WHERE relative_path=?", relative);
    const approvedExisting = volume?.state === "created" && same({ device: volume.device, inode: volume.inode, uid: volume.uid, mode: volume.mode }, actual);
    if (!create || (!created && !approvedExisting)) fail();
    this.run("INSERT INTO cowork_instruction_directories VALUES(?,?)", relative, JSON.stringify(actual));
  }
  private assertTree(tree: Tree): void {
    for (let index = 0; index < tree.entries.length; index++) {
      const entry = tree.entries[index]!;
      if (!same(identity(entry.fd, true), entry.identity)) fail();
      let current = -1;
      try {
        current = openDirAt(index === 0 ? AT_FDCWD : tree.entries[index - 1]!.fd, entry.name);
        if (!same(identity(current, true), entry.identity)) fail();
      } finally { if (current >= 0) closeSync(current); }
      if (!entry.relative.startsWith("@")) {
        const recorded = this.one("SELECT identity_json FROM cowork_instruction_directories WHERE relative_path=?", entry.relative);
        if (!recorded || !same(JSON.parse(recorded.identity_json), entry.identity)) fail();
      }
    }
  }
  private read(tree: Tree): Content {
    let fd = -1;
    try {
      this.assertTree(tree); fd = openInstructionAt(tree.directory);
      const before = identity(fd, false);
      if (before.uid !== process.geteuid?.() || before.mode !== 0o600) fail();
      const initialStat = fstatSync(fd, { bigint: true });
      const size = Number(initialStat.size), bytes = Buffer.alloc(size + 1);
      let length = 0;
      while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
      const finalStat = fstatSync(fd, { bigint: true });
      if (length !== size || !same(before, identity(fd, false)) || finalStat.size !== initialStat.size || finalStat.mtimeNs !== initialStat.mtimeNs || finalStat.ctimeNs !== initialStat.ctimeNs) fail();
      const value = bytes.subarray(0, size);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
      if (text.includes("\0")) fail();
      this.assertTree(tree);
      // Prove the current fixed entry is still the actual vnode read.
      const current = openInstructionAt(tree.directory);
      try { if (!same(identity(current, false), before)) fail(); } finally { closeSync(current); }
      return { identity: before, digest: digest(value), bytes: value };
    } catch (error) { if (error instanceof CoworkError) throw error; return fail(); }
    finally { if (fd >= 0) closeSync(fd); }
  }
  private publish(workspaceId: string, operationId: string, nextDigest: string): void {
    const workspace = this.records.get(workspaceId), changeId = `change-${randomUUID()}`;
    this.run("INSERT INTO cowork_outbox(change_id,workspace_id,operation_id,revision,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
      changeId, workspaceId, operationId, workspace.configRevision, "workspace_instructions_changed",
      JSON.stringify({ instructionRevision: workspace.instructionRevision, digest: nextDigest, refreshState: "refresh-required" }), this.now());
    this.run("INSERT INTO cowork_outbox_deliveries(change_id,session_id,state) SELECT ?,session_id,'pending' FROM cowork_conversations WHERE workspace_id=? AND state!='deleted'", changeId, workspaceId);
  }
  private metadata(workspaceId: string, content: Content) {
    return { workspaceId, instructionRevision: this.records.get(workspaceId).instructionRevision, digest: content.digest, bytes: content.bytes.length, refreshState: "refresh-required" as const };
  }
  /** Only the trusted host provisioning path calls this with a NEW backing tree.
   * There is intentionally no RPC initializer or missing-file seed fallback. */
  initialize(workspaceId: string, initialContent: string): void {
    if (this.records.rs.db.inTransaction) fail("authority_denied");
    const bytes = Buffer.from(initialContent, "utf8");
    if (bytes.length > COWORK_INSTRUCTION_MAX_BYTES || initialContent.includes("\0") || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== initialContent) fail("invalid_request");
    if (this.one("SELECT 1 FROM cowork_instructions WHERE workspace_id=?", workspaceId)) fail("request_conflict");
    const homeId = this.records.homeIdentity(), tree = this.tree(workspaceId, true);
    let fd = -1;
    try {
      this.assertTree(tree); fd = createFileAt(tree.directory, "WINTER.md", 0o600);
      this.write(fd, bytes); fullSyncInstructionFd(fd); const actual = identity(fd, false); fullSyncInstructionFd(tree.directory); this.assertTree(tree);
      durableCoworkTransaction(this.records.rs, () => { this.run("INSERT INTO cowork_instructions(workspace_id,home_id,file_identity_json,digest,bytes,refresh_state) VALUES(?,?,?,?,?,'refresh-required')", workspaceId, homeId, JSON.stringify(actual), digest(bytes), bytes.length); });
    } catch (error) { if (error instanceof CoworkError) throw error; fail(); }
    finally { if (fd >= 0) closeSync(fd); tree.close(); }
  }
  private write(fd: number, bytes: Buffer): void {
    for (let offset = 0; offset < bytes.length;) { const count = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (count <= 0) fail(); offset += count; }
  }
  private observe(workspaceId: string, tree: Tree): Content {
    const row = this.owner(workspaceId);
    if (row.pending_operation) this.recover(workspaceId, tree, row.pending_operation);
    const actual = this.read(tree), current = this.owner(workspaceId);
    if (actual.digest !== current.digest || !same(actual.identity, JSON.parse(current.file_identity_json))) {
      // Direct user edits (including normal editor atomic saves) are guidance,
      // not authority. Observe under the unchanged admitted backing directory.
      durableCoworkTransaction(this.records.rs, () => {
        const latest = this.owner(workspaceId);
        if (latest.pending_operation || latest.digest !== current.digest || latest.file_identity_json !== current.file_identity_json) fail();
        const confirmed = this.read(tree);
        if (confirmed.digest !== actual.digest || !same(confirmed.identity, actual.identity)) fail();
        this.assertTree(tree);
        const operationId = `operation-${randomUUID()}`;
        this.run("UPDATE cowork_workspaces SET instruction_revision=instruction_revision+1,config_revision=config_revision+1,updated_at=? WHERE workspace_id=?", this.now(), workspaceId);
        this.run("UPDATE cowork_instructions SET file_identity_json=?,digest=?,bytes=? WHERE workspace_id=?", JSON.stringify(actual.identity), actual.digest, actual.bytes.length, workspaceId);
        const receipt = { operationId, workspaceId, revision: this.records.get(workspaceId).configRevision, value: this.metadata(workspaceId, actual) };
        this.operation(operationId, "host-direct-edit", workspaceId, operationId, actual.digest, "applied", receipt);
        this.publish(workspaceId, operationId, actual.digest);
      });
    }
    return actual;
  }
  get(principal: CoworkPrincipal, workspaceId: string) {
    this.authority.requireWorkspace(principal, workspaceId, "read"); this.owner(workspaceId);
    const tree = this.tree(workspaceId);
    try { const content = this.observe(workspaceId, tree); return { ...this.metadata(workspaceId, content), contentBase64: content.bytes.toString("base64"), encoding: "utf-8" as const }; }
    finally { tree.close(); }
  }
  provenance(principal: CoworkPrincipal, workspaceId: string) {
    const { contentBase64: _content, encoding: _encoding, ...metadata } = this.get(principal, workspaceId);
    return { ...metadata, entries: [{ kind: "workspace" as const, guestPath: "/workspace/.winter/WINTER.md" as const, digest: metadata.digest }], sourceDiscovery: "unavailable" as const };
  }
  private operation(operationId: string, principalId: string, workspaceId: string, requestId: string, requestDigest: string, status: string, receipt: unknown): void {
    this.run("INSERT INTO cowork_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)", operationId, principalId, "workspace.instructions.update", workspaceId, requestId, requestDigest, workspaceId, status, JSON.stringify(receipt), this.now(), this.now());
  }
  private temporaryGone(tree: Tree, name: string): boolean {
    if (!/^instruction-[a-f0-9-]{36}\.tmp$/.test(name)) fail();
    // Existing O_DIRECTORY|NOFOLLOW primitive cannot open a substituted device.
    // Only ENOENT proves absence; regular files, links and all other failures are
    // present/unknown. This is an observation, not an atomic absence guarantee.
    try { const fd = openDirAt(tree.directory, name); closeSync(fd); return false; }
    catch (error) { return error instanceof FdError && error.code === "ENOENT"; }
  }
  private discardTemporary(tree: Tree, name: string): void {
    if (!/^instruction-[a-f0-9-]{36}\.tmp$/.test(name)) fail();
    this.assertTree(tree);
    try { unlinkAt(tree.directory, name); }
    catch (error) { if (!(error instanceof FdError && error.code === "ENOENT")) throw error; }
  }
  /** Restart recovery for an orphaned temp: the update died after its journal commit and before renameat, then a
   * direct user save replaced WINTER.md, so the file matches neither recorded image while the recorded temp is still
   * on disk. That temp is the host's own unapplied proposal. It is never replayed: the user's file stands and
   * observe() absorbs it as a direct edit. The temp is removed only once it is proven to be exactly the file the
   * journal recorded (vnode, single link, length and SHA-256). Anything else is unknown, stays in place, and the
   * workspace keeps refusing with recovery_required. WINTER.md is neither opened for write nor renamed here, and the
   * removal is a descriptor-relative unlink of a generated temporary name only. A crash after the unlink leaves
   * "neither image and temp gone", which the superseded rule already handles. */
  private discardVerifiedOrphan(tree: Tree, mutation: Row): void {
    const name = mutation.temporary_name as string;
    try {
      this.assertTree(tree);
      const fd = openTemporaryAt(tree.directory, name);
      try {
        const found = identity(fd, false);
        if (found.uid !== process.geteuid?.() || found.mode !== 0o600 || !same(found, JSON.parse(mutation.file_identity_json))) fail();
        const size = Number(fstatSync(fd, { bigint: true }).size);
        if (size !== mutation.after_bytes) fail();
        const bytes = Buffer.alloc(size + 1);
        let length = 0;
        while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
        if (length !== size || !same(found, identity(fd, false)) || digest(bytes.subarray(0, size)) !== mutation.after_digest) fail();
      } finally { closeSync(fd); }
      this.assertTree(tree);
      this.discardTemporary(tree, name);
      fullSyncInstructionFd(tree.directory);
      this.checkpoint("orphan-temporary-removed");
    } catch (error) { if (error instanceof CoworkError) throw error; return fail(); }
  }
  private recover(workspaceId: string, tree: Tree, operationId: string): void {
    const mutation = this.one("SELECT * FROM cowork_instruction_mutations WHERE operation_id=? AND workspace_id=?", operationId, workspaceId) ?? fail();
    if (!/^instruction-[a-f0-9-]{36}\.tmp$/.test(mutation.temporary_name)) fail();
    const before = this.owner(workspaceId);
    if (before.pending_operation !== operationId || before.digest !== mutation.before_digest || this.records.get(workspaceId).instructionRevision !== mutation.expected_revision) fail();
    const matchesBefore = (value: Content) => value.digest === before.digest && same(value.identity, JSON.parse(before.file_identity_json));
    const matchesAfter = (value: Content) => value.digest === mutation.after_digest && same(value.identity, JSON.parse(mutation.file_identity_json));
    const actual = this.read(tree);
    if (matchesAfter(actual)) {
      const fd = openInstructionAt(tree.directory);
      try { if (!same(identity(fd, false), actual.identity)) fail(); fullSyncInstructionFd(fd); } finally { closeSync(fd); }
      fullSyncInstructionFd(tree.directory);
      const confirmed = this.read(tree);
      if (!matchesAfter(confirmed)) fail();
      this.finish(workspaceId, tree, mutation, confirmed); return;
    }
    let status: "failed" | "superseded" | undefined = matchesBefore(actual) ? "failed" : this.temporaryGone(tree, mutation.temporary_name) ? "superseded" : undefined;
    if (!status) { this.discardVerifiedOrphan(tree, mutation); status = "superseded"; }
    try {
      durableCoworkTransaction(this.records.rs, () => {
        const current = this.owner(workspaceId), debt = this.one("SELECT * FROM cowork_instruction_mutations WHERE operation_id=?", operationId);
        if (current.pending_operation !== operationId || current.digest !== before.digest || current.file_identity_json !== before.file_identity_json || this.records.get(workspaceId).instructionRevision !== mutation.expected_revision || JSON.stringify(debt) !== JSON.stringify(mutation)) fail();
        const confirmed = this.read(tree);
        if (confirmed.digest !== actual.digest || !same(confirmed.identity, actual.identity)) fail();
        if (status === "failed" ? !matchesBefore(confirmed) : matchesBefore(confirmed) || matchesAfter(confirmed) || !this.temporaryGone(tree, mutation.temporary_name)) fail();
        this.assertTree(tree);
        this.run("UPDATE cowork_operations SET status=?,updated_at=? WHERE operation_id=? AND status='pending'", status, this.now(), operationId);
        this.run("UPDATE cowork_instructions SET pending_operation=NULL WHERE workspace_id=?", workspaceId);
        this.run("DELETE FROM cowork_instruction_mutations WHERE operation_id=?", operationId);
        const changeId = `change-${randomUUID()}`;
        this.run("INSERT INTO cowork_outbox(change_id,workspace_id,operation_id,revision,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)", changeId, workspaceId, operationId, this.records.get(workspaceId).configRevision, "workspace_operation_changed", JSON.stringify({ status, terminal: true }), this.now());
        this.run("INSERT INTO cowork_outbox_deliveries(change_id,session_id,state) SELECT ?,session_id,'pending' FROM cowork_conversations WHERE workspace_id=? AND state!='deleted'", changeId, workspaceId);
      });
    } finally {
      // A pragma restoration error can happen AFTER COMMIT. Consult canonical
      // ownership rather than inferring rollback from a thrown return.
      if (status === "failed" && !this.one("SELECT 1 FROM cowork_instruction_mutations WHERE operation_id=?", operationId) && this.one("SELECT status FROM cowork_operations WHERE operation_id=?", operationId)?.status === "failed") this.discardTemporary(tree, mutation.temporary_name);
    }
    // observe() absorbs a superseding direct edit; never apply or replay the temp.
  }
  /** This invocation knows renameat has NOT succeeded. Unlike restart recovery,
   * it need not infer whether the temp was applied from the current user file. */
  private abortUnreplaced(workspaceId: string, mutation: Row, before: Content, principalId: string, requestId: string, requestDigest: string): void {
    durableCoworkTransaction(this.records.rs, () => {
      const row = this.owner(workspaceId), debt = this.one("SELECT * FROM cowork_instruction_mutations WHERE operation_id=?", mutation.operation_id);
      const operation = this.one("SELECT * FROM cowork_operations WHERE operation_id=?", mutation.operation_id);
      if (row.pending_operation !== mutation.operation_id || row.digest !== before.digest || row.file_identity_json !== JSON.stringify(before.identity) || row.bytes !== before.bytes.length || this.records.get(workspaceId).instructionRevision !== mutation.expected_revision || !debt || Object.entries(mutation).some(([key, value]) => debt[key] !== value)) fail();
      if (!operation || operation.status !== "pending" || operation.principal_id !== principalId || operation.method !== "workspace.instructions.update" || operation.scope !== workspaceId || operation.workspace_id !== workspaceId || operation.request_id !== requestId || operation.request_digest !== requestDigest) fail();
      // A failed ancestry check cannot prevent this guarded metadata-only abort.
      // No target read/write, detached-tree adoption or temp replay occurs here.
      this.run("UPDATE cowork_operations SET status='failed',updated_at=? WHERE operation_id=?", this.now(), mutation.operation_id);
      this.run("UPDATE cowork_instructions SET pending_operation=NULL WHERE workspace_id=?", workspaceId);
      this.run("DELETE FROM cowork_instruction_mutations WHERE operation_id=?", mutation.operation_id);
      const changeId = `change-${randomUUID()}`;
      this.run("INSERT INTO cowork_outbox(change_id,workspace_id,operation_id,revision,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)", changeId, workspaceId, mutation.operation_id, this.records.get(workspaceId).configRevision, "workspace_operation_changed", JSON.stringify({ status: "failed", terminal: true }), this.now());
      this.run("INSERT INTO cowork_outbox_deliveries(change_id,session_id,state) SELECT ?,session_id,'pending' FROM cowork_conversations WHERE workspace_id=? AND state!='deleted'", changeId, workspaceId);
    });
  }
  private finish(workspaceId: string, tree: Tree, mutation: Row, actual: Content) {
    return durableCoworkTransaction(this.records.rs, () => {
      const row = this.owner(workspaceId), current = this.records.get(workspaceId);
      if (row.pending_operation !== mutation.operation_id || current.instructionRevision !== mutation.expected_revision) fail();
      this.assertTree(tree);
      this.run("UPDATE cowork_workspaces SET instruction_revision=instruction_revision+1,config_revision=config_revision+1,updated_at=? WHERE workspace_id=?", this.now(), workspaceId);
      this.run("UPDATE cowork_instructions SET file_identity_json=?,digest=?,bytes=?,pending_operation=NULL WHERE workspace_id=?", JSON.stringify(actual.identity), actual.digest, actual.bytes.length, workspaceId);
      const receipt = { operationId: mutation.operation_id as string, workspaceId, revision: this.records.get(workspaceId).configRevision, value: this.metadata(workspaceId, actual) };
      this.run("UPDATE cowork_operations SET status='applied',result_json=?,updated_at=? WHERE operation_id=? AND status='pending'", JSON.stringify(receipt), this.now(), mutation.operation_id);
      this.publish(workspaceId, mutation.operation_id, actual.digest);
      this.run("DELETE FROM cowork_instruction_mutations WHERE operation_id=?", mutation.operation_id);
      return receipt;
    });
  }
  update(principal: CoworkPrincipal, raw: InstructionUpdate) {
    if (principal.kind !== "local-user") fail("authority_denied");
    const input = CoworkInstructionUpdate.parse(raw);
    this.authority.requireWorkspace(principal, input.workspaceId, "admin");
    return this.perform(principal.id, input);
  }
  private perform(principalId: string, input: InstructionUpdate) {
    if (this.records.rs.db.inTransaction) fail("authority_denied");
    this.owner(input.workspaceId);
    const requestDigest = digest(JSON.stringify(input)), tree = this.tree(input.workspaceId);
    let temporaryName: string | undefined, pendingOperationId: string | undefined, unreplaced: { mutation: Row; before: Content } | undefined;
    let replacementSucceeded = false;
    try {
      const before = this.observe(input.workspaceId, tree);
      const previous = this.one("SELECT * FROM cowork_operations WHERE principal_id=? AND method='workspace.instructions.update' AND scope=? AND request_id=?", principalId, input.workspaceId, input.requestId);
      if (previous) { if (previous.request_digest !== requestDigest) fail("request_conflict"); if (previous.status !== "applied") fail(); return JSON.parse(previous.result_json); }
      const revision = this.records.get(input.workspaceId).instructionRevision;
      if (revision !== input.expectedInstructionRevision || before.digest !== input.expectedDigest) throw new CoworkError("revision_conflict", revision);
      const bytes = Buffer.from(input.content, "utf8"), operationId = `operation-${randomUUID()}`;
      if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== input.content) fail("invalid_request");
      temporaryName = `instruction-${randomUUID()}.tmp`;
      const fd = createFileAt(tree.directory, temporaryName, 0o600);
      let after: Content;
      try { this.write(fd, bytes); fullSyncInstructionFd(fd); after = { identity: identity(fd, false), digest: digest(bytes), bytes }; }
      finally { closeSync(fd); }
      this.checkpoint("temporary-durable");
      this.assertTree(tree);
      const current = this.read(tree);
      if (current.digest !== before.digest || !same(current.identity, before.identity)) throw new CoworkError("revision_conflict", revision);
      const mutation = { operation_id: operationId, expected_revision: revision, after_digest: after.digest, file_identity_json: JSON.stringify(after.identity) };
      pendingOperationId = operationId;
      unreplaced = { before, mutation: { ...mutation, workspace_id: input.workspaceId, before_digest: before.digest, temporary_name: temporaryName, after_bytes: bytes.length } };
      durableCoworkTransaction(this.records.rs, () => {
        const row = this.owner(input.workspaceId);
        if (row.pending_operation || this.records.get(input.workspaceId).instructionRevision !== revision || row.digest !== before.digest) fail();
        this.assertTree(tree);
        this.operation(operationId, principalId, input.workspaceId, input.requestId, requestDigest, "pending", { operationId, workspaceId: input.workspaceId, revision: this.records.get(input.workspaceId).configRevision, value: this.metadata(input.workspaceId, before) });
        this.run("INSERT INTO cowork_instruction_mutations VALUES(?,?,?,?,?,?,?,?)", operationId, input.workspaceId, revision, before.digest, after.digest, temporaryName!, JSON.stringify(after.identity), bytes.length);
        this.run("UPDATE cowork_instructions SET pending_operation=? WHERE workspace_id=?", operationId, input.workspaceId);
      });
      this.checkpoint("journal-durable"); this.assertTree(tree);
      this.checkpoint("before-replace");
      const immediatelyBefore = this.read(tree);
      if (immediatelyBefore.digest !== before.digest || !same(immediatelyBefore.identity, before.identity)) throw new CoworkError("revision_conflict", revision);
      this.assertTree(tree);
      // This narrows the editor-save window; read and rename are not an atomic
      // compare-and-swap. Same-user changes after this check remain a residual.
      // Replacement uses held directory descriptors; no pathname follows symlinks
      // or writes through the previously observed user file.
      replaceInstructionAt(tree.directory, temporaryName); replacementSucceeded = true; temporaryName = undefined;
      fullSyncInstructionFd(tree.directory); this.checkpoint("file-replaced"); this.assertTree(tree);
      const confirmed = this.read(tree);
      if (!same(confirmed.identity, after.identity) || confirmed.digest !== after.digest) fail();
      return this.finish(input.workspaceId, tree, mutation, confirmed);
    } catch (error) {
      if (!replacementSucceeded && unreplaced) {
        try { this.abortUnreplaced(input.workspaceId, unreplaced.mutation, unreplaced.before, principalId, input.requestId, requestDigest); }
        catch { /* failed guards/abort retain canonical debt; preserve original error */ }
      }
      if (error instanceof CoworkError) throw error; return fail();
    }
    finally {
      // Debt owns a temp after journal commit. It is not silently deleted/replayed
      // after a failure; recovery must see the recorded target inode+bytes.
      if (temporaryName) {
        try {
          const debt = pendingOperationId && this.one("SELECT 1 FROM cowork_instruction_mutations WHERE operation_id=? OR temporary_name=?", pendingOperationId, temporaryName);
          const operation = pendingOperationId && this.one("SELECT status FROM cowork_operations WHERE operation_id=?", pendingOperationId);
          const owner = this.one("SELECT pending_operation FROM cowork_instructions WHERE workspace_id=?", input.workspaceId);
          if (!debt && (!operation || operation.status === "failed") && owner && owner.pending_operation !== pendingOperationId) this.discardTemporary(tree, temporaryName);
        } catch { /* unknown DB/tree ownership retains the temp for host recovery */ }
      }
      tree.close();
    }
  }
  private agentScope(principal: Extract<CoworkPrincipal, { kind: "runtime" }>): string {
    const binding = this.records.binding(principal.sessionId), workspace = this.records.get(principal.workspaceId);
    if (binding.workspaceId !== principal.workspaceId || binding.state !== "active" || workspace.state !== "retained") fail("authority_denied");
    const capabilities = this.authority.effectiveCapabilities(principal.sessionId);
    if (!capabilities.toolClasses.includes("write") || !capabilities.hostServices.includes("workspace.instructions.update")) fail("authority_denied");
    // The shared-guidance edit column of the host policy matrix: Deny under plan and dont-ask, Ask otherwise (the card below).
    // Was a literal `plan || dont-ask`; one source of truth now.
    if (coworkHostDecision({ policy: binding.policy, tool: "InstructionEdit", path: "shared-instructions", ceiling: capabilities }).verdict !== "ask") fail("authority_denied");
    this.authority.requireSource(principal.workspaceId, binding.sourceId);
    return JSON.stringify({ binding, policy: this.records.policy(principal.workspaceId), grantRevision: workspace.grantRevision, incarnationId: workspace.incarnationId, leaseEpoch: workspace.leaseEpoch });
  }
  /** Authenticated guest-owner integration calls this internal port, not user RPC.
   * Content is copied BEFORE the prompt. No reusable approval token/flag is
   * accepted; the exact original revision/digest/content stays in this closure. */
  async updateAgent(principal: Extract<CoworkPrincipal, { kind: "runtime" }>, raw: InstructionUpdate, signal: AbortSignal) {
    const approval = this.approval;
    if (!approval || !(approval.broker instanceof ApprovalBroker) || signal.aborted) return fail("authority_denied");
    principal = Object.freeze({ ...principal });
    const input = Object.freeze(CoworkInstructionUpdate.parse(raw));
    if (principal.kind !== "runtime" || principal.workspaceId !== input.workspaceId) fail("authority_denied");
    const scope = this.agentScope(principal);
    const previous = this.one("SELECT 1 FROM cowork_operations WHERE principal_id=? AND method='workspace.instructions.update' AND scope=? AND request_id=?", principal.id, input.workspaceId, input.requestId);
    if (previous) return this.perform(principal.id, input);
    const contentDigest = digest(Buffer.from(input.content, "utf8")), callId = `instruction-${randomUUID()}`, issuedAt = Date.now(), timeoutMs = 60_000;
    const broker = approval.broker;
    const abort = () => { broker.resolve(principal.sessionId, callId, false, "aborted"); };
    const summary = `Update shared workspace guidance for ${input.workspaceId} at revision ${input.expectedInstructionRevision}; expected SHA-256 ${input.expectedDigest}; proposed SHA-256 ${contentDigest}\nProposed content:\n${input.content}`;
    const waiting = broker.wait(principal.sessionId, callId, timeoutMs, { toolName: "workspace.instructions.update", summary, issuedAt, expiresAt: issuedAt + timeoutMs });
    signal.addEventListener("abort", abort, { once: true });
    try {
      approval.emit(principal.sessionId, { type: "approval_requested", sessionId: principal.sessionId, threadId: "main", callId, toolName: "workspace.instructions.update", summary, issuedAt, expiresAt: issuedAt + timeoutMs });
      const outcome = await waiting;
      approval.emit(principal.sessionId, { type: "approval_resolved", sessionId: principal.sessionId, threadId: "main", callId, approved: outcome.approved, by: outcome.by });
      if (!outcome.approved || signal.aborted || this.agentScope(principal) !== scope) fail("authority_denied");
      return this.perform(principal.id, input);
    } finally { signal.removeEventListener("abort", abort); broker.resolve(principal.sessionId, callId, false, "aborted"); }
  }
}
