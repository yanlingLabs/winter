// Winter Phase 9c, Lane S — the WS-17 §8 conformance sign-off.
//
// `packages/core/conformance/ws17-rows.json` is the in-repo row matrix: one entry per WS-17 §8
// obligation (1..18), each carrying a `status` and one or more `citations`. This is the
// "cite-or-cover" gate the release depends on: every row must EITHER
//   (a) CITE something machine-checkable — a `winter` citation is verified HERE (the file exists
//       under the repo root and literally contains the quoted substring), while a `router`/`sdk`
//       citation (the SDK/router repos are siblings, not a workspace member, so their content
//       cannot be read from here) is only format-checked here and is verified once by the
//       controller against the sibling checkout at the named tag (recorded in the sign-off
//       report) — or
//   (b) COVER the gap explicitly — `status: "carried"` or `"unproven"` with a non-empty `note`
//       naming what is missing and why, rather than a silently-stale claim.
//
// This is deliberately a TEST, not a document: a citation that stops matching (a renamed test, a
// deleted file) fails HERE, the same reasoning the router's own `test/conformance/rows.test.ts`
// gives for the identical shape (R-7b-7). Never loosen `contains`'s minimum length — a citation
// pinned to a 3-character substring proves nothing and would rot silently.
//
// HERMETIC: reads two files under the repository (this file's own JSON fixture, plus whatever
// `winter` citations name) and writes nothing. No server, no runtime, no `~/.winter*`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ROWS_PATH = join(import.meta.dir, "..", "..", "conformance", "ws17-rows.json");

const MIN_CONTAINS_LENGTH = 12;
const STATUSES = ["proven", "partial", "unproven", "carried"] as const;
const REPOS = ["winter", "router", "sdk"] as const;

type Status = (typeof STATUSES)[number];
type Repo = (typeof REPOS)[number];

interface Citation {
  repo: Repo;
  tag?: string;
  file: string;
  contains: string;
}

interface Row {
  row: number;
  title: string;
  status: Status;
  citations: Citation[];
  note: string;
}

function loadRows(): Row[] {
  const raw = readFileSync(ROWS_PATH, "utf8");
  const parsed = JSON.parse(raw) as { rows: Row[] };
  return parsed.rows;
}

describe("WS-17 §8 sign-off matrix (ws17-rows.json)", () => {
  const rows = loadRows();

  test("the row set is exactly 1..18, once each", () => {
    const numbers = rows.map((r) => r.row).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  test("every row has a non-empty title and a recognized status", () => {
    for (const row of rows) {
      expect(row.title.trim().length).toBeGreaterThan(0);
      expect(STATUSES).toContain(row.status);
    }
  });

  test("every row cites something OR covers the gap with a note (cite-or-cover)", () => {
    for (const row of rows) {
      if (row.status === "proven" || row.status === "partial") {
        // CITE: proven/partial claims must point at machine-checkable evidence.
        expect(row.citations.length, `row ${row.row} (${row.status}) has no citations`).toBeGreaterThan(0);
      }
      if (row.status === "partial" || row.status === "carried") {
        // COVER: a gap or a standing obligation must be named, never left silent.
        expect(row.note.trim().length, `row ${row.row} (${row.status}) has an empty note`).toBeGreaterThan(0);
      }
    }
  });

  test("every citation names a recognized repo", () => {
    for (const row of rows) {
      for (const citation of row.citations) {
        expect(REPOS, `row ${row.row} citation has an unrecognized repo`).toContain(citation.repo);
      }
    }
  });

  test("every `winter` citation's file exists and literally contains its `contains` substring (min 12 chars)", () => {
    for (const row of rows) {
      for (const citation of row.citations) {
        if (citation.repo !== "winter") continue;
        expect(
          citation.contains.length,
          `row ${row.row} citation into ${citation.file} has too short a 'contains' (${citation.contains.length} < ${MIN_CONTAINS_LENGTH})`,
        ).toBeGreaterThanOrEqual(MIN_CONTAINS_LENGTH);

        const absolute = join(REPO_ROOT, citation.file);
        expect(existsSync(absolute), `row ${row.row} citation file does not exist: ${citation.file}`).toBe(true);

        const contents = readFileSync(absolute, "utf8");
        expect(
          contents.includes(citation.contains),
          `row ${row.row} citation file ${citation.file} does not contain: ${JSON.stringify(citation.contains)}`,
        ).toBe(true);
      }
    }
  });

  test("every `router`/`sdk` citation carries a tag and a relative file path (content verified by the controller against the sibling checkout)", () => {
    for (const row of rows) {
      for (const citation of row.citations) {
        if (citation.repo !== "router" && citation.repo !== "sdk") continue;
        expect(citation.tag, `row ${row.row} citation into ${citation.repo}:${citation.file} has no tag`).toBeTruthy();
        expect(citation.tag?.trim().length ?? 0, `row ${row.row} citation tag is empty`).toBeGreaterThan(0);
        expect(citation.file.trim().length, `row ${row.row} citation file is empty`).toBeGreaterThan(0);
        expect(citation.file.startsWith("/"), `row ${row.row} citation file must be relative, not absolute: ${citation.file}`).toBe(false);
        expect(citation.file.includes(".."), `row ${row.row} citation file must not traverse out of the repo: ${citation.file}`).toBe(false);
      }
    }
  });
});
