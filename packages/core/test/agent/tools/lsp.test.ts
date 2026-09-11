import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { registerLspTools } from "../../../src/agent/tools/lsp";
import { LspClient } from "../../../src/agent/lsp/client";
import { LspManager } from "../../../src/agent/lsp/manager";

// lsp consolidation T2: the single `lsp` tool (action-routed) replaces lsp_diagnostics/
// lsp_definition/lsp_references. Fence discipline and the 1-based<->0-based position boundary are
// the two things worth pinning hardest here (ported verbatim from the old per-tool suite, just
// through action-form); the new actions (hover/symbols/workspace_symbols/implementation) get their
// own golden-output + NotSupported coverage below.

const FIXTURE = join(import.meta.dir, "../lsp/fake-server.ts");
const FAKE = { command: "bun", args: ["run", FIXTURE] };
const isMac = process.platform === "darwin";

// Same pattern as client.test.ts's own withEnv: spawn() inherits the parent's env synchronously
// at the moment it's called (inside start(), before its first await), so setting/restoring env
// around an async `fn` is safe even though `finally` here runs before `fn`'s promise settles.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-lsp-tools-")));
}

function toFileUri(p: string): string {
  return `file://${encodeURI(p)}`;
}

// ctx.cwd/ctx.roots are DELIBERATELY wrong/unreachable dirs — proves the tool resolves cwd/roots
// via deps.cwdOf/deps.rootsOf(sessionId), never ctx.cwd/ctx.roots (mirrors memory-tools.test.ts's
// own ctx() convention and rationale).
const ctx = (sessionId: string) => ({ cwd: "/not-the-project-dir", roots: ["/nonexistent"], sessionId });

function setup() {
  const root = realDir();
  const outside = realDir(); // sibling dir, NEVER passed as a root — the fence-rejection target
  writeFileSync(join(outside, "secret.ts"), "const leaked = true;\n");
  writeFileSync(join(root, "usage.ts"), "import { target } from \"./target\";\ntarget();\n");
  writeFileSync(
    join(root, "target.ts"),
    "// line 0\n// line 1\n// line 2\nfunction target() {}\n// line 4\n",
  );
  mkdirSync(join(root, ".norma-tmp"), { recursive: true });
  const lsp = new LspManager({ serverCommands: { typescript: FAKE, swift: FAKE } });
  const r = new ToolRegistry();
  registerLspTools(r, { lsp, cwdOf: () => root, rootsOf: () => [root] });
  return { root, outside, lsp, r };
}

describe("lsp tool: pre-spawn guards (fence + language routing + param validation) — cross-platform, no process spawn", () => {
  test("fence rejection: an outside-roots path is a typed error, and clientFor is NEVER called", async () => {
    const { outside, lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp", { action: "diagnostics", file_path: join(outside, "secret.ts") }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("outside the allowed directories");
    expect(spy).not.toHaveBeenCalled();
  });

  test("fence rejection applies to every file_path action — clientFor never called", async () => {
    const { outside, lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    for (const action of ["definition", "references", "hover", "symbols", "implementation"] as const) {
      const args = action === "symbols" ? { action, file_path: join(outside, "secret.ts") } : { action, file_path: join(outside, "secret.ts"), line: 1, character: 1 };
      const out = await r.execute("lsp", args, ctx("s1"));
      expect(out.isError).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test("unsupported extension: a typed error listing supported extensions, BEFORE clientFor", async () => {
    const { root, lsp, r } = setup();
    writeFileSync(join(root, "notes.md"), "hello\n");
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp", { action: "diagnostics", file_path: "notes.md" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("unsupported");
    expect(out.output).toContain(".ts");
    expect(out.output).toContain(".swift");
    expect(spy).not.toHaveBeenCalled();
  });

  test("missing required params -> a clear per-action error naming every required field (no manager touch)", async () => {
    const { lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp", { action: "definition", file_path: "a.ts" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toBe("action 'definition' requires file_path, line, character");
    expect(spy).not.toHaveBeenCalled();
  });

  test("action 'symbols' requires only file_path", async () => {
    const { lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp", { action: "symbols" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toBe("action 'symbols' requires file_path");
    expect(spy).not.toHaveBeenCalled();
  });

  test("action 'workspace_symbols' requires only symbol", async () => {
    const { lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp", { action: "workspace_symbols" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toBe("action 'workspace_symbols' requires symbol");
    expect(spy).not.toHaveBeenCalled();
  });

  test("unknown action -> zod invalid-arguments typed error", async () => {
    const { r } = setup();
    const out = await r.execute("lsp", { action: "call_hierarchy", file_path: "a.ts" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments for lsp");
  });
});

describe.if(isMac)("lsp tool: happy-path formatting + position conversion (real fake-server)", () => {
  test("action 'diagnostics': golden formatting — severities, source, no-source, empty", async () => {
    const { root, lsp, r } = setup();
    try {
      await withEnv({
        NORMA_LSP_FAKE_DIAGS: JSON.stringify([
          { range: { start: { line: 2, character: 4 } }, severity: 1, message: "Cannot find name 'foo'.", source: "tsserver" },
          { range: { start: { line: 5, character: 0 } }, severity: 2, message: "unused variable" },
        ]),
      }, async () => {
        const out = await r.execute("lsp", { action: "diagnostics", file_path: "usage.ts" }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(out.output).toBe(
          "error 3:5 Cannot find name 'foo'. [tsserver]\nwarn 6:1 unused variable",
        );
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'diagnostics': empty publish -> \"no diagnostics\" (not a timeout)", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_DIAGS: "[]" }, async () => {
        const out = await r.execute("lsp", { action: "diagnostics", file_path: "usage.ts" }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "no diagnostics" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'diagnostics': caps at 100 + \"+N more\"", async () => {
    const { lsp, r } = setup();
    try {
      const diags = Array.from({ length: 105 }, (_, i) => ({
        range: { start: { line: i, character: 0 } }, severity: 1, message: `err ${i}`,
      }));
      await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, async () => {
        const out = await r.execute("lsp", { action: "diagnostics", file_path: "usage.ts" }, ctx("s1"));
        expect(out.isError).toBe(false);
        const lines = out.output.split("\n");
        expect(lines).toHaveLength(101); // 100 shown + 1 summary line
        expect(lines[0]).toBe("error 1:1 err 0");
        expect(lines[99]).toBe("error 100:1 err 99");
        expect(lines[100]).toBe("+5 more");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'definition': model 10:5 queries LSP 9:4 (outgoing request pinned) AND the return formats 1-based with a preview", async () => {
    const { root, lsp, r } = setup();
    const defSpy = spyOn(LspClient.prototype, "definition");
    try {
      const targetPath = join(root, "target.ts");
      await withEnv({
        NORMA_LSP_FAKE_DEFINITION: JSON.stringify([
          { uri: toFileUri(targetPath), range: { start: { line: 3, character: 2 } } },
        ]),
      }, async () => {
        const out = await r.execute("lsp", { action: "definition", file_path: "usage.ts", line: 10, character: 5 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(defSpy).toHaveBeenCalledTimes(1);
        const [uriArg, textArg, lineArg, charArg] = defSpy.mock.calls[0]!;
        expect(uriArg).toBe(toFileUri(join(root, "usage.ts")));
        expect(typeof textArg).toBe("string"); // file text — the client opens the doc before querying
        expect(lineArg).toBe(9); // 10 (model, 1-based) - 1
        expect(charArg).toBe(4); // 5 (model, 1-based) - 1
        expect(out.output).toBe(`${targetPath}:4:3  function target() {}`);
      });
    } finally {
      defSpy.mockRestore();
      await lsp.stopAll();
    }
  });

  test("action 'definition': a returned location OUTSIDE the read fence gets no preview (never read off-fence)", async () => {
    const { root, outside, lsp, r } = setup();
    try {
      const offFencePath = join(outside, "secret.ts");
      await withEnv({
        NORMA_LSP_FAKE_DEFINITION: JSON.stringify([{ uri: toFileUri(offFencePath), range: { start: { line: 0, character: 0 } } }]),
      }, async () => {
        const out = await r.execute("lsp", { action: "definition", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(out.output).toBe(`${offFencePath}:1:1`); // location shown, but no preview text leaked
        expect(out.output).not.toContain("leaked");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'definition': caps at 50 + \"+N more\" (parity with diagnostics/references caps)", async () => {
    const { outside, lsp, r } = setup();
    try {
      const offFence = join(outside, "secret.ts");
      const defs = Array.from({ length: 55 }, (_, i) => ({
        uri: toFileUri(offFence), range: { start: { line: i, character: 0 } },
      }));
      await withEnv({ NORMA_LSP_FAKE_DEFINITION: JSON.stringify(defs) }, async () => {
        const out = await r.execute("lsp", { action: "definition", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        const lines = out.output.split("\n");
        expect(lines).toHaveLength(51); // 50 shown + 1 summary line
        expect(lines[0]).toBe(`${offFence}:1:1`);
        expect(lines[49]).toBe(`${offFence}:50:1`);
        expect(lines[50]).toBe("+5 more");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'definition': empty result -> \"no definition found\"", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_DEFINITION: "[]" }, async () => {
        const out = await r.execute("lsp", { action: "definition", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "no definition found" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'references': model 2:1 queries LSP 1:0, golden formatting for a small result", async () => {
    const { root, lsp, r } = setup();
    const refSpy = spyOn(LspClient.prototype, "references");
    try {
      await withEnv({
        NORMA_LSP_FAKE_REFERENCES: JSON.stringify([
          { uri: toFileUri(join(root, "a.ts")), range: { start: { line: 1, character: 0 } } },
          { uri: toFileUri(join(root, "b.ts")), range: { start: { line: 5, character: 3 } } },
        ]),
      }, async () => {
        const out = await r.execute("lsp", { action: "references", file_path: "usage.ts", line: 2, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(refSpy).toHaveBeenCalledTimes(1);
        const [, , lineArg, charArg] = refSpy.mock.calls[0]!; // [uri, text, line, char]
        expect(lineArg).toBe(1);
        expect(charArg).toBe(0);
        expect(out.output).toBe(`${join(root, "a.ts")}:2:1\n${join(root, "b.ts")}:6:4`);
      });
    } finally {
      refSpy.mockRestore();
      await lsp.stopAll();
    }
  });

  test("action 'references': caps at 200 + \"+N more\"", async () => {
    const { root, lsp, r } = setup();
    try {
      const refs = Array.from({ length: 205 }, (_, i) => ({
        uri: toFileUri(join(root, "usage.ts")), range: { start: { line: i, character: 0 } },
      }));
      await withEnv({ NORMA_LSP_FAKE_REFERENCES: JSON.stringify(refs) }, async () => {
        const out = await r.execute("lsp", { action: "references", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        const lines = out.output.split("\n");
        expect(lines).toHaveLength(201); // 200 shown + 1 summary line
        expect(lines[0]).toBe(`${join(root, "usage.ts")}:1:1`);
        expect(lines[199]).toBe(`${join(root, "usage.ts")}:200:1`);
        expect(lines[200]).toBe("+5 more");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'references': empty result -> \"no references found\"", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_REFERENCES: "[]" }, async () => {
        const out = await r.execute("lsp", { action: "references", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "no references found" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'implementation': same location shape/formatting as definition", async () => {
    const { root, lsp, r } = setup();
    try {
      const targetPath = join(root, "target.ts");
      await withEnv({
        NORMA_LSP_FAKE_IMPLEMENTATION: JSON.stringify([{ uri: toFileUri(targetPath), range: { start: { line: 3, character: 2 } } }]),
      }, async () => {
        const out = await r.execute("lsp", { action: "implementation", file_path: "usage.ts", line: 10, character: 5 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(out.output).toBe(`${targetPath}:4:3  function target() {}`);
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'implementation': empty result -> its own \"no implementation found\" sentinel", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_IMPLEMENTATION: "[]" }, async () => {
        const out = await r.execute("lsp", { action: "implementation", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "no implementation found" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'hover': returns the client's rendered contents as-is", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_HOVER: JSON.stringify({ contents: { kind: "markdown", value: "**const** x: number" } }) }, async () => {
        const out = await r.execute("lsp", { action: "hover", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "**const** x: number" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'hover': a server without hover support renders a clean, non-error message", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_UNSUPPORTED: "textDocument/hover" }, async () => {
        const out = await r.execute("lsp", { action: "hover", file_path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(out.output).toContain("hover not supported by");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'symbols': returns the client's rendered document symbols as-is", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({
        NORMA_LSP_FAKE_DOCUMENT_SYMBOLS: JSON.stringify([
          { name: "target", kind: 12, range: { start: { line: 3, character: 0 } }, selectionRange: { start: { line: 3, character: 9 } } },
        ]),
      }, async () => {
        const out = await r.execute("lsp", { action: "symbols", file_path: "usage.ts" }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "Function target — line 4" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'symbols': a server without documentSymbol support renders a clean, non-error message", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_UNSUPPORTED: "textDocument/documentSymbol" }, async () => {
        const out = await r.execute("lsp", { action: "symbols", file_path: "usage.ts" }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(out.output).toContain("document symbols not supported by");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'workspace_symbols': routes off cwd (no file_path needed) and returns the client's rendered result", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({
        NORMA_LSP_FAKE_WORKSPACE_SYMBOLS: JSON.stringify([
          { name: "target", kind: 12, location: { uri: "file:///workspace/target.ts", range: { start: { line: 3, character: 9 } } } },
        ]),
      }, async () => {
        const out = await r.execute("lsp", { action: "workspace_symbols", symbol: "target" }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "Function target — /workspace/target.ts:4:10" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'workspace_symbols': a swift-project marker (Package.swift) routes clientFor to the swift language", async () => {
    const { root, lsp, r } = setup();
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version:5.9\n");
    const spy = spyOn(lsp, "clientFor");
    try {
      await withEnv({ NORMA_LSP_FAKE_WORKSPACE_SYMBOLS: "[]" }, async () => {
        await r.execute("lsp", { action: "workspace_symbols", symbol: "x" }, ctx("s1"));
      });
      expect(spy).toHaveBeenCalledWith(root, "swift");
    } finally {
      await lsp.stopAll();
    }
  });

  test("action 'workspace_symbols': no swift marker defaults clientFor to the typescript language", async () => {
    const { root, lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    try {
      await withEnv({ NORMA_LSP_FAKE_WORKSPACE_SYMBOLS: "[]" }, async () => {
        await r.execute("lsp", { action: "workspace_symbols", symbol: "x" }, ctx("s1"));
      });
      expect(spy).toHaveBeenCalledWith(root, "typescript");
    } finally {
      await lsp.stopAll();
    }
  });
});
