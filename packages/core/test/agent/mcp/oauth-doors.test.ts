// WS-25 fix round 1: `McpOAuthDoors` unit tests with a scripted `startLogin` (no network, no Keychain) —
// the client-registration snapshot is put back on EVERY exit that does not start a flow (I1), sign-ins for
// one server start one at a time (I1), a public pre-registered client takes no secret (minor 1), and a
// token without a refresh token is not dead inside its last minute (minor 2).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcpOAuthStore, encodeMcpOAuthClientRecord, encodeMcpOAuthTokenRecord, mcpOAuthClientAccount, mcpOAuthTokenAccount, McpOAuthError, type McpOAuthLogin } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
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

function fakeLogin(issuerOrigin: string): McpOAuthLogin {
  return { authUrl: `${issuerOrigin}/authorize?state=x`, issuerOrigin, authorizeOrigin: issuerOrigin, done: new Promise(() => {}), cancel: () => {} };
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
    expect(await second).toMatchObject({ code: "mcp_issuer_change_requires_confirmation", data: { storedIssuerOrigin: "https://legit.example.test" } });
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
    expect(await store.read(mcpOAuthClientAccount(URL_))).toBe(original);
  });
});

describe("McpOAuthDoors.setClientSecret — a public pre-registered client (fix round 1, minor 1)", () => {
  test("clientId without clientSecretRef is refused mcp_not_preregistered, and nothing is written", async () => {
    const store = createMemoryMcpOAuthStore();
    const doors = new McpOAuthDoors({ home: homeWith({ s: { type: "http", url: URL_, oauth: { clientId: "pub" } } }), store: () => store, startLogin: async () => { throw new Error("no discovery expected"); } });
    await expect(doors.setClientSecret(doors.resolve({ name: "s" }), "x")).rejects.toMatchObject({ code: "mcp_not_preregistered" });
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
