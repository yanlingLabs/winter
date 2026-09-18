// Daemon settings surface (2026-09-17 plan, item 3): the daemon becomes the SINGLE SOURCE for
// `<home>/agents/*.md` subagent definitions. Agent SDK 0.0.16's Winter runtime already parses this
// exact directory itself (`packages/runtime/src/subagents/definitions.ts` in the winter-agent-sdk
// repo — NOT exported from the published `@yanlinglabs/winter-agent-sdk` package, so it cannot be
// imported here), but the official (`claude`) leg has no idea `<home>/agents` exists at all: it
// only ever sees whatever the daemon hands it as `Options.agents`. So the daemon reads and parses
// the directory ITSELF (mirroring the Winter runtime's own field-for-field rules, verbatim where
// they're stated) and passes the result as `Options.agents` on both legs — see
// `runtime-sdk/mode-options.ts`'s `buildWinterOptions` for the Winter leg. The OFFICIAL leg has NO
// sanctioned way to receive it today; see `runtime-sdk/official-options.ts`'s own comment on this
// module for the measured reason (a router-package wall, not an agent-SDK one).
//
// This is a REIMPLEMENTATION, not a copy — the source lives in a sibling repository this package
// does not depend on. It follows `skills.ts`'s own in-repo precedent for a small, dependency-free
// frontmatter parser (no YAML dependency anywhere in this workspace) rather than inventing a third
// shape.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, PermissionMode } from "@yanlinglabs/winter-agent-sdk";

/** One rejected `<home>/agents/*.md` file — never silently skipped (measured against the SDK's own
 *  posture: a missing `name`/`description` is a rejection with a reason, not a silent drop). */
export interface AgentDefinitionRejection {
  path: string;
  reason: string;
}

export type ParsedAgentDefinitionResult =
  | { ok: true; name: string; definition: AgentDefinition }
  | { ok: false; path: string; reason: string };

interface FrontmatterResult {
  attrs: Record<string, string>;
  body: string;
}

const FRONTMATTER_DELIM = /^---\s*$/;

/** Flat `key: value` frontmatter only — every field this parser accepts is a bare scalar or a
 *  comma-separated list, never nested YAML (mirrors the SDK's own scope statement verbatim). A
 *  line this parser doesn't recognize is skipped, never guessed at. Unterminated frontmatter (no
 *  closing `---`) treats the WHOLE file as body — never throws. */
function parseFrontmatter(raw: string): FrontmatterResult {
  const lines = raw.split(/\r\n|\n/);
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0] ?? "")) {
    return { attrs: {}, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) return { attrs: {}, body: raw };
  const attrs: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2] ?? "";
    attrs[key] = value.trim().replace(/^["']|["']$/g, "");
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { attrs, body };
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const stripped = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  const items = stripped
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function isMemoryValue(v: string | undefined): v is "user" | "project" | "local" {
  return v === "user" || v === "project" || v === "local";
}

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
function isPermissionMode(v: string | undefined): v is PermissionMode {
  return v !== undefined && (PERMISSION_MODES as readonly string[]).includes(v);
}

function toEffortValue(raw: string): NonNullable<AgentDefinition["effort"]> {
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed as NonNullable<AgentDefinition["effort"]>;
}

/** A name may not start with `-` (collides with a flag-like spelling) or contain `:` (a Winter/
 *  claude reserved separator elsewhere in tool-identity grammar) — the SAME rule the SDK's own
 *  filesystem loader enforces, verbatim. */
function isValidAgentName(name: string): boolean {
  return name.length > 0 && !name.startsWith("-") && !name.includes(":");
}

/**
 * Parses one `.md` file's raw contents into an `AgentDefinition` (keyed by its OWN frontmatter
 * `name`, never the file's basename — a file with no `name:` is REJECTED, not defaulted). Mirrors
 * the SDK's own `parseAgentDefinitionFile` rule for rule (frontmatter `name`/`description` both
 * required since SDK 0.0.15, `isValidAgentName`'s exact check, a non-empty body required as the
 * prompt) — see this module's own header for why it cannot import that function instead.
 *
 * `model` is carried through VERBATIM (never split at a tag boundary) — a frontmatter agent file's
 * `model:` line names whatever model string the runtime SDK itself accepts for `AgentDefinition.model`,
 * which is not the same vocabulary as Winter's own provider-qualified session tags.
 */
export function parseAgentDefinitionFile(raw: string, path: string): ParsedAgentDefinitionResult {
  const { attrs, body } = parseFrontmatter(raw);
  if (body.trim().length === 0) return { ok: false, path, reason: "no prompt body (the file's content after any frontmatter block is empty)" };

  const name = attrs["name"];
  if (name === undefined || name.trim().length === 0) return { ok: false, path, reason: 'missing required frontmatter field "name"' };
  if (!isValidAgentName(name)) return { ok: false, path, reason: `invalid agent name "${name}" -- must not start with "-" or contain ":"` };

  const description = attrs["description"];
  if (description === undefined || description.trim().length === 0) return { ok: false, path, reason: 'missing required frontmatter field "description"' };

  const tools = splitList(attrs["tools"]);
  const disallowedTools = splitList(attrs["disallowedTools"]);
  const skills = splitList(attrs["skills"]);
  const maxTurnsRaw = attrs["maxTurns"];
  const maxTurns = maxTurnsRaw !== undefined && Number.isFinite(Number(maxTurnsRaw)) ? Number(maxTurnsRaw) : undefined;
  const memory = attrs["memory"];
  const isolation = attrs["isolation"];
  const permissionMode = attrs["permissionMode"];
  const definition: AgentDefinition = {
    description,
    prompt: body,
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(attrs["model"] !== undefined ? { model: attrs["model"] } : {}),
    ...(attrs["initialPrompt"] !== undefined ? { initialPrompt: attrs["initialPrompt"] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(attrs["background"] !== undefined ? { background: attrs["background"] === "true" } : {}),
    ...(isMemoryValue(memory) ? { memory } : {}),
    ...(attrs["effort"] !== undefined ? { effort: toEffortValue(attrs["effort"]) } : {}),
    // A typo'd permissionMode is dropped rather than mis-typed through, same posture `isMemoryValue`
    // and the isolation check just below already apply.
    ...(isPermissionMode(permissionMode) ? { permissionMode } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(isolation === "worktree" || isolation === "remote" ? { isolation } : {}),
    ...(attrs["color"] !== undefined ? { color: attrs["color"] } : {}),
  };
  return { ok: true, name, definition };
}

/**
 * Scans `<home>/agents/*.md`, returning every valid definition (keyed by its frontmatter `name`)
 * plus every rejected file with its reason. Defensive throughout: a missing directory yields zero
 * definitions and zero rejections (never an error); an unreadable individual file is skipped
 * (also never a rejection entry — a rejection is specifically about a file this daemon COULD read
 * but whose content is invalid, not an I/O failure).
 *
 * Deliberately performs a FRESH scan on every call — no caching — so item 3's own requirement ("new
 * files reach the next session hot, no restart") is satisfied by construction: the daemon never has
 * a stale snapshot to invalidate. The directory is small (hand-authored `.md` files), so a fresh
 * `readdirSync` + parse per call is the "cheaper correct" choice here, the same call `mode-options.ts`'s
 * `buildWinterOptions` makes at every session incarnation.
 *
 * Returns BOTH `definitions` (a plain `Record<string, AgentDefinition>` — exactly the shape
 * `Options.agents` wants, `mode-options.ts`'s only consumer today) and `sources` (the same data,
 * but as an array carrying each definition's OWN file path too — `agents.list`'s consumer, which
 * reports "which file" as a diagnostic `definitions` don't have room for once collapsed to a map).
 */
export function loadUserAgentDefinitions(home: string): {
  definitions: Record<string, AgentDefinition>;
  sources: Array<{ name: string; definition: AgentDefinition; path: string }>;
  rejected: AgentDefinitionRejection[];
} {
  const definitions: Record<string, AgentDefinition> = {};
  const sources: Array<{ name: string; definition: AgentDefinition; path: string }> = [];
  const rejected: AgentDefinitionRejection[] = [];
  const dir = join(home, "agents");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { definitions, sources, rejected }; // no agents/ directory at all — nothing, never an error
  }
  for (const entry of files) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, "utf8");
      const parsed = parseAgentDefinitionFile(raw, full);
      if (parsed.ok) {
        definitions[parsed.name] = parsed.definition;
        sources.push({ name: parsed.name, definition: parsed.definition, path: full });
      } else {
        rejected.push({ path: parsed.path, reason: parsed.reason });
      }
    } catch {
      continue; // an unreadable individual file is skipped, never aborts the whole scan
    }
  }
  return { definitions, sources, rejected };
}
