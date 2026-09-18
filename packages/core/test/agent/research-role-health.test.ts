import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../src/agent/fake-provider";
import { createResearchRunner } from "../../src/agent/research";
import { PageCache } from "../../src/agent/tools/page-core";
import type { ProviderEvent } from "../../src/providers/types";
import { RoleHealthRegistry } from "../../src/providers/role-health";
import { Settings } from "../../src/settings";

// 2026-09-18: role-health wiring for the two research roles (pins.research / pins.researchFallback)
// — OBSERVATION ONLY, mirrors research-effort.test.ts's own harness shape.

const PAGE_HTML = `<html><head><title>Bun</title></head><body><article><h1>Bun</h1><p>${"Bun is a fast JavaScript runtime. ".repeat(40)}</p></article></body></html>`;
const pageFetch = (async () => new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

const REPORT: ProviderEvent[] = [{ type: "text_delta", delta: "Bun is a runtime." }, { type: "done", stopReason: "end_turn" }];
const settingsOf = (over: Record<string, unknown>): Settings =>
  Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" }, ...over });
const ask = { url: "https://example.com/bun", query: "what is bun" };

function newRegistry(): RoleHealthRegistry {
  return new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-research-rh-")));
}

describe("research role-health wiring", () => {
  test("a plain provider error (no fallback trigger) records pins.research under the tag that ran, and STILL throws the pre-existing 'provider error' failure", async () => {
    const roleHealth = newRegistry();
    // `bad_request` with a message that does NOT match `looksLikeBadModelError`'s patterns — no
    // fallback swap, same as before this feature.
    const provider = new FakeProvider([[{ type: "error", code: "bad_request", providerCode: "invalid_argument", message: "malformed tool call arguments" }]]);
    const runnerDeps = { provider, settings: () => settingsOf({}), cache: new PageCache(), fetchFn: pageFetch, roleHealth };
    await expect(createResearchRunner(runnerDeps).run(ask, {})).rejects.toThrow(/provider error/);
    // pins.research's DEFAULT is the "luna" facing name for the daemon's own provider
    // (`pinsFor`'s own doc comment) — NOT `settings.provider.model` verbatim.
    const problem = roleHealth.problemFor("pins.research", "openai/gpt-5.6-luna");
    expect(problem).not.toBeNull();
    expect(problem?.reason).toBe("other");
  });

  test("a round that fails and THEN falls back records the PRIMARY role, not the fallback — the round that actually ran it failed as pins.research", async () => {
    const roleHealth = newRegistry();
    const badModel: ProviderEvent = { type: "error", code: "bad_request", message: "The model `gpt-5.6-luna` does not exist" };
    const provider = new FakeProvider([[badModel], REPORT]);
    const settings = settingsOf({ pins: { research: "openai/gpt-5.6-luna", researchFallback: "openai/o4-mini" } });
    const out = await createResearchRunner({ provider, settings: () => settings, cache: new PageCache(), fetchFn: pageFetch, roleHealth }).run(ask, {});
    expect(out).toContain("Bun is a runtime.");
    // The primary role's failing round is recorded — "bad_request" with no recognised providerCode -> "other".
    expect(roleHealth.problemFor("pins.research", "openai/gpt-5.6-luna")).not.toBeNull();
    // The fallback round that actually SUCCEEDED clears its own role (it never failed).
    expect(roleHealth.problemFor("pins.researchFallback", "openai/o4-mini")).toBeNull();
  });

  test("a following successful run clears a previously recorded note for the same role", async () => {
    const roleHealth = newRegistry();
    roleHealth.recordFailure("pins.research", "openai/gpt-5.6-luna", { reason: "rate-limited", detail: "stale" });
    const provider = new FakeProvider([REPORT]);
    await createResearchRunner({ provider, settings: () => settingsOf({}), cache: new PageCache(), fetchFn: pageFetch, roleHealth }).run(ask, {});
    expect(roleHealth.problemFor("pins.research", "openai/gpt-5.6-luna")).toBeNull();
  });

  test("no roleHealth wired (every pre-existing construction) -> unchanged", async () => {
    const provider = new FakeProvider([[{ type: "error", code: "server", message: "500" }]]);
    await expect(createResearchRunner({ provider, settings: () => settingsOf({}), cache: new PageCache(), fetchFn: pageFetch }).run(ask, {})).rejects.toThrow(/provider error/);
  });
});
