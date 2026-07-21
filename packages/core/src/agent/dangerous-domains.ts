/**
 * SP-approvals Task 10 (user addition 2026-07-21, spec §7 "Web tools"): web_fetch is free by
 * default like every other tool now, but keeps ONE safety floor no policy can silence — a fetch
 * whose target host is a known/likely exfiltration or tunnel-provider endpoint still needs a
 * human's yes. This is the SHIPPED half of the "effective dangerous set" the engine's pre-exec
 * check consults (`effective = SHIPPED_DANGEROUS_DOMAINS ∪ settings.permissions.dangerousDomains.
 * added` — see engine.ts's webFetchGate); the shipped list is an in-code constant, immutable by
 * construction ("the user can remove only the ones he added" — deleting an entry from
 * settings.json can only ever shrink the USER half, never this one).
 *
 * Curated for the REAL threat this floor exists for: a page the model was asked to summarize (or
 * a prompt-injected instruction hidden in one) telling it to `web_fetch` a secret/credential/file
 * preview OUT to somewhere the human never sees — so every entry below is a domain whose entire
 * business model is "accept arbitrary bytes from anyone, no auth, and make them reachable again"
 * (a paste host), "accept an arbitrary file upload, no auth" (a one-shot file host), "log every
 * byte of every request sent to a URL you control" (a request/interaction collector), or "expose a
 * local port to the public internet" (a tunnel provider) — the four families spec §7 names
 * explicitly. Plain content hosts (docs sites, GitHub, npm, etc.) are deliberately NOT here even
 * though a determined exfiltrator could technically encode data into e.g. a GitHub Gist filename —
 * v1's list targets the LOW-effort, zero-auth, purpose-built dead-drops, not "anything writable on
 * the internet" (that would just make web_fetch ask on every domain, defeating "free by default").
 *
 * One rationale comment per entry, reviewed (task-10-brief.md's own instruction: "implementer
 * curates ~15-25 with rationale, reviewer audits"). KNOWN LIMIT (documented, accepted v1, spec §7):
 * this is a domain list — a raw IP, a redirect hop through an allowed domain into a private one
 * (SSRF is separately guarded in tools/web.ts's `ssrfGuard`, a DIFFERENT concern), or a brand-new
 * paste/tunnel service not yet on this list all evade it. Matching is suffix-based (see
 * `dangerousDomainMatch` below) so a subdomain of any entry is covered without listing it
 * separately (e.g. `raw.pastebin.com` matches the `pastebin.com` entry).
 */
export const SHIPPED_DANGEROUS_DOMAINS: readonly string[] = [
  "pastebin.com", // the original anonymous paste host — classic exfil dead-drop, no auth to post or read
  "paste.ee", // anonymous paste host, no auth required
  "hastebin.com", // anonymous paste host (hackmd/hastebin family), no auth required
  "dpaste.org", // anonymous paste host
  "dpaste.com", // anonymous paste host — a distinct, commonly-confused-with-dpaste.org domain
  "ix.io", // anonymous curl-friendly paste host (`curl -F 'f:1=<-' ix.io`)
  "termbin.com", // anonymous nc-friendly paste host (`cmd | nc termbin.com 9999`), no auth at all
  "transfer.sh", // anonymous one-shot file host — `curl --upload-file` exfil-by-upload, no auth
  "0x0.st", // anonymous one-shot file host, no auth, minimal logging by design
  "file.io", // anonymous one-shot file host with self-destructing links
  "temp.sh", // anonymous one-shot file host
  "gofile.io", // anonymous file host, no auth required for uploads
  "webhook.site", // request-capture collector — logs every header/byte POSTed to a throwaway URL
  "requestbin.com", // request-capture collector (the original RequestBin)
  "pipedream.net", // request-capture / low-code relay — can forward captured data on to anywhere
  "interactsh.com", // out-of-band interaction collector (security-testing tool; equally exfil-capable)
  "oastify.com", // interactsh's default public collector domain (same tool, distinct domain)
  "burpcollaborator.net", // Burp Suite's public out-of-band collaborator — logs every inbound hit
  "ngrok.io", // tunnel provider — exposes a local port/service to the public internet
  "ngrok-free.app", // ngrok's current free-tier public domain
  "ngrok.app", // ngrok's custom-domain suffix for paid tunnels
  "serveo.net", // SSH-based tunnel provider, no signup required
  "localhost.run", // SSH-based tunnel provider, no signup required
  "telebit.io", // tunnel provider
  "loca.lt", // localtunnel's public relay domain
] as const;

/**
 * `host` (already lowercase from `new URL(...).hostname` in practice, but lowercased again here
 * defensively — this function must be correct standalone, not rely on a caller's normalization)
 * matches `entry` when they're equal, or `host` ends with `.${entry}` — the SAME suffix
 * grammar `permission-rules.ts`'s `WebFetch(domain:...)` exception rules use, so a rule written
 * against a matched entry covers exactly what this function would flag. Returns the matched LIST
 * ENTRY (not the raw `host`) — for a subdomain hit that's the broader parent domain, which is
 * deliberate: the approval card's "always allow" option persists a rule scoped to the ENTRY, so
 * approving once covers the whole family, not just the one subdomain that happened to trigger it.
 * `null` when nothing in `entries` matches (including an empty list).
 *
 * Deliberately NOT a bare `.includes`/substring check — `pastebin.com.evil.com` (entry is a
 * PREFIX, not a suffix) and `evilpastebin.com` (no label-boundary dot) must both fail to match
 * `pastebin.com`; only an exact match or a `.`-anchored suffix counts.
 */
export function dangerousDomainMatch(host: string, entries: readonly string[]): string | null {
  const h = host.toLowerCase();
  for (const entry of entries) {
    const e = entry.toLowerCase();
    if (h === e || h.endsWith(`.${e}`)) return entry;
  }
  return null;
}
