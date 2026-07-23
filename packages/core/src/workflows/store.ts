import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrustStore } from "../agent/trust";

/** A resolved workflow's identity + where it came from. Unlike OutputStyleStore's ResolvedStyle
 *  (agent/output-styles.ts) there is no `body` here — `resolve()` is the cheap "does this name
 *  exist, what does it do" lookup used by discovery/listing; `read()` below returns these same
 *  three fields plus the full script text, for anything that actually needs to run or edit it. */
export interface ResolvedWorkflow {
  name: string;
  description: string;
  /** Provenance: "project" or "user" — which of the two closest-wins roots this came from. */
  source: string;
}

/** Path-traversal guard — same regex, same rationale, as OutputStyleStore's (agent/output-styles.ts
 *  `resolve()`): `name` flows from settings/CLI/tool-args straight into a path join below
 *  (`${name}.js`), so it must be rejected BEFORE any filesystem call ever sees it. No dots, no
 *  slashes — a bare "." or ".." stem is refused rather than relying on the ".js" suffix to
 *  accidentally neuter it into "..js"/"...js". Shared by resolve()/read() and save() so the guard
 *  can't drift between the two call sites. */
const SLUG_RE = /^[A-Za-z0-9_-]+$/;

/** Matches a `description` key's value INSIDE a meta object-literal's text, but only when that
 *  value is a plain quoted string literal (single/double/backtick-quoted, backslash-escapes
 *  tolerated within it). Deliberately does not match a computed expression, a template literal with
 *  interpolation (`${...}`), or anything else that isn't a bare string — those are treated the same
 *  as "no description key at all" (see extractMetaDescription). Mirrors the plain-text key:value
 *  extraction output-styles.ts's parseStyleFile does for frontmatter — no eval there either. */
const DESCRIPTION_RE = /(?:^|[{,\s])description\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/;

/** Finds `meta = {`, slices the balanced `{...}` that follows, and pulls the `description` key's
 *  value out of that slice as TEXT — via DESCRIPTION_RE, never by evaluating it. The workflow
 *  feature's entire raison d'être is a sandboxed subprocess for a script's actual body; running any
 *  fragment of a workflow file — even just its meta block — in the unsandboxed daemon defeats that,
 *  since `list()`/`resolve()`/`read()` (and thus this function) fire passively, e.g. whenever the
 *  Workflows pane opens or `norma workflow list` runs, on every workflow file the trust gate would
 *  ever surface (a trusted project's `.norma/workflows/*.js`, or ANY `~/.norma/workflows/*.js`) —
 *  there is no opportunity for a human to review the file first. Any failure to find a well-formed
 *  `meta`/`description` (no `meta`, unbalanced braces, a computed/interpolated/missing description)
 *  yields "" rather than throwing or evaluating anything: a missing or malformed `meta` block must
 *  not make an otherwise-valid workflow file unresolvable/unlistable. */
function extractMetaDescription(raw: string): string {
  const m = raw.match(/\bmeta\s*=\s*\{/);
  if (!m || m.index === undefined) return "";
  const braceStart = m.index + m[0].length - 1; // index of the '{' itself
  const objLiteral = sliceBalancedBraces(raw, braceStart);
  if (!objLiteral) return "";
  const dm = objLiteral.match(DESCRIPTION_RE);
  if (!dm) return "";
  // Unescape backslash-escapes within the matched literal (\", \\, \n, ...) — a plain text
  // substitution, not evaluation: no expression is ever run, only literal characters replaced.
  return dm[2]!.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/** `src[start]` must be the opening '{'. Returns the substring through its matching '}', counting
 *  brace depth while skipping over anything inside a quoted string/template literal (so a
 *  description like `"a { here"` can't desync the count) and respecting backslash escapes inside
 *  those strings. Returns null if EOF is reached before depth returns to 0 (unbalanced, or `start`
 *  wasn't actually the start of an object literal). */
function sliceBalancedBraces(src: string, start: number): string | null {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") { i++; continue; } // skip the escaped char, whatever it is
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse `<name>.js`: pull `description` out of its `export const meta = { ... }` object literal
 *  (see extractMetaDescription). Identity is ALWAYS `fallbackName` (the filename stem) — mirrors
 *  output-styles' parseStyleFile, which never lets in-file metadata override the file it was
 *  actually found at, so list()'s and resolve()'s notions of a workflow's name can never disagree.
 *  Returns null if the file doesn't exist / isn't a regular file. */
function parseWorkflowFile(path: string, fallbackName: string): { name: string; description: string; body: string } | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return { name: fallbackName, description: extractMetaDescription(raw), body: raw };
}

/**
 * Resolves a workflow script by name from two sources, closest-wins: a trusted project's
 * `<cwd>/.norma/workflows/<name>.js`, then `<normaHome>/workflows/<name>.js`. Unlike
 * OutputStyleStore (agent/output-styles.ts) there are no built-ins to fall back to — an unresolved
 * name simply resolves to null. Mirrors OutputStyleStore's trust-gated project-dir discovery and
 * slug-guard exactly, adapted for the `.js` extension and the lack of built-ins. Never throws,
 * except `save()`, which rejects a malformed name before it ever reaches a filesystem call.
 */
export class WorkflowStore {
  constructor(private readonly deps: { normaHome: string; trust: Pick<TrustStore, "isTrusted"> }) {}

  /** Shared traversal for resolve()/read(): project[trusted] > user. Slug-guarded — see SLUG_RE. */
  private resolveInternal(name: string, cwd: string | null): { name: string; description: string; source: string; body: string } | null {
    if (!SLUG_RE.test(name)) return null;
    if (cwd && this.deps.trust.isTrusted(cwd)) {
      const p = parseWorkflowFile(join(cwd, ".norma", "workflows", `${name}.js`), name);
      if (p) return { ...p, source: "project" };
    }
    const u = parseWorkflowFile(join(this.deps.normaHome, "workflows", `${name}.js`), name);
    if (u) return { ...u, source: "user" };
    return null;
  }

  /** project[trusted] > user. null if the name resolves to nothing, or isn't a valid slug. */
  resolve(name: string, cwd: string | null): ResolvedWorkflow | null {
    const r = this.resolveInternal(name, cwd);
    return r ? { name: r.name, description: r.description, source: r.source } : null;
  }

  /** Same resolution chain and identity rules as resolve(), plus the full script text — for
   *  anything that actually needs to run or edit the workflow, rather than merely discover it. */
  read(name: string, cwd: string | null): { name: string; description: string; source: string; body: string } | null {
    return this.resolveInternal(name, cwd);
  }

  /** All resolvable workflows for the CLI: user files ∪ project files (if trusted), deduped by
   *  name closest-wins (project > user). Mirrors OutputStyleStore.list() (agent/output-styles.ts)
   *  exactly — same scan-then-overwrite Map dedup — minus the built-ins seed (workflows have none). */
  list(cwd: string | null): ResolvedWorkflow[] {
    const out = new Map<string, { description: string; source: string }>();
    const scan = (dir: string, source: string) => {
      let files: string[] = [];
      try { files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => e.name); }
      catch { return; }
      for (const f of files) {
        const p = parseWorkflowFile(join(dir, f), f.replace(/\.js$/, ""));
        if (p) out.set(p.name, { description: p.description, source });
      }
    };
    scan(join(this.deps.normaHome, "workflows"), "user");
    if (cwd && this.deps.trust.isTrusted(cwd)) scan(join(cwd, ".norma", "workflows"), "project"); // project overrides user
    return [...out].map(([name, v]) => ({ name, description: v.description, source: v.source }));
  }

  /** Writes a run's script to `<normaHome>/workflows/<name>.js` (creating the directory if it
   *  doesn't exist yet). Slug-guarded — same regex/rationale as resolve(); rejected BEFORE any
   *  filesystem call, since `name` here can come from a tool-call argument (the Workflow tool's
   *  `name` param) just as readily as from a human. Throws on an invalid name, rather than
   *  returning a result object — callers are expected to validate/catch, not silently no-op. */
  save(name: string, source: string): void {
    if (!SLUG_RE.test(name)) throw new Error(`invalid workflow name: "${name}"`);
    const dir = join(this.deps.normaHome, "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.js`), source);
  }
}
