/**
 * ComputerV2 Phase 4 — Winter Headless's LIVE checks: the real browser engine over the real headless pool and a real,
 * signed Winter Headless, on this Mac, while the cu-live monitor samples the user's frontmost app and Space every 20 ms.
 * The controller runs it, with the user's go-ahead; it is never run by an agent on its own.
 *
 *   WINTER_CU_LIVE_TESTS=1 bun scripts/cu-live/headless.ts --app "<Winter Headless .app>" [options]
 *
 *   --app <path>        the helper to drive (default `$WINTER_HEADLESS_APP`); a dev build from `bun run dev:headless`,
 *                       or a Release Winter.app's nested `Contents/Helpers/Winter Headless.app`
 *   --no-verify         skip the signature check of the spawned process (an unsigned build only)
 *   --user-typing       the view check's second variant: put another app in front and keep typing in it — the run
 *                       starts 10 s later; the user's own switches are then reported, never failed. They are told apart
 *                       by the monitor's hardware tap, which sees KEYS only when the terminal has Input Monitoring:
 *                       switch apps with the pointer (a click, the Dock), or grant it — a ⌘-Tab it cannot see reads as
 *                       unexplained
 *   --load              the cold start on a LOADED Mac: one `yes > /dev/null` per core while the helper starts
 *   --prompt-probes     ALSO the pages that ask (on a click, so with a user gesture) for the camera, microphone, screen
 *                       capture, location, notifications and a passkey (WebAuthn), that fetch a LAN address and an mDNS
 *                       name, open a WebSocket and WebTransport to a LAN address, make an RTCPeerConnection given a LAN
 *                       candidate (a fingerprinting script's), and a public site that asks for a client certificate (client.badssl.com — needs the
 *                       internet). They may raise a macOS prompt (TCC, Local Network) — the question these probes ask,
 *                       so only with the user at the Mac: a denial is remembered for the identity macOS blames. NOTE:
 *                       spawned from a terminal, a prompt is attributed to the terminal's process chain, not to Winter
 *                       Headless — these probes say WHETHER one appears; only a daemon-spawned run shows which name it
 *                       carries
 *   --only <view,memory,isolation>  run only those checks (default all three)
 *   --report <file>     where the JSON report goes (default out/cu-live/headless.json)
 *   --keep-temp         keep the temp home (the helper's cache dirs are removed by the pool either way)
 *
 * What it checks:
 *   view — never move the view: 10 headless tabs opened at once on media-heavy pages (two sessions of 5: a session
 *      holds at most 8), each read with text() and closed; cold, then warm. Across the WHOLE run: the helper is never
 *      the frontmost app; the frontmost app and the Space never change without the user's hardware input just before;
 *      no permission prompt (UserNotificationCenter, SecurityAgent, CoreServicesUIAgent) comes to the front; no process
 *      of the helper's tree — the helper and every CEF subprocess it started, found by parent pid — ever owns an
 *      on-screen window (CoreGraphics' window list, read through JavaScript for Automation with no Apple Event to any
 *      app; off-screen windows are reported); and the helper is never a Foreground app (`lsappinfo`: a Dock tile).
 *   memory — reported, not asserted: the first open to its state (cold, and with --load), and the helper's memory at
 *      1, 8 and 24 tabs — its processes' physical footprint summed, what the memory guard reads (with the old
 *      resident-size sum beside it); asserted: a session's 9th tab and the 25th tab are TargetBusy (a memory-guard
 *      refusal before 24 is recorded as the finding it is), and once every tab is closed the guard lets a new tab open.
 *   isolation — two sessions sign in to the same local site as different users and each sees only its own (cookies
 *      and localStorage); after a session's runtime ends its context is gone (signed out); tabs close at the turn's end,
 *      handoff() keeps one for exactly one more turn, keep() is NotAllowed; the helper SIGKILLed during a waitFor →
 *      TargetLost, and the next open relaunches it; a "daemon" (a child process owning the pool) SIGKILLed takes the
 *      helper with it (the pipe's EOF); and at the end the pool's stop leaves nothing from the helper app running.
 *
 * Drives the engine directly (as `scripts/browser-e2e/headless/engine-smoke.ts` does), not a daemon and a script: a
 * headless tab never touches the Computer Use helper, a card or the user's browsers, and concurrent `engine.global`
 * calls are what a script's `Promise.all` becomes. The FIRST START — a daemon starting a Release-signed helper inside
 * Winter.app with Winter.app closed — is checked by hand (`HEADLESS_LIVE_BY_HAND`). Everything is on a temp home
 * (`<tmp>/winter-cu-live-headless-*`): no Keychain (the helper runs with `--use-mock-keychain`), nothing under
 * `~/.winter*`. SIGINT/SIGTERM/SIGHUP stop the helper, the monitor, the load and the child, then exit 128+n.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BrowserEngine, HEADLESS_KEEP } from "../../packages/core/src/computer-use/browser/engine";
import { headlessRequirementFor } from "../../packages/core/src/computer-use/browser/headless/engines";
import { processTreeFootprint, processTreeRss } from "../../packages/core/src/computer-use/browser/headless/memory";
import { HEADLESS_NAME, HeadlessPool } from "../../packages/core/src/computer-use/browser/headless/pool";
import { BrowserBackendRegistry } from "../../packages/core/src/computer-use/browser/registry";
import type { TabRunScope } from "../../packages/core/src/computer-use/browser/tab-scope";
import { DiffBases } from "../../packages/core/src/computer-use/diff-base";
import { AutomationFailure } from "../../packages/core/src/computer-use/errors";
import { processSatisfiesRequirement } from "../../packages/core/src/computer-use/helper-verify";
import { TargetLocks } from "../../packages/core/src/computer-use/locks";
import type { SessionFacts } from "../../packages/core/src/computer-use/policy";
import { ResultBuilder } from "../../packages/core/src/computer-use/result";
import type { PrimitiveMetric } from "../../packages/core/src/computer-use/telemetry";
import type { TabHandle } from "../../packages/core/src/computer-use/worker/bridge";
import { buildTool, OUT_DIR } from "./build";
import {
  check, hardwareInputTimes, installStopHandler, parseMonitorLine, parseSessionReading, promptAppeared, renderTable, screenUnavailable,
  screenUnavailableAt, statusOf, type Check, type MonitorSample, type ScenarioResult,
} from "./lib";

// ── the pure parts (headless.test.ts) ────────────────────────────────────────────────────────────────────────────

export interface HeadlessLiveOptions {
  app: string;
  verify: boolean;
  userTyping: boolean;
  load: boolean;
  promptProbes: boolean;
  checks: ReadonlySet<HeadlessCheck>;
  report: string;
  keepTemp: boolean;
}

/** The live checks, by name. */
export const HEADLESS_CHECKS = ["view", "memory", "isolation"] as const;
export type HeadlessCheck = (typeof HEADLESS_CHECKS)[number];

/** The command line, or why it is wrong. `--child-pool` is the internal "daemon" of the isolation check's last step. */
export function parseHeadlessOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): HeadlessLiveOptions | { error: string } {
  let app = env.WINTER_HEADLESS_APP;
  let report = join(OUT_DIR, "headless.json");
  const o = { verify: true, userTyping: false, load: false, promptProbes: false, keepTemp: false };
  let checks = new Set<HeadlessCheck>(HEADLESS_CHECKS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string | undefined => { const v = argv[i + 1]; i++; return v === undefined || v.startsWith("--") ? undefined : v; };
    if (a === "--app") { const v = value(); if (v === undefined) return { error: "--app needs a path" }; app = v; }
    else if (a === "--report") { const v = value(); if (v === undefined) return { error: "--report needs a file" }; report = v; }
    else if (a === "--only") {
      const v = value();
      const picked = (v ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0);
      if (picked.length === 0 || picked.some((x) => !(HEADLESS_CHECKS as readonly string[]).includes(x))) return { error: `--only takes ${HEADLESS_CHECKS.join(", ")} (comma-separated)` };
      checks = new Set(picked as HeadlessCheck[]);
    }
    else if (a === "--no-verify") o.verify = false;
    else if (a === "--user-typing") o.userTyping = true;
    else if (a === "--load") o.load = true;
    else if (a === "--prompt-probes") o.promptProbes = true;
    else if (a === "--keep-temp") o.keepTemp = true;
    else return { error: `unknown argument ${a}` };
  }
  if (app === undefined || app.trim().length === 0) return { error: "name the helper: --app <Winter Headless .app> (or $WINTER_HEADLESS_APP; `bun run dev:headless` builds one)" };
  if (!/\.app\/?$/.test(app.trim())) return { error: `--app must be an .app bundle (got ${app})` };
  return { app: resolve(app.trim()), report: resolve(report), checks, ...o };
}

/** The app's executable and its window-server owner name (its bundle name: "Winter Headless", "Winter Headless Dev"). */
export function helperNames(app: string): { executable: string; owner: string } {
  const name = basename(app.replace(/\/+$/, "")).replace(/\.app$/i, "");
  return { executable: join(app, "Contents", "MacOS", name), owner: name };
}

/** One change of the frontmost app or Space, and whose it was. */
export interface FrontChange {
  t: number;
  what: string;
  /** `helper`: Winter Headless itself came to the front (always a failure); `user`: the user's hardware input came
   *  within `userWindowMs` before it; `unexplained`: neither. */
  by: "helper" | "user" | "unexplained";
}

/**
 * Every change of the frontmost app or the active Space in [from, to], attributed. The first sample in the window is
 * the baseline; a Space the monitor could not read (null) is not judged.
 */
export function attributeFrontChanges(samples: readonly MonitorSample[], from: number, to: number, helperPids: ReadonlySet<number>, userWindowMs = 1_500): FrontChange[] {
  const inside = samples.filter((s) => s.t >= from && s.t <= to);
  const input = hardwareInputTimes(samples, from - userWindowMs, to);
  const out: FrontChange[] = [];
  let prev: MonitorSample | undefined;
  for (const s of inside) {
    if (prev !== undefined) {
      const user = input.some((at) => at <= s.t && s.t - at <= userWindowMs);
      if (s.frontPid !== null && s.frontPid !== prev.frontPid) {
        const by = helperPids.has(s.frontPid) ? "helper" : user ? "user" : "unexplained";
        out.push({ t: s.t, what: `frontmost became ${s.front ?? "?"} (pid ${s.frontPid})`, by });
      } else if (s.space !== null && prev.space !== null && s.space !== prev.space) {
        out.push({ t: s.t, what: `active Space became ${s.space}`, by: user ? "user" : "unexplained" });
      }
    }
    if (s.frontPid !== null) prev = { ...s, space: s.space ?? prev?.space ?? null };
  }
  return out;
}

/** One window of the window server, as `WINDOW_LIST_JXA` reports it. */
export interface ServerWindow { id: number; pid: number; layer: number; onScreen: boolean }

/** JavaScript for Automation that prints every window's id, owner pid, layer and on-screen flag (CoreGraphics' window
 *  list — no Apple Event to any app, no permission: names and titles are not asked for). */
export const WINDOW_LIST_JXA = `ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))) || [];
JSON.stringify(list.map((w) => [w.kCGWindowNumber, w.kCGWindowOwnerPID, w.kCGWindowLayer, w.kCGWindowIsOnscreen === true]));`;

/** `WINDOW_LIST_JXA`'s output, the windows of the given processes only. */
export function windowsOf(stdout: string, pids: ReadonlySet<number>): ServerWindow[] {
  let rows: unknown;
  try { rows = JSON.parse(stdout.trim()); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const out: ServerWindow[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== "number" || typeof r[1] !== "number" || !pids.has(r[1])) continue;
    out.push({ id: r[0], pid: r[1], layer: typeof r[2] === "number" ? r[2] : 0, onScreen: r[3] === true });
  }
  return out;
}

/** Every process under the roots (the roots included), from `ps -A -o pid=,ppid=`. */
export function processTree(psOutput: string, roots: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const list = children.get(Number(m[2]));
    if (list === undefined) children.set(Number(m[2]), [Number(m[1])]); else list.push(Number(m[1]));
  }
  const out = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (out.has(pid)) continue;
    out.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** `lsappinfo info -only ApplicationType <asn>` → "Foreground" | "BackgroundOnly" | "UIElement" | …; undefined when none. */
export function parseApplicationType(stdout: string): string | undefined {
  return /"ApplicationType"="([^"]+)"/.exec(stdout)?.[1];
}

/** The processes (from `ps -A -o pid=,command=`) whose executable lies inside the helper app AND that this run's
 *  helper tree held (`ours`) — the helper itself and its "Winter Helper" subprocesses. The path alone is never enough:
 *  Winter.app's own CEF runs its subprocesses from the nested helper's Contents/Frameworks too, so a running Winter's
 *  processes can lie inside the same app and must never be counted (or killed) as the helper's. */
export function processesInside(psOutput: string, appPath: string, ours: ReadonlySet<number>): Array<{ pid: number; command: string }> {
  const prefix = `${appPath.replace(/\/+$/, "")}/`;
  const out: Array<{ pid: number; command: string }> = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m !== null && m[2]!.startsWith(prefix) && ours.has(Number(m[1]))) out.push({ pid: Number(m[1]), command: m[2]! });
  }
  return out;
}

export function mib(bytes: number | undefined): string {
  return bytes === undefined ? "?" : `${Math.round(bytes / (1024 * 1024))} MiB`;
}

/** A tone the media pages loop (muted by the helper's `--mute-audio`, but decoded and played all the same). */
export function wavTone(seconds = 1, hz = 440, rate = 8_000): Uint8Array<ArrayBuffer> {
  const n = Math.round(seconds * rate);
  const buf = new Uint8Array(new ArrayBuffer(44 + n));
  const v = new DataView(buf.buffer);
  const ascii = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + n, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); ascii(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * hz * i) / rate));
  return buf;
}

/** A large SVG: many shapes, so the page decodes and paints real work. */
export function heavySvg(seed: number, shapes = 2_000): string {
  let x = (seed * 9_973 + 7) >>> 0;
  const rnd = (m: number): number => { x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0; return x % m; };
  const parts: string[] = [];
  for (let i = 0; i < shapes; i++) parts.push(`<circle cx="${rnd(1200)}" cy="${rnd(800)}" r="${3 + rnd(30)}" fill="hsl(${rnd(360)},70%,50%)" fill-opacity="0.6"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">${parts.join("")}</svg>`;
}

/** A media-heavy page: six big SVGs, a canvas and a WebGL loop on requestAnimationFrame, 200 CSS animations, a looping
 *  audio element, and text for `text()` to read. */
export function mediaPage(n: number): string {
  const squares = Array.from({ length: 200 }, (_, i) => `<i class=s style="--h:${(i * 37) % 360}"></i>`).join("");
  const images = Array.from({ length: 6 }, (_, k) => `<img alt="art ${n}-${k}" width=600 height=400 src="/img/${n}-${k}.svg">`).join("");
  return `<!doctype html><meta charset=utf-8><title>Media ${n}</title>
<style>@keyframes spin{to{transform:rotate(360deg)}}.s{display:inline-block;width:24px;height:24px;margin:2px;background:hsl(var(--h),70%,50%);animation:spin 1s linear infinite}</style>
<h1>Media ${n}</h1><p>Headless live page ${n}: images, canvas, WebGL, animations and sound.</p>
<audio autoplay loop src="/tone.wav"></audio>
<canvas id=c width=1024 height=600></canvas><canvas id=g width=512 height=512></canvas>
<div>${squares}</div><div>${images}</div>
<p>${"The quick brown fox jumps over the lazy dog. ".repeat(80)}</p>
<script>
const c = document.getElementById("c").getContext("2d");
function draw(t) { for (let i = 0; i < 400; i++) { c.fillStyle = "hsl(" + ((t / 10 + i) % 360) + ",80%,50%)"; c.fillRect(Math.random() * 1024, Math.random() * 600, 8, 8); } requestAnimationFrame(draw); }
requestAnimationFrame(draw);
const gl = document.getElementById("g").getContext("webgl");
function paint(t) { if (gl) { gl.clearColor(Math.sin(t / 500) / 2 + 0.5, 0.2, 0.4, 1); gl.clear(gl.COLOR_BUFFER_BIT); } requestAnimationFrame(paint); }
requestAnimationFrame(paint);
</script>`;
}

/** The sign-in fixture: `/site/login?user=<a-z>` sets an HttpOnly cookie and a localStorage entry; `/site/` says who. */
export function siteHome(cookieUser: string | undefined): string {
  return `<!doctype html><meta charset=utf-8><title>Site</title>
<h1>${cookieUser === undefined ? "signed out" : `signed in as ${cookieUser}`}</h1>
<p id=ls>local: …</p>
<script>document.getElementById("ls").textContent = "local: " + (localStorage.getItem("who") || "none");</script>`;
}

export function siteLogin(user: string): string {
  return `<!doctype html><meta charset=utf-8><title>Signing in</title>
<script>localStorage.setItem("who", ${JSON.stringify(user)}); location.replace("/site/");</script>`;
}

/** The user named by a request's `sid` cookie (lowercase letters only), if any. */
export function cookieUser(cookieHeader: string | null): string | undefined {
  const m = /(?:^|;\s*)sid=([a-z]{1,32})(?:;|$)/.exec(cookieHeader ?? "");
  return m?.[1];
}

/** The pages the opt-in prompt probes load: each asks on a click (a user gesture, as a person's would be) and reports
 *  what the browser answered. */
export const PERMISSIONS_PROBE = `<!doctype html><meta charset=utf-8><title>Permissions probe</title><h1>Permissions probe</h1>
<button id=ask>Ask</button><ul id=out></ul>
<script>
const out = (k, v) => { const li = document.createElement("li"); li.textContent = k + ": " + v; document.getElementById("out").append(li); };
document.getElementById("ask").onclick = () => {
  navigator.mediaDevices?.getUserMedia({ video: true }).then(() => out("camera", "granted"), (e) => out("camera", e.name));
  navigator.mediaDevices?.getUserMedia({ audio: true }).then(() => out("microphone", "granted"), (e) => out("microphone", e.name));
  navigator.mediaDevices?.getDisplayMedia ? navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => out("screen", "granted"), (e) => out("screen", e.name)) : out("screen", "no API");
  navigator.geolocation?.getCurrentPosition(() => out("location", "granted"), (e) => out("location", "denied " + e.code));
  typeof Notification === "undefined" ? out("notifications", "no API") : Notification.requestPermission().then((r) => out("notifications", r), (e) => out("notifications", e.name));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  navigator.credentials?.create({ publicKey: { challenge, rp: { name: "Winter probe" }, user: { id: new Uint8Array(8), name: "probe", displayName: "Probe" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 5000 } }).then(() => out("passkey", "created"), (e) => out("passkey", e.name));
};
</script>`;

/** A public site that asks for a client certificate (a TLS handshake that requests one); it says what it received. */
export const CLIENT_CERT_PROBE_URL = "https://client.badssl.com/";

export const LAN_PROBE = `<!doctype html><meta charset=utf-8><title>LAN probe</title><h1>LAN probe</h1><ul id=out></ul>
<script>
const out = (k, v) => { const li = document.createElement("li"); li.textContent = k + ": " + v; document.getElementById("out").append(li); };
for (const [k, u] of [["lan", "http://192.168.1.1/"], ["mdns", "http://winter-probe-printer.local/"]]) {
  fetch(u, { mode: "no-cors", signal: AbortSignal.timeout(4000) }).then(() => out(k, "reached"), (e) => out(k, e.name));
}
// What no request handler sees: a WebSocket and WebTransport to a LAN address (the PAC belt's).
for (const [k, u] of [["websocket", "ws://192.168.1.1/"], ["websocket-label", "ws://router/"]]) {
  try { const ws = new WebSocket(u); ws.onopen = () => { out(k, "open"); ws.close(); }; ws.onerror = () => out(k, "error"); } catch (e) { out(k, e.name); }
}
if (typeof WebTransport === "function") {
  try { new WebTransport("https://192.168.1.1:4433/").ready.then(() => out("webtransport", "open"), (e) => out("webtransport", e.name)); } catch (e) { out("webtransport", e.name); }
} else out("webtransport", "no API");
</script>`;

/** A page's own RTCPeerConnection, as a fingerprinting script makes one: it gathers candidates (a host candidate would
 *  announce an mDNS name on the LAN) and is given a remote candidate on a LAN address (a STUN check would go there). */
export const WEBRTC_PROBE = `<!doctype html><meta charset=utf-8><title>WebRTC probe</title><h1>WebRTC probe</h1><ul id=out></ul>
<script>
const out = (k, v) => { const li = document.createElement("li"); li.textContent = k + ": " + v; document.getElementById("out").append(li); };
(async () => {
  try {
    const found = [];
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("probe");
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) found.push(e.candidate.candidate); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((done) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") done(); }; setTimeout(done, 5000); });
    out("candidates", found.length);
    const other = new RTCPeerConnection({ iceServers: [] });
    await other.setRemoteDescription(pc.localDescription);
    await other.setLocalDescription(await other.createAnswer());
    await pc.setRemoteDescription(other.localDescription);
    await pc.addIceCandidate({ candidate: "candidate:1 1 udp 2122260223 192.168.1.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 });
    await new Promise((r) => setTimeout(r, 3000));
    let pairs = 0, requests = 0;
    (await pc.getStats()).forEach((s) => { if (s.type === "candidate-pair") { pairs++; requests += s.requestsSent || 0; } });
    out("pairs", pairs + ", " + requests + " check(s) sent");
  } catch (e) { out("webrtc", e.name); }
})();
</script>`;

/** By hand with the user before merge (it needs a Release-signed Winter.app and the daemon). */
export const HEADLESS_LIVE_BY_HAND: readonly string[] = [
  "First start (before merge): a Release-signed Winter.app's daemon starts Winter Headless with Winter.app itself closed; the helper carries Winter's one Chromium (the CEF framework and its \"Winter Helper\" bundles in its own Contents/Frameworks; Winter.app's own holds none); a headless tab answers state(), screenshot() (a vision model), a click and typing, an out-of-process iframe, a dialog and a file chooser; killing the daemon ends the helper (its pipe's EOF); document.modelContext exists (--enable-features=WebMCP).",
  "With the daemon (not this script): note which name a macOS prompt would carry, if --prompt-probes ever raised one here.",
];

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────

class Aborted extends Error {}

/** A child process whose stdout lines are parsed as they come. */
class Lines<T> {
  readonly items: T[] = [];
  private buf = "";
  constructor(readonly child: ChildProcess, parse: (line: string) => T | undefined) {
    child.stdout?.on("data", (c: Buffer) => {
      this.buf += c.toString("utf8");
      for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
        const v = parse(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
        if (v !== undefined) this.items.push(v);
      }
    });
  }
  stop(): void {
    try { this.child.stdin?.end(); } catch { /* gone */ }
    try { this.child.kill("SIGTERM"); } catch { /* gone */ }
  }
}

/** The "daemon" of the isolation check's last step: a separate process that owns a pool, opens one tab and waits to
 *  be killed. */
async function childPool(home: string, app: string, verify: boolean): Promise<void> {
  const { executable } = helperNames(app);
  const pool = new HeadlessPool({
    home, enabled: () => true,
    resolve: () => ({ engine: "winter", app, executable, requirement: headlessRequirementFor("dist", true) }),
    ...(verify ? { verify: processSatisfiesRequirement } : {}),
  });
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>child</title><h1>child</h1>", { headers: { "content-type": "text/html" } }) });
  await pool.createTab({ sessionId: "s_child", url: `http://localhost:${page.port}/` });
  process.stdout.write(`${JSON.stringify({ helperPid: pool.pid })}\n`);
  await new Promise(() => {});
}

async function main(): Promise<void> {
  if (process.env.WINTER_CU_LIVE_TESTS !== "1") {
    console.error("cu-live headless: opt-in — set WINTER_CU_LIVE_TESTS=1 (the controller runs it, with the user's go-ahead)");
    process.exit(64);
  }
  if (process.argv[2] === "--child-pool") {
    await childPool(process.argv[3]!, process.argv[4]!, process.argv[5] === "verify");
    return;
  }
  const parsed = parseHeadlessOptions(process.argv.slice(2), process.env);
  if ("error" in parsed) { console.error(`cu-live headless: ${parsed.error}`); process.exit(64); }
  const o = parsed;
  const { executable } = helperNames(o.app);
  if (!existsSync(executable)) { console.error(`cu-live headless: no helper executable at ${executable}`); process.exit(64); }

  const log = (line: string): void => console.log(line);
  const tool = buildTool(log);
  const session = parseSessionReading(spawnSync(tool, ["session"], { encoding: "utf8" }).stdout ?? "");
  const unusable = screenUnavailable(session ?? null);
  if (unusable !== undefined) { console.error(`cu-live headless: refusing — ${unusable.what}`); process.exit(75); }

  const root = mkdtempSync(join(tmpdir(), "winter-cu-live-headless-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  // Everything the run owns, for the cleanup (and the hard exit).
  const loads: ChildProcess[] = [];
  let child: ChildProcess | undefined;
  const helperPids = new Set<number>();
  const killAll = (): void => {
    for (const l of loads.splice(0)) { try { l.kill("SIGKILL"); } catch { /* gone */ } }
    try { child?.kill("SIGKILL"); } catch { /* gone */ }
    for (const pid of helperPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  };
  const stop = installStopHandler({
    on: (signal, handler) => { process.on(signal, handler); },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    exit: (code) => process.exit(code),
    log,
    onHardExit: killAll,
  });
  const stopCheck = (): void => { if (stop.requested !== undefined && !stop.inCleanup) throw new Aborted(`stopped by ${stop.requested}`); };

  // ── the fixtures (loopback) ──
  const tone = wavTone();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const html = (body: string, headers: Record<string, string> = {}): Response => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
      let m: RegExpExecArray | null;
      if ((m = /^\/media\/(\d+)$/.exec(url.pathname)) !== null) return html(mediaPage(Number(m[1])));
      if ((m = /^\/img\/(\d+)-(\d+)\.svg$/.exec(url.pathname)) !== null) return new Response(heavySvg(Number(m[1]) * 10 + Number(m[2])), { headers: { "content-type": "image/svg+xml" } });
      if (url.pathname === "/tone.wav") return new Response(tone, { headers: { "content-type": "audio/wav" } });
      if (url.pathname === "/site/login") {
        const user = url.searchParams.get("user") ?? "";
        if (!/^[a-z]{1,32}$/.test(user)) return new Response("bad user", { status: 400 });
        return html(siteLogin(user), { "set-cookie": `sid=${user}; HttpOnly; SameSite=Lax; Path=/site` });
      }
      if (url.pathname === "/site/") return html(siteHome(cookieUser(req.headers.get("cookie"))));
      if (url.pathname === "/slow") return html("<!doctype html><title>Slow</title><h1>waiting</h1>");
      if (url.pathname === "/probe/permissions") return html(PERMISSIONS_PROBE);
      if (url.pathname === "/probe/lan") return html(LAN_PROBE);
      if (url.pathname === "/probe/webrtc") return html(WEBRTC_PROBE);
      return new Response("not found", { status: 404 });
    },
  });
  const BASE = `http://localhost:${server.port}`;

  // ── the pool and the engine ──
  const metrics: PrimitiveMetric[] = [];
  const pool = new HeadlessPool({
    home, enabled: () => true,
    resolve: () => ({ engine: "winter", app: o.app, executable, requirement: headlessRequirementFor("dist", true) }),
    ...(o.verify ? { verify: processSatisfiesRequirement } : {}),
    metric: (m) => metrics.push(m),
    log: (l) => log(`  (${l})`),
  });
  const registry = new BrowserBackendRegistry();
  registry.register(pool, { family: "headless", name: HEADLESS_NAME, instanceKey: "headless" });
  const engine = new BrowserEngine({
    registry, mintWinterTab: () => "unused", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({ cwd: root, title: "headless live check" }),
    home, headlessSessionEnded: (sid) => pool.disposeSession(sid), headlessReason: () => pool.reason,
  });
  const locks = new TargetLocks();
  const diffBases = new DiffBases();
  const facts: SessionFacts = { policy: "ask", mode: "code" };
  let runs = 0;
  /** One script's run in a session (its locks, its result builder). */
  const scope = (sessionId: string) => {
    const runId = `r${++runs}`;
    const builder = new ResultBuilder();
    const abort = new AbortController();
    const held = new Map<string, () => void>();
    const metric: PrimitiveMetric = { ts: 0, sessionId, callId: "cv2", primitive: "x", ms: 0, helperMs: 0 };
    const s: TabRunScope = {
      sessionId, runId, callId: "cv2", vision: true, signal: abort.signal, live: () => {}, timeLeft: () => 120_000, clampWait: (ms) => Math.min(ms, 120_000),
      lock: async (key, label) => { if (!held.has(key)) held.set(key, await locks.acquire(key, { runId, sessionId }, { label })); },
      lockRun: (key) => locks.holder(key)?.runId, authorize: async () => { throw new Error("no card may be raised for a headless tab"); },
      sessionPolicy: () => facts.policy, sessionFacts: () => facts, siteCard: async () => ({ approved: false }), persistentlyAllowed: () => false, granted: () => false,
      builder, keepImage: (img) => ({ image: "img", width: img.width, height: img.height }), lastTargetShot: new Map(), acted: new Set(), diffBases, metric,
      noteSite: () => {}, noteBrowser: () => {}, trusted: () => {},
    };
    return {
      s,
      open: async (url: string) => await engine.global(s, "browsers.open", { url, browser: "headless" }) as TabHandle,
      p: (tab: TabHandle, primitive: string, args: Record<string, unknown> = {}) => engine.primitive(s, tab.targetId, primitive, args),
      end: () => { for (const r of held.values()) r(); held.clear(); abort.abort(); engine.runEnded(sessionId, runId); },
    };
  };
  const failsWith = async (p: Promise<unknown>, kind: string): Promise<string | undefined> => {
    try { await p; return undefined; } catch (err) { return err instanceof AutomationFailure && err.kind === kind ? err.message : undefined; }
  };
  /** What a call did, for a check's detail: "resolved", or the error's kind and message. */
  const outcome = async (p: Promise<unknown>): Promise<{ kind?: string; text: string }> => {
    try { await p; return { text: "resolved" }; } catch (err) {
      return err instanceof AutomationFailure ? { kind: err.kind, text: `${err.kind}: ${err.message}` } : { text: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  };
  const waitUntil = async (what: () => boolean, ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (what()) return true; await Bun.sleep(50); }
    return what();
  };

  // ── the samplers ──
  const monitor = new Lines<MonitorSample>(spawn(tool, ["monitor", "--interval-ms", "20"], { stdio: ["pipe", "pipe", "ignore"] }), parseMonitorLine);
  const windowsSeen = new Map<number, { pid: number; onScreen: boolean; layer: number; firstAt: number }>();
  const appTypes = new Map<string, number>();
  const treeSeen = new Set<number>();
  let sampling = true;
  const windowSampler = (async () => {
    while (sampling) {
      const pid = pool.pid;
      if (pid !== undefined) helperPids.add(pid);
      if (helperPids.size > 0) {
        // The helper and every process it started (its CEF subprocesses), by parent pid.
        const ps = Bun.spawn(["/bin/ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } });
        const tree = processTree(await new Response(ps.stdout).text(), helperPids);
        for (const p of tree) treeSeen.add(p);
        const w = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", WINDOW_LIST_JXA], { stdout: "pipe", stderr: "ignore" });
        for (const win of windowsOf(await new Response(w.stdout).text(), tree)) {
          const seen = windowsSeen.get(win.id);
          if (seen === undefined) windowsSeen.set(win.id, { pid: win.pid, onScreen: win.onScreen, layer: win.layer, firstAt: Date.now() });
          else if (win.onScreen) seen.onScreen = true;
        }
        if (pid !== undefined) {
          const asn = spawnSync("/usr/bin/lsappinfo", ["find", `pid=${pid}`], { encoding: "utf8" }).stdout?.trim() ?? "";
          const type = asn.length === 0 ? "not registered" : parseApplicationType(spawnSync("/usr/bin/lsappinfo", ["info", "-only", "ApplicationType", asn], { encoding: "utf8" }).stdout ?? "") ?? "unknown";
          appTypes.set(type, (appTypes.get(type) ?? 0) + 1);
        }
      }
      await Bun.sleep(250);
    }
  })();

  const results: ScenarioResult[] = [];
  const measures: Record<string, unknown> = {};
  const scenario = async (name: string, group: string, fn: () => Promise<{ checks: Check[]; note?: string }>): Promise<void> => {
    stopCheck();
    const t0 = Date.now();
    let checks: Check[];
    let note: string | undefined;
    try { ({ checks, note } = await fn()); } catch (err) {
      if (err instanceof Aborted) throw err;
      checks = [check("ran", false, err instanceof Error ? `${err.name}: ${err.message}` : String(err))];
    }
    const r: ScenarioResult = { name, group, status: statusOf(checks), ms: Date.now() - t0, checks, ...(note === undefined ? {} : { note }) };
    results.push(r);
    log(`${r.status === "pass" ? "PASS" : "FAIL"} ${name} (${r.ms} ms)${note === undefined ? "" : ` — ${note}`}`);
    for (const c of checks) if (!c.ok) log(`    ✗ ${c.name}${c.detail === undefined ? "" : ` — ${c.detail.slice(0, 400)}`}`);
  };

  const startedAt = Date.now();
  let exitCode = 1;
  try {
    // Wait for the monitor's first samples (the baseline).
    if (!(await waitUntil(() => monitor.items.length >= 5, 5_000))) throw new Error("the monitor gave no samples");
    if (o.userTyping) {
      log("--user-typing: put another app in front now and keep typing in it until the run says it is done — starting in 10 s");
      await Bun.sleep(10_000);
    }
    const from = Date.now();

    // ── view: never move the view ──
    if (o.checks.has("view")) {
      await scenario("view: 10 headless tabs at once on media-heavy pages, cold — read and closed", "view", async () => {
        if (o.load) for (let i = 0; i < cpus().length; i++) loads.push(spawn("/usr/bin/yes", [], { stdio: ["ignore", "ignore", "ignore"] }));
        const a = scope("s_view_a"); const b = scope("s_view_b");
        const t0 = Date.now();
        let firstState: number | undefined;
        const open = async (sc: ReturnType<typeof scope>, n: number): Promise<TabHandle> => {
          const tab = await sc.open(`${BASE}/media/${n}`);
          firstState ??= Date.now() - t0;
          return tab;
        };
        const tabs = await Promise.all([...[0, 1, 2, 3, 4].map((n) => open(a, n).then((t) => [a, t, n] as const)), ...[5, 6, 7, 8, 9].map((n) => open(b, n).then((t) => [b, t, n] as const))]);
        const allOpen = Date.now() - t0;
        for (const l of loads.splice(0)) l.kill("SIGKILL");
        const texts = await Promise.all(tabs.map(async ([sc, tab, n]) => ({ n, text: await sc.p(tab, "text", { emit: false }) as string })));
        await Promise.all(tabs.map(([sc, tab]) => sc.p(tab, "close")));
        a.end(); b.end();
        measures.coldStart = { firstStateMs: firstState, allTenMs: allOpen, loaded: o.load };
        return {
          checks: [
            check("all 10 opened", tabs.length === 10),
            check("each text() read its own page", texts.every(({ n, text }) => text.includes(`Media ${n}`)), texts.filter(({ n, text }) => !text.includes(`Media ${n}`)).map(({ n }) => n).join(", ")),
            check("all closed", await waitUntil(() => pool.tabCount() === 0, 3_000), `${pool.tabCount()} left`),
          ],
          note: `cold start${o.load ? " on a loaded Mac" : ""}: the first state after ${firstState ?? "?"} ms, all 10 after ${allOpen} ms`,
        };
      });
      await scenario("view: the same again, warm", "view", async () => {
        const a = scope("s_view_a"); const b = scope("s_view_b");
        const t0 = Date.now();
        const tabs = await Promise.all([...[10, 11, 12, 13, 14].map(async (n) => [a, await a.open(`${BASE}/media/${n}`), n] as const), ...[15, 16, 17, 18, 19].map(async (n) => [b, await b.open(`${BASE}/media/${n}`), n] as const)]);
        const allOpen = Date.now() - t0;
        const texts = await Promise.all(tabs.map(async ([sc, tab, n]) => ({ n, text: await sc.p(tab, "text", { emit: false }) as string })));
        await Promise.all(tabs.map(([sc, tab]) => sc.p(tab, "close")));
        a.end(); b.end();
        measures.warm = { allTenMs: allOpen };
        return {
          checks: [check("each text() read its own page", texts.every(({ n, text }) => text.includes(`Media ${n}`))), check("all closed", await waitUntil(() => pool.tabCount() === 0, 3_000))],
          note: `warm: all 10 after ${allOpen} ms`,
        };
      });
    }

    // ── memory: at 1, 8 and 24 tabs; the caps ──
    if (o.checks.has("memory")) {
      await scenario("memory: the helper's memory at 1, 8 and 24 tabs; a session's 9th and the 25th tab are TargetBusy", "memory", async () => {
        const sessions = ["s_mem_1", "s_mem_2", "s_mem_3"].map((sid) => ({ sid, sc: scope(sid) }));
        const rss: Record<string, string> = {};
        const sample = async (label: string): Promise<void> => {
          await Bun.sleep(1_500);
          const pid = pool.pid;
          rss[label] = `${mib(pid === undefined ? undefined : processTreeFootprint(pid))} (resident-size sum ${mib(pid === undefined ? undefined : processTreeRss(pid))})`;
        };
        let n = 100;
        let guard: string | undefined;
        const openIn = async (i: number, count: number): Promise<void> => {
          for (let k = 0; k < count && guard === undefined; k++) {
            try { await sessions[i]!.sc.open(`${BASE}/media/${n++}`); } catch (err) {
              if (err instanceof AutomationFailure && err.kind === "TargetBusy" && /memory/i.test(err.message)) guard = `the memory guard refused tab ${pool.tabCount() + 1}: ${err.message}`;
              else throw err;
            }
          }
        };
        await openIn(0, 1); await sample("1 tab");
        await openIn(0, 7); await sample("8 tabs");
        const ninth = guard === undefined ? await failsWith(sessions[0]!.sc.open(`${BASE}/media/${n++}`), "TargetBusy") : "skipped (memory guard)";
        await openIn(1, 8); await openIn(2, 8); if (guard === undefined) await sample("24 tabs");
        const extra = scope("s_mem_4");
        const twentyFifth = guard === undefined ? await failsWith(extra.open(`${BASE}/media/${n++}`), "TargetBusy") : "skipped (memory guard)";
        for (const { sid, sc } of sessions) { sc.end(); engine.turnEnded(sid); }
        extra.end();
        measures.memory = rss;
        if (guard !== undefined) measures.memoryGuard = guard;
        const allClosed = await waitUntil(() => pool.tabCount() === 0, 5_000);
        // At once, as the next scenario would: the guard never stays tripped once the tabs are gone.
        const after = scope("s_mem_after");
        let reopened: string;
        try { await after.open(`${BASE}/media/${n++}`); reopened = "opened"; } catch (err) { reopened = err instanceof Error ? `${err.name}: ${err.message}` : String(err); }
        after.end(); engine.turnEnded("s_mem_after");
        return {
          checks: [
            check("a session's 9th tab is TargetBusy", ninth !== undefined, String(ninth)),
            check("the 25th tab is TargetBusy", twentyFifth !== undefined, String(twentyFifth)),
            check("every tab closed at the turns' end", allClosed, `${pool.tabCount()} left`),
            check("right after, a new tab opens (the guard is not left tripped)", reopened === "opened", reopened),
          ],
          note: `memory ${Object.entries(rss).map(([k, v]) => `${k}: ${v}`).join(", ")}${guard === undefined ? "" : ` — ${guard}`}`,
        };
      });
    }

    // ── isolation and lifecycle ──
    if (o.checks.has("isolation")) {
      await scenario("isolation: two sessions signed in as different users each see only their own", "isolation", async () => {
        const alice = scope("s_alice"); const bob = scope("s_bob");
        const [ta, tb] = await Promise.all([alice.open(`${BASE}/site/login?user=alice`), bob.open(`${BASE}/site/login?user=bob`)]);
        await Promise.all([alice.p(ta, "waitFor", { cond: { text: "signed in as alice" }, timeoutMs: 5_000 }), bob.p(tb, "waitFor", { cond: { text: "signed in as bob" }, timeoutMs: 5_000 })]);
        const [xa, xb] = await Promise.all([alice.p(ta, "text", { emit: false }) as Promise<string>, bob.p(tb, "text", { emit: false }) as Promise<string>]);
        const second = await alice.open(`${BASE}/site/`);
        const xa2 = await alice.p(second, "text", { emit: false }) as string;
        alice.end(); bob.end();
        return { checks: [
          check("alice sees alice (cookie and localStorage), never bob", xa.includes("signed in as alice") && xa.includes("local: alice") && !xa.includes("bob"), xa.slice(0, 200)),
          check("bob sees bob, never alice", xb.includes("signed in as bob") && xb.includes("local: bob") && !xb.includes("alice"), xb.slice(0, 200)),
          check("a second tab of alice's session shares her sign-in", xa2.includes("signed in as alice") && xa2.includes("local: alice"), xa2.slice(0, 200)),
        ] };
      });
      await scenario("isolation: after a session's runtime ends its context is gone; the other's stays", "isolation", async () => {
        engine.sessionEnded("s_alice", "idle");
        const alice = scope("s_alice"); const bob = scope("s_bob");
        const ta = await alice.open(`${BASE}/site/`);
        const tb = await bob.open(`${BASE}/site/`);
        const [xa, xb] = await Promise.all([alice.p(ta, "text", { emit: false }) as Promise<string>, bob.p(tb, "text", { emit: false }) as Promise<string>]);
        alice.end(); bob.end();
        return { checks: [
          check("alice's next tab is signed out, her localStorage gone", xa.includes("signed out") && xa.includes("local: none"), xa.slice(0, 200)),
          check("bob is still signed in", xb.includes("signed in as bob") && xb.includes("local: bob"), xb.slice(0, 200)),
        ] };
      });
      await scenario("isolation: tabs close at the turn's end; handoff() keeps one for one more turn; keep() is refused", "isolation", async () => {
        engine.turnEnded("s_alice"); engine.turnEnded("s_bob");
        const closedAtTurnEnd = await waitUntil(() => pool.tabCount("s_alice") === 0 && pool.tabCount("s_bob") === 0, 3_000);
        const h = scope("s_hand");
        const tab = await h.open(`${BASE}/site/`);
        const refused = await failsWith(h.p(tab, "keep"), "NotAllowed");
        await h.p(tab, "handoff");
        h.end();
        engine.turnEnded("s_hand");
        await Bun.sleep(500);
        const keptOneTurn = pool.tabCount("s_hand") === 1;
        engine.turnEnded("s_hand");
        const goneAfter = await waitUntil(() => pool.tabCount("s_hand") === 0, 3_000);
        return { checks: [
          check("the turn's end closed both sessions' tabs", closedAtTurnEnd, `${pool.tabCount()} open`),
          check("keep() is NotAllowed, in the headless sentence", refused === HEADLESS_KEEP, String(refused)),
          check("handoff() kept the tab through one turn's end", keptOneTurn),
          check("…and the next turn's end closed it", goneAfter),
        ] };
      });
      await scenario("isolation: the helper killed mid-script → TargetLost; the next open relaunches it", "isolation", async () => {
        const k = scope("s_kill");
        const tab = await k.open(`${BASE}/slow`);
        const before = pool.pid;
        const waiting = outcome(k.p(tab, "waitFor", { cond: { text: "never shows" }, timeoutMs: 20_000 }));
        await Bun.sleep(1_000);
        if (before !== undefined) process.kill(before, "SIGKILL");
        const lost = await waiting;
        const next = await failsWith(k.p(tab, "text", { emit: false }), "TargetLost");
        const again = await k.open(`${BASE}/site/`);
        const after = pool.pid;
        const read = await k.p(again, "text", { emit: false }) as string;
        k.end();
        engine.turnEnded("s_kill");
        return { checks: [
          check("the waitFor running when it died is TargetLost", lost.kind === "TargetLost", lost.text),
          check("the next call on that tab is TargetLost", next !== undefined, String(next)),
          check("the next browsers.open relaunched it (a new pid) and works", after !== undefined && after !== before && read.includes("signed out"), `${before} → ${after}`),
        ] };
      });
      await scenario("isolation: a daemon that dies takes the helper with it (the pipe's EOF)", "isolation", async () => {
        const childHome = join(root, "child-home");
        mkdirSync(childHome, { recursive: true });
        child = spawn(process.execPath, [import.meta.path, "--child-pool", childHome, o.app, o.verify ? "verify" : "no-verify"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } });
        const lines = new Lines<{ helperPid?: number }>(child, (l) => { try { return JSON.parse(l) as { helperPid?: number }; } catch { return undefined; } });
        if (!(await waitUntil(() => lines.items.length > 0, 30_000))) throw new Error("the child pool never reported its helper");
        const pid = lines.items[0]!.helperPid;
        if (pid === undefined) throw new Error("the child pool's helper had no pid");
        helperPids.add(pid);
        child.kill("SIGKILL");
        const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
        const gone = await waitUntil(() => !alive(), 5_000);
        if (!gone) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        rmSync(childHome, { recursive: true, force: true });
        return { checks: [check("the helper exited within 5 s of its daemon's SIGKILL", gone, gone ? "" : `pid ${pid} still alive — killed by the run`)] };
      });
    }

    // ── the opt-in prompt probes ──
    if (o.promptProbes) {
      log("--prompt-probes: these pages ask for the camera, microphone, location and notifications, fetch a LAN address and an mDNS name, open a WebSocket and WebTransport to the LAN and make an RTCPeerConnection with a LAN candidate — a macOS prompt, if one appears, is the finding (answer Don't Allow)");
      await scenario("probes: permission requests (with a gesture), a passkey, LAN fetches, sockets and WebRTC, and a client certificate raise no prompt", "probes", async () => {
        const p = scope("s_probe");
        const t0 = Date.now();
        const perms = await p.open(`${BASE}/probe/permissions`);
        const state = await p.p(perms, "state", { full: true, emit: false }) as string;
        const ask = Number(/\[(\d+)\] button "Ask"/.exec(state)?.[1]);
        if (!Number.isInteger(ask)) throw new Error(`no Ask button in the probe page: ${state.slice(0, 300)}`);
        await p.p(perms, "click", { target: ask });
        const lan = await p.open(`${BASE}/probe/lan`);
        const rtc = await p.open(`${BASE}/probe/webrtc`);
        let cert = "";
        try {
          const ct = await p.open(CLIENT_CERT_PROBE_URL);
          await Bun.sleep(3_000);
          cert = (await p.p(ct, "text", { emit: false }) as string).replace(/\s+/g, " ").slice(0, 200);
        } catch (err) {
          cert = `could not load (${err instanceof Error ? err.message.slice(0, 160) : "error"})`;
        }
        await Bun.sleep(6_000);
        const [xp, xl, xr] = await Promise.all([p.p(perms, "text", { emit: false }) as Promise<string>, p.p(lan, "text", { emit: false }) as Promise<string>,
          p.p(rtc, "text", { emit: false }) as Promise<string>]);
        p.end();
        engine.turnEnded("s_probe");
        const prompt = promptAppeared(monitor.items, t0, Date.now());
        return {
          checks: [check("no permission prompt came to the front", prompt === undefined, prompt === undefined ? "" : `${prompt.front} at +${prompt.t - t0} ms`)],
          note: `the pages read: ${xp.replace(/\s+/g, " ").slice(0, 400)} | ${xl.replace(/\s+/g, " ").slice(0, 300)} | ${xr.replace(/\s+/g, " ").slice(0, 200)} | the client-certificate site: ${cert}`,
        };
      });
    }

    // ── across the whole run ──
    const to = Date.now();
    await Bun.sleep(300);
    const changes = attributeFrontChanges(monitor.items, from, to, helperPids);
    const prompt = promptAppeared(monitor.items, from, to);
    const locked = screenUnavailableAt(monitor.items, from, to);
    const onScreen = [...windowsSeen.entries()].filter(([, w]) => w.onScreen);
    const foreground = appTypes.get("Foreground") ?? 0;
    measures.frontChanges = changes;
    measures.windows = [...windowsSeen.entries()].map(([id, w]) => ({ id, ...w }));
    measures.helperProcesses = treeSeen.size;
    measures.applicationTypes = Object.fromEntries(appTypes);
    measures.helperPids = [...helperPids];
    const keysWatched = monitor.items.some((s) => s.hwKeys === true);
    measures.hardwareKeysWatched = keysWatched;
    const runChecks = [
      check("the helper was never the frontmost app", !changes.some((c) => c.by === "helper"), changes.filter((c) => c.by === "helper").map((c) => c.what).join("; ")),
      check(o.userTyping ? "no change of the front app or Space without the user's input just before" : "the frontmost app and the Space never changed",
        o.userTyping ? !changes.some((c) => c.by === "unexplained") : changes.length === 0,
        changes.map((c) => `+${c.t - from} ms ${c.what} (${c.by})`).join("; ")),
      check("no permission prompt came to the front", prompt === undefined, prompt === undefined ? "" : `${prompt.front} at +${prompt.t - from} ms`),
      check("no process of the helper's tree (the helper, its CEF subprocesses) ever owned an on-screen window", onScreen.length === 0, onScreen.map(([id, w]) => `window ${id} of pid ${w.pid}, layer ${w.layer}`).join("; ")),
      check("the helper was never a Foreground app (no Dock tile)", foreground === 0, JSON.stringify(Object.fromEntries(appTypes))),
      check("the screen stayed usable (not locked)", locked === undefined, locked === undefined ? "" : locked.what),
    ];
    results.push({ name: "the whole run: never move the view", group: "view", status: statusOf(runChecks), ms: to - from, checks: runChecks,
      note: `${changes.length} front/Space change(s) (${changes.filter((c) => c.by === "user").length} the user's${keysWatched ? "" : "; the user's keys were not visible to the monitor (no Input Monitoring), so a keyboard-only switch reads as unexplained"}); ${windowsSeen.size} window(s) owned by the helper's ${treeSeen.size} process(es) (${onScreen.length} on screen); application types ${JSON.stringify(Object.fromEntries(appTypes))}` });

    // The daemon's stop ends the helper and everything it started. "Everything it started" is its process tree as it
    // is just before the stop, with every process the run saw in it — never the app path alone (processesInside).
    const ours = new Set(treeSeen);
    const lastHelper = pool.pid;
    if (lastHelper !== undefined) helperPids.add(lastHelper);
    for (const p of processTree(spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout ?? "", helperPids)) ours.add(p);
    pool.stop();
    const inside = (): Array<{ pid: number; command: string }> => processesInside(spawnSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout ?? "", o.app, ours);
    const clean = await waitUntil(() => inside().length === 0, 8_000);
    const left = inside();
    results.push({ name: "the pool's stop leaves no helper process behind", group: "isolation", status: clean ? "pass" : "fail", ms: 0,
      checks: [check("nothing from the helper app is still running 8 s after the stop", clean, left.map((p) => `${p.pid} ${p.command.slice(0, 120)}`).join("; "))] });
    for (const p of left) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    exitCode = results.every((r) => r.status !== "fail") ? 0 : 1;
  } catch (err) {
    if (err instanceof Aborted) { log(err.message); exitCode = stop.exitCode; }
    else { results.push({ name: "the run", group: "run", status: "fail", ms: Date.now() - startedAt, checks: [check("ran", false, err instanceof Error ? err.stack ?? err.message : String(err))] }); exitCode = 1; }
  } finally {
    stop.inCleanup = true;
    sampling = false;
    await windowSampler.catch(() => {});
    engine.stop();
    pool.stop();
    killAll();
    monitor.stop();
    server.stop(true);
    await Bun.sleep(500);
    if (!o.keepTemp) rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(o.report), { recursive: true });
    writeFileSync(o.report, `${JSON.stringify({
      startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, app: o.app, verified: o.verify,
      options: { userTyping: o.userTyping, load: o.load, promptProbes: o.promptProbes, checks: [...o.checks] },
      results, measures, metrics: metrics.filter((m) => m.primitive.startsWith("headless.")), byHand: HEADLESS_LIVE_BY_HAND,
    }, null, 2)}\n`);
    console.log(`\n${renderTable(results)}`);
    console.log(`report: ${o.report}${o.keepTemp ? ` (temp kept: ${root})` : ""}`);
    console.log("by hand, with the user:");
    for (const d of HEADLESS_LIVE_BY_HAND) console.log(`  - ${d}`);
    process.exit(exitCode);
  }
}

if (import.meta.main) await main();
