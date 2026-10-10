/**
 * ComputerV2 — the compiled-artifact gate for the Winter Computer Use helper: `bun run verify:computer-helper`.
 * Never under `bun test` (it builds and runs real signed binaries). Needs no TCC grant, shows no UI, never
 * touches `~/.winter*`, and launches nothing through LaunchServices: every helper it runs is its own child, on
 * a temp home (the test flavor's LaunchServices record, which running it creates, is removed at the end).
 *
 *  1. The dev helper `bun run dev:helper` left in `dist/dev/` is what TCC and the daemon need: Winter's team,
 *     identifier com.winter.computeruse.dev, the hardened runtime, EXACTLY the stated designated requirement,
 *     the Apple Events entitlement only, an LSUIElement Info.plist at the helper's own version
 *     (apple/ComputerUse/VERSION), and no test hooks compiled in.
 *  2. That very binary, run against a temp home (WINTER_CU_HOME), creates `run/computer-use.sock` 0600 in a
 *     0700 `run/` — and closes a connection from this script (bun: signed, but not the dev daemon) with no
 *     response at all, hello or not. The real peer check, no bypass.
 *  3. A TEST flavor is built (bundle id com.winter.computeruse.test, the WINTER_CU_TEST_BUILD condition) and
 *     signed the same way, and run with a FAKE daemon identity: bun's own designated requirement. Then the
 *     handshake with mutual authentication — the helper checked bun's code before reading a byte; this script
 *     checks the pid `hello` names against the helper's stated requirement (`codesign --verify -R=… <pid>`,
 *     the check the daemon makes over Security.framework) — then `status`, an engine method, an unknown
 *     method, and the three refusals (protocol, home, a first request that is not hello), each answered and
 *     closed; then Winter.app's leg (the same bun, also accepted as a fake Winter.app): hello client:"app",
 *     status and view.subscribe/unsubscribe allowed, every other method not_allowed, the daemon refused view.*,
 *     and — on a second test helper whose app requirement bun does not meet — a false client:"app" refused and
 *     closed. Finally the idle quit: once no script runs and nothing is bound it exits on its own — with the
 *     daemon's connection still open (that connection is not work) — closing it and removing its socket.
 *  4. winter-browser-host, nested in both bundles: in step 1 and 3's checks its own signature (com.winter.browserhost.dev
 *     / .test, Winter's team, hardened runtime, EXACTLY its stated requirement, no entitlements, test hooks only in the
 *     test flavor). Then the test host, run from inside the test helper the way Chrome runs it (argv[1] = the caller's
 *     origin, native messaging on stdin/stdout), against a temp home: a caller that is not Winter for Chrome → exit 1 and
 *     nothing written; no daemon → `host.status unavailable`; this bun as a fake daemon on `<home>/run/browser.sock` →
 *     `host.hello` with the pinned fields, the host's pid checked against the host's stated requirement exactly as the
 *     daemon checks it (Security.framework by pid, and codesign), then the relay both ways; and a host told to expect a
 *     daemon this bun is not → `host.status unverified` with not one byte sent.
 *
 *   bun run verify:computer-helper [--dev-helper <path>]   (default: dist/dev/Winter Computer Use Dev.app)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { HELPER_PROTOCOL } from "../packages/core/src/computer-use/protocol";
import { EXTENSION_IDS } from "../packages/core/src/computer-use/browser/extension/extension-ids";
import { BROWSER_HOST_PROTOCOL, EXTENSION_PROTOCOL } from "../packages/core/src/computer-use/browser/extension/protocol";
import { processSatisfiesRequirement } from "../packages/core/src/computer-use/helper-verify";
import { BROWSER_HOST, browserHostExecutable, HELPER, HELPER_SOCKET_NAME, helperExecutable, helperRequirement, LSREGISTER, readHelperVersion } from "./computer-helper-lib";
import { buildHelper, DEV_HELPER_APP, inspectHelper, run, signHelper, signingIdentity } from "./dev-helper";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_DIR = join(REPO_ROOT, "out", "computer-helper", "verify");

const results: { ok: boolean; what: string; detail?: string }[] = [];
function check(ok: boolean, what: string, detail?: string): boolean {
  results.push({ ok, what, ...(detail !== undefined ? { detail } : {}) });
  console.error(`${ok ? "  ok  " : "  FAIL"} ${what}${!ok && detail ? `\n         ${detail}` : ""}`);
  return ok;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** NDJSON over the helper's socket. */
class LineClient {
  private buffer = "";
  private readonly lines: unknown[] = [];
  private wake: (() => void) | undefined;
  received = 0;
  ended = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.received += chunk.length;
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        try { this.lines.push(JSON.parse(line)); } catch { this.lines.push({ unparseable: line }); }
      }
      this.wake?.();
    });
    const end = () => { this.ended = true; this.wake?.(); };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  static connect(path: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path });
      socket.once("connect", () => resolve(new LineClient(socket)));
      socket.once("error", reject);
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  /** The next line; "eof" when the helper closed; "timeout". */
  async next(timeoutMs = 5000): Promise<Record<string, any> | "eof" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (this.ended) return "eof";
      const left = deadline - Date.now();
      if (left <= 0) return "timeout";
      await new Promise<void>((r) => { this.wake = r; setTimeout(r, Math.min(left, 100)); });
    }
    return this.lines.shift() as Record<string, any>;
  }

  async request(id: number, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any> | "eof" | "timeout"> {
    this.send({ id, method, params });
    for (;;) {
      const line = await this.next();
      if (typeof line === "string" || line.id === id) return line;
    }
  }

  /** True when the helper closes within `timeoutMs` without ever having sent a byte. */
  async closedSilently(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended && Date.now() < deadline) await sleep(50);
    return this.ended && this.received === 0;
  }

  close(): void {
    this.socket.destroy();
  }
}

interface Launched { child: ChildProcess; stderr: string[]; exited: Promise<number | null> }

function launch(executable: string, env: Record<string, string>): Launched {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("WINTER_")) delete clean[k];
  const child = spawn(executable, [], { env: { ...clean, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => stderr.push(...d.split("\n").filter(Boolean)));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, stderr, exited };
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(50);
  }
  return condition();
}

function mode(path: string): number | undefined {
  try { return lstatSync(path).mode & 0o777; } catch { return undefined; }
}

function tempHome(): string {
  // Short on purpose: a socket path must fit in 104 bytes.
  return realpathSync(mkdtempSync(join(tmpdir(), "wcu-v-")));
}

async function stop(launched: Launched): Promise<void> {
  if (launched.child.exitCode !== null || launched.child.signalCode !== null) return;
  launched.child.kill("SIGTERM");
  const done = await Promise.race([launched.exited, sleep(5000).then(() => "late" as const)]);
  if (done === "late") launched.child.kill("SIGKILL");
}

/** Chrome native messaging on a child's pipes: 4-byte little-endian length + JSON. */
class NativePipe {
  private buffer = Buffer.alloc(0);
  readonly messages: Record<string, any>[] = [];
  constructor(private readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const n = this.buffer.readUInt32LE(0);
        if (this.buffer.length < 4 + n) break;
        this.messages.push(JSON.parse(this.buffer.subarray(4, 4 + n).toString("utf8")));
        this.buffer = this.buffer.subarray(4 + n);
      }
    });
  }
  send(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.child.stdin?.write(Buffer.concat([head, body]));
  }
  async next(match: (m: Record<string, any>) => boolean, ms = 8000): Promise<Record<string, any> | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const i = this.messages.findIndex(match);
      if (i >= 0) return this.messages.splice(i, 1)[0];
      await sleep(50);
    }
    return undefined;
  }
}

/** A fake daemon (this bun) on `<home>/run/browser.sock`: records every byte, answers host.hello, relays. */
async function fakeBrowserDaemon(socketPath: string) {
  const state = { bytes: 0, lines: [] as Record<string, any>[], sockets: [] as { write(s: string): number; end(): void }[] };
  let buffer = "";
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(sock) { state.sockets.push(sock as unknown as { write(s: string): number; end(): void }); },
      data(_sock, chunk) {
        state.bytes += chunk.length;
        buffer += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          state.lines.push(JSON.parse(buffer.slice(0, nl)));
          buffer = buffer.slice(nl + 1);
        }
      },
    },
  });
  return {
    state,
    write: (message: Record<string, unknown>) => state.sockets.at(-1)?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    async line(match: (m: Record<string, any>) => boolean, ms = 8000): Promise<Record<string, any> | undefined> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const i = state.lines.findIndex(match);
        if (i >= 0) return state.lines.splice(i, 1)[0];
        await sleep(50);
      }
      return undefined;
    },
    stop: () => server.stop(true),
  };
}

/** Step 4: the test host inside the test helper, the way Chrome runs it. */
async function verifyBrowserHost(testApp: string, fakeDaemon: string, homes: string[], version: string): Promise<void> {
  console.error("verify:computer-helper: 4. winter-browser-host (test flavor), run the way Chrome runs it");
  const exe = browserHostExecutable(testApp);
  const origin = `chrome-extension://${EXTENSION_IDS.dev[0]}/`;
  const home = tempHome();
  homes.push(home);
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("WINTER_")) delete clean[k];
  const env = (requirement: string) => ({ ...clean, WINTER_BROWSER_HOST_HOME: home, WINTER_CU_TEST_DAEMON_REQUIREMENT: requirement });

  const refused = spawnSync(exe, ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"], { env: env(fakeDaemon), input: "", timeout: 10_000 });
  check(refused.status === 1 && (refused.stdout?.length ?? 0) === 0, "a caller that is not Winter for Chrome → exit 1, nothing written to it", `exit ${refused.status}; ${refused.stderr?.toString().trim()}`);

  const socketPath = join(home, "run", "browser.sock");
  const spawnHost = (requirement: string) => {
    const child = spawn(exe, [origin], { env: env(requirement), stdio: ["pipe", "pipe", "pipe"] });
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => stderr.push(...d.split("\n").filter(Boolean)));
    return { child, stderr, pipe: new NativePipe(child) };
  };

  const host = spawnHost(fakeDaemon);
  try {
    const status = (daemon: string) => (m: Record<string, any>) => m.method === "host.status" && m.params?.daemon === daemon;
    check(await host.pipe.next(status("unavailable")) !== undefined, "no daemon → host.status {daemon: \"unavailable\"}", host.stderr.slice(-3).join(" | "));
    const daemon = await fakeBrowserDaemon(socketPath);
    try {
      const hello = await daemon.line((m) => m.method === "host.hello", 8000);
      const p = hello?.params ?? {};
      check(hello?.id === "h1" && p.protocol === BROWSER_HOST_PROTOCOL && p.client === "browser-host" && p.origin === origin && p.hostPid === host.child.pid
        && p.hostVersion === version && p.browserPid === process.pid && typeof p.browserBundleId === "string",
        "the daemon appears within the retry: host.hello {protocol, client, hostVersion, hostPid, origin, browserBundleId, browserPid} first", JSON.stringify(hello));
      const hostDr = helperRequirement(BROWSER_HOST.test.identifier, WINTER_TEAM_ID);
      check(processSatisfiesRequirement(Number(p.hostPid), hostDr), "the daemon's own check: the pid host.hello names satisfies the host's stated requirement (Security.framework by pid)");
      check(run("codesign", ["--verify", `-R=${hostDr}`, String(p.hostPid)]).status === 0, "…and codesign agrees on the running process");
      check(!processSatisfiesRequirement(Number(p.hostPid), helperRequirement(HELPER.test.identifier, WINTER_TEAM_ID)), "…and the check discriminates: the host is not the helper");
      daemon.write({ id: "h1", result: { protocol: BROWSER_HOST_PROTOCOL, daemonVersion: "verify" } });
      check(await host.pipe.next(status("connected")) !== undefined, "host.hello answered → host.status {daemon: \"connected\"} to the extension");
      host.pipe.send({ id: "e1", method: "hello", params: { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: "00000000-0000-4000-8000-000000000001" } });
      const relayed = await daemon.line((m) => m.id === "e1");
      check(relayed?.method === "hello" && relayed?.params?.instanceId === "00000000-0000-4000-8000-000000000001", "the relay: an extension message reaches the daemon unchanged", JSON.stringify(relayed));
      daemon.write({ id: "d1", method: "tabs.list", params: {} });
      const back = await host.pipe.next((m) => m.id === "d1");
      check(back?.method === "tabs.list", "…and a daemon request reaches the extension as one native message", JSON.stringify(back));
    } finally {
      daemon.stop();
    }
  } finally {
    host.child.kill("SIGTERM");
  }

  // A daemon this bun is not: the host checks the socket's process before writing anything.
  rmSync(socketPath, { force: true });
  const daemon = await fakeBrowserDaemon(socketPath);
  const strict = spawnHost("never");
  try {
    check(await strict.pipe.next((m) => m.method === "host.status" && m.params?.daemon === "unverified") !== undefined,
      "a process on the socket that is not the daemon → host.status {daemon: \"unverified\"}", strict.stderr.slice(-3).join(" | "));
    await sleep(300);
    check(daemon.state.bytes === 0, "…and it was sent not one byte");
  } finally {
    strict.child.kill("SIGTERM");
    daemon.stop();
  }
  // Chrome closing the port ends the host.
  const ending = spawnHost(fakeDaemon);
  ending.child.stdin?.end();
  const code = await Promise.race([new Promise<number | null>((r) => ending.child.once("exit", (c) => r(c))), sleep(5000).then(() => "late" as const)]);
  check(code === 0, "stdin closed (Chrome closed the port) → the host exits 0", String(code));
  if (code === "late") ending.child.kill("SIGKILL");
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("the helper is macOS-only");
  const devFlag = process.argv.indexOf("--dev-helper");
  const devHelperApp = devFlag >= 0 && process.argv[devFlag + 1] !== undefined ? process.argv[devFlag + 1]! : DEV_HELPER_APP;
  // The helper's OWN version (apple/ComputerUse/VERSION), not Winter's.
  const version = readHelperVersion();
  const homes: string[] = [];
  const launched: Launched[] = [];
  try {
    // ── 1. the dev helper as built by `bun run dev:helper` ────────────────────────────────────────────
    console.error(`verify:computer-helper: 1. the dev helper (${devHelperApp})`);
    if (!existsSync(devHelperApp)) {
      check(false, "the dev helper exists", "run `bun run dev:helper` first");
    } else {
      const failures = inspectHelper(devHelperApp, "dev");
      check(failures.length === 0, `signed for TCC: team ${WINTER_TEAM_ID}, ${HELPER.dev.identifier}, hardened runtime, the stated designated requirement, the Apple Events entitlement only, LSUIElement, version ${version}, no test hooks; winter-browser-host inside as ${BROWSER_HOST.dev.identifier}, its stated requirement, no entitlements, no test hooks`, failures.join("; "));

      // ── 2. that binary refuses a peer that is not the dev daemon ──────────────────────────────────────
      console.error("verify:computer-helper: 2. the dev binary's real peer check, on a temp home");
      const home = tempHome();
      homes.push(home);
      const socketPath = join(home, "run", HELPER_SOCKET_NAME);
      const dev = launch(helperExecutable(devHelperApp, "dev"), { WINTER_CU_HOME: home });
      launched.push(dev);
      if (check(await waitFor(() => existsSync(socketPath), 10_000), "it listens on <home>/run/computer-use.sock (WINTER_CU_HOME honoured by a dev build)", dev.stderr.slice(-5).join(" | "))) {
        check(mode(socketPath) === 0o600, "the socket is 0600", `mode ${mode(socketPath)?.toString(8)}`);
        check(mode(join(home, "run")) === 0o700, "run/ is 0700", `mode ${mode(join(home, "run"))?.toString(8)}`);
        const impostor = await LineClient.connect(socketPath);
        impostor.send({ id: 1, method: "hello", params: { protocol: HELPER_PROTOCOL, client: "daemon", home } });
        check(await impostor.closedSilently(), "a peer that is not com.winter.core.dev is closed with no response at all");
        impostor.close();
        check(await waitFor(() => dev.stderr.some((l) => l.includes("refused")), 3000), "the helper logged the refusal", dev.stderr.slice(-3).join(" | "));
      }
      await stop(dev);
      check(!existsSync(socketPath), "SIGTERM quits it and removes the socket file");
    }

    // ── 3. the test flavor, a fake daemon identity, the handshake ─────────────────────────────────────
    console.error("verify:computer-helper: 3. the test flavor (fake daemon identity) and the handshake");
    const identity = signingIdentity();
    const product = buildHelper("test", (line) => console.error(`verify:computer-helper: ${line}`));
    mkdirSync(VERIFY_DIR, { recursive: true });
    const testApp = join(VERIFY_DIR, `${HELPER.test.name}.app`);
    rmSync(testApp, { recursive: true, force: true });
    if (run("ditto", [product, testApp]).status !== 0) throw new Error(`could not copy ${product}`);
    rmSync(product, { recursive: true, force: true });
    const testFailures = signHelper(testApp, "test", identity.hash);
    check(testFailures.length === 0, `the test flavor is signed the same way (${HELPER.test.identifier}) and carries its test hooks`, testFailures.join("; "));

    const bunDr = /^designated => (.+)$/m.exec(run("codesign", ["-d", "-r-", process.execPath]).stdout)?.[1]?.trim();
    const fakeDaemon = bunDr ?? "always";
    if (bunDr === undefined) console.error(`verify:computer-helper: ${process.execPath} has no designated requirement (unsigned bun?) — the test helper accepts any peer (\`always\`)`);
    else console.error(`verify:computer-helper: fake daemon identity = this bun's designated requirement: ${bunDr}`);

    await verifyBrowserHost(testApp, fakeDaemon, homes, version);

    const home = tempHome();
    homes.push(home);
    const socketPath = join(home, "run", HELPER_SOCKET_NAME);
    const helper = launch(helperExecutable(testApp, "test"), {
      WINTER_CU_HOME: home,
      WINTER_CU_TEST_DAEMON_REQUIREMENT: fakeDaemon,
      // The same bun plays Winter.app too: a peer may claim any client its code satisfies.
      WINTER_CU_TEST_APP_REQUIREMENT: fakeDaemon,
      WINTER_CU_TEST_IDLE_SECONDS: "3",
    });
    launched.push(helper);
    if (!check(await waitFor(() => existsSync(socketPath), 10_000), "the test helper listens", helper.stderr.slice(-5).join(" | "))) return;
    check(mode(socketPath) === 0o600, "its socket is 0600");

    const daemon = await LineClient.connect(socketPath);
    const hello = await daemon.request(1, "hello", { protocol: HELPER_PROTOCOL, client: "daemon", home });
    const result = typeof hello === "object" ? hello.result : undefined;
    check(result?.protocol === HELPER_PROTOCOL && result?.helperVersion === version && result?.pid === helper.child.pid,
      `hello → {protocol: ${HELPER_PROTOCOL}, helperVersion: ${version}, pid: ${helper.child.pid}} (the helper accepted bun's code)`, JSON.stringify(hello));
    const helperDr = helperRequirement(HELPER.test.identifier, WINTER_TEAM_ID);
    const mutual = run("codesign", ["--verify", `-R=${helperDr}`, String(result?.pid ?? -1)]);
    check(mutual.status === 0, "mutual auth: the pid hello names satisfies the helper's stated designated requirement", mutual.stderr.trim());
    const wrong = run("codesign", ["--verify", `-R=${helperRequirement(HELPER.dev.identifier, WINTER_TEAM_ID)}`, String(result?.pid ?? -1)]);
    check(wrong.status !== 0, "…and that check discriminates (the dev helper's requirement does not match it)");

    const status = await daemon.request(2, "status");
    const s = typeof status === "object" ? status.result : undefined;
    check(s?.helperVersion === version && typeof s?.permissions?.accessibility === "boolean" && typeof s?.permissions?.screenRecording === "boolean",
      "status → {helperVersion, permissions: {accessibility, screenRecording}}", JSON.stringify(status));
    const apps = await daemon.request(3, "apps.list");
    check(typeof apps === "object" && (apps.result !== undefined || typeof apps.error?.data?.code === "string"),
      `an engine method is dispatched (apps.list → ${typeof apps === "object" ? (apps.result !== undefined ? "result" : apps.error?.data?.code) : apps})`, JSON.stringify(apps));
    const unknown = await daemon.request(4, "target.teleport");
    check(typeof unknown === "object" && unknown.error?.data?.code === "unsupported", "an unknown method → unsupported", JSON.stringify(unknown));
    const active = await daemon.request(5, "script.active", { sessionId: "s_verify", active: true });
    check(typeof active === "object" && JSON.stringify(active.result) === "{}", "script.active → {}", JSON.stringify(active));

    // ── 3b. Winter.app as the second client (the in-window mirror's view stream) ──
    const app = await LineClient.connect(socketPath);
    const appHello = await app.request(1, "hello", { protocol: HELPER_PROTOCOL, client: "app", home });
    check(typeof appHello === "object" && appHello.result?.pid === helper.child.pid, "Winter.app (fake identity): hello client:\"app\" → {protocol, helperVersion, pid}", JSON.stringify(appHello));
    const appStatus = await app.request(2, "status");
    check(typeof appStatus === "object" && appStatus.result?.helperVersion === version, "Winter.app may read status", JSON.stringify(appStatus));
    const subscribed = await app.request(3, "view.subscribe", { sessionId: "s_verify", frames: true, maxFps: 5, maxWidth: 360 });
    check(typeof subscribed === "object" && JSON.stringify(subscribed.result) === JSON.stringify({ targets: [] }), "view.subscribe → {targets: []} (nothing bound)", JSON.stringify(subscribed));
    for (const [n, method] of ["apps.list", "target.bind", "script.active", "session.ended"].entries()) {
      const refused = await app.request(10 + n, method, { sessionId: "s_verify" });
      check(typeof refused === "object" && refused.error?.data?.code === "not_allowed", `Winter.app may not call ${method} → not_allowed`, JSON.stringify(refused));
    }
    const unsubscribed = await app.request(20, "view.unsubscribe", { sessionId: "s_verify" });
    check(typeof unsubscribed === "object" && JSON.stringify(unsubscribed.result) === "{}", "view.unsubscribe → {}", JSON.stringify(unsubscribed));
    const daemonView = await daemon.request(7, "view.subscribe", { sessionId: "s_verify", frames: true });
    check(typeof daemonView === "object" && daemonView.error?.data?.code === "not_allowed", "the daemon may not subscribe to frames → not_allowed", JSON.stringify(daemonView));
    app.close();

    const refusals: { what: string; first: Record<string, unknown>; code: string; data?: Record<string, unknown> }[] = [
      // The helper names its own protocol and version, so the client can say which side is out of date.
      { what: "a protocol mismatch", first: { id: 1, method: "hello", params: { protocol: HELPER_PROTOCOL + 1, client: "daemon", home } }, code: "protocol_mismatch",
        data: { expected: HELPER_PROTOCOL, helperVersion: version } },
      { what: "a home mismatch", first: { id: 1, method: "hello", params: { protocol: HELPER_PROTOCOL, client: "daemon", home: realpathSync(tmpdir()) } }, code: "home_mismatch" },
      { what: "a first request that is not hello", first: { id: 1, method: "status", params: {} }, code: "protocol_mismatch" },
    ];
    for (const { what, first, code, data } of refusals) {
      const client = await LineClient.connect(socketPath);
      client.send(first);
      const reply = await client.next();
      const replied = typeof reply === "object" && reply.error?.data?.code === code
        && Object.entries(data ?? {}).every(([k, v]) => reply.error?.data?.[k] === v);
      check(replied && (await client.next()) === "eof", `${what} → ${code}, then the connection is closed`, JSON.stringify(reply));
      client.close();
    }

    // A helper whose app requirement this bun does not satisfy: claiming to be Winter.app is refused, closed.
    {
      const home2 = tempHome();
      homes.push(home2);
      const socket2 = join(home2, "run", HELPER_SOCKET_NAME);
      const strict = launch(helperExecutable(testApp, "test"), {
        WINTER_CU_HOME: home2,
        WINTER_CU_TEST_DAEMON_REQUIREMENT: fakeDaemon,
        WINTER_CU_TEST_APP_REQUIREMENT: "never",
      });
      launched.push(strict);
      if (check(await waitFor(() => existsSync(socket2), 10_000), "a second test helper (no app identity this bun satisfies) listens")) {
        const claimant = await LineClient.connect(socket2);
        const reply = await claimant.request(1, "hello", { protocol: HELPER_PROTOCOL, client: "app", home: home2 });
        check(typeof reply === "object" && reply.error?.data?.code === "not_allowed" && (await claimant.next()) === "eof",
          "a peer that is not Winter.app saying client:\"app\" → not_allowed, then closed", JSON.stringify(reply));
        claimant.close();
      }
      await stop(strict);
    }

    // The daemon stays connected: its one persistent connection must not keep an idle helper alive.
    const done = await daemon.request(6, "script.active", { sessionId: "s_verify", active: false });
    check(typeof done === "object" && JSON.stringify(done.result) === "{}", "script.active false → {}", JSON.stringify(done));
    const quit = await Promise.race([helper.exited, sleep(15_000).then(() => "late" as const)]);
    check(quit === 0, "with no running script and nothing bound it quits on its own, the daemon still connected (idle quit, 3 s in the test build)", `exit: ${String(quit)}; ${helper.stderr.slice(-3).join(" | ")}`);
    check((await daemon.next(3000)) === "eof", "…closing the daemon's connection (the daemon relaunches it on its next call)");
    check(!existsSync(socketPath), "…and removes its socket file");
    daemon.close();
  } finally {
    for (const l of launched) await stop(l);
    for (const h of homes) rmSync(h, { recursive: true, force: true });
    // Running an app's binary registers it with LaunchServices; the test flavor must leave no record behind.
    run(LSREGISTER, ["-u", join(VERIFY_DIR, `${HELPER.test.name}.app`)]);
    // Running the dev binary registered it too: a dev helper verified elsewhere (--dev-helper) must not stay a second
    // registered com.winter.computeruse.dev.
    if (devHelperApp !== DEV_HELPER_APP) run(LSREGISTER, ["-u", devHelperApp]);
    rmSync(VERIFY_DIR, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  check(false, "the gate ran to the end", (err as Error).message);
}
const failed = results.filter((r) => !r.ok);
console.error(`verify:computer-helper: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
