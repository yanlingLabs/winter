// Winter for Chrome — the Winter tab groups: one per Winter session ("Winter · <session title>"), group id → session id,
// kept in `chrome.storage.local` so a service-worker restart still knows which tabs are Winter's. A tab in one of these
// groups is an agent tab; taking it out of the group (`keep()`, or the user dragging it out) makes it the user's.
//
// Group ids live as long as the browser session: after a browser restart Chrome restores groups under new ids, so the
// old entries are pruned at load and those tabs read as the user's from then on.
import type { ChromeApi } from "./chrome-api";

const STORAGE_KEY = "winterGroups";

interface Entry { sessionId: string; title: string }

export class GroupBook {
  private readonly groups = new Map<number, Entry>();

  constructor(private readonly chrome: ChromeApi) {}

  async load(): Promise<void> {
    const stored = (await this.chrome.storage.get([STORAGE_KEY]))[STORAGE_KEY];
    this.groups.clear();
    if (typeof stored === "object" && stored !== null) {
      for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
        const id = Number(k);
        if (!Number.isInteger(id) || typeof v !== "object" || v === null) continue;
        const { sessionId, title } = v as Record<string, unknown>;
        if (typeof sessionId === "string") this.groups.set(id, { sessionId, title: typeof title === "string" ? title : "" });
      }
    }
    let pruned = false;
    for (const id of [...this.groups.keys()]) {
      try {
        await this.chrome.tabGroups.get(id);
      } catch {
        this.groups.delete(id);
        pruned = true;
      }
    }
    if (pruned) await this.save();
  }

  sessionOf(groupId: number): string | undefined {
    return groupId < 0 ? undefined : this.groups.get(groupId)?.sessionId;
  }

  groupFor(sessionId: string): number | undefined {
    for (const [id, e] of this.groups) if (e.sessionId === sessionId) return id;
    return undefined;
  }

  async set(groupId: number, sessionId: string, title: string): Promise<void> {
    this.groups.set(groupId, { sessionId, title });
    await this.save();
  }

  async drop(groupId: number): Promise<void> {
    if (this.groups.delete(groupId)) await this.save();
  }

  private async save(): Promise<void> {
    await this.chrome.storage.set({ [STORAGE_KEY]: Object.fromEntries([...this.groups].map(([id, e]) => [String(id), e])) });
  }
}

/** "Winter · <title>", the title cut to keep the group's chip readable. */
export function groupTitle(sessionTitle: string): string {
  const t = sessionTitle.trim().replace(/\s+/g, " ");
  const cut = t.length > 40 ? `${t.slice(0, 39)}…` : t;
  return cut === "" ? "Winter" : `Winter · ${cut}`;
}
