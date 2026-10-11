// ComputerV2 Phase 4 (spine §5.7) — the restart notice after the idle end. The 30-minute idle end deletes the session's
// runtime state (its `hadWorker` with it), so the next call used to start silently: the model found out from an
// `undefined` or a `TargetLost` that its variables and handles were gone. Now it is told.
import { afterEach, describe, expect, test } from "bun:test";
import { idleWords, type ComputerV2Service } from "../../src/computer-use/service";
import { savedScriptsWorld, sleepMs, textOf } from "./saved-scripts-harness";

const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });
const world = (idleMs?: number) => { const w = savedScriptsWorld(idleMs === undefined ? {} : { idleMs }); services.push(w.svc); return w; };

const IDLE_NOTICE = /The automation runtime restarted after \d+ seconds? without use; earlier variables and bindings are gone\./;

describe("the restart notice after the idle end", () => {
  test("a call after the idle end says the runtime restarted, and the variables are indeed gone", async () => {
    const w = world(40);
    expect(textOf(await w.run("const kept = 7\nprint(kept)"))).not.toContain("restarted");
    await sleepMs(120);
    expect(w.svc.workerPid("s1")).toBeUndefined();
    const r = await w.run("print(typeof kept)");
    expect(textOf(r)).toMatch(IDLE_NOTICE);
    expect(textOf(r)).toContain("undefined");
    // Said once: the call after it is quiet.
    expect(textOf(await w.run("print(1)"))).not.toContain("restarted");
  });

  test("the very first call of a session says nothing", async () => {
    const w = world(40);
    expect(textOf(await w.run("print(1)"))).not.toContain("restarted");
  });

  test("a deleted session's next incarnation starts quietly", async () => {
    const w = world(40);
    await w.run("print(1)");
    w.svc.endSession("s1", "deleted");
    expect(textOf(await w.run("print(2)"))).not.toContain("restarted");
  });

  test("an idle end, then a reset: the reset notice only", async () => {
    const w = world(40);
    await w.run("print(1)");
    await sleepMs(120);
    const r = await w.run("print(2)", { reset: true });
    expect(textOf(r)).toContain("The automation runtime was reset: earlier variables and bindings are gone (apps stay open).");
    expect(textOf(r)).not.toContain("restarted");
  });

  test("a crash keeps the old notice; with no saved script it says nothing about them", async () => {
    const w = world();
    await w.run("print(1)");
    w.latest().kill();
    const r = await w.run("print(2)");
    expect(textOf(r)).toContain("The automation runtime restarted; earlier variables and bindings are gone.");
    expect(textOf(r)).not.toContain("Saved scripts");
  });

  test("the idle end's length in words: 30 minutes in production", () => {
    expect(idleWords(30 * 60_000)).toBe("30 minutes");
    expect(idleWords(60_000)).toBe("1 minute");
    expect(idleWords(40)).toBe("1 second");
    expect(idleWords(5_000)).toBe("5 seconds");
  });
});
