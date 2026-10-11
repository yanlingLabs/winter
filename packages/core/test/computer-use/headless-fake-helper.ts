// A FAKE Winter Headless for the pool's tests: it speaks the helper's wire (apple/Winter/Sources/HeadlessHelper/
// HeadlessWire.swift) with no browser at all. The pool spawns it exactly as it spawns the real helper — the pipe on fds 3
// (commands in) and 4 (everything out) — through `/bin/sh`, which hands those two to this script as its stdin and stdout
// (Bun, running this script, keeps its own stdin and stdout reliably alive and flowing; a pending read on an extra
// descriptor alone let it end early).
//
// Its behaviour is chosen by its arguments (before the helper's own `--winter-cache-root=…`):
//   --fake-mode=normal (default) | no-hello | bad-protocol
//   --fake-log=<file>    one JSON line per command it read (`{op, params}`), for the test to inspect
// and by the URLs it is asked to open:
//   http://crash.test/        — it answers, then exits 1 (a crash of the whole browser)
//   http://renderer.test/     — it answers, then reports the tab gone `crashed` (one renderer)
//   http://events.test/       — it answers, then sends events for the tab (one off the allowlist, one for an unknown tab)
// It exits 0 on EOF, like the real helper.
import { appendFileSync } from "node:fs";

const argValue = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = argValue("fake-mode") ?? "normal";
const logFile = argValue("fake-log");
const cacheRoot = argValue("winter-cache-root");
if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ op: "started", params: { cacheRoot } })}\n`);
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

if (mode !== "no-hello") send("headless.hello", { protocol: mode === "bad-protocol" ? 99 : 1, linkId, pid: process.pid, version: "0.0.0-fake" });

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

function handle(m: { params: { linkId: string; cmdId: string; op: string; params: Record<string, unknown> } }): void {
  const { cmdId, op, params: p } = m.params;
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ op, params: p })}\n`);
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
      if (t.url === "http://renderer.test/") setTimeout(() => { tabs.delete(tabId); send("browserLink.tabGone", { linkId, tabId, reason: "crashed" }); }, 20);
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
    case "tab.close": tabs.delete(String(p.tabId)); return reply(cmdId, {});
    case "tabs.live": return reply(cmdId, { tabs: [...tabs].map(([tabId, t]) => ({ tabId, sessionId: t.sessionId, url: t.url, title: `live ${t.url}`, held: true })) });
    case "cdp.send": {
      if (!tabs.has(String(p.tabId))) return fail(cmdId, "tab_gone", "the headless tab is gone");
      if (p.method === "Runtime.evaluate") return reply(cmdId, { result: { result: { type: "number", value: 2 } } });
      return reply(cmdId, { result: {} });
    }
    case "cdp.subscribe": return reply(cmdId, {});
    case "context.dispose": {
      let closed = 0;
      for (const [k, t] of tabs) if (t.sessionId === p.sessionId) { tabs.delete(k); closed++; }
      return reply(cmdId, { closed });
    }
    default: return fail(cmdId, "not_allowed", `unknown op ${op}`);
  }
}

