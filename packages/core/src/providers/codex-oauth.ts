import type { SecretStore } from "../auth/secret-store";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "./types";
import { ResponsesSseParser } from "./responses-sse";
import { buildRequestBody, mapHttpError, wireToolNames } from "./openai-compatible";
import { refreshTokens, type OAuthTokens } from "./pkce";
import { CODEX, CODEX_MODELS } from "./codex-config";

export const CODEX_SECRET_NAMES = {
  access: "codex-access-token",
  refresh: "codex-refresh-token",
  id: "codex-id-token",
  account: "codex-account-id",
  expires: "codex-expires-at",
} as const;

export class CodexAuthStore {
  constructor(private readonly store: SecretStore) {}

  async save(t: OAuthTokens): Promise<void> {
    await this.store.set(CODEX_SECRET_NAMES.access, t.accessToken);
    if (t.refreshToken) await this.store.set(CODEX_SECRET_NAMES.refresh, t.refreshToken);
    if (t.idToken) await this.store.set(CODEX_SECRET_NAMES.id, t.idToken);
    if (t.accountId) await this.store.set(CODEX_SECRET_NAMES.account, t.accountId);
    await this.store.set(CODEX_SECRET_NAMES.expires, String(t.expiresAt));
  }

  async load(): Promise<OAuthTokens | null> {
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

    const names = wireToolNames(req.tools);
    const parser = new ResponsesSseParser((name) => names.get(name) ?? name);
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
