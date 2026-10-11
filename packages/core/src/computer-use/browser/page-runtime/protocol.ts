// ComputerV2 Phase 2 — the contract between the browser engine (daemon) and the page runtime it installs in each
// frame's isolated "winter" world. TYPES ONLY: imported by the runtime's source (bundled for the browser) and by the
// engine, so the two cannot drift. Every call is ONE `Runtime.callFunctionOn` of `PAGE_RUNTIME_CALL` with
// `(op, arg)`, returned by value.
//
// Ids are the runtime's own (`RtId`): small integers per DOCUMENT, minted the first time the runtime meets a node and
// kept while it exists. The engine maps (runtime instance, id) to the tab's model-visible refs.

export type RtId = number;

/** One element (or text leaf) of a frame's tree. Role words are already Phase 1's ("text field", "check box"). */
export interface RtNode {
  id: RtId;
  role: string;
  name?: string;
  /** The value as shown — already `<redacted>` for a secure field or a token-looking value. */
  value?: string;
  /** Show `value=…` even when empty (a text field's empty value is a fact the model needs). */
  showEmptyValue?: true;
  secure?: true;
  /** "disabled", "focused", "selected", "checked", "unchecked", "expanded", "collapsed". */
  states?: string[];
  /** A heading's level. */
  level?: number;
  /** A link's target host. */
  href?: string;
  /** An iframe: its origin's host (`about:srcdoc` for an inline one). The engine grafts the child frame under it. */
  frame?: true;
  origin?: string;
  /** A list's or list box's item count. */
  items?: number;
  /** Entirely outside the viewport (folded first when the tree is too long). */
  off?: true;
  /** Children the read stopped before (its node budget): shown as a "more" marker. */
  unread?: number;
  children?: RtNode[];
}

export interface RtSnapshot {
  url: string;
  title: string;
  /** The element with the keyboard focus, when this frame has it. */
  focused?: RtId;
  /** The focus is inside a child frame: the id of its iframe element. */
  focusedFrame?: RtId;
  roots: RtNode[];
  /** The read stopped at its budget: at least this many elements were not read. */
  unread?: number;
}

/** What `point` answers: where to click, or why not. Coordinates are CSS px in this frame's viewport. */
export type RtPoint =
  /** `picker`: the element (or the control a label forwards to) opens a native menu, picker or chooser window when
   *  pressed (the engine refuses pointer input). */
  | { ok: true; x: number; y: number; picker?: string }
  | { ok: false; reason: "gone" | "hidden" | "disabled" | "offscreen" }
  | { ok: false; reason: "covered"; by: { id: RtId; role: string; name?: string } };

/** The keyboard target's class, for the secure-field floor. `frame`: the target is an iframe — ask the child frame. */
export type RtClassify =
  | { kind: "ok"; editable: boolean; id?: RtId; role?: string; name?: string }
  | { kind: "secure"; id?: RtId }
  /** A native picker control (a <select>, a date/time/color or file input): keys could open its window. */
  | { kind: "picker"; id: RtId; what: string }
  | { kind: "frame"; id: RtId }
  | { kind: "unknown" };

/** What a pixel point hits in a frame: a native picker control, or an iframe to look into (its element's id). */
export interface RtHit { picker?: string; id?: RtId; frame?: RtId }

export interface RtFindQuery { text?: string; role?: string; name?: string }
export interface RtFound { id: RtId; role: string; name?: string; value?: string; states?: string[] }

/** `waitFor`'s conditions the runtime can check by itself (refs are the engine's: it passes their ids). */
export interface RtCondition { text?: string; title?: string; url?: string; goneText?: string; ids?: RtId[]; goneIds?: RtId[] }
export interface RtCheck { met: boolean; seen: string }

/** The ops, by name → argument → answer. */
export interface RtOps {
  hello: { arg: null; result: { id: string; url: string; title: string; readyState: string } };
  snapshot: { arg: { within?: RtId; maxNodes?: number }; result: RtSnapshot };
  find: { arg: RtFindQuery; result: RtFound[] };
  text: { arg: { markdown?: boolean }; result: string };
  /** The id of the element `this` (an element-bound call). */
  owner: { arg: null; result: RtId };
  /** An iframe element's content-box origin in this frame's viewport (scrolled into view first with `scroll`). */
  frameOffset: { arg: { id: RtId; scroll?: boolean; inner?: { x: number; y: number } }; result: { x: number; y: number } | null };
  /** `guardMenu`: a right-click follows — the browser's own context menu is not to open (unless the page shows its own). */
  point: { arg: { id: RtId; scroll?: boolean; settle?: boolean; guardMenu?: boolean }; result: RtPoint };
  /** The keyboard target: `id`'s element, else the focused element. */
  classify: { arg: { id?: RtId }; result: RtClassify };
  focus: { arg: { id: RtId }; result: RtClassify };
  /** `reason: "text"`: the id names a text leaf, not a field — `control` is the field it labels, if any. */
  setValue: { arg: { id: RtId; value: string }; result: { ok: true; shown: string } | { ok: false; reason: string; control?: RtId } };
  select: { arg: { id: RtId; text: string; before?: string; after?: string; caret?: "start" | "end" }; result: { ok: true } | { ok: false; reason: string } };
  /** Read back what a field holds now (for "received: verified"); null for a secure one. */
  readValue: { arg: { id: RtId }; result: string | null };
  /** Is `id` a file input; how many files it takes. */
  fileInput: { arg: { id: RtId }; result: { ok: true; multiple: boolean } | { ok: false; reason: string; control?: RtId } };
  /** Return the element itself (called with returnByValue:false — the engine needs its object id). */
  element: { arg: { id: RtId }; result: unknown };
  /** A synthetic paste of `html`/`text` into the focused element; `handled` when the page took it. */
  pasteEvent: { arg: { html?: string; text: string }; result: { handled: boolean } };
  /** ms since the last DOM mutation this runtime saw; the document's url, title and ready state. */
  quiet: { arg: null; result: { sinceMutationMs: number; url: string; title: string; readyState: string } };
  /** Resolves on the next DOM mutation, or after `maxMs`. */
  waitChange: { arg: { maxMs: number }; result: boolean };
  check: { arg: RtCondition; result: RtCheck };
  /** Which of these ids still name a connected element. */
  alive: { arg: { ids: RtId[] }; result: RtId[] };
  hitAt: { arg: { x: number; y: number; guardMenu?: boolean }; result: RtHit };
}
export type RtOp = keyof RtOps;

/** The function every call runs (the engine sends it as `functionDeclaration`). */
export const PAGE_RUNTIME_CALL = "function (op, arg) { return globalThis.__winterRuntime.call(op, arg, this); }";
/** The global the runtime installs itself under, in the isolated world only (the page never sees it). */
export const PAGE_RUNTIME_GLOBAL = "__winterRuntime";
