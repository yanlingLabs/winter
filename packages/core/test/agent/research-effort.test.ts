import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { createResearchRunner, RESEARCH_EFFORT } from "../../src/agent/research";
import { PageCache } from "../../src/agent/tools/page-core";
import type { ProviderEvent } from "../../src/providers/types";
import { Settings } from "../../src/settings";

// 2026-09-18: `settings.roleEfforts["pins.research"]` / `["pins.researchFallback"]` — the two research
// roles' stored efforts, spent on the sub-agent's own provider rounds. Asserted on the OUTGOING
// `TurnRequest`s; the resolver's rules are unit-tested in settings.test.ts.
//
// No network: the seed page is served by an injected `fetchFn` (page-core.test.ts's own idiom), and
// every model round is a scripted `FakeProvider` turn.

const PAGE_HTML = `<html><head><title>Bun</title></head><body><article><h1>Bun</h1><p>${"Bun is a fast JavaScript runtime. ".repeat(40)}</p></article></body></html>`;
const pageFetch = (async () => new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

const REPORT: ProviderEvent[] = [{ type: "text_delta", delta: "Bun is a runtime." }, { type: "done", stopReason: "end_turn" }];
const settingsOf = (over: Record<string, unknown>): Settings =>
  Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" }, ...over });

function runner(provider: FakeProvider, settings: () => Settings | null) {
  // A fresh cache per runner so no run is answered from another's page.
  return createResearchRunner({ provider, settings, cache: new PageCache(), fetchFn: pageFetch });
}
const ask = { url: "https://example.com/bun", query: "what is bun" };

describe("research: the pins.research / pins.researchFallback role efforts", () => {
  test("absent → RESEARCH_EFFORT, raw, exactly as before", async () => {
    const provider = new FakeProvider([REPORT]);
    await runner(provider, () => settingsOf({})).run(ask, {});
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.reasoningEffort).toBe(RESEARCH_EFFORT);
  });

  test("a stored effort the pin's model offers reaches the request", async () => {
    const provider = new FakeProvider([REPORT]);
    await runner(provider, () => settingsOf({ roleEfforts: { "pins.research": "low" } })).run(ask, {});
    expect(provider.requests[0]!.reasoningEffort).toBe("low");
  });

  test("a stored effort the pin's model does NOT offer is mapped or omitted — research still answers", async () => {
    const mapped = new FakeProvider([REPORT]);
    const out = await runner(mapped, () => settingsOf({ pins: { research: "openai/o4-mini" }, roleEfforts: { "pins.research": "max" } })).run(ask, {});
    expect(out).toContain("Bun is a runtime.");
    expect(mapped.requests[0]!.model).toBe("o4-mini");
    expect(mapped.requests[0]!.reasoningEffort).toBe("medium"); // the row's own defaultEffort

    const omitted = new FakeProvider([REPORT]);
    await runner(omitted, () => settingsOf({ pins: { research: "openai/gpt-5.4" }, roleEfforts: { "pins.research": "high" } })).run(ask, {});
    expect(omitted.requests[0]!.model).toBe("gpt-5.4");
    expect("reasoningEffort" in omitted.requests[0]!).toBe(false);
  });

  test("the effort FOLLOWS the fallback switch: the retried round runs at pins.researchFallback's effort, mapped onto ITS row", async () => {
    // Round 1 fails as an unknown model → the same round is retried on the fallback pin.
    const badModel: ProviderEvent[] = [{ type: "error", code: "bad_request", message: "The model `gpt-5.6-luna` does not exist", retryable: false } as ProviderEvent];
    const provider = new FakeProvider([badModel, REPORT]);
    const settings = settingsOf({
      pins: { research: "openai/gpt-5.6-luna", researchFallback: "openai/o4-mini" },
      roleEfforts: { "pins.research": "xhigh", "pins.researchFallback": "high" },
    });
    await runner(provider, () => settings).run(ask, {});
    expect(provider.requests.map((r) => [r.model, r.reasoningEffort])).toEqual([["gpt-5.6-luna", "xhigh"], ["o4-mini", "high"]]);

    // With only the PRIMARY's effort stored, the fallback keeps today's default — one role's effort is not the other's.
    const provider2 = new FakeProvider([badModel, REPORT]);
    const settings2 = settingsOf({ pins: { research: "openai/gpt-5.6-luna", researchFallback: "openai/o4-mini" }, roleEfforts: { "pins.research": "xhigh" } });
    await runner(provider2, () => settings2).run(ask, {});
    expect(provider2.requests.map((r) => r.reasoningEffort)).toEqual(["xhigh", RESEARCH_EFFORT]);
  });

  test("a settings change lands on the NEXT run of the SAME runner — no restart", async () => {
    const provider = new FakeProvider([REPORT]);
    let live: Settings = settingsOf({});
    const r = createResearchRunner({ provider, settings: () => live, cache: new PageCache(), fetchFn: pageFetch });
    await r.run(ask, {});
    live = settingsOf({ roleEfforts: { "pins.research": "medium" } });
    await r.run(ask, {});
    expect(provider.requests.map((q) => q.reasoningEffort)).toEqual([RESEARCH_EFFORT, "medium"]);
  });
});
