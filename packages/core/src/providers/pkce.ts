import { randomBytes } from "node:crypto";

export interface LoginConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  callbackPort: number;        // 1455 in production (codex-rs parity); 0 = ephemeral for tests
  scope: string;
  timeoutMs?: number;          // default 5 min
  openBrowser: (url: string) => Promise<void>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
  expiresAt: number; // epoch ms
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(48).toString("base64url"); // 64 chars, within 43–128
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export function decodeAccountId(idToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8"));
    return payload["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
  } catch { return null; }
}

async function exchange(tokenUrl: string, params: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = body.slice(0, 200);
    throw new Error(`token exchange failed: HTTP ${res.status}${snippet ? ` — ${snippet}` : ""}`);
  }
  const j = (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? null,
    idToken: j.id_token ?? null,
    accountId: j.id_token ? decodeAccountId(j.id_token) : null,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
}

export function refreshTokens(tokenUrl: string, clientId: string, refreshToken: string): Promise<OAuthTokens> {
  return exchange(tokenUrl, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
}

export async function runLoginFlow(cfg: LoginConfig): Promise<OAuthTokens> {
  const { verifier, challenge } = await generatePkce();
  const state = randomBytes(16).toString("base64url");

  let resolveCode!: (code: string) => void;
  let rejectFlow!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectFlow = rej; });
  // Attach a no-op catch so the rejection is always "handled" even if it fires
  // before the `await codePromise` line is reached (e.g. state-mismatch path).
  codePromise.catch(() => {});

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: cfg.callbackPort,
      hostname: "127.0.0.1", // loopback only — the auth code must never be reachable from the LAN
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
        if (url.searchParams.get("state") !== state) {
          rejectFlow(new Error("OAuth state mismatch — possible CSRF, aborting login"));
          return new Response("state mismatch", { status: 400 });
        }
        const code = url.searchParams.get("code");
        if (!code) { rejectFlow(new Error("callback missing code")); return new Response("missing code", { status: 400 }); }
        resolveCode(code);
        return new Response("Winter is signed in — you can close this tab.", { headers: { "content-type": "text/plain" } });
      },
    });
  } catch (err) {
    throw new Error(`could not open the login callback on port ${cfg.callbackPort} — is another login in progress? (${(err as Error).message})`);
  }

  const redirectUri = `http://localhost:${server.port}/auth/callback`;
  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const timeout = setTimeout(() => rejectFlow(new Error("login timed out")), cfg.timeoutMs ?? 5 * 60_000);
  try {
    cfg.openBrowser(authUrl.toString()).catch((e) => rejectFlow(new Error(`could not open browser: ${(e as Error).message}`)));
    const code = await codePromise;
    return await exchange(cfg.tokenUrl, {
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }
}
