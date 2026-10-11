import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskRegistry } from "../../src/agent/bg-registry";
import { sandboxAvailable } from "../../src/agent/sandbox";
import { sessionTmpDir } from "../../src/agent/session-tmp";

const d = sandboxAvailable() ? describe : describe.skip;
function realDir() { return realpathSync(mkdtempSync(join(tmpdir(), "winter-bg-"))); }

function makeRegistry(cwd: string) {
  const events: any[] = [];
  const reg = new BackgroundTaskRegistry({
    emit: (_sid, e) => events.push(e),
    spawnCtx: () => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_bgtest") }),
    killGraceMs: 300,
  });
  return { reg, events };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits on a CONDITION, never on a guess about how fast a sandboxed shell starts: polls `probe` until it holds.
 * `ms` is only the failure bound (a box so loaded that a task never ran must fail loudly, not hang) -- a test
 * that passes returns the moment its condition does, however slow the machine is.
 */
async function until(what: string, probe: () => boolean, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!probe()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The task has ended (`list` does not consume output, unlike `read`). */
function hasEnded(reg: BackgroundTaskRegistry, sessionId: string, taskId: string): boolean {
  return reg.list(sessionId).find((t) => t.taskId === taskId)?.status !== "running";
}

/** A shell snippet that blocks until the test creates `file` -- the test, not a `sleep`, decides when a task moves on. */
const gate = (file: string): string => `while [ ! -e '${file}' ]; do sleep 0.02; done`;

d("BackgroundTaskRegistry", () => {
  test("start → incremental read via cursor → exit event", async () => {
    const cwd = realDir();
    const { reg, events } = makeRegistry(cwd);
    // The task moves on only when the test opens a gate, so what each read may contain does not depend on how fast
    // the sandbox starts or how long a `sleep` really takes on a loaded machine.
    const go1 = join(cwd, "go1"), go2 = join(cwd, "go2");
    const id = reg.start("s1", `echo line1; ${gate(go1)}; echo line2; echo line3; ${gate(go2)}`);
    expect(id).toMatch(/^bg_/);
    expect(events.some((e) => e.type === "bg_task_started" && e.taskId === id)).toBe(true);

    // First read(s): the first line, and the task is still running (its gate is shut).
    let first = "";
    await until("line1", () => { const r = reg.read("s1", id); expect(r.status).toBe("running"); first += r.chunk; return first.includes("line1"); });
    expect(first).not.toContain("line2"); // held behind go1
    const firstLen = first.length;

    // Open the first gate: the next reads carry only NEW output.
    writeFileSync(go1, "");
    let second = "";
    await until("line3", () => { const r = reg.read("s1", id); expect(r.status).toBe("running"); second += r.chunk; return second.includes("line3"); });
    expect(second).not.toContain("line1"); // cursor advanced — only NEW output
    expect(second).toContain("line2");

    // Open the second: the task exits cleanly.
    writeFileSync(go2, "");
    await until("the task to exit", () => hasEnded(reg, "s1", id));
    const done = reg.read("s1", id);
    expect(done.status).toBe("exited");
    expect(done.exitCode).toBe(0);
    expect(done.chunk).toBe(""); // everything was already delivered
    expect(events.some((e) => e.type === "bg_task_exited" && e.taskId === id && e.exitCode === 0)).toBe(true);
    expect(firstLen).toBeGreaterThan(0);
  });

  test("kill reaps the whole process group (no orphan)", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    // grandchild writes its pid then sleeps long; if the group isn't killed it survives
    // (a name of its own: the session tmp dir outlives a run, so a fixed `child.pid` could be a stale one)
    const pidName = `child-${Date.now()}-${process.pid}.pid`;
    const pidFile = join(sessionTmpDir("s_bgtest"), pidName);
    const id = reg.start("s1", `sleep 30 & echo $! > "$TMPDIR/${pidName}"; wait`);
    await until("the grandchild's pid", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(grandchild, 0)).not.toThrow(); // it is running
    reg.kill("s1", id);
    expect(reg.read("s1", id).status).toBe("killed");
    // the backgrounded `sleep 30` must be gone (group kill): SIGTERM at once, SIGKILL after the grace
    await until("the grandchild to be reaped", () => { try { process.kill(grandchild, 0); return false; } catch { return true; } });
    expect(["killed", "exited"]).toContain(reg.read("s1", id).status);
  });

  test("background command cannot write outside the session roots (fence reused)", async () => {
    const cwd = realDir();
    const outside = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", `echo pwned > ${outside}/leak.txt 2>&1 || true`);
    await until("the task to finish", () => reg.read("s1", id).status !== "running"); // it RAN, then the file is checked
    expect(existsSync(join(outside, "leak.txt"))).toBe(false); // denied by the same Seatbelt fence
  });

  test("read/kill on a foreign session's task throws", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", "sleep 1");
    expect(() => reg.read("s2", id)).toThrow();
    expect(() => reg.kill("s2", id)).toThrow();
    reg.kill("s1", id);
  });

  test("list enumerates a session's tasks; killAllForSession clears them", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    const a = reg.start("s1", "sleep 5"); const b = reg.start("s1", "sleep 5");
    expect(reg.list("s1").map((t) => t.taskId).sort()).toEqual([a, b].sort());
    reg.killAllForSession("s1");
    await until("both tasks to be over", () => hasEnded(reg, "s1", a) && hasEnded(reg, "s1", b));
    for (const t of reg.list("s1")) expect(["killed", "exited"]).toContain(t.status);
  });

  test("ring overflow: read() never redelivers already-seen output (cursor stays correct)", async () => {
    const cwd = realDir();
    const events: any[] = [];
    const reg = new BackgroundTaskRegistry({
      emit: (_s, e) => events.push(e),
      spawnCtx: () => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_ov") }),
      killGraceMs: 300, ringCap: 25, // tiny: each 11-byte line overflows quickly
    });
    const id = reg.start("s1", "for i in 1 2 3 4 5; do echo LINE-$i; sleep 0.15; done");
    let assembled = "";
    for (let n = 0; n < 8; n++) {
      await new Promise((r) => setTimeout(r, 150));
      const { chunk } = reg.read("s1", id);
      // strip the one-time drop note before accumulating:
      assembled += chunk.replace("[background output ring full — oldest output dropped]\n", "");
    }
    // no line label should appear twice from redelivered stale output:
    for (const label of ["LINE-1", "LINE-2", "LINE-3", "LINE-4", "LINE-5"]) {
      const occurrences = assembled.split(label).length - 1;
      expect(occurrences).toBeLessThanOrEqual(1); // each seen at most once across all reads (some may be dropped by the ring, never duplicated)
    }
    expect(reg.read("s1", id).status).toBeDefined();
  });

  // CC parity (TaskOutput deprecated in favor of Read on the task's output file): the registry
  // tees every bg task's full output to <sessionTmpDir>/bash/<taskId>.log alongside the in-memory
  // ring — a caller now has BOTH a bash_output poll view and a plain file to Read/grep directly.
  test("output tees to <tmpDir>/bash/<taskId>.log — matches bash_output's view", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", "echo one; echo two; echo three");
    await until("the task to exit", () => hasEnded(reg, "s1", id)); // `list` reads without consuming
    const { chunk } = reg.read("s1", id); // first read — nothing yet consumed/evicted
    const file = reg.outputFile("s1", id);
    expect(file).toMatch(/\/bash\/bg_[0-9a-f]+\.log$/);
    expect(existsSync(file)).toBe(true);
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toBe(chunk); // byte-identical to what bash_output would have shown
    expect(onDisk).toContain("one");
    expect(onDisk).toContain("two");
    expect(onDisk).toContain("three");
  });

  test("outputFile() throws for a foreign session or unknown task, same as read()/kill()", () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", "sleep 1");
    expect(() => reg.outputFile("s2", id)).toThrow();
    expect(() => reg.outputFile("s1", "bg_nope")).toThrow();
    reg.kill("s1", id);
  });

  // Parity-tail review fix: the tee is batched (OutputCoalescer) and byte-capped — on hitting
  // the cap, ONE "[output file capped at ...]" note line lands and the tee stops for good, while
  // the ring (bash_output's view) keeps delivering everything past the cap.
  test("file tee caps: one note line, later output not teed, ring unaffected", async () => {
    const cwd = realDir();
    const reg = new BackgroundTaskRegistry({
      emit: () => {},
      spawnCtx: () => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_fcap") }),
      killGraceMs: 300, fileCap: 8, // tiny: the first chunk alone crosses it
    });
    // two separated chunks: the first (16 bytes) crosses the 8-byte cap, the second must land in the ring but never
    // the file. The second is held behind a gate the test opens only after the first has reached the file, so the
    // two can never be coalesced into one flush however slowly this machine schedules the timers.
    const go = join(cwd, "go");
    const id = reg.start("s1", `printf 'AAAAAAAAAAAAAAAA'; ${gate(go)}; printf 'ZZZZ'`);
    const file = reg.outputFile("s1", id);
    await until("the first chunk to reach the file", () => readFileSync(file, "utf8").includes("[output file capped at"));
    writeFileSync(go, "");
    await until("the task to exit (dispose flushed)", () => hasEnded(reg, "s1", id));
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toContain("AAAA"); // the crossing chunk still flushed in full (generous cap)
    expect(onDisk.split("[output file capped at").length - 1).toBe(1); // exactly one note line
    expect(onDisk).not.toContain("ZZZZ"); // tee stopped after the cap
    const { chunk, status } = reg.read("s1", id);
    expect(chunk).toContain("ZZZZ"); // ring/bash_output keep working past the file cap
    expect(status).toBe("exited");
  });

  test("zero-output task: the output file exists (empty) as soon as the task starts", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", "true");
    const file = reg.outputFile("s1", id);
    expect(existsSync(file)).toBe(true); // pre-created — the spawn result's path is always readable
    await until("the task to exit", () => hasEnded(reg, "s1", id));
    expect(readFileSync(file, "utf8")).toBe("");
  });

  // SP-approvals Task 11 (spec §8): the engine gates BEFORE a bg task ever starts (permission-
  // gate-order.test.ts covers that wiring with a stub, no real sandbox) — this registry just needs
  // to receive and honor the two resolved flags exactly like the foreground bash tool does
  // (tools-bash.test.ts's own escalation-arg suite).
  test("allowNetwork: true still cannot write outside the session roots (fence intact)", async () => {
    const cwd = realDir();
    const outside = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", `echo pwned > ${outside}/leak-network.txt 2>&1 || true`, { allowNetwork: true });
    await until("the task to exit", () => hasEnded(reg, "s1", id)); // it RAN, then the file is checked
    expect(existsSync(join(outside, "leak-network.txt"))).toBe(false);
    expect(reg.read("s1", id).status).toBeDefined();
  });

  test("dangerouslyDisableSandbox: true escapes the fence entirely — a background write outside the roots now SUCCEEDS", async () => {
    const cwd = realDir();
    const outside = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", `echo pwned > ${outside}/leak-unsandboxed.txt`, { dangerouslyDisableSandbox: true });
    await until("the task to exit", () => hasEnded(reg, "s1", id));
    expect(existsSync(join(outside, "leak-unsandboxed.txt"))).toBe(true);
    expect(readFileSync(join(outside, "leak-unsandboxed.txt"), "utf8")).toBe("pwned\n");
    const { status, exitCode } = reg.read("s1", id);
    expect(status).toBe("exited");
    expect(exitCode).toBe(0);
  });
});
