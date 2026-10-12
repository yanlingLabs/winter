// A FAKE Winter Headless for the pool's tests: it speaks the helper's wire (apple/Winter/Sources/HeadlessHelper/
// HeadlessWire.swift) with no browser at all. The pool spawns it exactly as it spawns the real helper — the pipe on fds 3
// (commands in) and 4 (everything out) — through `/bin/sh`, which hands those two to this script as its stdin and stdout
// (Bun, running this script, keeps its own stdin and stdout reliably alive and flowing; a pending read on an extra
// descriptor alone let it end early).
//
// Its behaviour is chosen by its arguments (before the helper's own `--winter-cache-root=…`):
//   --fake-mode=normal (default) | no-hello | bad-protocol | no-present (a helper from before the `present` feature)
//   --fake-log=<file>    one JSON line per command it read (`{op, params}`), for the test to inspect
// and by the URLs it is asked to open:
//   http://crash.test/        — it answers, then exits 1 (a crash of the whole browser)
//   http://renderer.test/     — it answers, then reports the tab gone `crashed` (one renderer)
//   http://events.test/       — it answers, then sends events for the tab (one off the allowlist, one for an unknown tab)
//   http://wedge.test/        — it answers, then never answers a cdp.send for that tab (a page busy-looping in its
//                               renderer: everything else, tabs.live included, is still answered)
//   http://hang.test/         — it answers, then — from that tab's first cdp.send on — answers nothing at all (the
//                               helper's own main thread stuck)
//   http://component.test/    — it answers, then installs a component in its cache root (as Chromium's updater does)
//                               beside a run's own data (Default/Cookies)
//   http://notice.test/       — it answers, then reports a refused popup twice and a refused local-network request
//                               once (plus a notice of an unknown kind, and one for an unknown tab)
//   http://slow-close.test/   — its tab.close is answered 300 ms late, with a `closed` line in the log just before (a
//                               page whose renderer takes a while to go)
//   http://slow-send.test/    — every cdp.send for it is answered 300 ms late, with an `answered` line in the log just
//                               before (an agent command in flight)
//   http://no-viewer.test/    — presented, its viewer never comes (no `headless.presentationStarted`)
//   http://viewer-leaves.test/ — presented, its viewer is accepted and then leaves 150 ms later (`presentationEnded`)
//   http://opens-window.test/ — presented, its page opens a window once its viewer is accepted (`headless.popupOpened`,
//                               a tab of the fake's own minting at http://window.test/)
//   http://notice-held.test/  — presented, its page tries the local network once its viewer is accepted (the person's
//                               doing) and again when it is unpresented (the agent's time again)
//   http://resizes.test/      — presented, its page is laid out in the panel's size once its viewer is accepted
//                               (`headless.viewChanged` 704×900 at 2, then a scale alone, 704×900 at 1, and one that is
//                               not a view at all), and in the agent's own again when it is unpresented (1280×800 at 1)
// Any other presented tab's viewer is accepted 20 ms after `headless.present` is answered.
// It exits 0 on EOF, like the real helper.
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argValue = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = argValue("fake-mode") ?? "normal";
const logFile = argValue("fake-log");
const cacheRoot = argValue("winter-cache-root");
const entries = (() => { try { return cacheRoot === undefined ? [] : readdirSync(cacheRoot).sort(); } catch { return []; } })();
if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ op: "started", params: { cacheRoot, entries } })}\n`);
const linkId = "h-fake";
// The real helper runs until its pipe closes; so does this.
const keepAlive = setInterval(() => {}, 1 << 30);
// Anything that goes wrong in the fake is said on stderr in the helper's own log form (the pool logs those lines).
process.on("uncaughtException", (err) => { process.stderr.write(`WinterHeadless: fake helper error: ${String((err as Error)?.stack ?? err).slice(0, 500).replace(/\n/g, " | ")}\n`); process.exitCode = 3; });
const tabs = new Map<string, { sessionId: string; url: string }>();

const send = (method: string, params: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); };
const reply = (cmdId: string, result: unknown): void => send("browserLink.result", { linkId, cmdId, ok: true, result });
const fail = (cmdId: string, code: string, message: string, data?: Record<string, unknown>): void =>
  send("browserLink.result", { linkId, cmdId, ok: false, error: { code, message, ...(data === undefined ? {} : { data }) } });

if (mode !== "no-hello") {
  send("headless.hello", { protocol: mode === "bad-protocol" ? 99 : 1, linkId, pid: process.pid, version: "0.0.0-fake", ...(mode === "no-present" ? {} : { features: ["present"] }) });
}
/** The live presentations, by tab: the nonce the daemon named. */
const presented = new Map<string, string>();
let services = 0;

let buffer = "";
void (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) handle(JSON.parse(line) as { params: { linkId: string; cmdId: string; op: string; params: Record<string, unknown> } });
    }
  }
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ op: "eof", params: {} })}\n`);
  clearInterval(keepAlive);
  process.stdout.end(() => process.exit(0));
})();

let hung = false;

function handle(m: { params: { linkId: string; cmdId: string; op: string; params: Record<string, unknown> } }): void {
  const { cmdId, op, params: p } = m.params;
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ op, params: p })}\n`);
  if (hung) return;
  switch (op) {
    case "tab.ensure": {
      const tabId = String(p.tabId);
      const known = tabs.get(tabId);
      if (known === undefined) {
        if (typeof p.url !== "string") return fail(cmdId, "tab_gone", "the headless tab is gone");
        tabs.set(tabId, { sessionId: String(p.sessionId), url: p.url });
      } else if (known.sessionId !== p.sessionId) {
        return fail(cmdId, "not_allowed", "this headless tab belongs to another session");
      }
      const t = tabs.get(tabId)!;
      reply(cmdId, { url: t.url, title: `title of ${t.url}`, loading: false, sessionId: t.sessionId, viewport: [1280, 800], dpr: 1 });
      if (t.url === "http://crash.test/") setTimeout(() => process.exit(1), 20);
      if (t.url === "http://component.test/" && cacheRoot !== undefined) {
        // What Chromium's component updater installs (a version folder with a manifest), beside a run's own data.
        mkdirSync(join(cacheRoot, "PKIMetadata", "1798"), { recursive: true });
        writeFileSync(join(cacheRoot, "PKIMetadata", "1798", "manifest.json"), '{"name":"pkiMetadata","version":"1798"}');
        mkdirSync(join(cacheRoot, "Default"), { recursive: true });
        writeFileSync(join(cacheRoot, "Default", "Cookies"), "a session's cookies");
      }
      if (t.url === "http://renderer.test/") setTimeout(() => { tabs.delete(tabId); send("browserLink.tabGone", { linkId, tabId, reason: "crashed" }); }, 20);
      if (t.url === "http://notice.test/") {
        setTimeout(() => {
          send("headless.notice", { linkId, tabId, kind: "popup" });
          send("headless.notice", { linkId, tabId, kind: "popup" });
          send("headless.notice", { linkId, tabId, kind: "local-network" });
          send("headless.notice", { linkId, tabId, kind: "camera" });
          send("headless.notice", { linkId, tabId: "w-unknown", kind: "popup" });
        }, 20);
      }
      if (t.url === "http://events.test/") {
        setTimeout(() => send("browserLink.events", { linkId, events: [
          { tabId, method: "Page.loadEventFired", params: { timestamp: 1 } },
          { tabId, method: "Not.anEvent", params: {} },
          { tabId: "w-unknown", method: "Page.loadEventFired", params: { timestamp: 2 } },
          { tabId, method: "Runtime.executionContextCreated", params: { context: { id: 3 } }, cdpSessionId: "S1" },
        ] }), 20);
      }
      return;
    }
    case "tab.release": return reply(cmdId, {});
    case "tab.close": {
      const tabId = String(p.tabId);
      const slow = tabs.get(tabId)?.url === "http://slow-close.test/";
      tabs.delete(tabId);
      if (!slow) return reply(cmdId, {});
      setTimeout(() => {
        if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ op: "closed", params: { tabId } })}\n`);
        reply(cmdId, {});
      }, 300);
      return;
    }
    case "tabs.live": return reply(cmdId, { tabs: [...tabs].map(([tabId, t]) => ({ tabId, sessionId: t.sessionId, url: t.url, title: `live ${t.url}`, held: true })) });
    case "cdp.send": {
      if (!tabs.has(String(p.tabId))) return fail(cmdId, "tab_gone", "the headless tab is gone");
      if (tabs.get(String(p.tabId))!.url === "http://wedge.test/") return; // never answered
      if (tabs.get(String(p.tabId))!.url === "http://hang.test/") { hung = true; return; } // nothing answered from now on
      if (tabs.get(String(p.tabId))!.url === "http://slow-send.test/") {
        setTimeout(() => {
          if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ op: "answered", params: { method: p.method } })}\n`);
          reply(cmdId, { result: {} });
        }, 300);
        return;
      }
      if (p.method === "Runtime.evaluate") return reply(cmdId, { result: { result: { type: "number", value: 2 } } });
      return reply(cmdId, { result: {} });
    }
    case "cdp.subscribe": return reply(cmdId, {});
    case "headless.present": {
      if (mode === "no-present") return fail(cmdId, "not_allowed", "unknown op headless.present");
      const tabId = String(p.tabId);
      const t = tabs.get(tabId);
      if (t === undefined) return fail(cmdId, "tab_gone", "the headless tab is gone");
      if (typeof p.nonce !== "string" || !/^[0-9a-f]{16}$/.test(p.nonce) || typeof p.viewerRequirement !== "string" || p.viewerRequirement === "") {
        return fail(cmdId, "not_allowed", "headless.present needs nonce (16 hex) and viewerRequirement");
      }
      presented.set(tabId, p.nonce);
      reply(cmdId, { service: `com.winter.headless.present.${process.pid}.fake${++services}`, cssWidth: 1280, cssHeight: 800 });
      if (t.url !== "http://no-viewer.test/") {
        setTimeout(() => {
          if (presented.get(tabId) !== p.nonce) return;
          send("headless.presentationStarted", { linkId, tabId });
          if (t.url === "http://opens-window.test/") {
            const windowId = `w-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
            tabs.set(windowId, { sessionId: t.sessionId, url: "http://window.test/" });
            setTimeout(() => send("headless.popupOpened", { linkId, tabId: windowId, openerTabId: tabId, url: "http://window.test/" }), 20);
          }
          if (t.url === "http://notice-held.test/") send("headless.notice", { linkId, tabId, kind: "local-network" });
          if (t.url === "http://resizes.test/") {
            send("headless.viewChanged", { linkId, tabId, cssWidth: 704, cssHeight: 900, scale: 2 });
            setTimeout(() => {
              send("headless.viewChanged", { linkId, tabId, cssWidth: 704, cssHeight: 900, scale: 1 });
              send("headless.viewChanged", { linkId, tabId, cssWidth: 0, cssHeight: 900, scale: 1 });
            }, 10);
          }
          if (t.url === "http://viewer-leaves.test/") {
            setTimeout(() => {
              if (presented.get(tabId) !== p.nonce) return;
              presented.delete(tabId);
              send("headless.presentationEnded", { linkId, tabId, reason: "the viewer went away" });
            }, 150);
          }
        }, 20);
      }
      return;
    }
    case "headless.unpresent": {
      presented.delete(String(p.tabId));
      reply(cmdId, { frames: 0 });
      if (tabs.get(String(p.tabId))?.url === "http://resizes.test/") send("headless.viewChanged", { linkId, tabId: String(p.tabId), cssWidth: 1280, cssHeight: 800, scale: 1 });
      if (tabs.get(String(p.tabId))?.url === "http://notice-held.test/") setTimeout(() => send("headless.notice", { linkId, tabId: String(p.tabId), kind: "local-network" }), 20);
      return;
    }
    case "headless.control":
      if (!presented.has(String(p.tabId))) return fail(cmdId, "not_live", "the headless tab is not presented");
      return reply(cmdId, {});
    case "context.dispose": {
      let closed = 0;
      for (const [k, t] of tabs) if (t.sessionId === p.sessionId) { tabs.delete(k); closed++; }
      return reply(cmdId, { closed });
    }
    default: return fail(cmdId, "not_allowed", `unknown op ${op}`);
  }
}

