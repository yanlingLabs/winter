import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { COWORK_FILE_CHUNK_MAX_BYTES, CoworkOutputPath, type CoworkParams } from "@yanlinglabs/winter-protocol";
import { AT_FDCWD, FdError, mkdirAt, openDirAt } from "../computer-use/browser/fd-fs";
import { CoworkAuthority, type CoworkGrantResolver, type CoworkPrincipal } from "./authority";
import { type CoworkCommittedSessions, CoworkRepository } from "./repository";
import { durableCoworkTransaction } from "./durable-transaction";
import { fullSyncInstructionFd } from "./instruction-fullsync";
import { openOutputAt } from "./output-fs";
import { CoworkError } from "./types";

type Identity = { device: string; inode: string; uid: number; mode: number };
type Row = Record<string, any>;
type Entry = { fd: number; parent: number; name: string; relative: string | null; identity: Identity };
interface Tree { entries: Entry[]; directory: number; close(): void }
/** Intent-journal view of one initialization: `prior` intents were committed by an EARLIER call (their directory may
 * legitimately be an unrecorded leftover); `created` collects the paths this call's own mkdir created. */
interface Journal { prior: ReadonlySet<string>; created: Set<string> }
const same = (a: Identity, b: Identity) => a.device === b.device && a.inode === b.inode && a.uid === b.uid && a.mode === b.mode;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: "file_unavailable" | "authority_denied" | "invalid_request" | "stale_file" | "file_missing" | "file_incomplete" = "file_unavailable"): never => { throw new CoworkError(code); };
const component = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) && value !== "." && value !== "..";
function identity(fd: number): Identity {
  const st = fstatSync(fd, { bigint: true });
  if (!st.isDirectory()) fail();
  return { device: String(st.dev), inode: String(st.ino), uid: Number(st.uid), mode: Number(st.mode & 0o7777n) };
}

/** A host user reader for canonical shared outputs only. No initializer is routed
 * over RPC, no missing-storage seed, guest path translation, filesystem listing,
 * VM access, source readiness change or ordinary Code OUTDIR fallback. */
export class CoworkOutputs {
  private readonly home: string;
  private readonly authority: CoworkAuthority;
  constructor(readonly records: CoworkRepository, home: string, grants: CoworkGrantResolver,
    /** Trusted race/fault instrumentation only; never settings or RPC input. */
    private readonly checkpoint: (phase: string) => void = () => {}) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new CoworkError("unsupported_topology");
    this.home = realpathSync(home);
    if (realpathSync(records.rs.path) !== join(this.home, "runtimes", "runtime-state.db")) fail("authority_denied");
    this.authority = new CoworkAuthority(records, grants);
  }
  private one(sql: string, ...args: any[]): Row | null { return this.records.rs.db.query<Row, any[]>(sql).get(...args); }
  private run(sql: string, ...args: any[]) { this.records.rs.db.run(sql, args); }
  private workspace(workspaceId: string): void {
    if (!component(workspaceId)) fail("invalid_request");
    const workspace = this.records.get(workspaceId);
    if (!["standalone", "project"].includes(workspace.ownership) || !["retained", "archived"].includes(workspace.state)) fail("authority_denied");
  }
  private user(principal: CoworkPrincipal, workspaceId: string): void {
    if (principal.kind !== "local-user") fail("authority_denied");
    this.workspace(workspaceId); this.authority.requireWorkspace(principal, workspaceId, "read");
  }
  private root(workspaceId: string, sessionId: string): string {
    if (!component(sessionId)) fail("invalid_request");
    return `cowork/workspaces/${workspaceId}/shared/outputs/${sessionId}`;
  }
  private binding(workspaceId: string, sessionId: string, initialize = false): void {
    const binding = this.records.binding(sessionId);
    if (binding.workspaceId !== workspaceId || (initialize && binding.state !== "active")) fail("authority_denied");
    // Deleted conversation tombstones deliberately retain output ownership/data.
  }
  private hasIntent(relative: string, homeId: string): boolean {
    return this.one("SELECT 1 FROM cowork_output_directory_intents WHERE relative_path=? AND home_id=?", relative, homeId) !== null;
  }
  private directoryRecord(relative: string, actual: Identity, create: boolean, created: boolean, homeId: string, adopt = false): boolean {
    const record = this.one("SELECT * FROM cowork_output_directories WHERE relative_path=?", relative);
    if (record) {
      if (record.home_id !== homeId || !same(JSON.parse(record.identity_json), actual)) fail();
      return false;
    }
    // Shared ancestors may already belong to another canonical storage owner.
    const guidance = this.one("SELECT identity_json FROM cowork_instruction_directories WHERE relative_path=?", relative);
    const volume = this.one("SELECT * FROM cowork_volume_directories WHERE relative_path=? AND state='created'", relative);
    const admitted = guidance ? same(JSON.parse(guidance.identity_json), actual) : volume && same({ device: volume.device, inode: volume.inode, uid: volume.uid, mode: volume.mode }, actual);
    // `adopt` is decided by the walk: a journaled leftover of an earlier attempt, never a foreign preexisting directory.
    if (!create || (!created && !admitted && !adopt && relative !== ".")) fail();
    return true;
  }
  /** `absent`, when given, makes this a read-only PROBE of the create walk: nothing is made, synced or checkpointed;
   * the first component that does not exist (ENOENT) and every later one are collected into it and the walk stops. */
  private tree(workspaceId: string, sessionId: string, create = false, journal?: Journal, absent?: Set<string>): Tree & { newEntries: Entry[] } {
    const homeId = this.records.recordedHomeIdentity(), entries: Entry[] = [], newEntries: Entry[] = [];
    const close = () => { for (const entry of entries.splice(0).reverse()) closeSync(entry.fd); };
    const remember = (fd: number, parent: number, name: string, relative: string | null) => {
      try { const actual = identity(fd), entry = { fd, parent, name, relative, identity: actual }; entries.push(entry); return entry; }
      catch (error) { closeSync(fd); throw error; }
    };
    try {
      let fd = openDirAt(AT_FDCWD, "/"); remember(fd, AT_FDCWD, "/", null);
      for (const name of this.home.split("/").filter(Boolean)) { const parent = fd; fd = openDirAt(parent, name); remember(fd, parent, name, null); }
      const home = entries.at(-1)!; home.relative = ".";
      if (home.identity.uid !== process.geteuid?.() || home.identity.mode !== 0o700) fail();
      if (this.directoryRecord(".", home.identity, create, false, homeId)) newEntries.push(home);
      const names = this.root(workspaceId, sessionId).split("/"), chain = this.chain(workspaceId, sessionId);
      for (const [index, name] of names.entries()) {
        const relative = chain[index]!;
        const parent = fd, parentEntry = entries.at(-1)!; let created = false;
        if (absent) {
          try { fd = openDirAt(parent, name); }
          catch (error) {
            if (!(error instanceof FdError) || error.code !== "ENOENT") throw error;
            // A RECORDED directory that has vanished can never match its identity again: refuse before any journal or mkdir.
            for (const later of chain.slice(index)) { if (this.one("SELECT 1 FROM cowork_output_directories WHERE relative_path=?", later)) fail(); absent.add(later); }
            break;
          }
        } else {
          created = create ? mkdirAt(parent, name, 0o700) : false;
          if (created) journal?.created.add(relative);
          fd = openDirAt(parent, name);
        }
        const entry = remember(fd, parent, name, relative);
        if (entry.identity.uid !== process.geteuid?.() || entry.identity.mode !== 0o700) fail();
        // Adopt an existing UNRECORDED directory only as the leftover of an earlier attempt that journaled its intent
        // before any mkdir: opened under the held parent without following links (above), self-owned, mode 0700 (above)
        // and on its held parent's device. Never a directory that merely exists; never deleted or renamed.
        const adopt = create && !created && journal !== undefined && journal.prior.has(relative) && entry.identity.device === parentEntry.identity.device && this.hasIntent(relative, homeId);
        const isNew = this.directoryRecord(relative, entry.identity, create, created, homeId, adopt);
        if (isNew) newEntries.push(entry);
        // An adopted directory's earlier attempt may have failed at exactly this sync, so it is made durable again.
        if (!absent && (created || (isNew && adopt))) { fullSyncInstructionFd(fd); fullSyncInstructionFd(parent); }
        if (!absent) this.checkpoint("directory-opened");
      }
      return { entries, directory: fd, newEntries, close };
    } catch (error) { close(); if (error instanceof CoworkError) throw error; return fail(); }
  }
  private assertTree(tree: Tree, newlyCreated: readonly Entry[] = []): void {
    const homeId = this.records.recordedHomeIdentity();
    for (const entry of tree.entries) {
      if (!same(identity(entry.fd), entry.identity)) fail();
      let current = -1;
      try { current = openDirAt(entry.parent, entry.name); if (!same(identity(current), entry.identity)) fail(); }
      finally { if (current >= 0) closeSync(current); }
      if (entry.relative !== null && !newlyCreated.includes(entry)) this.directoryRecord(entry.relative, entry.identity, false, false, homeId);
    }
  }
  /** The canonical chain below the home, as cumulative relative paths (`cowork`, `cowork/workspaces`, …, the session root). */
  private chain(workspaceId: string, sessionId: string): string[] {
    let relative = ""; return this.root(workspaceId, sessionId).split("/").map(name => (relative = relative ? `${relative}/${name}` : name));
  }
  /** Read-only pre-walk of the create walk (held-fd openDirAt, O_NOFOLLOW, no mkdir, nothing synced). It applies every
   * walk check to the directories that exist, so a FOREIGN unrecorded directory (no recorded/admitted identity, no
   * intent committed by an earlier call) is refused here, before any intent is written. Returns the paths that do not
   * exist yet: the first missing component and everything below it. */
  private absent(workspaceId: string, sessionId: string, homeId: string): Set<string> {
    const absent = new Set<string>(), prior = new Set(this.chain(workspaceId, sessionId).filter(relative => this.hasIntent(relative, homeId)));
    const probe = this.tree(workspaceId, sessionId, true, { prior, created: new Set() }, absent);
    try { return absent; } finally { probe.close(); }
  }
  /** Intent journal, step one: durably record the ABSENT, not-yet-recorded directories of the chain BEFORE any mkdir.
   * Returns the paths whose intent already existed (committed by an earlier attempt: their directory may be an
   * unrecorded leftover) and the ones inserted now (a directory already standing there is foreign and stays refused). */
  private journal(workspaceId: string, sessionId: string, sessions: CoworkCommittedSessions, homeId: string, absent: ReadonlySet<string>): { prior: Set<string>; fresh: Set<string> } {
    const prior = new Set<string>(), fresh = new Set<string>(), chain = this.chain(workspaceId, sessionId);
    durableCoworkTransaction(this.records.rs, () => {
      this.workspace(workspaceId); this.binding(workspaceId, sessionId, true);
      if (sessions.hasCommittedSession(sessionId) !== true || this.records.recordedHomeIdentity() !== homeId || this.records.get(workspaceId).state !== "retained") fail("authority_denied");
      if (this.one("SELECT 1 FROM cowork_output_locations WHERE session_id=?", sessionId)) throw new CoworkError("request_conflict");
      for (const relative of chain) {
        if (this.one("SELECT 1 FROM cowork_output_directories WHERE relative_path=?", relative)) { if (absent.has(relative)) fail(); continue; } // recorded yet absent: never mkdir a replacement
        if (this.one("SELECT 1 FROM cowork_output_directory_intents WHERE relative_path=? AND home_id=?", relative, homeId)) prior.add(relative);
        else if (absent.has(relative)) { this.run("INSERT INTO cowork_output_directory_intents VALUES(?,?,?)", relative, homeId, new Date().toISOString()); fresh.add(relative); }
      }
    });
    return { prior, fresh };
  }
  /** Best effort and database-only: a fresh intent whose directory this call never created would otherwise bless any
   * directory that appears there later. Intents of directories this call DID create stay, for the retry. */
  private forget(homeId: string, fresh: ReadonlySet<string>, created: ReadonlySet<string>): void {
    const stale = [...fresh].filter(relative => !created.has(relative));
    if (stale.length === 0) return;
    try { durableCoworkTransaction(this.records.rs, () => { for (const relative of stale) this.run("DELETE FROM cowork_output_directory_intents WHERE relative_path=? AND home_id=?", relative, homeId); }); } catch { /* the original failure is the one reported */ }
  }
  /** Trusted future storage owner only: creates a NEW canonical output directory
   * for an already bound, committed logical conversation. Cross-store ordering is
   * synchronous: store.createSession commit precedes this call; no caller-owned
   * transaction, await, reentrant lifecycle change or unverified session inventory.
   * A read-only pre-walk refuses a foreign existing directory before anything is written; then every ABSENT directory
   * of the chain is journaled (intent rows, one durable commit) BEFORE the first mkdir and the intents
   * are removed in the owner commit that records the directories. A retry therefore adopts only what an earlier attempt
   * journaled and left unrecorded (failure or crash); a directory that merely exists, with no earlier intent, is foreign
   * and refused, as is any link, non-0700, foreign-owned or cross-device entry. Nothing is ever deleted or renamed. */
  initialize(workspaceId: string, sessionId: string, sessions: CoworkCommittedSessions): void {
    if (this.records.rs.db.inTransaction) fail("authority_denied");
    this.workspace(workspaceId); this.binding(workspaceId, sessionId, true);
    if (!sessions || typeof sessions.hasCommittedSession !== "function" || sessions.hasCommittedSession(sessionId) !== true || this.records.get(workspaceId).state !== "retained") fail("authority_denied");
    if (this.one("SELECT 1 FROM cowork_output_locations WHERE session_id=?", sessionId)) throw new CoworkError("request_conflict");
    const homeId = this.records.recordedHomeIdentity(); let intents: { prior: Set<string>; fresh: Set<string> };
    try { const absent = this.absent(workspaceId, sessionId, homeId); this.checkpoint("pre-walk-done"); intents = this.journal(workspaceId, sessionId, sessions, homeId, absent); } catch (error) { if (error instanceof CoworkError) throw error; return fail(); }
    const created = new Set<string>(); let tree: (Tree & { newEntries: Entry[] }) | undefined;
    try {
      this.checkpoint("intents-recorded");
      tree = this.tree(workspaceId, sessionId, true, { prior: intents.prior, created });
      this.assertTree(tree, tree.newEntries); this.checkpoint("before-owner-commit");
      const recorded = tree;
      durableCoworkTransaction(this.records.rs, () => {
        this.workspace(workspaceId); this.binding(workspaceId, sessionId, true);
        if (sessions.hasCommittedSession(sessionId) !== true || this.records.recordedHomeIdentity() !== homeId || this.records.get(workspaceId).state !== "retained") fail("authority_denied");
        if (this.one("SELECT 1 FROM cowork_output_locations WHERE session_id=?", sessionId)) throw new CoworkError("request_conflict");
        this.assertTree(recorded, recorded.newEntries);
        for (const entry of recorded.newEntries) this.run("INSERT INTO cowork_output_directories VALUES(?,?,?)", entry.relative, homeId, JSON.stringify(entry.identity));
        this.run("INSERT INTO cowork_output_locations VALUES(?,?,?,?,?,1,?)", `output-${randomUUID()}`, homeId, workspaceId, sessionId, this.root(workspaceId, sessionId), new Date().toISOString());
        this.run("DELETE FROM cowork_output_directory_intents WHERE relative_path IN (SELECT relative_path FROM cowork_output_directories)");
      });
    } catch (error) { this.forget(homeId, intents.fresh, created); if (error instanceof CoworkError) throw error; fail(); }
    finally { tree?.close(); }
  }
  private owner(workspaceId: string, locationId: string, expectedRevision: number): Row {
    this.workspace(workspaceId);
    const row = this.one("SELECT * FROM cowork_output_locations WHERE workspace_id=? AND location_id=?", workspaceId, locationId);
    if (!row) return fail("authority_denied");
    if (row.home_id !== this.records.recordedHomeIdentity() || row.relative_path !== this.root(workspaceId, row.session_id)) fail("authority_denied");
    this.binding(workspaceId, row.session_id);
    if (row.revision !== expectedRevision) throw new CoworkError("revision_conflict", row.revision);
    return row;
  }
  /** Canonical DB inventory, never filesystem listing or discovery/enrollment. */
  list(principal: CoworkPrincipal, request: CoworkParams<"workspace.output.list">) {
    this.user(principal, request.workspaceId);
    const limit = request.limit ?? 100;
    const inventory = () => hash([request.workspaceId, this.records.recordedHomeIdentity(), this.one("SELECT COUNT(*) AS count, MAX(rowid) AS watermark FROM cowork_output_locations WHERE workspace_id=?", request.workspaceId)]);
    const generation = inventory(); let after = "";
    if (request.cursor) {
      const match = /^([a-f0-9]{64}):(output-[a-f0-9-]{36})$/.exec(request.cursor);
      if (!match) return fail("invalid_request");
      if (match[1] !== generation) throw new CoworkError("stale_cursor");
      after = match[2]!; this.owner(request.workspaceId, after, 1);
    }
    const rows = this.records.rs.db.query<Row, [string, string, number]>("SELECT * FROM cowork_output_locations WHERE workspace_id=? AND location_id>? ORDER BY location_id LIMIT ?").all(request.workspaceId, after, limit + 1);
    const page = rows.slice(0, limit), locations = page.map(row => {
      this.owner(request.workspaceId, row.location_id, row.revision);
      return { workspaceId: request.workspaceId, sessionId: row.session_id as string, locationId: row.location_id as string, kind: "conversation-outputs" as const, revision: row.revision as number };
    });
    this.user(principal, request.workspaceId);
    if (inventory() !== generation) throw new CoworkError("stale_cursor");
    return { locations, nextCursor: rows.length > limit ? `${generation}:${locations.at(-1)!.locationId}` : null };
  }
  private stamp(st: BigIntStats, row: Row): string {
    if (!st.isFile() || st.nlink !== 1n || st.uid !== BigInt(process.geteuid?.() ?? -1) || st.size < 0n || st.size > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    // An optimistic kernel metadata generation, NOT a content SHA-256 claim.
    return hash([row.location_id, row.revision, String(st.dev), String(st.ino), String(st.size), String(st.mtimeNs), String(st.ctimeNs), String(st.mode), String(st.nlink), String(st.uid)]);
  }
  private file<T>(principal: CoworkPrincipal, request: CoworkParams<"workspace.file.stat">, body: (fd: number, row: Row, generation: string, bytes: number) => T): T {
    this.user(principal, request.workspaceId);
    const row = this.owner(request.workspaceId, request.locationId, request.expectedLocationRevision);
    const parts = CoworkOutputPath.parse(request.relativePath).split("/"), filename = parts.pop()!;
    const tree = this.tree(request.workspaceId, row.session_id);
    const outputDevice = tree.entries.at(-1)!.identity.device; let fd = -1;
    try {
      let parent = tree.directory;
      for (const name of parts) {
        const child = openDirAt(parent, name);
        try { const actual = identity(child); if (actual.uid !== process.geteuid?.() || actual.device !== outputDevice) fail(); tree.entries.push({ fd: child, parent, name, relative: null, identity: actual }); }
        catch (error) { closeSync(child); throw error; }
        parent = child;
      }
      this.assertTree(tree); this.checkpoint("before-file-open"); fd = openOutputAt(parent, filename);
      const before = fstatSync(fd, { bigint: true }), generation = this.stamp(before, row);
      // Refuse cross-device entries instead of treating an unexpected mount as backing content.
      if (String(before.dev) !== outputDevice) fail();
      this.checkpoint("file-opened"); const result = body(fd, row, generation, Number(before.size));
      this.checkpoint("after-file-read");
      if (this.stamp(fstatSync(fd, { bigint: true }), row) !== generation) fail("stale_file");
      this.assertTree(tree);
      const current = openOutputAt(parent, filename);
      try { if (this.stamp(fstatSync(current, { bigint: true }), row) !== generation) fail("stale_file"); }
      finally { closeSync(current); }
      this.user(principal, request.workspaceId); this.owner(request.workspaceId, request.locationId, request.expectedLocationRevision);
      return result;
    } catch (error) {
      if (error instanceof CoworkError) throw error;
      if (error instanceof FdError && error.code === "ENOENT") fail("file_missing");
      return fail();
    } finally { if (fd >= 0) closeSync(fd); tree.close(); }
  }
  stat(principal: CoworkPrincipal, request: CoworkParams<"workspace.file.stat">) {
    return this.file(principal, request, (_fd, row, generation, bytes) => ({ workspaceId: request.workspaceId, locationId: request.locationId, relativePath: request.relativePath, locationRevision: row.revision as number, generation, bytes, kind: "file" as const }));
  }
  read(principal: CoworkPrincipal, request: CoworkParams<"workspace.file.readRange">) {
    const maxBytes = request.maxBytes ?? 65536;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > COWORK_FILE_CHUNK_MAX_BYTES || !Number.isSafeInteger(request.offset) || request.offset < 0) fail("invalid_request");
    return this.file(principal, request, (fd, row, generation, bytes) => {
      if (generation !== request.expectedGeneration) fail("stale_file");
      if (request.offset > bytes) fail("invalid_request");
      const count = Math.min(maxBytes, bytes - request.offset), content = Buffer.alloc(count); let read = 0;
      while (read < count) { const got = readSync(fd, content, read, count - read, request.offset + read); if (got === 0) fail("file_incomplete"); read += got; }
      const nextOffset = request.offset + read;
      return { workspaceId: request.workspaceId, locationId: request.locationId, relativePath: request.relativePath, locationRevision: row.revision as number, generation, bytes, kind: "file" as const,
        offset: request.offset, nextOffset, eof: nextOffset === bytes, contentBase64: content.toString("base64"), encoding: "base64" as const };
    });
  }
}
