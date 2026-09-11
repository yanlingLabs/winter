import type { SecretStore } from "../auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, readCredentialMaterial, writeCredentialMaterial } from "../auth/credential-material";
import { CODEX_SECRET_NAMES } from "../auth/legacy-secret-names";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "./types";
import { ResponsesSseParser } from "./responses-sse";
import { buildRequestBody, mapHttpError } from "./openai-compatible";
import { refreshTokens, type OAuthTokens } from "./pkce";
import { CODEX, CODEX_MODELS } from "./codex-config";

/** LEGACY raw records — a one-way migration source (`auth/credential-material.ts`'s
 *  `migrateLegacyCredentialMaterial`) and `norma logout`'s blank target ONLY. `CodexAuthStore`
 *  below no longer writes these; the single source of truth is the `codex-oauth:default` JSON
 *  material record the spawned Winter child actually reads. Defined in the leaf
 *  `auth/legacy-secret-names.ts` (hotfix review r1, m1 — breaks the import cycle with
 *  `auth/credential-material.ts`) and re-exported here verbatim so every existing importer of
 *  `CODEX_SECRET_NAMES` from this module keeps working unchanged. */
export { CODEX_SECRET_NAMES };

/**
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

export interface CodexProviderConfig {
  authStore: CodexAuthStore;
  backendUrl?: string;   // default CODEX.backendUrl; injectable for tests
  tokenUrl?: string;     // default CODEX.tokenUrl; injectable for tests
}

export class CodexOAuthProvider implements Provider {
  readonly id = "codex-oauth";
  constructor(private readonly cfg: CodexProviderConfig) {}

  models(): ModelInfo[] { return CODEX_MODELS; }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    let tokens = await this.cfg.authStore.load();
    if (!tokens) {
      yield { type: "error", code: "auth", message: "not signed in — run: norma login" };
      return;
    }

    let res: Response;
    try {
      res = await this.post(req, tokens);
      if (res.status === 401 && tokens.refreshToken) {
        try {
          const fresh = await refreshTokens(this.cfg.tokenUrl ?? CODEX.tokenUrl, CODEX.clientId, tokens.refreshToken);
          tokens = {
            ...tokens,
            accessToken: fresh.accessToken,
            expiresAt: fresh.expiresAt,
            // refresh grants usually return no id_token and may not rotate the refresh token:
            // never let nulls clobber known-good identity fields.
            ...(fresh.refreshToken != null ? { refreshToken: fresh.refreshToken } : {}),
            ...(fresh.idToken != null ? { idToken: fresh.idToken } : {}),
            ...(fresh.accountId != null ? { accountId: fresh.accountId } : {}),
          };
          await this.cfg.authStore.save(tokens);
          res = await this.post(req, tokens); // retry exactly once
        } catch {
          yield { type: "error", code: "auth", message: "HTTP 401 — token refresh failed, run: norma login" };
          return;
        }
      }
    } catch (err) {
      if (req.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield { type: "error", code: "network", message: (err as Error).message };
      return;
    }
    if (!res.ok) { yield await mapHttpError(res.status, res.headers.get("retry-after"), res.text()); return; }

    const parser = new ResponsesSseParser();
    const reader = res.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const e of parser.push(value)) yield e;
      }
      for (const e of parser.finish()) yield e;
    } catch (err) {
      if (req.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield { type: "error", code: "network", message: (err as Error).message };
    } finally {
      reader.cancel().catch(() => {}); // release the connection if the consumer breaks early
    }
  }

  private post(req: TurnRequest, tokens: OAuthTokens): Promise<Response> {
    return fetch(`${this.cfg.backendUrl ?? CODEX.backendUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokens.accessToken}`,
        ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
        ...CODEX.headers,
      },
      body: JSON.stringify(buildRequestBody(req)),
      signal: req.signal,
    });
  }
}
