// ComputerV2 (2026-10-08) — the apps ComputerV2 has used recently, by bundle id: name + lastUsedAt. Settings →
// Computer Use lists every app that has a setting PLUS these (`computerUse.apps.list`), so the user can restrict
// an app the agent touched without first finding its bundle id. Kept in `<home>/computer-use/recent-apps.json`,
// at most 50 apps, written best-effort (a failed write never fails a script).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RECENT_APPS_MAX = 50;

export interface RecentApp { bundleId: string; name: string; lastUsedAt: number }

export class RecentApps {
  private readonly path: string;
  private loaded: Map<string, RecentApp> | undefined;

  constructor(home: string, private readonly now: () => number = Date.now) {
    this.path = join(home, "computer-use", "recent-apps.json");
  }

  private load(): Map<string, RecentApp> {
    if (this.loaded !== undefined) return this.loaded;
    const m = new Map<string, RecentApp>();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const r of raw) {
          if (r !== null && typeof r === "object" && typeof (r as RecentApp).bundleId === "string" && typeof (r as RecentApp).name === "string" && typeof (r as RecentApp).lastUsedAt === "number") {
            m.set((r as RecentApp).bundleId, { bundleId: (r as RecentApp).bundleId, name: (r as RecentApp).name, lastUsedAt: (r as RecentApp).lastUsedAt });
          }
        }
      }
    } catch { /* absent or unreadable: start empty */ }
    this.loaded = m;
    return m;
  }

  note(bundleId: string, name: string): void {
    const m = this.load();
    m.delete(bundleId);
    m.set(bundleId, { bundleId, name, lastUsedAt: this.now() });
    while (m.size > RECENT_APPS_MAX) m.delete(m.keys().next().value!);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify([...m.values()], null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch { /* best effort */ }
  }

  list(): RecentApp[] {
    return [...this.load().values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }
}
