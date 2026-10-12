// `winter -p ... --model <providerId>/<modelId>`: the one-shot model choice for the session `-p` creates.
// Pure/isolatable logic, split out of main.ts like model-cli.ts so it is unit-testable without the
// top-level `import.meta.main` dispatch: the argv parse, the offline tag check, and the one
// daemon-side step (the `sync.config` list check + `session.create`) behind a fake-able client.
//
// The rules mirror what the daemon does with `session.create`'s `model` (ipc/server.ts's
// `resolveModelSelection`): a renamed catalog tag is canonicalised at parse, the tag must be
// provider-qualified with a pinned provider, `unstated/unstated` and `winter-test/*` are never a
// user's choice, and the tag must resolve to a catalog row (or a facing name, `anthropic/sonnet`) --
// all of that is `validateModelTag`/`canonicalizeModelTag`, shared with `winter model`. On top of the
// daemon's rules a catalog row must also be in the list `sync.config` offers (the credentialed
// providers' rows), so a model the home has no key for is refused here, before a session exists,
// instead of at the first turn. An unlisted model the daemon passes through verbatim (a provider's
// own `settings.providers.<id>.baseUrl` endpoint, or a provider with no catalog rows) cannot be in
// that list by construction and is let through exactly as the daemon lets it.
import { canonicalizeModelTag, rowForTag, splitTag, isModelTag, UNSTATED_TAG, WINTER_TEST_PREFIX } from "@yanlinglabs/winter-core";
import type { Settings } from "@yanlinglabs/winter-core";
import { METHODS, ModelTagSchema, SyncConfigModel, type ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import type { WinterClient } from "./client";
import { validateModelTag } from "./model-cli";

export const PRINT_USAGE = 'usage: winter -p "<prompt>" [--auto|--plan] [--trust|--no-trust] [--model <providerId>/<modelId>]';

/** Where a refused `--model` points: `winter model` prints the catalogue a live daemon offers. */
const LIST_HINT = "Run `winter model` to list the models you can use.";

export type PrintArgs =
  | { kind: "ok"; prompt: string | undefined; model: string | undefined }
  | { kind: "usageError"; message: string };

/**
 * Parses `winter -p`'s argv tail (everything after "-p", i.e. `process.argv.slice(3)`).
 *
 * `--model <tag>` / `--model=<tag>` is removed from the list and the prompt is the first thing left,
 * so with no `--model` the prompt is exactly `args[0]` -- what `-p` has always read as `argv[3]` --
 * and `-p --model <tag> "<prompt>"` works as well as `-p "<prompt>" --model <tag>`. The policy flags
 * (`--auto`, `--plan`, `--trust`, `--no-trust`) stay where they are: main.ts reads those off argv itself.
 *
 * A missing value (end of argv, an empty string, or a value that is itself a flag) and a repeated
 * `--model` are usage errors -- nothing is guessed.
 */
export function parsePrintArgs(args: readonly string[]): PrintArgs {
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "--model") {
      const next = args[i + 1];
      if (next === undefined || next === "" || next.startsWith("-")) {
        return { kind: "usageError", message: `${PRINT_USAGE} — --model needs a model tag. ${LIST_HINT}` };
      }
      value = next;
      i++;
    } else if (arg.startsWith("--model=")) {
      value = arg.slice("--model=".length);
      if (value === "") return { kind: "usageError", message: `${PRINT_USAGE} — --model needs a model tag. ${LIST_HINT}` };
    } else {
      rest.push(arg);
      continue;
    }
    if (model !== undefined) return { kind: "usageError", message: `${PRINT_USAGE} — --model may be given only once` };
    model = value;
  }
  return { kind: "ok", prompt: rest[0], model };
}

/** A `--model` the offline checks accepted: the canonical tag the daemon would store, and whether it is
 *  a catalog row (so `sync.config` is expected to list it) or a pass-through the daemon accepts unlisted. */
export interface PrintModel {
  tag: string;
  catalogRow: boolean;
}

export type PrintModelCheck = { ok: true; model: PrintModel } | { ok: false; message: string };

/**
 * Everything that needs no daemon: the tag's shape, the pinned provider, the catalog (or BYO-endpoint)
 * membership, and the facing-name / renamed-tag canonicalisation. Run BEFORE `connect()`, which
 * launches Winter.app when the daemon is down -- a typo must never open a socket. `settings` (optional,
 * best effort) carries the BYO-endpoint leniency `validateModelTag` and `canonicalizeModelTag` share.
 */
export function checkPrintModelOffline(typed: string, settings?: Settings): PrintModelCheck {
  // The daemon parses `session.create`'s `model` through `ModelTagSchema`, which resolves a renamed
  // catalog tag to its current key first; do the same, and fall back to what was typed when it is not
  // even tag-shaped (the checks below then name that).
  const wire = ModelTagSchema.safeParse(typed);
  const tag = wire.success ? wire.data : typed;
  if (validateModelTag(tag, settings) !== undefined) return { ok: false, message: offlineRefusal(typed, tag) };
  const canonical = canonicalizeModelTag(tag, settings);
  if (canonical === undefined) return { ok: false, message: offlineRefusal(typed, tag) };
  return { ok: true, model: { tag: canonical, catalogRow: rowForTag(canonical) !== undefined } };
}

/** The wording only: `validateModelTag` already decided the tag is not acceptable. */
function offlineRefusal(typed: string, tag: string): string {
  let providerId: string;
  let modelId: string;
  try {
    ({ providerId, modelId } = splitTag(tag));
  } catch {
    return `--model "${typed}" is not a provider-qualified tag — use "<providerId>/<modelId>". ${LIST_HINT}`;
  }
  // The "nothing recorded" sentinel and the test doubles are shaped like tags but are never a user's choice.
  if (tag === UNSTATED_TAG || tag.startsWith(WINTER_TEST_PREFIX)) {
    return `--model "${typed}" is not a provider-qualified tag — use "<providerId>/<modelId>". ${LIST_HINT}`;
  }
  if (!isModelTag(tag)) return `--model "${typed}": unknown provider "${providerId}". ${LIST_HINT}`;
  return `--model "${typed}": unknown model '${modelId}' for provider ${providerId}. ${LIST_HINT}`;
}

type DaemonCheck = { ok: true } | { ok: false; message: string };

/** The daemon-side half: is the (canonical) catalog tag one `sync.config` offers? Not asked at all
 *  for an unlisted pass-through model. A daemon that cannot answer is a refusal, never a guess. */
async function checkOffered(c: Pick<WinterClient, "request">, model: PrintModel): Promise<DaemonCheck> {
  if (!model.catalogRow) return { ok: true };
  let raw: unknown;
  try {
    raw = await c.request(METHODS.syncConfig, {});
  } catch (err) {
    return { ok: false, message: `--model "${model.tag}": could not read this daemon's model list (${err instanceof Error ? err.message : String(err)}).` };
  }
  const parsed = SyncConfigModel.array().safeParse((raw as { models?: unknown } | undefined)?.models);
  if (!parsed.success) {
    return { ok: false, message: `--model "${model.tag}": could not read this daemon's model list (an unexpected answer — is the daemon up to date?).` };
  }
  if (parsed.data.some((m) => m.id === model.tag)) return { ok: true };
  const { providerId } = splitTag(model.tag);
  if (parsed.data.length === 0) {
    return {
      ok: false,
      message: `--model "${model.tag}": this daemon offers no models yet — add a provider credential first (\`winter credentials set ${providerId}\`).`,
    };
  }
  return {
    ok: false,
    message: `--model "${model.tag}" is not in this daemon's model list (provider ${providerId} has no stored credential, or the model is not offered to sessions). ${LIST_HINT}`,
  };
}

export type PrintSessionResult =
  | { ok: true; sessionId: string; trusted: boolean }
  | { ok: false; message: string };

/**
 * `-p`'s session creation. With a `--model` it first checks the tag against the daemon's `sync.config`
 * list and creates NOTHING on a refusal; the accepted canonical tag rides `session.create`'s `model`
 * (the daemon validates and stamps it again -- this check only makes the refusal early and clear).
 * Without one it is the plain `createSession` call `-p` always made.
 */
export async function createPrintSession(
  c: Pick<WinterClient, "request" | "createSession">,
  opts: { cwd: string; approvalPolicy: ApprovalPolicy; model?: PrintModel },
): Promise<PrintSessionResult> {
  if (opts.model !== undefined) {
    const offered = await checkOffered(c, opts.model);
    if (!offered.ok) return offered;
  }
  const created = await c.createSession("global", {
    cwd: opts.cwd,
    approvalPolicy: opts.approvalPolicy,
    ...(opts.model !== undefined ? { model: opts.model.tag } : {}),
  });
  return { ok: true, sessionId: created.sessionId, trusted: created.trusted };
}
