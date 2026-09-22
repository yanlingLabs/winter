import { describe, expect, test } from "bun:test";
import {
  LOGIN_SHELL_PATH_ENV,
  LOGIN_SHELL_PATH_START,
  LOGIN_SHELL_PATH_END,
  applyLoginShellPath,
  describeLoginShellPath,
  loginShellPathDisabled,
  mergePathLists,
  parseMarkedPath,
  spawnShellRunner,
  type ShellRunner,
} from "../src/login-shell-path";

/** A runner that records what it was asked to run and answers with canned stdout — no test ever
 *  spawns a real shell. */
function fakeRunner(stdout: string, calls: Array<{ shell: string; args: string[]; timeoutMs: number }> = []): ShellRunner {
  return async (shell, args, timeoutMs) => {
    calls.push({ shell, args, timeoutMs });
    return { kind: "ok", stdout };
  };
}

const marked = (path: string, noise = ""): string => `${noise}${LOGIN_SHELL_PATH_START}${path}${LOGIN_SHELL_PATH_END}${noise}`;

describe("parseMarkedPath", () => {
  test("extracts the PATH between the markers, ignoring rc-file noise on either side", () => {
    expect(parseMarkedPath(marked("/opt/homebrew/bin:/usr/bin", "Welcome to zsh!\nnvm: v22\n"))).toBe("/opt/homebrew/bin:/usr/bin");
  });
  test("no markers, an unterminated marker or an empty value answers undefined", () => {
    expect(parseMarkedPath("just noise\n")).toBeUndefined();
    expect(parseMarkedPath(`${LOGIN_SHELL_PATH_START}/usr/bin`)).toBeUndefined();
    expect(parseMarkedPath(marked(""))).toBeUndefined();
  });
  test("a value carrying a newline is refused (it is not a PATH)", () => {
    expect(parseMarkedPath(marked("/usr/bin\n/bin"))).toBeUndefined();
  });
});

describe("mergePathLists", () => {
  test("first list wins the order, duplicates dropped, empty entries dropped", () => {
    expect(mergePathLists(["/opt/homebrew/bin", "/usr/bin", ""], ["/usr/bin", "/bin", "", "/opt/homebrew/bin"])).toEqual([
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
    ]);
  });
});

describe("applyLoginShellPath", () => {
  test("merges the login shell's PATH FIRST, then the inherited entries, de-duplicated", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh" };
    const calls: Array<{ shell: string; args: string[]; timeoutMs: number }> = [];
    const outcome = await applyLoginShellPath({
      env,
      run: fakeRunner(marked("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin", "rc noise\n"), calls),
    });
    expect(env.PATH).toBe("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(outcome.source).toBe("login-shell");
    expect(outcome.changed).toBe(true);
    expect(outcome.added).toEqual(["/opt/homebrew/bin", "/opt/homebrew/sbin"]);
    // A LOGIN shell (`-l`), bounded, with the user's own shell.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.shell).toBe("/bin/zsh");
    expect(calls[0]!.args).toContain("-l");
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  test("a relative entry from the login shell is never merged (the daemon's cwd is arbitrary)", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await applyLoginShellPath({ env, run: fakeRunner(marked(".:bin:/opt/homebrew/bin:/usr/bin")) });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  test("an unchanged PATH (terminal launch) reports changed: false and leaves env.PATH byte-identical", async () => {
    const env: Record<string, string | undefined> = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", SHELL: "/bin/zsh" };
    const outcome = await applyLoginShellPath({ env, run: fakeRunner(marked("/opt/homebrew/bin:/usr/bin")) });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(outcome.changed).toBe(false);
    expect(outcome.added).toEqual([]);
  });

  test("a timeout falls back to the inherited PATH plus the Homebrew dirs that EXIST", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
    const outcome = await applyLoginShellPath({
      env,
      run: async () => ({ kind: "timeout" }),
      exists: (p) => p === "/opt/homebrew/bin" || p === "/opt/homebrew/sbin",
    });
    expect(outcome.source).toBe("fallback");
    expect(outcome.reason).toContain("timed out");
    expect(env.PATH).toBe("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin");
    expect(outcome.added).toEqual(["/opt/homebrew/bin", "/opt/homebrew/sbin"]);
  });

  test("a failing shell, or output with no markers, falls back too — never throws", async () => {
    const env1: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const o1 = await applyLoginShellPath({ env: env1, run: async () => ({ kind: "error", reason: "exit 1" }), exists: () => false });
    expect(o1.source).toBe("fallback");
    expect(o1.changed).toBe(false);
    expect(env1.PATH).toBe("/usr/bin");
    const env2: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const o2 = await applyLoginShellPath({ env: env2, run: fakeRunner("oh-my-zsh update? [Y/n]"), exists: () => false });
    expect(o2.source).toBe("fallback");
    expect(o2.reason).toContain("no PATH");
    const env3: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const o3 = await applyLoginShellPath({ env: env3, run: async () => { throw new Error("spawn EACCES"); }, exists: () => false });
    expect(o3.source).toBe("fallback");
    expect(env3.PATH).toBe("/usr/bin");
  });

  test("SHELL absent (LaunchServices) resolves through /bin/zsh", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    const calls: Array<{ shell: string; args: string[]; timeoutMs: number }> = [];
    await applyLoginShellPath({ env, run: fakeRunner(marked("/opt/homebrew/bin:/usr/bin"), calls) });
    expect(calls[0]!.shell).toBe("/bin/zsh");
  });

  test("a relative or unknown-dialect SHELL is never run as given", async () => {
    const calls: Array<{ shell: string; args: string[]; timeoutMs: number }> = [];
    await applyLoginShellPath({ env: { PATH: "/usr/bin", SHELL: "zsh" }, run: fakeRunner(marked("/usr/bin"), calls) });
    await applyLoginShellPath({ env: { PATH: "/usr/bin", SHELL: "/opt/homebrew/bin/nu" }, run: fakeRunner(marked("/usr/bin"), calls) });
    expect(calls.map((c) => c.shell)).toEqual(["/bin/zsh", "/bin/zsh"]);
  });

  test("fish gets a fish-dialect script (its PATH is a list)", async () => {
    const calls: Array<{ shell: string; args: string[]; timeoutMs: number }> = [];
    await applyLoginShellPath({ env: { PATH: "/usr/bin", SHELL: "/opt/homebrew/bin/fish" }, run: fakeRunner(marked("/usr/bin"), calls) });
    expect(calls[0]!.shell).toBe("/opt/homebrew/bin/fish");
    // `string join` prints a trailing newline, which `parseMarkedPath` refuses — it must go through
    // `printf '%s'` so the END marker follows the PATH directly.
    expect(calls[0]!.args.join(" ")).toContain("printf '%s' (string join : $PATH)");
    expect(parseMarkedPath(`${LOGIN_SHELL_PATH_START}/usr/bin:/bin\n${LOGIN_SHELL_PATH_END}`)).toBeUndefined();
  });

  for (const value of ["off", "OFF", "Off", "0", "false", "FALSE", " off "]) {
    test(`${LOGIN_SHELL_PATH_ENV}=${JSON.stringify(value)} disables resolution entirely — the runner is never called`, async () => {
      const env: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh", [LOGIN_SHELL_PATH_ENV]: value };
      let called = false;
      const outcome = await applyLoginShellPath({ env, run: async () => { called = true; return { kind: "ok", stdout: "" }; } });
      expect(called).toBe(false);
      expect(outcome.source).toBe("disabled");
      expect(env.PATH).toBe("/usr/bin");
    });
  }

  test(`any other ${LOGIN_SHELL_PATH_ENV} value leaves resolution on`, async () => {
    for (const value of ["on", "1", "true", ""]) {
      expect(loginShellPathDisabled({ [LOGIN_SHELL_PATH_ENV]: value })).toBe(false);
    }
    expect(loginShellPathDisabled({})).toBe(false);
  });
});

// The REAL runner, driven through `/bin/sh -c` with an explicit script — no `-l`, no rc file, never
// the user's own login shell.
describe("spawnShellRunner", () => {
  const script = (body: string): string => `${body}printf '%s' '${LOGIN_SHELL_PATH_START}/opt/x/bin:/usr/bin${LOGIN_SHELL_PATH_END}'`;
  test("answers the marked output", async () => {
    const r = await spawnShellRunner("/bin/sh", ["-c", script("echo noise; ")], 5_000, { PATH: "/usr/bin:/bin" });
    expect(r.kind).toBe("ok");
    expect(parseMarkedPath((r as { stdout: string }).stdout)).toBe("/opt/x/bin:/usr/bin");
  });
  test("a background job holding the pipe open does not turn a good answer into a timeout", async () => {
    const started = Date.now();
    const r = await spawnShellRunner("/bin/sh", ["-c", script("sleep 2 & ")], 3_000, { PATH: "/usr/bin:/bin" });
    expect(r.kind).toBe("ok");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  test("a hung shell is abandoned at the deadline", async () => {
    const started = Date.now();
    const r = await spawnShellRunner("/bin/sh", ["-c", "sleep 20"], 300, { PATH: "/usr/bin:/bin" });
    expect(r.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  test("a missing shell is an error, never a throw", async () => {
    const r = await spawnShellRunner("/nonexistent/shell", ["-c", "true"], 1_000, { PATH: "/usr/bin:/bin" });
    expect(r.kind).toBe("error");
  });
});

describe("describeLoginShellPath — the one boot log line", () => {
  test("names the source and what was added; carries no other environment value", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh", OPENAI_API_KEY: "sk-secret-value" };
    const outcome = await applyLoginShellPath({ env, run: fakeRunner(marked("/opt/homebrew/bin:/usr/bin")) });
    const line = describeLoginShellPath(outcome);
    expect(line).toContain("login shell");
    expect(line).toContain("/bin/zsh");
    expect(line).toContain("/opt/homebrew/bin");
    expect(line).not.toContain("sk-secret-value");
    expect(line.includes("\n")).toBe(false);
  });
  test("an unchanged PATH says so", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const line = describeLoginShellPath(await applyLoginShellPath({ env, run: fakeRunner(marked("/usr/bin")) }));
    expect(line).toContain("unchanged");
  });
  test("a fallback names the reason", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const line = describeLoginShellPath(await applyLoginShellPath({ env, run: async () => ({ kind: "timeout" }), exists: () => false }));
    expect(line).toContain("timed out");
  });
});
