import { expect, test } from "bun:test";
import { join } from "node:path";

// Production boot never loads the host-env graph while COWORK_NATIVE_ENVIRONMENT_ACTIVATED is false (the activation seam requires it lazily).
// A fresh process, so no other test's imports count; a Bun plugin records every host-env module that is loaded.
test("a production-shaped daemon boots and stops without loading anything under cowork/host-env", async () => {
  const probe = join(import.meta.dir, "fixtures", "host-env-load-probe.ts");
  const run = Bun.spawnSync([process.execPath, probe], { env: { PATH: process.env.PATH ?? "", HOME: process.env.TMPDIR ?? "/tmp", WINTER_KEYCHAIN_SERVICE: process.env.WINTER_KEYCHAIN_SERVICE ?? "winter-test-throwaway" }, stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString().trim().split("\n").at(-1) ?? "";
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const result = JSON.parse(out) as { loaded: string[]; built: boolean | undefined };
  expect(result.built).toBe(false);
  expect(result.loaded).toEqual([]);
});
test("the probe can see a host-env load (the recorder is not blind)", async () => {
  const run = Bun.spawnSync([process.execPath, "-e", `
    const { readFileSync } = require("node:fs"); const loaded = [];
    Bun.plugin({ name: "r", setup(b) { b.onLoad({ filter: /[\\\\/]cowork[\\\\/]host-env[\\\\/][^\\\\/]+\\.ts$/ }, a => { loaded.push(a.path); return { contents: readFileSync(a.path, "utf8"), loader: "ts" }; }); } });
    await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "cowork", "host-env", "volume-identity"))});
    console.log(JSON.stringify(loaded));`], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  expect(JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!).length).toBeGreaterThan(0);
});
