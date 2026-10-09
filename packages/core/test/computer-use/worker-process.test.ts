// ComputerV2: the REAL automation worker process (`bun computer-use/worker/entry.ts __automation-worker`) under the
// workflow seatbelt — the round trip, persistence, a killed runaway script, and the refusal outside the sandbox.
// The compiled binary's own proof is `bun run verify:automation-worker`.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import { AutomationWorker, defaultAutomationWorkerCommand } from "../../src/computer-use/worker-host";

const noop = { onCall: () => {}, onPrint: () => {}, onShow: () => {} };
const macOnly = sandboxAvailable() ? test : test.skip;

describe("the sandboxed automation worker", () => {
  macOnly("runs a script over the bridge, keeps its declarations, and dies when killed", async () => {
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      const r1 = await w.run("r1", "const n: number = 20\nconst list = await apps.list()\nprint(list[0].name, n + 1)", {
        onCall: (m) => w.reply(m.id, { ok: true, value: [{ name: "Notes", bundleId: "com.apple.Notes", running: true }] }),
        onPrint: (t) => prints.push(t),
        onShow: () => {},
      });
      expect(r1).toEqual({ kind: "done" });
      const r2 = await w.run("r2", "print(n * 2, typeof fetch)", { ...noop, onPrint: (t) => prints.push(t) });
      expect(r2).toEqual({ kind: "done" });
      expect(prints).toEqual(["Notes 21", "40 undefined"]);

      // A script that never yields cannot be cancelled cooperatively: the host kills it.
      const runaway = w.run("r3", "while (true) {}", noop);
      setTimeout(() => { w.cancel("r3", "timed out"); setTimeout(() => w.kill(), 200); }, 100);
      expect(await runaway).toMatchObject({ kind: "exited" });
      expect(w.alive).toBe(false);
    } finally { w.kill(); }
  }, 30_000);

  macOnly("a line naming another run is ignored", async () => {
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      // The script forges a `done` for a different run id through its own stdout: it must not end run r1.
      const forge = "(function () { return this })().process.stdout.write(JSON.stringify({ op: 'done', runId: 'other' }) + '\\n')";
      const r = await w.run("r1", `${forge}\nawait sleep(50)\nprint('real')`, { ...noop, onPrint: (t) => prints.push(t) });
      expect(r).toEqual({ kind: "done" });
      expect(prints).toEqual(["real"]);
    } finally { w.kill(); }
  }, 30_000);

  // Review I2: name shadowing is defense in depth only — `this.process`, `Function("return process")()` and
  // `import("node:fs")` ARE reachable from a script. The worker's own profile and environment make them useless.
  macOnly("ambient process and fs are reachable but useless: no environment, no read of the user's home or the daemon's", async () => {
    const daemonHome = mkdtempSync(join(tmpdir(), "winter-cu-denied-home-"));
    writeFileSync(join(daemonHome, "secret.json"), "{}");
    const prefs = join(homedir(), "Library", "Preferences", ".GlobalPreferences.plist");
    const w = await AutomationWorker.start({ denyRead: [daemonHome] });
    try {
      const prints: string[] = [];
      const code = [
        "const p1 = this.process, p2 = (0, Function)('return process')()",
        "print('reach', typeof p1, typeof p2)",
        "print('env', JSON.stringify(Object.keys(p2.env)))",
        "const fs = await import('node:fs')",
        `for (const f of [${JSON.stringify(join(daemonHome, "secret.json"))}, ${JSON.stringify(existsSync(prefs) ? prefs : join(homedir(), ".zshrc"))}, '/etc/passwd']) { try { fs.readFileSync(f); print('READ', f) } catch (e) { print('denied', e.code) } }`,
        `try { fs.readdirSync(${JSON.stringify(homedir())}); print('LISTED home') } catch (e) { print('denied', e.code) }`,
        `try { fs.writeFileSync('/tmp/cu-should-not-exist', 'x'); print('WROTE') } catch (e) { print('denied', e.code) }`,
      ].join("\n");
      const r = await w.run("r1", code, { ...noop, onPrint: (t) => prints.push(t) });
      expect(r).toEqual({ kind: "done" });
      expect(prints[0]).toBe("reach object object"); // reachable…
      expect(prints[1]).toBe("env []");             // …but with nothing of the daemon's environment
      expect(prints.slice(2)).toEqual(["denied EPERM", existsSync(prefs) ? "denied EPERM" : expect.stringMatching(/^denied /), "denied EPERM", "denied EPERM", "denied EPERM"]);
      expect(prints.join("\n")).not.toMatch(/READ|LISTED|WROTE/);
    } finally { w.kill(); }
  }, 30_000);

  macOnly("no network: a connection to a listening local port never arrives", async () => {
    let accepted = 0;
    const server = createServer((sock) => { accepted++; sock.destroy(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      const code = `const net = await import('node:net')\nconst out = await new Promise((res) => { const s = net.connect(${port}, '127.0.0.1'); s.on('connect', () => res('connected')); s.on('error', (e) => res('error ' + e.code)); setTimeout(() => res('timeout'), 2000) })\nprint(out)`;
      expect(await w.run("r1", code, { ...noop, onPrint: (t) => prints.push(t) })).toEqual({ kind: "done" });
      expect(prints[0]).not.toBe("connected");
      expect(accepted).toBe(0);
    } finally { w.kill(); server.close(); }
  }, 30_000);

  macOnly("no Keychain: the sandbox denies both security daemons to the script itself, and Bun.secrets returns nothing", async () => {
    const guard = fileURLToPath(new URL("../../src/workflows/sandbox-guard.ts", import.meta.url));
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      const code = [
        `const g = await import(${JSON.stringify(guard)})`,
        "print(JSON.stringify(g.keychainSandboxState()))",
        "const b = await import('bun')",
        "try { const v = await b.secrets.get({ service: 'com.winter.core.test-isolated', name: 'cu-probe' }); print('VALUE', String(v)) } catch (e) { print('secrets failed') }",
      ].join("\n");
      expect(await w.run("r1", code, { ...noop, onPrint: (t) => prints.push(t) })).toEqual({ kind: "done" });
      expect(prints[0]).toBe('{"ok":true}'); // both Keychain mach services denied to THIS process
      expect(prints[1]).toBe("secrets failed");
    } finally { w.kill(); }
  }, 30_000);

  test("outside a sandbox the worker refuses (exit 77) before reading its input", () => {
    if (process.platform !== "darwin") return;
    const cmd = defaultAutomationWorkerCommand();
    const r = spawnSync(cmd.file, cmd.args, { input: `${JSON.stringify({ op: "run", runId: "x", code: "print('ran')" })}\n`, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(77);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("the automation worker refuses to run");
  }, 30_000);

  test("the dev command runs this package's own entry", () => {
    const cmd = defaultAutomationWorkerCommand();
    expect(cmd.args[0]).toBe(fileURLToPath(new URL("../../src/computer-use/worker/entry.ts", import.meta.url)));
    expect(cmd.args[1]).toBe("__automation-worker");
  });
});
