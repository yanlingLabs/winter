// A FAKE browser backend for the browser engine's tests: a `CdpTransport` whose tabs hold scripted pages. It enforces
// what every real transport enforces (`cdp-allowlist.ts`: the methods, the events, and the world rules — code runs
// only in an isolated world named "winter" whose context it SAW created), and plays the page runtime's ops
// (`page-runtime/protocol.ts`) from the scripted page, so the engine is exercised exactly as it would drive Chromium.
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS } from "../../src/computer-use/browser/cdp-allowlist";
import type { RtClassify, RtNode, RtPoint } from "../../src/computer-use/browser/page-runtime/protocol";
import { TransportError, type BrowserFamily, type CdpEvent, type CdpTransport, type TransportTab } from "../../src/computer-use/browser/transport";

export interface FakeFrame {
  frameId: string;
  /** The iframe element's id in the parent document. */
  ownerId: number;
  nodes: RtNode[];
  /** An out-of-process iframe: its own CDP session. */
  oopif?: boolean;
  secure?: number[];
  editable?: number[];
  url?: string;
}

export interface FakePage {
  url: string;
  title: string;
  nodes: RtNode[];
  secure?: number[];
  editable?: number[];
  focused?: number;
  /** id → what covers it. */
  covered?: Record<number, { id: number; role: string; name?: string }>;
  hidden?: number[];
  fileInputs?: number[];
  text?: string;
  frames?: FakeFrame[];
  /** Mutations keep coming (never quiet). */
  busy?: boolean;
}

interface Ctx { frameId: string; session?: string; winter: boolean; doc: number }

export class FakeTab {
  doc = 1;
  attached = false;
  subscribed: readonly string[] = [];
  readonly contexts = new Map<string, Ctx>();
  readonly winterObjects = new Set<string>();
  values = new Map<string, string>();
  focused: string | undefined;
  dialog?: { type: string; message: string };
  history: string[] = [];
  historyIndex = -1;
  closed = false;
  kept = false;
  /** The page has a beforeunload handler: a navigation asks first (the navigation waits for the answer). */
  beforeUnload = false;
  pendingNav?: string;
  holders = new Set<string>();
  constructor(readonly tabKey: string, public page: FakePage, readonly sessionId?: string, readonly agent = false) {
    this.history.push(page.url);
    this.historyIndex = 0;
  }
}

export class FakeCdpTransport implements CdpTransport {
  connected = true;
  private nextCtx = 10;
  readonly tabs = new Map<string, FakeTab>();
  readonly sent: Array<{ tabKey: string; method: string; params: Record<string, unknown>; session?: string }> = [];
  readonly overlays: Array<{ tabKey: string; active: boolean }> = [];
  private readonly events = new Set<(e: CdpEvent) => void>();
  private readonly gone = new Set<(tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void>();
  private readonly stops = new Set<(tabKey: string) => void>();
  private nextTab = 100;
  /** Pages by URL, for navigation (a URL not here gets a blank page titled with it). */
  pages: Record<string, FakePage> = {};
  /** The next navigate fails with this net error. */
  failNextNavigate?: string;

  constructor(readonly backend: string, readonly family: BrowserFamily) {}

  page(url: string): FakePage {
    const p = this.pages[url];
    return p !== undefined ? structuredClone(p) : { url, title: url, nodes: [{ id: 1, role: "text", name: `page ${url}` }] };
  }

  addTab(page: FakePage, o: { tabKey?: string; sessionId?: string; agent?: boolean } = {}): FakeTab {
    const key = o.tabKey ?? String(this.nextTab++);
    const t = new FakeTab(key, page, o.sessionId, o.agent ?? false);
    this.tabs.set(key, t);
    return t;
  }

  private tab(tabKey: string): FakeTab {
    if (!this.connected) throw new TransportError("disconnected", "the backend is gone");
    const t = this.tabs.get(tabKey);
    if (t === undefined || t.closed) throw new TransportError("tab_gone", "no such tab");
    return t;
  }

  async createTab(opts: { sessionId: string; sessionTitle?: string; url: string; tabKey?: string }): Promise<TransportTab> {
    const t = this.addTab(this.page(opts.url), { ...(opts.tabKey === undefined ? {} : { tabKey: opts.tabKey }), sessionId: opts.sessionId, agent: true });
    return { tabKey: t.tabKey, url: t.page.url, title: t.page.title, active: false, agent: true, sessionId: opts.sessionId };
  }
  async closeTab(tabKey: string): Promise<void> { this.tab(tabKey).closed = true; }
  async keepTab(tabKey: string): Promise<void> { this.tab(tabKey).kept = true; }
  async listTabs(): Promise<TransportTab[]> {
    if (!this.connected) throw new TransportError("disconnected", "gone");
    return [...this.tabs.values()].filter((t) => !t.closed).map((t) => ({ tabKey: t.tabKey, url: t.page.url, title: t.page.title, active: false, agent: t.agent, ...(t.sessionId === undefined ? {} : { sessionId: t.sessionId }) }));
  }
  async attach(tabKey: string, opts: { sessionId: string }): Promise<{ viewport: [number, number]; dpr: number }> {
    const t = this.tab(tabKey);
    t.attached = true;
    t.holders.add(opts.sessionId);
    return { viewport: [1200, 800], dpr: 2 };
  }
  async detach(tabKey: string): Promise<void> {
    const t = this.tabs.get(tabKey);
    if (t === undefined) return;
    t.attached = false;
    t.holders.clear();
    t.contexts.clear();
    t.winterObjects.clear();
  }
  async subscribe(tabKey: string, events: readonly string[]): Promise<void> {
    const bad = events.find((e) => !CDP_ALLOWED_EVENTS.includes(e));
    if (bad !== undefined) throw new TransportError("not_allowed", `event ${bad} is not allowed`);
    this.tab(tabKey).subscribed = [...events];
  }
  onEvent(listener: (e: CdpEvent) => void): () => void { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onTabGone(listener: (tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void): () => void { this.gone.add(listener); return () => { this.gone.delete(listener); }; }
  onStop(listener: (tabKey: string) => void): () => void { this.stops.add(listener); return () => { this.stops.delete(listener); }; }
  overlay(tabKey: string, o: { active: boolean }): void { this.overlays.push({ tabKey, active: o.active }); }

  /** Test doors: the tab goes away / the Stop button. */
  goneTab(tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user" = "closed"): void {
    const t = this.tabs.get(tabKey);
    if (t !== undefined) t.closed = true;
    for (const l of [...this.gone]) l(tabKey, reason);
  }
  pressStop(tabKey: string): void { for (const l of [...this.stops]) l(tabKey); }

  emit(tab: FakeTab, method: string, params: Record<string, unknown>, session?: string): void {
    if (!tab.subscribed.includes(method)) return;
    for (const l of [...this.events]) l({ tabKey: tab.tabKey, method, params, ...(session === undefined ? {} : { cdpSessionId: session }) });
  }

  /** The page navigates by itself (a link the page followed): a new document. */
  navigateTo(tabKey: string, url: string): void {
    const t = this.tab(tabKey);
    t.history = t.history.slice(0, t.historyIndex + 1);
    t.history.push(url);
    t.historyIndex = t.history.length - 1;
    this.commit(t, url);
  }

  /** A JavaScript dialog opens. */
  openDialog(tabKey: string, type: string, message: string): void {
    const t = this.tab(tabKey);
    t.dialog = { type, message };
    this.emit(t, "Page.javascriptDialogOpening", { url: t.page.url, message, type, hasBrowserHandler: false });
  }

  private commit(t: FakeTab, url: string): void {
    for (const [k, c] of [...t.contexts]) {
      if (c.frameId === "top" || c.session === undefined) {
        t.contexts.delete(k);
        this.emit(t, "Runtime.executionContextDestroyed", { executionContextId: Number(k.split(":")[1]) });
      }
    }
    t.doc++;
    t.page = this.page(url);
    t.values.clear();
    t.dialog = undefined;
    this.emit(t, "Page.frameStartedLoading", { frameId: "top" });
    this.emit(t, "Page.frameNavigated", { frame: { id: "top", url, loaderId: `L${t.doc}` }, type: "Navigation" });
    this.emit(t, "Page.lifecycleEvent", { frameId: "top", loaderId: `L${t.doc}`, name: "DOMContentLoaded", timestamp: 1 });
    this.emit(t, "Page.domContentEventFired", { timestamp: 1 });
    this.emit(t, "Page.loadEventFired", { timestamp: 1 });
    this.emit(t, "Page.frameStoppedLoading", { frameId: "top" });
  }

  private frameOf(t: FakeTab, frameId: string): { nodes: RtNode[]; secure: number[]; editable: number[]; url: string } {
    if (frameId === "top") return { nodes: t.page.nodes, secure: t.page.secure ?? [], editable: t.page.editable ?? [], url: t.page.url };
    const f = t.page.frames?.find((x) => x.frameId === frameId);
    if (f === undefined) throw new TransportError("cdp_error", "No frame with given id", { cdpCode: -32000, cdpMessage: "No frame with given id found" });
    return { nodes: f.nodes, secure: f.secure ?? [], editable: f.editable ?? [], url: f.url ?? "https://frame.example/" };
  }

  async send<T = unknown>(tabKey: string, method: string, params: Record<string, unknown> = {}, opts: { cdpSessionId?: string } = {}): Promise<T> {
    if (!CDP_ALLOWED_METHODS.includes(method)) throw new TransportError("not_allowed", `${method} is not allowed`);
    const t = this.tab(tabKey);
    if (!t.attached) throw new TransportError("cdp_error", "not attached", { cdpCode: -32000, cdpMessage: "Not attached" });
    const session = opts.cdpSessionId;
    this.sent.push({ tabKey, method, params, ...(session === undefined ? {} : { session }) });
    const ctxKey = (id: unknown): string => `${session ?? ""}:${String(id)}`;
    const r = (v: unknown): T => v as T;
    switch (method) {
      case "Page.enable": case "Runtime.enable": case "Network.enable": case "Page.setLifecycleEventsEnabled":
      case "Page.setInterceptFileChooserDialog": case "Emulation.setFocusEmulationEnabled": case "Runtime.releaseObject":
        return r({});
      case "Target.setAutoAttach": {
        if (session === undefined) {
          for (const f of t.page.frames ?? []) {
            if (f.oopif !== true) continue;
            this.emit(t, "Target.attachedToTarget", { sessionId: `S-${f.frameId}`, targetInfo: { targetId: f.frameId, type: "iframe", url: f.url ?? "" }, waitingForDebugger: false });
          }
        }
        return r({});
      }
      case "Page.getFrameTree": {
        if (session !== undefined) {
          const f = t.page.frames?.find((x) => `S-${x.frameId}` === session);
          return r({ frameTree: { frame: { id: f?.frameId ?? "?", parentId: "top", url: f?.url ?? "" } } });
        }
        return r({ frameTree: { frame: { id: "top", url: t.page.url }, childFrames: (t.page.frames ?? []).map((f) => ({ frame: { id: f.frameId, parentId: "top", url: f.url ?? "" } })) } });
      }
      case "Page.createIsolatedWorld": {
        if (params.worldName !== "winter" || params.grantUniveralAccess === true) throw new TransportError("not_allowed", "world rule");
        const frameId = String(params.frameId);
        const id = this.nextCtx++;
        t.contexts.set(ctxKey(id), { frameId, ...(session === undefined ? {} : { session }), winter: true, doc: t.doc });
        this.emit(t, "Runtime.executionContextCreated", { context: { id, name: "winter", origin: "", auxData: { frameId, isDefault: false, type: "isolated" } } }, session);
        return r({ executionContextId: id });
      }
      case "Runtime.evaluate": {
        const c = t.contexts.get(ctxKey(params.contextId));
        if (c === undefined || !c.winter) throw new TransportError("not_allowed", "Runtime.evaluate outside the winter world");
        return r({ result: { type: "string", value: `rt-${c.frameId}-${c.doc}` } });
      }
      case "DOM.getFrameOwner": {
        const f = t.page.frames?.find((x) => x.frameId === params.frameId);
        if (f === undefined) throw new TransportError("cdp_error", "no frame", { cdpMessage: "Frame with the given id was not found." });
        return r({ backendNodeId: f.ownerId });
      }
      case "DOM.resolveNode": {
        const c = t.contexts.get(ctxKey(params.executionContextId));
        if (c === undefined || !c.winter) throw new TransportError("not_allowed", "DOM.resolveNode outside the winter world");
        const objectId = `obj:${c.frameId}:${String(params.backendNodeId)}`;
        t.winterObjects.add(objectId);
        return r({ object: { type: "object", objectId } });
      }
      case "Runtime.callFunctionOn": {
        let frameId: string;
        if (typeof params.objectId === "string") {
          if (!t.winterObjects.has(params.objectId)) throw new TransportError("not_allowed", "objectId not minted in the winter world");
          frameId = params.objectId.split(":")[1]!;
          const [, , nodeId] = params.objectId.split(":");
          const op = (params.arguments as Array<{ value: unknown }>)[0]!.value;
          if (op === "owner") return r({ result: { type: "number", value: Number(nodeId) } });
          return r({ result: { type: "undefined" } });
        }
        const c = t.contexts.get(ctxKey(params.executionContextId));
        if (c === undefined || !c.winter) throw new TransportError("not_allowed", "Runtime.callFunctionOn outside the winter world");
        if (c.doc !== t.doc && c.frameId === "top") throw new TransportError("cdp_error", "ctx gone", { cdpMessage: "Cannot find context with specified id" });
        frameId = c.frameId;
        const args = params.arguments as Array<{ value: unknown }>;
        const op = String(args[0]!.value);
        const arg = (args[1]?.value ?? null) as Record<string, any> | null;
        if (params.returnByValue === false) {
          const objectId = `obj:${frameId}:${String(arg?.id)}`;
          t.winterObjects.add(objectId);
          return r({ result: { type: "object", objectId } });
        }
        return r({ result: { type: "object", value: this.op(t, frameId, op, arg) } });
      }
      case "Input.dispatchMouseEvent": return r({});
      case "Input.dispatchKeyEvent": {
        if (params.type === "keyDown" && typeof params.text === "string" && t.focused !== undefined) t.values.set(t.focused, (t.values.get(t.focused) ?? "") + params.text);
        return r({});
      }
      case "Input.insertText": {
        if (t.focused !== undefined) t.values.set(t.focused, (t.values.get(t.focused) ?? "") + String(params.text));
        return r({});
      }
      case "Page.navigate": {
        if (this.failNextNavigate !== undefined) { const e = this.failNextNavigate; delete this.failNextNavigate; return r({ frameId: "top", errorText: e }); }
        const url = String(params.url);
        t.history = t.history.slice(0, t.historyIndex + 1);
        t.history.push(url);
        t.historyIndex = t.history.length - 1;
        if (t.beforeUnload) {
          t.pendingNav = url;
          t.dialog = { type: "beforeunload", message: "" };
          queueMicrotask(() => this.emit(t, "Page.javascriptDialogOpening", { url: t.page.url, message: "", type: "beforeunload", hasBrowserHandler: false }));
        } else queueMicrotask(() => this.commit(t, url));
        return r({ frameId: "top", loaderId: `L${t.doc + 1}` });
      }
      case "Page.getNavigationHistory":
        return r({ currentIndex: t.historyIndex, entries: t.history.map((url, i) => ({ id: i + 1, url, title: url })) });
      case "Page.navigateToHistoryEntry": {
        const i = Number(params.entryId) - 1;
        t.historyIndex = i;
        queueMicrotask(() => this.commit(t, t.history[i]!));
        return r({});
      }
      case "Page.reload":
        queueMicrotask(() => this.commit(t, t.page.url));
        return r({});
      case "Page.handleJavaScriptDialog":
        if (t.dialog === undefined) throw new TransportError("cdp_error", "no dialog", { cdpMessage: "No dialog is showing" });
        t.dialog = undefined;
        this.emit(t, "Page.javascriptDialogClosed", { result: params.accept === true, userInput: String(params.promptText ?? "") });
        if (t.pendingNav !== undefined) {
          const url = t.pendingNav;
          delete t.pendingNav;
          if (params.accept === true) queueMicrotask(() => this.commit(t, url));
        }
        return r({});
      case "Page.getLayoutMetrics":
        return r({ cssVisualViewport: { pageX: 0, pageY: 300, clientWidth: 1200, clientHeight: 800, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 } });
      case "Page.captureScreenshot": {
        const clip = params.clip as { width: number; height: number; scale: number };
        return r({ data: fakeJpeg(Math.round(clip.width * clip.scale * 2), Math.round(clip.height * clip.scale * 2)) });
      }
      case "DOM.setFileInputFiles":
        if (typeof params.objectId !== "string" || !t.winterObjects.has(params.objectId)) throw new TransportError("not_allowed", "unknown object");
        t.values.set(`files:${params.objectId}`, (params.files as string[]).join(","));
        return r({});
      default:
        return r({});
    }
  }

  private op(t: FakeTab, frameId: string, op: string, arg: Record<string, any> | null): unknown {
    const f = this.frameOf(t, frameId);
    const key = (id: unknown): string => `${frameId}:${String(id)}`;
    const all = (): RtNode[] => { const out: RtNode[] = []; const v = (n: RtNode): void => { out.push(n); for (const c of n.children ?? []) v(c); }; for (const n of f.nodes) v(n); return out; };
    const node = (id: unknown): RtNode | undefined => all().find((n) => n.id === id);
    const withValues = (n: RtNode): RtNode => {
      const v = t.values.get(key(n.id));
      return { ...n, ...(v === undefined || f.secure.includes(n.id) ? {} : { value: v }), ...(n.children === undefined ? {} : { children: n.children.map(withValues) }) };
    };
    switch (op) {
      case "hello": return { id: `rt-${frameId}-${t.doc}`, url: f.url, title: t.page.title, readyState: "complete" };
      case "snapshot": {
        if (arg?.within !== undefined) {
          const n = node(arg.within);
          if (n === undefined) throw new TransportError("cdp_error", "exception", { cdpMessage: `stale:${arg.within}` });
          return { url: f.url, title: t.page.title, roots: [withValues(n)] };
        }
        const focused = t.focused?.startsWith(`${frameId}:`) === true ? Number(t.focused.split(":")[1]) : frameId === "top" ? t.page.focused : undefined;
        return { url: f.url, title: t.page.title, roots: f.nodes.map(withValues), ...(focused === undefined ? {} : { focused }) };
      }
      case "find": {
        const q = String(arg?.text ?? arg?.name ?? "").toLowerCase();
        return all().filter((n) => (n.name ?? "").toLowerCase().includes(q)).map((n) => ({ id: n.id, role: n.role, ...(n.name === undefined ? {} : { name: n.name }) }));
      }
      case "text": return t.page.text ?? all().map((n) => n.name ?? "").join("\n");
      case "frameOffset": return { x: 100, y: 200 };
      case "point": {
        const n = node(arg?.id);
        if (n === undefined) return { ok: false, reason: "gone" } satisfies RtPoint;
        const cov = frameId === "top" ? t.page.covered?.[n.id] : undefined;
        if (cov !== undefined) return { ok: false, reason: "covered", by: cov } satisfies RtPoint;
        if (t.page.hidden?.includes(n.id) === true) return { ok: false, reason: "hidden" } satisfies RtPoint;
        return { ok: true, x: 10 * n.id, y: 5 * n.id } satisfies RtPoint;
      }
      case "classify": case "focus": {
        const id = op === "focus" ? arg?.id : t.focused?.startsWith(`${frameId}:`) === true ? Number(t.focused.split(":")[1]) : frameId === "top" ? t.page.focused : undefined;
        if (id === undefined) {
          const oop = frameId === "top" ? t.page.frames?.find((x) => t.focused?.startsWith(`${x.frameId}:`) === true) : undefined;
          if (oop !== undefined) return { kind: "frame", id: oop.ownerId } satisfies RtClassify;
          return { kind: "ok", editable: false } satisfies RtClassify;
        }
        const n = node(id);
        if (n === undefined) return { kind: "unknown" } satisfies RtClassify;
        if (op === "focus") t.focused = key(id);
        if (f.secure.includes(Number(id))) return { kind: "secure", id: Number(id) } satisfies RtClassify;
        return { kind: "ok", editable: f.editable.includes(Number(id)), id: Number(id), role: n.role, ...(n.name === undefined ? {} : { name: n.name }) } satisfies RtClassify;
      }
      case "setValue": {
        const n = node(arg?.id);
        if (n === undefined) return { ok: false, reason: "gone" };
        if (f.secure.includes(n.id)) return { ok: false, reason: "secure_field" };
        t.values.set(key(n.id), String(arg?.value));
        return { ok: true, shown: String(arg?.value) };
      }
      case "select": {
        const n = node(arg?.id);
        if (n === undefined) return { ok: false, reason: "gone" };
        if (f.secure.includes(n.id)) return { ok: false, reason: "secure_field" };
        return { ok: true };
      }
      case "readValue": return f.secure.includes(Number(arg?.id)) ? null : t.values.get(key(arg?.id)) ?? "";
      case "fileInput": return t.page.fileInputs?.includes(Number(arg?.id)) === true ? { ok: true, multiple: true } : { ok: false, reason: "not a file input" };
      case "pasteEvent": return { handled: false };
      case "quiet": return { sinceMutationMs: t.page.busy === true ? 0 : 10_000, url: f.url, title: t.page.title, readyState: "complete" };
      case "waitChange": return false;
      case "check": {
        const text = t.page.text ?? all().map((n) => n.name ?? "").join("\n");
        let met = true;
        if (typeof arg?.text === "string" && !text.includes(arg.text)) met = false;
        if (typeof arg?.title === "string" && !t.page.title.includes(arg.title)) met = false;
        if (typeof arg?.url === "string" && !t.page.url.includes(arg.url)) met = false;
        if (Array.isArray(arg?.ids) && arg.ids.some((id: number) => node(id) === undefined)) met = false;
        if (Array.isArray(arg?.goneIds) && arg.goneIds.some((id: number) => node(id) !== undefined)) met = false;
        return { met, seen: `title "${t.page.title}" · ${text.slice(0, 100)}` };
      }
      case "alive": return (arg?.ids ?? []).filter((id: number) => node(id) !== undefined);
      default: throw new Error(`fake runtime: unknown op ${op}`);
    }
  }
}

/** A minimal JPEG header (SOI + SOF0) with the given size, as base64 — enough for `imageSize`. */
export function fakeJpeg(width: number, height: number): string {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  return b.toString("base64");
}
