import { describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";
import { ssrfGuard } from "../../../src/agent/tools/web";

/**
 * The generator-INDEPENDENT safety net for `ssrfGuard` — ported from the phone side's
 * `apple/NormaChatKit/Tests/NormaChatKitTests/SSRFResolverSweepTests.swift`, which exists because the
 * same guard was bitten twice by the same failure mode: a differential is only ever as good as its
 * generator's imagination. Round 1's generator couldn't express bare authorities; round 2's couldn't
 * express non-canonical address spellings — and THAT gap was a fail-open (a URL that resolved to the
 * router). Both of those checks ask "does the code agree with a reference?"; neither asks the question
 * that actually matters, which is "does the guard refuse what the machine will actually dial?"
 *
 * This test asks the operating system. The corpus is built MECHANICALLY, by transform, never as a
 * curated list — a curated list inherits exactly the imagination gap this exists to escape — and two
 * invariants are asserted over every host the guard ALLOWS:
 *
 *   1. RESOLVER invariant: `getaddrinfo` must not resolve the host, AS WRITTEN, into private /
 *      loopback / link-local / ULA space. This is the strong one: it holds regardless of which of the
 *      several legal readings of a non-canonical spelling a given dialer happens to pick.
 *   2. DIAL-PATH invariant: the host WHATWG canonicalizes to — which is what Bun's `fetch` actually
 *      dials, verified separately (see web.ts's `ssrfGuard` comment) — must not be private either.
 *      Strictly weaker than (1) on this runtime, and kept as a distinct assertion because it is the
 *      one whose failure would be a live, reachable SSRF today rather than a latent one.
 *
 * HERMETIC BY CONSTRUCTION. `AI_NUMERICHOST` makes `getaddrinfo` a pure parser: it resolves numeric
 * literals in every spelling the dialer accepts (`3232235777`, `0xc0a80101`, `0300.0250.0.1`,
 * `::ffff:7f00:1`) and returns EAI_NONAME for anything that would need DNS. `testTheOracleIsHermetic`
 * pins that property directly, so a future change that turned this sweep into a DNS flood would fail
 * rather than silently start emitting traffic.
 */

// --- the resolver oracle (getaddrinfo, numeric-host mode) --------------------------------------

/** Darwin `netdb.h`: AI_NUMERICHOST. */
const AI_NUMERICHOST = 0x00000004;
/** Darwin `sys/socket.h`: AF_INET / AF_INET6 (30, NOT Linux's 10) and SOCK_STREAM. */
const AF_INET = 2;
const AF_INET6 = 30;
const SOCK_STREAM = 1;

/** `struct addrinfo` on 64-bit Darwin: int ai_flags(0), int ai_family(4), int ai_socktype(8),
 *  int ai_protocol(12), socklen_t ai_addrlen(16), <4 bytes padding>, char *ai_canonname(24),
 *  struct sockaddr *ai_addr(32), struct addrinfo *ai_next(40) — 48 bytes. NOTE the Darwin field
 *  order: `ai_canonname` comes BEFORE `ai_addr` (Linux has them the other way round), which is why
 *  the address pointer is at +32 here. */
const ADDRINFO_SIZE = 48;
const AI_FAMILY_OFF = 4;
const AI_ADDR_OFF = 32;
const AI_NEXT_OFF = 40;
/** `sockaddr_in.sin_addr` (after sin_len/sin_family/sin_port) and `sockaddr_in6.sin6_addr` (after
 *  sin6_len/sin6_family/sin6_port/sin6_flowinfo). */
const SIN_ADDR_OFF = 4;
const SIN6_ADDR_OFF = 8;

const libc = dlopen("libSystem.B.dylib", {
  getaddrinfo: { args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  freeaddrinfo: { args: [FFIType.ptr], returns: FFIType.void },
});

/** `bun:ffi` brands raw addresses as `Pointer`; the arithmetic above is plain numbers. */
const asPointer = (value: number | bigint): Pointer => Number(value) as unknown as Pointer;

/** Every address `host` denotes to the OS, as raw bytes — 4 for IPv4, 16 for IPv6. Empty when the
 *  host is not a numeric literal in any spelling `getaddrinfo` accepts (which, under
 *  `AI_NUMERICHOST`, is every host that would otherwise need DNS). */
function numericResolve(host: string): Uint8Array[] {
  const hints = new Uint8Array(ADDRINFO_SIZE);
  const view = new DataView(hints.buffer);
  view.setInt32(0, AI_NUMERICHOST, true);
  view.setInt32(4, 0 /* AF_UNSPEC */, true);
  view.setInt32(8, SOCK_STREAM, true);
  const outPtr = new BigUint64Array(1);
  const rc = libc.symbols.getaddrinfo(Buffer.from(`${host}\0`), null, ptr(hints), ptr(outPtr));
  if (rc !== 0) return [];

  const head = Number(outPtr[0]!);
  const out: Uint8Array[] = [];
  for (let node = head; node !== 0; node = Number(read.ptr(asPointer(node), AI_NEXT_OFF))) {
    const family = read.i32(asPointer(node), AI_FAMILY_OFF);
    const addr = asPointer(read.ptr(asPointer(node), AI_ADDR_OFF));
    if (Number(addr) === 0) continue;
    if (family === AF_INET) {
      out.push(Uint8Array.from({ length: 4 }, (_v, i) => read.u8(addr, SIN_ADDR_OFF + i)));
    } else if (family === AF_INET6) {
      out.push(Uint8Array.from({ length: 16 }, (_v, i) => read.u8(addr, SIN6_ADDR_OFF + i)));
    }
  }
  if (head !== 0) libc.symbols.freeaddrinfo(asPointer(head));
  return out;
}

/** Classifies raw address bytes as private. Deliberately an INDEPENDENT second implementation of the
 *  range table — if it called into the code under test the sweep would prove nothing. */
function isPrivateBytes(b: Uint8Array): boolean {
  if (b.length === 4) return isPrivateV4(b[0]!, b[1]!);
  if (b.length !== 16) return false;
  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateV4(b[12]!, b[13]!); // ::ffff:a.b.c.d
  }
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10
  return false;
}

function isPrivateV4(a: number, b: number): boolean {
  return a === 127 || a === 10 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function show(b: Uint8Array): string {
  return b.length === 4
    ? b.join(".")
    : Array.from({ length: 8 }, (_v, i) => ((b[i * 2]! << 8) | b[i * 2 + 1]!).toString(16)).join(":");
}

// --- the mechanical corpus --------------------------------------------------------------------

/** Every spelling here is DERIVED by a transform from a target address; none is written out by hand,
 *  so the corpus covers combinations nobody enumerated. */
function ipv4Spellings(a: number, b: number, c: number, d: number): string[] {
  const n = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const hx = (v: number) => v.toString(16);
  const oc = (v: number) => v.toString(8);
  const hi = (a << 8) | b;
  const lo = (c << 8) | d;
  return [
    `${a}.${b}.${c}.${d}`, // dotted decimal
    `${a}.${b}.${c}.${d}.`, // trailing dot (DNS root label)
    `${n}`, // 32-bit integer
    `0x${hx(n)}`, // hex integer
    `0X${hx(n).toUpperCase()}`, // upper-hex integer
    `0${oc(n)}`, // octal integer
    `${a}.${b}.${lo}`, // 3-part (last is 16-bit)
    `${a}.${((b << 16) | (c << 8) | d) >>> 0}`, // 2-part (last is 24-bit)
    `0${oc(a)}.0${oc(b)}.0${oc(c)}.0${oc(d)}`, // per-octet octal
    `0x${hx(a)}.0x${hx(b)}.0x${hx(c)}.0x${hx(d)}`, // per-octet hex
    `0x${hx(a)}.${b}.${c}.${d}`, // mixed radix (hex head)
    `0${oc(a)}.${b}.${c}.${d}`, // mixed radix (octal head, decimal tail) — the getaddrinfo-mixed shape
    `0${a}.${b}.${c}.${d}`, // leading-zero decimal (the ambiguous class)
    `00${a}.${b}.${c}.${d}`, // double leading zero (the class is unbounded)
    `[::ffff:${a}.${b}.${c}.${d}]`, // IPv4-mapped, dotted
    `[::ffff:${hx(hi)}:${hx(lo)}]`, // IPv4-mapped, hex
    `[0:0:0:0:0:ffff:${hx(hi)}:${hx(lo)}]`, // IPv4-mapped, uncompressed
  ];
}

function ipv6Spellings(literal: string): string[] {
  const out = [literal, `[${literal}]`, `[${literal.toUpperCase()}]`];
  const bytes = numericResolve(literal)[0];
  if (bytes && bytes.length === 16) {
    const groups = Array.from({ length: 8 }, (_v, i) => (bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
    out.push(`[${groups.map((g) => g.toString(16).padStart(4, "0")).join(":")}]`); // fully expanded
    out.push(`[${groups.map((g) => g.toString(16)).join(":")}]`); // expanded, no leading zeros
  }
  return out;
}

function mechanicalCorpus(): string[] {
  const hosts: string[] = [];
  // Private / loopback / link-local IPv4 — a representative of each range plus its boundaries.
  const privateV4: Array<[number, number, number, number]> = [
    [127, 0, 0, 1], [127, 1, 2, 3], [127, 255, 255, 254],
    [10, 0, 0, 1], [10, 255, 255, 255],
    [172, 16, 0, 1], [172, 20, 10, 1], [172, 31, 255, 255],
    [192, 168, 0, 1], [192, 168, 1, 1],
    [169, 254, 0, 1], [169, 254, 169, 254],
    [0, 0, 0, 0], [0, 1, 2, 3],
  ];
  // Public IPv4 — public under every reading, so a correct guard allows most of these; they are what
  // populates the allow-set the invariants are actually exercised on.
  const publicV4: Array<[number, number, number, number]> = [
    [8, 8, 8, 8], [1, 1, 1, 1], [9, 9, 9, 9], [223, 255, 255, 255],
    [11, 0, 0, 1], [126, 0, 0, 1], [128, 0, 0, 1],
    [172, 15, 0, 1], [172, 32, 0, 1], [192, 167, 1, 1], [192, 169, 1, 1],
    [169, 253, 0, 1], [169, 255, 0, 1],
  ];
  for (const [a, b, c, d] of [...privateV4, ...publicV4]) hosts.push(...ipv4Spellings(a, b, c, d));

  const privateV6 = ["::1", "::", "fe80::1", "fe90::1", "febf::1", "fc00::1", "fdff:ffff::1"];
  const publicV6 = ["2001:db8::1", "2606:4700:4700::1111"];
  for (const literal of [...privateV6, ...publicV6]) hosts.push(...ipv6Spellings(literal));
  hosts.push("[fe80::1%25en0]"); // a zone id must not disguise a link-local address
  return hosts;
}

/** Strip the brackets / trailing root label the corpus carries for the guard, so `getaddrinfo` sees
 *  a bare host. */
function forResolution(host: string): string {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h.replace("%25", "%");
}

/** What Bun's `fetch` will actually dial for this host: WHATWG canonicalizes the authority before the
 *  request is made (proven by a loopback Host-header probe — see web.ts). A throw means the URL is
 *  unfetchable and `ssrfGuard` has already refused it as `invalid url`. */
function dialedAddress(host: string): Uint8Array[] {
  let canonical: string;
  try { canonical = new URL(`http://${host}/x`).hostname; } catch { return []; }
  return numericResolve(forResolution(canonical));
}

// --- the sweep -------------------------------------------------------------------------------

describe("ssrfGuard resolver sweep (generator-independent gate)", () => {
  test("the getaddrinfo oracle is hermetic — numeric literals only, never a DNS query", () => {
    // AI_NUMERICHOST is what makes this whole file emit zero network traffic. Pin it: a name that
    // WOULD resolve via DNS must come back empty, while non-canonical numeric spellings must resolve.
    expect(numericResolve("example.com")).toEqual([]);
    expect(numericResolve("localhost")).toEqual([]);
    expect(numericResolve("999.999.999.999")).toEqual([]);
    expect(numericResolve("127.0.0.1").map(show)).toEqual(["127.0.0.1"]);
    expect(numericResolve("3232235777").map(show)).toEqual(["192.168.1.1"]);
    expect(numericResolve("0xc0a80101").map(show)).toEqual(["192.168.1.1"]);
    expect(numericResolve("0300.0250.0.1").map(show)).toEqual(["192.168.0.1"]);
    expect(numericResolve("::ffff:7f00:1").map(show)).toEqual(["0:0:0:0:0:ffff:7f00:1"]);
  });

  test("nothing the guard ALLOWS resolves — or dials — into private space", () => {
    const corpus = mechanicalCorpus();
    // A corpus that is too small, or that exercises only one branch, makes the invariant vacuous.
    expect(corpus.length).toBeGreaterThan(400);

    let allowed = 0;
    let refused = 0;
    const resolverHoles: string[] = [];
    const dialHoles: string[] = [];

    for (const host of corpus) {
      if (ssrfGuard(`http://${host}/x`) !== null) { refused++; continue; }
      allowed++;
      for (const addr of numericResolve(forResolution(host))) {
        if (isPrivateBytes(addr)) resolverHoles.push(`http://${host}/  ALLOWED but resolves to ${show(addr)}`);
      }
      for (const addr of dialedAddress(host)) {
        if (isPrivateBytes(addr)) dialHoles.push(`http://${host}/  ALLOWED but DIALS ${show(addr)}`);
      }
    }

    // Liveness both ways: a guard that refused (or allowed) the entire corpus would satisfy the
    // invariants trivially.
    expect(allowed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);

    expect(dialHoles.sort().join("\n")).toBe("");
    expect(resolverHoles.sort().join("\n")).toBe("");
  });
});
