import { describe, expect, test } from "bun:test";
import { SHIPPED_DANGEROUS_DOMAINS, dangerousDomainMatch } from "../../src/agent/dangerous-domains";

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
