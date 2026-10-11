// ComputerV2 Phase 4 (D4) — the headless browser stays off the LOCAL NETWORK. Winter's headless browser is a
// Winter-owned Chromium the model drives with no one watching: pointed at the LAN it would be an SSRF pivot into the
// user's network (a router's admin page, a NAS, a printer), and on macOS a page reaching the local network makes the
// system ask about Local Network access — a prompt attributed to Winter, in front of the user. So a top-level page on
// the LAN is refused: the model's own URL before anything loads, and every committed top-frame navigation (a redirect,
// a page's own script) before anything of it is read or acted on. This Mac itself is allowed (a dev server).
//
// LEXICAL, on purpose: nothing here resolves a name. A public name that resolves to a private address is not caught
// here (Chromium's own Local Network Access check refuses a public page's sub-requests into the LAN, and headless
// raises no prompt for it); a name only the LAN can resolve is refused when it can only be local: `.local` (mDNS),
// `.home.arpa`, and a single-label name ("router", "nas").

/** The private-network sentence the model reads. */
export const HEADLESS_LAN_REFUSAL = "Winter's headless browser doesn't open pages on the local network (a private, link-local or .local address) — only public sites and this Mac's own servers (localhost)";

/** Is this URL's host on the local network (and not this Mac itself)? Non-URLs and non-http(s) URLs answer false — the
 *  scheme rule is `checkTabUrl`'s. */
export function isPrivateNetworkUrl(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.length === 0) return false;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) return privateIpv6(host.slice(1, -1));
  const v4 = ipv4(host);
  if (v4 !== undefined) return privateIpv4(v4);
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".home.arpa")) return true;
  // A single label resolves only through the LAN's own search domains.
  return !host.includes(".");
}

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : undefined;
}

function privateIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 127) return false; // this Mac (loopback)
  return a === 10 // RFC 1918
    || (a === 172 && b >= 16 && b <= 31) // RFC 1918
    || (a === 192 && b === 168) // RFC 1918
    || (a === 169 && b === 254) // link-local
    || (a === 100 && b >= 64 && b <= 127) // CGNAT (RFC 6598)
    || a === 0 // "this network"
    || a >= 224; // multicast, reserved, broadcast
}

function privateIpv6(raw: string): boolean {
  const host = raw.split("%")[0]!.toLowerCase();
  if (host === "::1") return false; // this Mac (loopback)
  if (host === "::") return true;
  // An IPv4-mapped or -compatible address is judged as its IPv4 address.
  const mapped = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped !== null) {
    const v4 = ipv4(mapped[1]!);
    return v4 === undefined ? true : privateIpv4(v4);
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex !== null) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return privateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return false;
  return (first & 0xfe00) === 0xfc00 // unique local (fc00::/7)
    || (first & 0xffc0) === 0xfe80 // link-local (fe80::/10)
    || (first & 0xff00) === 0xff00; // multicast
}
