import { CredentialResolutionError } from "@yanlinglabs/winter-provider-runtime";
import type { CredentialMaterial as RuntimeCredentialMaterial, CredentialRef, CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import type { SecretStore } from "../auth/secret-store";
import { clearCredentialMaterial, readCredentialMaterial, writeCredentialMaterial, type CredentialMaterial as WinterCredentialMaterial } from "../auth/credential-material";

const STORE_NAME = "winter keychain credential store";

/** `@yanlinglabs/winter-provider-runtime`'s `CredentialMaterial` union is a SUPERSET of Winter's own
 *  (it adds `aws`/`gcp-service-account`/`gcp-access-token`, kinds Winter never writes for these two
 *  providers) — narrow to the arms `auth/credential-material.ts`'s `writeCredentialMaterial`
 *  actually accepts, or refuse typed rather than silently dropping a field the write would need. */
function toWinterMaterial(material: RuntimeCredentialMaterial): WinterCredentialMaterial {
  switch (material.kind) {
    case "api-key":
      return { kind: "api-key", key: material.key };
    case "bearer":
      return { kind: "bearer", token: material.token };
    case "oauth":
      return {
        kind: "oauth",
        accessToken: material.accessToken,
        ...(material.refreshToken !== undefined ? { refreshToken: material.refreshToken } : {}),
        ...(material.expiresAt !== undefined ? { expiresAt: material.expiresAt } : {}),
        ...(material.accountId !== undefined ? { accountId: material.accountId } : {}),
        ...(material.idToken !== undefined ? { idToken: material.idToken } : {}),
      };
    default:
      throw new CredentialResolutionError(
        "unsupported",
        `${STORE_NAME}: cannot store a "${material.kind}" credential — Winter's material records support api-key/oauth/bearer only`,
      );
  }
}

/**
 * A `@yanlinglabs/winter-provider-runtime` `CredentialStore` over Winter's OWN Keychain-backed
 * `SecretStore`, delegating every read/write to `auth/credential-material.ts` — the SAME
 * parser/writer the post-8b hotfix defined for the spawned Winter child (lane-5 brief, P8c-10's
 * seam). A `{kind:"keychain",account}` ref's `account` IS the material record name
 * (`CREDENTIAL_MATERIAL_NAMES.openai` = `"openai:default"`, or `codexCredentialRef("default").account`
 * = `"codex-oauth:default"`), so the daemon's own internal model calls (compactor/titler/
 * bash-reviewer/status) and the spawned Winter child read — and, on a codex 401 refresh, WRITE BACK
 * — exactly the same token set. One parser, one writer, one record per provider.
 *
 * Only `{kind:"keychain"}` refs are handled (plus `{kind:"none"}`, which every store answers
 * identically) — the daemon never configures an `env`/`file`/`inline`/`aws-default-chain` ref for
 * either of these two providers, so anything else refuses typed rather than silently resolving to
 * nothing (mirrors the package's own `file`/`env` stores' `unsupported` arm).
 */
export function credentialStoreOverSecretStore(secrets: SecretStore): CredentialStore {
  return {
    async get(ref: CredentialRef): Promise<RuntimeCredentialMaterial | null> {
      if (ref.kind === "none") return null;
      if (ref.kind !== "keychain") {
        throw new CredentialResolutionError("unsupported", `${STORE_NAME}: cannot resolve a "${ref.kind}" credential reference`);
      }
      return await readCredentialMaterial(secrets, ref.account);
    },
    async set(ref: Extract<CredentialRef, { kind: "keychain" }>, material: RuntimeCredentialMaterial): Promise<void> {
      await writeCredentialMaterial(secrets, ref.account, toWinterMaterial(material));
    },
    async delete(ref: Extract<CredentialRef, { kind: "keychain" }>): Promise<void> {
      await clearCredentialMaterial(secrets, ref.account);
    },
  };
}
