# The agent cursor

How Winter shows the user what its computer-use helper is doing. One cursor, drawn in two places: a click-through
overlay above the target window, and smaller inside that window's mirror. Code: `Sources/WinterCUPresentation/Cursor/`.

## Principles

- **Winter's own.**
  - The language is the dispatch pill's: near-black faces, a faint white rim, a soft shadow.
  - Winter's ice blue (`AccentColor`, `#8CCBF0`) marks what the agent does.
  - Twelve rays — the count in the scale-burst mark — make the waiting spinner.
- **Not the system pointer, and not anyone else's.** The arrow is a dart with no stem: a black face, a white rim, a
  notched back, softened corners, and an ice-blue "frost edge" just inside its leading side.
- **Legible on any ground.** On light grounds the black face reads; on dark ones the white rim does. Every mark that
  must read anywhere (rings, reticle, drag path) is drawn twice: a dark under-stroke, then a light over-stroke.
- **Calm.**
  - Motion eases out like a hand: quick to start, long and gentle to arrive.
  - Paths bow slightly, the arrow leans a few degrees into the motion, and a press is a tiny squash.
  - Nothing loops loudly. At rest the cursor only breathes.
- **It never fights the user's pointer.**
  - The overlay is click-through and sits just above the target window, so windows covering the target cover the
    cursor too.
  - While the real mouse is in use (rung 4) Winter draws no second arrow at all.

## The look

| Part | Spec |
|---|---|
| Arrow | Tip (0,0), lower wing (3.6,17.2), notch (7.4,11.9), right wing (16.4,11.0); ×1.12 on screen, ×0.62 of that in the mirror. Corner radii: tip 0.6, wings 2.0 and 2.1, notch 1.3. |
| Face | `#0B0C0E` at 95% (Increase Contrast: 100%). |
| Rim | White, 1.3 pt at 92% (IC: 1.8 pt at 100%). It turns rose on a refusal. |
| Frost edge | Ice blue, 1.15 pt, just inside the left edge. |
| Halo | The outline stroked 4, 8 and 13 pt wide at 42%, 20% and 8%, scaled by the glow level. Ice; amber in the foreground; rose on a refusal. |
| Badge | A pill 18 pt tall, ≥ 22 pt wide, 12/20 pt below-right of the tip. Face ink at 92%, white rim at 16% (IC: 50%). |
| Caption | A pill 20 pt tall, SF 11 medium, 22 pt right of the tip, ≤ 240 pt and ≤ 40 characters. |
| Badges and captions near an edge | They flip to the tip's other side, so they stay inside the window. |
| Colours | Ice `#8CCBF0` (brand accent), amber `#F2A640` (real mouse in use), rose `#E87470` (refusal). |

## States

Events are queued on a visual timeline (`CursorTimeline`), each with a short minimum duration, so the user can follow
the cursor even when the helper acts faster. When the queue runs more than 0.6 s ahead, segments play at 0.4× their
length. Past 1.5 s the queue is cut and the cursor jumps to the present. It never trails the real work by more than
that.

| State | Look | Timing | Why |
|---|---|---|---|
| **appear** | Fades in where it first acts, scaling from 0.9 to 1. | 0.18 s | It never flies in from nowhere. |
| **idle** | Rests with a soft ice halo breathing (glow 0.22–0.50). | 3.2 s period, about 20 fps | Shows "bound, between actions" without demanding attention. |
| **moving** | Glides along a quadratic Bézier that bows about 16% of the distance (≤ 56 pt) to one side, eased with `cubic-bezier(0.35, 0, 0.15, 1)`. Leans up to 8° into horizontal motion. | 0.14–0.55 s, growing with the log of the distance | A confident hand; never a robotic straight line. |
| **targeting** | Four ice corner brackets close in from 8 pt outside the element's frame onto it, while the cursor arrives. | Settles in 0.2 s; holds until the action, then fades in 0.22 s; leaves on its own after 1.4 s if nothing acts | Shows WHAT it is about to touch, before it touches it. |
| **press** | Squash to 0.86 and back with one small overshoot; one ring spreads from the tip (3 → 18 pt). | Squash 0.2 s, ring 0.42 s | The touch itself, small and exact. |
| **double click** | Two squashes 0.11 s apart; the second ring is tighter (13 pt). | 0.27 s | Readable as "twice" without a label. |
| **right click** | A dashed ring, plus a menu badge (three lines). | Ring 0.42 s, badge 0.8 s | Distinct from a left click at a glance. |
| **typing** | A blinking ice caret in the badge. | Badge 1.4 s after the last type; blinks every 1.06 s | Says "keyboard", not "click". |
| **key** | The combo, spelled the way Mac menus spell it (⇧⌘S, ↩, ⌥⇥), in the badge. | 1.2 s | Shortcuts are invisible otherwise. |
| **scrolling** | Two chevrons that flow in the scroll direction (↕ when the direction is unknown). | 0.8 s | Directional, quiet. |
| **dragging** | Grip badge (six dots). The cursor stays pressed (0.9) while it travels a faint dashed ice path to a small end marker. A release ring plays at the drop. | Press 0.12 s; travel ≥ 0.3 s (1.25× a glide); path fades 0.3 s | Shows the destination before arriving. |
| **waiting** | The badge becomes a twelve-ray spinner, an ice head with a fading tail. A wait over 1.2 s with a label gets the caption "Waiting for “…”". On the end the rays draw in. | 0.9 s per turn; drawing in takes 0.24 s | Winter's mark doing the waiting. Short waits stay quiet. |
| **refused** | Rim and halo turn rose; a small damped head-shake (±3.2 pt, 2.5 cycles); a ⃠ badge. | Shake 0.36 s; tint holds 0.5 s, fades 0.3 s; badge 0.9 s | A gentle "no", not an alarm. |
| **foreground (rung 4)** | The arrow cross-fades away. A warm amber ring (radius 15 ± 2.5, pulsing) circles the REAL pointer, with the caption "Using your mouse" for as long as it lasts. Positions snap, because the real pointer jumps. | Cross-fade 0.2 s; pulse 1.4 s | The user must know the real mouse is moving, so as not to fight it; two arrows on one spot would confuse. |
| **done** | Fades out while shrinking to 0.92. | 0.42 s | Triggered by turn end, session end, a 30 s idle, or an explicit `.done`. |
| **caption** | A small pill near the cursor, e.g. "Clicking “Save”". | Shown ≥ 1.2 s; leaves on its own after 2.4 s unless cleared or replaced | See below. |

**Captions are for slow or important moments only.** Winter shows them by itself:
- in the foreground ("Using your mouse");
- for a labelled wait that lasts ("Waiting for “Saved”").

The core sends one for a consequential action: a press on an element named like Send, Delete, Save, Submit, Buy, Pay,
Publish or Post, and any menu command. Captions on routine clicks would be noise that slows the user's eye.

## Accessibility

- **Reduce Motion** (System Settings › Accessibility › Display, read on every event):
  - **Removed:** travel (the cursor appears at the destination), tilt, squash, shake, ring growth, spinner sweep, caret
    blink, chevron flow and breathing.
  - **Kept:** every state's look, as static marks that fade in and out. Rings hold at 70% of their full size; the
    spinner shows all twelve rays at 60%.
  - **Frame rate:** a resting cursor then needs no frames at all.
- **Increase Contrast:**
  - opaque faces;
  - a thicker, fully white rim (1.8 pt);
  - thicker strokes (2.2 pt over 4.2 pt);
  - brighter badge rims (50%);
  - a stronger drop shadow.
- **Frame rate** comes from a display link: 60 fps or more while anything moves, about 20 fps while only breathing,
  none when nothing changes.

## The mirror

The mirror draws the same `CursorFrame` through the same rig. Positions are mapped into its live image (aspect-fit),
and every size is ×0.62. Captions are left out: the mirror's own caption strip names the app.

## API

`CUPresentation.cursor(sessionId:target:point:kind:)` is unchanged. `CUCursorKind` keeps the pinned
`move, press, type, scroll, drag(to:)` and adds:

```swift
case target(frame: CGRect)          // screen points, like `point`
case doubleClick, rightClick
case key(combo: String)             // "cmd+s", "return"
case scrollToward(CUScrollDirection) // .up .down .left .right
case wait(CUWaitPhase)              // .begin(label: String?) / .end
case refused
case foreground(Bool)               // rung 4 on / off
case idle
case done
case caption(String?)               // nil clears
```

Kinds that are not about a place (`wait`, `refused`, `foreground`, `idle`, `done`, `caption`) use `point` only when
the cursor has not appeared yet. Send the last action point, or the window's centre.

`CUCursorKind(core:dragTo:frame:text:count:button:)` maps the core's event strings (below) so the shell needs no
switch of its own; an unknown string returns nil.

## What the core emits (`CUCoreEvents.actionAt`)

`actionAt` carries `kind: String`, `point` and `dragTo`. To reach every state it needs four more optional payloads:
- `frame: CGRect?` — the element's frame in screen points;
- `text: String?`;
- `count: Int?`;
- `button: String?`.

The shell then calls `CUCursorKind(core: kind, dragTo:, frame:, text:, count:, button:)`.

| Core `kind` | Payload | → `CUCursorKind` | Emit when | `point` |
|---|---|---|---|---|
| `"move"` | — | `.move` | A hover or pointer move without acting. | The point. |
| `"target"` | `frame` (required) | `.target(frame:)` | Immediately BEFORE any act on a ref: click, setValue, type with `into`, select, action, scroll on a ref, drag from a ref. Send it, then the act's own event. | The element's centre (or the act's point). |
| `"press"` | `count`, `button` | `.press`; count ≥ 2 → `.doubleClick`; button `"right"` → `.rightClick` | `click` (any rung). AX `action` → press; `AXShowMenu` → button `"right"`. `select` → press. | The click point. |
| `"doubleClick"` / `"rightClick"` | — | `.doubleClick` / `.rightClick` | Optional explicit forms. | The click point. |
| `"type"` | — | `.type` | `type`, `paste`, `setValue` (`"paste"` and `"setValue"` are accepted aliases). | The field's centre, or the caret if known. |
| `"key"` | `text` = combo, e.g. `"cmd+s"` (required) | `.key(combo:)` | `key`. | The focused element's centre, else the last point. |
| `"scroll"` | `text` = `"up"`/`"down"`/`"left"`/`"right"` | `.scrollToward(dir)`, or `.scroll` without `text` | `scroll`. | The scroll point. |
| `"drag"` | `dragTo` (required) | `.drag(to:)` | `drag`. | The start point. |
| `"waitBegin"` | `text` = what is awaited (the `waitFor` text or title), optional | `.wait(.begin(label:))` | At the start of `waitIdle`, `waitFor`, or a settle the script waits on. | The last point. |
| `"waitEnd"` | — | `.wait(.end)` | When that wait ends (met, settled OR timed out). | The last point. |
| `"refused"` | — | `.refused` | An act refused or failed: `refused`, `not_allowed`, `stale_ref`, `needs_foreground` declined, any act error. | The attempted point. |
| `"foreground"` | `text` = `"on"` / `"off"` | `.foreground(true/false)` | `"on"` just before rung-4 input; `"off"` right after it. | The real pointer's position. |
| `"idle"` | — | `.idle` | Optional: the cursor settles by itself after each action. | The last point. |
| `"done"` | — | `.done` | `target.release` (turn end and session end already fade it). | The last point. |
| `"caption"` | `text` (nil or empty clears) | `.caption(_)` | Before a consequential action (see Captions). Example: `"Clicking “Save”"`, or `"Choosing File › Export…"` for `menu`. | The action point. |

`menu` has no on-screen point in the background. Send only a `"caption"` ("Choosing File › Export…"), and no press.

## Proof without touching the screen

`CUCursorGallery.render(to:)` plays every state through the real timeline and rig into bitmaps: no window, overlay,
capture or tap. It writes:
- per state, PNG stills on light and dark at 1x and 2x;
- per state, a 30 fps looping GIF at 2x on light and on dark;
- `contact-sheet.png`: every state on Light, Dark, Reduce Motion and Increase Contrast, plus the mirror size;
- `cursor-closeups.png`: every state at 4x, cropped to the cursor.

Regenerate in either of two ways:
- `cu-presentation-demo --render-gallery <dir> [--no-gifs]`;
- `WINTER_CU_GALLERY_DIR=<dir> swift test --filter testRenderTheFullGalleryWhenAsked`.
