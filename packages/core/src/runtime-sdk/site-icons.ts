// The `tool_result.siteIcons` hand-off: the icon each web tool already KNOWS for the sites it read or
// found, carried to clients beside the result and never in the model-visible text.
//
// Two producers, one consumer:
//
//   * The daemon's own `Search` (Exa `/answer`, `agent/tools/search.ts`) learns each citation's
//     `favicon`. Its `run` has the session but not the tool-use id — an in-process MCP call carries
//     neither (`capabilities/server.ts`'s P8b-36 header) — so it records `page url → icon url` for the
//     session (`noteKnownSiteIcons`). The PostToolUse hook matched on the Search tool (`hooks.ts`) has
//     the tool-use id AND the result text, and pairs them: every recorded url that appears in the text,
//     in the order it appears (`siteIconsInText`), is attached under that id (`attachSiteIcons`). A url
//     → icon pair is a FACT about the page, not about one call, so a pair left over from an earlier
//     call can only ever be right.
//   * The Winter runtime's built-in `WebFetch`/`WebSearch`, on a runtime that reports icons, put them on
//     the host-facing `tool_result` block as `winter_site_icons` (`siteIconsFromRuntimeBlock`). Read by
//     the projector directly; an older runtime sends nothing and nothing changes.
//
// The projector (`projector/conversation.ts`'s `toolResults`) is the one consumer: it takes the
// attached list for the call (destructive, like `diff-attach.ts`'s `takeFileDiff`, so a replayed
// result never re-attaches), merges the block's own, and stamps the event. Everything is bounded and
// in memory; `clearSiteIcons` runs where `diff-attach.ts`'s `clearSession` does.
import { SITE_ICONS_MAX, SITE_ICON_URL_MAX_LENGTH, type SiteIcon } from "@yanlinglabs/winter-protocol";

/** How many page → icon pairs one session remembers (oldest first out). */
const KNOWN_PER_SESSION = 200;
/** How many not-yet-projected per-call attachments one session holds (oldest first out). */
export const ATTACHED_PER_SESSION = 50;

const known = new Map<string, Map<string, string>>();
const attached = new Map<string, Map<string, SiteIcon[]>>();

/** A url the wire may carry (`SiteIconUrl` in protocol/events.ts): https, parseable, re-serialised by
 *  `URL` (so printable ASCII), within the length cap. Undefined for anything else. */
export function siteIconUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > SITE_ICON_URL_MAX_LENGTH) return undefined;
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0 || parsed.username !== "" || parsed.password !== "") return undefined;
  const href = parsed.href;
  return href.length <= SITE_ICON_URL_MAX_LENGTH && /^https:\/\/[!-~]+$/.test(href) ? href : undefined;
}

/** A clean list: each entry's two urls checked (`siteIconUrl`), one entry per page url (first wins),
 *  at most `SITE_ICONS_MAX`. Undefined when nothing survives — the field is then left off. */
export function cleanSiteIcons(entries: Iterable<{ url: unknown; iconUrl: unknown }>): SiteIcon[] | undefined {
  const out: SiteIcon[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (out.length >= SITE_ICONS_MAX) break;
    const url = siteIconUrl(e.url);
    const iconUrl = siteIconUrl(e.iconUrl);
    if (url === undefined || iconUrl === undefined || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, iconUrl });
  }
  return out.length > 0 ? out : undefined;
}

/** Search's side: remember what Exa said each page's icon is, for this session. */
export function noteKnownSiteIcons(sessionId: string, entries: Iterable<{ url: unknown; iconUrl: unknown }>): void {
  let bySession = known.get(sessionId);
  for (const e of entries) {
    // Keyed by the url EXACTLY as the tool rendered it (that is what `siteIconsInText` finds), but
    // only once the pair is known to be sendable.
    if (typeof e.url !== "string" || siteIconUrl(e.url) === undefined) continue;
    const iconUrl = siteIconUrl(e.iconUrl);
    if (iconUrl === undefined) continue;
    if (bySession === undefined) { bySession = new Map(); known.set(sessionId, bySession); }
    bySession.delete(e.url);
    bySession.set(e.url, iconUrl);
    while (bySession.size > KNOWN_PER_SESSION) bySession.delete(bySession.keys().next().value as string);
  }
}

/** The remembered pairs whose page url appears in `text`, in order of first appearance. */
export function siteIconsInText(sessionId: string, text: string): SiteIcon[] | undefined {
  const bySession = known.get(sessionId);
  if (bySession === undefined || text.length === 0) return undefined;
  const found: Array<{ at: number; url: string; iconUrl: string }> = [];
  for (const [url, iconUrl] of bySession) {
    const at = urlIndexIn(text, url);
    if (at >= 0) found.push({ at, url, iconUrl });
  }
  found.sort((a, b) => a.at - b.at);
  return cleanSiteIcons(found);
}

/** Where `url` occurs in `text` as a whole url — not as the head of a longer one (`…/x` inside `…/xy`). */
function urlIndexIn(text: string, url: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf(url, from);
    if (at < 0) return -1;
    const next = text.charAt(at + url.length);
    if (next === "" || /[\s)\]>"'<,]/.test(next)) return at;
    from = at + 1;
  }
}

export function attachSiteIcons(sessionId: string, toolUseId: string, icons: SiteIcon[]): void {
  let bySession = attached.get(sessionId);
  if (bySession === undefined) { bySession = new Map(); attached.set(sessionId, bySession); }
  bySession.delete(toolUseId);
  bySession.set(toolUseId, icons);
  // An attachment whose result is never projected (an interrupted turn) would otherwise linger until
  // the session ends: the oldest goes first past the cap.
  while (bySession.size > ATTACHED_PER_SESSION) bySession.delete(bySession.keys().next().value as string);
}

export function takeSiteIcons(sessionId: string, toolUseId: string): SiteIcon[] | undefined {
  const bySession = attached.get(sessionId);
  if (bySession === undefined) return undefined;
  const icons = bySession.get(toolUseId);
  if (icons !== undefined) bySession.delete(toolUseId);
  if (bySession.size === 0) attached.delete(sessionId);
  return icons;
}

/** The runtime's own report on a host-facing `tool_result` block — `winter_site_icons:
 *  [{url, icon_url}]` (Winter agent SDK, WebFetch/WebSearch). Tolerant: anything malformed is dropped. */
export function siteIconsFromRuntimeBlock(block: Record<string, unknown>): SiteIcon[] | undefined {
  const raw = block["winter_site_icons"];
  if (!Array.isArray(raw)) return undefined;
  return cleanSiteIcons(raw.flatMap((e) => (e !== null && typeof e === "object"
    ? [{ url: (e as Record<string, unknown>)["url"], iconUrl: (e as Record<string, unknown>)["icon_url"] }]
    : [])));
}

/** What a `tool_result` event carries: the attached list first, then the block's own, deduplicated. */
export function siteIconsForResult(sessionId: string, toolUseId: string, block: Record<string, unknown>): SiteIcon[] | undefined {
  const fromDaemon = takeSiteIcons(sessionId, toolUseId) ?? [];
  const fromRuntime = siteIconsFromRuntimeBlock(block) ?? [];
  if (fromDaemon.length === 0 && fromRuntime.length === 0) return undefined;
  return cleanSiteIcons([...fromDaemon, ...fromRuntime]);
}

export function clearSiteIcons(sessionId: string): void {
  known.delete(sessionId);
  attached.delete(sessionId);
}

/** Test-only: sessions holding any site-icon state. */
export function siteIconSessions(): number { return new Set([...known.keys(), ...attached.keys()]).size; }
