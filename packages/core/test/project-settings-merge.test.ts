import { describe, expect, test } from "bun:test";
import { mergeSettings } from "../src/project-settings";
import { Settings } from "../src/settings";

/** Minimal valid Settings — schemaVersion literal 2 + a valid ProviderSettings variant
 *  (codex-oauth requires only a non-empty model; reasoningEffort/baseUrl etc are optional). */
function minimalBase(overrides: Record<string, unknown> = {}): Settings {
  return Settings.parse({
    schemaVersion: 2,
    provider: { type: "codex-oauth", model: "x" },
    ...overrides,
  });
}

describe("mergeSettings", () => {
  describe("basic merge semantics", () => {
    test("empty overlays array returns base unchanged", () => {
      const base = minimalBase({ permissions: { allow: ["Computer"] } });
      expect(mergeSettings(base, [])).toEqual(base);
    });

    test("scalar override: overlay reviewer.enabled false wins over base true", () => {
      const base = minimalBase({ reviewer: { enabled: true } });
      const merged = mergeSettings(base, [{ reviewer: { enabled: false } }]);
      expect(merged.reviewer?.enabled).toBe(false);
    });

    test("provider and plugins keys in an overlay are ignored — base's provider/plugins survive", () => {
      const base = minimalBase({ plugins: { enabled: ["safe-plugin"] } });
      const merged = mergeSettings(base, [
        {
          provider: { type: "openai-compatible", model: "evil", baseUrl: "https://evil.example" },
          plugins: { enabled: ["evil-plugin"] },
        },
      ]);
      expect(merged.provider).toEqual(base.provider);
      expect(merged.plugins).toEqual({ enabled: ["safe-plugin"] });
    });

    test("an overlay that would produce an invalid Settings is rejected — returns base unchanged (fail-safe)", () => {
      const base = minimalBase();
      // subagents.maxDepth is capped at 5 by the schema — 99 makes the merged object invalid.
      const merged = mergeSettings(base, [{ subagents: { maxDepth: 99 } }]);
      expect(merged).toEqual(base);
      expect(merged.subagents).toBeUndefined();
    });
  });

  describe("permission array unions", () => {
    test("permissions.allow unions base + one overlay — BOTH survive, deduped (the exact case a naive union-after-replace implementation loses)", () => {
      const base = minimalBase({ permissions: { allow: ["Computer"] } });
      const merged = mergeSettings(base, [{ permissions: { allow: ["Bash(ls:*)"] } }]);
      expect(merged.permissions?.allow).toEqual(["Computer", "Bash(ls:*)"]);
    });

    test("permissions.allow unions across three layers (user < project < local, all contribute)", () => {
      const base = minimalBase({ permissions: { allow: ["Computer"] } });
      const merged = mergeSettings(base, [
        { permissions: { allow: ["Bash(ls:*)"] } },
        { permissions: { allow: ["Edit(/tmp)"] } },
      ]);
      expect(merged.permissions?.allow).toEqual(["Computer", "Bash(ls:*)", "Edit(/tmp)"]);
    });

    test("permissions.allow union dedups an entry repeated across layers", () => {
      const base = minimalBase({ permissions: { allow: ["Computer"] } });
      const merged = mergeSettings(base, [{ permissions: { allow: ["Computer", "Bash(ls:*)"] } }]);
      expect(merged.permissions?.allow).toEqual(["Computer", "Bash(ls:*)"]);
    });

    test("permissions.additionalDirectories unions across layers", () => {
      const base = minimalBase({ permissions: { additionalDirectories: ["/opt/base"] } });
      const merged = mergeSettings(base, [{ permissions: { additionalDirectories: ["/opt/overlay"] } }]);
      expect(merged.permissions?.additionalDirectories).toEqual(["/opt/base", "/opt/overlay"]);
    });

    test("permissions.dangerousDomains.added unions across layers", () => {
      const base = minimalBase({ permissions: { dangerousDomains: { added: ["a.com"] } } });
      const merged = mergeSettings(base, [{ permissions: { dangerousDomains: { added: ["b.com"] } } }]);
      expect(merged.permissions?.dangerousDomains?.added).toEqual(["a.com", "b.com"]);
    });

    test("an overlay that doesn't touch permissions.allow leaves base's value exactly as it was", () => {
      const base = minimalBase({ permissions: { allow: ["Computer"] } });
      const merged = mergeSettings(base, [{ reviewer: { enabled: false } }]);
      expect(merged.permissions?.allow).toEqual(["Computer"]);
    });

    test("fix-wave F (M3): a non-string entry in an overlay's permissions.allow is DROPPED, not coerced to a string", () => {
      const base = minimalBase();
      const evil = JSON.parse('{"permissions":{"allow":[123,"Bash(ls:*)"]}}');
      const merged = mergeSettings(base, [evil]);
      expect(merged.permissions?.allow).toEqual(["Bash(ls:*)"]); // "123" never appears
      expect(Settings.safeParse(merged).success).toBe(true);
    });
  });

  describe("prototype-pollution guard", () => {
    test("a top-level __proto__ payload does not pollute Object.prototype", () => {
      const base = minimalBase();
      // JSON.parse gives an OWN "__proto__" data property (not a real prototype change) — this
      // is exactly the repo-controlled-file shape mergeSettings must defend against.
      const evil = JSON.parse('{"__proto__":{"polluted":true}}');
      const merged = mergeSettings(base, [evil]);
      expect(({} as any).polluted).toBeUndefined();
      expect(Settings.safeParse(merged).success).toBe(true);
    });

    test("a nested __proto__ payload (under permissions, which base already has as an object — forcing deepAssign to recurse) does not pollute Object.prototype", () => {
      const base = minimalBase({ permissions: { allow: ["Computer"] } });
      const evil = JSON.parse('{"permissions":{"__proto__":{"polluted":true}}}');
      const merged = mergeSettings(base, [evil]);
      expect(({} as any).polluted).toBeUndefined();
      expect(merged.permissions?.allow).toEqual(["Computer"]); // untouched by the dropped key
    });
  });

  describe("resilience (fix-wave G / M2): one bad overlay must not discard the others", () => {
    test("base + an invalid project overlay (reviewer.enabled as a string) + a valid local overlay (permissions.allow) -> the bad key is dropped, the good overlay's effect survives", () => {
      const base = minimalBase();
      const badProjectOverlay = JSON.parse('{"reviewer":{"enabled":"yes"}}'); // enabled must be boolean — invalid
      const goodLocalOverlay = { permissions: { allow: ["Bash(ls:*)"] } };
      const merged = mergeSettings(base, [badProjectOverlay, goodLocalOverlay]);
      expect(merged.reviewer?.enabled).toBeUndefined(); // the bad overlay never landed
      expect(merged.permissions?.allow).toEqual(["Bash(ls:*)"]); // the LATER good overlay still applied
    });

    test("the reverse order (good overlay first, bad one second) — the good overlay's effect still survives, the bad one is skipped", () => {
      const base = minimalBase();
      const goodLocalOverlay = { permissions: { allow: ["Bash(ls:*)"] } };
      const badProjectOverlay = JSON.parse('{"reviewer":{"enabled":"yes"}}');
      const merged = mergeSettings(base, [goodLocalOverlay, badProjectOverlay]);
      expect(merged.permissions?.allow).toEqual(["Bash(ls:*)"]);
      expect(merged.reviewer?.enabled).toBeUndefined();
    });

    test("a single bad overlay with no others still fails safe to base (unchanged pre-existing behavior)", () => {
      const base = minimalBase();
      const merged = mergeSettings(base, [{ subagents: { maxDepth: 99 } }]);
      expect(merged).toEqual(base);
    });
  });

  describe("clone semantics", () => {
    test("overlay sub-objects are cloned, not aliased — mutating the overlay after merging does not corrupt the merged result", () => {
      const base = minimalBase();
      const overlay: { reviewer: { model: string } } = { reviewer: { model: "shared-model" } };
      const merged = mergeSettings(base, [overlay]);
      overlay.reviewer.model = "MUTATED-AFTER-MERGE";
      expect(merged.reviewer?.model).toBe("shared-model");
    });
  });
});
