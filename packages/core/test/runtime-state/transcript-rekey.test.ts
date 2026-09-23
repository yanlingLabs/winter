// WS-21 round 3 (Important): a session made before the canonical cwd keeps its transcript under the RAW
// cwd's key, while both legs now look it up under the realpath's. `moveTranscriptFiles` carries one
// session's files (the transcript, every `<id>.*` sidecar, the `<id>/` subagent dir) from the recorded key
// to the canonical one — never overwriting anything, the transcript itself last so a crash mid-move is
// finished by simply running it again. Plus the records writer both callers share.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveTranscriptFiles } from "../../src/runtime-state/transcript-rekey";
import { openRuntimeStateDb, RuntimeSessionRecords, type NewRuntimeSessionRecord } from "../../src/runtime-state";

const ID = "0f6f3f0e-1111-4222-8333-444455556666";
const write = (p: string, body: string): void => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };

function store() {
  const projects = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-rekey-"))), "projects");
  mkdirSync(projects);
  return projects;
}

describe("moveTranscriptFiles", () => {
  test("moves the transcript, every sidecar and the subagent dir; another session's files stay", () => {
    const projects = store();
    write(join(projects, "-tmp-app", `${ID}.jsonl`), '{"type":"user","uuid":"u1"}\n');
    write(join(projects, "-tmp-app", `${ID}.provider-state.jsonl`), "{}\n");
    write(join(projects, "-tmp-app", `${ID}.summary.json`), "{}");
    write(join(projects, "-tmp-app", ID, "subagents", "agent-a.jsonl"), "{}\n");
    write(join(projects, "-tmp-app", "other-session.jsonl"), "{}\n");
    write(join(projects, "-tmp-app", "memory", "MEMORY.md"), "- x\n");
    const r = moveTranscriptFiles(projects, ID, "-tmp-app", "-private-tmp-app");
    expect(r.kind).toBe("moved");
    expect(r.kind === "moved" && [...r.entries].sort()).toEqual([ID, `${ID}.jsonl`, `${ID}.provider-state.jsonl`, `${ID}.summary.json`].sort());
    expect(r.kind === "moved" && r.entries[r.entries.length - 1]).toBe(`${ID}.jsonl`); // the transcript LAST
    expect(readFileSync(join(projects, "-private-tmp-app", `${ID}.jsonl`), "utf8")).toContain("u1");
    expect(existsSync(join(projects, "-private-tmp-app", ID, "subagents", "agent-a.jsonl"))).toBe(true);
    expect(existsSync(join(projects, "-tmp-app", `${ID}.jsonl`))).toBe(false);
    expect(existsSync(join(projects, "-tmp-app", "other-session.jsonl"))).toBe(true);
    expect(existsSync(join(projects, "-tmp-app", "memory", "MEMORY.md"))).toBe(true);
  });

  test("the same key, or nothing at the old key, is no move", () => {
    const projects = store();
    expect(moveTranscriptFiles(projects, ID, "-a", "-a")).toEqual({ kind: "not-needed" });
    expect(moveTranscriptFiles(projects, ID, "-a", "-b")).toEqual({ kind: "moved", entries: [] });
  });

  test("a collision (the canonical key already holds one of the names) moves NOTHING", () => {
    const projects = store();
    write(join(projects, "-tmp-app", `${ID}.jsonl`), "old\n");
    write(join(projects, "-tmp-app", `${ID}.provider-state.jsonl`), "old\n");
    write(join(projects, "-private-tmp-app", `${ID}.jsonl`), "new\n");
    const r = moveTranscriptFiles(projects, ID, "-tmp-app", "-private-tmp-app");
    expect(r).toEqual({ kind: "collision", entries: [`${ID}.jsonl`] });
    expect(readFileSync(join(projects, "-tmp-app", `${ID}.jsonl`), "utf8")).toBe("old\n");
    expect(readFileSync(join(projects, "-private-tmp-app", `${ID}.jsonl`), "utf8")).toBe("new\n");
    expect(existsSync(join(projects, "-tmp-app", `${ID}.provider-state.jsonl`))).toBe(true); // not even a sidecar
  });

  test("a crash mid-move is finished by running it again (what already moved is no collision)", () => {
    const projects = store();
    write(join(projects, "-tmp-app", `${ID}.jsonl`), "t\n");
    write(join(projects, "-private-tmp-app", `${ID}.provider-state.jsonl`), "moved before the crash\n"); // the sidecar went first
    const r = moveTranscriptFiles(projects, ID, "-tmp-app", "-private-tmp-app");
    expect(r).toEqual({ kind: "moved", entries: [`${ID}.jsonl`] });
    expect(existsSync(join(projects, "-private-tmp-app", `${ID}.jsonl`))).toBe(true);
  });

  test("never through a link: a key dir that is a symbolic link refuses, nothing moved", () => {
    const projects = store();
    write(join(projects, "-tmp-app", `${ID}.jsonl`), "t\n");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "winter-rekey-elsewhere-")));
    symlinkSync(elsewhere, join(projects, "-private-tmp-app"));
    const r = moveTranscriptFiles(projects, ID, "-tmp-app", "-private-tmp-app");
    expect(r.kind).toBe("refused");
    expect(existsSync(join(projects, "-tmp-app", `${ID}.jsonl`))).toBe(true);
    expect(existsSync(join(elsewhere, `${ID}.jsonl`))).toBe(false);
  });
});

describe("RuntimeSessionRecords.rekeyTranscript", () => {
  test("re-points the key and the backend root, guarded by the key it expects", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-rekey-rs-")));
    const rs = openRuntimeStateDb(home);
    try {
      const records = new RuntimeSessionRecords(rs);
      const rec: NewRuntimeSessionRecord = {
        winterSessionId: "s_1", runtimeKind: "winter-agent", backendSessionId: ID, providerId: "openai", modelRef: "openai/gpt-5.6-sol",
        backendRoot: "/h/sdk/projects/-tmp-app", transcriptProjectKey: "-tmp-app", memoryProjectKey: "-tmp-app", tempProjectKey: "-tmp-app",
        transcriptHealth: "clean", compatibilityLevel: "conversation", conformanceCorpusVersion: "c", versionProvenance: "recorded",
        sdkVersion: "0", engineVersion: "0", providerCatalogVersion: "0", providerAdapterVersion: "0", capabilities: [],
        selection: { runtimeKind: "winter-agent", providerId: "openai", modelRef: "openai/gpt-5.6-sol", family: "openai", authFamily: "api-key", sdkVersion: "0", reason: "t", decidedAt: new Date(0).toISOString() },
      };
      records.create(rec);
      expect(records.rekeyTranscript("s_1", "-other", "-private-tmp-app", "/h/sdk/projects/-private-tmp-app")).toBe(false);
      expect(records.get("s_1")!.transcriptProjectKey).toBe("-tmp-app");
      expect(records.rekeyTranscript("s_1", "-tmp-app", "-private-tmp-app", "/h/sdk/projects/-private-tmp-app")).toBe(true);
      const r = records.get("s_1")!;
      expect([r.transcriptProjectKey, r.backendRoot]).toEqual(["-private-tmp-app", "/h/sdk/projects/-private-tmp-app"]);
    } finally { rs.close(); }
  });
});
