import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { durableCoworkTransaction } from "../../src/cowork/durable-transaction";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function fixture() { const home = mkdtempSync(join(tmpdir(), "winter-cowork-durable-tx-")); cleanups.push(() => rmSync(home, { force: true, recursive: true })); const rs = openRuntimeStateDb(home); cleanups.push(() => rs.close()); return rs; }
function settings(rs: RuntimeStateDb) { return ["synchronous", "fullfsync", "checkpoint_fullfsync"].map(name => rs.db.query<Record<string, number>, []>(`PRAGMA main.${name}`).get()![name]); }
test("actual SQLite Cowork write configures FULL/fullfsync only for the commit and restores Code settings", () => {
 const rs = fixture(), before = settings(rs);
 expect(durableCoworkTransaction(rs, () => { expect(settings(rs)).toEqual([2, 1, 1]); rs.db.run("INSERT INTO schema_meta VALUES('durable-proof','yes')"); return "receipt"; })).toBe("receipt");
 expect(settings(rs)).toEqual(before); expect(rs.db.query("SELECT value FROM schema_meta WHERE key='durable-proof'").get()).toEqual({ value: "yes" });
});
test("throw and Promise-return roll back actual SQL and restore prior settings", () => {
 const rs = fixture(), before = settings(rs);
 expect(() => durableCoworkTransaction(rs, () => { rs.db.run("INSERT INTO schema_meta VALUES('refused','yes')"); throw new Error("fault"); })).toThrow("fault");
 expect(settings(rs)).toEqual(before); expect(rs.db.query("SELECT value FROM schema_meta WHERE key='refused'").get()).toBeNull();
 expect(() => durableCoworkTransaction(rs, () => { rs.db.run("INSERT INTO schema_meta VALUES('async-refused','yes')"); return Promise.resolve(); })).toThrow("authority_denied");
 expect(settings(rs)).toEqual(before); expect(rs.db.query("SELECT value FROM schema_meta WHERE key='async-refused'").get()).toBeNull();
});
test("caller transaction refuses before settings or authority changes", () => {
 const rs = fixture(), before = settings(rs);
 rs.transaction(() => { expect(() => durableCoworkTransaction(rs, () => {})).toThrow("authority_denied"); expect(settings(rs)).toEqual(before); }); expect(settings(rs)).toEqual(before);
});
