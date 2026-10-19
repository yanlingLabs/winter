// Anti-wiring pins for the content-out lane (the feature-branch publish service, the `.winterworkspace` writer and the restore
// flow). They replace the older "unwired" statement honestly: these modules are now WIRED, but only behind ports production
// never supplies, and only reachable from code that already sits behind the Cowork refusal. Each pin states what is true and
// would turn red the moment someone makes it false.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { METHODS } from "@yanlinglabs/winter-protocol";
import { createCoworkPublishService } from "../../src/cowork/git/publish-service";
import { GitPublicationError } from "../../src/cowork/git/types";

const packages = join(import.meta.dir, "..", "..", "..");
const srcRoot = join(packages, "core", "src");
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
const allSources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
const rel = (file: string) => relative(srcRoot, file);
const PUBLISH = ["cowork/git/publish-service.ts", "cowork/git/publish-intake.ts"];
const EXPORT = ["cowork/export-writer.ts", "cowork/restore-bundle.ts", "cowork/export-bundle.ts", "cowork/export-io.ts"];
const NEW_MODULES = [...PUBLISH, ...EXPORT];
/** The only src files allowed to name each new module: the lane's own modules. */
const ALLOWED_IMPORTERS: Record<string, string[]> = {
  "publish-service": ["cowork/git/publish-service.ts"],
  "publish-intake": ["cowork/git/publish-service.ts", "cowork/git/publish-intake.ts"],
  "export-writer": ["cowork/export-writer.ts"],
  "restore-bundle": ["cowork/restore-bundle.ts"],
  "export-bundle": ["cowork/export-bundle.ts", "cowork/export-writer.ts", "cowork/restore-bundle.ts"],
  "export-io": ["cowork/export-io.ts", "cowork/export-bundle.ts", "cowork/export-writer.ts", "cowork/restore-bundle.ts"],
};

test("every new module exists, and sources are found in every package (the scans below are not vacuous)", () => {
  expect(allSources.length).toBeGreaterThan(100);
  for (const module of NEW_MODULES) expect(existsSync(join(srcRoot, module))).toBe(true);
});

test("wired behind a port: no src file outside the lane's own modules names a new module, so the daemon, the IPC server and every session door never build them", () => {
  for (const file of allSources) {
    const text = readFileSync(file, "utf8"), name = rel(file);
    for (const [module, allowed] of Object.entries(ALLOWED_IMPORTERS)) {
      if (allowed.includes(name)) continue;
      expect(`${name}:${module}:${new RegExp(`["'/]${module}["']`).test(text)}`).toBe(`${name}:${module}:false`);
    }
    for (const symbol of ["createCoworkPublishService", "CoworkWorkspaceExporter", "CoworkWorkspaceRestorer", "CoworkPublishPorts", "CoworkExportImageDoor", "CoworkRestoreApproval", "CoworkRestoreIdentityPort"]) {
      if (NEW_MODULES.includes(name)) continue;
      expect(`${name}:${symbol}:${text.includes(symbol)}`).toBe(`${name}:${symbol}:false`);
    }
  }
});

test("the publication broker, journal, authority and executor are still constructed by no src file: production cannot assemble a publish service", () => {
  const own = ["cowork/git/broker.ts", "cowork/git/journal.ts", "cowork/git/authority.ts", "cowork/git/executor.ts", "cowork/git/publish-service.ts", "cowork/git/publish-intake.ts"];
  for (const file of allSources) {
    const name = rel(file), text = readFileSync(file, "utf8");
    if (own.includes(name) || name.startsWith("cowork/git/")) continue;
    for (const symbol of ["CoworkGitPublicationBroker", "CanonicalPublicationJournal", "CurrentCoworkPublicationAuthority", "IsolatedGitExecutor", "resolveGitExecutable", "checkPackBudget"]) expect(`${name}:${symbol}:${text.includes(symbol)}`).toBe(`${name}:${symbol}:false`);
  }
  // The broker still refuses outside an isolated fixture, unchanged by the service.
  const broker = readFileSync(join(srcRoot, "cowork/git/broker.ts"), "utf8");
  expect(broker).toContain('if (!this.options.isolatedFixture) deny("integration_unavailable");');
  expect(broker).toContain('availability(): { available: false; reason: "host_auth_and_service_integration_required" }');
});

test("the service built the way production would build it refuses every verb", async () => {
  const service = createCoworkPublishService(undefined);
  expect(service.availability()).toEqual({ available: false, reason: "publication_ports_absent" });
  const caller = { principalId: "u", sessionId: "s", taskId: "t" };
  await expect(service.publish(caller, { requestId: "r", sourceId: "x", ref: "refs/heads/f", oldOid: null, newOid: "a".repeat(40) })).rejects.toBeInstanceOf(GitPublicationError);
  expect(() => service.status(caller, "r")).toThrow(GitPublicationError);
});

test("the Cowork refusal is untouched: no RPC method, protocol name or session door names publish, export or restore, and the creation door is not built here", () => {
  for (const name of Object.values(METHODS as Record<string, string>)) expect(`${name}:${/publish|winterworkspace|workspace\.export|workspace\.restore|bundle/i.test(name)}`).toBe(`${name}:false`);
  for (const file of [join(srcRoot, "ipc/server.ts"), join(srcRoot, "daemon.ts"), join(srcRoot, "sessions/session-mode.ts"), join(srcRoot, "cowork/service.ts"), join(srcRoot, "cowork/session-ports.ts")]) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["publish-service", "export-writer", "restore-bundle", "winterworkspace", "createCoworkPublishService"]) expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
  for (const module of NEW_MODULES) {
    const text = readFileSync(join(srcRoot, module), "utf8");
    // No door, no new error code, no setting, no environment switch.
    for (const needle of ["coworkSessions", "CoworkSessionDoor", "CoworkError(", "process.env", "Bun.env", "settings."]) expect(`${module}:${needle}:${text.includes(needle)}`).toBe(`${module}:${needle}:false`);
  }
});

test("no network and no process: the new modules open no socket, speak no HTTP and spawn nothing; the guest never gets a way to reach a remote", () => {
  const forbidden = ["node:net", "node:http", "node:https", "node:http2", "node:dgram", "node:tls", "node:dns", "node:child_process", "node:worker_threads", "fetch(", "WebSocket", "Bun.connect", "Bun.listen", "Bun.spawn", "Bun.serve", "XMLHttpRequest", "origin ", "github.com"];
  for (const module of NEW_MODULES) {
    const text = readFileSync(join(srcRoot, module), "utf8").split("\n").filter(line => !/^\s*(\/\*|\*|\/\/)/.test(line)).join("\n");
    for (const needle of forbidden) expect(`${module}:${needle}:${text.includes(needle)}`).toBe(`${module}:${needle}:false`);
  }
  // The only imports of the publish modules are types, the repository type, hashing and each other.
  for (const module of PUBLISH) {
    const imports = [...readFileSync(join(srcRoot, module), "utf8").matchAll(/from "([^"]+)"/g)].map(match => match[1]!).sort();
    expect(imports.every(spec => ["node:crypto", "./types", "./publish-intake", "../repository"].includes(spec))).toBe(true);
  }
});

test("exports and restore touch no credential store and no home outside the workspace's own folder", () => {
  for (const module of EXPORT) {
    const text = readFileSync(join(srcRoot, module), "utf8");
    // The words may appear in comments that describe what is excluded; code lines may not. `.winterworkspace` is the bundle suffix.
    const code = text.split("\n").filter(line => !/^\s*(\/\*|\*|\/\/)/.test(line)).map(line => line.replace(/\/\/.*$/, "")).join("\n");
    for (const needle of [/Bun\.secrets/, /keychain/i, /\.winter(?!workspace)/, /\.claude/, /homedir/, /WINTER_HOME/, /runtime-state\.db/, /credentials/i])
      expect(`${module}:${needle}:${needle.test(code)}`).toBe(`${module}:${needle}:false`);
  }
});
