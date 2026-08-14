# Norma Brand Style Guide

The canonical definition of how Norma looks — colors, type, and the rules that keep two native apps on two platforms reading as one product.

**This document is the source of truth.** Two apps implement it:

| | Catalog | Names them |
| --- | --- | --- |
| **Mac** | `apple/Norma/Assets.xcassets` | `apple/Norma/Sources/App/Theme.swift` |
| **iOS** | `../norma-ios/Norma/Assets.xcassets` | `../norma-ios/Norma/App/Theme.swift` |

The palette originated on iOS, derived from the Claude iOS app and tuned by hand; the Mac adopted it in the 2026-08-07 sidebar-brand pass. The iOS design gallery (`../norma-ios/docs/ios26-design-gallery/`) remains the **phone's** styling authority for layout, materials, and Liquid Glass. This document governs **color and type on both platforms** and nothing else.

---

## 1. The palette

Every value below is authored in both catalogs with explicit Light and Dark appearances. Code never sees a number.

### The eleven shared tokens

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `Canvas` | `#F5F4F0` | `#181816` | The base plane. Warm cream / warm charcoal. |
| `CardSurface` | `#F9F9F7` | `#20201F` | The raised plane above `Canvas`. |
| `SelectionPill` | `#E8E6E1` | `#0B0B0B` | The selected row's fill. |
| `ElevatedSurface` | `#F2F2F7` | `#272726` | Tool output, approval cards — one step above the card. |
| `ControlSurface` | `#F0EFEC` | `#32322F` | Small controls: composer circles, model pills. |
| `BubbleUser` | `#F0EFEC` | `#32322F` | The user's own messages. |
| `ComposerSurface` | `#F9F9F7` | `#272726` | The composer card's opaque face. |
| `ComposerRim` | `#FFFFFF` @ 0.90 | `#FFFFFF` @ 0.08 | The composer's bright hairline. |
| `TextMuted` | `#7A7974` | `#9E9D96` | Quiet meta: section labels, timestamps, trailing glyphs. |
| `InverseCanvas` | `#2A2A27` | `#FAF9F5` | `Canvas` with its appearances swapped — the primary-action tint. |
| `AccentColor` | `#2E9484` | `#2E9484` | Brand teal. Same value in both appearances. |

### The four Mac-only tokens

These exist only in the Mac catalog. They are **deliberate platform extensions, not drift** — the phone has no hover state, no window-internal divider, and no floating palette, so there is nothing on iOS for them to mirror.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `RowHover` | `#EFEDE8` | `#101010` | Hover fill. Interpolated between `Canvas` and `SelectionPill` in both appearances, so hover → selected reads as one ramp rather than two unrelated tints. |
| `Hairline` | `#E5E2DC` | `#2A2A28` | The **shell's** divider: sidebar against content, and rims at the `Canvas`/`CardSurface` plane. Warm, because the system `separatorColor` is cool and fights the cream. |
| `HairlineElevated` | `#D8D5CF` | `#3A3A38` | The same rule **one plane up** — drawn *on* `ElevatedSurface` or `ControlSurface`. See below; it is not a nicety. |
| `PaletteSurface` | `#FFFFFF` | `#272726` | The face of anything that **floats above** content — the search palette it is named for, and the chat window's slide-in sidebar overlays. Brighter than `CardSurface` in both appearances, because it floats. |

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

**`CardSurface` must stay brighter than `Canvas` in both appearances.** That difference *is* the separation; the hairline is secondary. A palette tune that inverted it would make the shell read inside-out. Pinned by `SidebarBrandTests.testCardSurfaceIsBrighterThanCanvasInBothAppearances`.

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

The brand teal drives prominent controls, links, and `.tint(_:)`. It does **not** tint navigation. Selection in a sidebar is carried by fill alone (`SelectionPill`), with row content staying `.primary`.

On Mac this has a specific mechanical consequence: **`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` is deliberately left unset.** A colorset named `AccentColor` becomes the app-wide control tint the moment that setting names it — retinting every system control as a silent side effect of adding the palette. Keep it unset.

**Corollary, and it bit for real:** because that setting is unset, SwiftUI's `Color.accentColor` (and `.tint`'s default, and `.accentColor` in any form) resolves to **the user's own System Settings accent** — whatever they picked in General — not to Norma's teal. Code that wants the brand must name `Theme.accent`. Every accent-tinted piece of the Mac's approval and question cards was drawing in the Mac owner's personal accent until the 2026-08-12 transcript pass; `TranscriptBrandTests` now fails the suite on any `accentColor` in `ChatContent/`.

And an ancestor `.tint(_:)` does **not** rescue it — probed: with a system accent of `#FFC726`, `Color.accentColor` renders `#FFC727` even inside `.tint(Theme.accent)`, while `ShapeStyle.tint` renders `#2E9484`. `.tint` reaches `ShapeStyle.tint`, carets and selection; it does not reach `Color.accentColor`, which reads the system preference directly.

### 3.3 `SelectionPill` is darker than its pane in dark mode

`#0B0B0B` on a `#181816` base. This is intentional, measured from Claude, and adopted on purpose: a semantic system fill *cannot* express "darker than background", which is exactly why this is an authored asset rather than `.quaternary`.

Note this **differs from ChatGPT**, whose selected row is lighter than its pane. Where the two references disagree, Norma follows Claude — that is where the palette came from.

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

Everywhere else in Norma, colour is *surface*: § 3.4 records that this palette has had no danger and no success tone at all, which is why the transcript's failure lines are set in `.primary` and its status glyphs are shape-only. A diff is the exception, and not by preference — red and green **are** what the two columns mean, on every diff surface a person has ever read.

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

**A recorded limitation, in § 3.4's sense — and the wash is not its cause.** The syntax palette's light-mode ratios are below the body floor *already on the plain surface*: Apple's `systemGreen` is 2.11:1 on `CardSurface`, which is true of every code block in the transcript today and has nothing to do with diffs. What a wash adds is at most 0.31 of a ratio point — measurably negligible against a shortfall of 2.4. The body text itself (`labelColor`, which is the great majority of every line) is 9.31:1 or better on every ground here. Fixing the syntax palette is a separate change to a shared surface; tracked here, not fixed here, and explicitly **not** a reason to weaken the washes.

**Two channels, always.** The `-N`/`+M` signs and the `±` markers are TEXT, not glyphs, precisely because colour is the one channel that does not survive greyscale, colour blindness or a screen reader.

---

## 4. Type

**San Francisco everywhere, New York as a rare accent.** New York is the system serif (`Font.Design.serif`, no bundled font file) — the contrast of an authored serif heading over neutral sans body is the whole signature.

Since the 2026-08-13 typography pass this section is the **type source of truth for both apps**, the same way § 1 is for color. Two token files implement it and nothing else may construct a font:

| | Token file | Enforced by |
| --- | --- | --- |
| **Mac** | `apple/Norma/Sources/App/Typography.swift` (+ the serif bindings in `Theme.swift`) | `TypographyTests` — parses this section's tables AND sweeps every app source |
| **iOS** | `../norma-ios/Norma/App/Typography.swift` (+ the serif bindings in its `Theme.swift`) | `TypographyTests` in `NormaTests` — transcription + the same sweep |

### 4.1 The parity law

**Point-size parity is the design — iOS is the source of truth, ruled 2026-08-13** ("the iOS here is source of truth. the Mac should follow it"). iOS sets the user bubble and the serif assistant prose at the SAME nominal style (`.body`); the Mac mirrors that relationship at its own register: **one transcript ladder, shared by both prose roles**, with only the face and the leading differing.

The x-height facts stay recorded — as **accepted properties**, no longer as the rule. Measured on macOS 26:

- SF at 14 pt: x-height **7.3691** · NY at 14 pt: **6.713** (−9%)
- NY at 15.5 pt: x-height **7.3337** — within **0.48%** of SF at 14 pt
- SF at 15.5 pt: x-height **8.1587** — at a shared point size the serif reads **~10% optically lighter** (−10.11%)

That last line is the accepted property: at the shared ladder, Norma's serif reply reads ~10% lighter than the sans bubble beside it. Known, chosen — it is iOS's own rendered relationship, and matching it is the point. (An earlier pass sized the Mac's sans ladder lower to equalise x-heights; the ruling retired that — § 4.6.)

Consequences, stated as law:

1. **The two transcript prose roles share ONE ladder.** Same body, quote, headings and inline-code drop; the serif carries a wider leading (5 vs 3 — iOS's own distinction: `lineSpacing(6)` on serif markdown, nothing on the bubble). `TranscriptBrandTests.testTheTwoProseRolesShareOneNominalSizeByRuling` pins both the shared sizes and the accepted optical property.
2. **Parity between the apps is parity of ROLES, not of numbers.** iOS expresses roles as Dynamic Type styles (they must keep scaling); the Mac expresses them as points (macOS has no user type ramp). The same role name in the table below is the parity contract — never copy a number across the column boundary.

### 4.2 The serif allowlist

Serif may be used **only** for:

1. **The wordmark** — the iOS drawer title, the Mac sidebar header (`Theme.wordmark`, both platforms).
2. **The pairing-gate title** — iOS only (`Theme.serifTitle`).
3. **The pairing words display** — iOS only (`Theme.pairingWords`).
4. **Assistant prose in the transcript** — the reading face for what the assistant says. *Live on both platforms* (iOS from SP-chat; Mac from the 2026-08-12 chat-parity pass). The question card's question text is this binding too, by derivation — Norma asking is Norma speaking. So is the **orb field's inline reply** (ruled 2026-08-13: "the assistant reply should also use the same font the mac app uses font style and size") — `Typography.fieldAssistantMessage` wraps this face at the assistant role's size; same voice, one more surface, not a new binding.
5. **The Mac new-chat greeting** (`Theme.greeting`) — added 2026-08-07. Not invented on a whim: the iOS gallery's typography file names "the home greeting" as a sanctioned serif moment alongside the wordmark; this entry *records* that shipped decision (its full defence lives on the token's own doc), which the list had failed to do until the 2026-08-13 typography pass.

Everything else — user messages, tool output, lists, chrome, code — stays on the system sans by doing nothing.

Binding #4 has one boundary worth stating outright, because the Mac's own renderer makes it easy to cross: it allowlists **the transcript reply**, not model-authored text wherever it appears. A plan card's body is written by the model and rendered by the very same view, and it stays **sans** — a card is chrome around a decision. On the Mac that is a required `role` parameter rather than a default, and `TranscriptBrandTests` scans both call sites in both directions.

**Do not add a sixth binding without amending this list.** Serif beyond these moments turns an accent into a costume.

### 4.3 The role table

The contract: **same role structure, same hierarchy order, same serif/sans assignment — platform-appropriate values.** iOS cells are Dynamic Type styles (weights via `.weight()`, all scaling intact); Mac cells are points. `—` means the role has no surface on that platform. Unqualified role names live on `Typography`; `Theme.`-qualified ones are the serif allowlist. The Mac column of every table in this section is **machine-parsed by `TypographyTests.testEveryRoleMatchesTheTableInBrandMd`** — cell grammar: points [`mono`] [weight], a `.style` name, `derived`, or `—`.

#### Content roles (the transcript, both voices)

| Role | iOS | Mac | Face / notes |
| --- | --- | --- | --- |
| `assistantProse` | `.body` serif, `lineSpacing(6)` | 15.5 serif, lineSpacing 5 | NY. Binding #4. The unified ladder below. |
| `userBubble` | `.body` | 15.5 sans (the unified ladder's body) | SF. Same nominal size as the reply — § 4.1's law, iOS's own relationship. |
| `codeBlock` | `.footnote` mono | 12.5 mono | SF Mono. Mac: `syntaxCodeNS`. |
| `toolPhrase` | 14 (pinned) | 11 | Recorded divergence, § 4.6 — both sides measured, differently. |
| `toolOutputMono` | `.footnote` mono | 11 mono | The expandable tool payload. |
| `transcriptError` | `.footnote` | 11 | Mac: `caption`. |
| `jumpPill` | `.caption` semibold | 11 medium | "Jump to latest". |

The Mac's ONE transcript ladder (`transcriptProseMetrics`, both roles, pinned by `TranscriptBrandTests`; sans values were 14 / 13.5 / drop 0.5 / [20, 17, 15.5, 14.5] until the 2026-08-13 ruling):

| | Both prose roles (sans user message & plan card · serif assistant reply) |
| --- | --- |
| Body | 15.5 |
| Headings H1–H4 | 22 / 19 / 17 / 16 |
| Block quote | 15 |
| Inline code | 13.5 (body − 2, one shared drop) |
| `lineSpacing` | **sans 3 · serif 5** — the one metric the roles do NOT share |

The serif rhythm is 5, not iOS's: iOS's 1.59 pitch/size ratio is tuned for a phone's line width, and this is a desktop window. The sans keeps its tighter 3 — leading is the roles' one distinction, exactly as on iOS.

iOS's serif ladder is semantic: body prose `.body` serif; H1–H2 `.title3` semibold serif; H3+ `.headline` serif; no block-quote block in its renderer (recorded, § 4.6). Its inline code comes out of `AttributedString`'s markdown at the surrounding run's size — no separate role to name.

**Bold and italic runs inside serif prose stay New York.** `NSFontManager.convert(_:toHaveTrait:)` is free to fall back to another family when a trait is unavailable; measured, it does not here (`.NewYork-Regular` → `.NewYork-Semibold` / `.NewYork-RegularItalic`). Pinned by `TranscriptBrandTests.testSerifProseSurvivesBoldAndItalicConversion`, because the failure — every emphasis rendering in SF mid-sentence — is the kind nobody reports and everybody feels. The conversion itself lives in `Typography.converted(_:toHaveTrait:)` so the sweep can ban `NSFontManager` everywhere else.

#### The question card (one ladder, two registers)

The question is Norma asking, so its text is **binding #4 by derivation** on both platforms: on iOS by construction (`questionText ≡ assistantProse`), on the Mac by code (`QuestionCardType.question` *reads* `transcriptProseMetrics(.assistant).bodySize` — pinned as a derivation, never a copied number, by `InteractionCardTests`). The Mac steps are the iOS ratios against `.body` = 17, rounded to half points.

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `questionText` | `.body` serif, `lineSpacing(6)` | derived | ≡ `assistantProse` body, both platforms. |
| `questionOption` | `.callout` | 14.5 | The composer box's option register — the one the Mac ported. |
| `questionOptionInline` | `.subheadline` | — | iOS's frozen transcript card uses a step lower; recorded, § 4.6. |
| `questionSecondary` | `.footnote` | 12 | Descriptions, notes, Other. |
| `questionPill` | `.caption` medium | 11 | The composer's header pills. |
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
| `morphTrafficGlyph` | — | 8.5 bold | The morph window's hand-drawn traffic lights — verbatim orb geometry, § 4.5. |
| `paneTitle` | — | `.headline` | Dashboard pane titles. |
| `emptyStateTitle` | — | `.title2` | |
| `emptyStateSubtitle` | — | `.callout` | Also the dispatch explainer. |
| `landingBody` | — | `.body` | |
| `landingCaption` | — | `.caption` | |
| `chipLabel` | — | `.caption2` | Activity chips, sidebar count chips. |
| `fieldCodeLabelNS` | — | 11 medium | The orb field's code-block language label. |
| `fieldCodeBlockNS` | — | 13 mono | The orb field's code-block body. |
| `fieldInlineCodeNS` | — | derived | The orb field's inline-code run — re-bound through the shared transcript metrics by the orb ruling (lands on the same 13.5 the verbatim value carried: 15.5 − 2; a wiring change with zero rendered delta). |
| `fieldUserMessage` | — | derived | The orb field's echo of what you asked — bound to the transcript's user-message size (both 15.5 today). Face stays the field's difference-blend sans. |
| `fieldAssistantMessage` | — | derived | The orb field's reply — the transcript's assistant voice, FACE AND SIZE: `Theme.assistantProse` serif at the assistant role's size (final 2026-08-13 ruling; binding #4's surface, § 4.2). |
| `shortcutKeyNS` | — | 11 | Shortcut recorder key-caps. |
| `panelTabLabelNS` | — | 12 | The web panel's native tab label. |

Block maths (`mathNS`) walks a real maths-face candidate list (STIX Two first) and **defaults to the assistant-prose body size by derivation** (`mathDefaultNS`) — display maths sits inside Norma's reply.

#### The serif registers (both platforms, `Theme`)

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `Theme.wordmark` | 25 semibold serif | 20 semibold serif | Binding #1 — § 4.4 records why the numbers differ. |
| `Theme.greeting` | — | 38 serif | Binding #5, the new-chat page. |
| `Theme.assistantProse` | (via `.fontDesign(.serif)`) | derived | Binding #4's face — an NSFont face *function*; every size it renders comes from the ladders above, and `TranscriptBrandTests` pins the face itself. |

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
| Assistant serif prose vs sans beside it | both at `.body` → serif reads ~10% optically lighter | ONE shared ladder (15.5) → the same relationship | **RULED 2026-08-13: iOS is the source of truth; the Mac follows.** The earlier optical-parity correction (sans ladder sized lower to equalise x-heights) and the recorded `@ScaledMetric` recipe for lifting iOS's serif are both RETIRED — the point-size relationship, serif-reads-lighter and all, is the design. iOS unchanged; the Mac's sans ladder unified onto the assistant's sizes (leading stays distinct). |
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

- **Mac** — `TypographyTests` (in `NormaAppTests`): `testEveryRoleMatchesTheTableInBrandMd` parses § 4.3/§ 4.5's Mac cells from this file and asserts them against the live tokens (both directions, with a minimum-row floor so a format change cannot green it vacuously); `testNoFontIsConstructedOutsideTheTokenFiles` sweeps `Sources/` recursively; `testTokenFileConstructionCountIsPinned` pins the number of constructions inside the token files. Plus the pre-existing `TranscriptBrandTests` ladders/x-height/serif pins and `InteractionCardTests`' derivation pins.
- **iOS** — `TypographyTests` (in `NormaTests`): the doc table hand-transcribed (the § 1 palette pattern — the doc lives in this repo, so the phone asserts the transcription; updating the table means updating that test in the same change), the same recursive sweep, the same construction-count pin.
- **What the sweep cannot see** (each checked 2026-08-13): implicit `.init(` in argument position to a `Font`-typed parameter; `AttributeContainer.font = .body`-style implicit assignment; `.environment(\.font, …)` (none in either app); `.lineSpacing` literals outside the tokenised transcript surfaces; `.imageScale` (relative, no number; unused); `.minimumScaleFactor` (unused); Interface Builder files (neither repo has any); and omissions — a control that never sets a font renders the platform default. Multi-line `.font(` arguments are *forced* single-line rather than parsed.
- Trailing comments are not stripped by the sweep — it over-flags rather than under-flags, by design. Write the reason on its own line.

---

## 5. Mac sidebar metrics

The sidebar's vocabulary, measured from the ChatGPT desktop reference. All are **tune-at-gate** constants in `apple/Norma/Sources/AppShell/ShellSidebar.swift`.

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
| `InverseCanvas` | `#181816` | `#2A2A27` | drifted |
| `SelectionPill` | `#EDEBE6` | `#E8E6E1` | drifted |

Everything else the comments assert is still accurate (`ElevatedSurface`, `BubbleUser`, `ControlSurface`, `TextMuted`, `AccentColor`, `ComposerRim`, and both dark values above all match).

There is also one stale **relationship** claim, which the table above cannot show. `InverseCanvas` is documented as "`Canvas` with its light/dark values swapped". It no longer is: a true swap would be light `#181816` / dark `#F5F4F0`, but the asset is light `#2A2A27` / dark `#FAF9F5`. Both halves have moved off `Canvas`. The intent — *the base plane of the opposite appearance* — still holds; the literal derivation does not.

**The asset JSON is canonical.** The comments are stale prose. The Mac port was transcribed from the JSON for exactly this reason.

Correcting those comments is a small chore in the sibling repo, deliberately not done as part of the Mac pass that discovered it.

---

## 7. Reference material

- `../norma-ios/docs/ios26-design-gallery/10-color-materials-dark-mode.md` § 5 — the palette's original derivation.
- `../norma-ios/docs/ios26-design-gallery/08-typography.md` § 1 — the serif-as-accent argument.
- `../norma-ios/docs/ios26-design-gallery/17-claude-app-deconstruction.md` — the measurements most values came from.
