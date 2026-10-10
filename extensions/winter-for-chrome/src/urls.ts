// Winter for Chrome — which pages it never attaches to, and which URLs it opens.

/** Pages Winter never drives: the browser's own, extensions' and DevTools' pages, and local or opaque documents —
 *  `file:` (the user's disk), `data:`, `blob:` and `filesystem:` (content with no site of its own). */
const BROWSER_SCHEMES = ["chrome:", "edge:", "brave:", "vivaldi:", "opera:", "arc:", "chrome-extension:", "chrome-untrusted:", "devtools:", "view-source:",
  "chrome-search:", "chrome-native:", "about:", "file:", "data:", "blob:", "filesystem:"];

/** The extension stores: a page there may act on extensions, so no debugger ever touches it. */
const STORE_PAGES: { host: string; path?: string }[] = [
  { host: "chromewebstore.google.com" },
  { host: "chrome.google.com", path: "/webstore" },
  { host: "microsoftedge.microsoft.com", path: "/addons" },
];

/**
 * Why `url` must not be attached to (one sentence for the model), or undefined when it may be. `about:blank` is the one
 * `about:` page allowed: a fresh tab starts there. A URL that does not parse is refused.
 */
export function attachRefusal(url: string | undefined, ownId: string): string | undefined {
  if (url === undefined || url === "") return undefined; // a tab still loading its first page
  if (url === "about:blank") return undefined;
  if (url.startsWith(`chrome-extension://${ownId}/`)) return "Winter does not control Winter for Chrome's own pages";
  const lower = url.toLowerCase();
  const scheme = BROWSER_SCHEMES.find((s) => lower.startsWith(s));
  if (scheme !== undefined) {
    if (["file:", "data:", "blob:", "filesystem:"].includes(scheme)) return `${scheme} pages cannot be controlled (Winter drives web pages only)`;
    return `the browser's own pages (${scheme}) cannot be controlled`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the tab's address could not be read";
  }
  const host = parsed.hostname.toLowerCase();
  for (const store of STORE_PAGES) {
    if (host === store.host && (store.path === undefined || parsed.pathname === store.path || parsed.pathname.startsWith(`${store.path}/`))) {
      return "extension store pages cannot be controlled";
    }
  }
  return undefined;
}

/** The URLs `tabs.create` opens: http(s) and about:blank only (the engine checks them first; this is the second look). */
export function openable(url: unknown): url is string {
  if (typeof url !== "string") return false;
  if (url === "about:blank") return true;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
