/**
 * ComputerV2 — the compiled-artifact gate for the Winter Computer Use helper: `bun run verify:computer-helper`.
 * Never under `bun test` (it builds and runs real signed binaries). Needs no TCC grant, shows no UI, never
 * touches `~/.winter*` or LaunchServices' launch path: every helper it runs is its own child, on a temp home.
 *
 *  1. The dev helper `bun run dev:helper` left in `dist/dev/` is what TCC and the daemon need: Winter's team,
 *     identifier com.winter.computeruse.dev, the hardened runtime, EXACTLY the stated designated requirement,
 *     no entitlements, an LSUIElement Info.plist at this VERSION, and no test hooks compiled in.
 *  2. That very binary, run against a temp home (WINTER_CU_HOME), creates `run/computer-use.sock` 0600 in a
 *     0700 `run/` — and closes a connection from this script (bun: signed, but not the dev daemon) with no
 *     response at all, hello or not. The real peer check, no bypass.
 *  3. A TEST flavor is built (bundle id com.winter.computeruse.test, the WINTER_CU_TEST_BUILD condition) and
 *     signed the same way, and run with a FAKE daemon identity: bun's own designated requirement. Then the
 *     handshake with mutual authentication — the helper checked bun's code before reading a byte; this script
 *     checks the pid `hello` names against the helper's stated requirement (`codesign --verify -R=… <pid>`,
 *     the check the daemon makes over Security.framework) — then `status`, an engine method, an unknown
 *     method, and the three refusals (protocol, home, a first request that is not hello), each answered and
 *     closed. Finally the idle quit: with every connection gone it exits on its own and removes its socket.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { HELPER, HELPER_SOCKET_NAME, helperExecutable, helperRequirement } from "./computer-helper-lib";
import { buildHelper, DEV_HELPER_APP, inspectHelper, run, signHelper, signingIdentity } from "./dev-helper";
import { readCanonical } from "./version-lib";

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

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("the helper is macOS-only");
  const version = readCanonical();
  const homes: string[] = [];
  const launched: Launched[] = [];
  try {
    // ── 1. the dev helper as built by `bun run dev:helper` ────────────────────────────────────────────
    console.error(`verify:computer-helper: 1. the dev helper (${DEV_HELPER_APP})`);
    if (!existsSync(DEV_HELPER_APP)) {
      check(false, "the dev helper exists", "run `bun run dev:helper` first");
    } else {
      const failures = inspectHelper(DEV_HELPER_APP, "dev");
      check(failures.length === 0, `signed for TCC: team ${WINTER_TEAM_ID}, ${HELPER.dev.identifier}, hardened runtime, the stated designated requirement, no entitlements, LSUIElement, version ${version}, no test hooks`, failures.join("; "));

      // ── 2. that binary refuses a peer that is not the dev daemon ──────────────────────────────────────
      console.error("verify:computer-helper: 2. the dev binary's real peer check, on a temp home");
      const home = tempHome();
      homes.push(home);
      const socketPath = join(home, "run", HELPER_SOCKET_NAME);
      const dev = launch(helperExecutable(DEV_HELPER_APP, "dev"), { WINTER_CU_HOME: home });
      launched.push(dev);
      if (check(await waitFor(() => existsSync(socketPath), 10_000), "it listens on <home>/run/computer-use.sock (WINTER_CU_HOME honoured by a dev build)", dev.stderr.slice(-5).join(" | "))) {
        check(mode(socketPath) === 0o600, "the socket is 0600", `mode ${mode(socketPath)?.toString(8)}`);
        check(mode(join(home, "run")) === 0o700, "run/ is 0700", `mode ${mode(join(home, "run"))?.toString(8)}`);
        const impostor = await LineClient.connect(socketPath);
        impostor.send({ id: 1, method: "hello", params: { protocol: 1, client: "daemon", home } });
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

    const home = tempHome();
    homes.push(home);
    const socketPath = join(home, "run", HELPER_SOCKET_NAME);
    const helper = launch(helperExecutable(testApp, "test"), {
      WINTER_CU_HOME: home,
      WINTER_CU_TEST_DAEMON_REQUIREMENT: fakeDaemon,
      WINTER_CU_TEST_IDLE_SECONDS: "3",
    });
    launched.push(helper);
    if (!check(await waitFor(() => existsSync(socketPath), 10_000), "the test helper listens", helper.stderr.slice(-5).join(" | "))) return;
    check(mode(socketPath) === 0o600, "its socket is 0600");

    const daemon = await LineClient.connect(socketPath);
    const hello = await daemon.request(1, "hello", { protocol: 1, client: "daemon", home });
    const result = typeof hello === "object" ? hello.result : undefined;
    check(result?.protocol === 1 && result?.helperVersion === version && result?.pid === helper.child.pid,
      `hello → {protocol: 1, helperVersion: ${version}, pid: ${helper.child.pid}} (the helper accepted bun's code)`, JSON.stringify(hello));
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

    const refusals: { what: string; first: Record<string, unknown>; code: string }[] = [
      { what: "a protocol mismatch", first: { id: 1, method: "hello", params: { protocol: 2, client: "daemon", home } }, code: "protocol_mismatch" },
      { what: "a home mismatch", first: { id: 1, method: "hello", params: { protocol: 1, client: "daemon", home: realpathSync(tmpdir()) } }, code: "home_mismatch" },
      { what: "a first request that is not hello", first: { id: 1, method: "status", params: {} }, code: "protocol_mismatch" },
    ];
    for (const { what, first, code } of refusals) {
      const client = await LineClient.connect(socketPath);
      client.send(first);
      const reply = await client.next();
      const replied = typeof reply === "object" && reply.error?.data?.code === code;
      check(replied && (await client.next()) === "eof", `${what} → ${code}, then the connection is closed`, JSON.stringify(reply));
      client.close();
    }

    daemon.close();
    const quit = await Promise.race([helper.exited, sleep(15_000).then(() => "late" as const)]);
    check(quit === 0, "with no connection and no bound target it quits on its own (idle quit, 3 s in the test build)", `exit: ${String(quit)}; ${helper.stderr.slice(-3).join(" | ")}`);
    check(!existsSync(socketPath), "…and removes its socket file");
  } finally {
    for (const l of launched) await stop(l);
    for (const h of homes) rmSync(h, { recursive: true, force: true });
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
