import { readFileSync } from "node:fs";
import type { LspManager } from "./manager";
import { languageForPath } from "./manager";
import type { LspDiagnostic } from "./client";
import { resolveWithinAny } from "../paths";

/**
 * Auto-diagnostics after edit (lsp-consolidation T3 originally; ported to the Winter leg's
 * `PostToolUse` hook at Phase 8c Lane 3, Task 3.2) — CC parity: "after each file edit, it
 * automatically reports type errors and warnings so Claude can fix issues without a separate build
 * step." This is NOT a second diagnostics pipeline: it calls the SAME `LspManager.clientFor` /
 * `LspClient.diagnostics()` the on-demand `lsp` capability tool's `diagnostics` action already
 * rides (`agent/tools/lsp.ts`), which is what makes it automatically bounded by the SAME
 * per-language settle/timeout tuning (`DIAG_TUNING`, manager.ts) with no extra tuning of its own.
 *
 * PORT NOTE (8c): the retired engine's version (git history at `1e732738^`) keyed `FILE_PATH_ARG`
 * on the DAEMON's own lowercase registry tool names (`write`/`edit`/`notebook_edit`, each carrying
 * a `path` or `notebook_path` arg). The Winter leg's built-in tools are named and shaped
 * differently — `Edit`/`Write` take `file_path`; `NotebookEdit` takes `notebook_path`
 * (`@yanlinglabs/winter-agent-sdk`'s `descriptors/{edit,write,notebook-edit}.ts`, captured verbatim)
 * — so the map below is keyed on THOSE names. Winter 0.0.4 has no `MultiEdit` tool at all (measured:
 * absent from `WINTER_ADVERTISED_TOOLS_0_0_4_BASE`), so there is nothing to map it to; a future SDK
 * that adds one is a one-line addition here, not a silent gap (the calling hook in `hooks.ts` only
 * ever asks about tools this map lists).
 *
 * NEVER-FAIL CONTRACT (why this whole thing is one try/catch): the caller (`hooks.ts`'s
 * `PostToolUse` hook) only reaches this AFTER Winter itself reports the tool call — a diagnostics
 * hiccup (unsupported extension, fence rejection, spawn failure, timeout, dead server, a malformed
 * `tool_input` shape) must never retroactively touch a call the child already completed. Every
 * failure mode below resolves to "" (append nothing); NOTHING here ever throws out to the caller.
 */

// Winter tool name -> which `tool_input` key holds the file path that was just written.
const FILE_PATH_ARG: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/** The Winter tool names this hook ever applies to — exported so `hooks.ts`'s own `PostToolUse`
 *  matcher-group registration and this module's path-arg lookup can never drift apart (one Set,
 *  one source of truth). */
export const AUTO_DIAG_TOOL_NAMES = new Set(Object.keys(FILE_PATH_ARG));

const AUTO_DIAG_CAP = 20;

// LSP's wire format: file:// + encodeURI (NOT encodeURIComponent — leaves "/" untouched), the SAME
// choice tools/lsp.ts's own (module-local) toFileUri makes — duplicated rather than imported,
// same "small one-line helper, not worth coupling two files over" precedent as that file's own
// readRootsOf doc comment.
function toFileUri(p: string): string {
  return `file://${encodeURI(p)}`;
}

// Mirrors tools/lsp.ts's own severityWord (module-local there too, not exported) — same four-way
// mapping, kept in sync by hand if the LSP DiagnosticSeverity enum ever changes (it hasn't since
// LSP 3.x shipped).
function severityWord(sev: 1 | 2 | 3 | 4): "error" | "warn" | "info" | "hint" {
  switch (sev) {
    case 1: return "error";
    case 2: return "warn";
    case 3: return "info";
    case 4: return "hint";
    default: return "info"; // defensive: an out-of-range severity from a nonconforming server
  }
}

// Design decision (carried verbatim from the retired engine's version, flagged there for review):
// the spec's header format is binary — "(<n> errors, <m> warnings)" — with no third/fourth bucket
// for LSP's Information/Hint severities. `errors` counts ONLY severity 1; every other severity (2
// warning, 3 information, 4 hint) is folded into the `warnings` count for the header, though each
// entry line still shows its OWN real severity word (warn/info/hint) so no information is lost —
// only the two-bucket HEADER TOTAL is a simplification. Ordering: errors first (the spec's explicit
// requirement), then everything else in its original relative (server-reported) order — a stable
// partition, not a full re-sort by exact severity.
function formatBlock(displayPath: string, diags: LspDiagnostic[]): string {
  if (diags.length === 0) return ""; // clean file — CC parity: silence = clean, no token waste
  const errors = diags.filter((d) => d.severity === 1);
  const rest = diags.filter((d) => d.severity !== 1);
  const ordered = [...errors, ...rest];
  const shown = ordered
    .slice(0, AUTO_DIAG_CAP)
    .map((d) => `${displayPath}:${d.line + 1}:${d.character + 1} ${severityWord(d.severity)} ${d.message}`);
  const extra = ordered.length - AUTO_DIAG_CAP;
  const list = extra > 0 ? `${shown.join("\n")}\n…and ${extra} more` : shown.join("\n");
  // `rest.length` DELIBERATELY folds severities 3/4 (info/hint) into the "warnings" count — the
  // header is two-bucket by spec; entry lines above keep their true severity word. Don't "fix".
  return `\n\ndiagnostics (${errors.length} errors, ${rest.length} warnings):\n${list}`;
}

export interface AutoDiagnosticsOpts {
  lsp: LspManager;
  toolName: string; // one of AUTO_DIAG_TOOL_NAMES ("Edit"/"Write"/"NotebookEdit") — anything else returns "" immediately
  toolInput: unknown; // the hook's already-decoded `tool_input` (PostToolUseHookInput.tool_input)
  cwd: string; // workspace root to spawn/reuse the language server against (the hook input's own `cwd`)
  roots: string[]; // fence roots the file path is resolved against (session roots + tmp dir)
  // The TURN's abort signal (the hook callback's own `{signal}`, threaded through so an ESC/
  // interrupt mid-diagnostics-wait cuts this suffix short rather than riding out the full
  // settle/timeout window): optional — absent behaves exactly as before this was added.
  signal?: AbortSignal;
}

/** Rejects the moment `signal` aborts (or immediately if it already has) — raced against the
 *  spawn/diagnostics waits below so an interrupt cuts this suffix short WITHOUT touching
 *  LspClient (whose `diagnostics()` has no signal parameter; the abandoned promise self-cleans
 *  via the client's own settle/deadline timers, and Promise.race already attached a handler to
 *  it, so a late rejection is never unhandled). The abort listener is removed in `finally`
 *  either way: the turn's signal outlives this call, so a leaked once-listener per edit would
 *  otherwise accumulate for the whole turn. */
async function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("turn aborted"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Returns the block to APPEND to the `PostToolUse` `additionalContext`, or "" when there is
 *  nothing to append — see this file's own NEVER-FAIL CONTRACT doc comment above. */
export async function autoDiagnosticsSuffix(opts: AutoDiagnosticsOpts): Promise<string> {
  try {
    const argKey = FILE_PATH_ARG[opts.toolName];
    if (!argKey) return "";
    const filePath = (opts.toolInput as Record<string, unknown> | null | undefined)?.[argKey];
    if (typeof filePath !== "string" || !filePath) return "";
    const language = languageForPath(filePath);
    if (!language) return ""; // extension has no configured language server (e.g. .ipynb, .md)
    const abs = resolveWithinAny(opts.roots, filePath); // the SAME fence the write/edit itself was held to
    if (opts.signal?.aborted) return ""; // already interrupted — don't even cold-spawn a server
    const client = await raceAbort(opts.lsp.clientFor(opts.cwd, language), opts.signal); // may cold-spawn; bounded by startTimeoutMs
    const text = readFileSync(abs, "utf8");
    // Bounded by DIAG_TUNING[language] AND raced against the turn's abort — an interrupt resolves
    // "" promptly (raceAbort's rejection lands in this function's never-fail catch below) instead
    // of riding out the full settle/timeout window.
    const diags = await raceAbort(client.diagnostics(toFileUri(abs), text), opts.signal);
    return formatBlock(filePath, diags);
  } catch {
    return ""; // never-fail — see this file's own doc comment
  }
}
