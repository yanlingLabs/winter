import type { SessionEvent } from "@norma/protocol";

export type PanelTab = { tabId: string; kind: string; url?: string; title?: string };
export type PanelTabState = { tabs: PanelTab[]; activeTabId?: string };

/** PURE: rebuild tab state by replaying persisted panel events in order.
 *
 *  `panel_command` is deliberately absent from this switch — it is transient, never persisted, and
 *  carries no state. A command that changed the fold would mean the same navigation was recorded
 *  twice: once as intent, once as the reported fact. */
export function foldPanelTabs(events: readonly SessionEvent[]): PanelTabState {
  const tabs: PanelTab[] = [];
  let activeTabId: string | undefined;

  for (const e of events) {
    switch (e.type) {
      case "panel_tab_opened":
        if (!tabs.some((t) => t.tabId === e.tabId)) {
          tabs.push({ tabId: e.tabId, kind: e.kind, url: e.url, title: e.title });
        }
        break;
      case "panel_tab_closed": {
        const i = tabs.findIndex((t) => t.tabId === e.tabId);
        if (i >= 0) tabs.splice(i, 1);
        if (activeTabId === e.tabId) activeTabId = undefined;
        break;
      }
      case "panel_tab_activated":
        if (tabs.some((t) => t.tabId === e.tabId)) activeTabId = e.tabId;
        break;
      case "panel_tab_navigated": {
        const t = tabs.find((t) => t.tabId === e.tabId);
        // An unknown tab is ignored rather than created: navigation is a fact ABOUT a tab, and
        // resurrecting a closed one would make a stale in-flight report undo a close.
        if (t) { t.url = e.url; t.title = e.title; }
        break;
      }
    }
  }
  return { tabs, activeTabId };
}

/** PURE: does this session currently HOLD an open tab? Shared by both auto-delete doors — the
 *  reaper's `emptySessionIds` (sessions/store.ts) and the cleaner's `railFor` (sessions/cleaner.ts)
 *  — so "has tabs" has exactly one definition (panel-shell T16). Before this the two disagreed: the
 *  reaper scanned for the bare `panel_tab_opened` event's presence ("ever opened one") while the
 *  cleaner folded ("holds one now"), so a session that opened a tab and later closed it was
 *  reaper-immune but cleaner-eligible — permanent litter with zero content.
 *
 *  Deliberately a FOLD (`foldPanelTabs` above — the same replay `panel.list` reads), never a scan
 *  for the raw `panel_tab_opened` event. A session that opened a tab and later closed it holds none,
 *  and a presence check cannot see that: it would spare/rail the session forever, on the transcript
 *  it carried the DAY it closed its last tab, with no future event able to lift that (closing a tab
 *  does not remove the earlier `panel_tab_opened` line from history). Folding reads what the session
 *  holds NOW, so eligibility resumes the moment there is nothing left to lose.
 *
 *  Lives here rather than in either door's own file so the two can share ONE definition without a
 *  cycle: this file imports only `SessionEvent` from `@norma/protocol`, so both `sessions/store.ts`
 *  and `sessions/cleaner.ts` (which already imports `SYNCED_SESSION_ID_RE` from `./store`) can import
 *  from here with no path back. */
export function hasOpenPanelTabs(events: readonly SessionEvent[]): boolean {
  return foldPanelTabs(events).tabs.length > 0;
}
