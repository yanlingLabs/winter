import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, type SecretStore } from "../../src/auth/secret-store";
import {
  CREDENTIAL_MATERIAL_NAMES,
  clearCredentialMaterial,
  migrateLegacyCredentialMaterial,
  readCredentialMaterial,
  readOpenAiApiKey,
  writeCredentialMaterial,
  writeOpenAiApiKey,
  type CredentialMaterial,
} from "../../src/auth/credential-material";
import { CodexAuthStore, CODEX_SECRET_NAMES } from "../../src/providers/codex-oauth";
import { OPENAI_API_KEY_SECRET } from "../../src/providers/manager";

function store(): FileSecretStore {
  return new FileSecretStore(mkdtempSync(join(tmpdir(), "norma-cred-material-")));
}

// -------------------------------------------------------------------------------------------
// mirror of winter-agent-sdk v0.0.4 keychain-store.ts coerceMaterial — the child's parser; not
// exported. Copied here (api-key + oauth arms only, the only two Norma ever writes) so this test
// verifies the ACTUAL contract the spawned child enforces, independent of our own module's
// internal validation, which could drift from the child's without anyone noticing.
// -------------------------------------------------------------------------------------------
const MATERIAL_KINDS = new Set(["api-key", "bearer", "oauth", "aws", "gcp-service-account", "gcp-access-token"]);
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
    // (bearer / aws / gcp arms omitted — Norma never writes them)
    default:
      return undefined;
  }
}

describe("child-parser contract (winter-agent-sdk coerceMaterial)", () => {
  test("tripwire (hotfix review r1, m2): the installed winter-agent-sdk is the version the coerceMaterial mirror above was copied from — re-diff it on a bump", () => {
    // the coerceMaterial mirror above was copied from this version — re-diff it on a bump
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("@yanlinglabs/winter-agent-sdk/package.json");
    const pkg = require(pkgPath) as { version: string };
    expect(pkg.version).toBe("0.0.4");
  });


  test("CodexAuthStore.save() writes codex-oauth:default as JSON the child's parser accepts, with every field present", async () => {
    const s = store();
    await new CodexAuthStore(s).save({
      accessToken: "a", refreshToken: "r", idToken: "i", accountId: "acc", expiresAt: 1_800_000_000_000,
    });
    const raw = await s.get(CREDENTIAL_MATERIAL_NAMES.codexOauth);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    const coerced = coerceMaterial(parsed);
    expect(coerced).toEqual({
      kind: "oauth", accessToken: "a", refreshToken: "r", idToken: "i", accountId: "acc", expiresAt: 1_800_000_000_000,
    });
    expect(typeof (coerced as { expiresAt: unknown }).expiresAt).toBe("number");
  });

  test("writeOpenAiApiKey() writes openai:default as JSON the child's parser accepts", async () => {
    const s = store();
    await writeOpenAiApiKey(s, "sk-x");
    const raw = await s.get(CREDENTIAL_MATERIAL_NAMES.openai);
    const coerced = coerceMaterial(JSON.parse(raw!));
    expect(coerced).toEqual({ kind: "api-key", key: "sk-x" });
  });

  test("a blanked record ('') is what clearCredentialMaterial writes, and readCredentialMaterial returns null for it — presence must gate the spawn because the child JSON.parses ANY non-null string", async () => {
    const s = store();
    await writeOpenAiApiKey(s, "sk-x");
    await clearCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.openai);
    expect(await s.get(CREDENTIAL_MATERIAL_NAMES.openai)).toBe("");
    expect(await readCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.openai)).toBeNull();
  });

  test("writeOpenAiApiKey blanks the legacy raw record so a rotated key is never left live under the old name (hotfix review r1, m4)", async () => {
    const s = store();
    await s.set(OPENAI_API_KEY_SECRET, "sk-old-stale");
    await writeOpenAiApiKey(s, "sk-new");
    expect(await s.get(OPENAI_API_KEY_SECRET)).toBe("");
    expect(await readOpenAiApiKey(s)).toBe("sk-new");
  });
});

describe("migrateLegacyCredentialMaterial", () => {
  test("legacy five present + material absent -> codexOauth migrated, mapped fields, numeric expiresAt", async () => {
    const s = store();
    await s.set(CODEX_SECRET_NAMES.access, "at_legacy");
    await s.set(CODEX_SECRET_NAMES.refresh, "rt_legacy");
    await s.set(CODEX_SECRET_NAMES.id, "id_legacy");
    await s.set(CODEX_SECRET_NAMES.account, "acct_legacy");
    await s.set(CODEX_SECRET_NAMES.expires, "1800000000000");

    const report = await migrateLegacyCredentialMaterial(s);
    expect(report.codexOauth).toBe("migrated");

    const material = await readCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.codexOauth);
    expect(material).toEqual({
      kind: "oauth", accessToken: "at_legacy", refreshToken: "rt_legacy", idToken: "id_legacy",
      accountId: "acct_legacy", expiresAt: 1_800_000_000_000,
    });
    expect(typeof (material as { expiresAt: unknown }).expiresAt).toBe("number");
  });

  test("legacy openai-api-key present -> openai migrated", async () => {
    const s = store();
    await s.set(OPENAI_API_KEY_SECRET, "sk-legacy");
    const report = await migrateLegacyCredentialMaterial(s);
    expect(report.openai).toBe("migrated");
    expect(await readOpenAiApiKey(s)).toBe("sk-legacy");
  });

  test("idempotent: a second run reports present, record byte-identical", async () => {
    const s = store();
    await s.set(OPENAI_API_KEY_SECRET, "sk-legacy");
    await s.set(CODEX_SECRET_NAMES.access, "at_legacy");
    await migrateLegacyCredentialMaterial(s);
    const openaiBefore = await s.get(CREDENTIAL_MATERIAL_NAMES.openai);
    const codexBefore = await s.get(CREDENTIAL_MATERIAL_NAMES.codexOauth);

    const second = await migrateLegacyCredentialMaterial(s);
    expect(second).toEqual({ openai: "present", codexOauth: "present" });
    expect(await s.get(CREDENTIAL_MATERIAL_NAMES.openai)).toBe(openaiBefore);
    expect(await s.get(CREDENTIAL_MATERIAL_NAMES.codexOauth)).toBe(codexBefore);
  });

  test("existing material wins: fresh material + stale legacy -> present, material unchanged", async () => {
    const s = store();
    await writeCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "fresh" });
    await s.set(CODEX_SECRET_NAMES.access, "stale");

    const report = await migrateLegacyCredentialMaterial(s);
    expect(report.codexOauth).toBe("present");
    expect(await readCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.codexOauth)).toEqual({ kind: "oauth", accessToken: "fresh" });
  });

  test("blank legacy -> absent, nothing written", async () => {
    const s = store();
    const report = await migrateLegacyCredentialMaterial(s);
    expect(report).toEqual({ openai: "absent", codexOauth: "absent" });
    expect(await s.get(CREDENTIAL_MATERIAL_NAMES.openai)).toBeNull();
    expect(await s.get(CREDENTIAL_MATERIAL_NAMES.codexOauth)).toBeNull();
  });

  test("missing codex-expires-at -> material without expiresAt", async () => {
    const s = store();
    await s.set(CODEX_SECRET_NAMES.access, "at_legacy");
    const report = await migrateLegacyCredentialMaterial(s);
    expect(report.codexOauth).toBe("migrated");
    const material = await readCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.codexOauth);
    expect(material).toEqual({ kind: "oauth", accessToken: "at_legacy" });
    expect(Object.prototype.hasOwnProperty.call(material, "expiresAt")).toBe(false);
  });

  test("a store whose get throws for one name -> that slot absent, the other slot still processed, no throw", async () => {
    class PartlyThrowingStore implements SecretStore {
      constructor(private readonly inner: SecretStore) {}
      async get(name: string): Promise<string | null> {
        if (name === CODEX_SECRET_NAMES.access) throw new Error("keychain locked");
        return this.inner.get(name);
      }
      async set(name: string, value: string): Promise<void> {
        await this.inner.set(name, value);
      }
    }
    const inner = store();
    await inner.set(OPENAI_API_KEY_SECRET, "sk-legacy");
    const s = new PartlyThrowingStore(inner);

    const report = await migrateLegacyCredentialMaterial(s);
    expect(report.codexOauth).toBe("absent");
    expect(report.openai).toBe("migrated");
  });
});

describe("CodexAuthStore.load()", () => {
  test("material first, fields mapped back, absent optional fields -> null, expiresAt ?? 0", async () => {
    const s = store();
    await writeCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at_m" });
    const tokens = await new CodexAuthStore(s).load();
    expect(tokens).toEqual({ accessToken: "at_m", refreshToken: null, idToken: null, accountId: null, expiresAt: 0 });
  });

  test("legacy fallback when material absent", async () => {
    const s = store();
    await s.set(CODEX_SECRET_NAMES.access, "at_legacy");
    await s.set(CODEX_SECRET_NAMES.refresh, "rt_legacy");
    await s.set(CODEX_SECRET_NAMES.expires, "1800000000000");
    const tokens = await new CodexAuthStore(s).load();
    expect(tokens).toEqual({ accessToken: "at_legacy", refreshToken: "rt_legacy", idToken: null, accountId: null, expiresAt: 1_800_000_000_000 });
  });

  test("null when both absent", async () => {
    const s = store();
    expect(await new CodexAuthStore(s).load()).toBeNull();
  });

  test("save() writes ONLY the material name — the five legacy names stay untouched/null", async () => {
    const s = store();
    await new CodexAuthStore(s).save({ accessToken: "a", refreshToken: "r", idToken: "i", accountId: "acc", expiresAt: 1 });
    expect(await s.get(CREDENTIAL_MATERIAL_NAMES.codexOauth)).not.toBeNull();
    for (const name of Object.values(CODEX_SECRET_NAMES)) {
      expect(await s.get(name)).toBeNull();
    }
  });

  test("a load→save round-trip of tokens with no expiry does not persist expiresAt: 0 (hotfix review r1, n1)", async () => {
    const s = store();
    await writeCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at_m" }); // no expiresAt stored
    const authStore = new CodexAuthStore(s);
    const loaded = await authStore.load();
    expect(loaded?.expiresAt).toBe(0); // OAuthTokens' own "unknown expiry" default (load()'s `?? 0`)
    await authStore.save(loaded!);
    const material = await readCredentialMaterial(s, CREDENTIAL_MATERIAL_NAMES.codexOauth);
    expect(material).toEqual({ kind: "oauth", accessToken: "at_m" });
    expect(Object.prototype.hasOwnProperty.call(material, "expiresAt")).toBe(false);
  });
});

describe("readOpenAiApiKey", () => {
  test("material first", async () => {
    const s = store();
    await writeOpenAiApiKey(s, "sk-m");
    await s.set(OPENAI_API_KEY_SECRET, "sk-legacy"); // material must win over legacy
    expect(await readOpenAiApiKey(s)).toBe("sk-m");
  });

  test("legacy fallback", async () => {
    const s = store();
    await s.set(OPENAI_API_KEY_SECRET, "sk-legacy");
    expect(await readOpenAiApiKey(s)).toBe("sk-legacy");
  });

  test("null when both absent", async () => {
    const s = store();
    expect(await readOpenAiApiKey(s)).toBeNull();
  });
});
