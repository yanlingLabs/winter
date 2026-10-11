// ComputerV2 Phase 4 — the headless pool's pure rules: the private-network rule (D4), the engine ladder and the
// requirement it holds the helper to, and D2's lifecycle row.
import { describe, expect, test } from "bun:test";
import { headlessRequirementFor, resolveWinterHeadless, winterHeadlessAppPath } from "../../src/computer-use/browser/headless/engines";
import { isPrivateNetworkUrl } from "../../src/computer-use/browser/headless/private-network";
import { shouldCloseAgentTab } from "../../src/computer-use/browser/lifecycle";
import { headlessErrorToTransport } from "../../src/computer-use/browser/headless/winter-engine";

describe("the private-network rule (D4)", () => {
  test("the LAN is private; this Mac and the public internet are not", () => {
    const lan = [
      "http://10.0.0.1/", "http://10.255.255.255:8080/x", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.0.1/",
      "http://169.254.169.254/latest/meta-data", "http://100.64.0.1/", "http://100.127.255.255/", "http://0.0.0.0/", "http://224.0.0.1/",
      "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[::ffff:192.168.1.1]/", "http://[::ffff:c0a8:101]/", "http://[::]/",
      "http://nas.local/", "http://printer.local./", "http://box.home.arpa/", "http://router/", "https://intranet:8443/",
      // URL spellings the parser canonicalises to a private address.
      "http://0xa.0.0.1/", "http://10.1/", "http://3232235777/",
    ];
    for (const u of lan) expect([u, isPrivateNetworkUrl(u)]).toEqual([u, true]);
    const open = [
      "http://localhost:3000/", "http://dev.localhost/", "http://127.0.0.1:5173/", "http://127.1.2.3/", "http://[::1]:8080/",
      "https://example.com/", "http://8.8.8.8/", "http://172.32.0.1/", "http://100.128.0.1/", "http://[2001:4860::8888]/",
      "about:blank", "not a url", "file:///etc/hosts",
    ];
    for (const u of open) expect([u, isPrivateNetworkUrl(u)]).toEqual([u, false]);
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
