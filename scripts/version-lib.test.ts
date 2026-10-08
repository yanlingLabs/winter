// Winter Phase 9c (P9c-2): the new `#.###.#` version scheme. Pure logic only — no shell-outs, no
// real releases — mirrors release-lib.test.ts's own posture for the rest of the release pipeline.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORMAT, nextVersion, readCanonical, ROOT, semverTwin, stampInfoPlist, stampProjectYml } from "./version-lib";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempVersionFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "winter-version-lib-test-"));
  temps.push(dir);
  const path = join(dir, "VERSION");
  writeFileSync(path, content);
  return path;
}

describe("FORMAT", () => {
  for (const v of ["0.111.0", "0.112.9", "1.000.0"]) {
    test(`accepts ${v}`, () => {
      expect(FORMAT.test(v)).toBe(true);
    });
  }
  for (const v of ["0.2.014", "0.111.10", "0.11.0"]) {
    test(`rejects ${v}`, () => {
      expect(FORMAT.test(v)).toBe(false);
    });
  }
});

describe("semverTwin", () => {
  test("is identity for the new #.###.# scheme", () => {
    expect(semverTwin("0.111.0")).toBe("0.111.0");
  });
  test("still strips leading zeros in the feature group (semver's own constraint)", () => {
    expect(semverTwin("1.000.0")).toBe("1.0.0");
  });
  test("throws on a non-canonical input", () => {
    expect(() => semverTwin("0.2.014")).toThrow(/not a canonical version/);
  });
});

describe("readCanonical", () => {
  test("error text names #.###.# on a malformed VERSION file (old #.#.### scheme)", () => {
    const path = tempVersionFile("0.2.014\n");
    expect(() => readCanonical(path)).toThrow(/#\.###\.#/);
  });
  test("a well-formed #.###.# VERSION file round-trips", () => {
    const path = tempVersionFile("0.111.0\n");
    expect(readCanonical(path)).toBe("0.111.0");
  });
  test("trims trailing whitespace/newline", () => {
    const path = tempVersionFile("0.111.0\n\n");
    expect(readCanonical(path)).toBe("0.111.0");
  });
  test("the real repo VERSION file is itself canonical", () => {
    expect(FORMAT.test(readCanonical())).toBe(true);
  });
});

describe("nextVersion", () => {
  test("0.111.0 --patch -> 0.111.1", () => {
    expect(nextVersion("0.111.0", "--patch")).toBe("0.111.1");
  });
  test("0.111.9 --patch throws naming --feature", () => {
    expect(() => nextVersion("0.111.9", "--patch")).toThrow(/--feature/);
  });
  test("0.111.3 --feature -> 0.112.0", () => {
    expect(nextVersion("0.111.3", "--feature")).toBe("0.112.0");
  });
  test("0.999.0 --feature throws naming --major", () => {
    expect(() => nextVersion("0.999.0", "--feature")).toThrow(/--major/);
  });
  test("0.111.3 --major -> 1.000.0", () => {
    expect(nextVersion("0.111.3", "--major")).toBe("1.000.0");
  });
  test("--minor throws pointing at --feature, not the generic unknown-mode message", () => {
    expect(() => nextVersion("0.111.0", "--minor")).toThrow(/use --feature/);
  });
  test("an unrecognized mode throws the generic usage message", () => {
    expect(() => nextVersion("0.111.0", "--bogus")).toThrow(/--patch \| --feature \| --major/);
  });
  test("a non-canonical current version throws before considering the mode", () => {
    expect(() => nextVersion("0.2.014", "--patch")).toThrow(/#\.###\.#/);
  });
});

describe("stamping the apple sources", () => {
  test("project.yml: EVERY versioned target is stamped (Winter.app and the Winter Computer Use helper), not just the first", () => {
    const yml = readFileSync(join(ROOT, "apple", "Winter", "project.yml"), "utf8");
    const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;
    expect(count(yml, /CFBundleShortVersionString: "[^"]*"/g)).toBe(2);
    const stamped = stampProjectYml(yml, "9.999.9");
    expect(count(stamped, /CFBundleShortVersionString: "9\.999\.9"/g)).toBe(2);
    expect(count(stamped, /CFBundleVersion: "9\.999\.9"/g)).toBe(2);
    expect(stamped.replaceAll("9.999.9", readCanonical())).toBe(yml);
  });

  test("the helper's generated Info.plist is a stamped source, and today carries the canonical version", () => {
    const plist = readFileSync(join(ROOT, "apple", "WinterComputerUse", "Support", "Info.plist"), "utf8");
    expect(plist).toMatch(new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${readCanonical().replaceAll(".", "\\.")}</string>`));
    const stamped = stampInfoPlist(plist, "9.999.9");
    expect(stamped).toMatch(/<key>CFBundleShortVersionString<\/key>\s*<string>9\.999\.9<\/string>/);
    expect(stamped).toMatch(/<key>CFBundleVersion<\/key>\s*<string>9\.999\.9<\/string>/);
  });
});
