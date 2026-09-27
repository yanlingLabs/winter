// WS-25 fix round 1: `McpOAuthDoors` unit tests with a scripted `startLogin` (no network, no Keychain) —
// the client-registration snapshot is put back on EVERY exit that does not start a flow (I1), sign-ins for
// one server start one at a time (I1), a public pre-registered client takes no secret (minor 1), and a
// token without a refresh token is not dead inside its last minute (minor 2).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcpOAuthStore, decodeMcpOAuthClientSecretItem, encodeMcpOAuthClientRecord, encodeMcpOAuthTokenRecord, mcpOAuthClientAccount, mcpOAuthClientSecretAccount, mcpOAuthTokenAccount, McpOAuthError, type McpOAuthLogin } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { McpOAuthDoors } from "../../../src/agent/mcp/oauth-doors";

const URL_ = "https://mcp.example.test/mcp";

function homeWith(servers: Record<string, unknown>): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-oauth-doors-")));
  mkdirSync(join(home, "sdk"), { recursive: true });
  writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({ mcpServers: servers }));
  return home;
}

function clientRecord(issuer: string, clientId: string): string {
  return encodeMcpOAuthClientRecord({ v: 1, kind: "mcp-oauth-client", serverUrl: URL_, issuer, clientId, registeredVia: "dcr", redirectUri: "http://127.0.0.1:1/callback" });
}

function fakeLogin(issuer: string): McpOAuthLogin {
  const issuerOrigin = new URL(issuer).origin;
  return { authUrl: `${issuerOrigin}/authorize?state=x`, issuer, issuerOrigin, authorizeOrigin: issuerOrigin, done: new Promise(() => {}), cancel: () => {} };
}

describe("McpOAuthDoors.login — the registration snapshot (fix round 1, I1)", () => {
  test("a first leg that REGISTERS and then throws leaves the stored registration exactly as it was", async () => {
    const store = createMemoryMcpOAuthStore();
    const original = clientRecord("https://legit.example.test", "legit");
    await store.write(mcpOAuthClientAccount(URL_), original);
    const doors = new McpOAuthDoors({
      home: homeWith({ s: { type: "http", url: URL_ } }),
      store: () => store,
      startLogin: async (opts) => {
        await opts.store.write(mcpOAuthClientAccount(URL_), clientRecord("https://attacker.example.test", "evil"));
        throw new McpOAuthError("policy_refused", "the authorization URL is refused");
      },
    });
    await expect(doors.login(doors.resolve({ name: "s" }))).rejects.toMatchObject({ code: "mcp_login_failed" });
    expect(await store.read(mcpOAuthClientAccount(URL_))).toBe(original);
  });

  test("…and with no registration before, the one the failed leg added is removed", async () => {
    const store = createMemoryMcpOAuthStore();
    const doors = new McpOAuthDoors({
      home: homeWith({ s: { type: "http", url: URL_ } }),
      store: () => store,
      startLogin: async (opts) => {
        await opts.store.write(mcpOAuthClientAccount(URL_), clientRecord("https://attacker.example.test", "evil"));
        throw new McpOAuthError("login_failed", "nope");
      },
    });
    await expect(doors.login(doors.resolve({ name: "s" }))).rejects.toMatchObject({ code: "mcp_login_failed" });
    expect(await store.read(mcpOAuthClientAccount(URL_))).toBeNull();
  });

  test("a refused issuer change puts the snapshot back; a started flow keeps what it registered", async () => {
    const store = createMemoryMcpOAuthStore();
    const original = clientRecord("https://legit.example.test", "legit");
    await store.write(mcpOAuthClientAccount(URL_), original);
    const doors = new McpOAuthDoors({
      home: homeWith({ s: { type: "http", url: URL_ } }),
      store: () => store,
      startLogin: async (opts) => {
        await opts.store.write(mcpOAuthClientAccount(URL_), clientRecord("https://other.example.test", "other"));
        return fakeLogin("https://other.example.test");
      },
    });
    const server = doors.resolve({ name: "s" });
    await expect(doors.login(server)).rejects.toMatchObject({ code: "mcp_issuer_change_requires_confirmation" });
    expect(await store.read(mcpOAuthClientAccount(URL_))).toBe(original);
    await doors.login(server, { confirmIssuerChange: true });
    expect(await store.read(mcpOAuthClientAccount(URL_))).toBe(clientRecord("https://other.example.test", "other"));
    doors.dispose();
  });

  test("two concurrent sign-ins for one server start ONE AT A TIME: the second never snapshots the first's unconfirmed registration", async () => {
    const store = createMemoryMcpOAuthStore();
    const original = clientRecord("https://legit.example.test", "legit");
    await store.write(mcpOAuthClientAccount(URL_), original);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    let calls = 0;
    const doors = new McpOAuthDoors({
      home: homeWith({ s: { type: "http", url: URL_ } }),
      store: () => store,
      startLogin: async (opts) => {
        const n = ++calls;
        order.push(`start${n}`);
        await opts.store.write(mcpOAuthClientAccount(URL_), clientRecord("https://attacker.example.test", `evil${n}`));
        if (n === 1) await gate;
        order.push(`end${n}`);
        return fakeLogin("https://attacker.example.test");
      },
    });
    const server = doors.resolve({ name: "s" });
    // Settled values captured at once: the second rejects while the first is still being awaited below.
    const first = doors.login(server).then(() => undefined, (e: unknown) => e);
    const second = doors.login(server).then(() => undefined, (e: unknown) => e);
    await Bun.sleep(30);
    expect(order).toEqual(["start1"]); // the second waits for the first's start phase
    release();
    expect(await first).toMatchObject({ code: "mcp_issuer_change_requires_confirmation" });
    // The second snapshotted the RESTORED legit registration, so it is refused too — not waved through.
    expect(await second).toMatchObject({ code: "mcp_issuer_change_requires_confirmation", data: { storedIssuer: "https://legit.example.test", storedIssuerOrigin: "https://legit.example.test" } });
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
    expect(await store.read(mcpOAuthClientAccount(URL_))).toBe(original);
  });
});

describe("McpOAuthDoors.logout rides the same per-server chain (fix round 1 re-review)", () => {
  test("a sign-in start held at a gate + logout --forget-client → after both settle, no client record", async () => {
    const store = createMemoryMcpOAuthStore();
    await store.write(mcpOAuthClientAccount(URL_), clientRecord("https://legit.example.test", "legit"));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const doors = new McpOAuthDoors({
      home: homeWith({ s: { type: "http", url: URL_ } }),
      store: () => store,
      startLogin: async (opts) => {
        await opts.store.write(mcpOAuthClientAccount(URL_), clientRecord("https://attacker.example.test", "evil"));
        await gate;
        throw new McpOAuthError("login_failed", "nope"); // its finally restores the snapshot…
      },
      revoke: async ({ account, store: s, forgetClient }) => {
        await s.remove(account);
        if (forgetClient === true) await s.remove(mcpOAuthClientAccount(URL_));
      },
    });
    const server = doors.resolve({ name: "s" });
    const started = doors.login(server).then(() => undefined, (e: unknown) => e);
    const loggedOut = doors.logout(server, { forgetClient: true });
    await Bun.sleep(20);
    release();
    expect(await started).toMatchObject({ code: "mcp_login_failed" });
    await loggedOut;
    // …but the sign-out ran AFTER it, so the forgotten client stays forgotten.
    expect(await store.read(mcpOAuthClientAccount(URL_))).toBeNull();
  });
});

describe("McpOAuthDoors.login — FULL issuers, compared with sameIssuer (fix round 1, I1 steps 3-4)", () => {
  async function attempt(stored: string, flowIssuer: string, legWrites: boolean): Promise<{ error: unknown; store: ReturnType<typeof createMemoryMcpOAuthStore> }> {
    const store = createMemoryMcpOAuthStore();
    await store.write(mcpOAuthClientAccount(URL_), clientRecord(stored, "old"));
    const doors = new McpOAuthDoors({
      home: homeWith({ s: { type: "http", url: URL_ } }),
      store: () => store,
      startLogin: async (opts) => {
        if (legWrites) await opts.store.write(mcpOAuthClientAccount(URL_), clientRecord(flowIssuer, "new"));
        // The flow's own issuer deliberately disagrees when the leg wrote one: the READ-BACK record wins.
        return fakeLogin(legWrites ? "https://ignored.example.test" : flowIssuer);
      },
    });
    const error = await doors.login(doors.resolve({ name: "s" })).then(() => undefined, (e: unknown) => e);
    doors.dispose();
    return { error, store };
  }

  test("another TENANT on the same origin is an issuer change (an origin compare would miss it); both full issuers in the data", async () => {
    const { error } = await attempt("https://login.example.test/tenant-a", "https://login.example.test/tenant-b", true);
    expect(error).toMatchObject({
      code: "mcp_issuer_change_requires_confirmation",
      data: { storedIssuer: "https://login.example.test/tenant-a", newIssuer: "https://login.example.test/tenant-b", storedIssuerOrigin: "https://login.example.test", newIssuerOrigin: "https://login.example.test" },
    });
  });

  test("the same issuer ±1 trailing slash is NOT a change", async () => {
    expect((await attempt("https://as.example.test/t", "https://as.example.test/t/", true)).error).toBeUndefined();
  });

  test("the pre-registered path (leg 1 writes nothing) compares McpOAuthLogin.issuer", async () => {
    expect((await attempt("https://as.example.test/t1", "https://as.example.test/t2", false)).error).toMatchObject({ code: "mcp_issuer_change_requires_confirmation", data: { newIssuer: "https://as.example.test/t2" } });
    expect((await attempt("https://as.example.test/t1", "https://as.example.test/t1", false)).error).toBeUndefined();
  });
});

describe("McpOAuthDoors client secrets — discovered, confirmed, then written (fix round 1, minors 3-4)", () => {
  const ISSUER = "https://login.example.test/tenant-a";
  function setup(discovered = ISSUER) {
    const store = createMemoryMcpOAuthStore();
    let discoveries = 0;
    const doors = new McpOAuthDoors({
      home: homeWith({ gh: { type: "http", url: URL_, oauth: { clientId: "c", clientSecretRef: { kind: "keychain" } } } }),
      store: () => store,
      // No flow may start for a secret: a sign-in in flight would be superseded.
      startLogin: async () => { throw new Error("no sign-in flow for a client secret"); },
      discoverIssuer: async (opts) => {
        discoveries++;
        expect(opts.serverUrl).toBe(URL_);
        return { issuer: discovered, issuerOrigin: new URL(discovered).origin, authorizeOrigin: new URL(discovered).origin };
      },
    });
    return { store, doors, discoveries: () => discoveries };
  }

  test("clientSecretIssuer names the full issuer and writes nothing", async () => {
    const { store, doors } = setup();
    expect(await doors.clientSecretIssuer(doors.resolve({ name: "gh" }))).toEqual({ name: "gh", scope: "user", url: URL_, issuer: ISSUER, issuerOrigin: "https://login.example.test", authorizeOrigin: "https://login.example.test" });
    expect(store.entries.size).toBe(0);
  });

  test("without expectedIssuer nothing is written; the refusal carries the issuer to confirm", async () => {
    const { store, doors } = setup();
    await expect(doors.setClientSecret(doors.resolve({ name: "gh" }), "s3cret", undefined)).rejects.toMatchObject({ code: "mcp_expected_issuer_required", data: { issuer: ISSUER } });
    expect(store.entries.size).toBe(0);
  });

  test("a server that moved since the confirmation is refused (another tenant, same origin); nothing written", async () => {
    const { store, doors } = setup("https://login.example.test/tenant-b");
    await expect(doors.setClientSecret(doors.resolve({ name: "gh" }), "s3cret", ISSUER)).rejects.toMatchObject({ code: "mcp_issuer_changed", data: { issuer: "https://login.example.test/tenant-b" } });
    expect(store.entries.size).toBe(0);
  });

  test("confirmed → bound to the DISCOVERED issuer at the derived account, via discovery only", async () => {
    const { store, doors, discoveries } = setup();
    expect(await doors.setClientSecret(doors.resolve({ name: "gh" }), "s3cret", `${ISSUER}/`)).toEqual({ issuer: ISSUER, issuerOrigin: "https://login.example.test" });
    expect(decodeMcpOAuthClientSecretItem((await store.read(mcpOAuthClientSecretAccount(URL_)))!)).toEqual({ secret: "s3cret", issuer: ISSUER });
    expect(discoveries()).toBe(1);
  });
});

describe("McpOAuthDoors.setClientSecret — a public pre-registered client (fix round 1, minor 1)", () => {
  test("clientId without clientSecretRef is refused mcp_not_preregistered, and nothing is written", async () => {
    const store = createMemoryMcpOAuthStore();
    const doors = new McpOAuthDoors({ home: homeWith({ s: { type: "http", url: URL_, oauth: { clientId: "pub" } } }), store: () => store, startLogin: async () => { throw new Error("no discovery expected"); } });
    await expect(doors.setClientSecret(doors.resolve({ name: "s" }), "x", "https://as.example.test")).rejects.toMatchObject({ code: "mcp_not_preregistered" });
    expect(store.entries.size).toBe(0);
  });
});

describe("McpOAuthDoors.authColumns — dead means expired WITHOUT a refresh token (fix round 1, minor 2)", () => {
  const NOW = 1_000_000_000_000;
  async function authWith(record: { refreshToken?: string; expiresAt?: number }): Promise<string> {
    const store = createMemoryMcpOAuthStore();
    await store.write(mcpOAuthTokenAccount(URL_), encodeMcpOAuthTokenRecord({ v: 1, kind: "mcp-oauth", serverUrl: URL_, issuer: "https://as.example.test", accessToken: "a", generation: 1, ...record }));
    const doors = new McpOAuthDoors({ home: homeWith({}), store: () => store, now: () => NOW });
    return (await doors.authColumns({ url: URL_ }, undefined)).auth;
  }
  test("no refresh token: signed-in until expiresAt, even inside its last minute; needs-auth once expired", async () => {
    expect(await authWith({ expiresAt: NOW + 30_000 })).toBe("signed-in");
    expect(await authWith({ expiresAt: NOW })).toBe("needs-auth");
    expect(await authWith({ expiresAt: NOW - 1 })).toBe("needs-auth");
    expect(await authWith({})).toBe("signed-in");
  });
  test("with a refresh token: signed-in even when expired (the daemon refreshes it)", async () => {
    expect(await authWith({ expiresAt: NOW - 60_000, refreshToken: "r" })).toBe("signed-in");
  });
});

describe("the copied fixture authorization server (fix round 1, minor 7)", () => {
  // Drift guard: when the SDK source is reachable (a linked SDK worktree during development), the copy
  // must be the SDK's file plus exactly our provenance header. Skipped when only the published package
  // (which ships no src/) is installed.
  const copy = join(import.meta.dir, "..", "..", "fixtures", "mcp-oauth-fixture-as.ts");
  let sdkSource: string | undefined;
  try {
    const entry = Bun.resolveSync("@yanlinglabs/winter-agent-runtime/mcp-auth", import.meta.dir);
    const candidate = join(realpathSync(entry), "..", "mcp-auth", "test-fixture-as.ts");
    if (existsSync(candidate)) sdkSource = candidate;
  } catch { /* not resolvable: skipped */ }
  test.skipIf(sdkSource === undefined)("matches the linked SDK source byte-for-byte below its provenance header", () => {
    const ours = readFileSync(copy, "utf8");
    const header = ours.slice(0, ours.indexOf("// WS-25 (MCP OAuth) §3: THE FIXTURE"));
    expect(header.startsWith("// WS-25 (daemon-oauth lane): a VERBATIM COPY")).toBe(true);
    expect(ours.slice(header.length)).toBe(readFileSync(sdkSource!, "utf8"));
  });
});
