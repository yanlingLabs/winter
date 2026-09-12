import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { LspClient, LspTimeoutError, LspServerExitedError, LspNotSupportedError, LspRequestError } from "../../../src/agent/lsp/client";

const FIXTURE = join(import.meta.dir, "fake-server.ts");
const isMac = process.platform === "darwin";
const ROOT_URI = "file:///workspace";

// `env` isn't part of the constructor's public cfg, so tests that need scenario env vars set
// process.env before spawning and restore it after — spawn() inherits the parent's env.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe.if(isMac)("LspClient", () => {
  test("handshake completes: start() resolves and client is alive", async () => {
    const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
    await c.start();
    expect(c.alive).toBe(true);
    await c.stop();
  });

  test("start() rejects on a typed timeout when the server never responds", async () => {
    const c = new LspClient({ command: "sleep", args: ["30"], rootUri: ROOT_URI, startTimeoutMs: 200 });
    await expect(c.start()).rejects.toThrow(LspTimeoutError);
    await c.stop(); // the child never responds to shutdown either; stop()'s own SIGKILL fallback covers this
  }, 8000);

  test("diagnostics(): non-empty publish resolves with the canned diagnostics", async () => {
    await withEnv({ WINTER_LSP_FAKE_DIAGS: JSON.stringify([
      { range: { start: { line: 3, character: 1 }, end: { line: 3, character: 5 } }, severity: 2, message: "unused var", source: "fake-lsp" },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 50 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/a.ts", "const x = 1;", 2000);
      expect(diags).toEqual([{ line: 3, character: 1, severity: 2, message: "unused var", source: "fake-lsp" }]);
      await c.stop();
    });
  });

  test("diagnostics(): an empty publish resolves to [] — a valid answer, not a timeout", async () => {
    await withEnv({ WINTER_LSP_FAKE_DIAGS: "[]" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 50 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/clean.ts", "const y = 1;", 2000);
      expect(diags).toEqual([]);
      await c.stop();
    });
  });

  test("diagnostics(): staged publishes (empty syntactic pass, then the semantic pass) resolve with the SETTLED result, not the first publish", async () => {
    // Real tsserver shape: a fast (often empty) syntactic publish lands first; the semantic pass
    // follows ~100ms later as a SECOND publish for the same uri. Resolve-on-first-publish returns
    // "no diagnostics" for a file whose only problem is a TYPE error — the exact live failure this
    // settle window exists to prevent.
    await withEnv({ WINTER_LSP_FAKE_STAGED_DIAGS: "1", WINTER_LSP_FAKE_DIAGS: JSON.stringify([
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: "fake-lsp" },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 250 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/typed.ts", "const n: number = \"s\";", 3000);
      expect(diags).toEqual([{ line: 0, character: 6, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: "fake-lsp" }]);
      await c.stop();
    });
  });

  test("diagnostics(): the overall deadline returns the LATEST publish when the settle window can't elapse in time", async () => {
    // settle window (5s) deliberately larger than the overall timeout (600ms): both staged
    // publishes land (~0ms and ~100ms), the settle timer never gets to fire, and the deadline
    // must resolve with the latest data rather than throwing — data beats a timeout error.
    await withEnv({ WINTER_LSP_FAKE_STAGED_DIAGS: "1", WINTER_LSP_FAKE_DIAGS: JSON.stringify([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, severity: 1, message: "late but real", source: "fake-lsp" },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 5000 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/churn.ts", "x", 600);
      expect(diags).toEqual([{ line: 1, character: 0, severity: 1, message: "late but real", source: "fake-lsp" }]);
      await c.stop();
    });
  });

  test("diagnostics(): no publish ever arrives → rejects with a typed timeout", async () => {
    await withEnv({ WINTER_LSP_FAKE_NO_DIAGNOSTICS: "1" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.diagnostics("file:///workspace/silent.ts", "x", 150)).rejects.toThrow(LspTimeoutError);
      await c.stop();
    });
  });

  test("definition(): round-trips the canned location, 0-based through", async () => {
    await withEnv({ WINTER_LSP_FAKE_DEFINITION: JSON.stringify([
      { uri: "file:///workspace/def.ts", range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } } },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const locs = await c.definition("file:///workspace/a.ts", "const x = 1;", 4, 6);
      expect(locs).toEqual([{ path: "/workspace/def.ts", line: 9, character: 2 }]);
      await c.stop();
    });
  });

  test("references(): round-trips the canned locations", async () => {
    await withEnv({ WINTER_LSP_FAKE_REFERENCES: JSON.stringify([
      { uri: "file:///workspace/a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      { uri: "file:///workspace/b.ts", range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const locs = await c.references("file:///workspace/a.ts", "const x = 1;", 1, 0);
      expect(locs).toEqual([
        { path: "/workspace/a.ts", line: 1, character: 0 },
        { path: "/workspace/b.ts", line: 5, character: 3 },
      ]);
      await c.stop();
    });
  });

  test("definition()/references(): the target document is didOpen'd before the query — a server that only answers for open docs still resolves", async () => {
    // Real servers (tsserver, sourcekit-lsp) return null for a position query on a document they
    // were never handed. The old code never opened the doc for definition/references, so this
    // returned nothing live even though the fake server (which answered regardless) stayed green.
    await withEnv({
      WINTER_LSP_FAKE_REQUIRE_OPEN: "1",
      WINTER_LSP_FAKE_DEFINITION: JSON.stringify([{ uri: "file:///workspace/target.ts", range: { start: { line: 7, character: 0 }, end: { line: 7, character: 4 } } }]),
      WINTER_LSP_FAKE_REFERENCES: JSON.stringify([{ uri: "file:///workspace/ref.ts", range: { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } } }]),
    }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 100 });
      await c.start();
      const def = await c.definition("file:///workspace/src.ts", "const y = 1;", 0, 6);
      expect(def).toEqual([{ path: "/workspace/target.ts", line: 7, character: 0 }]);
      const refs = await c.references("file:///workspace/src2.ts", "const z = 2;", 0, 6);
      expect(refs).toEqual([{ path: "/workspace/ref.ts", line: 2, character: 1 }]);
      await c.stop();
    });
  });

  test("split-write: a response body split across two stdout writes reassembles correctly", async () => {
    await withEnv({ WINTER_LSP_FAKE_SPLIT: "1" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const locs = await c.definition("file:///workspace/a.ts", "x", 0, 0);
      expect(locs).toEqual([{ path: "/workspace/def.ts", line: 9, character: 2 }]);
      await c.stop();
    });
  });

  test("merged frames: two complete frames delivered in one chunk both dispatch", async () => {
    await withEnv({ WINTER_LSP_FAKE_MERGE: "1" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 50 });
      await c.start();
      // Prime the doc first so both position queries skip the ensure-open gate and issue their
      // requests in order (definition then references) — the ordering the fake's merge relies on.
      await c.diagnostics("file:///workspace/a.ts", "x", 2000);
      // The fake server holds the definition response until references arrives, then writes
      // BOTH frames concatenated in a single stdout.write() — both promises must still resolve.
      const [defs, refs] = await Promise.all([
        c.definition("file:///workspace/a.ts", "x", 0, 0),
        c.references("file:///workspace/a.ts", "x", 1, 0),
      ]);
      expect(defs).toEqual([{ path: "/workspace/def.ts", line: 9, character: 2 }]);
      expect(refs).toEqual([
        { path: "/workspace/a.ts", line: 1, character: 0 },
        { path: "/workspace/b.ts", line: 5, character: 3 },
      ]);
      await c.stop();
    });
  });

  test("server death mid-request rejects the pending request with a typed error", async () => {
    await withEnv({ WINTER_LSP_FAKE_DIE_ON: "textDocument/definition" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.definition("file:///workspace/a.ts", "x", 0, 0)).rejects.toThrow(LspServerExitedError);
      expect(c.alive).toBe(false);
      await c.stop(); // must not hang/throw even though the child is already gone
    });
  });

  test("stop(): clean shutdown resolves and marks the client dead", async () => {
    const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
    await c.start();
    expect(c.alive).toBe(true);
    await c.stop();
    expect(c.alive).toBe(false);
  });

  // --- lsp consolidation T1: hover/documentSymbols/workspaceSymbols/implementation -------------

  test("hover(): MarkupContent {kind,value} renders its value", async () => {
    await withEnv({ WINTER_LSP_FAKE_HOVER: JSON.stringify({ contents: { kind: "markdown", value: "**const** x: number" } }) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.hover("file:///workspace/a.ts", "const x = 1;", 0, 6);
      expect(out).toBe("**const** x: number");
      await c.stop();
    });
  });

  test("hover(): a bare string `contents` renders as-is", async () => {
    await withEnv({ WINTER_LSP_FAKE_HOVER: JSON.stringify({ contents: "plain string hover" }) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.hover("file:///workspace/a.ts", "const x = 1;", 0, 6);
      expect(out).toBe("plain string hover");
      await c.stop();
    });
  });

  test("hover(): an array of MarkedString (string + {language,value}) joins them", async () => {
    await withEnv({ WINTER_LSP_FAKE_HOVER: JSON.stringify({ contents: ["line one", { language: "ts", value: "const x: number" }] }) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.hover("file:///workspace/a.ts", "const x = 1;", 0, 6);
      expect(out).toBe("line one\nconst x: number");
      await c.stop();
    });
  });

  test("hover(): a null result renders \"no hover info\"", async () => {
    await withEnv({ WINTER_LSP_FAKE_HOVER: "null" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.hover("file:///workspace/a.ts", "const x = 1;", 0, 6);
      expect(out).toBe("no hover info");
      await c.stop();
    });
  });

  test("hover(): a server answering -32601 (method not found) rejects with LspNotSupportedError", async () => {
    await withEnv({ WINTER_LSP_FAKE_UNSUPPORTED: "textDocument/hover" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.hover("file:///workspace/a.ts", "const x = 1;", 0, 6)).rejects.toThrow(LspNotSupportedError);
      await c.stop();
    });
  });

  test("hover(): a DIFFERENT RPC error code (-32000) propagates as a plain LspRequestError, NOT LspNotSupportedError — only -32601 means 'unsupported'", async () => {
    await withEnv({ WINTER_LSP_FAKE_RPC_ERROR: "textDocument/hover:-32000" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const err = await c.hover("file:///workspace/a.ts", "const x = 1;", 0, 6).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(LspRequestError);
      expect(err).not.toBeInstanceOf(LspNotSupportedError);
      expect((err as LspRequestError).code).toBe(-32000);
      await c.stop();
    });
  });

  test("hover(): rides ensureParsed — the target document is opened/parsed before the query", async () => {
    await withEnv({ WINTER_LSP_FAKE_HOVER: JSON.stringify({ contents: "opened ok" }) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 100 });
      await c.start();
      // `ensureParsed` is private; spyOn works against the instance regardless (TS privacy is
      // compile-time only) — this pins that hover() actually rides it (like definition/references
      // do), not that the fake server enforces it (WINTER_LSP_FAKE_REQUIRE_OPEN only gates the
      // definition/references/implementation cases below).
      const spy = spyOn(c as unknown as { ensureParsed: () => Promise<void> }, "ensureParsed");
      const out = await c.hover("file:///workspace/a.ts", "const x = 1;", 0, 6);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(out).toBe("opened ok");
      await c.stop();
    });
  });

  test("documentSymbols(): flat SymbolInformation[] renders name/kind/line", async () => {
    await withEnv({
      WINTER_LSP_FAKE_DOCUMENT_SYMBOLS: JSON.stringify([
        { name: "Foo", kind: 5, location: { uri: "file:///workspace/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
        { name: "bar", kind: 12, location: { uri: "file:///workspace/a.ts", range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } } } },
      ]),
    }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.documentSymbols("file:///workspace/a.ts", "class Foo {}\n");
      expect(out).toBe("Class Foo — line 1\nFunction bar — line 5");
      await c.stop();
    });
  });

  test("documentSymbols(): hierarchical DocumentSymbol[] renders children indented under their parent", async () => {
    await withEnv({
      WINTER_LSP_FAKE_DOCUMENT_SYMBOLS: JSON.stringify([
        {
          name: "Foo", kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          children: [
            { name: "bar", kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 20 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } },
          ],
        },
      ]),
    }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.documentSymbols("file:///workspace/a.ts", "class Foo {\n  bar() {}\n}\n");
      expect(out).toBe("Class Foo — line 1\n  Method bar — line 2");
      await c.stop();
    });
  });

  test("documentSymbols(): empty array renders \"no symbols found\"", async () => {
    await withEnv({ WINTER_LSP_FAKE_DOCUMENT_SYMBOLS: "[]" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.documentSymbols("file:///workspace/a.ts", "");
      expect(out).toBe("no symbols found");
      await c.stop();
    });
  });

  test("documentSymbols(): -32601 rejects with LspNotSupportedError", async () => {
    await withEnv({ WINTER_LSP_FAKE_UNSUPPORTED: "textDocument/documentSymbol" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.documentSymbols("file:///workspace/a.ts", "")).rejects.toThrow(LspNotSupportedError);
      await c.stop();
    });
  });

  test("workspaceSymbols(): renders name/kind/path:line:character across the workspace, no didOpen required", async () => {
    await withEnv({
      WINTER_LSP_FAKE_WORKSPACE_SYMBOLS: JSON.stringify([
        { name: "target", kind: 12, location: { uri: "file:///workspace/target.ts", range: { start: { line: 3, character: 9 } } } },
      ]),
    }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const spy = spyOn(c as unknown as { ensureParsed: () => Promise<void> }, "ensureParsed");
      const out = await c.workspaceSymbols("target");
      expect(spy).not.toHaveBeenCalled(); // workspace/symbol is project-wide — no per-file didOpen gate
      expect(out).toBe("Function target — /workspace/target.ts:4:10");
      await c.stop();
    });
  });

  test("workspaceSymbols(): empty array renders \"no symbols found\"", async () => {
    await withEnv({ WINTER_LSP_FAKE_WORKSPACE_SYMBOLS: "[]" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const out = await c.workspaceSymbols("nothing");
      expect(out).toBe("no symbols found");
      await c.stop();
    });
  });

  test("workspaceSymbols(): -32601 rejects with LspNotSupportedError", async () => {
    await withEnv({ WINTER_LSP_FAKE_UNSUPPORTED: "workspace/symbol" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.workspaceSymbols("target")).rejects.toThrow(LspNotSupportedError);
      await c.stop();
    });
  });

  test("implementation(): round-trips the canned location, 0-based through (same shape as definition)", async () => {
    await withEnv({ WINTER_LSP_FAKE_IMPLEMENTATION: JSON.stringify([
      { uri: "file:///workspace/impl.ts", range: { start: { line: 14, character: 2 }, end: { line: 14, character: 8 } } },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const locs = await c.implementation("file:///workspace/a.ts", "const x = 1;", 4, 6);
      expect(locs).toEqual([{ path: "/workspace/impl.ts", line: 14, character: 2 }]);
      await c.stop();
    });
  });

  test("implementation(): rides ensureParsed — a server that only answers for open docs still resolves", async () => {
    await withEnv({
      WINTER_LSP_FAKE_REQUIRE_OPEN: "1",
      WINTER_LSP_FAKE_IMPLEMENTATION: JSON.stringify([{ uri: "file:///workspace/target.ts", range: { start: { line: 7, character: 0 } } }]),
    }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 100 });
      await c.start();
      const impl = await c.implementation("file:///workspace/src.ts", "const y = 1;", 0, 6);
      expect(impl).toEqual([{ path: "/workspace/target.ts", line: 7, character: 0 }]);
      await c.stop();
    });
  });

  test("implementation(): -32601 rejects with LspNotSupportedError", async () => {
    await withEnv({ WINTER_LSP_FAKE_UNSUPPORTED: "textDocument/implementation" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.implementation("file:///workspace/a.ts", "x", 0, 0)).rejects.toThrow(LspNotSupportedError);
      await c.stop();
    });
  });
});
