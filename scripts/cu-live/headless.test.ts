// Winter Headless's live checks (`headless.ts`), without a screen: the command line, whose a change of the front app or
// Space is, the window, process-tree and application-type readers, the leftover-process finder, and the fixtures.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { MonitorSample } from "./lib";
import {
  attributeFrontChanges, CLIENT_CERT_PROBE_URL, cookieUser, HEADLESS_CHECKS, HEADLESS_LIVE_BY_HAND, heavySvg, helperNames, LAN_PROBE, mediaPage, mib,
  parseApplicationType, parseHeadlessOptions, PERMISSIONS_PROBE, processesInside, processTree, siteHome, siteLogin, wavTone, WEBRTC_PROBE, WINDOW_LIST_JXA, windowsOf,
} from "./headless";

const APP = "/tmp/x/Winter Headless Dev.app";

describe("the command line", () => {
  test("defaults, the app from the environment, and every flag", () => {
    const o = parseHeadlessOptions([], { WINTER_HEADLESS_APP: APP });
    if ("error" in o) throw new Error(o.error);
    expect(o).toMatchObject({ app: APP, verify: true, userTyping: false, load: false, promptProbes: false, keepTemp: false });
    expect([...o.checks].sort()).toEqual([...HEADLESS_CHECKS].sort());
    expect(o.report.endsWith(join("out", "cu-live", "headless.json"))).toBe(true);
    const all = parseHeadlessOptions(["--app", APP, "--no-verify", "--user-typing", "--load", "--prompt-probes", "--keep-temp", "--only", "view,isolation", "--report", "/tmp/r.json"], {});
    if ("error" in all) throw new Error(all.error);
    expect(all).toMatchObject({ verify: false, userTyping: true, load: true, promptProbes: true, keepTemp: true, report: "/tmp/r.json" });
    expect([...all.checks].sort()).toEqual(["isolation", "view"]);
  });

  test("what it refuses", () => {
    expect(parseHeadlessOptions([], {})).toEqual({ error: expect.stringContaining("--app") });
    expect(parseHeadlessOptions(["--app", "/tmp/not-an-app"], {})).toEqual({ error: expect.stringContaining(".app bundle") });
    expect(parseHeadlessOptions(["--app", APP, "--only", "2"], {})).toEqual({ error: expect.stringContaining("--only") });
    expect(parseHeadlessOptions(["--app", APP, "--only"], {})).toEqual({ error: expect.stringContaining("--only") });
    expect(parseHeadlessOptions(["--app", APP, "--yes"], {})).toEqual({ error: "unknown argument --yes" });
    expect(parseHeadlessOptions(["--app"], {})).toEqual({ error: "--app needs a path" });
  });

  test("the helper's executable and its window-server owner name are the bundle's name", () => {
    expect(helperNames(APP)).toEqual({ executable: join(APP, "Contents", "MacOS", "Winter Headless Dev"), owner: "Winter Headless Dev" });
    expect(helperNames("/Applications/Winter.app/Contents/Helpers/Winter Headless.app/").owner).toBe("Winter Headless");
  });
});

describe("whose a change of the front app or Space is", () => {
  const sample = (t: number, frontPid: number, space: number | null, hw?: { n: number; last: number | null }): MonitorSample => ({
    t, front: `app${frontPid}`, frontPid, space, hidIdleMs: null, ...(hw === undefined ? {} : { hw: hw.n, hwLast: hw.last, hwStart: 0, hwKeys: true }),
  });

  test("nothing changed: nothing reported", () => {
    expect(attributeFrontChanges([sample(0, 1, 5), sample(20, 1, 5), sample(40, 1, null)], 0, 100, new Set([9]))).toEqual([]);
  });

  test("the helper in front is the helper's, whatever the user did", () => {
    const s = [sample(0, 1, 5, { n: 0, last: null }), sample(20, 1, 5, { n: 1, last: 15 }), sample(40, 9, 5, { n: 1, last: 15 })];
    expect(attributeFrontChanges(s, 0, 100, new Set([9]))).toEqual([{ t: 40, what: "frontmost became app9 (pid 9)", by: "helper" }]);
  });

  test("a change right after the user's hardware input is theirs; one with none is unexplained", () => {
    const s = [
      sample(0, 1, 5, { n: 0, last: null }),
      sample(1_000, 1, 5, { n: 2, last: 990 }),
      sample(1_020, 2, 5, { n: 2, last: 990 }),
      sample(9_000, 2, 5, { n: 2, last: 990 }),
      sample(9_020, 3, 5, { n: 2, last: 990 }),
    ];
    expect(attributeFrontChanges(s, 0, 10_000, new Set([9])).map((c) => [c.t, c.by])).toEqual([[1_020, "user"], [9_020, "unexplained"]]);
  });

  test("a Space change is judged too; an unreadable Space is not", () => {
    const s = [sample(0, 1, 5), sample(20, 1, null), sample(40, 1, 5), sample(60, 1, 6)];
    expect(attributeFrontChanges(s, 0, 100, new Set())).toEqual([{ t: 60, what: "active Space became 6", by: "unexplained" }]);
  });

  test("only the window [from, to] is judged, its first sample the baseline", () => {
    const s = [sample(0, 1, 5), sample(20, 2, 5), sample(40, 2, 5), sample(60, 3, 5), sample(80, 4, 5)];
    expect(attributeFrontChanges(s, 30, 70, new Set()).map((c) => c.t)).toEqual([60]);
  });
});

describe("the readers", () => {
  test("the window list, kept to the helper's process tree", () => {
    const out = JSON.stringify([[12, 101, 0, false], [13, 102, 25, true], [14, 999, 0, true], ["x", 101, 0, true], [15, 101]]);
    expect(windowsOf(out, new Set([101, 102]))).toEqual([
      { id: 12, pid: 101, layer: 0, onScreen: false },
      { id: 13, pid: 102, layer: 25, onScreen: true },
      { id: 15, pid: 101, layer: 0, onScreen: false },
    ]);
    expect(windowsOf("not json", new Set([101]))).toEqual([]);
    expect(WINDOW_LIST_JXA).toContain("CGWindowListCopyWindowInfo");
    expect(WINDOW_LIST_JXA).not.toMatch(/Application\(|kCGWindowName|tell /);
  });

  test("the process tree under the helper: its CEF subprocesses by parent pid", () => {
    const ps = ["  1     0", "100     1", "101   100", "102   100", "103   101", "200     1", "  garbage"].join("\n");
    expect([...processTree(ps, [100])].sort()).toEqual([100, 101, 102, 103]);
    expect([...processTree(ps, [999])]).toEqual([999]);
  });

  test("lsappinfo's ApplicationType", () => {
    expect(parseApplicationType('"ApplicationType"="BackgroundOnly"\n')).toBe("BackgroundOnly");
    expect(parseApplicationType('"ApplicationType"="Foreground"')).toBe("Foreground");
    expect(parseApplicationType("")).toBeUndefined();
  });

  test("the processes inside the helper app — never this run's own command line naming it", () => {
    const ps = [
      `  101 ${APP}/Contents/MacOS/Winter Headless Dev --winter-cache-root=/tmp/c`,
      `  102 ${APP}/Contents/Frameworks/Winter Helper (Renderer).app/Contents/MacOS/Winter Helper (Renderer) --type=renderer`,
      `  103 /usr/local/bin/bun scripts/cu-live/headless.ts --app ${APP}`,
      `  104 /tmp/x/Winter Headless Dev.app.bak/Contents/MacOS/other`,
      "  105 /Applications/Winter.app/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper",
    ].join("\n");
    const ours = new Set([101, 102, 103, 104, 105]);
    expect(processesInside(ps, APP, ours).map((p) => p.pid)).toEqual([101, 102]);
    expect(processesInside(ps, `${APP}/`, ours).map((p) => p.pid)).toEqual([101, 102]);
  });

  test("a process inside the helper app that this run's helper never held is not its — Winter.app's own CEF runs from there too", () => {
    const nested = "/Applications/Winter.app/Contents/Helpers/Winter Headless.app";
    const ps = [
      `  201 ${nested}/Contents/MacOS/Winter Headless --winter-cache-root=/tmp/c`,
      `  202 ${nested}/Contents/Frameworks/Winter Helper (Renderer).app/Contents/MacOS/Winter Helper (Renderer) --type=renderer`,
      // Winter.app's own panel browser: the same executables, another parent.
      `  301 ${nested}/Contents/Frameworks/Winter Helper (GPU).app/Contents/MacOS/Winter Helper (GPU) --type=gpu-process`,
      `  302 ${nested}/Contents/Frameworks/Winter Helper (Renderer).app/Contents/MacOS/Winter Helper (Renderer) --type=renderer`,
    ].join("\n");
    expect(processesInside(ps, nested, new Set([201, 202])).map((p) => p.pid)).toEqual([201, 202]);
    expect(processesInside(ps, nested, new Set())).toEqual([]);
  });

  test("mib", () => {
    expect(mib(undefined)).toBe("?");
    expect(mib(3 * 1024 * 1024 * 1024)).toBe("3072 MiB");
  });
});

describe("the fixtures", () => {
  const scriptsOf = (html: string): string[] => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const compiles = (code: string): void => { expect(() => new Function(code)).not.toThrow(); };

  test("a WAV tone with a valid header", () => {
    const w = wavTone(0.5, 440, 8_000);
    const text = (a: number, n: number): string => String.fromCharCode(...w.slice(a, a + n));
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(w.length).toBe(44 + 4_000);
    expect(new DataView(w.buffer).getUint32(40, true)).toBe(4_000);
  });

  test("the media page: its title, sound, canvases, animations and images; its script compiles", () => {
    const html = mediaPage(7);
    expect(html).toContain("<title>Media 7</title>");
    expect(html).toContain('<audio autoplay loop src="/tone.wav">');
    expect(html.match(/<img /g)?.length).toBe(6);
    expect(html.match(/class=s /g)?.length).toBe(200);
    for (const s of scriptsOf(html)) compiles(s);
    expect(heavySvg(3)).toBe(heavySvg(3));
    expect(heavySvg(3, 10).match(/<circle /g)?.length).toBe(10);
  });

  test("the sign-in site: who the cookie names, and the pages", () => {
    expect(cookieUser("a=1; sid=alice; b=2")).toBe("alice");
    expect(cookieUser("sid=alice")).toBe("alice");
    expect(cookieUser("sid=Alice")).toBeUndefined();
    expect(cookieUser("xsid=bob")).toBeUndefined();
    expect(cookieUser(null)).toBeUndefined();
    expect(siteHome("bob")).toContain("signed in as bob");
    expect(siteHome(undefined)).toContain("signed out");
    expect(siteLogin("bob")).toContain('localStorage.setItem("who", "bob")');
    for (const html of [siteHome("bob"), siteLogin("bob"), PERMISSIONS_PROBE, LAN_PROBE, WEBRTC_PROBE]) for (const s of scriptsOf(html)) compiles(s);
  });

  test("the probes ask for each permission and fetch a LAN address and an mDNS name", () => {
    for (const asked of ["video: true", "audio: true", "getDisplayMedia", "getCurrentPosition", "requestPermission", "credentials?.create"]) expect(PERMISSIONS_PROBE).toContain(asked);
    expect(PERMISSIONS_PROBE).toContain("<button id=ask>Ask</button>");
    expect(CLIENT_CERT_PROBE_URL.startsWith("https://")).toBe(true);
    expect(LAN_PROBE).toContain("http://192.168.1.1/");
    expect(LAN_PROBE).toMatch(/\.local\//);
    expect(LAN_PROBE).toContain("ws://192.168.1.1/");
    expect(LAN_PROBE).toContain("new WebTransport(\"https://192.168.1.1:4433/\")");
    for (const part of ["new RTCPeerConnection", "createDataChannel", "addIceCandidate", "192.168.1.1 54321 typ host", "getStats"]) expect(WEBRTC_PROBE).toContain(part);
  });

  test("the first start is listed for the user, by hand", () => {
    expect(HEADLESS_LIVE_BY_HAND[0]).toMatch(/^First start/);
  });
});
