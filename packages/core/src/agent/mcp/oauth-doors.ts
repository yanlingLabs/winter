// WS-25 (MCP OAuth, spec §1-§3): the daemon's MCP SIGN-IN DOORS -- `mcp.login`, `mcp.loginStatus`,
// `mcp.logout`, `mcp.setClientSecret` and `mcp.list`'s auth columns. `ipc/server.ts` owns the RPC shape;
// this module owns what the doors DO, so the CLI's no-daemon path runs the very same code.
//
// THE SDK DOES THE PROTOCOL. Discovery, registration (pre-registered > CIMD > DCR), PKCE, the loopback
// listener, `state`, the code exchange, the issuer checks and every auth request's SSRF policy live in
// `@yanlinglabs/winter-agent-runtime/mcp-auth` (`startMcpOAuthLogin`, `revokeMcpOAuth`). The daemon adds
// what only a host can know:
//   - WHICH server a name means: the same precedence a session folds (local > trusted project > user),
//     for the caller's `cwd` -- or one explicit scope -- and the server's canonical URL keys the sign-in
//     (spec §1.6: one sign-in serves every scope and project that names the same server);
//   - the LOGIN TABLE: a flow's loopback listener lives in this process for up to 5 minutes while the
//     client (the Mac, the CLI) opens the browser; `mcp.loginStatus` reads it;
//   - the ISSUER-CHANGE CONFIRMATION (review, binding): a sign-in whose authorization server is not the one
//     the stored client registration names is refused typed until the caller confirms, showing both
//     origins -- a redeclared server URL (a project overriding the user's scope with its own
//     `authServerMetadataUrl`) must not silently replace the user's registration. Issuers are compared
//     in FULL with the SDK's `sameIssuer`, never by origin (tenant paths share an origin);
//   - the CLIENT SECRET's door, bound to the issuer the USER's own config discovers, which the caller
//     shows and the user confirms before the secret is sent (`clientSecretIssuer`, `setClientSecret`);
//   - telling live sessions: after a sign-in or a sign-out every live child that configures the server is
//     asked to RECONNECT it (`onSignInChanged`) -- a Keychain write never evicts or restarts a child.
//
// NOTHING SECRET LEAVES. No token, code, verifier, `state`, secret or authorize URL is ever logged: the
// `authUrl` goes back to the caller that asked for it and nowhere else. Errors carry codes and origins.
import { canonicalMcpServerUrl, discoverMcpOAuthIssuer, sameIssuer, decodeMcpOAuthClientRecord, decodeMcpOAuthTokenRecord, encodeMcpOAuthClientSecretItem, McpOAuthError, MCP_OAUTH_LOGIN_TIMEOUT_MS, mcpOAuthClientAccount, mcpOAuthClientSecretAccount, mcpOAuthTokenAccount, revokeMcpOAuth, startMcpOAuthLogin, validateMcpOAuthConfig, type McpOAuthConfig, type McpOAuthLogin, type McpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { sdkLocalMcpServers, sdkUserMcpServers } from "../../settings";
import { cliCommandName } from "../../profile";
import { localScopeKeyFor, projectScopeRootFor, projectScopeTrusted } from "../../runtime-sdk/run-home-input";
import { parseProjectMcpServers, readRawProjectMcpConfig, type McpOAuthSetting } from "./project-file";
import { describeReconnectError } from "./reconnect";

export type McpDoorScope = "local" | "user" | "project";

/** A typed refusal from a sign-in door: `code` rides the JSON-RPC error's `data.code`, `data` beside it. */
export class McpOAuthDoorRefusal extends Error {
  constructor(readonly code: string, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "McpOAuthDoorRefusal";
  }
}

/**
 * A started sign-in. Besides the flow (`loginId`, `authUrl`) it names WHAT the user is about to authorize,
 * so a client can show it and ask BEFORE opening the browser (WS-25 security review M1): the server the
 * name resolved to -- a trusted project's or a local entry can shadow a user-scope name -- its URL, and
 * the authorization server's full issuer.
 */
export interface McpLoginStarted {
  loginId: string;
  authUrl: string;
  issuerOrigin: string;
  authorizeOrigin: string;
  issuer: string;
  name: string;
  scope: McpDoorScope;
  url: string;
}

/** An http/sse server as a door resolved it. */
export interface ResolvedMcpServer {
  name: string;
  scope: McpDoorScope;
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthSetting;
}

type AnyEntry = { type: "stdio" | "http" | "sse"; url?: unknown; headers?: unknown; oauth?: unknown };

export interface McpOAuthDoorDeps {
  home: string;
  /** The daemon's ONE MCP OAuth store (`runtime-sdk/mcp-oauth-store.ts`); tests pass a memory store. */
  store: () => McpOAuthStore;
  /** Per-directory trust: a project's MCP file is read only for a trusted project. */
  trust?: { isTrusted(dir: string): boolean };
  /** A sign-in or sign-out finished for this server: reconnect live children, re-probe the status. */
  onSignInChanged?: (serverUrl: string) => Promise<void> | void;
  /** Test seams: the SDK doors, the network under the SDK's auth policy, the CIMD URL, the clock. */
  startLogin?: typeof startMcpOAuthLogin;
  discoverIssuer?: typeof discoverMcpOAuthIssuer;
  revoke?: typeof revokeMcpOAuth;
  fetch?: typeof fetch;
  clientMetadataUrl?: string;
  now?: () => number;
  /** An unfinished login's server-side lifetime (spec §2: 5 minutes). */
  loginTtlMs?: number;
  log?: (line: string) => void;
}

type LoginState = "pending" | "done" | "failed" | "expired";
interface LoginEntry {
  account: string;
  state: LoginState;
  error?: string;
  login: McpOAuthLogin;
  timer?: ReturnType<typeof setTimeout>;
}

/** A settled login is remembered this long (a client polling late still reads its answer), then forgotten. */
const SETTLED_LOGIN_RETENTION_MS = 15 * 60_000;

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function hasStaticAuthorization(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((h) => h.toLowerCase() === "authorization");
}

/** The SDK's error codes, or a class name -- never an unbounded server string. */
function reasonOf(err: unknown): string {
  if (err instanceof McpOAuthError) return err.code;
  return err instanceof Error ? err.name : "failed";
}

export class McpOAuthDoors {
  private readonly logins = new Map<string, LoginEntry>();
  /** Per token account: the tail of the sign-in starts and sign-outs queued for it (fix round 1, I1). */
  private readonly startChains = new Map<string, Promise<void>>();
  /** The last sign-in change's follow-up (reconnects), for tests and an orderly shutdown. */
  private followUps = new Set<Promise<void>>();

  constructor(private readonly deps: McpOAuthDoorDeps) {}

  // --- which server --------------------------------------------------------------------------------

  /**
   * The server `name` means, as a session would see it: with `scope`, that scope's entry only; without,
   * the session fold's precedence -- local > trusted project > user -- for `cwd` (no `cwd`: the user
   * scope, which is what the Mac's cwd-less pane means). An absent name, a stdio server and a server whose
   * config pins a static `Authorization` header (no sign-in applies to it) are refused typed, as is an
   * `oauth` block the runtime would refuse.
   */
  resolve(params: { name: string; scope?: McpDoorScope | undefined; cwd?: string | undefined }): ResolvedMcpServer {
    const { name } = params;
    const cwd = params.cwd === undefined || params.cwd === "" ? undefined : params.cwd;
    const found = params.scope !== undefined ? this.inScope(params.scope, name, cwd) : this.folded(name, cwd);
    if (found === undefined) {
      throw new McpOAuthDoorRefusal("mcp_server_not_found", `no MCP server named "${name}" is configured${params.scope !== undefined ? ` in the ${params.scope} scope` : cwd !== undefined ? " for this directory" : " in the user scope"}`);
    }
    const { scope, entry } = found;
    if (entry.type === "stdio" || typeof entry.url !== "string") {
      throw new McpOAuthDoorRefusal("mcp_oauth_not_applicable", `MCP server "${name}" is a stdio server; sign-in applies only to http and sse servers`);
    }
    const headers = entry.headers as Record<string, string> | undefined;
    if (hasStaticAuthorization(headers)) {
      throw new McpOAuthDoorRefusal("mcp_oauth_not_applicable", `MCP server "${name}" sends a static Authorization header from its config, so it never uses a sign-in`);
    }
    if (entry.oauth !== undefined) {
      const problem = validateMcpOAuthConfig(entry.oauth, entry.url);
      if (problem !== undefined) throw new McpOAuthDoorRefusal("mcp_oauth_config_invalid", problem);
    }
    try {
      canonicalMcpServerUrl(entry.url);
    } catch (err) {
      throw new McpOAuthDoorRefusal("mcp_oauth_config_invalid", err instanceof Error ? err.message : "the server URL is refused");
    }
    return {
      name,
      scope,
      type: entry.type,
      url: entry.url,
      ...(headers !== undefined ? { headers } : {}),
      ...(entry.oauth !== undefined ? { oauth: entry.oauth as McpOAuthSetting } : {}),
    };
  }

  private inScope(scope: McpDoorScope, name: string, cwd: string | undefined): { scope: McpDoorScope; entry: AnyEntry } | undefined {
    if (scope === "user") {
      const entry = sdkUserMcpServers(this.deps.home)[name];
      return entry === undefined ? undefined : { scope, entry };
    }
    if (cwd === undefined) throw new McpOAuthDoorRefusal("mcp_scope_needs_cwd", `the "${scope}" scope names a project — pass the project's cwd`);
    if (scope === "local") {
      const entry = sdkLocalMcpServers(this.deps.home, localScopeKeyFor(cwd))[name];
      return entry === undefined ? undefined : { scope, entry };
    }
    const entry = this.projectEntry(name, cwd);
    return entry === undefined ? undefined : { scope, entry };
  }

  /** A TRUSTED project's `.winter/mcp.json` entry (an untrusted project is refused typed, never read). */
  private projectEntry(name: string, cwd: string, refuseUntrusted = true): AnyEntry | undefined {
    let dir = cwd;
    try { dir = realpathSync(cwd); } catch { /* a vanished cwd: its spelling */ }
    if (this.deps.trust === undefined || !projectScopeTrusted(dir, this.deps.trust)) {
      if (!refuseUntrusted) return undefined;
      throw new McpOAuthDoorRefusal("mcp_project_untrusted", `the project at ${dir} is not trusted, so its MCP servers are not read (winter trust)`);
    }
    const read = readRawProjectMcpConfig(projectScopeRootFor(dir));
    if (read.kind !== "ok") return undefined;
    return parseProjectMcpServers(read.servers).servers[name];
  }

  private folded(name: string, cwd: string | undefined): { scope: McpDoorScope; entry: AnyEntry } | undefined {
    if (cwd !== undefined) {
      const local = sdkLocalMcpServers(this.deps.home, localScopeKeyFor(cwd))[name];
      if (local !== undefined) return { scope: "local", entry: local };
      const project = this.projectEntry(name, cwd, false);
      if (project !== undefined) return { scope: "project", entry: project };
    }
    const user = sdkUserMcpServers(this.deps.home)[name];
    return user === undefined ? undefined : { scope: "user", entry: user };
  }

  // --- mcp.login / mcp.loginStatus ----------------------------------------------------------------

  /**
   * Starts a sign-in and returns what the caller opens. The flow stays in this process (its loopback
   * listener) until the browser's callback arrives, the caller's 5 minutes run out (`expired`), or a newer
   * sign-in for the same server supersedes it.
   *
   * ISSUER CHANGE: the stored client registration is snapshotted FIRST, because the SDK persists a new DCR
   * or CIMD registration during the flow's first leg -- before this door learns the issuer, and before the
   * SDK's own authorize-URL policy check can still throw. So the snapshot is put back on EVERY exit that
   * does not hand the flow to the login table (fix round 1, I1): a refused issuer change, and equally a
   * first leg that failed after registering -- otherwise a failing flow toward another authorization
   * server would leave ITS registration stored, and the next sign-in would compare against that one and
   * skip the confirmation. When the new issuer's origin differs from the stored one's and the call did not
   * confirm, the flow is cancelled and the call refused typed with both origins
   * (`mcp_issuer_change_requires_confirmation`).
   *
   * SERIALISED PER SERVER (fix round 1, I1): two `mcp.login` calls for one token account run their start
   * phases one after the other, so the second never snapshots a registration the first wrote but has not
   * yet had confirmed (or put back).
   */
  async login(server: ResolvedMcpServer, opts: { confirmIssuerChange?: boolean } = {}): Promise<McpLoginStarted> {
    const account = mcpOAuthTokenAccount(server.url);
    return this.serialised(account, () => this.startLoginSerialised(server, account, opts));
  }

  /**
   * Runs `work` after every sign-in start and sign-out already queued for this token account (fix round
   * 1). A sign-out rides the same chain as a start: a start's `finally` restores its registration snapshot,
   * and running concurrently it could bring back a client registration `--forget-client` just removed.
   */
  private serialised<T>(account: string, work: () => Promise<T>): Promise<T> {
    const previous = this.startChains.get(account) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.startChains.set(account, tail);
    void tail.then(() => { if (this.startChains.get(account) === tail) this.startChains.delete(account); });
    return run;
  }

  private async startLoginSerialised(server: ResolvedMcpServer, account: string, opts: { confirmIssuerChange?: boolean }): Promise<McpLoginStarted> {
    const store = this.deps.store();
    const clientAccount = mcpOAuthClientAccount(server.url);
    const snapshot = await store.read(clientAccount).catch(() => null);
    let storedIssuer: string | undefined;
    if (snapshot !== null) {
      try { storedIssuer = decodeMcpOAuthClientRecord(snapshot).issuer; } catch { /* a malformed registration is treated as none, as the SDK treats it */ }
    }

    // Cleared only once the flow is handed to the login table; every other exit puts the snapshot back.
    let restoreSnapshot = true;
    try {
      let login: McpOAuthLogin;
      try {
        login = await (this.deps.startLogin ?? startMcpOAuthLogin)({
          serverUrl: server.url,
          ...(server.oauth !== undefined ? { oauth: server.oauth as McpOAuthConfig } : {}),
          store,
          ...(this.deps.clientMetadataUrl !== undefined ? { clientMetadataUrl: this.deps.clientMetadataUrl } : {}),
          ...(this.deps.fetch !== undefined ? { fetch: this.deps.fetch } : {}),
          ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
          timeoutMs: this.deps.loginTtlMs ?? MCP_OAUTH_LOGIN_TIMEOUT_MS,
        });
      } catch (err) {
        const code = reasonOf(err);
        if (code === "client_secret_issuer_mismatch") {
          throw new McpOAuthDoorRefusal("mcp_client_secret_issuer_mismatch", `${err instanceof Error ? err.message : "the client secret belongs to another authorization server"} — set the client secret again for this server (${cliCommandName()} mcp set-secret ${server.name})`, { reason: code });
        }
        if (code === "client_secret_unavailable") {
          throw new McpOAuthDoorRefusal("mcp_client_secret_unavailable", `MCP server "${server.name}" is a pre-registered client with a client secret, and none is stored — set it first (${cliCommandName()} mcp set-secret ${server.name}, or Settings → MCP)`, { reason: code });
        }
        // The SDK's messages carry codes, origins and bounded text only (never a token or a URL's query).
        throw new McpOAuthDoorRefusal("mcp_login_failed", `the sign-in to "${server.name}" could not start: ${err instanceof Error ? err.message.slice(0, 300) : "failed"}`, { reason: code });
      }

      // Fix round 1 (I1 steps 3-4): FULL issuers, compared with the SDK's own `sameIssuer` (exact, ±1
      // trailing slash — the comparison a secret's binding uses), never origins: one origin can host many
      // authorization servers behind tenant paths. The new issuer is what leg 1 actually registered with
      // when it wrote a registration (read back), else the flow's own verified `issuer` (the pre-registered
      // path, and a reused registration, write nothing in leg 1).
      const newIssuer = await this.issuerAfterLeg1(store, clientAccount, snapshot, login);
      if (storedIssuer !== undefined && !sameIssuer(storedIssuer, newIssuer) && opts.confirmIssuerChange !== true) {
        login.cancel();
        const storedOrigin = originOf(storedIssuer) ?? storedIssuer;
        const newOrigin = originOf(newIssuer) ?? login.issuerOrigin;
        throw new McpOAuthDoorRefusal(
          "mcp_issuer_change_requires_confirmation",
          `MCP server "${server.name}" now signs in at ${newIssuer}, but its stored registration belongs to ${storedIssuer} — confirm the change to continue`,
          { storedIssuer, newIssuer, storedIssuerOrigin: storedOrigin, newIssuerOrigin: newOrigin },
        );
      }
      restoreSnapshot = false;
      return this.handToLoginTable(server, account, login);
    } finally {
      if (restoreSnapshot) {
        // Put back the registration the first leg may have replaced (or remove the one it added to a
        // server that had none): nothing is left behind by a sign-in that never started.
        try {
          const now = await store.read(clientAccount);
          if (now !== snapshot) {
            if (snapshot === null) await store.remove(clientAccount);
            else await store.write(clientAccount, snapshot);
          }
        } catch { /* best effort: the next sign-in re-registers either way */ }
      }
    }
  }

  /** The issuer this flow signs in with: the registration leg 1 wrote, when it wrote one; else `login.issuer`. */
  private async issuerAfterLeg1(store: McpOAuthStore, clientAccount: string, snapshot: string | null, login: McpOAuthLogin): Promise<string> {
    try {
      const now = await store.read(clientAccount);
      if (now !== null && now !== snapshot) return decodeMcpOAuthClientRecord(now).issuer;
    } catch { /* unreadable: the flow's own issuer */ }
    return login.issuer;
  }

  /** Hands a started flow to the login table: its expiry timer, its settlement, its follow-up. */
  private handToLoginTable(server: ResolvedMcpServer, account: string, login: McpOAuthLogin): McpLoginStarted {
    const loginId = `ml_${randomBytes(12).toString("hex")}`;
    const entry: LoginEntry = { account, state: "pending", login };
    this.logins.set(loginId, entry);
    // A newer sign-in for the same server supersedes this one inside the SDK; say so here at once.
    for (const [id, other] of this.logins) {
      if (id !== loginId && other.account === account && other.state === "pending") other.login.cancel();
    }
    const ttl = this.deps.loginTtlMs ?? MCP_OAUTH_LOGIN_TIMEOUT_MS;
    entry.timer = setTimeout(() => {
      if (entry.state === "pending") {
        entry.state = "expired";
        login.cancel();
      }
    }, ttl);
    entry.timer.unref?.();
    void login.done.then((outcome) => {
      clearTimeout(entry.timer);
      if (entry.state === "pending") {
        if (outcome.ok) entry.state = "done";
        else if (outcome.reason === "login_timeout") entry.state = "expired";
        else {
          entry.state = "failed";
          entry.error = outcome.reason.slice(0, 200);
        }
      }
      this.deps.log?.(`mcp: sign-in to '${server.name}' ${entry.state}${entry.error !== undefined ? ` (${entry.error})` : ""}`);
      const forget = setTimeout(() => this.logins.delete(loginId), SETTLED_LOGIN_RETENTION_MS);
      forget.unref?.();
      if (outcome.ok) this.track(this.deps.onSignInChanged?.(server.url));
    });
    this.deps.log?.(`mcp: sign-in to '${server.name}' started (authorization server ${login.issuerOrigin})`);
    return {
      loginId, authUrl: login.authUrl, issuerOrigin: login.issuerOrigin, authorizeOrigin: login.authorizeOrigin,
      issuer: login.issuer, name: server.name, scope: server.scope, url: server.url,
    };
  }

  /** `pending` | `done` | `failed` (with a code-shaped `error`) | `expired`. An unknown id is `expired`. */
  loginStatus(loginId: string): { state: LoginState; error?: string } {
    const entry = this.logins.get(loginId);
    if (entry === undefined) return { state: "expired" };
    return entry.error !== undefined ? { state: entry.state, error: entry.error } : { state: entry.state };
  }

  // --- mcp.logout ------------------------------------------------------------------------------------

  /**
   * Best-effort RFC 7009 revocation, then the local sign-in is removed (the SDK's `revokeMcpOAuth`); the
   * client registration is KEPT unless `forgetClient` (spec §1.6). A pending sign-in for the same server
   * is cancelled first. Live children then reconnect the server (it turns `needs-auth`).
   */
  async logout(server: ResolvedMcpServer, opts: { forgetClient?: boolean } = {}): Promise<void> {
    const account = mcpOAuthTokenAccount(server.url);
    // Serialised with sign-in STARTS for the same server (`serialised`): never interleaved with a start's
    // snapshot restore.
    await this.serialised(account, () => this.logoutSerialised(server, account, opts));
  }

  private async logoutSerialised(server: ResolvedMcpServer, account: string, opts: { forgetClient?: boolean }): Promise<void> {
    for (const entry of this.logins.values()) {
      if (entry.account === account && entry.state === "pending") entry.login.cancel();
    }
    await (this.deps.revoke ?? revokeMcpOAuth)({
      account,
      store: this.deps.store(),
      ...(opts.forgetClient === true ? { forgetClient: true } : {}),
      ...(this.deps.fetch !== undefined ? { fetch: this.deps.fetch } : {}),
    });
    this.deps.log?.(`mcp: signed out of '${server.name}'${opts.forgetClient === true ? " (client registration forgotten)" : ""}`);
    this.track(this.deps.onSignInChanged?.(server.url));
  }

  // --- mcp.clientSecretIssuer / mcp.setClientSecret ---------------------------------------------------

  /**
   * The USER-scope server a client secret for `server` belongs to (review I-A, binding): the user's own
   * configuration is the only source trusted to say where a secret may be sent, so whichever scope the
   * name resolved in, the target is the user-scope server with the same canonical URL. None there ->
   * `mcp_secret_needs_user_scope`; a user config without `oauth.clientId` + `oauth.clientSecretRef` (not a
   * confidential pre-registered client, fix round 1 minor 1: the SDK reads a secret only when the config
   * marks one) -> `mcp_not_preregistered`.
   */
  private clientSecretTarget(server: ResolvedMcpServer): ResolvedMcpServer {
    const canonical = canonicalMcpServerUrl(server.url);
    let user: ResolvedMcpServer | undefined;
    if (server.scope === "user") {
      user = server;
    } else {
      for (const [name, entry] of Object.entries(sdkUserMcpServers(this.deps.home))) {
        if (entry.type === "stdio") continue;
        let same = false;
        try { same = canonicalMcpServerUrl(entry.url) === canonical; } catch { same = false; }
        if (same) {
          user = this.resolve({ name, scope: "user" });
          break;
        }
      }
    }
    if (user === undefined) {
      throw new McpOAuthDoorRefusal("mcp_secret_needs_user_scope", `MCP server "${server.name}" comes from the ${server.scope} scope; a client secret is set only for a server in your user scope (winter mcp add -s user …), which decides where the secret may be sent`);
    }
    if (user.oauth?.clientId === undefined) {
      throw new McpOAuthDoorRefusal("mcp_not_preregistered", `MCP server "${user.name}" is not configured as a pre-registered client (oauth.clientId), so it has no client secret`);
    }
    if (user.oauth.clientSecretRef === undefined) {
      throw new McpOAuthDoorRefusal("mcp_not_preregistered", `MCP server "${user.name}" is a public pre-registered client (its config has oauth.clientId but no oauth.clientSecretRef: { kind: "keychain" }), so a client secret would never be used — add the marker first`);
    }
    return user;
  }

  /**
   * The authorization server the USER-scope server's own discovery names (the SDK's side-effect-free
   * `discoverMcpOAuthIssuer`: no registration, no listener, no store, no secret — so it never supersedes a
   * sign-in in flight). Honours the user config's own `authServerMetadataUrl` (with the SDK's RFC 8414
   * issuer-location check), never a project's.
   */
  private async discoverFor(user: ResolvedMcpServer): Promise<{ issuer: string; issuerOrigin: string; authorizeOrigin: string }> {
    try {
      return await (this.deps.discoverIssuer ?? discoverMcpOAuthIssuer)({
        serverUrl: user.url,
        ...(user.oauth !== undefined ? { oauth: user.oauth as McpOAuthConfig } : {}),
        ...(this.deps.fetch !== undefined ? { fetch: this.deps.fetch } : {}),
      });
    } catch (err) {
      throw new McpOAuthDoorRefusal("mcp_discovery_failed", `could not discover the authorization server for "${user.name}": ${err instanceof Error ? err.message.slice(0, 300) : "failed"}`, { reason: reasonOf(err) });
    }
  }

  /**
   * `mcp.clientSecretIssuer` (fix round 1, minor 4): the issuer a client secret for this server WOULD be
   * bound to, for the client to show and confirm BEFORE the secret is asked for or sent. Writes nothing.
   */
  async clientSecretIssuer(server: ResolvedMcpServer): Promise<{ name: string; scope: McpDoorScope; url: string; issuer: string; issuerOrigin: string; authorizeOrigin: string }> {
    const user = this.clientSecretTarget(server);
    const found = await this.discoverFor(user);
    // `scope`/`url` (WS-25 integration): which server the secret belongs to, for a client that must show it
    // before asking (the CLI's non-interactive `--from-clipboard` prints it and asks for `--issuer`).
    return { name: user.name, scope: user.scope, url: user.url, ...found };
  }

  /**
   * A pre-registered client's secret, to the Keychain under the DERIVED account
   * `mcp-oauth-client-secret:<id>` (review C1: never a config-named account), BOUND to the issuer the
   * USER-scope server's own discovery names (review I-A) -- so the SDK sends it to that authorization
   * server only.
   *
   * CONFIRMED FIRST (fix round 1, minor 4): `expectedIssuer` is the issuer the caller showed the user and
   * the user accepted (`clientSecretIssuer`). It is required: absent -> `mcp_expected_issuer_required`
   * (carrying the discovered issuer), and nothing is written. Discovery runs again here and must name the
   * same authorization server (`sameIssuer`), else `mcp_issuer_changed` -- a server that moved between the
   * confirmation and the write is confirmed again, never bound silently.
   *
   * Returns the issuer it bound to. The secret is never echoed and never logged.
   */
  async setClientSecret(server: ResolvedMcpServer, secret: string, expectedIssuer: string | undefined): Promise<{ issuer: string; issuerOrigin: string }> {
    const user = this.clientSecretTarget(server);
    const found = await this.discoverFor(user);
    if (expectedIssuer === undefined) {
      throw new McpOAuthDoorRefusal("mcp_expected_issuer_required", `confirm where the client secret for "${user.name}" may be sent (${found.issuer}) and pass it as expectedIssuer — nothing was stored`, { issuer: found.issuer, issuerOrigin: found.issuerOrigin });
    }
    if (!sameIssuer(expectedIssuer, found.issuer)) {
      throw new McpOAuthDoorRefusal("mcp_issuer_changed", `the authorization server for "${user.name}" is now ${found.issuer}, not the ${expectedIssuer} you confirmed — nothing was stored; confirm again`, { issuer: found.issuer, issuerOrigin: found.issuerOrigin, expectedIssuer });
    }
    await this.deps.store().write(mcpOAuthClientSecretAccount(user.url), encodeMcpOAuthClientSecretItem(secret, found.issuer));
    this.deps.log?.(`mcp: client secret stored for '${user.name}' (bound to ${found.issuer})`);
    return { issuer: found.issuer, issuerOrigin: found.issuerOrigin };
  }

  // --- mcp.list's auth columns -----------------------------------------------------------------------

  /**
   * `auth` / `oauthIssuerOrigin` / `oauthPreregistered` for one configured http/sse server (spec §2):
   *   - `none` -- a static `Authorization` header, or no sign-in stored, no `oauth` block and a probe that
   *     did not ask for one;
   *   - `signed-in` -- a stored sign-in that is not DEAD (spec §1.2: dead = expired with no refresh token;
   *     an absent expiry is valid until the server says 401). Fix round 1 (minor 2): the 60 s early-refresh
   *     margin applies only to a REFRESHABLE token (the SDK's own `usable()`): a token without a refresh
   *     token is used until it actually expires, so it is not dead inside its last minute;
   *   - `needs-auth` -- a dead or unreadable sign-in, or none while the config declares `oauth` or the last
   *     probe was refused for want of one.
   * Reads the daemon's own store; never refreshes, never returns material.
   */
  async authColumns(entry: { url: string; headers?: Record<string, string>; oauth?: { clientId?: string } }, probeStatus: string | undefined): Promise<{ auth: "none" | "signed-in" | "needs-auth"; oauthIssuerOrigin?: string; oauthPreregistered?: boolean }> {
    const preregistered = entry.oauth?.clientId !== undefined ? { oauthPreregistered: true } : {};
    if (hasStaticAuthorization(entry.headers)) return { auth: "none", ...preregistered };
    let account: string;
    try {
      account = mcpOAuthTokenAccount(entry.url);
    } catch {
      return { auth: "none", ...preregistered };
    }
    const store = this.deps.store();
    let issuerOrigin: string | undefined;
    try {
      const raw = await store.read(mcpOAuthClientAccount(entry.url));
      if (raw !== null) issuerOrigin = originOf(decodeMcpOAuthClientRecord(raw).issuer);
    } catch { /* unreadable registration: no origin to show */ }
    const withOrigin = { ...(issuerOrigin !== undefined ? { oauthIssuerOrigin: issuerOrigin } : {}), ...preregistered };
    let raw: string | null = null;
    try { raw = await store.read(account); } catch { raw = null; }
    if (raw !== null) {
      try {
        const record = decodeMcpOAuthTokenRecord(raw);
        const now = (this.deps.now ?? Date.now)();
        const dead = record.refreshToken === undefined && record.expiresAt !== undefined && record.expiresAt <= now;
        return { auth: dead ? "needs-auth" : "signed-in", ...withOrigin };
      } catch {
        return { auth: "needs-auth", ...withOrigin };
      }
    }
    return { auth: entry.oauth !== undefined || probeStatus === "needs-auth" ? "needs-auth" : "none", ...withOrigin };
  }

  // --- lifecycle -------------------------------------------------------------------------------------

  /** A follow-up's failure is logged the way a failed reconnect is (`describeReconnectError`: name, code, masked and capped message). */
  private track(p: Promise<void> | void): void {
    if (p === undefined) return;
    const tracked = Promise.resolve(p).catch((err) => this.deps.log?.(`mcp: reconnecting live sessions failed (${describeReconnectError(err)})`)).finally(() => this.followUps.delete(tracked));
    this.followUps.add(tracked);
  }

  /** Resolves when every sign-in change's follow-up (live-session reconnects) has settled. */
  async settled(): Promise<void> {
    while (this.followUps.size > 0) await Promise.all([...this.followUps]);
  }

  /** Daemon shutdown: every pending sign-in is cancelled (its loopback listener closed). */
  dispose(): void {
    for (const entry of this.logins.values()) {
      clearTimeout(entry.timer);
      if (entry.state === "pending") entry.login.cancel();
    }
  }
}
