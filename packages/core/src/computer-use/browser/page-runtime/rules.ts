// ComputerV2 Phase 2 — the page runtime's SAFETY RULES, as pure functions over plain facts about an element (no DOM
// types, no I/O). The runtime (`main.ts`) reads the facts off the element and asks these; the daemon's unit tests ask
// them directly, so the floors are covered by the ordinary core test run without a browser.
//
//   - the SECURE-FIELD floor: password inputs, `autocomplete` one-time-code / current|new-password / cc-*, and every
//     text entry in a payment provider's frame — never typed into, never read;
//   - NATIVE PICKERS: a <select> (a multiple one too), inputs of type date / time / datetime-local / month / week /
//     color, and a file input open a native menu, picker or chooser window when pressed or keyed (Space, Enter,
//     Alt-Down…) — the browser embed has no hook to stop them, so a pointer or keyboard act on one is refused
//     (setValue, or upload for a file input). A label forwards a press to its control, so pressing one counts as
//     pressing it. RESIDUAL RISK, by nature undetectable: a page's own script opening a picker from an ordinary
//     element (`showPicker()`, `input.click()` from a button's handler);
//   - FAIL CLOSED: a keyboard target that cannot be determined is `unknown`, which the engine refuses.

/** What the runtime reads off an element for the rules. */
export interface ElementFacts {
  /** Upper-case tag name ("INPUT", "SELECT", …). */
  tag: string;
  /** An <input>'s type, lower-case ("" when none). */
  type?: string;
  /** The `autocomplete` attribute, as written. */
  autocomplete?: string;
  /** The element is the root of an editable region (`isContentEditable`). */
  contentEditable?: boolean;
}

export const SECURE_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  "current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year",
]);

/** Hosts whose frames are payment fields (a card form served by the provider in an iframe). */
export const PAYMENT_HOSTS: readonly string[] = [
  "stripe.com", "stripe.network", "braintreegateway.com", "braintree-api.com", "adyen.com", "adyenpayments.com", "checkout.com",
  "paypal.com", "paypalobjects.com", "squareup.com", "squarecdn.com", "recurly.com", "chargebee.com", "klarna.com", "spreedly.com",
  "authorize.net", "worldpay.com", "globalpay.com", "pay.google.com", "payments.amazon.com", "afterpay.com", "affirm.com",
];

/** Is `hostname` (a child frame's own) a payment provider's? */
export function isPaymentHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PAYMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["", "text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "week", "time"]);

/** Does the element take typed text? */
export function isTextEntry(f: ElementFacts): boolean {
  if (f.tag === "TEXTAREA") return true;
  if (f.tag === "INPUT") return TEXT_INPUT_TYPES.has((f.type ?? "").toLowerCase());
  return f.contentEditable === true;
}

/** The secure-field floor. `inPaymentFrame`: the element's own frame is a payment provider's. */
export function isSecureField(f: ElementFacts, inPaymentFrame: boolean): boolean {
  if (f.tag === "INPUT" && (f.type ?? "").toLowerCase() === "password") return true;
  const tokens = (f.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (tokens.some((t) => SECURE_AUTOCOMPLETE.has(t))) return true;
  return inPaymentFrame && isTextEntry(f);
}

export const PICKER_INPUT_TYPES: ReadonlySet<string> = new Set(["date", "time", "datetime-local", "month", "week", "color"]);

export const FILE_CHOOSER = "a file chooser";

/** A control a click or a key would open a native menu, picker or chooser window for — the word for it, or
 *  undefined. */
export function nativePicker(f: ElementFacts): string | undefined {
  if (f.tag === "SELECT") return "a pop-up menu";
  if (f.tag === "INPUT") {
    const type = (f.type ?? "").toLowerCase();
    if (type === "file") return FILE_CHOOSER;
    if (PICKER_INPUT_TYPES.has(type)) return type === "color" ? "a color picker" : `a ${type} picker`;
  }
  return undefined;
}

/** What to use instead of pressing a picker control. */
export function pickerAdvice(what: string): string {
  return what === FILE_CHOOSER ? "upload(ref, paths)" : "setValue(ref, value)";
}

/** The value shape a picker input's `setValue` takes, for the sentence that says how. */
export function pickerValueHint(type: string): string | undefined {
  switch (type.toLowerCase()) {
    case "date": return "YYYY-MM-DD";
    case "time": return "HH:MM";
    case "datetime-local": return "YYYY-MM-DDTHH:MM";
    case "month": return "YYYY-MM";
    case "week": return "YYYY-W##";
    case "color": return "#rrggbb";
    default: return undefined;
  }
}

/** A keyboard target's class, decided from what the runtime could read — FAIL CLOSED: no element is `unknown`. */
export type TargetClass = { kind: "secure" } | { kind: "picker"; what: string } | { kind: "frame" } | { kind: "ok"; editable: boolean } | { kind: "unknown" };

export function classifyTarget(f: ElementFacts | null | undefined, o: { inPaymentFrame: boolean; isBody?: boolean }): TargetClass {
  if (f === null || f === undefined) return { kind: "unknown" };
  if (o.isBody === true) return { kind: "ok", editable: false };
  if (f.tag === "IFRAME" || f.tag === "FRAME") return { kind: "frame" };
  if (isSecureField(f, o.inPaymentFrame)) return { kind: "secure" };
  const picker = nativePicker(f);
  if (picker !== undefined) return { kind: "picker", what: picker };
  return { kind: "ok", editable: isTextEntry(f) };
}

// ── find({ css }): the selectors a script may run (Phase 3 review, HIGH 1) ─────────────────────────────────────────
//
// An attribute selector that TESTS a value (`[value^="hu"]`, `meta[content^="a"]`) matches the RAW DOM, so a loop over
// `find({ css })`'s match count would read a password a framework mirrors into `value`, or a hidden CSRF token, one
// character at a time — past the secure-field floor and the hidden() filter. So `find({ css })` takes only a tokenised
// SAFE SUBSET: tag names and `*`, `#id`, `.class`, `[attr]` PRESENCE (no operator, no value), the combinators (space,
// `>`, `+`, `~`) and `,`, and a few pseudo-classes — structural ones, the element states state() already shows, and
// `:not()`/`:is()`/`:where()`/`:has()` over the same subset. No quotes, no backslash escapes, no namespaces, no
// pseudo-elements; anything else is refused with the reason.

const CSS_PLAIN_PSEUDOS: ReadonlySet<string> = new Set([
  "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "empty", "root",
  "enabled", "disabled", "checked", "required", "optional", "read-only", "read-write", "link", "any-link", "focus", "focus-within",
]);
const CSS_NTH_PSEUDOS: ReadonlySet<string> = new Set(["nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type"]);
const CSS_NESTING_PSEUDOS: ReadonlySet<string> = new Set(["not", "is", "where", "has"]);
/** Attributes whose value may be tested for EQUALITY with a plain word (`input[type=password]`, `[role=tab]`): they
 *  describe an element, never carry what a user typed or a secret. Never `value`, `content`, `href`, `src`… */
const CSS_EQUALITY_ATTRS: ReadonlySet<string> = new Set([
  "type", "role", "name", "for", "rel", "lang", "dir", "tabindex", "autocomplete", "inputmode",
  "data-testid", "data-test-id", "data-test", "data-cy",
]);

/** Why `selector` may not run in `find({ css })`, or undefined when it is in the safe subset. */
export function cssSelectorRefusal(selector: string): string | undefined {
  if (selector.length === 0) return "it is empty";
  if (selector.length > 500) return "it is longer than 500 characters";
  let i = 0;
  const s = selector;
  const ident = (): string | undefined => {
    const m = /^-?[A-Za-z_\u00a0-\uffff][-A-Za-z0-9_\u00a0-\uffff]*/.exec(s.slice(i));
    if (m === null) return undefined;
    i += m[0].length;
    return m[0];
  };
  const ws = (): boolean => { const start = i; while (i < s.length && /\s/.test(s[i]!)) i++; return i > start; };
  // A compound selector: [tag | *] then any of #id .class [attr] :pseudo.
  const compound = (depth: number): string | undefined => {
    let any = false;
    if (s[i] === "*") { i++; any = true; } else if (ident() !== undefined) any = true;
    for (;;) {
      const c = s[i];
      if (c === "#" || c === ".") {
        i++;
        if (ident() === undefined) return `a ${c === "#" ? "#id" : ".class"} must be a plain name (no escapes)`;
        any = true;
      } else if (c === "[") {
        i++;
        ws();
        const attr = ident()?.toLowerCase();
        if (attr === undefined) return "an attribute selector must name a plain attribute";
        ws();
        if (s[i] === "=" && (CSS_EQUALITY_ATTRS.has(attr) || attr.startsWith("aria-"))) {
          i++;
          ws();
          if (ident() === undefined) return `[${attr}=…] compares with a plain word (no quotes)`;
          ws();
        }
        if (s[i] !== "]") {
          return "an attribute selector may only test that an attribute is PRESENT ([name]), or compare type, role, name, aria-* or a test id with a plain word ([type=password]) — a value test could read hidden or secret values";
        }
        i++;
        any = true;
      } else if (c === ":") {
        i++;
        if (s[i] === ":") return "pseudo-elements (::name) are not selectors of elements";
        const name = ident()?.toLowerCase();
        if (name === undefined) return "a pseudo-class must be a plain name";
        if (CSS_PLAIN_PSEUDOS.has(name)) { any = true; continue; }
        if (s[i] !== "(") return `:${name} is not allowed (structure and the states state() shows only)`;
        i++;
        if (CSS_NTH_PSEUDOS.has(name)) {
          const m = /^\s*(odd|even|[+-]?\d*n(\s*[+-]\s*\d+)?|[+-]?\d+)\s*\)/i.exec(s.slice(i));
          if (m === null) return `:${name}() takes an+b, odd or even`;
          i += m[0].length;
          any = true;
          continue;
        }
        if (!CSS_NESTING_PSEUDOS.has(name)) return `:${name}() is not allowed`;
        if (depth > 4) return "selectors are nested too deeply";
        ws();
        const inner = list(depth + 1, name === "has");
        if (inner !== undefined) return inner;
        ws();
        if (s[i] !== ")") return `:${name}( is not closed`;
        i++;
        any = true;
      } else break;
    }
    return any ? undefined : `unexpected "${s[i] ?? "end"}" — only tags, #id, .class, [attr], combinators and structural pseudo-classes are allowed`;
  };
  // A complex selector: compounds joined by combinators (a relative one, inside :has(), may start with one).
  const complex = (depth: number, relative: boolean): string | undefined => {
    ws();
    if (relative && (s[i] === ">" || s[i] === "+" || s[i] === "~")) { i++; ws(); }
    let r = compound(depth);
    if (r !== undefined) return r;
    for (;;) {
      const hadWs = ws();
      const c = s[i];
      if (c === ">" || c === "+" || c === "~") { i++; ws(); } else if (!hadWs || c === undefined || c === "," || c === ")") break;
      r = compound(depth);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  const list = (depth: number, relative: boolean): string | undefined => {
    for (;;) {
      const r = complex(depth, relative);
      if (r !== undefined) return r;
      ws();
      if (s[i] !== ",") return undefined;
      i++;
    }
  };
  if (/["'\\|]/.test(s)) return "quotes, backslash escapes and namespaces are not allowed";
  const r = list(0, false);
  if (r !== undefined) return r;
  ws();
  if (i < s.length) return `unexpected "${s[i]}" — only tags, #id, .class, [attr], combinators and structural pseudo-classes are allowed`;
  return undefined;
}
