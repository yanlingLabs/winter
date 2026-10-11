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
