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

  // R-T3 whole-branch review FIX 2: namesForMode excludes ToolSearch from the ordinary
  // mode-membership pass and decides it purely via anyDeferred (:100) — but namesNotForMode used
  // to have no equivalent exclusion, so a hypothetical future `modes` declaration on ToolSearch
  // itself (it declares none today) would make it satisfy namesNotForMode("code")'s plain
  // complement check and land in code's `excludeTools` (engine.ts runThread's toolAccess for a
  // plain, non-dispatch/non-chat session) — stripping ToolSearch out of code mode ENTIRELY even
  // though namesForMode("code") still (correctly) reports it eligible. Pins BOTH directions so the
  // two functions can never again disagree about ToolSearch, regardless of what `modes` it might
  // one day carry.
  test("ToolSearch's own (hypothetical) modes field never feeds namesNotForMode — it always tracks namesForMode's anyDeferred decision instead", () => {
    const r = new ToolRegistry();
    // ToolSearch declares modes NOT including "code" — the exact landmine scenario probed by the
    // review. Real ToolSearch declares no `modes` at all today; this is deliberately adversarial.
    r.register(def("ToolSearch", { modes: ["chat"] }));
    r.register(def("web_fetch", { modes: ["code"], deferred: true })); // gives code an eligible deferred tool
    // Direction 1 (unaffected by this fix, pinned anyway so a regression here is caught too):
    // namesForMode("code") still resolves ToolSearch as eligible via anyDeferred, ignoring
    // ToolSearch's own declared modes entirely.
    expect(r.namesForMode("code", { builtinDeferral: true }).has("ToolSearch")).toBe(true);
    // Direction 2 (the actual fix): namesNotForMode("code") must NOT list ToolSearch as excluded —
    // before FIX 2 this was `true`, which would strip ToolSearch out of code's excludeTools-shaped
    // toolAccess in engine.ts.
    expect(r.namesNotForMode("code").has("ToolSearch")).toBe(false);
  });
});
