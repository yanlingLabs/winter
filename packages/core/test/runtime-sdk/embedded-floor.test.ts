import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedSessionHost, EmbeddedRuntimeUnavailable } from "../../src/runtime-sdk/embedded";
import { registerHostStorageFences } from "../../src/runtime-sdk/host-storage-fence";

test("actual Core embedded host refuses active protection without asking an older SDK worker to interpret flags", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-embedded-protected-"))), home = join(root, "home");
  mkdirSync(join(home, "cowork"), { recursive: true });
  const unregister = registerHostStorageFences(home, { coordinationDir: join(root, "coordination"), coworkStorageActive: true });
  let called = 0;
  const host = createEmbeddedSessionHost({ home, spawnWorker: () => { called++; throw new Error("older SDK ignores flags"); } });
  try {
    expect(() => host.spawn({ command: "winter-embedded", args: [], cwd: root, env: {} })).toThrow(EmbeddedRuntimeUnavailable);
    expect(called).toBe(0);
  } finally { unregister(); }
});

test("actual Core embedded host independently refuses requireHostFloor and native-floor command options", () => {
  let called = 0;
  const host = createEmbeddedSessionHost({ spawnWorker: () => { called++; throw new Error("older SDK ignores flags"); } });
  for (const options of [{ requireHostFloor: true, command: "winter-embedded" }, { command: "/usr/bin/sandbox-exec" }]) {
    expect(() => host.spawn({ ...options, args: [], cwd: "/", env: {} } as never)).toThrow(EmbeddedRuntimeUnavailable);
  }
  expect(called).toBe(0);
});

test("actual use-point recheck refuses storage enabled by host preparation before the worker is constructed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-embedded-preparation-"))), home = join(root, "home");
  mkdirSync(join(home, "cowork"), { recursive: true });
  let called = 0, unregister: (() => void) | undefined;
  const host = createEmbeddedSessionHost({ home,
    workflowWorkerCommand: () => { unregister = registerHostStorageFences(home, { coordinationDir: join(root, "coordination"), coworkStorageActive: true }); return { file: process.execPath, args: [] }; },
    spawnWorker: () => { called++; throw new Error("older SDK ignores flags"); },
  });
  try { expect(() => host.spawn({ command: "winter-embedded", args: [], cwd: root, env: {} })).toThrow(EmbeddedRuntimeUnavailable); expect(called).toBe(0); }
  finally { unregister?.(); }
});

for (const mode of ["live", "retired", "daemon"]) test(mode === "daemon" ? "real daemon wiring rejects active embedded topology, direct host spawn and captured closure" : `real ${mode} embedded Worker closes resumably before storage activation without third-party descendant debt`, async () => {
  const child = Bun.spawn([process.execPath, "run", "--preload", join(import.meta.dir, "../preload.ts"), join(import.meta.dir, "fixtures/embedded-floor.ts"), mode], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // A failing fixture says why: its exit code alone hid the cause of an intermittent CI failure.
  if (code !== 0 || stderr.includes("error:")) console.error(`embedded-floor fixture (${mode}) exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  expect(code).toBe(0);
  expect(stderr).not.toContain("error:");
  expect(stdout.endsWith("embedded descendant gate verified\n")).toBe(true);
}, 20_000);
