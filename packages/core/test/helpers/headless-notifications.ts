// A guard for tests that run a REAL daemon in-process: the daemon's headless-notification fallback
// (`agent/notify-fallback.ts`, wired into `dispatch-children` and the `push_notification` sink) shells out to
// `osascript ... display notification` whenever no harness is attached to the session -- which is the normal
// state of a Dispatch coordinator in an e2e. `startDaemon` has no seam for it, but the fallback spawns through the
// global `Bun.spawn`, so this spy catches exactly those spawns: it records them (so a test can still prove the
// fallback was reached, with the title it expects) and answers a stand-in -- no notification is ever shown on the
// machine running the tests. Every other spawn (the `winter` child, git, ps, ...) passes straight through, untouched.

import { spyOn } from "bun:test";

export interface PostedNotification { title: string; message: string }

export interface NotificationGuard {
  /** Every headless notification the code under test tried to post, oldest first. */
  readonly posted: PostedNotification[];
  /** Puts the real `Bun.spawn` back. Call it when the daemon is stopped. */
  restore(): void;
}

/** True for the fixed argv `notifyHeadless` builds (`osascript -e ... display notification ... -- <message> <title>`). */
function isNotification(cmd: unknown): cmd is string[] {
  return Array.isArray(cmd) && cmd[0] === "osascript" && cmd.some((part) => typeof part === "string" && part.includes("display notification"));
}

export function guardHeadlessNotifications(): NotificationGuard {
  const posted: PostedNotification[] = [];
  const original = Bun.spawn as unknown as (...args: unknown[]) => unknown;
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const first = args[0];
    const cmd = Array.isArray(first) ? first : (first as { cmd?: unknown } | undefined)?.cmd;
    if (!isNotification(cmd)) return original.apply(Bun, args);
    const tail = cmd.slice(cmd.indexOf("--") + 1);
    posted.push({ message: String(tail[0] ?? ""), title: String(tail[1] ?? "") });
    return { pid: 0, kill() {}, exited: Promise.resolve(0) };
  }) as never);
  return { posted, restore: () => spy.mockRestore() };
}
