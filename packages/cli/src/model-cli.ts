// Pure/isolatable logic behind `winter model ...`, split out of main.ts so it can be
// unit-tested without going through the top-level `if (import.meta.main)` dispatch. Mirrors
// plugin-cli.ts's split: main.ts owns the I/O (loadSettings/saveSettings/connect), this file
// owns the parse/validate decisions.
import { REASONING_EFFORTS, rowForTag, isModelTag, modelTagIsKnown, splitTag, UNSTATED_TAG, WINTER_TEST_PREFIX, internalEligibleProviderIds } from "@yanlinglabs/winter-core";
import type { Settings } from "@yanlinglabs/winter-core";

export type ModelCliAction =
  | { kind: "show" }
  | { kind: "setModel"; slug: string; confirmLossy?: boolean }
  | { kind: "setEffort"; effort: string }
  | { kind: "setModelAndEffort"; slug: string; effort: string; confirmLossy?: boolean }
  // Winter Phase 8d (P8d-8, Task 4.3): the D30 advisor override — its OWN standalone flag form,
  // never combined with a slug/--effort change in the same invocation (mirrors `--effort`'s own
  // "effort-only change" form above, not the combined one below it).
  | { kind: "setAdvisor"; slug: string }
  | { kind: "clearAdvisor" }
  | { kind: "usageError"; message: string };

const USAGE = "usage: winter model [<tag>] [--effort <level>] [--confirm]  |  winter model --effort <level>  |  winter model --advisor <tag|auto>";

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

  // `--confirm` (2026-09-16): the one-shot lossy-handoff confirmation for the ATTACHED session's
  // `session.setModel` (`confirmLossy: true` on that call only, never stored). Accepted anywhere
  // after the slug; `winter model` (no session) ignores it.
  const confirmLossy = args.includes("--confirm");
  const rest = args.slice(1).filter((a) => a !== "--confirm");
  const confirm = confirmLossy ? { confirmLossy: true } : {};

  if (rest.length === 0) return { kind: "setModel", slug, ...confirm };

  if (rest[0] === "--effort") {
    const effort = rest[1];
    if (!effort || rest.length > 2) return { kind: "usageError", message: USAGE };
    return { kind: "setModelAndEffort", slug, effort, ...confirm };
  }

  return { kind: "usageError", message: USAGE };
}

/** WS-20 (review fix): the ONE shared "strip the '<providerId>/' prefix for DISPLAY" helper —
 *  every surface that shows a model to the user (not just this file's own `renderModelListing`)
 *  imports this rather than re-deriving it: the TUI welcome banner and the T5 status-chrome footer
 *  (`packages/cli/src/tui/app.tsx`, `state.ts`) both do. Splits at the FIRST `/` via core's own
 *  `splitTag`, falling back to the raw value on anything not tag-shaped (a pre-migration bare
 *  model, or any other non-catalog string) — never throws, since this is a label helper, not a
 *  validator (see `validateModelTag` for that). */
export function modelIdPortion(tag: string): string {
  try {
    return splitTag(tag).modelId;
  } catch {
    return tag;
  }
}

/** WS-20 (review fix, Nit 1): a free-text CLI line's "model, with the provider as a hint" shape —
 *  `modelIdPortion` alone (never the raw tag), the providerId trailing in parens as a secondary
 *  hint rather than concatenated into one opaque string. A no-op fallback to the raw value on
 *  anything not tag-shaped, same posture as `modelIdPortion` itself. */
export function modelDisplayWithHint(tag: string): string {
  try {
    const { providerId, modelId } = splitTag(tag);
    return `${modelId} (${providerId})`;
  } catch {
    return tag;
  }
}

/** WS-20 (review fix, item 4): validates a model against the tag shape ("<providerId>/<modelId>"),
 *  catalog PROVIDER membership, and now catalog MODEL membership too — replaces
 *  `validateModelSlug`'s per-provider-type allowlist now that a model is ALWAYS a
 *  provider-qualified tag (`packages/core/src/runtime-sdk/model-tag.ts`, the one place the
 *  shape/lookup rules live). Distinct failure shapes, so the message always names the actual
 *  defect:
 *    - not tag-shaped at all (`splitTag` throws)      -> "…must be a provider-qualified tag …"
 *    - the `unstated/unstated` sentinel, or a `winter-test/…` double -> same message: NEITHER is a
 *      real, user-settable model — `isModelTag` accepts both as escapes (it exists to validate a
 *      *stored* value, e.g. a session record that may legitimately carry the sentinel), but a
 *      value the USER is trying to SET must never be either.
 *    - tag-shaped but the provider isn't pinned         -> "…unknown provider "<id>""
 *    - a real, pinned provider, but this specific model isn't one of its rows (and no BYO
 *      endpoint override exists for it, `settings.providers.<id>.baseUrl`) -> "unknown model
 *      '<id>' for provider <p>" (`modelTagIsKnown`, core's own membership check — the SAME one the
 *      daemon consults, so this refuses locally exactly what the daemon would refuse remotely).
 *  `settings` is optional (defaulted through to `modelTagIsKnown`) so a caller with no settings in
 *  hand yet still gets the shape/provider-pinned checks; only the model-membership check needs it
 *  (for the BYO-endpoint leniency). Returns an error message, or undefined when the tag is valid. */
export function validateModelTag(tag: string, settings?: Settings): string | undefined {
  if (tag === UNSTATED_TAG || tag.startsWith(WINTER_TEST_PREFIX)) {
    return `invalid model "${tag}" — must be a provider-qualified tag "<providerId>/<modelId>"`;
  }
  let providerId: string;
  let modelId: string;
  try {
    ({ providerId, modelId } = splitTag(tag));
  } catch {
    return `invalid model "${tag}" — must be a provider-qualified tag "<providerId>/<modelId>"`;
  }
  if (!isModelTag(tag)) {
    return `invalid model "${tag}" — unknown provider "${providerId}"`;
  }
  if (!modelTagIsKnown(tag, settings)) {
    return `unknown model '${modelId}' for provider ${providerId}`;
  }
  return undefined;
}

/** `settings.provider.model` may name ANY catalog provider, and since 2026-09-19 so may Winter's own
 *  background jobs — they run on whichever ELIGIBLE provider has a credential
 *  (`internalEligibleProviderIds`, core's settings.ts), independently of this field. So the note is now
 *  only about the ZERO-SETUP case: when the chosen provider is one Winter's jobs cannot be driven over
 *  (a first-party Claude row, or an adapter family the daemon cannot use), those jobs fall back to
 *  another credentialed provider rather than following this model — worth saying once, never a refusal
 *  and never a claim that anything is inert. `undefined` when the provider IS eligible (nothing to say).
 *  Precondition: `tag` is already a validated tag — `splitTag` is called unguarded. */
export function internalProviderNote(tag: string): string | undefined {
  const { providerId } = splitTag(tag);
  if (internalEligibleProviderIds().has(providerId)) return undefined;
  return `note: Winter's own background jobs (titles, the bash safety reviewer, dreaming, the session cleaner) can't run on ${providerId} — they'll use whichever provider you have a usable credential for instead. Your sessions are unaffected.`;
}

/** Validates a reasoning-effort slug against REASONING_EFFORTS (settings.ts — the wire-valid
 *  universe, measured live against the endpoint, not read off the /models catalogue; see that
 *  constant's own comment). Per-model rejection (e.g. "minimal", which the backend rejects on a
 *  per-model basis) is NOT validated here — the backend rejects unsupported combos itself.
 *  Returns an error message, or undefined when valid. */
export function validateEffort(effort: string, tag?: string): string | undefined {
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) return `invalid effort "${effort}" — must be one of: ${REASONING_EFFORTS.join(", ")}`;
  // 2026-09-17: the MODEL decides — a row that declares no vocabulary takes no effort; a row that
  // declares one accepts only its members (plus "none", Winter's unset).
  if (tag === undefined) return undefined;
  const row = rowForTag(tag);
  if (row === undefined) return undefined; // unknown to the catalog (BYO): unconstrained
  const vocab = row.reasoning?.efforts ?? [];
  if (vocab.length === 0) return `model ${modelIdPortion(tag)} (${splitTag(tag).providerId}) takes no reasoning effort — leave it on the provider's default`;
  if (effort === "none" || vocab.includes(effort)) return undefined;
  return `effort "${effort}" is not supported by ${modelIdPortion(tag)} — supported: none, ${vocab.join(", ")}`;
}

/** Winter Phase 8d (P8d-8, Task 4.3) + WS-20: validates an advisor TAG — shape/provider first
 *  (`validateModelTag`, the same check every other model write now goes through), then catalog
 *  row membership (`rowForTag`, the SAME exact-key lookup `session.setModel`'s handler consults on
 *  the daemon side) so a tag-shaped but nonexistent row (e.g. a typo'd modelId under a real
 *  provider) is still caught. The CLI runs this command with no daemon RPC at all (direct
 *  settings.json read/write, same posture as `validateModelTag` above), so the compiled-in static
 *  catalog is the only universe it can check against. `"auto"` is parsed as `clearAdvisor` before
 *  this ever runs (`parseModelArgs`) — this only ever sees a real candidate tag. Returns an error
 *  message, or undefined when valid. */
export function validateAdvisorSlug(tag: string): string | undefined {
  const shapeErr = validateModelTag(tag);
  if (shapeErr) return shapeErr;
  if (rowForTag(tag) !== undefined) return undefined;
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
