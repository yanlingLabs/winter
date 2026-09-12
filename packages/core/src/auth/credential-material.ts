import type { SecretStore } from "./secret-store";
import { OPENAI_API_KEY_SECRET, CODEX_SECRET_NAMES } from "./legacy-secret-names";
import type { OAuthTokens } from "../providers/pkce";

/** Re-exported verbatim so every existing importer of `CODEX_SECRET_NAMES` from the now-deleted
 *  `providers/codex-oauth.ts` keeps working unchanged — see `CodexAuthStore`'s own doc comment. */
export { CODEX_SECRET_NAMES };

/**
 * Hotfix (post-8b, 2026-09-11): the spawned `winter` child resolves a `CredentialRef { kind:
 * "keychain" }` by reading Norma's Keychain ITSELF (`Bun.secrets.get`) and requires the stored
 * value to be JSON-encoded `CredentialMaterial` — `winter-agent-sdk` v0.0.4
 * `packages/runtime/src/provider/keychain-store.ts`'s `coerceMaterial`. Norma used to store RAW
 * token/key strings under the inventory's secret names, which the child's `JSON.parse` rejects
 * outright ("... is not valid JSON credential material"). This module is the SINGLE source of
 * truth for the JSON material records the child actually reads, plus the one-way migration off the
 * legacy raw records.
 */

export type ApiKeyMaterial = { kind: "api-key"; key: string };
export type OauthMaterial = {
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  idToken?: string;
};
/** A bearer credential (Console OAuth, or an approved gateway) — Norma does not write this kind
 *  today (no inventory row uses it), but the seam (`runtime-sdk/keychain.ts`) must still be able to
 *  EXTRACT one correctly for the day a `console-oauth`-family row is added, per the router's
 *  `fetchAuthCredentials` contract (`winter-runtime-sdk` `src/official/auth.ts`), which injects the
 *  seam's returned string verbatim as an env var. */
export type BearerMaterial = { kind: "bearer"; token: string };
export type CredentialMaterial = ApiKeyMaterial | OauthMaterial | BearerMaterial;

/**
 * The Keychain item names `NORMA_CREDENTIAL_INVENTORY` (`runtime-sdk/keychain.ts`) points the
 * Winter child at — `<providerId>:<accountId>` per the SDK's own convention, one fixed `default`
 * account per provider today (no multi-account support yet).
 */
export const CREDENTIAL_MATERIAL_NAMES = { openai: "openai:default", codexOauth: "codex-oauth:default" } as const;

/** Error code/class only — NEVER `.message` (same discipline as `runtime-sdk/keychain.ts`'s
 *  `describeError`; duplicated rather than imported to keep this module out of a cycle with
 *  `runtime-sdk/keychain.ts`, which imports FROM here). */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return code !== undefined ? String(code) : err.name;
  }
  return typeof err;
}

/** The material `kind`s the child's `coerceMaterial` recognizes. `aws`/`gcp-*` are in the child's
 *  own set but have no arm below — Norma never writes or reads them, so they fall through to
 *  `undefined` (malformed) exactly like an unrecognized kind, matching the child's own refusal for
 *  a shape it does not expect from Norma's inventory. `bearer` DOES have an arm (see `BearerMaterial`
 *  above) even though no inventory row writes one today, so the seam can extract it correctly the
 *  day one does. */
const MATERIAL_KINDS = new Set(["api-key", "bearer", "oauth", "aws", "gcp-service-account", "gcp-access-token"]);

/** Structural check mirroring the child's `coerceMaterial` (api-key + oauth + bearer arms). Never
 *  throws; an unrecognized shape is `undefined`. */
function coerceMaterial(value: unknown): CredentialMaterial | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string" || !MATERIAL_KINDS.has(v.kind)) return undefined;
  switch (v.kind) {
    case "api-key":
      return typeof v.key === "string" ? { kind: "api-key", key: v.key } : undefined;
    case "oauth":
      return typeof v.accessToken === "string"
        ? {
            kind: "oauth",
            accessToken: v.accessToken,
            ...(typeof v.refreshToken === "string" ? { refreshToken: v.refreshToken } : {}),
            ...(typeof v.expiresAt === "number" ? { expiresAt: v.expiresAt } : {}),
            ...(typeof v.accountId === "string" ? { accountId: v.accountId } : {}),
            ...(typeof v.idToken === "string" ? { idToken: v.idToken } : {}),
          }
        : undefined;
    case "bearer":
      return typeof v.token === "string" ? { kind: "bearer", token: v.token } : undefined;
    default:
      return undefined; // aws / gcp — Norma never writes or reads these
  }
}

/**
 * `JSON.parse` + the structural check above. Blank/missing (`store.get` returns `null`/`""` — the
 * empty string is what `norma logout`/`clearCredentialMaterial` write, and it must read as "no
 * credential" here exactly like everywhere else in Norma) → `null`, no warning. Malformed (bad
 * JSON, or JSON that doesn't coerce) → `null` + ONE `console.warn` naming the record NAME only —
 * never the stored value.
 */
export async function readCredentialMaterial(store: SecretStore, name: string): Promise<CredentialMaterial | null> {
  const raw = await store.get(name);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[credential-material] "${name}" is not valid JSON`);
    return null;
  }
  const material = coerceMaterial(parsed);
  if (material === undefined) {
    console.warn(`[credential-material] "${name}" is not a recognized credential material shape`);
    return null;
  }
  return material;
}

/** `JSON.stringify`, with any `undefined`-valued field dropped first (defensive — Norma's own
 *  callers already build these via conditional spreads, but a stray `{ ...t, refreshToken:
 *  undefined }` must never round-trip as the literal string `"undefined"` inside the JSON). */
export async function writeCredentialMaterial(store: SecretStore, name: string, material: CredentialMaterial): Promise<void> {
  const clean = Object.fromEntries(Object.entries(material).filter(([, v]) => v !== undefined));
  await store.set(name, JSON.stringify(clean));
}

/** `store.set(name, "")` — `SecretStore` has no delete; an empty string reads as absent everywhere
 *  in Norma (presence is truthiness), including `readCredentialMaterial` above. */
export async function clearCredentialMaterial(store: SecretStore, name: string): Promise<void> {
  await store.set(name, "");
}

/** The OpenAI key: the material record first (`openai:default`), else the legacy raw
 *  `openai-api-key` (read-only fallback — never rewritten here), else `null`. */
export async function readOpenAiApiKey(store: SecretStore): Promise<string | null> {
  const material = await readCredentialMaterial(store, CREDENTIAL_MATERIAL_NAMES.openai);
  if (material?.kind === "api-key") return material.key;
  const legacy = await store.get(OPENAI_API_KEY_SECRET);
  return legacy || null;
}

/**
 * Writes the material record, then blanks the legacy raw `openai-api-key` (hotfix review r1, m4)
 * so a ROTATED key is never left live under the old name — a install that somehow still reads the
 * legacy record (a pre-hotfix binary, a stray direct read) must see the new key was rotated, not
 * the stale one. The blank happens AFTER the material write succeeds (never before: if the write
 * throws, the legacy value — however stale — is left intact rather than the account ending up with
 * no key stored anywhere). This does not need its own migration path: `migrateLegacyCredentialMaterial`'s
 * "material present -> never overwritten" rule already means the now-blank legacy value is simply
 * ignored on the next boot.
 */
export async function writeOpenAiApiKey(store: SecretStore, key: string): Promise<void> {
  await writeCredentialMaterial(store, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key });
  await store.set(OPENAI_API_KEY_SECRET, "");
}

export interface CredentialMigrationReport {
  openai: "migrated" | "present" | "absent";
  codexOauth: "migrated" | "present" | "absent";
}

/** One provider's migration attempt, wholly guarded: ANY throw along the read-legacy/write-material
 *  path (a locked/denied Keychain) is caught, warned with the NAME + error code/class, and reported
 *  as `"absent"` — boot must never die on this, and the other provider's slot must still be
 *  attempted independently (that's why this is one function per provider rather than one shared
 *  try/catch around both). */
async function migrateOpenAi(store: SecretStore): Promise<"migrated" | "present" | "absent"> {
  try {
    const existing = await readCredentialMaterial(store, CREDENTIAL_MATERIAL_NAMES.openai);
    if (existing !== null) return "present"; // never overwritten — legacy values are stale by definition
    const legacy = await store.get(OPENAI_API_KEY_SECRET);
    if (!legacy) return "absent";
    await writeCredentialMaterial(store, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: legacy });
    return "migrated";
  } catch (err) {
    console.warn(`[credential-material] migration for "${CREDENTIAL_MATERIAL_NAMES.openai}" failed: ${describeError(err)}`);
    return "absent";
  }
}

async function migrateCodexOauth(store: SecretStore): Promise<"migrated" | "present" | "absent"> {
  try {
    const existing = await readCredentialMaterial(store, CREDENTIAL_MATERIAL_NAMES.codexOauth);
    if (existing !== null) return "present"; // the child may have refreshed it — never clobbered
    const accessToken = await store.get(CODEX_SECRET_NAMES.access);
    if (!accessToken) return "absent";
    const [refreshToken, idToken, accountId, expiresRaw] = await Promise.all([
      store.get(CODEX_SECRET_NAMES.refresh),
      store.get(CODEX_SECRET_NAMES.id),
      store.get(CODEX_SECRET_NAMES.account),
      store.get(CODEX_SECRET_NAMES.expires),
    ]);
    const expiresAt = expiresRaw ? Number(expiresRaw) : NaN;
    const material: OauthMaterial = {
      kind: "oauth",
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(idToken ? { idToken } : {}),
      ...(accountId ? { accountId } : {}),
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    };
    await writeCredentialMaterial(store, CREDENTIAL_MATERIAL_NAMES.codexOauth, material);
    return "migrated";
  } catch (err) {
    console.warn(`[credential-material] migration for "${CREDENTIAL_MATERIAL_NAMES.codexOauth}" failed: ${describeError(err)}`);
    return "absent";
  }
}

/**
 * Boot-time, idempotent, one-way: for each provider, if the material record is ABSENT and the
 * legacy raw record(s) are present, write the material record from them. If the material record is
 * PRESENT it is NEVER overwritten. Legacy records are left in place (blanked only by `norma
 * logout`). Never logs a value; the report carries status words only. Never throws.
 */
export async function migrateLegacyCredentialMaterial(store: SecretStore): Promise<CredentialMigrationReport> {
  const openai = await migrateOpenAi(store);
  const codexOauth = await migrateCodexOauth(store);
  return { openai, codexOauth };
}

/**
 * P8d-13's dead-provider cleanup relocated this class here from the now-deleted
 * `providers/codex-oauth.ts` (which existed only to house `CodexOAuthProvider`, superseded by
 * `providers/runtime-provider.ts`'s `createCodexOauthRuntimeProvider` — see that module's own
 * header for the ruling). `CodexAuthStore` itself was never part of that ruling: it is the ONLY
 * writer of the `codex-oauth:default` credential material (`norma login`'s OAuth callback,
 * `packages/cli/src/main.ts`) and is unrelated to which `Provider` implementation later reads it.
 *
 * Facade over the `codex-oauth:default` JSON credential material record (post-8b hotfix): the
 * spawned Winter child resolves its `CredentialRef` by reading this SAME record directly off the
 * Keychain and `JSON.parse`-ing it, so `save`/`load` here and the child's own reads/writes (its
 * 401-refresh writes the merged material back to the exact ref it was handed) share ONE token set.
 * `save` no longer touches the five legacy `CODEX_SECRET_NAMES` — those are migration-source/logout
 * only now. `load` falls back to them (read-only) when the material record is absent, so an
 * upgrade from a pre-hotfix install keeps working until the boot-time migration (or this load
 * itself, next save) writes the material record forward.
 */
export class CodexAuthStore {
  constructor(private readonly store: SecretStore) {}

  async save(t: OAuthTokens): Promise<void> {
    await writeCredentialMaterial(this.store, CREDENTIAL_MATERIAL_NAMES.codexOauth, {
      kind: "oauth",
      accessToken: t.accessToken,
      ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
      ...(t.idToken ? { idToken: t.idToken } : {}),
      ...(t.accountId ? { accountId: t.accountId } : {}),
      // Hotfix review r1, n1: mirrors migrateCodexOauth's own guard — an `OAuthTokens.expiresAt`
      // of `0` (this type's own "unknown expiry" default, e.g. after a load() with no legacy
      // `codex-expires-at` at all) must not round-trip into the material as a literal `expiresAt:
      // 0`, which the child would read as "expired since the epoch" rather than "unknown".
      ...(Number.isFinite(t.expiresAt) && t.expiresAt > 0 ? { expiresAt: t.expiresAt } : {}),
    });
  }

  async load(): Promise<OAuthTokens | null> {
    const material = await readCredentialMaterial(this.store, CREDENTIAL_MATERIAL_NAMES.codexOauth);
    if (material?.kind === "oauth") {
      return {
        accessToken: material.accessToken,
        refreshToken: material.refreshToken ?? null,
        idToken: material.idToken ?? null,
        accountId: material.accountId ?? null,
        expiresAt: material.expiresAt ?? 0,
      };
    }
    // Read-only legacy fallback — never rewritten from here (the migration function is the only
    // writer that promotes these into the material record).
    const accessToken = await this.store.get(CODEX_SECRET_NAMES.access);
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: await this.store.get(CODEX_SECRET_NAMES.refresh),
      idToken: await this.store.get(CODEX_SECRET_NAMES.id),
      accountId: await this.store.get(CODEX_SECRET_NAMES.account),
      expiresAt: Number((await this.store.get(CODEX_SECRET_NAMES.expires)) ?? 0),
    };
  }
}
