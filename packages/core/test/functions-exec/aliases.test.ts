import { describe, expect, test } from "bun:test";
import { dispatchFunctionsExecAlias, normalizeFunctionsExecAlias } from "../../src/functions-exec/aliases";

describe("functions-exec canonical aliases", () => {
  test("normalizes only exact canonical bash arguments", () => {
    expect(normalizeFunctionsExecAlias("bash", {
      command: "pwd",
      timeoutMs: 100,
      runInBackground: false,
    })).toEqual({
      name: "bash",
      args: { command: "pwd", timeoutMs: 100, runInBackground: false },
    });
    expect(() => normalizeFunctionsExecAlias("bash", { command: "pwd", shell: "zsh" })).toThrow(/unknown/i);
    expect(() => normalizeFunctionsExecAlias("bash", { command: "" })).toThrow(/non-empty/i);
  });

  test("accepts edit only as a validated raw patch string before canonical dispatch", async () => {
    const patch = ["*** Begin Patch", "*** Add File: added.txt", "+hello", "*** End Patch"].join("\n");
    const calls: unknown[] = [];
    await expect(dispatchFunctionsExecAlias("edit", patch, async (name, args) => {
      calls.push({ name, args });
      return { output: "prepared" };
    })).resolves.toEqual({ output: "prepared" });
    expect(calls).toEqual([{ name: "edit", args: { patch } }]);
    expect(() => normalizeFunctionsExecAlias("edit", { patch })).toThrow(/raw Codex patch/i);
    expect(() => normalizeFunctionsExecAlias("edit", "not a patch")).toThrow(/boundaries/i);
  });

  test("keeps web and read aliases narrow", () => {
    expect(normalizeFunctionsExecAlias("read", { path: "README.md", offset: 0, limit: 10 })).toEqual({
      name: "read",
      args: { path: "README.md", offset: 0, limit: 10 },
    });
    expect(() => normalizeFunctionsExecAlias("web_fetch", { url: "https://example.test", extra: true })).toThrow(/unknown/i);
    expect(() => normalizeFunctionsExecAlias("web_search", { query: "Norma", max_results: 101 })).toThrow(/integer/i);
  });
});
