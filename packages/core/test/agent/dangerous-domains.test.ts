import { describe, expect, test } from "bun:test";
import {
  SHIPPED_DANGEROUS_DOMAINS, dangerousDomainMatch, dangerousHostMatch, dangerousUrlMatch, normalizeDangerousDomain,
} from "../../src/agent/dangerous-domains";

// SP-approvals Task 10 (user addition 2026-07-21, spec §7): web tools become free by default, but
// web_fetch keeps ONE floor no policy can silence — a fetch to a known/likely exfiltration or
// tunnel-provider domain still needs a human's yes. This is the curated shipped list (immutable by
// construction — "the user can remove only the ones he added", per settings.permissions.
// dangerousDomains.added) plus the pure suffix-match predicate engine.ts's pre-exec check consults.

describe("SHIPPED_DANGEROUS_DOMAINS", () => {
  // Bound widened in the SP-approvals T10 review (list-delta adoption, 2026-07-21): the brief's own
  // "~15-25" guidance was superseded by the reviewer's adopted 13-entry delta (12 reviewer-verified
  // + transfer.archivete.am, WebFetch-verified live during that same review) — ~38 entries today,
  // headroom kept generous so a small future addition doesn't require touching this bound again.
  test("is a non-empty, sanely-sized curated list (generous headroom, not unbounded)", () => {
    expect(SHIPPED_DANGEROUS_DOMAINS.length).toBeGreaterThanOrEqual(15);
    expect(SHIPPED_DANGEROUS_DOMAINS.length).toBeLessThanOrEqual(45);
  });

  test("every entry is lowercase, trimmed, and non-empty — dangerousDomainMatch relies on this, it never normalizes the SHIPPED list itself beyond its own lowercasing", () => {
    for (const entry of SHIPPED_DANGEROUS_DOMAINS) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry).toBe(entry.trim());
      expect(entry.length).toBeGreaterThan(0);
      expect(entry).not.toMatch(/\s/);
    }
  });

  test("no duplicate entries", () => {
    expect(new Set(SHIPPED_DANGEROUS_DOMAINS).size).toBe(SHIPPED_DANGEROUS_DOMAINS.length);
  });

  // Spot-check the exfil/tunnel/paste families the brief names explicitly — this is a curated,
  // reviewed list (task-10-brief.md), not an exhaustive enumeration, so this pins the REQUIRED
  // members without over-constraining the implementer's judgment on the rest.
  test("covers the paste/exfil/tunnel/collector families named in the brief", () => {
    const required = [
      "pastebin.com", "transfer.sh", "file.io", "0x0.st", "webhook.site", "requestbin.com",
      "pipedream.net", "interactsh.com", "oastify.com", "burpcollaborator.net", "ngrok.io",
      "ngrok-free.app", "serveo.net", "localhost.run", "telebit.io", "paste.ee", "hastebin.com",
      "dpaste.org", "temp.sh",
    ];
    for (const domain of required) {
      expect(SHIPPED_DANGEROUS_DOMAINS).toContain(domain);
    }
  });

  // SP-approvals T10 review (2026-07-21): 12 reviewer-adopted entries + transfer.archivete.am
  // (WebFetch-verified live and running transfer.sh's own open-source codebase during the review —
  // the brief's "unless you can verify it's a live transfer.sh mirror right now" condition).
  test("covers the list-delta domains adopted in the T10 review", () => {
    const delta = [
      "x0.at", "sprunge.us", "rentry.co", "cl1p.net", "pastes.dev", "catbox.moe",
      "bashupload.com", "bore.pub", "zrok.io", "webhookrelay.com", "pagekite.net",
      "requestcatcher.com", "transfer.archivete.am",
    ];
    for (const domain of delta) {
      expect(SHIPPED_DANGEROUS_DOMAINS).toContain(domain);
    }
  });

  test("each entry looks like a bare registrable-ish hostname — no scheme, path, port, or leading dot", () => {
    for (const entry of SHIPPED_DANGEROUS_DOMAINS) {
      expect(entry).not.toMatch(/^https?:\/\//);
      expect(entry).not.toMatch(/[/:]/);
      expect(entry.startsWith(".")).toBe(false);
    }
  });
});

describe("dangerousDomainMatch", () => {
  const list = ["pastebin.com", "transfer.sh", "ngrok-free.app"];

  test("exact host match returns the matched entry", () => {
    expect(dangerousDomainMatch("pastebin.com", list)).toBe("pastebin.com");
  });

  test("a subdomain suffix-matches and returns the PARENT entry, not the subdomain", () => {
    expect(dangerousDomainMatch("raw.pastebin.com", list)).toBe("pastebin.com");
    expect(dangerousDomainMatch("a.b.transfer.sh", list)).toBe("transfer.sh");
  });

  test("case-insensitive on both the host and the list entry", () => {
    expect(dangerousDomainMatch("PASTEBIN.COM", list)).toBe("pastebin.com");
    expect(dangerousDomainMatch("Raw.Pastebin.Com", list)).toBe("pastebin.com");
    expect(dangerousDomainMatch("example.NGROK-FREE.APP", list)).toBe("ngrok-free.app");
  });

  test("no match anywhere in the list returns null", () => {
    expect(dangerousDomainMatch("example.com", list)).toBeNull();
  });

  test("empty entries list always returns null", () => {
    expect(dangerousDomainMatch("pastebin.com", [])).toBeNull();
  });

  // Anti-bypass regression pins (same spirit as permission-rules.ts's shell-hazard exploit
  // fixtures): a naive substring/`includes` check would wrongly match these.
  test("a host that merely CONTAINS an entry as a substring, without a proper label boundary, does NOT match", () => {
    expect(dangerousDomainMatch("evilpastebin.com", list)).toBeNull(); // no separating dot
    expect(dangerousDomainMatch("pastebin.com.evil.com", list)).toBeNull(); // entry is a PREFIX, not a suffix
    expect(dangerousDomainMatch("notatransfer.sh", list)).toBeNull();
  });

  test("returns the FIRST matching entry when a host could match more than one list member", () => {
    expect(dangerousDomainMatch("pastebin.com", ["pastebin.com", "pastebin.com"])).toBe("pastebin.com");
  });

  // HIGH-1 (SP-approvals T10 review): a trailing-dot FQDN (the DNS root label, spelled literally —
  // "pastebin.com." resolves to the EXACT SAME address as "pastebin.com") must not bypass the
  // floor. Mirrors tools/web.ts's ssrfGuard, which already strips exactly one trailing dot before
  // its own private-address checks for the identical reason.
  test("a trailing-dot FQDN still matches — the exact host, and a subdomain, both with a literal trailing dot", () => {
    expect(dangerousDomainMatch("pastebin.com.", list)).toBe("pastebin.com");
    expect(dangerousDomainMatch("sub.pastebin.com.", list)).toBe("pastebin.com");
  });
});

// Whole-branch review N1 (2026-09-18): the floor's two matchers disagreed on URL-SHAPED user entries,
// in the unsafe direction. `settings.permissions.dangerousDomains.added` is a bare `z.array(z.string())`
// and the runtime child's own `blockedDomains` matcher URL-PARSES every entry, so `https://evil.example`
// and `evil.example:8080` were honoured INSIDE a Winter child and by nothing host-side — not the
// PreToolUse floor hook (the only enforcer on the official leg), not `Search`'s citation filter, not
// `browser`. Both sides now reduce a url-shaped entry to its hostname.
describe("normalizeDangerousDomain — url-shaped user entries (N1)", () => {
  const CASES: Array<[string, string]> = [
    ["evil.example", "evil.example"],                       // the common case, untouched
    ["*.evil.example", "evil.example"],                     // the SDK's own wildcard spelling
    [".evil.example", "evil.example"],
    ["evil.example.", "evil.example"],                      // trailing root label
    ["  EVIL.example  ", "evil.example"],                   // trim + case
    ["https://evil.example", "evil.example"],
    ["http://evil.example/admin", "evil.example"],
    ["https://evil.example:8443/x?y=1#z", "evil.example"],
    ["evil.example:8080", "evil.example"],                  // a port with no scheme — `new URL` alone reads this as a SCHEME
    ["evil.example/x", "evil.example"],
    ["user:pw@evil.example", "evil.example"],               // userinfo
    ["https://user@EVIL.example./x", "evil.example"],        // every trick at once
    ["//evil.example/x", "evil.example"],                   // scheme-relative
    ["ftp://evil.example", "evil.example"],                 // any scheme, not just http(s)
    ["*.evil.example:8080", "evil.example"],                // wildcard + port
  ];

  for (const [entry, want] of CASES) {
    test(`${JSON.stringify(entry)} -> ${want}`, () => {
      expect(normalizeDangerousDomain(entry)).toBe(want);
    });
  }

  test("never throws, and falls back to the bare normalization for anything unparseable", () => {
    for (const junk of ["", "   ", ":", "://", "http://", "///", "not a domain", "[", "]", "a b:c"]) {
      expect(() => normalizeDangerousDomain(junk)).not.toThrow();
    }
    // A bracketed IPv6 authority keeps its brackets — that is what `URL.hostname` answers, and what a
    // url's own host comparison uses.
    expect(normalizeDangerousDomain("[::1]")).toBe("[::1]");
    expect(normalizeDangerousDomain("http://[fe80::1]:8080/x")).toBe("[fe80::1]");
  });

  test("a url-shaped ENTRY now actually blocks the url it names, host-side", () => {
    // The whole point: these are the spellings that were honoured by the child and by nothing else.
    for (const entry of ["https://evil.example", "evil.example:8080", "evil.example/admin", "*.evil.example"]) {
      expect(dangerousUrlMatch("https://evil.example/x", [entry])).toMatchObject({ host: "evil.example", matchedEntry: entry });
      // …and a subdomain of it, through the shared suffix grammar.
      expect(dangerousUrlMatch("https://sub.evil.example/x", [entry])).toMatchObject({ matchedEntry: entry });
      // …while a neighbour that merely ends in the same letters still does not match.
      expect(dangerousUrlMatch("https://notevil.example/x", [entry])).toBeNull();
    }
  });

  test("a url-shaped entry reaches the HOST-string door too (WebSearch's own domain lists)", () => {
    expect(dangerousHostMatch("sub.evil.example", ["https://evil.example/x"])).toBe("https://evil.example/x");
    expect(dangerousHostMatch("notevil.example", ["https://evil.example/x"])).toBeNull();
  });
});

// 2026-09-19: the runtime child's own `blockedDomains` matcher has two EXACT-ONLY rules; this host-side
// matcher (the only floor on the official leg) must agree with it rather than over-block.
describe("dangerousHostMatch — exact-only entries", () => {
  test("a single-label entry never acts as a suffix: `com` does not block every .com", () => {
    expect(dangerousHostMatch("example.com", ["com"])).toBeNull();
    expect(dangerousHostMatch("localhost", ["localhost"])).toBe("localhost");
    expect(dangerousHostMatch("app.localhost", ["localhost"])).toBeNull();
  });
  test("an IP literal on either side is never a suffix relation", () => {
    expect(dangerousHostMatch("127.0.0.1", ["0.1"])).toBeNull();
    expect(dangerousHostMatch("127.0.0.1", ["0.0.1"])).toBeNull();
    expect(dangerousHostMatch("127.0.0.1", ["127.0.0.1"])).toBe("127.0.0.1");
    expect(dangerousHostMatch("[::1]", ["::1"])).toBeNull(); // bracketed host vs bare entry: different spellings, never a suffix guess
  });
  test("a repeated wildcard prefix is one entry, not an entry that matches nothing", () => {
    expect(normalizeDangerousDomain("*.*.evil.example")).toBe("evil.example");
    expect(dangerousHostMatch("a.evil.example", ["*.*.evil.example"])).toBe("*.*.evil.example");
  });
  test("every shipped entry still matches itself and a subdomain of itself", () => {
    for (const entry of SHIPPED_DANGEROUS_DOMAINS) {
      expect(dangerousHostMatch(entry, SHIPPED_DANGEROUS_DOMAINS)).toBe(entry);
      expect(dangerousHostMatch(`sub.${entry}`, SHIPPED_DANGEROUS_DOMAINS)).toBe(entry);
    }
  });
});
