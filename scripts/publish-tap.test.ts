// Winter Phase 9c (P9c-5): the tap publisher. Never invokes a real `gh` — every `--publish`-path
// test uses a FAKE GhRunner, per the lane's hard constraint (this repo's own release/publish
// scripts are controller-only; `--dry-run` reads local files only and is exercised for real in
// scripts/release-lib.test.ts-style pure-function tests here instead of via the CLI).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitMessageFor,
  currentSha,
  findUnfilledTemplateSlot,
  publishFile,
  putArgsFor,
  renderDryRunEntry,
  TAP_REPO,
  tapPlan,
  type GhRunner,
} from "./publish-tap";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "winter-publish-tap-test-"));
  temps.push(dir);
  const path = join(dir, "cask.rb");
  writeFileSync(path, content);
  return path;
}

describe("tapPlan", () => {
  test("names both cask paths, keyed off the given version", () => {
    const plan = tapPlan("0.111.0");
    expect(plan).toHaveLength(2);
    expect(plan[0]!.repoPath).toBe("Casks/winter.rb");
    expect(plan[0]!.localPath).toContain("out/release/0.111.0/winter.rb");
    expect(plan[1]!.repoPath).toBe("Casks/norma.rb");
    expect(plan[1]!.localPath).toContain("packaging/norma-deprecated.rb");
  });

  test("norma.rb's source path never depends on the version (it's controller-filled, not release-rendered)", () => {
    expect(tapPlan("0.111.0")[1]!.localPath).toBe(tapPlan("0.222.5")[1]!.localPath);
  });
});

describe("commitMessageFor", () => {
  test("ends with the Claude-Session trailer", () => {
    expect(commitMessageFor("Casks/winter.rb")).toMatch(/Claude-Session: https:\/\/claude\.ai\/code\/session_/);
  });
  test("names the exact file being published", () => {
    expect(commitMessageFor("Casks/norma.rb")).toContain("Casks/norma.rb");
  });
});

describe("putArgsFor", () => {
  test("base64-encodes the content and targets the right repo/path", () => {
    const args = putArgsFor("Casks/winter.rb", "cask \"winter\" do\nend\n", undefined);
    expect(args).toEqual([
      "api",
      "-X",
      "PUT",
      `repos/${TAP_REPO}/contents/Casks/winter.rb`,
      "-f",
      `message=${commitMessageFor("Casks/winter.rb")}`,
      "-f",
      `content=${Buffer.from("cask \"winter\" do\nend\n", "utf8").toString("base64")}`,
    ]);
  });

  test("omits sha entirely when creating a new file", () => {
    const args = putArgsFor("Casks/norma.rb", "content", undefined);
    expect(args.join(" ")).not.toContain("sha=");
  });

  test("includes sha when updating an existing file", () => {
    const args = putArgsFor("Casks/norma.rb", "content", "abc123def");
    expect(args).toContain("-f");
    expect(args).toContain("sha=abc123def");
  });
});

describe("currentSha", () => {
  test("returns the sha when gh succeeds with a nonempty value", () => {
    const runner: GhRunner = () => "deadbeef\n";
    expect(currentSha(runner, "Casks/winter.rb")).toBe("deadbeef");
  });

  test("returns undefined when gh throws (404 — the cask does not exist yet)", () => {
    const runner: GhRunner = () => {
      throw new Error("gh: 404 Not Found");
    };
    expect(currentSha(runner, "Casks/norma.rb")).toBeUndefined();
  });

  test("treats an empty jq result the same as absent, rather than an empty-string sha", () => {
    const runner: GhRunner = () => "";
    expect(currentSha(runner, "Casks/winter.rb")).toBeUndefined();
  });

  test("queries the exact repo/path this release publishes to", () => {
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      return "sha1\n";
    };
    currentSha(runner, "Casks/winter.rb");
    expect(calls).toEqual([["api", `repos/${TAP_REPO}/contents/Casks/winter.rb`, "--jq", ".sha"]]);
  });
});

describe("publishFile", () => {
  test("fetches the current sha, then PUTs with it included (updating an existing cask)", () => {
    const localPath = tempFile("cask \"winter\" do\nend\n");
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "api" && args.length === 4) return "existing-sha\n"; // the sha lookup
      return ""; // the PUT itself
    };
    publishFile(runner, { repoPath: "Casks/winter.rb", localPath });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["api", `repos/${TAP_REPO}/contents/Casks/winter.rb`, "--jq", ".sha"]);
    expect(calls[1]).toEqual(putArgsFor("Casks/winter.rb", "cask \"winter\" do\nend\n", "existing-sha"));
  });

  test("omits sha on a brand-new cask (the sha lookup 404s)", () => {
    const localPath = tempFile("cask \"norma\" do\nend\n");
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "api" && args.length === 4) throw new Error("404");
      return "";
    };
    publishFile(runner, { repoPath: "Casks/norma.rb", localPath });

    expect(calls[1]).toEqual(putArgsFor("Casks/norma.rb", "cask \"norma\" do\nend\n", undefined));
  });

  // Fix wave M3 (whole-branch review, Major): a file that still carries an unfilled `{{slot}}`
  // (packaging/norma-deprecated.rb, verbatim in this repo, before the controller hand-fills it)
  // must never publish literally — no network call at all, not even the sha lookup.
  test("refuses (before any network call) when the file still contains an unfilled {{slot}}", () => {
    const localPath = tempFile('cask "norma" do\n  version "{{version}}"\n  sha256 "{{sha256}}"\nend\n');
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      return "";
    };
    expect(() => publishFile(runner, { repoPath: "Casks/norma.rb", localPath })).toThrow(/Casks\/norma\.rb/);
    expect(() => publishFile(runner, { repoPath: "Casks/norma.rb", localPath })).toThrow(/\{\{version\}\}/);
    expect(calls).toHaveLength(0); // never even reached the sha lookup
  });
});

describe("findUnfilledTemplateSlot", () => {
  test("finds the first {{slot}} placeholder", () => {
    expect(findUnfilledTemplateSlot('version "{{version}}"\nsha256 "{{sha256}}"')).toBe("{{version}}");
  });
  test("undefined once every slot has been filled in", () => {
    expect(findUnfilledTemplateSlot('version "0.2.015"\nsha256 "deadbeef"')).toBeUndefined();
  });
  test("a Ruby string-interpolation `#{...}` is not a template slot (different delimiter)", () => {
    expect(findUnfilledTemplateSlot('url "https://example.com/#{version}/x.dmg"')).toBeUndefined();
  });
  test("a slot name spelled inside a Ruby comment line is not an unfilled slot", () => {
    expect(
      findUnfilledTemplateSlot('# CONTROLLER: replace {{version}} and {{sha256}} by hand\n  version "0.2.015"\n'),
    ).toBeUndefined();
  });
  test("a live-stanza slot is still found when comments also spell it", () => {
    expect(findUnfilledTemplateSlot('#   {{version}} -> "0.2.015"\n  version "{{version}}"\n')).toBe("{{version}}");
  });
});

describe("renderDryRunEntry — fix wave M3 (whole-branch review, Major)", () => {
  test("prints the full content when there is no unfilled slot", () => {
    const localPath = tempFile('cask "winter" do\nend\n');
    const entry = renderDryRunEntry({ repoPath: "Casks/winter.rb", localPath });
    expect(entry).toContain("Casks/winter.rb");
    expect(entry).toContain('cask "winter" do');
    expect(entry).not.toContain("REFUSED");
  });

  test("prints a REFUSED line naming the file and the slot — never the literal template content — when a slot is unfilled", () => {
    const localPath = tempFile('cask "norma" do\n  version "{{version}}"\nend\n');
    const entry = renderDryRunEntry({ repoPath: "Casks/norma.rb", localPath });
    expect(entry).toContain("Casks/norma.rb");
    expect(entry).toContain("REFUSED");
    expect(entry).toContain("{{version}}");
    expect(entry).not.toContain('cask "norma" do'); // the raw unfilled content is never printed
  });

  test("prints the 'missing on disk' note when the file does not exist yet — never a false refusal", () => {
    const entry = renderDryRunEntry({ repoPath: "Casks/winter.rb", localPath: join(tmpdir(), "winter-publish-tap-test-does-not-exist", "winter.rb") });
    expect(entry).toContain("missing on disk");
    expect(entry).not.toContain("REFUSED");
  });
});
