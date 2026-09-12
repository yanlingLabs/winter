import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner, type HookEventPayload, type HookSpec } from "../../src/plugins/hook-runner";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "winter-hook-runner-"));
}

function mkPayload(overrides: Partial<HookEventPayload> = {}): HookEventPayload {
  return { event: "pre-tool", sessionId: "sess-1", pluginId: "demo", ts: 1234, ...overrides };
}

function mkSpec(overrides: Partial<HookSpec> = {}): HookSpec {
  return { pluginId: "demo", command: "true", cwd: tmpDir(), ...overrides };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HookRunner.run", () => {
  test("(a) exit-0 script echoing stdout → ok, stdout captured", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "echo hello-stdout" }), mkPayload());
    expect(result.status).toBe("ok");
    expect(result.stdout.trim()).toBe("hello-stdout");
    expect(result.reason).toBeUndefined();
  });

  test("(b) exit-2 script writing stderr → blocked, reason from stderr", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "echo denied-reason 1>&2; exit 2" }), mkPayload());
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("denied-reason");
  });

  test("(b2) exit-2 with no stderr → blocked, reason undefined", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "exit 2" }), mkPayload());
    expect(result.status).toBe("blocked");
    expect(result.reason).toBeUndefined();
  });

  test("(c) exit-1 → error", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "echo boom 1>&2; exit 1" }), mkPayload());
    expect(result.status).toBe("error");
    expect(result.reason).toBe("boom");
  });

  test("(d) sleeping script + timeoutMs 100 → timeout in ~100ms, process is actually dead", async () => {
    const runner = new HookRunner();
    const dir = tmpDir();
    const pidFile = join(dir, "pid");
    const start = Date.now();
    const result = await runner.run(
      mkSpec({ cwd: dir, command: `echo $$ > "${pidFile}"; sleep 5`, timeoutMs: 100 }),
      mkPayload(),
    );
    const elapsed = Date.now() - start;

    expect(result.status).toBe("timeout");
    // Resolved close to the 100ms timeout, nowhere near the 5s sleep — proves the timer won the race.
    expect(elapsed).toBeLessThan(2000);

    // Poll (bounded, short interval) that the spawned shell's own pid is no longer alive — proves
    // proc.kill() actually reaped the process rather than leaving it running in the background.
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    for (let i = 0; i < 25; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await sleep(20);
    }
    expect(alive).toBe(false);
  });

  test("(e) stdout beyond the cap is truncated at 8192 chars", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "yes x | head -c 20000" }), mkPayload());
    expect(result.status).toBe("ok");
    expect(result.stdout.length).toBe(8192);
  });

  test("(f) the JSON payload arrives on stdin — round-trips through a `cat`", async () => {
    const runner = new HookRunner();
    const payload = mkPayload({ event: "session-start", extra: "field" });
    const result = await runner.run(mkSpec({ command: "cat" }), payload);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  test("(g) a bogus/nonexistent command → error, never throws", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "this-command-does-not-exist-xyz-123" }), mkPayload());
    expect(result.status).toBe("error");
  });

  test("(g2) Bun.spawn itself throwing (invalid cwd) → error, never throws", async () => {
    const runner = new HookRunner();
    const result = await runner.run(
      mkSpec({ command: "echo hi", cwd: "/no/such/directory/for/sure/xyz-abc-123" }),
      mkPayload(),
    );
    expect(result.status).toBe("error");
    expect(result.reason).toBeDefined();
  });

  test("(h) WINTER_SESSION_ID/WINTER_PLUGIN_ID/WINTER_HOOK_EVENT are set in the child's env", async () => {
    const runner = new HookRunner();
    const result = await runner.run(
      mkSpec({ pluginId: "plugin-x", command: 'printf "%s|%s|%s" "$WINTER_SESSION_ID" "$WINTER_PLUGIN_ID" "$WINTER_HOOK_EVENT"' }),
      mkPayload({ sessionId: "sess-42", pluginId: "plugin-x", event: "turn-end" }),
    );
    expect(result.status).toBe("ok");
    expect(result.stdout).toBe("sess-42|plugin-x|turn-end");
  });

  // C1 regression (4f T1 review): a child that exits before reading stdin (`exit 0`) combined with a
  // large payload can make Bun's FileSink stdin `write()`/`end()` REJECT (EPIPE) instead of throwing
  // synchronously. Pre-fix, that rejection was unhandled — Bun terminates the whole process on an
  // unhandled rejection ("UNHANDLED REJECTION: EPIPE: broken pipe, send"), which would take the
  // entire daemon down, not just this one hook run. Post-fix (awaiting the writes inside the
  // try/catch), the rejection is caught like any other early-exit write failure and run() just
  // resolves normally. The only meaningful assertion here is that this test (and the process running
  // it) SURVIVES at all — if the fix regresses, this whole test file crashes rather than reporting a
  // clean failure.
  test("(i) C1: large payload + child that exits before reading stdin → no unhandled EPIPE rejection, run() resolves ok", async () => {
    const runner = new HookRunner();
    const bigPayload = mkPayload({ padding: "x".repeat(5_000_000) }); // multi-MB, reliably triggers EPIPE on write
    const result = await runner.run(mkSpec({ command: "exit 0" }), bigPayload);
    expect(result.status).toBe("ok");
  });

  // C2 regression (4f T1 review): the timeout path used to call `proc.kill()` (default SIGTERM), which
  // a hook can trivially ignore (`trap '' TERM`). `await proc.exited` then blocks until the child exits
  // on its own — for a genuinely hung/infinite-loop hook, that's forever, defeating the timeout and
  // (downstream) hanging the pre-tool gate. Post-fix, the timeout path sends SIGKILL, which cannot be
  // trapped. The explicit 3000ms bun-test-level timeout (3rd arg) is a fail-fast guard for the RED
  // state: pre-fix this hook (SIGTERM-immune) makes run() hang for the sleep's full duration, and we
  // want that to show up as a fast, unambiguous test failure rather than stalling the whole suite.
  // NB: `sleep 2`, not `sleep 30` — `sh -c` forks `sleep` as a separate grandchild, so SIGKILLing the
  // `sh` process (proc.pid) orphans it rather than killing it; it self-exits on its own shortly after
  // (harmless), but `sleep 30` specifically collides with the literal `pgrep -f 'sleep 30'` orphan
  // check in test/agent/tools-bash.test.ts, so a longer-but-distinct duration avoids cross-file flakes.
  test(
    "(j) C2: SIGTERM-ignoring hook (trap '' TERM; sleep 2) + timeoutMs ~100 → timeout resolves promptly via SIGKILL, child is dead",
    async () => {
      const runner = new HookRunner();
      const dir = tmpDir();
      const pidFile = join(dir, "pid");
      const start = Date.now();
      const result = await runner.run(
        mkSpec({ cwd: dir, command: `trap '' TERM; echo $$ > "${pidFile}"; sleep 2`, timeoutMs: 100 }),
        mkPayload(),
      );
      const elapsed = Date.now() - start;

      expect(result.status).toBe("timeout");
      // Budget well under 1s: proves SIGKILL won, not the ignored SIGTERM + eventual natural exit.
      expect(elapsed).toBeLessThan(1000);

      // Poll (bounded, short interval) that the spawned shell's own pid is no longer alive — proves
      // the timeout path actually killed the SIGTERM-immune process rather than merely giving up on it.
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      let alive = true;
      for (let i = 0; i < 25; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await sleep(20);
      }
      expect(alive).toBe(false);
    },
    3000,
  );

  // C3 regression (4f T1 re-review, post-C1): the C1 fix awaited the stdin write/end BEFORE the
  // timeout `Promise.race` was constructed. A non-draining but ALIVE hook (never reads stdin)
  // combined with a payload above the pipe-buffer threshold (~512-600KB) blocks that awaited write
  // forever — the race/timer is never armed, so run() hangs unboundedly instead of resolving
  // "timeout". Fix: the stdin write/end is now a fire-and-forget task the race does not wait on, so
  // the timer is always armed immediately regardless of whether the write drains. `exec sleep 15`
  // (not `sleep 30`, to avoid the tools-bash.test.ts pgrep-sleep-30 collision) replaces the shell
  // with `sleep` via `exec` so it never reads stdin and the pipe never drains. The explicit 5000ms
  // bun-test-level timeout (3rd arg) is a fail-fast guard for the RED state: pre-fix, this hangs
  // indefinitely (no timeout, ever) rather than reporting a clean failure.
  test(
    "(k) C3: non-draining alive hook + oversized (~1MB) payload + short timeout → resolves timeout promptly, write does not gate the race",
    async () => {
      const runner = new HookRunner();
      const bigPayload = mkPayload({ padding: "x".repeat(1_000_000) });
      const start = Date.now();
      const result = await runner.run(mkSpec({ command: "exec sleep 15", timeoutMs: 200 }), bigPayload);
      const elapsed = Date.now() - start;

      expect(result.status).toBe("timeout");
      // Budget well under the 15s sleep and well past the 200ms timeoutMs — proves the timer won
      // the race rather than the write blocking it indefinitely.
      expect(elapsed).toBeLessThan(1500);
    },
    5000,
  );

  // C1(l) regression (4f whole-branch review): a hook that backgrounds a process which INHERITS
  // stdout (`sleep 5 & echo done`). `sh` writes "done" and EXITS — so proc.exited resolves ~instantly
  // and proc.exitCode is 0 (this is the NORMAL-exit path, NOT the timeout path) — but the backgrounded
  // grandchild keeps the pipe's write end open, so no EOF ever reaches our read. Pre-fix, the
  // normal-exit path did `new Response(proc.stdout).text()`, which reads to EOF and therefore BLOCKS
  // for the grandchild's whole lifetime (5s here); every engine hook site awaits run(), so the turn
  // wedges and never clears runningTurns — unrecoverable without a daemon restart. Post-fix, readCapped
  // races the read against a bounded deadline (the hook's own remaining budget, floored at 500ms) and
  // returns the partial "done" it already captured. `sleep 5`, not `sleep 30`: the latter collides with
  // tools-bash.test.ts's literal `pgrep -f 'sleep 30'` orphan guard. The 1500ms bun-test-level timeout
  // (3rd arg) is the fail-fast RED guard — pre-fix this hangs ~5s to the grandchild's natural exit.
  test(
    "(l) C1: grandchild inheriting stdout holds the pipe open → readCapped returns partial promptly, never blocks to EOF",
    async () => {
      const runner = new HookRunner();
      const start = Date.now();
      const result = await runner.run(mkSpec({ command: "sleep 5 & echo done", timeoutMs: 300 }), mkPayload());
      const elapsed = Date.now() - start;

      expect(result.status).toBe("ok"); // sh exited 0 — classification is unchanged, uses proc.exitCode
      expect(result.stdout).toContain("done"); // partial-ok: we captured what was written before the deadline
      expect(elapsed).toBeLessThan(1500); // resolves at the ~500ms read deadline, nowhere near the 5s grandchild
    },
    1500,
  );

  // C1(m) regression (4f whole-branch review): the UNBOUNDED-memory facet, exercised by a grandchild
  // that FLOODS the inherited stdout (`yes x & echo start`): sh exits instantly (proc.exited resolves,
  // exitCode 0) but the orphaned `yes` writes forever with no EOF. Pre-fix, `new Response(proc.stdout)
  // .text()` drains that unbounded stream into a single string — it never terminates, so run() BOTH
  // hangs AND grows RSS without bound (measured ~+1.1GB within 4s → daemon OOM). Post-fix, readCapped
  // reads at most STDOUT_CAP bytes then reader.cancel()s, which closes our read end so the orphan gets
  // SIGPIPE and dies, and resolves in ~ms with a capped string. NB a *bounded* huge dump (e.g. 64MB
  // `head -c … | tr`) does NOT reproduce this: Bun eagerly drains+buffers a finite producer's whole
  // stdout into memory BEFORE proc.exited resolves, so pre-fix and post-fix show the same peak there —
  // only an unbounded producer distinguishes them (see task-4-report.md). Asserts cap + prompt
  // resolution (2500ms bun-test timeout = RED guard; pre-fix hangs) + a bounded RSS delta around run().
  test(
    "(m) C1: grandchild flooding stdout → readCapped caps output and bounds memory, never buffers unboundedly",
    async () => {
      const runner = new HookRunner();
      const rssBefore = process.memoryUsage().rss;
      const start = Date.now();
      const result = await runner.run(mkSpec({ command: "yes x & echo start" }), mkPayload());
      const elapsed = Date.now() - start;
      const rssDelta = process.memoryUsage().rss - rssBefore;

      expect(result.status).toBe("ok");
      expect(result.stdout.length).toBe(8192); // capped, not the unbounded flood
      expect(elapsed).toBeLessThan(1500); // resolves at the cap in ~ms, no hang
      // Bounded memory: the fixed path adds only a few MB around run(); the pre-fix ~1GB buffering
      // would blow past this wide ceiling (pre-fix never even reaches this assertion — it hangs first).
      expect(rssDelta).toBeLessThan(150_000_000);
    },
    2500,
  );
});
