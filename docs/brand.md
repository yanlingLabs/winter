# Winter Brand Style Guide

The canonical definition of how Winter looks — colors, type, and the rules that keep two native apps on two platforms reading as one product.

**This document is the source of truth.** Two apps implement it:

| | Catalog | Names them |
| --- | --- | --- |
| **Mac** | `apple/Winter/Assets.xcassets` | `apple/Winter/Sources/App/Theme.swift` |
| **iOS** | `../norma-ios/Winter/Assets.xcassets` | `../norma-ios/Winter/App/Theme.swift` |

The palette originated on iOS, derived from the Claude iOS app and tuned by hand; the Mac adopted it in the 2026-08-07 sidebar-brand pass. The iOS design gallery (`../norma-ios/docs/ios26-design-gallery/`) remains the **phone's** styling authority for layout, materials, and Liquid Glass. This document governs **color and type on both platforms** and nothing else.

---

## 1. The palette

Every value below is authored with explicit Light and Dark appearances. Code never sees a number.

**The Mac and iOS palettes no longer mirror each other (2026-09-17).** The Mac follows the ChatGPT/Codex macOS app — the values in this section are the **Mac** catalog's, measured from its light and dark themes; the iOS catalog keeps its own values in `../norma-ios/Winter/Assets.xcassets`.

### The fourteen core tokens (Mac values)

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `Canvas` | `#FCFCFC` | `#262626` | The base plane. Near-white / neutral charcoal. |
| `CardSurface` | `#FFFFFF` | `#181818` | The content plane — ChatGPT's white / near-black. |
| `SelectionPill` | `#EFF0F0` | `#383838` | The selected row's fill — a soft neutral grey. |
| `ElevatedSurface` | `#F7F7F7` | `#232323` | Tool output, approval cards — one step above the card. |
| `ControlSurface` | `#F0F0F0` | `#323232` | Small controls: composer circles, model pills. |
| `BubbleUser` | `#EAF3FD` | `#223D72` | The user's own messages — ChatGPT's blue bubble. |
| `ComposerSurface` | `#FFFFFF` | `#353535` | The composer card's opaque face. |
| `ComposerRim` | `#E5E5E5` | `#414141` | The composer's bright hairline. |
| `TextMuted` | `#767778` | `#8B8B8B` | Quiet meta: section labels, timestamps, trailing glyphs — ChatGPT's measured "Worked for" grey (light) and idle-icon grey (dark). |
| `TextPrimary` | `#1A1C1F` | `#FFFFFF` | Body text — ChatGPT's measured reply ink (light; dark not yet measured). The shell's root foreground style. |
| `TextSecondary` | `#3B3D3F` | `#DEDEDE` | Sidebar text — ChatGPT's measured sidebar ink (light; dark not yet measured). |
| `TextPlaceholder` | `#C7C7C8` | `#686868` | Composer placeholder — ChatGPT's measured placeholder (light; dark not yet measured). |
| `InverseCanvas` | `#1A1C1F` | `#FFFFFF` | `Canvas` with its appearances swapped — the primary-action tint. |
| `AccentColor` | `#8CCBF0` | `#8CCBF0` | Brand ice blue. Same value in both appearances. |

### The Mac-only tokens

These exist only in the Mac catalog. They are **deliberate platform extensions, not drift** — the phone has no hover state, no window-internal divider, and no floating palette, so there is nothing on iOS for them to mirror.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `RowHover` | `#F5F6F6` | `#2F2F2F` | Hover fill — between `Canvas` and `SelectionPill` in both appearances (ChatGPT's measured sidebar ramp). |
| `RowHoverVibrant` | `#000000` @ 4% | `#FFFFFF` @ 6% | The same hover step for rows on the TRANSLUCENT sidebar plane (2026-09-17): a luminance wash, not a grey — it brightens or darkens the blur behind it instead of covering it. |
| `SelectionPillVibrant` | `#000000` @ 7% | `#FFFFFF` @ 10% | The selected step of that vibrant ramp. Paired with `RowHoverVibrant` so hover → selected reads as one ramp there too. |
| `Hairline` | `#EAEAEA` | `#373737` | The **shell's** divider: sidebar against content, and rims at the `Canvas`/`CardSurface` plane. A neutral grey, matched to the neutral planes. |
| `HairlineElevated` | `#DADADB` | `#3C3C3C` | The same rule **one plane up** — drawn *on* `ElevatedSurface` or `ControlSurface`. See below; it is not a nicety. |
| `PaletteSurface` | `#FFFFFF` | `#2D2D2D` | The face of anything that **floats above** content — the search palette it is named for, and the chat window's slide-in sidebar overlays. Brighter than `CardSurface` in both appearances, because it floats. |
| `ChromeHover` | `#EDEDEE` | `#2A2A2A` | Window-chrome controls' hover fill — titlebar icons, panel tabs, the address field. Dark is ChatGPT's measured value; light was not captured and sits one step past `ChromeSelected`. |
| `ChromeSelected` | `#F3F3F4` | `#242424` | The same controls' on/selected fill (the active panel tab, a toggled titlebar icon) — ChatGPT's measured values. |

`ElevatedSurface` cannot serve as `PaletteSurface`: its light value (`#F2F2F7`) is a retained cool system grey that is *darker* than `CardSurface`. That is the wrong direction for something that floats above.

**Why there are two hairlines.** `Hairline` is defined against the shell's two planes, and it collapses above them: on `ElevatedSurface` it measures **1.159:1 light and 1.040:1 dark** — in dark, a rule that is very nearly not drawn at all. The 2026-08-12 transcript pass walked straight into that by moving the interaction cards onto `ElevatedSurface` while leaving their separators and code-block rims on the shell token, which is how a divider added *because* "stacked blocks left the reader to infer from spacing alone" ended up back at nothing. `HairlineElevated` measures **1.313:1 light / 1.312:1 dark** on that plane — the same separation in both appearances by construction — and 1.389 / 1.431 on `CardSurface`, which is the ground a floating control's rim has to read against.

It is a second asset rather than `Hairline` with an alpha because its two halves move in *opposite* directions from `Hairline`'s: darker in light, lighter in dark. No single runtime opacity expresses that, which is § 3.1's whole argument. Pinned by `TranscriptBrandTests.testTheElevatedHairlineActuallySeparatesOnItsOwnPlane` and `…DivergesFromTheShellHairlineInBothDirections`.

### `BubbleUser` and `ControlSurface` are the same value

Not a mistake. Claude's user bubble measured byte-identical to their control-chip fill. They are kept as separate tokens so the two can diverge later without a rename.

---

## 2. The plane mapping

`Canvas` is the base. `CardSurface` is the raised plane above it. Everything else stacks on top of those two.

**On iOS** this is literal: the sidebar is the base plane the whole screen sits on, and the mode content is a card that slides over it. Surface contrast is the reveal drawer's *primary* separator — the card's shadow is only secondary.

**On Mac** the same two tokens map onto the window: **the sidebar is `Canvas`, the content side is `CardSurface`.** One decision satisfying two goals at once — it reproduces the greyer-sidebar-against-brighter-content relationship of the ChatGPT and Claude desktop apps, *and* it preserves the phone's base/raised semantics exactly, rather than reinterpreting them for a second platform.

**`CardSurface` must stay distinct from `Canvas` in both appearances.** That difference *is* the separation; the hairline is secondary. Light keeps the content brighter (pure white over a near-white sidebar); dark puts the content on pitch black, so there it is the darker plane. Pinned by `SidebarBrandTests.testCardSurfaceSeparatesFromCanvasInBothAppearances`.

### Inside the Mac transcript

The transcript sits on the content side, so `CardSurface` is its ground. Three things stack on it, and only three:

| Thing | Token |
| --- | --- |
| The user's own message bubble | `BubbleUser` |
| Interaction cards (approval / question / plan), tool-output blocks, fenced code blocks, the question preview pane, block maths | `ElevatedSurface` |
| The inline-code chip inside a run of prose; the "jump to latest" pill | `ControlSurface` |

`ElevatedSurface` is the *block* fill and `ControlSurface` is the *chip* fill, and they are not interchangeable: measured against `CardSurface`, `ElevatedSurface` is 1.06:1 — plenty for a block with its own bounds, invisible behind a few characters of text. Note `ElevatedSurface` is **darker** than its ground in light and lighter in dark; "one step above" is about layering, not brightness (which is also why it cannot serve as `PaletteSurface` — see § 1).

Rules drawn *on* those raised surfaces — a multi-question card's separators, a code block's rim, the "jump to latest" pill — take `HairlineElevated`, never the shell's `Hairline` (§ 1).

Everything else on this surface is text on that ground: `.primary` for content, `TextMuted` for meta (§ 3.5).

---

## 3. Rules

### 3.1 The anti-rule: no hex in code

> Never write `Color(red:green:blue:)` or a hex literal for UI chrome.

Colors are **named asset-catalog entries** with Light and Dark authored in the catalog, or a **reuse of a system semantic color**. `Theme` only ever *names* a color; it never computes one. Code stays appearance-agnostic and the catalog owns the values.

This extends to derived values. A hover tint is its own authored asset, not `.opacity(0.5)` applied to something else — a runtime alpha hack has no dark-mode variant and no way to be tuned per appearance.

### 3.2 The accent stays out of the sidebar

The brand ice blue drives prominent controls, links, and `.tint(_:)`. It does **not** tint navigation. Selection in a sidebar is carried by fill alone (`SelectionPill`), with row content staying `.primary`.

On Mac this has a specific mechanical consequence: **`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` is deliberately left unset.** A colorset named `AccentColor` becomes the app-wide control tint the moment that setting names it — retinting every system control as a silent side effect of adding the palette. Keep it unset.

**Corollary, and it bit for real:** because that setting is unset, SwiftUI's `Color.accentColor` (and `.tint`'s default, and `.accentColor` in any form) resolves to **the user's own System Settings accent** — whatever they picked in General — not to Winter's ice blue. Code that wants the brand must name `Theme.accent`. Every accent-tinted piece of the Mac's approval and question cards was drawing in the Mac owner's personal accent until the 2026-08-12 transcript pass; `TranscriptBrandTests` now fails the suite on any `accentColor` in `ChatContent/`.

And an ancestor `.tint(_:)` does **not** rescue it — probed: with a system accent of `#FFC726`, `Color.accentColor` renders `#FFC727` even inside `.tint(Theme.accent)`, while `ShapeStyle.tint` renders `#8CCBF0`. `.tint` reaches `ShapeStyle.tint`, carets and selection; it does not reach `Color.accentColor`, which reads the system preference directly.

### 3.3 `SelectionPill` is a neutral grey

`#EFF0F0` on the `#FCFCFC` light sidebar, `#383838` on the `#262626` dark one — ChatGPT's measured selected row, lighter-looking in dark and a soft grey in light. `RowHover` sits between the pane and the pill in both appearances so hover → selected reads as one ramp.

### 3.4 Contrast — a known limitation

The accent measures ≈4.8:1 on the dark canvas and ≈3.5:1 on the light cream. That is fine for controls and glyphs but **short of the 4.5:1 body-text floor in light mode**. If the accent is ever used to color text, a light-tuned darker variant must be introduced first. Tracked, not fixed.

### 3.5 Quiet text is `TextMuted`, not the system's faint greys

Two text registers, and only two: **`.primary` for content, `TextMuted` for meta.** SwiftUI's hierarchical `.tertiary`/`.quaternary` are not the third and fourth steps of that ladder — they are a different ladder, and the faint end of it is not legible on this palette.

Measured, composited on `CardSurface`:

| | Light | Contrast | Dark | Contrast |
| --- | --- | --- | --- | --- |
| `.secondary` | `#7D7D7C` | 3.91:1 | `#9A9A9A` | 5.80:1 |
| `.tertiary` | `#B9B9B7` | **1.86:1** | `#575756` | **2.25:1** |
| `TextMuted` | `#7A7974` | 4.14:1 | `#9E9D96` | 5.99:1 |

Two consequences.

**`.tertiary` is below every legibility floor there is.** It was the Mac transcript's activity rows, tool rows, session timestamps and completed tasks until the 2026-08-12 pass. Don't reach for it; `TranscriptBrandTests` fails the suite on it anywhere in `ChatContent/`.

**`.secondary` and `TextMuted` are ONE register, not two.** Three units apart is not a step. `.secondary` stays sanctioned under § 3.1 and is still used widely — but a surface that pairs the two, one above the other, is drawing one colour and claiming a hierarchy. Wherever moving the faint level onto `TextMuted` collapsed such a pair, the Mac transcript promoted the *upper* member to `.primary` rather than inventing a grey: tool-output payload against its chrome, a session row's title against its timestamp, a pending task against a completed one, a sidebar value against its label. That is the pattern to follow.

`.primary`, `.secondary`, `.green` and `.red` all remain sanctioned system semantic colors under § 3.1 — this rule is about the *faint* end, plus that one warning.

### 3.6 Diff colors — the one place colour carries meaning

Everywhere else in Winter, colour is *surface*: § 3.4 records that this palette has had no danger and no success tone at all, which is why the transcript's failure lines are set in `.primary` and its status glyphs are shape-only. A diff is the exception, and not by preference — red and green **are** what the two columns mean, on every diff surface a person has ever read.

Four tokens, both schemes: a **foreground pair** (the transcript chip's `-N +M`, the diff tab's gutter numbers and `±` markers) and a **row-wash pair** (the full-row background tint on changed rows).

| Token | Light | Dark |
| --- | --- | --- |
| `DiffAdded` | `#1F7A3D` | `#4CC38A` |
| `DiffRemoved` | `#B3261E` | `#FF6B70` |
| `DiffAddedWash` | `#22C55E` @ 10% | `#22C55E` @ 16% |
| `DiffRemovedWash` | `#EF4444` @ 10% | `#EF4444` @ 16% |

The washes are authored per appearance rather than as an `.opacity()` on the role — § 3.1's derived-value rule. Their two alphas differ because the two grounds do: the same 10% that reads as a clear tint on the cream `CardSurface` all but disappears on the dark one.

**Measured**, by § 3.5's method (WCAG relative contrast, sRGB, composited — a wash is alpha-composited over `CardSurface` before anything on it is measured). Grounds: `CardSurface` `#F9F9F7` / `#20201F`; added wash over it `#E3F4E8` / `#203A29`; removed wash over it `#F8E7E5` / `#412625`.

| | On `CardSurface` | On its own wash | On `ControlSurface` (the chip) |
| --- | --- | --- | --- |
| `DiffAdded` light | 5.10:1 | 4.70:1 | 4.67:1 |
| `DiffAdded` dark | 7.36:1 | 5.55:1 | 5.81:1 |
| `DiffRemoved` light | 6.20:1 | 5.46:1 | 5.68:1 |
| `DiffRemoved` dark | 5.89:1 | 4.97:1 | 4.65:1 |

All eight clear the 4.5:1 body floor. **One value moved to get there:** the dark red was provisionally `#F2555A`, which measures 4.83:1 on the panel — and **4.08:1 on its own wash**, which is the ground those numbers are actually drawn on. `#FF6B70` is that value lifted until the real ground passes. `TranscriptBrandTests.testTheDiffRolesClearTheBodyTextFloorOnEveryGroundTheyAreDrawnOn` pins all three grounds so the next tune cannot repeat it.

How visible the washes themselves are, against the plane they tint: added 1.085:1 light / 1.326:1 dark, removed 1.136:1 / 1.185:1. Deliberately faint — this is the background of ordinary code, not a highlight.

**What lands on the washes** (a diff row's text is `SyntaxHighlighter`'s output: `labelColor` body with the system-colour syntax palette on top):

| Ink | Light: card → +wash → −wash | Dark: card → +wash → −wash |
| --- | --- | --- |
| `labelColor` (the body) | 14.35 → 13.46 → 12.99 | 11.99 → 9.31 → 10.29 |
| `systemBlue` (keywords) | 3.34 → 3.08 → 2.94 | 5.04 → 3.80 → 4.25 |
| `systemGreen` (strings) | 2.11 → 1.94 → 1.85 | 8.07 → 6.08 → 6.80 |
| `systemPurple` (numbers) | 3.95 → 3.64 → 3.48 | 4.49 → 3.39 → 3.79 |
| `secondaryLabelColor` (comments) | 3.91 → 3.85 → 3.81 | 5.82 → 4.90 → 5.24 |

**A recorded limitation, in § 3.4's sense — and the wash is not its cause.** The syntax palette's light-mode ratios are below the body floor *already on the plain surface*: Apple's `systemGreen` is 2.11:1 on `CardSurface`, which is true of every code block in the transcript today and has nothing to do with diffs. What a wash adds is at most 0.47 of a ratio point — measurably negligible against a shortfall of 2.4. The body text itself (`labelColor`, which is the great majority of every line) is 9.31:1 or better on every ground here. Fixing the syntax palette is a separate change to a shared surface; tracked here, not fixed here, and explicitly **not** a reason to weaken the washes.

**Two channels, always.** The `-N`/`+M` signs and the `±` markers are TEXT, not glyphs, precisely because colour is the one channel that does not survive greyscale, colour blindness or a screen reader.

### 3.7 Panel tabs are neutral chrome

The six per-kind panel-tab tints (diff-tabs Task 12, extended by editor-product Task 2, re-tuned by the 2026-08-15 ladder ruling) were **retired on 2026-09-17**: panel tabs, the collapsed group chip, the "+" button and the titlebar icons all wear one neutral chrome style (`ShellChromeButtonStyle`) — no fill at rest, `ChromeHover` under the pointer, `ChromeSelected` while on — matching ChatGPT's macOS app. A tab's kind is still told by its favicon.

### 3.8 The editor's Monaco theme (editor-product Task 4)

`EditorTheme.tokensJSON(for:)` (`apple/Winter/Sources/AppShell/EditorTheme.swift`) is a Monaco `defineTheme` payload built entirely from tokens this document already names — no new hex is authored for the editor. `base` is Monaco's own builtin `vs` (light) / `vs-dark` (dark), `inherit: true` so everything this payload does NOT name still comes from that builtin. `EditorRuntime` sends it immediately once the page reports `ready`, and again on every system appearance change (`NSApp`'s own `effectiveAppearance`, the app's first non-SwiftUI reactor to it — every other surface adapts through `Color`/`Image`'s automatic machinery, which a Chromium page has none of).

**Chrome — five colors, all reused, none authored fresh:**

| Monaco color | Token | Light | Dark | Why this token |
| --- | --- | --- | --- | --- |
| `editor.background` | `CardSurface` | `#FFFFFF` | `#181818` | The plane every other panel content view sits on (§ 2's plane mapping) — the editor is one more tenant of it. |
| `editor.foreground` | `labelColor`, composited over `CardSurface` | `#262626` | `#DDDDDD` | `labelColor` is measured NOT fully opaque (84.7% both appearances, `PanelKindTintTests`); composited to one opaque hex by § 3.5's own method rather than sent with its own alpha — the SAME value § 3.6's ink table already publishes as "`labelColor` (the body)" on plain `CardSurface` (14.35 / 11.99, below). |
| `editor.selectionBackground` | `SelectionPill` | `#EFF0F0` | `#383838` | The one existing token named for exactly this job ("the selected row's fill"). Dark is darker than its pane by design — § 3.3's ruling carries over unchanged; this is the same asset, not a re-derivation. |
| `editor.lineHighlightBackground` | `RowHover` | `#F5F6F6` | `#2F2F2F` | The closest existing token to "the row under the cursor, gently set apart from its neighbours" — exactly what a list row's hover state already means everywhere else in the app. |
| `editorCursor.foreground` | `AccentColor` | `#8CCBF0` | `#8CCBF0` | Neither wash above reads as a CARET color — both are quiet fills, and a cursor wants to be found at a glance. `accent` is the one token reserved for exactly that job elsewhere (§ 3.2: "tints prominent controls and glyphs", the transcript's own selection chrome and in-progress markers). § 3.4's recorded ceiling ("fine for controls and glyphs, short of the body-text floor") is why this is sanctioned for a caret and would not be for a run of text. |

**Syntax — five Monaco token rules, the SAME `NSColor`s `SyntaxHighlighter` paints the transcript's code blocks with** (`ChatContent/MessageTextFormatting.swift`), so a code block reads identically in the transcript and in the editor:

| Monaco token | `NSColor` | Light | Dark | On `CardSurface`, § 3.5's method |
| --- | --- | --- | --- | --- |
| `keyword` | `.systemBlue` | `#0088FF` | `#0091FF` | 3.34:1 / 5.04:1 |
| `string` | `.systemGreen` | `#34C759` | `#30D158` | **2.11:1** / 8.07:1 |
| `number` | `.systemPurple` | `#CB30E0` | `#DB34F2` | 3.95:1 / 4.49:1 |
| `comment` | `.secondaryLabelColor` | `#7D7D7C` | `#9A9A9A` | 3.91:1 / 5.82:1 |
| `type` | `.systemBlue` (reused) | `#0088FF` | `#0091FF` | 3.34:1 / 5.04:1 |

The five contrast figures are not new measurements — they are § 3.6's own "on `CardSurface`" column ("What lands on the washes", above), which composites these identical five `NSColor`s over this identical ground for the transcript's diff rows. `type` has no role of its own in `SyntaxHighlighter.palette` (four roles, not five — keyword/string/number/comment); it reuses `keyword`'s color rather than introduce a fifth `NSColor` the transcript never paints with — a type name reads closer to a structural/declaration token than to a string, a number or a comment, the only other three roles on offer.

**The light-mode `systemGreen` limitation carries over, unfixed, as § 3.6 already records it.** `2.11:1` is below the 4.5:1 body floor, and it is not a property of the editor or of this payload — it is Apple's `systemGreen` on `CardSurface`, true of every string literal in every code surface this app has, editor included. § 3.6's own ruling stands without amendment: "fixing the syntax palette is a separate change to a shared surface; tracked here, not fixed here."

**The white flash — the OTHER half of this task, not a color-token question.** A Chromium page paints opaque white by default for the whole window between a browser existing and its own first paint — for the editor (asset load, the Monaco AMD bootstrap) on the order of a few hundred milliseconds, well before `setTheme` above could ever reach it. Two changes close that window rather than reduce it: the CEF browser's own `background_color` is set AT CREATION to `EditorTheme.cardSurfaceBackgroundARGB(for:)` — the scheme's `CardSurface`, opaque, packed `0xAARRGGBB` (`WinterCEF.h`'s `backgroundColorARGB` parameter — `0x00000000` is reserved as "no override" for every non-editor caller); `editor.html`'s body becomes `background: transparent`, so that browser-level color shows through instead of Chromium's own white until Monaco's first paint lands. Measured live (editor-product Task 4's harness run): with the branded theme sent immediately on `ready` (drill 1's `1.brand` step), a screenshot taken well into the run shows the editor already painted in `CardSurface`'s own tone, not white.

---

## 4. Type

**San Francisco everywhere, New York as a rare accent.** New York is the system serif (`Font.Design.serif`, no bundled font file) — the contrast of an authored serif heading over neutral sans body is the whole signature.

Since the 2026-08-13 typography pass this section is the **type source of truth for both apps**, the same way § 1 is for color. Two token files implement it and nothing else may construct a font:

| | Token file | Enforced by |
| --- | --- | --- |
| **Mac** | `apple/Winter/Sources/App/Typography.swift` (+ the serif bindings in `Theme.swift`) | `TypographyTests` — parses this section's tables AND sweeps every app source |
| **iOS** | `../norma-ios/Winter/App/Typography.swift` (+ the serif bindings in its `Theme.swift`) | `TypographyTests` in `WinterTests` — transcription + the same sweep |

### 4.1 The parity law

**The transcript follows ChatGPT's Mac app — measured 2026-09-17.** Both prose roles (the user bubble and the assistant reply) are the system sans at **14 pt on a ~23 pt line pitch**, matched against a 2× capture of ChatGPT by whole-line ink width (eight strings, all within ~0.5% of SF Pro 14 regular). ChatGPT bundles no text font of its own, so its face *is* SF Pro — Winter's sans. The earlier serif reply (New York) was retired the same day (§ 4.2).

Consequences, stated as law:

1. **The two transcript prose roles share ONE ladder** — body, quote, headings, inline-code drop *and* leading, in the same face. `TranscriptBrandTests.testTheTwoProseRolesShareOneLadder` pins it.
2. **Parity between the apps is parity of ROLES, not of numbers.** iOS expresses roles as Dynamic Type styles (they must keep scaling); the Mac expresses them as points (macOS has no user type ramp). The same role name in the table below is the parity contract — never copy a number across the column boundary.

### 4.2 The serif allowlist

Serif may be used **only** for:

1. **The wordmark** — the iOS drawer title, the Mac sidebar header (`Theme.wordmark`, both platforms).
2. **The pairing-gate title** — iOS only (`Theme.serifTitle`).
3. **The pairing words display** — iOS only (`Theme.pairingWords`).
4. ~~**Assistant prose in the transcript**~~ — **retired 2026-09-17** (user: "drop our weird assistant font"). The reply, the question card's question and the orb field's reply are the system sans on both platforms now; `Theme.assistantProse` survives on the Mac only as the named entry point for that voice.
5. **The Mac new-chat greeting** (`Theme.greeting`) — added 2026-08-07. Not invented on a whim: the iOS gallery's typography file names "the home greeting" as a sanctioned serif moment alongside the wordmark; this entry *records* that shipped decision (its full defence lives on the token's own doc), which the list had failed to do until the 2026-08-13 typography pass.

Everything else — user messages, tool output, lists, chrome, code — stays on the system sans by doing nothing.

The Mac renderer still takes a required `role` parameter (assistant vs sans) so the two voices can diverge again without a new plumbing pass; today both resolve to the same font.

**Do not add a binding without amending this list.** Serif beyond these moments turns an accent into a costume.

### 4.3 The role table

The contract: **same role structure, same hierarchy order, same serif/sans assignment — platform-appropriate values.** iOS cells are Dynamic Type styles (weights via `.weight()`, all scaling intact); Mac cells are points. `—` means the role has no surface on that platform. Unqualified role names live on `Typography`; `Theme.`-qualified ones are the serif allowlist. The Mac column of every table in this section is **machine-parsed by `TypographyTests.testEveryRoleMatchesTheTableInBrandMd`** — cell grammar: points [`mono`] [weight], a `.style` name, `derived`, or `—`.

#### Content roles (the transcript, both voices)

| Role | iOS | Mac | Face / notes |
| --- | --- | --- | --- |
| `assistantProse` | `.body`, `lineSpacing(6)` | 14 sans, lineSpacing 6 | SF. ChatGPT-measured; the unified ladder below. |
| `userBubble` | `.body` | 14 sans (the unified ladder's body) | SF. Same size and rhythm as the reply — § 4.1's law. |
| `codeBlock` | `.footnote` mono | 12.5 mono | SF Mono. Mac: `syntaxCodeNS`. |
| `toolPhrase` | 14 (pinned) | 11 | Recorded divergence, § 4.6 — both sides measured, differently. |
| `toolOutputMono` | `.footnote` mono | 11 mono | The expandable tool payload. |
| `transcriptError` | `.footnote` | 11 | Mac: `caption`. |
| `jumpPill` | `.caption` semibold | 11 medium | "Jump to latest". |

The Mac's ONE transcript ladder (`transcriptProseMetrics`, both roles, pinned by `TranscriptBrandTests`; 15.5 / 15 / drop 2 / [22, 19, 17, 16] with leading 3 · 5 until the 2026-09-17 ChatGPT pass):

| | Both prose roles (user message, plan card, assistant reply) |
| --- | --- |
| Body | 14 |
| Headings H1–H4 | 20 / 17 / 15.5 / 14.5 (not in the ChatGPT capture — the donor's 14-pt run) |
| Block quote | 13.5 |
| Inline code | 12.5 (body − 1.5 — the code-block face's size) |
| `lineSpacing` | 6 (14 pt SF's 16.7 natural line + 6 ≈ ChatGPT's measured 23 pt pitch) |

iOS's prose ladder is semantic: body prose `.body`; H1–H2 `.title3` semibold; H3+ `.headline`; no block-quote block in its renderer (recorded, § 4.6). Its inline code comes out of `AttributedString`'s markdown at the surrounding run's size — no separate role to name.

**Bold and italic runs** are built by `Typography.converted(_:toHaveTrait:)` (`NSFontManager`), kept there so the sweep can ban `NSFontManager` everywhere else.

#### The question card (one ladder, two registers)

The question is Winter asking, so its text is **binding #4 by derivation** on both platforms: on iOS by construction (`questionText ≡ assistantProse`), on the Mac by code (`QuestionCardType.question` *reads* `transcriptProseMetrics(.assistant).bodySize` — pinned as a derivation, never a copied number, by `InteractionCardTests`). The Mac steps are the iOS ratios against `.body` = 17, rounded to half points.

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `questionText` | `.body`, `lineSpacing(6)` | derived | ≡ `assistantProse` body, both platforms. |
| `questionOption` | `.callout` | 13 | The composer box's option register — the one the Mac ported. |
| `questionOptionInline` | `.subheadline` | — | iOS's frozen transcript card uses a step lower; recorded, § 4.6. |
| `questionSecondary` | `.footnote` | 10.5 | Descriptions, notes, Other. |
| `questionPill` | `.caption` medium | 10 | The composer's header pills. |
| `questionCardChip` | `.caption2` semibold | — | iOS's frozen-card category chip; recorded, § 4.6. |
| `questionPillCheck` | 9 semibold | 9 semibold | The answered-pill checkmark — the one glyph both platforms pin at 9. |
| `questionCheckmark` | `.body` medium | — | iOS's reserved-column option check. |
| `questionAction` | `.headline` | — | Submit / Close capsules (Mac's action row is chrome-drawn, `control`). |
| `questionActionGlyph` | 17 medium | — | The clear (xmark) circle. |
| `questionNoteGlyph` | 18 | — | The note toggle. |
| `questionNoteField` | `.footnote` | — | The note input. |
| `questionAttribution` | `.caption` | — | The frozen card's "answered by …" footer. |
| `questionPreviewMono` | — | `.body` mono | The Mac card's read-only preview pane. |

#### The composer

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `composerField` | `.body` | derived | The input itself — BOUND to the user-message size (ruling 2026-08-13), reading the live sans metrics so typing and the sent bubble can never diverge. EVERY home, the orb field included: the new-chat 16-pt opt-up (2026-08-07) and the orb's brief hold-at-14 were both retired by rulings the same day (§ 4.6). |
| `composerPlusGlyph` | 17 light | 17 medium | The attach circle — the one composer glyph size the platforms share. Mac: `composerAttachGlyph`. |
| `composerModelPill` | 14 (pinned) | 13 | iOS Claude-measured on device; Mac `control`. Recorded, § 4.6. |
| `composerSend` | 17 bold | 15 medium | Recorded divergence, § 4.6. |
| `composerMicGlyph` | 15 | — | The mock mic circle. |
| `composerStop` | 15 semibold | — | |
| `composerVoice` | 17 | — | The mock voice orb. |

#### iOS chrome (no Mac counterpart — the drawer, session lists, pickers, approvals, pairing)

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `sidebarSectionLabel` | `.subheadline` | — | "Recents" (sentence case, measured ~15 pt vs Claude). |
| `sidebarModeRow` | `.body` | — | Mode glyph + title. |
| `sidebarRecentRow` | `.body` | — | Recent-session rows. |
| `sidebarSoonBadge` | `.caption2` medium | — | The "Soon" capsule; also the session list's offline badge. |
| `sidebarMeta` | `.footnote` | — | Retry / empty-state lines. |
| `newChatPill` | `.callout` medium | — | |
| `sessionRowTitle` | `.body` | — | |
| `sessionRowSubtitle` | `.subheadline` | — | |
| `sessionRowChevron` | `.footnote` semibold | — | |
| `sessionStatusTitle` | `.subheadline` medium | — | Connection banner title. |
| `sessionStatusCaption` | `.caption2` | — | "Showing cached". |
| `newSessionGlyph` | 14 | — | The plus-bubble in the 32 pt inverse circle. |
| `bannerText` | `.caption` | — | Session-level notice rows. |
| `bannerDismiss` | `.caption2` bold | — | |
| `actionIcon` | 16 | — | Message action buttons (copy/retry). |
| `footerAsterisk` | 22 semibold | — | The end-of-conversation mark. |
| `footerDisclaimer` | `.footnote` | — | |
| `approvalTitle` | `.subheadline` semibold | — | |
| `approvalMeta` | `.footnote` | — | Summary + verdict rows (weights at call sites). |
| `dispatchBody` | `.callout` | — | |
| `settingsFootnote` | `.footnote` | — | |
| `pickerSheetTitle` | `.title3` semibold | — | |
| `pickerHeaderGlyph` | 17 medium | — | |
| `pickerRowIcon` | `.title3` | — | |
| `pickerRowTitle` | `.body` | — | Selected weights at call sites. |
| `pickerBadge` | `.footnote` semibold | — | |
| `pickerSubtitle` | `.subheadline` | — | |
| `pickerCaption` | `.caption2` medium | — | |
| `Theme.serifTitle` | `.title2` serif semibold | — | Binding #2, the pairing gate. |
| `Theme.pairingWords` | `.largeTitle` serif semibold | — | Binding #3 — named by this pass; was inline. |
| `pairedTitle` | `.title2` semibold | — | "Paired with …" (sans — chrome, not a binding). |
| `pairingAction` | `.headline` | — | Pair / Done / Submit capsules. |
| `pairingBody` | `.body` | — | |
| `pairingSubtitle` | `.subheadline` medium | — | |
| `pairingCaption` | `.footnote` | — | |
| `pairedGlyph` | 64 | — | The drawn-on checkmark. |
| `gateGlyph` | 56 | — | The not-paired phone glyph. |
| `scannerTitle` | `.title2` bold | — | |
| `scannerHeadline` | `.headline` | — | |
| `scannerSubtitle` | `.subheadline` | — | |
| `scannerInstruction` | `.footnote` | — | |
| `scannerGlyphLarge` | 48 | — | |
| `scannerGlyph` | 40 | — | |

The pinned glyph sizes above (14/16/17/18/22/40/48/56/64 and the two 13/11 tool marks) are **decoration geometry, not reading text** — the same exception class as the wordmark. Everything a user *reads* on iOS stays on the ramp.

#### Mac chrome (no iOS counterpart — the window shell, dashboard, orb)

The scale (§ 4.5) plus its mono variants and the named one-offs:

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `micro` | — | 8 | Path-crumb chevrons. |
| `badge` | — | 9 | Count badges, pill checkmarks, tool-row disclosure chevrons. |
| `tiny` | — | 10 | Timestamps, micro-labels. |
| `caption` | — | 11 | The small-meta workhorse (91 sites at adoption). |
| `label` | — | 12 | The standard label (107 sites at adoption). |
| `control` | — | 13 | Sidebar/palette rows, composer chrome. |
| `body` | — | 14 | Input + reading chrome. |
| `bodyLarge` | — | 15 | Send glyphs, palette input. |
| `heading` | — | 16 | Tile values, the new-chat composer. |
| `captionMono` | — | 11 mono | Paths, ids, hashes. |
| `labelMono` | — | 12 mono | Field values, URLs, config text. |
| `controlMono` | — | 13 mono | Provider model strings. |
| `emptyStateGlyph` | — | 34 light | Every landing surface's glyph. |
| `pairingCode` | — | 22 mono semibold | The six-digit confirm code. |
| `pairingGlyphLarge` | — | 36 | |
| `pairingGlyphMedium` | — | 30 | |
| `settingsPageTitle` | — | 26 regular | A settings page's title. |
| `morphTrafficGlyph` | — | 8.5 bold | The morph window's hand-drawn traffic lights — verbatim orb geometry, § 4.5. |
| `paneTitle` | — | `.headline` | Dashboard pane titles. |
| `emptyStateTitle` | — | `.title2` | |
| `emptyStateSubtitle` | — | `.callout` | Also the dispatch explainer. |
| `landingBody` | — | `.body` | |
| `landingCaption` | — | `.caption` | |
| `chipLabel` | — | `.caption2` | Activity chips, sidebar count chips. |
| `fieldCodeLabelNS` | — | 11 medium | The orb field's code-block language label. |
| `fieldCodeBlockNS` | — | 13 mono | The orb field's code-block body. |
| `fieldInlineCodeNS` | — | derived | The orb field's inline-code run — re-bound through the shared transcript metrics by the orb ruling (12.5 today: 14 − 1.5). |
| `fieldUserMessage` | — | derived | The orb field's echo of what you asked — bound to the transcript's user-message size (both 14 today). Face stays the field's difference-blend sans. |
| `fieldAssistantMessage` | — | derived | The orb field's reply — the transcript's assistant voice, FACE AND SIZE: `Theme.assistantProse` (the system sans since 2026-09-17) at the assistant role's size. |
| `shortcutKeyNS` | — | 11 | Shortcut recorder key-caps. |
| `panelTabLabelNS` | — | 12 | The web panel's native tab label. |

Block maths (`mathNS`) walks a real maths-face candidate list (STIX Two first) and **defaults to the assistant-prose body size by derivation** (`mathDefaultNS`) — display maths sits inside Winter's reply.

#### The serif registers (both platforms, `Theme`)

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `Theme.wordmark` | 25 semibold serif | 20 semibold serif | Binding #1 — § 4.4 records why the numbers differ. |
| `Theme.greeting` | — | 38 serif | Binding #5, the new-chat page. |
| `Theme.assistantProse` | (system sans) | derived | The assistant voice's face — an NSFont face *function*, the system sans since binding #4 was retired (§ 4.2); every size comes from the ladder above, and `TranscriptBrandTests` pins the face. |

### 4.4 The wordmark's two size registers

The wordmark is a **logo lockup, not text**, so it is pinned rather than Dynamic-Type-scaled — the deliberate exception to the rule that everything else scales.

| Platform | Register | Why |
| --- | --- | --- |
| iOS | `.system(size: 25, weight: .semibold, design: .serif)` | Measured against Claude's iOS drawer, where the wordmark is ~25 pt. `.title` (28 pt) rendered visibly ~15% taller side by side. |
| Mac | `.system(size: 20, weight: .semibold, design: .serif)` | 25 pt overpowers the row block in a 272 pt sidebar; 20 pt is what the ChatGPT desktop reference measures. |

Same binding, two platform registers. Not drift — a phone drawer and a desktop sidebar are different objects at different viewing distances.

### 4.5 The Mac chrome scale

macOS has no user Dynamic Type, so Mac chrome is honest fixed points — which is exactly why they must all live on one named ladder. The nine steps (8 / 9 / 10 / 11 / 12 / 13 / 14 / 15 / 16) are the app's own measured status quo from the 2026-08-13 inventory (12 pt ×107, 11 pt ×91, 13 pt ×35, 14 and 10 pt ×14 each, 9 pt ×9 — a clean ladder that was always there, just unnamed). Tokenising it changed **no rendered output**; weights stay call-site arguments (`Typography.caption(.semibold)`) because emphasis is per-surface, size is not.

**The orb's MESSAGE text follows the transcript; its chrome stays verbatim; its geometry never follows either.** The 2026-08-13 orb rulings bound the field's user echo, reply and inline code to the live transcript metrics (`fieldUserMessage` / `fieldAssistantMessage` / `fieldInlineCodeNS`) — the reply in the transcript's serif FACE as well as its size, the echo staying difference-blend sans — and the typing surface to the user-message size (`composerFieldSize`, the +1 pt resting consequence accepted by the final ruling). Everything else the orb draws — status glyphs, verb labels, hint rows, chips, `morphTrafficGlyph` (8.5 bold in a 14 pt circle) — is chrome on the measured scale, tokenised verbatim, and any change there is an orb change taking the orb's own gate. The field's GEOMETRY is ruled stable independent of text size: the panel frame and the pill clamps (360 / 44 / 240) are literals in `MorphModel`, the geometry side never references the type system (pinned by `TypographyTests.testOrbGeometryIsIndependentOfTheTypeSystem`), and text lays out inside those clamps — wrapping and scrolling at the ceiling as it already does. The one text-derived dimension is the pill's grow-with-typing height BETWEEN the clamps, which is why the orb's own composer is held (§ 4.6).

### 4.6 Recorded divergences, and the open iOS ruling

Tokenisation is a refactor: rendered output changes **only** where a row here records a reconciliation with grounds. These are the places the two apps express the same role differently, kept as-is and recorded:

| Role | iOS | Mac | Status |
| --- | --- | --- | --- |
| Assistant prose vs the user bubble | both at `.body`, both sans | ONE shared ladder (14), both sans | **2026-09-17: serif retired, ladder re-measured against ChatGPT (14 pt).** History: **RULED 2026-08-13: iOS is the source of truth; the Mac follows.** The earlier optical-parity correction (sans ladder sized lower to equalise x-heights) and the recorded `@ScaledMetric` recipe for lifting iOS's serif are both RETIRED — the point-size relationship, serif-reads-lighter and all, is the design. iOS unchanged; the Mac's sans ladder unified onto the assistant's sizes (leading stays distinct). |
| Composer field vs user bubble | both `.body` — the field and the bubble share one style | derived — one bound size | **RESOLVED 2026-08-13** ("make the composer field bound to the user message size aka 15.5"): `composerFieldSize` reads the live sans metrics, so the divergence is structurally closed — a ladder change moves typing and bubble together. The new-chat page's 16-pt register (a 2026-08-07 user call) is retired by the same ruling. |
| Orb field + morph window message text | n/a | derived — bound to the transcript roles | **RULED 2026-08-13**, twice: sizes first ("follow the same message sizes … bound to the apps transcript sizes"), then the reply's FACE ("the same font the mac app uses font style and size") — the field reply is `Theme.assistantProse` serif at 15.5, binding #4's surface. The morph window's transcript is `WindowContentView` → `TranscriptView` → the metrics end to end (verified; it needed nothing). Rendered changes: reply 13 sans → 15.5 serif, echo 11 → 15.5; inline code lands on the same 13.5. **Visual gate:** New York at 15.5 under the field's difference-blend law has never been seen — glass legibility is eye-only. |
| The orb field's OWN composer | n/a | derived — bound like every other home | **RESOLVED by the final 2026-08-13 ruling** ("the orb should type at 15.5 as well make it bound to the user message transcript"): the hold-at-14 is retired, the quantified consequence accepted (resting field 47 → 48 pt, line height 17 → 18, wider grow steps). The clear-button threshold is re-derived from the live face (`ComposerTextView.twoLineContentHeight` — two lines + insets), so the NEXT ladder change moves it with the text instead of silently retuning it. Panel clamps stay literal and type-independent, pinned. |
| `toolPhrase` | 14 pinned (Claude-measured on device, r3) | 11 (`caption`, the chrome scale) | Both deliberate measurements; a desktop row is quieter. Kept. |
| `composerSend` | 17 bold | 15 medium (`bodyLarge`) | Kept — different affordance sizes on the two composers. |
| `composerModelPill` | 14 pinned | 13 (`control`) | Kept. |
| Question options | box `.callout`, frozen card `.subheadline` | 14.5 (callout ratio) | iOS's two registers for one role predate the Mac port; the Mac took the box's. Kept, both named. |
| Question pills/chips | composer `.caption` medium, card chip `.caption2` semibold | 11 | Same story. Kept, both named. |
| Block quotes | no block in the iOS renderer | 15 (unified ladder) | iOS parser gap, not a type decision. Recorded. |
| iOS fixed-size meta (`toolPhrase` 14, `composerModelPill` 14, glyph pins) | pinned, does not scale with Dynamic Type | n/a | Pre-existing, deliberate per their measurement comments; now *named* so the exception is visible. |

### 4.7 How to add a role

1. Name it in the right table above (iOS style, Mac points, face, weight if it matters). The name is the Swift symbol name.
2. Add the token to the platform file(s): `Typography` for chrome, `Theme` only for a new serif binding (which also means amending § 4.2 — that is the point of the list).
3. Run the suite. `TypographyTests` fails until doc and code agree — the Mac side parses this file, and both platforms pin the construction count inside the token files, so an unrecorded token cannot ride along silently.
4. Route call sites through the role. Never a literal at a call site: the sweep fails on any font constructed outside the token files.

### 4.8 Enforcement

- **Mac** — `TypographyTests` (in `WinterAppTests`): `testEveryRoleMatchesTheTableInBrandMd` parses § 4.3/§ 4.5's Mac cells from this file and asserts them against the live tokens (both directions, with a minimum-row floor so a format change cannot green it vacuously); `testNoFontIsConstructedOutsideTheTokenFiles` sweeps `Sources/` recursively; `testTokenFileConstructionCountIsPinned` pins the number of constructions inside the token files. Plus the pre-existing `TranscriptBrandTests` ladders/x-height/serif pins and `InteractionCardTests`' derivation pins.
- **iOS** — `TypographyTests` (in `WinterTests`): the doc table hand-transcribed (the § 1 palette pattern — the doc lives in this repo, so the phone asserts the transcription; updating the table means updating that test in the same change), the same recursive sweep, the same construction-count pin.
- **What the sweep cannot see** (each checked 2026-08-13): implicit `.init(` in argument position to a `Font`-typed parameter; `AttributeContainer.font = .body`-style implicit assignment; `.environment(\.font, …)` (none in either app); `.lineSpacing` literals outside the tokenised transcript surfaces; `.imageScale` (relative, no number; unused); `.minimumScaleFactor` (unused); Interface Builder files (neither repo has any); and omissions — a control that never sets a font renders the platform default. Multi-line `.font(` arguments are *forced* single-line rather than parsed.
- Trailing comments are not stripped by the sweep — it over-flags rather than under-flags, by design. Write the reason on its own line.

---

## 5. Mac sidebar metrics

The sidebar's vocabulary, measured from the ChatGPT desktop reference. All are **tune-at-gate** constants in `apple/Winter/Sources/AppShell/ShellSidebar.swift`.

| Constant | Value | Note |
| --- | --- | --- |
| `shellSidebarWidth` | 272 | Reference measures ~277. |
| `shellSidebarRowHeight` | 32 | Nav rows and Recents rows alike. |
| `shellSidebarWordmarkRowHeight` | 38 | Taller — it also clears the inline traffic lights. |
| `shellSidebarSectionGap` | 44 | Nav block → "Recents" label. |
| `shellSidebarRowCornerRadius` | 6 | Shared by every row fill. |
| `shellSidebarTopInset` | 44 | Traffic-light clearance. |
| `shellSidebarHairlineWidth` | 1 | |
| `shellTrafficLightInset` | (10, 8) | See below. |
| `shellSidebarToggleLeadingInset` | 88 | Cluster starts beyond the three window buttons. |
| `shellSidebarToggleTopInset` | 11 | From the window top, *not* the safe area. Shared by both clusters. |
| `shellTitlebarButtonSize` | 26 | Every titlebar button. |
| `shellTitlebarClusterSpacing` | 8 | Size + spacing = the reference's **34 pt pitch**. |
| `shellTitlebarTrailingInset` | 8 | Trailing cluster's gap from the window edge. |
| `shellSidebarContentInset` | 18 | The pane's content column. |

`shellSidebarSectionGap` deserves a note: at the old 14 pt the pane read as one undifferentiated column of rows. Widening that single gap does more than any other value to make the sidebar read like the reference.

`shellTrafficLightInset` deserves a longer one. macOS insets the traffic lights automatically only when a window has a **unified NSToolbar** — and this window deliberately has none (`AppShellTests` pins `window.toolbar == nil`; the ChatGPT app has no toolbar and the custom-sidebar rework removed ours on purpose). Rather than reinstate chrome that was removed by decision, `AppWindowController.positionTrafficLights()` offsets the three standard window buttons by hand, from a **remembered AppKit baseline** so repeated application cannot drift them, re-applied on resize because AppKit re-lays them out.

### The titlebar clusters

Two clusters flank the titlebar band, both on the **traffic lights' centre line**: the sidebar toggle plus back/forward at the leading edge, and three window affordances at the trailing edge. Metrics are measured off the reference by cropping its titlebar corners, not estimated — the 34 pt centre-to-centre pitch is its figure.

Three rules:

1. **Both clusters read one `shellSidebarToggleTopInset`**, so they share a centre line by construction rather than by two numbers happening to agree.
2. **Every icon up there is a `ShellTitlebarButton`** — one hit box, one metric, one hover treatment. The hover fill is `ShellSidebarRowStyle`, the same treatment sidebar rows wear: a background fill, never a colour change on the glyph.
3. **Placeholders hover and click like anything else**, one step quieter in colour, and their help text says *"not wired yet"* — so hovering one cannot promise a feature that does not exist. (An earlier pass rendered them `.disabled`; the user's call was that they should behave as buttons.)

### The sidebar toggle

The pane collapses, driven by a toggle pinned in the titlebar band to the right of the traffic lights. Two rules:

1. **It stays in the same place in both states.** An affordance that disappears along with the pane it controls is unfindable. This is why it is an overlay on the shell root rather than a child of the pane.
2. **The glyph states the condition; the label names the action.** Two distinct symbols — `rectangle.leadinghalf.inset.filled` when showing, `sidebar.left` when hidden — not one symbol in two tints, which would be ambiguous exactly when the referenced pane is off-screen. Help text reads "Hide sidebar" / "Show sidebar".

---

## 6. Keeping the two apps in sync

**Two catalogs. No shared package. This document is the tripwire.**

A shared SPM design product would cost a `v-*-kitN` tag on this repo plus a `revision:` bump and `xcodegen generate` in `norma-ios` for **zero phone benefit** — the values don't change, only where they're stored. Not worth the release churn today. It stays a documented option, not a debt.

So the discipline is manual and stated:

- **Changing a shared token means changing both catalogs and this table**, in the same change.
- **A Mac-only or iOS-only token must be declared as such here**, with its reason — otherwise the next person reads it as drift and "fixes" it.
- The Mac catalog was ported from the iOS asset JSON with a programmatic diff proving all eleven matched exactly. Re-run that check when touching shared values.

### Recorded drift: iOS `Theme.swift` comments vs. its own assets

Some iOS `Theme.swift` doc comments quote hex values that **no longer match the assets they describe**. Verified by extracting every hex literal from that file and diffing it against the catalog:

| Token | Comment says (light) | Asset actually is | |
| --- | --- | --- | --- |
| `InverseCanvas` | `#2A2A2A` | `#FAFAFA` | drifted |
| `SelectionPill` | `#EFEFEF` | `#0B0B0B` | drifted |

Everything else the comments assert is still accurate (`ElevatedSurface`, `BubbleUser`, `ControlSurface`, `TextMuted`, `AccentColor`, `ComposerRim`, and both dark values above all match).

There is also one stale **relationship** claim, which the table above cannot show. `InverseCanvas` is documented as "`Canvas` with its light/dark values swapped". It no longer is: a true swap would be light `#181816` / dark `#F5F4F0`, but the asset is light `#2A2A27` / dark `#FAF9F5`. Both halves have moved off `Canvas`. The intent — *the base plane of the opposite appearance* — still holds; the literal derivation does not.

**The asset JSON is canonical.** The comments are stale prose. The Mac port was transcribed from the JSON for exactly this reason.

Correcting those comments is a small chore in the sibling repo, deliberately not done as part of the Mac pass that discovered it.

---

## 7. Reference material

- `../norma-ios/docs/ios26-design-gallery/10-color-materials-dark-mode.md` § 5 — the palette's original derivation.
- `../norma-ios/docs/ios26-design-gallery/08-typography.md` § 1 — the serif-as-accent argument.
- `../norma-ios/docs/ios26-design-gallery/17-claude-app-deconstruction.md` — the measurements most values came from.
