import { describe, expect, test } from "bun:test";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { ChildAlreadyTerminalError, RuntimeChildren, type PersistedWinterChild } from "../../src/runtime-state/children";
import { withTempHome } from "./support";

const PARENT = "s_parent";

const child = (over: Partial<PersistedWinterChild> = {}): PersistedWinterChild => ({
  parentWinterSessionId: PARENT,
  childId: "c_1",
  agentType: "explore",
  providerId: "openai",
  modelRef: "gpt-5.6-sol",
  providerCatalogVersion: "0.0.2",
  providerAdapterVersion: "0.0.2",
  status: "running",
  transcriptRef: "subagents/agent-c_1/transcript.jsonl",
  startedAt: "2026-09-10T00:00:00.000Z",
  generation: 1,
  ...over,
});

const use = (home: string, fn: (rs: RuntimeStateDb, children: RuntimeChildren) => void): void => {
  const rs = openRuntimeStateDb(home);
  try {
    fn(rs, new RuntimeChildren(rs));
  } finally {
    rs.close();
  }
};

describe("RuntimeChildren", () => {
  test("upsert round-trips every field, including the slot and permission blobs", () =>
    withTempHome((home) =>
      use(home, (_rs, children) => {
        const full = child({
          name: "explorer",
          connectionRef: "conn_1",
          resumeContextRef: "subagents/agent-c_1/resume.json",
          worktreeRef: "/tmp/wt/c_1",
          requestedModel: "sol",
          effectiveModel: "gpt-5.6-sol",
          effectiveProvider: "openai",
          slot: { family: "openai", name: "Sol", source: "inherited" },
          permission: { effectiveMode: "ask", parentPolicyHash: "abc123" },
        });
        children.upsert(full);
        expect(children.get(PARENT, "c_1")).toEqual(full);
        expect(children.get(PARENT, "c_missing")).toBeUndefined();
        expect(children.get("s_other", "c_1")).toBeUndefined();

        // the optional halves stay absent rather than becoming nulls
        children.upsert(child({ childId: "c_bare" }));
        const bare = children.get(PARENT, "c_bare");
        expect(bare?.slot).toBeUndefined();
        expect(bare?.permission).toBeUndefined();
        expect(bare?.completedAt).toBeUndefined();
        expect(bare?.resumeContextRef).toBeUndefined();
      })));

  test("upsert replaces the same (parent, childId) rather than duplicating it", () =>
    withTempHome((home) =>
      use(home, (rs, children) => {
        children.upsert(child({ name: "first" }));
        children.upsert(child({ name: "second", status: "completed", completedAt: "2026-09-10T00:05:00.000Z" }));
        expect(rs.db.query("SELECT count(*) AS n FROM runtime_children").get()).toEqual({ n: 1 });
        expect(children.get(PARENT, "c_1")?.name).toBe("second");
        expect(children.get(PARENT, "c_1")?.status).toBe("completed");
        expect(children.get(PARENT, "c_1")?.completedAt).toBe("2026-09-10T00:05:00.000Z");
      })));

  test("list is per parent and filters by status", () =>
    withTempHome((home) =>
      use(home, (_rs, children) => {
        children.upsert(child({ childId: "c_run" }));
        children.upsert(child({ childId: "c_done", status: "completed", startedAt: "2026-09-10T00:01:00.000Z" }));
        children.upsert(child({ childId: "c_fail", status: "failed", startedAt: "2026-09-10T00:02:00.000Z" }));
        children.upsert(child({ childId: "c_other", parentWinterSessionId: "s_second" }));

        expect(children.list(PARENT).map((c) => c.childId)).toEqual(["c_run", "c_done", "c_fail"]);
        expect(children.list("s_second").map((c) => c.childId)).toEqual(["c_other"]);
        expect(children.list(PARENT, { status: "running" }).map((c) => c.childId)).toEqual(["c_run"]);
        expect(children.list(PARENT, { status: ["completed", "failed"] }).map((c) => c.childId)).toEqual(["c_done", "c_fail"]);
        expect(children.list(PARENT, { status: "timeout" })).toEqual([]);
        expect(children.list("s_nobody")).toEqual([]);
      })));

  test("setStatus stamps completedAt for a terminal status and leaves it alone otherwise", () =>
    withTempHome((home) =>
      use(home, (rs) => {
        const children = new RuntimeChildren(rs, () => "2026-09-10T12:00:00.000Z");
        children.upsert(child());
        children.setStatus(PARENT, "c_1", "interrupted");
        expect(children.get(PARENT, "c_1")?.status).toBe("interrupted");
        expect(children.get(PARENT, "c_1")?.completedAt).toBeUndefined();

        children.setStatus(PARENT, "c_1", "completed");
        expect(children.get(PARENT, "c_1")?.completedAt).toBe("2026-09-10T12:00:00.000Z");

        children.upsert(child({ childId: "c_2" }));
        children.setStatus(PARENT, "c_2", "timeout", "2026-09-10T09:00:00.000Z");
        expect(children.get(PARENT, "c_2")?.completedAt).toBe("2026-09-10T09:00:00.000Z");
        // an unknown child is a no-op, never an invented row
        children.setStatus(PARENT, "c_ghost", "failed");
        expect(children.get(PARENT, "c_ghost")).toBeUndefined();
      })));

  test("reclassifyAfterRestart interrupts only running children whose process is proven gone", () =>
    withTempHome((home) =>
      use(home, (_rs, children) => {
        children.upsert(child({ childId: "c_run" }));
        children.upsert(child({ childId: "c_run2", parentWinterSessionId: "s_second" }));
        children.upsert(child({ childId: "c_done", status: "completed", completedAt: "2026-09-10T00:05:00.000Z" }));
        children.upsert(child({ childId: "c_stopped", status: "stopped" }));

        const kept = children.reclassifyAfterRestart(() => false);
        expect(kept.interrupted).toEqual([]);
        // {parent, childId} pairs, not bare ids: two parents may mint the same childId
        expect(kept.kept).toEqual([
          { parent: PARENT, childId: "c_run" },
          { parent: "s_second", childId: "c_run2" },
        ]);
        expect(children.get(PARENT, "c_run")?.status).toBe("running");

        const gone = children.reclassifyAfterRestart(() => true);
        expect(gone.interrupted).toEqual([
          { parent: PARENT, childId: "c_run" },
          { parent: "s_second", childId: "c_run2" },
        ]);
        expect(gone.kept).toEqual([]);
        expect(children.get(PARENT, "c_run")?.status).toBe("interrupted");
        expect(children.get("s_second", "c_run2")?.status).toBe("interrupted");
        // WS-16 §12: everything already finished is evidence, not state to rewrite
        expect(children.get(PARENT, "c_done")?.status).toBe("completed");
        expect(children.get(PARENT, "c_done")?.completedAt).toBe("2026-09-10T00:05:00.000Z");
        expect(children.get(PARENT, "c_stopped")?.status).toBe("stopped");
        // a second restart has nothing left to reclassify
        expect(children.reclassifyAfterRestart(() => true)).toEqual({ interrupted: [], kept: [] });
      })));

  test("the predicate sees the whole child, so two parents' same-named children are told apart", () =>
    withTempHome((home) =>
      use(home, (_rs, children) => {
        // The same childId under two parents — the case a bare-id result could not describe.
        children.upsert(child({ childId: "c_same", worktreeRef: "/tmp/wt/a" }));
        children.upsert(child({ childId: "c_same", parentWinterSessionId: "s_second" }));
        const seen: string[] = [];
        const out = children.reclassifyAfterRestart((c) => {
          seen.push(`${c.parentWinterSessionId}/${c.childId}`);
          return c.worktreeRef !== undefined;
        });
        expect(seen.sort()).toEqual(["s_parent/c_same", "s_second/c_same"]);
        expect(out.interrupted).toEqual([{ parent: PARENT, childId: "c_same" }]);
        expect(out.kept).toEqual([{ parent: "s_second", childId: "c_same" }]);
        expect(children.get(PARENT, "c_same")?.status).toBe("interrupted");
        expect(children.get("s_second", "c_same")?.status).toBe("running");
      })));

  test("a child that already finished is never resurrected by an upsert", () =>
    withTempHome((home) =>
      use(home, (_rs, children) => {
        children.upsert(child({ status: "completed", completedAt: "2026-09-10T00:05:00.000Z" }));
        let caught: unknown;
        try {
          children.upsert(child({ status: "running" }));
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ChildAlreadyTerminalError);
        expect((caught as ChildAlreadyTerminalError).status).toBe("completed");
        expect((caught as ChildAlreadyTerminalError).childId).toBe("c_1");
        // the row kept its outcome AND its completedAt
        expect(children.get(PARENT, "c_1")?.status).toBe("completed");
        expect(children.get(PARENT, "c_1")?.completedAt).toBe("2026-09-10T00:05:00.000Z");
        expect(() => children.upsert(child({ status: "interrupted" }))).toThrow(ChildAlreadyTerminalError);
        // one terminal outcome may still correct another (nothing is being resurrected)
        children.upsert(child({ status: "failed", completedAt: "2026-09-10T00:06:00.000Z" }));
        expect(children.get(PARENT, "c_1")?.status).toBe("failed");
      })));

  test("a damaged slot/permission blob costs that field, never the row", () =>
    withTempHome((home) =>
      use(home, (rs, children) => {
        children.upsert(child({ slot: { family: "openai", name: "Sol", source: "inherited" }, permission: { effectiveMode: "ask", parentPolicyHash: "abc" } }));
        children.upsert(child({ childId: "c_2" }));
        rs.db.run("UPDATE runtime_children SET slot_json = ?, permission_json = ? WHERE child_id = 'c_1'", ["{not json", "also not json"]);

        // Review r1 (Important 1): slot/permission are DESCRIPTIVE. A row that cannot describe its
        // slot still knows whether it was running — and `reclassifyAfterRestart` maps every running
        // child in ONE transaction, so a throw here used to mean no child anywhere was reclassified.
        const damaged = children.get(PARENT, "c_1")!;
        expect(damaged.slot).toBeUndefined();
        expect(damaged.permission).toBeUndefined();
        expect(damaged.status).toBe("running");
        expect(children.reclassifyAfterRestart(() => true).interrupted).toEqual([
          { parent: PARENT, childId: "c_1" },
          { parent: PARENT, childId: "c_2" },
        ]);
      })));

  test("reclassifyAfterRestart can be scoped to one parent", () =>
    withTempHome((home) =>
      use(home, (_rs, children) => {
        children.upsert(child());
        children.upsert(child({ parentWinterSessionId: "s_other", childId: "c_2" }));

        const scoped = children.reclassifyAfterRestart(() => true, { parent: PARENT });

        expect(scoped.interrupted).toEqual([{ parent: PARENT, childId: "c_1" }]);
        expect(children.get("s_other", "c_2")?.status).toBe("running");
      })));

  test("resumeContextRef is a locator, never a closure", () =>
    withTempHome((home) =>
      use(home, (rs, children) => {
        expect(() => children.upsert({ ...child(), resumeContextRef: (() => {}) as unknown as string })).toThrow(TypeError);
        expect(rs.db.query("SELECT count(*) AS n FROM runtime_children").get()).toEqual({ n: 0 });
        children.upsert(child({ resumeContextRef: "subagents/agent-c_1/resume.json" }));
        expect(rs.db.query("SELECT resume_context_ref AS r FROM runtime_children").get()).toEqual({ r: "subagents/agent-c_1/resume.json" });
      })));
});
