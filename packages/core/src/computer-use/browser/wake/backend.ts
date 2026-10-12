// ComputerV2 — WAKE TRIGGERS on browser tabs: the `WakeBackend` for tab bindings (`bt_…`), built beside the browser
// engine. The registry (`wakes/registry.ts`) arms and disarms; this backend watches, and reports the ONE event that ends a
// trigger (`fired` or `lost`).
//
// TWO PATHS, one watcher (`page-runtime/watch.ts`):
//  - DEBUGGER-FREE (Winter for Chrome 1.2.0, feature `watch`): the element is read in the winter world while the tab is
//    attached (role, name, the secure-field floor, a LOCATOR), then the extension injects the watcher into ITS OWN
//    isolated world — no debugger — and injects it again into each new document of the tab. The tab is let go at once:
//    no "is debugging this browser" bar while the user works.
//  - THE DEBUGGER PATH (Winter's built-in browser; a Winter for Chrome older than 1.2.0; an element inside a child
//    frame): the watcher runs in the frame's winter world and the backend LONG-POLLS it (`watchWait`, ≤ 20 s a round,
//    acknowledged, so an answer lost on the way is sent again; each poll names the watches the backend keeps, so one
//    whose disarm could not reach the page goes at the next), holding the tab (`wake:<id>`) for the trigger's life.
//    That hold is WATCH-ONLY (`TabDriver`): while only wake holders hold a tab, it changes nothing the user sees or does
//    — no file-chooser interception, no focus emulation, no emulated screen size, no agent overlay, and on the built-in
//    browser none of Winter.app's native-UI holds (link feature `watchOnly`: the page's dialogs, permission prompts, file
//    choosers, downloads, context menus, keys and focus are the user's). A primitive on the tab takes the full hold back;
//    the tab drops back after. A Winter.app without the feature never holds a built-in tab for a wake (refused, "update
//    Winter"). A page dialog is never answered or dismissed by the wake path, and the poller polls around one.
//
// The trigger outlives the script's binding: a reset, a worker restart, the worker's idle end and a turn end (the user's
// tab released, the built-in tab's hold let go) leave it armed — it keeps the tab's driver, never the binding. Only these
// end it: a cancel (`disarm`), the tab closing or crashing (`lost`), a ref condition's document going away (`lost`,
// unless the user's own press of that element or form came just before — then `fired`), and the backend's link dropping
// (`lost`: "Winter for Chrome disconnected" / "Winter isn't running").
//
// THE RULINGS (controller, 2026-10-12), each held by a test (`test/computer-use/browser-wake.test.ts`):
//  - NO SCOPE AT ARM: `arm` has no run, so it can raise no card. A tab on a dangerous-domains host is `NotAllowed` unless
//    the session already approved that host for the SESSION (a one-run approval does not count) or a saved
//    `WebFetch(domain:…)` rule allows it.
//  - A USER'S BROWSER needs the app allowed beyond one call (`persistentlyAllowed`), else the once-grant refusal.
//  - WINTER'S OWN INPUT is every Input.* and Page.navigate/reload/navigateToHistoryEntry the tab's driver sends, and the
//    whole act primitive the engine marks — from ANY session — with a 500 ms grace after it (`TabDriver.ownInputAt`);
//    an extension also stamps what its debugger sends (`own`); and the helper's input to the browser APP
//    (`BrowserEngineDeps.ownAppInputAt`, wired by the service). EVERY judgement of a trusted event or a transition goes
//    through `own()`, which asks all three: a press, a fire, the trusted input that made a submit or a change the user's
//    (`cause`), a URL change, a navigation's start, a state found true in a new document. What lands inside is never the
//    user's: an input event is dropped, a state transition is not counted (it becomes the baseline).
//  - A DOCUMENT WINTER'S OWN NAVIGATION LOADED sets the baseline of a page condition and never fires — decided when the
//    navigation STARTS (the top frame's `Page.frameStartedLoading`), not at its commit, which can come long after.
//  - ALREADY TRUE AT ARM: a state condition that holds when armed is refused `NotAllowed` with one daemon sentence.
//  - Only a false→true transition after arming fires; input conditions need the user's trusted DOM events, and a submit
//    or a change also a trusted pointer or key event of theirs on the submitter or in the form (the field) just before.
//  - HOLDS: a waiting tab's hold counts against the session's 8 and the 16 in all (`engine.wakeHoldRefusal`; refused
//    `TargetBusy`, naming `wakes.cancel`).
//  - AGENT TABS: an armed trigger keeps an agent tab open at a turn end — ANY session's trigger (a peer's wait keeps the
//    tab open too: `TabDriver.wakesArmed` counts them all). When the trigger ends, the tab gets the `handoff` mark if
//    its session is mid-turn (`engine.wakeEnded`), so the wake turn's end is where the ordinary rule applies.
//
// Floors: a headless tab is refused (nobody can see it); a secure field, or anything in a payment frame, is never
// watched (`Refused`, Phase 1's sentence); a content condition never fires on a page behind the dangerous-domain floor
// (it waits for the tab to leave it). Privacy: what a watcher reports is the kind, when, and the top URL's origin and path
// / the title, which are redacted here before they reach a `detail`; a `navigated` detail is the origin and path only
// ("?…" where a query was — a GET form's typed values never appear) and, for `{ url }`, the model's own words.
import { AutomationFailure } from "../../errors";
import { redactText, redactUrl } from "../page-runtime/redact";
import { watchUrlKey, watchUrlShape, type WatchArmResult, type WatchKind, type WatchSpec } from "../page-runtime/watch";
import type { BrowserEngine, WakeTabTarget } from "../engine";
import { familyOfBackendId } from "../families";
import { SECURE_FIELD_SENTENCE, shownUrl, WakeWorldGone, type TabDriver, type WakeFrame } from "../tab-driver";
import { TransportError, type CdpEvent, type CdpTransport, type TransportWatchEvent } from "../transport";
import type { WakeArmed, WakeArmRequest, WakeBackend, WakeBackendEvent, WakeCondition } from "../../wakes/types";

/** A long poll waits at most this long for an event (a round trip every 20 s keeps an older extension's idle detach off). */
export const WAKE_POLL_MS = 20_000;
/** A navigation (or the element going) this soon after the user's own press of the watched element or form: `fired`. */
export const WAKE_PRESS_NAV_MS = 3_000;
/** How long a lost world is tried again (a new document still loading) before the trigger is `lost`. */
export const WAKE_RECOVER_MS = 20_000;
/** A tab reported closed may be one the browser gave a new id to navigate it (the engine's `rekey` revives its driver
 *  within this long): the trigger is lost only if it stays closed. */
export const WAKE_CLOSED_GRACE_MS = 2_000;

export const WAKE_HEADLESS = "nobody can see a headless tab — the user can't act in it; open the page with browsers.open(url) in Winter's browser and wait there";
export const WAKE_OLD_EXTENSION_NOTE = "this Winter for Chrome is older than 1.2.0, so Winter keeps the browser's debugger on the tab while it waits (its debugging bar shows) — update Winter for Chrome to wait without the debugging bar";
export const WAKE_IN_FRAME_NOTE = "the element is inside a frame of the page, so Winter keeps the browser's debugger on the tab while it waits (its debugging bar shows)";
/** A Winter.app without the link feature `watchOnly` would hold the tab with every native-UI hold on for the whole wait
 *  (the user's dialogs unseen, their file chooser cancelled): never. */
export const WAKE_UPDATE_WINTER = "this Winter's app can't wait on a built-in tab without taking it from the user — update Winter to wait on a built-in tab";

const STATE_KINDS: ReadonlySet<string> = new Set(["appeared", "gone", "titled"]);
const INPUT_KINDS: ReadonlySet<string> = new Set(["clicked", "submitted", "changed"]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const bad = (message: string): Error => Object.assign(new TypeError(message), { name: "TypeError" });
const quoted = (s: string, max = 60): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};

/** The pill on the page — fixed words per kind, naming only the element's own label (never the model's words). */
export function wakePill(kind: WatchKind, label: string, o: { anyForm?: boolean } = {}): string {
  const l = label.replace(/\s+/g, " ").trim();
  const it = l.length === 0 ? "the marked element" : quoted(l);
  switch (kind) {
    case "clicked": return `Winter continues when you click ${it}`;
    case "submitted": return o.anyForm === true ? "Winter continues when you submit a form on this page" : `Winter continues when you submit ${it}`;
    case "changed": return `Winter continues when you change ${it}`;
    case "gone": return l.length === 0 && o.anyForm === true ? "Winter continues when this page changes" : `Winter continues when ${it} goes away`;
    case "titled": return "Winter continues when this page's title changes";
    case "navigated": return "Winter continues when you go to another page";
    default: return "Winter continues when this page changes";
  }
}

/** A `navigated` detail's address: origin and path only (redacted), "?…" where a query was and "#…" where a fragment
 *  was — a GET form's typed values never appear. */
export function wakeUrlShape(url: string): string {
  const shown = shownUrl(url);
  let u: URL;
  try { u = new URL(shown); } catch { return "another page"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return redactUrl(`${u.protocol}${u.pathname}`).slice(0, 300);
  return `${redactUrl(`${u.origin}${u.pathname}`).slice(0, 300)}${u.search.length > 1 ? "?…" : ""}${u.hash.length > 1 ? "#…" : ""}`;
}

interface Armed {
  req: WakeArmRequest;
  onEvent: (e: WakeBackendEvent) => void;
  target: WakeTabTarget;
  driver: TabDriver;
  transport: CdpTransport;
  path: "cdp" | "ext";
  spec: WatchSpec;
  /** The element's ref (a ref condition). */
  ref?: number;
  /** The debugger path: the watch's frame now, its holder, its poller's key. */
  frame?: WakeFrame;
  holder: string;
  pollKey?: string;
  /** The document the watch was last armed in (`performance.timeOrigin`). */
  doc?: number;
  /** The user's own press of the watched element or form (a navigation or the element going right after it fires). */
  pressedAt?: number;
  /** navigated: the address it compares with (`watchUrlKey`), and (with words) whether they were met. */
  baseKey: string;
  urlMet?: boolean;
  ended: boolean;
  off: Array<() => void>;
}

interface Poller {
  key: string;
  driver: TabDriver;
  frame: WakeFrame;
  wakes: Set<string>;
  /** The watcher world polled, and the last of its events taken. */
  world?: string;
  ack: number;
  running: boolean;
}

/** The debugger path's view of a tab's top-level navigations: when the last one started and whether Winter's own input
 *  started it. */
interface NavHook { off: () => void; startAt: number; own: boolean; commitAt: number }

export interface BrowserWakeBackendDeps {
  now?(): number;
  log?(line: string): void;
  /** Tests: shorter waits. */
  pollMs?: number;
  recoverMs?: number;
  closedGraceMs?: number;
}

export class BrowserWakeBackend implements WakeBackend {
  private readonly armed = new Map<string, Armed>();
  private readonly pollers = new Map<string, Poller>();
  private readonly hookedTransports = new Set<CdpTransport>();
  /** Per tab (driver): its navigation hook (debugger path only), removed when its last watch ends. */
  private readonly navHooks = new Map<TabDriver, NavHook>();
  /** Watches being armed in a page now: named in every poll too, so a poll in flight never drops one. */
  private readonly arming = new Set<string>();
  private stopped = false;
  private pollerSeq = 0;

  constructor(private readonly engine: BrowserEngine, private readonly deps: BrowserWakeBackendDeps = {}) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  // ── arm ─────────────────────────────────────────────────────────────────────────────────────────────

  async arm(req: WakeArmRequest, onEvent: (e: WakeBackendEvent) => void): Promise<WakeArmed> {
    if (this.stopped) throw new AutomationFailure("BrowserUnavailable", "Winter is shutting down");
    const t = this.engine.wakeTarget(req.sessionId, req.targetId);
    if (t.family === "headless") throw new AutomationFailure("NotAllowed", WAKE_HEADLESS);
    if (t.bundleId !== undefined && !this.engine.wakeAllowed(req.sessionId, t.bundleId)) {
      throw new AutomationFailure("NotAllowed", `${t.browserName} was allowed for one call only — a wake trigger needs it allowed for this session`);
    }
    const driver = t.driver;
    const transport = driver.transport;
    // Winter's built-in browser can't be watched without a hold (its CDP needs one): only a watch-only hold, never one
    // with Winter.app's native-UI holds on for the whole wait.
    if (t.family === "winter" && transport.watchOnlyHolds !== true) throw new AutomationFailure("NotAllowed", WAKE_UPDATE_WINTER);
    const c = req.condition;
    const ref = "ref" in c && c.ref !== undefined ? parseRef(c.ref) : undefined;
    const holder = `wake:${req.wakeId}`;
    // Attached for the arm (the run that arms has it attached already; the debugger-free path lets go after). The
    // holder names its session first, so the hold is made for it.
    driver.wakeHolders.set(holder, req.sessionId);
    this.arming.add(req.wakeId);
    let keepHold = false;
    try {
      await driver.ensureAttached(holder);
      if (driver.dialog !== undefined) throw new AutomationFailure("TargetBusy", `${driver.dialogBusySentence()} (wakeWhen() waits for it)`);
      try { await driver.quietInfo(); } catch { /* the last committed URL and title */ }
      const host = this.engine.wakeSiteBlocked(req.sessionId, driver.url);
      if (host !== undefined) {
        throw new AutomationFailure("NotAllowed", `this tab is on ${host}, which is on the dangerous-domains list and not approved for this session — a wake trigger can't watch it`);
      }

      // The element (a ref condition): read in its own frame's winter world — its label, the secure-field floor, its locator.
      let frame: WakeFrame | undefined;
      let element: { role: string; name: string } | undefined;
      let locator: WatchSpec["locator"];
      if (ref !== undefined) {
        let got: Awaited<ReturnType<TabDriver["wakeLocate"]>>;
        try {
          got = await driver.wakeLocate(ref);
        } catch (err) {
          if (c.kind === "gone" && err instanceof AutomationFailure && err.kind === "StaleRef") throw alreadyTrue(c);
          throw err;
        }
        if (!got.found.ok) {
          if (got.found.reason === "secure") throw new AutomationFailure("Refused", SECURE_FIELD_SENTENCE);
          if (c.kind === "gone") throw alreadyTrue(c);
          throw new AutomationFailure("StaleRef", `[${ref}] is gone — call state()`);
        }
        frame = got.frame;
        element = got.found.element;
        locator = got.found.locator;
      }
      if (c.kind === "navigated" && c.url !== undefined && c.url.length > 0 && driver.url.includes(c.url)) throw alreadyTrue(c);

      const kind: WatchKind = c.kind;
      const anyForm = c.kind === "submitted" && ref === undefined;
      const spec: WatchSpec = {
        watchId: req.wakeId, kind, pill: wakePill(kind, element?.name ?? "", { anyForm: anyForm || (c.kind === "gone" && ref === undefined) }),
        expiresAt: req.expiresAt, initial: "refuse",
        ...(locator === undefined ? {} : { locator }),
        ...(c.kind === "appeared" ? { text: c.text } : {}),
        ...(c.kind === "gone" && ref === undefined && c.text !== undefined ? { text: c.text } : {}),
        ...(c.kind === "titled" ? { title: c.title } : {}),
        ...(c.kind === "navigated" && c.url !== undefined && c.url.length > 0 ? { url: c.url } : {}),
        ...(anyForm ? { anyForm: true } : {}),
        ...(c.kind === "changed" ? { settleMs: c.settleMs } : {}),
      };
      if (c.kind === "gone" && ref === undefined && (c.text === undefined || c.text.length === 0)) throw bad("wakeWhen({ gone }) takes an element ref or a text");

      const path: "cdp" | "ext" = transport.watch !== undefined && (frame === undefined || frame.top) ? "ext" : "cdp";
      if (path === "cdp") {
        // The hold the wait keeps counts against the hold budgets.
        const full = this.engine.wakeHoldRefusal(req.sessionId, driver, holder);
        if (full !== undefined) throw new AutomationFailure("TargetBusy", full);
      }
      const a: Armed = {
        req, onEvent, target: t, driver, transport, path, spec, ...(ref === undefined ? {} : { ref }), holder,
        baseKey: watchUrlKey(driver.url), ended: false, off: [],
      };
      if (c.kind === "navigated" && c.url !== undefined) a.urlMet = false;

      let result: WatchArmResult;
      if (path === "ext") {
        this.hookTransport(transport);
        try { result = await transport.watch!(driver.tabKey, spec); } catch (err) { throw watchFailure(err, t.browserName); }
      } else {
        frame ??= await driver.wakeTopFrame();
        try { result = await driver.wakeArm(frame, spec, ref); } catch (err) {
          if (err instanceof WakeWorldGone) throw new AutomationFailure("StaleRef", "the page changed — call state()");
          throw err;
        }
        a.frame = frame;
      }
      if (!result.ok) {
        if (path === "ext") void transport.unwatch?.(driver.tabKey, req.wakeId).catch(() => undefined);
        throw armRefusal(result.reason, c, ref);
      }
      a.doc = result.doc;

      // Armed: from here on only an event or a disarm ends it.
      this.armed.set(req.wakeId, a);
      driver.wakesArmed++;
      a.off.push(this.onGone(a));
      if (path === "cdp") {
        keepHold = true;
        this.hookNavigation(driver);
        this.addToPoller(a);
      }
      const title = driver.shownTitle.replace(/\s+/g, " ").trim();
      const note = path === "cdp" && t.family !== "winter"
        ? (transport.watch === undefined ? WAKE_OLD_EXTENSION_NOTE : WAKE_IN_FRAME_NOTE)
        : undefined;
      return {
        ...(element === undefined ? {} : { element }),
        targetLabel: title.length > 0 ? `${t.browserName} — ${title.slice(0, 80)}` : t.browserName,
        rebind: `browsers.tab(${JSON.stringify(`${t.backend}:${driver.tabKey}`)})`,
        ...(note === undefined ? {} : { note }),
      };
    } finally {
      this.arming.delete(req.wakeId);
      if (!keepHold) {
        driver.wakeHolders.delete(holder);
        void driver.release(holder);
      }
    }
  }

  // ── disarm and ending ───────────────────────────────────────────────────────────────────────────────

  disarm(wakeId: string): void {
    const a = this.armed.get(wakeId);
    if (a === undefined || a.ended) return;
    this.finish(a);
  }

  /** Daemon stop: every trigger left as it is (the registry persists them for the restart notice); nothing polled. */
  stop(): void {
    this.stopped = true;
    for (const a of this.armed.values()) {
      a.ended = true;
      for (const off of a.off) off();
    }
    this.armed.clear();
    this.pollers.clear();
    for (const h of this.navHooks.values()) h.off();
    this.navHooks.clear();
  }

  /** What is armed now (tests, status). */
  armedIds(): string[] { return [...this.armed.keys()]; }

  private finish(a: Armed): void {
    if (a.ended) return;
    a.ended = true;
    this.armed.delete(a.req.wakeId);
    a.driver.wakesArmed = Math.max(0, a.driver.wakesArmed - 1);
    for (const off of a.off) { try { off(); } catch { /* best effort */ } }
    // An agent tab the trigger waited on: one more turn (the wake turn's end applies the ordinary rule).
    try { this.engine.wakeEnded(a.target.backend, a.driver.tabKey); } catch { /* best effort */ }
    if (a.path === "ext") {
      void a.transport.unwatch?.(a.driver.tabKey, a.req.wakeId).catch(() => undefined);
    } else {
      const p = a.pollKey === undefined ? undefined : this.pollers.get(a.pollKey);
      p?.wakes.delete(a.req.wakeId);
      if (p !== undefined && p.wakes.size === 0) this.pollers.delete(p.key);
      a.driver.wakeHolders.delete(a.holder);
      // The tab's navigation hook goes with its last watch.
      if (![...this.armed.values()].some((x) => x.driver === a.driver && x.path === "cdp")) {
        this.navHooks.get(a.driver)?.off();
        this.navHooks.delete(a.driver);
      }
      // The watch leaves the page (its ring and pill) before the tab is let go — even under a page dialog (it lands
      // when the dialog closes; the next poll of the frame, naming the watches kept, is the belt).
      const d = a.driver;
      const frame = a.frame;
      void (async () => {
        if (frame !== undefined && d.gone === undefined) await d.wakeDisarm(frame, a.req.wakeId);
        await d.release(a.holder);
      })();
    }
  }

  private end(a: Armed, e: Omit<WakeBackendEvent, "wakeId">): void {
    if (a.ended) return;
    // A fire on the user's own input: a page dialog it raised is theirs (the built-in browser never dismisses it).
    if (e.outcome === "fired" && INPUT_KINDS.has(a.spec.kind)) a.driver.noteUserFired(e.at);
    this.finish(a);
    try { a.onEvent({ wakeId: a.req.wakeId, ...e }); } catch (err) {
      this.deps.log?.(`computer-use: a wake listener threw (${err instanceof Error ? err.message : "error"})`);
    }
  }

  private lose(a: Armed, reason: string): void { this.end(a, { outcome: "lost", at: this.now(), reason }); }

  // ── what the watchers report ────────────────────────────────────────────────────────────────────────

  /** Did Winter (any session) cause what landed at `at`: its input to the tab, its helper's input to the browser app,
   *  or (the extension's own stamp) its debugger's? Every judgement of a trusted event or a transition asks this. */
  private own(a: Armed, at: number, stamped?: boolean): boolean {
    if (stamped === true) return true;
    if (a.driver.ownInputAt(at)) return true;
    return a.target.bundleId !== undefined && this.engine.wakeOwnAppInput(a.target.bundleId, at);
  }

  private onReport(a: Armed, e: { outcome: string; at: number; cause?: number; url?: string; key?: string; match?: boolean; title?: string; reason?: string; own?: boolean }): void {
    if (a.ended) return;
    const at = Number.isFinite(e.at) ? e.at : this.now();
    // A submit's or a change's trusted input (on the submitter, in the form, in the field): Winter's own makes it Winter's.
    const ownCause = typeof e.cause === "number" && Number.isFinite(e.cause) && this.own(a, e.cause);
    switch (e.outcome) {
      case "pressed":
        if (!this.own(a, at, e.own) && !ownCause) a.pressedAt = at;
        return;
      case "fired": {
        if (this.own(a, at, e.own) || ownCause) return;
        // A page condition never fires on a page behind the dangerous-domain floor: it waits for the tab to leave.
        if (pageWatch(a.spec) && typeof e.url === "string" && this.engine.wakeSiteBlocked(a.req.sessionId, e.url) !== undefined) return;
        this.end(a, { outcome: "fired", at, detail: this.detail(a, e) });
        return;
      }
      case "url":
        // Winter for Chrome's report: the address's shape, its key, and whether it holds the words (it matches them).
        if (typeof e.url === "string") {
          const want = this.wantUrl(a);
          this.onUrl(a, { shape: e.url, key: e.key ?? e.url, ...(want === undefined ? {} : { match: e.match ?? e.url.includes(want) }) }, at, e.own === true);
        }
        return;
      case "lost":
        this.lostOrPressed(a, e.reason === "doc" ? "doc" : e.reason === "gone" ? "gone" : "other", at, e.reason);
        return;
      default:
        return;
    }
  }

  /** A ref condition's document (or its element) went at `at`: `fired` when the user's own press of it came just before
   *  (measured from the press to when the page went, not to when the backend learned of it), else `lost`. */
  private lostOrPressed(a: Armed, why: "doc" | "gone" | "other", at: number, raw?: string): void {
    if (a.ended) return;
    if ((why === "doc" || why === "gone") && a.pressedAt !== undefined && at >= a.pressedAt - 50 && at - a.pressedAt <= WAKE_PRESS_NAV_MS
      && (a.spec.kind === "clicked" || a.spec.kind === "submitted")) {
      this.end(a, { outcome: "fired", at: a.pressedAt, detail: a.spec.kind === "clicked" ? "clicked" : "submitted the form" });
      return;
    }
    if (why === "doc") return this.lose(a, "the page changed");
    if (why === "gone") return this.lose(a, "the element is gone");
    this.lose(a, raw === "disconnected" ? this.linkSentence(a) : raw !== undefined && raw.length > 0 ? raw.slice(0, 200) : "the page can't be watched any more");
  }

  /** The tab's address as a `navigated` watch weighs it: its shape (`watchUrlShape`), its key, and (a watch with words)
   *  whether it holds them. The debugger path has the whole address; Winter for Chrome sends only these. */
  private urlFacts(a: Armed, url: string): { shape: string; key: string; match?: boolean } {
    const want = this.wantUrl(a);
    return { shape: watchUrlShape(url), key: watchUrlKey(url), ...(want === undefined ? {} : { match: url.includes(want) }) };
  }

  /** navigated: the tab's top-level address changed (a same-document change counts). `stamped`: Winter's own
   *  navigation (the extension's stamp, or — debugger path — decided when it started). */
  private onUrl(a: Armed, u: { shape: string; key: string; match?: boolean }, at: number, stamped: boolean): void {
    if (a.ended || a.spec.kind !== "navigated") return;
    const want = this.wantUrl(a);
    if (this.own(a, at, stamped)) {
      // Winter's own navigation: the new baseline.
      a.baseKey = u.key;
      if (want !== undefined) a.urlMet = u.match === true;
      return;
    }
    if (want === undefined) {
      if (u.key === a.baseKey) return;
    } else {
      const was = a.urlMet === true;
      a.urlMet = u.match === true;
      if (!a.urlMet || was) return;
    }
    this.end(a, { outcome: "fired", at, detail: this.navDetail(a, u.shape) });
  }

  private wantUrl(a: Armed): string | undefined {
    const c = a.req.condition as Extract<WakeCondition, { kind: "navigated" }>;
    return c.url !== undefined && c.url.length > 0 ? c.url : undefined;
  }

  /** "now at <origin and path>" — and, for `{ url }`, the model's own words it matched. */
  private navDetail(a: Armed, url: string): string {
    const want = this.wantUrl(a);
    return `now at ${wakeUrlShape(url)}${want === undefined ? "" : ` — matched ${quoted(want)}`}`;
  }

  private detail(a: Armed, e: { url?: string; title?: string }): string {
    switch (a.spec.kind) {
      case "clicked": return "clicked";
      case "submitted": return "submitted the form";
      case "changed": return "changed";
      case "appeared": return "appeared";
      case "gone": return "gone";
      case "titled": return `title now ${quoted(redactText(e.title ?? a.driver.title), 120)}`;
      case "navigated": return this.navDetail(a, e.url ?? a.driver.url);
    }
  }

  private linkSentence(a: Armed): string {
    return familyOfBackendId(a.target.backend) === "winter" || a.target.family === "winter" ? "Winter isn't running" : "Winter for Chrome disconnected";
  }

  /** The tab closed, crashed, or the user took it back. A "closed" that turns out to be the tab coming back under a
   *  new id (its driver revived, `engine.rekey`) keeps the trigger: the watch moved with it. */
  private onGone(a: Armed): () => void {
    const l = (reason: string): void => {
      if (a.ended) return;
      switch (reason) {
        case "closed":
          setTimeout(() => { if (!a.ended && a.driver.gone !== undefined) this.lose(a, goneReason(a.driver.gone)); }, this.deps.closedGraceMs ?? WAKE_CLOSED_GRACE_MS);
          return;
        case "crashed": this.lose(a, "the tab crashed"); return;
        case "detached_by_user": this.lose(a, "the user stopped Winter from controlling this tab"); return;
        default: return; // stopped: the debugger path attaches again
      }
    };
    a.driver.goneListeners.add(l);
    return () => { a.driver.goneListeners.delete(l); };
  }

  private hookTransport(t: CdpTransport): void {
    if (this.hookedTransports.has(t) || t.onWatchEvent === undefined) return;
    this.hookedTransports.add(t);
    t.onWatchEvent((tabKey, e: TransportWatchEvent) => {
      const a = this.armed.get(e.watchId);
      // The tab's key as the driver has it NOW (a tab the browser gave a new id moved with its driver).
      if (a === undefined || a.path !== "ext" || a.transport !== t || a.driver.tabKey !== tabKey) return;
      this.onReport(a, e);
    });
  }

  /** The debugger path's view of the tab's top-level URL (navigated) and of who started its navigations. */
  private hookNavigation(driver: TabDriver): void {
    if (this.navHooks.has(driver)) return;
    const hook: NavHook = { off: () => {}, startAt: 0, own: false, commitAt: 0 };
    const l = (e: CdpEvent): void => {
      if (e.cdpSessionId !== undefined) return;
      let url: string | undefined;
      let stamped = false;
      const at = this.now();
      if (e.method === "Page.frameStartedLoading") {
        // Who starts a navigation decides whose it is — its commit can come long after Winter's input ended.
        if (e.params.frameId === undefined || e.params.frameId !== driver.mainFrameId) return;
        hook.startAt = at;
        hook.own = driver.ownInputNow;
        return;
      } else if (e.method === "Page.frameNavigated") {
        const f = (e.params.frame ?? {}) as { parentId?: string; url?: string; urlFragment?: string };
        if (f.parentId !== undefined || typeof f.url !== "string") return;
        url = `${f.url}${f.urlFragment ?? ""}`;
        // A commit with no start seen since the last one (an event lost): judged now.
        if (hook.startAt <= hook.commitAt) { hook.startAt = at; hook.own = driver.ownInputNow; }
        hook.commitAt = at;
        stamped = hook.own;
      } else if (e.method === "Page.navigatedWithinDocument") {
        if (e.params.frameId !== driver.mainFrameId || typeof e.params.url !== "string") return;
        url = e.params.url;
      } else return;
      for (const a of [...this.armed.values()]) {
        if (a.driver === driver && a.path === "cdp" && a.spec.kind === "navigated") this.onUrl(a, this.urlFacts(a, url), at, stamped || (e.method === "Page.frameNavigated" && this.navOwnApp(a, hook)));
      }
    };
    driver.listeners.add(l);
    hook.off = () => { driver.listeners.delete(l); };
    this.navHooks.set(driver, hook);
  }

  /** The navigation in progress started on the helper's input to the browser app (the engine's own is `hook.own`). */
  private navOwnApp(a: Armed, hook: NavHook): boolean {
    return hook.startAt > 0 && a.target.bundleId !== undefined && this.engine.wakeOwnAppInput(a.target.bundleId, hook.startAt);
  }

  // ── the debugger path: long polls ───────────────────────────────────────────────────────────────────

  private addToPoller(a: Armed): void {
    let p = [...this.pollers.values()].find((x) => x.driver === a.driver && x.frame.frameId === a.frame!.frameId);
    if (p === undefined) {
      p = { key: `p${++this.pollerSeq}`, driver: a.driver, frame: a.frame!, wakes: new Set(), ack: 0, running: false };
      this.pollers.set(p.key, p);
    }
    p.wakes.add(a.req.wakeId);
    a.pollKey = p.key;
    if (!p.running) void this.runPoller(p);
  }

  private live(p: Poller): Armed[] {
    return [...p.wakes].map((id) => this.armed.get(id)).filter((x): x is Armed => x !== undefined && !x.ended);
  }

  private async runPoller(p: Poller): Promise<void> {
    p.running = true;
    let failures = 0;
    try {
      while (!this.stopped && this.live(p).length > 0) {
        const d = p.driver;
        if (d.gone !== undefined && await this.staysGone(d)) { this.goneAll(p, d.gone!); return; }
        try {
          // A page dialog only delays a poll (it is never answered here): the poll waits it out, or times out and runs
          // again.
          const keep = [...this.live(p).map((a) => a.req.wakeId), ...this.arming];
          const r = await d.wakeWait(p.frame, p.ack, this.deps.pollMs ?? WAKE_POLL_MS, p.world, keep);
          failures = 0;
          if (r.world !== p.world) { p.world = r.world; p.ack = 0; }
          for (const ev of r.events) {
            p.ack = Math.max(p.ack, ev.seq);
            const a = this.armed.get(ev.watchId);
            if (a !== undefined && p.wakes.has(ev.watchId)) this.onReport(a, ev);
          }
          // A watch no longer in the page (it removed itself): armed there again.
          const missing = this.live(p).filter((a) => !r.alive.includes(a.req.wakeId));
          if (missing.length > 0) await this.recover(p, missing);
        } catch (err) {
          if (err instanceof WakeWorldGone) { await this.recover(p, this.live(p)); continue; }
          if (d.gone !== undefined) { if (await this.staysGone(d)) { this.goneAll(p, d.gone!); return; } continue; }
          if (err instanceof AutomationFailure && err.kind === "BrowserUnavailable") { for (const a of this.live(p)) this.lose(a, this.linkSentence(a)); return; }
          if (err instanceof AutomationFailure && err.kind === "TargetLost") {
            // The debugger let go while the tab lives (an extension's detach): attached again by `recover`.
            await this.recover(p, this.live(p));
            continue;
          }
          if (err instanceof AutomationFailure && err.kind === "TargetBusy") { await sleep(500); continue; }
          failures++;
          this.deps.log?.(`computer-use: a wake watch's poll failed (${err instanceof Error ? err.message.slice(0, 120) : "error"})`);
          if (failures >= 5) { for (const a of this.live(p)) this.lose(a, "the page can't be watched any more"); return; }
          await sleep(500 * failures);
        }
      }
    } finally {
      p.running = false;
      if (this.live(p).length === 0) this.pollers.delete(p.key);
    }
  }

  private goneAll(p: Poller, reason: string): void {
    for (const a of this.live(p)) this.lose(a, goneReason(reason));
  }

  /** Is the tab gone for good? A "closed" is given the rekey's grace first (the tab may be back under a new id). */
  private async staysGone(d: TabDriver): Promise<boolean> {
    if (d.gone !== "closed") return d.gone !== undefined;
    await sleep(this.deps.closedGraceMs ?? WAKE_CLOSED_GRACE_MS);
    return d.gone !== undefined;
  }

  /**
   * A watch's world went (a new document, or a detach) or the watch left it: attach again if need be and arm each watch
   * again in the frame's world now — a ref watch by its locator (another document: `lost`, or `fired` after the user's
   * press), a page watch with the new document as its baseline (a transition when the user or the page brought the
   * document and the condition holds there; never when Winter's own navigation — or the helper's input — did).
   */
  private async recover(p: Poller, wakes: Armed[]): Promise<void> {
    const d = p.driver;
    const deadline = this.now() + (this.deps.recoverMs ?? WAKE_RECOVER_MS);
    let todo = wakes.filter((a) => !a.ended);
    while (todo.length > 0 && !this.stopped) {
      if (d.gone !== undefined && await this.staysGone(d)) { this.goneAll(p, d.gone!); return; }
      try {
        for (const a of todo) await d.ensureAttached(a.holder);
        const frame = p.frame.top ? await d.wakeTopFrame() : await d.wakeFrameAgain(p.frame.frameId);
        const hook = this.navHooks.get(d);
        // When the document went: its navigation's start (else now).
        const wentAt = hook !== undefined && hook.startAt > 0 ? hook.startAt : this.now();
        for (const a of todo) {
          if (a.ended) continue;
          // A page condition on a page behind the floor: not watched there (it waits for the tab to leave it).
          if (pageWatch(a.spec) && this.engine.wakeSiteBlocked(a.req.sessionId, d.url) !== undefined) continue;
          const r = await d.wakeArm(frame, { ...a.spec, initial: "baseline" });
          if (!r.ok) {
            this.lostOrPressed(a, r.reason === "doc" ? "doc" : "gone", r.reason === "doc" ? wentAt : this.now());
            continue;
          }
          const newDoc = a.doc !== undefined && r.doc !== a.doc;
          a.frame = frame;
          a.doc = r.doc;
          if (r.met === true && a.spec.kind === "gone" && a.spec.locator !== undefined) {
            // Its element went while the world was away: that is the condition.
            if (!this.own(a, this.now())) this.end(a, { outcome: "fired", at: this.now(), detail: "gone" });
            continue;
          }
          const navOwn = hook !== undefined && (hook.own || this.navOwnApp(a, hook) || this.own(a, wentAt));
          if (r.met === true && newDoc && !navOwn && STATE_KINDS.has(a.spec.kind)) this.end(a, { outcome: "fired", at: this.now(), detail: this.detail(a, { title: d.title }) });
        }
        p.frame = frame;
        return;
      } catch (err) {
        if (d.gone !== undefined && await this.staysGone(d)) { this.goneAll(p, d.gone!); return; }
        // A child frame that went (its parent navigated): its watches' document is gone.
        if (err instanceof WakeWorldGone && !p.frame.top) { for (const a of todo) this.lostOrPressed(a, "doc", this.now()); return; }
        if (err instanceof AutomationFailure && err.kind === "BrowserUnavailable") { for (const a of todo) this.lose(a, this.linkSentence(a)); return; }
        if (err instanceof AutomationFailure && (err.kind === "Refused" || err.kind === "NotAllowed")) { for (const a of todo) this.lose(a, "the page can't be watched any more"); return; }
        if (this.now() >= deadline) { for (const a of todo) this.lose(a, "the page can't be watched any more"); return; }
        await sleep(250);
      }
      todo = todo.filter((a) => !a.ended);
    }
  }
}

function goneReason(reason: string): string {
  return reason === "crashed" ? "the tab crashed" : reason === "detached_by_user" ? "the user stopped Winter from controlling this tab" : "the tab was closed";
}

/** A watch of the page itself (no element; `navigated` aside): the dangerous-domain floor keeps it from firing — and
 *  from being installed — on a page behind it. */
function pageWatch(spec: WatchSpec): boolean {
  return spec.locator === undefined && spec.kind !== "navigated";
}

function parseRef(ref: string): number {
  const n = Number(ref);
  if (!Number.isInteger(n) || n <= 0) throw bad("wakeWhen() takes an element ref from state() or find()");
  return n;
}

/** The controller's ruling: a state condition already true at arm is refused, in the daemon's words. */
function alreadyTrue(c: WakeCondition): AutomationFailure {
  switch (c.kind) {
    case "appeared": return new AutomationFailure("NotAllowed", `${quoted(c.text)} is already shown in this tab — nothing to wait for; check state()`);
    case "gone": return new AutomationFailure("NotAllowed", c.ref !== undefined
      ? `[${c.ref}] is already gone from this tab — nothing to wait for; check state()`
      : `${quoted(c.text ?? "")} isn't shown in this tab — nothing to wait for; check state()`);
    case "titled": return new AutomationFailure("NotAllowed", `this tab's title already contains ${quoted(c.title)} — nothing to wait for; check title()`);
    case "navigated": return new AutomationFailure("NotAllowed", `this tab's address already contains ${quoted(c.url ?? "")} — nothing to wait for; check url()`);
    default: return new AutomationFailure("NotAllowed", "that is already true in this tab — nothing to wait for; check state()");
  }
}

function armRefusal(reason: "met" | "gone" | "doc" | "noform", c: WakeCondition, ref: number | undefined): Error {
  switch (reason) {
    case "met": return alreadyTrue(c);
    case "gone": return c.kind === "gone" ? alreadyTrue(c) : new AutomationFailure("StaleRef", `[${ref ?? "?"}] is gone — call state()`);
    case "doc": return new AutomationFailure("StaleRef", "the page changed — call state()");
    case "noform": return new Error(`[${ref ?? "?"}] is not in a form — wakeWhen({ submitted: true }) waits for any form of the page`);
  }
}

/** The extension's refusal of a watch, as the model's error. */
function watchFailure(err: unknown, browserName: string): Error {
  if (err instanceof TransportError) {
    if (err.code === "not_allowed") {
      if (err.data.reason === "secure") return new AutomationFailure("Refused", SECURE_FIELD_SENTENCE);
      return new AutomationFailure("Refused", `this page doesn't let Winter watch it (${err.message.slice(0, 160)})`);
    }
    if (err.code === "tab_gone") return new AutomationFailure("TargetLost", "the tab was closed — open it again with browsers.open() or bind another with browsers.tab()");
    if (err.code === "disconnected") return new AutomationFailure("BrowserUnavailable", `${browserName} can't be reached: Winter for Chrome is not connected — ask the user`, true);
    if (err.code === "timeout") return new AutomationFailure("TargetBusy", "the browser did not answer in time — try again in a moment", true);
    return new Error(err.message.slice(0, 300));
  }
  return err instanceof Error ? err : new Error(String(err));
}
