import { Database } from "bun:sqlite";
import { CoworkRepository } from "../../src/cowork/repository";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { COWORK_RPC, COWORK_FILE_CHUNK_MAX_BYTES } from "@yanlinglabs/winter-protocol";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, downgradeCoworkRuntimeStateToV7 } from "../../src/runtime-state/db";
import { CoworkError, type CoworkErrorCode } from "../../src/cowork/types";
import { CoworkWorkspaceService } from "../../src/cowork/service";
import { CoworkOutputs } from "../../src/cowork/outputs";
import { outdirPath, ensureOutdir } from "../../src/sessions/outdir";
import { outputFixture, outputUser } from "./output-fixture";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(checkpoint: (phase: string) => void = () => {}) { const f = outputFixture(checkpoint); cleanup.push(() => f.close()); return f; }
function refusal(fn: () => unknown, code: CoworkErrorCode) { try { fn(); throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(CoworkError); expect((error as CoworkError).code).toBe(code); expect((error as Error).message).toBe(code); } }
const native = process.platform === "darwin" && process.arch === "arm64" && process.env.WINTER_COWORK_OUTPUT_FS_FIXTURE === "1" ? test : test.skip;
function request(f: ReturnType<typeof fixture>, locationId: string, relativePath = "file.bin") { return { workspaceId: f.workspaceId, locationId, expectedLocationRevision: 1, relativePath }; }
test("schema15 is additive, empty output authority cannot be inferred from ordinary OUTDIR", () => {
 const f = fixture(); expect(f.db.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION); expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(15); expect(f.db.integrity().ok).toBe(true);
 const path = join(ensureOutdir(f.home, f.sessionId), "ordinary.bin"); writeFileSync(path, "ordinary");
 expect(outdirPath(f.home, f.sessionId)).not.toBe(f.root); expect(f.outputs.list(outputUser, { workspaceId: f.workspaceId })).toEqual({ locations: [], nextCursor: null });
 refusal(() => f.outputs.stat(outputUser, request(f, "unknown")), "authority_denied"); expect(existsSync(f.root)).toBe(false); expect(readFileSync(path, "utf8")).toBe("ordinary");
 expect(() => downgradeCoworkRuntimeStateToV7(f.home)).toThrow("Cowork authority");
});
test("local service refuses paired/runtime/extra paths before backing access, preserving empty roots", () => {
 const f = fixture(), local = { role: "harness", connectionId: 1 };
 expect(f.service.call(local, "workspace.output.list", { workspaceId: f.workspaceId })).toEqual({ locations: [], nextCursor: null });
 expect(() => f.service.call(local, "workspace.file.stat", { ...request(f, "unknown"), path: "/host" })).toThrow("Unrecognized key");
 f.host.principal = () => ({ kind: "paired-user", id: "phone", workspaceIds: new Set([f.workspaceId]), repositoryAuthorities: new Set() });
 refusal(() => f.service.call({ role: "remote", connectionId: 2 }, "workspace.output.list", { workspaceId: f.workspaceId }), "authority_denied");
 f.host.principal = () => ({ kind: "runtime", id: "runtime", workspaceId: f.workspaceId, sessionId: f.sessionId });
 refusal(() => f.service.call(local, "workspace.file.stat", request(f, "unknown")), "authority_denied"); expect(existsSync(f.root)).toBe(false);
});
test("unsupported host leaves ordinary service available and refuses output filesystem consumers", () => {
 const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
 try { Object.defineProperty(process, "platform", { ...descriptor, value: "linux" }); refusal(() => new CoworkOutputs(f.records, f.home, f.grants), "unsupported_topology"); const service = new CoworkWorkspaceService(f.records, f.host, undefined, f.home); expect(service.outputs).toBeUndefined(); refusal(() => service.call({ role: "harness", connectionId: 1 }, "workspace.output.list", { workspaceId: f.workspaceId }), "unsupported_topology"); expect(service.call({ role: "harness", connectionId: 1 }, "workspace.get", { workspaceId: f.workspaceId }).workspaceId).toBe(f.workspaceId); }
 finally { Object.defineProperty(process, "platform", descriptor); }
 expect(f.records.get(f.workspaceId).state).toBe("retained");
});
native("actual recorded output roots survive reopening and binary ranges work with VM stopped", () => {
 const f = fixture(), location = f.initialize(), bytes = Buffer.from([0, 255, 1, 128, 10, 13]); writeFileSync(join(f.root, "file.bin"), bytes);
 expect(f.db.integrity().ok).toBe(true); expect(f.records.get(f.workspaceId).power).toBe("stopped"); // Fixture authority only; no VM exists.
 const input = request(f, location.locationId), stat = f.outputs.stat(outputUser, input);
 expect(COWORK_RPC["workspace.file.stat"].result.parse(stat).bytes).toBe(bytes.length);
 const chunk = f.outputs.read(outputUser, { ...input, expectedGeneration: stat.generation, offset: 0, maxBytes: 3 });
 expect(Buffer.from(chunk.contentBase64, "base64")).toEqual(bytes.subarray(0, 3)); expect(chunk.nextOffset).toBe(3); expect(chunk.eof).toBe(false);
 const tail = f.outputs.read(outputUser, { ...input, expectedGeneration: stat.generation, offset: 3, maxBytes: 3 }); expect(Buffer.from(tail.contentBase64, "base64")).toEqual(bytes.subarray(3)); expect(tail.eof).toBe(true);
 expect(f.outputs.read(outputUser, { ...input, expectedGeneration: stat.generation, offset: bytes.length }).contentBase64).toBe("");
 const second = openRuntimeStateDb(f.home); try { const owner = new CoworkOutputs(new CoworkRepository(second), f.home, f.grants); expect(owner.stat(outputUser, input)).toEqual(stat); } finally { second.close(); }
 expect(JSON.stringify(stat)).not.toContain(f.home); expect(stat).not.toHaveProperty("device"); expect(stat).not.toHaveProperty("inode");
});
native("initializer requires committed session, no outer transaction, canonical binding and new storage", () => {
 const f = fixture(); refusal(() => f.outputs.initialize(f.workspaceId, "absent", f.store), "not_found");
 refusal(() => f.outputs.initialize(f.workspaceId, f.sessionId, undefined as any), "authority_denied");
 (f.store as unknown as { db: Database }).db.transaction(() => { (f.store as unknown as { db: Database }).db.run("UPDATE sessions SET last_seq=0 WHERE session_id=?", [f.sessionId]); refusal(() => f.outputs.initialize(f.workspaceId, f.sessionId, f.store), "authority_denied"); })();
 expect(existsSync(f.root)).toBe(false);
 (f.store as unknown as { db: Database }).db.run("UPDATE sessions SET last_seq=1 WHERE session_id=?", [f.sessionId]);
 f.db.transaction(() => refusal(() => f.outputs.initialize(f.workspaceId, f.sessionId, f.store), "authority_denied")); expect(existsSync(f.root)).toBe(false);
 mkdirSync(f.root, { recursive: true, mode: 0o700 }); refusal(() => f.outputs.initialize(f.workspaceId, f.sessionId, f.store), "file_unavailable");
 expect(f.db.db.query("SELECT COUNT(*) AS n FROM cowork_output_locations").get()).toEqual({ n: 0 });
});
native("missing recorded root never recreates or reenrolls; missing content is a distinct result", () => {
 const f = fixture(), location = f.initialize(), input = request(f, location.locationId);
 refusal(() => f.outputs.stat(outputUser, input), "file_missing");
 rmSync(f.root, { recursive: true }); refusal(() => f.outputs.stat(outputUser, input), "file_unavailable"); expect(existsSync(f.root)).toBe(false);
 mkdirSync(f.root, { mode: 0o700 }); writeFileSync(join(f.root, "file.bin"), "replacement"); refusal(() => f.outputs.stat(outputUser, input), "file_unavailable");
 refusal(() => f.outputs.initialize(f.workspaceId, f.sessionId, f.store), "request_conflict");
});
native("traversal, symlink, hardlink, FIFO, socket and directory entries never become file content", () => {
 const f = fixture(), location = f.initialize(), outside = join(f.home, "outside.bin"); writeFileSync(outside, "private");
 symlinkSync(outside, join(f.root, "symlink")); linkSync(outside, join(f.root, "hardlink")); mkdirSync(join(f.root, "directory"));
 expect(spawnSync("/usr/bin/mkfifo", [join(f.root, "fifo")]).status).toBe(0);
 const socket = Bun.listen({ unix: join(f.root, "socket"), socket: { data() {} } });
 try { for (const name of ["symlink", "hardlink", "fifo", "socket", "directory"]) refusal(() => f.outputs.stat(outputUser, request(f, location.locationId, name)), "file_unavailable"); } finally { socket.stop(true); }
 const local = { role: "harness", connectionId: 1 };
 for (const relativePath of ["../outside.bin", "/outside.bin", "directory/../../outside.bin"]) expect(() => f.service.call(local, "workspace.file.stat", request(f, location.locationId, relativePath))).toThrow("Invalid input");
 symlinkSync(f.home, join(f.root, "parent-link")); refusal(() => f.outputs.stat(outputUser, request(f, location.locationId, "parent-link/outside.bin")), "file_unavailable");
 expect(readFileSync(outside, "utf8")).toBe("private");
});
native("nested user files and control-like ordinary content names remain readable", () => {
 const f = fixture(), location = f.initialize(); mkdirSync(join(f.root, "nested"));
 for (const name of ["manifest.json", "index.db", "file.db-wal", 'quote"\\newline\n', "😀"]) { writeFileSync(join(f.root, "nested", name), Buffer.from([0, 255])); expect(f.outputs.stat(outputUser, request(f, location.locationId, `nested/${name}`)).bytes).toBe(2); }
});
native("stale generations, range and allocation bounds reject changed files", () => {
 const f = fixture(), location = f.initialize(), input = request(f, location.locationId), path = join(f.root, "file.bin"); writeFileSync(path, Buffer.alloc(COWORK_FILE_CHUNK_MAX_BYTES + 1, 128));
 const stat = f.outputs.stat(outputUser, input), range = { ...input, expectedGeneration: stat.generation, offset: 0, maxBytes: COWORK_FILE_CHUNK_MAX_BYTES };
 expect(Buffer.from(f.outputs.read(outputUser, range).contentBase64, "base64").length).toBe(COWORK_FILE_CHUNK_MAX_BYTES);
 refusal(() => f.outputs.read(outputUser, { ...range, maxBytes: COWORK_FILE_CHUNK_MAX_BYTES + 1 }), "invalid_request"); refusal(() => f.outputs.read(outputUser, { ...range, offset: stat.bytes + 1 }), "invalid_request");
 writeFileSync(path, "new"); refusal(() => f.outputs.read(outputUser, range), "stale_file");
 refusal(() => f.outputs.stat(outputUser, { ...input, expectedLocationRevision: 2 }), "revision_conflict");
});
native("actual file mutation/replacement and directory rename races fail before returning bytes", () => {
 for (const attack of ["file-mutation", "file-replacement", "ancestor", "mode"] as const) {
  let armed = false; const f = fixture(phase => { if (!armed || phase !== "after-file-read") return; armed = false;
   if (attack === "file-mutation") writeFileSync(join(f.root, "file.bin"), "changed");
   if (attack === "file-replacement") { renameSync(join(f.root, "file.bin"), join(f.root, "old.bin")); writeFileSync(join(f.root, "file.bin"), "replacement"); }
   if (attack === "ancestor") { renameSync(f.root, `${f.root}-moved`); mkdirSync(f.root, { mode: 0o700 }); writeFileSync(join(f.root, "file.bin"), "replacement"); }
   if (attack === "mode") chmodSync(join(f.root, "file.bin"), 0o400);
  });
  const location = f.initialize(), input = request(f, location.locationId); writeFileSync(join(f.root, "file.bin"), "original"); const stat = f.outputs.stat(outputUser, input); armed = true;
  refusal(() => f.outputs.read(outputUser, { ...input, expectedGeneration: stat.generation, offset: 0 }), attack === "ancestor" ? "file_unavailable" : "stale_file");
 }
});
native("initializer interrupted before owner commit leaves unknown data refused after restart", () => {
 const f = fixture(phase => { if (phase === "before-owner-commit") throw new Error("crash"); }); refusal(() => f.initialize(), "file_unavailable");
 expect(existsSync(f.root)).toBe(true); expect(f.db.db.query("SELECT COUNT(*) AS n FROM cowork_output_locations").get()).toEqual({ n: 0 });
 const restarted = new CoworkOutputs(f.records, f.home, f.grants); refusal(() => restarted.initialize(f.workspaceId, f.sessionId, f.store), "file_unavailable");
});
native("opaque inventory pagination, cross-scope, archived and deleted conversation retention", () => {
 const f = fixture(), first = f.initialize(), secondSession = f.bind("bind-second"); f.outputs.initialize(f.workspaceId, secondSession, f.store);
 const page = f.outputs.list(outputUser, { workspaceId: f.workspaceId, limit: 1 }); expect(page.locations).toHaveLength(1); expect(page.nextCursor).not.toBeNull();
 const tail = f.outputs.list(outputUser, { workspaceId: f.workspaceId, limit: 1, cursor: page.nextCursor! }); expect(tail.locations).toHaveLength(1); expect(tail.locations[0]!.locationId).not.toBe(page.locations[0]!.locationId);
 const thirdSession = f.bind("bind-third"); f.outputs.initialize(f.workspaceId, thirdSession, f.store); refusal(() => f.outputs.list(outputUser, { workspaceId: f.workspaceId, cursor: page.nextCursor! }), "stale_cursor");
 const another = fixture(); refusal(() => another.outputs.stat(outputUser, request(another, first.locationId)), "authority_denied");
 writeFileSync(join(f.root, "file.bin"), "retained"); f.records.abandonConversation(f.sessionId); expect(f.outputs.stat(outputUser, request(f, first.locationId)).bytes).toBe(8);
 f.db.transaction(() => f.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [f.workspaceId])); expect(f.outputs.stat(outputUser, request(f, first.locationId)).bytes).toBe(8);
});
native("external committed workspace deletion during a read is refused by final authority guard", () => {
 let armed = false; const f = fixture(phase => { if (armed && phase === "after-file-read") { armed = false; const writer = openRuntimeStateDb(f.home); try { writer.transaction(() => writer.db.run("UPDATE cowork_workspaces SET state='deleting' WHERE workspace_id=?", [f.workspaceId]), { mode: "immediate" }); } finally { writer.close(); } } });
 const location = f.initialize(), input = request(f, location.locationId); writeFileSync(join(f.root, "file.bin"), "data"); const stat = f.outputs.stat(outputUser, input); armed = true;
 refusal(() => f.outputs.read(outputUser, { ...input, expectedGeneration: stat.generation, offset: 0 }), "authority_denied");
});

native("short read during an actual truncation refuses incomplete content", () => {
 let armed = false; const f = fixture(phase => { if (armed && phase === "file-opened") { armed = false; writeFileSync(join(f.root, "file.bin"), ""); } });
 const location = f.initialize(), input = request(f, location.locationId); writeFileSync(join(f.root, "file.bin"), "original"); const stat = f.outputs.stat(outputUser, input); armed = true;
 refusal(() => f.outputs.read(outputUser, { ...input, expectedGeneration: stat.generation, offset: 0 }), "file_incomplete");
});

test("schema14 upgrades to15 preserving existing workspace/HomeIdentity and default Code settings", () => {
 const f = fixture(), before = f.records.get(f.workspaceId), homeId = f.records.recordedHomeIdentity();
 const settings = () => ["synchronous", "fullfsync", "checkpoint_fullfsync"].map(name => f.db.db.query<Record<string, number>, []>(`PRAGMA ${name}`).get()![name]); const prior = settings();
 f.db.db.run("DROP TABLE cowork_output_locations"); f.db.db.run("DROP TABLE cowork_output_directories"); f.db.db.run("PRAGMA user_version=14");
 const upgraded = openRuntimeStateDb(f.home); try { expect(upgraded.schemaVersion()).toBe(15); const records = new CoworkRepository(upgraded); expect(records.get(f.workspaceId)).toEqual(before); expect(records.recordedHomeIdentity()).toBe(homeId); expect(upgraded.integrity().ok).toBe(true); } finally { upgraded.close(); }
 expect(settings()).toEqual(prior);
});
native("owner transaction failure rolls back root authority and refuses orphan enrollment", () => {
 const f = fixture(); f.db.db.run("CREATE TRIGGER refuse_output_owner BEFORE INSERT ON cowork_output_locations BEGIN SELECT RAISE(ABORT,'injected owner crash'); END");
 refusal(() => f.initialize(), "file_unavailable"); expect(f.db.db.query("SELECT COUNT(*) AS n FROM cowork_output_locations").get()).toEqual({ n: 0 }); expect(f.db.db.query("SELECT COUNT(*) AS n FROM cowork_output_directories").get()).toEqual({ n: 0 });
 expect(existsSync(f.root)).toBe(true); f.db.db.run("DROP TRIGGER refuse_output_owner"); refusal(() => f.initialize(), "file_unavailable");
});

native("service refuses nested directory and file devices against the canonical output root", () => {
 const f = fixture(), location = f.initialize(), nested = join(f.root, "nested"), path = join(nested, "file.bin"); mkdirSync(nested); writeFileSync(path, "ordinary");
 const input = request(f, location.locationId, "nested/file.bin"), local = { role: "harness", connectionId: 1 };
 const positive = f.service.call(local, "workspace.file.stat", input); expect(positive.bytes).toBe(8);
 const rootStat = fs.statSync(f.root, { bigint: true }), nestedStat = fs.statSync(nested, { bigint: true }), fileStat = fs.statSync(path, { bigint: true }), original = fs.fstatSync;
 for (const changed of ["nested-and-file", "file-only"] as const) {
  let observed = 0;
  const mocked = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: any) => {
   const actual = original(fd, options) as unknown as fs.Stats | fs.BigIntStats;
   if (options?.bigint && (actual as fs.BigIntStats).dev === rootStat.dev && ((changed === "nested-and-file" && (actual as fs.BigIntStats).ino === nestedStat.ino) || (actual as fs.BigIntStats).ino === fileStat.ino)) {
    observed++; return Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { dev: rootStat.dev + 1n });
   }
   return actual;
  }) as typeof fs.fstatSync);
  try { refusal(() => f.service.call(local, "workspace.file.stat", input), "file_unavailable"); expect(observed).toBeGreaterThan(0); }
  finally { mocked.mockRestore(); }
 }
 expect(f.service.call(local, "workspace.file.stat", input)).toEqual(positive);
 const read = f.service.call(local, "workspace.file.read", { ...input, expectedGeneration: positive.generation }); expect(Buffer.from(read.contentBase64, "base64").toString()).toBe("ordinary");
});
