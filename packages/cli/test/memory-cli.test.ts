// Phase 5b Task 4 — `winter memory list|show <name>|rm <name> [--project]` (main.ts) + `/memory`
// (tui/commands.ts) share memory-cli.ts. `parseMemoryArgs` is pure (routeCliInvocation's
// precedent — argv in, route out, no socket); `runMemoryRoute` is the one client-driven step,
// exercised here with a fake client following tui/commands.test.ts's `makeClient` precedent
// (recorded calls, canned results, no real I/O) since main.ts's own argv switch can't be driven
// directly by a unit test (routines-cli.ts's header comment) — this is the testable seam instead.
import { describe, expect, test } from "bun:test";
import {
  MEMORY_USAGE,
  formatDeleted,
  formatFactDetail,
  formatFactLine,
  formatMemoryList,
  parseMemoryArgs,
  runMemoryRoute,
  type MemoryFactLike,
  type MemoryFactMetaLike,
  type ResolvedMemoryRoute,
} from "../src/memory-cli";
import type { WinterClient } from "../src/client";

// ---- fake client (mirrors tui/commands.test.ts's makeClient — recorded calls, canned results) ----
type Impl = Record<string, (...args: unknown[]) => unknown>;

function makeClient(impl: Impl): { client: WinterClient; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const client: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    client[name] = (...args: unknown[]) => {
      calls.push({ method: name, args });
      return Promise.resolve(fn(...args));
    };
  }
  return { client: client as unknown as WinterClient, calls };
}

describe("parseMemoryArgs", () => {
  test("no args -> list, scope user, no cwd", () => {
    expect(parseMemoryArgs([], "/work")).toEqual({ kind: "list", scope: "user", cwd: undefined });
  });

  test("explicit 'list' -> same as no args", () => {
    expect(parseMemoryArgs(["list"], "/work")).toEqual({ kind: "list", scope: "user", cwd: undefined });
  });

  test("--project passes scope:\"project\" + cwd = the caller's own cwd", () => {
    expect(parseMemoryArgs(["list", "--project"], "/my/proj")).toEqual({ kind: "list", scope: "project", cwd: "/my/proj" });
  });

  test("--project works positioned before the subcommand too", () => {
    expect(parseMemoryArgs(["--project", "list"], "/my/proj")).toEqual({ kind: "list", scope: "project", cwd: "/my/proj" });
  });

  test("show <name> -> scope user by default", () => {
    expect(parseMemoryArgs(["show", "captain"], "/work")).toEqual({ kind: "show", scope: "user", cwd: undefined, name: "captain" });
  });

  test("show <name> --project -> project scope + cwd", () => {
    expect(parseMemoryArgs(["show", "captain", "--project"], "/my/proj")).toEqual({
      kind: "show", scope: "project", cwd: "/my/proj", name: "captain",
    });
  });

  test("rm <name> -> scope user by default", () => {
    expect(parseMemoryArgs(["rm", "captain"], "/work")).toEqual({ kind: "rm", scope: "user", cwd: undefined, name: "captain" });
  });

  test("rm <name> --project -> project scope + cwd", () => {
    expect(parseMemoryArgs(["rm", "captain", "--project"], "/my/proj")).toEqual({
      kind: "rm", scope: "project", cwd: "/my/proj", name: "captain",
    });
  });

  test("show/rm with no name -> usage (unknown subcommand help text)", () => {
    expect(parseMemoryArgs(["show"], "/work")).toEqual({ kind: "usage" });
    expect(parseMemoryArgs(["rm"], "/work")).toEqual({ kind: "usage" });
  });

  test("unrecognized subcommand -> usage", () => {
    expect(parseMemoryArgs(["bogus"], "/work")).toEqual({ kind: "usage" });
  });

  test("MEMORY_USAGE mentions every subcommand and the --project flag", () => {
    expect(MEMORY_USAGE).toContain("list");
    expect(MEMORY_USAGE).toContain("show");
    expect(MEMORY_USAGE).toContain("rm");
    expect(MEMORY_USAGE).toContain("--project");
  });
});

describe("runMemoryRoute — list", () => {
  test("empty store -> facts: []", async () => {
    const { client, calls } = makeClient({ memoryList: () => ({ facts: [] }) });
    const route: ResolvedMemoryRoute = { kind: "list", scope: "user" };
    const result = await runMemoryRoute(client, route);
    expect(result).toEqual({ kind: "list", facts: [] });
    expect(calls).toEqual([{ method: "memoryList", args: ["user", undefined] }]);
  });

  test("populated store -> facts passed through untouched", async () => {
    const facts: MemoryFactMetaLike[] = [
      { name: "captain", description: "prefers concise replies", type: "user" },
      { name: "stack", description: "monorepo, bun workspaces", type: "project" },
    ];
    const { client } = makeClient({ memoryList: () => ({ facts }) });
    const result = await runMemoryRoute(client, { kind: "list", scope: "user" });
    expect(result).toEqual({ kind: "list", facts });
  });

  test("--project scope threads scope+cwd to the client call", async () => {
    const { client, calls } = makeClient({ memoryList: () => ({ facts: [] }) });
    await runMemoryRoute(client, { kind: "list", scope: "project", cwd: "/my/proj" });
    expect(calls).toEqual([{ method: "memoryList", args: ["project", "/my/proj"] }]);
  });
});

describe("runMemoryRoute — show", () => {
  test("returns the fetched fact, including its body", async () => {
    const fact: MemoryFactLike = { name: "captain", description: "prefers concise replies", type: "user", body: "Sam prefers short answers." };
    const { client, calls } = makeClient({ memoryRead: () => ({ fact }) });
    const result = await runMemoryRoute(client, { kind: "show", scope: "user", name: "captain" });
    expect(result).toEqual({ kind: "show", fact });
    expect(calls).toEqual([{ method: "memoryRead", args: ["user", "captain", undefined] }]);
  });

  test("a store rejection (not found) propagates — never swallowed", async () => {
    const { client } = makeClient({ memoryRead: () => { throw new Error('memory fact "nope" not found or corrupt'); } });
    await expect(runMemoryRoute(client, { kind: "show", scope: "user", name: "nope" })).rejects.toThrow(/not found/);
  });
});

describe("runMemoryRoute — rm", () => {
  test("calls memoryDelete with scope+name+cwd, confirms with name+scope", async () => {
    const { client, calls } = makeClient({ memoryDelete: () => ({}) });
    const result = await runMemoryRoute(client, { kind: "rm", scope: "project", cwd: "/my/proj", name: "captain" });
    expect(result).toEqual({ kind: "rm", name: "captain", scope: "project" });
    expect(calls).toEqual([{ method: "memoryDelete", args: ["project", "captain", "/my/proj"] }]);
  });
});

describe("formatFactDetail / formatFactLine", () => {
  test("mirrors memory_read's own \"(type) — description\" wording", () => {
    expect(formatFactDetail({ name: "captain", description: "prefers concise replies", type: "user" })).toBe("(user) — prefers concise replies");
  });

  test("formatFactLine prepends the name", () => {
    expect(formatFactLine({ name: "captain", description: "prefers concise replies", type: "user" })).toBe("captain (user) — prefers concise replies");
  });
});

describe("formatMemoryList — empty + populated output shapes", () => {
  test("empty -> single fallback line", () => {
    expect(formatMemoryList([])).toEqual(["(no memory facts)"]);
  });

  test("populated -> one formatFactLine per fact, in order", () => {
    const facts: MemoryFactMetaLike[] = [
      { name: "captain", description: "prefers concise replies", type: "user" },
      { name: "stack", description: "monorepo, bun workspaces", type: "project" },
    ];
    expect(formatMemoryList(facts)).toEqual([
      "captain (user) — prefers concise replies",
      "stack (project) — monorepo, bun workspaces",
    ]);
  });
});

describe("formatDeleted — rm confirms", () => {
  test("names the fact and the scope it was deleted from", () => {
    expect(formatDeleted("captain", "user")).toBe('deleted memory fact "captain" (user scope)');
    expect(formatDeleted("stack", "project")).toBe('deleted memory fact "stack" (project scope)');
  });
});
