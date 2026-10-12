/**
 * ComputerV2 Phase 4 — the compiled-artifact gate for Winter Headless: a real build, signed the dev way, driven over its
 * real pipe.
 *
 *   bun run verify:headless-helper            build a proof copy into a temp dir (dist/dev is never touched)
 *   bun run verify:headless-helper --app <p>  check and drive an existing build instead: dist/dev's, or a Release
 *                                             Winter.app's nested Contents/Helpers/Winter Headless.app (its flavor is
 *                                             read from its bundle id; a nested one must borrow the enclosing app's
 *                                             Chromium and carry none of its own)
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHeadless } from "./dev-headless";
import { HEADLESS, headlessExecutable, type HeadlessFlavor } from "./headless-helper-lib";

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
  const id = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).stdout.trim();
  const flavor: HeadlessFlavor = id === HEADLESS.dist.identifier ? "dist" : "dev";
  console.log(`${app}: ${id} (${flavor === "dist" ? "a Release helper, nested in Winter.app" : "a self-contained dev helper"})`);
  try {
    const failures = inspectHeadless(app, flavor);
    check(flavor === "dist"
      ? "the signature: stated requirement, hardened runtime, no entitlements, background-only, no Chromium of its own"
      : "the signature: stated requirement, hardened runtime, no entitlements, background-only, self-contained", failures.length === 0, failures.join("; "));

    if (flavor === "dist") {
      // Nested at Winter.app/Contents/Helpers/: the enclosing app's Chromium is what it runs.
      const frameworks = join(app, "..", "..", "Frameworks");
      const borrowed = ["Chromium Embedded Framework.framework", ...["", " (Alerts)", " (GPU)", " (Plugin)", " (Renderer)"].map((s) => `Winter Helper${s}.app`)]
        .filter((name) => !existsSync(join(frameworks, name)));
      check("nested in a Winter.app whose Frameworks hold the CEF framework and the five Winter Helper bundles", basename(join(app, "..")) === "Helpers" && borrowed.length === 0,
        borrowed.length === 0 ? resolve(frameworks) : `missing: ${borrowed.join(", ")}`);
    }

    const exe = headlessExecutable(app, flavor);
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
