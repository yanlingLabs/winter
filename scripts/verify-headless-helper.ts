/**
 * ComputerV2 Phase 4 — the compiled-artifact gate for Winter Headless: a real build, signed the dev way, driven over its
 * real pipe.
 *
 *   bun run verify:headless-helper            build a proof copy into a temp dir (dist/dev is never touched)
 *   bun run verify:headless-helper --app <p>  check and drive an existing build instead (e.g. dist/dev's)
 *
 * What it proves:
 *   1. the signature (`checkSignedHeadless`): identifier, Winter's team, the hardened runtime, the stated designated
 *      requirement, no entitlements, LSBackgroundOnly, Winter's version, self-contained — and a strict verify, nested
 *      code included, against that requirement;
 *   2. it refuses to run without its pipe (fds 3/4) or without a cache root, before CEF starts;
 *   3. the pipe itself (`scripts/browser-e2e/headless/smoke.ts`): hello, a windowless tab in a session's context, the
 *      allowlist and the world rules, a screenshot, input, an out-of-process iframe, a held dialog answered over
 *      DevTools, the file chooser intercepted, context.dispose, and the exit on EOF — with no window ever owned by it
 *      and the frontmost app unchanged;
 *   4. the whole chain (`engine-smoke.ts`): the REAL engine over the REAL pool, which spawns the helper and checks the
 *      process against its requirement (`processSatisfiesRequirement`) before it sends anything.
 * Everything runs on temp directories; nothing is registered with LaunchServices.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHeadless } from "./dev-headless";
import { HEADLESS, headlessExecutable } from "./headless-helper-lib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail.length > 0 ? ` — ${detail}` : ""}`);
};

function main(): void {
  if (process.platform !== "darwin") { console.error("verify:headless-helper: macOS only"); process.exit(1); }
  const argv = process.argv.slice(2);
  const appIndex = argv.indexOf("--app");
  let app = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  let scratch: string | undefined;
  if (app === undefined) {
    scratch = mkdtempSync(join(tmpdir(), "winter-headless-verify-"));
    console.log(`building a proof copy into ${scratch}…`);
    const built = spawnSync("bun", [join(REPO_ROOT, "scripts", "dev-headless.ts"), "--out", scratch], { stdio: "inherit", env: { ...process.env } });
    if (built.status !== 0) { console.error("verify:headless-helper: the build failed"); process.exit(1); }
    app = join(scratch, `${HEADLESS.dev.name}.app`);
  }
  app = resolve(app);
  try {
    const failures = inspectHeadless(app, "dev");
    check("the signature: stated requirement, hardened runtime, no entitlements, background-only, self-contained", failures.length === 0, failures.join("; "));

    const exe = headlessExecutable(app, "dev");
    const noPipe = spawnSync(exe, ["--winter-cache-root=/tmp/winter-headless-never"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "ignore", "pipe"] });
    check("started without its pipe it refuses at once", noPipe.status === 2 && /only Winter starts this/.test(noPipe.stderr ?? ""), `exit ${noPipe.status}`);
    const sh = spawnSync("/bin/sh", ["-c", `exec "$0" 3</dev/null 4>/dev/null`, exe], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "ignore", "pipe"] });
    check("started without a cache root it refuses at once", sh.status === 2 && /--winter-cache-root/.test(sh.stderr ?? ""), `exit ${sh.status}`);

    const smoke = spawnSync("bun", [join(REPO_ROOT, "scripts", "browser-e2e", "headless", "smoke.ts"), "--app", app], { encoding: "utf8", timeout: 180_000, env: { ...process.env } });
    const smokeTail = (smoke.stdout ?? "").trim().split("\n").at(-1) ?? "";
    check("the pipe (smoke.ts)", smoke.status === 0, smokeTail);
    if (smoke.status !== 0) console.log(smoke.stdout);

    const engine = spawnSync("bun", [join(REPO_ROOT, "scripts", "browser-e2e", "headless", "engine-smoke.ts"), "--app", app], { encoding: "utf8", timeout: 180_000, env: { ...process.env } });
    const engineTail = (engine.stdout ?? "").trim().split("\n").at(-1) ?? "";
    check("the engine over the pool, the signature checked (engine-smoke.ts)", engine.status === 0, engineTail);
    if (engine.status !== 0) console.log(engine.stdout);
  } finally {
    if (scratch !== undefined && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`verify:headless-helper: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) main();
