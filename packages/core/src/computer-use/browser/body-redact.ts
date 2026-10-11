// ComputerV2 Phase 3 — a response body as the model may read it (`networkBody(id)`). Request bodies never cross at all
// (the allowlist keeps none); a RESPONSE body does only on request, cut by the transport at 1 MiB and here at the
// caller's `maxChars`, and redacted: JSON values under a secret-looking key, the same keys in form or `key: value` text,
// then the page runtime's token rule (JWTs, `sk-`, `ghp_`, long hex/base64 runs) over everything.
import { redactText } from "./page-runtime/redact";

/** Keys whose value is a secret wherever it appears. */
export const SECRET_KEY = /(^|[-_.])(pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|auth(orization)?|session([-_]?id)?|sid|cookie|credentials?|private[-_]?key|signature|otp|ssn|card[-_]?number|cc[-_]?num(ber)?|cvv|cvc|pin)($|[-_.])|(token|secret|password|passwd|apikey|api_key|credentials?|signature|cookie)$/i;

export const BODY_DEFAULT_CHARS = 64 * 1024;
export const BODY_MAX_CHARS = 256 * 1024;

const TEXT_MIME = /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson|ld\+json|manifest\+json)|image\/svg\+xml)/i;

/** Is this MIME type text the model can read? */
export function isTextMime(mime: string | undefined): boolean {
  return mime !== undefined && TEXT_MIME.test(mime.trim());
}

function redactJson(v: unknown, depth = 0): unknown {
  if (depth > 64) return "<redacted>";
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && x !== null ? "<redacted>" : redactJson(x, depth + 1);
    }
    return out;
  }
  if (typeof v === "string") return redactText(v);
  return v;
}

/** Form-urlencoded pairs, `"key": "value"` and `key: value` / `key=value` text: a secret key's value redacted. */
function redactKeyedText(text: string): string {
  return text
    // "key": "value" (JSON-ish text that did not parse)
    .replace(/("([^"\\]{1,80})"\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (m, head: string, key: string) => (SECRET_KEY.test(key) ? `${head}"<redacted>"` : m))
    // key=value&… (a form body or a query)
    .replace(/(^|[?&\s])([\w.[\]-]{1,80})=([^&\s]*)/g, (m, lead: string, key: string) => (SECRET_KEY.test(key) ? `${lead}${key}=<redacted>` : m))
    // key: value (headers-like or YAML-like lines)
    .replace(/^(\s*([\w.-]{1,80})\s*:\s*)(.+)$/gm, (m, head: string, key: string) => (SECRET_KEY.test(key) ? `${head}<redacted>` : m));
}

/** The body as text, redacted and cut at `maxChars` (with a marker saying so). */
export function redactBody(body: string, mime: string | undefined, maxChars: number): { text: string; cut: boolean } {
  let text: string;
  const trimmed = body.trimStart();
  const jsonish = (mime !== undefined && /json/i.test(mime)) || trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  let ok = false;
  if (jsonish && body.length <= 2 * 1024 * 1024) {
    try { parsed = JSON.parse(body); ok = true; } catch { ok = false; }
  }
  if (ok) text = JSON.stringify(redactJson(parsed), null, 2);
  else text = redactText(redactKeyedText(body));
  if (text.length <= maxChars) return { text, cut: false };
  return { text: text.slice(0, maxChars), cut: true };
}
