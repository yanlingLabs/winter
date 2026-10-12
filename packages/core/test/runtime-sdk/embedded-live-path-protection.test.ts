import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(!process.env.WINTER_TEST_PATH_PROTECTION_SDK)("Core live snapshot reaches an actual local candidate Worker without enabling uncovered context", async () => {
  const child = Bun.spawn([process.execPath, "run", "--preload", join(import.meta.dir, "../preload.ts"), join(import.meta.dir, "fixtures/embedded-live-path-protection.ts"), process.env.WINTER_TEST_PATH_PROTECTION_SDK!], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toBe("actual local SDK live file policy verified; context gate retained\n");
}, 30_000);
