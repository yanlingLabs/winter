import { test, expect } from "bun:test";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { z } from "zod";

const def = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: name, args: z.object({}), run: async () => "ok", ...extra,
});

test("deferred: true still means deferred in every mode", () => {
  const r = new ToolRegistry();
  r.register(def("lsp", { deferred: true, modes: ["code", "dispatch"] }));
  expect(r.isDeferredBuiltin("lsp", true, "code")).toBe(true);
  expect(r.isDeferredBuiltin("lsp", true, "dispatch")).toBe(true);
});

test("deferred: [mode] defers ONLY in that mode", () => {
  const r = new ToolRegistry();
  r.register(def("bash", { deferred: ["dispatch"], modes: ["code", "dispatch"] }));
  expect(r.isDeferredBuiltin("bash", true, "dispatch")).toBe(true);
  expect(r.isDeferredBuiltin("bash", true, "code")).toBe(false);
});

test("specs() hides a mode-deferred tool only in that mode", () => {
  const r = new ToolRegistry();
  r.register(def("ToolSearch"));
  r.register(def("bash", { deferred: ["dispatch"], modes: ["code", "dispatch"] }));
  const names = (mode: any) =>
    r.specs(null, { builtinDeferral: true, loaded: new Set(), mode }).map((s) => s.name);
  expect(names("code")).toContain("bash");        // immediate in code
  expect(names("dispatch")).not.toContain("bash"); // deferred in dispatch
});

test("auto-ToolSearch respects per-mode deferral", () => {
  const r = new ToolRegistry();
  r.register(def("ToolSearch"));
  // deferred ONLY in code — must not drag ToolSearch into dispatch, where it is immediate
  r.register(def("bash", { deferred: ["code"], modes: ["code", "dispatch"] }));
  expect(r.namesForMode("code", { builtinDeferral: true }).has("ToolSearch")).toBe(true);
  expect(r.namesForMode("dispatch", { builtinDeferral: true }).has("ToolSearch")).toBe(false);
});

test("an empty array means deferred nowhere", () => {
  const r = new ToolRegistry();
  r.register(def("x", { deferred: [], modes: ["code"] }));
  expect(r.isDeferredBuiltin("x", true, "code")).toBe(false);
});
