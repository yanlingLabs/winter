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

---

## 4. Type

**San Francisco everywhere, New York as a rare accent.** New York is the system serif (`Font.Design.serif`, no bundled font file) — the contrast of an authored serif heading over neutral sans body is the whole signature.

Since the 2026-08-13 typography pass this section is the **type source of truth for both apps**, the same way § 1 is for color. Two token files implement it and nothing else may construct a font:

| | Token file | Enforced by |
| --- | --- | --- |
| **Mac** | `apple/Norma/Sources/App/Typography.swift` (+ the serif bindings in `Theme.swift`) | `TypographyTests` — parses this section's tables AND sweeps every app source |
| **iOS** | `../norma-ios/Norma/App/Typography.swift` (+ the serif bindings in its `Theme.swift`) | `TypographyTests` in `NormaTests` — transcription + the same sweep |

### 4.1 The optical-parity law

**Point-size parity is NOT optical parity.** New York's x-height is ~9–10% shorter than San Francisco's at equal point size. Measured on macOS 26:

- SF at 14 pt: x-height **7.3691** · NY at 14 pt: **6.713** (−9%)
- NY at 15.5 pt: x-height **7.3337** — within **0.48%** of SF at 14 pt → *optical parity*
- SF at 15.5 pt: x-height **8.1587** — serif at the same points reads **~10% smaller** (−10.11%)

Consequences, stated as law:

1. **A serif role set beside a sans role takes MORE points, not the same number.** The Mac's serif ladder is the sans ladder × 15.5/14 for exactly this reason, and `TranscriptBrandTests.testTheSerifBodyIsSizedToMatchTheSansBodyItSitsBeside` keeps the measurement executable.
2. **Parity between the apps is parity of ROLES, not of numbers.** iOS expresses roles as Dynamic Type styles (they must keep scaling); the Mac expresses them as points (macOS has no user type ramp). The same role name in the table below is the parity contract — never copy a number across the column boundary.
3. **iOS currently violates clause 1** and this is recorded, not smoothed away: its serif assistant prose sits at `.body` — the same style as the sans user bubble beside it — so the reply genuinely renders ~10% smaller than the user's message. See § 4.6 for the recorded ruling and its recipe.

### 4.2 The serif allowlist

Serif may be used **only** for:

1. **The wordmark** — the iOS drawer title, the Mac sidebar header (`Theme.wordmark`, both platforms).
2. **The pairing-gate title** — iOS only (`Theme.serifTitle`).
3. **The pairing words display** — iOS only (`Theme.pairingWords`).
4. **Assistant prose in the transcript** — the reading face for what the assistant says. *Live on both platforms* (iOS from SP-chat; Mac from the 2026-08-12 chat-parity pass). The question card's question text is this binding too, by derivation — Norma asking is Norma speaking.
5. **The Mac new-chat greeting** (`Theme.greeting`) — added 2026-08-07. Not invented on a whim: the iOS gallery's typography file names "the home greeting" as a sanctioned serif moment alongside the wordmark; this entry *records* that shipped decision (its full defence lives on the token's own doc), which the list had failed to do until the 2026-08-13 typography pass.

Everything else — user messages, tool output, lists, chrome, code — stays on the system sans by doing nothing.

Binding #4 has one boundary worth stating outright, because the Mac's own renderer makes it easy to cross: it allowlists **the transcript reply**, not model-authored text wherever it appears. A plan card's body is written by the model and rendered by the very same view, and it stays **sans** — a card is chrome around a decision. On the Mac that is a required `role` parameter rather than a default, and `TranscriptBrandTests` scans both call sites in both directions.

**Do not add a sixth binding without amending this list.** Serif beyond these moments turns an accent into a costume.

### 4.3 The role table

The contract: **same role structure, same hierarchy order, same serif/sans assignment — platform-appropriate values.** iOS cells are Dynamic Type styles (weights via `.weight()`, all scaling intact); Mac cells are points. `—` means the role has no surface on that platform. Unqualified role names live on `Typography`; `Theme.`-qualified ones are the serif allowlist. The Mac column of every table in this section is **machine-parsed by `TypographyTests.testEveryRoleMatchesTheTableInBrandMd`** — cell grammar: points [`mono`] [weight], a `.style` name, `derived`, or `—`.

#### Content roles (the transcript, both voices)

| Role | iOS | Mac | Face / notes |
| --- | --- | --- | --- |
| `assistantProse` | `.body` serif, `lineSpacing(6)` | 15.5 serif, lineSpacing 5 | NY. Binding #4. The two ladders below. |
| `userBubble` | `.body` | 14 sans (the sans ladder's body) | SF. |
| `codeBlock` | `.footnote` mono | 12.5 mono | SF Mono. Mac: `syntaxCodeNS`. |
| `toolPhrase` | 14 (pinned) | 11 | Recorded divergence, § 4.6 — both sides measured, differently. |
| `toolOutputMono` | `.footnote` mono | 11 mono | The expandable tool payload. |
| `transcriptError` | `.footnote` | 11 | Mac: `caption`. |
| `jumpPill` | `.caption` semibold | 11 medium | "Jump to latest". |

The two Mac transcript ladders (`transcriptProseMetrics`, pinned by `TranscriptBrandTests`):

| | Sans (user message, plan card) | Serif (assistant reply) |
| --- | --- | --- |
| Body | 14 | 15.5 |
| Headings H1–H4 | 20 / 17 / 15.5 / 14.5 | 22 / 19 / 17 / 16 |
| Block quote | 13.5 | 15 |
| `lineSpacing` | 3 | 5 |
| Inline code | 13.5 (body − 0.5) | 13.5 (body − 2) |

Two notes. **Inline code lands on 13.5 pt in both**, by two different drops — SF Mono has to sit lower against New York than against SF to read as the same size. And the serif rhythm is 5, not iOS's: iOS's 1.59 pitch/size ratio is tuned for a phone's line width, and this is a desktop window.

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
| `questionPreviewMono` | — | `.body` mono | The Mac card's read-only preview pane. |

#### The composer

| Role | iOS | Mac | Notes |
| --- | --- | --- | --- |
| `composerField` | `.body` | 14 | The input itself. Mac: `ComposerTextView` via `sansNS(ofSize:)`, fed `bodySize` — except the new-chat page, whose composer is the page's subject and takes `headingSize` (16; `newChatComposerFontSize` derives from it). |
| `composerPlusGlyph` | 17 light | 17 medium | The attach circle — the one composer glyph size the platforms share. Mac: `composerAttachGlyph`. |
| `composerModelPill` | 14 (pinned) | 13 | iOS Claude-measured on device; Mac `control`. Recorded, § 4.6. |
| `composerSend` | 17 bold | 15 medium | Recorded divergence, § 4.6. |
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

**The orb is tokenised verbatim, never tuned from here.** The orb field renders on glass under the morph's blend law and `NormaFieldView`'s geometry is measured; its chrome happens to sit on the same scale (10–14), and `morphTrafficGlyph` (8.5 bold in a 14 pt circle) is one-off geometry. Any value change on those surfaces is an orb change and takes the orb's own gate.

### 4.6 Recorded divergences, and the open iOS ruling

Tokenisation is a refactor: rendered output changes **only** where a row here records a reconciliation with grounds. These are the places the two apps express the same role differently, kept as-is and recorded:

| Role | iOS | Mac | Status |
| --- | --- | --- | --- |
| Assistant serif prose vs sans beside it | both at `.body` → serif reads ~10% smaller | serif ladder ×15.5/14 → optical parity | **The open ruling.** iOS violates § 4.1; fix without breaking Dynamic Type = the whole serif ladder via `@ScaledMetric(relativeTo: .body)` (body ≈18.9→19; headings scaled to keep descending, else H3+ at `.headline`(17) falls *under* a 19 pt body). A phone-visual change on the primary reading surface → needs the on-device gate; recorded with the full recipe in the 2026-08-13 typography report. |
| `toolPhrase` | 14 pinned (Claude-measured on device, r3) | 11 (`caption`, the chrome scale) | Both deliberate measurements; a desktop row is quieter. Kept. |
| `composerSend` | 17 bold | 15 medium (`bodyLarge`) | Kept — different affordance sizes on the two composers. |
| `composerModelPill` | 14 pinned | 13 (`control`) | Kept. |
| Question options | box `.callout`, frozen card `.subheadline` | 14.5 (callout ratio) | iOS's two registers for one role predate the Mac port; the Mac took the box's. Kept, both named. |
| Question pills/chips | composer `.caption` medium, card chip `.caption2` semibold | 11 | Same story. Kept, both named. |
| Block quotes | no block in the iOS renderer | 13.5 / 15 by role | iOS parser gap, not a type decision. Recorded. |
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
