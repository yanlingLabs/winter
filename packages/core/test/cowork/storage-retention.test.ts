// Retention of Cowork host storage. Every rule below is pinned to the document sentence it enforces.
// None of them adds a deletion: the only automatic deletion paths are the documented session exceptions
// (the empty-session reaper and the once-per-lifetime cleaner, both through SessionStore.deleteSession),
// and they remove a session and its binding, never a workspace's volumes, memory, outputs or repositories.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkVolumes, CoworkVolumeError, RAW_VOLUME_MIN_BYTES, type CoworkVolumeAuthority, type CoworkVolumeRequest } from "../../src/cowork/volumes";
import type { CoworkVolumeBackup } from "../../src/cowork/volume-backup";
import { createCoworkSessionDeletionHook } from "../../src/cowork/workspace-events";
import { reapEmptySessions } from "../../src/sessions/reaper";
import { SessionStore } from "../../src/sessions/store";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { authorityFixtureSessions } from "./committed-sessions";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => { try { fn(); } catch { /* best effort */ } }); });

const proof = {}, stopProof = {};
const authority: CoworkVolumeAuthority = { authorize: (_action, input) => input.proof === proof, verifyStopped: (_input, stop) => stop.proof === stopProof };

/** A workspace bound to a real indexed session, with two sparse images that hold bytes and shared
 * instructions, memory and an output file for that session. Standalone by default; `project` for a shared one. */
function fixture(ownership: "standalone" | "project" = "standalone") {
  const home = mkdtempSync(join(tmpdir(), "winter-cowork-retention-"));
  const db: RuntimeStateDb = openRuntimeStateDb(home), store = new SessionStore(home), repo = new CoworkRepository(db);
  cleanup.push(() => { store.close(); db.close(); rmSync(home, { recursive: true, force: true }); });
  repo.homeIdentity();
  const sessionId = store.createSession("global", { mode: "code" });
  const made = repo.create({ principalId: "fixture-user", requestId: "create" }, {
    ownership, title: "Retention fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }],
    ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" },
  });
  const workspaceId = made.workspaceId;
  // The standalone owner is the reserved conversation; the fixture points the reservation at the real session.
  if (ownership === "standalone") db.db.run("UPDATE cowork_workspaces SET owner_id=? WHERE workspace_id=?", [sessionId, workspaceId]);
  const epoch = repo.beginIncarnation(workspaceId, "fixture-incarnation", repo.get(workspaceId).configRevision);
  repo.acknowledgeSource(epoch, made.value.sources[0]!.sourceId, 1, "ready");
  repo.bindConversation({ principalId: "fixture-user", requestId: "bind", expectedRevision: repo.get(workspaceId).configRevision }, workspaceId, { sessionId, sourceId: made.value.sources[0]!.sourceId }, authorityFixtureSessions(sessionId));
  db.transaction(() => db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [workspaceId]));
  const excluded = new Set<string>();
  const key = (fd: number) => { const st = fstatSync(fd); return `${st.dev}:${st.ino}`; };
  const backup: CoworkVolumeBackup = { excludeItem: (_p, fd) => { excluded.add(key(fd)); }, verifyItemExcluded: (_p, fd) => excluded.has(key(fd)), verifyDescriptorExcluded: fd => excluded.has(key(fd)) };
  const request: CoworkVolumeRequest = { workspaceId, proof, owner: { controllerInstanceId: "controller-one", workerInstanceId: "worker-one", incarnationId: "incarnation-one", leaseEpoch: 1, runtimeImageDigest: "a".repeat(64) } };
  const volumes = new CoworkVolumes(db, home, authority, backup);
  volumes.plan(request, { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES }); volumes.materialize(request);
  const dir = join(home, "cowork", "workspaces", workspaceId);
  for (const name of ["data.ext4", "env.ext4"]) { const fd = openSync(join(dir, name), "r+"), bytes = Buffer.from(`durable guest bytes in ${name}`); writeSync(fd, bytes, 0, bytes.length, 8192); closeSync(fd); }
  const shared = [["instructions/WINTER.md", "# workspace guidance"], ["memory/notes.md", "- remembered"], [`outputs/${sessionId}/report.pdf`, "deliverable"], [`outputs/${sessionId}/index.db`, "an artifact that happens to be named like an index"]] as const;
  for (const [rel, body] of shared) { mkdirSync(join(dir, "shared", rel, ".."), { recursive: true }); writeFileSync(join(dir, "shared", rel), body); }
  return { home, db, store, repo, volumes, request, workspaceId, sessionId, dir, sourceId: made.value.sources[0]!.sourceId };
}
type Fixture = ReturnType<typeof fixture>;

/** Everything a retention rule may not disturb: volume records, source rows, and every byte beneath the workspace directory. */
function retained(f: Fixture) {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name), st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else files[relative(f.dir, abs)] = `${st.size}:${st.ino}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
    }
  };
  walk(f.dir);
  return { files, power: f.repo.get(f.workspaceId).power, volumes: f.volumes.records(f.workspaceId), sources: f.repo.sources(f.workspaceId).map(s => [s.sourceId, s.state, s.desired]) };
}
const lifecycle = (f: Fixture) => { const w = f.repo.get(f.workspaceId); return { state: w.state, configRevision: w.configRevision }; };
const remove = (f: Fixture, door: "reaper" | "store") => {
  const hook = createCoworkSessionDeletionHook(f.repo);
  if (door === "reaper") expect(reapEmptySessions({ store: f.store, attachedCount: () => 0, home: f.home, now: () => Date.now() + 3 * 24 * 3600_000, onDelete: hook })).toEqual([f.sessionId]);
  else { f.store.deleteSession(f.sessionId); hook(f.sessionId); }
  expect(() => f.store.getTitle(f.sessionId)).toThrow("unknown session"); // the session really is gone
};
// docs/cowork-execution-contracts.md: "Deleting a standalone conversation does not silently destroy its
// workspace. Detach/archive its workspace for explicit later deletion/export; ... Empty-session reapers, runtime
// retention and model-driven session cleanup may not delete Cowork volumes or shared Project data." and
// docs/cowork-spec.md: "Archive preserves data; deletion is separate."
for (const door of ["reaper", "store"] as const) {
  test(`deleting a standalone workspace's only conversation through ${door === "reaper" ? "the empty-session reaper" : "the shared SessionStore.deleteSession door (user delete and the cleaner)"} archives the workspace and retains both volumes and every shared file`, () => {
    const f = fixture(), before = retained(f), revision = lifecycle(f).configRevision;
    expect(lifecycle(f).state).toBe("retained");
    expect(Object.keys(before.files).sort()).toEqual(["data.ext4", "env.ext4", "shared/instructions/WINTER.md", "shared/memory/notes.md", `shared/outputs/${f.sessionId}/index.db`, `shared/outputs/${f.sessionId}/report.pdf`].sort());
    remove(f, door);
    expect(f.repo.binding(f.sessionId).state).toBe("deleted"); // its binding is tombstoned, never reused
    expect(lifecycle(f)).toEqual({ state: "archived", configRevision: revision + 1 }); // detached, and visible to a revision-keyed client
    expect(retained(f)).toEqual(before); // volume records, sources, power and every byte unchanged
    // detached: no wake, no disk admission until it is explicitly restored (there is no restore operation yet)
    for (const attempt of [() => f.volumes.claim(f.request), () => f.volumes.open(f.request, "data")]) {
      try { attempt(); throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(CoworkVolumeError); expect((error as CoworkVolumeError).code).toBe("authority_denied"); }
    }
    expect(f.db.integrity().ok).toBe(true);
    createCoworkSessionDeletionHook(f.repo)(f.sessionId); // a repeated retirement is harmless
    expect(lifecycle(f)).toEqual({ state: "archived", configRevision: revision + 1 });
  });
}

test("deleting one Project conversation never archives the shared workspace, and changes no revision", () => {
  const f = fixture("project"), before = retained(f), life = lifecycle(f);
  remove(f, "store");
  expect(f.repo.binding(f.sessionId).state).toBe("deleted");
  expect(lifecycle(f)).toEqual(life); expect(life.state).toBe("retained");
  expect(retained(f)).toEqual(before);
});

test("ownership kind, not just the owner id, decides: a Project workspace whose owner id was corrupted to the session id still is not archived", () => {
  const f = fixture("project");
  f.db.db.run("UPDATE cowork_workspaces SET owner_id=? WHERE workspace_id=?", [f.sessionId, f.workspaceId]);
  const life = lifecycle(f); remove(f, "store");
  expect(lifecycle(f)).toEqual(life);
});

test("a standalone workspace that is not stopped, or is already past retained, keeps its state when its conversation goes", () => {
  for (const [power, state] of [["running", "retained"], ["starting", "retained"], ["draining", "retained"], ["uncertain", "retained"], ["stopped", "deleting"], ["stopped", "archived"]] as const) {
    const f = fixture();
    f.db.db.run("UPDATE cowork_workspaces SET power=?, state=? WHERE workspace_id=?", [power, state, f.workspaceId]);
    const life = lifecycle(f); remove(f, "store");
    expect(lifecycle(f)).toEqual(life);
  }
});

test("only the standalone owner's retirement archives: another binding row on that workspace leaves it retained", () => {
  const f = fixture(), life = lifecycle(f);
  f.db.db.run("INSERT INTO cowork_conversations(session_id,workspace_id,project_id,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at) VALUES('s_other',?,NULL,?,'.','auto','{}',1,'active','t')", [f.workspaceId, f.sourceId]);
  f.repo.abandonConversation("s_other");
  expect(f.repo.binding("s_other").state).toBe("deleted");
  expect(lifecycle(f)).toEqual(life);
});

// docs/cowork-spec.md, "Archived | Refuse automatic wake until explicitly restored"; restore returns
// the same data (host-protocol: "restore never restores revoked grants or deleted backing").
test("an archived, deleting or deleted workspace refuses any disk admission and changes nothing; restoring the state admits the same disks", () => {
  const f = fixture(), before = retained(f);
  for (const state of ["archived", "deleting", "deleted"]) {
    f.db.db.run("UPDATE cowork_workspaces SET state=? WHERE workspace_id=?", [state, f.workspaceId]);
    for (const attempt of [() => f.volumes.claim(f.request), () => f.volumes.open(f.request, "data")]) {
      try { attempt(); throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(CoworkVolumeError); expect((error as CoworkVolumeError).code).toBe("authority_denied"); }
    }
    expect(() => f.repo.beginIncarnation(f.workspaceId, "wake", f.repo.get(f.workspaceId).configRevision)).toThrow();
  }
  f.db.db.run("UPDATE cowork_workspaces SET state='retained' WHERE workspace_id=?", [f.workspaceId]);
  expect(retained(f)).toEqual(before);
  const claimed = f.volumes.claim(f.request);
  expect(claimed.map(v => v.purpose).sort()).toEqual(["data", "environment"]);
  const handle = f.volumes.open(f.request, "data"); const probe = Buffer.alloc(32); readSync(handle.fd, probe, 0, 32, 8192); handle.close();
  expect(probe.toString()).toContain("durable guest bytes in data.ext4");
});

// docs/cowork-raw-volumes.md: "There is no destructive cleanup or automatic replacement operation." and
// docs/cowork-execution-contracts.md: deletion/retention "must not silently remove uncommitted work,
// transcripts, memory or outputs". A ratchet, not a proof: adding a removal/truncation primitive anywhere
// under src/cowork fails here until the retention rules above are reviewed for it.
const DESTRUCTIVE = new RegExp([
  String.raw`\b(?:rmSync|unlinkSync|rmdirSync|truncateSync|ftruncateSync|renameSync|unlink|rmdir|truncate|rename|ftruncate)\s*\(`, // fs calls, sync or promise
  String.raw`\brm\s*\(`, String.raw`\bunlinkat\b`, String.raw`\brenameat\b`, String.raw`\brenamex_np\b`, // renamex_np: RENAME_SWAP exchanges two names, RENAME_EXCL never overwrites
  String.raw`\bO_TRUNC\b`, // an open that truncates
  String.raw`\bBun\.write\s*\(`, // Bun's overwrite-by-default writer
  String.raw`["'\x60](?:/(?:usr/)?bin/)?rm(?:["'\x60\s])`, // spawning rm: ["rm", ...], "/bin/rm", "rm -rf ...", and Bun shell $\`rm ...\`
].join("|"));
test("the ratchet pattern recognizes each removal, rename-over and truncation form, and not lookalikes", () => {
  for (const code of [
    "rmSync(p, { recursive: true })", "await rm(p, { force: true })", "unlinkSync(p)", "await unlink(p)", "rmdirSync(d)", "await rmdir(d)", "truncateSync(p, 0)", "await truncate(p)",
    "ftruncateSync(fd, 0)", "await ftruncate(fd, 0)", "renameSync(a, b)", "await rename(a, b)", "native().symbols.renameat!(d, a, d, b)", "lib().symbols.renamex_np!(a, b, 2)", "unlinkat(fd, name, 0)",
    "openSync(p, O_WRONLY | O_TRUNC)", "constants.O_TRUNC", "await Bun.write(path, bytes)", 'spawnSync("rm", ["-rf", p])', 'Bun.spawn(["/bin/rm", "-rf", p])', 'execFileSync("/usr/bin/rm", [p])',
    'execSync("rm -rf " + p)', "await $`rm -rf ${p}`",
  ]) expect([code, DESTRUCTIVE.test(code)]).toEqual([code, true]);
  for (const code of ["const norm = normalize(p)", "perform(task)", "alarm(1)", "const form = 1", "program(x)", "readFileSync(p)", "writeSync(fd, bytes)", 'const label = "rmdirectory"', "format(x)", "mkdirSync(d)", "const truncated = x"]) {
    expect([code, DESTRUCTIVE.test(code)]).toEqual([code, false]);
  }
});
test("no Cowork source file removes, renames-over or truncates anything beyond the audited sites", () => {
  const root = join(import.meta.dir, "..", "..", "src", "cowork");
  const files: string[] = [];
  const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk(root);
  const destructive = DESTRUCTIVE;
  const found: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (/^\s*(\/\*|\*)/.test(line)) return; // doc-comment lines
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (destructive.test(code)) found.push(`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  const audited = [
    // Sizes a recorded virgin inode (zero or exact final size) to its logical capacity; never shrinks data.
    /^volumes\.ts:\d+: .*ftruncateSync\(fd, volume\.capacityBytes\)/,
    // The Git broker's own quarantine directory for rejected objects; not workspace storage.
    /^git\/broker\.ts:\d+: .*rm\(quarantine/,
    // The approved WINTER.md write: renameat replaces the instruction file's directory entry atomically
    // (a content-bound, user-approved edit); it never removes workspace data.
    /^instruction-fs\.ts:\d+: .*renameat/,
    // The export writer and the restore flow (export-io.ts). `renamex_np` is only ever called with RENAME_EXCL (the finished
    // bundle appears under a name that does not exist, or a restore places an image where none is) or RENAME_SWAP (an
    // atomic exchange of a verified staged image with the live one, after an explicit confirmation). The exchanged-out
    // image is kept in `restore-aside-<exportId>/`; nothing is unlinked or truncated.
    /^export-io\.ts:\d+: .*renamex_np/,
    // A failed export removes only the dot-named `.partial` folder it created this call in the destination (or, if the record then refused to complete, the bundle it had just renamed into place).
    /^export-writer\.ts:\d+: .*rmSync\(owned/,
    // A restore that failed BEFORE its first exchange removes only its own `.restore-<exportId>` staging folder, which holds
    // copies from the bundle and no live data. After the first exchange nothing is removed (the staging folder holds the old images).
    /^restore-bundle\.ts:\d+: .*rmSync\(staging/,
    // The production native environment's coordination files (S7B part 1), all in the Coordination directory and none in a workspace: the
    // installation id's and the stores' own temp files, the atomic replace of a launch-journal entry, and the retirement of a launcher
    // receipt or journal entry of one scope. No workspace data, image or output is touched.
    /^host-env\/coordination\.ts:\d+: .*unlinkSync\(temporary\)/,
    /^host-env\/stores\.ts:\d+: .*(renameSync\(temporary|unlinkSync\(temporary\)|unlinkSync\(join\(directory, name\)\))/,
  ];
  const unexpected = found.filter(line => !audited.some(pattern => pattern.test(line)));
  expect(unexpected).toEqual([]);
  for (const pattern of audited) expect(found.some(line => pattern.test(line))).toBe(true); // a stale allowlist entry is also a failure
});

test("the retained-workspace fixture really has the shape the rules above assume", () => {
  const f = fixture();
  expect(existsSync(join(f.dir, "data.ext4"))).toBe(true);
  expect(f.repo.get(f.workspaceId).ownership).toBe("standalone");
  expect(f.repo.binding(f.sessionId).state).toBe("active");
  expect(f.volumes.records(f.workspaceId)).toHaveLength(2);
});
