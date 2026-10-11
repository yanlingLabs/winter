// Winter for Chrome — which tabs are Winter's ("agent tabs") and which Winter session each belongs to.
//
//  - Every tab `tabs.create` opens is an agent tab of its session, by TAB ID — whatever the user does to it: Chrome's
//    own pin (which takes a tab out of its group) and dragging it elsewhere do not make it the user's. Only `keep()`
//    (`tabs.keep`) hands it to the user for good. Winter's engine decides when an agent tab closes (at its session's
//    turn end unless marked); the extension only carries that out.
//  - Each session's agent tabs open in one tab group, "Winter · <session title>", group id → session id.
//
// The record lives in `chrome.storage.local`, so a service-worker restart AND an update of the extension (which clears
// `storage.session`) keep it: the tabs are still open, still Winter's. Tab and group ids last only as long as the browser
// session, so the record is CLEARED when the browser itself starts (the controller decides that at startup, before the
// record is read for anything): after a browser restart Winter knows none of its old tabs, and any it restores are the
// user's from then on — an old id is never mistaken for a new tab.
import type { ChromeApi } from "./chrome-api";

const STORAGE_KEY = "winterAgents";

interface Group { sessionId: string; title: string }

export class AgentBook {
  private readonly groups = new Map<number, Group>();
  private readonly tabs = new Map<number, string>();

  constructor(private readonly chrome: ChromeApi) {}

  /** Loads the record and forgets tabs and groups that no longer exist. */
  async load(): Promise<void> {
    const stored = (await this.chrome.storage.local.get([STORAGE_KEY]))[STORAGE_KEY];
    this.groups.clear();
    this.tabs.clear();
    if (typeof stored === "object" && stored !== null) {
      const { groups, tabs } = stored as { groups?: unknown; tabs?: unknown };
      if (typeof groups === "object" && groups !== null) {
        for (const [k, v] of Object.entries(groups as Record<string, unknown>)) {
          const id = Number(k);
          const e = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
          if (Number.isInteger(id) && typeof e.sessionId === "string") this.groups.set(id, { sessionId: e.sessionId, title: typeof e.title === "string" ? e.title : "" });
        }
      }
      if (typeof tabs === "object" && tabs !== null) {
        for (const [k, v] of Object.entries(tabs as Record<string, unknown>)) {
          const id = Number(k);
          if (Number.isInteger(id) && typeof v === "string") this.tabs.set(id, v);
        }
      }
    }
    let changed = false;
    for (const id of [...this.groups.keys()]) {
      try { await this.chrome.tabGroups.get(id); } catch { this.groups.delete(id); changed = true; }
    }
    for (const id of [...this.tabs.keys()]) {
      try { await this.chrome.tabs.get(id); } catch { this.tabs.delete(id); changed = true; }
    }
    if (changed) await this.save();
  }

  /** The browser started: every id in the record belonged to its previous session. */
  async clear(): Promise<void> {
    this.groups.clear();
    this.tabs.clear();
    await this.save();
  }

  /** Every agent tab's id. */
  tabIds(): number[] {
    return [...this.tabs.keys()];
  }

  /** The session an agent tab belongs to, or undefined for the user's tabs. */
  sessionOfTab(tabId: number): string | undefined {
    return this.tabs.get(tabId);
  }

  groupFor(sessionId: string): number | undefined {
    for (const [id, g] of this.groups) if (g.sessionId === sessionId) return id;
    return undefined;
  }

  isWinterGroup(groupId: number): boolean {
    return groupId >= 0 && this.groups.has(groupId);
  }

  async addTab(tabId: number, sessionId: string): Promise<void> {
    this.tabs.set(tabId, sessionId);
    await this.save();
  }

  async addGroup(groupId: number, sessionId: string, title: string): Promise<void> {
    this.groups.set(groupId, { sessionId, title });
    await this.save();
  }

  /** The tab is no longer Winter's: closed, or handed to the user. */
  async dropTab(tabId: number): Promise<void> {
    if (this.tabs.delete(tabId)) await this.save();
  }

  async dropGroup(groupId: number): Promise<void> {
    if (this.groups.delete(groupId)) await this.save();
  }

  private async save(): Promise<void> {
    await this.chrome.storage.local.set({
      [STORAGE_KEY]: {
        groups: Object.fromEntries([...this.groups].map(([id, g]) => [String(id), g])),
        tabs: Object.fromEntries([...this.tabs].map(([id, s]) => [String(id), s])),
      },
    });
  }
}

/** "Winter · <title>", the title cut to keep the group's chip readable. */
export function groupTitle(sessionTitle: string): string {
  const t = sessionTitle.trim().replace(/\s+/g, " ");
  const cut = t.length > 40 ? `${t.slice(0, 39)}…` : t;
  return cut === "" ? "Winter" : `Winter · ${cut}`;
}
