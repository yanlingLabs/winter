// WS-25 (security review M4): `check-cimd-live.ts`'s comparison, offline. The live fetch itself runs only
// from `.github/workflows/cimd-live.yml` (scheduled / on demand), never in ordinary CI.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CIMD_SOURCE, CIMD_URL, cimdProblems } from "./check-cimd-live";

const committed = JSON.parse(readFileSync(CIMD_SOURCE, "utf8")) as Record<string, unknown>;

describe("check-cimd-live", () => {
  test("the committed document's client_id is the URL it is served from", () => {
    expect(committed.client_id).toBe(CIMD_URL);
    expect(cimdProblems(structuredClone(committed), committed)).toEqual([]);
  });

  test("a live document that differs anywhere is named by key", () => {
    const live = { ...committed, redirect_uris: ["http://127.0.0.1/callback", "https://attacker.example/cb"] };
    expect(cimdProblems(live, committed)).toEqual(["the live document differs from the committed one at: redirect_uris"]);
    const { client_uri: _dropped, ...missing } = committed;
    expect(cimdProblems(missing, committed)).toEqual(["the live document differs from the committed one at: client_uri"]);
  });

  test("a live client_id other than the URL is refused on its own", () => {
    const problems = cimdProblems({ ...committed, client_id: "https://elsewhere.example/c.json" }, committed);
    expect(problems[0]).toContain("the live document's client_id");
    expect(problems).toHaveLength(2);
  });

  test("non-object documents are problems, never a throw", () => {
    expect(cimdProblems("nope", committed)).toEqual(["the live document is not a JSON object"]);
    expect(cimdProblems(committed, null)).toEqual(["the committed document is not a JSON object"]);
  });
});
