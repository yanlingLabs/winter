/**
 * WS-19 — the credential INVENTORY as a manageable surface: list / set / remove, one library used
 * by every door (the RPC handlers in `ipc/server.ts`, `winter credentials` in the CLI, and through
 * the RPC the Mac app and the phone).
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: names and booleans cross this boundary, never values.
 * Nothing here logs a key, echoes one back in a result, or puts one in an error message — not even
 * a fragment, not even a length. `credential.set`'s value goes from the wire straight into the
 * `SecretStore` and is never read back out by any of these functions.
 *
 * The rows are derived, not enumerated: `credentialInventory()` (`keychain.ts`) is the catalog-
 * derived slot list, and the only things this file adds by hand are the TWO DAEMON TOOL KEYS (Exa,
 * web search), which are not provider credentials at all — they are raw values under their own
 * long-standing secret names (`exa-api-key`/`web-search-api-key`, still read verbatim by the tools
 * and by `sync.config`), and they appear here only because the user manages them the same way.
 */
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialRow as CredentialRowSchema } from "@yanlinglabs/winter-protocol";
import type { z } from "zod";
import type { SecretStore } from "../auth/secret-store";
import type { Settings } from "../settings";
import { CODEX_SECRET_NAMES, readCredentialMaterial, writeCredentialMaterial } from "../auth/credential-material";
import { EXA_API_KEY_SECRET } from "../agent/tools/search";
import { WEB_SEARCH_API_KEY_SECRET } from "../agent/tools/web";
import {
  ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME,
  ANTHROPIC_CREDENTIAL_SECRET_NAME,
  credentialInventory,
  type CredentialSlot,
} from "./keychain";

export type CredentialRow = z.infer<typeof CredentialRowSchema>;
export type CredentialDoor = CredentialRow["door"];

/** The typed refusal vocabulary (W19-4/W19-5), carried on `error.data.code` by the RPC handlers and
 *  printed verbatim by the CLI. `door` rides along only for `credential_kind_unsupported`, naming
 *  the way in that DOES work for that row. */
export type CredentialRefusalCode =
  | "credential_provider_unknown"
  | "credential_kind_unsupported"
  | "credential_value_invalid"
  | "credential_store_unavailable";

export interface CredentialRefusal {
  code: CredentialRefusalCode;
  /** Names the provider and the door. NEVER the value, not even its length. */
  message: string;
  door?: CredentialDoor;
}

/** The two daemon-owned tool keys (A-2). NOT `<id>:default` credential material — raw values under
 *  the names the tools themselves already read, which is why they are a separate table rather than
 *  extra inventory slots. */
const TOOL_ROWS: ReadonlyArray<{ providerId: string; displayName: string; secretName: string }> = [
  { providerId: "exa", displayName: "Exa", secretName: EXA_API_KEY_SECRET },
  { providerId: "web-search", displayName: "Web search", secretName: WEB_SEARCH_API_KEY_SECRET },
];

/** Spelled once — `credential-material.ts`'s `CREDENTIAL_MATERIAL_NAMES.codexOauth`, reached
 *  without importing the whole constant into three predicates below. */
const CODEX_SECRET_MATERIAL_NAME = "codex-oauth:default";

/**
 * A slot's fixed presentation — the three fields a client keys a row by (`providerId|door|kind`,
 * A-1) must be STABLE, so `kind` is the kind this SLOT holds, never the kind of whatever happens
 * to be stored in it right now (an empty slot keeps its kind).
 *
 * Two slots are not api-key doors: `codex-oauth:default` is Winter's own OAuth material, reached
 * only through `winter login`; `anthropic:console` is the console broker's bearer, reached only
 * through `provider.login` / `provider.logout`. Everything else in the inventory is an api-key slot
 * this RPC can write.
 */
function presentationFor(slot: CredentialSlot): { kind: CredentialRow["kind"]; manageable: boolean; door: CredentialDoor } {
  if (slot.secretName === CODEX_SECRET_MATERIAL_NAME) return { kind: "oauth", manageable: false, door: "cli-oauth" };
  if (slot.secretName === ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME) return { kind: "bearer", manageable: false, door: "provider.login" };
  return { kind: "api-key", manageable: true, door: "credential.set" };
}

/**
 * The anthropic accounts each answer exactly ONE material kind (`keychain.ts`'s own
 * `ANTHROPIC_ACCOUNT_ALLOWED_KIND` gate, mirrored here so `present` agrees with what the seam would
 * actually serve): an api-key sitting in the console account is NOT "console present".
 */
const ACCOUNT_REQUIRED_KIND: Readonly<Record<string, "api-key" | "bearer">> = {
  [ANTHROPIC_CREDENTIAL_SECRET_NAME]: "api-key",
  [ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME]: "bearer",
};

/** Presence for one inventory slot: parseable material (`credentialPresenceFrom`'s own rule — a
 *  blank or unparseable record is ABSENT, never "present with something the child will reject"),
 *  narrowed by the account's required kind where it has one. A store failure reads as absent, the
 *  same as everywhere else; it is never allowed to fail the whole list. */
async function slotPresent(store: SecretStore, slot: CredentialSlot): Promise<boolean> {
  try {
    const material = await readCredentialMaterial(store, slot.secretName);
    if (material === null) return false;
    const required = ACCOUNT_REQUIRED_KIND[slot.secretName];
    return required === undefined || material.kind === required;
  } catch {
    return false;
  }
}

/** Presence for a raw tool key: a non-empty stored value. No JSON, no material wrapper — the tools
 *  read these verbatim and always have. */
async function rawPresent(store: SecretStore, name: string): Promise<boolean> {
  try {
    return Boolean(await store.get(name));
  } catch {
    return false;
  }
}

/**
 * W19-3's body. ONE ROW PER INVENTORY SLOT (A-1), so `anthropic` appears twice — the api-key slot
 * (`door: "credential.set"`, manageable) and the console slot (`door: "provider.login"`, not
 * manageable) — followed by the two tool rows.
 *
 * LIVE on every call: presence is re-probed, never a boot snapshot, which is what makes
 * `credential.set` followed immediately by `credential.list` (W19-8) agree with no restart. The
 * probes are issued together for the same reason `credentialPresenceFrom` parallelises its own: the
 * inventory is ~150 rows and they are independent reads.
 *
 * `settings` is accepted for symmetry with the rest of this seam's signatures (and so a future row
 * can be settings-aware without changing every caller); nothing reads it today — deliberately, since
 * a row's identity must not move when a setting changes underneath a client that keyed on it.
 */
export async function credentialRows(store: SecretStore, _home?: string, _settings?: Settings | null): Promise<CredentialRow[]> {
  const byId = new Map(loadCatalog().providers.map((p) => [p.id, p]));
  const slots = credentialInventory();
  const [slotPresence, toolPresence] = await Promise.all([
    Promise.all(slots.map((slot) => slotPresent(store, slot))),
    Promise.all(TOOL_ROWS.map((row) => rawPresent(store, row.secretName))),
  ]);
  const rows: CredentialRow[] = [];
  slots.forEach((slot, i) => {
    const descriptor = byId.get(slot.provider);
    // A slot whose catalog row vanished under a bump: skipped rather than rendered with invented
    // metadata. The derivation itself cannot produce one (it reads the same catalog), so this can
    // only ever fire for the hand-written head rows — and a missing `codex-oauth`/`anthropic` row is
    // exactly the drift `keychain.test.ts`'s catalog-alignment pin exists to catch loudly.
    if (descriptor === undefined || descriptor.risk.class === "blocked") return;
    const { kind, manageable, door } = presentationFor(slot);
    rows.push({
      providerId: slot.provider,
      displayName: descriptor.displayName,
      group: "provider",
      authKinds: [...descriptor.authKinds],
      manageable,
      present: slotPresence[i]!,
      kind,
      risk: descriptor.risk.class === "review-required" ? "review-required" : "approved",
      door,
    });
  });
  TOOL_ROWS.forEach((row, i) => {
    rows.push({
      providerId: row.providerId,
      displayName: row.displayName,
      group: "tool",
      authKinds: ["api-key"],
      manageable: true,
      present: toolPresence[i]!,
      kind: "api-key",
      risk: "approved",
      door: "credential.set",
    });
  });
  return rows;
}

/** Where a `providerId` actually stores its value, and how. `material` records are the JSON
 *  `CredentialMaterial` the spawned child parses; `raw` is a bare string (the two tool keys only). */
type WriteTarget = { storage: "material" | "raw"; secretName: string };

/** Resolves a `providerId` to the slot `credential.set` would write, or the typed refusal that
 *  explains why it cannot. `anthropic` always resolves to `anthropic:default` (A-1): the console arm
 *  is not addressable through this door in either direction. */
function setTargetFor(providerId: string): WriteTarget | CredentialRefusal {
  const tool = TOOL_ROWS.find((r) => r.providerId === providerId);
  if (tool !== undefined) return { storage: "raw", secretName: tool.secretName };
  if (providerId === "anthropic") return { storage: "material", secretName: ANTHROPIC_CREDENTIAL_SECRET_NAME };
  if (providerId === "codex-oauth") {
    return {
      code: "credential_kind_unsupported",
      message: "codex-oauth signs in with ChatGPT rather than an API key — run `winter login`",
      door: "cli-oauth",
    };
  }
  const slot = credentialInventory().find((s) => s.provider === providerId);
  if (slot === undefined) {
    return { code: "credential_provider_unknown", message: `no credential slot for provider "${providerId}"` };
  }
  return { storage: "material", secretName: slot.secretName };
}

/**
 * W19-4's value rule, shared by the RPC and the CLI so there is ONE definition of "that is not a
 * usable key". Same character set the CLI's own `invisibleKeyCharWarning` has always rejected
 * (printable ASCII only): a zero-width space picked up while copying from a web page is the common
 * case, and it fails as an invalid HTTP header value much later and far less legibly.
 *
 * NEVER quotes the value, and never reports its length — "too long" says so without saying how long.
 */
export const CREDENTIAL_VALUE_MAX_CHARS = 4096;

export function credentialValueRefusal(value: string): CredentialRefusal | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { code: "credential_value_invalid", message: "the key is empty" };
  if (trimmed.length > CREDENTIAL_VALUE_MAX_CHARS) {
    return { code: "credential_value_invalid", message: "the key is longer than this door accepts" };
  }
  for (const ch of trimmed) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp > 0x7e) {
      return {
        code: "credential_value_invalid",
        message: "the key contains a non-printable or non-ASCII character — often a stray invisible character (like a zero-width space) picked up when copying from a web page. Copy it again and re-paste.",
      };
    }
  }
  return undefined;
}

/**
 * W19-4: store one api-key credential. Returns `undefined` on success, the typed refusal otherwise.
 *
 * The value is TRIMMED and written; it is never read back, never logged and never returned. A store
 * failure becomes `credential_store_unavailable` carrying the error's CLASS only (the same
 * discipline `keychain.ts`'s `describeError` keeps) — a Keychain error message could conceivably
 * embed what it was handed.
 */
export async function setCredential(store: SecretStore, providerId: string, apiKey: string): Promise<CredentialRefusal | undefined> {
  const target = setTargetFor(providerId);
  if ("code" in target) return target;
  const invalid = credentialValueRefusal(apiKey);
  if (invalid !== undefined) return invalid;
  const value = apiKey.trim();
  try {
    if (target.storage === "raw") await store.set(target.secretName, value);
    else await writeCredentialMaterial(store, target.secretName, { kind: "api-key", key: value });
  } catch (err) {
    return {
      code: "credential_store_unavailable",
      message: `the credential could not be stored (${err instanceof Error ? ((err as { code?: unknown }).code ?? err.name) : typeof err})`,
    };
  }
  return undefined;
}

/**
 * W19-5: remove one provider's stored credential. `removed` is false when there was nothing there.
 *
 * REMOVE IS OFFERED INDEPENDENTLY OF `manageable` (A-3): `codex-oauth` cannot be SET through this
 * door but it can be cleared through it, and clearing it means every Codex name — the material
 * record AND the five legacy raw records `winter logout` has always blanked, or a pre-material
 * install would stay signed in through the fallback path. `anthropic` clears `anthropic:default`
 * only; the console arm's own sign-out (`provider.logout` / `winter logout --anthropic-console`) is
 * the only way to clear `anthropic:console`, because that door also has an `ant` profile on disk to
 * remove, which no secret-store delete can do.
 */
export async function removeCredential(store: SecretStore, providerId: string): Promise<{ removed: boolean } | CredentialRefusal> {
  const names = removalNamesFor(providerId);
  if ("code" in names) return names;
  try {
    // Sequential rather than parallel: `removed` must be a faithful "did anything go away", and one
    // name failing must not leave the rest unattempted — the loop below does both, and the set is
    // at most six names.
    let removed = false;
    for (const name of names.names) {
      if (await store.delete(name)) removed = true;
    }
    return { removed };
  } catch (err) {
    return {
      code: "credential_store_unavailable",
      message: `the credential could not be removed (${err instanceof Error ? ((err as { code?: unknown }).code ?? err.name) : typeof err})`,
    };
  }
}

function removalNamesFor(providerId: string): { names: string[] } | CredentialRefusal {
  const tool = TOOL_ROWS.find((r) => r.providerId === providerId);
  if (tool !== undefined) return { names: [tool.secretName] };
  if (providerId === "anthropic") return { names: [ANTHROPIC_CREDENTIAL_SECRET_NAME] };
  if (providerId === "codex-oauth") return { names: [CODEX_SECRET_MATERIAL_NAME, ...Object.values(CODEX_SECRET_NAMES)] };
  const slot = credentialInventory().find((s) => s.provider === providerId);
  if (slot === undefined) {
    return { code: "credential_provider_unknown", message: `no credential slot for provider "${providerId}"` };
  }
  return { names: [slot.secretName] };
}

/** The provider's facing name, for a message that has to say WHICH provider is missing a key.
 *  Falls back to the id — a provider with no catalog row has no better name to offer. */
export function credentialDisplayNameFor(providerId: string): string {
  const tool = TOOL_ROWS.find((r) => r.providerId === providerId);
  if (tool !== undefined) return tool.displayName;
  return loadCatalog().providers.find((p) => p.id === providerId)?.displayName ?? providerId;
}
