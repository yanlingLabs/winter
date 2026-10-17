import { afterEach, expect, test } from "bun:test";
import { closeSync, constants, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, statfsSync, symlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES, COWORK_FREE_SPACE_MAX_IMAGES, COWORK_FREE_SPACE_RESERVE_BYTES, STATFS_BYTES, assessFreeSpace, createFstatFootprintReader, createStatfsReader, parseStatfs, preflightImageAdmission, readSpaceSafely, reverifyStickyExclusion,
  type ExclusionVerifier, type FilesystemSpace, type FilesystemSpaceReader, type FreeSpaceInput, type ImageFootprintReader, type PressureView, type ProvisionedImage, type SpaceTarget, type StatfsLibrary,
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
/** Allocated bytes per fd; absent means unknown. */
function footprints(values: Record<number, number | null | "throw" | string>): ImageFootprintReader & { asked: SpaceTarget[] } {
  const asked: SpaceTarget[] = [];
  return { asked, allocatedBytes(target) { asked.push(target); const v = target.kind === "fd" ? values[target.fd] : undefined; if (v === "throw") throw new Error("boom"); return (v ?? null) as number | null; } };
}
const noFootprint = footprints({});
const image = (name: string, provisionedBytes: number, fd: number): ProvisionedImage => ({ name, provisionedBytes, target: fdTarget(fd) });
/** assessFreeSpace with the ports a caller must always pass, overridable per test. */
const assess = (patch: Partial<FreeSpaceInput> & Pick<FreeSpaceInput, "images" | "space">) => assessFreeSpace({ outstanding: [], footprint: noFootprint, guard: open, ...patch });

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
test("readSpaceSafely returns a validated plain copy and never throws, whatever the reader does", () => {
  const target = fdTarget(3), good = space(5 * GiB);
  const copy = readSpaceSafely({ read: () => good }, target)!;
  expect(copy).toEqual(good); expect(copy).not.toBe(good);
  expect(readSpaceSafely({ read: () => null }, target)).toBeNull();
  expect(readSpaceSafely({ read: () => { throw new Error("x"); } }, target)).toBeNull();
  const hostile = { get filesystemId() { return "fsid:x"; }, get availableBytes(): number { throw new Error("getter"); }, typeName: "apfs", blockBytes: 4096, totalBytes: 1 } as FilesystemSpace;
  expect(readSpaceSafely({ read: () => hostile }, target)).toBeNull();
  for (const bad of [{ ...good, availableBytes: -1 }, { ...good, availableBytes: 1.5 }, { ...good, availableBytes: Number.NaN }, { ...good, availableBytes: Number.MAX_SAFE_INTEGER + 2 }, { ...good, filesystemId: "" }, { ...good, filesystemId: 7 as never }, { ...good, filesystemId: "x".repeat(201) }])
    expect(readSpaceSafely({ read: () => bad }, target)).toBeNull();
});

// ---------------------------------------------------------------- the allocation reader
test("the footprint reader is st_blocks * 512 of a regular file reached by fd or by an unfollowed path, and null for everything else", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-n2-footprint-"))); roots.push(root);
  const path = join(root, "img"), fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    ftruncateSync(fd, 64 * MiB);
    const reader = createFstatFootprintReader();
    const blocks = () => statSync(path).blocks * 512;
    expect(blocks()).toBeLessThan(MiB);
    expect(reader.allocatedBytes({ kind: "fd", fd })).toBe(blocks()); expect(reader.allocatedBytes({ kind: "path", path })).toBe(blocks());
    writeSync(fd, Buffer.alloc(8 * MiB, 1), 0, 8 * MiB, 0);
    expect(blocks()).toBeGreaterThanOrEqual(8 * MiB);
    expect(reader.allocatedBytes({ kind: "fd", fd })).toBe(blocks()); expect(reader.allocatedBytes({ kind: "path", path })).toBe(blocks());
    const link = join(root, "link"); symlinkSync(path, link);
    mkdirSync(join(root, "dir"));
    for (const target of [{ kind: "path", path: link }, { kind: "path", path: join(root, "dir") }, { kind: "path", path: join(root, "missing") }, { kind: "path", path: "relative" }, { kind: "path", path: "/a\0b" }, { kind: "fd", fd: 0x7ffffff0 }, { kind: "fd", fd: -1 }, { kind: "fd", fd: 1.5 }, { kind: "other" }, null] as unknown as SpaceTarget[])
      expect(reader.allocatedBytes(target)).toBeNull();
  } finally { closeSync(fd); }
});

// ---------------------------------------------------------------- free-space admission
test("the reserve is the contract's 5 GiB and the requirement is sum(remaining) + reserve", () => {
  expect(COWORK_FREE_SPACE_RESERVE_BYTES).toBe(5368709120);
  const images = [image("data.ext4", 64 * GiB, 10), image("env.ext4", 32 * GiB, 11)], need = 96 * GiB + RESERVE;
  expect(assess({ images, space: table({ 10: space(need), 11: space(need) }) })).toEqual({ outcome: "admit", requiredBytes: need, availableBytes: need, reserveBytes: RESERVE, filesystemId: "fsid:test:1" });
});
test("exact boundary: reserve-1, reserve, reserve+1 around the full requirement (free < required blocks, free == required admits)", () => {
  const images = [image("data.ext4", 8 * GiB, 10), image("env.ext4", 4 * GiB, 11)], need = 12 * GiB + RESERVE;
  const run = (free: number) => assess({ images, space: table({ 10: space(free), 11: space(free) }) });
  expect(run(need - 1)).toEqual({ outcome: "resource_blocked", reason: "free_space_below_requirement", requiredBytes: need, availableBytes: need - 1, reserveBytes: RESERVE, filesystemId: "fsid:test:1" });
  expect(run(need).outcome).toBe("admit");
  expect(run(need + 1).outcome).toBe("admit");
  // The same three values around the bare reserve with a one-byte image pin the reserve itself, not just the sum.
  const tiny = [image("a.ext4", 1, 10)];
  expect(assess({ images: tiny, space: table({ 10: space(RESERVE) }) }).outcome).toBe("resource_blocked");
  expect(assess({ images: tiny, space: table({ 10: space(RESERVE + 1) }) }).outcome).toBe("admit");
});
test("a tunable reserve replaces the default, and the default applies when omitted", () => {
  const one = [image("a.ext4", 1000, 10)];
  expect(assess({ images: one, space: table({ 10: space(1999) }), reserveBytes: 1000 }).outcome).toBe("resource_blocked");
  expect(assess({ images: one, space: table({ 10: space(2000) }), reserveBytes: 1000 }).outcome).toBe("admit");
  expect(assess({ images: one, space: table({ 10: space(1000 + RESERVE - 1) }) }).outcome).toBe("resource_blocked");
});
test("several images: every image counts, none can be dropped from the sum", () => {
  const sizes = [10 * GiB, 20 * GiB, 30 * GiB], images = sizes.map((size, i) => image(`img${i}.ext4`, size, 10 + i));
  const need = 60 * GiB + RESERVE;
  const reader = (free: number) => table({ 10: space(free), 11: space(free), 12: space(free) });
  expect(assess({ images, space: reader(need - 1) }).outcome).toBe("resource_blocked");
  expect(assess({ images, space: reader(need) }).outcome).toBe("admit");
  // Enough for any two of the three (and the reserve) is still refused: all three are counted.
  for (let skip = 0; skip < 3; skip++) expect(assess({ images, space: reader(60 * GiB - sizes[skip]! + RESERVE) }).outcome).toBe("resource_blocked");
});
test("remaining liability: provisioned minus allocated is reserved, an unwritten sparse image needs its full size, and the credit is capped", () => {
  const A = 10 * GiB, B = 5 * GiB, images = [image("data.ext4", A, 10), image("env.ext4", B, 11)];
  const run = (alloc: Record<number, number | null | "throw" | string>, free: number) => assess({ images, space: table({ 10: space(free), 11: space(free) }), footprint: footprints(alloc) });
  // Nothing allocated (a never-written sparse image): the full provisioned size is needed.
  expect(run({ 10: 0, 11: 0 }, 15 * GiB + RESERVE - 1).outcome).toBe("resource_blocked");
  expect(run({ 10: 0, 11: 0 }, 15 * GiB + RESERVE).outcome).toBe("admit");
  // 4 GiB of the first image is already on disk: only its remaining 6 GiB is liability.
  const need = 11 * GiB + RESERVE;
  expect(run({ 10: 4 * GiB, 11: 0 }, need - 1)).toMatchObject({ outcome: "resource_blocked", reason: "free_space_below_requirement", requiredBytes: need });
  expect(run({ 10: 4 * GiB, 11: 0 }, need)).toMatchObject({ outcome: "admit", requiredBytes: need });
  // A fully allocated image has nothing left to grow into; credit never exceeds the provisioned size, so it can never go negative.
  expect(run({ 10: A, 11: 0 }, 5 * GiB + RESERVE)).toMatchObject({ outcome: "admit", requiredBytes: 5 * GiB + RESERVE });
  expect(run({ 10: 100 * GiB, 11: 0 }, 5 * GiB + RESERVE - 1).outcome).toBe("resource_blocked");
  expect(run({ 10: 100 * GiB, 11: 100 * GiB }, RESERVE)).toMatchObject({ outcome: "admit", requiredBytes: RESERVE });
  // An unreadable or nonsensical allocation earns no credit at all.
  for (const bad of [null, "throw", Number.NaN, -5, 1.5, 0, "7"] as const) {
    expect({ bad, outcome: run({ 10: bad, 11: bad }, 15 * GiB + RESERVE - 1).outcome }).toEqual({ bad, outcome: "resource_blocked" });
    expect({ bad, result: run({ 10: bad, 11: bad }, 15 * GiB + RESERVE) }).toMatchObject({ bad, result: { outcome: "admit", requiredBytes: 15 * GiB + RESERVE } }); // exactly the full size, not more
  }
  // The allocation is read from the same target as the free space.
  const reads = footprints({ 10: 0, 11: 0 }); assess({ images, space: table({ 10: space(10 ** 13), 11: space(10 ** 13) }), footprint: reads });
  expect(reads.asked).toEqual([fdTarget(10), fdTarget(11)]);
});
test("sparse images are not reservations: real sparse and partly written files, measured by fstat on the pinned fd", () => {
  const root = mkdtempSync(join(tmpdir(), "winter-n2-sparse-")); roots.push(root);
  const path = join(root, "data.ext4"), fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    ftruncateSync(fd, 64 * MiB);
    const reader = createFstatFootprintReader(), images = [image("data.ext4", 64 * MiB, fd)];
    const allocated = () => statSync(path).blocks * 512;
    expect(allocated()).toBeLessThan(MiB); // claims (almost) no physical space ...
    let need = 64 * MiB - allocated() + RESERVE; // ... yet still needs (almost) all of its provisioned size
    expect(need).toBeGreaterThan(63 * MiB + RESERVE);
    expect(assess({ images, space: table({ [fd]: space(need - 1) }), footprint: reader }).outcome).toBe("resource_blocked");
    expect(assess({ images, space: table({ [fd]: space(need) }), footprint: reader })).toMatchObject({ outcome: "admit", requiredBytes: need });
    // Writing real data moves exactly that many bytes from "liability" to "already on disk".
    writeSync(fd, Buffer.alloc(8 * MiB, 1), 0, 8 * MiB, 0);
    expect(allocated()).toBeGreaterThanOrEqual(8 * MiB);
    need = 64 * MiB - allocated() + RESERVE;
    expect(assess({ images, space: table({ [fd]: space(need - 1) }), footprint: reader })).toMatchObject({ outcome: "resource_blocked", requiredBytes: need });
    expect(assess({ images, space: table({ [fd]: space(need) }), footprint: reader }).outcome).toBe("admit");
  } finally { closeSync(fd); }
});
test("outstanding images of other admissions are counted: a candidate that fits alone is refused beside them", () => {
  const candidate = [image("data.ext4", 20 * GiB, 10)];
  const others = [image("other-data.ext4", 50 * GiB, 20), image("other-env.ext4", 10 * GiB, 21)];
  const reader = (free: number) => table({ 10: space(free), 20: space(free), 21: space(free) });
  expect(assess({ images: candidate, space: reader(20 * GiB + RESERVE) }).outcome).toBe("admit"); // alone it fits
  const need = 80 * GiB + RESERVE;
  expect(assess({ images: candidate, outstanding: others, space: reader(need - 1) })).toMatchObject({ outcome: "resource_blocked", requiredBytes: need });
  expect(assess({ images: candidate, outstanding: others, space: reader(need) }).outcome).toBe("admit");
  // Outstanding images get the same remaining-liability credit.
  const credited = footprints({ 20: 30 * GiB, 21: 10 * GiB });
  expect(assess({ images: candidate, outstanding: others, space: reader(40 * GiB + RESERVE), footprint: credited })).toMatchObject({ outcome: "admit", requiredBytes: 40 * GiB + RESERVE });
  expect(assess({ images: candidate, outstanding: others, space: reader(40 * GiB + RESERVE - 1), footprint: credited }).outcome).toBe("resource_blocked");
  // Their filesystems are observed too, and the smallest pool decides.
  const split = table({ 10: space(1000 * GiB, "fsid:big"), 20: space(80 * GiB + RESERVE - 1, "fsid:small"), 21: space(1000 * GiB, "fsid:big") });
  expect(assess({ images: candidate, outstanding: others, space: split })).toMatchObject({ outcome: "resource_blocked", filesystemId: "fsid:small" });
  expect(assess({ images: candidate, outstanding: others, space: table({ 10: space(10 ** 13), 20: null, 21: space(10 ** 13) }) })).toMatchObject({ outcome: "resource_blocked", reason: "free_space_unavailable" });
  expect(assess({ images: candidate, outstanding: [{ ...others[0]!, name: "bad name" }], space: reader(10 ** 13) }).outcome).toBe("invalid_request");
});
test("the caller must say what is outstanding: omitting it is an invalid request, an empty array is an explicit statement", () => {
  const images = [image("a.ext4", GiB, 10)], reader = table({ 10: space(10 ** 12) });
  const call = (patch: Record<string, unknown>) => assessFreeSpace({ images, outstanding: [], space: reader, footprint: noFootprint, guard: open, ...patch } as FreeSpaceInput).outcome;
  expect(call({})).toBe("admit");
  reader.reads.length = 0;
  for (const omitted of [undefined, null, "none", {}]) expect(call({ outstanding: omitted })).toBe("invalid_request");
  expect(preflightImageAdmission({ images: [{ name: "a.ext4", provisionedBytes: GiB, path: "/p/a.ext4", fd: 10 }], outstanding: undefined, space: reader, footprint: noFootprint, guard: open, backup: verifier().backup } as never).outcome).toBe("invalid_request");
  expect(reader.reads).toEqual([]);
});
test("the number of images is bounded: a few being admitted, and a machine's worth together with the outstanding ones", () => {
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => image(`${prefix}${i}`, 4096, 3));
  const everything = { read: () => space(10 ** 13) } satisfies FilesystemSpaceReader;
  expect(COWORK_FREE_SPACE_MAX_IMAGES).toBe(8192); expect(COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES).toBe(4);
  // Both sides of the admitted-images cap (one guest admits two; four is the ceiling).
  expect(assess({ images: many(COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES, "c"), space: everything }).outcome).toBe("admit");
  expect(assess({ images: many(COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES + 1, "c"), space: everything }).outcome).toBe("invalid_request");
  expect(assess({ images: many(COWORK_FREE_SPACE_MAX_IMAGES, "c"), space: everything }).outcome).toBe("invalid_request"); // not a way to pass everything as "being admitted"
  // Both sides of the combined cap.
  expect(assess({ images: many(1, "c"), outstanding: many(COWORK_FREE_SPACE_MAX_IMAGES - 1, "o"), space: everything }).outcome).toBe("admit");
  expect(assess({ images: many(1, "c"), outstanding: many(COWORK_FREE_SPACE_MAX_IMAGES, "o"), space: everything }).outcome).toBe("invalid_request");
  expect(assess({ images: many(COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES, "c"), outstanding: many(COWORK_FREE_SPACE_MAX_IMAGES - COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES, "o"), space: everything }).outcome).toBe("admit");
  expect(assess({ images: many(COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES, "c"), outstanding: many(COWORK_FREE_SPACE_MAX_IMAGES - COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES + 1, "o"), space: everything }).outcome).toBe("invalid_request");
  // The preflight inherits both caps.
  const pre = (n: number) => preflightImageAdmission({ images: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, provisionedBytes: 4096, path: `/p/${i}`, fd: 3 })), outstanding: [], space: everything, footprint: noFootprint, guard: open, backup: verifier().backup }).outcome;
  expect(pre(COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES)).toBe("admit"); expect(pre(COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES + 1)).toBe("invalid_request");
});
test("shared pool: the MIN of every observed filesystem decides, never a per-filesystem group", () => {
  // Two APFS volumes of one container report the same pool under different fsids. 60 + 60 + reserve does not fit
  // in 100 GiB, though each 60 GiB image alone would pass its own volume's check.
  const images = [image("data.ext4", 60 * GiB, 10), image("env.ext4", 60 * GiB, 11)];
  const pool = 100 * GiB, shared = table({ 10: space(pool, "fsid:vol:a"), 11: space(pool, "fsid:vol:b") });
  expect(assess({ images, space: shared })).toMatchObject({ outcome: "resource_blocked", reason: "free_space_below_requirement", availableBytes: pool, requiredBytes: 120 * GiB + RESERVE });
  // Different filesystems: the smaller one limits, and is named.
  const mixed = table({ 10: space(1000 * GiB, "fsid:big"), 11: space(120 * GiB + RESERVE - 1, "fsid:small") });
  expect(assess({ images, space: mixed })).toMatchObject({ outcome: "resource_blocked", filesystemId: "fsid:small", availableBytes: 120 * GiB + RESERVE - 1 });
  const edge = assess({ images, space: table({ 10: space(1000 * GiB, "fsid:big"), 11: space(120 * GiB + RESERVE, "fsid:small") }) });
  expect(edge).toMatchObject({ outcome: "admit", filesystemId: "fsid:small", availableBytes: 120 * GiB + RESERVE });
});
test("an unreadable reading blocks: null, a throw, or a nonsensical number, on any one image", () => {
  const images = [image("data.ext4", GiB, 10), image("env.ext4", GiB, 11)], ok = space(100 * GiB);
  for (const bad of [null, "throw", space(-1), space(1.5), space(Number.NaN), space(Number.MAX_SAFE_INTEGER + 2)] as const) {
    for (const [a, b] of [[bad, ok], [ok, bad]] as const) {
      const result = assess({ images, space: table({ 10: a, 11: b }) });
      expect(result).toEqual({ outcome: "resource_blocked", reason: "free_space_unavailable", requiredBytes: null, availableBytes: null, reserveBytes: RESERVE, filesystemId: null });
    }
  }
  // A reader whose property getter throws is handled like any other unreadable answer.
  const hostile = { read: () => ({ get filesystemId() { return "fsid:x"; }, get availableBytes(): number { throw new Error("getter"); }, typeName: "apfs", blockBytes: 4096, totalBytes: 1 }) } as FilesystemSpaceReader;
  expect(assess({ images, space: hostile })).toMatchObject({ outcome: "resource_blocked", reason: "free_space_unavailable" });
});
test("a blocked or failing pressure guard refuses before any filesystem is read", () => {
  const reads = table({ 10: space(10 ** 12) }), images = [image("a.ext4", GiB, 10)];
  expect(assess({ images, space: reads, guard: closed })).toMatchObject({ outcome: "resource_blocked", reason: "pressure_guard_blocked", requiredBytes: null, availableBytes: null, filesystemId: null });
  expect(assess({ images, space: reads, guard: { admitsNewWork: () => { throw new Error("x"); } } }).outcome).toBe("resource_blocked");
  expect(assess({ images, space: reads, guard: { admitsNewWork: () => 1 as unknown as boolean } }).outcome).toBe("resource_blocked"); // only `true` admits
  expect(reads.reads).toEqual([]);
});
test("malformed requests are structured refusals, never a throw and never an admit", () => {
  const ok = image("a.ext4", GiB, 10), reader = table({ 10: space(10 ** 12) });
  const bad = (input: unknown) => assessFreeSpace(input as FreeSpaceInput).outcome;
  const base = { outstanding: [], space: reader, footprint: noFootprint, guard: open };
  expect(bad({ ...base, images: [] })).toBe("invalid_request");
  for (const size of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(bad({ ...base, images: [image("a", size, 10)] })).toBe("invalid_request");
  for (const name of ["", "a b", "../x", "x/y", "a".repeat(65)]) expect(bad({ ...base, images: [image(name, GiB, 10)] })).toBe("invalid_request");
  expect(bad({ ...base, images: [{ name: "a", provisionedBytes: GiB }] })).toBe("invalid_request"); // no target
  for (const reserveBytes of [0, -5, 1.5, Number.NaN]) expect(bad({ ...base, images: [ok], reserveBytes })).toBe("invalid_request");
  expect(bad({ ...base, space: table({ 10: space(10 ** 12) }), images: [image("a", Number.MAX_SAFE_INTEGER, 10), image("b", Number.MAX_SAFE_INTEGER, 10)] })).toBe("invalid_request"); // the sum overflows
  expect(bad({ ...base, images: [ok], space: {} })).toBe("invalid_request");
  expect(bad({ ...base, images: [ok], footprint: {} })).toBe("invalid_request");
  expect(bad({ ...base, images: [ok], guard: {} })).toBe("invalid_request");
  expect(bad({ images: [ok], outstanding: [], space: reader, guard: open })).toBe("invalid_request"); // no footprint reader
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
test("preflight: guard, then free space on the fds, then exclusion of the admitted images; later stages never run after an earlier refusal", () => {
  const pre = (opts: { free?: number; guard?: PressureView; v?: ReturnType<typeof verifier>; outstanding?: ProvisionedImage[] }) => {
    const v = opts.v ?? verifier(), reader = table({ 10: space(opts.free ?? 100 * GiB), 11: space(opts.free ?? 100 * GiB), 20: space(opts.free ?? 100 * GiB) }), footprint = footprints({ 10: 0, 11: 0, 20: 0 });
    const result = preflightImageAdmission({ images: [{ name: "data.ext4", provisionedBytes: GiB, path: "/h/cowork/workspaces/w/data.ext4", fd: 10 }, { name: "env.ext4", provisionedBytes: GiB, path: "/h/cowork/workspaces/w/env.ext4", fd: 11 }], outstanding: opts.outstanding ?? [], space: reader, footprint, guard: opts.guard ?? open, backup: v.backup });
    return { result, calls: v.calls, reads: reader.reads, asked: footprint.asked };
  };
  const admitted = pre({});
  expect(admitted.result).toMatchObject({ outcome: "admit", requiredBytes: 2 * GiB + RESERVE });
  expect(admitted.reads).toEqual([10, 11]); // fstatfs on the pinned fds, never a path
  expect(admitted.asked).toEqual([fdTarget(10), fdTarget(11)]); // and fstat on the same fds
  expect(admitted.calls).toEqual(["descriptor:10", "item:/h/cowork/workspaces/w/data.ext4:10", "descriptor:11", "item:/h/cowork/workspaces/w/env.ext4:11"]);
  const guarded = pre({ guard: closed }); expect(guarded.result).toMatchObject({ outcome: "resource_blocked", reason: "pressure_guard_blocked" }); expect(guarded.reads).toEqual([]); expect(guarded.calls).toEqual([]);
  const full = pre({ free: 2 * GiB + RESERVE - 1 }); expect(full.result).toMatchObject({ outcome: "resource_blocked", reason: "free_space_below_requirement" }); expect(full.calls).toEqual([]);
  const unexcluded = pre({ v: verifier({ item: (_p, fd) => fd !== 11 }) }); expect(unexcluded.result).toEqual({ outcome: "backup_exclusion_unavailable", image: "env.ext4" });
  // Outstanding images count toward space but are not re-verified for exclusion (their descriptors are not this caller's).
  const beside = pre({ outstanding: [image("other.ext4", 100 * GiB, 20)] });
  expect(beside.result).toMatchObject({ outcome: "resource_blocked", requiredBytes: 102 * GiB + RESERVE }); expect(beside.calls).toEqual([]);
  const roomy = pre({ free: 1000 * GiB, outstanding: [image("other.ext4", 100 * GiB, 20)] }); expect(roomy.result.outcome).toBe("admit"); expect(roomy.calls).toHaveLength(4);
});
test("preflight refuses malformed images and ports", () => {
  const base = { images: [{ name: "a.ext4", provisionedBytes: GiB, path: "/p/a.ext4", fd: 3 }], outstanding: [], space: table({ 3: space(10 ** 12) }), footprint: noFootprint, guard: open, backup: verifier().backup };
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
// Every check reduces to a boolean before expect(), so a failing assertion can never print a host identifier.
real("the real fstatfs/statfs adapter returns a well-formed reading that agrees with node:fs on stable fields", () => {
  const root = mkdtempSync(join(tmpdir(), "winter-n2-statfs-")); roots.push(root);
  const path = join(root, "probe"), fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const reader = createStatfsReader(), byFd = reader.read({ kind: "fd", fd }), byPath = reader.read({ kind: "path", path: root });
    expect(byFd !== null && byPath !== null).toBe(true);
    if (!byFd || !byPath) return;
    for (const reading of [byFd, byPath]) {
      expect(/^[ -~]{1,15}$/.test(reading.typeName)).toBe(true);
      expect(reading.blockBytes >= 512 && (reading.blockBytes & (reading.blockBytes - 1)) === 0).toBe(true);
      expect(Number.isSafeInteger(reading.totalBytes) && Number.isSafeInteger(reading.availableBytes)).toBe(true);
      expect(reading.availableBytes >= 0 && reading.totalBytes >= reading.availableBytes).toBe(true);
      expect(reading.totalBytes % reading.blockBytes === 0 && reading.availableBytes % reading.blockBytes === 0).toBe(true);
      expect(/^fsid:[0-9a-f]{1,8}:[0-9a-f]{1,8}$/.test(reading.filesystemId)).toBe(true);
    }
    expect(byFd.filesystemId === byPath.filesystemId && byFd.typeName === byPath.typeName).toBe(true);
    const node = statfsSync(root); // block size and total are stable between two calls; free space is not
    expect(byFd.blockBytes === node.bsize && byFd.totalBytes === node.blocks * node.bsize).toBe(true);
    expect(reader.read({ kind: "fd", fd: 0x7ffffff0 }) === null).toBe(true);
    expect(reader.read({ kind: "path", path: join(root, "missing", "deeper") }) === null).toBe(true);
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
    const pre = preflightImageAdmission({ images: [{ name, provisionedBytes: 16 * MiB, path, fd }], outstanding: [], space: createStatfsReader(), footprint: createFstatFootprintReader(), guard: open, backup: timeMachineVolumeBackup, reserveBytes: 1 });
    expect(pre.outcome).toBe("admit");
  } finally { closeFd(fd); closeFd(dirFd); }
});
