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
      if (method === METHODS.mcpLogin) return { loginId: "ml_1", authUrl: "https://as.example.test/authorize?state=S", issuerOrigin: "https://as.example.test", authorizeOrigin: "https://as.example.test", issuer: "https://as.example.test/tenant", name: "linear", scope: "user", url: "https://mcp.example.test/mcp" };
      if (method === METHODS.mcpLoginStatus) return { state: ++polls < 3 ? "pending" : "done" };
      throw new Error(`unexpected ${method}`);
    });
    const d = deps({ door, confirm: async () => true });
    const outcome = await runMcpLoginRoute(["linear"], d);
    expect(outcome).toEqual({ ok: true, kind: "login", name: "linear", via: "daemon", issuerOrigin: "https://as.example.test" });
    expect(door.calls[0]).toEqual({ method: METHODS.mcpLogin, params: { name: "linear", cwd: "/work/proj" } });
    expect(d.opened).toEqual(["https://as.example.test/authorize?state=S"]);
    expect(d.printed.join("\n")).toContain("https://as.example.test");
    expect(d.pokes).toBe(0); // the daemon did it itself
  });

  test("the resolved scope, URL and issuer are shown and confirmed BEFORE the browser opens; declined → nothing opened, nothing polled (security review M1)", async () => {
    const door = scriptedDoor((method) => {
      if (method === METHODS.mcpLogin) return { loginId: "ml_p", authUrl: "https://as.evil.test/authorize?state=S", issuerOrigin: "https://as.evil.test", authorizeOrigin: "https://as.evil.test", issuer: "https://as.evil.test", name: "linear", scope: "project", url: "https://mcp.evil.test/mcp" };
      throw new Error(`unexpected ${method}`);
    });
    const order: string[] = [];
    const d = deps({ door, confirm: async (q) => { order.push(`confirm:${q}`); return false; }, openBrowser: (u) => { order.push(`open:${u}`); } });
    d.print = (line) => { order.push(`print:${line}`); };
    const outcome = await runMcpLoginRoute(["linear"], d);
    expect(outcome).toMatchObject({ ok: false, code: "cancelled" });
    expect(order[0]).toBe("print:\"linear\" → project https://mcp.evil.test/mcp → issuer https://as.evil.test");
    expect(order[1]!.startsWith("confirm:")).toBe(true);
    expect(order.some((e) => e.startsWith("open:"))).toBe(false);
    expect(door.calls.map((c) => c.method)).toEqual([METHODS.mcpLogin]); // never polled
  });

  test("a changed authorization server asks first; confirmed → the call repeats with confirmIssuerChange", async () => {
    const door = scriptedDoor((method, params) => {
      if (method === METHODS.mcpLogin && params.confirmIssuerChange !== true) {
        return rpcError("changed", { code: "mcp_issuer_change_requires_confirmation", storedIssuer: "https://old.example.test/t1", newIssuer: "https://new.example.test/t2", storedIssuerOrigin: "https://old.example.test", newIssuerOrigin: "https://new.example.test" });
      }
      if (method === METHODS.mcpLogin) return { loginId: "ml_2", authUrl: "https://new.example.test/a", issuerOrigin: "https://new.example.test" };
      return { state: "done" };
    });
    const questions: string[] = [];
    const outcome = await runMcpLoginRoute(["linear", "-s", "user"], deps({ door, confirm: async (q) => { questions.push(q); return true; } }));
    expect(outcome.ok).toBe(true);
    // The FULL issuers are what the user is shown.
    expect(questions[0]).toContain("https://old.example.test/t1");
    expect(questions[0]).toContain("https://new.example.test/t2");
    expect(door.calls[1]!.params).toEqual({ name: "linear", scope: "user", cwd: "/work/proj", confirmIssuerChange: true });
  });

  test("declined → no sign-in; an expired or failed login is a typed failure", async () => {
    const changed = scriptedDoor(() => rpcError("changed", { code: "mcp_issuer_change_requires_confirmation", storedIssuerOrigin: "a", newIssuerOrigin: "b" }));
    expect(await runMcpLoginRoute(["x"], deps({ door: changed }))).toMatchObject({ ok: false, code: "mcp_issuer_change_requires_confirmation" });
    const expired = scriptedDoor((m) => (m === METHODS.mcpLogin ? { loginId: "l", authUrl: "u", issuerOrigin: "o" } : { state: "expired" }));
    expect(await runMcpLoginRoute(["x"], deps({ door: expired, confirm: async () => true }))).toMatchObject({ ok: false, code: "expired" });
    const failed = scriptedDoor((m) => (m === METHODS.mcpLogin ? { loginId: "l", authUrl: "u", issuerOrigin: "o" } : { state: "failed", error: "authorization_denied:access_denied" }));
    const f = await runMcpLoginRoute(["x"], deps({ door: failed, confirm: async () => true }));
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
      clientSecretIssuer: async () => ({ name: "linear", issuer: "https://as", issuerOrigin: "https://as", authorizeOrigin: "https://as" }),
      setClientSecret: async () => ({ issuer: "https://as", issuerOrigin: "https://as" }),
      dispose: () => { disposed = true; },
    };
    const d = deps({ local: () => local, confirm: async () => true });
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

describe("winter mcp set-secret (WS-25, fix round 1: confirm the issuer BEFORE the secret)", () => {
  const SECRET = "the-client-secret-VALUE";
  const ISSUER = "https://github.com/login/oauth";

  function secretDoor(over: (method: string, params: any) => unknown = () => undefined) {
    return scriptedDoor((method, params) => {
      const r = over(method, params);
      if (r !== undefined) return r;
      if (method === METHODS.mcpClientSecretIssuer) return { name: "gh", issuer: ISSUER, issuerOrigin: "https://github.com", authorizeOrigin: "https://github.com" };
      if (method === METHODS.mcpSetClientSecret) return { ok: true, issuer: ISSUER, issuerOrigin: "https://github.com" };
      throw new Error(`unexpected ${method}`);
    });
  }

  test("issuer shown and confirmed FIRST, then the masked prompt, then mcp.setClientSecret with the confirmed expectedIssuer", async () => {
    const door = secretDoor();
    const order: string[] = [];
    const outcome = await runMcpSetSecretRoute(["gh"], deps({
      door,
      confirm: async (q) => { order.push(`confirm:${q}`); return true; },
      readSecret: async (p) => { order.push(`prompt:${p}`); return `${SECRET}\n`; },
    }));
    expect(order[0]).toContain(ISSUER);
    expect(order[1]).toBe(`prompt:Client secret for "gh": `);
    expect(door.calls.map((c) => c.method)).toEqual([METHODS.mcpClientSecretIssuer, METHODS.mcpSetClientSecret]);
    expect(door.calls[1]!.params).toEqual({ name: "gh", cwd: "/work/proj", secret: SECRET, expectedIssuer: ISSUER });
    expect(outcome).toEqual({ ok: true, kind: "set-secret", name: "gh", via: "daemon", issuer: ISSUER });
    expect(renderMcpAuthOutcome(outcome)).not.toContain(SECRET);
    expect(renderMcpAuthOutcome(outcome)).toContain(ISSUER);
  });

  test("declined → the secret is never asked for and nothing is sent", async () => {
    let prompted = false;
    const door = secretDoor();
    const outcome = await runMcpSetSecretRoute(["gh"], deps({ door, confirm: async () => false, readSecret: async () => { prompted = true; return SECRET; } }));
    expect(outcome).toMatchObject({ ok: false, code: "not_confirmed" });
    expect(prompted).toBe(false);
    expect(door.calls.map((c) => c.method)).toEqual([METHODS.mcpClientSecretIssuer]);
  });

  test("never an argument, never a pipe: an extra positional and a non-TTY stdin are refused before anything", async () => {
    let prompted = false;
    const door = secretDoor();
    const d = deps({ door, confirm: async () => true, readSecret: async () => { prompted = true; return SECRET; } });
    const arg = await runMcpSetSecretRoute(["gh", SECRET], d);
    expect(arg).toMatchObject({ ok: false });
    expect((arg as { message: string }).message).toContain("masked prompt");
    expect(await runMcpSetSecretRoute(["gh"], { ...d, stdinIsTTY: false })).toMatchObject({ ok: false });
    expect(prompted).toBe(false);
    expect(door.calls).toEqual([]);
  });

  test("a refusal never echoes the secret, even if a message quoted it; a moved issuer is typed", async () => {
    const quoting = secretDoor((m) => (m === METHODS.mcpSetClientSecret ? rpcError(`refused ${SECRET}`, { code: "mcp_issuer_changed", issuer: "https://elsewhere" }) : undefined));
    const outcome = await runMcpSetSecretRoute(["gh"], deps({ door: quoting, confirm: async () => true, readSecret: async () => SECRET }));
    expect(outcome).toMatchObject({ ok: false, code: "mcp_issuer_changed" });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test("with no daemon the same order runs in-process", async () => {
    const calls: string[] = [];
    const local: McpAuthLocalDoors = {
      resolve: (p) => p,
      login: async () => { throw new Error("unused"); },
      loginStatus: () => ({ state: "done" }),
      logout: async () => {},
      clientSecretIssuer: async () => { calls.push("issuer"); return { name: "gh", issuer: ISSUER, issuerOrigin: "https://github.com", authorizeOrigin: "https://github.com" }; },
      setClientSecret: async (_s, secret, expected) => { calls.push(`set:${secret}:${expected}`); return { issuer: ISSUER, issuerOrigin: "https://github.com" }; },
      dispose: () => { calls.push("dispose"); },
    };
    const outcome = await runMcpSetSecretRoute(["gh"], deps({ local: () => local, confirm: async () => true, readSecret: async () => SECRET }));
    expect(outcome).toMatchObject({ ok: true, via: "in-process", issuer: ISSUER });
    expect(calls).toEqual(["issuer", `set:${SECRET}:${ISSUER}`, "dispose"]);
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

describe("the non-interactive doors (an agent's `!` shell): set-secret --from-clipboard, login --yes", () => {
  const SECRET = "clipboard-client-SECRET-5c1e";
  const ISSUER = "https://github.com/login/oauth";
  const URL_ = "https://api.githubcopilot.com/mcp/";

  function fakeClipboard(value: string, opts: { clearFails?: boolean } = {}) {
    const c = {
      value, reads: 0, clears: 0,
      read: async () => { c.reads++; return c.value; },
      clear: async () => { c.clears++; if (opts.clearFails === true) throw new Error("pbcopy failed"); c.value = ""; },
    };
    return c;
  }
  function secretDoor(over: (method: string, params: any) => unknown = () => undefined) {
    return scriptedDoor((method, params) => {
      const r = over(method, params);
      if (r !== undefined) return r;
      if (method === METHODS.mcpClientSecretIssuer) return { name: "gh", scope: "user", url: URL_, issuer: ISSUER, issuerOrigin: "https://github.com", authorizeOrigin: "https://github.com" };
      if (method === METHODS.mcpSetClientSecret) return { ok: true, issuer: ISSUER, issuerOrigin: "https://github.com" };
      throw new Error(`unexpected ${method}`);
    });
  }
  const noAsk = { confirm: async () => { throw new Error("must not ask"); }, readSecret: async () => { throw new Error("must not prompt"); }, stdinIsTTY: false, platform: "darwin" };

  test("without --issuer: prints the target and the exact re-run, reads nothing, writes nothing", async () => {
    const clip = fakeClipboard(SECRET);
    const door = secretDoor();
    const d = deps({ door, clipboard: clip, ...noAsk });
    const outcome = await runMcpSetSecretRoute(["gh", "--from-clipboard"], d);
    expect(outcome).toMatchObject({ ok: false, code: "issuer_confirmation_required" });
    expect(d.printed).toEqual([`"gh" → user ${URL_} → issuer ${ISSUER}`]);
    expect((outcome as { message: string }).message).toContain(`--issuer ${ISSUER}`);
    expect(clip.reads).toBe(0);
    expect(clip.clears).toBe(0);
    expect(door.calls.map((c) => c.method)).toEqual([METHODS.mcpClientSecretIssuer]);
  });

  test("a --issuer that is not the discovered one is refused before the clipboard is touched", async () => {
    const clip = fakeClipboard(SECRET);
    const door = secretDoor();
    const outcome = await runMcpSetSecretRoute(["gh", "--from-clipboard", "--issuer", "https://evil.example/oauth"], deps({ door, clipboard: clip, ...noAsk }));
    expect(outcome).toMatchObject({ ok: false, code: "mcp_issuer_changed" });
    expect(clip.reads).toBe(0);
    expect(clip.clears).toBe(0);
    expect(door.calls.map((c) => c.method)).toEqual([METHODS.mcpClientSecretIssuer]);
  });

  test("the daemon's own re-discovery refusing the write leaves the clipboard alone and never echoes the value", async () => {
    const clip = fakeClipboard(`${SECRET}\n`);
    const door = secretDoor((m) => (m === METHODS.mcpSetClientSecret ? rpcError(`moved ${SECRET}`, { code: "mcp_issuer_changed", issuer: "https://elsewhere" }) : undefined));
    const d = deps({ door, clipboard: clip, ...noAsk });
    const outcome = await runMcpSetSecretRoute(["gh", "--from-clipboard", "--issuer", ISSUER], d);
    expect(outcome).toMatchObject({ ok: false, code: "mcp_issuer_changed" });
    expect(clip.clears).toBe(0);
    expect(clip.value).toBe(`${SECRET}\n`);
    expect(JSON.stringify(outcome) + d.printed.join("\n")).not.toContain(SECRET);
  });

  test("success: one trailing newline trimmed, sent with expectedIssuer = --issuer, the clipboard cleared, the value and its length never printed", async () => {
    const clip = fakeClipboard(`${SECRET}\n`);
    const door = secretDoor();
    const d = deps({ door, clipboard: clip, ...noAsk });
    const outcome = await runMcpSetSecretRoute(["gh", "--from-clipboard", "--issuer", ISSUER], d);
    expect(outcome).toEqual({ ok: true, kind: "set-secret", name: "gh", via: "daemon", issuer: ISSUER, clipboardCleared: true });
    expect(door.calls[1]!.params).toEqual({ name: "gh", cwd: "/work/proj", secret: SECRET, expectedIssuer: ISSUER });
    expect(clip.clears).toBe(1);
    const shown = d.printed.join("\n") + renderMcpAuthOutcome(outcome);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain(String(SECRET.length));
    expect(renderMcpAuthOutcome(outcome)).toContain("clipboard was cleared");
    // A clipboard that cannot be cleared is said so, not hidden.
    const stuck = fakeClipboard(SECRET, { clearFails: true });
    const r = await runMcpSetSecretRoute(["gh", "--from-clipboard", "--issuer", `${ISSUER}/`], deps({ door: secretDoor(), clipboard: stuck, ...noAsk }));
    expect(renderMcpAuthOutcome(r)).toContain("could NOT be cleared");
  });

  test("empty, multi-line or implausible clipboard contents are refused typed; nothing is sent or cleared", async () => {
    for (const [value, code] of [["", "clipboard_empty"], ["\n", "clipboard_empty"], ["line-one\nline-two", "clipboard_not_a_secret"], ["x".repeat(513), "clipboard_not_a_secret"], [" padded ", "clipboard_not_a_secret"]] as const) {
      const clip = fakeClipboard(value);
      const door = secretDoor();
      const outcome = await runMcpSetSecretRoute(["gh", "--from-clipboard", "--issuer", ISSUER], deps({ door, clipboard: clip, ...noAsk }));
      expect(outcome).toMatchObject({ ok: false, code });
      expect(clip.clears).toBe(0);
      expect(door.calls.map((c) => c.method)).toEqual([METHODS.mcpClientSecretIssuer]);
    }
  });

  test("--from-clipboard is macOS-only; --issuer without it is a usage error; the interactive path is unchanged", async () => {
    const clip = fakeClipboard(SECRET);
    const door = secretDoor();
    expect(await runMcpSetSecretRoute(["gh", "--from-clipboard", "--issuer", ISSUER], deps({ door, clipboard: clip, ...noAsk, platform: "linux" }))).toMatchObject({ ok: false, code: "clipboard_unsupported" });
    expect(await runMcpSetSecretRoute(["gh", "--issuer", ISSUER], deps({ door, clipboard: clip, ...noAsk }))).toMatchObject({ ok: false });
    expect(clip.reads).toBe(0);
    expect(door.calls).toEqual([]);
  });

  test("with no daemon the same clipboard door runs in-process (and pokes a live daemon)", async () => {
    const clip = fakeClipboard(SECRET);
    let stored: { secret: string; expected: string | undefined } | undefined;
    const local: McpAuthLocalDoors = {
      resolve: (p) => p,
      login: async () => { throw new Error("no"); },
      loginStatus: () => ({ state: "done" }),
      logout: async () => {},
      clientSecretIssuer: async () => ({ name: "gh", scope: "user", url: URL_, issuer: ISSUER, issuerOrigin: "https://github.com", authorizeOrigin: "https://github.com" }),
      setClientSecret: async (_s, secret, expected) => { stored = { secret, expected }; return { issuer: ISSUER, issuerOrigin: "https://github.com" }; },
      dispose: () => {},
    };
    const d = deps({ local: () => local, clipboard: clip, ...noAsk });
    expect(await runMcpSetSecretRoute(["gh", "--from-clipboard"], d)).toMatchObject({ ok: false, code: "issuer_confirmation_required" });
    expect(stored).toBeUndefined();
    expect(await runMcpSetSecretRoute(["gh", "--from-clipboard", "--issuer", ISSUER], d)).toMatchObject({ ok: true, via: "in-process", clipboardCleared: true });
    expect(stored).toEqual({ secret: SECRET, expected: ISSUER });
    expect(d.pokes).toBe(1);
  });

  test("login --yes skips the open-the-browser question (the target line is still printed) but NOT the issuer-change guard", async () => {
    const start = { loginId: "ml_y", authUrl: "https://as.example.test/authorize?state=S", issuerOrigin: "https://as.example.test", authorizeOrigin: "https://as.example.test", issuer: "https://as.example.test", name: "linear", scope: "user", url: "https://mcp.example.test/mcp" };
    const plain = scriptedDoor((m) => (m === METHODS.mcpLogin ? start : { state: "done" }));
    const d = deps({ door: plain, ...noAsk });
    expect(await runMcpLoginRoute(["linear", "--yes"], d)).toMatchObject({ ok: true });
    expect(d.printed[0]).toBe(`"linear" → user https://mcp.example.test/mcp → issuer https://as.example.test`);
    expect(d.opened).toEqual([start.authUrl]);

    const change = rpcError("changed", { code: "mcp_issuer_change_requires_confirmation", storedIssuer: "https://old.example.test", newIssuer: "https://as.example.test", storedIssuerOrigin: "https://old.example.test", newIssuerOrigin: "https://as.example.test" });
    const changed = scriptedDoor((m, p) => (m === METHODS.mcpLogin ? (p.confirmIssuerChange === true ? start : change) : { state: "done" }));
    // --yes alone: the change is still asked (and a shell that cannot answer declines) — never implied.
    const refused = await runMcpLoginRoute(["linear", "--yes"], deps({ door: changed, ...noAsk, confirm: async () => false }));
    expect(refused).toMatchObject({ ok: false, code: "mcp_issuer_change_requires_confirmation" });
    expect((refused as { message: string }).message).toContain("--confirm-issuer-change");
    expect(changed.calls.filter((c) => c.method === METHODS.mcpLogin).map((c) => c.params.confirmIssuerChange)).toEqual([undefined]);
    // The explicit flag accepts it (printed, not asked), and --yes then skips the browser question.
    const changed2 = scriptedDoor((m, p) => (m === METHODS.mcpLogin ? (p.confirmIssuerChange === true ? start : change) : { state: "done" }));
    const d2 = deps({ door: changed2, ...noAsk });
    expect(await runMcpLoginRoute(["linear", "--yes", "--confirm-issuer-change"], d2)).toMatchObject({ ok: true });
    expect(d2.printed[0]).toContain("--confirm-issuer-change");
    expect(changed2.calls.filter((c) => c.method === METHODS.mcpLogin).map((c) => c.params.confirmIssuerChange)).toEqual([undefined, true]);
  });
});
