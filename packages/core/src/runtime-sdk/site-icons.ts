// The `tool_result.siteIcons` hand-off: the icon each web tool already KNOWS for the sites it read or
// found, carried to clients beside the result and never in the model-visible text.
//
// ONE producer now: the Winter runtime's built-in web tools — `WebFetch` (the page's own icon),
// `WebSearch` and `Search` (each Exa result's / citation's `favicon`) — put them on the HOST-facing
// `tool_result` block as `winter_site_icons: [{url, icon_url}]` (`siteIconsFromRuntimeBlock`). A runtime
// that reports none sends nothing and nothing changes.
//
// (Until 2026-10-01 a SECOND producer lived here: the daemon's own `Search` recorded its citations'
// icons per session and a PostToolUse hook paired them with the call id. `Search` is the agent SDK's
// built-in now and reports its icons the runtime's way, so that half — and its per-session state —
// is gone.)
//
// The projector (`projector/conversation.ts`'s `toolResults`) is the one consumer: it reads the block's
// own list and stamps the event. Stateless and bounded.
import { SITE_ICONS_MAX, SITE_ICON_URL_MAX_LENGTH, type SiteIcon } from "@yanlinglabs/winter-protocol";

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

/** The runtime's own report on a host-facing `tool_result` block — `winter_site_icons:
 *  [{url, icon_url}]` (Winter agent SDK, WebFetch/WebSearch/Search). Tolerant: anything malformed is dropped. */
export function siteIconsFromRuntimeBlock(block: Record<string, unknown>): SiteIcon[] | undefined {
  const raw = block["winter_site_icons"];
  if (!Array.isArray(raw)) return undefined;
  return cleanSiteIcons(raw.flatMap((e) => (e !== null && typeof e === "object"
    ? [{ url: (e as Record<string, unknown>)["url"], iconUrl: (e as Record<string, unknown>)["icon_url"] }]
    : [])));
}

/** What a `tool_result` event carries: the block's own list, cleaned. (The signature keeps the session
 *  and call id the retired daemon-side producer keyed on, so the projector's one call site is unchanged.) */
export function siteIconsForResult(_sessionId: string, _toolUseId: string, block: Record<string, unknown>): SiteIcon[] | undefined {
  return siteIconsFromRuntimeBlock(block);
}
