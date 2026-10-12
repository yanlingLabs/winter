// ComputerV2 — WAKE TRIGGERS: the in-page WATCHER, one source for both of its homes.
//
//  - the page runtime (`main.ts`) installs it in the frame's isolated "winter" world (the CDP path: Winter's built-in
//    browser, a Winter for Chrome older than 1.2.0, and a watched element inside a child frame). Its events wait in a
//    queue the engine long-polls (`watchWait`), each answered by acknowledgement, so an answer lost on the way is
//    sent again;
//  - Winter for Chrome 1.2.0 injects the SAME function with `chrome.scripting.executeScript` into the extension's own
//    isolated world (never the page's, never the winter world) — no debugger — and the watcher reports with
//    `chrome.runtime.sendMessage`.
//
// `wakeWatcher` must STAND ALONE: Chrome serializes its source text for `executeScript`, so it uses nothing outside its
// own body (the same rule as Winter for Chrome's `drawOverlay`). Everything the daemon decides — the element's role
// and name, its redaction, the secure-field floor, the locator — is decided in the winter world by `main.ts` BEFORE the
// watcher is armed; the watcher only finds the element again by its locator and watches.
//
// What it reports, and nothing more: which watch, what happened ("fired", "pressed" — a trusted press on the watched
// element or form that a navigation may cut short —, or "lost"), when (the page's clock), the top document's URL and,
// for a title watch, the title. Never a value the user typed, never coordinates, never page text.
//
// Only the USER's action counts: input conditions (clicked, submitted, changed) take only trusted DOM events, and a
// submit or a change also needs the page's transient user activation (a page script's own `requestSubmit()` or
// `execCommand()` does not count). Winter's own CDP input is trusted too — the DAEMON drops what lands while Winter's
// input to the tab is in flight or within 500 ms after it. State conditions (appeared, gone, titled) report a
// false→true transition; one already true at the first install refuses the arm ("met").
//
// While armed the user can SEE that Winter waits: a ring around the watched element and a small pill at the page's
// bottom left, in a closed shadow root under one `<winter-wake-overlay>` element that takes no pointer event (the page
// runtime leaves it out of its tree walk and hit tests). The pill's words are the daemon's (fixed per kind, naming
// only the element's own label).

export const WAKE_OVERLAY_TAG = "winter-wake-overlay";

/** The conditions a page watcher keeps. `navigated` only shows its pill: the engine (or the extension) sees the top
 *  frame's URL itself. */
export type WatchKind = "clicked" | "submitted" | "appeared" | "gone" | "changed" | "titled" | "navigated";

/** An element, findable again from any isolated world of the same document. */
export interface WatchLocator {
  /** `performance.timeOrigin` of the document it was read in: another value is another document. */
  doc: number;
  /** From `<html>` down: [tagName, its index among same-tag element siblings, 1 when entered through the previous
   *  element's open shadow root]. */
  path: Array<[string, number, number]>;
  tag: string;
  /** The identifying attributes it had (`WATCH_LOCATOR_ATTRS`), each of which a match must still have. */
  attrs: Record<string, string>;
}

/** The attributes a locator remembers: steady ones that identify an element and carry its secure-field facts (type,
 *  autocomplete) — never one a page rewrites as it works (a label, a link's address). */
export const WATCH_LOCATOR_ATTRS = ["id", "name", "type", "role", "data-testid", "autocomplete"] as const;

export interface WatchSpec {
  /** `wk_<12 hex>`. */
  watchId: string;
  kind: WatchKind;
  locator?: WatchLocator;
  /** appeared / gone (text). */
  text?: string;
  /** titled. */
  title?: string;
  /** submitted with no element: any form of the page. */
  anyForm?: boolean;
  /** changed: the quiet stretch after the user's last input before it fires. */
  settleMs?: number;
  /** The pill's words (the daemon's). */
  pill: string;
  /** Epoch ms: the watcher removes itself a little after it, if nobody did. */
  expiresAt: number;
  /** What a state condition already true at install means: "refuse" (the first arm — nothing to wait for), "baseline"
   *  (a document Winter's own navigation loaded: the state is the new baseline) or "fire" (a new document the user or
   *  the page brought: a transition). */
  initial: "refuse" | "baseline" | "fire";
}

export interface WatchEvent {
  seq: number;
  watchId: string;
  outcome: "fired" | "pressed" | "lost";
  /** Epoch ms (the page's clock): the user's action, the last input of a change, or when it was seen. */
  at: number;
  /** The top document's URL (the daemon redacts it, and holds content conditions to its site floor). */
  url: string;
  /** titled: the title now (the daemon redacts it). */
  title?: string;
  /** lost: "gone" — the element went and could not be found again; "doc" — not this document any more. */
  reason?: "gone" | "doc";
}

export type WatchArmResult =
  /** `doc`: the document's `performance.timeOrigin`; `met`: a state condition holds now. */
  | { ok: true; installed: "new" | "alive"; doc: number; met?: boolean }
  /** met: already true (initial "refuse"); gone: the element is not there; doc: another document; noform: no form. */
  | { ok: false; reason: "met" | "gone" | "doc" | "noform" };

export interface WatchWaitResult {
  /** This world's watcher (its sequence numbers are its own: an acknowledgement of another world's means nothing). */
  world: string;
  /** Events after the acknowledged sequence number, oldest first (at most 50). */
  events: WatchEvent[];
  /** The watches installed in this document now (one gone from here expired or removed itself). */
  alive: string[];
}

export type WatcherArg =
  | { op: "arm"; sink: "queue" | "runtime"; spec: WatchSpec; element?: Element }
  | { op: "disarm"; watchId: string }
  /** queue sink: the events after `ack` (of world `world`), waiting at most `maxMs` (≤ 25 s) for one. */
  | { op: "wait"; ack: number; maxMs: number; world?: string }
  | { op: "alive" };

/** How long the queue sink lives without a poll before it removes itself (the daemon polls every ≤ 20 s). */
export const WATCH_UNPOLLED_MS = 75_000;
/** The runtime sink's heartbeat to the extension (a watch it no longer knows removes itself). */
export const WATCH_HEARTBEAT_MS = 20_000;

/**
 * The watcher. STANDS ALONE (serialized by Chrome): every helper lives inside. The first call in a world builds its
 * state on a non-enumerable global of that world; later calls (fresh copies of this function, for `executeScript`)
 * reach the same state through it.
 */
export function wakeWatcher(arg: WatcherArg): unknown {
  type W = {
    spec: WatchSpec;
    el?: Element;
    form?: HTMLFormElement;
    last?: boolean;
    value?: string;
    lastInput?: number;
    settle?: ReturnType<typeof setTimeout>;
    missingSince?: number;
    lostSent?: boolean;
    ring?: HTMLElement;
  };
  type Api = {
    arm(a: { sink: "queue" | "runtime"; spec: WatchSpec; element?: Element }): WatchArmResult;
    disarm(id: string): boolean;
    wait(a: { ack: number; maxMs: number; world?: string }): Promise<WatchWaitResult>;
    alive(): string[];
  };
  const KEY = "__winterWake";
  const g = globalThis as unknown as Record<string, unknown>;
  let api = g[KEY] as Api | undefined;
  if (api === undefined) {
    api = ((): Api => {
      const TAG = "winter-wake-overlay";
      const UNPOLLED_MS = 75_000;
      const HEARTBEAT_MS = 20_000;
      const MISSING_MS = 1_500;
      const WORLD = `w${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      const watches = new Map<string, W>();
      let queue: WatchEvent[] = [];
      let seq = 0;
      const waiters = new Set<() => void>();
      let sink: "queue" | "runtime" = "queue";
      let lastPoll = Date.now();
      let lastBeat = Date.now();
      let failures = 0;
      let installed = false;
      let observer: MutationObserver | undefined;
      let tick: ReturnType<typeof setInterval> | undefined;
      let checkTimer: ReturnType<typeof setTimeout> | undefined;
      let lastCheck = 0;
      let host: HTMLElement | undefined;
      let root: ShadowRoot | undefined;
      let pills: HTMLElement | undefined;
      let frameAsked = false;

      const runtime = (): { sendMessage?: (m: unknown) => unknown } | undefined =>
        (g.chrome as { runtime?: { sendMessage?: (m: unknown) => unknown } } | undefined)?.runtime;
      const send = (m: Record<string, unknown>, then?: (r: unknown) => void): void => {
        const rt = runtime();
        if (rt?.sendMessage === undefined) { failures++; return; }
        try {
          const p = rt.sendMessage(m) as Promise<unknown> | undefined;
          if (p !== undefined && typeof p.then === "function") {
            p.then((r) => { failures = 0; then?.(r); }, () => { failures++; if (failures >= 3) removeAll(); });
          }
        } catch {
          // The extension went (reloaded or removed): nothing can hear this watcher any more.
          removeAll();
        }
      };

      const report = (w: W, outcome: WatchEvent["outcome"], o: { at?: number; title?: string; reason?: WatchEvent["reason"] } = {}): void => {
        const ev: WatchEvent = {
          seq: ++seq, watchId: w.spec.watchId, outcome, at: o.at ?? Date.now(), url: String(location.href).slice(0, 4096),
          ...(o.title === undefined ? {} : { title: o.title.slice(0, 300) }), ...(o.reason === undefined ? {} : { reason: o.reason }),
        };
        if (sink === "runtime") { send({ type: "winter.wake.event", ...ev }); return; }
        queue.push(ev);
        if (queue.length > 200) queue = queue.slice(-200);
        for (const wake of [...waiters]) wake();
      };

      // ── finding elements ────────────────────────────────────────────────────────────────────────────────
      const matches = (el: Element, loc: WatchLocator): boolean =>
        el.tagName === loc.tag && Object.entries(loc.attrs).every(([k, v]) => el.getAttribute(k) === v);
      const deepAll = (selector: string, max = 2_000): Element[] => {
        const out: Element[] = [];
        const roots: Array<Document | ShadowRoot> = [document];
        for (let i = 0; i < roots.length && out.length < max; i++) {
          const r = roots[i]!;
          for (const el of Array.from(r.querySelectorAll(selector))) { out.push(el); if (out.length >= max) break; }
          let n = 0;
          for (const el of Array.from(r.querySelectorAll("*"))) {
            if (++n > 20_000) break;
            if (el.shadowRoot !== null) roots.push(el.shadowRoot);
          }
        }
        return out;
      };
      const locate = (loc: WatchLocator): Element | undefined => {
        if (performance.timeOrigin !== loc.doc) return undefined;
        let cur: Element | undefined;
        for (const [tag, index, shadow] of loc.path) {
          const scope: ParentNode | null | undefined = cur === undefined ? document : shadow === 1 ? cur.shadowRoot : cur;
          if (scope === null || scope === undefined) { cur = undefined; break; }
          let n = -1;
          let found: Element | undefined;
          for (const c of Array.from(scope.children)) {
            if (c.tagName === tag && ++n === index) { found = c; break; }
          }
          if (found === undefined) { cur = undefined; break; }
          cur = found;
        }
        if (cur !== undefined && matches(cur, loc)) return cur;
        // Moved (the page re-rendered around it): found again only by what identifies it, and only when unique.
        const keys = ["id", "name", "data-testid"].filter((k) => loc.attrs[k] !== undefined);
        if (keys.length === 0) return undefined;
        const esc = (v: string): string => (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"));
        const sel = `${loc.tag.toLowerCase()}${keys.map((k) => `[${k}="${esc(loc.attrs[k]!)}"]`).join("")}`;
        let hits: Element[];
        try { hits = deepAll(sel).filter((el) => matches(el, loc)); } catch { return undefined; }
        return hits.length === 1 ? hits[0] : undefined;
      };
      const shown = (el: Element): boolean => {
        if (!el.isConnected || el.getClientRects().length === 0) return false;
        try { const st = getComputedStyle(el); return st.visibility !== "hidden" && st.visibility !== "collapse"; } catch { return true; }
      };
      const formOf = (el: Element | undefined): HTMLFormElement | undefined => {
        if (el === undefined) return undefined;
        if (el instanceof HTMLFormElement) return el;
        const f = (el as HTMLInputElement).form;
        if (f instanceof HTMLFormElement) return f;
        const c = el.closest("form");
        return c instanceof HTMLFormElement ? c : undefined;
      };
      // A field Winter never watches (the daemon refused one at arm; a container's own fields are skipped too).
      const secure = (el: Element): boolean => {
        if (el instanceof HTMLInputElement && el.type.toLowerCase() === "password") return true;
        const tokens = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
        return tokens.some((t) => t === "current-password" || t === "new-password" || t === "one-time-code" || t.startsWith("cc-"));
      };
      const fieldValue = (el: Element): string => {
        if (el instanceof HTMLInputElement) return el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.value;
        if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions).map((o) => o.value).join("\n");
        if (el instanceof HTMLTextAreaElement) return el.value;
        return "";
      };
      /** What `changed` compares (in the page only; it never leaves). A container: its own fields' values. */
      const valueOf = (el: Element): string => {
        if (secure(el)) return "";
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return fieldValue(el);
        if ((el as HTMLElement).isContentEditable === true) return (el as HTMLElement).innerText ?? "";
        return Array.from(el.querySelectorAll("input, select, textarea")).filter((f) => !secure(f)).map(fieldValue).join("\u0000");
      };
      // The page's text costs a layout to read: read again only after the DOM changed (or every 10 s, for what changes
      // with no mutation), never on every tick of an hours-long wait.
      let textCache: string | undefined;
      let textAt = 0;
      let dirty = true;
      const visibleText = (): string => {
        if (textCache !== undefined && !dirty && Date.now() - textAt < 10_000) return textCache;
        dirty = false;
        textAt = Date.now();
        textCache = readText();
        return textCache;
      };
      const readText = (): string => {
        const body = document.body;
        if (body === null) return "";
        let t = body.innerText ?? "";
        const extra: string[] = [];
        let n = 0;
        const walk = (node: Element): void => {
          if (++n > 20_000) return;
          if (node.shadowRoot !== null) extra.push((node.shadowRoot as unknown as { innerText?: string }).innerText ?? node.shadowRoot.textContent ?? "");
          for (const c of Array.from(node.children)) walk(c);
        };
        walk(body);
        if (extra.length > 0) t += `\n${extra.join("\n")}`;
        return t;
      };
      /** A state condition, now (undefined: not a state condition). */
      const met = (w: W): boolean | undefined => {
        const s = w.spec;
        if (s.kind === "appeared") return visibleText().includes(s.text ?? "\u0000");
        if (s.kind === "titled") return document.title.includes(s.title ?? "\u0000");
        if (s.kind === "gone") {
          if (s.locator === undefined && w.el === undefined) return !visibleText().includes(s.text ?? "\u0000");
          if (w.el !== undefined && !w.el.isConnected && s.locator !== undefined) w.el = locate(s.locator);
          return w.el === undefined || !shown(w.el);
        }
        return undefined;
      };
      const userActive = (): boolean => {
        const ua = (navigator as unknown as { userActivation?: { isActive?: boolean } }).userActivation;
        return ua === undefined || ua.isActive === true;
      };

      // ── the user's events ───────────────────────────────────────────────────────────────────────────────
      const onPointerDown = (e: Event): void => {
        if (!e.isTrusted) return;
        const path = e.composedPath();
        for (const w of watches.values()) if (w.spec.kind === "clicked" && w.el !== undefined && path.includes(w.el)) report(w, "pressed");
      };
      const onClick = (e: Event): void => {
        if (!e.isTrusted) return;
        const path = e.composedPath();
        for (const w of watches.values()) {
          if (w.spec.kind === "clicked" && w.el !== undefined && path.includes(w.el)) report(w, "fired");
          else if (w.spec.kind === "submitted") {
            // A press of the form's submit button: a navigation may follow before (or instead of) its submit event.
            const b = path.find((x) => (x instanceof HTMLButtonElement && x.type === "submit") || (x instanceof HTMLInputElement && (x.type === "submit" || x.type === "image")));
            const f = b === undefined ? undefined : (b as HTMLButtonElement).form;
            if (f instanceof HTMLFormElement && (w.spec.anyForm === true || f === w.form)) report(w, "pressed");
          }
        }
      };
      const onKeyDown = (e: Event): void => {
        if (!e.isTrusted) return;
        const key = (e as KeyboardEvent).key;
        if (key !== "Enter" && key !== " ") return;
        const path = e.composedPath();
        const target = path[0];
        for (const w of watches.values()) {
          if (w.spec.kind === "clicked" && w.el !== undefined && path.includes(w.el)) report(w, "pressed");
          else if (w.spec.kind === "submitted" && key === "Enter" && target instanceof HTMLElement && !(target instanceof HTMLTextAreaElement)) {
            const f = formOf(target);
            if (f !== undefined && (w.spec.anyForm === true || f === w.form)) report(w, "pressed");
          }
        }
      };
      const onSubmit = (e: Event): void => {
        if (!e.isTrusted || !userActive()) return;
        const f = e.target;
        if (!(f instanceof HTMLFormElement)) return;
        for (const w of watches.values()) if (w.spec.kind === "submitted" && (w.spec.anyForm === true || f === w.form)) report(w, "fired");
      };
      const onInput = (e: Event): void => {
        if (!e.isTrusted || !userActive()) return;
        const path = e.composedPath();
        const target = path[0];
        if (target instanceof Element && secure(target)) return;
        for (const w of watches.values()) {
          if (w.spec.kind !== "changed" || w.el === undefined || !path.includes(w.el)) continue;
          w.lastInput = Date.now();
          if (w.settle !== undefined) clearTimeout(w.settle);
          w.settle = setTimeout(() => {
            w.settle = undefined;
            if (!watches.has(w.spec.watchId) || w.el === undefined) return;
            const v = valueOf(w.el);
            if (v === w.value) return;
            w.value = v;
            report(w, "fired", { at: w.lastInput ?? Date.now() });
          }, Math.max(100, Math.min(60_000, w.spec.settleMs ?? 1_500)));
        }
      };
      const onMove = (): void => { if (!frameAsked) { frameAsked = true; try { requestAnimationFrame(() => { frameAsked = false; place(); }); } catch { frameAsked = false; } } };

      // ── checking ────────────────────────────────────────────────────────────────────────────────────────
      const check = (): void => {
        lastCheck = Date.now();
        for (const w of [...watches.values()]) {
          const s = w.spec;
          if (s.expiresAt + 5_000 < Date.now()) { remove(s.watchId); continue; }
          const m = met(w);
          if (m !== undefined) {
            if (m && w.last === false) report(w, "fired", s.kind === "titled" ? { title: document.title } : {});
            w.last = m;
            continue;
          }
          // An input condition's element: still there, or found again (a re-render); else lost after a moment.
          if (w.el === undefined || s.anyForm === true) continue;
          if (!w.el.isConnected) {
            const again = s.locator === undefined ? undefined : locate(s.locator);
            if (again !== undefined) {
              w.el = again;
              if (s.kind === "submitted") w.form = formOf(again);
              w.missingSince = undefined;
            } else {
              w.missingSince ??= Date.now();
              if (Date.now() - w.missingSince >= MISSING_MS && w.lostSent !== true) { w.lostSent = true; report(w, "lost", { reason: "gone" }); }
            }
          } else {
            w.missingSince = undefined;
          }
        }
        place();
      };
      const onMutation = (): void => { dirty = true; scheduleCheck(); };
      const scheduleCheck = (): void => {
        if (checkTimer !== undefined) return;
        checkTimer = setTimeout(() => { checkTimer = undefined; check(); }, Math.max(0, 500 - (Date.now() - lastCheck)));
      };
      const onTick = (): void => {
        const now = Date.now();
        if (sink === "queue" && now - lastPoll > UNPOLLED_MS) { removeAll(); return; }
        if (sink === "runtime" && now - lastBeat >= HEARTBEAT_MS) {
          lastBeat = now;
          send({ type: "winter.wake.alive", watchIds: [...watches.keys()] }, (r) => {
            const known = (r as { known?: unknown } | undefined)?.known;
            if (!Array.isArray(known)) return;
            for (const id of [...watches.keys()]) if (!known.includes(id)) remove(id);
          });
        }
        check();
      };

      // ── what the user sees ──────────────────────────────────────────────────────────────────────────────
      const ensureOverlay = (): void => {
        if (host !== undefined && host.isConnected) return;
        host = document.createElement(TAG);
        const hostStyle: Array<[string, string]> = [
          ["all", "initial"], ["position", "fixed"], ["inset", "0"], ["width", "100vw"], ["height", "100vh"], ["z-index", "2147483646"],
          ["pointer-events", "none"], ["display", "block"], ["visibility", "visible"], ["opacity", "1"], ["transform", "none"], ["filter", "none"],
          ["clip-path", "none"], ["margin", "0"], ["border", "0"], ["padding", "0"],
        ];
        for (const [k, v] of hostStyle) host.style.setProperty(k, v, "important");
        root = host.attachShadow({ mode: "closed" });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(`
          :host, * { pointer-events: none !important; }
          .ring { position: fixed; left: 0; top: 0; display: none; border-radius: 6px; box-sizing: border-box;
            border: 2px solid rgba(96, 148, 255, 0.95); box-shadow: 0 0 0 3px rgba(96, 148, 255, 0.25), 0 0 14px rgba(96, 148, 255, 0.45); }
          .pills { position: fixed; left: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; max-width: 60vw; }
          .pill { user-select: none; font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: #fff;
            background: rgba(30, 40, 60, 0.9); border: 1px solid rgba(96, 148, 255, 0.9); border-radius: 999px; padding: 7px 12px;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        `);
        root.adoptedStyleSheets = [sheet];
        pills = document.createElement("div");
        pills.className = "pills";
        root.append(pills);
        (document.documentElement ?? document.body).appendChild(host);
        for (const w of watches.values()) w.ring = undefined;
      };
      const place = (): void => {
        if (watches.size === 0) return;
        ensureOverlay();
        if (root === undefined || pills === undefined) return;
        // The pills: each watch's own words, three at most.
        const texts = [...watches.values()].map((w) => w.spec.pill);
        const shownTexts = texts.length > 3 ? [...texts.slice(0, 2), `…and ${texts.length - 2} more`] : texts;
        if (pills.childElementCount !== shownTexts.length || shownTexts.some((t, i) => pills!.children[i]?.textContent !== t)) {
          pills.replaceChildren(...shownTexts.map((t) => { const p = document.createElement("div"); p.className = "pill"; p.textContent = t; return p; }));
        }
        // The rings, around each watched element where it is now (hidden while it is not on screen).
        for (const w of watches.values()) {
          if (w.el === undefined || w.spec.anyForm === true || w.spec.kind === "appeared" || w.spec.kind === "titled" || w.spec.kind === "navigated") continue;
          if (w.ring === undefined || !w.ring.isConnected) {
            w.ring = document.createElement("div");
            w.ring.className = "ring";
            root.append(w.ring);
          }
          const r = w.el.isConnected ? w.el.getBoundingClientRect() : undefined;
          const on = r !== undefined && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
          w.ring.style.display = on ? "block" : "none";
          if (on) {
            w.ring.style.transform = `translate(${Math.round(r.left - 4)}px, ${Math.round(r.top - 4)}px)`;
            w.ring.style.width = `${Math.round(r.width + 8)}px`;
            w.ring.style.height = `${Math.round(r.height + 8)}px`;
          }
        }
      };

      // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────
      const LISTENERS: Array<[string, (e: Event) => void]> = [
        ["pointerdown", onPointerDown], ["click", onClick], ["keydown", onKeyDown], ["submit", onSubmit], ["input", onInput], ["change", onInput],
      ];
      const install = (): void => {
        if (installed) return;
        installed = true;
        for (const [type, fn] of LISTENERS) addEventListener(type, fn, { capture: true });
        addEventListener("scroll", onMove, { capture: true, passive: true });
        addEventListener("resize", onMove, { passive: true });
        observer = new MutationObserver(onMutation);
        try { observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true }); } catch { /* a detached document */ }
        tick = setInterval(onTick, 1_000);
      };
      const uninstall = (): void => {
        if (!installed) return;
        installed = false;
        for (const [type, fn] of LISTENERS) removeEventListener(type, fn, { capture: true });
        removeEventListener("scroll", onMove, { capture: true });
        removeEventListener("resize", onMove);
        observer?.disconnect();
        observer = undefined;
        if (tick !== undefined) clearInterval(tick);
        tick = undefined;
        if (checkTimer !== undefined) clearTimeout(checkTimer);
        checkTimer = undefined;
        host?.remove();
        host = undefined;
        root = undefined;
        pills = undefined;
      };
      const remove = (id: string): boolean => {
        const w = watches.get(id);
        if (w === undefined) return false;
        watches.delete(id);
        if (w.settle !== undefined) clearTimeout(w.settle);
        w.ring?.remove();
        if (watches.size === 0) uninstall();
        else place();
        return true;
      };
      const removeAll = (): void => { for (const id of [...watches.keys()]) remove(id); };

      return {
        arm: (a) => {
          sink = a.sink;
          lastPoll = Date.now();
          dirty = true;
          const spec = a.spec;
          const existing = watches.get(spec.watchId);
          if (existing !== undefined) {
            existing.spec = { ...existing.spec, pill: spec.pill, expiresAt: spec.expiresAt };
            place();
            return { ok: true, installed: "alive", doc: performance.timeOrigin, ...(existing.last === undefined ? {} : { met: existing.last }) };
          }
          let el = a.element instanceof Element ? a.element : undefined;
          if (el === undefined && spec.locator !== undefined) {
            if (performance.timeOrigin !== spec.locator.doc) return { ok: false, reason: "doc" };
            el = locate(spec.locator);
            // Not there: for `gone` that is the condition itself (already true); for the rest, nothing to watch.
            if (el === undefined && spec.kind !== "gone") return { ok: false, reason: "gone" };
          }
          const w: W = { spec, ...(el === undefined ? {} : { el }) };
          if (spec.kind === "submitted" && spec.anyForm !== true) {
            w.form = formOf(el);
            if (w.form === undefined) return { ok: false, reason: "noform" };
          }
          if (spec.kind === "changed" && el !== undefined) w.value = valueOf(el);
          const m = met(w);
          if (m === true && spec.initial === "refuse") return { ok: false, reason: "met" };
          // A new document (not Winter's own doing) that already shows it: that is the transition.
          w.last = m === true && spec.initial === "fire" ? false : m;
          watches.set(spec.watchId, w);
          install();
          place();
          if (m === true && spec.initial === "fire") check();
          return { ok: true, installed: "new", doc: performance.timeOrigin, ...(m === undefined ? {} : { met: m }) };
        },
        disarm: (id) => remove(id),
        wait: async (a) => {
          lastPoll = Date.now();
          const ack = a.world === WORLD ? a.ack : 0;
          queue = queue.filter((e) => e.seq > ack);
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              const done = (): void => { waiters.delete(done); clearTimeout(timer); resolve(); };
              const timer = setTimeout(done, Math.max(0, Math.min(25_000, a.maxMs)));
              waiters.add(done);
            });
          }
          lastPoll = Date.now();
          return { world: WORLD, events: queue.slice(0, 50), alive: [...watches.keys()] };
        },
        alive: () => [...watches.keys()],
      };
    })();
    Object.defineProperty(g, KEY, { value: api, enumerable: false, configurable: false, writable: false });
  }
  switch (arg.op) {
    case "arm": return api.arm(arg);
    case "disarm": return api.disarm(arg.watchId);
    case "wait": return api.wait(arg);
    case "alive": return api.alive();
    default: return undefined;
  }
}
