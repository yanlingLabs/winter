// WS-25 (review M8, spec §4.3): the ROUTER's run-home fold passes a server's `oauth` block to the child
// untouched. A run-home build hands the child no `Options.mcpServers` at all -- the child reads its MCP
// servers from `<run folder>/.winter.json`, which the linked router (`buildRunHome`) writes from the user
// and local scopes in `sdk/.winter.json` and a trusted project's `.winter/mcp.json`. A router that dropped
// or rewrote the unknown key would silently turn every pre-registered client into DCR. Built with the REAL
// router, through the daemon's own `runHomeInputFor`, exactly as `daemon.ts` builds one.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunHome } from "@yanlinglabs/winter-runtime-sdk";
import { runHomeInputFor } from "../../src/runtime-sdk/run-home-input";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));

// Deliberately unusual key order and every field: byte-identity is checked on the serialized block.
const USER_OAUTH = { scopes: ["repo", "read:org"], callbackPort: 47823, clientSecretRef: { kind: "keychain" }, clientId: "Iv1.user" };
const LOCAL_OAUTH = { authServerMetadataUrl: "https://auth.example.test/.well-known/oauth-authorization-server", clientId: "local-client" };
const PROJECT_OAUTH = { scopes: ["read"] };

describe("the router's run-home fold keeps the oauth block (WS-25, review M8)", () => {
  test("user, local and trusted-project servers reach the child's .winter.json with oauth byte-identical", async () => {
    const home = tmp("winter-rh-oauth-home-");
    const project = tmp("winter-rh-oauth-proj-");
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({
      mcpServers: { gh: { type: "http", url: "https://api.example.test/mcp", oauth: USER_OAUTH } },
      projects: { [project]: { mcpServers: { loc: { type: "sse", url: "https://sse.example.test/sse", oauth: LOCAL_OAUTH } } } },
    }));
    mkdirSync(join(project, ".winter"), { recursive: true });
    writeFileSync(join(project, ".winter", "mcp.json"), JSON.stringify({ mcpServers: { proj: { type: "http", url: "https://proj.example.test/mcp", oauth: PROJECT_OAUTH } } }));

    const rh = await buildRunHome(runHomeInputFor({
      home,
      trust: { isTrusted: (dir) => dir === project },
      settings: () => null,
      reservedMcpServerNames: [],
      gitRootFor: () => null,
    }, { mode: "code", dispatchChild: false, leg: "winter", cwd: project }));
    try {
      const config = JSON.parse(readFileSync(join(rh.dir, ".winter.json"), "utf8")) as { mcpServers?: Record<string, { oauth?: unknown }>; projects?: Record<string, { mcpServers?: Record<string, { oauth?: unknown }> }> };
      const all: Record<string, { oauth?: unknown }> = { ...(config.mcpServers ?? {}) };
      for (const p of Object.values(config.projects ?? {})) Object.assign(all, p.mcpServers ?? {});
      expect(Object.keys(all).sort()).toEqual(["gh", "loc", "proj"]);
      expect(JSON.stringify(all.gh!.oauth)).toBe(JSON.stringify(USER_OAUTH));
      expect(JSON.stringify(all.loc!.oauth)).toBe(JSON.stringify(LOCAL_OAUTH));
      expect(JSON.stringify(all.proj!.oauth)).toBe(JSON.stringify(PROJECT_OAUTH));
    } finally {
      await rh.dispose();
    }
  });
});
