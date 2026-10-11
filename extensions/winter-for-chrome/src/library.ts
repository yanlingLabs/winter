// Winter for Chrome — what it reads or saves under the user's OPTIONAL permissions (each switched on in the toolbar
// popup, never at install): `history` and `bookmarks` (read-only searches, for Winter to find a page the user means)
// and `downloads` (a file a page makes itself, which no debugger can catch, saved where Winter can take it).
//
// Each permission's API exists only while it is granted, so every door here first asks the browser whether it is;
// without it the request is refused `not_allowed` with `data.permission`, the toolbar shows a "!" and the popup offers
// the switch. Nothing here writes to history or bookmarks, opens a downloaded file, or touches a download Winter did
// not ask for: a download is Winter's only when the ARMED TAB'S OWN debugger sessions said it began
// (`Page.downloadWillBegin`, after the arm) and the browser's item has that very URL — a download the user starts from
// another tab of the same site never matches — and every other download is left exactly as the browser would have it.
import type { ChromeApi, ChromeDownloadItem, Clock } from "./chrome-api";

export type OptionalPermission = "history" | "bookmarks" | "downloads";
export const OPTIONAL_PERMISSIONS: readonly OptionalPermission[] = ["history", "bookmarks", "downloads"];

/** A refusal the controller answers with (`ExtensionError` there). */
export class LibraryRefusal extends Error {
  constructor(readonly code: "not_allowed" | "tab_gone", message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
  }
}

const NEEDS_SENTENCE: Record<OptionalPermission, string> = {
  history: "Winter for Chrome may not search this browser's history — ask the user to allow it in Winter for Chrome's menu (its toolbar button)",
  bookmarks: "Winter for Chrome may not search this browser's bookmarks — ask the user to allow it in Winter for Chrome's menu (its toolbar button)",
  downloads: "Winter for Chrome may not save files a page makes — ask the user to allow downloads in Winter for Chrome's menu (its toolbar button)",
};

const clampInt = (v: unknown, min: number, max: number, dflt: number): number =>
  (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : dflt);
/** Pages a search may name: web pages only (never `javascript:` or `data:`). */
const webUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u) && u.length <= 8_192;

function originOf(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return undefined;
  try {
    // A `blob:https://site/uuid` URL's origin is the page's that made it.
    const u = new URL(url.startsWith("blob:") ? url.slice(5) : url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch { return undefined; }
}

const baseName = (path: string): string => path.split(/[\\/]/).filter((s) => s !== "").at(-1) ?? "download";
/** A suggested file name as one path segment (the browser adds Winter's folder in front). */
function safeSegment(name: string): string {
  // eslint-disable-next-line no-control-regex
  const n = baseName(name).replace(/[\u0000-\u001f\u007f/\\:]/g, "").replace(/^\.+/, "").trim();
  return n === "" ? "download" : n.slice(0, 200);
}

interface Arm {
  tabId: number; subdir: string; until: number; maxBytes: number; origin?: string; armedAt: number; downloadId?: number; timer?: unknown;
  /** The URLs the armed tab's own pages said they began downloading after the arm (`Page.downloadWillBegin`). */
  urls: Set<string>;
  /** The progress poll while the download runs (`chrome.downloads.onChanged` carries no byte counts). */
  poll?: unknown; lastBytes?: number;
}
/** How often a running download's bytes are read for Winter (a slow file is alive while they grow). */
export const DOWNLOAD_PROGRESS_POLL_MS = 2_000;
/** How long a candidate download waits for the armed tab's `Page.downloadWillBegin` before it is left alone. */
export const HOLD_FOR_WILL_BEGIN_MS = 3_000;

type Suggest = (s?: { filename: string; conflictAction: "uniquify" }) => void;
interface Held { item: ChromeDownloadItem; suggest?: Suggest; timer: unknown }

export interface LibraryOptions {
  notify(method: string, params: Record<string, unknown>): void;
  /** The permissions Winter needed and lacked changed (the toolbar's "!" and the popup's highlighted switch). */
  onNeeds?(needs: OptionalPermission[]): void;
  clock: Clock;
  now?(): number;
  log?(line: string): void;
}

export class Library {
  private readonly arms = new Map<number, Arm>();
  private readonly needs = new Set<OptionalPermission>();
  private listening = false;

  constructor(private readonly chrome: ChromeApi, private readonly opts: LibraryOptions) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** Listen for a permission switched on (the downloads listeners need its API) or off. Call once at start. */
  start(): void {
    this.chrome.permissions.onAdded.addListener((p) => {
      for (const name of p.permissions ?? []) if (this.needs.delete(name as OptionalPermission)) this.opts.onNeeds?.([...this.needs]);
      if ((p.permissions ?? []).includes("downloads")) this.listen();
    });
    this.chrome.permissions.onRemoved.addListener((p) => {
      if (!(p.permissions ?? []).includes("downloads")) return;
      for (const tabId of [...this.arms.keys()]) this.disarm(tabId);
      // Granted again later, the browser hands out a NEW downloads API: its events must be listened to afresh.
      this.listening = false;
    });
    void this.granted("downloads").then((ok) => { if (ok) this.listen(); });
  }

  /** The permissions Winter asked for and the user has not granted (the popup highlights them). */
  needed(): OptionalPermission[] { return [...this.needs]; }

  private async granted(p: OptionalPermission): Promise<boolean> {
    try { return await this.chrome.permissions.contains({ permissions: [p] }); } catch { return false; }
  }

  private async require(p: OptionalPermission): Promise<void> {
    if (await this.granted(p)) return;
    if (!this.needs.has(p)) { this.needs.add(p); this.opts.onNeeds?.([...this.needs]); }
    throw new LibraryRefusal("not_allowed", NEEDS_SENTENCE[p], { permission: p });
  }

  // ── history and bookmarks (read only) ───────────────────────────────────────────────────────────────────────────

  async history(params: Record<string, unknown>): Promise<{ items: Array<{ url: string; title: string; lastVisitTime: number }> }> {
    await this.require("history");
    const api = this.chrome.optional().history;
    if (api === undefined) throw new LibraryRefusal("not_allowed", NEEDS_SENTENCE.history, { permission: "history" });
    const text = typeof params.text === "string" ? params.text.slice(0, 500) : "";
    const maxResults = clampInt(params.maxResults, 1, 200, 25);
    const q: { text: string; maxResults: number; startTime?: number; endTime?: number } = { text, maxResults };
    if (typeof params.startTime === "number" && Number.isFinite(params.startTime)) q.startTime = params.startTime;
    if (typeof params.endTime === "number" && Number.isFinite(params.endTime)) q.endTime = params.endTime;
    const found = await api.search(q);
    return {
      items: found.filter((i) => webUrl(i.url)).slice(0, maxResults)
        .map((i) => ({ url: i.url!, title: (i.title ?? "").slice(0, 500), lastVisitTime: Math.round(i.lastVisitTime ?? 0) })),
    };
  }

  async bookmarks(params: Record<string, unknown>): Promise<{ items: Array<{ url: string; title: string; folder: string }> }> {
    await this.require("bookmarks");
    const api = this.chrome.optional().bookmarks;
    if (api === undefined) throw new LibraryRefusal("not_allowed", NEEDS_SENTENCE.bookmarks, { permission: "bookmarks" });
    const maxResults = clampInt(params.maxResults, 1, 200, 25);
    const text = typeof params.text === "string" ? params.text.trim().slice(0, 500) : "";
    const nodes = text === "" ? await api.getRecent(maxResults) : await api.search(text);
    const folders = new Map<string, string>();
    const folderPath = async (id: string | undefined, depth = 0): Promise<string> => {
      if (id === undefined || depth > 32) return "";
      const known = folders.get(id);
      if (known !== undefined) return known;
      let node;
      try { node = (await api.get(id))[0]; } catch { node = undefined; }
      if (node === undefined) return "";
      const parent = await folderPath(node.parentId, depth + 1);
      const path = node.title === undefined || node.title === "" ? parent : parent === "" ? node.title : `${parent}/${node.title}`;
      folders.set(id, path);
      return path;
    };
    const out: Array<{ url: string; title: string; folder: string }> = [];
    for (const n of nodes) {
      if (!webUrl(n.url)) continue; // folders, javascript: and data: bookmarks are left out
      out.push({ url: n.url, title: (n.title ?? "").slice(0, 500), folder: (await folderPath(n.parentId)).slice(0, 500) });
      if (out.length >= maxResults) break;
    }
    return { items: out };
  }

  // ── downloads (a file the page makes itself) ────────────────────────────────────────────────────────────────────

  /** `downloads.arm {tabKey, subdir, until, maxBytes}` (or `subdir: null` to disarm). */
  async arm(tabId: number, tabUrl: string | undefined, params: Record<string, unknown>): Promise<void> {
    if (params.subdir === null) { this.disarm(tabId); return; }
    const subdir = params.subdir;
    if (typeof subdir !== "string" || !/^Winter\/[0-9a-f]{6,32}$/.test(subdir)) throw new LibraryRefusal("not_allowed", "downloads.arm needs Winter's own subfolder");
    await this.require("downloads");
    this.listen();
    this.disarm(tabId);
    const until = clampInt(params.until, 0, Number.MAX_SAFE_INTEGER, this.now() + 60_000);
    const maxBytes = clampInt(params.maxBytes, 1, 2 ** 40, 200 * 1024 * 1024);
    const origin = originOf(tabUrl);
    const arm: Arm = { tabId, subdir, until, maxBytes, armedAt: this.now(), urls: new Set(), ...(origin === undefined ? {} : { origin }) };
    arm.timer = this.opts.clock.setTimeout(() => this.expire(arm), Math.max(0, until - this.now()));
    this.arms.set(tabId, arm);
  }

  /** `downloads.release {id}`: the file was taken — the item leaves the browser's downloads list. */
  async release(id: unknown): Promise<void> {
    const n = typeof id === "string" && /^\d{1,12}$/.test(id) ? Number(id) : Number.NaN;
    const api = this.chrome.optional().downloads;
    if (!Number.isSafeInteger(n) || api === undefined) return;
    try { await api.erase({ id: n }); } catch { /* already gone */ }
  }

  /** The tab went away, or the link to Winter dropped: its arm goes. */
  disarm(tabId: number): void {
    const a = this.arms.get(tabId);
    if (a === undefined) return;
    this.arms.delete(tabId);
    if (a.timer !== undefined) this.opts.clock.clearTimeout(a.timer);
    if (a.poll !== undefined) this.opts.clock.clearTimeout(a.poll);
  }

  /** While the arm's download runs: its received bytes, every DOWNLOAD_PROGRESS_POLL_MS, as `progress` when they grew. */
  private schedulePoll(a: Arm): void {
    a.poll = this.opts.clock.setTimeout(() => { void this.pollProgress(a); }, DOWNLOAD_PROGRESS_POLL_MS);
  }

  private async pollProgress(a: Arm): Promise<void> {
    if (this.arms.get(a.tabId) !== a || a.downloadId === undefined) return;
    const api = this.chrome.optional().downloads;
    let item: ChromeDownloadItem | undefined;
    try { item = (await api?.search({ id: a.downloadId }))?.[0]; } catch { item = undefined; }
    if (this.arms.get(a.tabId) !== a) return;
    if (item !== undefined && item.state === "in_progress") {
      if (item.bytesReceived > a.maxBytes) {
        void api?.cancel(item.id).catch(() => undefined);
        this.tell(a, { id: String(item.id), state: "failed", name: safeSegment(item.filename), bytes: item.bytesReceived, error: "too large" });
        this.disarm(a.tabId);
        return;
      }
      if (item.bytesReceived !== a.lastBytes) {
        a.lastBytes = item.bytesReceived;
        this.tell(a, { id: String(item.id), state: "progress", name: safeSegment(item.filename), bytes: item.bytesReceived, ...(item.totalBytes > 0 ? { totalBytes: item.totalBytes } : {}) });
      }
    }
    if (item === undefined || item.state === "in_progress") this.schedulePoll(a);
  }

  disarmAll(): void { for (const tabId of [...this.arms.keys()]) this.disarm(tabId); }

  private expire(a: Arm): void {
    if (this.arms.get(a.tabId) !== a) return;
    if (a.downloadId !== undefined) {
      const api = this.chrome.optional().downloads;
      void api?.cancel(a.downloadId).catch(() => undefined);
      this.tell(a, { id: String(a.downloadId), state: "failed", name: "download", bytes: 0, error: "timed out" });
    }
    this.disarm(a.tabId);
  }

  /** Downloads created after an arm, from the armed tab's site, that no `Page.downloadWillBegin` has matched YET: held
   *  for HOLD_FOR_WILL_BEGIN_MS (their name decided then), in case the tab's word comes after the browser's item. */
  private readonly pending = new Map<number, Held>();

  /** The armed tab's own debugger session (or one of its frames') said a download began (`Page.downloadWillBegin`). */
  noteWillBegin(tabId: number, url: string): void {
    const a = this.arms.get(tabId);
    if (a === undefined || a.downloadId !== undefined || url.length === 0 || url.length > 8_192) return;
    a.urls.add(url);
    // The browser's item may have come first: one held for its name is decided now.
    for (const [id, p] of [...this.pending]) {
      if (p.item.url !== url && p.item.finalUrl !== url) continue;
      const hit = this.attribute(p.item);
      if (hit === undefined) continue;
      this.pending.delete(id);
      this.opts.clock.clearTimeout(p.timer);
      p.suggest?.({ filename: `${hit.subdir}/${safeSegment(p.item.filename)}`, conflictAction: "uniquify" });
      p.suggest = undefined;
    }
  }

  private listen(): void {
    if (this.listening) return;
    const api = this.chrome.optional().downloads;
    if (api === undefined) return;
    this.listening = true;
    api.onCreated.addListener((item) => { if (this.attribute(item) === undefined) this.hold(item); });
    api.onDeterminingFilename.addListener((item, suggest) => {
      const a = this.attribute(item);
      if (a !== undefined) { suggest({ filename: `${a.subdir}/${safeSegment(item.filename)}`, conflictAction: "uniquify" }); return; }
      const p = this.pending.get(item.id) ?? this.hold(item);
      // Every other download gets its answer at once, as the browser would have it.
      if (p === undefined) { suggest(); return; }
      p.suggest = suggest;
      return true; // answered when the tab's word comes, or as the browser would at the hold's end
    });
    api.onChanged.addListener((delta) => { void this.changed(delta); });
  }

  /** Hold a download that might still be the armed tab's (created after an arm, from its site). */
  private hold(item: ChromeDownloadItem): Held | undefined {
    const existing = this.pending.get(item.id);
    if (existing !== undefined) return existing;
    const started = Date.parse(item.startTime ?? "");
    const from = [originOf(item.url), originOf(item.finalUrl), originOf(item.referrer)];
    const candidate = [...this.arms.values()].some((a) => a.downloadId === undefined && a.origin !== undefined && from.includes(a.origin)
      && (!Number.isFinite(started) || started >= a.armedAt));
    if (!candidate) return undefined;
    const p: Held = {
      item,
      timer: this.opts.clock.setTimeout(() => {
        if (this.pending.get(item.id) !== p) return;
        this.pending.delete(item.id);
        p.suggest?.();
      }, HOLD_FOR_WILL_BEGIN_MS),
    };
    this.pending.set(item.id, p);
    return p;
  }

  /** Is this download an armed tab's? Only one whose URL the armed tab's own pages said they began downloading after
   *  the arm (`noteWillBegin`), created after the arm — no slack. */
  private attribute(item: ChromeDownloadItem): Arm | undefined {
    for (const a of this.arms.values()) if (a.downloadId === item.id) return a;
    const started = Date.parse(item.startTime ?? "");
    for (const a of this.arms.values()) {
      if (a.downloadId !== undefined) continue;
      if (Number.isFinite(started) && started < a.armedAt) continue;
      if (!a.urls.has(item.url) && !(item.finalUrl !== undefined && a.urls.has(item.finalUrl))) continue;
      a.downloadId = item.id;
      if (item.totalBytes > a.maxBytes) {
        void this.chrome.optional().downloads?.cancel(item.id).catch(() => undefined);
        this.tell(a, { id: String(item.id), state: "failed", name: safeSegment(item.filename), bytes: 0, error: "too large" });
        this.disarm(a.tabId);
        return undefined;
      }
      this.schedulePoll(a);
      this.tell(a, {
        id: String(item.id), state: "started", name: safeSegment(item.filename), bytes: 0,
        ...(item.totalBytes > 0 ? { totalBytes: item.totalBytes } : {}), ...(typeof item.mime === "string" ? { mime: item.mime } : {}),
      });
      return a;
    }
    return undefined;
  }

  private async changed(delta: { id: number; state?: { current?: string }; error?: { current?: string }; totalBytes?: { current?: number } }): Promise<void> {
    const a = [...this.arms.values()].find((x) => x.downloadId === delta.id);
    if (a === undefined) return;
    const api = this.chrome.optional().downloads;
    if (api === undefined) return;
    const total = delta.totalBytes?.current;
    if (typeof total === "number" && total > a.maxBytes) {
      void api.cancel(delta.id).catch(() => undefined);
      this.tell(a, { id: String(delta.id), state: "failed", name: "download", bytes: 0, error: "too large" });
      this.disarm(a.tabId);
      return;
    }
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    let item: ChromeDownloadItem | undefined;
    try { item = (await api.search({ id: delta.id }))[0]; } catch { item = undefined; }
    if (item === undefined) return;
    if (state === "interrupted") {
      this.tell(a, { id: String(item.id), state: "failed", name: safeSegment(item.filename), bytes: item.bytesReceived, error: (delta.error?.current ?? item.error ?? "interrupted").slice(0, 200) });
    } else {
      // Where the file came from after its redirects: Winter holds it to its dangerous-domain floor before taking it.
      const from = webUrl(item.finalUrl) ? item.finalUrl : webUrl(item.url) ? item.url : undefined;
      this.tell(a, {
        id: String(item.id), state: "done", name: baseName(item.filename), bytes: item.fileSize > 0 ? item.fileSize : item.bytesReceived, path: item.filename,
        ...(typeof item.mime === "string" ? { mime: item.mime } : {}), ...(from === undefined ? {} : { url: from }),
      });
    }
    this.disarm(a.tabId);
  }

  private tell(a: Arm, download: Record<string, unknown>): void {
    this.opts.notify("download", { tabKey: String(a.tabId), download });
  }
}

