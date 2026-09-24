// WS-21 L3.5 (spec §4.2, §4.3; F21): an approval card's "always" answers are saved where claude keeps
// them, in claude's grammar — "everywhere" in `sdk/settings.json`, "in this project" in the TRUSTED
// project's `.winter/settings.local.json` at its git root, followed by the global git exclude. The card
// offers "in this project" only for a trusted project. Every test runs git with a temp HOME,
// XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type NewSessionEvent, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { TrustStore } from "../../src/agent/trust";
import { LOCAL_SETTINGS_EXCLUDE } from "../../src/agent/git-exclude";
import { saveAnswerEverywhere, saveAnswerInProject, SavedAnswerRefused } from "../../src/agent/saved-answers";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { startIpcServer } from "../../src/ipc/server";
import { canUseToolFor } from "../../src/runtime-sdk/approval-bridge";
import { _clearGitRootCacheForTests } from "../../src/runtime-sdk/run-home-input";
import { SessionStore } from "../../src/sessions/store";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
const ENV = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] as const;
const saved: Record<string, string | undefined> = {};
let gitHome: string;
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  gitHome = tmp("winter-save-githome-");
  process.env.HOME = gitHome;
  process.env.XDG_CONFIG_HOME = join(gitHome, ".config");
  process.env.GIT_CONFIG_GLOBAL = join(gitHome, ".gitconfig");
  writeFileSync(join(gitHome, ".gitconfig"), "");
});
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterEach(() => _clearGitRootCacheForTests());

const excludesFile = (): string => join(gitHome, ".config", "git", "ignore");
function repo(): string {
  const dir = tmp("winter-save-repo-");
  if (Bun.spawnSync(["git", "-C", dir, "init", "-q"], { env: process.env }).exitCode !== 0) throw new Error("git init failed");
  return dir;
}

describe("saveAnswerEverywhere / saveAnswerInProject", () => {
  test("everywhere writes claude grammar into sdk/settings.json, deduped, other keys preserved", () => {
    const home = tmp("winter-save-home-");
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", "settings.json"), JSON.stringify({ theme: "dark", permissions: { deny: ["Skill(x)"] } }));
    expect(saveAnswerEverywhere(home, "Bash(npm test:*)")).toEqual(["Bash(npm test:*)"]);
    expect(saveAnswerEverywhere(home, "Edit")).toEqual(["Edit", "Write"]);            // Winter's Edit = both tools
    expect(saveAnswerEverywhere(home, "Computer")).toEqual(["mcp__winter__computer__computer"]);
    saveAnswerEverywhere(home, "Bash(npm test:*)");                                   // dedup
    const onDisk = JSON.parse(readFileSync(join(home, "sdk", "settings.json"), "utf8"));
    expect(onDisk.permissions.allow).toEqual(["Bash(npm test:*)", "Edit", "Write", "mcp__winter__computer__computer"]);
    expect(onDisk.permissions.deny).toEqual(["Skill(x)"]);
    expect(onDisk.theme).toBe("dark");
    // …and NEVER settings.json, where the key no longer lives.
    expect(existsSync(join(home, "settings.json"))).toBe(false);
  });

  test("a rule the runtimes cannot apply is refused, not saved", () => {
    const home = tmp("winter-save-home-");
    expect(() => saveAnswerEverywhere(home, "Edit(/some/dir)")).toThrow(SavedAnswerRefused); // a writable-dir declaration
    expect(existsSync(join(home, "sdk", "settings.json"))).toBe(false);
  });

  test("in this project, trusted: <root>/.winter/settings.local.json in claude grammar, then the exclude line EXACTLY once", () => {
    const home = tmp("winter-save-home-");
    const root = repo();
    saveAnswerInProject({ root, winterHome: home, trusted: true }, "Bash(make:*)");
    saveAnswerInProject({ root, winterHome: home, trusted: true }, "Edit");
    const local = JSON.parse(readFileSync(join(root, ".winter", "settings.local.json"), "utf8"));
    expect(local.permissions.allow).toEqual(["Bash(make:*)", "Edit", "Write"]);
    const excludes = readFileSync(excludesFile(), "utf8").split("\n").filter(Boolean);
    expect(excludes.filter((l) => l === LOCAL_SETTINGS_EXCLUDE)).toHaveLength(1);
    // The retired store is not written.
    expect(existsSync(join(root, ".winter", "permissions.local.json"))).toBe(false);
  });

  test("in this project, UNTRUSTED: refused, nothing written anywhere", () => {
    const home = tmp("winter-save-home-");
    const root = repo();
    expect(() => saveAnswerInProject({ root, winterHome: home, trusted: false }, "Bash(make:*)")).toThrow(SavedAnswerRefused);
    expect(existsSync(join(root, ".winter"))).toBe(false);
  });

  test("never through a planted link, never into the Winter home, never over a file that does not parse", () => {
    const home = tmp("winter-save-home-");
    const root = repo();
    const elsewhere = tmp("winter-save-elsewhere-");
    symlinkSync(elsewhere, join(root, ".winter"));
    expect(() => saveAnswerInProject({ root, winterHome: home, trusted: true }, "Bash(ls)")).toThrow(/symbolic link/);
    expect(existsSync(join(elsewhere, "settings.local.json"))).toBe(false);

    expect(() => saveAnswerInProject({ root: join(home, "outputs"), winterHome: home, trusted: true }, "Bash(ls)")).toThrow(/Winter home/);

    const root2 = repo();
    mkdirSync(join(root2, ".winter"));
    writeFileSync(join(root2, ".winter", "settings.local.json"), "{ half");
    expect(() => saveAnswerInProject({ root: root2, winterHome: home, trusted: true }, "Bash(ls)")).toThrow(/untouched/);
    expect(readFileSync(join(root2, ".winter", "settings.local.json"), "utf8")).toBe("{ half");
  });
});

describe("the card offers \"in this project\" only for a trusted project", () => {
  const cardOptions = async (trusted: boolean): Promise<Array<{ id: string; scope?: string }>> => {
    const events: NewSessionEvent[] = [];
    const approvals = new ApprovalBroker();
    const canUse = canUseToolFor({
      sessionId: "s_save", mode: "code", policy: "ask", approvals, questions: new QuestionBroker(), gate: new PermissionGate(),
      emit: (e) => { events.push(e); }, log: { info: () => {}, error: () => {} }, projectTrusted: () => trusted,
    });
    const ac = new AbortController();
    const pending = canUse("Bash", { command: "npm test" }, { signal: ac.signal, toolUseID: "c1", requestId: "r1" } as Parameters<CanUseTool>[2]);
    const until = Date.now() + 2000;
    while (!events.some((e) => e.type === "approval_requested") && Date.now() < until) await Bun.sleep(5);
    approvals.resolve("s_save", "c1", false, "test");
    await pending;
    const card = events.find((e) => e.type === "approval_requested") as unknown as { options?: Array<{ id: string; scope?: string }> };
    return card.options ?? [];
  };

  test("untrusted: allow once / everywhere / deny — no project scope", async () => {
    const ids = (await cardOptions(false)).map((o) => o.id);
    expect(ids).toContain("allow_global");
    expect(ids).not.toContain("allow_project");
  });

  test("trusted: the project scope is offered", async () => {
    expect((await cardOptions(true)).map((o) => o.id)).toContain("allow_project");
  });
});

// The door itself: `approval.respond` with a rule-bearing option.
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

describe("approval.respond saves through the WS-21 doors", () => {
  async function world(sessionCwd?: (root: string) => string) {
    const home = tmp("winter-save-ipc-");
    const root = repo();
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const broker = new ApprovalBroker();
    const trust = new TrustStore(join(home, "trust.json"));
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, broker, trust, winterHome: home });
    const client = await TestClient.connect(socketPath);
    await client.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "approver" });
    const answer = async (callId: string, option: { id: string; rule: string; scope: "project" | "global" }, approved: boolean) => {
      const sessionId = store.createSession("global", { approvalPolicy: "ask", cwd: sessionCwd?.(root) ?? root });
      void broker.wait(sessionId, callId, 5000, { toolName: "bash", summary: "x", issuedAt: Date.now(), expiresAt: Date.now() + 5000, options: [{ ...option, label: "x" }] });
      return client.request(METHODS.approvalRespond, { sessionId, callId, approved, optionId: option.id });
    };
    return { home, root, trust, answer, client, stop: () => { client.close(); server.stop(); store.close(); } };
  }

  test("\"everywhere\" lands in sdk/settings.json (claude grammar)", async () => {
    const w = await world();
    try {
      const res = await w.answer("c1", { id: "allow_global", rule: "Bash(npm test:*)", scope: "global" }, true);
      expect(res.result).toEqual({ ok: true, alreadyResolved: false });
      expect(JSON.parse(readFileSync(join(w.home, "sdk", "settings.json"), "utf8")).permissions.allow).toEqual(["Bash(npm test:*)"]);
    } finally { w.stop(); }
  });

  test("\"in this project\" on a TRUSTED project → <git root>/.winter/settings.local.json; the retired stores stay unwritten", async () => {
    const w = await world();
    try {
      w.trust.trust(w.root);
      await w.answer("c2", { id: "allow_project", rule: "Bash(make:*)", scope: "project" }, true);
      expect(JSON.parse(readFileSync(join(w.root, ".winter", "settings.local.json"), "utf8")).permissions.allow).toEqual(["Bash(make:*)"]);
      expect(existsSync(join(w.home, "permissions", "projects.json"))).toBe(false);
      expect(existsSync(join(w.root, ".winter", "permissions.local.json"))).toBe(false);
    } finally { w.stop(); }
  });

  test("\"in this project\" on an UNTRUSTED project saves nothing (and the approval still resolves)", async () => {
    const w = await world();
    try {
      const res = await w.answer("c3", { id: "allow_project", rule: "Bash(make:*)", scope: "project" }, true);
      expect(res.result).toEqual({ ok: true, alreadyResolved: false });
      expect(existsSync(join(w.root, ".winter"))).toBe(false);
    } finally { w.stop(); }
  });

  // R.3 re-review B-2: in a linked worktree of a TRUSTED repo the card offers "in this project" (the bridge's
  // trust is the run home's, keyed on the repository) — and the answer IS saved, into the worktree's own local
  // tier (it used to be refused on a path-only trust check, logged, and approved once).
  test("R.3 re-review B-2: \"in this project\" from a linked worktree of a TRUSTED repo → the WORKTREE's .winter/settings.local.json", async () => {
    let wt = "";
    const w = await world((root) => {
      const git = (args: string[]) => expect(Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "ignore", env: process.env }).exitCode).toBe(0);
      git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"]);
      wt = join(tmp("winter-save-wt-"), "wt");
      git(["worktree", "add", "-q", "-b", `r3p-${Math.random().toString(16).slice(2)}`, wt]);
      wt = realpathSync(wt);
      return wt;
    });
    try {
      w.trust.trust(w.root);
      await w.answer("c6", { id: "allow_project", rule: "Bash(make:*)", scope: "project" }, true);
      expect(JSON.parse(readFileSync(join(wt, ".winter", "settings.local.json"), "utf8")).permissions.allow).toEqual(["Bash(make:*)"]);
      expect(existsSync(join(w.root, ".winter", "settings.local.json"))).toBe(false);
    } finally { w.stop(); }
  });

  // R.3 re-review B-2 (minor): `session.create` reports `trusted` with the SAME rule the card and the save use.
  test("R.3 re-review B-2: session.create in a linked worktree of a TRUSTED repo reports trusted: true", async () => {
    const w = await world();
    const git = (args: string[]) => expect(Bun.spawnSync(["git", "-C", w.root, ...args], { stdout: "ignore", stderr: "ignore", env: process.env }).exitCode).toBe(0);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"]);
    const wtPath = join(tmp("winter-save-wt-"), "wt");
    git(["worktree", "add", "-q", "-b", `r3b-${Math.random().toString(16).slice(2)}`, wtPath]);
    const wt = realpathSync(wtPath);
    try {
      w.trust.trust(w.root);
      const created = await w.client.request(METHODS.sessionCreate, { scope: "global", cwd: wt });
      expect(created.error).toBeUndefined();
      expect(created.result.trusted).toBe(true);
      const untrustedDir = tmp("winter-save-plain-");
      expect((await w.client.request(METHODS.sessionCreate, { scope: "global", cwd: untrustedDir })).result.trusted).toBe(false);
    } finally { w.stop(); }
  });

  test("a DENIED rule-bearing answer saves nothing", async () => {
    const w = await world();
    try {
      w.trust.trust(w.root);
      await w.answer("c4", { id: "allow_global", rule: "Bash(rm -rf build)", scope: "global" }, false);
      await w.answer("c5", { id: "allow_project", rule: "Bash(rm -rf build)", scope: "project" }, false);
      expect(existsSync(join(w.home, "sdk", "settings.json"))).toBe(false);
      expect(existsSync(join(w.root, ".winter", "settings.local.json"))).toBe(false);
    } finally { w.stop(); }
  });
});
