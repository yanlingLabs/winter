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
// element or form that a navigation may cut short —, or "lost"), when (the page's clock), the top document's ORIGIN AND
// PATH ("?…" where it has a query: a GET form's typed values never leave) and, for a title watch, the title. Never a
// value the user typed, never coordinates, never page text.
//
// Only the USER's action counts: input conditions (clicked, submitted, changed) take only trusted DOM events. A click
// counts on the `click` itself (a press only on the release over the element: a press dragged off it is no press); a
// submit or a change also needs a trusted pointer or key event of the user's on the submitter or in the form (in the
// field) within about a second before it (`cause`, reported with it) — a page script's own `requestSubmit()` (an
// autosave, Turbo) or `execCommand()` has none; transient user activation is not enough (it lasts seconds, and Winter's
// own CDP input grants it). Enter counts as a press only where it submits implicitly: in a text-like field or on a
// submit button, never on a link or a `type=button`. Winter's own CDP input is trusted too — the DAEMON drops what lands
// (or whose `cause` lands) while Winter's input to the tab is in flight or within 500 ms after it. State conditions
// (appeared, gone, titled) report a false→true transition; one already true at the first install refuses the arm
// ("met"). A page that stops other listeners from its own capture listener on the window, registered before the
// watcher's, can starve it of the user's events (a stated residual: the wait then ends by expiry or by the model).
//
// While armed the user can SEE that Winter waits: a ring around the watched element and a small pill at the page's
// bottom left, in a closed shadow root under one `<winter-wake-overlay>` element that takes no pointer event (the page
// runtime leaves it out of its tree walk and hit tests). The pill's words are the daemon's (fixed per kind, naming
// only the element's own label). Watchers of one page in different worlds (the debugger path's, the extension's, a
// world left behind by a detach) share ONE pill: each overlay names its watches on its host (`data-pills`), and only the
// first overlay in the page draws them all; a watch armed again in a new world retires its old world's copy at once
// (`data-retire` on the old overlay's host).

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
  /** navigated: the model's words the tab's address must come to contain — matched where the address is known (Winter
   *  for Chrome matches them itself: nothing of an address beyond its site and path leaves it). */
  url?: string;
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
  /** submitted / changed: when the trusted pointer or key event that made it the user's landed. */
  cause?: number;
  /** The top document's origin and path, "?…" where it has a query and "#…" where it has a fragment (the daemon
   *  redacts it, and holds content conditions to its site floor). */
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
  /** queue sink: the events after `ack` (of world `world`), waiting at most `maxMs` (≤ 25 s) for one. `live`: the
   *  watches the daemon keeps — any other here is dropped (one whose disarm could not reach the page). */
  | { op: "wait"; ack: number; maxMs: number; world?: string; live?: string[] }
  | { op: "alive" };

/** How long the queue sink lives without a poll before it removes itself (the daemon polls every ≤ 20 s). */
export const WATCH_UNPOLLED_MS = 75_000;
/** The runtime sink's heartbeat to the extension (a watch it no longer knows removes itself). */
export const WATCH_HEARTBEAT_MS = 20_000;

/** An address as a watch report carries it: origin and path, "?…" where it has a query and "#…" where it has a fragment
 *  (a GET form's typed values never leave). The watcher keeps its own copy of this (it must stand alone). */
export function watchUrlShape(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return ""; }
  const base = u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname}`;
  return `${base.slice(0, 4000)}${u.search.length > 1 ? "?…" : ""}${u.hash.length > 1 ? "#…" : ""}`;
}

/** A short digest of a whole address (FNV-1a): tells one address from another — a `navigated` watch with no words —
 *  without carrying it. */
export function watchUrlKey(url: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** A submit or a change is the user's only with a trusted pointer or key event of theirs this soon before it. */
export const WATCH_CAUSE_MS = 1_000;
/** A page whose DOM never stops changing has its text read at most this often. */
export const WATCH_TEXT_FLOOR_MS = 2_000;

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
    lastCause?: number;
    settle?: ReturnType<typeof setTimeout>;
    missingSince?: number;
    lostSent?: boolean;
    ring?: HTMLElement;
  };
  type Api = {
    arm(a: { sink: "queue" | "runtime"; spec: WatchSpec; element?: Element }): WatchArmResult;
    disarm(id: string): boolean;
    wait(a: { ack: number; maxMs: number; world?: string; live?: string[] }): Promise<WatchWaitResult>;
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
      const CAUSE_MS = 1_000;
      const TEXT_FLOOR_MS = 2_000;
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
      /** The user's recent trusted pointer and key events (and clicks): when, and what they went through. */
      const recent: Array<{ at: number; path: EventTarget[] }> = [];

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

      /** The top document's origin and path — never its query or fragment (a GET form's typed values). */
      const where = (): string => {
        try {
          const u = new URL(String(location.href));
          const base = u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname}`;
          return `${base.slice(0, 4000)}${u.search.length > 1 ? "?…" : ""}${u.hash.length > 1 ? "#…" : ""}`;
        } catch { return ""; }
      };

      const report = (w: W, outcome: WatchEvent["outcome"], o: { at?: number; cause?: number; title?: string; reason?: WatchEvent["reason"] } = {}): void => {
        const ev: WatchEvent = {
          seq: ++seq, watchId: w.spec.watchId, outcome, at: o.at ?? Date.now(), url: where(),
          ...(o.cause === undefined ? {} : { cause: o.cause }),
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
      /** Where Enter submits a form by itself: a text-like field, or a submit button. Never a link, a `type=button`. */
      const TEXT_LIKE = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "datetime-local", "month", "week", "time"]);
      const submitsOnEnter = (t: EventTarget | undefined): boolean => {
        if (t instanceof HTMLInputElement) return TEXT_LIKE.has(t.type.toLowerCase()) || t.type === "submit" || t.type === "image";
        return t instanceof HTMLButtonElement && t.type === "submit";
      };
      /** A button or a link (what Enter presses). */
      const pressable = (t: EventTarget): boolean =>
        t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement && t.hasAttribute("href")
        || (t instanceof HTMLInputElement && ["submit", "button", "image", "reset"].includes(t.type))
        || (t instanceof Element && ["button", "link"].includes((t.getAttribute("role") ?? "").toLowerCase()));
      // The page's text costs a layout to read: read again only after the DOM changed, at most every 2 s on a page
      // that never stops changing (or every 10 s, for what changes with no mutation) — never on every tick.
      let textCache: string | undefined;
      let textAt = 0;
      let dirty = true;
      const visibleText = (force = false): string => {
        const age = Date.now() - textAt;
        if (!force && textCache !== undefined && age < 10_000 && (!dirty || age < TEXT_FLOOR_MS)) return textCache;
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
      const met = (w: W, fresh = false): boolean | undefined => {
        const s = w.spec;
        if (s.kind === "appeared") return visibleText(fresh).includes(s.text ?? "\u0000");
        if (s.kind === "titled") return document.title.includes(s.title ?? "\u0000");
        if (s.kind === "gone") {
          if (s.locator === undefined && w.el === undefined) return !visibleText(fresh).includes(s.text ?? "\u0000");
          if (w.el !== undefined && !w.el.isConnected && s.locator !== undefined) w.el = locate(s.locator);
          return w.el === undefined || !shown(w.el);
        }
        return undefined;
      };
      /** The user's trusted pointer or key event through one of `on`, at most `within` ms ago: when it landed. */
      const causeOf = (on: Array<Element | undefined>, within = CAUSE_MS): number | undefined => {
        const now = Date.now();
        for (let i = recent.length - 1; i >= 0; i--) {
          const r = recent[i]!;
          if (now - r.at > within) break;
          if (on.some((x) => x !== undefined && r.path.includes(x))) return r.at;
        }
        return undefined;
      };

      // ── the user's events ───────────────────────────────────────────────────────────────────────────────
      const note = (e: Event): void => {
        if (!e.isTrusted) return;
        recent.push({ at: Date.now(), path: e.composedPath() as EventTarget[] });
        if (recent.length > 24) recent.shift();
      };
      const onPointerUp = (e: Event): void => {
        note(e);
        if (!e.isTrusted) return;
        // Released over the watched element: a click that a navigation may cut short (a press dragged off is none).
        const path = e.composedPath();
        for (const w of watches.values()) if (w.spec.kind === "clicked" && w.el !== undefined && path.includes(w.el)) report(w, "pressed");
      };
      const onClick = (e: Event): void => {
        note(e);
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
        note(e);
        if (!e.isTrusted) return;
        if ((e as KeyboardEvent).key !== "Enter") return;
        const path = e.composedPath();
        const target = path[0];
        for (const w of watches.values()) {
          if (w.spec.kind === "clicked" && w.el !== undefined && path.includes(w.el) && target !== undefined && pressable(target)) report(w, "pressed");
          else if (w.spec.kind === "submitted" && submitsOnEnter(target)) {
            const f = formOf(target as Element);
            if (f !== undefined && (w.spec.anyForm === true || f === w.form)) report(w, "pressed");
          }
        }
      };
      const onKeyUp = (e: Event): void => {
        note(e);
        if (!e.isTrusted || (e as KeyboardEvent).key !== " ") return;
        const path = e.composedPath();
        const target = path[0];
        for (const w of watches.values()) {
          if (w.spec.kind === "clicked" && w.el !== undefined && path.includes(w.el) && target !== undefined && pressable(target) && !(target instanceof HTMLAnchorElement)) report(w, "pressed");
        }
      };
      const onSubmit = (e: Event): void => {
        if (!e.isTrusted) return;
        const f = e.target;
        if (!(f instanceof HTMLFormElement)) return;
        // The user's own pointer or key event on the submitter or in the form, just before: else a page script's.
        const submitter = (e as SubmitEvent).submitter ?? undefined;
        const cause = causeOf([submitter instanceof Element ? submitter : undefined, f]);
        if (cause === undefined) return;
        for (const w of watches.values()) if (w.spec.kind === "submitted" && (w.spec.anyForm === true || f === w.form)) report(w, "fired", { cause });
      };
      const onInput = (e: Event): void => {
        if (!e.isTrusted) return;
        const path = e.composedPath();
        const target = path[0];
        if (target instanceof Element && secure(target)) return;
        for (const w of watches.values()) {
          if (w.spec.kind !== "changed" || w.el === undefined || !path.includes(w.el)) continue;
          // The user's own pointer or key event in the field, just before (a native <select> popup's choice comes
          // with none: its opening press counts while nothing else came after it).
          const latest = recent[recent.length - 1];
          const cause = causeOf([w.el]) ?? (target instanceof HTMLSelectElement && latest !== undefined && Date.now() - latest.at <= 60_000 && latest.path.includes(w.el) ? latest.at : undefined);
          if (cause === undefined) continue;
          w.lastInput = Date.now();
          w.lastCause = cause;
          if (w.settle !== undefined) clearTimeout(w.settle);
          w.settle = setTimeout(() => {
            w.settle = undefined;
            if (!watches.has(w.spec.watchId) || w.el === undefined) return;
            const v = valueOf(w.el);
            if (v === w.value) return;
            w.value = v;
            report(w, "fired", { at: w.lastInput ?? Date.now(), ...(w.lastCause === undefined ? {} : { cause: w.lastCause }) });
          }, Math.max(100, Math.min(60_000, w.spec.settleMs ?? 1_500)));
        }
      };
      const onMove = (): void => { if (!frameAsked) { frameAsked = true; try { requestAnimationFrame(() => { frameAsked = false; place(); }); } catch { frameAsked = false; } } };

      // ── checking ────────────────────────────────────────────────────────────────────────────────────────
      const check = (): void => {
        lastCheck = Date.now();
        // Watches armed again in a newer world: this world's copies go at once (their ring and pill with them).
        const retire = host?.getAttribute("data-retire");
        if (retire !== null && retire !== undefined && sink === "queue") {
          host!.removeAttribute("data-retire");
          let ids: unknown;
          try { ids = JSON.parse(retire); } catch { ids = []; }
          if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") remove(id);
          if (watches.size === 0) return;
        }
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
              if (Date.now() - w.missingSince >= MISSING_MS && w.lostSent !== true) {
                w.lostSent = true;
                // When it went, not when it was given up on (a press just before it can still make it the user's).
                report(w, "lost", { reason: "gone", at: w.missingSince });
              }
            }
          } else {
            w.missingSince = undefined;
          }
        }
        place();
      };
      const onMutation = (records: MutationRecord[]): void => {
        // An overlay's own host changing (its pills, a retirement) is no change of the page's text.
        if (records.some((r) => !(r.type === "attributes" && r.target instanceof Element && r.target.tagName.toLowerCase() === TAG))) dirty = true;
        scheduleCheck();
      };
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
        host.setAttribute("data-world", WORLD);
        host.setAttribute("data-sink", sink);
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
      /** Every overlay of the page and the watches it names (`data-pills`): [host, [[id, words], …]]. */
      const overlays = (): Array<[Element, Array<[string, string]>]> => {
        const out: Array<[Element, Array<[string, string]>]> = [];
        for (const h of Array.from(document.querySelectorAll(TAG)).slice(0, 16)) {
          let list: unknown;
          try { list = JSON.parse(h.getAttribute("data-pills") ?? "[]"); } catch { list = []; }
          const named = Array.isArray(list) ? list.filter((x): x is [string, string] => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string").slice(0, 32) : [];
          out.push([h, named]);
        }
        return out;
      };
      const place = (): void => {
        if (watches.size === 0) return;
        ensureOverlay();
        if (root === undefined || pills === undefined || host === undefined) return;
        // This world's watches, named on its host; ONE pill list for the page: the first overlay that names any draws
        // them all (another world's — the extension's, or one a detach left behind — included, each watch once).
        const mine: Array<[string, string]> = [...watches.values()].map((w) => [w.spec.watchId, w.spec.pill]);
        const named = JSON.stringify(mine);
        if (host.getAttribute("data-pills") !== named) host.setAttribute("data-pills", named);
        const all = overlays().filter(([, list]) => list.length > 0);
        const leader = all.length === 0 || all[0]![0] === host;
        // Said on the host (a fact the page could see anyway: which overlay draws).
        if (leader !== host.hasAttribute("data-lead")) { if (leader) host.setAttribute("data-lead", ""); else host.removeAttribute("data-lead"); }
        const seen = new Set<string>();
        const texts: string[] = [];
        if (leader) {
          for (const [, list] of [[host, mine] as [Element, Array<[string, string]>], ...all.filter(([h]) => h !== host)]) {
            for (const [id, words] of list) { if (!seen.has(id)) { seen.add(id); texts.push(words.slice(0, 300)); } }
          }
        }
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
      /** A watch armed here that another world (one a detach left behind) still keeps: that copy retires at once. */
      const retireElsewhere = (id: string): void => {
        for (const [h, list] of overlays()) {
          if (h === host || h.getAttribute("data-sink") !== "queue" || !list.some(([x]) => x === id)) continue;
          let ids: unknown;
          try { ids = JSON.parse(h.getAttribute("data-retire") ?? "[]"); } catch { ids = []; }
          const next = Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [];
          if (!next.includes(id)) next.push(id);
          h.setAttribute("data-retire", JSON.stringify(next.slice(-32)));
        }
      };

      // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────
      const LISTENERS: Array<[string, (e: Event) => void]> = [
        ["pointerdown", note], ["pointerup", onPointerUp], ["click", onClick], ["keydown", onKeyDown], ["keyup", onKeyUp],
        ["submit", onSubmit], ["input", onInput], ["change", onInput],
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
        recent.length = 0;
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
          const m = met(w, true);
          if (m === true && spec.initial === "refuse") return { ok: false, reason: "met" };
          // A new document (not Winter's own doing) that already shows it: that is the transition.
          w.last = m === true && spec.initial === "fire" ? false : m;
          watches.set(spec.watchId, w);
          install();
          place();
          retireElsewhere(spec.watchId);
          if (m === true && spec.initial === "fire") check();
          return { ok: true, installed: "new", doc: performance.timeOrigin, ...(m === undefined ? {} : { met: m }) };
        },
        disarm: (id) => remove(id),
        wait: async (a) => {
          lastPoll = Date.now();
          // The daemon names the watches it keeps: one it no longer does (its disarm never reached the page) goes now.
          if (Array.isArray(a.live)) for (const id of [...watches.keys()]) if (!a.live.includes(id)) remove(id);
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
