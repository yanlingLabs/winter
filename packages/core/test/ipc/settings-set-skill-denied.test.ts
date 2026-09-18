// Daemon settings surface batch 3 (item 2): `settings.setSkillDenied` (write) + `skills.list`'s
// `denied`/`deniedBy` overlay (read) — the `Skill(<name>)` deny-rule mechanism both legs' pinned
// runtimes use in place of a dedicated "disabled skills" setting. Bare IPC server harness, same
// shape `settings-model-roles.test.ts`/`agents-list.test.ts` already use.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";

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

describe("settings.setSkillDenied + skills.list denial overlay", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-skill-denied-"));
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    mkdirSync(join(home, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: a test skill\n---\n\nBody.");
    const trust = new TrustStore(join(home, "trust.json"));
    const skills = new SkillStore({ winterHome: home, trust });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, skills });
    stop = () => { server.stop(); store.close(); };
    return { home, socketPath, harnessToken: tokens.harness };
  }

  test("skills.list reports a fresh skill as not denied", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.skillsList, {});
    const row = result.result.skills.find((s: any) => s.name === "my-skill");
    expect(row.denied).toBeUndefined();
    expect(row.deniedBy).toBeUndefined();
    c.close();
  });

  test("toggle off writes the Skill(<name>) deny rule, and skills.list reports it denied by settings", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const setResult = await c.request(METHODS.settingsSetSkillDenied, { name: "my-skill", denied: true });
    expect(setResult.error).toBeUndefined();
    expect(setResult.result).toEqual({ ok: true, name: "my-skill", denied: true, rule: "Skill(my-skill)" });
    const onDisk = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(onDisk.permissions.deny).toEqual(["Skill(my-skill)"]);
    const listResult = await c.request(METHODS.skillsList, {});
    const row = listResult.result.skills.find((s: any) => s.name === "my-skill");
    expect(row.denied).toBe(true);
    expect(row.deniedBy).toBe("settings");
    c.close();
  });

  test("toggle back on removes the rule — skills.list reports it not denied again", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.settingsSetSkillDenied, { name: "my-skill", denied: true });
    const offResult = await c.request(METHODS.settingsSetSkillDenied, { name: "my-skill", denied: false });
    expect(offResult.result).toEqual({ ok: true, name: "my-skill", denied: false, rule: "Skill(my-skill)" });
    const listResult = await c.request(METHODS.skillsList, {});
    const row = listResult.result.skills.find((s: any) => s.name === "my-skill");
    expect(row.denied).toBeUndefined();
    c.close();
  });

  test("a rule written by hand in settings.json is reported, not overwritten by an unrelated toggle", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const current = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    saveSettings(join(home, "settings.json"), Settings.parse({ ...current, permissions: { deny: ["Skill(my-skill)", "Agent(fork)"] } }));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    // A hand-written rule is reported as denied without ever calling settings.setSkillDenied.
    const listResult = await c.request(METHODS.skillsList, {});
    const row = listResult.result.skills.find((s: any) => s.name === "my-skill");
    expect(row.denied).toBe(true);
    // Toggling an UNRELATED skill on/off must never disturb the hand-written "Agent(fork)" entry.
    await c.request(METHODS.settingsSetSkillDenied, { name: "unrelated-skill", denied: true });
    const onDisk = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(onDisk.permissions.deny).toEqual(["Skill(my-skill)", "Agent(fork)", "Skill(unrelated-skill)"]);
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.settingsSetSkillDenied)).toBe(false);
  });

  // BLOCKER (fix wave, pre-merge review): a home whose settings.json is still v2-shaped on disk
  // (the v2->v3 migration is in-memory only unless the daemon boot hook persists it) used to make
  // saveSettings throw a raw zod dump on ANY write through this RPC. Exercised at the IPC layer
  // (not just settings.ts directly) so the whole request/response path is proven, not just the
  // pure transform.
  test("succeeds against a v2-shaped settings.json on disk (BLOCKER)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-skill-denied-v2-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "codex-oauth/gpt-5.6-sol" },
    }));
    mkdirSync(join(home, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: a test skill\n---\n\nBody.");
    const trust = new TrustStore(join(home, "trust.json"));
    const skills = new SkillStore({ winterHome: home, trust });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, skills });
    stop = () => { server.stop(); store.close(); };

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli");
    const setResult = await c.request(METHODS.settingsSetSkillDenied, { name: "my-skill", denied: true });
    expect(setResult.error).toBeUndefined();
    expect(setResult.result).toEqual({ ok: true, name: "my-skill", denied: true, rule: "Skill(my-skill)" });
    const onDisk = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(onDisk.provider).toEqual({ model: "codex-oauth/gpt-5.6-sol" }); // `type` dropped, no longer poisons the write
    expect(onDisk.permissions.deny).toEqual(["Skill(my-skill)"]);
    c.close();
  });
});
