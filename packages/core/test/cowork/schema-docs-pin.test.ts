import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_STATE_SCHEMA_VERSION } from "../../src/runtime-state/db";

// The schema version and the rollback range in the docs follow RUNTIME_STATE_SCHEMA_VERSION: a bump that forgets the docs fails here.
const root = join(import.meta.dir, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const v = RUNTIME_STATE_SCHEMA_VERSION;

test("the settings doc names the current schema version and the rollback range", () => {
  const doc = read("docs/claude/settings-and-migrations.md");
  expect(doc).toContain(`## Runtime-state schema v${v} and the way back`);
  expect(doc).toContain(`is at schema v${v} (\`RUNTIME_STATE_SCHEMA_VERSION\``);
  expect(doc).toContain(`accepts v8..v${v}`);
  expect(doc).toContain(`meets a v${v} store`);
});
test("the release note names the current schema version and the rollback range, and release.md points at it", () => {
  const note = read("docs/RELEASE-NOTES-cowork-schema.md");
  expect(note).toContain(`# Runtime-state schema v${v}`);
  expect(note).toContain(`moves to schema v${v}`);
  expect(note).toContain(`accepts v8 to v${v}`);
  expect(read("docs/claude/release.md")).toContain("docs/RELEASE-NOTES-cowork-schema.md");
});
