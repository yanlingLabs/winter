// The `.winterworkspace` writer. Each rule is pinned to the document sentence it enforces, and each guard has a test that
// fails when the guard is removed (the mutation scripts live with the lane's scratch notes).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkfifoSyncForTest, openSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "./export-fs";
import { join } from "node:path";
import { BUNDLE_IMAGE_FILES, DEFAULT_BUNDLE_LIMITS, serializeIntegrity, verifyBundle, walkRegularFilesAt } from "../../src/cowork/export-bundle";
import { ExportIoError, hasExtendedAttributes, openDirectoryNoFollow } from "../../src/cowork/export-io";
import { EXPORT_PLAINTEXT_DISCLOSURE } from "../../src/cowork/exports";
import { CoworkLifecycleError, canonicalJson, sha256Hex } from "../../src/cowork/storage-lifecycle";
import { A, BACKUP_XATTR, PROOF, SECRET, failsWith, fixture, listXattrs, onCleanup, poke, runCleanup, setXattr, type Fixture } from "./export-fixture";

setDefaultTimeout(60_000);
afterEach(runCleanup);
void onCleanup;

const entriesOf = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();
const bundleFiles = (path: string) => entriesOf(path).filter(entry => lstatSync(join(path, entry)).isFile());
const record = (f: Fixture, id: string) => f.db.db.query<Record<string, any>, [string]>("SELECT * FROM cowork_exports WHERE export_id=?").get(id)!;

test("an export is a folder bundle holding exactly the whitelist: the recorded manifest bytes, an integrity index, both images and the three shared roots", async () => {
  const f = await fixture();
  const result = await f.exportOnce("my-backup");
  const opaqueId = Object.keys(f.bound.get(result.exportId)!.outputIds)[0]!;
  expect(opaqueId).toMatch(/^s[0-9a-f]{16}$/);
  expect(result.path).toBe(join(f.destination, "my-backup.winterworkspace"));
  expect(result.disclosure).toBe(EXPORT_PLAINTEXT_DISCLOSURE);
  expect(bundleFiles(result.path)).toEqual(["data.ext4", "env.ext4", "integrity.json", "manifest.json",
    "shared/instructions/WINTER.md", "shared/memory/deep/er/fact.txt", "shared/memory/notes.md", `shared/outputs/${opaqueId}/empty.txt`, `shared/outputs/${opaqueId}/report.pdf`]);
  // The manifest is the RECORD, byte for byte: validateImport digests it against the row.
  const row = record(f, result.exportId);
  expect(readFileSync(join(result.path, "manifest.json"), "utf8")).toBe(row.manifest_json);
  expect(sha256Hex(readFileSync(join(result.path, "manifest.json"), "utf8"))).toBe(row.manifest_digest);
  expect(row.state).toBe("complete");
  // Images are byte-identical to the stopped source; the index verifies end to end.
  for (const [file, purpose] of [["data.ext4", "data"], ["env.ext4", "environment"]] as const) expect(Buffer.compare(readFileSync(join(result.path, file)), readFileSync(f.image(purpose)))).toBe(0);
  const verified = await verifyBundle(result.path);
  expect(verified.integrity.exportId).toBe(result.exportId);
  expect(verified.files.size).toBe(8);
  // The database-side binding holds the digest of integrity.json and the only copy of the session ids.
  expect(verified.integrityDigest).toBe(result.contentDigest); expect(f.bound.get(result.exportId)).toEqual({ contentDigest: result.contentDigest, outputIds: { [opaqueId]: "session-one" } });
  for (const file of bundleFiles(result.path)) expect(file).not.toContain("session-one");
  expect(readFileSync(join(result.path, "integrity.json"), "utf8")).not.toContain("session-one");
  verified.close();
  // No absolute path, home path or host name in anything the bundle states about itself.
  for (const name of ["manifest.json", "integrity.json"]) { const text = readFileSync(join(result.path, name), "utf8"); expect(text).not.toContain(f.base); expect(text).not.toContain("/Users"); }
  // Owner-only, nothing executable, and backup-eligible: the original's sticky exclusion and xattrs did not travel.
  for (const file of bundleFiles(result.path)) expect(statSync(join(result.path, file)).mode & 0o777).toBe(0o600);
  for (const image of BUNDLE_IMAGE_FILES) { expect(listXattrs(join(result.path, image))).toEqual([]); const fd = openSync(join(result.path, image), "r"); try { expect(hasExtendedAttributes(fd)).toBe(false); } finally { closeSync(fd); } }
  expect(listXattrs(f.image("data"))).toContain(BACKUP_XATTR); // the source keeps its own
  expect(readdirSync(f.destination)).toEqual(["my-backup.winterworkspace"]);
});

test("opaque output ids are random per export: never derived from the session id, never repeated across exports", async () => {
  const f = await fixture();
  const first = await f.exportOnce("one"), second = await f.exportOnce("two");
  const a = Object.keys(f.bound.get(first.exportId)!.outputIds)[0]!, b = Object.keys(f.bound.get(second.exportId)!.outputIds)[0]!;
  expect(a).toMatch(/^s[0-9a-f]{16}$/); expect(b).toMatch(/^s[0-9a-f]{16}$/); expect(a).not.toBe(b);
  // A scripted mint shows the mapper redraws a collision and refuses a malformed id.
  const { OutputIdMapper } = await import("../../src/cowork/export-bundle");
  const draws = ["s0000000000000000", "s0000000000000000", "short", "s1111111111111111"]; let n = 0;
  const mapper = new OutputIdMapper(() => draws[n++]!);
  expect(mapper.toBundle("one/x")).toBe("s0000000000000000/x"); expect(mapper.toBundle("two/y")).toBe("s1111111111111111/y"); expect(mapper.toBundle("one/z")).toBe("s0000000000000000/z");
  expect(mapper.reverse).toEqual({ s0000000000000000: "one", s1111111111111111: "two" }); expect(mapper.toBundle("loose.txt")).toBe("f/loose.txt");
});

test("images are cloned where the volume allows and sparse-copied otherwise, with identical bytes and no xattrs", async () => {
  const f = await fixture();
  const cloned = await f.exportOnce("clone");
  expect(cloned.imageCopy).toEqual({ data: "clone", environment: "clone" });
  const sparse = await new (await import("../../src/cowork/export-writer")).CoworkWorkspaceExporter({ ...f.writerPorts, allowClone: false }).export({ workspaceId: f.workspaceId, destinationParent: f.destination, name: "sparse", proof: PROOF });
  expect(sparse.imageCopy).toEqual({ data: "sparse", environment: "sparse" });
  expect(statSync(join(sparse.path, "data.ext4")).size).toBe(statSync(f.image("data")).size);
  expect(Buffer.compare(readFileSync(join(sparse.path, "data.ext4")), readFileSync(join(cloned.path, "data.ext4")))).toBe(0);
  for (const image of BUNDLE_IMAGE_FILES) expect(listXattrs(join(sparse.path, image))).toEqual([]);
});

test("nothing outside the whitelist is exported: no authority database, bookmark, credential, decoy file or path", async () => {
  const f = await fixture();
  const result = await f.exportOnce("clean");
  for (const file of bundleFiles(result.path)) {
    const bytes = readFileSync(join(result.path, file));
    expect([file, bytes.includes(Buffer.from(SECRET))]).toEqual([file, false]);
  }
  const names = entriesOf(result.path).join("\n");
  for (const forbidden of ["runtime-state", "bookmark", "credentials", "secret.txt", "outside-roots", ".db", "Keychain"]) expect(names).not.toContain(forbidden);
});

test("a symlink, hard link or FIFO in a shared root refuses the whole export; the generation is failed and nothing is left behind", async () => {
  for (const make of [
    (f: Fixture) => symlinkSync("/etc/hosts", join(f.shared, "outputs/session-one/link")),
    (f: Fixture) => linkSync(join(f.shared, "memory/notes.md"), join(f.shared, "memory/notes-hard.md")),
    (f: Fixture) => mkfifoSyncForTest(join(f.shared, "outputs/session-one/pipe")),
    (f: Fixture) => symlinkSync(join(f.shared, "memory"), join(f.shared, "outputs/loop")),
    (f: Fixture) => writeFileSync(join(f.shared, "memory", "bad\nname.md"), "x"),
  ]) {
    const f = await fixture(); make(f);
    await failsWith(f.exportOnce("unsafe"), "bundle_unsafe");
    expect(readdirSync(f.destination)).toEqual([]);
    expect(f.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "failed" }]);
  }
  // A shared root that is itself a symlink is refused too, and a root swapped for a link is not followed.
  const g = await fixture(); const target = join(g.base, "elsewhere"); mkdirSync(target); writeFileSync(join(target, "x.txt"), SECRET);
  const memory = join(g.shared, "memory"); mkdirSync(join(g.base, "moved")); symlinkSync(target, join(g.shared, "outputs-link"));
  await (await import("./export-fs")).renameForTest(memory, join(g.base, "moved/memory")); symlinkSync(target, memory);
  await failsWith(g.exportOnce("rootlink"), "bundle_unsafe");
  expect(readdirSync(g.destination)).toEqual([]);
});

test("a shared folder that is not where the record says it is, because a component was replaced by a link, is refused", async () => {
  const f = await fixture(); const moved = join(f.base, "moved-shared");
  await (await import("./export-fs")).renameForTest(f.shared, moved); symlinkSync(moved, f.shared);
  await failsWith(f.exportOnce("moved"), "bundle_unsafe");
  expect(readdirSync(f.destination)).toEqual([]);
});

test("the shared snapshot is two passes: a file that changes between them refuses the export", async () => {
  const f = await fixture();
  f.checkpoints.push(phase => { if (phase === "shared-pass-1") writeFileSync(join(f.shared, "memory/notes.md"), "- changed between the passes\n"); });
  await failsWith(f.exportOnce("racy"), "generation_stale");
  expect(readdirSync(f.destination)).toEqual([]);
  expect(f.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "failed" }]);
  // A file that appears or vanishes between the passes refuses too.
  const g = await fixture();
  g.checkpoints.push(phase => { if (phase === "shared-pass-1") rmFile(join(g.shared, "memory/notes.md")); });
  await failsWith(g.exportOnce("racy2"), "generation_stale");
  const h = await fixture();
  h.checkpoints.push(phase => { if (phase === "shared-pass-1") writeFileSync(join(h.shared, "memory/new.md"), "new\n"); });
  await failsWith(h.exportOnce("racy3"), "generation_stale");
});
const rmFile = (path: string) => { require("node:fs").unlinkSync(path); };

test("a byte written into a source image while it is being copied refuses the export", async () => {
  const f = await fixture();
  f.checkpoints.push(phase => { if (phase === "image-copied:data") poke(f.image("data"), 20000, "X"); });
  await failsWith(f.exportOnce("midcopy"), "generation_stale");
  expect(readdirSync(f.destination)).toEqual([]);
  expect(f.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "failed" }]);
});

test("a claim, run and release of the workspace during the copy refuses the export even though the images look unchanged", async () => {
  const f = await fixture();
  f.checkpoints.push(phase => { if (phase === "shared-snapshotted") f.db.db.run("UPDATE cowork_volumes SET last_stop_id='stop-after-a-run' WHERE workspace_id=?", [f.workspaceId]); });
  await failsWith(f.exportOnce("ran"), "generation_stale");
  const g = await fixture();
  g.checkpoints.push(phase => { if (phase === "shared-snapshotted") g.db.db.run("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", [g.workspaceId]); });
  await failsWith(g.exportOnce("epoch"), "generation_stale");
  expect(readdirSync(g.destination)).toEqual([]);
});

test("the bundle appears atomically, and the generation is complete only after the exclusive rename", async () => {
  const f = await fixture();
  const seen: Record<string, { listing: string[]; state: string }> = {};
  f.checkpoints.push(phase => { if (["before-rename", "before-complete"].includes(phase)) seen[phase] = { listing: readdirSync(f.destination), state: f.db.db.query<{ state: string }, []>("SELECT state FROM cowork_exports").get()!.state }; });
  const result = await f.exportOnce("atomic");
  expect(seen["before-rename"]!.listing).toHaveLength(1); expect(seen["before-rename"]!.listing[0]).toMatch(/^\.[0-9a-f-]+\.partial$/); expect(seen["before-rename"]!.state).toBe("prepared");
  expect(seen["before-complete"]).toEqual({ listing: ["atomic.winterworkspace"], state: "prepared" });
  expect(readdirSync(f.destination)).toEqual(["atomic.winterworkspace"]);
  expect(f.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "complete" }]);
  expect(result.files).toBe(9);
});

test("a generation is never complete for a bundle that does not exist: a refusal at complete takes the bundle back and marks the generation failed", async () => {
  const f = await fixture();
  f.checkpoints.push(phase => { if (phase === "before-complete") f.db.db.run("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", [f.workspaceId]); });
  await failsWith(f.exportOnce("late-stale"), "generation_stale");
  expect(readdirSync(f.destination)).toEqual([]);
  expect(f.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "failed" }]);
});

test("an existing target is never overwritten or merged, whether it appears before or during the export", async () => {
  const f = await fixture();
  mkdirSync(join(f.destination, "taken.winterworkspace")); writeFileSync(join(f.destination, "taken.winterworkspace/mine.txt"), "mine");
  await failsWith(f.exportOnce("taken"), "bundle_exists");
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_exports").get()).toEqual({ n: 0 }); // refused before a generation was prepared
  expect(readFileSync(join(f.destination, "taken.winterworkspace/mine.txt"), "utf8")).toBe("mine");
  expect(readdirSync(join(f.destination, "taken.winterworkspace"))).toEqual(["mine.txt"]);
  const g = await fixture();
  g.checkpoints.push(phase => { if (phase === "before-rename") { mkdirSync(join(g.destination, "late.winterworkspace")); writeFileSync(join(g.destination, "late.winterworkspace/mine.txt"), "mine"); } });
  await failsWith(g.exportOnce("late"), "bundle_exists");
  expect(readdirSync(join(g.destination, "late.winterworkspace"))).toEqual(["mine.txt"]);
  expect(g.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "failed" }]); // never a phantom complete
  expect(readdirSync(g.destination)).toEqual(["late.winterworkspace"]); // the partial was removed
});

test("destinations are judged: absolute, an existing owner-only folder, outside Cowork's own storage, a clean name", async () => {
  const f = await fixture();
  const cases: Array<[string, unknown]> = [["relative", "exports"], ["missing", join(f.base, "nope")], ["inside cowork storage", join(f.home, "cowork")], ["inside a workspace", f.dir],
    ["the home's cowork parent", join(f.home, "cowork", "workspaces")], ["empty", ""], ["nul", `${f.destination}\0x`]];
  for (const [name, destination] of cases) { await failsWith(f.exporter().export({ workspaceId: f.workspaceId, destinationParent: destination as string, proof: PROOF }), "destination_invalid").catch(error => { throw new Error(`${name}: ${error.message}`); }); }
  const open = join(f.base, "open"); mkdirSync(open); chmodSync(open, 0o777);
  await failsWith(f.exporter().export({ workspaceId: f.workspaceId, destinationParent: open, proof: PROOF }), "destination_invalid");
  const file = join(f.base, "file"); writeFileSync(file, "x");
  await failsWith(f.exporter().export({ workspaceId: f.workspaceId, destinationParent: file, proof: PROOF }), "destination_invalid");
  for (const name of ["../escape", "a/b", ".hidden", "x".repeat(101), "bad\nname", ""]) await failsWith(f.exportOnce(name), "destination_invalid");
  expect(readdirSync(f.destination)).toEqual([]);
  // Judged before any record is made: no generation was prepared for a bad destination.
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_exports").get()).toEqual({ n: 0 });
});

test("a destination with an ACL granting writes to others is refused, even though its mode bits are owner-only", async () => {
  const f = await fixture(); const acl = join(f.base, "acl"); mkdirSync(acl, { mode: 0o700 });
  expect((await import("node:child_process")).spawnSync("/bin/chmod", ["+a", "everyone allow add_file,delete_child", acl]).status).toBe(0);
  await failsWith(f.exporter().export({ workspaceId: f.workspaceId, destinationParent: acl, proof: PROOF }), "destination_invalid");
  expect(readdirSync(acl)).toEqual([]); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_exports").get()).toEqual({ n: 0 });
  // A read-only ACL does not matter.
  const reading = join(f.base, "reading"); mkdirSync(reading, { mode: 0o700 });
  (await import("node:child_process")).spawnSync("/bin/chmod", ["+a", "everyone allow read,list", reading]);
  await f.exporter().export({ workspaceId: f.workspaceId, destinationParent: reading, name: "ok", proof: PROOF });
});

test("a shared directory swapped for a link between the two passes is never followed: the export refuses and nothing of the decoy is read", async () => {
  const f = await fixture(); const decoy = join(f.base, "decoy"); mkdirSync(join(decoy, "er"), { recursive: true }); writeFileSync(join(decoy, "er/fact.txt"), SECRET);
  f.checkpoints.push(async phase => { if (phase === "shared-pass-1") { const deep = join(f.shared, "memory/deep"); (await import("./export-fs")).renameForTest(deep, join(f.base, "deep-moved")); symlinkSync(decoy, deep); } });
  await failsWith(f.exportOnce("swapped"), "bundle_unsafe");
  expect(readdirSync(f.destination)).toEqual([]);
  // The same swap one level up (a whole root) is held by descriptor: the held directory is still the original, and the export
  // either completes from it or refuses; it never contains the decoy.
  const g = await fixture(); const decoy2 = join(g.base, "decoy2"); mkdirSync(decoy2); writeFileSync(join(decoy2, "notes.md"), SECRET);
  g.checkpoints.push(async phase => { if (phase === "shared-pass-1") { (await import("./export-fs")).renameForTest(join(g.shared, "memory"), join(g.base, "memory-moved")); symlinkSync(decoy2, join(g.shared, "memory")); } });
  const result = await g.exportOnce("held");
  for (const file of bundleFiles(result.path)) expect(readFileSync(join(result.path, file)).includes(Buffer.from(SECRET))).toBe(false);
  expect(readFileSync(join(result.path, "shared/memory/notes.md"), "utf8")).toBe("- remembered\n");
});

test("a symlinked destination parent resolves to a real folder; the bundle lands in the real one", async () => {
  const f = await fixture(); const link = join(f.base, "link"); symlinkSync(f.destination, link);
  const result = await f.exporter().export({ workspaceId: f.workspaceId, destinationParent: link, name: "via-link", proof: PROOF });
  expect(result.path).toBe(join(f.destination, "via-link.winterworkspace"));
});

test("the generation lifecycle: failure marks it failed and frees the workspace; a stuck prepared generation is abandoned only when this exporter is not working on it", async () => {
  const f = await fixture();
  // A crash after prepare leaves a prepared generation, which blocks every later export.
  const stuck = f.exportsRecords.prepare(f.workspaceId, PROOF);
  await failsWith(f.exportOnce("blocked"), "export_in_progress");
  const exporter = f.exporter();
  expect(exporter.abandonInterrupted(f.workspaceId, PROOF)).toMatchObject({ exportId: stuck.exportId, state: "failed" });
  expect(exporter.abandonInterrupted(f.workspaceId, PROOF)).toBeNull();
  expect(() => exporter.abandonInterrupted(f.workspaceId, { not: "the proof" })).not.toThrow(); // nothing in flight: no authority question
  // The same call made while THIS exporter is mid-export refuses and leaves the live generation alone.
  const g = await fixture(); const own = g.exporter(); let during: unknown;
  g.checkpoints.push(phase => { if (phase === "shared-snapshotted") { try { own.abandonInterrupted(g.workspaceId, PROOF); } catch (error) { during = error; } } });
  await own.export({ workspaceId: g.workspaceId, destinationParent: g.destination, name: "live", proof: PROOF });
  expect(during).toBeInstanceOf(CoworkLifecycleError); expect((during as CoworkLifecycleError).code).toBe("export_in_progress");
  expect(g.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "complete" }]);
  // The proof is required to abandon.
  const h = await fixture(); h.exportsRecords.prepare(h.workspaceId, PROOF);
  await failsWith(async () => h.exporter().abandonInterrupted(h.workspaceId, { not: "the proof" }), "authority_denied");
});

test("cancellation stops the copy, fails the generation and leaves no partial folder", async () => {
  const f = await fixture(); const controller = new AbortController();
  f.checkpoints.push(phase => { if (phase === "image-copied:data") controller.abort(); });
  let error: unknown; try { await f.exporter().export({ workspaceId: f.workspaceId, destinationParent: f.destination, name: "cancelled", proof: PROOF, signal: controller.signal }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ExportIoError); expect((error as ExportIoError).reason).toBe("cancelled");
  expect(readdirSync(f.destination)).toEqual([]);
  expect(f.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "failed" }]);
});

test("refusals that precede any copy: authority, a workspace not at rest, unpinned images, a door that refuses, an image of the wrong size", async () => {
  const denied = await fixture();
  await failsWith(denied.exporter().export({ workspaceId: denied.workspaceId, destinationParent: denied.destination, proof: { wrong: true } }), "authority_denied");
  expect(readdirSync(denied.destination)).toEqual([]); expect(denied.opened).toEqual([]);
  const running = await fixture(); running.db.db.run("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", [running.workspaceId]);
  await failsWith(running.exportOnce("running"), "volume_busy"); expect(running.opened).toEqual([]);
  const owned = await fixture(); owned.db.db.run("UPDATE cowork_volumes SET owner_json='{}' WHERE workspace_id=?", [owned.workspaceId]);
  await failsWith(owned.exportOnce("owned"), "volume_busy");
  const unpinned = await fixture({ pin: false });
  await failsWith(unpinned.exportOnce("unpinned"), "image_unpinned"); expect(unpinned.opened).toEqual([]);
  const refusing = await fixture();
  await failsWith(refusing.exporter({ images: { openStopped: () => { throw new Error("door says no"); } } }).export({ workspaceId: refusing.workspaceId, destinationParent: refusing.destination, proof: PROOF }), "export_not_ready");
  expect(readdirSync(refusing.destination)).toEqual([]); expect(refusing.db.db.query("SELECT state FROM cowork_exports").all()).toEqual([{ state: "failed" }]);
  const wrong = await fixture();
  await failsWith(wrong.exporter({ images: { openStopped: (id, purpose, proof) => { const open = wrong.door.openStopped(id, purpose, proof); return { ...open, capacityBytes: open.capacityBytes + 4096 }; } } }).export({ workspaceId: wrong.workspaceId, destinationParent: wrong.destination, proof: PROOF }), "recovery_required");
  expect(readdirSync(wrong.destination)).toEqual([]);
});

test("an image whose descriptor is not the recorded size is refused even when the door claims the recorded capacity", async () => {
  const f = await fixture(); const tiny = join(f.base, "tiny"); writeFileSync(tiny, "x", { mode: 0o600 });
  const lying = { openStopped: (id: string, purpose: "data" | "environment", proof: unknown) => { const real = f.door.openStopped(id, purpose, proof); real.close(); const fd = openSync(tiny, "r"); return { fd, capacityBytes: real.capacityBytes, close: () => closeSync(fd) }; } };
  await failsWith(f.exporter({ images: lying }).export({ workspaceId: f.workspaceId, destinationParent: f.destination, proof: PROOF }), "recovery_required");
  expect(readdirSync(f.destination)).toEqual([]);
});

test("images are read only through the pinned-descriptor door, one open per image, and always closed", async () => {
  const f = await fixture();
  let closed = 0;
  const counting = { openStopped: (id: string, purpose: "data" | "environment", proof: unknown) => { const open = f.door.openStopped(id, purpose, proof); return { ...open, close: () => { closed++; open.close(); } }; } };
  await f.exporter({ images: counting }).export({ workspaceId: f.workspaceId, destinationParent: f.destination, name: "door", proof: PROOF });
  expect(f.opened).toEqual(["data", "environment"]); expect(closed).toBe(2);
});

test("the walk and the index reject what a bundle may not hold", async () => {
  const f = await fixture();
  const result = await f.exportOnce("walk");
  const oid = Object.keys(f.bound.get(result.exportId)!.outputIds)[0]!;
  const sharedFd = openDirectoryNoFollow(join(result.path, "shared"));
  try {
    expect(walkRegularFilesAt(sharedFd, DEFAULT_BUNDLE_LIMITS).map(file => file.path)).toEqual(["instructions/WINTER.md", "memory/deep/er/fact.txt", "memory/notes.md", `outputs/${oid}/empty.txt`, `outputs/${oid}/report.pdf`]);
    expect(() => walkRegularFilesAt(sharedFd, { ...DEFAULT_BUNDLE_LIMITS, files: 2 })).toThrow(CoworkLifecycleError);
    expect(() => walkRegularFilesAt(sharedFd, { ...DEFAULT_BUNDLE_LIMITS, depth: 1 })).toThrow(CoworkLifecycleError);
    expect(() => walkRegularFilesAt(sharedFd, { ...DEFAULT_BUNDLE_LIMITS, sharedBytes: 10 })).toThrow(CoworkLifecycleError);
  } finally { closeSync(sharedFd); }
  const again = await verifyBundle(result.path);
  expect(serializeIntegrity(again.integrity)).toBe(readFileSync(join(result.path, "integrity.json"), "utf8")); again.close();
  void A; void canonicalJson; void existsSync; void setXattr;
});
