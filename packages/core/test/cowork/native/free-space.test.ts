import { afterEach, expect, test } from "bun:test";
import { closeSync, constants, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, statfsSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COWORK_FREE_SPACE_RESERVE_BYTES, STATFS_BYTES, assessFreeSpace, createStatfsReader, parseStatfs, preflightImageAdmission, reverifyStickyExclusion,
  type ExclusionVerifier, type FilesystemSpace, type FilesystemSpaceReader, type PressureView, type ProvisionedImage, type SpaceTarget, type StatfsLibrary,
} from "../../../src/cowork/native/free-space";
import { closeFd, openDirAt, openImageAt, AT_FDCWD } from "../../../src/cowork/volume-fs";
import { timeMachineVolumeBackup } from "../../../src/cowork/volume-backup";

const GiB = 1024 ** 3, MiB = 1024 ** 2, RESERVE = COWORK_FREE_SPACE_RESERVE_BYTES;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const real = process.platform === "darwin" && process.arch === "arm64" ? test : test.skip;

const space = (availableBytes: number, filesystemId = "fsid:test:1"): FilesystemSpace => ({ filesystemId, typeName: "apfs", blockBytes: 4096, totalBytes: 10 ** 13, availableBytes });
const open: PressureView = { admitsNewWork: () => true };
const closed: PressureView = { admitsNewWork: () => false };
const fdTarget = (fd: number): SpaceTarget => ({ kind: "fd", fd });
/** A reader answering per fd from a table; counts reads. */
function table(values: Record<number, FilesystemSpace | null | "throw">): FilesystemSpaceReader & { reads: number[] } {
  const reads: number[] = [];
  return { reads, read(target) { const fd = target.kind === "fd" ? target.fd : -1; reads.push(fd); const v = values[fd]; if (v === "throw") throw new Error("boom"); return v ?? null; } };
}
const image = (name: string, provisionedBytes: number, fd: number): ProvisionedImage => ({ name, provisionedBytes, target: fdTarget(fd) });

// ---------------------------------------------------------------- statfs layout
function statfsBuffer(over: { bsize?: number; blocks?: bigint; bavail?: bigint; type?: string; fsid?: [number, number] } = {}): Buffer {
  const b = Buffer.alloc(STATFS_BYTES);
  b.writeUInt32LE(over.bsize ?? 4096, 0); b.writeBigUInt64LE(over.blocks ?? 1000n, 8); b.writeBigUInt64LE(over.blocks ?? 1000n, 16); b.writeBigUInt64LE(over.bavail ?? 250n, 24);
  b.writeInt32LE((over.fsid ?? [16777232, 26])[0], 48); b.writeInt32LE((over.fsid ?? [16777232, 26])[1], 52);
  b.write(over.type ?? "apfs", 72, "latin1");
  return b;
}
test("parseStatfs reads the macOS 64-bit-inode layout at its pinned offsets", () => {
  expect(STATFS_BYTES).toBe(2168);
  expect(parseStatfs(statfsBuffer())).toEqual({ filesystemId: "fsid:1000010:1a", typeName: "apfs", blockBytes: 4096, totalBytes: 1000 * 4096, availableBytes: 250 * 4096 });
  expect(parseStatfs(statfsBuffer({ fsid: [-1, 0] }))!.filesystemId).toBe("fsid:ffffffff:0");
  // Larger-than-needed buffers (a pooled Buffer slice) parse the same.
  const pooled = Buffer.concat([Buffer.alloc(7, 0xff), statfsBuffer(), Buffer.alloc(5)]).subarray(7, 7 + STATFS_BYTES);
  expect(parseStatfs(pooled)!.availableBytes).toBe(250 * 4096);
});
test("parseStatfs refuses anything it cannot trust", () => {
  expect(parseStatfs(Buffer.alloc(STATFS_BYTES - 1))).toBeNull();
  for (const bsize of [0, 511, (1 << 24) + 1]) expect(parseStatfs(statfsBuffer({ bsize }))).toBeNull();
  expect(parseStatfs(statfsBuffer({ blocks: 10n, bavail: 11n }))).toBeNull();
  expect(parseStatfs(statfsBuffer({ blocks: 1n << 62n, bavail: 1n << 62n }))).toBeNull(); // bytes exceed 2^53
  expect(parseStatfs(statfsBuffer({ type: "" }))).toBeNull();
  const unterminated = statfsBuffer(); unterminated.fill(0x61, 72, 88); expect(parseStatfs(unterminated)).toBeNull();
  const binary = statfsBuffer(); binary[72] = 0x01; expect(parseStatfs(binary)).toBeNull();
});

// ---------------------------------------------------------------- the production reader over a fake library
test("the reader prefers fstatfs for an fd, NUL-terminates a path and refuses malformed targets without calling the library", () => {
  const calls: string[] = [];
  const library: StatfsLibrary = {
    fstatfs: (fd, out) => { calls.push(`fstatfs:${fd}`); statfsBuffer().copy(out); return 0; },
    statfs: (path, out) => { calls.push(`statfs:${path.toString("latin1").replace(/\0/g, "<NUL>")}`); statfsBuffer().copy(out); return 0; },
  };
  const reader = createStatfsReader(library);
  expect(reader.read({ kind: "fd", fd: 7 })!.availableBytes).toBe(250 * 4096);
  expect(reader.read({ kind: "path", path: "/tmp/x" })!.blockBytes).toBe(4096);
  expect(calls).toEqual(["fstatfs:7", "statfs:/tmp/x<NUL>"]);
  calls.length = 0;
  for (const bad of [{ kind: "fd", fd: -1 }, { kind: "fd", fd: 1.5 }, { kind: "fd", fd: 2 ** 31 }, { kind: "path", path: "relative" }, { kind: "path", path: "" }, { kind: "path", path: "/a\0b" }, { kind: "path", path: `/${"x".repeat(4096)}` }, { kind: "other" }, null] as unknown as SpaceTarget[]) expect(reader.read(bad)).toBeNull();
  expect(calls).toEqual([]);
  expect(createStatfsReader({ ...library, fstatfs: () => -1 }).read({ kind: "fd", fd: 3 })).toBeNull();
  expect(createStatfsReader({ ...library, statfs: (_p, out) => { Buffer.alloc(STATFS_BYTES).copy(out); return 0; } }).read({ kind: "path", path: "/tmp" })).toBeNull(); // all-zero struct: bsize 0
});

// ---------------------------------------------------------------- free-space admission
test("the reserve is the contract's 5 GiB and the requirement is sum(provisioned) + reserve", () => {
  expect(COWORK_FREE_SPACE_RESERVE_BYTES).toBe(5368709120);
  const images = [image("data.ext4", 64 * GiB, 10), image("env.ext4", 32 * GiB, 11)], need = 96 * GiB + RESERVE;
  const result = assessFreeSpace({ images, space: table({ 10: space(need), 11: space(need) }), guard: open });
  expect(result).toEqual({ outcome: "admit", requiredBytes: need, availableBytes: need, reserveBytes: RESERVE, filesystemId: "fsid:test:1" });
});
test("exact boundary: reserve-1, reserve, reserve+1 around the full requirement (free < required blocks, free == required admits)", () => {
  const images = [image("data.ext4", 8 * GiB, 10), image("env.ext4", 4 * GiB, 11)], need = 12 * GiB + RESERVE;
  const run = (free: number) => assessFreeSpace({ images, space: table({ 10: space(free), 11: space(free) }), guard: open });
  expect(run(need - 1)).toEqual({ outcome: "resource_blocked", reason: "free_space_below_requirement", requiredBytes: need, availableBytes: need - 1, reserveBytes: RESERVE, filesystemId: "fsid:test:1" });
  expect(run(need).outcome).toBe("admit");
  expect(run(need + 1).outcome).toBe("admit");
  // The same three values around the bare reserve with a one-byte image pin the reserve itself, not just the sum.
  const tiny = [image("a.ext4", 1, 10)];
  expect(assessFreeSpace({ images: tiny, space: table({ 10: space(RESERVE) }), guard: open }).outcome).toBe("resource_blocked");
  expect(assessFreeSpace({ images: tiny, space: table({ 10: space(RESERVE + 1) }), guard: open }).outcome).toBe("admit");
});
test("a tunable reserve replaces the default, and the default applies when omitted", () => {
  const one = [image("a.ext4", 1000, 10)];
  expect(assessFreeSpace({ images: one, space: table({ 10: space(1999) }), guard: open, reserveBytes: 1000 }).outcome).toBe("resource_blocked");
  expect(assessFreeSpace({ images: one, space: table({ 10: space(2000) }), guard: open, reserveBytes: 1000 }).outcome).toBe("admit");
  expect(assessFreeSpace({ images: one, space: table({ 10: space(1000 + RESERVE - 1) }), guard: open }).outcome).toBe("resource_blocked");
});
test("several images: every image counts, none can be dropped from the sum", () => {
  const sizes = [10 * GiB, 20 * GiB, 30 * GiB], images = sizes.map((size, i) => image(`img${i}.ext4`, size, 10 + i));
  const need = 60 * GiB + RESERVE;
  const reader = (free: number) => table({ 10: space(free), 11: space(free), 12: space(free) });
  expect(assessFreeSpace({ images, space: reader(need - 1), guard: open }).outcome).toBe("resource_blocked");
  expect(assessFreeSpace({ images, space: reader(need), guard: open }).outcome).toBe("admit");
  // Enough for any two of the three (and the reserve) is still refused: all three are counted.
  for (let skip = 0; skip < 3; skip++) {
    const two = 60 * GiB - sizes[skip]! + RESERVE;
    expect(assessFreeSpace({ images, space: reader(two), guard: open }).outcome).toBe("resource_blocked");
  }
});
test("sparse images are not reservations: provisioned size counts, whatever is on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "winter-n2-sparse-")); roots.push(root);
  const path = join(root, "data.ext4"), fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    ftruncateSync(fd, 64 * MiB);
    const sparse = statSync(path); expect(sparse.size).toBe(64 * MiB); expect(sparse.blocks * 512).toBeLessThan(MiB); // claims (almost) no physical space
    const need = 64 * MiB + RESERVE, images = [image("data.ext4", sparse.size, fd)];
    expect(assessFreeSpace({ images, space: table({ [fd]: space(need - 1) }), guard: open }).outcome).toBe("resource_blocked");
    // Writing real data changes st_blocks, and still earns no credit.
    writeSync(fd, Buffer.alloc(8 * MiB, 1), 0, 8 * MiB, 0);
    expect(statSync(path).blocks * 512).toBeGreaterThanOrEqual(8 * MiB);
    const written = assessFreeSpace({ images, space: table({ [fd]: space(need - 1) }), guard: open });
    expect(written).toMatchObject({ outcome: "resource_blocked", reason: "free_space_below_requirement", requiredBytes: need });
    expect(assessFreeSpace({ images, space: table({ [fd]: space(need) }), guard: open }).outcome).toBe("admit");
  } finally { closeSync(fd); }
});
test("shared pool: the MIN of every observed filesystem decides, never a per-filesystem group", () => {
  // Two APFS volumes of one container report the same pool under different fsids. 60 + 60 + reserve does not fit
  // in 100 GiB, though each 60 GiB image alone would pass its own volume's check.
  const images = [image("data.ext4", 60 * GiB, 10), image("env.ext4", 60 * GiB, 11)];
  const pool = 100 * GiB, shared = table({ 10: space(pool, "fsid:vol:a"), 11: space(pool, "fsid:vol:b") });
  expect(assessFreeSpace({ images, space: shared, guard: open })).toMatchObject({ outcome: "resource_blocked", reason: "free_space_below_requirement", availableBytes: pool, requiredBytes: 120 * GiB + RESERVE });
  // Different filesystems: the smaller one limits, and is named.
  const mixed = table({ 10: space(1000 * GiB, "fsid:big"), 11: space(120 * GiB + RESERVE - 1, "fsid:small") });
  const refused = assessFreeSpace({ images, space: mixed, guard: open });
  expect(refused).toMatchObject({ outcome: "resource_blocked", filesystemId: "fsid:small", availableBytes: 120 * GiB + RESERVE - 1 });
  const edge = assessFreeSpace({ images, space: table({ 10: space(1000 * GiB, "fsid:big"), 11: space(120 * GiB + RESERVE, "fsid:small") }), guard: open });
  expect(edge).toMatchObject({ outcome: "admit", filesystemId: "fsid:small", availableBytes: 120 * GiB + RESERVE });
});
test("an unreadable reading blocks: null, a throw, or a nonsensical number, on any one image", () => {
  const images = [image("data.ext4", GiB, 10), image("env.ext4", GiB, 11)], ok = space(100 * GiB);
  for (const bad of [null, "throw", space(-1), space(1.5), space(Number.NaN), space(Number.MAX_SAFE_INTEGER + 2)] as const) {
    for (const [a, b] of [[bad, ok], [ok, bad]] as const) {
      const result = assessFreeSpace({ images, space: table({ 10: a, 11: b }), guard: open });
      expect(result).toEqual({ outcome: "resource_blocked", reason: "free_space_unavailable", requiredBytes: 2 * GiB + RESERVE, availableBytes: null, reserveBytes: RESERVE, filesystemId: null });
    }
  }
});
test("a blocked or failing pressure guard refuses before any filesystem is read", () => {
  const reads = table({ 10: space(10 ** 12) });
  expect(assessFreeSpace({ images: [image("a.ext4", GiB, 10)], space: reads, guard: closed })).toMatchObject({ outcome: "resource_blocked", reason: "pressure_guard_blocked", availableBytes: null, filesystemId: null });
  expect(assessFreeSpace({ images: [image("a.ext4", GiB, 10)], space: reads, guard: { admitsNewWork: () => { throw new Error("x"); } } }).outcome).toBe("resource_blocked");
  expect(assessFreeSpace({ images: [image("a.ext4", GiB, 10)], space: reads, guard: { admitsNewWork: () => 1 as unknown as boolean } }).outcome).toBe("resource_blocked"); // only `true` admits
  expect(reads.reads).toEqual([]);
});
test("malformed requests are structured refusals, never a throw and never an admit", () => {
  const ok = image("a.ext4", GiB, 10), reader = table({ 10: space(10 ** 12) });
  const bad = (input: unknown) => assessFreeSpace(input as Parameters<typeof assessFreeSpace>[0]).outcome;
  expect(bad({ images: [], space: reader, guard: open })).toBe("invalid_request");
  expect(bad({ images: Array.from({ length: 17 }, (_, i) => image(`i${i}`, GiB, 10)), space: reader, guard: open })).toBe("invalid_request");
  for (const size of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(bad({ images: [image("a", size, 10)], space: reader, guard: open })).toBe("invalid_request");
  for (const name of ["", "a b", "../x", "x/y", "a".repeat(65)]) expect(bad({ images: [image(name, GiB, 10)], space: reader, guard: open })).toBe("invalid_request");
  for (const reserveBytes of [0, -5, 1.5, Number.NaN]) expect(bad({ images: [ok], space: reader, guard: open, reserveBytes })).toBe("invalid_request");
  expect(bad({ images: [image("a", Number.MAX_SAFE_INTEGER, 10)], space: reader, guard: open })).toBe("invalid_request"); // the sum overflows
  expect(bad({ images: [ok], space: {}, guard: open })).toBe("invalid_request");
  expect(bad({ images: [ok], space: reader, guard: {} })).toBe("invalid_request");
  expect(bad({ images: [ok], space: reader })).toBe("invalid_request");
  expect(bad(null)).toBe("invalid_request");
  expect(reader.reads).toEqual([]);
});

// ---------------------------------------------------------------- sticky exclusion re-verification
function verifier(opts: { descriptor?: (fd: number) => unknown; item?: (path: string, fd: number) => unknown } = {}) {
  const calls: string[] = [];
  const backup = new Proxy({
    verifyDescriptorExcluded: (fd: number) => { calls.push(`descriptor:${fd}`); return opts.descriptor ? opts.descriptor(fd) : true; },
    verifyItemExcluded: (path: string, fd: number) => { calls.push(`item:${path}:${fd}`); return opts.item ? opts.item(path, fd) : true; },
  }, { get(target, key) { if (key === "excludeItem") throw new Error("re-verification must never apply an exclusion"); return Reflect.get(target, key); } });
  return { backup: backup as unknown as ExclusionVerifier, calls };
}
const excludable = (name: string, fd: number) => ({ name, path: `/h/cowork/workspaces/w/${name}`, fd });
test("re-verification asks both the descriptor and the named check for every image, and never applies an exclusion", () => {
  const v = verifier();
  expect(reverifyStickyExclusion([excludable("data.ext4", 10), excludable("env.ext4", 11)], v.backup)).toBeNull();
  expect(v.calls).toEqual(["descriptor:10", "item:/h/cowork/workspaces/w/data.ext4:10", "descriptor:11", "item:/h/cowork/workspaces/w/env.ext4:11"]);
});
test("re-verification names the first image that is not provably excluded; a throw or a non-true answer is a no", () => {
  const images = [excludable("data.ext4", 10), excludable("env.ext4", 11)];
  expect(reverifyStickyExclusion(images, verifier({ item: (_p, fd) => fd !== 11 }).backup)).toEqual({ outcome: "backup_exclusion_unavailable", image: "env.ext4" });
  expect(reverifyStickyExclusion(images, verifier({ descriptor: fd => fd !== 10 }).backup)).toEqual({ outcome: "backup_exclusion_unavailable", image: "data.ext4" });
  expect(reverifyStickyExclusion(images, verifier({ item: () => { throw new Error("tmutil gone"); } }).backup)).toEqual({ outcome: "backup_exclusion_unavailable", image: "data.ext4" });
  for (const answer of [1, "yes", {}, undefined, null]) expect(reverifyStickyExclusion(images, verifier({ item: () => answer }).backup)).toEqual({ outcome: "backup_exclusion_unavailable", image: "data.ext4" });
  // The cheap vnode check short-circuits the expensive named check.
  const cheap = verifier({ descriptor: () => false }); reverifyStickyExclusion(images, cheap.backup); expect(cheap.calls).toEqual(["descriptor:10"]);
});
test("preflight: guard, then free space on the fds, then exclusion; later stages never run after an earlier refusal", () => {
  const pre = (opts: { free?: number; guard?: PressureView; v?: ReturnType<typeof verifier> }) => {
    const v = opts.v ?? verifier(), reader = table({ 10: space(opts.free ?? 100 * GiB), 11: space(opts.free ?? 100 * GiB) });
    const result = preflightImageAdmission({ images: [{ name: "data.ext4", provisionedBytes: GiB, path: "/h/cowork/workspaces/w/data.ext4", fd: 10 }, { name: "env.ext4", provisionedBytes: GiB, path: "/h/cowork/workspaces/w/env.ext4", fd: 11 }], space: reader, guard: opts.guard ?? open, backup: v.backup });
    return { result, calls: v.calls, reads: reader.reads };
  };
  const admitted = pre({});
  expect(admitted.result).toMatchObject({ outcome: "admit", requiredBytes: 2 * GiB + RESERVE });
  expect(admitted.reads).toEqual([10, 11]); // fstatfs on the pinned fds, never a path
  expect(admitted.calls).toEqual(["descriptor:10", "item:/h/cowork/workspaces/w/data.ext4:10", "descriptor:11", "item:/h/cowork/workspaces/w/env.ext4:11"]);
  const guarded = pre({ guard: closed }); expect(guarded.result).toMatchObject({ outcome: "resource_blocked", reason: "pressure_guard_blocked" }); expect(guarded.reads).toEqual([]); expect(guarded.calls).toEqual([]);
  const full = pre({ free: 2 * GiB + RESERVE - 1 }); expect(full.result).toMatchObject({ outcome: "resource_blocked", reason: "free_space_below_requirement" }); expect(full.calls).toEqual([]);
  const unexcluded = pre({ v: verifier({ item: (_p, fd) => fd !== 11 }) }); expect(unexcluded.result).toEqual({ outcome: "backup_exclusion_unavailable", image: "env.ext4" });
});
test("preflight refuses malformed images and ports", () => {
  const base = { images: [{ name: "a.ext4", provisionedBytes: GiB, path: "/p/a.ext4", fd: 3 }], space: table({ 3: space(10 ** 12) }), guard: open, backup: verifier().backup };
  const bad = (patch: Record<string, unknown>) => preflightImageAdmission({ ...base, ...patch } as Parameters<typeof preflightImageAdmission>[0]).outcome;
  expect(bad({})).toBe("admit");
  expect(bad({ images: [{ ...base.images[0], path: "relative" }] })).toBe("invalid_request");
  expect(bad({ images: [{ ...base.images[0], path: "/a\0b" }] })).toBe("invalid_request");
  expect(bad({ images: [{ ...base.images[0], fd: -1 }] })).toBe("invalid_request");
  expect(bad({ backup: {} })).toBe("invalid_request");
  expect(bad({ backup: undefined })).toBe("invalid_request");
  expect(bad({ images: undefined })).toBe("invalid_request");
});

// ---------------------------------------------------------------- the real host (read-only; shape, not values)
real("the real fstatfs/statfs adapter returns a well-formed reading that agrees with node:fs on stable fields", () => {
  const root = mkdtempSync(join(tmpdir(), "winter-n2-statfs-")); roots.push(root);
  const path = join(root, "probe"), fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const reader = createStatfsReader(), byFd = reader.read({ kind: "fd", fd })!, byPath = reader.read({ kind: "path", path: root })!;
    for (const reading of [byFd, byPath]) {
      expect(reading.typeName).toMatch(/^[ -~]{1,15}$/);
      expect(reading.blockBytes).toBeGreaterThanOrEqual(512); expect(reading.blockBytes & (reading.blockBytes - 1)).toBe(0);
      expect(Number.isSafeInteger(reading.totalBytes) && Number.isSafeInteger(reading.availableBytes)).toBe(true);
      expect(reading.availableBytes).toBeGreaterThanOrEqual(0); expect(reading.totalBytes).toBeGreaterThanOrEqual(reading.availableBytes);
      expect(reading.totalBytes % reading.blockBytes).toBe(0); expect(reading.availableBytes % reading.blockBytes).toBe(0);
      expect(reading.filesystemId).toMatch(/^fsid:[0-9a-f]{1,8}:[0-9a-f]{1,8}$/);
    }
    expect(byFd.filesystemId).toBe(byPath.filesystemId); expect(byFd.typeName).toBe(byPath.typeName);
    const node = statfsSync(root); // block size and total are stable between two calls; free space is not
    expect(byFd.blockBytes).toBe(node.bsize); expect(byFd.totalBytes).toBe(node.blocks * node.bsize);
    expect(reader.read({ kind: "fd", fd: 0x7ffffff0 })).toBeNull();
    expect(reader.read({ kind: "path", path: join(root, "missing", "deeper") })).toBeNull();
  } finally { closeSync(fd); }
});
real("the real sticky-exclusion re-verification accepts only an image the existing helper has excluded (disposable temp images only)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-n2-excl-"))); roots.push(root); // tmutil names the canonical path
  mkdirSync(join(root, "ws"), { mode: 0o700 });
  const dir = join(root, "ws"), name = "data.ext4", path = join(dir, name);
  const seed = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600); ftruncateSync(seed, 16 * MiB); closeSync(seed);
  const dirFd = openDirAt(AT_FDCWD, dir), fd = openImageAt(dirFd, name);
  try {
    const images = [{ name, path, fd }];
    expect(reverifyStickyExclusion(images, timeMachineVolumeBackup)).toEqual({ outcome: "backup_exclusion_unavailable", image: name }); // never applied by the re-verify
    expect(reverifyStickyExclusion(images, timeMachineVolumeBackup)).not.toBeNull(); // and still not applied after the first call
    timeMachineVolumeBackup.excludeItem(path, fd); // the existing helper, applied by the test as the volume code does at creation
    expect(reverifyStickyExclusion(images, timeMachineVolumeBackup)).toBeNull();
    const pre = preflightImageAdmission({ images: [{ name, provisionedBytes: 16 * MiB, path, fd }], space: createStatfsReader(), guard: open, backup: timeMachineVolumeBackup, reserveBytes: 1 });
    expect(pre.outcome).toBe("admit");
  } finally { closeFd(fd); closeFd(dirFd); }
});
