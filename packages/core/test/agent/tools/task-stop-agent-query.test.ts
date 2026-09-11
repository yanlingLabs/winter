// P8b Task 13 — `task_stop` and `agent_list`/`agent_output` over the PERSISTED roster.
//
// The tools did not move: they take the `AgentRegistry` contract, and Task 13 handed them a second
// implementation of it. What this file proves is that the swap is behaviour-preserving where it
// must be, and that the two places it CANNOT be — a stop with no local `AbortController`, and the
// notified flag — are handled rather than silently broken.
//
// THE ONE THAT WOULD HAVE BEEN SILENT: `task_stop` used to write `entry.notified = true` on the
// object `get()` returned, which worked only because that object WAS the registry's live row. A
// persisted registry materialises entries from a table, so the same line would have set a flag on a
// copy and the stopped child's raw result would have re-surfaced in a later turn.
import { describe, expect, test } from "bun:test";
import type { DeliveryOutcome, GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { SessionMessagingFacet } from "@yanlinglabs/winter-agent-sdk";
import { createPersistedChildren, type AgentRegistry, type RegisterInput } from "../../../src/agent/bg-agent-registry";
import { registerAgentQueryTools } from "../../../src/agent/tools/agent-query";
import { registerTaskStopTool } from "../../../src/agent/tools/task-stop";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { ChildProfiles, RuntimeChildren } from "../../../src/runtime-state/children";
import { openRuntimeStateDb } from "../../../src/runtime-state/db";
import { withTempHome } from "../../runtime-state/support";

const input = (over: Partial<RegisterInput> = {}): RegisterInput => ({
  agentId: "a1",
  sessionId: "s1",
  threadId: "t1",
  abort: new AbortController(),
  ...over,
});

/** A fake `Query.messaging` — the only door to a child this process did not spawn (surface map
 *  §9.2: "a child engine has no facet surface of its own"). */
function fakeFacet(outcome: (msg: GlobalAgentMessage) => DeliveryOutcome = (m) => ({ status: "delivered", messageId: m.messageId })) {
  const steered: Array<{ id: string; body: string }> = [];
  const resumed: string[] = [];
  const facet: SessionMessagingFacet = {
    listReachable: async () => [],
    deliver: async (m) => ({ status: "unavailable", messageId: m.messageId, retryable: false, reason: "inert" }),
    steerChild: async (id, msg) => {
      steered.push({ id, body: msg.body });
      return outcome(msg);
    },
    resumeChild: async (id, msg) => {
      resumed.push(id);
      return { status: "resumed_and_delivered", messageId: msg.messageId };
    },
    subscribeIdle: async (_id, opts) => ({ status: "subscribed", messageId: opts.messageId }),
    senderClass: async () => "prompts",
    readNotifications: async () => ({ notifications: [], remaining: 0 }),
    onIdleNotice: () => () => {},
  };
  return { facet, steered, resumed };
}

const ctx = (sessionId: string) => ({ cwd: "/tmp", roots: ["/tmp"], sessionId });

interface Kit {
  registry: AgentRegistry;
  tools: ToolRegistry;
  run(name: string, args: Record<string, unknown>, sessionId?: string): Promise<{ output: string; isError: boolean }>;
}

const withKit = (
  fn: (k: Kit, facets: ReturnType<typeof fakeFacet>) => Promise<void> | void,
  opts: { facetFor?: boolean } = {},
): Promise<void> =>
  withTempHome(async (home) => {
    const rs = openRuntimeStateDb(home);
    try {
      const facets = fakeFacet();
      const registry = createPersistedChildren({
        store: new RuntimeChildren(rs),
        profiles: new ChildProfiles(home),
        providerId: () => "openai",
        ...(opts.facetFor === false ? {} : { facetFor: () => facets.facet }),
      });
      const tools = new ToolRegistry();
      registerTaskStopTool(tools, { bgAgents: registry });
      registerAgentQueryTools(tools, {
        bgAgents: registry,
        store: { read: () => [] },
        transcriptPathFor: (sid, tid) => `/tmp/${sid}/${tid}.jsonl`,
      });
      await fn(
        {
          registry,
          tools,
          run: (name, args, sessionId = "s1") => tools.execute(name, args, ctx(sessionId)),
        },
        facets,
      );
    } finally {
      rs.close();
    }
  });

describe("task_stop over the persisted roster", () => {
  test("a child THIS process spawned is aborted locally, and the facet is not bothered", async () => {
    await withKit(async (k, facets) => {
      const abort = new AbortController();
      k.registry.register(input({ abort, name: "worker" }));

      expect(await k.run("task_stop", { task_id: "a1" })).toMatchObject({ isError: false, output: "stopped agent 'a1'" });
      expect(abort.signal.aborted).toBe(true);
      expect(k.registry.get("a1", "s1")?.status).toBe("stopped");
      expect(facets.steered).toHaveLength(0);
    });
  });

  test("after a restart there is no local controller → a steer through the OWNING session's facet, never a kill", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = new RuntimeChildren(rs);
        const profiles = new ChildProfiles(home);
        const facets = fakeFacet();

        // Boot 1 registers the child; boot 2 is a brand-new registry over the same home, holding
        // no `AbortController` for anything.
        createPersistedChildren({ store, profiles, providerId: () => "openai" }).register(input({ name: "worker" }));
        const restarted = createPersistedChildren({ store, profiles, providerId: () => "openai", facetFor: () => facets.facet });

        const tools = new ToolRegistry();
        registerTaskStopTool(tools, { bgAgents: restarted });
        const out = await tools.execute("task_stop", { task_id: "worker" }, ctx("s1"));

        expect(out).toMatchObject({ isError: false, output: "stopped agent 'worker'" });
        // A REQUEST, not a kill: `steerChild` on the parent's facet, addressed by the bare child id.
        expect(facets.steered).toHaveLength(1);
        expect(facets.steered[0]!.id).toBe("a1");
        expect(facets.steered[0]!.body).toContain("Stop what you are doing");
        expect(facets.resumed).toHaveLength(0);
        // `resumeChild` is "never the reverse of steerChild" (surface map §9.2) — a running child is
        // steered and nothing else.
        expect(restarted.get("a1", "s1")?.status).toBe("stopped");
      } finally {
        rs.close();
      }
    });
  });

  test("after a restart with no live owner at all: the roster records the stop and says nothing was interrupted", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = new RuntimeChildren(rs);
        const profiles = new ChildProfiles(home);
        const lines: string[] = [];
        createPersistedChildren({ store, profiles, providerId: () => "openai" }).register(input());
        const restarted = createPersistedChildren({ store, profiles, providerId: () => "openai", log: (l) => lines.push(l) });

        const tools = new ToolRegistry();
        registerTaskStopTool(tools, { bgAgents: restarted });
        expect(await tools.execute("task_stop", { task_id: "a1" }, ctx("s1"))).toMatchObject({ isError: false, output: "stopped agent 'a1'" });
        expect(restarted.get("a1", "s1")?.status).toBe("stopped");
        expect(lines.join("\n")).toContain("no live owner to ask");
      } finally {
        rs.close();
      }
    });
  });
});

describe("task_stop — the semantics that must not change", () => {
  test("stopping an already-finished agent REPORTS its status and is not an error", async () => {
    await withKit(async (k) => {
      k.registry.register(input());
      k.registry.complete("a1", { ok: true, result: "done" });
      expect(await k.run("task_stop", { task_id: "a1" })).toMatchObject({ isError: false, output: "agent 'a1' already completed" });
    });
  });

  test("the stale-name guard still refuses a name that now reaches a different agent", async () => {
    await withKit(async (k) => {
      k.registry.register(input({ name: "worker" }));
      expect(await k.run("task_stop", { task_id: "worker" })).toMatchObject({ isError: false, output: "stopped agent 'worker'" });
      // The name's reach is now recorded at a1. Re-point it and the guard must refuse rather than
      // stop the wrong child.
      k.registry.recordReached("s1", "worker", "a-other");
      const refused = await k.run("task_stop", { task_id: "worker" });
      expect(refused.isError).toBe(true);
      expect(refused.output).toContain("now reaches a different agent");
    });
  });

  test("markNotified is DURABLE: a stopped child's result never re-surfaces as a completion notice", async () => {
    await withKit(async (k) => {
      k.registry.register(input());
      await k.run("task_stop", { task_id: "a1" });
      // The caller of task_stop already has this result in its own turn. The detached chain's
      // settle-time claim must find nothing — and must still find nothing after a restart.
      expect(k.registry.takeForNotification("a1")).toBeUndefined();
      expect(k.registry.get("a1", "s1")?.notified).toBe(true);
    });
  });

  test("an unknown id is still a typed not-found", async () => {
    await withKit(async (k) => {
      const missing = await k.run("task_stop", { task_id: "ghost" });
      expect(missing.isError).toBe(true);
      expect(missing.output).toContain("no running agent, dispatch child, or background task 'ghost'");
    });
  });
});

describe("agent_list / agent_output over the persisted roster", () => {
  test("agent_list reads the child's last status FROM THE RECORD, across a restart", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const store = new RuntimeChildren(rs);
        const profiles = new ChildProfiles(home);
        const boot1 = createPersistedChildren({ store, profiles, providerId: () => "openai" });
        boot1.register(input({ name: "worker", resume: { agentType: "reviewer", cwd: "/r", approvalPolicy: "auto", instructions: "i", openingPrompt: "p", description: "review auth", depth: 1, loaded: [], excludeTools: [] } }));
        boot1.register(input({ agentId: "a2" }));
        boot1.complete("a2", { ok: false, result: "boom" });

        const restarted = createPersistedChildren({ store, profiles, providerId: () => "openai" });
        const tools = new ToolRegistry();
        registerAgentQueryTools(tools, { bgAgents: restarted, store: { read: () => [] }, transcriptPathFor: (sid, tid) => `/tmp/${sid}/${tid}.jsonl` });

        const listed = (await tools.execute("agent_list", {}, ctx("s1"))).output;
        expect(listed).toContain("a1 (worker) — running");
        // The description comes out of the ResumeContext, which only survives because the profile does.
        expect(listed).toContain("review auth");
        expect(listed).toContain("a2 — failed");

        const out = (await tools.execute("agent_output", { agent: "a2" }, ctx("s1"))).output;
        expect(out).toContain("agent 'a2' failed");
        expect(out).toContain("boom");
        // The transcript path is derived from the child's threadId, which has no column and is only
        // there because the profile carries it.
        expect(out).toContain("/tmp/s1/t1.jsonl");
      } finally {
        rs.close();
      }
    });
  });

  test("agent_output on an unknown agent is a typed error, and reading it never claims the notice", async () => {
    await withKit(async (k) => {
      const ghost = await k.run("agent_output", { agent: "ghost" });
      expect(ghost.isError).toBe(true);
      expect(ghost.output).toContain("no such agent 'ghost' in this session");
      k.registry.register(input());
      k.registry.complete("a1", { ok: true, result: "done" });
      await k.run("agent_output", { agent: "a1" });
      // Read-only: a peek must not consume the settle-time claim.
      expect(k.registry.takeForNotification("a1")?.agentId).toBe("a1");
    });
  });

  test("agent_list on a session with no children says so", async () => {
    await withKit(async (k) => {
      expect(await k.run("agent_list", {}, "empty")).toMatchObject({ isError: false, output: "no background agents in this session" });
    });
  });
});
