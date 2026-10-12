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
// What the watcher reports reaches the extension as a runtime message from that world (`winter.wake.event`; the page
// itself cannot send one — no `externally_connectable`), and the extension relays it to Winter (`watch.event`): which
// watch, what happened, when, the top document's URL and, for a title watch, the title. Never what the user typed. The
// extension also says whether its own debugger sent the tab input or a navigation within 500 ms before (`own`): Winter
// never counts its own input as the user's. A watch the extension no longer knows (a worker restart, the link to Winter
// dropped) is taken down by the watcher itself at its next heartbeat (`winter.wake.alive`).
import { wakeWatcher, type WatchArmResult, type WatchSpec } from "../../../packages/core/src/computer-use/browser/page-runtime/watch";
import type { ChromeApi, MessageSender } from "./chrome-api";
import { attachRefusal } from "./urls";

/** Input or a navigation the extension's debugger sent a tab is its own for this long after. */
export const OWN_INPUT_GRACE_MS = 500;
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
  log?(line: string): void;
}

export class WatchBook {
  private readonly tabs = new Map<number, Map<string, WatchSpec>>();
  private readonly stamps = new Map<number, { inFlight: number; start: number; end: number }>();
  /** Per tab: whether the navigation in progress came from the extension's own debugger (its new document is a baseline). */
  private readonly navOwn = new Map<number, boolean>();

  constructor(private readonly chrome: ChromeApi, private readonly opts: WatchBookOptions) {}

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
    }
    return result;
  }

  /** `watch.cancel`: idempotent; the watcher (its ring and pill) leaves the page. */
  async cancel(tabId: number, watchId: unknown): Promise<void> {
    if (typeof watchId !== "string") return;
    const m = this.tabs.get(tabId);
    m?.delete(watchId);
    if (m !== undefined && m.size === 0) this.tabs.delete(tabId);
    try { await this.inject(tabId, { op: "disarm", watchId }); } catch { /* the page or the tab went: the watch went with it */ }
  }

  /** The link to Winter dropped: every watch is taken down (Winter reads them all as lost). */
  async releaseAll(): Promise<void> {
    const all = [...this.tabs].flatMap(([tabId, m]) => [...m.keys()].map((id) => [tabId, id] as const));
    this.tabs.clear();
    for (const [tabId, id] of all) {
      try { await this.inject(tabId, { op: "disarm", watchId: id }); } catch { /* gone already */ }
    }
  }

  dropTab(tabId: number): void {
    this.tabs.delete(tabId);
    this.stamps.delete(tabId);
    this.navOwn.delete(tabId);
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
    if (info.status === "loading") this.navOwn.set(tabId, this.own(tabId, at));
    if (typeof info.url === "string") {
      const own = this.own(tabId, at);
      for (const spec of m.values()) {
        if (spec.kind !== "navigated") continue;
        this.opts.notify("watch.event", { tabKey: String(tabId), watchId: spec.watchId, outcome: "url", at, url: info.url.slice(0, 4096), ...(own ? { own: true } : {}) });
      }
    }
    if (info.status === "complete") void this.reinject(tabId);
  }

  /** A new document (or the same one, loaded again): each watch injected again — `alive` where it already runs. */
  private async reinject(tabId: number): Promise<void> {
    const m = this.tabs.get(tabId);
    if (m === undefined) return;
    const own = this.navOwn.get(tabId) === true;
    this.navOwn.delete(tabId);
    for (const spec of [...m.values()]) {
      let r: WatchArmResult | undefined;
      try {
        r = armResult(await this.inject(tabId, { op: "arm", sink: "runtime", spec: { ...spec, initial: own ? "baseline" : "fire" } }));
      } catch {
        continue; // a page that takes no script (a browser page, a store page): tried again at the tab's next load
      }
      if (r === undefined || r.ok || this.tabs.get(tabId)?.get(spec.watchId) !== spec) continue;
      // An element's watch whose document went (or whose element is not there): Winter decides lost or fired.
      m.delete(spec.watchId);
      this.opts.notify("watch.event", { tabKey: String(tabId), watchId: spec.watchId, outcome: "lost", at: this.now(), reason: r.reason === "doc" ? "doc" : "gone" });
    }
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
      return true;
    }
    sendResponse({});
    const { watchId, outcome, at, url, title, reason } = message;
    if (tabId === undefined || mine === undefined || typeof watchId !== "string" || !mine.has(watchId)) return true;
    if (outcome !== "fired" && outcome !== "pressed" && outcome !== "lost") return true;
    if (typeof at !== "number" || !Number.isFinite(at)) return true;
    if (outcome === "lost") mine.delete(watchId);
    const own = this.own(tabId, at);
    this.opts.notify("watch.event", {
      tabKey: String(tabId), watchId, outcome, at,
      ...(typeof url === "string" ? { url: url.slice(0, 4096) } : {}), ...(typeof title === "string" ? { title: title.slice(0, 300) } : {}),
      ...(reason === "gone" || reason === "doc" ? { reason } : {}), ...(own ? { own: true } : {}),
    });
    return true;
  }
}

/** Winter's watch, checked field by field (an unknown field is dropped; a malformed one refused). */
function parseSpec(raw: unknown): WatchSpec {
  if (!isRecord(raw)) throw new WatchRefusal("watch.arm needs a watch", "malformed");
  const { watchId, kind, locator, text, title, anyForm, settleMs, pill, expiresAt } = raw;
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
