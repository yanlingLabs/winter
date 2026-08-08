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
