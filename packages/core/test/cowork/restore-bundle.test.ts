// The restore flow. Every conflict rule in restore-bundle.ts has a test here that fails when the rule is removed.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparePaths, serializeIntegrity, verifyBundle, type BundleIntegrity } from "../../src/cowork/export-bundle";
import { createCoworkWorkspaceRestorer } from "../../src/cowork/restore-bundle";
import { CoworkVolumeError } from "../../src/cowork/volumes";
import { sha256Hex } from "../../src/cowork/storage-lifecycle";
import { BACKUP_XATTR, PROOF, failsWith, fixture, listXattrs, poke, runCleanup, type Fixture } from "./export-fixture";

setDefaultTimeout(60_000);
afterEach(runCleanup);

const snapshot = (f: Fixture): Record<"data" | "environment", { ino: number; digest: string }> => {
  const one = (purpose: "data" | "environment") => { const path = f.image(purpose), st = statSync(path); return { ino: st.ino, digest: sha256Hex(readFileSync(path).toString("base64")) }; };
  return { data: one("data"), environment: one("environment") };
};
const sharedSnapshot = (f: Fixture) => Object.fromEntries(readdirSync(f.shared, { recursive: true }).map(String).filter(p => lstatSync(join(f.shared, p)).isFile()).sort().map(p => [p, readFileSync(join(f.shared, p), "utf8")]));
const workspaceListing = (f: Fixture) => readdirSync(f.dir).sort();
/** A guest that kept working after the export: both images and the shared files differ now. */
function driftAfterExport(f: Fixture) {
  poke(f.image("data"), 8192, "LATER-DATA-BYTES"); poke(f.image("environment"), 4096, "LATER-ENV-BYTES");
  f.put("memory/notes.md", "- changed after the export\n"); f.put("memory/new-after.md", "new\n");
}
/** A bundle an attacker (or a bug) rebuilt consistently: manifest edited, integrity recomputed over every file. */
function forge(source: string, to: string, edit: (manifest: Record<string, any>) => void): string {
  cpSync(source, to, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(to, "manifest.json"), "utf8")); edit(manifest);
  const text = JSON.stringify(manifest); writeFileSync(join(to, "manifest.json"), text);
  const integrity = JSON.parse(readFileSync(join(to, "integrity.json"), "utf8")) as BundleIntegrity;
  integrity.manifestDigest = sha256Hex(text); integrity.exportId = manifest.generation.exportId;
  const entry = integrity.files.find(file => file.path === "manifest.json")!; entry.bytes = Buffer.byteLength(text); entry.sha256 = sha256Hex(text);
  writeFileSync(join(to, "integrity.json"), serializeIntegrity(integrity));
  return to;
}
const restoreInput = (path: string, extra: Record<string, unknown> = {}) => ({ bundlePath: path, proof: PROOF, ...extra });

test("restore replaces both images with the exported generation, keeps what it replaced, and the workspace can be claimed again", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  const original = snapshot(f); const originalImages = { data: readFileSync(f.image("data")), environment: readFileSync(f.image("environment")) };
  driftAfterExport(f);
  const drifted = { data: readFileSync(f.image("data")), environment: readFileSync(f.image("environment")) }; const liveShared = sharedSnapshot(f);
  const result = await f.restorer().restore(restoreInput(exported.path));
  expect(result).toMatchObject({ workspaceId: f.workspaceId, exportId: exported.exportId, generation: 1, restored: ["data.ext4", "env.ext4"], asideName: `restore-aside-${exported.exportId}`, sharedName: `restored-shared-${exported.exportId}` });
  // Live images are the exported bytes; the replaced ones are kept, byte for byte, in the aside folder.
  expect(readFileSync(f.image("data")).equals(originalImages.data)).toBe(true); expect(readFileSync(f.image("environment")).equals(originalImages.environment)).toBe(true);
  expect(readFileSync(join(f.dir, result.asideName, "data.ext4")).equals(drifted.data)).toBe(true); expect(readFileSync(join(f.dir, result.asideName, "env.ext4")).equals(drifted.environment)).toBe(true);
  expect(JSON.parse(readFileSync(join(f.dir, result.asideName, "RESTORE.json"), "utf8"))).toMatchObject({ exportId: exported.exportId, generation: 1, replaced: [{ file: "data.ext4", hadLiveImage: true }, { file: "env.ext4", hadLiveImage: true }] });
  // The live shared folders are untouched; the bundle's shared files sit beside them, never merged.
  expect(sharedSnapshot(f)).toEqual(liveShared);
  expect(readFileSync(join(f.dir, result.sharedName!, "memory/notes.md"), "utf8")).toBe("- remembered\n");
  expect(readFileSync(join(f.dir, result.sharedName!, "outputs/session-one/report.pdf")).length).toBe(8);
  // Different files now (a swap, not an in-place write), re-recorded and backup-excluded: the real volume layer accepts them.
  expect(snapshot(f).data.ino).not.toBe(original.data.ino);
  expect(f.identityCalls()).toBe(2);
  const claimed = f.volumes.claim(f.request); expect(claimed.every(volume => volume.owner !== null)).toBe(true);
  const opened = f.volumes.open(f.request, "data"); opened.close();
  expect(workspaceListing(f)).toEqual(["bookmark.bin", "credentials.json", "data.ext4", "env.ext4", result.asideName, result.sharedName!, "shared"].sort());
});

test("the confirmation is mandatory, receives an accurate summary, and a no leaves the workspace exactly as it was", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); driftAfterExport(f);
  const before = snapshot(f), listing = workspaceListing(f);
  for (const answer of [false, () => false, () => Promise.resolve(false), (() => "yes") as unknown as boolean, (() => 1) as unknown as boolean]) {
    f.setAnswer(answer);
    await failsWith(f.restorer().restore(restoreInput(exported.path)), "restore_unconfirmed");
  }
  expect(snapshot(f)).toEqual(before); expect(workspaceListing(f)).toEqual(listing); expect(f.identityCalls()).toBe(0);
  expect(f.confirmations[0]).toMatchObject({ workspaceId: f.workspaceId, exportId: exported.exportId, generation: 1, latest: true, sharedFiles: 5, asideName: `restore-aside-${exported.exportId}`,
    images: [{ file: "data.ext4", liveExists: true, liveMatchesRecord: true, bytes: 16 * 1024 * 1024 }, { file: "env.ext4", liveExists: true, liveMatchesRecord: true, bytes: 16 * 1024 * 1024 }] });
  f.setAnswer(() => { throw new Error("card failed"); });
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "export_not_ready");
  expect(snapshot(f)).toEqual(before);
});

test("a missing live image is restored without an exchange and the confirmation says it was missing; a live image that is not the recorded file is reported", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  unlinkSync(f.image("data"));
  const result = await f.restorer().restore(restoreInput(exported.path));
  expect(f.confirmations[0]!.images[0]).toMatchObject({ file: "data.ext4", liveExists: false, liveMatchesRecord: false });
  expect(readFileSync(f.image("data")).includes(Buffer.from("DATA-IMAGE-BYTES"))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.dir, result.asideName, "RESTORE.json"), "utf8")).replaced[0]).toEqual({ file: "data.ext4", hadLiveImage: false });
  f.volumes.claim(f.request);
  const g = await fixture(); const ex2 = await g.exportOnce("b");
  unlinkSync(g.image("environment")); writeFileSync(g.image("environment"), "a replacement somebody put there", { mode: 0o600 });
  await g.restorer().restore(restoreInput(ex2.path));
  expect(g.confirmations[0]!.images[1]).toMatchObject({ file: "env.ext4", liveExists: true, liveMatchesRecord: false });
});

test("only the latest completed generation restores without an explicit flag", async () => {
  const f = await fixture(); const first = await f.exportOnce("one"); poke(f.image("data"), 9000, "SECOND"); const second = await f.exportOnce("two");
  await failsWith(f.restorer().restore(restoreInput(first.path)), "restore_conflict");
  expect(f.confirmations).toHaveLength(0); // refused before any card
  await f.restorer().restore(restoreInput(first.path, { allowOlderGeneration: true }));
  expect(f.confirmations[0]).toMatchObject({ generation: 1, latest: false });
  expect(readFileSync(f.image("data")).includes(Buffer.from("SECOND"))).toBe(false);
  const g = await fixture(); const a = await g.exportOnce("a"); const b = await g.exportOnce("b");
  await g.restorer().restore(restoreInput(b.path)); void a;
});

test("a running, owned or deleted workspace is refused; an owner or a claim that appears while the card is open is caught afterwards", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); const before = snapshot(f);
  f.db.db.run("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", [f.workspaceId]);
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "recovery_required"); // validateImport: a workspace not at rest no longer derives the manifest
  f.db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [f.workspaceId]);
  f.volumes.claim(f.request);
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "volume_busy");
  f.volumes.release(f.request, { confirmationId: "stop-1", proof: PROOF });
  expect(f.confirmations).toHaveLength(0);
  // While the card is open the workspace is claimed: judged again after the answer.
  f.setAnswer(() => { f.volumes.claim(f.request); return true; });
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "volume_busy");
  expect(snapshot(f)).toEqual(before); expect(readdirSync(f.dir).some(name => name.startsWith(".restore-"))).toBe(false);
  const g = await fixture(); const ex = await g.exportOnce("b"); g.db.db.run("UPDATE cowork_workspaces SET state='deleting' WHERE workspace_id=?", [g.workspaceId]);
  await failsWith(g.restorer().restore(restoreInput(ex.path)), "authority_denied");
});

test("a live image replaced while the card was open is a conflict, not an overwrite", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  f.setAnswer(() => { unlinkSync(f.image("environment")); writeFileSync(f.image("environment"), "swapped in while you were deciding", { mode: 0o600 }); return true; });
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "restore_conflict");
  expect(readFileSync(f.image("environment"), "utf8")).toBe("swapped in while you were deciding");
  expect(f.identityCalls()).toBe(0);
});

test("authority and identity: no proof, a foreign home, an unknown workspace and an unrecorded generation each refuse, even for a consistently rebuilt bundle", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); const before = snapshot(f);
  await failsWith(f.restorer().restore({ bundlePath: exported.path, proof: { wrong: true } }), "authority_denied");
  const cases: Array<[string, (m: Record<string, any>) => void, string]> = [
    ["foreign home", m => { m.homeId = "another-home"; }, "foreign_home"],
    ["unknown workspace", m => { m.workspace.workspaceId = "no-such-workspace"; }, "workspace_unknown"],
    ["unrecorded generation", m => { m.generation.exportId = "export_forged"; }, "generation_unknown"],
    ["changed volume uuid", m => { m.volumes[0].filesystemUuid = "00000000-0000-4000-8000-000000000000"; }, "generation_unknown"],
    ["changed digest", m => { m.images.baseImageDigest = "c".repeat(64); }, "generation_unknown"],
    ["extra manifest key", m => { m.extra = true; }, "manifest_invalid"],
    ["future format", m => { m.formatVersion = 2; }, "unknown_format"],
    ["unknown volume format", m => { m.volumes[0].format = "luks"; }, "unknown_format"],
  ];
  let n = 0;
  for (const [name, edit, code] of cases) {
    const forged = forge(exported.path, join(f.destination, `forged-${++n}.winterworkspace`), edit);
    await failsWith(f.restorer().restore(restoreInput(forged)).catch(error => { if (name === "extra manifest key") { /* index is consistent, manifest is not */ } throw error; }), code as any).catch(error => { throw new Error(`${name}: ${error.message}`); });
  }
  expect(snapshot(f)).toEqual(before); expect(f.confirmations).toHaveLength(0); expect(f.identityCalls()).toBe(0);
});

test("a consistently rebuilt bundle is still refused when its index disagrees with the manifest or with the recorded image size", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); const before = snapshot(f);
  // The index names a different export than the manifest does.
  const other = join(f.destination, "other-id.winterworkspace"); cpSync(exported.path, other, { recursive: true });
  const index = JSON.parse(readFileSync(join(other, "integrity.json"), "utf8")); index.exportId = "export_someone_else"; writeFileSync(join(other, "integrity.json"), serializeIntegrity(index));
  await failsWith(f.restorer().restore(restoreInput(other)), "bundle_invalid");
  // A truncated image, with the index recomputed over it: the manifest's capacity is the record's, not the bundle's.
  const small = join(f.destination, "small.winterworkspace"); cpSync(exported.path, small, { recursive: true });
  writeFileSync(join(small, "env.ext4"), "tiny", { mode: 0o600 });
  const idx = JSON.parse(readFileSync(join(small, "integrity.json"), "utf8")) as BundleIntegrity;
  const entry = idx.files.find(file => file.path === "env.ext4")!; entry.bytes = 4; entry.sha256 = sha256Hex("tiny");
  writeFileSync(join(small, "integrity.json"), serializeIntegrity(idx));
  await failsWith(f.restorer().restore(restoreInput(small)), "bundle_invalid");
  expect(snapshot(f)).toEqual(before); expect(f.confirmations).toHaveLength(0);
});

test("a bundle damaged in any way is refused before the workspace is touched", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); const before = snapshot(f), listing = workspaceListing(f);
  let n = 0;
  const copy = () => { const to = join(f.destination, `damaged-${++n}.winterworkspace`); cpSync(exported.path, to, { recursive: true }); return to; };
  const damages: Array<[string, (path: string) => void, string]> = [
    ["flipped image byte", p => poke(join(p, "data.ext4"), 8192, "Z"), "bundle_invalid"],
    ["flipped shared byte", p => writeFileSync(join(p, "shared/memory/notes.md"), "- remembered!\n"), "bundle_invalid"],
    ["truncated shared file", p => writeFileSync(join(p, "shared/memory/notes.md"), ""), "bundle_invalid"],
    ["extra shared file", p => writeFileSync(join(p, "shared/memory/extra.md"), "x"), "bundle_invalid"],
    ["missing shared file", p => unlinkSync(join(p, "shared/memory/notes.md")), "bundle_invalid"],
    ["missing image", p => unlinkSync(join(p, "env.ext4")), "bundle_invalid"],
    ["missing integrity", p => unlinkSync(join(p, "integrity.json")), "bundle_invalid"],
    ["extra top-level file", p => writeFileSync(join(p, "notes.txt"), "x"), "bundle_invalid"],
    ["unknown shared root", p => { mkdirSync(join(p, "shared/other")); writeFileSync(join(p, "shared/other/x"), "x"); }, "bundle_invalid"],
    ["manifest edited alone", p => writeFileSync(join(p, "manifest.json"), readFileSync(join(p, "manifest.json"), "utf8").replace("export_fixture_1", "export_fixture_9")), "generation_unknown"],
    ["integrity not canonical", p => writeFileSync(join(p, "integrity.json"), JSON.stringify(JSON.parse(readFileSync(join(p, "integrity.json"), "utf8")), null, 1)), "bundle_invalid"],
    ["integrity oversized", p => writeFileSync(join(p, "integrity.json"), " ".repeat(17 * 1024 * 1024)), "bundle_invalid"],
    ["integrity with traversal", p => { const i = JSON.parse(readFileSync(join(p, "integrity.json"), "utf8")); i.files.push({ path: "shared/memory/../../data.ext4", bytes: 0, sha256: "0".repeat(64) }); writeFileSync(join(p, "integrity.json"), serializeIntegrity(i)); }, "bundle_invalid"],
    ["integrity unsorted", p => { const i = JSON.parse(readFileSync(join(p, "integrity.json"), "utf8")); i.files.reverse(); writeFileSync(join(p, "integrity.json"), serializeIntegrity(i)); }, "bundle_invalid"],
    ["integrity duplicate", p => { const i = JSON.parse(readFileSync(join(p, "integrity.json"), "utf8")); i.files.push(i.files[0]); i.files.sort((a: any, b: any) => comparePaths(a.path, b.path)); writeFileSync(join(p, "integrity.json"), serializeIntegrity(i)); }, "bundle_invalid"],
    ["symlinked shared file", p => { unlinkSync(join(p, "shared/memory/notes.md")); symlinkSync(join(f.dir, "bookmark.bin"), join(p, "shared/memory/notes.md")); }, "bundle_unsafe"],
    ["symlinked image", p => { unlinkSync(join(p, "data.ext4")); symlinkSync(f.image("data"), join(p, "data.ext4")); }, "bundle_unsafe"],
    ["hard-linked shared file", p => linkSync(join(p, "shared/memory/notes.md"), join(f.destination, `hl-${n}`)), "bundle_unsafe"],
    ["shared is a symlink", p => { rmSync(join(p, "shared"), { recursive: true }); symlinkSync(f.shared, join(p, "shared")); }, "bundle_unsafe"],
  ];
  for (const [name, damage, code] of damages) { const p = copy(); damage(p); await failsWith(f.restorer().restore(restoreInput(p)), code as any).catch(error => { throw new Error(`${name}: ${error.message}`); }); }
  // Not a bundle at all: wrong suffix, relative, missing, a symlink to a good bundle, a regular file.
  const link = join(f.destination, "link.winterworkspace"); symlinkSync(exported.path, link);
  for (const path of [exported.path.replace(".winterworkspace", ".zip"), "relative.winterworkspace", join(f.destination, "missing.winterworkspace"), join(f.destination, "x.winterworkspace\0"), link]) await failsWith(f.restorer().restore(restoreInput(path)), path === link ? "bundle_unsafe" : "bundle_invalid");
  const plain = join(f.destination, "plain.winterworkspace"); writeFileSync(plain, "x");
  await failsWith(f.restorer().restore(restoreInput(plain)), "bundle_invalid");
  expect(snapshot(f)).toEqual(before); expect(workspaceListing(f)).toEqual(listing); expect(f.confirmations).toHaveLength(0);
});

test("the bundle is hashed again as it is staged: a file that changes after verification but before the copy is caught", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); const before = snapshot(f), listing = workspaceListing(f);
  f.setAnswer(() => { poke(join(exported.path, "data.ext4"), 8192, "Z"); return true; }); // after verifyBundle, during the card
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "bundle_invalid");
  expect(snapshot(f)).toEqual(before); expect(workspaceListing(f)).toEqual(listing); // staging removed, nothing swapped
  const g = await fixture(); const ex = await g.exportOnce("b");
  g.setAnswer(() => { writeFileSync(join(ex.path, "shared/memory/notes.md"), "- tampered after verification\n"); return true; });
  await failsWith(g.restorer().restore(restoreInput(ex.path)), "bundle_invalid");
  expect(workspaceListing(g)).not.toContain(`restored-shared-${ex.exportId}`);
});

test("the restored image carries the backup exclusion before it can become live; if that cannot be verified nothing is swapped", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); const before = snapshot(f), listing = workspaceListing(f);
  f.setAnswer(() => { f.breakBackup(true); return true; });
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "backup_exclusion_unavailable");
  expect(snapshot(f)).toEqual(before); expect(workspaceListing(f)).toEqual(listing); expect(f.identityCalls()).toBe(0);
  // On success the live inode is in the exclusion set (the fake backup port keys on dev:ino).
  const g = await fixture(); const ex = await g.exportOnce("b"); await g.restorer().restore(restoreInput(ex.path));
  const st = statSync(g.image("data")); expect(g.excluded.has(`${st.dev}:${st.ino}`)).toBe(true);
  // The exported bundle itself never had the exclusion, and the staged copy of it never had stray attributes.
  expect(listXattrs(join(ex.path, "data.ext4"))).toEqual([]);
  void BACKUP_XATTR;
});

test("a failure after the exchange fails closed: the old images are kept, the recorded identity no longer matches, and the volume layer refuses", async () => {
  for (const crash of [
    (f: Fixture) => f.checkpoints.push(phase => { if (phase === "swapped:data.ext4") throw new Error("crash between the exchange and the identity record"); }),
    (f: Fixture) => f.failIdentity(true),
    (f: Fixture) => f.checkpoints.push(phase => { if (phase === "identity-recorded") throw new Error("crash before the final rename"); }),
  ]) {
    const f = await fixture(); const exported = await f.exportOnce("backup"); driftAfterExport(f);
    const drifted = readFileSync(f.image("data")); crash(f);
    await failsWith(f.restorer().restore(restoreInput(exported.path)), "recovery_required");
    // Nothing deleted: the pre-restore image is still on disk in the staging folder.
    expect(readFileSync(join(f.dir, `.restore-${exported.exportId}`, "data.ext4")).equals(drifted)).toBe(true);
    expect(workspaceListing(f)).toContain(`.restore-${exported.exportId}`);
    // For the first two crashes the database still records the OLD file, so the volume layer refuses to hand it out.
    if (f.identityCalls() === 0 || f.identityCalls() === 1) { let error: unknown; try { f.volumes.claim(f.request); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(CoworkVolumeError); expect((error as CoworkVolumeError).code).toBe("recovery_required"); }
    // And it will not run the same restore again on top of the debris.
    f.checkpoints.length = 0; f.failIdentity(false);
    await failsWith(f.restorer().restore(restoreInput(exported.path)), "restore_conflict");
  }
});

test("a leftover aside, shared or staging folder of this generation refuses a second restore; two restores of one workspace cannot overlap", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  for (const name of [`restore-aside-${exported.exportId}`, `restored-shared-${exported.exportId}`, `.restore-${exported.exportId}`]) {
    mkdirSync(join(f.dir, name)); await failsWith(f.restorer().restore(restoreInput(exported.path)), "restore_conflict"); rmSync(join(f.dir, name), { recursive: true });
  }
  // A DIFFERENT instance on the same workspace while the first is mid-restore: the lock is process-wide, not per instance.
  const first = f.restorer(), other = f.restorer(); let second: Promise<unknown> | undefined;
  f.setAnswer(() => { second = other.restore(restoreInput(exported.path)).catch(error => error); return true; });
  await first.restore(restoreInput(exported.path));
  expect((await second as any).code).toBe("restore_conflict");
  // The lock is released: a later restore of the next generation proceeds.
  poke(f.image("data"), 9100, "NEXT"); const next = await f.exportOnce("next"); f.setAnswer(true);
  await f.restorer().restore(restoreInput(next.path));
});

test("the workspace is held from the last check to the identity record: a claim that lands while the copy is staged ends in a refusal, not in 'restored'", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); driftAfterExport(f);
  const before = snapshot(f), listing = workspaceListing(f);
  f.checkpoints.push(phase => { if (phase === "staged") f.volumes.claim(f.request); });
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "volume_busy");
  expect(snapshot(f)).toEqual(before); expect(f.identityCalls()).toBe(0);
  expect(workspaceListing(f)).toEqual(listing); // the staging folder was cleaned, nothing was exchanged
  // The same for a workspace that starts running, and for a live image replaced at that moment.
  const g = await fixture(); const eg = await g.exportOnce("b");
  g.checkpoints.push(phase => { if (phase === "staged") g.db.db.run("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", [g.workspaceId]); });
  await failsWith(g.restorer().restore(restoreInput(eg.path)), "recovery_required");
  const h = await fixture(); const eh = await h.exportOnce("c");
  h.checkpoints.push(phase => { if (phase === "staged") { unlinkSync(h.image("environment")); writeFileSync(h.image("environment"), "replaced at the last moment", { mode: 0o600 }); } });
  await failsWith(h.restorer().restore(restoreInput(eh.path)), "restore_conflict");
  expect(readFileSync(h.image("environment"), "utf8")).toBe("replaced at the last moment");
});

test("the process-wide lock, not the leftover check, stops a second restorer that was already past its checks", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  let reachedSecond!: () => void; const secondReached = new Promise<void>(resolve => { reachedSecond = resolve; });
  let finishedFirst: Promise<unknown> = Promise.resolve(), calls = 0;
  // The first restorer waits at its card until the second has reached ITS card (or 300 ms pass); the second then waits for the
  // first to finish before it answers. Without the lock both pass every check and the second replaces the images again.
  f.setAnswer(async () => {
    if (++calls === 1) { await Promise.race([secondReached, new Promise(resolve => setTimeout(resolve, 300))]); return true; }
    reachedSecond(); await finishedFirst; return true;
  });
  const first = f.restorer().restore(restoreInput(exported.path)); finishedFirst = first.catch(() => undefined);
  const second = f.restorer().restore(restoreInput(exported.path)).then(() => "restored", (error: any) => error.code);
  await first;
  expect(await second).toBe("restore_conflict");
  expect(f.identityCalls()).toBe(2); // one restore's two records, not four
});

test("two instances restoring the same workspace cannot both succeed", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  const results = await Promise.allSettled([f.restorer().restore(restoreInput(exported.path)), f.restorer().restore(restoreInput(exported.path))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason.code)).toEqual(["restore_conflict"]);
});

test("a bundle that was rewritten and re-indexed is refused: the database binds the index, and without that column the restorer cannot be built", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup"); const before = snapshot(f);
  const forged = join(f.destination, "rewritten.winterworkspace"); cpSync(exported.path, forged, { recursive: true });
  poke(join(forged, "data.ext4"), 8192, "EVIL"); // rewrite the image, then recompute the index over it
  const idx = JSON.parse(readFileSync(join(forged, "integrity.json"), "utf8")) as BundleIntegrity;
  const { createHash } = await import("node:crypto");
  idx.files.find(file => file.path === "data.ext4")!.sha256 = createHash("sha256").update(readFileSync(join(forged, "data.ext4"))).digest("hex");
  writeFileSync(join(forged, "integrity.json"), serializeIntegrity(idx));
  await verifyBundle(forged).then(bundle => bundle.close()); // internally consistent: the old check alone would accept it
  await failsWith(f.restorer().restore(restoreInput(forged)), "bundle_invalid");
  expect(snapshot(f)).toEqual(before); expect(f.confirmations).toHaveLength(0);
  // No binding recorded for the generation, or a binding for another digest: refused.
  f.bound.clear(); await failsWith(f.restorer().restore(restoreInput(exported.path)), "bundle_invalid");
  // The shape production can build today refuses everything; a ports object without the binding cannot be built at all.
  await failsWith(createCoworkWorkspaceRestorer(undefined).restore(restoreInput(exported.path)), "integration_unavailable");
  expect(() => createCoworkWorkspaceRestorer({ ...f.restorePorts, binding: undefined as never })).toThrow();
});

test("authority and the recorded sizes are judged before a byte of any image is hashed", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  poke(join(exported.path, "data.ext4"), 8192, "Z"); // a corrupt image: hashing would say bundle_invalid
  await failsWith(f.restorer().restore({ bundlePath: exported.path, proof: { wrong: true } }), "authority_denied");
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "bundle_invalid"); // with authority, the hash does run
  const g = await fixture(); const eg = await g.exportOnce("b"); poke(join(eg.path, "data.ext4"), 8192, "Z");
  g.bound.set(eg.exportId, { ...g.bound.get(eg.exportId)!, contentDigest: "0".repeat(64) });
  await failsWith(g.restorer().restore(restoreInput(eg.path)), "bundle_invalid"); // the binding is judged first too
});

test("opaque output ids map back to the real session folders, and an id the record does not hold is refused", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  const opaqueId = Object.keys(f.bound.get(exported.exportId)!.outputIds)[0]!;
  expect(f.bound.get(exported.exportId)!.outputIds).toEqual({ [opaqueId]: "session-one" });
  f.setAnswer(true);
  f.bound.set(exported.exportId, { ...f.bound.get(exported.exportId)!, outputIds: {} });
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "bundle_invalid");
  f.bound.set(exported.exportId, { ...f.bound.get(exported.exportId)!, outputIds: { [opaqueId]: "session-one" } });
  const result = await f.restorer().restore(restoreInput(exported.path));
  expect(existsSync(join(f.dir, result.sharedName!, "outputs/session-one/report.pdf"))).toBe(true);
  expect(existsSync(join(f.dir, result.sharedName!, `outputs/${opaqueId}`))).toBe(false);
});

test("a staging folder created by someone else in the moment before ours is never removed by us", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  const theirs = join(f.dir, `.restore-${exported.exportId}`);
  f.setAnswer(() => { mkdirSync(theirs); writeFileSync(join(theirs, "keep.txt"), "theirs"); return true; });
  await expect(f.restorer().restore(restoreInput(exported.path))).rejects.toThrow();
  expect(readFileSync(join(theirs, "keep.txt"), "utf8")).toBe("theirs");
});

test("the workspace folder is judged again inside the held section", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  f.checkpoints.push(phase => { if (phase === "staged") require("node:fs").chmodSync(f.dir, 0o755); });
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "recovery_required");
  expect(f.identityCalls()).toBe(0);
});

test("a restore is not an un-archive and not an import: an archived workspace restores in place, and an exported-then-deleted record cannot be resurrected", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  f.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [f.workspaceId]);
  await f.restorer().restore(restoreInput(exported.path));
  expect(f.repo.get(f.workspaceId).state).toBe("archived"); // restore leaves the lifecycle state alone
  const g = await fixture(); const ex = await g.exportOnce("b");
  g.db.db.run("DELETE FROM cowork_export_output_ids"); g.db.db.run("DELETE FROM cowork_exports WHERE workspace_id=?", [g.workspaceId]);
  await failsWith(g.restorer().restore(restoreInput(ex.path)), "generation_unknown");
});

test("a live image that is a link, a workspace folder with loose permissions, and a bundle image with loose permissions", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  const real = f.image("data"); const kept = join(f.base, "kept.img"); cpSync(real, kept); unlinkSync(real); symlinkSync(kept, real);
  await failsWith(f.restorer().restore(restoreInput(exported.path)), "restore_conflict");
  expect(lstatSync(real).isSymbolicLink()).toBe(true); expect(f.confirmations).toHaveLength(0);
  const g = await fixture(); const ex = await g.exportOnce("b");
  require("node:fs").chmodSync(g.dir, 0o755);
  await failsWith(g.restorer().restore(restoreInput(ex.path)), "recovery_required");
  const h = await fixture(); const eh = await h.exportOnce("c");
  for (const image of ["data.ext4", "env.ext4"]) require("node:fs").chmodSync(join(eh.path, image), 0o644);
  await h.restorer().restore(restoreInput(eh.path));
  expect(statSync(h.image("data")).mode & 0o777).toBe(0o600); expect(statSync(h.image("environment")).mode & 0o777).toBe(0o600);
  h.volumes.claim(h.request); // and the volume layer, which requires 0600, accepts them
});

test("the restore reads the bundle only: it creates and removes nothing inside it", async () => {
  const f = await fixture(); const exported = await f.exportOnce("backup");
  const listing = () => readdirSync(exported.path, { recursive: true }).map(String).sort();
  const before = listing(); const verified = await verifyBundle(exported.path); verified.close();
  await f.restorer().restore(restoreInput(exported.path));
  expect(listing()).toEqual(before); expect(existsSync(join(exported.path, "data.ext4"))).toBe(true); 
});
