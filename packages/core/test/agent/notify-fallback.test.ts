import { describe, expect, test } from "bun:test";
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

  test("default spawn parameter falls back silently (never throws) when osascript itself is unavailable", () => {
    // No spawn override — exercises the real defaultOsascriptSpawn on a platform where osascript
    // may not exist (Bun.spawn throws ENOENT synchronously in that case); notifyHeadless must
    // never propagate that as an exception (a headless-fallback failure must never fail the tool
    // call that already returned "notification sent").
    expect(() => notifyHeadless("T", "m")).not.toThrow();
  });
});
