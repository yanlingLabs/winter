import { expect, test } from "bun:test";
import { COWORK_FREE_SPACE_RESERVE_BYTES, type FilesystemSpace, type FilesystemSpaceReader, type SpaceTarget } from "../../../src/cowork/native/free-space";
import { COWORK_PRESSURE_HALT_TIMEOUT_MS, COWORK_PRESSURE_RESUME_MARGIN_BYTES, CoworkPressureGuard, type PressureTransition, type WriterHaltOutcome, type WriterHaltPort, type WriterHaltRequest } from "../../../src/cowork/native/pressure";

const GiB = 1024 ** 3, R = COWORK_FREE_SPACE_RESERVE_BYTES, M = COWORK_PRESSURE_RESUME_MARGIN_BYTES;
const space = (availableBytes: number, filesystemId = "fsid:a:1"): FilesystemSpace => ({ filesystemId, typeName: "apfs", blockBytes: 4096, totalBytes: 10 ** 13, availableBytes });

/** Readings are keyed by the path of a `{kind:"path"}` target and mutable between evaluations. */
class FakeSpace implements FilesystemSpaceReader {
  readings = new Map<string, FilesystemSpace | null | "throw" | "garbage">();
  reads: string[] = [];
  set(key: string, value: number | null | "throw" | "garbage"): void { this.readings.set(`/${key}`, typeof value === "number" ? space(value, `fsid:${key}`) : value); }
  read(target: SpaceTarget): FilesystemSpace | null {
    const path = target.kind === "path" ? target.path : "?"; this.reads.push(path);
    const value = this.readings.get(path);
    if (value === "throw") throw new Error("statfs failed");
    if (value === "garbage") return { filesystemId: "x", typeName: "apfs", blockBytes: 4096, totalBytes: 1, availableBytes: Number.NaN };
    return value ?? null;
  }
}
type HaltScript = (request: WriterHaltRequest, call: number) => WriterHaltOutcome | Promise<WriterHaltOutcome>;
class FakeWriters implements WriterHaltPort {
  calls: WriterHaltRequest[] = [];
  script: HaltScript = () => ({ halted: true });
  haltWriters(request: WriterHaltRequest) { this.calls.push(request); return this.script(request, this.calls.length); }
}
function guardFor(keys: readonly string[], opts: Partial<ConstructorParameters<typeof CoworkPressureGuard>[0]> = {}) {
  const reader = new FakeSpace(), writers = new FakeWriters(), transitions: PressureTransition[] = [];
  const guard = new CoworkPressureGuard({ space: reader, writers, onTransition: t => transitions.push(t), ...opts });
  for (const key of keys) { guard.watch(key, { kind: "path", path: `/${key}` }); reader.set(key, 100 * GiB); }
  return { guard, reader, writers, transitions };
}

test("constants: the 5 GiB reserve, a provisional resume margin and halt timeout", () => {
  expect(R).toBe(5 * GiB);
  expect(M).toBeGreaterThanOrEqual(1);
  expect(COWORK_PRESSURE_HALT_TIMEOUT_MS).toBeGreaterThanOrEqual(1);
});
test("construction validates its ports and options", () => {
  const ports = { space: new FakeSpace(), writers: new FakeWriters() };
  expect(() => new CoworkPressureGuard({ ...ports, space: {} as FilesystemSpaceReader })).toThrow(TypeError);
  expect(() => new CoworkPressureGuard({ ...ports, writers: {} as WriterHaltPort })).toThrow(TypeError);
  expect(() => new CoworkPressureGuard(undefined as never)).toThrow(TypeError);
  for (const bad of [{ reserveBytes: 0 }, { reserveBytes: 1.5 }, { resumeMarginBytes: 0 }, { resumeMarginBytes: -1 }, { haltTimeoutMs: 0 }, { haltTimeoutMs: 600_001 }, { reserveBytes: Number.MAX_SAFE_INTEGER, resumeMarginBytes: 2 }]) expect(() => new CoworkPressureGuard({ ...ports, ...bad })).toThrow(RangeError);
  const guard = new CoworkPressureGuard(ports);
  for (const key of ["", "a b", "x".repeat(201), "a/b"]) expect(() => guard.watch(key, { kind: "path", path: "/x" })).toThrow(TypeError);
  expect(() => guard.watch("ok", undefined as never)).toThrow(TypeError);
});
test("boundary: free == reserve does not block; free == reserve - 1 does; reserve + 1 does not", async () => {
  for (const [free, blocked] of [[R - 1, true], [R, false], [R + 1, false]] as const) {
    const { guard, reader, writers } = guardFor(["a"]); reader.set("a", free);
    const report = await guard.evaluate();
    expect({ free: free - R, blocked: report.blocked.length === 1, halts: writers.calls.length }).toEqual({ free: free - R, blocked, halts: blocked ? 1 : 0 });
    expect(guard.admitsNewWork()).toBe(!blocked);
  }
});
test("crossing the reserve reports a structured resource_blocked and halts the writers with the evidence", async () => {
  const { guard, reader, writers, transitions } = guardFor(["a"]); reader.set("a", R - 1);
  const report = await guard.evaluate();
  expect(report.blocked).toEqual([{ outcome: "resource_blocked", reason: "free_space_below_reserve", requiredBytes: null, availableBytes: R - 1, reserveBytes: R, filesystemId: "fsid:a" }]);
  expect(writers.calls).toEqual([{ key: "a", episode: 1, reason: "free_space_below_reserve", availableBytes: R - 1, reserveBytes: R }]);
  expect(report.haltUnconfirmed).toEqual([]);
  expect(transitions).toEqual([{ key: "a", from: "clear", to: "blocked", episode: 1, reason: "free_space_below_reserve", availableBytes: R - 1 }]);
  expect(guard.snapshot().entries[0]).toMatchObject({ key: "a", state: "blocked", episode: 1, haltConfirmed: true, observed: true });
});
test("never evaluated and nothing watched both fail closed; a clear observed key admits", async () => {
  const { guard } = guardFor(["a"]);
  expect(guard.admitsNewWork()).toBe(false); // watched but never evaluated
  expect(new CoworkPressureGuard({ space: new FakeSpace(), writers: new FakeWriters() }).admitsNewWork()).toBe(false); // nothing watched
  await guard.evaluate(); expect(guard.admitsNewWork()).toBe(true);
  expect(guard.snapshot().evaluatedAt).not.toBeNull();
  guard.watch("late", { kind: "path", path: "/late" }); expect(guard.admitsNewWork()).toBe(false); // a new key is unobserved until sampled
});
test("hysteresis: a flapping reading blocks once, clears only at reserve + margin, and a new dip is a new episode", async () => {
  const { guard, reader, writers, transitions } = guardFor(["a"]);
  const step = async (free: number) => { reader.set("a", free); return guard.evaluate(); };
  await step(R - 1);                                       // block, episode 1, halt #1
  await step(R); await step(R + 1); await step(R + M - 1); // above the reserve but below the resume line: still blocked
  await step(R - 1); await step(R + M - 1);                // dipping again must not halt or open another episode
  expect(guard.admitsNewWork()).toBe(false);
  expect(writers.calls.map(c => c.episode)).toEqual([1]);
  const cleared = await step(R + M);                       // the resume line itself clears
  expect(cleared.blocked).toEqual([]); expect(guard.admitsNewWork()).toBe(true);
  await step(R); await step(R + M - 1); expect(guard.admitsNewWork()).toBe(true); // clear stays clear until the reserve is crossed
  await step(R - 1);                                       // a new crossing: episode 2, halt #2
  expect(writers.calls.map(c => c.episode)).toEqual([1, 2]);
  expect(transitions.map(t => `${t.from}>${t.to}:${t.episode}`)).toEqual(["clear>blocked:1", "blocked>clear:1", "clear>blocked:2"]);
});
test("a failing writer-halt port keeps the key blocked, is retried every evaluation, and never lets space alone clear it", async () => {
  const failures: Record<string, HaltScript> = {
    throws: () => { throw new Error("port down"); },
    rejects: () => Promise.reject(new Error("port down")),
    refuses: () => ({ halted: false }),
    garbage: () => undefined as unknown as WriterHaltOutcome,
    truthyButNotTrue: () => ({ halted: 1 }) as unknown as WriterHaltOutcome,
  };
  for (const [name, script] of Object.entries(failures)) {
    const { guard, reader, writers } = guardFor(["a"]); writers.script = script; reader.set("a", R - 1);
    const first = await guard.evaluate();
    expect({ name, blocked: first.blocked.length, unconfirmed: first.haltUnconfirmed }).toEqual({ name, blocked: 1, unconfirmed: ["a"] });
    expect(guard.snapshot().entries[0]).toMatchObject({ state: "blocked", haltConfirmed: false });
    reader.set("a", R + M + 10 * GiB);                    // plenty of space again, but the writers are not confirmed halted
    const second = await guard.evaluate();
    expect({ name, state: guard.snapshot().entries[0]!.state, unconfirmed: second.haltUnconfirmed }).toEqual({ name, state: "blocked", unconfirmed: ["a"] });
    expect(guard.admitsNewWork()).toBe(false);
    expect(writers.calls.map(c => c.episode)).toEqual([1, 1]); // retried, same episode
    writers.script = () => ({ halted: true });            // the port recovers: the retry confirms and the same evaluation clears
    const third = await guard.evaluate();
    expect({ name, blocked: third.blocked, transitions: third.transitions.map(t => t.to) }).toEqual({ name, blocked: [], transitions: ["clear"] });
    expect(guard.admitsNewWork()).toBe(true);
  }
});
test("a halt that never answers times out as a failure and does not stall the other filesystems", async () => {
  const { guard, reader, writers } = guardFor(["a", "b"], { haltTimeoutMs: 25 });
  writers.script = request => request.key === "a" ? new Promise<WriterHaltOutcome>(() => {}) : { halted: true };
  reader.set("a", R - 1); reader.set("b", R - 1);
  const started = Date.now(), report = await guard.evaluate();
  expect(Date.now() - started).toBeLessThan(2000);
  expect(report.haltUnconfirmed).toEqual(["a"]);
  expect(report.blocked.map(b => b.filesystemId).sort()).toEqual(["fsid:a", "fsid:b"]);
  expect(guard.snapshot().entries.map(e => [e.key, e.haltConfirmed])).toEqual([["a", false], ["b", true]]);
});
test("an unreadable filesystem blocks, halts with a null reading, and clears only on a good reading above the resume line", async () => {
  for (const bad of [null, "throw", "garbage"] as const) {
    const { guard, reader, writers } = guardFor(["a"]); reader.set("a", bad);
    const report = await guard.evaluate();
    expect({ bad, blocked: report.blocked }).toEqual({ bad, blocked: [{ outcome: "resource_blocked", reason: "free_space_unavailable", requiredBytes: null, availableBytes: null, reserveBytes: R, filesystemId: null }] });
    expect(writers.calls).toEqual([{ key: "a", episode: 1, reason: "free_space_unavailable", availableBytes: null, reserveBytes: R }]);
    reader.set("a", null); await guard.evaluate(); expect(guard.admitsNewWork()).toBe(false);   // still unreadable
    reader.set("a", R + M - 1); await guard.evaluate(); expect(guard.admitsNewWork()).toBe(false); // readable but below the resume line
    reader.set("a", R + M); await guard.evaluate(); expect(guard.admitsNewWork()).toBe(true);
  }
});
test("keys are independent; any blocked key refuses all new work; one cleared key does not clear another", async () => {
  const { guard, reader, writers } = guardFor(["a", "b", "c"]);
  reader.set("b", R - 1); await guard.evaluate();
  expect(writers.calls.map(c => c.key)).toEqual(["b"]);
  expect(guard.snapshot().entries.map(e => [e.key, e.state])).toEqual([["a", "clear"], ["b", "blocked"], ["c", "clear"]]);
  expect(guard.admitsNewWork()).toBe(false);
  reader.set("a", R - 1); reader.set("b", R + M); await guard.evaluate();
  expect(guard.snapshot().entries.map(e => [e.key, e.state])).toEqual([["a", "blocked"], ["b", "clear"], ["c", "clear"]]);
  expect(writers.calls.map(c => c.key)).toEqual(["b", "a"]);
});
test("all filesystems are sampled before any halt runs, so one slow halt cannot skew the other readings", async () => {
  const { guard, reader, writers } = guardFor(["a", "b"]);
  let readsAtFirstHalt = -1; writers.script = () => { if (readsAtFirstHalt < 0) readsAtFirstHalt = reader.reads.length; return { halted: true }; };
  reader.reads.length = 0; reader.set("a", R - 1); reader.set("b", R - 1);
  await guard.evaluate();
  expect(readsAtFirstHalt).toBe(2);
});
test("unwatch reports whether the key was blocked; a retarget keeps the key's state; unwatching during a halt does not resurrect it", async () => {
  const { guard, reader } = guardFor(["a", "b"]);
  reader.set("a", R - 1); await guard.evaluate();
  guard.watch("a", { kind: "path", path: "/moved" }); reader.readings.set("/moved", space(R - 1));
  expect(guard.snapshot().entries[0]).toMatchObject({ key: "a", state: "blocked", episode: 1 });
  expect(guard.unwatch("b")).toEqual({ wasBlocked: false });
  expect(guard.unwatch("b")).toEqual({ wasBlocked: false });
  expect(guard.unwatch("a")).toEqual({ wasBlocked: true });
  expect(guard.snapshot().entries).toEqual([]);
  const fresh = guardFor(["x"]); fresh.reader.set("x", R - 1);
  fresh.writers.script = () => { fresh.guard.unwatch("x"); return { halted: true }; };
  const report = await fresh.guard.evaluate();
  expect(fresh.guard.snapshot().entries).toEqual([]); expect(report.blocked).toEqual([]);
  expect(fresh.guard.admitsNewWork()).toBe(false); // nothing watched fails closed
});
test("evaluations are serialized: a slow halt finishes before the next sample is taken", async () => {
  const { guard, reader, writers } = guardFor(["a"]);
  const order: string[] = [];
  writers.script = async () => { order.push("halt-start"); await new Promise(r => setTimeout(r, 30)); order.push("halt-end"); return { halted: true }; };
  const baseRead = reader.read.bind(reader); reader.read = target => { order.push("sample"); return baseRead(target); };
  reader.set("a", R - 1);
  const first = guard.evaluate(), second = guard.evaluate();
  await Promise.all([first, second]);
  expect(order).toEqual(["sample", "halt-start", "halt-end", "sample"]);
});
test("a throwing transition listener never changes the guard", async () => {
  const { guard, reader } = guardFor(["a"], { onTransition: () => { throw new Error("listener"); } });
  reader.set("a", R - 1); await guard.evaluate(); expect(guard.admitsNewWork()).toBe(false);
  reader.set("a", R + M); await guard.evaluate(); expect(guard.admitsNewWork()).toBe(true);
});
test("the guard touches only read() on the reader and haltWriters() on the port", async () => {
  const touched: string[] = [];
  // Methods are bound to the real object so only the guard's own accesses are recorded.
  const watchOnly = <T extends object>(label: string, allowed: string, target: T): T => new Proxy(target, {
    get(t, key) { if (typeof key === "string" && key !== allowed) touched.push(`${label}.${key}`); const value = Reflect.get(t, key, t); return typeof value === "function" ? value.bind(t) : value; },
  });
  const reader = new FakeSpace(), writers = new FakeWriters();
  const guard = new CoworkPressureGuard({ space: watchOnly("space", "read", reader), writers: watchOnly("writers", "haltWriters", writers) });
  guard.watch("a", { kind: "path", path: "/a" }); reader.set("a", R - 1); await guard.evaluate(); reader.set("a", R + M); await guard.evaluate();
  expect(touched).toEqual([]);
  expect(writers.calls).toHaveLength(1);
});
test("snapshot entries are frozen copies", async () => {
  const { guard, reader } = guardFor(["a"]); reader.set("a", R - 1); await guard.evaluate();
  const snap = guard.snapshot(), entry = snap.entries[0]!;
  expect(Object.isFrozen(entry)).toBe(true);
  expect(() => { (entry as { state: string }).state = "clear"; }).toThrow();
  expect(guard.snapshot().entries[0]!.state).toBe("blocked");
});
