// The `chrome` group's RIG (I/O; the plan and the checks are `chrome.ts`): the page server, Chrome for Testing
// instances on temp profiles, its UI language, and the remote-debugging dialog's precondition. Nothing here touches
// the user's Chrome or Chrome for Testing's default profile; what it changes (one AppleLanguages key of Chrome for
// Testing's own domain, for the French launches) it puts back — at the next English launch, and at cleanup.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CFT_BUNDLE, CFT_PROCESS, chromeLaunchArgs, chromePidFrom, localStateFor, MATERIAL_PAGE, pageEventsSince, parseDevToolsActivePort,
  type ChromeNeed, type ChromeObservation, type PageEvent,
} from "./chrome";
import { onScreenIds } from "./wake";

export interface ChromeRigDeps {
  /** The Chrome for Testing .app. */
  app: string;
  /** The run's temp root (profiles go under it). */
  root: string;
  /** The suite's fixture-web folder. */
  webDir: string;
  tool: string;
  log(line: string): void;
  sh(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string };
  /** Puts the user's app back in front (on their Space). */
  activateUser(): Promise<void>;
  /** Throws when the run must stop (real input, a prompt, a signal). */
  abortIfInput(): void;
  own(pid: number): void;
  disown(pid: number): void;
}

interface Instance {
  need: ChromeNeed;
  pid: number;
  profile: string;
  ws?: WebSocket;
  dialogRaised?: boolean;
  dialogVia?: string;
  connectionAnswered?: boolean;
  note?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ChromeRig {
  readonly pageLog: PageEvent[] = [];
  private server?: ReturnType<typeof Bun.serve>;
  private current?: Instance;
  /** The French launches set Chrome for Testing's AppleLanguages (it was absent before — checked). */
  private langSet = false;
  private seq = 0;

  constructor(private readonly d: ChromeRigDeps) {}

  get pageUrl(): string {
    if (this.server === undefined) throw new Error("the page server is not up");
    return `http://127.0.0.1:${this.server.port}/${MATERIAL_PAGE}`;
  }

  /** The page server: the fixture page, and `/log` (what the page saw). */
  start(): void {
    if (this.server !== undefined) return;
    const page = join(this.d.webDir, MATERIAL_PAGE);
    this.server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: async (req): Promise<Response> => {
        const path = new URL(req.url).pathname;
        if (path === "/log" && req.method === "POST") {
          try { this.pageLog.push({ ...(JSON.parse(await req.text()) as PageEvent), at: Date.now() }); } catch { /* not ours */ }
          return new Response("", { status: 204 });
        }
        if (path === `/${MATERIAL_PAGE}`) return new Response(readFileSync(page, "utf8"), { headers: { "content-type": "text/html; charset=utf-8" } });
        return new Response("not found", { status: 404 });
      },
    });
  }

  pageSince(since: number): PageEvent[] { return pageEventsSince(this.pageLog, since); }

  observe(): ChromeObservation | undefined {
    const c = this.current;
    if (c === undefined) return undefined;
    return {
      pid: c.pid, lang: c.need.lang, profile: c.profile, devToolsActivePort: existsSync(join(c.profile, "DevToolsActivePort")),
      ...(c.dialogRaised === undefined ? {} : { dialogRaised: c.dialogRaised }), ...(c.dialogVia === undefined ? {} : { dialogVia: c.dialogVia }),
      ...(c.connectionAnswered === undefined ? {} : { connectionAnswered: c.connectionAnswered }), ...(c.note === undefined ? {} : { note: c.note }),
    };
  }

  private alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

  private windows(): Set<number> { return onScreenIds(this.d.sh(this.d.tool, ["windows", CFT_PROCESS]).stdout); }

  private async until<T>(what: string, ms: number, get: () => T | undefined): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      this.d.abortIfInput();
      const v = get();
      if (v !== undefined && v !== false) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  private setLanguage(lang: "en" | "fr"): void {
    if (lang === "fr" && !this.langSet) {
      const before = this.d.sh("defaults", ["read", CFT_BUNDLE, "AppleLanguages"]);
      if (before.status === 0) throw new Error(`Chrome for Testing already has its own AppleLanguages (${before.stdout.replace(/\s+/g, " ").trim()}) — the run won't change it`);
      const w = this.d.sh("defaults", ["write", CFT_BUNDLE, "AppleLanguages", "-array", "fr"]);
      if (w.status !== 0) throw new Error(`defaults write failed: ${w.stderr.trim()}`);
      this.langSet = true;
      this.d.log("Chrome for Testing's AppleLanguages set to (fr) for the French launches");
    } else if (lang === "en" && this.langSet) {
      this.restoreLanguage();
    }
  }

  private restoreLanguage(): void {
    if (!this.langSet) return;
    this.d.sh("defaults", ["delete", CFT_BUNDLE, "AppleLanguages"]);
    if (this.d.sh("defaults", ["read", CFT_BUNDLE, "AppleLanguages"]).status === 0) throw new Error("Chrome for Testing's AppleLanguages is still set after the delete");
    this.langSet = false;
    this.d.log("Chrome for Testing's AppleLanguages removed again");
  }

  /** The instance `need` asks for: the running one when its key matches, else a fresh launch. */
  async ensure(need: ChromeNeed): Promise<void> {
    if (this.current !== undefined && this.current.need.key === need.key && this.alive(this.current.pid)) return;
    await this.quit();
    this.start();
    this.setLanguage(need.lang);
    const profile = mkdtempSync(join(this.d.root, `cft-${need.key}-${++this.seq}-`));
    mkdirSync(profile, { recursive: true });
    const localState = localStateFor(need);
    if (localState !== undefined) writeFileSync(join(profile, "Local State"), JSON.stringify(localState));
    const launchedAt = Date.now();
    this.d.log(`launching Chrome for Testing (${need.key}, ${need.lang}) on ${profile}…`);
    const r = this.d.sh("open", ["-n", "-g", "-a", this.d.app, "--args", ...chromeLaunchArgs(need, profile, this.pageUrl)]);
    if (r.status !== 0) throw new Error(`open Chrome for Testing failed: ${r.stderr.trim()}`);
    const pid = await this.until("Chrome for Testing's pid", 15_000, () => chromePidFrom(this.d.sh("ps", ["-axo", "pid=,command="]).stdout, this.d.app, profile));
    this.d.own(pid);
    const inst: Instance = { need, pid, profile };
    this.current = inst;
    if (need.start === "material") {
      await this.until("the Material page's ready message", 20_000, () => this.pageLog.some((e) => e.ev === "ready" && (e.at ?? 0) >= launchedAt) || undefined);
    } else {
      await this.until("a Chrome for Testing window on screen", 15_000, () => this.windows().size > 0 || undefined);
      await sleep(1_500);
    }
    if (need.remoteDebugging === true) await this.raiseDialog(inst);
    await sleep(800);
    await this.d.activateUser();
    await sleep(500);
  }

  /** Remote debugging is on (Local State): connect to its endpoint as an outside app would — Chrome asks "Allow remote
   *  debugging?". Raised = a new window of the browser came on screen within 10 s. Never answered here. */
  private async raiseDialog(inst: Instance): Promise<void> {
    const portFile = join(inst.profile, "DevToolsActivePort");
    let endpoint: { port: number; path: string } | undefined;
    try {
      endpoint = await this.until("DevToolsActivePort", 10_000, () => existsSync(portFile) ? parseDevToolsActivePort(readFileSync(portFile, "utf8")) : undefined);
    } catch {
      inst.dialogRaised = false;
      inst.note = "remote debugging did not start from Local State (no DevToolsActivePort in 10 s)";
      return;
    }
    const before = this.windows();
    inst.connectionAnswered = false;
    const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
    inst.ws = ws;
    ws.addEventListener("open", () => { try { ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })); } catch { /* closed */ } });
    ws.addEventListener("message", () => { inst.connectionAnswered = true; });
    ws.addEventListener("error", () => { inst.note = `${inst.note ?? ""} (the connection errored)`.trim(); });
    try {
      await this.until("the dialog (a new browser window)", 10_000, () => [...this.windows()].some((id) => !before.has(id)) || undefined);
      inst.dialogRaised = true;
      inst.dialogVia = `Local State user-enabled + a WebSocket to ${endpoint.port}${endpoint.path.replace(/[0-9a-f-]{36}$/, "…")}`;
    } catch {
      inst.dialogRaised = false;
      inst.note = `${inst.note ?? ""} no new window within 10 s of the connection${inst.connectionAnswered ? " (and the browser ANSWERED it)" : ""}`.trim();
    }
  }

  /** Quit the current instance (its windows go with it), whatever state it is in. */
  async quit(): Promise<void> {
    const c = this.current;
    if (c === undefined) return;
    this.current = undefined;
    try { c.ws?.close(); } catch { /* gone */ }
    if (this.alive(c.pid)) {
      try { process.kill(c.pid, "SIGTERM"); } catch { /* gone */ }
      const t0 = Date.now();
      while (this.alive(c.pid) && Date.now() - t0 < 8_000) await sleep(100);
      if (this.alive(c.pid)) { try { process.kill(c.pid, "SIGKILL"); } catch { /* gone */ } await sleep(500); }
    }
    if (this.alive(c.pid)) throw new Error(`Chrome for Testing (pid ${c.pid}) is still running`);
    this.d.disown(c.pid);
    this.d.log(`quit Chrome for Testing (${c.need.key})`);
  }

  /** The end of the run (an abort too): quit, restore the language, stop the server. */
  async cleanup(): Promise<void> {
    let err: unknown;
    try { await this.quit(); } catch (e) { err = e; }
    try { this.restoreLanguage(); } catch (e) { err ??= e; }
    this.server?.stop(true);
    this.server = undefined;
    if (err !== undefined) throw err;
  }
}
