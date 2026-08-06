/** `mountTui` (Phase 3a Task 6; Phase 3c Task 4 — the FULLSCREEN alt-screen boundary). main.ts calls
 *  this once, after the session bootstrap, on the Ink branch.
 *
 *  HEADLESS SAFETY NET: if `process.stdout.isTTY` is falsy it returns a resolved no-op handle WITHOUT
 *  calling Ink's `render` OR writing any escape — a non-TTY invocation that somehow reaches here (it
 *  should be double-guarded by main.ts's `chat && isTTY` too) never touches the terminal and stays
 *  byte-identical to the legacy headless path.
 *
 *  ALT-SCREEN LIFECYCLE (HARD CONSTRAINT 3, all through the injected `write` sink so tests assert the
 *  exact byte order without touching a real terminal):
 *    enterAltScreen → enableMouseTracking → render(<App>) …  (interactive)
 *    … on exit request: disableMouseTracking → instance.unmount() → await waitUntilExit() → leaveAltScreen
 *  The App is rendered onto a damage-diffing stdout proxy (`makeDiffingStdout`, TUI renderer T4 —
 *  BSU/ESU-synchronized writes of only the CHANGED rows per frame; `NORMA_TUI_DIFF=0` kill-switch
 *  falls back to the 3c-era full-frame `makeSyncStdout` write-through) with
 *  `exitOnCtrlC: false` — the App itself owns quitting (Task 5's double-ctrl+C/ctrl+D flow calls
 *  `onExitRequest`, wired below to the teardown; main.ts prints the dim "resume this session with…"
 *  hint itself, AFTER `waitUntilExit()` resolves — i.e. after `leaveAltScreen` above has already run,
 *  landing the hint in the NORMAL buffer, never the alt screen).
 *
 *  RESUME REPLAY (Task 5): `resumeTargetSeq` is a passthrough — main.ts sets it (to the seq its own
 *  `attach(sessionId, 0)` call returned) ONLY on the `norma resume <id>` Ink route; every other route
 *  (fresh session, legacy/NORMA_LEGACY_CLI chat resume, non-TTY) leaves it `undefined`, and `<App>`'s
 *  behavior with `undefined` is exactly today's (see app.tsx's RESUME REPLAY doc comment). */

import React from "react";
import { render as inkRender } from "ink";
import { App, type AppClient } from "./app";
import { makeSyncStdout } from "./sync-stdout";
import { makeDiffingStdout } from "./frame-diff";
import { enterAltScreen, leaveAltScreen, enableMouseTracking, disableMouseTracking } from "./alt-screen";
import type { EventBridge } from "./event-bridge";
import type { ApprovalPolicy } from "@norma/protocol";

export interface MountOpts {
  client: AppClient;
  bridge: EventBridge;
  sessionId: string;
  cwd: string;
  initialPolicy: ApprovalPolicy;
  version: string; // CLI version — welcome banner (packages/cli/package.json)
  model: string; // resolved provider model — welcome banner (settings.provider.model)
  /** Task 5 resume replay — see the module doc comment. Passed straight through to `<App>`. */
  resumeTargetSeq?: number;
}

export interface TuiHandle {
  waitUntilExit(): Promise<void>;
}

/** A structural view of Ink's `render` — only `unmount`/`waitUntilExit` are used here, so tests can
 *  inject a spy returning a controllable stub. Ink's real `render` (returns the full `Instance`)
 *  satisfies it. */
export type RenderInstance = { unmount(): void; waitUntilExit(): Promise<void> };
export type RenderLike = (node: React.ReactElement, options?: unknown) => RenderInstance;

export function mountTui(
  opts: MountOpts,
  renderImpl: RenderLike = inkRender as unknown as RenderLike,
  write: (s: string) => void = (s) => { process.stdout.write(s); },
  stdoutStream: NodeJS.WriteStream = process.stdout,
): TuiHandle {
  if (!process.stdout.isTTY) {
    // Non-TTY: never render, never write an escape — hand back an already-resolved handle so the
    // caller's `await handle.waitUntilExit()` returns immediately (headless untouched).
    return { waitUntilExit: () => Promise.resolve() };
  }

  enterAltScreen(write);
  enableMouseTracking(write);

  // TUI renderer T4 — the damage-diffed writer under Ink (mechanism report Q5/Q7 cure 4): Ink
  // still renders full frames, but the stdout it writes them to diffs each against the previous
  // one and emits only the changed rows (frame-diff.ts), so repaint cost is bounded by damage,
  // never transcript/viewport size. `NORMA_TUI_DIFF=0` is THE KILL-SWITCH: it bypasses the differ
  // entirely for the 3c-era BSU/ESU write-through proxy — a live rendering artifact bisects to
  // renderer-vs-writer in one relaunch. On the stream's 'resize' (SIGWINCH — columns OR rows) the
  // differ resets, so the next frame is a full repaint against the new geometry (its previous-frame
  // record is meaningless across a resize); the hook is removed at teardown. A fresh writer per
  // mount means any future alt-screen RE-entry path that remounts starts on a full repaint by
  // construction. `stdoutStream` is injected for tests; production is always process.stdout.
  const diffEnabled = process.env.NORMA_TUI_DIFF !== "0";
  let inkStdout: NodeJS.WriteStream;
  let onResize: (() => void) | undefined;
  if (diffEnabled) {
    const diffing = makeDiffingStdout(stdoutStream);
    inkStdout = diffing.stream;
    onResize = () => diffing.reset();
    stdoutStream.on("resize", onResize);
  } else {
    inkStdout = makeSyncStdout(stdoutStream);
  }

  let instance: RenderInstance;
  let requested = false;
  const onExitRequest = (): void => {
    if (requested) return; // idempotent — repeated presses collapse into the one teardown
    requested = true;
    disableMouseTracking(write);
    instance.unmount();
  };

  instance = renderImpl(
    React.createElement(App, {
      client: opts.client,
      bridge: opts.bridge,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      initialPolicy: opts.initialPolicy,
      version: opts.version,
      model: opts.model,
      onExitRequest,
      resumeTargetSeq: opts.resumeTargetSeq,
    }),
    { stdout: inkStdout, exitOnCtrlC: false },
  );

  return {
    waitUntilExit: async () => {
      // Block until Ink unmounts (via onExitRequest, or any other path), THEN write the leave escape
      // last — completing the HARD CONSTRAINT 3 order: disableMouseTracking → unmount →
      // waitUntilExit → leaveAltScreen. If Ink unmounted by a path that didn't go through
      // onExitRequest, mouse tracking hasn't been disabled yet, so do it here first.
      await instance.waitUntilExit();
      if (onResize) stdoutStream.off("resize", onResize); // T4: the differ's resize hook dies with the mount
      if (!requested) disableMouseTracking(write);
      leaveAltScreen(write);
    },
  };
}
