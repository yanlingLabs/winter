// WS-25 (spec §2): the `oauth` block on every daemon-side MCP config surface — the user/local entries
// (`settings.ts`, `validateMcpServerEntryForWrite`, the `sdk/.winter.json` read door), a project's
// `.winter/mcp.json` entries (`ProjectMcpEntrySchema`) and the child's `Options.mcpServers`
// (`configuredMcpServersFor`). Declared (zod strips an undeclared key) and validated with the runtime's
// own `validateMcpOAuthConfig(oauth, url)`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectMcpServers } from "../../../src/agent/mcp/project-file";
import { sdkUserMcpServers, validateMcpServerEntryForWrite } from "../../../src/settings";
import { configuredMcpServersFor } from "../../../src/runtime-sdk/external-mcp";

const PRE = { clientId: "Iv1.abc", clientSecretRef: { kind: "keychain" }, callbackPort: 47823, scopes: ["repo", "read:org"] };

describe("the oauth block on a daemon-side MCP config (WS-25)", () => {
  test("the user/local write door keeps a valid block byte-for-byte", () => {
    const entry = validateMcpServerEntryForWrite({ type: "http", url: "https://api.example.test/mcp", oauth: PRE });
    expect(entry).toEqual({ type: "http", url: "https://api.example.test/mcp", oauth: PRE } as never);
    const sse = validateMcpServerEntryForWrite({ type: "sse", url: "https://api.example.test/sse", oauth: { scopes: ["a"] } });
    expect((sse as { oauth?: unknown }).oauth).toEqual({ scopes: ["a"] });
  });

  test("a client secret VALUE is refused by name, with the runtime's own words", () => {
    expect(() => validateMcpServerEntryForWrite({ type: "http", url: "https://api.example.test/mcp", oauth: { clientId: "x", clientSecret: "s3cret-value" } }))
      .toThrow(/oauth\.clientSecret' is refused/);
    // …and the message never quotes the value.
    try { validateMcpServerEntryForWrite({ type: "http", url: "https://api.example.test/mcp", oauth: { clientId: "x", clientSecret: "s3cret-value" } }); } catch (e) {
      expect((e as Error).message).not.toContain("s3cret-value");
    }
  });

  test("a clientSecretRef that NAMES an account or a service is refused (review C1: the account is derived)", () => {
    expect(() => validateMcpServerEntryForWrite({ type: "http", url: "https://api.example.test/mcp", oauth: { clientId: "x", clientSecretRef: { kind: "keychain", account: "openai:default" } } }))
      .toThrow(/clientSecretRef/);
    expect(() => validateMcpServerEntryForWrite({ type: "http", url: "https://api.example.test/mcp", oauth: { clientId: "x", clientSecretRef: { kind: "keychain", service: "com.winter.core" } } }))
      .toThrow(/clientSecretRef/);
  });

  test("an unknown key, a secret ref without a client id, a bad port and a loopback metadata URL are refused", () => {
    const url = "https://api.example.test/mcp";
    expect(() => validateMcpServerEntryForWrite({ type: "http", url, oauth: { clientSecretRefs: { kind: "keychain" } } })).toThrow(/unknown key/);
    expect(() => validateMcpServerEntryForWrite({ type: "http", url, oauth: { clientSecretRef: { kind: "keychain" } } })).toThrow(/needs 'oauth.clientId'/);
    expect(() => validateMcpServerEntryForWrite({ type: "http", url, oauth: { callbackPort: 70000 } })).toThrow(/callbackPort/);
    expect(() => validateMcpServerEntryForWrite({ type: "http", url, oauth: { authServerMetadataUrl: "http://127.0.0.1:9/.well-known/oauth-authorization-server" } })).toThrow(/authServerMetadataUrl/);
  });

  test("the sdk/.winter.json read door keeps a valid block and skips an entry that carries a secret", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-mcp-oauth-cfg-"));
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({
      mcpServers: {
        gh: { type: "http", url: "https://api.example.test/mcp", oauth: PRE },
        bad: { type: "http", url: "https://api.example.test/other", oauth: { clientSecret: "nope" } },
      },
    }));
    const servers = sdkUserMcpServers(home);
    expect(Object.keys(servers)).toEqual(["gh"]);
    expect((servers.gh as { oauth?: unknown }).oauth).toEqual(PRE);
  });

  test("a project entry accepts the block per entry (a bad sibling is skipped, named)", () => {
    const { servers, skipped } = parseProjectMcpServers({
      linear: { type: "http", url: "https://mcp.example.test/mcp", oauth: { scopes: ["read"] } },
      evil: { type: "http", url: "https://mcp.example.test/x", oauth: { clientId: "c", clientSecretRef: { kind: "keychain", account: "anthropic:default" } } },
    });
    expect((servers.linear as { oauth?: unknown }).oauth).toEqual({ scopes: ["read"] });
    expect(skipped.map((s) => s.name)).toEqual(["evil"]);
  });

  test("the child's Options.mcpServers carry the block (a copy)", () => {
    const user = validateMcpServerEntryForWrite({ type: "http", url: "https://api.example.test/mcp", oauth: PRE });
    const out = configuredMcpServersFor({ settings: undefined, userMcpServers: { gh: user }, cwd: undefined, trusted: () => false });
    expect(out.gh).toEqual({ type: "http", url: "https://api.example.test/mcp", oauth: PRE } as never);
    expect((out.gh as { oauth?: unknown }).oauth).not.toBe((user as { oauth?: unknown }).oauth);
  });
});
