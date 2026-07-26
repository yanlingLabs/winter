import { z } from "zod";
import type { ToolRegistry } from "./registry";

const DEFAULT_TITLE = "Norma";

const PushNotificationArgs = z.object({
  message: z.string().min(1).max(500),
  // .min(1) mirrors the wire event's own bound (review finding: an explicit "" passed `??` and
  // surfaced a raw ZodError from the store's event validation instead of a clean tool rejection).
  title: z.string().min(1).max(100).optional(),
});

/**
 * `push_notification` (task-30, the final CC-parity tool item): CC's `PushNotification` sends a
 * desktop (+ phone, via their hosted Remote Control — not our scope) notification; usage per the
 * CC reference is "typically pushes when a long task finishes or a decision is needed." Norma's
 * advantage over CC's undocumented/opaque delivery is a REAL Mac app: a native
 * `UNUserNotificationCenter` alert with proper app identity (see the Norma target's
 * `SessionModel.apply`), plus a headless `osascript` fallback when nobody's attached at all (see
 * `agent/notify-fallback.ts`).
 *
 * This tool itself stays thin — it never touches `SessionHub`/`osascript` directly. All of that
 * lives behind the `ctx.notify` bridge (engine.ts), mirroring `ask_user`'s `ctx.ask` and the task
 * tools' `ctx.taskEvent`: one emit-and-maybe-fallback chokepoint, not duplicated per call site.
 */
export function registerPushNotificationTool(r: ToolRegistry): void {
  r.register({
    name: "push_notification",
    description:
      "Send the user a native desktop notification — use when a long-running task finishes or you need to flag a decision the user should look at soon, especially if they may not be watching this session right now. " +
      "message: the notification body (required, up to 500 chars). title: optional, up to 100 chars, defaults to \"Norma\".",
    args: PushNotificationArgs,
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    deferred: true,
    async run({ message, title }: z.infer<typeof PushNotificationArgs>, ctx) {
      if (!ctx.notify) return "notification not available in this session";
      ctx.notify(title ?? DEFAULT_TITLE, message);
      return "notification sent";
    },
  });
}
