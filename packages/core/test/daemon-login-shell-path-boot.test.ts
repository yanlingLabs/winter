// A1: the login-shell PATH is resolved ONCE at boot, inside `startDaemon`, and merged into the
// environment every spawn builds its own `env` from. Driven with a FAKE runner and a FAKE env object — no test
// ever runs the developer's real login shell, and the test process's own PATH is never touched.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { TOKEN_NAMES } from "../src/auth/tokens";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { LOGIN_SHELL_PATH_END, LOGIN_SHELL_PATH_START, type ShellRunner } from "../src/login-shell-path";
import { withTempHome } from "./runtime-state/support";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  const stopping = daemon?.stop();
  daemon = undefined;
  await stopping;
});

describe("daemon boot — login-shell PATH", () => {
  test("the login shell's PATH is merged (its entries first) before the daemon starts serving, with one log line", async () => {
    await withTempHome(async (home) => {
      const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", HOME: home };
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      const calls: string[] = [];
      // Fix round (P9c-20): the probe runs AFTER the daemon's tokens are minted, so a slow rc file
      // never delays the tokens a first-boot client waits for.
      let tokenPresentWhenProbed: boolean | undefined;
      const run: ShellRunner = async (shell) => {
        calls.push(shell);
        tokenPresentWhenProbed = (await secrets.get(TOKEN_NAMES.harness)) !== null;
        return { kind: "ok", stdout: `Last login: noise\n${LOGIN_SHELL_PATH_START}/opt/homebrew/bin:/usr/bin:/bin${LOGIN_SHELL_PATH_END}` };
      };
      const lines: string[] = [];
      const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
      try {
        daemon = await startDaemon({
          home,
          secrets,
          agentProvider: null,
          loginShellPath: { env, run },
        });
      } finally {
        spy.mockRestore();
      }
      expect(calls).toEqual(["/bin/zsh"]);
      expect(tokenPresentWhenProbed).toBe(true);
      expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
      const pathLines = lines.filter((l) => l.startsWith("env: "));
      expect(pathLines).toHaveLength(1);
      expect(pathLines[0]).toContain("/opt/homebrew/bin");
    });
  });

  test("`loginShellPath: false` skips resolution entirely", async () => {
    await withTempHome(async (home) => {
      const before = process.env.PATH;
      daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null, loginShellPath: false });
      expect(process.env.PATH).toBe(before);
    });
  });
});
