// ComputerV2 Phase 3 — where a download() file goes (`download-paths.ts`): the plan's rules and refusals, and the
// placing (never through a link, never over a file, the bytes checked, the quarantine attribute set).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStagedDownloads, downloadStagingRoot, newStagingDir, placeDownload, planDownload, quarantineValue, safeDownloadName, type DownloadRoots,
} from "../../src/computer-use/browser/download-paths";
import { AutomationFailure } from "../../src/computer-use/errors";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "winter-dl-")));
  const cwd = join(base, "project");
  const home = join(base, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  const tmpDir = join(base, "winter-session-s1");
  const roots: DownloadRoots = { cwd, tmpDir, home, denyWrite: [join(cwd, "vendor-locked")] };
  const stage = (content: string): string => {
    const dir = newStagingDir(home, "s1");
    const p = join(dir, "file");
    writeFileSync(p, content);
    return p;
  };
  return { base, cwd, home, tmpDir, roots, stage, done: () => rmSync(base, { recursive: true, force: true }) };
}

const refusal = (f: () => unknown): string => {
  try { f(); } catch (err) { return err instanceof AutomationFailure ? `${err.kind}: ${err.message}` : `other: ${(err as Error).message}`; }
  return "no refusal";
};

describe("safeDownloadName", () => {
  test("a basename with no control characters, separators, leading dots or bidi marks; at most 200 bytes; never empty", () => {
    expect(safeDownloadName("report.csv")).toBe("report.csv");
    expect(safeDownloadName("../../etc/passwd")).toBe("passwd");
    expect(safeDownloadName("..\\..\\win.ini")).toBe("win.ini");
    expect(safeDownloadName("a:b\u0007c.txt")).toBe("abc.txt");
    expect(safeDownloadName("...env")).toBe("env");
    expect(safeDownloadName("in‮voice.pdf")).toBe("invoice.pdf");
    expect(safeDownloadName("")).toBe("download");
    expect(safeDownloadName(undefined)).toBe("download");
    const long = safeDownloadName(`${"é".repeat(150)}.tar.gz`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith(".gz")).toBe(true);
  });
});

describe("planDownload", () => {
  test("no { to }: the session's temp folder, downloads/<name>", () => {
    const f = fixture();
    try {
      expect(planDownload(undefined, "report.csv", f.roots)).toEqual({ root: "tmp", rootPath: f.tmpDir, dirs: ["downloads"], name: "report.csv" });
    } finally { f.done(); }
  });

  test("{ to }: relative to the working directory, a trailing / a folder, absolute inside either root", () => {
    const f = fixture();
    try {
      expect(planDownload("data/q3.csv", "report.csv", f.roots)).toEqual({ root: "cwd", rootPath: f.cwd, dirs: ["data"], name: "q3.csv" });
      expect(planDownload("data/", "report.csv", f.roots)).toEqual({ root: "cwd", rootPath: f.cwd, dirs: ["data"], name: "report.csv" });
      expect(planDownload(".", "report.csv", f.roots)).toEqual({ root: "cwd", rootPath: f.cwd, dirs: [], name: "report.csv" });
      expect(planDownload(join(f.tmpDir, "x", "y.bin"), "z", f.roots)).toEqual({ root: "tmp", rootPath: f.tmpDir, dirs: ["x"], name: "y.bin" });
    } finally { f.done(); }
  });

  test("refusals name the rule: outside both roots, a hidden segment, a settings file, the home, the deny-write list", () => {
    const f = fixture();
    try {
      expect(refusal(() => planDownload("/etc/hosts", "x", f.roots))).toMatch(/NotAllowed: \/etc\/hosts is outside this session's working directory and temp folder/);
      expect(refusal(() => planDownload("../elsewhere.txt", "x", f.roots))).toMatch(/NotAllowed: .*outside/);
      expect(refusal(() => planDownload(".git/hooks/pre-commit", "x", f.roots))).toMatch(/hidden folders or files \("\.git"\)/);
      expect(refusal(() => planDownload("sub/.env", "x", f.roots))).toMatch(/hidden folders or files \("\.env"\)/);
      expect(refusal(() => planDownload("sub/", ".bashrc", { ...f.roots }))).toBe("no refusal"); // the suggested name loses its dots
      expect(refusal(() => planDownload("conf/settings.json", "x", f.roots))).toMatch(/can't be named settings\.json/);
      expect(refusal(() => planDownload("vendor-locked/a.txt", "x", f.roots))).toMatch(/sandbox's protected list/);
      const inHome = { ...f.roots, cwd: f.base };
      expect(refusal(() => planDownload("home/x.txt", "x", inHome))).toMatch(/inside Winter's own home/);
      expect(refusal(() => planDownload(42, "x", f.roots))).toMatch(/other: download\(\)'s to is a path/);
      expect(refusal(() => planDownload("a.txt", "x", { ...f.roots, cwd: undefined }))).toMatch(/no working directory/);
    } finally { f.done(); }
  });
});

describe("placeDownload", () => {
  test("copies into place, never over a file (report (2).csv), removes the staged copy, sets the quarantine attribute", () => {
    const f = fixture();
    try {
      const plan = planDownload(undefined, "report.csv", f.roots);
      const staged = f.stage("a,b\n1,2\n");
      const first = placeDownload(staged, plan, { expectedBytes: 8, tmpDir: f.tmpDir });
      expect(first).toEqual({ path: join(f.tmpDir, "downloads", "report.csv"), name: "report.csv", bytes: 8 });
      expect(readFileSync(first.path, "utf8")).toBe("a,b\n1,2\n");
      expect(existsSync(staged)).toBe(false);
      expect(statSync(first.path).mode & 0o777).toBe(0o644);
      const second = placeDownload(f.stage("x"), plan, { tmpDir: f.tmpDir });
      expect(second.name).toBe("report (2).csv");
      if (process.platform === "darwin") {
        const q = spawnSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", first.path], { encoding: "utf8" });
        expect(q.stdout.trim()).toMatch(/^0083;[0-9a-f]+;Winter;$/);
      }
      expect(quarantineValue(0x5f5e100 * 1000)).toBe("0083;5f5e100;Winter;");
    } finally { f.done(); }
  });

  test("a link anywhere on the way down is refused and nothing is written there", () => {
    const f = fixture();
    try {
      const outside = join(f.base, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(f.cwd, "data"));
      const plan = planDownload("data/a.txt", "x", f.roots);
      expect(refusal(() => placeDownload(f.stage("hi"), plan, { tmpDir: f.tmpDir }))).toMatch(/NotAllowed: the folder data is not a plain folder/);
      expect(existsSync(join(outside, "a.txt"))).toBe(false);
      // The session temp folder itself replaced by a link.
      symlinkSync(outside, f.tmpDir);
      const tmpPlan = planDownload(undefined, "b.txt", f.roots);
      expect(refusal(() => placeDownload(f.stage("hi"), tmpPlan, { tmpDir: f.tmpDir }))).toMatch(/temp folder is not a plain folder/);
      expect(existsSync(join(outside, "downloads"))).toBe(false);
    } finally { f.done(); }
  });

  test("a folder swapped for a link AFTER the walk changes nothing: the file lands in the folder that was checked", () => {
    const f = fixture();
    try {
      const outside = join(f.base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "report.csv"), "the user's own file");
      const plan = planDownload("sub/", "report.csv", f.roots);
      const placed = placeDownload(f.stage("downloaded"), plan, { tmpDir: f.tmpDir }, {
        afterWalk: () => { renameSync(join(f.cwd, "sub"), join(f.cwd, "sub.moved")); symlinkSync(outside, join(f.cwd, "sub")); },
      });
      expect(placed.name).toBe("report.csv");
      expect(readFileSync(join(f.cwd, "sub.moved", "report.csv"), "utf8")).toBe("downloaded");
      expect(readFileSync(join(outside, "report.csv"), "utf8")).toBe("the user's own file");
    } finally { f.done(); }
  });

  test("a failure after the file was created removes OUR entry from the checked folder — never a file the swap points at", () => {
    const f = fixture();
    try {
      const outside = join(f.base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "notes.md"), "keep me");
      const plan = planDownload("sub/", "notes.md", f.roots);
      expect(refusal(() => placeDownload(f.stage("x"), plan, { tmpDir: f.tmpDir }, {
        afterCreate: () => {
          renameSync(join(f.cwd, "sub"), join(f.cwd, "sub.moved"));
          symlinkSync(outside, join(f.cwd, "sub"));
          throw new Error("disk full");
        },
      }))).toBe("other: disk full");
      expect(readFileSync(join(outside, "notes.md"), "utf8")).toBe("keep me");
      expect(existsSync(join(f.cwd, "sub.moved", "notes.md"))).toBe(false);
    } finally { f.done(); }
  });

  test("an incomplete file is refused; the staging root is cleared per session and in all", () => {
    const f = fixture();
    try {
      const plan = planDownload(undefined, "x.bin", f.roots);
      expect(refusal(() => placeDownload(f.stage("abc"), plan, { expectedBytes: 10, tmpDir: f.tmpDir }))).toMatch(/other: the download is incomplete \(3 of 10 bytes\)/);
      expect(existsSync(join(f.tmpDir, "downloads", "x.bin"))).toBe(false);
      expect(existsSync(join(downloadStagingRoot(f.home), "s1"))).toBe(true);
      clearStagedDownloads(f.home, "s1");
      expect(existsSync(join(downloadStagingRoot(f.home), "s1"))).toBe(false);
      f.stage("y");
      clearStagedDownloads(f.home);
      expect(existsSync(downloadStagingRoot(f.home))).toBe(false);
    } finally { f.done(); }
  });
});
