// Pure/isolatable logic behind `winter model ...`, split out of main.ts so it can be
// unit-tested without going through the top-level `if (import.meta.main)` dispatch. Mirrors
// plugin-cli.ts's split: main.ts owns the I/O (loadSettings/saveSettings/connect), this file
// owns the parse/validate decisions.
import { REASONING_EFFORTS, catalogRowsFor, isModelTag, splitTag } from "@yanlinglabs/winter-core";

export type ModelCliAction =
  | { kind: "show" }
  | { kind: "setModel"; slug: string }
  | { kind: "setEffort"; effort: string }
  | { kind: "setModelAndEffort"; slug: string; effort: string }
  // Winter Phase 8d (P8d-8, Task 4.3): the D30 advisor override — its OWN standalone flag form,
  // never combined with a slug/--effort change in the same invocation (mirrors `--effort`'s own
  // "effort-only change" form above, not the combined one below it).
  | { kind: "setAdvisor"; slug: string }
  | { kind: "clearAdvisor" }
  | { kind: "usageError"; message: string };

const USAGE = "usage: winter model [<slug>] [--effort <level>]  |  winter model --effort <level>  |  winter model --advisor <slug|auto>";

/**
 * Parses `winter model`'s argv tail (everything after "model" — i.e. `process.argv.slice(3)`).
 * Forms:
 *   []                          -> show
 *   ["--effort", level]         -> setEffort (effort-only change)
 *   ["--advisor", "auto"]       -> clearAdvisor (P8d-8)
 *   ["--advisor", slug]         -> setAdvisor (P8d-8)
 *   [slug]                      -> setModel
 *   [slug, "--effort", level]   -> setModelAndEffort
 * Anything else (missing effort/advisor value, trailing garbage, an unknown flag in slug
 * position) is a usageError — main.ts prints `.message` and exits 1, never silently guesses.
 */
export function parseModelArgs(args: string[]): ModelCliAction {
  if (args.length === 0) return { kind: "show" };

  if (args[0] === "--effort") {
    const effort = args[1];
    if (!effort || args.length > 2) return { kind: "usageError", message: USAGE };
    return { kind: "setEffort", effort };
  }

  if (args[0] === "--advisor") {
    const value = args[1];
    if (!value || args.length > 2) return { kind: "usageError", message: USAGE };
    return value === "auto" ? { kind: "clearAdvisor" } : { kind: "setAdvisor", slug: value };
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

/** WS-20: validates a model against the tag shape ("<providerId>/<modelId>") AND catalog
 *  provider membership — replaces `validateModelSlug`'s per-provider-type allowlist now that a
 *  model is ALWAYS a provider-qualified tag (`packages/core/src/runtime-sdk/model-tag.ts`, the
 *  one place the shape/lookup rules live). Two distinct failure shapes, so the message always
 *  names the actual defect:
 *    - not tag-shaped at all (`splitTag` throws)      -> "…must be a provider-qualified tag …"
 *    - tag-shaped but the provider isn't pinned         -> "…unknown provider "<id>""
 *  Returns an error message, or undefined when the tag is valid. The sentinel (`unstated/unstated`)
 *  is never a user-settable model — rejected the same as any other non-catalog provider. */
export function validateModelTag(tag: string): string | undefined {
  let providerId: string;
  try {
    providerId = splitTag(tag).providerId;
  } catch {
    return `invalid model "${tag}" — must be a provider-qualified tag "<providerId>/<modelId>"`;
  }
  if (!isModelTag(tag)) {
    return `invalid model "${tag}" — unknown provider "${providerId}"`;
  }
  return undefined;
}

/** Validates a reasoning-effort slug against REASONING_EFFORTS (settings.ts — the wire-valid
 *  universe, measured live against the endpoint, not read off the /models catalogue; see that
 *  constant's own comment). Per-model rejection (e.g. "minimal", which the backend rejects on a
 *  per-model basis) is NOT validated here — the backend rejects unsupported combos itself.
 *  Returns an error message, or undefined when valid. */
export function validateEffort(effort: string): string | undefined {
  if ((REASONING_EFFORTS as readonly string[]).includes(effort)) return undefined;
  return `invalid effort "${effort}" — must be one of: ${REASONING_EFFORTS.join(", ")}`;
}

/** Winter Phase 8d (P8d-8, Task 4.3) + WS-20: validates an advisor TAG — shape/provider first
 *  (`validateModelTag`, the same check every other model write now goes through), then catalog
 *  row membership (`catalogRowsFor`, the SAME catalog `session.setModel`'s handler consults on the
 *  daemon side) so a tag-shaped but nonexistent row (e.g. a typo'd modelId under a real provider)
 *  is still caught. The CLI runs this command with no daemon RPC at all (direct settings.json
 *  read/write, same posture as `validateModelTag` above), so the compiled-in static catalog is the
 *  only universe it can check against. `"auto"` is parsed as `clearAdvisor` before this ever runs
 *  (`parseModelArgs`) — this only ever sees a real candidate tag. Returns an error message, or
 *  undefined when valid. */
export function validateAdvisorSlug(tag: string): string | undefined {
  const shapeErr = validateModelTag(tag);
  if (shapeErr) return shapeErr;
  if (catalogRowsFor(tag).length > 0) return undefined;
  return `invalid advisor model "${tag}" — not in the pinned catalog (use "auto" to clear the override)`;
}

/** WS-20: one row of `sync.config`'s `models[]` — the shape `renderModelListing` groups/labels
 *  from. Mirrors `SyncConfigModel` (`packages/protocol/src/methods.ts`) structurally rather than
 *  importing it, so this stays a pure zero-import function callable from a plain object literal in
 *  tests; the two are kept in sync by the protocol's own schema being the wire source of truth. */
export interface ModelListingRow {
  id: string;
  providerId: string;
  displayName: string;
  facingName?: string;
  efforts: string[];
}

/** WS-20: `winter model` (show) / `/model` (headless fallback)'s catalogue listing — grouped by
 *  provider (first-appearance order, matching the daemon's own catalog order), each row marked
 *  `"  * "` when it is the CURRENT tag else `"    "`, labelled by facing name (falling back to the
 *  bare modelId when the row fills no family slot) with the modelId always shown alongside in
 *  parens so the underlying slug is never hidden behind a display name. Pure string-building — no
 *  I/O, no color codes (the caller wraps ANSI around the whole block if it wants any). */
export function renderModelListing(models: ModelListingRow[], current: string): string {
  const byProvider = new Map<string, ModelListingRow[]>();
  for (const m of models) {
    const rows = byProvider.get(m.providerId);
    if (rows) rows.push(m);
    else byProvider.set(m.providerId, [m]);
  }
  let out = "";
  for (const [providerId, rows] of byProvider) {
    out += `${providerId}\n`;
    for (const m of rows) {
      const modelId = m.id.slice(m.id.indexOf("/") + 1);
      const label = m.facingName ?? modelId;
      const marker = m.id === current ? "  * " : "    ";
      out += `${marker}${label}  (${modelId})\n`;
    }
  }
  return out;
}
