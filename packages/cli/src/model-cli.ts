// Pure/isolatable logic behind `norma model ...`, split out of main.ts so it can be
// unit-tested without going through the top-level `if (import.meta.main)` dispatch. Mirrors
// plugin-cli.ts's split: main.ts owns the I/O (loadSettings/saveSettings/connect), this file
// owns the parse/validate decisions.
import { CODEX_MODELS, REASONING_EFFORTS } from "@norma/core";

export type ModelCliAction =
  | { kind: "show" }
  | { kind: "setModel"; slug: string }
  | { kind: "setEffort"; effort: string }
  | { kind: "setModelAndEffort"; slug: string; effort: string }
  | { kind: "usageError"; message: string };

const USAGE = "usage: norma model [<slug>] [--effort <level>]  |  norma model --effort <level>";

/**
 * Parses `norma model`'s argv tail (everything after "model" — i.e. `process.argv.slice(3)`).
 * Forms:
 *   []                          -> show
 *   ["--effort", level]         -> setEffort (effort-only change)
 *   [slug]                      -> setModel
 *   [slug, "--effort", level]   -> setModelAndEffort
 * Anything else (missing effort value, trailing garbage, an unknown flag in slug position) is a
 * usageError — main.ts prints `.message` and exits 1, never silently guesses.
 */
export function parseModelArgs(args: string[]): ModelCliAction {
  if (args.length === 0) return { kind: "show" };

  if (args[0] === "--effort") {
    const effort = args[1];
    if (!effort || args.length > 2) return { kind: "usageError", message: USAGE };
    return { kind: "setEffort", effort };
  }

  const slug = args[0]!;
  if (slug.startsWith("-")) return { kind: "usageError", message: USAGE };

  if (args.length === 1) return { kind: "setModel", slug };

  if (args[1] === "--effort") {
    const effort = args[2];
    if (!effort || args.length > 3) return { kind: "usageError", message: USAGE };
    return { kind: "setModelAndEffort", slug, effort };
  }

  return { kind: "usageError", message: USAGE };
}

/**
 * Validates a model slug against the active provider type. codex-oauth is allowlisted to
 * CODEX_MODELS (the gpt-5.6 family only — 5.5/5.4/5.4-mini are deprecated, see
 * providers/codex-config.ts) with a clear error listing the valid slugs. openai-compatible has
 * no allowlist — arbitrary API models are legitimate there, so any non-empty slug passes.
 * Returns an error message, or null when the slug is valid.
 */
export function validateModelSlug(providerType: "codex-oauth" | "openai-compatible", slug: string): string | null {
  if (providerType === "openai-compatible") {
    return slug.trim().length > 0 ? null : "model slug must not be empty";
  }
  if (CODEX_MODELS.some((m) => m.id === slug)) return null;
  return `invalid model "${slug}" for codex-oauth — valid slugs: ${CODEX_MODELS.map((m) => m.id).join(", ")}`;
}

/** Validates a reasoning-effort slug against REASONING_EFFORTS (settings.ts — the wire-valid
 *  universe, measured live against the endpoint, not read off the /models catalogue; see that
 *  constant's own comment). Per-model rejection (e.g. "minimal", which the backend rejects on a
 *  per-model basis) is NOT validated here — the backend rejects unsupported combos itself.
 *  Returns an error message, or null when valid. */
export function validateEffort(effort: string): string | null {
  if ((REASONING_EFFORTS as readonly string[]).includes(effort)) return null;
  return `invalid effort "${effort}" — must be one of: ${REASONING_EFFORTS.join(", ")}`;
}
