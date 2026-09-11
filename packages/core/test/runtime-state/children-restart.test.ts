// P8b Task 13 — the persisted roster, across a daemon restart (WS-17 §8 row 6).
//
// THE PROOF ROW, stated as a test: "Winter child identity + `ResumeContext` reconstructed after
// daemon restart". `BackgroundAgentRegistry` was one `Map`, so a restart lost the names a model was
// still using, which children had finished, and every `ResumeContext` that made `resume` possible.
// A "restart" here is a SECOND registry built over the same temp home — no shared object, nothing
// carried in memory, exactly what a new daemon process gets.
//
// The `BackgroundAgentRegistry` semantics tests below are COPIED from `bg-agent-registry.test.ts`,
// deliberately: the persisted registry is a different implementation of one contract, and the only
// honest way to say "the semantics survive" is to re-run the cases that define them.
import { describe, expect, test } from "bun:test";
import {
  CHILD_STALL_TIMEOUT_MS,
  checkNameNotStale,
  createPersistedChildren,
  guardAgentName,
  type AgentRegistry,
  type RegisterInput,
  type ResumeContext,
} from "../../src/agent/bg-agent-registry";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { ChildProfiles, RuntimeChildren } from "../../src/runtime-state/children";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withTempHome } from "./support";

const RESUME: ResumeContext = {
  agentType: "reviewer",
  cwd: "/repo/child",
  roots: ["/repo/child"],
  approvalPolicy: "auto",
  model: "fake-1",
  instructions: "you are a subagent",
  maxTurns: 10,
  openingPrompt: "review the auth module",
  description: "review auth",
  depth: 1,
  loaded: ["ToolSearch"],
  excludeTools: ["ask_user", "exit_plan_mode", "enter_plan_mode"],
  allowTools: ["read", "grep"],
};

const input = (over: Partial<RegisterInput> = {}): RegisterInput => ({
  agentId: "a1",
  sessionId: "s1",
  threadId: "t1",
  abort: new AbortController(),
  ...over,
});

/** A timer pair the test drives by hand — the alternative is waiting ten real minutes. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: {
      set(fn: () => void, ms: number): unknown {
        const id = next++;
        pending.set(id, { fn, ms });
        return id;
      },
      clear(handle: unknown): void {
        pending.delete(handle as number);
      },
    },
    armed: (): Array<{ ms: number }> => [...pending.values()].map((p) => ({ ms: p.ms })),
    /** Timer IDENTITIES, not just their windows: a re-arm must be observable as a NEW timer, or
     *  "progress() re-arms" would pass against a `progress()` that did nothing at all. */
    ids: (): number[] => [...pending.keys()],
    fireAll(): void {
      for (const [id, p] of [...pending]) {
        pending.delete(id);
        p.fn();
      }
    },
  };
}

interface Home {
  home: string;
  rs: RuntimeStateDb;
  /** A fresh registry over the SAME home — what a restarted daemon builds. */
  registry(over?: Partial<Parameters<typeof createPersistedChildren>[0]>): AgentRegistry;
  children: RuntimeChildren;
  profiles: ChildProfiles;
}

const withHome = (fn: (h: Home) => Promise<void> | void): Promise<void> =>
  withTempHome(async (home) => {
    const rs = openRuntimeStateDb(home);
    try {
      const children = new RuntimeChildren(rs);
      const profiles = new ChildProfiles(home);
      await fn({
        home,
        rs,
        children,
        profiles,
        registry: (over = {}) => createPersistedChildren({ store: children, profiles, providerId: () => "openai", ...over }),
      });
    } finally {
      rs.close();
    }
  });

describe("createPersistedChildren — identity and ResumeContext across a restart", () => {
  test("WS-17 §8 row 6: a SECOND registry over the same home reconstructs the child whole", async () => {
    await withHome(async (h) => {
      const first = h.registry();
      expect(first.register(input({ name: "auth-reviewer", resume: RESUME }))).toEqual({ ok: true });

      // ── the daemon dies here ─────────────────────────────────────────────────────────────────
      // A new registry, a new `RuntimeChildren`, a new `ChildProfiles` — nothing in common but the
      // home on disk.
      const second = createPersistedChildren({ store: new RuntimeChildren(h.rs), profiles: new ChildProfiles(h.home), providerId: () => "openai" });

      const entry = second.get("a1", "s1");
      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe("a1");
      expect(entry!.sessionId).toBe("s1");
      expect(entry!.name).toBe("auth-reviewer");
      expect(entry!.threadId).toBe("t1");
      expect(entry!.resume).toEqual(RESUME);
      // Identity by NAME survives too — which is the half a model actually uses.
      expect(second.get("auth-reviewer", "s1")?.agentId).toBe("a1");
      expect(second.list("s1").map((e) => e.agentId)).toEqual(["a1"]);
    });
  });

  test("the ResumeContext lives under `runtimes/`, where the read tools are denied — and the row only points at it", async () => {
    await withHome(async (h) => {
      h.registry().register(input({ resume: RESUME }));
      const row = h.children.get("s1", "a1");
      // WS-16 §12: a locator, never the object. The row must not have grown a prompt column.
      expect(row?.resumeContextRef).toBe("children/s1/a1.json");
      expect(JSON.stringify(row)).not.toContain("review the auth module");
      // And the profile that locator names is under the tree `daemon.ts` denies `read`/`grep`.
      expect(row!.resumeContextRef!.startsWith("children/")).toBe(true);
      expect(h.profiles.read("s1", "a1")?.resume).toEqual(RESUME);
    });
  });

  test("a restart reclassifies a running child `interrupted`, and reopen() still resumes it", async () => {
    await withHome(async (h) => {
      h.registry().register(input({ resume: RESUME }));
      expect(h.children.get("s1", "a1")?.status).toBe("running");

      // WS-16 §12's restart rule: nothing this process owned survived, so every `running` child is
      // proven gone. (The default `isChildGone` in 8a's recovery says exactly this.)
      const { interrupted } = h.children.reclassifyAfterRestart(() => true);
      expect(interrupted).toEqual([{ parent: "s1", childId: "a1" }]);

      const second = h.registry();
      expect(second.get("a1", "s1")?.status).toBe("interrupted");
      // `interrupted` is recoverable, not terminal-and-done: a fresh controller re-admits it.
      expect(second.reopen("a1", new AbortController())).toBe(true);
      expect(second.get("a1", "s1")?.status).toBe("running");
      expect(second.get("a1", "s1")?.resume).toEqual(RESUME);
    });
  });

  test("a child that already FINISHED is never resurrected by a restart", async () => {
    await withHome(async (h) => {
      const first = h.registry();
      first.register(input());
      first.complete("a1", { ok: true, result: "done" });
      h.children.reclassifyAfterRestart(() => true);
      expect(h.registry().get("a1", "s1")?.status).toBe("completed");
      expect(h.registry().get("a1", "s1")?.result).toBe("done");
    });
  });
});

describe("createPersistedChildren — the BackgroundAgentRegistry semantics, copied case for case", () => {
  test("register → list shows the running entry", async () => {
    await withHome((h) => {
      const reg = h.registry();
      expect(reg.register(input())).toEqual({ ok: true });
      const list = reg.list("s1");
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ agentId: "a1", sessionId: "s1", threadId: "t1", status: "running", notified: false });
    });
  });

  test("complete(ok:true) → completed + result stored; complete(ok:false) → failed", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input());
      reg.complete("a1", { ok: true, result: "all good" });
      expect(reg.get("a1", "s1")).toMatchObject({ status: "completed", result: "all good" });

      reg.register(input({ agentId: "a2" }));
      reg.complete("a2", { ok: false, result: "boom" });
      expect(reg.get("a2", "s1")).toMatchObject({ status: "failed", result: "boom" });
    });
  });

  test("complete on unknown or already-terminal agent is a no-op", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.complete("nope", { ok: true, result: "x" });
      expect(reg.get("nope", "s1")).toBeUndefined();
      reg.register(input());
      reg.complete("a1", { ok: true, result: "first" });
      reg.complete("a1", { ok: false, result: "second" });
      expect(reg.get("a1", "s1")).toMatchObject({ status: "completed", result: "first" });
    });
  });

  test("get by agentId / by name, and both scoped OUT by the wrong session", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input({ name: "alpha" }));
      expect(reg.get("a1", "s1")?.agentId).toBe("a1");
      expect(reg.get("alpha", "s1")?.agentId).toBe("a1");
      expect(reg.get("a1", "other")).toBeUndefined();
      expect(reg.get("alpha", "other")).toBeUndefined();
    });
  });

  test("register: a name already used by a DIFFERENT agentId is rejected, original untouched", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input({ name: "alpha" }));
      const second = reg.register(input({ agentId: "a2", name: "alpha" }));
      expect(second.ok).toBe(false);
      expect(second.ok === false && second.error).toBe("name 'alpha' already in use by agent a1");
      expect(reg.get("alpha", "s1")?.agentId).toBe("a1");
      expect(reg.list("s1")).toHaveLength(1);
    });
  });

  test("register: re-registering the same agentId is rejected as duplicate", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input({ name: "alpha" }));
      const again = reg.register(input({ name: "alpha" }));
      expect(again.ok).toBe(false);
      expect(again.ok === false && again.error).toBe("agent 'a1' is already registered");
    });
  });

  test("names may repeat across different sessions", async () => {
    await withHome((h) => {
      const reg = h.registry();
      expect(reg.register(input({ name: "alpha" })).ok).toBe(true);
      expect(reg.register(input({ agentId: "a2", sessionId: "s2", name: "alpha" })).ok).toBe(true);
      expect(reg.get("alpha", "s1")?.agentId).toBe("a1");
      expect(reg.get("alpha", "s2")?.agentId).toBe("a2");
    });
  });

  test("stop(running) → true, fires abort, status stopped; stop on a terminal or unknown agent → false", async () => {
    await withHome((h) => {
      const reg = h.registry();
      const abort = new AbortController();
      reg.register(input({ abort }));
      expect(reg.stop("a1")).toBe(true);
      expect(abort.signal.aborted).toBe(true);
      expect(reg.get("a1", "s1")?.status).toBe("stopped");
      expect(reg.stop("a1")).toBe(false);
      expect(reg.stop("nobody")).toBe(false);
    });
  });

  test("stop() then complete(): the entry stays 'stopped' and its result is never overwritten", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input());
      reg.stop("a1");
      reg.complete("a1", { ok: true, result: "finished after all" });
      expect(reg.get("a1", "s1")?.status).toBe("stopped");
      expect(reg.get("a1", "s1")?.result).toBeUndefined();
    });
  });

  test("takeForNotification claims a terminal-unnotified entry exactly once — across a restart too", async () => {
    await withHome(async (h) => {
      const first = h.registry();
      first.register(input());
      expect(first.takeForNotification("a1")).toBeUndefined(); // still running
      first.complete("a1", { ok: true, result: "done" });
      expect(first.takeForNotification("a1")?.agentId).toBe("a1");
      expect(first.takeForNotification("a1")).toBeUndefined();
      // The claim is durable, which is the whole point: a restart must not re-notify.
      expect(h.registry().takeForNotification("a1")).toBeUndefined();
      expect(h.registry().takeForNotification("ghost")).toBeUndefined();
    });
  });

  test("complete({notified:true}) claims immediately; complete({timedOut:true}) reports 'timeout'", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input());
      reg.complete("a1", { ok: true, result: "sync result" }, { notified: true });
      expect(reg.takeForNotification("a1")).toBeUndefined();

      reg.register(input({ agentId: "a2" }));
      reg.complete("a2", { ok: true, result: "slow" }, { timedOut: true });
      // timedOut wins over outcome.ok — a timed-out child is never a generic failure OR a success.
      expect(reg.get("a2", "s1")?.status).toBe("timeout");
      expect(reg.reopen("a2", new AbortController())).toBe(true);
      expect(reg.get("a2", "s1")?.status).toBe("running");
    });
  });

  test("reopen: unknown → false; already running → false; a reopened entry is not notifiable", async () => {
    await withHome((h) => {
      const reg = h.registry();
      expect(reg.reopen("ghost", new AbortController())).toBe(false);
      reg.register(input());
      expect(reg.reopen("a1", new AbortController())).toBe(false);
      reg.complete("a1", { ok: true, result: "done" });
      expect(reg.reopen("a1", new AbortController())).toBe(true);
      expect(reg.get("a1", "s1")).toMatchObject({ status: "running", notified: false });
      expect(reg.get("a1", "s1")?.result).toBeUndefined();
      expect(reg.takeForNotification("a1")).toBeUndefined();
    });
  });

  test("list scopes to the given session only, in registration order", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input({ agentId: "a1" }));
      reg.register(input({ agentId: "a2" }));
      reg.register(input({ agentId: "b1", sessionId: "s2" }));
      expect(reg.list("s1").map((e) => e.agentId)).toEqual(["a1", "a2"]);
      expect(reg.list("s2").map((e) => e.agentId)).toEqual(["b1"]);
    });
  });
});

describe("createPersistedChildren — the stale-name guard", () => {
  test("guardAgentName rejects a name that now reaches a DIFFERENT child, naming both ids", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input({ name: "alpha" }));
      const entry = reg.get("alpha", "s1")!;
      // First by-name reach records; a second reach at the same agent is fine.
      expect(guardAgentName(reg, "s1", "alpha", entry)).toEqual({ ok: true });
      expect(guardAgentName(reg, "s1", "alpha", entry)).toEqual({ ok: true });
      // The same name now resolving somewhere else is the refusal the guard exists for.
      const impostor = { ...entry, agentId: "a2" };
      const refused = guardAgentName(reg, "s1", "alpha", impostor);
      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.error).toContain("name 'alpha' now reaches a different agent (a2)");
      expect(refused.ok === false && refused.error).toContain("it previously reached a1");
      // A by-ID resolution bypasses the guard entirely, exactly as before.
      expect(guardAgentName(reg, "s1", "a2", impostor)).toEqual({ ok: true });
    });
  });

  test("a name whose reach was never recorded is ACCEPTED — and the reach is scoped per session", async () => {
    await withHome((h) => {
      const reg = h.registry();
      expect(reg.firstReached("s1", "alpha")).toBeUndefined();
      expect(checkNameNotStale(undefined, "a1", "alpha")).toEqual({ ok: true });
      reg.recordReached("s1", "alpha", "a1");
      expect(reg.firstReached("s1", "alpha")).toBe("a1");
      expect(reg.firstReached("s2", "alpha")).toBeUndefined();
    });
  });

  test("the reach memory SURVIVES a restart — a stale reference is refused after a reboot too", async () => {
    await withHome((h) => {
      h.registry().recordReached("s1", "alpha", "a1");
      expect(h.registry().firstReached("s1", "alpha")).toBe("a1");
      expect(checkNameNotStale(h.registry().firstReached("s1", "alpha"), "a2", "alpha").ok).toBe(false);
    });
  });
});

describe("createPersistedChildren — never throws (the contract the Map had for free)", () => {
  test("a CLOSED runtime-state handle answers empty, and the turn that asked is unharmed", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      const lines: string[] = [];
      const reg = createPersistedChildren({
        store: new RuntimeChildren(rs), profiles: new ChildProfiles(home), providerId: () => "openai", log: (l) => lines.push(l),
      });
      reg.register(input({ name: "worker" }));
      // `engine.ts`'s `runTurn` asks `list(sessionId)` on EVERY round to decide whether to pin
      // `task_stop`. A daemon torn down mid-turn used to raise `RangeError: Cannot use a closed
      // database` straight out of the agent loop — found by the suite, not by reasoning.
      rs.close();

      expect(reg.list("s1")).toEqual([]);
      expect(reg.get("a1", "s1")).toBeUndefined();
      expect(reg.get("worker", "s1")).toBeUndefined();
      expect(reg.stop("a1")).toBe(false);
      expect(reg.reopen("a1", new AbortController())).toBe(false);
      expect(reg.takeForNotification("a1")).toBeUndefined();
      expect(() => reg.complete("a1", { ok: true, result: "x" })).not.toThrow();
      expect(() => reg.markNotified("a1")).not.toThrow();
      expect(() => reg.progress("a1")).not.toThrow();
      expect(reg.register(input({ agentId: "a9" })).ok).toBe(false);
      expect(lines.join("\n")).toContain("answering as if there were no such child");
    });
  });
});

describe("createPersistedChildren — the progress-stall watchdog (fix round 1, F1)", () => {
  test("THE SHIPPED DAEMON'S SHAPE: with no `stallTimeoutMs` dep, nothing is ever armed", async () => {
    await withHome((h) => {
      const clock = fakeTimers();
      const abort = new AbortController();
      // `daemon.ts` passes no `stallTimeoutMs` while the engine runs children: `SubagentManager`
      // already owns a resettable window for them and its controller is folded into their run
      // signal, so a second timer here would be a second KILLER — and, unreset, a 600 s WALL CLOCK,
      // which is exactly what CLAUDE.md's tool surface and "subagents: no timeout" forbid.
      const reg = h.registry({ timers: clock.timers });
      reg.register(input({ abort }));

      expect(clock.armed()).toEqual([]);
      clock.fireAll();
      expect(reg.get("a1", "s1")?.status).toBe("running");
      expect(abort.signal.aborted).toBe(false);
    });
  });

  test("a child with NO progress is stopped as `timeout` once the window is armed", async () => {
    await withHome((h) => {
      const clock = fakeTimers();
      const abort = new AbortController();
      const reg = h.registry({ timers: clock.timers, stallTimeoutMs: () => undefined });
      reg.register(input({ abort }));

      // `undefined` from the getter means the shipped default, which is `SubagentManager`'s and the
      // Winter runtime's own `ASYNC_AGENT_STALL_TIMEOUT_MS`.
      expect(clock.armed()).toEqual([{ ms: CHILD_STALL_TIMEOUT_MS }]);
      clock.fireAll();

      expect(reg.get("a1", "s1")?.status).toBe("timeout");
      expect(reg.get("a1", "s1")?.result).toContain("no progress for 600s");
      expect(abort.signal.aborted).toBe(true);
    });
  });

  test("a child that KEEPS reporting progress is never aborted, however long it runs", async () => {
    await withHome((h) => {
      const clock = fakeTimers();
      const abort = new AbortController();
      const reg = h.registry({ timers: clock.timers, stallTimeoutMs: () => undefined });
      reg.register(input({ abort }));

      // Ten full windows of fake time — an hour and forty minutes of wall clock — each one ended by
      // a progress report before it could fire. A wall clock kills this child; a progress window
      // does not, and that difference is the whole user-facing rule.
      let previous = clock.ids()[0]!;
      for (let window = 0; window < 10; window += 1) {
        reg.progress("a1");
        const armed = clock.ids();
        expect(armed).toHaveLength(1); // cleared and re-armed, never stacked
        expect(armed[0]).not.toBe(previous); // a NEW timer: the window genuinely restarted
        previous = armed[0]!;
      }
      expect(reg.get("a1", "s1")?.status).toBe("running");
      expect(abort.signal.aborted).toBe(false);

      // And when it finally does go quiet, it is stopped.
      clock.fireAll();
      expect(reg.get("a1", "s1")?.status).toBe("timeout");
      expect(abort.signal.aborted).toBe(true);
    });
  });

  test("a terminal transition disarms, so a finished child is never reported stalled", async () => {
    await withHome((h) => {
      const clock = fakeTimers();
      const reg = h.registry({ timers: clock.timers, stallTimeoutMs: () => undefined });
      reg.register(input());
      reg.complete("a1", { ok: true, result: "finished in time" });
      expect(clock.armed()).toEqual([]);
      clock.fireAll();
      expect(reg.get("a1", "s1")?.status).toBe("completed");
    });
  });

  test("the window is LIVE and `null` disables it — no setting may require a restart", async () => {
    await withHome((h) => {
      const clock = fakeTimers();
      let window: number | null = 1_000;
      const reg = h.registry({ timers: clock.timers, stallTimeoutMs: () => window });
      reg.register(input());
      expect(clock.armed()).toEqual([{ ms: 1_000 }]);

      window = null;
      reg.progress("a1");
      expect(clock.armed()).toEqual([]);
      // Disabled means disabled: nothing fires, and the child stays running.
      clock.fireAll();
      expect(reg.get("a1", "s1")?.status).toBe("running");
    });
  });
});

describe("createPersistedChildren — fix round 1 residues", () => {
  test("F7: an unscoped NAME lookup never answers about an arbitrary parent's child", async () => {
    await withHome((h) => {
      const reg = h.registry();
      reg.register(input({ name: "twin" }));
      reg.register(input({ agentId: "b1", sessionId: "s2", name: "twin" }));
      // Two sessions may legally use one name, so unscoped it is ambiguous — exactly as a bare
      // child id minted by two parents is.
      expect(reg.get("twin")).toBeUndefined();
      expect(reg.get("twin", "s1")?.agentId).toBe("a1");
      expect(reg.get("twin", "s2")?.agentId).toBe("b1");
    });
  });

  test("F5: a `facetFor` that THROWS does not escape stop() — the never-throws contract holds", async () => {
    await withHome((h) => {
      const lines: string[] = [];
      const store = new RuntimeChildren(h.rs);
      const profiles = new ChildProfiles(h.home);
      createPersistedChildren({ store, profiles, providerId: () => "openai" }).register(input());
      // A restarted registry (no local controller) whose host door throws the way the daemon's real
      // one can: `records.get` on a closed handle, or `UnaddressableEntryError` on a bad backend id.
      const restarted = createPersistedChildren({
        store, profiles, providerId: () => "openai",
        facetFor: () => { throw new Error("UnaddressableEntryError"); },
        log: (l) => lines.push(l),
      });
      expect(() => restarted.stop("a1")).not.toThrow();
      expect(restarted.get("a1", "s1")?.status).toBe("stopped");
      expect(lines.join("\n")).toContain("children.facet failed");
    });
  });

  test("F4: deleting a session's runtime state deletes the child PROFILES, not only the rows", async () => {
    await withHome(async (h) => {
      const reg = h.registry();
      reg.register(input({ resume: RESUME }));
      expect(h.profiles.read("s1", "a1")?.resume).toEqual(RESUME);
      expect(existsSync(join(h.home, "runtimes", "children", "s1", "a1.json"))).toBe(true);

      h.profiles.removeParent("s1");

      // The prompt is gone with the row — a sweep that pruned one and left the other would leave
      // `instructions`/`openingPrompt` on disk under a home the user believes they emptied.
      expect(h.profiles.read("s1", "a1")).toBeUndefined();
      expect(existsSync(join(h.home, "runtimes", "children", "s1"))).toBe(false);
      // And it is best-effort: a second removal, or one for a parent that never existed, is a no-op.
      expect(() => h.profiles.removeParent("s1")).not.toThrow();
      expect(() => h.profiles.removeParent("never-existed")).not.toThrow();
    });
  });
});
