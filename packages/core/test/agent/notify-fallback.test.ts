import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { notifyHeadless } from "../../src/agent/notify-fallback";

describe("notifyHeadless (osascript headless fallback)", () => {
  test("spawns a FIXED 3-line AppleScript, passing title/message as trailing argv items", () => {
    const calls: string[][] = [];
    notifyHeadless("Winter", "hello", (cmd) => { calls.push(cmd); });
    expect(calls).toHaveLength(1);
    const cmd = calls[0]!;
    expect(cmd[0]).toBe("osascript");
    // Everything up to the "--" separator is the SAME literal script regardless of the message —
    // the message/title are never concatenated into it.
    const sep = cmd.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(cmd.slice(0, sep)).toEqual([
      "osascript",
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e", "end run",
    ]);
    expect(cmd.slice(sep + 1)).toEqual(["hello", "Winter"]);
  });

  // Injection safety: a message stuffed with quotes/semicolons/backticks/AppleScript keywords must
  // ride as ONE verbatim argv element after "--", never get spliced into the script text (which
  // stays byte-identical no matter what the message contains) and never reach a shell at all
  // (Bun.spawn's argv array bypasses /bin/sh entirely — there is no shell here to reinterpret it).
  test("a quote/semicolon/backtick-laden message rides as one verbatim argv item — never touches the script text", () => {
    const hostile = `"; do shell script "rm -rf ~"; display dialog "pwned` + "` echo hi `" + `' OR 1=1 --`;
    const calls: string[][] = [];
    notifyHeadless("Title", hostile, (cmd) => { calls.push(cmd); });
    const cmd = calls[0]!;
    const sep = cmd.indexOf("--");
    // the fixed script lines are UNCHANGED — no trace of the hostile string in them
    for (const line of cmd.slice(0, sep)) {
      expect(line.includes(hostile)).toBe(false);
    }
    // the hostile string survives completely intact as its own argv element
    expect(cmd[sep + 1]).toBe(hostile);
    expect(cmd).toHaveLength(sep + 3); // -- + message + title, nothing split/escaped/dropped
  });

  // The default seam is `Bun.spawn`: spied here, so the real default path runs end to end (argv, stdio) while no real
  // `osascript` ever shows a notification on the machine running the tests.
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">> | undefined;
  afterEach(() => { spawnSpy?.mockRestore(); spawnSpy = undefined; });

  test("default spawn hands Bun.spawn the same fixed argv, with every stdio ignored", () => {
    const seen: Array<{ cmd: unknown; opts: unknown }> = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: unknown, opts: unknown) => { seen.push({ cmd, opts }); return {} as never; }) as never);
    notifyHeadless("Winter", "hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmd).toEqual([
      "osascript",
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e", "end run",
      "--", "hello", "Winter",
    ]);
    expect(seen[0]!.opts).toEqual({ stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  });

  test("default spawn falls back silently (never throws) when osascript itself is unavailable", () => {
    // Bun.spawn throws ENOENT synchronously when the binary is missing (non-macOS, a minimal image); notifyHeadless must
    // never propagate that (a headless-fallback failure must never fail the tool call that already returned
    // "notification sent"). Simulated by a spy, so the test is the same on every machine and never shells out.
    let calls = 0;
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => { calls++; throw Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" }); }) as never);
    expect(() => notifyHeadless("T", "m")).not.toThrow();
    expect(calls).toBe(1);
  });
});
