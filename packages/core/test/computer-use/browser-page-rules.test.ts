// The page runtime's SAFETY RULES and REDACTION as pure functions (`page-runtime/rules.ts`, `redact.ts`) — the floors
// the runtime applies in the page, in the ordinary core test run with no browser. (The DOM glue that reads these facts
// off real elements is covered by `e2e:browser` against Chromium.)
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactText, redactUrl, REDACTED } from "../../src/computer-use/browser/page-runtime/redact";
import {
  classifyTarget, FILE_CHOOSER, isPaymentHost, isSecureField, isTextEntry, nativePicker, pickerAdvice, pickerValueHint,
} from "../../src/computer-use/browser/page-runtime/rules";

describe("the secure-field floor", () => {
  test("passwords, secure autocomplete tokens, and every text entry in a payment provider's frame", () => {
    expect(isSecureField({ tag: "INPUT", type: "password" }, false)).toBe(true);
    expect(isSecureField({ tag: "INPUT", type: "PASSWORD" }, false)).toBe(true);
    for (const ac of ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "section-pay billing cc-number"]) {
      expect(isSecureField({ tag: "INPUT", type: "text", autocomplete: ac }, false)).toBe(true);
    }
    expect(isSecureField({ tag: "INPUT", type: "text", autocomplete: "email" }, false)).toBe(false);
    expect(isSecureField({ tag: "INPUT", type: "text" }, true)).toBe(true);
    expect(isSecureField({ tag: "TEXTAREA" }, true)).toBe(true);
    expect(isSecureField({ tag: "DIV", contentEditable: true }, true)).toBe(true);
    // A payment frame's button or check box is no text entry.
    expect(isSecureField({ tag: "INPUT", type: "checkbox" }, true)).toBe(false);
    expect(isSecureField({ tag: "BUTTON" }, true)).toBe(false);
  });

  test("payment hosts match themselves and their subdomains, nothing else", () => {
    expect(isPaymentHost("js.stripe.com")).toBe(true);
    expect(isPaymentHost("STRIPE.COM")).toBe(true);
    expect(isPaymentHost("checkout.adyen.com")).toBe(true);
    expect(isPaymentHost("notstripe.com")).toBe(false);
    expect(isPaymentHost("stripe.com.evil.example")).toBe(false);
  });

  test("text entry: text-like inputs, textareas, editable regions; not buttons, check boxes, colors or files", () => {
    for (const type of ["", "text", "search", "email", "url", "tel", "number", "password"]) expect(isTextEntry({ tag: "INPUT", type })).toBe(true);
    for (const type of ["checkbox", "radio", "button", "submit", "color", "file", "range"]) expect(isTextEntry({ tag: "INPUT", type })).toBe(false);
    expect(isTextEntry({ tag: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tag: "DIV", contentEditable: true })).toBe(true);
    expect(isTextEntry({ tag: "DIV" })).toBe(false);
  });
});

describe("native pickers", () => {
  test("a select (any), the date/time/color inputs and a file input open a native window; nothing else does", () => {
    expect(nativePicker({ tag: "SELECT" })).toBe("a pop-up menu");
    expect(nativePicker({ tag: "INPUT", type: "date" })).toBe("a date picker");
    expect(nativePicker({ tag: "INPUT", type: "time" })).toBe("a time picker");
    expect(nativePicker({ tag: "INPUT", type: "datetime-local" })).toBe("a datetime-local picker");
    expect(nativePicker({ tag: "INPUT", type: "month" })).toBe("a month picker");
    expect(nativePicker({ tag: "INPUT", type: "week" })).toBe("a week picker");
    expect(nativePicker({ tag: "INPUT", type: "Color" })).toBe("a color picker");
    expect(nativePicker({ tag: "INPUT", type: "file" })).toBe(FILE_CHOOSER);
    for (const type of ["text", "checkbox", "range", "button", ""]) expect(nativePicker({ tag: "INPUT", type })).toBeUndefined();
    expect(nativePicker({ tag: "BUTTON" })).toBeUndefined();
    expect(pickerAdvice(FILE_CHOOSER)).toBe("upload(ref, paths)");
    expect(pickerAdvice("a date picker")).toBe("setValue(ref, value)");
  });

  test("each picker input's value shape", () => {
    expect(pickerValueHint("date")).toBe("YYYY-MM-DD");
    expect(pickerValueHint("time")).toBe("HH:MM");
    expect(pickerValueHint("datetime-local")).toBe("YYYY-MM-DDTHH:MM");
    expect(pickerValueHint("month")).toBe("YYYY-MM");
    expect(pickerValueHint("week")).toBe("YYYY-W##");
    expect(pickerValueHint("color")).toBe("#rrggbb");
    expect(pickerValueHint("text")).toBeUndefined();
  });
});

describe("the keyboard target's class (fails closed)", () => {
  const o = { inPaymentFrame: false };
  test("no element is unknown; the body is a non-editable ok; an iframe is followed", () => {
    expect(classifyTarget(null, o)).toEqual({ kind: "unknown" });
    expect(classifyTarget(undefined, o)).toEqual({ kind: "unknown" });
    expect(classifyTarget({ tag: "BODY" }, { ...o, isBody: true })).toEqual({ kind: "ok", editable: false });
    expect(classifyTarget({ tag: "IFRAME" }, o)).toEqual({ kind: "frame" });
  });

  test("secure beats everything; a picker is refused; a text field is editable, a button is not", () => {
    expect(classifyTarget({ tag: "INPUT", type: "password" }, o)).toEqual({ kind: "secure" });
    expect(classifyTarget({ tag: "INPUT", type: "text" }, { inPaymentFrame: true })).toEqual({ kind: "secure" });
    expect(classifyTarget({ tag: "SELECT" }, o)).toEqual({ kind: "picker", what: "a pop-up menu" });
    expect(classifyTarget({ tag: "INPUT", type: "date" }, o)).toEqual({ kind: "picker", what: "a date picker" });
    expect(classifyTarget({ tag: "INPUT", type: "file" }, o)).toEqual({ kind: "picker", what: FILE_CHOOSER });
    expect(classifyTarget({ tag: "INPUT", type: "text" }, o)).toEqual({ kind: "ok", editable: true });
    expect(classifyTarget({ tag: "DIV", contentEditable: true }, o)).toEqual({ kind: "ok", editable: true });
    expect(classifyTarget({ tag: "BUTTON" }, o)).toEqual({ kind: "ok", editable: false });
  });
});

describe("redaction", () => {
  test("token patterns in any text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    expect(redactText(`token: ${jwt} done`)).toBe(`token: ${REDACTED} done`);
    expect(redactText("key sk-live0123456789abcdefABCDEF")).toBe(`key ${REDACTED}`);
    expect(redactText("ghp_0123456789abcdefghijABCDEFGHIJ")).toBe(REDACTED);
    expect(redactText("xoxb-1234567890-abcdefghij")).toBe(REDACTED);
    expect(redactText("AKIAABCDEFGHIJKLMNOP")).toBe(REDACTED);
    expect(redactText("sha 0123456789abcdef0123456789abcdef01")).toBe(`sha ${REDACTED}`);
    expect(redactText("aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3")).toBe(REDACTED);
  });

  test("ordinary text is left alone: words, sentences, long lower-case names, paths", () => {
    for (const s of ["Your cart has 3 items", "internationalizationofsomethinglong", "/usr/local/share/applications/thing/data/x", "Order #12345 shipped"]) {
      expect(redactText(s)).toBe(s);
    }
  });

  test("a URL's credential parameters and OAuth fragments, by key (any case, encoded); the rest kept", () => {
    expect(redactUrl("https://app.example/cb?code=abc123&state=xyz")).toBe(`https://app.example/cb?code=${REDACTED}&state=xyz`);
    expect(redactUrl("https://app.example/#access_token=abc&token_type=bearer&expires_in=3600"))
      .toBe(`https://app.example/#access_token=${REDACTED}&token_type=bearer&expires_in=3600`);
    expect(redactUrl("https://x.example/?Token=1&API_KEY=2&sig=3&X-Amz-Signature=4&q=hello"))
      .toBe(`https://x.example/?Token=${REDACTED}&API_KEY=${REDACTED}&sig=${REDACTED}&X-Amz-Signature=${REDACTED}&q=hello`);
    expect(redactUrl("https://x.example/?%74oken=secret")).toBe(`https://x.example/?%74oken=${REDACTED}`);
    expect(redactUrl("https://x.example/page#section-2")).toBe("https://x.example/page#section-2");
    expect(redactUrl("https://x.example/a/b?q=shoes&page=2")).toBe("https://x.example/a/b?q=shoes&page=2");
    expect(redactUrl("https://x.example/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig")).toBe(`https://x.example/reset/${REDACTED}`);
    // An empty value stays (nothing to hide).
    expect(redactUrl("https://x.example/?code=")).toBe("https://x.example/?code=");
  });
});

describe("the page runtime builds under its own DOM program", () => {
  test("core's program has no DOM library: the runtime's entry is excluded and nothing in src references lib dom", () => {
    const core = join(import.meta.dir, "..", "..");
    const tsconfig = readFileSync(join(core, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain("src/computer-use/browser/page-runtime/main.ts");
    const runtime = JSON.parse(readFileSync(join(core, "src", "computer-use", "browser", "page-runtime", "tsconfig.json"), "utf8")) as { compilerOptions: { lib: string[] } };
    expect(runtime.compilerOptions.lib).toContain("DOM");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (p.endsWith(".ts") && /\/\/\/\s*<reference\s+lib="dom"/i.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(core, "src"));
    expect(offenders).toEqual([]);
  });
});
