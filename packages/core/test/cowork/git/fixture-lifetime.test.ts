import { expect, test } from "bun:test";
import { GitPublicationError } from "../../../src/cowork/git/types";
import { GitFixtureLifetime } from "./fixture-lifetime";

test("fixture close aborts and drains a rejected command before directory cleanup", async () => {
  const lifetime = new GitFixtureLifetime(); let entered!: () => void, settled = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const executor = lifetime.executor({ run: command => new Promise((_, reject) => {
    entered(); command.signal!.addEventListener("abort", () => {
      // Model executor close/pipe draining after cancellation, without a Git process.
      setTimeout(() => { settled = true; reject(new GitPublicationError("cancelled")); }, 5);
    }, { once: true });
  }) });
  const result = executor.run({ cwd: "/unused", home: "/unused", args: [] });
  await started; await lifetime.close();
  expect(settled).toBe(true); await expect(result).rejects.toMatchObject({ code: "cancelled" });
});

test("abandoned workflow rejection is observed and cannot start a later command after close", async () => {
  const lifetime = new GitFixtureLifetime(); let resume!: () => void, effects = 0;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const executor = lifetime.executor({ async run() { effects++; return { code: 0, stdout: "" }; } });
  const workflow = lifetime.track(async () => { await paused; return executor.run({ cwd: "/unused", home: "/unused", args: [] }); });
  await Bun.sleep(0);
  const closing = lifetime.close(); resume(); await closing;
  expect(effects).toBe(0);
  await expect(workflow).rejects.toMatchObject({ code: "cancelled" });
  await expect(executor.run({ cwd: "/unused", home: "/unused", args: [] })).rejects.toMatchObject({ code: "cancelled" });
  expect(effects).toBe(0);
});

test("fixture observers preserve the original command failure and caller cancellation", async () => {
  const lifetime = new GitFixtureLifetime(), original = new GitPublicationError("command_failed"), caller = new AbortController();
  caller.abort(); let aborted = false;
  const executor = lifetime.executor({ async run(command) { aborted = command.signal!.aborted; throw original; } });
  await expect(executor.run({ cwd: "/unused", home: "/unused", args: [], signal: caller.signal })).rejects.toBe(original);
  expect(aborted).toBe(true); await lifetime.close();
});
