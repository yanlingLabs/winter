// ComputerV2 Phase 3 — browsers.history() / browsers.bookmarks(): read-only searches of a user's browser, checked as a
// bind of the browser and refused until the user grants Winter for Chrome's optional permission; redacted, fenced.
import { describe, expect, test } from "bun:test";
import { AutomationFailure } from "../../src/computer-use/errors";
import { harness } from "./browser-harness";

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

describe("browsers.history()", () => {
  test("searches the named browser, 90 days back by default; URLs and titles redacted; printed fenced", async () => {
    const h = harness();
    h.chrome.historyItems = [
      { url: "https://flights.example/search?token=sk-abcdefghijklmnopqrstuvwx", title: "Flights to ZRH", lastVisitTime: Date.UTC(2026, 9, 10) },
      { url: "https://news.example/", title: "News", lastVisitTime: Date.UTC(2026, 9, 9) },
    ];
    const r = h.run();
    const rows = await h.engine.global(r.scope, "browsers.history", { browser: "chrome", query: "Flights" }) as Array<{ url: string; title: string; visited: string; browser: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ browser: "chrome", title: "Flights to ZRH", visited: "2026-10-10T00:00:00.000Z" });
    expect(rows[0]!.url).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    const q = h.chrome.libraryQueries[0] as { history: { text: string; startTime: number; maxResults: number } };
    expect(q.history).toMatchObject({ text: "Flights", maxResults: 25 });
    expect(Date.now() - q.history.startTime).toBeGreaterThan(89 * 24 * 3_600_000);
    expect(r.text()).toMatch(/<screen-data id="[0-9a-f]+">[\s\S]*"Flights to ZRH"/);
    await expect(h.engine.global(r.scope, "browsers.history", { browser: "chrome", from: "not a date" })).rejects.toThrow(/from is a date/);
    await expect(h.engine.global(r.scope, "browsers.history", { browser: "chrome", limit: 500 })).rejects.toThrow(/limit is a whole number 1–200/);
    r.end();
  });

  test("the permission not granted: NotAllowed with the extension's sentence; the built-in browser has none; an old extension says update", async () => {
    const h = harness();
    h.chrome.granted.delete("history");
    const r = h.run();
    const e = await failure(h.engine.global(r.scope, "browsers.history", { browser: "chrome" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(e.message).toMatch(/ask the user to allow it in Winter for Chrome's menu/);
    await expect(h.engine.global(r.scope, "browsers.history", { browser: "winter" })).rejects.toThrow(/keeps no history or bookmarks/);
    delete h.chrome.history;
    expect((await failure(h.engine.global(r.scope, "browsers.history", { browser: "chrome" })) as AutomationFailure).kind).toBe("BrowserUnavailable");
    r.end();
  });

  test("checked as a bind: under ask, the per-app card is raised first", async () => {
    const h = harness({ policy: "ask" });
    const r = h.run();
    const pending = h.engine.global(r.scope, "browsers.history", { browser: "chrome" });
    await new Promise((res) => setTimeout(res, 10));
    expect(h.cards.map((c) => c.summary)).toEqual(["Allow Winter to use Google Chrome (com.google.Chrome)?"]);
    r.end();
    await pending.catch(() => undefined);
  });
});

describe("browsers.bookmarks()", () => {
  test("a search with each bookmark's folder; no browser named reads the ones this session allowed", async () => {
    const h = harness();
    h.chrome.bookmarkItems = [
      { url: "https://papers.example/1", title: "A paper", folder: "Bookmarks Bar/Research" },
      { url: "https://other.example/", title: "Other", folder: "Other" },
    ];
    const r = h.run();
    // bypass: the browser is allowed in this session without a card.
    const rows = await h.engine.global(r.scope, "browsers.bookmarks", { query: "paper" }) as Array<{ browser: string; url: string; title: string; folder: string }>;
    expect(rows).toEqual([{ browser: "chrome", url: "https://papers.example/1", title: "A paper", folder: "Bookmarks Bar/Research" }]);
    expect(r.text()).toContain('"A paper" https://papers.example/1 · "Bookmarks Bar/Research"');
    r.end();
  });
});
