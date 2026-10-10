// The live ComputerV2 suite's DAEMON: compiled into `out/cu-live/winter-core-live` and signed by
// `scripts/cu-live/build.ts` with a TEST-ONLY identity (`com.winter.core.cutest`, Winter's team) — never a production
// identifier, which would satisfy the dev Keychain items' access lists. A dev helper accepts that identity only as a
// live-test instance: launched for a home inside a `winter-cu-live-` temp dir (`HelperIdentity.isLiveTestHome`).
//
// It is NOT the shipped `winter-core`: a separate compile entry that starts the real daemon (`startDaemon`) on a
// TEMP home with a FILE secret store, so a run never reads or writes the Keychain, and refuses anything else:
//   - `WINTER_CU_LIVE_TESTS=1` must be set;
//   - `WINTER_HOME` must be absolute, exist, sit under the system temp dir, carry `winter-cu-live-` in its path,
//     and be neither profile's default home (`~/.winter`, `~/.winter-dev`).
// It also serves the one self-spawn ComputerV2 needs: `<this binary> __automation-worker` (the sandboxed worker).
// Code sessions run the external `winter` runtime (`WINTER_RUNTIME_EXECUTABLE`, set by the runner).
//
// Every screenshot the helper returns is also written to `<home>/cu-live-shots/` (the test seam
// `ComputerUseInjection.screenshotSink`) so the runner can judge its pixels.
//
// On start it prints ONE JSON line `{"ready":true,"socket":…,"pid":…}`; SIGTERM/SIGINT stop it cleanly.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AUTOMATION_WORKER_ARG, FileSecretStore, isDefaultWinterHome, runAutomationWorker, startDaemon } from "../../packages/core/src/index";
import { HELPER_PROTOCOL } from "../../packages/core/src/computer-use/protocol";
import { runFreshSampler, type FreshSamplerParams } from "./fresh-sampler";
import { FIXTURE_ADAPTER } from "./adapters";

if (process.argv[2] === AUTOMATION_WORKER_ARG) {
  runAutomationWorker();
  await new Promise(() => {});   // the worker exits when the daemon closes its stdin
}

/**
 * `winter-core-live __peer-hello <socket> <home>`: one `hello` as a DAEMON client to a helper socket (and, for
 * `__helper-call`, one method after it) —
 * how the dry run proves which helpers accept this test identity (a live-test instance) and which close it unanswered
 * (every other dev helper). Prints one JSON line: `{"accepted":true,"result":…}` or `{"accepted":false,…}`.
 */
async function peerHello(socketPath: string, home: string, call?: { method: string; params: unknown }): Promise<void> {
  let buf = "";
  let helloDone = false;
  const answer = await new Promise<Record<string, unknown>>((resolve) => {
    const timer = setTimeout(() => resolve({ accepted: helloDone, timeout: true }), 6_000);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) { s.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: HELPER_PROTOCOL, client: "daemon", home } })}\n`); },
        data(s, chunk) {
          buf += new TextDecoder().decode(chunk);
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let msg: { id?: number; result?: unknown; error?: unknown };
            try { msg = JSON.parse(line) as typeof msg; } catch { clearTimeout(timer); resolve({ accepted: helloDone, error: "unreadable answer" }); return; }
            if (msg.id === 1) {
              if (msg.result === undefined) { clearTimeout(timer); resolve({ accepted: false, error: msg.error }); return; }
              helloDone = true;
              if (call === undefined) { clearTimeout(timer); resolve({ accepted: true, result: msg.result }); return; }
              s.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: call.method, params: call.params })}\n`);
            } else if (msg.id === 2) {
              clearTimeout(timer);
              resolve(msg.result !== undefined ? { accepted: true, result: msg.result } : { accepted: true, error: msg.error });
              return;
            }
          }
        },
        close() { clearTimeout(timer); resolve({ accepted: helloDone, closed: true }); },
        error() { clearTimeout(timer); resolve({ accepted: helloDone, closed: true }); },
      },
    }).catch(() => { clearTimeout(timer); resolve({ accepted: false, connectFailed: true }); });
  });
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  process.exit(0);
}

function refuse(why: string): never {
  process.stderr.write(`winter-core-live: refusing — ${why}\n`);
  process.exit(64);
}

/** Why `home` may not host the live daemon, or undefined when it may. Exported shape for the runner's tests. */
export function liveHomeRefusal(home: string | undefined, tempRoot: string): string | undefined {
  if (home === undefined || home.length === 0) return "WINTER_HOME is not set";
  if (!isAbsolute(home)) return `WINTER_HOME must be absolute (got ${home})`;
  if (!existsSync(home)) return `WINTER_HOME does not exist: ${home}`;
  const real = realpathSync(home);
  const temp = realpathSync(tempRoot);
  if (!real.startsWith(`${temp}/`)) return `WINTER_HOME must be under the system temp dir (${temp})`;
  if (!real.includes("winter-cu-live-")) return "WINTER_HOME must be a winter-cu-live- temp dir";
  if (isDefaultWinterHome(real, "dist") || isDefaultWinterHome(real, "dev")) return "WINTER_HOME is a profile's default home";
  return undefined;
}

if (import.meta.main) {
  if (process.env.WINTER_CU_LIVE_TESTS !== "1") refuse("WINTER_CU_LIVE_TESTS=1 is not set");
  if (process.argv[2] === "__peer-hello") await peerHello(process.argv[3] ?? "", process.argv[4] ?? "");
  // `__helper-call <socket> <home> <method> <json params>`: one call after hello — the runner's door to a live-test
  // helper's test-only methods (`test.activate`) and its `status`.
  if (process.argv[2] === "__helper-call") await peerHello(process.argv[3] ?? "", process.argv[4] ?? "", { method: process.argv[5] ?? "status", params: JSON.parse(process.argv[6] ?? "{}") as unknown });
  // `__helper-freshness <socket> <home> <json params>`: the freshness measurement's sampler (fresh-sampler.ts) — a
  // live-test helper's `test.capture`/`test.stream` on a fixed schedule over one connection.
  if (process.argv[2] === "__helper-freshness") {
    try {
      await runFreshSampler(process.argv[3] ?? "", process.argv[4] ?? "", JSON.parse(process.argv[5] ?? "{}") as FreshSamplerParams, HELPER_PROTOCOL);
      process.exit(0);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ done: false, error: err instanceof Error ? err.message : String(err) })}\n`);
      process.exit(1);
    }
  }
  const home = process.env.WINTER_HOME;
  const refusal = liveHomeRefusal(home, tmpdir());
  if (refusal !== undefined) refuse(refusal);
  const shots = join(home!, "cu-live-shots");
  mkdirSync(shots, { recursive: true });
  let shotN = 0;
  const daemon = await startDaemon({
    home: home!,
    secrets: new FileSecretStore(join(home!, "test-secrets")),
    computerUse: {
      // The adapters group's TEST adapter for the fixture app (AX-backed extras) — this daemon only.
      adapters: [FIXTURE_ADAPTER],
      screenshotSink: (shot) => {
        const ext = shot.mime === "image/png" ? "png" : "jpg";
        writeFileSync(join(shots, `${Date.now()}-${String(++shotN).padStart(4, "0")}-${shot.primitive.replace(/[^a-z.]/gi, "")}.${ext}`), Buffer.from(shot.base64, "base64"));
      },
    },
  });
  process.stdout.write(`${JSON.stringify({ ready: true, socket: daemon.socketPath, pid: process.pid })}\n`);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try { await daemon.stop(); } finally { process.exit(0); }
  };
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
}
