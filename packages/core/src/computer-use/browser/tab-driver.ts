// ComputerV2 Phase 2 — ONE browser tab, driven over CDP through its backend's transport. Shared by every session
// that binds the tab (the per-tab lock serializes them); the engine (`engine.ts`) owns sessions, bindings and
// policy, this file owns the mechanics:
//
//   - FRAMES: the tab's frame tree, out-of-process iframes included (`Target.setAutoAttach`, flattened child sessions);
//   - THE PAGE RUNTIME in an isolated world named "winter" per frame per document (`Page.createIsolatedWorld`,
//     re-created lazily for every new document — nothing on the allowlist installs a script ahead of a navigation);
//   - REFS: the runtime's per-document ids mapped to the tab's integers — stable while the element exists, never
//     reused; a new top-frame document makes every earlier ref stale;
//   - the tab's state and diffs (the last 8 snapshots), find, text, waits, input, navigation, dialogs, screenshots.
//
// Only `cdp-allowlist.ts`'s methods and events are ever sent or subscribed — the transports refuse anything else.
import { AutomationFailure } from "../errors";
import type { ScreenshotBudget } from "../protocol";
import { buttonOf, keyEvents, keyForChar, modifiersOf, parseCombo, type KeyPress } from "./input";
import { PAGE_RUNTIME_SOURCE } from "./page-runtime/bundle.generated";
import { redactText, redactUrl } from "./page-runtime/redact";
import { pickerAdvice } from "./page-runtime/rules";
import {
  PAGE_RUNTIME_CALL, type RtCheck, type RtClassify, type RtCondition, type RtFindQuery, type RtFound, type RtHit, type RtNode, type RtPoint, type RtSnapshot,
} from "./page-runtime/protocol";
import { fitsBudget, imageSize, outputSize, scaleFor, toCss, type CssRect, type ShotFrame } from "./scale";
import { diffState, fullState, makeSnapshot, type TabDialogLine, type TabHeader, type TabNode, type TabSnapshot } from "./state-format";
import { TransportError, type CdpEvent, type CdpTransport } from "./transport";

/** The events the engine follows on every tab (a subset of `CDP_ALLOWED_EVENTS`). */
export const TAB_EVENTS: readonly string[] = [
  "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.domContentEventFired", "Page.loadEventFired", "Page.lifecycleEvent",
  "Page.frameAttached", "Page.frameDetached", "Page.frameStartedLoading", "Page.frameStoppedLoading", "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed", "Page.fileChooserOpened", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared", "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed",
  "Target.attachedToTarget", "Target.detachedFromTarget", "Inspector.detached", "Inspector.targetCrashed",
];

export const NAVIGATION_WAIT_MS = 10_000;
const SNAPSHOTS_KEPT = 8;
const MAX_FRAMES = 30;
const MAX_FRAME_DEPTH = 6;
const TYPE_AS_KEYS_MAX = 200;

/** The secure-field floor's sentences (Phase 1's words — the helper's `refused` reasons). */
export const SECURE_FIELD_SENTENCE = "that is a password or payment field — Winter never reads or types into one; ask the user to fill it in";
export const FOCUS_UNKNOWN_SENTENCE = (where: string): string => `can't tell which field has focus in ${where}, so it could be a password field — pass \`into\` or click a text field first`;

interface FrameRec {
  frameId: string;
  parentId?: string;
  /** The CDP session the frame's documents live in (absent: the tab's own). */
  session?: string;
  url: string;
  /** The "winter" world's context id in this frame's current document, and the CDP session it was made in (a context
   *  id means nothing in another session: a frame that moved out of process gets a new world). */
  ctx?: number;
  ctxSession?: string;
  /** The world's `uniqueId` when the browser reports one (a process-local context id can repeat across processes). */
  ctxUnique?: string;
  /** The page runtime instance installed in that world. */
  rtId?: string;
  installing?: Promise<void>;
  /** The iframe element that holds this frame, as its parent's runtime knows it. */
  owner?: { parentRt: string; id: number };
}

interface Dialog extends TabDialogLine { session?: string }

export interface TabStateResult { text: string; snapshotId: string; isDiff: boolean; settled?: boolean; waitedMs?: number }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const bad = (message: string): Error => Object.assign(new TypeError(message), { name: "TypeError" });
const stale = (ref: number): AutomationFailure => new AutomationFailure("StaleRef", `[${ref}] is gone — call state()`);

/** A transport failure as the model's error kind. */
export function transportFailure(err: unknown, browserName: string): Error {
  if (!(err instanceof TransportError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.code) {
    case "disconnected":
      return new AutomationFailure("BrowserUnavailable", browserName === "Winter's browser"
        ? "Winter's browser can't be reached: Winter isn't running — ask the user to open Winter"
        : `${browserName} can't be reached: Winter for Chrome is not connected — ask the user`, true);
    case "protocol_mismatch":
      return new AutomationFailure("BrowserUnavailable", err.data.side === "extension"
        ? "Winter for Chrome is too old or too new for this Winter — ask the user to update Winter for Chrome"
        : "Winter's browser speaks another version — ask the user to update Winter");
    case "tab_gone": return new AutomationFailure("TargetLost", "the tab was closed, crashed or stopped — open it again with browsers.open() or bind another with browsers.tab()");
    case "attach_refused": return new AutomationFailure("Refused", "that tab can't be controlled (a browser-internal page, a store page, or another debugger is attached)");
    case "timeout": return new AutomationFailure("TargetBusy", "the browser did not answer in time — the page may be busy; try again in a moment", true);
    case "not_allowed": return new Error(`the browser refused that request (${err.message})`);
    case "cdp_error": {
      // -32603 from Winter's app: the browser's answer was too large for the link, or not valid JSON.
      if (err.data.cdpCode === -32603) return new Error("the browser's answer was too large or unreadable — read less at once (state({ within }), a region screenshot)");
      const msg = typeof err.data.cdpMessage === "string" ? err.data.cdpMessage : err.message;
      return new Error(msg.slice(0, 300));
    }
  }
}

export class TabDriver {
  /** Bound by these sessions now (the hold / debugger stays attached while any does). */
  readonly holders = new Set<string>();
  /** Why the tab is gone (closed, crashed, stopped, detached by the user) — every call is `TargetLost` after. */
  gone?: string;
  url = "";
  title = "";
  /** Bumped by every new top-frame document. */
  generation = 0;
  /** A committed top-frame navigation the site floor has not looked at yet. */
  siteCheckPending = true;
  /** The model's own goto/close on an agent tab: a `beforeunload` dialog it raises is accepted. */
  agentNavigating = false;
  dialog?: Dialog;
  fileChooser?: { frameId: string; mode: string };

  private attached = false;
  /** Times the debugger was let go while the tab lived (an idle detach, `stopped`, a command's `tab_gone`): a
   *  navigation in flight across one is finished by attaching again (`navigation`). */
  private detaches = 0;
  private attaching?: Promise<void>;
  private releasing?: Promise<void>;
  /** When a primitive last used this tab (the hold cap releases the least recently used), and how many are using it
   *  now (never released under one). */
  lastUsed = 0;
  busy = 0;
  /** The top frame's runtime at the last state: a different one means a new document even if its event was lost. */
  private lastTopRt?: string;
  private viewport: [number, number] = [0, 0];
  private dpr = 1;
  private readonly frames = new Map<string, FrameRec>();
  private topFrameId?: string;
  private readonly childSetups = new Map<string, Promise<void>>();
  /** CDP sessions ("" = the tab's own) where Runtime is enabled: a world is made and used only in one (a world rule). */
  private readonly runtimeOn = new Set<string>();
  private nextRef = 1;
  private readonly refByKey = new Map<string, number>();
  private readonly refInfo = new Map<number, { rtId: string; id: number }>();
  /** Runtime instance → the frame it is installed in now. A ref whose instance is not here is stale. */
  private readonly liveRts = new Map<string, string>();
  private snapshots: TabSnapshot[] = [];
  private snapCounter = 0;
  private newPage = false;
  private readonly inflight = new Set<string>();
  private lastRequestAt = -Infinity;
  private navSeq = 0;
  private lastCommitLoader?: string;
  private lastCommitType?: string;
  private dclLoader?: string;
  private readonly pokes = new Set<() => void>();
  private readonly shots = new Map<string, ShotFrame>();
  private shotCounter = 0;
  /** The `uniqueId` each recently created context reported (`<session>:<id>` → uniqueId): the browser reports a world's
   *  creation BEFORE it answers the `Page.createIsolatedWorld` that made it, so the id is matched up afterwards. */
  private readonly seenUnique = new Map<string, string>();

  constructor(
    readonly backend: string,
    readonly tabKey: string,
    public transport: CdpTransport,
    /** "Winter's browser", "Google Chrome" — for error sentences. */
    readonly browserName: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ── transport ───────────────────────────────────────────────────────────────────────────────────

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, session?: string, timeoutMs?: number): Promise<T> {
    if (this.gone !== undefined) throw this.lost();
    // A page dialog pauses the page: input, and any read of the page, would be answered only once the dialog is — so
    // nothing of the kind is sent while one is open (only the dialog's answer, navigation and closing are).
    const pausable = method.startsWith("Input.") || method === "Runtime.callFunctionOn" || method === "Runtime.evaluate";
    if (pausable && this.dialog !== undefined) throw new AutomationFailure("TargetBusy", this.dialogBusySentence());
    const sent = this.transport.send<T>(this.tabKey, method, params, { ...(session === undefined ? {} : { cdpSessionId: session }), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    try {
      // A dialog opening while it is in flight: stop waiting at once — input counts as delivered; a read is TargetBusy.
      if (pausable) {
        const opened = await this.raceDialog(sent);
        if (opened) {
          void sent.catch(() => undefined);
          if (method.startsWith("Input.")) return {} as T;
          throw new AutomationFailure("TargetBusy", this.dialogBusySentence());
        }
      }
      return await sent;
    } catch (err) {
      if (err instanceof AutomationFailure) throw err;
      // `tab_gone` from a command is not proof the tab closed (an extension's debugger can be let go while the tab
      // lives): attach again on the next primitive — that attach failing is what loses the tab.
      if (err instanceof TransportError && err.code === "tab_gone") { this.attached = false; this.detaches++; this.resetDocumentState(true); }
      throw transportFailure(err, this.browserName);
    }
  }

  /** `true` when a page dialog opened before `p` settled (then `p` is left running); else `p`'s outcome. */
  private raceDialog(p: Promise<unknown>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let done = false;
      const check = (): void => {
        if (done || this.dialog === undefined) return;
        done = true;
        this.pokes.delete(check);
        resolve(true);
      };
      this.pokes.add(check);
      p.then(() => { if (done) return; done = true; this.pokes.delete(check); resolve(false); },
        (e: unknown) => { if (done) return; done = true; this.pokes.delete(check); reject(e); });
    });
  }

  lost(): AutomationFailure {
    const why = this.gone === "crashed" ? "the tab crashed" : this.gone === "detached_by_user" ? "the user stopped Winter from controlling this tab" : "the tab was closed";
    return new AutomationFailure("TargetLost", `${why} — open a new one with browsers.open() or bind another with browsers.tab()`);
  }

  /** The transport was replaced (the app or the extension reconnected): everything the old one knew is gone. */
  replaceTransport(t: CdpTransport): void {
    if (t === this.transport) return;
    this.transport = t;
    this.resetDocumentState(true);
    this.attached = false;
  }

  // ── attach / detach ────────────────────────────────────────────────────────────────────────────

  /** `transient`: the tab may be between documents (the browser navigating it by itself) — a `tab_gone` from the attach
   *  is `TabBetween`, not the tab lost. */
  async ensureAttached(sessionId: string, o: { transient?: boolean } = {}): Promise<void> {
    if (this.gone !== undefined) throw this.lost();
    if (this.releasing !== undefined) await this.releasing;
    this.holders.add(sessionId);
    this.lastUsed = this.now();
    if (this.attached) return;
    this.attaching ??= (async () => {
      let info: { viewport: [number, number]; dpr: number };
      try { info = await this.transport.attach(this.tabKey, { sessionId }); } catch (err) {
        if (err instanceof TransportError && err.code === "tab_gone") {
          if (o.transient === true) throw new TabBetween();
          this.gone ??= "closed";
          throw this.lost();
        }
        throw transportFailure(err, this.browserName);
      }
      this.viewport = info.viewport;
      this.dpr = info.dpr > 0 ? info.dpr : 1;
      try { await this.transport.subscribe(this.tabKey, TAB_EVENTS); } catch (err) { throw transportFailure(err, this.browserName); }
      await this.enableDomains(undefined);
      // Background tabs behave as focused (focus events, :focus, caret) — never by raising anything.
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
      await this.loadTopFrame();
      this.attached = true;
    })().finally(() => { this.attaching = undefined; });
    await this.attaching;
  }

  /**
   * The frame tree. A hostile page can make it too large to come back (Winter's app caps an answer); then the tab
   * still works from its own target info (a page target's id IS its main frame's) and the frame events that follow.
   */
  private async loadTopFrame(): Promise<void> {
    try {
      const tree = await this.send<{ frameTree: FrameTreeNode }>("Page.getFrameTree");
      this.loadFrameTree(tree.frameTree, undefined, undefined);
      return;
    } catch (err) {
      if (err instanceof AutomationFailure && err.kind === "TargetLost") throw err;
    }
    try {
      const info = await this.send<{ targetInfo?: { targetId?: string; url?: string } }>("Target.getTargetInfo");
      const id = info.targetInfo?.targetId;
      if (typeof id === "string" && id.length > 0) {
        const rec = this.frames.get(id) ?? { frameId: id, url: info.targetInfo?.url ?? "" };
        this.frames.set(id, rec);
        this.topFrameId = id;
        if (this.url === "") this.url = rec.url;
      }
    } catch { /* the next frame event names the top frame */ }
  }

  private async enableDomains(session: string | undefined): Promise<void> {
    await this.send("Page.enable", {}, session);
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true }, session).catch(() => undefined);
    await this.send("Runtime.enable", {}, session);
    this.runtimeOn.add(session ?? "");
    // Only request timing is read (idle detection); nothing needs a body, so the browser buffers none.
    await this.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }, session).catch(() => undefined);
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true }, session).catch(() => undefined);
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session).catch(() => undefined);
  }

  /**
   * Drop `sessionId`'s hold; the tab is detached when no session holds it — after undoing what attaching turned on
   * (the intercepted file chooser, focus emulation, auto-attach, the enabled domains), so the tab is left as it was.
   * Never closes it.
   */
  async release(sessionId: string): Promise<void> {
    this.holders.delete(sessionId);
    if (this.holders.size > 0 || !this.attached) return;
    this.attached = false;
    this.overlay(false);
    this.resetDocumentState(false);
    this.releasing = (async () => {
      if (this.gone === undefined) {
        const quiet = async (method: string, params: Record<string, unknown> = {}): Promise<void> => {
          try { await this.transport.send(this.tabKey, method, params, { timeoutMs: 2_000 }); } catch { /* best effort */ }
        };
        await quiet("Page.setInterceptFileChooserDialog", { enabled: false });
        await quiet("Emulation.setFocusEmulationEnabled", { enabled: false });
        await quiet("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
        await quiet("Network.disable");
        await quiet("Runtime.disable");
        await quiet("Page.disable");
      }
      try { await this.transport.detach(this.tabKey); } catch { /* the tab or the link is gone already */ }
    })().finally(() => { this.releasing = undefined; });
    await this.releasing;
  }

  /** Is the tab attached (held) now? */
  get isAttached(): boolean { return this.attached; }

  /** The model is about to see this tab whole (a fresh binding): earlier navigations are not "new" to it. */
  resetPageMark(): void { this.newPage = false; }

  overlay(active: boolean, cursor?: { x: number; y: number; kind: "move" | "press" | "type" | "scroll" }): void {
    try { this.transport.overlay(this.tabKey, { active, ...(cursor === undefined ? {} : { cursor }) }); } catch { /* best effort */ }
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────────────

  onEvent(e: CdpEvent): void {
    const p = e.params as Record<string, any>;
    const session = e.cdpSessionId;
    switch (e.method) {
      case "Page.frameAttached": {
        const id = String(p.frameId);
        const rec = this.frames.get(id) ?? { frameId: id, url: "", ...(session === undefined ? {} : { session }) };
        if (typeof p.parentFrameId === "string") rec.parentId = p.parentFrameId;
        this.frames.set(id, rec);
        break;
      }
      case "Page.frameDetached":
        if (p.reason !== "swap") this.dropFrame(String(p.frameId));
        break;
      case "Page.frameNavigated": {
        const f = (p.frame ?? {}) as { id: string; parentId?: string; url: string; urlFragment?: string; loaderId?: string };
        const rec = this.frames.get(f.id) ?? { frameId: f.id, url: "", ...(session === undefined ? {} : { session }) };
        rec.url = `${f.url}${f.urlFragment ?? ""}`;
        if (f.parentId !== undefined) rec.parentId = f.parentId;
        delete rec.ctx;
        this.forgetRuntime(rec);
        this.frames.set(f.id, rec);
        if (f.parentId === undefined && session === undefined) {
          this.topFrameId = f.id;
          this.url = rec.url;
          this.newTopDocument();
          this.navSeq++;
          this.lastCommitLoader = f.loaderId;
          this.lastCommitType = typeof p.type === "string" ? p.type : undefined;
        }
        break;
      }
      case "Page.navigatedWithinDocument": {
        const rec = this.frames.get(String(p.frameId));
        if (rec !== undefined) rec.url = String(p.url);
        if (String(p.frameId) === this.topFrameId && session === undefined) {
          this.url = String(p.url);
          this.navSeq++;
          this.lastCommitType = "sameDocument";
          this.siteCheckPending = true;
        }
        break;
      }
      case "Page.domContentEventFired":
        if (session === undefined) this.dclLoader = this.lastCommitLoader;
        break;
      case "Page.lifecycleEvent":
        if (p.name === "DOMContentLoaded" && p.frameId === this.topFrameId && session === undefined) this.dclLoader = typeof p.loaderId === "string" ? p.loaderId : this.lastCommitLoader;
        break;
      case "Page.javascriptDialogOpening": {
        const type = typeof p.type === "string" ? p.type : "alert";
        if (type === "beforeunload" && this.agentNavigating) {
          void this.send("Page.handleJavaScriptDialog", { accept: true }, session).catch(() => undefined);
          break;
        }
        const okRef = this.nextRef++;
        this.dialog = {
          type, message: typeof p.message === "string" ? p.message : "", okRef,
          ...(type === "alert" ? {} : { cancelRef: this.nextRef++ }),
          ...(type === "prompt" ? { promptRef: this.nextRef++, promptText: typeof p.defaultPrompt === "string" ? p.defaultPrompt : "" } : {}),
          ...(session === undefined ? {} : { session }),
        };
        break;
      }
      case "Page.javascriptDialogClosed":
        this.dialog = undefined;
        break;
      case "Page.fileChooserOpened":
        this.fileChooser = { frameId: String(p.frameId ?? ""), mode: String(p.mode ?? "selectSingle") };
        break;
      case "Runtime.executionContextCreated": {
        const c = (p.context ?? {}) as { id: number; name?: string; uniqueId?: string; auxData?: { frameId?: string } };
        const frameId = c.auxData?.frameId;
        // A world counts as ours only by the id our own `Page.createIsolatedWorld` returned — never by its name, which
        // another extension's world could share. Its event only adds the `uniqueId` the browser reports.
        if (typeof c.uniqueId === "string") {
          this.seenUnique.set(`${session ?? ""}:${c.id}`, c.uniqueId);
          if (this.seenUnique.size > 256) this.seenUnique.delete(this.seenUnique.keys().next().value!);
        }
        if (frameId !== undefined && typeof c.uniqueId === "string") {
          const rec = this.frames.get(frameId);
          if (rec !== undefined && rec.ctx === c.id && (rec.ctxSession ?? undefined) === session) rec.ctxUnique = c.uniqueId;
        }
        break;
      }
      case "Runtime.executionContextDestroyed": {
        // Matched by `uniqueId` where the browser reports one: a process-local id can repeat after a navigation.
        const id = p.executionContextId;
        const unique = typeof p.executionContextUniqueId === "string" ? p.executionContextUniqueId : undefined;
        const seenKey = `${session ?? ""}:${String(id)}`;
        if (unique === undefined || this.seenUnique.get(seenKey) === unique) this.seenUnique.delete(seenKey);
        for (const rec of this.frames.values()) {
          const same = unique !== undefined && rec.ctxUnique !== undefined ? rec.ctxUnique === unique : rec.ctx === id && (rec.ctxSession ?? undefined) === session;
          if (same) { delete rec.ctx; this.forgetRuntime(rec); }
        }
        break;
      }
      case "Runtime.executionContextsCleared":
        for (const rec of this.frames.values()) if ((rec.session ?? undefined) === session) { delete rec.ctx; this.forgetRuntime(rec); }
        break;
      case "Network.requestWillBeSent":
        this.inflight.add(`${session ?? ""}:${String(p.requestId)}`);
        this.lastRequestAt = this.now();
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        this.inflight.delete(`${session ?? ""}:${String(p.requestId)}`);
        break;
      case "Target.attachedToTarget": {
        const child = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const info = (p.targetInfo ?? {}) as { targetId?: string; type?: string };
        if (child === undefined || info.type !== "iframe" || typeof info.targetId !== "string") break;
        const rec = this.frames.get(info.targetId) ?? { frameId: info.targetId, url: "" };
        this.runtimeOn.delete(child); // a fresh session: nothing is enabled in it yet
        rec.session = child;
        delete rec.ctx;
        this.forgetRuntime(rec);
        this.frames.set(info.targetId, rec);
        const setup = (async () => {
          await this.enableDomains(child);
          const tree = await this.send<{ frameTree: FrameTreeNode }>("Page.getFrameTree", {}, child);
          this.loadFrameTree(tree.frameTree, rec.parentId, child);
        })().catch(() => undefined).finally(() => { this.childSetups.delete(child); });
        this.childSetups.set(child, setup);
        break;
      }
      case "Target.detachedFromTarget": {
        const child = typeof p.sessionId === "string" ? p.sessionId : undefined;
        if (child !== undefined) this.runtimeOn.delete(child);
        for (const rec of this.frames.values()) if (child !== undefined && rec.session === child) { delete rec.ctx; this.forgetRuntime(rec); }
        break;
      }
      case "Inspector.targetCrashed":
        this.gone ??= "crashed";
        break;
      case "Inspector.detached":
        // The tab's debugger was let go (idle, or the target swapped) while the tab lives: attach again on the next
        // primitive; its world, and so every ref, will be new.
        if (session === undefined) { this.attached = false; this.detaches++; this.holders.clear(); this.resetDocumentState(true); }
        break;
      default:
        break;
    }
    for (const poke of [...this.pokes]) poke();
  }

  onGone(reason: string): void {
    if (reason === "stopped") {
      // The tab's browser was stopped or its debugger let go (the app parked it; the extension idled out): the tab
      // itself may live on — the next primitive attaches again; its document (and so every ref) is new.
      this.attached = false;
      this.detaches++;
      this.holders.clear();
      this.resetDocumentState(true);
    } else {
      this.gone ??= reason;
    }
    for (const poke of [...this.pokes]) poke();
  }

  /** The URL and title as the model may read them: credentials in a URL, and token-looking text, redacted. */
  get shownUrl(): string { return redactUrl(shownUrl(this.url)); }
  get shownTitle(): string { return redactText(this.title); }

  private loadFrameTree(node: FrameTreeNode, parentId: string | undefined, session: string | undefined): void {
    const f = node.frame;
    const rec = this.frames.get(f.id) ?? { frameId: f.id, url: "" };
    rec.url = `${f.url}${f.urlFragment ?? ""}`;
    const pid = f.parentId ?? parentId;
    if (pid !== undefined) rec.parentId = pid;
    if (session !== undefined) rec.session = session;
    this.frames.set(f.id, rec);
    if (pid === undefined && session === undefined) {
      this.topFrameId = f.id;
      if (this.url === "") this.url = rec.url;
    }
    for (const c of node.childFrames ?? []) this.loadFrameTree(c, f.id, session);
  }

  private dropFrame(frameId: string): void {
    const rec = this.frames.get(frameId);
    if (rec === undefined) return;
    this.forgetRuntime(rec);
    this.frames.delete(frameId);
    for (const c of [...this.frames.values()]) if (c.parentId === frameId) this.dropFrame(c.frameId);
  }

  private forgetRuntime(rec: FrameRec): void {
    if (rec.rtId !== undefined) this.liveRts.delete(rec.rtId);
    delete rec.rtId;
    delete rec.owner;
    if (rec.ctx === undefined) { delete rec.ctxSession; delete rec.ctxUnique; }
  }

  /** A new top-frame document: every ref is stale, the snapshots go, the next state is full and says "new page". */
  private newTopDocument(): void {
    this.lastTopRt = undefined;
    this.generation++;
    this.newPage = true;
    this.snapshots = [];
    this.refByKey.clear();
    this.refInfo.clear();
    this.dialog = undefined;
    this.fileChooser = undefined;
    this.siteCheckPending = true;
    this.shots.clear();
  }

  private resetDocumentState(newDocument: boolean): void {
    for (const rec of this.frames.values()) { delete rec.ctx; this.forgetRuntime(rec); }
    this.frames.clear();
    this.childSetups.clear();
    this.runtimeOn.clear();
    this.seenUnique.clear();
    this.topFrameId = undefined;
    this.inflight.clear();
    if (newDocument) this.newTopDocument();
  }

  // ── the page runtime ───────────────────────────────────────────────────────────────────────────

  private top(): FrameRec {
    const rec = this.topFrameId === undefined ? undefined : this.frames.get(this.topFrameId);
    if (rec === undefined) throw new AutomationFailure("TargetBusy", "the page is not ready yet — try again in a moment", true);
    return rec;
  }

  private async ensureRuntime(rec: FrameRec): Promise<void> {
    // A world made in another session than the frame's now (it moved out of process) is not this frame's any more.
    if (rec.ctx !== undefined && rec.ctxSession !== rec.session) { delete rec.ctx; delete rec.ctxSession; this.forgetRuntime(rec); }
    if (rec.rtId !== undefined && rec.ctx !== undefined) return;
    if (rec.installing !== undefined) { await rec.installing; return; }
    rec.installing = (async () => {
      const session = rec.session;
      // Runtime first, in the frame's own session: an out-of-process frame's session may still be being set up.
      if (!this.runtimeOn.has(session ?? "")) {
        const setup = session === undefined ? undefined : this.childSetups.get(session);
        if (setup !== undefined) await setup;
        if (!this.runtimeOn.has(session ?? "")) {
          await this.send("Runtime.enable", {}, session);
          this.runtimeOn.add(session ?? "");
        }
        if (rec.session !== session) throw new Error("the frame's execution context was destroyed (it moved to another process)");
      }
      if (rec.ctx === undefined) {
        const r = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: rec.frameId, worldName: "winter" }, session);
        if (rec.session !== session) throw new Error("the frame's execution context was destroyed (it moved to another process)");
        rec.ctx = r.executionContextId;
        if (session === undefined) delete rec.ctxSession;
        else rec.ctxSession = session;
        const unique = this.seenUnique.get(`${session ?? ""}:${r.executionContextId}`);
        if (unique !== undefined) rec.ctxUnique = unique;
        else delete rec.ctxUnique;
      }
      const res = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression: `${PAGE_RUNTIME_SOURCE}\n;globalThis.__winterRuntime.id`, contextId: rec.ctx, returnByValue: true,
      }, rec.ctxSession);
      if (res.exceptionDetails !== undefined || typeof res.result?.value !== "string") throw new Error("the page runtime could not be installed in this page");
      rec.rtId = res.result.value;
      this.liveRts.set(rec.rtId, rec.frameId);
    })().finally(() => { rec.installing = undefined; });
    await rec.installing;
  }

  /** One page-runtime op in `rec`'s current document. */
  private async callIn<T>(rec: FrameRec, op: string, arg: unknown, opts: { byValue?: boolean; expectRt?: string } = {}): Promise<T> {
    await this.ensureRuntime(rec);
    if (opts.expectRt !== undefined && rec.rtId !== opts.expectRt) throw new AutomationFailure("StaleRef", "that element is gone (the page changed) — call state()");
    const res = await this.send<{ result?: { value?: unknown; objectId?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.callFunctionOn", {
      functionDeclaration: PAGE_RUNTIME_CALL, executionContextId: rec.ctx, arguments: [{ value: op }, { value: arg ?? null }],
      returnByValue: opts.byValue !== false, awaitPromise: true,
    }, rec.ctxSession);
    if (res.exceptionDetails !== undefined) {
      const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "error";
      const m = /stale:(\d+)/.exec(msg);
      if (m !== null) throw new AutomationFailure("StaleRef", "that element is gone — call state()");
      throw new Error(`the page runtime failed (${msg.split("\n")[0]!.slice(0, 200)})`);
    }
    return (opts.byValue === false ? res.result?.objectId : res.result?.value) as T;
  }

  /** An op with no element ids: retried once in a fresh runtime when the document changed under it. */
  private async callFresh<T>(rec: FrameRec, op: string, arg: unknown): Promise<T> {
    try {
      return await this.callIn<T>(rec, op, arg);
    } catch (err) {
      if (!isContextGone(err)) throw err;
      delete rec.ctx;
      this.forgetRuntime(rec);
      return await this.callIn<T>(rec, op, arg);
    }
  }

  // ── refs ───────────────────────────────────────────────────────────────────────────────────────

  private refFor(rtId: string, id: number): number {
    const key = `${rtId}:${id}`;
    let ref = this.refByKey.get(key);
    if (ref === undefined) {
      ref = this.nextRef++;
      this.refByKey.set(key, ref);
      this.refInfo.set(ref, { rtId, id });
    }
    return ref;
  }

  /** A ref → its frame and runtime id, or `StaleRef`. */
  resolve(ref: number): { rec: FrameRec; id: number; rtId: string } {
    const info = this.refInfo.get(ref);
    if (info === undefined) throw new AutomationFailure("StaleRef", `[${ref}] is not on this page (it may be from before a navigation) — call state()`);
    const frameId = this.liveRts.get(info.rtId);
    const rec = frameId === undefined ? undefined : this.frames.get(frameId);
    if (rec === undefined || rec.rtId !== info.rtId) throw stale(ref);
    return { rec, id: info.id, rtId: info.rtId };
  }

  isDialogRef(ref: number): boolean {
    const d = this.dialog;
    return d !== undefined && (ref === d.okRef || ref === d.cancelRef || ref === d.promptRef);
  }

  // ── frames ─────────────────────────────────────────────────────────────────────────────────────

  private async settleChildSetups(): Promise<void> {
    if (this.childSetups.size > 0) await Promise.race([Promise.allSettled([...this.childSetups.values()]), sleep(2_000)]);
  }

  /** Map each child frame of `rec` to its iframe element in `rec`'s runtime (`DOM.getFrameOwner`). */
  private async ensureOwners(rec: FrameRec): Promise<void> {
    if (rec.rtId === undefined || rec.ctx === undefined || rec.ctxSession !== rec.session) return;
    for (const c of this.frames.values()) {
      if (c.parentId !== rec.frameId || (c.owner !== undefined && c.owner.parentRt === rec.rtId)) continue;
      try {
        const own = await this.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: c.frameId }, rec.session);
        const node = await this.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: own.backendNodeId, executionContextId: rec.ctx }, rec.ctxSession);
        const objectId = node.object.objectId;
        if (objectId === undefined) continue;
        try {
          const res = await this.send<{ result?: { value?: unknown } }>("Runtime.callFunctionOn", {
            functionDeclaration: PAGE_RUNTIME_CALL, objectId, arguments: [{ value: "owner" }, { value: null }], returnByValue: true,
          }, rec.ctxSession);
          if (typeof res.result?.value === "number" && rec.rtId !== undefined) c.owner = { parentRt: rec.rtId, id: res.result.value };
        } finally {
          void this.send("Runtime.releaseObject", { objectId }, rec.ctxSession).catch(() => undefined);
        }
      } catch { /* unreadable owner: the frame's content is shown without a place, or not at all */ }
    }
  }

  private childFrameFor(rec: FrameRec, id: number): FrameRec | undefined {
    if (rec.rtId === undefined) return undefined;
    for (const c of this.frames.values()) if (c.parentId === rec.frameId && c.owner !== undefined && c.owner.parentRt === rec.rtId && c.owner.id === id) return c;
    return undefined;
  }

  /** Where `rec`'s viewport sits in the top frame's (CSS px), with the point `inner` (in `rec`'s viewport) brought
   *  into view in every ancestor on the way up — so a click there lands in `rec`. */
  private async frameOrigin(rec: FrameRec, inner: { x: number; y: number }): Promise<{ x: number; y: number }> {
    if (rec.parentId === undefined) return { x: 0, y: 0 };
    const parent = this.frames.get(rec.parentId);
    if (parent === undefined) throw new AutomationFailure("StaleRef", "that element's frame is gone — call state()");
    await this.ensureRuntime(parent);
    await this.ensureOwners(parent);
    if (rec.owner === undefined) throw new Error("can't place that frame on the page");
    const off = await this.callIn<{ x: number; y: number } | null>(parent, "frameOffset", { id: rec.owner.id, scroll: true, inner }, { expectRt: rec.owner.parentRt });
    if (off === null) throw new AutomationFailure("StaleRef", "that element's frame is gone — call state()");
    const up = await this.frameOrigin(parent, { x: off.x + inner.x, y: off.y + inner.y });
    return { x: off.x + up.x, y: off.y + up.y };
  }

  // ── state ──────────────────────────────────────────────────────────────────────────────────────

  private async readTree(within: number | undefined): Promise<{ roots: TabNode[]; focusedRef?: number; unread?: number }> {
    await this.settleChildSetups();
    const budget = { frames: 0 };
    if (within !== undefined) {
      const { rec, id, rtId } = this.resolve(within);
      const snap = await this.callIn<RtSnapshot>(rec, "snapshot", { within: id }, { expectRt: rtId });
      const focus: { ref?: number } = {};
      const roots = await this.convert(rec, snap.roots, budget, 0, focus);
      return { roots, ...(snap.unread === undefined ? {} : { unread: snap.unread }) };
    }
    const top = this.top();
    const snap = await this.callFresh<RtSnapshot>(top, "snapshot", {});
    // Another runtime in the top frame than at the last state: a new document, even if its navigation event never
    // arrived (an over-size event is dropped by the transport).
    if (this.lastTopRt !== undefined && top.rtId !== this.lastTopRt) this.newTopDocument();
    this.lastTopRt = top.rtId;
    this.url = snap.url || this.url;
    this.title = snap.title;
    const focus: { ref?: number; frame?: { rec: FrameRec; id: number } } = {};
    if (snap.focused !== undefined && top.rtId !== undefined) focus.ref = this.refFor(top.rtId, snap.focused);
    const roots = await this.convert(top, snap.roots, budget, 0, focus, snap.focusedFrame);
    return { roots, ...(focus.ref === undefined ? {} : { focusedRef: focus.ref }), ...(snap.unread === undefined ? {} : { unread: snap.unread }) };
  }

  private async convert(rec: FrameRec, nodes: readonly RtNode[], budget: { frames: number }, depth: number, focus: { ref?: number }, focusedFrame?: number): Promise<TabNode[]> {
    const rtId = rec.rtId!;
    if (depth === 0 || nodes.some((n) => n.frame === true)) await this.ensureOwners(rec);
    const out: TabNode[] = [];
    for (const n of nodes) {
      const t: TabNode = {
        ref: this.refFor(rtId, n.id), role: n.role, states: n.states ?? [], children: [],
        ...(n.name === undefined ? {} : { name: n.name }), ...(n.value === undefined ? {} : { value: n.value }),
        ...(n.showEmptyValue === true ? { showEmptyValue: true } : {}), ...(n.secure === true ? { secure: true } : {}),
        ...(n.level === undefined ? {} : { level: n.level }), ...(n.href === undefined ? {} : { href: n.href }),
        ...(n.origin === undefined ? {} : { origin: n.origin }), ...(n.items === undefined ? {} : { items: n.items }),
        ...(n.off === true ? { off: true } : {}), ...(n.unread === undefined ? {} : { unread: n.unread }),
      };
      if (n.frame === true) {
        const child = this.childFrameFor(rec, n.id);
        if (child === undefined) {
          t.note = "its content can't be read";
        } else if (depth >= MAX_FRAME_DEPTH || budget.frames >= MAX_FRAMES) {
          t.note = "too many frames to read — state({within:<this ref>})";
        } else {
          budget.frames++;
          try {
            const cs = await this.callFresh<RtSnapshot>(child, "snapshot", {});
            const inner: { ref?: number } = {};
            if (focusedFrame === n.id && cs.focused !== undefined && child.rtId !== undefined) focus.ref = this.refFor(child.rtId, cs.focused);
            t.children = await this.convert(child, cs.roots, budget, depth + 1, focusedFrame === n.id ? focus : inner, cs.focusedFrame);
          } catch {
            t.note = "its content can't be read";
          }
        }
      } else if (n.children !== undefined) {
        t.children = await this.convert(rec, n.children, budget, depth, focus, focusedFrame);
      }
      out.push(t);
    }
    return out;
  }

  private header(settle?: { settled: boolean; ms: number }, focusedRef?: number, unread?: number, scoped = false): TabHeader {
    const notes: string[] = [];
    if (this.fileChooser !== undefined) notes.push("the page asked for a file — use upload(ref, paths) on its file input");
    return {
      title: this.shownTitle, url: this.shownUrl,
      ...(focusedRef === undefined ? {} : { focusedRef }), ...(settle === undefined ? {} : { settle }),
      ...(this.newPage && !scoped ? { newPage: true } : {}), ...(unread === undefined ? {} : { unread }),
      ...(this.dialog === undefined ? {} : { dialog: this.dialog }), ...(notes.length === 0 ? {} : { notes }),
    };
  }

  /** The tab's state: full, or a diff against `since` when that snapshot is still held and less than half changed. */
  async state(o: { within?: number; full?: boolean; since?: string; settle?: { maxMs: number } }): Promise<TabStateResult> {
    let settle: { settled: boolean; ms: number } | undefined;
    if (o.settle !== undefined) {
      const w = await this.waitForIdle(150, o.settle.maxMs);
      settle = { settled: w.settled, ms: w.waitedMs };
    }
    const id = `ts${++this.snapCounter}`;
    if (this.dialog !== undefined) {
      // The page is paused while its dialog is open: only the dialog can be read (and answered).
      const text = fullState(this.header(settle), [], false) + "\n(the page is paused until its dialog is answered)";
      return { text, snapshotId: id, isDiff: false, ...(settle === undefined ? {} : { settled: settle.settled, waitedMs: settle.ms }) };
    }
    const tree = await this.readTree(o.within);
    const header = this.header(settle, tree.focusedRef, tree.unread, o.within !== undefined);
    const snap = makeSnapshot(id, tree.roots, o.within);
    let text = fullState(header, tree.roots, o.within === undefined && o.full !== true);
    let isDiff = false;
    if (o.since !== undefined && o.full !== true) {
      const old = this.snapshots.find((s) => s.id === o.since);
      if (old !== undefined && old.scope === o.within) {
        const d = diffState(header, old, snap);
        if (d.changedRatio <= 0.5) { text = d.text; isDiff = true; }
      }
    }
    this.snapshots.push(snap);
    if (this.snapshots.length > SNAPSHOTS_KEPT) this.snapshots.shift();
    if (o.within === undefined) this.newPage = false;
    return { text, snapshotId: id, isDiff, ...(settle === undefined ? {} : { settled: settle.settled, waitedMs: settle.ms }) };
  }

  async find(q: RtFindQuery): Promise<Array<{ ref: number; role: string; name?: string; value?: string; states?: string[] }>> {
    this.requireNoDialog("find()");
    const top = this.top();
    const out: Array<{ ref: number; role: string; name?: string; value?: string; states?: string[] }> = [];
    const visit = async (rec: FrameRec, depth: number): Promise<void> => {
      const found = await this.callFresh<RtFound[]>(rec, "find", q);
      for (const f of found) if (out.length < 50) out.push({ ref: this.refFor(rec.rtId!, f.id), role: f.role, ...(f.name === undefined ? {} : { name: f.name }), ...(f.value === undefined ? {} : { value: f.value }), ...(f.states === undefined ? {} : { states: f.states }) });
      if (depth >= MAX_FRAME_DEPTH) return;
      for (const c of [...this.frames.values()].filter((x) => x.parentId === rec.frameId)) {
        try { await visit(c, depth + 1); } catch { /* an unreadable frame */ }
      }
    };
    await this.settleChildSetups();
    await visit(top, 0);
    return out;
  }

  async text(markdown: boolean): Promise<string> {
    this.requireNoDialog("text()");
    await this.settleChildSetups();
    const top = this.top();
    const parts = [await this.callFresh<string>(top, "text", { markdown })];
    let frames = 0;
    for (const c of this.frames.values()) {
      if (c === top || frames >= MAX_FRAMES) continue;
      frames++;
      try {
        const t = await this.callFresh<string>(c, "text", { markdown });
        if (t.trim().length > 0) parts.push(`--- frame ${hostLabel(c.url)} ---\n${t}`);
      } catch { /* an unreadable frame */ }
    }
    return parts.join("\n\n");
  }

  async quietInfo(): Promise<{ sinceMutationMs: number; url: string; title: string; readyState: string }> {
    const q = await this.callFresh<{ sinceMutationMs: number; url: string; title: string; readyState: string }>(this.top(), "quiet", null);
    this.url = q.url || this.url;
    this.title = q.title;
    return q;
  }

  // ── waits ──────────────────────────────────────────────────────────────────────────────────────

  private async waitUntil(pred: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (pred()) return true;
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        this.pokes.delete(check);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const check = (): void => { if (this.gone !== undefined || pred()) finish(pred()); };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(pred()), Math.max(0, timeoutMs));
      this.pokes.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** No DOM mutation, no pending load and no new network request for `quietMs`, within `timeoutMs`. */
  async waitForIdle(quietMs: number, timeoutMs: number, signal?: AbortSignal): Promise<{ settled: boolean; waitedMs: number }> {
    const q = Math.max(30, quietMs);
    const start = this.now();
    for (;;) {
      if (this.dialog !== undefined) return { settled: false, waitedMs: this.now() - start };
      let info: { sinceMutationMs: number; readyState: string } | undefined;
      try { info = await this.quietInfo(); } catch (err) { if (!isContextGone(err) && !(err instanceof AutomationFailure)) throw err; }
      const elapsed = this.now() - start;
      const netQuiet = this.now() - this.lastRequestAt >= q;
      if (info !== undefined && info.sinceMutationMs >= q && info.readyState !== "loading" && netQuiet) return { settled: true, waitedMs: elapsed };
      if (elapsed >= timeoutMs || signal?.aborted === true) return { settled: false, waitedMs: elapsed };
      await sleep(Math.min(50, timeoutMs - elapsed));
    }
  }

  /** `waitFor`: the runtime's observer plus a 100 ms poll; `WaitTimeout` with what was seen. */
  async waitFor(cond: RtCondition & { refs?: number[]; goneRefs?: number[] }, timeoutMs: number, signal?: AbortSignal): Promise<{ waitedMs: number }> {
    const start = this.now();
    const ids = (refs: number[] | undefined, gone: boolean): number[] | undefined => {
      if (refs === undefined) return undefined;
      const out: number[] = [];
      for (const r of refs) {
        try { out.push(this.resolve(r).id); } catch (err) { if (!gone) throw err; }
      }
      return out;
    };
    let seen = "";
    for (;;) {
      if (this.dialog !== undefined) throw new AutomationFailure("TargetBusy", this.dialogBusySentence());
      const c: RtCondition = { ...cond, ...(cond.refs === undefined ? {} : { ids: ids(cond.refs, false)! }), ...(cond.goneRefs === undefined ? {} : { goneIds: ids(cond.goneRefs, true)! }) };
      delete (c as { refs?: unknown }).refs;
      delete (c as { goneRefs?: unknown }).goneRefs;
      let res: RtCheck | undefined;
      try { res = await this.callFresh<RtCheck>(this.top(), "check", c); } catch (err) { if (!isContextGone(err)) throw err; }
      if (res !== undefined) {
        seen = res.seen;
        if (res.met) return { waitedMs: this.now() - start };
      }
      const left = timeoutMs - (this.now() - start);
      if (left <= 0 || signal?.aborted === true) {
        throw new AutomationFailure("WaitTimeout", `the wait timed out without the condition being met${seen.length > 0 ? ` — seen: ${seen.slice(0, 2_000)}` : ""}`);
      }
      try { await this.callFresh<boolean>(this.top(), "waitChange", { maxMs: Math.min(100, left) }); } catch { await sleep(Math.min(100, left)); }
    }
  }

  // ── input ──────────────────────────────────────────────────────────────────────────────────────

  /** The daemon's own words (no page text: they are shown outside the fence) — state() shows the dialog itself. */
  dialogBusySentence(): string {
    return `a page dialog is open (${this.dialog?.type ?? "alert"}) — state() shows it; click its OK or Cancel first`;
  }

  requireNoDialog(what: string): void {
    if (this.dialog !== undefined) throw new AutomationFailure("TargetBusy", `${this.dialogBusySentence()} (${what} waits for it)`);
  }

  /** A ref → where to click in the top frame's viewport (CSS px), after the actionability check; `picker` names the
   *  native window pressing it would open (the engine refuses that). `guardMenu`: a right-click follows — the
   *  element's frame stops the browser's own context menu from opening (unless the page shows its own). */
  async pointForRef(ref: number, o: { guardMenu?: boolean } = {}): Promise<{ x: number; y: number; picker?: string }> {
    const { rec, id, rtId } = this.resolve(ref);
    const guard = o.guardMenu === true ? { guardMenu: true } : {};
    const p = await this.callIn<RtPoint>(rec, "point", { id, scroll: true, ...guard }, { expectRt: rtId });
    if (!p.ok) {
      switch (p.reason) {
        case "gone": throw stale(ref);
        case "hidden": throw new Error(`[${ref}] is not visible on the page`);
        case "disabled": throw new Error(`[${ref}] is disabled — pressing it does nothing`);
        case "offscreen": throw new Error(`[${ref}] is off screen even after scrolling it into view`);
        case "covered": {
          const by = this.refFor(rtId, p.by.id);
          throw new Error(`[${ref}] is covered by [${by}] ${p.by.role}${p.by.name === undefined ? "" : ` "${p.by.name}"`} — dismiss it first`);
        }
      }
    }
    const picker = p.picker === undefined ? {} : { picker: p.picker };
    if (rec.parentId === undefined) return { x: p.x, y: p.y, ...picker };
    // In a child frame: every ancestor brings this point into its view, then the frame paints where it now is
    // before the click (an out-of-process frame is hit-tested by where it last painted).
    const origin = await this.frameOrigin(rec, { x: p.x, y: p.y });
    await this.callIn<RtPoint>(rec, "point", { id, scroll: false, settle: true, ...guard }, { expectRt: rtId });
    return { x: p.x + origin.x, y: p.y + origin.y, ...picker };
  }

  /** The native picker control at a viewport point (CSS px), looked for through the frames there — undefined when
   *  the point hits none. Before a press at a pixel point (`guardMenu`: a right-click — every frame on the way stops
   *  the browser's own context menu). */
  async pickerAt(x: number, y: number, o: { guardMenu?: boolean } = {}): Promise<string | undefined> {
    let rec = this.top();
    let px = x, py = y;
    for (let depth = 0; depth <= MAX_FRAME_DEPTH; depth++) {
      const hit = await this.callFresh<RtHit>(rec, "hitAt", { x: px, y: py, ...(o.guardMenu === true ? { guardMenu: true } : {}) });
      if (hit.picker !== undefined) return hit.picker;
      if (hit.frame === undefined) return undefined;
      await this.ensureOwners(rec);
      const child = this.childFrameFor(rec, hit.frame);
      if (child === undefined) return undefined;
      const off = await this.callIn<{ x: number; y: number } | null>(rec, "frameOffset", { id: hit.frame });
      if (off === null) return undefined;
      px -= off.x; py -= off.y;
      rec = child;
    }
    return undefined;
  }

  /** A point in a screenshot → CSS px of the viewport. */
  pointForShot(shotId: string | undefined, x: number, y: number): { x: number; y: number } {
    const shot = shotId === undefined ? undefined : this.shots.get(shotId);
    if (shot === undefined) throw new AutomationFailure("NotAllowed", "a point is pixels in this tab's latest screenshot — take tab.screenshot() first, or use an element ref");
    return toCss(shot, x, y);
  }

  async mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  }

  async click(at: { x: number; y: number }, o: { button?: unknown; count?: unknown; modifiers?: unknown }): Promise<void> {
    const { button, buttons } = buttonOf(o.button);
    const count = o.count === 2 || o.count === 3 ? o.count : 1;
    const modifiers = modifiersOf(o.modifiers);
    this.overlay(true, { x: at.x, y: at.y, kind: "press" });
    await this.mouse("mouseMoved", at.x, at.y, { modifiers });
    for (let i = 1; i <= count; i++) {
      await this.mouse("mousePressed", at.x, at.y, { button, buttons, clickCount: i, modifiers });
      await this.mouse("mouseReleased", at.x, at.y, { button, buttons: 0, clickCount: i, modifiers });
    }
  }

  async hover(at: { x: number; y: number }, ms: number, signal?: AbortSignal): Promise<void> {
    this.overlay(true, { x: at.x, y: at.y, kind: "move" });
    await this.mouse("mouseMoved", at.x, at.y);
    await this.waitUntil(() => false, ms, signal);
  }

  async scroll(at: { x: number; y: number }, direction: string, pages: number): Promise<void> {
    const [vw, vh] = await this.viewportSize();
    const dy = direction === "down" ? vh * 0.8 * pages : direction === "up" ? -vh * 0.8 * pages : 0;
    const dx = direction === "right" ? vw * 0.8 * pages : direction === "left" ? -vw * 0.8 * pages : 0;
    this.overlay(true, { x: at.x, y: at.y, kind: "scroll" });
    await this.mouse("mouseWheel", at.x, at.y, { deltaX: dx, deltaY: dy });
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    this.overlay(true, { x: from.x, y: from.y, kind: "press" });
    await this.mouse("mouseMoved", from.x, from.y);
    await this.mouse("mousePressed", from.x, from.y, { button: "left", buttons: 1, clickCount: 1 });
    const steps = 8;
    try {
      for (let i = 1; i <= steps; i++) {
        stopIfAborted(signal);
        await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { button: "left", buttons: 1 });
      }
    } finally {
      // The button is let go even when the run stops mid-drag: never leave the page holding a pressed button.
      if (this.dialog === undefined && this.gone === undefined) await this.mouse("mouseReleased", signal?.aborted === true ? from.x : to.x, signal?.aborted === true ? from.y : to.y, { button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
    }
  }

  /** The keyboard's target, classified by the runtime (fails closed): `into`'s element (focused first), else the
   *  focused element, followed into child frames. */
  async keyboardTarget(into: number | undefined): Promise<{ editable: boolean; ref?: number; label?: string; frame: FrameRec }> {
    let rec: FrameRec;
    let c: RtClassify;
    if (into !== undefined) {
      const r = this.resolve(into);
      rec = r.rec;
      c = await this.callIn<RtClassify>(rec, "focus", { id: r.id }, { expectRt: r.rtId });
    } else {
      rec = this.top();
      c = await this.callFresh<RtClassify>(rec, "classify", {});
    }
    for (let depth = 0; c.kind === "frame" && depth < MAX_FRAME_DEPTH; depth++) {
      await this.ensureOwners(rec);
      const child = this.childFrameFor(rec, c.id);
      if (child === undefined) { c = { kind: "unknown" }; break; }
      rec = child;
      c = await this.callFresh<RtClassify>(rec, "classify", {});
    }
    if (c.kind === "secure") throw new AutomationFailure("Refused", SECURE_FIELD_SENTENCE);
    if (c.kind === "picker") {
      const ref = rec.rtId === undefined ? undefined : this.refFor(rec.rtId, c.id);
      throw new AutomationFailure("Refused", pickerSentence(ref, c.what));
    }
    if (c.kind !== "ok") throw new AutomationFailure("Refused", FOCUS_UNKNOWN_SENTENCE("this tab"));
    const ref = c.id === undefined || rec.rtId === undefined ? undefined : this.refFor(rec.rtId, c.id);
    const label = ref === undefined ? undefined : `[${ref}] ${c.role ?? "element"}${c.name === undefined ? "" : ` "${c.name}"`}`;
    return { editable: c.editable, ...(ref === undefined ? {} : { ref }), ...(label === undefined ? {} : { label }), frame: rec };
  }

  /** Text as key presses (≤ 200 characters on one line: a page's key listeners see them), else inserted at once. */
  async typeText(text: string, signal?: AbortSignal): Promise<void> {
    if ([...text].length <= TYPE_AS_KEYS_MAX && !/[\r\n]/.test(text)) {
      for (const ch of text) {
        stopIfAborted(signal);
        const k = keyForChar(ch);
        if (k === undefined) { await this.send("Input.insertText", { text: ch }); continue; }
        const [down, up] = keyEvents({ modifiers: k.shift ? 8 : 0, def: k });
        await this.send("Input.dispatchKeyEvent", down);
        await this.send("Input.dispatchKeyEvent", up);
      }
      return;
    }
    await this.send("Input.insertText", { text });
  }

  async insertText(text: string): Promise<void> { await this.send("Input.insertText", { text }); }

  async press(p: KeyPress, repeat: number, signal?: AbortSignal): Promise<void> {
    const [down, up] = keyEvents(p);
    for (let i = 0; i < repeat; i++) {
      stopIfAborted(signal);
      await this.send("Input.dispatchKeyEvent", down);
      await this.send("Input.dispatchKeyEvent", up);
    }
  }

  parseKey(combo: string): KeyPress { return parseCombo(combo); }

  async readBack(ref: number): Promise<string | null> {
    try {
      const { rec, id, rtId } = this.resolve(ref);
      return await this.callIn<string | null>(rec, "readValue", { id }, { expectRt: rtId });
    } catch { return null; }
  }

  /** A synthetic paste in the frame that holds the focused field (`keyboardTarget`'s `frame`). */
  async pasteEvent(frame: FrameRec, html: string | undefined, text: string): Promise<boolean> {
    const r = await this.callFresh<{ handled: boolean }>(frame, "pasteEvent", { ...(html === undefined ? {} : { html }), text });
    return r.handled;
  }

  async setValue(ref: number, value: string): Promise<string> {
    const { rec, id, rtId } = this.resolve(ref);
    const r = await this.callIn<{ ok: true; shown: string } | { ok: false; reason: string }>(rec, "setValue", { id, value }, { expectRt: rtId });
    if (!r.ok) {
      if (r.reason === "secure_field") throw new AutomationFailure("Refused", SECURE_FIELD_SENTENCE);
      if (r.reason === "gone") throw stale(ref);
      throw new Error(`[${ref}]: ${r.reason}`);
    }
    return r.shown;
  }

  async select(ref: number, text: string, o: { before?: string; after?: string; caret?: "start" | "end" }): Promise<void> {
    const { rec, id, rtId } = this.resolve(ref);
    const r = await this.callIn<{ ok: true } | { ok: false; reason: string }>(rec, "select", { id, text, ...o }, { expectRt: rtId });
    if (!r.ok) {
      if (r.reason === "secure_field") throw new AutomationFailure("Refused", SECURE_FIELD_SENTENCE);
      if (r.reason === "gone") throw stale(ref);
      throw new Error(`[${ref}]: ${r.reason}`);
    }
  }

  /** `DOM.setFileInputFiles` on a file input ref (paths already checked by the engine). */
  async upload(ref: number, files: string[]): Promise<void> {
    const { rec, id, rtId } = this.resolve(ref);
    const fi = await this.callIn<{ ok: true; multiple: boolean } | { ok: false; reason: string }>(rec, "fileInput", { id }, { expectRt: rtId });
    if (!fi.ok) {
      if (fi.reason === "gone") throw stale(ref);
      throw new Error(`[${ref}] is ${fi.reason === "not a file input" ? "not a file input — upload() takes an input[type=file] ref" : fi.reason}`);
    }
    if (!fi.multiple && files.length > 1) throw new Error(`[${ref}] takes one file`);
    const objectId = await this.callIn<string | undefined>(rec, "element", { id }, { byValue: false, expectRt: rtId });
    if (objectId === undefined) throw stale(ref);
    try {
      await this.send("DOM.setFileInputFiles", { files, objectId }, rec.ctxSession);
    } finally {
      void this.send("Runtime.releaseObject", { objectId }, rec.ctxSession).catch(() => undefined);
    }
    this.fileChooser = undefined;
  }

  /** Answer the open dialog (its OK / Cancel ref), with the prompt's reply. */
  async answerDialog(ref: number): Promise<void> {
    const d = this.dialog;
    if (d === undefined) throw stale(ref);
    if (ref === d.promptRef) throw new Error(`[${ref}] is the dialog's text field — setValue() it, then click OK`);
    const accept = ref === d.okRef;
    await this.send("Page.handleJavaScriptDialog", { accept, ...(d.type === "prompt" && accept ? { promptText: d.promptText ?? "" } : {}) }, d.session);
    this.dialog = undefined;
  }

  // ── navigation ─────────────────────────────────────────────────────────────────────────────────

  /** `Page.navigate` and wait for the new page (commit + DOMContentLoaded, at most 10 s). `false`: still loading.
   *  `sessionId`: the navigation may be carried out by the browser itself across a detach (`navigation`). */
  async goto(url: string, signal?: AbortSignal, sessionId?: string): Promise<boolean> {
    const from = this.url;
    return await this.navigation(sessionId, (now) => sameDocUrl(now, url) || !sameDocUrl(now, from), signal, async (d0) => {
      const before = this.navSeq;
      const r = await this.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url });
      if (typeof r.errorText === "string" && r.errorText.length > 0) throw new Error(`${r.errorText} — the page could not be loaded`);
      if (r.loaderId === undefined) return await this.waitUntil(() => this.navSeq > before || this.detaches !== d0, 2_000, signal) || true;
      return await this.waitLoaded(() => this.lastCommitLoader === r.loaderId && this.navSeq > before, d0, signal);
    });
  }

  private async waitLoaded(committed: () => boolean, d0: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.now() + NAVIGATION_WAIT_MS;
    const detached = (): boolean => this.detaches !== d0;
    const ok = await this.waitUntil(() => committed() || this.dialog !== undefined || this.gone !== undefined || detached(), NAVIGATION_WAIT_MS, signal);
    if (this.gone !== undefined) throw this.lost();
    if (detached()) return false;
    if (!ok) return false;
    if (this.dialog !== undefined) return true;
    if (this.lastCommitType === "BackForwardCacheRestore" || this.lastCommitType === "sameDocument") return true;
    const loader = this.lastCommitLoader;
    return await this.waitUntil(() => (loader !== undefined && this.dclLoader === loader) || this.dialog !== undefined || this.gone !== undefined || detached(), Math.max(0, deadline - this.now()), signal);
  }

  async history(step: -1 | 1, signal?: AbortSignal, sessionId?: string): Promise<boolean> {
    const h = await this.send<{ currentIndex: number; entries: Array<{ id: number; url?: string }> }>("Page.getNavigationHistory");
    const entry = h.entries[h.currentIndex + step];
    if (entry === undefined) throw new Error(step < 0 ? "no page to go back to" : "no page to go forward to");
    const from = this.url;
    const want = entry.url;
    return await this.navigation(sessionId, (now) => (want !== undefined && sameDocUrl(now, want)) || !sameDocUrl(now, from), signal, async (d0) => {
      const before = this.navSeq;
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      return await this.waitLoaded(() => this.navSeq > before, d0, signal);
    });
  }

  async reload(signal?: AbortSignal, sessionId?: string): Promise<boolean> {
    return await this.navigation(sessionId, undefined, signal, async (d0) => {
      const before = this.navSeq;
      await this.send("Page.reload", {});
      return await this.waitLoaded(() => this.navSeq > before, d0, signal);
    });
  }

  /**
   * One navigation. The browser may carry it out BY ITSELF and let the debugger go meanwhile (Winter for Chrome
   * navigates an agent tab with a `beforeunload` page through the tabs API, so the dialog never brings it to the front):
   * a detach during the navigation — or the navigate refused because the tab let go — is not the tab lost. The tab is
   * attached again (a fresh world: every ref is new), the new document awaited, and its URL checked (`arrived`: where it
   * was sent, or at least not where it was). `false`: still loading after 10 s.
   */
  private async navigation(sessionId: string | undefined, arrived: ((url: string) => boolean) | undefined, signal: AbortSignal | undefined, go: (d0: number) => Promise<boolean>): Promise<boolean> {
    const d0 = this.detaches;
    try {
      const loaded = await go(d0);
      if (this.detaches === d0) return loaded;
    } catch (err) {
      if (this.detaches === d0 || sessionId === undefined || this.gone !== undefined) throw err;
    }
    if (sessionId === undefined) return false;
    return await this.reattachAfterNavigation(sessionId, arrived, signal);
  }

  private async reattachAfterNavigation(sessionId: string, arrived: ((url: string) => boolean) | undefined, signal: AbortSignal | undefined): Promise<boolean> {
    const deadline = this.now() + NAVIGATION_WAIT_MS;
    // The tab may be between documents for a moment: its attach is retried until the navigation's deadline.
    for (;;) {
      try { await this.ensureAttached(sessionId, { transient: true }); break; } catch (err) {
        if (!(err instanceof TabBetween)) throw err;
        if (this.now() >= deadline || signal?.aborted === true) { this.gone ??= "closed"; throw this.lost(); }
        await this.waitUntil(() => false, 100, signal);
      }
    }
    for (;;) {
      if (this.gone !== undefined) throw this.lost();
      if (this.dialog !== undefined) return true;
      try {
        const q = await this.quietInfo();
        if (q.readyState !== "loading" && (arrived === undefined || arrived(q.url))) return true;
      } catch (err) {
        if (!isContextGone(err) && !(err instanceof AutomationFailure && err.kind !== "TargetLost")) throw err;
      }
      if (this.now() >= deadline || signal?.aborted === true) return false;
      await this.waitUntil(() => false, 100, signal);
    }
  }

  /** After a tab was opened: wait (at most 10 s) until its document is the one asked for and has loaded. */
  async waitOpened(wantUrl: string, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.now() + NAVIGATION_WAIT_MS;
    for (;;) {
      if (this.gone !== undefined) throw this.lost();
      if (this.dialog !== undefined) return true;
      try {
        const q = await this.quietInfo();
        const there = wantUrl === "about:blank" || q.url !== "about:blank";
        if (there && q.readyState !== "loading") return true;
      } catch (err) { if (!isContextGone(err) && !(err instanceof AutomationFailure)) throw err; }
      if (this.now() >= deadline || signal?.aborted === true) return false;
      await this.waitUntil(() => false, 100, signal);
    }
  }

  // ── screenshots ────────────────────────────────────────────────────────────────────────────────

  private async viewportSize(): Promise<[number, number]> {
    try {
      const m = await this.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics");
      if (m.cssVisualViewport !== undefined) return [m.cssVisualViewport.clientWidth, m.cssVisualViewport.clientHeight];
    } catch { /* fall back to the attach answer */ }
    return this.viewport;
  }

  /** One JPEG at the budget; its frame is kept so a Point maps back to CSS px. */
  async screenshot(budget: ScreenshotBudget, region: CssRect | undefined, quality: number): Promise<{ shotId: string; imageBase64: string; width: number; height: number; css: CssRect }> {
    this.requireNoDialog("screenshot()");
    const m = await this.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics");
    const vv = m.cssVisualViewport;
    const css: CssRect = region === undefined
      ? { x: 0, y: 0, width: vv.clientWidth, height: vv.clientHeight }
      : { x: Math.max(0, region.x), y: Math.max(0, region.y), width: Math.max(1, Math.min(region.width, vv.clientWidth - Math.max(0, region.x))), height: Math.max(1, Math.min(region.height, vv.clientHeight - Math.max(0, region.y))) };
    let scale = scaleFor(css, this.dpr, budget);
    let shot: { data: string } | undefined;
    let size: { width: number; height: number } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      shot = await this.send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg", quality: Math.round(quality * 100), fromSurface: true,
        clip: { x: vv.pageX + css.x, y: vv.pageY + css.y, width: css.width, height: css.height, scale },
      }, undefined, 20_000);
      const assumed = outputSize(css, scale, this.dpr);
      size = imageSize(shot.data) ?? { width: assumed.w, height: assumed.h };
      if (fitsBudget(size.width, size.height, budget)) break;
      // The browser scaled differently than assumed (it did not apply the display's ratio): fit it once more.
      scale *= Math.min(budget.maxLongEdge / Math.max(size.width, size.height), 0.97);
    }
    const shotId = `tshot${++this.shotCounter}`;
    this.shots.set(shotId, { width: size!.width, height: size!.height, css });
    if (this.shots.size > 16) this.shots.delete(this.shots.keys().next().value!);
    return { shotId, imageBase64: shot!.data, width: size!.width, height: size!.height, css };
  }
}

interface FrameTreeNode { frame: { id: string; parentId?: string; url: string; urlFragment?: string }; childFrames?: FrameTreeNode[] }

/** An attach refused while the tab is between documents (`ensureAttached`'s `transient`): try again shortly. */
class TabBetween extends Error {}

/** Two URLs name the same document (the fragment and a trailing slash aside). */
function sameDocUrl(a: string, b: string): boolean {
  const norm = (u: string): string => { const h = u.indexOf("#"); const base = h < 0 ? u : u.slice(0, h); return base.endsWith("/") ? base.slice(0, -1) : base; };
  return norm(a) === norm(b);
}

/** Stop a sequence of input events between two of them when the run was cancelled. */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AutomationFailure("Cancelled", "the script was cancelled — the input stopped partway");
}

/** The refusal for pointer or keyboard input on a native picker control: its window would open on the user's screen. */
export function pickerSentence(ref: number | undefined, what: string): string {
  return `${ref === undefined ? "that control" : `[${ref}]`} opens ${what} when pressed or keyed — use ${pickerAdvice(what)} instead`;
}

/** A tab's URL as the model reads it: Winter's start page (a `data:` URL, loaded for about:blank) reads as about:blank. */
export function shownUrl(url: string): string {
  return url.startsWith("data:") ? "about:blank" : url;
}

/** The CDP said the context (the document) the call was aimed at is gone. */
export function isContextGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot find context|context was destroyed|Execution context|No frame|Cannot find default execution context|uniqueContextId/i.test(msg);
}

function hostLabel(url: string): string {
  try { return new URL(url).host || url.slice(0, 60); } catch { return url.slice(0, 60); }
}
