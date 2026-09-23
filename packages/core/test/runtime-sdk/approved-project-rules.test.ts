// Review I2 (2026-09-23): "Allow … in this project" must take effect in an UNTRUSTED project.
//
// The Mac app never marks a project trusted (it never calls `daemon.trustDir`), and the saved-rules
// reader applies a project's in-repo `.winter/permissions.local.json` only when the project IS trusted
// (a cloned repository can ship that file). So for every Mac project the card offered the option, the
// user chose it, the rule was written — and never applied. The daemon now also records such an answer
// in its OWN `<home>/permissions/projects.json` (written only by `approval.respond`, write-fenced from
// every tool), and that record applies regardless of trust; a forged in-repo file still does not.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { ApprovedProjectRules } from "../../src/agent/approved-project-rules";
import { repoRootFor } from "../../src/agent/memory-dir";
import { PermissionRules } from "../../src/agent/permission-rules";
import { TrustStore } from "../../src/agent/trust";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { startDaemon } from "../../src/daemon";
import { startIpcServer } from "../../src/ipc/server";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { persistedAllowRulesFor } from "../../src/runtime-sdk/mode-options";
import { SessionStore } from "../../src/sessions/store";

function realDir(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

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
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
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
  close(): void { this.socket.end(); }
}

describe("ApprovedProjectRules — the daemon's own record", () => {
  test("records per CANONICAL root (a symlinked spelling is the same project), dedupes, and lives under <home>/permissions", () => {
    const home = realDir("winter-approved-home-");
    const repo = realDir("winter-approved-repo-");
    const alias = join(realDir("winter-approved-alias-"), "link");
    symlinkSync(repo, alias);
    const store = new ApprovedProjectRules({ winterHome: home });
    store.record(repo, "Bash(npm test)");
    store.record(alias, "Bash(npm test)");
    store.record(alias, "Bash(make:*)");
    expect(store.rulesFor(repo)).toEqual(["Bash(npm test)", "Bash(make:*)"]);
    expect(store.rulesFor(alias)).toEqual(["Bash(npm test)", "Bash(make:*)"]);
    expect(store.file()).toBe(join(home, "permissions", "projects.json"));
    expect(JSON.parse(readFileSync(store.file(), "utf8")).projects[repo]).toEqual(["Bash(npm test)", "Bash(make:*)"]);
  });

  // Whole-branch review (minor c): the same control-plane guard `PermissionRules.append` enforces — a
  // "project" that is the home itself or lies inside it (a session whose cwd is the MEMDIR, an outputs
  // dir, …) is Winter's own state, not a project; approving "in this project" there records nothing.
  test("refuses a root that is the home itself or inside it, however it is spelled", () => {
    const home = realDir("winter-approved-inhome-");
    const alias = join(realDir("winter-approved-inhome-alias-"), "link");
    symlinkSync(home, alias);
    mkdirSync(join(home, "outputs", "s1"), { recursive: true });
    const store = new ApprovedProjectRules({ winterHome: home, log: () => {} });
    expect(() => store.record(home, "Bash")).toThrow(/home/);
    expect(() => store.record(join(home, "outputs", "s1"), "Bash")).toThrow(/home/);
    expect(() => store.record(join(alias, "outputs", "s1"), "Bash")).toThrow(/home/);
    expect(existsSync(store.file())).toBe(false);
  });

  test("a malformed record reads as nothing and is never overwritten by a new approval", () => {
    const home = realDir("winter-approved-bad-");
    mkdirSync(join(home, "permissions"), { recursive: true });
    writeFileSync(join(home, "permissions", "projects.json"), "{ not json");
    const store = new ApprovedProjectRules({ winterHome: home });
    expect(store.rulesFor("/anything")).toEqual([]);
    expect(() => store.record("/anything", "Bash(x)")).toThrow();
    expect(readFileSync(join(home, "permissions", "projects.json"), "utf8")).toBe("{ not json");
  });
});

// Re-review R1 (2026-09-23): the record is applied WITHOUT a trust check, so it must be the daemon's own
// file. The reviewer's probe: one unsandboxed `ln -s` (reachable under a saved `Bash(ln:*)`) turned
// `<home>/permissions` into a link to a session-writable directory holding a planted `projects.json`,
// and `rulesFor()` then answered `["Bash"]` — after which any SANDBOXED session could mint
// "user-approved" rules for any project by writing that directory. The store now refuses any
// `<home>/permissions` that is not the home's own real directory, and any `projects.json` that is a link.
describe("ApprovedProjectRules — never through a link (re-review R1)", () => {
  function plantedStore(repo: string, rules: string[]): string {
    const elsewhere = realDir("winter-approved-planted-");
    writeFileSync(join(elsewhere, "projects.json"), JSON.stringify({ version: 1, projects: { [repo]: rules } }));
    return elsewhere;
  }

  test("the reviewer's probe — a symlinked STORE directory — reads as nothing, logs once, and is never written through", () => {
    const home = realDir("winter-approved-r1-home-");
    const repo = realDir("winter-approved-r1-repo-");
    const elsewhere = plantedStore(repo, ["Bash"]);
    symlinkSync(elsewhere, join(home, "permissions"));
    const logs: string[] = [];
    const store = new ApprovedProjectRules({ winterHome: home, log: (m) => logs.push(m) });

    expect(store.rulesFor(repo)).toEqual([]);
    // …and through the daemon's own saved-rules reader, which is what reached the child.
    const saved = persistedAllowRulesFor(repo, {
      projectRootOf: (c) => c, effectiveSettings: () => null,
      approvedProjectRules: (root) => store.rulesFor(root), isTrusted: () => false,
    });
    expect(saved).toEqual([]);
    expect(logs).toHaveLength(1); // one line for the condition, not one per read
    expect(logs[0]).toContain(join(home, "permissions"));

    expect(() => store.record(repo, "Bash(npm test)")).toThrow();
    expect(readdirSync(elsewhere)).toEqual(["projects.json"]); // no temp file planted there either
    expect(JSON.parse(readFileSync(join(elsewhere, "projects.json"), "utf8")).projects[repo]).toEqual(["Bash"]);
  });

  test("a symlinked projects.json inside the real store directory is refused the same way", () => {
    const home = realDir("winter-approved-r1-file-");
    const repo = realDir("winter-approved-r1-file-repo-");
    const elsewhere = plantedStore(repo, ["Bash"]);
    mkdirSync(join(home, "permissions"), { mode: 0o700 });
    symlinkSync(join(elsewhere, "projects.json"), join(home, "permissions", "projects.json"));
    const logs: string[] = [];
    const store = new ApprovedProjectRules({ winterHome: home, log: (m) => logs.push(m) });

    expect(store.rulesFor(repo)).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(() => store.record(repo, "Bash(npm test)")).toThrow();
    expect(lstatSync(join(home, "permissions", "projects.json")).isSymbolicLink()).toBe(true); // left for the user
    expect(JSON.parse(readFileSync(join(elsewhere, "projects.json"), "utf8")).projects[repo]).toEqual(["Bash"]);
  });

  test("prepare() (daemon boot) makes the store a real 0700 directory before a link can be planted", () => {
    const home = realDir("winter-approved-r1-prep-");
    const repo = realDir("winter-approved-r1-prep-repo-");
    const store = new ApprovedProjectRules({ winterHome: home, log: () => {} });
    store.prepare();
    const st = lstatSync(join(home, "permissions"));
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    store.record(repo, "Bash(npm test)");
    expect(store.rulesFor(repo)).toEqual(["Bash(npm test)"]);
  });

  test("prepare() never replaces a link it finds — it is refused (one log line) and left for the user", () => {
    const home = realDir("winter-approved-r1-prep-link-");
    const repo = realDir("winter-approved-r1-prep-link-repo-");
    const elsewhere = plantedStore(repo, ["Bash"]);
    symlinkSync(elsewhere, join(home, "permissions"));
    const logs: string[] = [];
    const store = new ApprovedProjectRules({ winterHome: home, log: (m) => logs.push(m) });
    store.prepare();
    expect(lstatSync(join(home, "permissions")).isSymbolicLink()).toBe(true);
    expect(store.rulesFor(repo)).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  // Re-review M-b: the root those rules are looked up by is `repoRootFor(cwd)`, and a `.git` FILE
  // pointing at another project's git dir used to make THAT project the root.
  test("M-b: a directory whose .git file points at another project's git dir does not inherit its approvals", () => {
    const home = realDir("winter-approved-mb-home-");
    const other = realDir("winter-approved-mb-other-");
    expect(Bun.spawnSync(["git", "-C", other, "init", "-q"]).exitCode).toBe(0);
    const evil = realDir("winter-approved-mb-evil-");
    writeFileSync(join(evil, ".git"), `gitdir: ${join(other, ".git")}\n`);
    const store = new ApprovedProjectRules({ winterHome: home, log: () => {} });
    store.record(other, "Bash");
    const savedRulesFor = (cwd: string) => persistedAllowRulesFor(cwd, {
      projectRootOf: (c) => repoRootFor(c), effectiveSettings: () => null,
      approvedProjectRules: (root) => store.rulesFor(root), isTrusted: () => false,
    });
    expect(savedRulesFor(other)).toEqual(["Bash"]);
    expect(savedRulesFor(evil)).toEqual([]);
  });

  test("the daemon creates <home>/permissions at boot", async () => {
    const home = realDir("winter-approved-r1-boot-");
    const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    try {
      const st = lstatSync(join(home, "permissions"));
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o700);
    } finally {
      await daemon.stop();
    }
  });
});

describe("approval.respond → the next incarnation's saved rules, in an UNTRUSTED project", () => {
  async function world() {
    const home = realDir("winter-approved-ipc-");
    const repo = realDir("winter-approved-ipc-repo-");
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const broker = new ApprovalBroker();
    const trust = new TrustStore(join(home, "trust.json"));
    const resolver = new ProjectSettingsResolver({ base: () => null, trust });
    const permissionRules = new PermissionRules({ globalAllow: (root) => resolver.effective(root)?.permissions?.allow, winterHome: home });
    const approvedProjectRules = new ApprovedProjectRules({ winterHome: home });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, broker, permissionRules, approvedProjectRules });
    const client = await TestClient.connect(socketPath);
    await client.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "approver" });
    // The daemon's own reader, exactly as `daemon.ts` wires it (the project root of a non-git dir is
    // the dir itself).
    const savedRulesFor = (cwd: string) => persistedAllowRulesFor(cwd, {
      projectRootOf: (c) => c,
      effectiveSettings: (root) => resolver.effective(root),
      approvedProjectRules: (root) => approvedProjectRules.rulesFor(root),
      projectRules: (root) => permissionRules.rulesFor(root).project,
      isTrusted: (dir) => trust.isTrusted(dir),
    });
    return { home, repo, store, broker, trust, client, savedRulesFor, stop: () => { client.close(); server.stop(); store.close(); } };
  }

  test("approving \"in this project\" reaches the saved rules even though the project was never trusted", async () => {
    const w = await world();
    try {
      expect(w.trust.isTrusted(w.repo)).toBe(false);
      const sessionId = w.store.createSession("global", { approvalPolicy: "ask", cwd: w.repo });
      const options = [{ id: "allow_project", label: 'Allow "Bash(npm test)" in this project', rule: "Bash(npm test)", scope: "project" as const }];
      void w.broker.wait(sessionId, "c1", 5000, { toolName: "bash", summary: "npm test", issuedAt: Date.now(), expiresAt: Date.now() + 5000, options });
      const res = await w.client.request(METHODS.approvalRespond, { sessionId, callId: "c1", approved: true, optionId: "allow_project" });
      expect(res.result).toEqual({ ok: true, alreadyResolved: false });

      expect(existsSync(join(w.home, "permissions", "projects.json"))).toBe(true);
      expect(w.savedRulesFor(w.repo)).toEqual(["Bash(npm test)"]);
    } finally {
      w.stop();
    }
  });

  test("a DENIED rule-bearing answer records nothing", async () => {
    const w = await world();
    try {
      const sessionId = w.store.createSession("global", { approvalPolicy: "ask", cwd: w.repo });
      const options = [{ id: "allow_project", label: "x", rule: "Bash(rm -rf build)", scope: "project" as const }];
      void w.broker.wait(sessionId, "c2", 5000, { toolName: "bash", summary: "rm", issuedAt: Date.now(), expiresAt: Date.now() + 5000, options });
      await w.client.request(METHODS.approvalRespond, { sessionId, callId: "c2", approved: false, optionId: "allow_project" });
      expect(w.savedRulesFor(w.repo)).toEqual([]);
    } finally {
      w.stop();
    }
  });

  test("a FORGED in-repo .winter/permissions.local.json in an untrusted project is not applied — and applies once trusted", async () => {
    const w = await world();
    try {
      mkdirSync(join(w.repo, ".winter"), { recursive: true });
      writeFileSync(join(w.repo, ".winter", "permissions.local.json"), JSON.stringify({ allow: ["Bash", "Edit"] }));
      expect(w.savedRulesFor(w.repo)).toEqual([]);
      w.trust.trust(w.repo);
      expect(w.savedRulesFor(w.repo)).toEqual(["Bash", "Edit"]);
    } finally {
      w.stop();
    }
  });
});
