import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrustStore } from "./trust";
import { neutralizeReminderTags } from "./context";

/** A fully-resolved output style ready to inject. `body` is neutralized + byte-capped for FILE
 *  styles; built-in bodies are trusted constants. `keepCodingInstructions: true` augments the base
 *  prompt (body appended after it); `false` replaces it. */
export interface ResolvedStyle {
  name: string;
  description: string;
  body: string;
  keepCodingInstructions: boolean;
}

// Overlay bodies — each ASSUMES Norma's base SYSTEM_PROMPT is still present (keepCodingInstructions:
// true), so they layer behavior on top rather than restating the base.
const PROACTIVE_BODY =
  "Operate in a proactive mode. When the user's intent is clear, take the initiating action instead " +
  "of asking whether to proceed, and chain the obvious follow-up steps without pausing for " +
  "confirmation on reversible work. Still surface — and stop for — genuinely irreversible or " +
  "ambiguous decisions. Prefer doing over describing.";
const EXPLANATORY_BODY =
  "Operate in an explanatory mode. As you work, briefly explain the reasoning behind non-obvious " +
  "choices: why this approach over the alternatives, what tradeoff you are making, what a key piece " +
  "of code or command actually does. Keep explanations short and inline — the goal is that the user " +
  "understands not just what you did but why.";
const LEARNING_BODY =
  "Operate in a collaborative learning mode. Do the bulk of the work yourself, but deliberately " +
  "leave a few small, well-chosen pieces for the user to complete, each marked with a `TODO(human):` " +
  "comment stating exactly what that piece should do and why it is a good one to try. Favor gaps " +
  "that teach the core idea. When you finish, list the `TODO(human)` markers you left so the user " +
  "can find them.";

/** The four built-ins. `default` is reserved: empty body, never injected — selecting it (or leaving
 *  `outputStyle` unset) means "use the base prompt as-is". The other three augment the base. */
export const BUILTIN_OUTPUT_STYLES: ResolvedStyle[] = [
  { name: "default", description: "Norma's standard behavior.", body: "", keepCodingInstructions: true },
  { name: "proactive", description: "Act immediately and autonomously; ask less.", body: PROACTIVE_BODY, keepCodingInstructions: true },
  { name: "explanatory", description: "Explain reasoning and tradeoffs while working.", body: EXPLANATORY_BODY, keepCodingInstructions: true },
  { name: "learning", description: "Leave labeled TODO(human) gaps for you to complete.", body: LEARNING_BODY, keepCodingInstructions: true },
];
export const BUILTIN_STYLE_NAMES: readonly string[] = BUILTIN_OUTPUT_STYLES.map((s) => s.name);

const DEFAULT_BODY_CAP = 32768;

/** Parse `<name>.md`: frontmatter (name, description, keep-coding-instructions) between the first
 *  ---…--- fence, then the body. Returns null if invalid (no fence / not a regular file). Mirrors
 *  skills.ts `parseSkill`. */
function parseStyleFile(path: string, fallbackName: string, cap: number): ResolvedStyle | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  let name = fallbackName;
  let description = "";
  let keep = false;
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "name" && val) name = val;
    else if (key === "description") description = val;
    else if (key === "keep-coding-instructions") keep = val === "true";
  }
  let capped = neutralizeReminderTags(body);
  if (Buffer.byteLength(capped) > cap) capped = Buffer.from(capped).subarray(0, cap).toString("utf8");
  return { name, description, body: capped, keepCodingInstructions: keep };
}

/**
 * Resolves an output style by name from three sources, closest-wins: a trusted project's
 * `<cwd>/.norma/output-styles/<name>.md`, then `<normaHome>/output-styles/<name>.md`, then the
 * built-ins. Mirrors SkillStore's trust-gated project-dir discovery. Never throws.
 */
export class OutputStyleStore {
  private readonly cap: number;
  constructor(private readonly deps: { normaHome: string; trust: Pick<TrustStore, "isTrusted">; caps?: { bodyBytes?: number } }) {
    this.cap = deps.caps?.bodyBytes ?? DEFAULT_BODY_CAP;
  }

  /** project[trusted] > user > built-in. null if the name resolves to nothing. */
  resolve(name: string, cwd: string | null): ResolvedStyle | null {
    if (cwd && this.deps.trust.isTrusted(cwd)) {
      const p = parseStyleFile(join(cwd, ".norma", "output-styles", `${name}.md`), name, this.cap);
      if (p) return p;
    }
    const u = parseStyleFile(join(this.deps.normaHome, "output-styles", `${name}.md`), name, this.cap);
    if (u) return u;
    return BUILTIN_OUTPUT_STYLES.find((s) => s.name === name) ?? null;
  }

  /** All resolvable styles for the CLI: built-ins ∪ user files ∪ project files (if trusted),
   *  deduped by name closest-wins (project > user > built-in). */
  list(cwd: string | null): { name: string; description: string }[] {
    const out = new Map<string, string>();
    for (const s of BUILTIN_OUTPUT_STYLES) out.set(s.name, s.description);
    const scan = (dir: string) => {
      let files: string[] = [];
      try { files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name); }
      catch { return; }
      for (const f of files) {
        const p = parseStyleFile(join(dir, f), f.replace(/\.md$/, ""), this.cap);
        if (p) out.set(p.name, p.description);
      }
    };
    scan(join(this.deps.normaHome, "output-styles"));           // user overrides built-in
    if (cwd && this.deps.trust.isTrusted(cwd)) scan(join(cwd, ".norma", "output-styles")); // project overrides user
    return [...out].map(([name, description]) => ({ name, description }));
  }
}
