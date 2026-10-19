// Anti-wiring pins for the content-out lane (the feature-branch publish service, the `.winterworkspace` writer and the restore
// flow). They replace the older "unwired" statement honestly: these modules are now WIRED, but only behind ports production
// never supplies, and only reachable from code that already sits behind the Cowork refusal. Each pin states what is true and
// would turn red the moment someone makes it false.
//
// The scanner resolves imports (relative specifiers, with or without a `.js`/`.ts` extension or `/index`, static, dynamic,
// `require`, re-export and multi-line forms) to files, so renaming a specifier cannot dodge it. The rules are pure functions of
// a path -> text map, and each rule is exercised on virtual files (passing and failing cases) as well as on the real tree.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { METHODS } from "@yanlinglabs/winter-protocol";
import { createCoworkPublishService } from "../../src/cowork/git/publish-service";
import { GitPublicationError } from "../../src/cowork/git/types";
import { createCoworkWorkspaceRestorer } from "../../src/cowork/restore-bundle";

const packages = join(import.meta.dir, "..", "..", "..");
const srcRoot = join(packages, "core", "src");
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
const packageDirs = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src")));
const REAL = new Map<string, string>(packageDirs.flatMap(entry => sourceFiles(join(packages, entry.name, "src")).map(file => [file, readFileSync(file, "utf8")] as const)));
const abs = (path: string) => join(srcRoot, path);

// ------------------------------------------------------------------------------------------------ the scanner

/** Every module specifier a text can load, in any spelling. */
export function specifiersOf(text: string): string[] {
  const out: string[] = [];
  for (const pattern of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\bimport\s+["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /\bexport\s*\*\s*from\s*["']([^"']+)["']/g])
    for (const match of text.matchAll(pattern)) out.push(match[1]!);
  return out;
}
/** The file a relative specifier from `importer` names, extension-insensitive; null for a package specifier. */
export function resolveSpecifier(importer: string, specifier: string, files: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier).replace(/\.(m|c)?(js|ts)x?$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.js")]) if (files.has(candidate)) return candidate;
  return `${base}.ts`;
}
export function importEdges(files: ReadonlyMap<string, string>): Array<[string, string]> {
  const known = new Set(files.keys()), edges: Array<[string, string]> = [];
  for (const [file, text] of files) for (const specifier of specifiersOf(text)) { const target = resolveSpecifier(file, specifier, known); if (target) edges.push([file, target]); }
  return edges;
}
/** Rule: a module may be reached only from its allowed importers. Returns the offending "importer -> module" edges. */
export function importViolations(files: ReadonlyMap<string, string>, allowed: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const [from, to] of importEdges(files)) {
    const rule = allowed[to];
    if (rule && !rule.includes(from) && !out.includes(`${rel(from)} -> ${rel(to)}`)) out.push(`${rel(from)} -> ${rel(to)}`);
  }
  return out;
}
/** Rule: a symbol may appear only in the listed files (identifier match, so a longer name does not trip a shorter one). */
export function symbolViolations(files: ReadonlyMap<string, string>, symbols: readonly string[], allowedFiles: readonly string[]): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (allowedFiles.includes(file)) continue;
    for (const symbol of symbols) if (new RegExp(`(?<![A-Za-z0-9_$])${symbol}(?![A-Za-z0-9_$])`).test(text)) out.push(`${rel(file)}: ${symbol}`);
  }
  return out;
}
const rel = (file: string) => relative(packages, file);

// ------------------------------------------------------------------------------------------------ the lane

const PUBLISH = ["cowork/git/publish-service.ts", "cowork/git/publish-intake.ts"].map(abs);
const EXPORT = ["cowork/export-writer.ts", "cowork/restore-bundle.ts", "cowork/export-bundle.ts", "cowork/export-io.ts"].map(abs);
const NEW_MODULES = [...PUBLISH, ...EXPORT];
const ALLOWED_IMPORTERS: Record<string, string[]> = {
  [abs("cowork/git/publish-service.ts")]: [],
  [abs("cowork/git/publish-intake.ts")]: [abs("cowork/git/publish-service.ts")],
  [abs("cowork/export-writer.ts")]: [abs("cowork/restore-bundle.ts")], // restore names the binding TYPE only
  [abs("cowork/restore-bundle.ts")]: [],
  [abs("cowork/export-bundle.ts")]: [abs("cowork/export-writer.ts"), abs("cowork/restore-bundle.ts")],
  [abs("cowork/export-io.ts")]: [abs("cowork/export-bundle.ts"), abs("cowork/export-writer.ts"), abs("cowork/restore-bundle.ts")],
};
const LANE_SYMBOLS = ["createCoworkPublishService", "CoworkPublishPorts", "PublishBundlePort", "pullPublishBundle", "publishBundlePath", "CoworkWorkspaceExporter", "createCoworkWorkspaceRestorer",
  "CoworkExportImageDoor", "CoworkExportContentBinding", "CoworkRestoreApproval", "CoworkRestoreIdentityPort", "inspectBundle", "verifyBundle", "hashBundleFiles", "walkRegularFilesAt", "openRegularAt",
  "renameDirect", "copyImageFile", "copyFdHashed", "stripExtendedAttributes", "hasWritableAcl", "listDirectoryAt", "openDirectoryNoFollow", "OutputIdMapper"];
const GIT_DIR = abs("cowork/git") + "/";
/** The exact import edges inside cowork/git today. Adding a new one (a new wire into the broker, the journal, ...) fails here. */
const GIT_EDGES = [
  "authority.ts -> types.ts", "broker.ts -> pack-budget.ts", "broker.ts -> types.ts", "executor.ts -> types.ts", "journal.ts -> types.ts", "pack-budget.ts -> types.ts",
  "publish-intake.ts -> types.ts", "publish-service.ts -> publish-intake.ts", "publish-service.ts -> types.ts",
  "read-authority.ts -> read-types.ts", "read-owned-command.ts -> read-types.ts", "read-parser-entry.ts -> read-types.ts", "read-parser-entry.ts -> read-wire.ts", "read-parser-helper.ts -> read-owned-command.ts",
  "read-parser-helper.ts -> read-types.ts", "read-transport.ts -> read-authority.ts", "read-transport.ts -> read-parser-helper.ts", "read-transport.ts -> read-types.ts", "read-transport.ts -> read-wire.ts",
  "read-wire.ts -> pack-budget.ts", "read-wire.ts -> read-types.ts",
];

test("the scanner is not vacuous: the real tree is found, and every new module exists", () => {
  expect(REAL.size).toBeGreaterThan(100);
  for (const module of NEW_MODULES) { expect(existsSync(module)).toBe(true); expect(REAL.has(module)).toBe(true); }
  expect(importEdges(REAL).length).toBeGreaterThan(500);
});

test("the scanner resolves every spelling of an import, so a renamed specifier cannot dodge a pin", () => {
  const importer = abs("ipc/zz-probe.ts"), target = abs("cowork/export-writer.ts");
  const files = new Map<string, string>([[importer, ""], [target, ""], [abs("cowork/export-io.ts"), ""], [abs("cowork/index.ts"), ""]]);
  const spellings = [
    'import { x } from "../cowork/export-writer";', 'import { x } from "../cowork/export-writer.js";', 'import { x } from "../cowork/export-writer.ts";', "import { x } from '../cowork/export-writer';",
    'import type { x } from "../cowork/export-writer";', 'export * from "../cowork/export-writer";', 'export { x } from "../cowork/export-writer.js";', 'const m = await import("../cowork/export-writer");',
    'const m = require("../cowork/export-writer");', 'import "../cowork/export-writer";', 'import {\n  a,\n  b,\n} from\n  "../cowork/export-writer";', 'import { x } from "../cowork/../cowork/export-writer.js";', 'import { x } from "./../ipc/../cowork/export-writer";',
  ];
  for (const text of spellings) expect([text, importViolations(new Map([...files, [importer, text]]), ALLOWED_IMPORTERS)]).toEqual([text, [`${rel(importer)} -> ${rel(target)}`]]);
  // An allowed importer, a package specifier and an unrelated file are fine.
  expect(importViolations(new Map([...files, [abs("cowork/restore-bundle.ts"), 'import type { x } from "./export-writer.js";']]), ALLOWED_IMPORTERS)).toEqual([]);
  expect(importViolations(new Map([...files, [importer, 'import { x } from "zod";\nimport { y } from "./other";']]), ALLOWED_IMPORTERS)).toEqual([]);
  // Symbols are matched as identifiers: a different longer name is not a hit, the real one is.
  expect(symbolViolations(new Map([[importer, "const a = renameDirectory(1);"]]), ["renameDirect"], [])).toEqual([]);
  expect(symbolViolations(new Map([[importer, "renameDirect(a, b, 'swap')"]]), ["renameDirect"], [])).toEqual([`${rel(importer)}: renameDirect`]);
  expect(symbolViolations(new Map([[importer, "copyImageFile(fd, p)"]]), ["copyImageFile"], [importer])).toEqual([]);
});

test("wired behind a port: no src file outside the lane names a new module or any of its symbols, so the daemon, the IPC server and every session door never build them", () => {
  expect(importViolations(REAL, ALLOWED_IMPORTERS)).toEqual([]);
  expect(symbolViolations(REAL, LANE_SYMBOLS, NEW_MODULES)).toEqual([]);
  // Nothing under cowork/ or elsewhere imports a *test* helper either.
  for (const [file] of importEdges(REAL)) expect(file.includes("/test/")).toBe(false);
});

test("cowork/git is not reachable from outside it, and its internal wiring is exactly the pinned edge list", () => {
  const edges = importEdges(REAL).filter(([from, to]) => to.startsWith(GIT_DIR) || from.startsWith(GIT_DIR));
  expect(edges.filter(([from, to]) => to.startsWith(GIT_DIR) && !from.startsWith(GIT_DIR)).map(([from, to]) => `${rel(from)} -> ${rel(to)}`)).toEqual([]);
  const internal = edges.filter(([from, to]) => from.startsWith(GIT_DIR) && to.startsWith(GIT_DIR)).map(([from, to]) => `${from.slice(GIT_DIR.length)} -> ${to.slice(GIT_DIR.length)}`).sort();
  expect(internal).toEqual([...GIT_EDGES].sort());
  // The broker, the journal, the authority and the executor are named by no file but their own and the tests.
  const names = ["CoworkGitPublicationBroker", "CanonicalPublicationJournal", "CurrentCoworkPublicationAuthority", "IsolatedGitExecutor", "resolveGitExecutable", "checkPackBudget"];
  const own = new Map([...REAL].filter(([file]) => !file.startsWith(GIT_DIR)));
  expect(symbolViolations(own, names, [])).toEqual([]);
  // The broker still refuses outside an isolated fixture, unchanged by the service.
  const broker = REAL.get(abs("cowork/git/broker.ts"))!;
  expect(broker).toContain('if (!this.options.isolatedFixture) deny("integration_unavailable");');
  expect(broker).toContain('availability(): { available: false; reason: "host_auth_and_service_integration_required" }');
});

test("the services built the way production would build them refuse every verb", async () => {
  const service = createCoworkPublishService(undefined);
  expect(service.availability()).toEqual({ available: false, reason: "publication_ports_absent" });
  const caller = { principalId: "u", sessionId: "s", taskId: "t" };
  await expect(service.publish(caller, { requestId: "r", sourceId: "x", ref: "refs/heads/f", oldOid: null, newOid: "a".repeat(40) })).rejects.toBeInstanceOf(GitPublicationError);
  expect(() => service.status(caller, "r")).toThrow(GitPublicationError);
  await expect(createCoworkWorkspaceRestorer(undefined).restore({ bundlePath: "/x.winterworkspace", proof: {} })).rejects.toMatchObject({ code: "integration_unavailable" });
});

test("the Cowork refusal is untouched: no RPC method, protocol name or session door names publish, export or restore, and the creation door is not built here", () => {
  for (const name of Object.values(METHODS as Record<string, string>)) expect(`${name}:${/publish|winterworkspace|workspace\.export|workspace\.restore|bundle/i.test(name)}`).toBe(`${name}:false`);
  for (const file of ["ipc/server.ts", "daemon.ts", "sessions/session-mode.ts", "cowork/service.ts", "cowork/session-ports.ts"].map(abs)) {
    const text = REAL.get(file)!;
    for (const needle of ["publish-service", "export-writer", "restore-bundle", "winterworkspace", "createCoworkPublishService", "createCoworkWorkspaceRestorer"]) expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
  for (const module of NEW_MODULES) {
    const text = REAL.get(module)!;
    // No door, no new error code, no setting, no environment switch.
    for (const needle of ["coworkSessions", "CoworkSessionDoor", "CoworkError(", "process.env", "Bun.env", "settings."]) expect(`${basename(module)}:${needle}:${text.includes(needle)}`).toBe(`${basename(module)}:${needle}:false`);
  }
});

const codeOnly = (text: string) => text.split("\n").filter(line => !/^\s*(\/\*|\*|\/\/)/.test(line)).map(line => line.replace(/\/\/.*$/, "")).join("\n");

test("no network and no process: the new modules open no socket, speak no HTTP and spawn nothing; the guest never gets a way to reach a remote", () => {
  const forbidden = ["node:net", "node:http", "node:https", "node:http2", "node:dgram", "node:tls", "node:dns", "node:child_process", "node:worker_threads", "fetch(", "WebSocket", "Bun.connect", "Bun.listen", "Bun.spawn", "Bun.serve", "XMLHttpRequest", "github.com", "posix_spawn", "execve", "fork(", "system("];
  for (const module of NEW_MODULES) {
    const text = codeOnly(REAL.get(module)!);
    for (const needle of forbidden) expect(`${basename(module)}:${needle}:${text.includes(needle)}`).toBe(`${basename(module)}:${needle}:false`);
    for (const needle of [/\b(socket|connect|bind|listen|accept|sendto|recvfrom|getaddrinfo|vsock)\s*:\s*\{/, /\bdlopen\(\s*["'](?!\/usr\/lib\/libSystem\.B\.dylib)/]) expect(`${basename(module)}:${needle}:${needle.test(text)}`).toBe(`${basename(module)}:${needle}:false`);
  }
  // The only imports of the publish modules are types, the repository type, hashing and each other.
  for (const module of PUBLISH) {
    const imports = [...REAL.get(module)!.matchAll(/from "([^"]+)"/g)].map(match => match[1]!).sort();
    expect(imports.every(spec => ["node:crypto", "./types", "./publish-intake", "../repository"].includes(spec))).toBe(true);
  }
});

test("the native symbol table of export-io.ts is pinned exactly: adding connect, a spawn or any other symbol fails here", () => {
  const text = REAL.get(abs("cowork/export-io.ts"))!;
  expect([...text.matchAll(/dlopen\(/g)]).toHaveLength(1);
  for (const module of NEW_MODULES) if (module !== abs("cowork/export-io.ts")) expect(codeOnly(REAL.get(module)!)).not.toMatch(/dlopen|bun:ffi/);
  const block = text.slice(text.indexOf('dlopen("/usr/lib/libSystem.B.dylib", {'), text.indexOf("  });", text.indexOf("dlopen(")));
  const symbols = [...block.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):\s*\{\s*args:/gm)].map(match => match[1]!).sort();
  expect(symbols).toEqual(["__error", "acl_free", "acl_get_file", "acl_to_text", "closedir", "fclonefileat", "fdopendir", "flistxattr", "fremovexattr", "openat", "readdir", "renamex_np"]);
  // Every symbol the module CALLS is in the table.
  const called = [...text.matchAll(/symbols\.([A-Za-z_][A-Za-z0-9_]*)!?\(/g)].map(match => match[1]!);
  for (const name of new Set(called)) expect(symbols).toContain(name);
  // A scanner check on a virtual module: a table with an extra symbol is detected the same way.
  const extra = block.replace("closedir:", "connect: { args: [], returns: 0 },\n    closedir:");
  expect([...extra.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):\s*\{\s*args:/gm)].map(match => match[1]!)).toContain("connect");
});

test("exports and restore touch no credential store and no home outside the workspace's own folder", () => {
  for (const module of EXPORT) {
    const code = codeOnly(REAL.get(module)!);
    for (const needle of [/Bun\.secrets/, /keychain/i, /\.winter(?!workspace)/, /\.claude/, /homedir/, /WINTER_HOME/, /runtime-state\.db/, /credentials/i])
      expect(`${basename(module)}:${needle}:${needle.test(code)}`).toBe(`${basename(module)}:${needle}:false`);
  }
});
