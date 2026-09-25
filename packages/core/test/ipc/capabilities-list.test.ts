// Daemon settings surface (2026-09-17 plan, item 2): `capabilities.list` — the daemon's own
// in-process `winter__<key>` capability servers, grouped by key, with live enablement and per-mode
// exposure. Bare IPC server harness, same shape `settings-set-advisor-model.test.ts` already uses
// (no shared test-harness module exists in this codebase).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";
import { disallowedToolsFor } from "../../src/runtime-sdk/mode-options";
import { WINTER_CAPABILITY_TOOLS, CAPABILITY_SERVER_KEYS, capabilityToolName } from "../../src/capabilities/names";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("capabilities.list", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(settingsOverride?: Record<string, unknown>) {
    const home = mkdtempSync(join(tmpdir(), "winter-capabilities-list-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...settingsOverride }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets });
    stop = () => { server.stop(); store.close(); };
    return { home, socketPath, harnessToken: tokens.harness };
  }

  test("shape: one entry per CAPABILITY_SERVER_KEYS, tools grouped by wire-name prefix, external always []", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.capabilitiesList, {});
    expect(result.error).toBeUndefined();
    expect(result.result.ok).toBe(true);
    const caps = result.result.capabilities;
    expect(caps.map((x: any) => x.key).sort()).toEqual([...CAPABILITY_SERVER_KEYS].sort());

    const byKey = new Map<string, any>(caps.map((x: any) => [x.key, x]));
    expect(byKey.get("external").tools).toEqual([]);

    // Every static WINTER_CAPABILITY_TOOLS row lands under its own key's group, and nowhere else.
    for (const name of Object.keys(WINTER_CAPABILITY_TOOLS)) {
      const owner = CAPABILITY_SERVER_KEYS.find((k) => name.startsWith(capabilityToolName(k, "")));
      expect(owner).toBeDefined();
      const group = byKey.get(owner!);
      expect(group.tools.some((t: any) => t.name === name)).toBe(true);
      for (const other of CAPABILITY_SERVER_KEYS) {
        if (other === owner) continue;
        expect(byKey.get(other).tools.some((t: any) => t.name === name)).toBe(false);
      }
    }
    c.close();
  });

  test("a disabled capability (computerUse.enabled absent) reports enabled:false; lsp defaults enabled:true", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.capabilitiesList, {});
    const byKey = new Map<string, any>(result.result.capabilities.map((x: any) => [x.key, x]));
    expect(byKey.get("computer").enabled).toBe(false);
    expect(byKey.get("lsp").enabled).toBe(true);
    // Every other key has no settings gate at all — always live.
    for (const key of CAPABILITY_SERVER_KEYS) {
      if (key === "computer" || key === "lsp") continue;
      expect(byKey.get(key).enabled).toBe(true);
    }
    c.close();
  });

  test("settings.computerUse.enabled:true flips computer live; settings.lsp.enabled:false flips lsp off", async () => {
    const { socketPath, harnessToken } = await boot({ computerUse: { enabled: true }, lsp: { enabled: false } });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.capabilitiesList, {});
    const byKey = new Map<string, any>(result.result.capabilities.map((x: any) => [x.key, x]));
    expect(byKey.get("computer").enabled).toBe(true);
    expect(byKey.get("lsp").enabled).toBe(false);
    c.close();
  });

  test("per-mode exposure matches the Winter leg's disallowedToolsFor for WINTER_CAPABILITY_TOOLS exactly", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.capabilitiesList, {});
    // The listing reports the WINTER leg's answer (its rows are all `mcp__winter__*` capability
    // tools, which only a Winter child ever sees). This test daemon has no Exa key in its throwaway
    // Keychain service, so the handler's live probe answers `false` — spelled here rather than
    // defaulted, since the default is the opposite (`true`, the narrower surface).
    const exposure = { exaKeyPresent: false };
    const disallowed = {
      code: new Set(disallowedToolsFor("code", exposure, WINTER_CAPABILITY_TOOLS)),
      dispatch: new Set(disallowedToolsFor("dispatch", exposure, WINTER_CAPABILITY_TOOLS)),
      chat: new Set(disallowedToolsFor("chat", exposure, WINTER_CAPABILITY_TOOLS)),
    };
    for (const group of result.result.capabilities) {
      for (const tool of group.tools) {
        expect(tool.exposure.code).toBe(!disallowed.code.has(tool.name));
        expect(tool.exposure.dispatch).toBe(!disallowed.dispatch.has(tool.name));
        expect(tool.exposure.chat).toBe(!disallowed.chat.has(tool.name));
      }
    }
    // Spot-check one concretely: the sessions trio is dispatch-only.
    const sessionsGroup = result.result.capabilities.find((x: any) => x.key === "sessions");
    const spawn = sessionsGroup.tools.find((t: any) => t.name === "mcp__winter__sessions__session_spawn");
    expect(spawn.exposure).toEqual({ code: false, dispatch: true, chat: false });
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.capabilitiesList)).toBe(false);
  });
});
