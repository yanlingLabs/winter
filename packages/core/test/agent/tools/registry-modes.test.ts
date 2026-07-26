import { describe, test, expect } from "bun:test";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { z } from "zod";

const def = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: name, args: z.object({}), run: async () => "ok", ...extra,
});

describe("per-mode tool derivation", () => {
  test("absent modes means code-only — the restrictive default", () => {
    const r = new ToolRegistry();
    r.register(def("bash"));
    expect(r.namesForMode("code").has("bash")).toBe(true);
    expect(r.namesForMode("chat").has("bash")).toBe(false);
    expect(r.namesForMode("dispatch").has("bash")).toBe(false);
  });

  test("a tool declaring chat appears in chat and NOT in code", () => {
    const r = new ToolRegistry();
    r.register(def("Search", { modes: ["chat"] }));
    expect(r.namesForMode("chat").has("Search")).toBe(true);
    expect(r.namesForMode("code").has("Search")).toBe(false);
    expect(r.namesNotForMode("code").has("Search")).toBe(true);
  });

  test("a tool may declare several modes", () => {
    const r = new ToolRegistry();
    r.register(def("Search", { modes: ["chat", "dispatch"] }));
    expect(r.namesForMode("chat").has("Search")).toBe(true);
    expect(r.namesForMode("dispatch").has("Search")).toBe(true);
    expect(r.namesForMode("code").has("Search")).toBe(false);
  });

  test("ToolSearch is auto-included when the mode has a deferred tool", () => {
    const r = new ToolRegistry();
    r.register(def("ToolSearch"));
    r.register(def("push_notification", { modes: ["dispatch"], deferred: true }));
    expect(r.namesForMode("dispatch", { builtinDeferral: true }).has("ToolSearch")).toBe(true);
  });

  test("ToolSearch is NOT auto-included when the mode has no deferred tool", () => {
    const r = new ToolRegistry();
    r.register(def("ToolSearch"));
    r.register(def("Search", { modes: ["chat"] }));            // not deferred
    expect(r.namesForMode("chat", { builtinDeferral: true }).has("ToolSearch")).toBe(false);
  });

  test("a deferred tool in ANOTHER mode does not drag ToolSearch into this one", () => {
    const r = new ToolRegistry();
    r.register(def("ToolSearch"));
    r.register(def("lsp", { deferred: true }));                 // code-only
    r.register(def("Search", { modes: ["chat"] }));
    expect(r.namesForMode("code", { builtinDeferral: true }).has("ToolSearch")).toBe(true);
    expect(r.namesForMode("chat", { builtinDeferral: true }).has("ToolSearch")).toBe(false);
  });

  test("builtinDeferral off means no auto-ToolSearch anywhere", () => {
    const r = new ToolRegistry();
    r.register(def("ToolSearch"));
    r.register(def("lsp", { deferred: true }));
    expect(r.namesForMode("code", { builtinDeferral: false }).has("ToolSearch")).toBe(false);
  });
});
