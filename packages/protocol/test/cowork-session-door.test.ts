import { describe, expect, test } from "bun:test";
import {
  CoworkRelativeCwd,
  CoworkSessionCreate,
  CoworkSessionCreatedFacts,
  CoworkSessionLocation,
  CoworkSessionRef,
  SessionCreateParams,
  SessionCreatedEvent,
  SessionEvent,
  SessionListResult,
} from "../src";

// Cowork session door (D1 spine): the wire fields a Cowork conversation is created with, announced with and listed
// with. Additive and optional everywhere; nothing produces them yet (core's session.create refuses every Cowork request
// until a door exists: packages/core/test/cowork/session-door-off.test.ts).
describe("the Cowork session binding on the wire", () => {
  test("a relative cwd is relative, inside its root and plain: no leading slash, no .. component, no backslash or NUL", () => {
    for (const ok of [".", "repo", "repo/sub", "a.b/c..d", "..hidden", "x".repeat(4096)]) expect([ok, CoworkRelativeCwd.safeParse(ok).success]).toEqual([ok, true]);
    for (const bad of ["", "/", "/etc", "..", "../x", "a/../b", "a/..", "a\\b", "a\0b", "x".repeat(4097)]) expect([bad, CoworkRelativeCwd.safeParse(bad).success]).toEqual([bad, false]);
  });

  test("a location is a source (with an optional relative cwd) or the outputs location, nothing else, no extra keys", () => {
    expect(CoworkSessionLocation.parse({ kind: "source", sourceId: "src_one" })).toEqual({ kind: "source", sourceId: "src_one" });
    expect(CoworkSessionLocation.parse({ kind: "source", sourceId: "src_one", relativeCwd: "repo" })).toEqual({ kind: "source", sourceId: "src_one", relativeCwd: "repo" });
    expect(CoworkSessionLocation.parse({ kind: "outputs" })).toEqual({ kind: "outputs" });
    for (const bad of [{ kind: "outputs", sourceId: "src_one" }, { kind: "outputs", relativeCwd: "." }, { kind: "source" }, { kind: "source", sourceId: "" },
      { kind: "source", sourceId: "src_one", path: "/x" }, { kind: "folder", sourceId: "src_one" }, {}, null, "outputs"]) {
      expect([bad, CoworkSessionLocation.safeParse(bad).success]).toEqual([bad, false]);
    }
  });

  test("the create binding carries the workspace, the location and the request id, strictly", () => {
    const binding = { workspaceId: "w_one", location: { kind: "outputs" as const }, requestId: "req_one" };
    expect(CoworkSessionCreate.parse(binding)).toEqual(binding);
    for (const key of ["workspaceId", "location", "requestId"] as const) { const { [key]: _, ...missing } = binding; expect([key, CoworkSessionCreate.safeParse(missing).success]).toEqual([key, false]); }
    for (const extra of [{ cwd: "/" }, { approvalPolicy: "bypass" }, { model: "x/y" }, { sessionId: "s_x" }]) expect([extra, CoworkSessionCreate.safeParse({ ...binding, ...extra }).success]).toEqual([extra, false]);
  });

  test("session.create carries the binding as an OPTIONAL field: absent stays absent, present is validated", () => {
    expect("cowork" in SessionCreateParams.parse({ scope: "global", mode: "cowork" })).toBe(false);
    const cowork = { workspaceId: "w_one", location: { kind: "source" as const, sourceId: "src_one", relativeCwd: "repo" }, requestId: "req_one" };
    expect(SessionCreateParams.parse({ scope: "global", mode: "cowork", cowork }).cowork).toEqual(cowork);
    // Not a refinement: the schema does not tie the binding to the mode (the daemon refuses the mismatch, typed).
    expect(SessionCreateParams.parse({ scope: "global", cowork }).cowork).toEqual(cowork);
    expect(SessionCreateParams.safeParse({ scope: "global", mode: "cowork", cowork: { ...cowork, location: { kind: "source", sourceId: "src_one", relativeCwd: "/abs" } } }).success).toBe(false);
  });

  test("session_created's cowork facts: source id present exactly for a source location, nullable project, positive policy revision", () => {
    const outputs = { workspaceId: "w_one", projectId: null, location: "outputs" as const, sourceId: null, policyRevision: 1 };
    const source = { workspaceId: "w_one", projectId: "p_one", location: "source" as const, sourceId: "src_one", policyRevision: 3 };
    expect(CoworkSessionCreatedFacts.parse(outputs)).toEqual(outputs);
    expect(CoworkSessionCreatedFacts.parse(source)).toEqual(source);
    for (const bad of [{ ...outputs, sourceId: "src_one" }, { ...source, sourceId: null }, { ...outputs, location: "folder" }, { ...outputs, policyRevision: 0 },
      { ...outputs, extra: true }, (({ projectId: _, ...rest }) => rest)(outputs), (({ sourceId: _, ...rest }) => rest)(outputs)]) {
      expect([bad, CoworkSessionCreatedFacts.safeParse(bad).success]).toEqual([bad, false]);
    }
  });

  test("session_created round-trips its cowork facts through the event union, and stays valid without them", () => {
    const wire = { seq: 1, sessionId: "s_fixture", ts: 1781270000000, type: "session_created", scope: "global", mode: "cowork",
      cowork: { workspaceId: "w_one", projectId: null, location: "outputs" as const, sourceId: null, policyRevision: 1 } };
    expect(SessionCreatedEvent.parse(wire).cowork).toEqual(wire.cowork);
    expect(JSON.parse(JSON.stringify(SessionEvent.parse(wire)))).toEqual(wire);
    const { cowork: _, ...bare } = wire;
    expect("cowork" in SessionCreatedEvent.parse(bare)).toBe(false);
    expect(SessionEvent.safeParse({ ...wire, cowork: { ...wire.cowork, sourceId: "src_one" } }).success).toBe(false);
  });

  test("a session.list row may carry a Cowork reference (workspace, nullable Project) and nothing else", () => {
    const row = { sessionId: "s_fixture", scope: "global", createdAt: 1, lastSeq: 1, mode: "cowork", cowork: { workspaceId: "w_one", projectId: null } };
    expect(SessionListResult.parse({ sessions: [row] }).sessions[0]!.cowork).toEqual({ workspaceId: "w_one", projectId: null });
    expect(CoworkSessionRef.safeParse({ workspaceId: "w_one", projectId: null, root: "/workspace/x" }).success).toBe(false);
    expect(CoworkSessionRef.safeParse({ workspaceId: "w_one" }).success).toBe(false);
    const { cowork: _, ...plain } = row;
    expect("cowork" in SessionListResult.parse({ sessions: [plain] }).sessions[0]!).toBe(false);
  });
});
