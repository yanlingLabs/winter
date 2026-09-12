import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import type { ToolDefinition, ToolRegistry } from "./registry";
import { resolveWithinAny } from "../paths";
import { LspManager, languageForPath, type LspLanguage } from "../lsp/manager";
import { LspNotSupportedError, type LspDiagnostic, type LspLocation } from "../lsp/client";

/**
 * `lsp` (lsp-consolidation T2, design doc `2026-07-15-lsp-consolidation-design.md`) — ONE tool
 * replacing the phase-5f three (lsp_diagnostics/lsp_definition/lsp_references), CC-parity: a
 * single fixed `LSP` tool whose `action` picks the operation. Adds four actions the three old
 * tools never exposed — hover/symbols/workspace_symbols/implementation — over T1's new LspClient
 * methods, while definition/references/diagnostics stay BYTE-EQUIVALENT to their old per-tool
 * output (same caps, same "no X found" sentinels, same fence/preview behavior).
 *
 * `cwdOf`/`rootsOf`/`tmpDirOf` are deps closures, NOT `ctx.cwd`/`ctx.roots` — same rationale as
 * memory.ts's `cwdOf`: they resolve the SESSION's real cwd/roots (daemon.ts wires them from
 * `store.meta(sid).cwd`/`sessionDirs.roots(sid)`/`sessionTmpDir(sid)`), which for an isolated
 * worktree child can diverge from `ctx.cwd`/`ctx.roots` (the CURRENT THREAD's).
 *
 * FENCE DISCIPLINE (the security lens for this file, unchanged from the three-tool era): every
 * file_path-based action resolves `file_path` against the session's read roots via
 * `resolveWithinAny` BEFORE anything else touches the manager — in particular before `clientFor`
 * (a test spies the manager and asserts zero `clientFor` calls on a fence rejection or a missing-
 * required-param error). Language routing (`languageForPath`) runs second, after the fence check,
 * so both guards are provably ahead of any manager interaction. `workspace_symbols` takes no
 * `file_path` (workspace/symbol is project-wide, not per-file) so there is nothing to fence there
 * — it always operates over the session's own trusted cwd.
 *
 * That same fence is re-applied to `definition`/`implementation`'s returned locations before
 * reading a disk preview (see `formatDefinition` below): a location the language server reports
 * OUTSIDE the session's roots still gets listed (path:line:col), but never previewed. Without
 * this, a compromised or buggy language server could return an arbitrary absolute path (e.g.
 * "/etc/passwd") and turn this tool into a read-any-file oracle that bypasses the exact fence its
 * own `file_path` arg is held to.
 *
 * POSITION CONVENTION (the other binding constraint): `line`/`character` args are 1-based (the
 * model/human editor convention — stated in the tool's own description); LspClient's
 * structured-data methods (definition/references/implementation/diagnostics) are 0-based
 * throughout (client.ts's own doc comment) — subtract 1 before calling the client, add 1 back
 * when formatting a returned location. hover/symbols/workspace_symbols instead return an
 * ALREADY-RENDERED, 1-based string straight from the client (see client.ts's own T1 doc comment
 * on that split) — this file passes that string through untouched.
 *
 * CAPABILITY DETECTION: hover/symbols/workspace_symbols/implementation ride T1's
 * `LspNotSupportedError` (thrown by the client on a JSON-RPC -32601 "method not found" — the
 * standard signal for an optional LSP capability the server never registered). This file catches
 * exactly that type and returns its message as a normal, non-error result (`withNotSupported`
 * below) — the same "clean sentinel, not a crash" posture as "no definition found"/"no
 * diagnostics" for an empty-but-successful answer. Every OTHER thrown error (timeout, a genuine
 * RPC error, server death) is NOT caught here — it propagates to the registry's ordinary
 * isError:true path, same as it always has for definition/references/diagnostics.
 *
 * CALLER CONTRACT (T2's own docstring on `clientFor`): the idle-reap timer rearms on `clientFor`
 * itself, not on each query — so every action calls `clientFor` fresh, immediately before its
 * query, rather than caching a client across a call boundary.
 */

// EXTENSION_LANGUAGE's key set (agent/lsp/manager.ts) is not exported — this is a small,
// display-only duplicate so the "unsupported extension" error can name them. Keep in sync with
// that map if a language is ever added there.
const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".swift"];

const DIAGNOSTICS_CAP = 100;
const REFERENCES_CAP = 200;
// Definitions (and implementations, which share this formatter) are capped lower than references
// (50 vs 200) because each shown location does a fenced readFileSync for its one-line preview — an
// unbounded pathological server returning many locations would otherwise force one disk read
// apiece. Parity with the diagnostics/references caps.
const DEFINITIONS_CAP = 50;
const PREVIEW_MAX = 200; // one-line preview text is length-capped, not just line-capped

function severityWord(sev: 1 | 2 | 3 | 4): "error" | "warn" | "info" | "hint" {
  switch (sev) {
    case 1: return "error";
    case 2: return "warn";
    case 3: return "info";
    case 4: return "hint";
    default: return "info"; // defensive: an out-of-range severity from a nonconforming server
  }
}

// LSP's wire format: file:// + encodeURI (NOT encodeURIComponent — leaves "/" untouched), the SAME
// choice manager.ts's own (unexported) pathToFileUri makes, so client.ts's uriToPath round-trips it.
function toFileUri(p: string): string {
  return `file://${encodeURI(p)}`;
}

// The session tmp dir is a Winter-managed, session-private read root, same allowance fs-read.ts's
// own readRootsOf grants — duplicated here (not imported) because that version closes over
// ToolContext's roots/tmpDir, while this file's tool resolves both via deps closures instead.
function readRootsOf(roots: string[], tmpDir?: string): string[] {
  return tmpDir ? [...roots, tmpDir] : roots;
}

function oneLinePreview(absPath: string, line0: number): string | undefined {
  try {
    const lines = readFileSync(absPath, "utf8").split("\n");
    const raw = lines[line0];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.length > PREVIEW_MAX ? trimmed.slice(0, PREVIEW_MAX) + "…" : trimmed;
  } catch {
    return undefined; // file unreadable/vanished since the server reported it — omit the preview, still show the location
  }
}

function formatDiagnostics(diags: LspDiagnostic[]): string {
  if (diags.length === 0) return "no diagnostics";
  const shown = diags.slice(0, DIAGNOSTICS_CAP).map((d) => {
    const src = d.source ? ` [${d.source}]` : "";
    return `${severityWord(d.severity)} ${d.line + 1}:${d.character + 1} ${d.message}${src}`;
  });
  const extra = diags.length - DIAGNOSTICS_CAP;
  return extra > 0 ? `${shown.join("\n")}\n+${extra} more` : shown.join("\n");
}

// Shared by BOTH `definition` and `implementation` (same request/response shape — LspLocation[]
// — per client.ts's own doc comment on `implementation`); only the empty-result sentinel differs.
// Only these two get a preview (references does not — see this file's doc comment and the
// original brief's formatting spec). `readRoots` re-applies the SAME fence the tool's own
// `file_path` arg is held to (see FENCE DISCIPLINE above) — a location outside it is still listed,
// just never read.
function formatDefinition(locs: LspLocation[], readRoots: string[], emptyMessage = "no definition found"): string {
  if (locs.length === 0) return emptyMessage;
  const lines = locs.slice(0, DEFINITIONS_CAP).map((loc) => {
    const base = `${loc.path}:${loc.line + 1}:${loc.character + 1}`;
    let safe: string | undefined;
    try { safe = resolveWithinAny(readRoots, loc.path); } catch { /* outside the fence: no preview, location still shown */ }
    const prev = safe ? oneLinePreview(safe, loc.line) : undefined;
    return prev ? `${base}  ${prev}` : base;
  });
  const extra = locs.length - DEFINITIONS_CAP;
  return extra > 0 ? `${lines.join("\n")}\n+${extra} more` : lines.join("\n");
}

function formatReferences(locs: LspLocation[]): string {
  if (locs.length === 0) return "no references found";
  const shown = locs.slice(0, REFERENCES_CAP).map((loc) => `${loc.path}:${loc.line + 1}:${loc.character + 1}`);
  const extra = locs.length - REFERENCES_CAP;
  return extra > 0 ? `${shown.join("\n")}\n+${extra} more` : shown.join("\n");
}

// workspace_symbols has no file_path to route language from (workspace/symbol is a project-wide
// search, not per-file) — LspManager still keys servers per (root, language), so SOME language
// must be picked to spawn/reuse against. Marker-file heuristic, scoped to cwd's own top level (no
// recursive walk — this must stay cheap; it runs on every workspace_symbols call): a Swift
// package/app marker signals Swift; everything else defaults to typescript (the broader-coverage
// language in EXTENSION_LANGUAGE — 6 extensions vs swift's 1 — and this codebase's own common
// case). v1 compromise: a project with BOTH stacks only ever searches one language's servers —
// a known gap, not silently pretended away; a future per-language override is the natural follow-up
// if it matters in practice.
function detectWorkspaceLanguage(cwd: string): LspLanguage {
  try {
    const entries = readdirSync(cwd);
    if (entries.some((e) => e === "Package.swift" || e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"))) return "swift";
  } catch {
    /* unreadable cwd: fall through to the default */
  }
  return "typescript";
}

async function withNotSupported(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LspNotSupportedError) return e.message; // clean sentinel, not a crash — see this file's own doc comment
    throw e;
  }
}

export interface LspToolDeps {
  /** The daemon's ONE `LspManager`, or a GETTER over its live holder (fix wave, review F7): the
   *  `lsp` capability server is built per session and read per call, so `settings.lsp.enabled`
   *  flipping off mid-session makes the NEXT call refuse ("not available") with no rebuild — the
   *  same hot shape `computer`'s service getter has. A plain manager (the registry door, tests)
   *  keeps working unchanged. */
  lsp: LspManager | (() => LspManager | undefined);
  cwdOf: (sessionId: string) => string | undefined;
  rootsOf: (sessionId: string) => string[];
  tmpDirOf?: (sessionId: string) => string | undefined;
}

const ACTIONS = ["definition", "references", "hover", "symbols", "workspace_symbols", "implementation", "diagnostics"] as const;
type LspAction = (typeof ACTIONS)[number];

// Per-action param requirement, enforced IN THE HANDLER rather than via zod (the schema itself
// keeps every field but `action` optional, since which fields are required depends on which
// action was picked). `workspace_symbols` is the only action keyed off `symbol` instead of
// `file_path`/`line`/`character` — it searches BY NAME across the whole workspace, not a position
// in one file.
const REQUIRED_PARAMS: Record<LspAction, readonly string[]> = {
  definition: ["file_path", "line", "character"],
  references: ["file_path", "line", "character"],
  hover: ["file_path", "line", "character"],
  implementation: ["file_path", "line", "character"],
  symbols: ["file_path"],
  diagnostics: ["file_path"],
  workspace_symbols: ["symbol"],
};

/** Throws the SAME message regardless of how many/which fields are missing, naming every field
 *  the action needs so a caller sees the whole contract at once, not just the one field it
 *  happened to omit (e.g. "action 'definition' requires file_path, line, character"). */
function assertRequiredParams(action: LspAction, args: { file_path?: string; line?: number; character?: number; symbol?: string }): void {
  const required = REQUIRED_PARAMS[action];
  const present: Record<string, unknown> = { file_path: args.file_path, line: args.line, character: args.character, symbol: args.symbol };
  if (required.some((k) => present[k] === undefined)) {
    throw new Error(`action '${action}' requires ${required.join(", ")}`);
  }
}

/** Fix wave (review F7): the ONE `lsp` definition, shared by the registry door
 *  (`registerLspTools`) and the `lsp` capability server (`capabilities/lsp.ts`) — the same
 *  "one implementation, two doors" shape every other capability tool takes. */
export function lspToolDefs(deps: LspToolDeps): ToolDefinition[] {
  const { cwdOf, rootsOf, tmpDirOf } = deps;
  const manager = (): LspManager => {
    const m = typeof deps.lsp === "function" ? deps.lsp() : deps.lsp;
    if (m === undefined) throw new Error("lsp is not available in this session (settings.lsp.enabled is false)");
    return m;
  };

  // Shared prelude for every file_path-based action: fence-check `file_path` BEFORE anything else
  // touches the manager, THEN route its language (unsupported → typed error) — also before
  // `clientFor`. Only once both guards pass does a caller get a workspace root to spawn/reuse a
  // server against.
  function resolvePathAndLanguage(sessionId: string, filePath: string): { abs: string; cwd: string; language: LspLanguage; readRoots: string[] } {
    const readRoots = readRootsOf(rootsOf(sessionId), tmpDirOf?.(sessionId));
    const abs = resolveWithinAny(readRoots, filePath); // throws BEFORE clientFor on an outside-roots path
    const language = languageForPath(abs);
    if (!language) {
      throw new Error(`unsupported file extension for LSP: "${filePath}" (supported: ${SUPPORTED_EXTENSIONS.join(", ")})`);
    }
    const cwd = cwdOf(sessionId);
    if (!cwd) throw new Error("no working directory for this session");
    return { abs, cwd, language, readRoots };
  }

  return [{
    name: "lsp",
    description:
      "Query the project's language server. action selects the operation: 'definition' (jump to where the symbol at " +
      "file_path:line:character is defined), 'references' (find usages of that symbol), 'implementation' (find " +
      "implementations of that symbol), 'hover' (type/doc info for that symbol), 'symbols' (list every symbol declared " +
      "in file_path), 'workspace_symbols' (search symbols by name across the whole project via symbol), 'diagnostics' " +
      "(errors/warnings for file_path). line/character are 1-based (like most editors); file_path is relative to the " +
      "session directory. Supported: .ts/.tsx/.js/.jsx/.mts/.cts/.swift.",
    args: z.object({
      action: z.enum(ACTIONS),
      file_path: z.string().optional(),
      line: z.number().int().min(1).optional(),
      character: z.number().int().min(1).optional(),
      symbol: z.string().optional(),
    }),
    deferred: true,
    async run({ action, file_path, line, character, symbol }, { sessionId }) {
      assertRequiredParams(action, { file_path, line, character, symbol });

      if (action === "workspace_symbols") {
        const cwd = cwdOf(sessionId);
        if (!cwd) throw new Error("no working directory for this session");
        const language = detectWorkspaceLanguage(cwd);
        const client = await manager().clientFor(cwd, language); // re-acquired fresh every call — see CALLER CONTRACT above
        return withNotSupported(() => client.workspaceSymbols(symbol!));
      }

      const { abs, cwd, language, readRoots } = resolvePathAndLanguage(sessionId, file_path!);
      const client = await manager().clientFor(cwd, language);
      const text = readFileSync(abs, "utf8"); // the client opens the doc before querying — servers only answer for open docs

      switch (action) {
        case "diagnostics": {
          const diags = await client.diagnostics(toFileUri(abs), text);
          return formatDiagnostics(diags);
        }
        case "definition": {
          const locs = await client.definition(toFileUri(abs), text, line! - 1, character! - 1); // 1-based tool args -> 0-based client
          return formatDefinition(locs, readRoots);
        }
        case "implementation": {
          return withNotSupported(async () => {
            const locs = await client.implementation(toFileUri(abs), text, line! - 1, character! - 1);
            return formatDefinition(locs, readRoots, "no implementation found");
          });
        }
        case "references": {
          const locs = await client.references(toFileUri(abs), text, line! - 1, character! - 1);
          return formatReferences(locs);
        }
        case "hover":
          return withNotSupported(() => client.hover(toFileUri(abs), text, line! - 1, character! - 1));
        case "symbols":
          return withNotSupported(() => client.documentSymbols(toFileUri(abs), text));
        default:
          // Unreachable: every LspAction is handled above (workspace_symbols returns earlier) —
          // NOT a compile-time exhaustiveness check (ToolRegistry.register's non-generic
          // signature widens `run`'s args to `any` project-wide, so a `never` assertion here would
          // never actually catch a missed case at compile time); this is a pure runtime backstop.
          throw new Error(`unhandled lsp action: ${String(action)}`);
      }
    },
  }];
}

export function registerLspTools(r: ToolRegistry, deps: LspToolDeps): void {
  for (const def of lspToolDefs(deps)) r.register(def);
}
