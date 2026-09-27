// WS-25 (daemon-oauth lane): a VERBATIM COPY of the agent SDK's fixture authorization server
// (`winter-agent-sdk` packages/runtime/src/mcp-auth/test-fixture-as.ts at SDK main 6d77ee36 -- the WS-25
// merge). The SDK does not ship its `src/` (`files: [dist, ...]`), so the daemon's tests carry their own
// copy rather than reaching into the installed package. Re-sync it when the SDK's changes; never widen it
// here -- a daemon test that needs more is a request to the SDK's fixture.
//
// WS-25 (MCP OAuth) §3: THE FIXTURE -- an in-process OAuth authorization server and the MCP server it
// protects, on one loopback `Bun.serve`. Every `mcp-auth` test and `bun run verify:mcp-oauth` sign in,
// refresh and revoke against THIS, never a real authorization server.
//
// WHAT IT IMPLEMENTS (each the part of the RFC a client can get wrong):
//   - RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, and the
//     `WWW-Authenticate: Bearer resource_metadata="..."` challenge on every 401;
//   - RFC 8414 metadata at `/.well-known/oauth-authorization-server` (issuer = the origin, exactly);
//   - RFC 7591 dynamic registration (`/register`), a Client ID Metadata Document client (a client_id that is
//     an https URL, RESOLVED THROUGH `cimdDocuments` -- the fixture never goes to the network, and the MCP
//     client refuses a non-https CIMD URL, so the document is served from this map), and pre-registered
//     clients, public or confidential (`client_secret_basic` / `client_secret_post`);
//   - `/authorize`, AUTO-APPROVING: a 302 to the redirect URI with `code`, the caller's `state` and `iss`
//     (RFC 9207). PKCE S256 is REQUIRED, and the redirect URI must be registered: exactly, or -- for a
//     loopback IP literal -- with any port (RFC 8252 §7.3, which is what CIMD's portless document relies on);
//   - `/token`: the code grant (single-use code, the same redirect URI, the verifier checked) and ROTATING
//     refresh tokens with REUSE DETECTION -- replaying a rotated refresh token revokes its whole family
//     (RFC 9700 §4.14), which is exactly what two processes refreshing one token would trigger;
//   - `/revoke` (RFC 7009);
//   - the MCP endpoint `/mcp`: a raw 2025-era Streamable HTTP server that answers only a valid bearer,
//     with a `step_up` tool that needs an extra scope (403 `insufficient_scope`, RFC 6750 §3.1);
//   - a LEGACY variant (`metadata: false`): no PRM and no RFC 8414 document -- the MCP client falls back to
//     `/authorize`, `/token` and `/register` on the server's origin.
//
// Counters (`log`, `tokenPosts`, `mcpRequests`) let a test prove what did NOT happen: no token-endpoint
// POST at a connect with a valid token (spec §1.2), no request at all for an expired token with no
// refresh token.
import { createHash, randomBytes } from "node:crypto";

export interface FixtureAsOptions {
  /** false: the legacy variant -- no protected-resource metadata and no RFC 8414 document. Default true. */
  metadata?: boolean;
  /** Advertise `registration_endpoint` and accept RFC 7591 registrations. Default true. */
  dcr?: boolean;
  /** Advertise `client_id_metadata_document_supported`. Default false. */
  cimd?: boolean;
  /** Client ID Metadata Documents by their URL (the client_id). */
  cimdDocuments?: Record<string, { client_id: string; redirect_uris: string[]; [k: string]: unknown }>;
  /** Pre-registered clients; each redirect URI must match exactly (port included). */
  preregistered?: Array<{ clientId: string; clientSecret?: string; redirectUris: string[] }>;
  /** Access token lifetime in seconds; `null` issues no `expires_in` at all. Default 3600. */
  accessTokenTtlSec?: number | null;
  /** Issue refresh tokens. Default true. */
  refreshTokens?: boolean;
  /** `scopes_supported` on both documents, and the scope a sign-in gets when it asks for none. Default ["read"]. */
  scopesSupported?: string[];
  /** The scope the `step_up` tool demands (403 insufficient_scope without it). Default "admin". */
  stepUpScope?: string;
  /** Send RFC 9207 `iss` on the redirect and advertise it. Default true. */
  issParameter?: boolean;
  /** Advertise `revocation_endpoint`. Default true. */
  revocation?: boolean;
  /** Delay every `/token` answer by this many ms (a test ends a sign-in DURING its code exchange). */
  tokenDelayMs?: number;
  /** Publish the protected resource as the bare ORIGIN (no path) -- the RFC 8707 indicator form a URL round trip would change. */
  pathlessResource?: boolean;
}

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  resource?: string;
}

interface TokenGrant {
  family: string;
  clientId: string;
  scope: string;
  active: boolean;
  /** A refresh token already exchanged: presenting it again is REUSE, not merely an invalid token. */
  rotated?: boolean;
}

export interface FixtureAs {
  readonly origin: string;
  readonly issuer: string;
  /** The protected MCP endpoint. */
  readonly mcpUrl: string;
  /** Every request, in order: `METHOD /path`. */
  readonly log: string[];
  /** Every POST to `/token`, by grant type, in order. */
  readonly tokenPosts: string[];
  /** The `resource` form parameter of every POST to `/token`, in order (`null` when absent). */
  readonly tokenResources: Array<string | null>;
  /** Every request that reached `/mcp` (answered or 401). */
  readonly mcpRequests: number;
  /** Registered DCR clients, in order. */
  readonly registrations: Array<{ clientId: string; redirectUris: string[] }>;
  /** The redirect URIs `/authorize` was asked to use, in order. */
  readonly authorizeRedirects: string[];
  /** Families revoked by refresh-token reuse. */
  readonly reuseRevokedFamilies: string[];
  /** Tokens revoked through `/revoke`. */
  readonly revokedViaEndpoint: string[];
  /** The browser: GET the authorize URL (auto-approved), then follow its 302 to the loopback callback. Returns the callback's status. */
  approve(authUrl: string): Promise<{ callbackStatus: number; location: string }>;
  /** Forgets every DCR registration, as an authorization server that expired its dynamic clients does. */
  forgetRegistrations(): void;
  /** Makes every access token issued so far invalid at `/mcp` (401), as an expiry would. */
  expireAllAccessTokens(): void;
  close(): void;
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function s256(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

function isLoopbackIpRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

/**
 * Redirect matching, as a strict authorization server does it (fix round 1 I4):
 *   - a REGISTERED client (DCR, pre-registered) matches EXACTLY -- port included -- so the tests that a
 *     sign-in binds and registers the same literal URI, and reuses a persisted port, prove something;
 *   - a CIMD document's PORTLESS loopback IP redirect (`http://127.0.0.1/callback`) matches that host and
 *     path on ANY port (RFC 8252 §7.3), which is exactly what Winter's global document relies on.
 */
function redirectAllowed(requested: string, registered: readonly string[] | undefined, cimd: boolean): boolean {
  if (registered === undefined) return false;
  if (registered.includes(requested)) return true;
  if (!cimd || !isLoopbackIpRedirect(requested)) return false;
  const req = new URL(requested);
  return registered.some((r) => {
    if (!isLoopbackIpRedirect(r)) return false;
    const reg = new URL(r);
    return reg.port === "" && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
  });
}

export function startFixtureAs(opts: FixtureAsOptions = {}): FixtureAs {
  const metadata = opts.metadata ?? true;
  const dcr = opts.dcr ?? true;
  const scopesSupported = opts.scopesSupported ?? ["read"];
  const stepUpScope = opts.stepUpScope ?? "admin";
  const issParameter = opts.issParameter ?? true;
  const ttl = opts.accessTokenTtlSec === undefined ? 3600 : opts.accessTokenTtlSec;
  const issueRefresh = opts.refreshTokens ?? true;
  const revocation = opts.revocation ?? true;

  const log: string[] = [];
  const tokenPosts: string[] = [];
  const tokenResources: Array<string | null> = [];
  const registrations: Array<{ clientId: string; redirectUris: string[] }> = [];
  const authorizeRedirects: string[] = [];
  const reuseRevokedFamilies: string[] = [];
  const revokedViaEndpoint: string[] = [];
  let mcpRequests = 0;

  const clients = new Map<string, { secret?: string; redirectUris?: string[]; cimd?: boolean }>();
  for (const c of opts.preregistered ?? []) clients.set(c.clientId, { ...(c.clientSecret !== undefined ? { secret: c.clientSecret } : {}), redirectUris: c.redirectUris });
  const codes = new Map<string, CodeGrant>();
  const accessTokens = new Map<string, TokenGrant>();
  /** refresh token -> grant; `active: false` once ROTATED (a replay of it is reuse). */
  const refreshTokens = new Map<string, TokenGrant>();

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      log.push(`${req.method} ${url.pathname}`);
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
      const oauthError = (error: string, status = 400) => json({ error, error_description: `fixture: ${error}` }, status);

      if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
        if (!metadata) return new Response("not found", { status: 404 });
        return json({ resource: opts.pathlessResource === true ? origin : mcpUrl, authorization_servers: [issuer], scopes_supported: scopesSupported, bearer_methods_supported: ["header"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (!metadata) return new Response("not found", { status: 404 });
        return json({
          issuer,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(dcr ? { registration_endpoint: `${origin}/register` } : {}),
          ...(revocation ? { revocation_endpoint: `${origin}/revoke` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
          scopes_supported: scopesSupported,
          ...(opts.cimd === true ? { client_id_metadata_document_supported: true } : {}),
          ...(issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
        });
      }
      if (url.pathname.startsWith("/.well-known/")) return new Response("not found", { status: 404 });

      if (url.pathname === "/register" && req.method === "POST") {
        if (!dcr) return new Response("not found", { status: 404 });
        const body = (await req.json()) as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
        const redirectUris = body.redirect_uris ?? [];
        if (redirectUris.length === 0) return oauthError("invalid_redirect_uri");
        const clientId = `dcr-${b64url(randomBytes(9))}`;
        const confidential = body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none";
        const secret = confidential ? b64url(randomBytes(18)) : undefined;
        clients.set(clientId, { redirectUris, ...(secret !== undefined ? { secret } : {}) });
        registrations.push({ clientId, redirectUris });
        return json({ ...body, client_id: clientId, ...(secret !== undefined ? { client_secret: secret } : {}), client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        const p = url.searchParams;
        const clientId = p.get("client_id") ?? "";
        const redirectUri = p.get("redirect_uri") ?? "";
        const client = resolveClient(clientId);
        if (client === undefined) return new Response("unknown client", { status: 400 });
        if (!redirectAllowed(redirectUri, client.redirectUris, client.cimd === true)) return new Response("redirect_uri not registered", { status: 400 });
        authorizeRedirects.push(redirectUri);
        if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return new Response("PKCE S256 required", { status: 400 });
        const code = b64url(randomBytes(18));
        const resource = p.get("resource");
        codes.set(code, { clientId, redirectUri, challenge: p.get("code_challenge")!, scope: p.get("scope") ?? scopesSupported.join(" "), ...(resource !== null ? { resource } : {}) });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        const state = p.get("state");
        if (state !== null) back.searchParams.set("state", state);
        if (issParameter) back.searchParams.set("iss", issuer);
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        if (opts.tokenDelayMs !== undefined) await Bun.sleep(opts.tokenDelayMs);
        const grantType = form.get("grant_type") ?? "";
        tokenPosts.push(grantType);
        tokenResources.push(form.get("resource"));
        const auth = authenticateClient(req, form);
        if (auth === "invalid") return oauthError("invalid_client", 401);
        if (grantType === "authorization_code") {
          const grant = codes.get(form.get("code") ?? "");
          if (grant === undefined) return oauthError("invalid_grant");
          codes.delete(form.get("code")!); // single use
          if (grant.clientId !== auth.clientId || grant.redirectUri !== form.get("redirect_uri")) return oauthError("invalid_grant");
          if (s256(form.get("code_verifier") ?? "") !== grant.challenge) return oauthError("invalid_grant");
          if (grant.resource !== undefined && form.get("resource") !== grant.resource) return oauthError("invalid_target");
          return json(issue(b64url(randomBytes(9)), grant.clientId, grant.scope));
        }
        if (grantType === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          const grant = refreshTokens.get(presented);
          if (grant === undefined || grant.clientId !== auth.clientId) return oauthError("invalid_grant");
          if (grant.rotated === true) {
            // REUSE: a rotated refresh token came back. Revoke the whole family (RFC 9700 §4.14).
            revokeFamily(grant.family);
            reuseRevokedFamilies.push(grant.family);
            return oauthError("invalid_grant");
          }
          if (!grant.active) return oauthError("invalid_grant");
          grant.active = false;
          grant.rotated = true;
          return json(issue(grant.family, grant.clientId, grant.scope));
        }
        return oauthError("unsupported_grant_type");
      }

      if (url.pathname === "/revoke" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const token = form.get("token") ?? "";
        revokedViaEndpoint.push(token);
        const grant = accessTokens.get(token) ?? refreshTokens.get(token);
        if (grant !== undefined) revokeFamily(grant.family);
        return new Response(null, { status: 200 });
      }

      if (url.pathname === "/mcp") return handleMcp(req);
      return new Response("not found", { status: 404 });
    },
  });

  const origin: string = `http://127.0.0.1:${server.port}`;
  const issuer: string = origin;
  const mcpUrl: string = `${origin}/mcp`;
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;

  function resolveClient(clientId: string): { secret?: string; redirectUris?: string[]; cimd?: boolean } | undefined {
    const known = clients.get(clientId);
    if (known !== undefined) return known;
    if (opts.cimd === true && clientId.startsWith("https://")) {
      const doc = opts.cimdDocuments?.[clientId];
      if (doc === undefined || doc.client_id !== clientId) return undefined;
      return { redirectUris: doc.redirect_uris, cimd: true };
    }
    return undefined;
  }

  function authenticateClient(req: Request, form: URLSearchParams): { clientId: string } | "invalid" {
    let clientId = form.get("client_id") ?? undefined;
    let secret = form.get("client_secret") ?? undefined;
    const basic = req.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const [id, sec] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
      clientId = id;
      secret = sec;
    }
    if (clientId === undefined) return "invalid";
    const client = resolveClient(clientId);
    if (client === undefined) return "invalid";
    if (client.secret !== undefined && client.secret !== secret) return "invalid";
    return { clientId };
  }

  function issue(family: string, clientId: string, scope: string): Record<string, unknown> {
    const access = `at-${b64url(randomBytes(18))}`;
    accessTokens.set(access, { family, clientId, scope, active: true });
    const out: Record<string, unknown> = { access_token: access, token_type: "Bearer", scope };
    if (ttl !== null) out.expires_in = ttl;
    if (issueRefresh) {
      const refresh = `rt-${b64url(randomBytes(18))}`;
      refreshTokens.set(refresh, { family, clientId, scope, active: true });
      out.refresh_token = refresh;
    }
    return out;
  }

  function revokeFamily(family: string): void {
    for (const grant of [...accessTokens.values(), ...refreshTokens.values()]) if (grant.family === family) grant.active = false;
  }

  async function handleMcp(req: Request): Promise<Response> {
    mcpRequests++;
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const grant = accessTokens.get(token);
    if (grant === undefined || !grant.active) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": challenge } });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const body = (await req.json()) as { id?: unknown; method?: string; params?: { name?: string } };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" } });
    switch (body.method) {
      case "server/discover":
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }), { headers: { "content-type": "application/json" } });
      case "initialize":
        return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture-mcp", version: "1" } });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({
          tools: [
            { name: "whoami", inputSchema: { type: "object", properties: {} } },
            { name: "step_up", inputSchema: { type: "object", properties: {} } },
          ],
        });
      case "tools/call": {
        if (body.params?.name === "step_up" && !grant.scope.split(" ").includes(stepUpScope)) {
          return new Response("insufficient scope", {
            status: 403,
            headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${[...grant.scope.split(" "), stepUpScope].join(" ")}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
          });
        }
        return reply({ content: [{ type: "text", text: `PONG-${grant.clientId.startsWith("https://") ? "cimd" : "ok"}-${grant.scope}` }] });
      }
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }), { headers: { "content-type": "application/json" } });
    }
  }

  return {
    origin,
    issuer,
    mcpUrl,
    log,
    tokenPosts,
    tokenResources,
    get mcpRequests() {
      return mcpRequests;
    },
    registrations,
    authorizeRedirects,
    reuseRevokedFamilies,
    revokedViaEndpoint,
    async approve(authUrl: string) {
      const consent = await fetch(authUrl, { redirect: "manual" });
      const location = consent.headers.get("location");
      if (consent.status !== 302 || location === null) throw new Error(`fixture: the authorize request was refused (${consent.status}: ${await consent.text()})`);
      const callback = await fetch(location, { redirect: "manual" });
      await callback.text();
      return { callbackStatus: callback.status, location };
    },
    forgetRegistrations() {
      for (const r of registrations) clients.delete(r.clientId);
    },
    expireAllAccessTokens() {
      for (const grant of accessTokens.values()) grant.active = false;
    },
    close() {
      server.stop(true);
    },
  };
}
