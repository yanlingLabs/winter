import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedGitReadCommandRunner } from "../../../src/cowork/git/read-owned-command";
import { parserFixtureCommand } from "./read-parser-fixture";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const value = mkdtempSync(join(tmpdir(), "winter-git-owned-command-")); homes.push(value); return value; }
const limits = { capacity: 1, wallMs: 100, outputBytes: 64, drainMs: 500 };
function command(root: string, source: string) { return { file: process.execPath, args: ["--no-env-file", "-e", source], cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root } }; }
function kernelDead(child: ChildProcess) { expect(child.pid).toBeGreaterThan(0); expect(() => process.kill(child.pid!, 0)).toThrow(); }

test("real auxiliary timeout confirms owned exit before rejection and reclaims its slot", async () => {
  const root = home(); let child!: ChildProcess, exit = false;
  const launcher = ((file: string, args: readonly string[], options: SpawnOptions) => { child = spawn(file, args, options); child.once("exit", () => { exit = true; }); return child; }) as typeof spawn;
  const runner = new OwnedGitReadCommandRunner(limits, { isolatedFixture: true, spawn: launcher });
  await expect(runner.run(command(root, 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'))).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(exit).toBe(true); kernelDead(child); expect(runner.retainedOwnership).toBe(0); expect(runner.measurements.uncertainStops).toBe(0);
  expect((await runner.run({ file: "/usr/bin/printf", args: ["ok"], cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root } })).stdout).toBe("ok");
});
test("combined reader cap never rejects while the real auxiliary process remains alive", async () => {
  const root = home(); let child!: ChildProcess, exit = false;
  const launcher = ((file: string, args: readonly string[], options: SpawnOptions) => { child = spawn(file, args, options); child.once("exit", () => { exit = true; }); return child; }) as typeof spawn;
  const runner = new OwnedGitReadCommandRunner({ ...limits, wallMs: 1_000 }, { isolatedFixture: true, spawn: launcher });
  await expect(runner.run(command(root, 'process.stdout.write("A".repeat(512));setInterval(()=>{},1000);'))).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(exit).toBe(true); kernelDead(child); expect(runner.retainedOwnership).toBe(0);
});
test("unconfirmed exit retains admission debt after drain; only an exit event releases it", async () => {
  const fake = Object.assign(new EventEmitter(), { pid: 123456789, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let kills = 0;
  const runner = new OwnedGitReadCommandRunner({ ...limits, wallMs: 5, drainMs: 10 }, { isolatedFixture: true, spawn: (() => fake) as unknown as typeof spawn, kill: () => { kills++; } });
  await expect(runner.run(command(home(), "unused"))).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(kills).toBeGreaterThan(0); expect(runner.measurements.uncertainStops).toBe(1); expect(runner.retainedOwnership).toBe(1);
  await expect(runner.run(command(home(), "unused"))).rejects.toMatchObject({ code: "busy" });
  fake.emit("exit", -1); expect(runner.retainedOwnership).toBe(0);
});
test("synchronous no-child launch failure releases auxiliary admission", async () => {
  let calls = 0;
  const runner = new OwnedGitReadCommandRunner(limits, { isolatedFixture: true, spawn: (() => { calls++; throw new Error("fixture launch failed"); }) as typeof spawn });
  for (let i = 0; i < 2; i++) await expect(runner.run(command(home(), "unused"))).rejects.toMatchObject({ code: "integration_unavailable" });
  expect(calls).toBe(2); expect(runner.retainedOwnership).toBe(0);
});
test("fixture wrapper actually bounds compiler/tool output and preserves isolated HOME", async () => {
  const root = home();
  await expect(parserFixtureCommand(root, [process.execPath, "--no-env-file", "-e", 'process.stdout.write("x".repeat(70_000));setInterval(()=>{},1000);'], root)).rejects.toMatchObject({ code: "budget_exceeded" });
  const result = await parserFixtureCommand(root, [process.execPath, "--no-env-file", "-e", 'process.stdout.write(process.env.HOME);'], root);
  expect(result.output).toBe(root); expect(result.code).toBe(0);
});
