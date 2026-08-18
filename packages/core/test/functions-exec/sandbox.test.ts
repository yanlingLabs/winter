import { describe, expect, test } from "bun:test";
import { buildFunctionsExecSeatbeltProfile, functionsExecSandboxAvailable } from "../../src/functions-exec/sandbox";

describe("functions-exec Seatbelt profile", () => {
  test("permits only runtime reads while denying protected roots, writes, networking, and forks", () => {
    const profile = buildFunctionsExecSeatbeltProfile({
      workerExecutable: "/opt/norma/bin/norma",
      runtimePaths: ["/opt/norma/runtime"],
      protectedRoots: ["/Users/example/project"],
    });

    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(allow process-exec (literal "/opt/norma/bin/norma"))');
    expect(profile).toContain('(allow file-read*\n  (literal "/opt/norma/bin/norma")');
    expect(profile).toContain('(literal "/opt/norma/runtime")');
    expect(profile).toContain('(deny file-read* (subpath "/Users/example/project"))');
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny process-fork)");
    expect(profile).not.toContain('(literal "/"))');
  });

  test("is available only with macOS Seatbelt", () => {
    expect(functionsExecSandboxAvailable("darwin", true)).toBe(true);
    expect(functionsExecSandboxAvailable("darwin", false)).toBe(false);
    expect(functionsExecSandboxAvailable("linux", true)).toBe(false);
    expect(functionsExecSandboxAvailable("win32", true)).toBe(false);
  });
});
