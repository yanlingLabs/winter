import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrustStore } from "./trust";
import type { SkillStore } from "./skills";
import type { ResolvedStyle } from "./output-styles";

export const BASE_PROMPT = [
  "You are Norma, an agentic assistant running on the user's Mac.",
  "You operate inside a session working directory; file tool paths are relative to it.",
  "Use the tools to accomplish the user's request, then reply with a concise summary.",
  // CC-parity (user directive 2026-07-10): route decisions the user must make THROUGH the tool.
  "When you need the user to choose between options or clarify something you cannot resolve from the request, the code, or sensible defaults, ALWAYS ask via the ask_user tool with structured options — never pose the question as prose and stop. (This is about HOW to ask, not WHETHER: if you can proceed on a sensible default, just proceed.)",
].join(" ");

const TRUNC = "\n[…truncated]";

/** Cap a string to `maxBytes` UTF-8 bytes, truncating on a valid boundary (a split multibyte char degrades to U+FFFD, never a lone surrogate). */
function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Read a UTF-8 file, capping at `maxBytes`; returns null if missing/unreadable/not a regular file. */
function readCapped(path: string, maxBytes: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    const s = readFileSync(path, "utf8");
    if (s.length === 0) return null;
    const { text, truncated } = capBytes(s, maxBytes);
    return truncated ? text + TRUNC : text;
  } catch { return null; }
}

/** Read a file capped at `maxLines` AND `maxBytes` (whichever first). null if missing/unreadable/empty. */
function readMemory(path: string, maxLines: number, maxBytes: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    let s = readFileSync(path, "utf8");
    if (s.length === 0) return null;
    let truncated = false;
    const lines = s.split("\n");
    if (lines.length > maxLines) { s = lines.slice(0, maxLines).join("\n"); truncated = true; }
    const capped = capBytes(s, maxBytes);
    s = capped.text;
    truncated = truncated || capped.truncated;
    return truncated ? s + TRUNC : s;
  } catch { return null; }
}

export interface AssemblerCaps { instructionsBytes?: number; memoryLines?: number; memoryBytes?: number }

// File-based memory (MEMDIR, T1). CC's exact numbers (design doc): first 200 lines OR 25KB
// (binary — 25 * 1024 — matching this file's own existing 24576 = 24 * 1024 convention for the
// LEGACY cap just below), whichever hits first. Deliberately a SEPARATE constant from
// `AssemblerCaps.memoryLines/memoryBytes` (200/24576) rather than reusing/retuning them: those
// still gate the pre-existing phase-5b injection below, byte-for-byte unchanged, so every caller
// that never opts into the `memory` dep (below) — every existing test included — keeps its exact
// prior behavior.
const MEMDIR_INDEX_MAX_LINES = 200;
const MEMDIR_INDEX_MAX_BYTES = 25 * 1024;

/** Neutralizes a literal closing (or opening) `<system-reminder>` tag inside untrusted file
 *  content before it's embedded in one — mirrors engine.ts's own `sanitizeForReminder` intent
 *  (same tag, same "a nested literal tag must not let file content escape the wrapper and read as
 *  a second, model-authored system instruction" concern) without that helper's newline-collapsing
 *  (MEMORY.md is a real multi-line markdown list — collapsing it to one line would make the index
 *  unreadable, and file content isn't attacker-controlled turn-input the way a tool result is, so
 *  only the tag itself needs neutralizing here). */
export function neutralizeReminderTags(s: string): string {
  return s.replace(/<\/?system-reminder>/gi, "[tag]");
}

/** T1's protocol text (design doc §"Protocol text"): what the model is told about the memory
 *  directory, adapted from the harness's own observable format (CC's exact wording is private).
 *  Injected UNCONDITIONALLY whenever memory is enabled — independent of whether MEMORY.md exists
 *  yet (an empty/absent memory dir still needs the model to know it CAN save things there). */
function memoryProtocol(memDir: string): string {
  return [
    "## Memory",
    `Persistent, per-project memory lives at the absolute path \`${memDir}\` (created on demand). There are NO dedicated memory tools — use the plain \`write\`/\`edit\`/\`read\`/\`glob\`/\`grep\` tools on it like any other directory.`,
    "Save a fact worth recalling in a FUTURE session (a user preference, a correction the user gave you, a durable project constraint) as its own file there, `<name>.md` where `<name>` is a short kebab-case slug, with frontmatter then the fact:",
    "```\n---\nname: <name>\ndescription: <one-line summary>\ntype: user | feedback | project | reference\n---\n<the fact — for feedback/project, add a short Why / How to apply it too>\n```",
    `Then add or update a one-line pointer for it in \`${join(memDir, "MEMORY.md")}\` (create the file if it doesn't exist yet): \`- [<name>](<name>.md) — <description>\`. MEMORY.md's first ${MEMDIR_INDEX_MAX_LINES} lines / ${Math.round(MEMDIR_INDEX_MAX_BYTES / 1024)}KB load into every session automatically — keep it terse; put detail in the fact file itself, not the index line.`,
    "Update a fact by overwriting its file (and its MEMORY.md line) instead of writing a near-duplicate under a new name. Delete a fact (and its MEMORY.md line) once you learn it is wrong or no longer true. Never save something the repo itself already records — code, config, docs, and NORMA.md are already durable; memory is for facts ABOUT the user or project that live outside the repo.",
  ].join("\n");
}

/** Hot getters over a live settings holder, mirroring engine.ts's `EngineConfig` getter
 *  convention (e.g. `reviewerEnabled: () => settings?.reviewer?.enabled`) — daemon.ts supplies
 *  these as closures over its own `let settings` so a `memory.enabled`/`memory.directory` edit
 *  applies to the NEXT `assemble()` call, no ContextAssembler reconstruction. Deliberately
 *  optional/absent in every test that doesn't pass it: absence means "behave exactly as before
 *  T1" (the legacy phase-5b injection below), not "memory disabled" — see `assemble()`'s branch. */
export interface MemoryContextConfig {
  enabled(): boolean;
  dirFor(cwd: string): string;
  /** Dreaming (Phase 7b): the _assistant bucket path — see assistantMemoryDirFor. REQUIRED (like
   *  `enabled`/`dirFor`), deliberately NOT optional: the assistant branch in `assemble()` fires
   *  INSTEAD of the project/legacy fallbacks (if/else-if chain), so an assistant-mode caller
   *  (chat/cowork later) that forgot to wire this would silently degrade to total memory silence.
   *  Requiring it turns that dormant edge into a compile error at the construction site. Callers
   *  that never pass `memoryBucket: "assistant"` still supply it (a stub path is fine — it's only
   *  read inside the assistant branch). */
  assistantDir(): string;
}

export class ContextAssembler {
  private readonly normaHome: string;
  private readonly trust: TrustStore;
  private readonly skills: SkillStore;
  private readonly basePrompt: string;
  private readonly caps: Required<AssemblerCaps>;
  private readonly memory?: MemoryContextConfig;
  private readonly styleResolver?: (cwd: string | null) => ResolvedStyle | null;
  constructor(deps: {
    normaHome: string;
    trust: TrustStore;
    skills: SkillStore;
    basePrompt?: string;
    caps?: AssemblerCaps;
    memory?: MemoryContextConfig;
    styleResolver?: (cwd: string | null) => ResolvedStyle | null;
  }) {
    this.normaHome = deps.normaHome;
    this.trust = deps.trust;
    this.skills = deps.skills;
    this.basePrompt = deps.basePrompt ?? BASE_PROMPT;
    this.memory = deps.memory;
    this.styleResolver = deps.styleResolver;
    this.caps = {
      instructionsBytes: deps.caps?.instructionsBytes ?? 32768,
      memoryLines: deps.caps?.memoryLines ?? 200,
      memoryBytes: deps.caps?.memoryBytes ?? 24576,
    };
  }

  assemble(input: {
    cwd: string | null; loadedSkills?: string[]; basePromptOverride?: string; memoryBucket?: "project" | "assistant"; skipOutputStyle?: boolean;
    // CM branch review (Important 1 follow-on): whether the `Skill` tool is actually offered to
    // THIS thread — undefined/true (every pre-existing caller) is byte-identical to before this
    // field existed. `false` (chat/dispatch's own narrow allowlists never include "Skill" —
    // engine.ts's turn()) suppresses the "call the `Skill` tool" header below: telling the model to
    // call a tool it doesn't have is exactly the kind of machine-touching-capability leak this
    // review found in the DEFERRED-tools text (buildInstructionsFull), just for the skills list.
    skillToolOffered?: boolean;
  }): string {
    const cwd = input.cwd;
    const trusted = cwd ? this.trust.isTrusted(cwd) : false;
    // Dispatch mode (Phase 7, spec §7): the coordinator gets its OWN base prompt — swapped in
    // whole, not patched — while every other section below (date, user/project instructions,
    // memory, capabilities) still applies unchanged regardless of caller.
    // Output style (CC-parity): the resolved style fills the base slot. SKIPPED entirely under a
    // basePromptOverride (dispatch coordinators keep their own base) OR `skipOutputStyle` (dispatch
    // CHILD sessions — origin:"dispatch-child" — which run mode:"code" with the NORMAL base, so the
    // override check alone wouldn't exclude them): styles are main-conversation only. Everything else
    // still gets them. keepCodingInstructions:true augments (base kept, overlay appended right after);
    // false replaces the base. An empty body or a null resolver → base unchanged (byte-identical).
    let baseSlot = input.basePromptOverride ?? this.basePrompt;
    const styleAppend: string[] = [];
    if (input.basePromptOverride === undefined && !input.skipOutputStyle) {
      const style = this.styleResolver?.(cwd) ?? null;
      if (style && style.body) {
        if (style.keepCodingInstructions) styleAppend.push(style.body);
        else baseSlot = style.body;
      }
    }
    const sections: string[] = [baseSlot, ...styleAppend];

    // F2 (4e gate ledger): the model has no other way to know the current date — recomputed each
    // assemble() call (once per turn) so it stays current across long sessions. LOCAL time, not
    // UTC (review-caught: the daemon runs on the user's own Mac, so toISOString would report the
    // wrong date for up to a third of every day off-UTC); built by hand for locale stability.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    sections.push(`Today's date is ${today}.`);

    const userInstr = readCapped(join(this.normaHome, "NORMA.md"), this.caps.instructionsBytes);
    if (userInstr) sections.push(`## User instructions (~/.norma/NORMA.md)\n${userInstr}`);

    if (cwd && trusted) {
      const projInstr = readCapped(join(cwd, "NORMA.md"), this.caps.instructionsBytes);
      if (projInstr) sections.push(`## Project instructions (NORMA.md)\n${projInstr}`);
    }

    // Project prose rules (CC-parity: `.claude/rules/` → `.norma/rules/*.md`). Same trust gate as
    // the project NORMA.md block just above (reuses the same hoisted `trusted`, not a second
    // `isTrusted` call). Every file's total is bounded by ONE shared budget — the instructions byte
    // cap — rather than per-file, so a directory of many small rule files can't add up to an
    // unbounded prompt; `readCapped` truncates each file to whatever of that budget remains, and
    // files are read in sorted filename order for determinism.
    if (cwd && trusted) {
      const rulesDir = join(cwd, ".norma", "rules");
      let files: string[] = [];
      try { files = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort(); } catch { /* no rules dir → none */ }
      const parts: string[] = [];
      let budget = this.caps.instructionsBytes; // reuse the instructions byte cap as the TOTAL rules budget
      for (const f of files) {
        if (budget <= 0) break;
        const body = readCapped(join(rulesDir, f), budget);
        if (body) {
          // fix-wave E: decrement by the FULL pushed part's bytes (header included), not just the
          // body — the `### <filename>\n` header was previously uncounted, making it
          // unbounded-per-file (bounded only by filename length × file count).
          const part = `### ${f}\n${neutralizeReminderTags(body)}`;
          parts.push(part);
          budget -= Buffer.byteLength(part);
        }
      }
      if (parts.length) sections.push(`## Project rules (.norma/rules/)\n${parts.join("\n\n")}`);
    }

    // File-based memory (MEMDIR, T1; bucket switch added by Dreaming Phase 7b): supersedes the
    // tool-based phase-5b memory below WHENEVER a `memory` config was supplied (daemon.ts always
    // supplies one in production — only tests that don't care about memory omit it) AND it's
    // enabled. Two live buckets share that gate: `memoryBucket: "assistant"` (dispatch/assistant
    // sessions — the shared `_assistant` dream bucket, keyed off nothing but `memory` itself, no
    // cwd needed) takes priority when requested; otherwise the ORIGINAL project bucket applies
    // whenever there's also a cwd to derive a project dir from (no cwd → no project to key off,
    // same "nothing to inject" outcome the legacy branch reaches for its own project-scoped half
    // when `cwd` is null). Absent config (deliberately no `else memory.enabled() === false`
    // special case — see MemoryContextConfig's own doc comment), disabled memory, or (for the
    // project bucket) a null cwd all fall through to the UNCHANGED legacy branch, so every
    // existing caller/test keeps its exact prior behavior.
    if (this.memory && this.memory.enabled() && input.memoryBucket === "assistant") {
      // Dreaming (Phase 7b): assistant-mode sessions load the shared dream bucket INSTEAD of the
      // cwd MEMDIR, and get NO memory-protocol block — they have no write tools; memories come
      // from dream cycles, and their base prompt already says so.
      const indexPath = join(this.memory.assistantDir(), "MEMORY.md");
      const idx = readMemory(indexPath, MEMDIR_INDEX_MAX_LINES, MEMDIR_INDEX_MAX_BYTES);
      if (idx) {
        sections.push(`<system-reminder>\nAssistant memory index (auto-loaded from ${indexPath}; capped at the first ${MEMDIR_INDEX_MAX_LINES} lines / ${Math.round(MEMDIR_INDEX_MAX_BYTES / 1024)}KB):\n${neutralizeReminderTags(idx)}\n</system-reminder>`);
      }
    } else if (this.memory && cwd && this.memory.enabled()) {
      const memDir = this.memory.dirFor(cwd);
      sections.push(memoryProtocol(memDir));
      const idx = readMemory(join(memDir, "MEMORY.md"), MEMDIR_INDEX_MAX_LINES, MEMDIR_INDEX_MAX_BYTES);
      // Absent MEMORY.md (a fresh project, or one with no saved facts yet) → skip this section
      // entirely, zero cost — the protocol block above is injected regardless, so the model still
      // knows the mechanism exists even with nothing yet to recall.
      if (idx) {
        sections.push(
          `<system-reminder>\nProject memory index (auto-loaded from ${join(memDir, "MEMORY.md")}; capped at the first ${MEMDIR_INDEX_MAX_LINES} lines / ${Math.round(MEMDIR_INDEX_MAX_BYTES / 1024)}KB):\n${neutralizeReminderTags(idx)}\n</system-reminder>`,
        );
      }
    } else {
      const mem: string[] = [];
      const userMem = readMemory(join(this.normaHome, "memory", "MEMORY.md"), this.caps.memoryLines, this.caps.memoryBytes);
      if (userMem) mem.push(`### User memory\n${userMem}`);
      if (cwd && trusted) {
        const projMem = readMemory(join(cwd, ".norma", "memory", "MEMORY.md"), this.caps.memoryLines, this.caps.memoryBytes);
        if (projMem) mem.push(`### Project memory\n${projMem}`);
      }
      if (mem.length) sections.push(`## Memory\n${mem.join("\n\n")}`);
    }

    const metas = this.skills.list({ cwd });
    // CM branch review (Important 1 follow-on): only advertise "call the `Skill` tool" when it's
    // actually offered — `skillToolOffered !== false` keeps every pre-existing caller (which never
    // passes this field) byte-identical. When it's explicitly false AND there are skills to have
    // listed, the whole capabilities section collapses to nothing below (capLines.length stays 1)
    // rather than dangling on an empty "## Available capabilities" header with no body.
    const skillToolOffered = input.skillToolOffered !== false;
    const capLines: string[] = ["## Available capabilities"];
    if (metas.length && skillToolOffered) {
      capLines.push("### Skills — call the `Skill` tool with a skill name to load its full instructions before using it");
      for (const m of metas) capLines.push(`- **${m.name}** — ${m.description}`);
    } else if (!metas.length) {
      capLines.push("No skills are installed.");
    }
    const loaded = (input.loadedSkills ?? [])
      .map((n) => this.skills.load(n, { cwd }))
      .filter((x): x is { name: string; body: string } => x !== null);
    if (loaded.length) {
      capLines.push("### Loaded skills");
      for (const s of loaded) capLines.push(`#### ${s.name}\n${s.body}`);
    }
    if (capLines.length > 1) sections.push(capLines.join("\n"));

    return sections.join("\n\n");
  }
}
