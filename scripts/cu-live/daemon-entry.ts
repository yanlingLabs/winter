// The live ComputerV2 suite's DAEMON: compiled into `out/cu-live/winter-core-live` and signed with the dev daemon's
// identity (`com.winter.core.dev`, Winter's team) by `scripts/cu-live/build.ts`, so the signed dev helper accepts it
// as its daemon — the helper checks its peer's designated requirement, and a `bun` process would be refused.
//
// It is NOT the shipped `winter-core`: a separate compile entry that starts the real daemon (`startDaemon`) on a
// TEMP home with a FILE secret store, so a run never reads or writes the Keychain, and refuses anything else:
//   - `WINTER_CU_LIVE_TESTS=1` must be set;
//   - `WINTER_HOME` must be absolute, exist, sit under the system temp dir, carry `winter-cu-live-` in its path,
//     and be neither profile's default home (`~/.winter`, `~/.winter-dev`).
// It also serves the one self-spawn ComputerV2 needs: `<this binary> __automation-worker` (the sandboxed worker).
// Code sessions run the external `winter` runtime (`WINTER_RUNTIME_EXECUTABLE`, set by the runner).
//
// On start it prints ONE JSON line `{"ready":true,"socket":…,"pid":…}`; SIGTERM/SIGINT stop it cleanly.
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AUTOMATION_WORKER_ARG, FileSecretStore, isDefaultWinterHome, runAutomationWorker, startDaemon } from "../../packages/core/src/index";

if (process.argv[2] === AUTOMATION_WORKER_ARG) {
  runAutomationWorker();
  await new Promise(() => {});   // the worker exits when the daemon closes its stdin
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
  const home = process.env.WINTER_HOME;
  const refusal = liveHomeRefusal(home, tmpdir());
  if (refusal !== undefined) refuse(refusal);
  const daemon = await startDaemon({ home: home!, secrets: new FileSecretStore(join(home!, "test-secrets")) });
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
