import { z } from "zod";
import type { Mode, ToolRegistry } from "./registry";
import type { PeripheralClass } from "../../peripheral/broker";

/**
 * `computer` (Phase 5 CU) — the computer-use tool. ONE tool with an `action` discriminant; each
 * action maps to a peripheral capability class leased from Norma.app (spec §4.6):
 *
 *   ax_snapshot → ax-read      (PRIMARY grounding: a text tree of on-screen elements with ids +
 *                               role/label/value + AX-sourced screen-space center coordinates)
 *   screenshot / zoom → screenshot (SECONDARY: a downscaled PNG staged as a vision image; zoom
 *                               captures a REGION at full resolution — the dense-UI/Retina detail
 *                               path. Both need a vision-capable model.)
 *   click/move/drag/type/key/scroll → input-drive (act on an element id — native AXPress — or x,y)
 *   wait → NO peripheral class  (a pure core-side timer: no lease, no Norma.app round-trip)
 *
 * A PLAIN TOOL (not an engine bridge): everything it needs is `ctx.computerUse.act(...)` (the
 * lease-holding ComputerUseService) + `ctx.attachImage` (staging a screenshot for the model). The
 * tool builds the provider payload, calls the service, and shapes the model-facing result.
 *
 * Errors surface as isError tool_results (thrown → the registry catches them): "computer use
 * unavailable — Norma.app not running" (no provider / lease gone), a denial message (policy), or the
 * provider's own message (e.g. missing TCC grant).
 *
 * DELIBERATELY SKIPPED actions (user decision 2026-07-12, logged in the phase report): raw
 * left_mouse_down/left_mouse_up (dangling-button hazard — `drag` covers the mainstream case),
 * cursor_position (clicks take absolute targets; the cursor's location is never load-bearing),
 * hold_key-with-duration (games primitive; `modifiers` on click/drag covers the productive subset).
 */

const MODIFIERS = ["cmd", "shift", "ctrl", "opt", "fn"] as const;
const MAX_WAIT_S = 5;

const ComputerArgs = z.object({
  action: z.enum(["ax_snapshot", "screenshot", "zoom", "click", "move", "drag", "type", "key", "scroll", "wait"]),
  element_id: z.number().int().nonnegative().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  // drag destination (mirrors the flat primary-target fields above)
  to_element_id: z.number().int().nonnegative().optional(),
  to_x: z.number().optional(),
  to_y: z.number().optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  clicks: z.number().int().min(1).max(3).optional(),
  modifiers: z.array(z.enum(MODIFIERS)).optional(),
  text: z.string().optional(),
  keys: z.string().optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  // zoom region size (region origin rides x,y)
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  seconds: z.number().positive().optional(),
});
type ComputerArgsT = z.infer<typeof ComputerArgs>;

// Hand-authored JSON Schema (rawParameters) so the description carries the AX-primary guidance the
// model needs — the generated schema would drop the prose.
const RAW_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["ax_snapshot", "screenshot", "zoom", "click", "move", "drag", "type", "key", "scroll", "wait"],
      description:
        "ax_snapshot: read the accessibility tree of the frontmost app — a numbered list of elements with role, label, value and on-screen center coordinates. PREFER THIS to ground actions (it is exact); screenshot only when the UI is not exposed via accessibility. " +
        "screenshot: capture the screen as an image (needs a vision-capable model). " +
        "zoom: capture a REGION of the screen at full detail — x,y = region origin, width,height = region size (screen points); use after a screenshot when small text/controls are unreadable. " +
        "click/move: act on element_id (from the latest ax_snapshot) OR x,y coordinates — prefer element_id. " +
        "drag: press at element_id/x,y and release at to_element_id/to_x,to_y (sliders, drag-and-drop, text selection). " +
        "type: type `text` into the focused element. key: press `keys` (e.g. \"cmd+s\", \"return\", \"cmd+shift+4\"). " +
        "scroll: scroll by dx,dy at element_id or x,y. " +
        "wait: pause `seconds` (max 5) for the UI to settle (animations, loads) before observing again.",
    },
    element_id: { type: "integer", minimum: 0, description: "Target element id from the latest ax_snapshot (preferred over x,y)." },
    x: { type: "number", description: "Target x in screen points (or the zoom region's origin x) — for clicks, use only when no element_id fits." },
    y: { type: "number", description: "Target y in screen points (or the zoom region's origin y)." },
    to_element_id: { type: "integer", minimum: 0, description: "Drag destination element id (action=drag; preferred over to_x,to_y)." },
    to_x: { type: "number", description: "Drag destination x in screen points (action=drag)." },
    to_y: { type: "number", description: "Drag destination y in screen points (action=drag)." },
    button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button for click (default left)." },
    clicks: { type: "integer", minimum: 1, maximum: 3, description: "Click count: 1 (default), 2 = double-click, 3 = triple-click (select line/paragraph)." },
    modifiers: { type: "array", items: { type: "string", enum: [...MODIFIERS] }, description: "Modifier keys held during click/drag (e.g. [\"shift\"] for range-select, [\"cmd\"] for multi-select)." },
    text: { type: "string", description: "Text to type (action=type)." },
    keys: { type: "string", description: "Key or chord to press, e.g. \"cmd+s\" (action=key)." },
    dx: { type: "number", description: "Horizontal scroll delta in pixels (action=scroll); positive scrolls content right." },
    dy: { type: "number", description: "Vertical scroll delta in pixels (action=scroll); positive scrolls DOWN the page (web-style), negative scrolls up." },
    width: { type: "number", exclusiveMinimum: 0, description: "Zoom region width in screen points (action=zoom)." },
    height: { type: "number", exclusiveMinimum: 0, description: "Zoom region height in screen points (action=zoom)." },
    seconds: { type: "number", exclusiveMinimum: 0, maximum: MAX_WAIT_S, description: `Seconds to wait (action=wait, max ${MAX_WAIT_S}).` },
  },
};

/** The peripheral class each action leases. `wait` never reaches this — it is handled locally in
 *  run() before any lease/peripheral involvement. */
function classFor(action: Exclude<ComputerArgsT["action"], "wait">): PeripheralClass {
  if (action === "ax_snapshot") return "ax-read";
  if (action === "screenshot" || action === "zoom") return "screenshot";
  return "input-drive"; // click/move/drag/type/key/scroll
}

/** Resolve the primary target object for actions that need one; throws a typed error when neither
 *  an element_id nor an x,y pair is supplied. */
function target(a: ComputerArgsT): Record<string, unknown> {
  if (a.element_id !== undefined) return { elementId: a.element_id };
  if (a.x !== undefined && a.y !== undefined) return { x: a.x, y: a.y };
  throw new Error(`action '${a.action}' needs a target: either element_id (from ax_snapshot) or both x and y`);
}

/** Resolve the drag DESTINATION target; throws when neither to_element_id nor to_x,to_y is given. */
function toTarget(a: ComputerArgsT): Record<string, unknown> {
  if (a.to_element_id !== undefined) return { elementId: a.to_element_id };
  if (a.to_x !== undefined && a.to_y !== undefined) return { x: a.to_x, y: a.to_y };
  throw new Error("action 'drag' needs a destination: either to_element_id or both to_x and to_y");
}

/** Build the provider payload for an action (throws a typed error on a missing required field). */
function buildPayload(a: ComputerArgsT, screenshotMaxDim?: number): Record<string, unknown> {
  switch (a.action) {
    case "ax_snapshot":
      return { op: "ax_snapshot" };
    case "screenshot":
      return screenshotMaxDim ? { op: "screenshot", maxDim: screenshotMaxDim } : { op: "screenshot" };
    case "zoom": {
      if (a.x === undefined || a.y === undefined || a.width === undefined || a.height === undefined) {
        throw new Error("action 'zoom' needs the region: x, y (origin) and width, height (size), in screen points");
      }
      const base = { op: "zoom", x: a.x, y: a.y, width: a.width, height: a.height };
      return screenshotMaxDim ? { ...base, maxDim: screenshotMaxDim } : base;
    }
    case "click":
      return {
        op: "click", target: target(a), button: a.button ?? "left", clicks: a.clicks ?? 1,
        ...(a.modifiers && a.modifiers.length ? { modifiers: a.modifiers } : {}),
      };
    case "move":
      return { op: "move", target: target(a) };
    case "drag":
      return {
        op: "drag", from: target(a), to: toTarget(a),
        ...(a.modifiers && a.modifiers.length ? { modifiers: a.modifiers } : {}),
      };
    case "type":
      if (a.text === undefined) throw new Error("action 'type' needs `text`");
      return { op: "type", text: a.text };
    case "key":
      if (!a.keys) throw new Error("action 'key' needs `keys` (e.g. \"cmd+s\")");
      return { op: "key", keys: a.keys };
    case "scroll":
      if (a.dx === undefined && a.dy === undefined) throw new Error("action 'scroll' needs dx and/or dy");
      return { op: "scroll", target: a.element_id !== undefined || (a.x !== undefined && a.y !== undefined) ? target(a) : undefined, dx: a.dx ?? 0, dy: a.dy ?? 0 };
    case "wait":
      throw new Error("unreachable: wait is handled locally"); // run() short-circuits before buildPayload
  }
}

/** Abortable sleep for the `wait` action — resolves early (without throwing) when the turn's
 *  AbortSignal fires, so an interrupted turn never sits out the full wait. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Shape the model-facing result string from a successful capability call. */
function formatResult(a: ComputerArgsT, resultJson: string, attachImage?: (u: string) => void): string {
  let parsed: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(resultJson || "{}");
    // JSON.parse("null")/primitives succeed — only accept an object so the field reads below
    // never TypeError on a degenerate provider payload.
    if (p !== null && typeof p === "object") parsed = p as Record<string, unknown>;
  } catch { /* provider returned non-JSON — fall through */ }

  if (a.action === "ax_snapshot") {
    return typeof parsed.text === "string" ? parsed.text : resultJson;
  }
  if (a.action === "screenshot" || a.action === "zoom") {
    const dataUrl = typeof parsed.dataUrl === "string" ? parsed.dataUrl : undefined;
    if (dataUrl && attachImage) attachImage(dataUrl);
    const w = parsed.width, h = parsed.height, sw = parsed.scaledWidth, sh = parsed.scaledHeight;
    const dims = typeof w === "number" && typeof h === "number" ? `${w}×${h}` : "screen";
    const wasScaled = typeof w === "number" && typeof sw === "number" && typeof sh === "number" && (sw !== w || sh !== h);
    // COORDINATE-SPACE NOTES (systematic-misclick guards): click/move/scroll x,y are SCREEN
    // coordinates (the ax_snapshot space). A zoomed image is region-relative — the model must add
    // the region origin back; a downscaled image must be multiplied back up. State both exactly.
    const originNote = a.action === "zoom" && typeof parsed.originX === "number" && typeof parsed.originY === "number"
      ? ` Positions in this image are relative to the region — ADD the region origin (${parsed.originX},${parsed.originY}) to get screen coordinates.`
      : "";
    const scaleNote = wasScaled
      ? ` The image was downscaled to ${sw}×${sh}; multiply positions read off the image by ${((w as number) / (sw as number)).toFixed(3)} first${a.action === "zoom" ? ", then add the origin" : ""} — or better, target ax_snapshot element ids.`
      : "";
    const label = a.action === "zoom" ? `Zoomed region captured (${dims} at screen origin ${typeof parsed.originX === "number" ? `(${parsed.originX},${parsed.originY})` : "?"})` : `Screenshot captured (screen is ${dims})`;
    return dataUrl ? `${label}. The image follows this result as the next message.${originNote}${scaleNote}` : `${label}.`;
  }
  // input actions: prefer a provider-supplied detail, else a generic confirmation.
  if (typeof parsed.detail === "string") return parsed.detail;
  return `${a.action} done`;
}

export function registerComputerTool(
  r: ToolRegistry,
  // D1-T2: `deferred` widened from `boolean` to `boolean | Mode[]` (registry.ts's
  // ToolDefinition.deferred) — same ONE-mechanism reconciliation as task_stop's identical
  // registration-time flag (see task-stop.ts's own doc comment). daemon.ts's two registration call
  // sites now pass `deferred: ["dispatch"]`: immediate in code, deferred only in dispatch.
  deps: { screenshotMaxDim?: number; deferred?: boolean | Mode[] } = {},
): void {
  const { screenshotMaxDim, deferred } = deps;
  r.register({
    name: "computer",
    description:
      "Control this Mac: read the accessibility tree (ax_snapshot), take a screenshot (or zoom into a region), click/drag/type/press keys/scroll, and wait for the UI to settle. " +
      "Ground actions on ax_snapshot elements (exact) before falling back to a screenshot. Requires Norma.app running with the relevant permissions granted.",
    args: ComputerArgs,
    rawParameters: RAW_PARAMETERS,
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    deferred,
    async run(args, ctx) {
      if (!ctx.computerUse) throw new Error("computer use is not available in this session");
      const a = args as ComputerArgsT;
      // `wait` is purely local: no lease, no peripheral round-trip, no vision requirement — just an
      // abortable clamped sleep so the model can let animations/loads settle before re-observing.
      if (a.action === "wait") {
        if (a.seconds === undefined) throw new Error("action 'wait' needs `seconds` (max 5)");
        const s = Math.min(a.seconds, MAX_WAIT_S);
        await sleep(s * 1000, ctx.signal);
        // Report the truth: an aborted turn cuts the sleep short, so don't claim the full duration.
        return ctx.signal?.aborted ? "wait interrupted" : `waited ${s}s`;
      }
      if ((a.action === "screenshot" || a.action === "zoom") && ctx.visionCapable === false) {
        throw new Error("screenshots need a vision-capable model; use action 'ax_snapshot' to read the screen instead");
      }
      const cls = classFor(a.action);
      const payload = JSON.stringify(buildPayload(a, screenshotMaxDim));
      const res = await ctx.computerUse.act(ctx.sessionId, cls, payload);
      if (!res.ok) throw new Error(res.message);
      return formatResult(a, res.resultJson, ctx.attachImage);
    },
  });
}
