// Wake triggers on the FAKE browser (`browser-fake-transport.ts`): the page watcher's ops in the winter world (the
// debugger path: `watchLocate`, `watchArm`, `watchWait`, `watchDisarm`), Winter for Chrome 1.2.0's debugger-free watch
// (`watch`/`unwatch`/`onWatchEvent`, its own world, injected again in each new document), and test doors for the USER's
// actions — which reach the page as trusted events, exactly as Winter's own `Input.*` click does (only the timing tells
// them apart). Semantics follow `page-runtime/watch.ts`: input conditions report each event; state conditions report a
// false→true transition; `initial` refuse / baseline / fire.
import type { RtNode } from "../../src/computer-use/browser/page-runtime/protocol";
import type { WatchArmResult, WatchEvent, WatchSpec, WatchWaitResult } from "../../src/computer-use/browser/page-runtime/watch";
import { TransportError, type TransportWatchEvent } from "../../src/computer-use/browser/transport";
import type { FakeCdpTransport, FakeTab } from "./browser-fake-transport";

interface FakeWatch { spec: WatchSpec; frameId: string; doc: number; id?: number; last?: boolean; value?: string }

interface World {
  key: string;
  tabKey: string;
  frameId: string;
  doc: number;
  ext: boolean;
  watches: Map<string, FakeWatch>;
  queue: WatchEvent[];
  seq: number;
  waiters: Set<() => void>;
}

export class FakeWakes {
  private readonly worlds = new Map<string, World>();
  /** The extension's own record of its watches, per tab (re-injected into each new document). */
  private readonly extWatches = new Map<string, Map<string, WatchSpec>>();
  private readonly listeners = new Set<(tabKey: string, e: TransportWatchEvent) => void>();
  /** When the transport last sent the tab input or a navigation (the extension's own stamp). */
  private readonly lastOwn = new Map<string, number>();
  /** Every watcher op the fake saw (what a test asks of the page). */
  readonly ops: Array<{ op: string; frameId: string; arg: unknown }> = [];

  constructor(private readonly transport: FakeCdpTransport) {}

  /** Winter for Chrome 1.2.0: the debugger-free members. */
  enableExtension(): void {
    const t = this.transport;
    t.features?.add("watch");
    t.watch = async (tabKey, spec) => {
      const tab = t.tabs.get(tabKey);
      if (tab === undefined || tab.closed) throw new TransportError("tab_gone", "no such tab");
      const r = this.arm(this.world(tab, "top", `ext:${tabKey}:${tab.doc}`, true), tab, spec, undefined);
      if (r.ok) {
        let m = this.extWatches.get(tabKey);
        if (m === undefined) { m = new Map(); this.extWatches.set(tabKey, m); }
        m.set(spec.watchId, spec);
      }
      return r;
    };
    t.unwatch = async (tabKey, watchId) => {
      this.extWatches.get(tabKey)?.delete(watchId);
      for (const w of this.worlds.values()) if (w.ext && w.tabKey === tabKey) w.watches.delete(watchId);
    };
    t.onWatchEvent = (l) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  }

  /** The extension's link dropped: every watch it kept is lost. */
  dropExtension(): void {
    this.transport.connected = false;
    for (const [tabKey, m] of this.extWatches) for (const id of m.keys()) this.tell(tabKey, { watchId: id, outcome: "lost", at: Date.now(), reason: "disconnected" });
    this.extWatches.clear();
  }

  /** How many watches the extension keeps now (none for an old build). */
  extCount(): number { let n = 0; for (const m of this.extWatches.values()) n += m.size; return n; }

  /** The pills a tab shows now (every world of its current document). */
  pills(tabKey: string): string[] {
    const tab = this.transport.tabs.get(tabKey);
    return [...this.worlds.values()].filter((w) => w.tabKey === tabKey && tab !== undefined && w.doc === tab.doc).flatMap((w) => [...w.watches.values()].map((x) => x.spec.pill));
  }

  stampOwn(tabKey: string): void { this.lastOwn.set(tabKey, Date.now()); }

  private tell(tabKey: string, e: TransportWatchEvent): void { for (const l of [...this.listeners]) l(tabKey, e); }

  private world(tab: FakeTab, frameId: string, key: string, ext: boolean): World {
    let w = this.worlds.get(key);
    if (w === undefined) {
      w = { key, tabKey: tab.tabKey, frameId, doc: tab.doc, ext, watches: new Map(), queue: [], seq: 0, waiters: new Set() };
      this.worlds.set(key, w);
    }
    return w;
  }

  private nodes(tab: FakeTab, frameId: string): RtNode[] {
    const list = frameId === "top" ? tab.page.nodes : tab.page.frames?.find((f) => f.frameId === frameId)?.nodes ?? [];
    const out: RtNode[] = [];
    const v = (n: RtNode): void => { out.push(n); for (const c of n.children ?? []) v(c); };
    for (const n of list) v(n);
    return out;
  }
  private node(tab: FakeTab, frameId: string, id: number | undefined): RtNode | undefined {
    return id === undefined ? undefined : this.nodes(tab, frameId).find((n) => n.id === id);
  }
  private text(tab: FakeTab): string { return tab.page.text ?? this.nodes(tab, "top").map((n) => n.name ?? "").join("\n"); }
  private shown(tab: FakeTab, frameId: string, id: number | undefined): boolean {
    return this.node(tab, frameId, id) !== undefined && tab.page.hidden?.includes(id!) !== true;
  }
  /** Is `id` the watched node or inside it? */
  private within(tab: FakeTab, frameId: string, watched: number | undefined, id: number): boolean {
    if (watched === undefined) return false;
    if (watched === id) return true;
    const n = this.node(tab, frameId, watched);
    const inside = (x: RtNode): boolean => x.id === id || (x.children ?? []).some(inside);
    return n !== undefined && inside(n);
  }

  private met(tab: FakeTab, w: FakeWatch): boolean | undefined {
    switch (w.spec.kind) {
      case "appeared": return this.text(tab).includes(w.spec.text ?? "\u0000");
      case "titled": return tab.page.title.includes(w.spec.title ?? "\u0000");
      case "gone": return w.spec.locator === undefined && w.id === undefined ? !this.text(tab).includes(w.spec.text ?? "\u0000") : !this.shown(tab, w.frameId, w.id);
      default: return undefined;
    }
  }

  private push(world: World, w: FakeWatch, outcome: WatchEvent["outcome"], o: { at?: number; title?: string; reason?: "gone" | "doc" } = {}): void {
    const tab = this.transport.tabs.get(world.tabKey)!;
    const ev: WatchEvent = { seq: ++world.seq, watchId: w.spec.watchId, outcome, at: o.at ?? Date.now(), url: tab.page.url, ...(o.title === undefined ? {} : { title: o.title }), ...(o.reason === undefined ? {} : { reason: o.reason }) };
    if (world.ext) {
      const stamp = this.lastOwn.get(world.tabKey);
      const own = stamp !== undefined && ev.at >= stamp - 50 && ev.at - stamp <= 500;
      this.tell(world.tabKey, { watchId: ev.watchId, outcome, at: ev.at, url: ev.url, ...(ev.title === undefined ? {} : { title: ev.title }), ...(ev.reason === undefined ? {} : { reason: ev.reason }), ...(own ? { own } : {}) });
      return;
    }
    world.queue.push(ev);
    for (const wake of [...world.waiters]) wake();
  }

  private arm(world: World, tab: FakeTab, spec: WatchSpec, id: number | undefined): WatchArmResult {
    const existing = world.watches.get(spec.watchId);
    if (existing !== undefined) return { ok: true, installed: "alive", doc: world.doc, ...(existing.last === undefined ? {} : { met: existing.last }) };
    let el = id;
    if (el === undefined && spec.locator !== undefined) {
      if (spec.locator.doc !== tab.doc) return { ok: false, reason: "doc" };
      const fakeId = Number(spec.locator.attrs["data-fake"]);
      el = this.node(tab, world.frameId, fakeId) !== undefined ? fakeId : undefined;
      if (el === undefined && spec.kind !== "gone") return { ok: false, reason: "gone" };
      if (el === undefined) el = fakeId;
    }
    const w: FakeWatch = { spec, frameId: world.frameId, doc: tab.doc, ...(el === undefined ? {} : { id: el }) };
    // A form, or a button in one (the fake's forms: role "form"; its buttons count as in a form).
    if (spec.kind === "submitted" && spec.anyForm !== true && !["form", "button"].includes(this.node(tab, world.frameId, el)?.role ?? "")) return { ok: false, reason: "noform" };
    if (spec.kind === "changed") w.value = tab.values.get(`${world.frameId}:${String(el)}`) ?? "";
    const m = this.met(tab, w);
    if (m === true && spec.initial === "refuse") return { ok: false, reason: "met" };
    w.last = m === true && spec.initial === "fire" ? false : m;
    world.watches.set(spec.watchId, w);
    if (m === true && spec.initial === "fire") this.recheckWorld(world);
    return { ok: true, installed: "new", doc: tab.doc, ...(m === undefined ? {} : { met: m }) };
  }

  // ── the page runtime's ops (the debugger path), called by the fake transport ─────────────────────────────

  op(tab: FakeTab, frameId: string, op: string, arg: Record<string, any> | null, ctx: string): unknown {
    this.ops.push({ op, frameId, arg });
    const key = `winter:${tab.tabKey}:${ctx}`;
    switch (op) {
      case "watchLocate": {
        const id = Number(arg?.id);
        const n = this.node(tab, frameId, id);
        if (n === undefined) return { ok: false, reason: "gone" };
        const secure = frameId === "top" ? tab.page.secure ?? [] : tab.page.frames?.find((f) => f.frameId === frameId)?.secure ?? [];
        if (secure.includes(id)) return { ok: false, reason: "secure" };
        return { ok: true, element: { role: n.role, name: n.name ?? "" }, locator: { doc: tab.doc, path: [["BODY", 0, 0]], tag: "DIV", attrs: { "data-fake": String(id) } }, top: frameId === "top" };
      }
      case "watchArm": {
        const id = typeof arg?.id === "number" ? arg.id : undefined;
        const secure = frameId === "top" ? tab.page.secure ?? [] : [];
        if (id !== undefined && secure.includes(id)) throw new Error("secure_field");
        return this.arm(this.world(tab, frameId, key, false), tab, arg!.spec as WatchSpec, id);
      }
      case "watchWait": {
        const world = this.world(tab, frameId, key, false);
        const ack = arg?.world === world.key ? Number(arg?.ack ?? 0) : 0;
        world.queue = world.queue.filter((e) => e.seq > ack);
        const answer = (): WatchWaitResult => ({ world: world.key, events: world.queue.slice(0, 50), alive: [...world.watches.keys()] });
        if (world.queue.length > 0) return Promise.resolve(answer());
        return new Promise<WatchWaitResult>((resolve) => {
          const done = (): void => { world.waiters.delete(done); clearTimeout(timer); resolve(answer()); };
          const timer = setTimeout(done, Math.min(25_000, Number(arg?.maxMs ?? 0)));
          world.waiters.add(done);
        });
      }
      case "watchDisarm": {
        const world = this.worlds.get(key);
        return world?.watches.delete(String(arg?.watchId)) ?? false;
      }
      default: throw new Error(`fake wakes: unknown op ${op}`);
    }
  }

  // ── what happens in the page ──────────────────────────────────────────────────────────────────────────────

  /** The worlds of a tab's CURRENT document (an older document's are gone with it). */
  private live(tabKey: string, frameId = "top"): World[] {
    const tab = this.transport.tabs.get(tabKey);
    if (tab === undefined) return [];
    return [...this.worlds.values()].filter((w) => w.tabKey === tabKey && w.frameId === frameId && w.doc === tab.doc);
  }

  /** The USER acts in the page (a trusted event that is not Winter's): a click (with the press before it), a press
   *  only, a form submitted, a field changed (its value set first, the change settled). */
  user(tabKey: string, ev: { type: "click" | "press" | "submit" | "change"; id?: number; frameId?: string; value?: string; at?: number }): void {
    const frameId = ev.frameId ?? "top";
    const tab = this.transport.tabs.get(tabKey)!;
    const at = ev.at ?? Date.now();
    if (ev.type === "change" && ev.id !== undefined && ev.value !== undefined) tab.values.set(`${frameId}:${String(ev.id)}`, ev.value);
    for (const world of this.live(tabKey, frameId)) {
      for (const w of [...world.watches.values()]) {
        const s = w.spec;
        if (ev.type === "press" || ev.type === "click") {
          if (s.kind === "clicked" && ev.id !== undefined && this.within(tab, frameId, w.id, ev.id)) this.push(world, w, ev.type === "click" ? "fired" : "pressed", { at });
        } else if (ev.type === "submit") {
          if (s.kind === "submitted" && (s.anyForm === true || (ev.id !== undefined && w.id === ev.id))) this.push(world, w, "fired", { at });
        } else if (ev.type === "change") {
          if (s.kind === "changed" && ev.id !== undefined && w.id === ev.id) {
            const v = tab.values.get(`${frameId}:${String(ev.id)}`) ?? "";
            if (v !== w.value) { w.value = v; this.push(world, w, "fired", { at }); }
          }
        }
      }
    }
  }

  /** Winter's own `Input.*` click at a point lands in the page as a trusted click too (the element at (10·id, 5·id)). */
  inputClick(tab: FakeTab, x: number, y: number): void {
    const n = this.nodes(tab, "top").find((m) => Math.abs(10 * m.id - x) < 1 && Math.abs(5 * m.id - y) < 1);
    if (n !== undefined) this.user(tab.tabKey, { type: "click", id: n.id });
  }

  /** The page changed by itself (a test edited its nodes, text or title): state conditions are checked again. */
  recheck(tabKey: string): void {
    for (const world of [...this.worlds.values()]) if (world.tabKey === tabKey) this.recheckWorld(world);
  }

  private recheckWorld(world: World): void {
    const tab = this.transport.tabs.get(world.tabKey);
    if (tab === undefined || tab.doc !== world.doc) return;
    for (const w of [...world.watches.values()]) {
      const m = this.met(tab, w);
      if (m === undefined) {
        // An input condition's element went: lost ("gone").
        if (w.id !== undefined && w.spec.anyForm !== true && this.node(tab, world.frameId, w.id) === undefined) this.push(world, w, "lost", { reason: "gone" });
        continue;
      }
      if (m && w.last === false) this.push(world, w, "fired", w.spec.kind === "titled" ? { title: tab.page.title } : {});
      w.last = m;
    }
  }

  /** A same-document navigation (pushState): the engine's event, and the extension's URL report. */
  sameDocument(tabKey: string, url: string): void {
    const tab = this.transport.tabs.get(tabKey)!;
    tab.page = { ...tab.page, url };
    this.transport.emit(tab, "Page.navigatedWithinDocument", { frameId: "top", url });
    this.extUrl(tabKey, url);
  }

  private extUrl(tabKey: string, url: string): void {
    const own = Date.now() - (this.lastOwn.get(tabKey) ?? -Infinity) <= 500;
    for (const spec of this.extWatches.get(tabKey)?.values() ?? []) {
      if (spec.kind === "navigated") this.tell(tabKey, { watchId: spec.watchId, outcome: "url", at: Date.now(), url, ...(own ? { own } : {}) });
    }
  }

  /** A new top document committed (the fake transport calls this): the extension reports the URL, re-injects its page
   *  watches (`fire`, or `baseline` after its own input or navigation) and loses its element watches. */
  committed(tab: FakeTab, url: string): void {
    const m = this.extWatches.get(tab.tabKey);
    if (m === undefined || m.size === 0) return;
    this.extUrl(tab.tabKey, url);
    const own = Date.now() - (this.lastOwn.get(tab.tabKey) ?? -Infinity) <= 500;
    queueMicrotask(() => {
      for (const spec of [...m.values()]) {
        const world = this.world(tab, "top", `ext:${tab.tabKey}:${tab.doc}`, true);
        const r = this.arm(world, tab, { ...spec, initial: own ? "baseline" : "fire" }, undefined);
        if (!r.ok && r.reason === "doc") {
          m.delete(spec.watchId);
          this.tell(tab.tabKey, { watchId: spec.watchId, outcome: "lost", at: Date.now(), reason: "doc", url });
        }
      }
    });
  }
}
