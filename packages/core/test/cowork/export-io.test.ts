import { afterEach, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportIoError, attributeNameBuffers, copyImageFile, hasExtendedAttributes, hasWritableAcl, hashDescriptor, listDirectoryAt, openAt, openDirectoryNoFollow, renameDirect, stampDescriptor, stripExtendedAttributes } from "../../src/cowork/export-io";
import { spawnSync } from "node:child_process";
import { constants, renameSync, symlinkSync } from "node:fs";
import { BACKUP_XATTR, listXattrs, setXattr } from "./export-fixture";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-export-io-"))); dirs.push(dir); return dir; };
const MIB = 1024 * 1024;
function image(path: string, size: number) {
  const fd = openSync(path, "wx", 0o600); writeSync(fd, Buffer.from("head-bytes"), 0, 10, 8192); writeSync(fd, Buffer.from("tail"), 0, 4, size - 4); closeSync(fd);
  setXattr(path, BACKUP_XATTR, "bplist-fixture"); setXattr(path, "com.example.other", "x");
}

test("clone and sparse copy produce identical bytes, strip every xattr, and keep owner-only mode", async () => {
  const dir = temp(), source = join(dir, "source"); image(source, 8 * MIB);
  const fd = openSync(source, "r");
  try {
    expect(hasExtendedAttributes(fd)).toBe(true);
    expect(await copyImageFile(fd, join(dir, "clone"))).toBe("clone");
    expect(await copyImageFile(fd, join(dir, "sparse"), { allowClone: false })).toBe("sparse");
    for (const name of ["clone", "sparse"]) {
      expect(readFileSync(join(dir, name)).equals(readFileSync(source))).toBe(true);
      expect(listXattrs(join(dir, name))).toEqual([]);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    // A destination that exists is never opened for writing: EEXIST, content untouched.
    writeFileSync(join(dir, "taken"), "mine");
    await expect(copyImageFile(fd, join(dir, "taken"))).rejects.toThrow();
    await expect(copyImageFile(fd, join(dir, "taken"), { allowClone: false })).rejects.toThrow();
    expect(readFileSync(join(dir, "taken"), "utf8")).toBe("mine");
  } finally { closeSync(fd); }
});

test("a sparse copy keeps holes in a large file instead of writing zeros", async () => {
  const dir = temp(), source = join(dir, "source"); image(source, 64 * MIB);
  const fd = openSync(source, "r");
  try {
    await copyImageFile(fd, join(dir, "sparse"), { allowClone: false });
    const copy = statSync(join(dir, "sparse"));
    expect(copy.size).toBe(64 * MIB);
    expect(copy.blocks * 512).toBeLessThan(MIB); // two touched pages, not 64 MiB
    expect(readFileSync(join(dir, "sparse")).equals(readFileSync(source))).toBe(true);
  } finally { closeSync(fd); }
});

test("hashing and stamps: the stream hash is sha256 of exactly the first N bytes, and any write changes the stamp", async () => {
  const dir = temp(), path = join(dir, "f"); writeFileSync(path, "hello world");
  const fd = openSync(path, "r+");
  try {
    expect(await hashDescriptor(fd, 5)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const before = stampDescriptor(fd); writeSync(fd, Buffer.from("J"), 0, 1, 0);
    expect(stampDescriptor(fd)).not.toBe(before);
    await expect(hashDescriptor(fd, 1000)).rejects.toThrow(ExportIoError); // a short source is an error, never a silent partial hash
    const controller = new AbortController(); controller.abort();
    await expect(hashDescriptor(fd, 5, controller.signal)).rejects.toMatchObject({ reason: "cancelled" });
    // A change that moves only the change time (an xattr or a mode) still changes the stamp.
    const beforeMeta = stampDescriptor(fd); await new Promise(resolve => setTimeout(resolve, 20)); setXattr(path, "com.example.b", "1");
    expect(stampDescriptor(fd)).not.toBe(beforeMeta); stripExtendedAttributes(fd);
    setXattr(path, "com.example.a", "1"); expect(hasExtendedAttributes(fd)).toBe(true); stripExtendedAttributes(fd); expect(hasExtendedAttributes(fd)).toBe(false);
  } finally { closeSync(fd); }
});

test("renameDirect: exclusive refuses an existing target, swap exchanges two existing paths atomically", () => {
  const dir = temp(); mkdirSync(join(dir, "a")); mkdirSync(join(dir, "b")); writeFileSync(join(dir, "a/f"), "A"); writeFileSync(join(dir, "b/f"), "B");
  expect(() => renameDirect(join(dir, "a"), join(dir, "b"), "exclusive")).toThrow(ExportIoError);
  expect(readFileSync(join(dir, "b/f"), "utf8")).toBe("B");
  renameDirect(join(dir, "a"), join(dir, "b"), "swap");
  expect([readFileSync(join(dir, "a/f"), "utf8"), readFileSync(join(dir, "b/f"), "utf8")]).toEqual(["B", "A"]);
  expect(() => renameDirect(join(dir, "a"), join(dir, "missing"), "swap")).toThrow(ExportIoError);
  renameDirect(join(dir, "a"), join(dir, "c"), "exclusive");
  expect(readFileSync(join(dir, "c/f"), "utf8")).toBe("B");
});

test("extended-attribute names are handled as raw bytes: a name that is not valid UTF-8 is passed back unchanged", () => {
  // APFS refuses to create such a name, so the splitting that feeds fremovexattr is tested directly.
  const list = Buffer.concat([Buffer.from([0x61, 0xff, 0xfe, 0x62, 0]), Buffer.from("plain\0"), Buffer.from([0xc3, 0x28, 0])]);
  const names = attributeNameBuffers(list);
  expect(names.map(name => [...name])).toEqual([[0x61, 0xff, 0xfe, 0x62, 0], [...Buffer.from("plain\0")], [0xc3, 0x28, 0]]);
  expect(Buffer.concat(names).equals(list)).toBe(true);
  expect(attributeNameBuffers(Buffer.alloc(0))).toEqual([]);
});

test("a held directory cannot be redirected: openat and listing follow the descriptor, not the path, and links are refused", () => {
  const dir = temp(); mkdirSync(join(dir, "root")); mkdirSync(join(dir, "root/a")); writeFileSync(join(dir, "root/a/file"), "original"); writeFileSync(join(dir, "root/top"), "t");
  mkdirSync(join(dir, "decoy")); writeFileSync(join(dir, "decoy/file"), "DECOY"); symlinkSync(join(dir, "decoy"), join(dir, "root/link"));
  const root = openDirectoryNoFollow(join(dir, "root"));
  try {
    expect(listDirectoryAt(root)).toEqual(["a", "link", "top"]);
    expect(listDirectoryAt(root)).toEqual(["a", "link", "top"]); // a second listing of the same descriptor is not empty
    const held = openAt(root, "a", constants.O_RDONLY | constants.O_DIRECTORY);
    // The path is swapped for the decoy; the held descriptors still see the original.
    renameSync(join(dir, "root/a"), join(dir, "moved-a")); symlinkSync(join(dir, "decoy"), join(dir, "root/a"));
    expect(listDirectoryAt(held)).toEqual(["file"]);
    const file = openAt(held, "file", constants.O_RDONLY); expect(readFileSync(`/dev/fd/${file}`, "utf8")).toBe("original"); closeSync(file); closeSync(held);
    expect(() => openAt(root, "a", constants.O_RDONLY | constants.O_DIRECTORY)).toThrow(ExportIoError); // now a link: refused
    expect(() => openAt(root, "link", constants.O_RDONLY)).toThrow(ExportIoError);
    for (const bad of ["", ".", "..", "a/b", "a\0b"]) expect(() => openAt(root, bad, constants.O_RDONLY)).toThrow(ExportIoError);
  } finally { closeSync(root); }
  expect(() => openDirectoryNoFollow(join(dir, "root/link"))).toThrow(); // a final symlink is refused
});

test("a destination ACL that lets another principal add files or delete children is detected, a read-only one is not", () => {
  const dir = temp();
  expect(hasWritableAcl(dir)).toBe(false);
  expect(spawnSync("/bin/chmod", ["+a", "everyone allow read,list", dir]).status).toBe(0);
  expect(hasWritableAcl(dir)).toBe(false);
  expect(spawnSync("/bin/chmod", ["+a", "everyone allow add_file", dir]).status).toBe(0);
  expect(hasWritableAcl(dir)).toBe(true);
  const other = temp(); expect(spawnSync("/bin/chmod", ["+a", "everyone allow delete_child", other]).status).toBe(0);
  expect(hasWritableAcl(other)).toBe(true);
  expect(hasWritableAcl(join(dir, "does-not-exist"))).toBe(false); // no path, no ACL: the caller's own existence check judges it
});
