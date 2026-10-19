import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkFolderSelections } from "../../src/cowork/folder-selections";
import { createMacCoworkHost } from "../../src/cowork/mac-host";
import { COWORK_REMOTE_METHODS, COWORK_RPC } from "@yanlinglabs/winter-protocol";
import { resolveMacFolderBookmark } from "../../src/cowork/folder-bookmark";

const local = { kind: "local-user" as const, id: "local-fixture" };
const other = { kind: "local-user" as const, id: "other-user" };
const remote = { kind: "paired-user" as const, id: "remote", workspaceIds: new Set<string>(), repositoryAuthorities: new Set<string>() };
const roots: string[] = [], hosts: CoworkFolderSelections[] = [];
afterEach(() => { hosts.splice(0).forEach(h => h.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "cowork-selection-")); roots.push(base);
  const folder = join(base, "source"), control = join(base, "protected"); mkdirSync(folder); mkdirSync(control);
  let now = 0, target = folder, scopes = 0;
  const options = { ttlMs: 100, now: () => now, protectedRoots: () => [control], resolver: (data: Buffer) => {
    if (data.toString() !== "host-bookmark") throw new Error("bad bookmark"); scopes++;
    let closed = false; return { path: target, close: () => { if (!closed) { closed = true; scopes--; } } };
  } };
  const host = new CoworkFolderSelections(options); hosts.push(host);
  const bookmark = Buffer.from("host-bookmark").toString("base64");
  return { base, folder, control, host, options, bookmark, prepare: () => host.prepare(local, 1, bookmark, "Fixture", "read-write"), target: (path: string) => { target = path; }, now: (value: number) => { now = value; }, scopes: () => scopes };
}
describe("the sweep timer is lazy", () => {
  test("no timer exists until a selection does, and it clears itself when the last one expires", () => {
    const f = fixture();
    const timerOf = () => (f.host as unknown as { timer?: unknown }).timer;
    expect(timerOf()).toBeUndefined(); // a daemon that never prepares a folder never owns a timer
    f.prepare(); expect(timerOf()).toBeDefined();
    f.now(1_000); (f.host as unknown as { sweep(): void }).sweep(); // past the 100 ms ttl: dropped
    expect(timerOf()).toBeUndefined();
  });
});

describe("Mac folder preparation authority", () => {
  test("opaque grant resolves through existing adapter without paths or readiness", () => {
    const f = fixture(), prepared = f.prepare(), selection = f.host.selection(local, 1, prepared.selectionId)!;
    expect(prepared.state).toBe("prepared"); expect(prepared.kind).toBe("folder"); expect(JSON.stringify(prepared)).not.toContain(f.base);
    expect(selection.kind).toBe("folder");
    if (selection.kind !== "folder") throw new Error("unexpected");
    expect(f.host.folder(selection.detail.grantRef)?.rootIdentity).toBe(selection.detail.rootIdentity);
    expect(f.scopes()).toBe(1);
    f.host.revoke(local, 1, prepared.selectionId);
    expect(f.host.folder(selection.detail.grantRef)).toBeUndefined(); expect(f.scopes()).toBe(0);
  });
  test("principal and connection are both mandatory, remote/runtime cannot prepare", () => {
    const f = fixture(), prepared = f.prepare();
    expect(f.host.selection(other, 1, prepared.selectionId)).toBeUndefined();
    expect(f.host.selection(local, 2, prepared.selectionId)).toBeUndefined();
    expect(() => f.host.revoke(other, 1, prepared.selectionId)).toThrow("authority_denied");
    expect(() => f.host.prepare(remote, 1, f.bookmark, "Remote", "read-only")).toThrow("authority_denied");
    expect(() => f.host.prepare({ kind: "runtime", id: "runtime", sessionId: "session", workspaceId: "workspace" }, 1, f.bookmark, "Runtime", "read-only")).toThrow("authority_denied");
    expect(f.host.selection(local, 1, prepared.selectionId)).toBeDefined();
  });
  test("expiry/disconnect and shutdown release scopes and descriptors", () => {
    const f = fixture(), baseline = readdirSync("/dev/fd").length, p = f.prepare();
    expect(readdirSync("/dev/fd").length).toBe(baseline + 1);
    f.now(100); expect(f.host.selection(local, 1, p.selectionId)).toBeUndefined();
    expect(readdirSync("/dev/fd").length).toBe(baseline); expect(f.scopes()).toBe(0);
    f.now(200); const next = f.prepare(); f.host.closeConnection(2);
    expect(f.host.selection(local, 1, next.selectionId)).toBeDefined();
    f.host.closeConnection(1); expect(f.scopes()).toBe(0); expect(readdirSync("/dev/fd").length).toBe(baseline);
    f.prepare(); f.host.close(); f.host.close(); expect(f.scopes()).toBe(0);
    expect(f.prepare).toThrow("authority_denied");
  });
  test("protected root, descendant, ancestor and symlink alias refuse", () => {
    const f = fixture();
    for (const path of [f.control, f.base]) {
      f.target(path); expect(f.prepare).toThrow("authority_denied"); expect(f.scopes()).toBe(0);
    }
    const child = join(f.control, "child"); mkdirSync(child); f.target(child);
    expect(f.prepare).toThrow("authority_denied");
    const alias = join(f.base, "alias"); symlinkSync(f.control, alias); f.target(alias);
    expect(f.prepare).toThrow("authority_denied"); expect(f.scopes()).toBe(0);
  });
  test("replacement, relocation and new protected-root registration revoke lookup", () => {
    const f = fixture(), p = f.prepare();
    renameSync(f.folder, join(f.base, "old")); mkdirSync(f.folder);
    expect(f.host.selection(local, 1, p.selectionId)).toBeUndefined(); expect(f.scopes()).toBe(0);
    const second = f.prepare(); f.target(join(f.base, "old"));
    expect(f.host.selection(local, 1, second.selectionId)).toBeUndefined(); expect(f.scopes()).toBe(0);
    f.target(f.folder); const third = f.prepare(); f.options.protectedRoots = () => [f.folder];
    expect(f.host.selection(local, 1, third.selectionId)).toBeUndefined(); expect(f.scopes()).toBe(0);
  });
  test("directory replacement during intake refuses before publishing without FD leaks", () => {
    const f = fixture(), baseline = readdirSync("/dev/fd").length;
    let count = 0;
    f.options.resolver = () => {
      count++; if (count === 2) { renameSync(f.folder, join(f.base, "old")); mkdirSync(f.folder); }
      return { path: f.folder, close() {} };
    };
    expect(f.prepare).toThrow("authority_denied"); expect(readdirSync("/dev/fd").length).toBe(baseline);
  });
  test("existing host-selection adapter binds current connection and retains provisioning refusal", () => {
    const f = fixture(), adapter = createMacCoworkHost(f.base, f.options); hosts.push(adapter.selections!);
    const connection = { role: "harness", connectionId: 4 }, principal = adapter.principal(connection)!;
    const p = adapter.selections!.prepare(principal, 4, f.bookmark, "Fixture", "read-only");
    expect(adapter.selection(principal, p.selectionId, connection)).toBeDefined();
    expect(adapter.selection(principal, p.selectionId, { ...connection, connectionId: 5 })).toBeUndefined();
    expect(() => adapter.requireProvisioning(principal)).toThrow("unsupported_topology");
  });
  test("bounded requests reject raw paths, invalid access and expose no paired methods", () => {
    const f = fixture(); expect(() => f.host.prepare(local, 1, "a", "Fixture", "read-only")).toThrow("invalid_request");
    expect(() => COWORK_RPC["workspace.selection.prepareFolder"].params.parse({ bookmarkBase64: f.bookmark, label: "Fixture", access: "read-only", path: f.folder })).toThrow();
    expect(() => COWORK_RPC["workspace.selection.prepareFolder"].params.parse({ bookmarkBase64: "x".repeat(87385), label: "Fixture", access: "read-only" })).toThrow();
    for (const method of ["workspace.selection.prepareFolder", "workspace.selection.revoke", "workspace.capabilities.get"]) expect(COWORK_REMOTE_METHODS as readonly string[]).not.toContain(method);
  });
  test("actual Mac bookmark producer resolves only the disposable directory", () => {
    if (process.platform !== "darwin") return;
    const f = fixture();
    const result = Bun.spawnSync(["swift", "-module-cache-path", join(f.base, "module-cache"), "-e", 'import Foundation; let url = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true); print(try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil).base64EncodedString())', f.folder], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const bookmark = result.stdout.toString().trim(), native = new CoworkFolderSelections({ protectedRoots: () => [f.control] }); hosts.push(native);
    const before = readdirSync(f.folder);
    const prepared = native.prepare(local, 7, bookmark, "Disposable", "read-write");
    expect(prepared.state).toBe("prepared"); expect(native.selection(local, 7, prepared.selectionId)).toBeDefined();
    expect(readdirSync(f.folder)).toEqual(before);
    native.closeConnection(7); expect(native.selection(local, 7, prepared.selectionId)).toBeUndefined();
  }, 30_000);
  test("request replay preserves grant and expiry, conflicting or expired replay never regrants", () => {
    const f = fixture();
    const first = f.host.prepare(local, 1, f.bookmark, "Fixture", "read-only", "attempt");
    const replay = f.host.prepare(local, 1, f.bookmark, "Fixture", "read-only", "attempt");
    expect(replay).toEqual(first); expect(f.scopes()).toBe(1);
    expect(() => f.host.prepare(local, 1, f.bookmark, "Changed", "read-only", "attempt")).toThrow("request_conflict");
    f.now(100); expect(() => f.host.prepare(local, 1, f.bookmark, "Fixture", "read-only", "attempt")).toThrow("authority_denied");
    expect(f.scopes()).toBe(0); f.host.revoke(local, 1, first.selectionId); f.host.revoke(local, 1, first.selectionId);
  });
  test("production native resolver rejects a base64 path or malformed bookmark", () => {
    const f = fixture();
    if (process.platform !== "darwin") return;
    expect(() => resolveMacFolderBookmark(Buffer.from(f.folder))).toThrow("authority_denied");
    expect(() => resolveMacFolderBookmark(Buffer.from("not-a-bookmark"))).toThrow("authority_denied");
  });
});
