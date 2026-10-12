// Winter for Chrome 1.2.0 — WAKE TRIGGERS' watches, with NO debugger (feature `watch`).
//
// Winter can wait for the user to do something in a tab — click a button, submit a form, change a field, or for a text
// or a title to show — and wake its session when they do. While it waits, Winter for Chrome holds no debugger on the
// tab (so the browser shows no "is debugging this browser" bar): Winter reads the element once, while it is attached,
// into a LOCATOR, and the extension injects the page watcher (`page-runtime/watch.ts`, the daemon's own source, bundled
// in) with `chrome.scripting.executeScript` into ITS OWN isolated world — never the page's main world, never Winter's
// "winter" world, and never as a declared content script — in the tab's top frame. It injects it again into each new
// document of the tab (`tabs.onUpdated` "complete"): a page condition carries on there (a document the extension's own
// debugger input or navigation brought is only its new baseline), an element's watch reports that its document went.
//
// An element's watch is never left silent: a load that never completes is looked at 10 s after it began, a page that
// takes no script (a browser page, a store page) loses it at once, and a tab whose watcher stops being heard from (a
// renderer that crashed) is looked at after a minute of silence. (`tabs.onUpdated` says "loading" for a same-document
// change too — a pushState, a new fragment — so "loading" alone never loses one: the injection after it tells.)
//
// What the watcher reports reaches the extension as a runtime message from that world (`winter.wake.event`; the page
// itself cannot send one — no `externally_connectable`), and the extension relays it to Winter (`watch.event`): which
// watch, what happened, when, the top document's origin and path and, for a title watch, the title — and for a watch of
// the address, a digest of it and whether it holds the words Winter waits for (matched here). Never what the user typed
// (a GET form's values ride an address's query, which never leaves). The extension also says whether its own debugger
// sent the tab input or a navigation within 500 ms before (`own`) — of the event, or of the user's input that made a
// submit or a change theirs (`cause`): Winter never counts its own input as the user's. A watch the extension no longer
// knows (a worker restart, the link to Winter dropped) is taken down by the watcher itself at its next heartbeat
// (`winter.wake.alive`).
import { wakeWatcher, watchUrlKey, watchUrlShape, type WatchArmResult, type WatchSpec } from "../../../packages/core/src/computer-use/browser/page-runtime/watch";
import { realClock, type ChromeApi, type Clock, type MessageSender } from "./chrome-api";
import { attachRefusal } from "./urls";

/** Input or a navigation the extension's debugger sent a tab is its own for this long after. */
export const OWN_INPUT_GRACE_MS = 500;
/** A load that began this long ago and never completed: its tab's watches are looked at anyway. */
export const LOAD_STALL_MS = 10_000;
/** A tab whose watcher has not been heard from for this long (its heartbeat comes every 20 s — every minute in a
 *  background tab the browser throttles): looked at. */
export const WATCH_SILENCE_MS = 65_000;
const WATCH_ID = /^wk_[0-9a-f]{12}$/;
const KINDS = new Set(["clicked", "submitted", "appeared", "gone", "changed", "titled", "navigated"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A refusal the controller turns into its typed error (`not_allowed` with `data.reason`). */
export class WatchRefusal extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "WatchRefusal";
  }
}

export interface WatchBookOptions {
  notify(method: string, params: Record<string, unknown>): void;
  now?(): number;
  clock?: Clock;
  log?(line: string): void;
}

export class WatchBook {
  private readonly tabs = new Map<number, Map<string, WatchSpec>>();
  private readonly stamps = new Map<number, { inFlight: number; start: number; end: number }>();
  /** Per tab: whether the navigation in progress came from the extension's own debugger (its new document is a baseline). */
  private readonly navOwn = new Map<number, boolean>();
  /** Per tab: when its last load began (an element's document went then), and the look taken if it never completes. */
  private readonly loadingAt = new Map<number, number>();
  private readonly stalls = new Map<number, unknown>();
  /** Per tab: the look taken when its watcher falls silent. */
  private readonly silences = new Map<number, unknown>();
  private readonly clock: Clock;

  constructor(private readonly chrome: ChromeApi, private readonly opts: WatchBookOptions) {
    this.clock = opts.clock ?? realClock;
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** Call once, synchronously at the worker's top level (with the controller's other listeners). */
  start(): void {
    this.chrome.tabs.onUpdated.addListener((tabId, info) => this.onUpdated(tabId, info));
  }

  /** How many watches the extension keeps now. */
  count(): number { let n = 0; for (const m of this.tabs.values()) n += m.size; return n; }

  // ── the extension's own input ─────────────────────────────────────────────────────────────────────────────────────

  inputStart(tabId: number): void {
    const s = this.stamps.get(tabId);
    if (s === undefined) this.stamps.set(tabId, { inFlight: 1, start: this.now(), end: -Infinity });
    else { if (s.inFlight === 0) s.start = this.now(); s.inFlight++; }
  }

  inputEnd(tabId: number): void {
    const s = this.stamps.get(tabId);
    if (s === undefined || s.inFlight === 0) return;
    s.inFlight--;
    if (s.inFlight === 0) s.end = this.now();
  }

  /** Did the extension's debugger send the tab input or a navigation at `at`, or within the grace before it? */
  own(tabId: number, at: number): boolean {
    const s = this.stamps.get(tabId);
    if (s === undefined) return false;
    if (s.inFlight > 0 && at >= s.start - 50) return true;
    return at >= s.start - 50 && at <= s.end + OWN_INPUT_GRACE_MS;
  }

  // ── Winter's requests ─────────────────────────────────────────────────────────────────────────────────────────────

  /** `watch.arm`: the first injection, refusing a state condition that already holds. */
  async arm(tabId: number, url: string | undefined, raw: unknown): Promise<WatchArmResult> {
    const spec = parseSpec(raw);
    const refusal = attachRefusal(url, this.chrome.runtimeId);
    if (refusal !== undefined) throw new WatchRefusal(refusal, "page");
    let r: unknown;
    try {
      r = await this.inject(tabId, { op: "arm", sink: "runtime", spec: { ...spec, initial: "refuse" } });
    } catch (err) {
      throw new WatchRefusal(`the browser would not let Winter watch this page: ${err instanceof Error ? err.message : String(err)}`, "page");
    }
    const result = armResult(r);
    if (result === undefined) throw new WatchRefusal("the page's watcher did not answer", "page");
    if (result.ok) {
      let m = this.tabs.get(tabId);
      if (m === undefined) { m = new Map(); this.tabs.set(tabId, m); }
      m.set(spec.watchId, spec);
      this.heard(tabId);
    }
    return result;
  }

  /** `watch.cancel`: idempotent; the watcher (its ring and pill) leaves the page. */
  async cancel(tabId: number, watchId: unknown): Promise<void> {
    if (typeof watchId !== "string") return;
    const m = this.tabs.get(tabId);
    m?.delete(watchId);
    if (m !== undefined && m.size === 0) this.forget(tabId);
    try { await this.inject(tabId, { op: "disarm", watchId }); } catch { /* the page or the tab went: the watch went with it */ }
  }

  /** The link to Winter dropped: every watch is taken down (Winter reads them all as lost). */
  async releaseAll(): Promise<void> {
    const all = [...this.tabs].flatMap(([tabId, m]) => [...m.keys()].map((id) => [tabId, id] as const));
    for (const tabId of [...this.tabs.keys()]) this.forget(tabId);
    for (const [tabId, id] of all) {
      try { await this.inject(tabId, { op: "disarm", watchId: id }); } catch { /* gone already */ }
    }
  }

  dropTab(tabId: number): void {
    this.forget(tabId);
    this.stamps.delete(tabId);
  }

  /**
   * The browser replaced a tab under a new id to navigate it (the extension's own navigation of a page that may ask
   * "leave this page?"): its watches move to the new tab — whose new document, Winter's own navigation brought, is only
   * their new baseline (an element's watch reads its document gone there).
   */
  moveTab(oldId: number, newId: number): void {
    const m = this.tabs.get(oldId);
    if (m === undefined || m.size === 0 || oldId === newId) return;
    this.forget(oldId);
    const into = this.tabs.get(newId) ?? new Map<string, WatchSpec>();
    for (const [id, spec] of m) into.set(id, spec);
    this.tabs.set(newId, into);
    this.navOwn.set(newId, true);
    this.loadingAt.set(newId, this.now());
    this.stall(newId);
    this.heard(newId);
  }

  private forget(tabId: number): void {
    this.tabs.delete(tabId);
    this.navOwn.delete(tabId);
    this.loadingAt.delete(tabId);
    for (const timers of [this.stalls, this.silences]) {
      const h = timers.get(tabId);
      if (h !== undefined) this.clock.clearTimeout(h);
      timers.delete(tabId);
    }
  }

  private async inject(tabId: number, arg: unknown): Promise<unknown> {
    const res = await this.chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: wakeWatcher as (arg: never) => unknown, args: [arg] });
    return Array.isArray(res) && isRecord(res[0]) ? res[0].result : undefined;
  }

  // ── the browser's events ──────────────────────────────────────────────────────────────────────────────────────────

  private onUpdated(tabId: number, info: { url?: string; status?: string }): void {
    const m = this.tabs.get(tabId);
    if (m === undefined || m.size === 0) return;
    const at = this.now();
    if (info.status === "loading") {
      this.navOwn.set(tabId, this.own(tabId, at));
      this.loadingAt.set(tabId, at);
      this.stall(tabId);
    }
    if (typeof info.url === "string") {
      const own = this.navOwn.get(tabId) === true || this.own(tabId, at);
      // Never the whole address (a GET form's typed values ride its query): its site and path, a digest that tells it
      // from another, and whether it holds the words Winter waits for — matched here.
      const shape = watchUrlShape(info.url);
      const key = watchUrlKey(info.url);
      for (const spec of m.values()) {
        if (spec.kind !== "navigated") continue;
        this.opts.notify("watch.event", {
          tabKey: String(tabId), watchId: spec.watchId, outcome: "url", at, url: shape, key,
          ...(spec.url === undefined ? {} : { match: info.url.includes(spec.url) }), ...(own ? { own: true } : {}),
        });
      }
    }
    if (info.status === "complete") void this.reinject(tabId);
  }

  /** A load began: looked at even if it never completes. */
  private stall(tabId: number): void {
    const old = this.stalls.get(tabId);
    if (old !== undefined) this.clock.clearTimeout(old);
    this.stalls.set(tabId, this.clock.setTimeout(() => { this.stalls.delete(tabId); void this.reinject(tabId); }, LOAD_STALL_MS));
  }

  /** The tab's watcher was heard from (or just armed): looked at again after a silence. */
  private heard(tabId: number): void {
    const old = this.silences.get(tabId);
    if (old !== undefined) this.clock.clearTimeout(old);
    this.silences.set(tabId, this.clock.setTimeout(() => { this.silences.delete(tabId); void this.reinject(tabId); }, WATCH_SILENCE_MS));
  }

  /**
   * A new document (or the same one, loaded again, or a same-document change, or a silent watcher): each watch injected
   * again — `alive` where it already runs. An element's watch whose document went (or where no script runs any more)
   * is reported to Winter, which decides lost or fired.
   */
  private async reinject(tabId: number): Promise<void> {
    const m = this.tabs.get(tabId);
    if (m === undefined) return;
    const stalled = this.stalls.get(tabId);
    if (stalled !== undefined) { this.clock.clearTimeout(stalled); this.stalls.delete(tabId); }
    const own = this.navOwn.get(tabId) === true;
    this.navOwn.delete(tabId);
    const wentAt = this.loadingAt.get(tabId) ?? this.now();
    for (const spec of [...m.values()]) {
      let r: WatchArmResult | undefined;
      let threw = false;
      try {
        r = armResult(await this.inject(tabId, { op: "arm", sink: "runtime", spec: { ...spec, initial: own ? "baseline" : "fire" } }));
      } catch {
        // A page that takes no script (a browser page, a store page) or a renderer that went: an element's watch
        // lost its document; a page condition is tried again at the tab's next load.
        threw = true;
      }
      if (this.tabs.get(tabId)?.get(spec.watchId) !== spec) continue;
      if (threw ? spec.locator === undefined : r === undefined || r.ok) continue;
      const reason = threw || r?.ok === false && r.reason === "doc" ? "doc" : "gone";
      m.delete(spec.watchId);
      this.opts.notify("watch.event", { tabKey: String(tabId), watchId: spec.watchId, outcome: "lost", at: reason === "doc" ? wentAt : this.now(), reason });
    }
    if (m.size === 0) this.forget(tabId);
    else this.heard(tabId);
  }

  /**
   * A runtime message from a watcher in a tab's top frame (`background.ts` passes only the extension's own senders):
   * an event to relay, or its heartbeat. False: not a watcher's message.
   */
  onMessage(message: unknown, sender: MessageSender, sendResponse: (r: unknown) => void): boolean {
    if (!isRecord(message) || (message.type !== "winter.wake.event" && message.type !== "winter.wake.alive")) return false;
    const tabId = sender.tab?.id;
    const mine = tabId === undefined || sender.frameId !== 0 ? undefined : this.tabs.get(tabId);
    if (message.type === "winter.wake.alive") {
      const ids = Array.isArray(message.watchIds) ? message.watchIds.filter((x): x is string => typeof x === "string") : [];
      sendResponse({ known: ids.filter((id) => mine?.has(id) === true) });
      if (tabId !== undefined && mine !== undefined) this.heard(tabId);
      return true;
    }
    sendResponse({});
    const { watchId, outcome, at, cause, url, title, reason } = message;
    if (tabId === undefined || mine === undefined || typeof watchId !== "string" || !mine.has(watchId)) return true;
    if (outcome !== "fired" && outcome !== "pressed" && outcome !== "lost") return true;
    if (typeof at !== "number" || !Number.isFinite(at)) return true;
    this.heard(tabId);
    if (outcome === "lost") mine.delete(watchId);
    const causeAt = typeof cause === "number" && Number.isFinite(cause) ? cause : undefined;
    const own = this.own(tabId, at) || (causeAt !== undefined && this.own(tabId, causeAt));
    this.opts.notify("watch.event", {
      tabKey: String(tabId), watchId, outcome, at, ...(causeAt === undefined ? {} : { cause: causeAt }),
      ...(typeof url === "string" ? { url: url.slice(0, 4096) } : {}), ...(typeof title === "string" ? { title: title.slice(0, 300) } : {}),
      ...(reason === "gone" || reason === "doc" ? { reason } : {}), ...(own ? { own: true } : {}),
    });
    if (mine.size === 0) this.forget(tabId);
    return true;
  }
}

/** Winter's watch, checked field by field (an unknown field is dropped; a malformed one refused). */
function parseSpec(raw: unknown): WatchSpec {
  if (!isRecord(raw)) throw new WatchRefusal("watch.arm needs a watch", "malformed");
  const { watchId, kind, locator, text, title, url, anyForm, settleMs, pill, expiresAt } = raw;
  if (typeof watchId !== "string" || !WATCH_ID.test(watchId)) throw new WatchRefusal("watch.arm needs a watch id", "malformed");
  if (typeof kind !== "string" || !KINDS.has(kind)) throw new WatchRefusal("watch.arm: an unknown kind of watch", "malformed");
  if (typeof pill !== "string" || pill.length === 0 || pill.length > 300) throw new WatchRefusal("watch.arm needs the pill's words", "malformed");
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) throw new WatchRefusal("watch.arm needs an expiry", "malformed");
  const spec: WatchSpec = { watchId, kind: kind as WatchSpec["kind"], pill, expiresAt, initial: "refuse" };
  if (locator !== undefined) {
    if (!isRecord(locator) || typeof locator.doc !== "number" || typeof locator.tag !== "string" || !Array.isArray(locator.path) || !isRecord(locator.attrs)) {
      throw new WatchRefusal("watch.arm: a malformed locator", "malformed");
    }
    const path = locator.path.filter((p): p is [string, number, number] => Array.isArray(p) && p.length === 3 && typeof p[0] === "string" && typeof p[1] === "number" && (p[2] === 0 || p[2] === 1));
    if (path.length !== locator.path.length || path.length > 512) throw new WatchRefusal("watch.arm: a malformed locator", "malformed");
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(locator.attrs)) if (typeof v === "string" && v.length <= 500) attrs[k] = v;
    spec.locator = { doc: locator.doc, path, tag: locator.tag.slice(0, 64), attrs };
  }
  if (typeof text === "string") spec.text = text.slice(0, 1_000);
  if (typeof title === "string") spec.title = title.slice(0, 1_000);
  if (typeof url === "string" && url.length > 0) spec.url = url.slice(0, 1_000);
  if (anyForm === true) spec.anyForm = true;
  if (typeof settleMs === "number" && Number.isFinite(settleMs)) spec.settleMs = Math.max(100, Math.min(60_000, settleMs));
  return spec;
}

function armResult(raw: unknown): WatchArmResult | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.ok === true && (raw.installed === "new" || raw.installed === "alive") && typeof raw.doc === "number") {
    return { ok: true, installed: raw.installed, doc: raw.doc, ...(typeof raw.met === "boolean" ? { met: raw.met } : {}) };
  }
  if (raw.ok === false && (raw.reason === "met" || raw.reason === "gone" || raw.reason === "doc" || raw.reason === "noform")) return { ok: false, reason: raw.reason };
  return undefined;
}
