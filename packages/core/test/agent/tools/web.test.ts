import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { registerWebTools, ssrfGuard, htmlToText, followRedirects, WEB_SEARCH_API_KEY_SECRET } from "../../../src/agent/tools/web";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-webfetch-")));
}

// --- Step 1: pure-fn tests (no live network) -------------------------------------------------

describe("ssrfGuard", () => {
  test("rejects non-http(s), localhost, private/link-local/loopback IPs", () => {
    for (const bad of ["ftp://x.com", "http://localhost/x", "http://127.0.0.1", "http://10.0.0.5", "http://172.16.9.1", "http://192.168.1.1", "http://169.254.1.1", "http://[::1]/", "file:///etc/passwd"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
    expect(ssrfGuard("https://example.com/page")).toBeNull();
  });

  test("rejects trailing-dot FQDN bypass of localhost/.local/IPv4 checks", () => {
    for (const bad of ["http://localhost./x", "http://foo.local./x", "http://10.0.0.1./x"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("still allows a trailing dot on a genuinely public hostname", () => {
    expect(ssrfGuard("https://example.com.")).toBeNull();
  });

  test("rejects bracketed IPv6 link-local/unique-local literals (brackets previously made these structurally dead)", () => {
    for (const bad of ["http://[fe80::1]/", "http://[fc00::1]/", "http://[fd12:3456::1]/"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("still allows public domains that merely START with fc/fd/fe80 (the ULA/link-local check is IPv6-literal-only)", () => {
    for (const ok of ["https://fcc.gov/", "https://fdic.gov/", "https://fc-barcelona.com/", "https://fe80.example.com/"]) {
      expect(ssrfGuard(ok)).toBeNull();
    }
  });

  // 4g final-review fix: fe80::/10 (the documented link-local range) is wider than the fe80::/16
  // that a bare `startsWith("fe80")` prefix check covers — fe90::/fea0::/feb0:: are link-local
  // too but were previously let through.
  test("rejects the FULL fe80::/10 link-local range, not just fe80:: itself", () => {
    for (const bad of ["http://[fe80::1]/", "http://[fe90::1]/", "http://[fea0::1]/", "http://[feb0::1]/", "http://[febf:ffff::1]/"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("still allows a public domain that merely starts with \"fear\" (past the fe80::/10 range boundary)", () => {
    expect(ssrfGuard("https://fear.com/")).toBeNull();
  });

  test("rejects IPv4-mapped IPv6 loopback/private addresses (dotted and canonical hex forms)", () => {
    for (const bad of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:10.0.0.5]/"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("rejects the IPv6 unspecified address", () => {
    expect(ssrfGuard("http://[::]/")).not.toBeNull();
  });

  // Task 6b Part A: the guard was rewritten from string comparisons to a parser (see below). These
  // messages are the audit-line and model-transcript surface AND the phone mirrors them byte for
  // byte, so the rewrite must not reword a single one. Pinned verbatim, not just as "non-null".
  test("every pre-existing refusal keeps its exact message (the rewrite tightens, never rewords)", () => {
    const expected: Array<[string, string]> = [
      ["ftp://x.com", "only http(s) urls are allowed"],
      ["file:///etc/passwd", "only http(s) urls are allowed"],
      ["http://not a url", "invalid url: http://not a url"],
      ["http://localhost/x", "refusing to fetch a local address"],
      ["http://localhost./x", "refusing to fetch a local address"],
      ["http://foo.local/", "refusing to fetch a local address"],
      ["http://foo.local./x", "refusing to fetch a local address"],
      ["http://0.0.0.0/", "refusing to fetch a local address"],
      ["http://0/", "refusing to fetch a local address"], // WHATWG canonicalizes this to 0.0.0.0
      ["http://[::1]/", "refusing to fetch a local address"],
      ["http://[::]/", "refusing to fetch a local address"],
      ["http://127.0.0.1", "refusing to fetch a private address"],
      ["http://10.0.0.5", "refusing to fetch a private address"],
      ["http://10.0.0.1./x", "refusing to fetch a private address"],
      ["http://172.16.9.1", "refusing to fetch a private address"],
      ["http://192.168.1.1", "refusing to fetch a private address"],
      ["http://169.254.169.254", "refusing to fetch a private address"],
      ["http://[fe80::1]/", "refusing to fetch a private address"],
      ["http://[fe90::1]/", "refusing to fetch a private address"],
      ["http://[febf:ffff::1]/", "refusing to fetch a private address"],
      ["http://[fc00::1]/", "refusing to fetch a private address"],
      ["http://[fd12:3456::1]/", "refusing to fetch a private address"],
      ["http://[::ffff:127.0.0.1]/", "refusing to fetch a private address"],
      ["http://[::ffff:7f00:1]/", "refusing to fetch a private address"],
      // …including the one asymmetry the old code had and this keeps: a bare 0.0.0.0 host is
      // reported *local*, but the same 32 bits arriving IPv4-mapped are reported *private*.
      ["http://[::ffff:0.0.0.0]/", "refusing to fetch a private address"],
    ];
    for (const [url, message] of expected) expect(ssrfGuard(url)).toBe(message);
  });

  // Task 6b Part A (back-ported from the phone's fix-round-2 Critical): every check in this guard
  // used to be a string comparison against `u.hostname` — the host AFTER WHATWG canonicalized it.
  // Canonicalization is LOSSY, and the reading WHATWG picks is not the only reading a resolver
  // accepts: it reads a leading zero as OCTAL (`0127` → 87) while `getaddrinfo` prefers DECIMAL
  // whenever it fits (`0127` → 127). Every host below was ALLOWED by the old guard and confirmed by
  // `getaddrinfo` to denote the private address named in the comment — 18 spellings found by
  // `ssrf-resolver-sweep.test.ts` against the old guard, which is also the gate that proves the
  // class (not the list) is closed.
  test("rejects leading-zero-decimal spellings a resolver targets into private space (was a fail-open)", () => {
    for (const bad of [
      "http://0127.0.0.1/", "http://0127.1.2.3/", "http://0127.255.255.254/", // → 127.x loopback
      "http://010.0.0.1/", "http://010.255.255.255/", "http://010.8.8.8/", // → 10.x
      "http://0172.16.0.1/", "http://0172.20.10.1/", "http://0172.31.255.255/", // → 172.16-31.x
      "http://010.010.010.010/", // per-octet octal, decimal-read → 10.10.10.10
    ]) {
      expect(ssrfGuard(bad)).toBe("refusing to fetch a private address");
    }
  });

  test("the leading-zero class is unbounded — extra zeros must not reopen it", () => {
    // `0127` / `00127` / `000127` all read as 127 decimal; enumerating spellings could never close
    // this, which is why the guard parses instead of matching.
    for (const zeros of ["0", "00", "000", "0000000000"]) {
      expect(ssrfGuard(`http://${zeros}127.0.0.1/`)).toBe("refusing to fetch a private address");
      expect(ssrfGuard(`http://${zeros}10.0.0.1/`)).toBe("refusing to fetch a private address");
    }
  });

  test("percent-encoding the ambiguous spelling does not reopen it either", () => {
    // WHATWG percent-decodes the host before parsing it, so `%30%31%32%37.0.0.1` canonicalizes to
    // the same public 87.0.0.1 — the raw-authority reading has to decode too.
    expect(ssrfGuard("http://%30%31%32%37.0.0.1/")).toBe("refusing to fetch a private address");
    expect(ssrfGuard("http://%30%31%30.0.0.1/")).toBe("refusing to fetch a private address");
  });

  test("still refuses the spellings WHATWG canonicalizes INTO the guarded form (both readings consulted)", () => {
    // The other direction of the same disagreement: here WHATWG's octal reading is the private one
    // (`0177` → 127) and the resolver's decimal reading (177) is public. Refusing needs the
    // c-convention reading, so this pins that dropping either policy is a regression.
    for (const bad of ["http://0177.0.0.1/", "http://0300.0250.0.1/", "http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://3232235777/", "http://0xc0a80101/", "http://0XC0A80101/"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("the raw-authority reading cannot be fooled by userinfo, ports, paths, queries or fragments", () => {
    for (const bad of [
      "http://user:pass@0127.0.0.1:8080/p?q#f", // host is after the LAST "@"
      "http://0127.0.0.1./", // trailing root label
      "http://a@b@010.0.0.1/x", // multiple "@"
      "http:\\\\010.0.0.1\\x", // backslashes are slashes for special schemes
      "http:/010.0.0.1/x", // a single slash still has an authority
    ]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
    // …and it must not mistake a path/query/fragment for the host (the over-blocking direction).
    for (const ok of [
      "https://example.com/010.0.0.1", "https://example.com/?redir=0127.0.0.1",
      "https://example.com/#010.0.0.1", "https://example.com/@010.0.0.1",
    ]) {
      expect(ssrfGuard(ok)).toBeNull();
    }
  });

  test("still allows ordinary public hosts, including numeric-looking names and non-ASCII domains", () => {
    for (const ok of [
      "https://example.com/", "https://8.8.8.8/", "https://1.1.1.1/", "https://223.255.255.255/",
      "https://172.15.0.1/", "https://172.32.0.1/", "https://192.167.1.1/", "https://169.253.0.1/",
      "https://8.8.8.8.nip.io/", "https://2021.example.com/", "https://08.example.com/",
      "https://xn--nicode-2ya.example/", "https://ünicode.example/",
      "https://[2001:db8::1]/", "https://[2606:4700:4700::1111]/", "https://[::ffff:8.8.8.8]/",
    ]) {
      expect(ssrfGuard(ok)).toBeNull();
    }
  });
});

describe("htmlToText", () => {
  // Verbatim task-5-brief.md input, EXPECTED VALUE CORRECTED: the code's own comment ("structure
  // worth keeping (user design): headings → #") plus the .md save target both confirm headings
  // convert to "# text", not plain text — the brief's illustrative expected string was stale.
  test("strips tags/scripts/styles, decodes entities, keeps text, converts headings to markdown", () => {
    expect(htmlToText("<html><script>x()</script><body><h1>Hi &amp; bye</h1><p>a<br>b</p></body>")).toBe("# Hi & bye\na\nb");
  });

  test("converts links to 'text (url)' and list items to '- text'", () => {
    expect(htmlToText('<a href="https://x.com">click</a>')).toBe("click (https://x.com)");
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  test("does not create false bullet points from <link> tags", () => {
    const html = '<html><head><link rel="icon" href="favicon.ico"><title>Page</title></head><body><p>content</p></body></html>';
    const result = htmlToText(html);
    expect(result).not.toContain("- ");
  });

  test("strips <head> section before text conversion to avoid title leakage", () => {
    const html = "<head><title>T</title></head><body><h1>H</h1>hello</body>";
    const result = htmlToText(html);
    expect(result).toBe("# H\nhello");
    expect(result).not.toContain("T");
  });
});

// --- Critical (whole-branch review fix-round-2): htmlToText runs UNCONDITIONALLY on every HTML
// fetch (web_fetch AND, via fetchCleanPage, ReadPage/FetchPage) — unlike page-core.ts's
// extractLinks (only reached when a page's LINKS are extracted), this is the DOMINANT cost the
// re-review measured (256KB: 389.1ms extractLinks-alone vs 389.0ms full pipeline — ~100%
// attributable to htmlToText). Its script/style/head/heading/anchor regexes had the IDENTICAL
// lazy-scan-to-a-required-token shape extractLinks was already fixed for (page-core.ts's own
// LINK_OPEN_RE/LINK_CLOSE_RE comment) — quadratic on many opens with a distant/absent close. Fixed
// the same way: two single-pass regexes (opens, closes) paired by a monotonic pointer, per tag
// shape (`replacePairedTag` for script/style/head/anchor; `convertHeadings` for the h1-h6
// backreference case, which needs a per-LEVEL close list since `<h2>` only pairs with `</h2>`). ---
describe("htmlToText: linear-time scanning (Critical fix, fix-round-2 — the SAME shape as page-core.ts's extractLinks fix, applied here too)", () => {
  function unclosed(unit: string, totalBytes: number): string {
    const reps = Math.ceil(totalBytes / unit.length);
    return unit.repeat(reps);
  }

  const shapes: Array<{ name: string; unit: string }> = [
    { name: "script", unit: '<script type="text/x"> ' },
    { name: "style", unit: '<style type="text/x"> ' },
    { name: "head", unit: "<head> " },
    { name: "h1 (backreference case)", unit: '<h1 class="x">heading text ' },
    { name: "a (the same shape extractLinks already fixed)", unit: '<a href="https://example.com/x">link text ' },
  ];

  for (const { name, unit } of shapes) {
    test(`many unclosed <${name}> opens, no closing tag anywhere: a doubling series (128KB->1MB) stays bounded, not ~4x per doubling`, () => {
      const sizesKb = [128, 256, 512, 1024];
      const timings = sizesKb.map((kb) => {
        const html = unclosed(unit, kb * 1024);
        const start = performance.now();
        htmlToText(html);
        return performance.now() - start;
      });
      // Pre-fix this series was ~130/510/2070/8360ms per shape (measured directly on this branch
      // before the fix, each step ~4x the last — clean O(n^2), matching the reviewer's own
      // methodology). Post-fix every step must stay small and bounded — an absolute bound, not a
      // ratio (CI timing noise): even the LARGEST (1MB) must complete in well under what the
      // SMALLEST (128KB) took pre-fix.
      for (const t of timings) expect(t).toBeLessThan(100);
    });
  }

  test("the 3MB pathological case (no closing tags at all) completes in a small bounded time (was ~77,000ms pre-fix, measured directly)", () => {
    const html = unclosed('<script type="text/x"> ', 3 * 1024 * 1024);
    const start = performance.now();
    htmlToText(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  // Task 6b Part B: the fix above linearized the five PAIRED-tag scans but left the FINAL
  // `<[^>]+>` strip quadratic, and the shapes probed above all terminate their own tags (`<script
  // type="text/x">` has a `>`), so nothing in this file ever reached it. The adversarial shape for
  // the strip is the ABSENT `>`: with no `>` after some point, the regex engine consumes to
  // end-of-string at EVERY `<` and fails.
  //
  // CEILING CALIBRATION — measured, not guessed. `"<p>ok</p>" + "<script x".repeat(n)` on this
  // branch, before the `stripTags` rewrite and after:
  //
  //     opens     bytes     before     after     ratio
  //      5,000    45 KB       78 ms    0.3 ms      260x
  //     10,000    90 KB      301 ms    0.3 ms     1000x
  //     20,000   180 KB     1457 ms    0.6 ms     2400x
  //     40,000   360 KB     6011 ms    1.2 ms     5000x
  //
  // A 200 ms ceiling at 40,000 opens sits ~165x above the linear run and ~30x below the quadratic
  // one, so it is both non-flaky and genuinely discriminating (verified by reverting `stripTags` to
  // the regex: 6.0 s, FAILS). The doubling series is asserted too, since a constant-factor
  // improvement that stayed O(n²) would clear a single absolute bound at some size and not others.
  test("the FINAL tag strip stays linear when no '>' follows (the absent-close shape the paired passes never reach)", () => {
    const closedPair = "<p>ok</p>"; // so the strip really runs a pairing-free scan, not an empty one
    const timings = [5_000, 10_000, 20_000, 40_000].map((opens) => {
      const html = closedPair + "<script x".repeat(opens);
      const start = performance.now();
      const text = htmlToText(html);
      const elapsed = performance.now() - start;
      // Byte-identity spot-check at every size: an unterminated tag is NOT a tag, so it survives.
      expect(text).toBe(("ok\n" + "<script x".repeat(opens)).trim());
      return elapsed;
    });
    for (const t of timings) expect(t).toBeLessThan(200);
  });

  test("many WELL-FORMED, properly-closed tags of every shape (the realistic case) still extract correctly and quickly", () => {
    const html = Array.from(
      { length: 2000 },
      (_, i) => `<h2>Heading ${i}</h2><p>Paragraph ${i} with a <a href="https://example.com/${i}">link ${i}</a>.</p>`,
    ).join("");
    const start = performance.now();
    const result = htmlToText(html);
    const elapsed = performance.now() - start;
    expect(result).toContain("## Heading 0");
    expect(result).toContain("link 0 (https://example.com/0)");
    expect(result).toContain("## Heading 1999");
    expect(result).toContain("link 1999 (https://example.com/1999)");
    expect(elapsed).toBeLessThan(200);
  });
});

// --- followRedirects: fake fetch, no live network ---------------------------------------------

function fakeFetch(script: Array<{ status: number; location?: string; body?: string; contentType?: string }>): typeof fetch {
  let i = 0;
  return (async (_url: string, _init?: RequestInit) => {
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    const headers = new Headers();
    if (step.location) headers.set("location", step.location);
    if (step.contentType) headers.set("content-type", step.contentType);
    return new Response(step.body ?? "", { status: step.status, headers });
  }) as typeof fetch;
}

describe("followRedirects", () => {
  test("302 example.com -> private IP is refused (SSRF guard re-run on the hop)", async () => {
    const fetchFn = fakeFetch([{ status: 302, location: "http://10.0.0.1/" }]);
    const res = await followRedirects("https://example.com", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("ssrf");
      const expected = ssrfGuard("http://10.0.0.1/");
      expect(expected).not.toBeNull();
      expect(res.error).toBe(expected as string);
    }
  });

  test("302 -> 302 -> 200 returns the final body", async () => {
    const fetchFn = fakeFetch([
      { status: 302, location: "https://example.com/step2" },
      { status: 302, location: "https://example.com/step3" },
      { status: 200, body: "final body", contentType: "text/plain" },
    ]);
    const res = await followRedirects("https://example.com/step1", { fetchFn });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toBe("final body");
      expect(res.url).toBe("https://example.com/step3");
      expect(res.status).toBe(200);
    }
  });

  test("more than 3 redirect hops is a typed error", async () => {
    const fetchFn = fakeFetch([
      { status: 302, location: "https://example.com/1" },
      { status: 302, location: "https://example.com/2" },
      { status: 302, location: "https://example.com/3" },
      { status: 302, location: "https://example.com/4" },
      { status: 200, body: "unreached" },
    ]);
    const res = await followRedirects("https://example.com/0", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("redirects");
  });

  test("public first hop redirecting into an IPv4-mapped IPv6 loopback is refused mid-chain", async () => {
    const fetchFn = fakeFetch([{ status: 302, location: "http://[::ffff:127.0.0.1]/" }]);
    const res = await followRedirects("https://example.com", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("ssrf");
      const expected = ssrfGuard("http://[::ffff:127.0.0.1]/");
      expect(expected).not.toBeNull();
      expect(res.error).toBe(expected as string);
    }
  });

  test("non-2xx after redirects resolve is 'fetch failed: <status>'", async () => {
    const fetchFn = fakeFetch([{ status: 404, body: "not found" }]);
    const res = await followRedirects("https://example.com/missing", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("fetch failed: 404");
      expect(res.kind).toBe("http");
    }
  });
});

// --- web_fetch tool: save-to-file + result shape + audit ---------------------------------------

describe("web_fetch tool", () => {
  test("writes the full converted text to ctx.tmpDir and returns a header+preview+guidance result, preview <= 8192 bytes", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    const html = "<html><body><h1>Example Domain</h1><p>This domain is for illustrative examples.</p></body></html>";
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 200, body: html, contentType: "text/html; charset=utf-8" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);

    const savedMatch = out.output.match(/^Saved to: (.+)$/m);
    expect(savedMatch).not.toBeNull();
    const savedPath = savedMatch![1]!;
    expect(existsSync(savedPath)).toBe(true);
    const fileContent = readFileSync(savedPath, "utf8");
    expect(fileContent).toBe("# Example Domain\nThis domain is for illustrative examples.");

    expect(out.output).toContain("Title: Example Domain");
    expect(out.output).toContain("--- preview (first 8192 bytes) ---");
    expect(out.output).toContain("--- end preview ---");
    expect(out.output).toContain("Use read with offset/limit to page through it, grep to search it, or spawn_agent to digest it.");

    const previewSection = out.output.split("--- preview (first 8192 bytes) ---\n")[1]!.split("\n--- end preview ---")[0]!;
    expect(Buffer.byteLength(previewSection, "utf8")).toBeLessThanOrEqual(8192);

    expect(audited.length).toBe(1);
    expect(audited[0]).toMatchObject({ kind: "network", tool: "web_fetch", url: "https://example.com/", outcome: "ok" });
  });

  test("non-html content-type is saved and returned as raw text (no htmlToText conversion)", async () => {
    const r = new ToolRegistry();
    registerWebTools(r, { fetchFn: fakeFetch([{ status: 200, body: "plain text body", contentType: "text/plain" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/raw" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Title: -");
    const savedPath = out.output.match(/^Saved to: (.+)$/m)![1]!;
    expect(readFileSync(savedPath, "utf8")).toBe("plain text body");
  });

  test("SSRF refusal is a typed error AND is audited with outcome ssrf_refused", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "http://10.0.0.5/" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.output).toContain("refusing to fetch a private address");
    expect(audited.length).toBe(1);
    expect(audited[0]).toMatchObject({ kind: "network", tool: "web_fetch", url: "http://10.0.0.5/", outcome: "ssrf_refused" });
  });

  test("non-2xx HTTP error is a typed error AND is audited with outcome http_error", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 500, body: "boom" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/broken" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.output).toBe("fetch failed: 500");
    expect(audited[0]).toMatchObject({ outcome: "http_error" });
  });

  test("audit includes finalUrl (distinct from requested url) when a redirect chain resolves elsewhere", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, {
      audit: (l) => audited.push(l),
      fetchFn: fakeFetch([
        { status: 302, location: "https://example.com/final" },
        { status: 200, body: "final body", contentType: "text/plain" },
      ]),
    });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/start" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);
    expect(audited[0]).toMatchObject({ url: "https://example.com/start", finalUrl: "https://example.com/final", outcome: "ok" });
  });

  test("a successful fetch followed by a file-write failure is audited as write_error, not network_error", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 200, body: "x", contentType: "text/plain" }]) });
    const dir = tmp();
    // ctx.tmpDir points INTO a regular file — mkdirSync(recursive) throws ENOTDIR, simulating a
    // write-time failure that happens strictly after the fetch already succeeded.
    const blockerFile = join(dir, "not-a-dir");
    writeFileSync(blockerFile, "x");
    const badTmpDir = join(blockerFile, "sub");
    const out = await r.execute("web_fetch", { url: "https://example.com/" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: badTmpDir });
    expect(out.isError).toBe(true);
    expect(audited[0]).toMatchObject({ outcome: "write_error" });
  });

  test("missing ctx.tmpDir is a typed error (audited too)", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 200, body: "x" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/" }, { cwd: dir, roots: [dir], sessionId: "s1" });
    expect(out.isError).toBe(true);
    expect(out.output).toContain("ctx.tmpDir is unset");
    expect(audited[0]).toMatchObject({ outcome: "no_tmp_dir" });
  });

  test("bad args (missing url) is a registry-level tool error, not a throw", async () => {
    const r = new ToolRegistry();
    registerWebTools(r);
    const dir = tmp();
    const out = await r.execute("web_fetch", {}, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
  });
});

// --- web_search tool (4g Task 6, Brave backend): no-key error, canned-fixture mapping, request
// shape, clamping, empty/non-200 outcomes — all driven via the SAME injectable fetchFn as
// web_fetch above, no live network. ------------------------------------------------------------

function fakeSecret(value: string | null): (name: string) => Promise<string | null> {
  return async (name) => {
    expect(name).toBe(WEB_SEARCH_API_KEY_SECRET);
    return value;
  };
}

function braveFetch(body: unknown, status = 200): typeof fetch {
  return (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("web_search tool", () => {
  test("no key stored is a typed isError with the exact login hint, and is audited outcome no_key", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), secret: fakeSecret(null) });
    const dir = tmp();
    const out = await r.execute("web_search", { query: "norma agent" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    // Branch review FIX 6: no `<key>` placeholder — the CLI's `--web-search-key` branch ignores a
    // positional value and prompts via readSecret regardless, so the OLD wording ("norma login
    // --web-search-key <key> ...") described a command that doesn't do what it implies.
    expect(out.output).toBe("web_search needs an API key — store one with: norma login --web-search-key (Brave Search API)");
    expect(audited.length).toBe(1);
    expect(audited[0]).toMatchObject({ kind: "network", tool: "web_search", query: "norma agent", outcome: "no_key" });
  });

  // Branch review FIX 1 (Important/security): the identical twin of chat's Search key leak — Bun's
  // REAL fetch (not an injected fake) embeds an invalid header's VALUE verbatim in its own error
  // text. Unlike chat's Search, web_search's output is remote-reachable (a code session can be
  // driven from a phone), so this leak matters even more here.
  test("a stray U+200B in the Brave key never leaks into the tool result, through Bun's REAL fetch", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    const leakyKey = "SUPER_SECRET_BRAVE_KEY​"; // trailing U+200B — .trim() does not strip it
    registerWebTools(r, { audit: (l) => audited.push(l), secret: fakeSecret(leakyKey) }); // no fetchFn override
    const dir = tmp();
    const out = await r.execute("web_search", { query: "x" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.output).not.toContain(leakyKey);
    expect(out.output).not.toContain("SUPER_SECRET_BRAVE_KEY");
    expect(JSON.stringify(audited)).not.toContain(leakyKey);
  });

  // --- final re-review must-fix: search.ts's identical twin (see its comment for full reasoning)
  // — the ORIGINAL FIX 1 redirected the raw detail to console.error and called it done, but
  // ~/.norma/logs/core.err.log (where launchd.ts sends the daemon's stderr) is deliberately
  // agent-readable, so the key must be redacted before it's logged, not just before it's returned.
  // Short, obviously-fake token (not a realistic-looking secret) — asserts on absence only.
  test("the key is redacted from the console.error line too — a useful diagnostic survives", async () => {
    const r = new ToolRegistry();
    const fakeToken = "tok-b1-zwsp​"; // trailing U+200B, same artifact as the test above
    registerWebTools(r, { secret: fakeSecret(fakeToken) }); // no fetchFn override — real global fetch
    const dir = tmp();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await r.execute("web_search", { query: "x" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
      const stderrText = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(stderrText).not.toContain(fakeToken);
      expect(stderrText).not.toContain("tok-b1");
      // Still diagnostic: an operator can tell this is an invalid-header failure, not a DNS one.
      expect(stderrText).toContain("invalid value");
      expect(stderrText).toContain("<redacted>");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a genuine network failure (key never appears in the underlying message) keeps its real diagnostic in stderr — redaction is a no-op, not a blanket scrub", async () => {
    const r = new ToolRegistry();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      registerWebTools(r, {
        secret: fakeSecret("clean-ascii-key"),
        fetchFn: (async () => {
          throw new Error("getaddrinfo ENOTFOUND api.search.brave.com");
        }) as unknown as typeof fetch,
      });
      const dir = tmp();
      await r.execute("web_search", { query: "x" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
      const stderrText = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(stderrText).toContain("ENOTFOUND");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("no secret accessor at all (deps.secret undefined) behaves identically to no key stored", async () => {
    const r = new ToolRegistry();
    registerWebTools(r); // no secret, no fetchFn
    const dir = tmp();
    const out = await r.execute("web_search", { query: "x" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.output).toContain("web_search needs an API key");
  });

  test("canned Brave response maps to a numbered title/url/description list, default-capped at 5", async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({ title: `Title ${i + 1}`, url: `https://x.com/${i + 1}`, description: `Desc ${i + 1}` }));
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), secret: fakeSecret("brave-key"), fetchFn: braveFetch({ web: { results } }) });
    const dir = tmp();
    const out = await r.execute("web_search", { query: "example" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);
    expect(out.output).toBe(
      [1, 2, 3, 4, 5].map((n) => `${n}. Title ${n}\n   https://x.com/${n}\n   Desc ${n}`).join("\n"),
    );
    expect(out.output).not.toContain("Title 6");
    expect(audited[0]).toMatchObject({ kind: "network", tool: "web_search", query: "example", outcome: "ok" });
  });

  test("max_results is honored up to the cap; requests above 10 clamp to 10", async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ title: `T${i + 1}`, url: `https://x.com/${i + 1}`, description: "d" }));
    const r1 = new ToolRegistry();
    registerWebTools(r1, { secret: fakeSecret("k"), fetchFn: braveFetch({ web: { results: results.slice(0, 3) } }) });
    const dir = tmp();
    const out1 = await r1.execute("web_search", { query: "q", max_results: 3 }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out1.output.split("\n").filter((l) => /^\d+\./.test(l)).length).toBe(3);

    let capturedUrl = "";
    const fetchFn = (async (url: string) => { capturedUrl = url; return new Response(JSON.stringify({ web: { results } }), { status: 200 }); }) as typeof fetch;
    const r2 = new ToolRegistry();
    registerWebTools(r2, { secret: fakeSecret("k"), fetchFn });
    const out2 = await r2.execute("web_search", { query: "q", max_results: 999 }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(capturedUrl).toContain("count=10");
    expect(out2.output.split("\n").filter((l) => /^\d+\./.test(l)).length).toBe(10);
  });

  test("request shape: URL is Brave's search endpoint with encoded query + count, header carries the key", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchFn = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    }) as typeof fetch;
    const r = new ToolRegistry();
    registerWebTools(r, { secret: fakeSecret("my-brave-key"), fetchFn });
    const dir = tmp();
    await r.execute("web_search", { query: "hello world" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(capturedUrl).toBe("https://api.search.brave.com/res/v1/web/search?q=hello%20world&count=5");
    expect(capturedHeaders["x-subscription-token"]).toBe("my-brave-key");
    expect(capturedHeaders["accept"]).toBe("application/json");
  });

  test("empty results is 'no results for <query>', not an error", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), secret: fakeSecret("k"), fetchFn: braveFetch({ web: { results: [] } }) });
    const dir = tmp();
    const out = await r.execute("web_search", { query: "asdkjhasdkjhasd" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);
    expect(out.output).toBe("no results for asdkjhasdkjhasd");
    expect(audited[0]).toMatchObject({ outcome: "ok" });
  });

  test("non-200 response is a typed isError carrying the status, audited http_error", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), secret: fakeSecret("k"), fetchFn: braveFetch({}, 401) });
    const dir = tmp();
    const out = await r.execute("web_search", { query: "q" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.output).toBe("web_search failed: HTTP 401");
    expect(audited[0]).toMatchObject({ outcome: "http_error" });
  });

  test("bad args (missing query) is a registry-level tool error, not a throw", async () => {
    const r = new ToolRegistry();
    registerWebTools(r);
    const dir = tmp();
    const out = await r.execute("web_search", {}, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
  });
});
