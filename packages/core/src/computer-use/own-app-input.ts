// ComputerV2 — wake triggers ACROSS BACKENDS: Winter's own HELPER input to an app, per bundle id, from any session.
//
// A browser bound as an APP (`apps.open("Google Chrome")`) takes the helper's clicks and keys — and inside its page those
// arrive as TRUSTED DOM events, exactly like the user's. A tab wake trigger on that browser (the browser backend) must
// never take them for the user's action, so it asks `ownAppInputAt(bundleId, at)` (`BrowserEngineDeps.ownAppInputAt`)
// alongside its own record of what the engine sent the tab. The same rule as the tab's own (`TabDriver.ownInputAt`):
// input in flight at `at`, or one that ended at most `WAKE_LIMITS.ownInputGraceMs` before it; 50 ms of slack before a
// start for the page's clock.
//
// The reverse — the engine's input to a Chromium browser that a helper watch also watches — never arises: an app watch
// on a browser the engine drives tab by tab is refused (`AppWakeBackend.arm`, the browser families' bundle ids).
import { WAKE_LIMITS } from "./wakes/types";

interface BundleInput {
  depth: number;
  start: number;
  /** Closed windows [start, end], oldest first. */
  windows: Array<[number, number]>;
}

/** How long a closed window is kept, and how many per bundle. */
const KEEP_MS = 60_000;
const KEEP_WINDOWS = 32;
/** How far before an input's start an event may still be stamped (a page's clock against the daemon's). */
const START_SLACK_MS = 50;

export class OwnAppInput {
  private readonly byBundle = new Map<string, BundleInput>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Winter's input to `bundleId` starts; the returned function ends it (idempotent). */
  begin(bundleId: string): () => void {
    const t = this.now();
    this.prune(t);
    const key = bundleId.toLowerCase();
    let b = this.byBundle.get(key);
    if (b === undefined) { b = { depth: 0, start: t, windows: [] }; this.byBundle.set(key, b); }
    if (b.depth++ === 0) b.start = t;
    const entry = b;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (entry.depth === 0 || --entry.depth > 0) return;
      const end = this.now();
      entry.windows.push([entry.start, end]);
      while (entry.windows.length > KEEP_WINDOWS || (entry.windows.length > 0 && end - entry.windows[0]![1] > KEEP_MS)) entry.windows.shift();
    };
  }

  /** Was Winter's input to this app in flight at `at` (epoch ms), or did it end at most the grace before? */
  at(bundleId: string, at: number): boolean {
    const b = this.byBundle.get(bundleId.toLowerCase());
    if (b === undefined || !Number.isFinite(at)) return false;
    if (b.depth > 0 && at >= b.start - START_SLACK_MS) return true;
    const grace = WAKE_LIMITS.ownInputGraceMs;
    return b.windows.some(([start, end]) => at >= start - START_SLACK_MS && at <= end + grace);
  }

  /** Bundles with nothing in flight whose last window is older than `KEEP_MS` go. */
  private prune(t: number): void {
    for (const [key, b] of this.byBundle) {
      if (b.depth === 0 && (b.windows.length === 0 || t - b.windows.at(-1)![1] > KEEP_MS)) this.byBundle.delete(key);
    }
  }
}
