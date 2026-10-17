// The REAL page watcher (`page-runtime/watch.ts`, `wakeWatcher`), run fast: its own source text — as Chrome serializes
// it for `executeScript` — evaluated in a fresh `node:vm` context per test, over a minimal fake DOM and a fake clock (no
// DOM library: none is a dependency). What layout decides (rings, `innerText` as rendered) stays with the opt-in e2e
// runners in a real Chromium; this file holds the rules that need no layout: the user's cause for a submit, Enter and a
// press, the watches each poll keeps, the text-read floor on a page that never stops changing, retirement.
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { wakeWatcher, WATCH_TEXT_FLOOR_MS, type WatchSpec, type WatcherArg } from "../../src/computer-use/browser/page-runtime/watch";

// ── a minimal DOM ───────────────────────────────────────────────────────────────────────────────────────────────────

class FakeNode {
  parentNode: FakeNode | null = null;
  readonly kids: FakeElement[] = [];
  get children(): FakeElement[] { return this.kids; }
  get childElementCount(): number { return this.kids.length; }
  append(...els: FakeElement[]): void { for (const e of els) { e.parentNode = this; this.kids.push(e); } }
  appendChild(e: FakeElement): FakeElement { this.append(e); return e; }
  replaceChildren(...els: FakeElement[]): void { for (const k of this.kids) k.parentNode = null; this.kids.length = 0; this.append(...els); }
  get isConnected(): boolean { let n: FakeNode | null = this; while (n !== null) { if (n instanceof FakeDocument) return true; n = n instanceof FakeShadowRoot ? n.host : n.parentNode; } return false; }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode): void => { for (const k of n.kids) { if (sel === "*" || k.tagName.toLowerCase() === sel.toLowerCase()) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
}
class FakeShadowRoot extends FakeNode {
  adoptedStyleSheets: unknown[] = [];
  constructor(readonly host: FakeElement) { super(); }
}
class FakeElement extends FakeNode {
  readonly attrs = new Map<string, string>();
  readonly style = { setProperty: (): void => {}, display: "", transform: "", width: "", height: "" };
  shadowRoot: FakeShadowRoot | null = null;
  className = "";
  textContent = "";
  text = "";
  form?: FakeElement;
  constructor(readonly tagName: string) { super(); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); env?.mutate([{ type: "attributes", target: this }]); }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  attachShadow(): FakeShadowRoot { const r = new FakeShadowRoot(this); return r; }
  remove(): void { const p = this.parentNode; if (p !== null) { p.kids.splice(p.kids.indexOf(this), 1); this.parentNode = null; } }
  closest(sel: string): FakeElement | null { let n: FakeNode | null = this; while (n instanceof FakeElement) { if (n.tagName.toLowerCase() === sel) return n; n = n.parentNode; } return null; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
}
class FakeHTMLElement extends FakeElement {}
class FakeForm extends FakeHTMLElement { constructor() { super("FORM"); } }
class FakeInput extends FakeHTMLElement { value = ""; checked = false; constructor(public type = "text") { super("INPUT"); } }
class FakeButton extends FakeHTMLElement { constructor(public type = "submit") { super("BUTTON"); } }
class FakeAnchor extends FakeHTMLElement { constructor() { super("A"); this.attrs.set("href", "#x"); } }
class FakeBody extends FakeHTMLElement {
  reads = 0;
  constructor() { super("BODY"); }
  get innerText(): string { this.reads++; return this.text; }
}
class FakeDocument extends FakeNode {
  title = "Review form";
  readonly documentElement = new FakeHTMLElement("HTML");
  readonly body = new FakeBody();
  constructor() { super(); this.append(this.documentElement); this.documentElement.append(this.body); }
  createElement(tag: string): FakeElement { return new FakeHTMLElement(tag.toUpperCase()); }
}

/** A trusted (or not) event through `target` and its ancestors, to the capture listeners on the window. */
interface FakeEvent { type: string; isTrusted: boolean; target: FakeNode; key?: string; submitter?: FakeElement | null; composedPath(): FakeNode[] }
const eventOn = (type: string, target: FakeNode, o: { trusted?: boolean; key?: string; submitter?: FakeElement } = {}): FakeEvent => ({
  type, isTrusted: o.trusted !== false, target, ...(o.key === undefined ? {} : { key: o.key }), ...(o.submitter === undefined ? {} : { submitter: o.submitter }),
  composedPath: () => { const p: FakeNode[] = []; let n: FakeNode | null = target; while (n !== null) { p.push(n); n = n instanceof FakeShadowRoot ? n.host : n.parentNode; } return p; },
});

let env: ReturnType<typeof makeEnv> | undefined;

function makeEnv() {
  let now = 1_800_000_000_000;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  let next = 1;
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  let observer: ((records: unknown[]) => void) | undefined;
  const document = new FakeDocument();
  const sent: unknown[] = [];
  const ctx: Record<string, unknown> = {
    Date: { now: () => now }, Math, JSON, Array, Object, Promise, Number, String, Set, Map, Error, TypeError, URL,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: (id: number) => { timers.delete(id); },
    requestAnimationFrame: (fn: () => void) => { const id = next++; timers.set(id, { at: now + 16, fn }); return id; },
    performance: { timeOrigin: 1_700_000_000_000.5 },
    location: { href: "https://shop.example/review?draft=secret#top" },
    document, innerWidth: 1200, innerHeight: 800, navigator: {},
    addEventListener: (type: string, fn: (e: unknown) => void) => { const l = listeners.get(type) ?? []; l.push(fn); listeners.set(type, l); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    MutationObserver: class { constructor(cb: (records: unknown[]) => void) { observer = cb; } observe(): void {} disconnect(): void { observer = undefined; } },
    CSSStyleSheet: class { replaceSync(): void {} },
    CSS: { escape: (s: string) => s },
    getComputedStyle: () => ({ visibility: "visible" }),
    Element: FakeElement, HTMLElement: FakeHTMLElement, HTMLFormElement: FakeForm, HTMLInputElement: FakeInput, HTMLButtonElement: FakeButton,
    HTMLAnchorElement: FakeAnchor, HTMLSelectElement: class extends FakeHTMLElement {}, HTMLTextAreaElement: class extends FakeHTMLElement {},
    ShadowRoot: FakeShadowRoot, Document: FakeDocument, DocumentFragment: FakeShadowRoot, Text: class {},
    chrome: { runtime: { sendMessage: (m: unknown) => { sent.push(m); return Promise.resolve({}); } } },
  };
  vm.createContext(ctx);
  const src = wakeWatcher.toString();
  const e = {
    document, sent,
    call: (arg: WatcherArg | Record<string, unknown>): any => vm.runInContext(`(${src})(${JSON.stringify(arg)})`, ctx),
    armEl: (spec: WatchSpec, el: FakeElement): any => { ctx.__arg = { op: "arm", sink: "queue", spec, element: el }; return vm.runInContext(`(${src})(__arg)`, ctx); },
    dispatch: (ev: FakeEvent): void => { for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev); },
    mutate: (records: unknown[]): void => { observer?.(records); },
    advance: async (ms: number): Promise<void> => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, t] = due;
        now = t.at;
        if (t.every !== undefined) t.at += t.every; else timers.delete(id);
        t.fn();
        await Promise.resolve();
      }
      now = end;
    },
    get now(): number { return now; },
  };
  env = e;
  return e;
}

const spec = (over: Partial<WatchSpec> = {}): WatchSpec => ({
  watchId: "wk_000000000001", kind: "appeared", text: "Saved", pill: "Winter continues when this page changes",
  expiresAt: Date.now() + 3_600_000 * 24 * 365 * 10, initial: "refuse", ...over,
});

/** A page with a form: an email field, a submit button, a Cancel link. */
function formPage(e: ReturnType<typeof makeEnv>) {
  const form = new FakeForm();
  const email = new FakeInput("text");
  const submit = new FakeButton("submit");
  const cancel = new FakeAnchor();
  for (const el of [email, submit, cancel]) el.form = form;
  form.append(email, submit, cancel);
  e.document.body.append(form);
  return { form, email, submit, cancel };
}

async function queued(e: ReturnType<typeof makeEnv>, live?: string[]): Promise<{ events: Array<Record<string, any>>; alive: string[] }> {
  const p = e.call({ op: "wait", ack: 0, maxMs: 0, ...(live === undefined ? {} : { live }) }) as Promise<{ events: Array<Record<string, any>>; alive: string[] }>;
  await e.advance(1);
  return await p;
}

describe("the real watcher, fast (a fake DOM in a vm context)", () => {
  test("a page that never stops changing has its text read at most every 2 s (WATCH_TEXT_FLOOR_MS)", async () => {
    const e = makeEnv();
    e.document.body.text = "Draft";
    expect(e.call({ op: "arm", sink: "queue", spec: spec() })).toMatchObject({ ok: true, installed: "new" });
    const start = e.document.body.reads;
    // A mutation every 100 ms for 10 s.
    for (let i = 0; i < 100; i++) { e.mutate([{ type: "childList", target: e.document.body }]); await e.advance(100); }
    const reads = e.document.body.reads - start;
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(reads).toBeLessThanOrEqual(Math.ceil(10_000 / WATCH_TEXT_FLOOR_MS) + 1);
    // …and the text it waits for is still seen (within the floor).
    e.document.body.text = "Draft — Saved";
    e.mutate([{ type: "childList", target: e.document.body }]);
    await e.advance(WATCH_TEXT_FLOOR_MS + 600);
    expect((await queued(e)).events.map((x) => x.outcome)).toEqual(["fired"]);
  });

  test("each poll names the watches the daemon keeps: any other in the world goes (its disarm never reached the page)", async () => {
    const e = makeEnv();
    e.call({ op: "arm", sink: "queue", spec: spec({ watchId: "wk_00000000000a" }) });
    e.call({ op: "arm", sink: "queue", spec: spec({ watchId: "wk_00000000000b", text: "Done" }) });
    expect((await queued(e)).alive.sort()).toEqual(["wk_00000000000a", "wk_00000000000b"]);
    expect((await queued(e, ["wk_00000000000b"])).alive).toEqual(["wk_00000000000b"]);
  });

  test("a submit fires only with the user's trusted pointer or key event on the submitter or in the form within a second before (its cause); a page script's requestSubmit() never does", async () => {
    const e = makeEnv();
    const { form, submit } = formPage(e);
    e.call({ op: "arm", sink: "queue", spec: spec({ kind: "submitted", anyForm: true, text: undefined }) });
    // The page submits by itself (autosave): a trusted submit event with no input of the user's behind it.
    e.dispatch(eventOn("submit", form, { submitter: undefined }));
    // A click long ago, then a submit: too late to be its cause.
    e.dispatch(eventOn("pointerdown", submit));
    await e.advance(1_500);
    e.dispatch(eventOn("submit", form));
    expect((await queued(e)).events).toEqual([]);
    // An untrusted click (a page script's) is no cause either.
    e.dispatch(eventOn("click", submit, { trusted: false }));
    e.dispatch(eventOn("submit", form));
    expect((await queued(e)).events).toEqual([]);
    // The user's own press of the submit button, then its submit.
    e.dispatch(eventOn("pointerdown", submit));
    const pressedAt = e.now;
    await e.advance(30);
    e.dispatch(eventOn("submit", form, { submitter: submit }));
    const fired = (await queued(e)).events.filter((x) => x.outcome === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.cause).toBe(pressedAt);
    // The address it reports: origin and path only.
    expect(fired[0]!.url).toBe("https://shop.example/review?…#…");
  });

  test("Enter is a press only where it submits implicitly — in a text field, on a submit button — never on a link", async () => {
    const e = makeEnv();
    const { form, email, cancel } = formPage(e);
    e.armEl(spec({ kind: "submitted", text: undefined }), form);
    e.dispatch(eventOn("keydown", cancel, { key: "Enter" }));
    expect((await queued(e)).events).toEqual([]);
    e.dispatch(eventOn("keydown", email, { key: "Enter" }));
    expect((await queued(e)).events.map((x) => x.outcome)).toEqual(["pressed"]);
  });

  test("a click is pressed on its release over the element, fired on its click — a press dragged off is neither", async () => {
    const e = makeEnv();
    const { submit } = formPage(e);
    e.armEl(spec({ kind: "clicked", text: undefined }), submit);
    // Down on it, up elsewhere (the browser's click lands on the common ancestor, never the button).
    e.dispatch(eventOn("pointerdown", submit));
    e.dispatch(eventOn("pointerup", e.document.body));
    e.dispatch(eventOn("click", e.document.body));
    expect((await queued(e)).events).toEqual([]);
    e.dispatch(eventOn("pointerdown", submit));
    e.dispatch(eventOn("pointerup", submit));
    e.dispatch(eventOn("click", submit));
    expect((await queued(e)).events.map((x) => x.outcome)).toEqual(["pressed", "fired"]);
  });

  test("an overlay whose host is told to retire a watch (a newer world armed it) drops it at once; ONE overlay of the page draws the pills", async () => {
    const e = makeEnv();
    e.document.body.text = "Draft";
    e.call({ op: "arm", sink: "queue", spec: spec({ watchId: "wk_00000000000a" }) });
    e.call({ op: "arm", sink: "queue", spec: spec({ watchId: "wk_00000000000b", text: "Done" }) });
    const host = e.document.querySelectorAll("winter-wake-overlay")[0]!;
    expect(host.hasAttribute("data-lead")).toBe(true);
    expect(JSON.parse(host.getAttribute("data-pills")!).map((x: [string, string]) => x[0])).toEqual(["wk_00000000000a", "wk_00000000000b"]);
    host.setAttribute("data-retire", JSON.stringify(["wk_00000000000a"]));
    await e.advance(600);
    expect((await queued(e)).alive).toEqual(["wk_00000000000b"]);
  });
});
