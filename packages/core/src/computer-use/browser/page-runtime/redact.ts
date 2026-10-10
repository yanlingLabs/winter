// ComputerV2 Phase 2 — REDACTION of secret-looking text, shared by the page runtime (in the page) and the daemon
// (headers, `url()`, tab lists, errors). Pure: no DOM, no I/O.
//
//   - token patterns in any text: JWTs (`eyJ…`), `sk-…` keys, GitHub / Slack / AWS tokens, runs of 32+ hex, and
//     base64-looking runs of 32+ characters that mix digits, upper and lower case;
//   - in a URL, also the values of credential-bearing query parameters and fragment fields (`?code=`, `?token=`,
//     `#access_token=`, …) — an OAuth redirect must never print its token.

export const REDACTED = "<redacted>";

const TOKEN_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[0-9a-fA-F]{32,}\b/g,
];
const B64_RUN = /[A-Za-z0-9+/_=-]{32,}/g;

function tokenish(run: string): boolean {
  if (!/[0-9]/.test(run) || !/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
  if ((run.match(/\//g) ?? []).length > 2) return false;
  if ((run.match(/-/g) ?? []).length > 3 && !/[0-9]{3,}/.test(run)) return false;
  return true;
}

/** `s` with every token-looking run replaced by `<redacted>`. */
export function redactText(s: string): string {
  let out = s;
  for (const p of TOKEN_PATTERNS) out = out.replace(new RegExp(p.source, p.flags), REDACTED);
  return out.replace(new RegExp(B64_RUN.source, B64_RUN.flags), (m) => (tokenish(m) ? REDACTED : m));
}

export function looksSecret(s: string): boolean { return redactText(s) !== s; }

/** Query or fragment keys whose values are credentials. */
const SECRET_KEYS = /^(?:code|token|access_token|id_token|refresh_token|auth|authorization|client_secret|secret|password|passwd|pwd|api_key|apikey|key|sig|signature|session|sessionid|session_id|sid|ticket|assertion|saml(?:request|response)|oauth_token|oauth_verifier|x-amz-signature|x-amz-credential|x-amz-security-token|jwt)$/i;

function redactPairs(part: string): string {
  return part.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) return pair;
    let key = pair.slice(0, eq);
    try { key = decodeURIComponent(key); } catch { /* keep as written */ }
    return SECRET_KEYS.test(key) && pair.length > eq + 1 ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
  }).join("&");
}

/** A URL with its credential-bearing query and fragment values, and any token-looking run, redacted. */
export function redactUrl(url: string): string {
  let base = url;
  let fragment = "";
  const hash = base.indexOf("#");
  if (hash >= 0) { fragment = base.slice(hash + 1); base = base.slice(0, hash); }
  const q = base.indexOf("?");
  if (q >= 0) base = `${base.slice(0, q)}?${redactPairs(base.slice(q + 1))}`;
  // A fragment shaped like a query (OAuth's implicit flow puts the token there).
  if (fragment.includes("=")) fragment = redactPairs(fragment);
  return redactText(fragment.length > 0 || hash >= 0 ? `${base}#${fragment}` : base);
}
