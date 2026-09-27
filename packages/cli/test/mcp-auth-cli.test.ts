// WS-25 (MCP OAuth): `winter mcp login|logout|set-secret` — `mcp-cli.ts`'s routes, with a scripted daemon
// door and fake in-process doors (no socket, no Keychain, no browser, no network).
import { describe, expect, test } from "bun:test";
import { METHODS } from "@yanlinglabs/winter-protocol";
import { runMcpLoginRoute, runMcpLogoutRoute, runMcpSetSecretRoute, renderMcpAuthOutcome, mcpAuthNote, type McpAuthDeps, type McpAuthLocalDoors, type McpAuthRpcDoor } from "../src/mcp-cli";

function rpcError(message: string, data: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { rpc: { message, code: -32602, data } });
}

function scriptedDoor(handler: (method: string, params: any) => unknown): McpAuthRpcDoor & { calls: Array<{ method: string; params: any }> } {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const r = handler(method, params);
      if (r instanceof Error) throw r;
      return r;
    },
    close() {},
  };
}

function deps(over: Partial<McpAuthDeps> = {}): McpAuthDeps & { printed: string[]; opened: string[]; pokes: number } {
  const printed: string[] = [];
  const opened: string[] = [];
  const out = {
    printed, opened, pokes: 0,
    cwd: "/work/proj",
    local: () => { throw new Error("no in-process doors in this test"); },
    openBrowser: (url: string) => { opened.push(url); },
    confirm: async () => false,
    readSecret: async () => "",
    stdinIsTTY: true,
    print: (line: string) => { printed.push(line); },
    poke: async () => { out.pokes++; return true; },
    sleep: async () => {},
    pollMs: 0,
    ...over,
  };
  return out as never;
}

describe("winter mcp login (WS-25)", () => {
  test("through the daemon: login with the cwd, show the issuer, open the browser, poll to done", async () => {
    let polls = 0;
    const door = scriptedDoor((method) => {
      if (method === METHODS.mcpLogin) return { loginId: "ml_1", authUrl: "https://as.example.test/authorize?state=S", issuerOrigin: "https://as.example.test", authorizeOrigin: "https://as.example.test" };
      if (method === METHODS.mcpLoginStatus) return { state: ++polls < 3 ? "pending" : "done" };
      throw new Error(`unexpected ${method}`);
    });
    const d = deps({ door });
    const outcome = await runMcpLoginRoute(["linear"], d);
    expect(outcome).toEqual({ ok: true, kind: "login", name: "linear", via: "daemon", issuerOrigin: "https://as.example.test" });
    expect(door.calls[0]).toEqual({ method: METHODS.mcpLogin, params: { name: "linear", cwd: "/work/proj" } });
    expect(d.opened).toEqual(["https://as.example.test/authorize?state=S"]);
    expect(d.printed.join("\n")).toContain("https://as.example.test");
    expect(d.pokes).toBe(0); // the daemon did it itself
  });

  test("a changed authorization server asks first; confirmed → the call repeats with confirmIssuerChange", async () => {
    const door = scriptedDoor((method, params) => {
      if (method === METHODS.mcpLogin && params.confirmIssuerChange !== true) {
        return rpcError("changed", { code: "mcp_issuer_change_requires_confirmation", storedIssuerOrigin: "https://old.example.test", newIssuerOrigin: "https://new.example.test" });
      }
      if (method === METHODS.mcpLogin) return { loginId: "ml_2", authUrl: "https://new.example.test/a", issuerOrigin: "https://new.example.test" };
      return { state: "done" };
    });
    const questions: string[] = [];
    const outcome = await runMcpLoginRoute(["linear", "-s", "user"], deps({ door, confirm: async (q) => { questions.push(q); return true; } }));
    expect(outcome.ok).toBe(true);
    expect(questions[0]).toContain("https://old.example.test");
    expect(questions[0]).toContain("https://new.example.test");
    expect(door.calls[1]!.params).toEqual({ name: "linear", scope: "user", cwd: "/work/proj", confirmIssuerChange: true });
  });

  test("declined → no sign-in; an expired or failed login is a typed failure", async () => {
    const changed = scriptedDoor(() => rpcError("changed", { code: "mcp_issuer_change_requires_confirmation", storedIssuerOrigin: "a", newIssuerOrigin: "b" }));
    expect(await runMcpLoginRoute(["x"], deps({ door: changed }))).toMatchObject({ ok: false, code: "mcp_issuer_change_requires_confirmation" });
    const expired = scriptedDoor((m) => (m === METHODS.mcpLogin ? { loginId: "l", authUrl: "u", issuerOrigin: "o" } : { state: "expired" }));
    expect(await runMcpLoginRoute(["x"], deps({ door: expired }))).toMatchObject({ ok: false, code: "expired" });
    const failed = scriptedDoor((m) => (m === METHODS.mcpLogin ? { loginId: "l", authUrl: "u", issuerOrigin: "o" } : { state: "failed", error: "authorization_denied:access_denied" }));
    const f = await runMcpLoginRoute(["x"], deps({ door: failed }));
    expect(f).toMatchObject({ ok: false, code: "failed" });
    expect(renderMcpAuthOutcome(f)).toContain("authorization_denied");
  });

  test("with no daemon the SAME doors run in-process, are disposed, and a live daemon is poked", async () => {
    let disposed = false;
    const local: McpAuthLocalDoors = {
      resolve: (p) => p,
      login: async () => ({ loginId: "ml_l", authUrl: "https://as/a", issuerOrigin: "https://as", authorizeOrigin: "https://as" }),
      loginStatus: () => ({ state: "done" }),
      logout: async () => {},
      setClientSecret: async () => ({ issuerOrigin: "https://as" }),
      dispose: () => { disposed = true; },
    };
    const d = deps({ local: () => local });
    expect(await runMcpLoginRoute(["linear"], d)).toMatchObject({ ok: true, via: "in-process" });
    expect(disposed).toBe(true);
    expect(d.pokes).toBe(1);
  });
});

describe("winter mcp logout (WS-25)", () => {
  test("--forget-client reaches the wire; an unknown option is a usage error", async () => {
    const door = scriptedDoor(() => ({ ok: true }));
    expect(await runMcpLogoutRoute(["linear", "--forget-client"], deps({ door }))).toEqual({ ok: true, kind: "logout", name: "linear", via: "daemon" });
    expect(door.calls[0]).toEqual({ method: METHODS.mcpLogout, params: { name: "linear", cwd: "/work/proj", forgetClient: true } });
    expect(await runMcpLogoutRoute(["linear", "--nope"], deps({ door }))).toMatchObject({ ok: false });
  });

  test("a typed refusal carries its code", async () => {
    const door = scriptedDoor(() => rpcError("no MCP server named \"x\"", { code: "mcp_server_not_found" }));
    expect(await runMcpLogoutRoute(["x"], deps({ door }))).toEqual({ ok: false, message: "no MCP server named \"x\"", code: "mcp_server_not_found" });
  });
});

describe("winter mcp set-secret (WS-25)", () => {
  const SECRET = "the-client-secret-VALUE";

  test("the secret comes in ONLY at the masked prompt and goes to mcp.setClientSecret; never printed", async () => {
    const door = scriptedDoor(() => ({ ok: true, issuerOrigin: "https://github.com" }));
    const prompts: string[] = [];
    const outcome = await runMcpSetSecretRoute(["gh"], deps({ door, readSecret: async (p) => { prompts.push(p); return `${SECRET}\n`; } }));
    expect(prompts).toEqual([`Client secret for "gh": `]);
    expect(door.calls[0]).toEqual({ method: METHODS.mcpSetClientSecret, params: { name: "gh", cwd: "/work/proj", secret: SECRET } });
    expect(outcome).toEqual({ ok: true, kind: "set-secret", name: "gh", via: "daemon", issuerOrigin: "https://github.com" });
    expect(renderMcpAuthOutcome(outcome)).not.toContain(SECRET);
    expect(renderMcpAuthOutcome(outcome)).toContain("https://github.com");
  });

  test("never an argument, never a pipe: an extra positional and a non-TTY stdin are refused before any prompt", async () => {
    let prompted = false;
    const d = deps({ door: scriptedDoor(() => ({ ok: true })), readSecret: async () => { prompted = true; return SECRET; } });
    const arg = await runMcpSetSecretRoute(["gh", SECRET], d);
    expect(arg).toMatchObject({ ok: false });
    expect((arg as { message: string }).message).toContain("masked prompt");
    const piped = await runMcpSetSecretRoute(["gh"], { ...d, stdinIsTTY: false });
    expect(piped).toMatchObject({ ok: false });
    expect(prompted).toBe(false);
  });

  test("a refusal never echoes the secret, even if a message quoted it", async () => {
    const door = scriptedDoor(() => rpcError(`refused ${SECRET}`, { code: "mcp_not_preregistered" }));
    const outcome = await runMcpSetSecretRoute(["gh"], deps({ door, readSecret: async () => SECRET }));
    expect(outcome).toMatchObject({ ok: false, code: "mcp_not_preregistered" });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});

describe("winter mcp list's auth note (WS-25)", () => {
  test("signed-in / needs sign-in with the issuer origin; none and absent print nothing", () => {
    expect(mcpAuthNote({ auth: "signed-in", oauthIssuerOrigin: "https://as" })).toBe("signed in at https://as");
    expect(mcpAuthNote({ auth: "needs-auth" })).toBe("needs sign-in (winter mcp login)");
    expect(mcpAuthNote({ auth: "none" })).toBe("");
    expect(mcpAuthNote({})).toBe("");
  });
});
