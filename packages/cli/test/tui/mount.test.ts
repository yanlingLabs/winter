/** Phase 3c Task 4 — `mountTui`: the fullscreen alt-screen boundary.
 *
 *  Two things under test, both via injected seams so no real terminal is touched:
 *   1. The HEADLESS guard: non-TTY → never render, never write an escape, resolve immediately.
 *   2. The alt-screen escape ORDER (HARD CONSTRAINT 3): enter → mouse-on → (render) …
 *      onExitRequest → mouse-off → unmount → waitUntilExit → leave — asserted through the injected
 *      `write` sink + a fake render instance whose unmount/waitUntilExit log into the SAME order array.
 *
 *  The renderer and the escape `write` sink are both injectable (`mountTui(opts, renderImpl, write)`),
 *  so the ordering is a pure, deterministic assertion with no Ink instance and no stdout bytes. */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mountTui, type RenderInstance } from "../../src/tui/mount";
import { makeEventBridge } from "../../src/tui/event-bridge";
import { formatResumeHint } from "../../src/main";

const ENTER = "\x1b[?1049h\x1b[2J\x1b[H";
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
const LEAVE = "\x1b[?1049l";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function fakeClient() {
  const rec = () => () => Promise.resolve({});
  return {
    send: rec(), steer: rec(), interrupt: rec(), setPolicy: rec(),
    askUserRespond: rec(), planRespond: rec(), request: rec(),
    // child-transcript-view T3 (AppClient's two typed members):
    sendToThread: () => Promise.resolve({ delivered: "queued" as const, agentId: "x" }),
    agentStop: () => Promise.resolve({ status: "stopped" }),
  };
}

const mountOpts = () => ({
  client: fakeClient(),
  bridge: makeEventBridge(),
  sessionId: "s",
  cwd: "/tmp",
  initialPolicy: "ask" as const,
  version: "0.0.1",
  model: "m",
});

function escName(s: string): string {
  return s === ENTER ? "ENTER" : s === MOUSE_ON ? "MOUSE_ON" : s === MOUSE_OFF ? "MOUSE_OFF" : s === LEAVE ? "LEAVE" : `?${JSON.stringify(s)}`;
}

describe("mountTui — headless guard", () => {
  test("non-TTY: never renders, never writes an escape, resolves immediately", async () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    try {
      let renders = 0;
      const writes: string[] = [];
      const handle = mountTui(
        mountOpts(),
        () => { renders += 1; return { unmount() {}, waitUntilExit: () => new Promise<void>(() => {}) }; },
        (s) => writes.push(s),
      );
      expect(renders).toBe(0);
      expect(writes).toEqual([]); // no alt-screen / mouse escapes on the headless path
      let resolved = false;
      await Promise.race([handle.waitUntilExit().then(() => { resolved = true; }), wait(30)]);
      expect(resolved).toBe(true);
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });

  test("TTY: renders exactly once and writes enter + mouse-on at mount, before any exit", () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try {
      let renders = 0;
      const writes: string[] = [];
      let opts: unknown;
      mountTui(
        mountOpts(),
        (_node, o) => { renders += 1; opts = o; return { unmount() {}, waitUntilExit: () => new Promise<void>(() => {}) }; },
        (s) => writes.push(s),
      );
      expect(renders).toBe(1);
      expect(writes).toEqual([ENTER, MOUSE_ON]); // enter, then mouse-on — nothing else yet
      // render options: a synchronized-update stdout proxy + Ink's own ctrl+C exit disabled.
      expect((opts as { exitOnCtrlC?: boolean }).exitOnCtrlC).toBe(false);
      expect(typeof (opts as { stdout?: { write?: unknown } }).stdout?.write).toBe("function");
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });
});

describe("mountTui — alt-screen escape order (HARD CONSTRAINT 3)", () => {
  test("enter → mouse-on → … → mouse-off → unmount → waitUntilExit → leave", async () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try {
      const order: string[] = [];
      let resolveExit!: () => void;
      const exitP = new Promise<void>((r) => { resolveExit = r; });
      const instance: RenderInstance = {
        unmount: () => { order.push("unmount"); },
        waitUntilExit: () => { order.push("waitUntilExit"); return exitP; },
      };
      let capturedOnExit: (() => void) | undefined;
      const handle = mountTui(
        mountOpts(),
        (node) => {
          capturedOnExit = (node.props as { onExitRequest?: () => void }).onExitRequest;
          return instance;
        },
        (s) => order.push(escName(s)),
      );

      // At mount: enter + mouse-on, and the App was handed an onExitRequest.
      expect(order).toEqual(["ENTER", "MOUSE_ON"]);
      expect(typeof capturedOnExit).toBe("function");

      // User requests exit (T5's temporary ctrl+C wiring calls this).
      capturedOnExit!();
      resolveExit();
      await handle.waitUntilExit();

      expect(order).toEqual(["ENTER", "MOUSE_ON", "MOUSE_OFF", "unmount", "waitUntilExit", "LEAVE"]);
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });

  test("onExitRequest is idempotent — repeat presses collapse into one teardown", async () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try {
      const order: string[] = [];
      let resolveExit!: () => void;
      const exitP = new Promise<void>((r) => { resolveExit = r; });
      let unmounts = 0;
      let capturedOnExit: (() => void) | undefined;
      const handle = mountTui(
        mountOpts(),
        (node) => {
          capturedOnExit = (node.props as { onExitRequest?: () => void }).onExitRequest;
          return { unmount: () => { unmounts += 1; }, waitUntilExit: () => exitP };
        },
        (s) => order.push(escName(s)),
      );
      capturedOnExit!();
      capturedOnExit!(); // second press — must NOT re-teardown
      capturedOnExit!();
      resolveExit();
      await handle.waitUntilExit();
      expect(unmounts).toBe(1);
      expect(order).toEqual(["ENTER", "MOUSE_ON", "MOUSE_OFF", "LEAVE"]);
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });
});

describe("mountTui — resumeTargetSeq passthrough (Phase 3c Task 5)", () => {
  test("passed straight through to <App> when set on opts", () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try {
      let opts: unknown;
      mountTui(
        { ...mountOpts(), resumeTargetSeq: 42 },
        (node) => { opts = node.props; return { unmount() {}, waitUntilExit: () => new Promise<void>(() => {}) }; },
        () => {},
      );
      expect((opts as { resumeTargetSeq?: number }).resumeTargetSeq).toBe(42);
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });

  test("(d) non-resume: omitted on opts -> undefined on <App> (today's behavior, unchanged)", () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try {
      let opts: unknown;
      mountTui(
        mountOpts(),
        (node) => { opts = node.props; return { unmount() {}, waitUntilExit: () => new Promise<void>(() => {}) }; },
        () => {},
      );
      expect((opts as { resumeTargetSeq?: number }).resumeTargetSeq).toBeUndefined();
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });
});

// TUI renderer T4 — the damage-diffed writer under Ink. mountTui hands Ink a stdout proxy built
// over an INJECTED stream (4th param; production default process.stdout), so these tests drive the
// exact object Ink would write frames to and read the exact bytes the terminal would see.
describe("mountTui — the diffing writer under Ink (TUI renderer T4)", () => {
  const BSU = "\x1b[?2026h";
  const ESU = "\x1b[?2026l";
  const ERASE_SCREEN = "\x1b[2J";

  function fakeStdoutStream(): { stream: NodeJS.WriteStream; writes: string[] } {
    const writes: string[] = [];
    const em = new EventEmitter() as unknown as Record<string, unknown>;
    em.rows = 24;
    em.columns = 80;
    em.isTTY = true;
    em.write = (chunk: unknown) => { writes.push(String(chunk)); return true; };
    return { stream: em as unknown as NodeJS.WriteStream, writes };
  }

  type Mounted = {
    inkStdout: NodeJS.WriteStream;
    writes: string[];
    stream: NodeJS.WriteStream;
    exit: () => Promise<void>;
  };

  /** Mounts with a fake render + fake stdout stream; returns the stdout Ink was handed. */
  function mountWithFakes(): Mounted {
    const { stream, writes } = fakeStdoutStream();
    let inkStdout: NodeJS.WriteStream | undefined;
    let capturedOnExit: (() => void) | undefined;
    let resolveExit!: () => void;
    const exitP = new Promise<void>((r) => { resolveExit = r; });
    const handle = mountTui(
      mountOpts(),
      (node, o) => {
        inkStdout = (o as { stdout: NodeJS.WriteStream }).stdout;
        capturedOnExit = (node.props as { onExitRequest?: () => void }).onExitRequest;
        return { unmount() {}, waitUntilExit: () => exitP };
      },
      () => {},
      stream,
    );
    return {
      inkStdout: inkStdout!,
      writes,
      stream,
      exit: async () => { capturedOnExit!(); resolveExit(); await handle.waitUntilExit(); },
    };
  }

  function withTty<T>(fn: () => T): T {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try { return fn(); } finally { (process.stdout as unknown as { isTTY: boolean }).isTTY = prev; }
  }

  function withDiffEnv<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.NORMA_TUI_DIFF;
    if (value === undefined) delete process.env.NORMA_TUI_DIFF;
    else process.env.NORMA_TUI_DIFF = value;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.NORMA_TUI_DIFF;
      else process.env.NORMA_TUI_DIFF = prev;
    }
  }

  test("default mode: Ink's frames are DIFFED — full repaint first, damage after, zero bytes on an identical frame", () => {
    withTty(() => withDiffEnv(undefined, () => {
      const m = mountWithFakes();
      m.inkStdout.write("a\nb\n"); // Ink's first frame (no prelude)
      expect(m.writes.length).toBe(1);
      expect(m.writes[0]).toBe(BSU + ERASE_SCREEN + "\x1b[1;1Ha\x1b[K\x1b[2;1Hb\x1b[K\x1b[2;1H" + ESU);
      m.inkStdout.write("\x1b[2K\x1b[1A\x1b[2K\x1b[G" + "a\nc\n"); // steady-state: eraseLines(2) prelude
      expect(m.writes[1]).toBe(BSU + "\x1b[2;1Hc\x1b[K\x1b[2;1H" + ESU); // ONE damaged row
      m.inkStdout.write("\x1b[2K\x1b[1A\x1b[2K\x1b[G" + "a\nc\n"); // identical frame
      expect(m.writes.length).toBe(2); // zero damage ⇒ zero bytes
    }));
  });

  test("THE KILL-SWITCH: NORMA_TUI_DIFF=0 bypasses the differ entirely — BSU/ESU write-through, byte-identical chunks", () => {
    withTty(() => withDiffEnv("0", () => {
      const m = mountWithFakes();
      const chunk = "\x1b[2K\x1b[G" + "a\nb\n";
      m.inkStdout.write(chunk);
      m.inkStdout.write(chunk); // write-through does NOT dedupe — every chunk passes verbatim
      expect(m.writes).toEqual([BSU + chunk + ESU, BSU + chunk + ESU]);
    }));
  });

  test("resize on the stdout stream resets the differ — the next frame is a FULL repaint", () => {
    withTty(() => withDiffEnv(undefined, () => {
      const m = mountWithFakes();
      m.inkStdout.write("a\nb\n");
      (m.stream as unknown as EventEmitter).emit("resize"); // SIGWINCH → node's WriteStream 'resize'
      m.inkStdout.write("\x1b[2K\x1b[1A\x1b[2K\x1b[G" + "a\nb\n"); // identical content post-resize
      expect(m.writes.length).toBe(2);
      expect(m.writes[1]).toContain(ERASE_SCREEN); // repainted fully, not diffed to zero
    }));
  });

  test("teardown removes the resize hook from the stdout stream", async () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try {
      await withDiffEnv(undefined, async () => {
        const m = mountWithFakes();
        expect((m.stream as unknown as EventEmitter).listenerCount("resize")).toBe(1);
        await m.exit();
        expect((m.stream as unknown as EventEmitter).listenerCount("resize")).toBe(0);
      });
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });

  test("kill-switch mode registers NO resize hook (nothing to reset)", () => {
    withTty(() => withDiffEnv("0", () => {
      const m = mountWithFakes();
      expect((m.stream as unknown as EventEmitter).listenerCount("resize")).toBe(0);
    }));
  });
});

// Phase 3c Task 5 — main.ts's post-exit seam: AFTER `await mountTui(...).waitUntilExit()` resolves,
// main.ts writes `formatResumeHint(sessionId)` through the SAME stdout sink. mountTui's own
// `waitUntilExit` writes the LEAVE escape as its OWN last step (HARD CONSTRAINT 3) before resolving
// — so as long as main.ts's hint-write happens after the `await` (which it does — see main.ts's
// ink-mode branch), the hint is STRUCTURALLY guaranteed to land after LEAVE. This replicates that
// exact call order (mountTui(...).waitUntilExit() THEN write the hint) through the injected sink, no
// real Ink instance or terminal involved — "unit-test the mount/main seam with an injected
// sink+printer" per the task brief, `formatResumeHint` standing in as the "printer".
describe("mount/main seam — resume hint prints after the LEAVE escape (Phase 3c Task 5)", () => {
  test("hint text lands in the sink strictly after LEAVE, with the exact session id", async () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    try {
      const order: string[] = [];
      let resolveExit!: () => void;
      const exitP = new Promise<void>((r) => { resolveExit = r; });
      let capturedOnExit: (() => void) | undefined;
      const handle = mountTui(
        mountOpts(),
        (node) => {
          capturedOnExit = (node.props as { onExitRequest?: () => void }).onExitRequest;
          return {
            unmount: () => { order.push("unmount"); },
            waitUntilExit: () => { order.push("waitUntilExit"); return exitP; },
          };
        },
        (s) => order.push(escName(s)),
      );

      capturedOnExit!();
      resolveExit();
      await handle.waitUntilExit(); // by now LEAVE has already been written (mount.ts's own last step)
      order.push(formatResumeHint("s1")); // main.ts's post-await step, through the SAME sink

      expect(order[order.length - 2]).toBe("LEAVE"); // the hint is the VERY NEXT thing after LEAVE
      const hint = order.at(-1)!;
      expect(hint).toContain("Resume this session with:");
      expect(hint).toContain("norma resume s1");
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });
});
