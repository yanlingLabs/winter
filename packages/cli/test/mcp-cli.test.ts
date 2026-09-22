import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectMcpConfig } from "@yanlinglabs/winter-core";
import {
  parseMcpAddArgs, parseMcpAddJsonArgs, parseMcpRemoveArgs, parseMcpGetArgs,
  ensureMcpScope, ensureMcpTransport, parseMcpHeaders, parseMcpEnv, looksLikeMcpUrl,
  buildMcpEntry, runMcpAddRoute, runMcpAddJsonRoute, runMcpRemoveRoute, runMcpGetRoute,
  renderMcpAddOutcome, renderMcpRemoveOutcome, renderMcpGetOutcome,
  type McpDoor, type McpRouteDeps,
} from "../src/mcp-cli";

describe("parseMcpAddArgs", () => {
  test("name + command, no flags", () => {
    const r = parseMcpAddArgs(["my-server", "npx"]);
    expect(r).toEqual({ kind: "ok", parsed: { name: "my-server", commandOrUrl: "npx", trailingArgs: [], scopeRaw: undefined, transportRaw: undefined, envArgs: [], headerArgs: [] } });
  });

  test("trailing positional args (no --) become the stdio command's own args", () => {
    const r = parseMcpAddArgs(["my-server", "npx", "my-mcp-pkg"]);
    expect(r).toEqual({ kind: "ok", parsed: { name: "my-server", commandOrUrl: "npx", trailingArgs: ["my-mcp-pkg"], scopeRaw: undefined, transportRaw: undefined, envArgs: [], headerArgs: [] } });
  });

  test("flags anywhere before the positionals, -e/-H repeatable", () => {
    const r = parseMcpAddArgs(["-e", "API_KEY=xxx", "-s", "project", "my-server", "-e", "OTHER=1", "npx", "my-mcp"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.parsed.scopeRaw).toBe("project");
    expect(r.parsed.envArgs).toEqual(["API_KEY=xxx", "OTHER=1"]);
    expect(r.parsed.name).toBe("my-server");
    expect(r.parsed.commandOrUrl).toBe("npx");
    expect(r.parsed.trailingArgs).toEqual(["my-mcp"]);
  });

  test("`--` stops flag parsing — everything after is the command's own args verbatim, even if flag-shaped", () => {
    const r = parseMcpAddArgs(["-e", "API_KEY=xxx", "my-server", "--", "my-command", "--some-flag", "arg1"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.parsed.commandOrUrl).toBe("my-command");
    expect(r.parsed.trailingArgs).toEqual(["--some-flag", "arg1"]);
    expect(r.parsed.envArgs).toEqual(["API_KEY=xxx"]);
  });

  test("missing name -> usageError", () => {
    expect(parseMcpAddArgs([])).toMatchObject({ kind: "usageError" });
  });

  test("missing command -> usageError", () => {
    expect(parseMcpAddArgs(["my-server"])).toMatchObject({ kind: "usageError" });
  });

  test("-t/--transport recognized", () => {
    const r = parseMcpAddArgs(["-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.parsed.transportRaw).toBe("http");
  });

  test("-H repeatable", () => {
    const r = parseMcpAddArgs(["-t", "http", "-H", "Authorization: Bearer x", "-H", "X-Custom: value", "name", "https://x"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.parsed.headerArgs).toEqual(["Authorization: Bearer x", "X-Custom: value"]);
  });
});

describe("parseMcpAddJsonArgs / parseMcpRemoveArgs / parseMcpGetArgs", () => {
  test("add-json requires name and json", () => {
    expect(parseMcpAddJsonArgs(["name"])).toMatchObject({ kind: "usageError" });
    expect(parseMcpAddJsonArgs(["name", "{}"])).toEqual({ kind: "ok", parsed: { name: "name", json: "{}", scopeRaw: undefined } });
  });
  test("add-json accepts -s anywhere", () => {
    expect(parseMcpAddJsonArgs(["-s", "project", "name", "{}"])).toEqual({ kind: "ok", parsed: { name: "name", json: "{}", scopeRaw: "project" } });
  });
  test("remove requires a name", () => {
    expect(parseMcpRemoveArgs([])).toMatchObject({ kind: "usageError" });
    expect(parseMcpRemoveArgs(["foo", "-s", "user"])).toEqual({ kind: "ok", parsed: { name: "foo", scopeRaw: "user" } });
  });
  test("get requires a name", () => {
    expect(parseMcpGetArgs([])).toMatchObject({ kind: "usageError" });
    expect(parseMcpGetArgs(["foo"])).toEqual({ kind: "ok", name: "foo" });
  });
});

describe("ensureMcpScope / ensureMcpTransport", () => {
  test("default scope is user", () => expect(ensureMcpScope(undefined)).toEqual({ kind: "ok", scope: "user" }));
  test("user and project are ok", () => {
    expect(ensureMcpScope("user")).toEqual({ kind: "ok", scope: "user" });
    expect(ensureMcpScope("project")).toEqual({ kind: "ok", scope: "project" });
  });
  test("local is refused with an explanation, not silently accepted", () => {
    const r = ensureMcpScope("local");
    expect(r.kind).toBe("localRefused");
    if (r.kind !== "localRefused") throw new Error("expected localRefused");
    expect(r.message).toMatch(/no private per-project MCP scope/);
  });
  test("anything else is invalid", () => expect(ensureMcpScope("bogus")).toMatchObject({ kind: "invalid" }));

  test("default transport is stdio", () => expect(ensureMcpTransport(undefined)).toEqual({ kind: "ok", transport: "stdio" }));
  test("stdio/http/sse are ok", () => {
    for (const t of ["stdio", "http", "sse"] as const) expect(ensureMcpTransport(t)).toEqual({ kind: "ok", transport: t });
  });
  test("anything else is invalid", () => expect(ensureMcpTransport("bogus")).toMatchObject({ kind: "invalid" }));
});

describe("parseMcpHeaders / parseMcpEnv / looksLikeMcpUrl", () => {
  test("parses Name: value pairs, trimming whitespace", () => {
    expect(parseMcpHeaders(["Authorization: Bearer abc", "X-Foo:bar"])).toEqual({ kind: "ok", headers: { Authorization: "Bearer abc", "X-Foo": "bar" } });
  });
  test("refuses a header with no colon", () => {
    expect(parseMcpHeaders(["no-colon-here"])).toMatchObject({ kind: "invalid" });
  });
  test("parses KEY=value, splitting on the FIRST =", () => {
    expect(parseMcpEnv(["A=1", "B=c=d"])).toEqual({ kind: "ok", env: { A: "1", B: "c=d" } });
  });
  test("refuses a malformed env arg", () => {
    expect(parseMcpEnv(["no-equals"])).toMatchObject({ kind: "invalid" });
  });
  test("looksLikeMcpUrl flags http(s)/localhost/sse/mcp-shaped commands", () => {
    expect(looksLikeMcpUrl("https://mcp.sentry.dev/mcp")).toBe(true);
    expect(looksLikeMcpUrl("npx")).toBe(false);
  });
});

describe("buildMcpEntry", () => {
  test("stdio: command/args/env", () => {
    const r = parseMcpAddArgs(["-e", "A=1", "my-server", "npx", "pkg"]);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(buildMcpEntry(r.parsed, "stdio")).toEqual({ kind: "ok", entry: { type: "stdio", command: "npx", args: ["pkg"], env: { A: "1" } } });
  });
  test("http: url/headers", () => {
    const r = parseMcpAddArgs(["-H", "Authorization: Bearer x", "sentry", "https://mcp.sentry.dev/mcp"]);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(buildMcpEntry(r.parsed, "http")).toEqual({ kind: "ok", entry: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer x" } } });
  });
});

describe("route functions (no daemon — direct settings.json / .mcp.json writes)", () => {
  let dir: string;
  let winterHome: string;
  let cwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winter-mcp-cli-"));
    winterHome = join(dir, "home");
    cwd = join(dir, "project");
    mkdirSync(winterHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    // Written as a raw JSON file (not via `saveSettings`) — the CLI package's public
    // `@yanlinglabs/winter-core` surface deliberately exposes `Settings` as a TYPE only, not the
    // runtime zod schema, so a test fixture here is built the same way a hand-edited settings.json
    // would be (`loadSettings` inside the route functions still validates it on every read).
    writeFileSync(join(winterHome, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }, null, 2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function deps(): McpRouteDeps { return { cwd, winterHome }; }

  test("add (user scope, default) writes settings.mcpServers and reports via:local", async () => {
    const outcome = await runMcpAddRoute(["my-server", "npx", "my-mcp"], deps());
    expect(outcome).toEqual({ ok: true, scope: "user", name: "my-server", transport: "stdio", via: "local" });
    const raw = JSON.parse(readFileSync(join(winterHome, "settings.json"), "utf8"));
    expect(raw.mcpServers["my-server"]).toEqual({ type: "stdio", command: "npx", args: ["my-mcp"] });
  });

  test("add refuses a reserved name, writing nothing", async () => {
    const outcome = await runMcpAddRoute(["winter__browser", "npx"], deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.message).toMatch(/reserved/);
  });

  test("add refuses a credential-shaped header, surfaced as a clear message", async () => {
    const outcome = await runMcpAddRoute(["-t", "http", "-H", "Authorization: Bearer sk-x", "remote", "https://example.com/mcp"], deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.message).toMatch(/credential-shaped/);
  });

  test("add --scope local is refused with an explanation, not silently mapped to user or project", async () => {
    const outcome = await runMcpAddRoute(["-s", "local", "my-server", "npx"], deps());
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/no private per-project MCP scope/) });
  });

  test("add --scope project --transport http is refused — the WRITE door only writes stdio (the reader itself now accepts http/sse, per-entry)", async () => {
    const outcome = await runMcpAddRoute(["-s", "project", "-t", "http", "remote", "https://example.com/mcp"], deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.message).toMatch(/only writes a stdio entry/);
  });

  test("add --scope project writes <cwd>/.mcp.json and reports trust status", async () => {
    const outcome = await runMcpAddRoute(["-s", "project", "my-server", "npx", "my-mcp"], deps());
    expect(outcome).toEqual({ ok: true, scope: "project", name: "my-server", transport: "stdio", cwd, trusted: false });
    expect(readProjectMcpConfig(cwd)).toEqual({ mcpServers: { "my-server": { command: "npx", args: ["my-mcp"] } } });
  });

  // REGRESSION: a write built on the typed, stdio-only `.mcp.json` reader would `.parse()` the
  // WHOLE map at once, throw on the http entry below, degrade to "nothing configured", and then
  // overwrite the file with ONLY the new entry — silently deleting a server claude (or a human)
  // configured there, and stripping the stdio entry's own `type` field. `runMcpAddRoute` must go
  // through the RAW read/write door (`readRawProjectMcpConfig`/`writeRawProjectMcpConfig`) instead.
  test("add --scope project preserves an EXISTING http entry and a stdio entry's own `type` field, byte-for-byte", async () => {
    const existing = {
      mcpServers: {
        httpEntry: { type: "http", url: "https://example.com/mcp", headers: { "X-Foo": "bar" } },
        stdioWithType: { type: "stdio", command: "npx", args: ["existing-pkg"] },
      },
    };
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(existing, null, 2));

    const outcome = await runMcpAddRoute(["-s", "project", "new-one", "npx", "new-pkg"], deps());
    expect(outcome).toEqual({ ok: true, scope: "project", name: "new-one", transport: "stdio", cwd, trusted: false });

    const after = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(after.mcpServers.httpEntry).toEqual(existing.mcpServers.httpEntry);
    expect(after.mcpServers.stdioWithType).toEqual(existing.mcpServers.stdioWithType);
    expect(after.mcpServers["new-one"]).toEqual({ command: "npx", args: ["new-pkg"] });
  });

  test("add --scope project refuses to write over a malformed .mcp.json rather than replace it", async () => {
    writeFileSync(join(cwd, ".mcp.json"), "{ not json");
    const outcome = await runMcpAddRoute(["-s", "project", "my-server", "npx"], deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.message).toMatch(/not valid JSON/);
    // Untouched — the refusal must not have overwritten the torn file.
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe("{ not json");
  });

  test("add-json validates JSON shape before writing, and writes on success", async () => {
    const bad = await runMcpAddJsonRoute(["name", "not json"], deps());
    expect(bad.ok).toBe(false);
    const badShape = await runMcpAddJsonRoute(["name", JSON.stringify({ type: "bogus" })], deps());
    expect(badShape.ok).toBe(false);
    const good = await runMcpAddJsonRoute(["name", JSON.stringify({ type: "stdio", command: "npx" })], deps());
    expect(good).toEqual({ ok: true, scope: "user", name: "name", transport: "stdio", via: "local" });
  });

  test("add-json defaults a type-less JSON object with a `command` to stdio (matching claude's own .mcp.json convention)", async () => {
    const outcome = await runMcpAddJsonRoute(["typeless", JSON.stringify({ command: "npx", args: ["pkg"] })], deps());
    expect(outcome).toEqual({ ok: true, scope: "user", name: "typeless", transport: "stdio", via: "local" });
    const raw = JSON.parse(readFileSync(join(winterHome, "settings.json"), "utf8"));
    expect(raw.mcpServers.typeless).toEqual({ type: "stdio", command: "npx", args: ["pkg"] });
  });

  test("add warns (but still succeeds) when the command looks like a URL and --transport wasn't given", async () => {
    const outcome = await runMcpAddRoute(["my-server", "https://mcp.sentry.dev/mcp"], deps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.warning).toMatch(/looks like a URL/);
    expect(renderMcpAddOutcome(outcome)).toMatch(/^Warning: .*looks like a URL/);
  });

  test("add does NOT warn when --transport was given explicitly, even on a URL-shaped command", async () => {
    const outcome = await runMcpAddRoute(["-t", "http", "my-server", "https://mcp.sentry.dev/mcp"], deps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.warning).toBeUndefined();
  });

  test("remove with an explicit scope removes just there, idempotently", async () => {
    await runMcpAddRoute(["my-server", "npx"], deps());
    const first = await runMcpRemoveRoute(["my-server", "-s", "user"], deps());
    expect(first).toEqual({ ok: true, scope: "user", name: "my-server", removed: true });
    const second = await runMcpRemoveRoute(["my-server", "-s", "user"], deps());
    expect(second).toEqual({ ok: true, scope: "user", name: "my-server", removed: false });
  });

  test("remove with no scope finds the one scope it's in", async () => {
    await runMcpAddRoute(["-s", "project", "my-server", "npx"], deps());
    const outcome = await runMcpRemoveRoute(["my-server"], deps());
    expect(outcome).toEqual({ ok: true, scope: "project", name: "my-server", removed: true, cwd });
  });

  test("remove with no scope and the name in NEITHER scope refuses typed", async () => {
    const outcome = await runMcpRemoveRoute(["never-added"], deps());
    expect(outcome).toEqual({ ok: false, message: 'No MCP server found with name: "never-added"' });
  });

  test("remove with no scope and the name in BOTH scopes reports the ambiguity", async () => {
    await runMcpAddRoute(["dup", "npx"], deps());
    await runMcpAddRoute(["-s", "project", "dup", "npx"], deps());
    const outcome = await runMcpRemoveRoute(["dup"], deps());
    expect(outcome).toEqual({ ok: false, multi: true, name: "dup", scopes: ["user", "project"] });
  });

  test("get finds a user-scope entry", async () => {
    await runMcpAddRoute(["my-server", "npx", "arg"], deps());
    const outcome = await runMcpGetRoute(["my-server"], deps());
    expect(outcome).toEqual({ ok: true, found: true, name: "my-server", scope: "user", transport: "stdio", command: "npx", args: ["arg"], env: undefined });
  });

  test("get falls back to project scope when not in user scope", async () => {
    await runMcpAddRoute(["-s", "project", "proj-only", "npx"], deps());
    const outcome = await runMcpGetRoute(["proj-only"], deps());
    expect(outcome).toEqual({ ok: true, found: true, name: "proj-only", scope: "project", transport: "stdio", command: "npx", args: undefined, env: undefined, cwd });
  });

  test("get on an absent name reports found:false", async () => {
    expect(await runMcpGetRoute(["never-added"], deps())).toEqual({ ok: true, found: false, name: "never-added" });
  });

  // PARITY FIX (controller-directed): `mcp get`'s project-scope path now shares the daemon's own
  // per-entry parser (`parseProjectMcpServers`) — an http/sse project entry reports its REAL
  // transport (previously always reported "stdio", deferred item 3), and a present-but-invalid
  // entry is `found: true` with `unrecognized` set (the schema's own reason), never silently
  // absent, and never breaks the lookup of a sibling name in the same file.
  test("get on a project-scope http entry reports its real transport (not always 'stdio')", async () => {
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } } }));
    const outcome = await runMcpGetRoute(["remote"], deps());
    expect(outcome).toEqual({ ok: true, found: true, name: "remote", scope: "project", transport: "http", url: "https://example.com/mcp", headers: undefined, cwd });
  });

  test("get on a project-scope entry that fails every recognized shape reports found:true with `unrecognized` set, and does not break a sibling lookup", async () => {
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
      mcpServers: { broken: { type: "stdio" }, sibling: { command: "npx" } },
    }));
    const brokenOutcome = await runMcpGetRoute(["broken"], deps());
    expect(brokenOutcome.ok).toBe(true);
    if (!brokenOutcome.ok || !brokenOutcome.found) throw new Error("expected found:true");
    expect(brokenOutcome.unrecognized).toBeDefined();
    const siblingOutcome = await runMcpGetRoute(["sibling"], deps());
    expect(siblingOutcome).toEqual({ ok: true, found: true, name: "sibling", scope: "project", transport: "stdio", command: "npx", args: undefined, env: undefined, cwd });
  });
});

describe("route functions with a live door (daemon path)", () => {
  test("add uses the door and reports via:daemon", async () => {
    const calls: unknown[] = [];
    const door: McpDoor = {
      mcpAdd: async (name, entry) => { calls.push(["add", name, entry]); return { ok: true, name, transport: entry.type, started: entry.type === "stdio" }; },
      mcpRemove: async (name) => ({ ok: true, name, removed: true }),
      mcpGet: async (name) => ({ ok: true, name, found: false }),
    };
    const outcome = await runMcpAddRoute(["my-server", "npx"], { cwd: "/tmp", winterHome: "/tmp/home", door });
    expect(outcome).toEqual({ ok: true, scope: "user", name: "my-server", transport: "stdio", via: "daemon", started: true });
    expect(calls).toEqual([["add", "my-server", { type: "stdio", command: "npx" }]]);
  });

  test("a door rejection surfaces as ok:false with its message", async () => {
    const door: McpDoor = {
      mcpAdd: async () => { throw new Error("already exists in user config"); },
      mcpRemove: async (name) => ({ ok: true, name, removed: false }),
      mcpGet: async (name) => ({ ok: true, name, found: false }),
    };
    const outcome = await runMcpAddRoute(["my-server", "npx"], { cwd: "/tmp", winterHome: "/tmp/home", door });
    expect(outcome).toEqual({ ok: false, message: "already exists in user config" });
  });
});

describe("rendering", () => {
  test("add outcome text (user, local)", () => {
    expect(renderMcpAddOutcome({ ok: true, scope: "user", name: "x", transport: "stdio", via: "local" }))
      .toMatch(/Added stdio MCP server "x" to user config.*next time a daemon starts/);
  });
  test("add outcome text (project, untrusted)", () => {
    expect(renderMcpAddOutcome({ ok: true, scope: "project", name: "x", transport: "stdio", cwd: "/p", trusted: false }))
      .toMatch(/not yet loaded.*winter trust \/p/);
  });
  test("remove multi-scope text lists both hints", () => {
    const text = renderMcpRemoveOutcome({ ok: false, multi: true, name: "x", scopes: ["user", "project"] });
    expect(text).toContain('winter mcp remove "x" -s user');
    expect(text).toContain('winter mcp remove "x" -s project');
  });
  test("get not-found text", () => {
    expect(renderMcpGetOutcome({ ok: true, found: false, name: "x" })).toBe('No MCP server found with name: "x"');
  });
});
