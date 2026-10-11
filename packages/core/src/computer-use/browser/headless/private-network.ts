// ComputerV2 Phase 4 — the headless browser stays off the LOCAL NETWORK (the user's ruling: this Mac's own servers are
// allowed, the LAN is refused, decided by the address as written). Winter's headless browser is a Winter-owned Chromium
// the model drives with no one watching: pointed at the LAN it would be an SSRF pivot into the user's network (a
// router's admin page, a NAS, a printer), and on macOS a page reaching the local network makes the system ask about
// Local Network access — a prompt in front of the user.
//
// The daemon applies this rule to the model's own URL before anything loads, and to every committed top-frame
// navigation before anything of it is read or acted on. Winter Headless applies the SAME rule inside the browser to
// every request — a navigation, a redirect, a sub-resource, a fetch — and cancels a refused one before any socket opens
// (its Swift copy, `HeadlessNetworkRule.swift`; one fixture, `test/computer-use/fixtures/headless-private-network.json`,
// holds the two equal).
//
// LEXICAL, on purpose: nothing here resolves a name. A public name that resolves to a private address is NOT caught
// (the residual: DNS rebinding, or a public name pointed at the LAN). A name only the LAN can resolve is refused: the
// mDNS `.local`, the private-use `.home.arpa` and `.internal`, the de-facto `.lan`, `.home`, `.corp`, `.intranet`,
// `.private` and `.localdomain`, and a single-label name ("router", "nas").

/** The private-network sentence the model reads. */
export const HEADLESS_LAN_REFUSAL = "Winter's headless browser doesn't open pages on the local network (a private, link-local or .local address) — only public sites and this Mac's own servers (localhost)";

/** Name suffixes only a local network resolves. Winter Headless also maps every name under them to "not found" in its
 *  browser's own resolver (`--host-resolver-rules`, `HeadlessNetworkRule.hostResolverRulesSwitch`), so nothing it runs
 *  — a WebSocket included — can resolve one. */
export const LOCAL_NAME_SUFFIXES: readonly string[] = [".local", ".home.arpa", ".internal", ".lan", ".home", ".corp", ".intranet", ".private", ".localdomain"];

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
  return isPrivateNetworkHost(host);
}

/** The rule on a host as a URL spells it (an IPv6 address in brackets). */
export function isPrivateNetworkHost(rawHost: string): boolean {
  let host = rawHost.toLowerCase();
  if (host.length === 0) return false;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) {
    const bytes = ipv6Bytes(host.slice(1, -1));
    return bytes === undefined ? true : privateIpv6(bytes);
  }
  const v4 = ipv4(host);
  if (v4 !== undefined) return privateIpv4(v4);
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (LOCAL_NAME_SUFFIXES.some((s) => host.endsWith(s))) return true;
  // A single label resolves only through the LAN's own search domains.
  return !host.includes(".");
}

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : undefined;
}

function privateIpv4([a, b]: readonly number[]): boolean {
  if (a === undefined || b === undefined) return true;
  if (a === 127) return false; // this Mac (loopback)
  return a === 10 // RFC 1918
    || (a === 172 && b >= 16 && b <= 31) // RFC 1918
    || (a === 192 && b === 168) // RFC 1918
    || (a === 169 && b === 254) // link-local
    || (a === 100 && b >= 64 && b <= 127) // CGNAT (RFC 6598)
    || a === 0 // "this network"
    || a >= 224; // multicast, reserved, broadcast
}

/** An IPv6 address (no brackets, an optional zone) as its 16 bytes; undefined when it is not one. */
export function ipv6Bytes(raw: string): number[] | undefined {
  const text = raw.split("%")[0]!.toLowerCase();
  if (text.length === 0 || /[^0-9a-f:.]/.test(text)) return undefined;
  // A trailing dotted IPv4 is its last two groups.
  let groupsText = text;
  let tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const v4 = ipv4(dotted[2]!);
    if (v4 === undefined) return undefined;
    groupsText = `${dotted[1]!}0:0`;
    tail = v4;
  }
  const halves = groupsText.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part.length === 0) return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === undefined || rest === undefined) return undefined;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function privateIpv6(b: readonly number[]): boolean {
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  const v4 = (): number[] => b.slice(12, 16);
  if (zero(0, 15) && b[15] === 1) return false; // ::1, this Mac (loopback)
  if (zero(0, 16)) return true; // :: (unspecified)
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return privateIpv4(v4()); // ::ffff:a.b.c.d (mapped)
  if (zero(0, 12)) return privateIpv4(v4()); // ::a.b.c.d (IPv4-compatible)
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return privateIpv4(v4()); // ::ffff:0:a.b.c.d (translated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return privateIpv4(v4()); // 64:ff9b::/96 (NAT64)
  const first = (b[0]! << 8) | b[1]!;
  return (first & 0xfe00) === 0xfc00 // unique local (fc00::/7)
    || (first & 0xffc0) === 0xfe80 // link-local (fe80::/10)
    || (first & 0xffc0) === 0xfec0 // site-local, deprecated (fec0::/10)
    || (first & 0xff00) === 0xff00; // multicast
}
