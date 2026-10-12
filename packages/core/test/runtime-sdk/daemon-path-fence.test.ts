import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDaemonPathAccess, readDaemonTextFile, daemonChildSpawnWithFloor } from "../../src/runtime-sdk/daemon-path-fence";
import { registerHostStorageFences } from "../../src/runtime-sdk/host-storage-fence";
import { lspToolDefs } from "../../src/agent/tools/lsp";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { LspManager } from "../../src/agent/lsp/manager";
import { officeCapability } from "../../src/capabilities/office";
import { checkUploadFiles, stageUploads } from "../../src/computer-use/browser/upload-paths";
import { autoDiagnosticsSuffix } from "../../src/agent/lsp/auto-diagnostics";
import { sessionHooksFor } from "../../src/runtime-sdk/hooks";
import { takeFileDiff } from "../../src/runtime-sdk/diff-attach";

describe("Core protected storage checks at actual host use points", () => {
  let root: string, home: string, other: string, coordination: string, volume: string, db: string, project: string, unregister: () => void;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "winter-daemon-path-fence-")));
    home = join(root, "home"); other = join(root, "other"); coordination = join(root, "coordination"); project = join(root, "project");
    for (const dir of [join(home, "cowork"), join(other, "cowork/workspaces/w/shared"), join(other, "runtimes"), coordination, project]) mkdirSync(dir, { recursive: true });
    volume = join(other, "cowork/workspaces/w/data.ext4"); db = join(other, "runtimes/runtime-state.db");
    for (const path of [volume, db, join(coordination, "cowork-admission.sqlite")]) writeFileSync(path, "private fixture bytes");
    unregister = registerHostStorageFences(home, { participatingHomes: [other], coordinationDir: coordination, coworkStorageActive: true });
  });
  afterEach(() => unregister());
  test("direct paths, parent symlinks, hard links and case variants use one canonical fence; ordinary/shared reads work", () => {
    symlinkSync(other, join(project, "alias")); linkSync(volume, join(project, "volume.ts"));
    for (const path of [volume, db, join(coordination, "cowork-admission.sqlite"), join(project, "alias/runtimes/runtime-state.db"), join(project, "volume.ts"), volume.toUpperCase()]) {
      expect(() => assertDaemonPathAccess(home, path, project)).toThrow("protected Winter storage");
    }
    const ordinary = join(project, "ordinary.ts"), shared = join(other, "cowork/workspaces/w/shared/output.md");
    writeFileSync(ordinary, "ordinary"); writeFileSync(shared, "shared");
    symlinkSync(ordinary, join(project, "ordinary-link.ts"));
    expect(readDaemonTextFile(home, join(project, "ordinary-link.ts"))).toBe("ordinary");
    expect(readDaemonTextFile(home, ordinary)).toBe("ordinary"); expect(readDaemonTextFile(home, shared)).toBe("shared");
    expect(() => assertDaemonPathAccess(home, shared, project, "write")).toThrow();
  });
  test("LSP refuses protected input before server contact and omits protected returned previews", async () => {
    const manager = new LspManager(), call = spyOn(manager, "clientFor"), registry = new ToolRegistry();
    for (const def of lspToolDefs({ home, lsp: manager, cwdOf: () => project, rootsOf: () => [project, root] })) registry.register(def);
    linkSync(db, join(project, "private.ts"));
    const ctx = { sessionId: "s", cwd: project, roots: [root] };
    expect((await registry.execute("lsp", { action: "diagnostics", file_path: "private.ts" }, ctx)).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    const source = join(project, "source.ts"); writeFileSync(source, "const ordinary = 1;");
    call.mockResolvedValue({ definition: async () => [{ path: join(project, "private.ts"), line: 0, character: 0 }] } as never);
    const out = await registry.execute("lsp", { action: "definition", file_path: source, line: 1, character: 1 }, ctx);
    expect(out.isError).toBeFalsy(); expect(out.output).not.toContain("private fixture bytes"); expect(out.output).toContain("private.ts:1:1");
    call.mockRestore();
  });
  test("all office kinds reject aliases before dispatch; ordinary documents dispatch", async () => {
    const dispatched: unknown[] = [];
    const instance = officeCapability({ sessionId: "s", mode: "code", cwd: project, roots: [root] }, { office: {
      home, dirsOf: () => [{ path: root, locked: true }], harnesses: () => [{ clientName: "orb", role: "harness" }],
      dispatch: cmd => { dispatched.push(cmd); return { commandId: "pcmd", settled: Promise.resolve({ kind: "result", ok: true, result: "ok" }) }; },
    } }).instance as { callTool(name: string, args: unknown): Promise<{ isError?: boolean }> };
    for (const name of ["docs", "sheets", "slides"]) {
      const alias = join(project, `${name}.docx`); linkSync(volume, alias);
      expect((await instance.callTool(name, { verb: "info", path: alias })).isError).toBe(true);
    }
    expect(dispatched).toHaveLength(0);
    const path = join(project, "ordinary.docx"); writeFileSync(path, "fixture");
    expect((await instance.callTool("docs", { verb: "info", path })).isError).toBeFalsy(); expect(dispatched).toHaveLength(1);
  });
  test("uploads refuse other-home aliases with broad cwd and no read-deny list, then recheck at source copy", () => {
    linkSync(volume, join(project, "upload.bin"));
    expect(() => checkUploadFiles("upload.bin", { home, cwd: project, denyRead: [] })).toThrow("Protected Winter storage");
    const path = join(project, "ordinary.txt"); writeFileSync(path, "ordinary");
    const checked = checkUploadFiles(path, { home, cwd: root, denyRead: [] });
    linkSync(path, join(other, "cowork/workspaces/w/env.ext4"));
    expect(() => stageUploads(checked, home, "s")).toThrow();
  });
  test("auto-diagnostics and diff bookkeeping do not expose protected content", async () => {
    const path = join(project, "private.ts"); linkSync(db, path);
    const manager = new LspManager(), call = spyOn(manager, "clientFor");
    expect(await autoDiagnosticsSuffix({ home, lsp: manager, cwd: project, roots: [root], toolName: "Edit", toolInput: { file_path: path } })).toBe("");
    expect(call).not.toHaveBeenCalled(); call.mockRestore();
    const hooks = sessionHooksFor({ home, sessionId: "s", roots: [root], cwd: project }).winter!;
    const input = { session_id: "s", transcript_path: "", cwd: project, tool_name: "Edit", tool_input: { file_path: path }, tool_use_id: "private", hook_event_name: "PreToolUse" };
    for (const group of hooks.PreToolUse ?? []) if (group.matcher === "Edit") for (const hook of group.hooks) await hook(input as never, "private", { signal: new AbortController().signal });
    writeFileSync(db, "updated private fixture bytes");
    for (const group of hooks.PostToolUse ?? []) if (group.matcher === "Edit") for (const hook of group.hooks) await hook({ ...input, hook_event_name: "PostToolUse", tool_response: "ok" } as never, "private", { signal: new AbortController().signal });
    expect(takeFileDiff("s", "private")).toBeUndefined();
  });
  test("active child floors have no unprotected fallback when SDK capability is unavailable", () => {
    const options = { command: "/bin/sh", args: ["-c", "true"], cwd: project, env: {} };
    try { expect(daemonChildSpawnWithFloor(home, options).command).toBe("/usr/bin/sandbox-exec"); }
    catch (error) { expect(String(error)).toContain("floor unavailable"); }
  });
});
