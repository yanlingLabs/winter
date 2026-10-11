// ComputerV2 Phase 4 — the headless pool's pure rules: the private-network rule, the engine ladder and the requirement
// it holds the helper to, and the lifecycle row for headless tabs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headlessRequirementFor, resolveWinterHeadless, winterHeadlessAppPath } from "../../src/computer-use/browser/headless/engines";
import { ipv6Bytes, isPrivateNetworkHost, isPrivateNetworkUrl } from "../../src/computer-use/browser/headless/private-network";
import { shouldCloseAgentTab } from "../../src/computer-use/browser/lifecycle";
import { headlessErrorToTransport } from "../../src/computer-use/browser/headless/winter-engine";

describe("the private-network rule (the user's ruling: this Mac allowed, the LAN refused, by the address as written)", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "headless-private-network.json"), "utf8")) as { refused: string[]; allowed: string[] };

  test("every row of the shared fixture (Winter Headless's Swift copy answers the same file)", () => {
    expect(fixture.refused.length).toBeGreaterThan(20);
    for (const u of fixture.refused) expect([u, isPrivateNetworkUrl(u)]).toEqual([u, true]);
    for (const u of fixture.allowed) expect([u, isPrivateNetworkUrl(u)]).toEqual([u, false]);
  });

  test("URL spellings the parser canonicalises to a private address, and what is not an http(s) URL", () => {
    for (const u of ["http://0xa.0.0.1/", "http://10.1/", "http://3232235777/", "http://0300.0250.1.1/", "http://[::ffff:192.168.1.1]/", "http://[::192.168.1.1]/", "HTTP://ROUTER.LAN/", "https://intranet:8443/"]) {
      expect([u, isPrivateNetworkUrl(u)]).toEqual([u, true]);
    }
    for (const u of ["about:blank", "not a url", "file:///etc/hosts", "http://[::ffff:127.0.0.1]/"]) expect([u, isPrivateNetworkUrl(u)]).toEqual([u, false]);
  });

  test("IPv6 parsing: groups, the elision, a dotted tail; nonsense is refused (fail closed)", () => {
    expect(ipv6Bytes("::1")).toEqual([...new Array(15).fill(0), 1]);
    expect(ipv6Bytes("1:2:3:4:5:6:7:8")).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
    expect(ipv6Bytes("::ffff:10.0.0.1")!.slice(10)).toEqual([0xff, 0xff, 10, 0, 0, 1]);
    expect(ipv6Bytes("fe80::1%en0")!.slice(0, 2)).toEqual([0xfe, 0x80]);
    for (const bad of ["", "1::2::3", "1:2:3:4:5:6:7:8:9", "12345::", "::1.2.3.256", "g::1"]) expect([bad, ipv6Bytes(bad)]).toEqual([bad, undefined]);
    expect(isPrivateNetworkHost("[1::2::3]")).toBe(true);
  });
});

describe("the engine ladder", () => {
  const exists = (paths: string[]) => (p: string): boolean => paths.includes(p);

  test("an explicit $WINTER_HEADLESS_APP is authoritative: missing is the failure, never another copy", () => {
    const env = { WINTER_HEADLESS_APP: "/tmp/H/Winter Headless Dev.app" };
    expect(resolveWinterHeadless("dist", { env, execPath: "/Applications/Winter.app/Contents/MacOS/winter-core", exists: () => false }))
      .toEqual({ missing: "Winter's headless browser is missing — reinstall Winter" });
    const r = resolveWinterHeadless("dist", { env, exists: exists(["/tmp/H/Winter Headless Dev.app/Contents/MacOS/Winter Headless Dev"]) });
    expect(r).toEqual({
      engine: "winter", app: "/tmp/H/Winter Headless Dev.app", executable: "/tmp/H/Winter Headless Dev.app/Contents/MacOS/Winter Headless Dev",
      requirement: headlessRequirementFor("dist", true),
    });
  });

  test("dist: the helper next to the running winter-core, in Winter.app's Helpers", () => {
    const execPath = "/Applications/Winter.app/Contents/MacOS/winter-core";
    expect(winterHeadlessAppPath("dist", {}, execPath).path).toBe("/Applications/Winter.app/Contents/Helpers/Winter Headless.app");
    const exe = "/Applications/Winter.app/Contents/Helpers/Winter Headless.app/Contents/MacOS/Winter Headless";
    expect(resolveWinterHeadless("dist", { env: {}, execPath, exists: exists([exe]) })).toMatchObject({ engine: "winter", executable: exe, requirement: headlessRequirementFor("dist", false) });
  });

  test("a dev daemon says how to build the dev helper; off its own home only the override counts", () => {
    expect(resolveWinterHeadless("dev", { env: {}, exists: () => false })).toEqual({ missing: "Winter's headless browser is not built — run `bun run dev:headless`" });
    expect(resolveWinterHeadless("dev", { env: {}, exists: () => true, overrideOnly: true })).toEqual({ missing: "Winter's headless browser is missing — reinstall Winter" });
    expect(winterHeadlessAppPath("dev", {}).path.endsWith("/dist/dev/Winter Headless Dev.app")).toBe(true);
  });

  test("the requirement: the profile's identifier and Winter's team; an override may be either identity", () => {
    expect(headlessRequirementFor("dist", false, "TEAM")).toBe('identifier "com.winter.headless" and anchor apple generic and certificate leaf[subject.OU] = "TEAM"');
    expect(headlessRequirementFor("dev", false, "TEAM")).toBe('identifier "com.winter.headless.dev" and anchor apple generic and certificate leaf[subject.OU] = "TEAM"');
    expect(headlessRequirementFor("dist", true, "TEAM")).toBe('(identifier "com.winter.headless" or identifier "com.winter.headless.dev") and anchor apple generic and certificate leaf[subject.OU] = "TEAM"');
  });
});

describe("the helper's error codes", () => {
  test("its tab ceiling is capacity; not_live reads as the tab gone", () => {
    expect(headlessErrorToTransport("not_allowed", "already has 24 tabs", { capacity: true }).code).toBe("capacity");
    expect(headlessErrorToTransport("not_allowed", "refused").code).toBe("not_allowed");
    expect(headlessErrorToTransport("not_live", "x").code).toBe("tab_gone");
    expect(headlessErrorToTransport("something_new", "x").code).toBe("cdp_error");
  });
});

describe("D2's lifecycle row", () => {
  test("a headless tab closes at the turn's end unless handed off, at deletion, archiving and the runtime's idle end — never at daemon stop", () => {
    const f = (event: Parameters<typeof shouldCloseAgentTab>[0]["event"], extra: Partial<Parameters<typeof shouldCloseAgentTab>[0]> = {}) =>
      shouldCloseAgentTab({ event, family: "headless", kept: false, ...extra });
    expect(f("turn-ended")).toBe(true);
    expect(f("turn-ended", { handoff: true })).toBe(false);
    expect(f("session-deleted")).toBe(true);
    expect(f("session-archived")).toBe(true);
    expect(f("idle-ended")).toBe(true);
    expect(f("daemon-stop")).toBe(false);
    // Unchanged: the built-in browser never; a user's browser not at an idle end.
    expect(shouldCloseAgentTab({ event: "turn-ended", family: "winter", kept: false })).toBe(false);
    expect(shouldCloseAgentTab({ event: "idle-ended", family: "chrome", kept: false })).toBe(false);
  });
});
