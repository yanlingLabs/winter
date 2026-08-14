import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFF_ID_RE, DIFF_PATCH_MAX_BYTES, mintDiffId, diffDirPath, writeDiff, readStoredDiff, removeSessionDiffs } from "../../src/diffs/store";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "norma-diff-store-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const SID = "sess_abc123";

describe("diff store", () => {
  test("mintDiffId matches the wire regex and is unique", () => {
    const a = mintDiffId(), b = mintDiffId();
    expect(a).toMatch(DIFF_ID_RE); expect(b).toMatch(DIFF_ID_RE); expect(a).not.toBe(b);
  });
  test("write/read round-trip preserves header and patch bytes", async () => {
    const id = mintDiffId();
    const patch = "@@ -1,1 +1,1 @@\n-a\n+b\n";
    const r = await writeDiff(home, SID, id, { path: "/tmp/x.swift", added: 1, removed: 1 }, patch);
    expect(r.truncated).toBe(false);
    const got = await readStoredDiff(home, SID, id);
    expect(got!.header).toEqual({ path: "/tmp/x.swift", added: 1, removed: 1, truncated: false });
    expect(got!.patch).toBe(patch);
  });
  test("oversized patch truncates at a hunk boundary with the marker", async () => {
    const hunk = "@@ -1,1 +1,1 @@\n-" + "x".repeat(600_000) + "\n+" + "y".repeat(600_000) + "\n";
    const patch = hunk + hunk; // ~2.4 MB, two hunks
    const id = mintDiffId();
    const r = await writeDiff(home, SID, id, { path: "/p", added: 2, removed: 2 }, patch);
    expect(r.truncated).toBe(true);
    const got = await readStoredDiff(home, SID, id);
    expect(got!.header.truncated).toBe(true);
    expect(got!.patch.endsWith("[patch truncated]\n")).toBe(true);
    expect(Buffer.byteLength(got!.patch, "utf8")).toBeLessThanOrEqual(DIFF_PATCH_MAX_BYTES + 64);
    expect(got!.patch.startsWith("@@ ")).toBe(true); // still opens with a parseable hunk
  });
  test("id shapes are enforced before any path is built", async () => {
    await expect(writeDiff(home, "../evil", mintDiffId(), { path: "/p", added: 0, removed: 0 }, "")).rejects.toThrow();
    await expect(writeDiff(home, SID, "../../etc/passwd", { path: "/p", added: 0, removed: 0 }, "")).rejects.toThrow();
    expect(await readStoredDiff(home, SID, "../../etc/passwd")).toBeNull();
    expect(await readStoredDiff(home, "..", "ok_id")).toBeNull();
  });
  test("missing diff reads as null", async () => {
    expect(await readStoredDiff(home, SID, mintDiffId())).toBeNull();
  });
  test("removeSessionDiffs deletes the whole session dir and tolerates absence", async () => {
    const id = mintDiffId();
    await writeDiff(home, SID, id, { path: "/p", added: 0, removed: 0 }, "");
    expect(existsSync(diffDirPath(home, SID))).toBe(true);
    await removeSessionDiffs(home, SID);
    expect(existsSync(diffDirPath(home, SID))).toBe(false);
    await removeSessionDiffs(home, SID); // second call: no throw
  });
});
