import { describe, expect, test } from "bun:test";
import { foldPanelTabs } from "../../src/panel/store";

const base = { sessionId: "s1", seq: 0, ts: 0 };

describe("foldPanelTabs", () => {
  test("open then navigate leaves the tab at its latest url", () => {
    const state = foldPanelTabs([
      { ...base, type: "panel_tab_opened", tabId: "t1", kind: "web" },
      { ...base, type: "panel_tab_navigated", tabId: "t1", url: "https://a", title: "A" },
      { ...base, type: "panel_tab_navigated", tabId: "t1", url: "https://b", title: "B" },
    ] as any);
    expect(state.tabs).toEqual([{ tabId: "t1", kind: "web", url: "https://b", title: "B" }]);
  });

  test("closing a tab removes it and clears active if it was active", () => {
    const state = foldPanelTabs([
      { ...base, type: "panel_tab_opened", tabId: "t1", kind: "web" },
      { ...base, type: "panel_tab_activated", tabId: "t1" },
      { ...base, type: "panel_tab_closed", tabId: "t1" },
    ] as any);
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeUndefined();
  });

  test("navigation for an unknown tab is ignored, not resurrecting", () => {
    const state = foldPanelTabs([
      { ...base, type: "panel_tab_navigated", tabId: "ghost", url: "https://x", title: "X" },
    ] as any);
    expect(state.tabs).toEqual([]);
  });

  test("open order is preserved", () => {
    const state = foldPanelTabs([
      { ...base, type: "panel_tab_opened", tabId: "t1", kind: "web" },
      { ...base, type: "panel_tab_opened", tabId: "t2", kind: "web" },
    ] as any);
    expect(state.tabs.map((t) => t.tabId)).toEqual(["t1", "t2"]);
  });

  test("panel_command never affects folded state", () => {
    const state = foldPanelTabs([
      { ...base, type: "panel_tab_opened", tabId: "t1", kind: "web" },
      { ...base, type: "panel_command", commandId: "c1", tabId: "t1",
        action: "navigate", url: "https://a", deadlineMs: 15000 },
    ] as any);
    // `noUncheckedIndexedAccess` is on, so `tabs[0]` is `PanelTab | undefined`. Assert the length
    // FIRST and then index optionally — `tabs[0]?.url` alone would pass vacuously on an empty array.
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.url).toBeUndefined();
  });

  // diff-tabs Task 7: `panel_tab_opened.diffId` (protocol Task 3) carried through the fold — the
  // mint-side half lives in `mintPanelTab` (panel/open-tab.ts), exercised over the real RPC in
  // test/ipc/panel-methods.test.ts; this is the PURE fold's own copy of the same guarantee.
  test("panel_tab_opened carries diffId through the fold", () => {
    const state = foldPanelTabs([
      { ...base, type: "panel_tab_opened", tabId: "t1", kind: "diff", diffId: "abc123" },
    ] as any);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.diffId).toBe("abc123");
    expect(state.tabs[0]?.kind).toBe("diff");
  });

  test("panel_tab_opened with no diffId folds with diffId left undefined (every non-diff kind)", () => {
    const state = foldPanelTabs([
      { ...base, type: "panel_tab_opened", tabId: "t1", kind: "web" },
    ] as any);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.diffId).toBeUndefined();
  });
});
