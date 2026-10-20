import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, openSync, closeSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { COWORK_INSTALLATION_ID_FILE, CoworkHostEnvError, assertDisjointFromHome, assertOutsideWinterHomes, coordinationDirectory, ensurePrivateDirectory, loadOrCreateInstallationId } from "../../src/cowork/host-env/coordination";
import { createCoworkRecoverGuards, processStartToken } from "../../src/cowork/host-env/guards";
import { COWORK_HOME_BINDING_DDL, createCoworkHomeBindingStore, createCoworkLaunchJournal, createCoworkReceiptStore } from "../../src/cowork/host-env/stores";
import { parseVolumeUuidReply, readVolumeId } from "../../src/cowork/host-env/volume-identity";
import type { ProcessInspection, ProcessTable } from "../../src/cowork/native/admission-probes";
import type { CoworkNativeLaunchEntry } from "../../src/cowork/native/stop-proof";
import type { CoworkVolumeRecord } from "../../src/cowork/volumes";

// N2 S7B part 1: the host facts of the production native environment, over temp directories and fakes. No real machine id, process or Keychain item is read.
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const temp = (): string => { const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-host-env-"))); roots.push(root); return root; };
const code = (body: () => unknown): string => { try { body(); return "accepted"; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

describe("the Coordination directory and the installation id", () => {
  test("the directory is the ledger's directory under the override, and a relative or empty override is refused (never a fallback to the real path)", () => {
    const root = temp();
    expect(coordinationDirectory({ env: { WINTER_COWORK_COORDINATION_DIR: root }, homeDirectory: "/nonexistent" })).toBe(root);
    expect(() => coordinationDirectory({ env: { WINTER_COWORK_COORDINATION_DIR: "relative/dir" }, homeDirectory: "/nonexistent" })).toThrow();
    expect(coordinationDirectory({ env: {}, homeDirectory: "/home-for-test" })).toBe("/home-for-test/Library/Application Support/Winter/Coordination");
  });
  test("a private directory is created 0700; an existing one with other bits, or a symlink, is refused and NOT repaired", () => {
    const root = temp(), fresh = join(root, "a", "b");
    ensurePrivateDirectory(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    const open = join(root, "open"); mkdirSync(open, { mode: 0o755 }); chmodSync(open, 0o755);
    expect(code(() => ensurePrivateDirectory(open))).toBe("directory_not_private");
    expect(statSync(open).mode & 0o777).toBe(0o755);
    symlinkSync(fresh, join(root, "link"));
    expect(code(() => ensurePrivateDirectory(join(root, "link")))).toBe("directory_path_alias");
  });
  test("any .winter component, in any case, is refused before anything is created", () => {
    for (const bad of ["/Users/x/.winter/coord", "/Users/x/.winter-dev/c", "/Users/x/.WINTER/c", "/tmp/.Winter-x/y"]) expect(code(() => assertOutsideWinterHomes(bad))).toBe("path_inside_winter_home");
    expect(() => assertOutsideWinterHomes("/Users/x/Library/Application Support/Winter/Coordination/cowork-receipts")).not.toThrow();
  });
  test("the coordination directory must be disjoint from the Winter home: not the home, not inside it, not above it, even through a symlink", () => {
    const root = temp(), home = join(root, "home"); mkdirSync(home);
    expect(code(() => assertDisjointFromHome(join(root, "coord"), home))).toBe("accepted");
    expect(code(() => assertDisjointFromHome(home, home))).toBe("path_inside_winter_home");
    expect(code(() => assertDisjointFromHome(join(home, "not-yet", "coord"), home))).toBe("path_inside_winter_home");
    expect(code(() => assertDisjointFromHome(root, home))).toBe("path_inside_winter_home");
    symlinkSync(home, join(root, "alias"));
    expect(code(() => assertDisjointFromHome(join(root, "alias", "coord"), home))).toBe("path_inside_winter_home");
    expect(code(() => assertDisjointFromHome(join(root, "homestead"), home))).toBe("accepted"); // a sibling that merely shares a name prefix is fine
  });
  test("a symlinked ancestor is refused BEFORE anything is created (the recursive mkdir must not follow it)", () => {
    const root = temp(), elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "link"));
    expect(code(() => ensurePrivateDirectory(join(root, "link", "a", "b")))).toBe("directory_path_alias");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  test("the installation id is random, created once at 0600, stable, and never overwritten", () => {
    const dir = join(temp(), "coord");
    const first = loadOrCreateInstallationId(dir);
    expect(first).toMatch(/^inst-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(statSync(join(dir, COWORK_INSTALLATION_ID_FILE)).mode & 0o777).toBe(0o600);
    expect(loadOrCreateInstallationId(dir)).toBe(first);
    expect(loadOrCreateInstallationId(dir, () => "inst-00000000-0000-4000-8000-000000000000")).toBe(first); // a different mint changes nothing
    expect(readdirSync(dir)).toEqual([COWORK_INSTALLATION_ID_FILE]); // no temp file left behind
    expect(loadOrCreateInstallationId(join(temp(), "other"))).not.toBe(first);
  });
  test("a mint that is not a valid id is refused, and an existing file that is not exactly a valid id of this user is refused, untouched", () => {
    const dir = join(temp(), "coord");
    expect(code(() => loadOrCreateInstallationId(dir, () => "not an id"))).toBe("installation_id_invalid");
    expect(existsSync(join(dir, COWORK_INSTALLATION_ID_FILE))).toBe(false);
    const path = join(dir, COWORK_INSTALLATION_ID_FILE);
    for (const [name, mutate] of [
      ["wrong mode", () => { writeFileSync(path, "inst-00000000-0000-4000-8000-000000000000\n", { mode: 0o644 }); chmodSync(path, 0o644); }],
      ["garbage", () => { writeFileSync(path, "garbage\n", { mode: 0o600 }); }],
      ["no newline", () => { writeFileSync(path, "inst-00000000-0000-4000-8000-000000000000", { mode: 0o600 }); }],
      ["empty", () => { writeFileSync(path, "", { mode: 0o600 }); }],
      ["hard link", () => { writeFileSync(path, "inst-00000000-0000-4000-8000-000000000000\n", { mode: 0o600 }); linkSync(path, join(dir, "second")); }],
    ] as const) {
      rmSync(dir, { recursive: true, force: true }); ensurePrivateDirectory(dir); mutate();
      const before = readFileSync(path, "utf8");
      expect(`${name}:${code(() => loadOrCreateInstallationId(dir))}`).toBe(`${name}:installation_id_invalid`);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    rmSync(dir, { recursive: true, force: true }); ensurePrivateDirectory(dir);
    writeFileSync(join(dir, "target"), "inst-00000000-0000-4000-8000-000000000000\n", { mode: 0o600 }); symlinkSync(join(dir, "target"), path);
    expect(code(() => loadOrCreateInstallationId(dir))).toBe("installation_id_invalid");
  });
});

describe("the home binding store", () => {
  const binding = { homeId: "home_00000000-0000-4000-8000-000000000001", canonicalPath: "/tmp/h", volumeId: "vol-a", directoryId: "inode-7", originMachineId: "machine-synthetic", originInstallationId: "inst-00000000-0000-4000-8000-000000000002" };
  function db() {
    const raw = new Database(":memory:"); raw.run("PRAGMA foreign_keys=ON");
    raw.exec("CREATE TABLE cowork_home_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), home_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)");
    raw.run("INSERT INTO cowork_home_identity VALUES (1,?,?)", [binding.homeId, "t"]);
    return { db: raw, path: "x" } as never;
  }
  test("unavailable until the table exists (migration 18), then write-once: an identical write is a no-op, a different one is refused", () => {
    const rs = db(), store = createCoworkHomeBindingStore(rs);
    expect(store.available()).toBe(false); expect(store.read()).toBeNull();
    expect(code(() => store.writeOnce(binding))).toBe("home_binding_unavailable");
    (rs as { db: Database }).db.exec(COWORK_HOME_BINDING_DDL);
    expect(store.available()).toBe(true); expect(store.read()).toBeNull();
    store.writeOnce(binding); store.writeOnce({ ...binding });
    expect(store.read()).toEqual(binding);
    for (const change of [{ canonicalPath: "/tmp/elsewhere" }, { volumeId: "vol-b" }, { directoryId: "inode-8" }, { originMachineId: "machine-other" }, { originInstallationId: "inst-00000000-0000-4000-8000-000000000003" }])
      expect(code(() => store.writeOnce({ ...binding, ...change }))).toBe("home_binding_conflict");
    expect(store.read()).toEqual(binding);
  });
});

describe("the launch journal", () => {
  const entry: CoworkNativeLaunchEntry = { workspaceId: "workspace_a", incarnationId: "inc-1", leaseEpoch: 3, bootId: "boot-1", launcher: { pid: 10, startToken: "1.000001", instanceId: "launcher-1" }, worker: null };
  test("records atomically, replaces the previous entry, forgets, and leaves no temp file", () => {
    const dir = join(temp(), "journal"), journal = createCoworkLaunchJournal(dir);
    expect(journal.load(entry)).toBeNull();
    journal.record({ ...entry, launcher: null });
    expect(journal.load(entry)!.launcher).toBeNull();
    journal.record({ ...entry, worker: { pid: 11, startToken: "2.000002" } });
    expect(journal.load(entry)).toEqual({ ...entry, worker: { pid: 11, startToken: "2.000002" } });
    expect(readdirSync(dir)).toEqual(["workspace_a.inc-1.3.json"]);
    expect(statSync(join(dir, "workspace_a.inc-1.3.json")).mode & 0o777).toBe(0o600);
    journal.forget(entry); journal.forget(entry);
    expect(journal.load(entry)).toBeNull(); expect(readdirSync(dir)).toEqual([]);
  });
  test("a corrupt, foreign, group-readable or oversize file reads as no entry; unsafe ids are refused", () => {
    const dir = join(temp(), "journal"), journal = createCoworkLaunchJournal(dir);
    const path = join(dir, "workspace_a.inc-1.3.json");
    writeFileSync(path, "{not json", { mode: 0o600 }); expect(journal.load(entry)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...entry, incarnationId: "inc-other" }), { mode: 0o600 }); expect(journal.load(entry)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...entry, launcher: { pid: -1, startToken: "x", instanceId: "i" } }), { mode: 0o600 }); expect(journal.load(entry)).toBeNull();
    writeFileSync(path, JSON.stringify(entry), { mode: 0o600 }); chmodSync(path, 0o644); expect(journal.load(entry)).toBeNull();
    chmodSync(path, 0o600); writeFileSync(path, "x".repeat(5000)); expect(journal.load(entry)).toBeNull();
    expect(code(() => journal.record({ ...entry, workspaceId: "../escape" }))).toBe("scope_invalid");
    expect(code(() => journal.record({ ...entry, bootId: "has space" }))).toBe("journal_entry_invalid");
    expect(journal.load({ ...entry, workspaceId: "../escape" })).toBeNull();
  });
});

describe("the receipt store (S2's DirectoryReceiptStore format)", () => {
  const vectors = JSON.parse(readFileSync(join(import.meta.dir, "native", "vectors", "stop-receipts.json"), "utf8")) as { positive: { text: string; class: string }[] };
  const text = vectors.positive.find(entry => entry.class === "A")!.text;
  const receipt = JSON.parse(text) as { workspaceId: string; incarnationId: string; leaseEpoch: number };
  const scope = { workspaceId: receipt.workspaceId, incarnationId: receipt.incarnationId, leaseEpoch: receipt.leaseEpoch };
  const name = `${scope.workspaceId}.${scope.incarnationId}.${scope.leaseEpoch}.receipt`;
  const setup = () => { const dir = join(temp(), "receipts"); ensurePrivateDirectory(dir); return { dir, store: createCoworkReceiptStore(dir), path: join(dir, name) }; };

  test("a regular 0600 single-link file of this user whose name and content agree is loaded, attested only as a file", () => {
    const { store, path } = setup();
    expect(store.load(scope)).toBeNull();
    writeFileSync(path, text, { mode: 0o600 });
    expect(store.load(scope)).toEqual({ text, attested: true });
  });
  test("every failed file check is no receipt: mode, hard link, symlink, size, empty, garbage, a scope mismatch, a missing newline", () => {
    const { dir, store, path } = setup();
    writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o644);
    expect(store.load(scope)).toBeNull();                                                   // group/world readable
    chmodSync(path, 0o600); linkSync(path, join(dir, "second-link"));
    expect(store.load(scope)).toBeNull(); rmSync(join(dir, "second-link"));                // two links
    rmSync(path); writeFileSync(join(dir, "real"), text, { mode: 0o600 }); symlinkSync(join(dir, "real"), path);
    expect(store.load(scope)).toBeNull(); rmSync(path);                                    // a symlink, even to a good file
    writeFileSync(path, "", { mode: 0o600 }); expect(store.load(scope)).toBeNull();        // empty
    writeFileSync(path, "x".repeat(9000), { mode: 0o600 }); expect(store.load(scope)).toBeNull(); // over the receipt bound
    writeFileSync(path, "{\"garbage\":1}\n", { mode: 0o600 }); expect(store.load(scope)).toBeNull();
    writeFileSync(path, text.slice(0, -1), { mode: 0o600 }); expect(store.load(scope)).toBeNull();
    writeFileSync(path, text.replace(scope.incarnationId, "inc-another-incarnation"), { mode: 0o600 }); expect(store.load(scope)).toBeNull(); // the name says one scope, the content another
    writeFileSync(path, text, { mode: 0o600 });
    expect(store.load({ ...scope, leaseEpoch: scope.leaseEpoch + 1 })).toBeNull();          // another epoch's name is another file
    expect(store.load({ ...scope, workspaceId: "../x" })).toBeNull();                        // an unsafe scope never builds a path
    expect(store.load(scope)).toEqual({ text, attested: true });
  });
  test("retire unlinks exactly its own scope, tolerates its absence, and never follows a symlink", () => {
    const { dir, store, path } = setup();
    const other = join(dir, `${scope.workspaceId}.${scope.incarnationId}.${scope.leaseEpoch + 1}.receipt`);
    writeFileSync(path, text, { mode: 0o600 }); writeFileSync(other, text, { mode: 0o600 });
    store.retire(scope); store.retire(scope);
    expect(existsSync(path)).toBe(false); expect(existsSync(other)).toBe(true);
    const target = join(dir, "target"); writeFileSync(target, "keep", { mode: 0o600 }); symlinkSync(target, path);
    store.retire(scope);
    expect(lstatSync(target).isFile()).toBe(true); expect(existsSync(path)).toBe(false);
    store.retire({ ...scope, workspaceId: "../escape" }); // no throw, nothing outside the directory
  });
  test("a directory under a .winter component is refused outright", () => {
    expect(code(() => createCoworkReceiptStore("/tmp/.winter-dev/receipts"))).toBe("path_inside_winter_home");
  });
});

describe("the two guard probes", () => {
  const entry = (over: Partial<CoworkNativeLaunchEntry> = {}): CoworkNativeLaunchEntry => ({ workspaceId: "workspace_a", incarnationId: "inc-1", leaseEpoch: 1, bootId: "boot-1", launcher: { pid: 10, startToken: "5.000005", instanceId: "launcher-1" }, worker: { pid: 11, startToken: "6.000006" }, ...over });
  const subject = (processes: CoworkNativeLaunchEntry | null) => ({ workspaceId: "workspace_a", incarnationId: "inc-1", leaseEpoch: 1, owner: null, processes });
  function guards(options: { entry?: CoworkNativeLaunchEntry | null; held?: boolean; table?: Record<number, ProcessInspection>; boot?: string | null; throwing?: boolean } = {}) {
    const table: ProcessTable = { inspect: pid => { if (options.throwing) throw new Error("table broke"); return options.table?.[pid] ?? { kind: "absent" }; } };
    const journal = { record: () => {}, forget: () => {}, load: () => options.entry ?? null };
    return createCoworkRecoverGuards({ journal, processes: table, bootId: () => options.boot === undefined ? "boot-1" : options.boot, ownersHeld: () => options.held ?? true, home: "/nonexistent" });
  }
  const present = (token: string, zombie = false): ProcessInspection => ({ kind: "present", startSeconds: Number(token.split(".")[0]), startMicroseconds: Number(token.split(".")[1]), zombie });

  test("the start token format is seconds.microseconds padded to six digits", () => {
    expect(processStartToken({ kind: "present", startSeconds: 5, startMicroseconds: 5, zombie: false })).toBe("5.000005");
  });
  test("both recorded processes absent: gone; one still present with its recorded start token: not shown", () => {
    expect(guards({ entry: entry() }).processAbsent(subject(null))).toBe(true);
    expect(guards({ entry: entry(), table: { 10: present("5.000005") } }).processAbsent(subject(null))).toBe(false);   // the launcher lives
    expect(guards({ entry: entry(), table: { 11: present("6.000006") } }).processAbsent(subject(null))).toBe(false);   // the worker lives
  });
  test("a pid reused by another process (another start token) or a zombie counts as gone; an unknowable table does not", () => {
    expect(guards({ entry: entry(), table: { 10: present("9.000009"), 11: present("9.000009") } }).processAbsent(subject(null))).toBe(true);
    expect(guards({ entry: entry(), table: { 10: present("5.000005", true), 11: present("6.000006", true) } }).processAbsent(subject(null))).toBe(true);
    expect(guards({ entry: entry(), table: { 10: { kind: "unknown" } } }).processAbsent(subject(null))).toBe(false);
    expect(guards({ entry: entry(), throwing: true }).processAbsent(subject(null))).toBe(false);
  });
  test("a boot id that differs from the entry's means nothing survived; an unreadable boot id shows nothing", () => {
    expect(guards({ entry: entry({ bootId: "boot-0" }), table: { 10: present("5.000005"), 11: present("6.000006") } }).processAbsent(subject(null))).toBe(true);
    expect(guards({ entry: entry(), boot: null }).processAbsent(subject(null))).toBe(false);
  });
  test("a null journal entry: absent only when no volume names an owner (nothing was ever claimed); with an owner the journal was lost, so not shown", () => {
    expect(guards({ entry: null, held: false }).processAbsent(subject(null))).toBe(true);
    expect(guards({ entry: null, held: true }).processAbsent(subject(null))).toBe(false);
  });
  test("an entry with no launcher identity (a spawn requested, its result never written) shows nothing, and so does an entry for another scope", () => {
    expect(guards({ entry: entry({ launcher: null }), held: false }).processAbsent(subject(null))).toBe(false);
    expect(guards({ entry: entry({ incarnationId: "inc-other" }) }).processAbsent(subject(null))).toBe(false);
  });
  test("a launcher with no worker identity: absent only while no volume owner exists (the claim comes after `begun`, which records the worker)", () => {
    expect(guards({ entry: entry({ worker: null }), held: false }).processAbsent(subject(null))).toBe(true);
    expect(guards({ entry: entry({ worker: null }), held: true }).processAbsent(subject(null))).toBe(false);
  });
  test("the subject's own journal entry is used when given; otherwise the journal is read", () => {
    expect(guards({ entry: null, held: true }).processAbsent(subject(entry()))).toBe(true);
  });

  describe("images unlocked", () => {
    const volume = (purpose: "data" | "environment", device: string, inode: string): CoworkVolumeRecord => ({ workspaceId: "workspace_a", purpose, identity: { device, inode, uid: 0, mode: 0o600 } } as unknown as CoworkVolumeRecord);
    const pair = [volume("data", "1", "10"), volume("environment", "1", "11")];
    const probeOf = (results: Record<string, ReturnType<NonNullable<Parameters<typeof createCoworkRecoverGuards>[0]["lockProbe"]>>>) => createCoworkRecoverGuards({ journal: { record: () => {}, forget: () => {}, load: () => null }, processes: { inspect: () => ({ kind: "absent" }) }, bootId: () => "b", ownersHeld: () => false, home: "/home", lockProbe: path => results[path.slice("/home/cowork/workspaces/workspace_a/".length)] ?? "missing" });
    test("both images free and the recorded files: unlocked", () => {
      expect(probeOf({ "data.ext4": { identity: { device: "1", inode: "10" } }, "env.ext4": { identity: { device: "1", inode: "11" } } }).imagesUnlocked(pair)).toBe(true);
    });
    test("either locked, missing, a different file, no recorded identity, or not exactly two volumes: not unlocked", () => {
      const free = { "data.ext4": { identity: { device: "1", inode: "10" } }, "env.ext4": { identity: { device: "1", inode: "11" } } } as const;
      expect(probeOf({ ...free, "env.ext4": "locked" }).imagesUnlocked(pair)).toBe(false);
      expect(probeOf({ ...free, "data.ext4": "missing" }).imagesUnlocked(pair)).toBe(false);
      expect(probeOf({ ...free, "data.ext4": { identity: { device: "1", inode: "99" } } }).imagesUnlocked(pair)).toBe(false);
      expect(probeOf({ ...free, "data.ext4": { identity: { device: "2", inode: "10" } } }).imagesUnlocked(pair)).toBe(false);
      expect(probeOf(free).imagesUnlocked([pair[0]!])).toBe(false);
      expect(probeOf(free).imagesUnlocked([{ ...pair[0]!, identity: null } as CoworkVolumeRecord, pair[1]!])).toBe(false);
      expect(probeOf(free).imagesUnlocked([{ ...pair[0]!, purpose: "other" } as unknown as CoworkVolumeRecord, pair[1]!])).toBe(false);
    });
    test.skipIf(process.platform !== "darwin")("the real probe: a held exclusive lock on the image makes it locked, releasing it makes it unlocked, and the identity is the file's", () => {
      const home = temp(), directory = join(home, "cowork", "workspaces", "workspace_a");
      mkdirSync(directory, { recursive: true });
      for (const file of ["data.ext4", "env.ext4"]) writeFileSync(join(directory, file), "x", { mode: 0o600 });
      const identityOf = (file: string) => { const info = statSync(join(directory, file), { bigint: true }); return { device: String(info.dev), inode: String(info.ino), uid: 0, mode: 0o600 }; };
      const volumes = [{ workspaceId: "workspace_a", purpose: "data", identity: identityOf("data.ext4") }, { workspaceId: "workspace_a", purpose: "environment", identity: identityOf("env.ext4") }] as unknown as CoworkVolumeRecord[];
      const real = createCoworkRecoverGuards({ journal: { record: () => {}, forget: () => {}, load: () => null }, processes: { inspect: () => ({ kind: "absent" }) }, bootId: () => "b", ownersHeld: () => false, home });
      expect(real.imagesUnlocked(volumes)).toBe(true);
      const holder = openSync(join(directory, "env.ext4"), constants.O_RDONLY | 0x20 /* O_EXLOCK */ | constants.O_NONBLOCK);
      try { expect(real.imagesUnlocked(volumes)).toBe(false); } finally { closeSync(holder); }
      expect(real.imagesUnlocked(volumes)).toBe(true);
      rmSync(join(directory, "data.ext4")); writeFileSync(join(directory, "data.ext4"), "y", { mode: 0o600 }); // a different file under the same name
      expect(real.imagesUnlocked(volumes)).toBe(false);
    });
  });
});

describe("the volume identity", () => {
  test("the reply parser takes only a well-formed non-nil uuid after a sane length word", () => {
    const reply = (length: number, uuid: number[]): Uint8Array => { const bytes = new Uint8Array(24); new DataView(bytes.buffer).setUint32(0, length, true); bytes.set(uuid, 4); return bytes; };
    const good = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    expect(parseVolumeUuidReply(reply(20, good))).toBe("12345678-9abc-def0-1122-334455667788");
    expect(parseVolumeUuidReply(reply(20, new Array(16).fill(0)))).toBeNull();
    expect(parseVolumeUuidReply(reply(8, good))).toBeNull();
    expect(parseVolumeUuidReply(new Uint8Array(10))).toBeNull();
    expect(parseVolumeUuidReply(null)).toBeNull();
    expect(readVolumeId("/x", { query: () => reply(20, good) })).toBe("vol-12345678-9abc-def0-1122-334455667788");
    expect(readVolumeId("/x", { query: () => { throw new Error("no"); } })).toBeNull();
  });
  test.skipIf(process.platform !== "darwin")("the real query answers a ledger-safe id for a real path and null for a missing one", () => {
    const id = readVolumeId(temp());
    expect(id === null || /^vol-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)).toBe(true);
    expect(readVolumeId(join(temp(), "does-not-exist"))).toBeNull();
  });
});
