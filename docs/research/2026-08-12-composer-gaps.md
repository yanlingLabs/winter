# Composer gaps on the Mac shell — research (2026-08-12)

Read-only research. No code changed, nothing launched. Scope: the **composer and its surrounding
chrome** on the Mac's ChatGPT-style shell. The transcript/cards/tool-rows comparison is a sibling
document.

Two reported gaps:

1. the model/effort picker on the Mac composer is a placeholder; iOS's is real;
2. the permissions selector should sit **above the composer, cowork-style**, not only in a ⋯ popover.

Headline for each:

* **Gap 1 is "wire existing", not "build the menu."** The Mac already ships a complete,
  catalogue-driven model menu *and* effort menu, fully wired to `session.setModel` /
  `session.setEffort`, with optimistic overlay + probation-revert — and they already render **on
  this exact screen**, in the header row a few inches above the composer. The composer chip is a
  second, dead affordance for machinery that is already live on the same page.
* **Gap 2 is "build new, from an existing recipe."** The cowork strip the user is describing is a
  real, measurable surface in `NormaComposerCard`; the policy picker row body is a real, shared
  view (`policyPickerRow`). Nothing joins them today. The surgery is small; the *decisions* are not.

---

## Gap 1 — the model/effort picker

### 1.1 What the user sees today

`apple/Norma/Sources/AppShell/NormaComposerCard.swift:207-215` — the control row's model slot:

```swift
HStack(spacing: 4) {
    Text(newChatModelPlaceholder)            // "Default model"
        .font(.system(size: 14))
    Image(systemName: "chevron.down")
        .font(.system(size: 9, weight: .semibold))
}
.help("Model and effort (not wired yet)")
```

It is not even a `Button` — it is an `HStack` with a `.help()`. There is no action, no hover, no
hit-target beyond the tooltip. `newChatModelPlaceholder` is `"Default model"`
(`AppShell/NewChatPage.swift:118`), deliberately not a real slug.

The two neighbours, **out of scope** but noted as requested:

* `NormaComposerCard.swift:204` — `NewChatControlButton(systemImage: "plus", label: "Attach (not
  wired yet)")`. `NewChatControlButton` (`NewChatPage.swift:280-298`) is `Button {} label:` — an
  **empty action closure**. Not trivially adjacent: attachment needs a file-picker, an upload path,
  and a wire shape none of which exist.
* `NormaComposerCard.swift:216` — the same for `"mic"` / Dictate. Also not adjacent.

The card has **two homes** and both show this chip:

| home | mount | `stripEdge` |
|---|---|---|
| new-chat launch page | `NewChatPage.swift:505` | `.below` |
| live session page | `ChatContent/WindowContentView.swift:187` | `.above` |

`WindowContentView` is in turn hosted by `ShellSessionView`
(`AppShell/ShellSessionHost.swift:1762`), which is mounted from `ShellSidebar.swift:495` (the
shell's detail column) **and** `DispatchSurface.swift:97`. So the composer card renders on chat,
code and dispatch sessions.

### 1.2 What iOS does, end to end

**Control.** `norma-ios/Norma/Code/ChatComposerView.swift:97-126` — `modelPill`, a real `Button`
in the composer's control row (position 2, right after the mocked `+`):

* label = `picker.selectedOption.displayName` at 14 pt regular, `.primary`;
* plus, **only when there is one**, `picker.effortPillLabel` at 14 pt `.secondary`
  (`ModelPickerModel.swift:368-371` — `nil` on a never-synced phone or an unset Mac effort, because
  "a pill reading `Terra Default` would name a level that does not exist");
* capsule, `Theme.controlSurface`, `.frame(height: 36)`, `.padding(.horizontal, 16)`;
* accessibility label `"Model: \(picker.pillLabel)"`, e.g. `"Terra High"`
  (`ModelPickerModel.swift:375-378`).

So: **model name + effort word, side by side, no glyph, no chevron.**

**Presentation.** Tap → `.sheet` (`ChatComposerView.swift:78-80`) → `ModelPickerSheet`
(`Code/ModelPickerSheet.swift`). Two pages, `NavigationStack`-pushed:

* page 1 "Select model" — one grouped card, one row per catalogue model, title + blurb + trailing
  teal checkmark, `Default` badge on `picker.defaultModel`. Then a separate card whose single row
  is `Effort` → pushes page 2. **That row is absent entirely when `picker.offeredEfforts` is empty**
  (`ModelPickerSheet.swift:53`).
* page 2 "Effort" — a `Default` row that *clears* the override, then one row per offered level,
  then a footer caption and the (still-mock) Thinking toggle.
* Metrics (measured from Claude, per the file's own doc): card `r=24` continuous, 28 pt horizontal
  page margins, ~69 pt rows via 14 pt vertical padding, separators inset 18 pt, 42 pt circular
  glass header button, `presentationDetents([.fraction(0.72), .large])`.

**What it calls.** `ModelPickerModel` (`Code/ModelPickerModel.swift:225`) is injected with two
closures — `applyModel: (String) async throws -> Void` and `applyEffort: (String?) async throws ->
Void` — so it never learns which engine it drives (`CodeSessionView.swift:85-100` binds them to
`CodeSessionModel.applyModel/applyEffort`, i.e. `session.setModel` / `session.setEffort` on a
Mac-driven session; `LocalChatController` for the phone's own chat engine).

**How the change reflects back — and the one place iOS is deliberately better than the Mac.** The
apply is **awaited**; the checkmark moves **only on success**; a refusal is rendered verbatim at the
top of the sheet (`FailureBanner`, `ModelPickerSheet.swift:244`). The file says so in its own words
(`ModelPickerSheet.swift:12-16`):

> The Mac's picker fires `setModel` and forgets, so a slug the daemon rejects silently does nothing
> while the checkmark moves anyway.

That is accurate as of today — see §1.3's probation note for the Mac's (different, weaker)
compensation.

**iOS has no pre-session picker.** `ChatComposerView` exists only inside `CodeSessionView`
(`CodeSessionView.swift:144`), which is constructed only with a live `model.sessionId`
(`ChatSessionScreen.swift:215`, `CodeRootView.swift:165`), and `ModelPickerModel.init` takes
`sessionId:` as a required parameter. **A new chat on iOS gets the Mac's default and the picker
appears once the session exists.** This is the closest thing to a precedent for the Mac's new-chat
question (§1.5).

### 1.3 What the Mac already has — the actual answer to "wire or build"

**Build nothing. The menus exist, are catalogue-driven, and already render on this screen.**

`ChatContent/WindowContentView.swift:100-143` is the chat header row. It already renders, in order:
working-dirs chip, background verb, **model menu**, **effort menu**, policy ⋯.

| piece | location | what it is |
|---|---|---|
| model button | `WindowContentView.swift:393-408` | `Image(systemName: "cpu")`, 14 pt `.secondary`, plain; on tap calls `adapter.onRefreshModelCatalogue()` then opens a `.popover(arrowEdge: .bottom)` |
| model menu content | `:419-438` | header `Model` (11 pt semibold secondary), a `Default` row, one row per `modelPickerOptions(adapter.modelCatalogue)`, plus a row for an unlisted current slug. `.padding(12)`, `.frame(minWidth: 160)` |
| model row | `:444-463` | sets `adapter.pendingModel` (optimistic), fires `adapter.onSetModel(model)`, closes; `.disabled(adapter.modelChangeInFlight)`, `.padding(.vertical, 4)` |
| effort button | `:469-484` | `Image(systemName: "gauge.with.dots.needle.33percent")`, same idiom |
| effort menu content | `:495-528` | header `Reasoning effort`, `Default`, then `opts.wire`, then a second `Norma` section for `opts.tiers`, then an `.unknown` row for a current value in neither list. `.frame(minWidth: 180)` |
| effort row | `:530-549` | mirror of the model row against `onSetEffort` / `effortChangeInFlight` |

The **pure decisions** behind them are already extracted and unit-tested
(`apple/Norma/Tests/NormaAppTests/ModelPickerTests.swift`, 33 tests):

* `modelPickerOptions(_:)` — `WindowContentView.swift:724`. `catalogue.models.map(\.id)`. Empty is a
  real answer; never derive a lineup.
* `effortPickerOptions(catalogue:model:mode:)` — `:758`. Returns `(wire:, tiers:)` — **two lists,
  never concatenated**. `wire` = the selected model's `efforts` (resolving the model as
  `override ?? catalogue.defaultModel`). `tiers` = `catalogue.clientEfforts`, and **only** when
  `wire` is non-empty *and* `effortTiersAreOffered(mode:)`.
* `effortTiersAreOffered(mode:)` — `:772`. `mode == nil || mode == "code"`. Swift mirror of the
  daemon's `clientEffortEligible`.
* `selectionIsCurrent` `:782`, `selectionOrigin` `:792`, `modelDisplayLabel` `:801` (`"Default"` for
  nil), `effortDisplayLabel` `:810` (`"Default"` for nil — deliberately *not* `"none"`).
* `modelMenuIsVisible(isChatSession:)` `:832` → **always `true`**;
  `effortMenuIsVisible(isChatSession:)` `:819` → **always `true`**. Both kept as named functions
  precisely so that a regression copying the policy button's `!isChatSession` there is an obviously
  wrong one-line diff.
* `effectiveSelection(row:optimistic:)` — `FieldKit/FieldStateAdapter.swift:844`.

The **state** is all on `FieldStateAdapter`:

| field | line | note |
|---|---|---|
| `modelCatalogue: SyncConfigSnapshot` | `:722` | seeded `.empty`; a *snapshot*, refreshed on menu-open |
| `onRefreshModelCatalogue: () -> Void` | `:731` | |
| `modelChangeInFlight` / `effortChangeInFlight` | `:631` / `:736` | separate flags, deliberately |
| `onSetModel: (String?) -> Void` | `:641` | `nil` clears the override |
| `onSetEffort: (String?) -> Void` | `:740` | `nil` clears the override |
| `pendingModel` / `pendingEffort: OptimisticSelection` | `:745` / `:747` | the optimistic overlay (`enum` at `:831`) |
| `armProbation(model:effort:)` | `:775` | arms the auto-revert on a turn that fails naming the value |

And the **shell already wires every one of them** — `ShellSessionHost.wire(adapter:feed:)`:

* `onSetModel` → `ShellSessionHost.swift:1540-1551` → `client.setModel(sessionId:model:)` → refresh
  directory → clear `pendingModel` → `armProbation(model:)`;
* `onSetEffort` → `:1553-1564` → `client.setEffort(sessionId:effort:)` → same shape;
* `onRefreshModelCatalogue` → `:1566` → `refreshModelCatalogue()` (`:1595-1603`) →
  `client.syncConfig()` → `adapter.modelCatalogue = snapshot`.

Kit layer: `NormaClient.setModel` (`apple/NormaKit/.../NormaClient+Methods.swift:510`),
`setEffort` (`:529`), `syncConfig()` (`:1236` region, returning `SyncConfigSnapshot` at `:1168`).

**The Mac's failure story vs iOS's.** The Mac fires and forgets (no `FailureBanner` equivalent), but
it is not defenceless: `armProbation` (`FieldStateAdapter.swift:775`) watches the *next turn* and
auto-reverts the selection if the turn errors while naming the rejected value
(`selectionRevertAxis`, `:914`). That is a different, later, weaker guarantee than iOS's awaited
apply — worth naming in the plan, because moving the picker to the composer makes the silent no-op
more visible, not less.

### 1.4 Effort tiers — the real source of truth

Do not trust the memory note. The authority is `packages/core/src/settings.ts`:

* **Wire efforts** — `REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"]`
  (`settings.ts:29`). `"minimal"` is deliberately **absent** — the endpoint refuses it.
* **Norma-level tiers** — `CLIENT_EFFORTS = ["ultra"]` (`settings.ts:51`). Exactly one today.
  Strictly disjoint from the above. Translated by `CLIENT_EFFORT_WIRE` (`:58`) — `ultra → max` —
  plus a delegation posture in the prompt, at `AgentEngine.resolveSel`, before a request body exists.
* **Eligibility** — `clientEffortEligible(mode)` (`settings.ts:89`): `mode === undefined || mode ===
  "code"`. A fail-closed allowlist; a future mode gets no tiers for free.
* **Per model, not global** — the client never hard-codes the list. `sync.config` serves
  `models[].efforts` per slug plus `clientEfforts`
  (`NormaClient+Methods.swift:1131` `SyncConfigModelInfo`, `:1168` `SyncConfigSnapshot`).
* **Validation** — `assertEffortSelectable` (`packages/core/src/ipc/server.ts:476`) is shared
  verbatim by `session.setEffort` and `session.create`. A tier on a non-code session is refused with
  a sentence naming the mode. A wire effort outside `effortsForModel(model)` is refused, *unless*
  the provider cannot enumerate (`allowed.length > 0` gate — a BYOK endpoint is not bricked).

So the user-selectable set is: `Default` (clear) + up to six wire levels for the *selected model* +
`ultra`, code sessions only, and only when the wire list is non-empty.

**Two daemon-side refusals the composer wiring must reckon with:**

1. **Dispatch pins both axes.** `session.setModel` refuses a non-null model on a dispatch session
   (`ipc/server.ts:1560-1561`, `DISPATCH_PIN_MESSAGE`), and `session.setEffort` refuses a non-null
   effort likewise (`:1603-1604`). Only a `null` (clear) passes. **The Mac's existing
   `modelMenuIsVisible`/`effortMenuIsVisible` return `true` unconditionally**, so the header menus
   are *already* shown-and-refused on dispatch — and `ShellSessionView` renders on
   `DispatchSurface.swift:97`. Moving the control to the composer inherits this, more visibly.
2. **Chat is fine.** `session.setModel`'s own doc is explicit that there is no "fixed model" concept
   for any mode, chat included; `setEffort` is mode-agnostic apart from the tier gate. Chat is the
   shell's default session and the model/effort picker is legitimately live there. This is the
   **opposite** of the policy story in Gap 2.

### 1.5 The new-chat case — the subtle part

The new-chat page renders the same card **before any session exists**. `NewChatPage.body`
(`NewChatPage.swift:388`) talks to no client at all; the first Enter runs
`ShellSessionHost.sendFirstChatMessage` (`ShellSessionHost.swift:843`), which does:

```
guard newChatCreate != .creating            // one create, ever
capture epoch = newChatPageEpoch            // which page instance this belongs to
capture bound = newChatBoundSessionId       // panel-shell T15 reuse
→ if bound and panel.list(bound) succeeds → reuse it
  else client.createSession(scope: "global", approvalPolicy: "auto", mode: "chat")
→ newChatBoundSessionId = nil
→ pendingFirstMessages[sessionId] = trimmed   // parked BEFORE onCreated — do not reorder
→ newChatCreate = .idle
→ if epoch unchanged → onCreated(sessionId)   // NewChatPage.submit navigates
```

Delivery happens later, on that session's own attach (`deliverPendingFirstMessage`, `:904`).

**A model/effort choice made on this page therefore has to be held somewhere and applied at create.**
Three shapes, and the wire already supports the good one:

* **The daemon accepts both at create time.** `SessionCreateParams` carries `model`
  (`packages/protocol/src/methods.ts:133`) and `effort` (`:142`), validated by the *same* functions
  `session.setModel`/`session.setEffort` use (`resolveModelSelection` at `ipc/server.ts:510`,
  `assertEffortSelectable` at `:476`). The effort field's own comment says why it exists: the
  phone's New Chat sets model **and** effort at create time on a latency-critical path, and
  "two round-trips leave a window in which a turn fired immediately after create resolves at the
  GLOBAL effort, silently."
* **But `NormaKit` does not pass them.** `NormaClient.createSession`
  (`NormaClient+Methods.swift:303`) is
  `createSession(scope:cwd:approvalPolicy:mode:)` — no `model`, no `effort`. **This is the one kit
  change Gap 1 needs**, and it is additive (two optional params onto an existing `obj([...])`).
* The page would also need a catalogue to draw rows from. `ShellSessionHost.managementClient`
  (`ShellSessionHost.swift:221`) is a live `NormaClient` and `syncConfig()` is role-agnostic and
  takes no `sessionId`, so a `host`-owned snapshot is a one-call fetch — the same call
  `refreshModelCatalogue` already makes, just off the management client instead of the attachment's.

The pre-session state itself has an obvious home: `newChatDraft` / `newChatCreate` /
`newChatBoundSessionId` are already `@Published` on the host precisely because
`NewChatPage`'s `@State` does not survive `ShellRootView`'s `.maximized` teardown of `detail`
(`ShellSessionHost.swift:756-770`). A `newChatModel`/`newChatEffort` pair belongs in exactly that
group, cleared in `apply(destination:)`'s `.newChat` case alongside the others.

**One trap if this is built:** the T15 reuse branch does not create — it adopts an existing
`newChatBoundSessionId`. A create-time model would silently not apply on that branch. It would need
a `setModel`/`setEffort` follow-up on the reuse path, or the choice must be defined as
"applies to the session this send creates".

### 1.6 Surgery estimate — Gap 1

**Mechanical (a few hours, one file mostly):**

* Turn `NormaComposerCard.swift:207-215` into a `Button` in the `NewChatControlChip` idiom, opening a
  `.popover`.
* Give `NormaComposerCard` the inputs it needs. It currently takes no adapter. Two honest options:
  (a) pass `@ObservedObject var adapter: FieldStateAdapter?` — the adapter is already in scope at the
  live call site (`WindowContentView.swift:187` constructs the card with `adapter.draftBinding`); or
  (b) pass a small value struct + two closures, iOS-style, so the new-chat page can supply a
  pre-session variant. **(b) is the shape iOS proved and the only one that serves both homes.**
* Reuse `modelPickerOptions` / `effortPickerOptions` / `modelDisplayLabel` / `effortDisplayLabel` /
  `selectionIsCurrent` / `selectionOrigin` verbatim — they are free functions in
  `WindowContentView.swift`, already global-scope and already tested.
* Label: the iOS pill's `"<Model> <Effort>"`, from `modelDisplayLabel` + `effortDisplayLabel`
  against `effectiveSelection(row:optimistic:)`. Today the Mac shows the frozen string
  `"Default model"`; the honest live equivalent is `"Default"` when both are unset.

**Judgment (needs a ruling before code):**

* Does the composer chip **replace** the two header glyphs (`cpu` at `WindowContentView.swift:400`,
  `gauge...` at `:476`) or sit beside them? Two live doors to the same RPC on one screen is exactly
  the drift the shared-`policyPickerRow` precedent was created to avoid. Note the header glyphs
  render in **all three** of `WindowContentView`'s homes (shell, detached window, orb morph window) —
  only the shell opts into the composer card (`WindowContentView.swift:32` `composerCardMode`), so
  removing them outright would strip the affordance from the detached and orb windows.
* One popover with both axes (iOS's two-page sheet, flattened) or two popovers side by side?
* Dispatch: hide the chip, or leave it shown-and-refused as the header already is?
* The new-chat pre-session question — see "Needs your call".

**Not needed:** any daemon change, any protocol change, any new RPC, any new pure decision function.
The only non-app edit is the optional widening of `NormaClient.createSession`, and only if the
new-chat page is allowed to pick.

---

## Gap 2 — the permissions selector above the composer

### 2.1 Where the "cowork-style" presentation actually is

It is **on the Mac**, in `NormaComposerCard` itself — not on iOS. (Checked: `norma-ios/Norma` has
**no** `setPolicy`, no approval-policy picker, and no policy row anywhere near its composer. iOS has
no equivalent to describe.)

`NormaComposerCard.swift:176-198` — `coworkStrip`:

```swift
HStack(spacing: 10) {
    NewChatControlChip(systemImage: "folder",     title: "Project or folder",
                       label: "Working folder (not wired yet)")
    NewChatControlChip(systemImage: "hand.raised", title: "Ask",
                       label: "Approval mode (not wired yet)")
    Spacer(minLength: 12)
    …announcement…
}
.padding(.horizontal, 18)
.frame(height: newChatCoworkStripHeight)
```

That second chip — `hand.raised` / **"Ask"** / *"Approval mode (not wired yet)"* — **is** the thing
the user is pointing at. It is a placeholder, exactly like the model chip.

### 2.2 Exact anatomy of the strip (values, not adjectives)

Container — `stripSurface(band:)`, `NormaComposerCard.swift:152-174`:

| property | value | source |
|---|---|---|
| shape | `RoundedRectangle(cornerRadius: 18, style: .continuous)` | `newChatCardCornerRadius`, `NewChatPage.swift:102` |
| fill | `Theme.canvas` — **#F5F4F0** light / **#181816** dark | `Assets.xcassets/Canvas.colorset` |
| rim | `Theme.hairline.opacity(0.5)`, `lineWidth: 0.5` | `shellSidebarHairlineWidth`, `ShellSidebar.swift:671`; `Hairline` = #E5E2DC / #2A2A28 |
| total height | `newChatComposerHeight + band` = **124 + 40 = 164** | `NewChatPage.swift:107`, `:110` |
| visible band | **40 pt** (`newChatCoworkStripHeight`) | `NewChatPage.swift:110` |
| card width | **670 pt** (`newChatCardWidth`) | `NewChatPage.swift:101` |

The band is the *only* visible part: the strip is a full-height rounded rect **behind** an opaque
composer (`Theme.composerSurface` = **#F9F9F7** / **#272726**), so only its protruding edge and side
rims show. The composer keeps its own complete border on all four sides
(`NormaComposerCard.swift:119-133`) — that is what makes the strip read as a second surface rather
than as the card growing a section. Canvas-behind-composer-surface is a **4-value** separation in
light mode (0xF5F4F0 vs 0xF9F9F7): deliberately subtle. **This is the "litle row background" the
user means.**

Content:

* `HStack(spacing: 10)`, `.padding(.horizontal, 18)` — matched to the control row's own 18
  (`:219`) so the strip's first glyph lands on the same column as the composer's `+`.
* `NewChatControlChip` (`NewChatPage.swift:301-330`): glyph 13 pt `Theme.textMuted`; title **14 pt
  `.primary`** (explicitly *not* muted 11 pt — "these are CONTROLS you would click"); trailing
  `chevron.down` 9 pt semibold `Theme.textMuted`; `.padding(.horizontal, 8)`, `.frame(height: 26)`;
  `.buttonStyle(ShellSidebarRowStyle(isSelected: false))` → the pane's one hover treatment, a
  `RowHover`-filled rounded rect at `shellSidebarRowCornerRadius = 6` (`ShellSidebar.swift:735`,
  style at `:1367`).
* Motion: `band` animates 0→40 under the mode segment's `withAnimation(.easeInOut(duration: 0.24))`
  (`NormaComposerCard.swift:229`), and the row is pinned to the growing edge and `.clipped()`
  (`:163-171`) so it *travels out from underneath* rather than fading in place. The composer's own
  height never changes — a standing ruling.

**A rendered-appearance caveat I cannot resolve from code:** I have the tokens and the metrics, but
not the on-screen result. Whether a 4-value fill separation reads as a distinct row at 40 pt, and
how the 0.5 pt half-alpha rim actually renders on a Retina panel, are gate observations.

### 2.3 The direction — and the one thing that does not line up

The strip has two edges (`NormaComposerStripEdge`, `NormaComposerCard.swift:10-13`):

* `.below` — `ZStack(alignment: .top)`, band protrudes **below** the composer. Used by
  `NewChatPage.swift:509`.
* `.above` — `ZStack(alignment: .bottom)`, band protrudes **above** the composer. Used by
  `WindowContentView.swift:192` (the live session page, because "below" there is off-screen).

But the band's gate is `newChatShowsCoworkControls(mode:)`, which is **`mode == .cowork` only**
(`NewChatPage.swift:136`, pinned by `SidebarBrandTests.swift:320-323`). And a *live session* can
never be `.cowork`: `composerCardMode` is `SessionMode(wire: row.mode)`
(`ShellSessionHost.swift:1783`), the daemon's `mode` vocabulary is `code | dispatch | chat`
(`methods.ts:127`), and `SessionMode(wire:)` maps anything unknown to `.code`
(`ShellNavigation.swift:62`).

**Therefore: the `.above` variant renders nowhere today.** The only strip the user can have seen is
the new-chat page's, with the mode segment moved to Cowork — where it appears **below** the
composer, not above.

I am not going to guess which the user meant. Read it as: *"give the permissions selector the
cowork strip's treatment, and put it above the composer."* The `.above` machinery is already written
and already threaded through the live page — it has simply never had a reason to fire. Flipping the
gate is the whole mechanism.

### 2.4 The mode×surface matrix — the honest answer is "not in chat"

This is the constraint the user asked me to answer from the matrix rather than from taste.

`WorkSidebar.swift:216-225`:

```swift
if !adapter.isChatSession {
    VStack(alignment: .leading, spacing: 2) {
        ForEach(sessionPolicyModes, id: \.self) { policyPickerRow($0) }
    }
}
```

and the identical gate on the ⋯ button, `WindowContentView.swift:140-142`. The reason
(`FieldStateAdapter.swift:645-653`, and the comment at `WindowContentView.swift:134-139`):

> chat's approval policy is FIXED (core's `engine.ts` resolves it to the internal "chat" policy every
> turn regardless of the stored row, and `session.setPolicy` rejects ANY change for a chat target),
> so BOTH policy pickers are meaningless for chat and hidden while this is true — showing a picker
> whose every row would now come back as an RPC error is worse than no picker at all.

Confirmed daemon-side, twice over: the handler rejects **any** policy value for a chat target —
`"chat sessions have a fixed policy and cannot be changed — chat never asks permissions"`
(`ipc/server.ts:1518-1519`) — and the method is deliberately **off** `REMOTE_ALLOWED_METHODS`
because "chat's fixed policy has no remote-meaningful 'set' at all" (`ipc/server.ts:382-383`).

**So, per mode:**

| session mode | above-composer policy row? | why |
|---|---|---|
| **chat** | **No** | policy is immutable server-side; every row is an RPC error. This is the shell's default session and the mode the new-chat page creates. |
| **code** | **Yes** | the mode the picker was built for. |
| **dispatch** | **Yes, minus one row** | `session.setPolicy` refuses only `"plan"` for a dispatch target (`ipc/server.ts:1521-1522` — "dispatch never asks permissions"); the other five are settable. Note this is the **opposite** shape from model/effort, which dispatch pins entirely (§1.4). Neither picker filters `plan` out today, so a dispatch `Plan` row is already shown-and-refused in the ⋯ menu and the WorkSidebar. |
| **cowork** | N/A | no daemon mode exists; unreachable on a live session. |
| **new-chat page (pre-session)** | **No** | it creates `mode: "chat"` with `approvalPolicy: "auto"` hardcoded (`ShellSessionHost.swift:865`); the created session's policy is then immutable. |

**Flagging it as instructed: the shell's default session is chat, and chat is exactly where this row
must not appear.** Under the honest reading, the user will type into the shell's ordinary new chat
and see no permissions row at all. That is not a bug — it is the plan-immunity ruling working — but
it will look like the feature did not ship unless it is decided up front.

### 2.5 The data the row needs, and whether the shell has it

| need | where | status |
|---|---|---|
| current policy | `FieldStateAdapter.sessionPolicy` (`:612`) | **present, but see the trap below** |
| in-flight | `FieldStateAdapter.policyChangeInFlight` (`:618`) | present |
| setter | `FieldStateAdapter.onSetPolicy` (`:623`) | present, wired by the shell at `ShellSessionHost.swift:1531-1539` → `client.setPolicy` |
| the six modes | `sessionPolicyModes` (`WorkSidebar.swift:135`) | present, pinned by `PolicyMenuTests.swift:123` |
| labels | `policyDisplayLabel` (`:140`) | present — `Plan / Don't Ask / Ask / Accept Edits / Auto / Bypass` |
| danger styling | `isPolicyDangerous` (`:155`) → `"⚠ Bypass"` + `.red` (`:196`, `:203`) | present, pinned by `PolicyMenuTests.swift:129` |
| the row body | `policyPickerRow(_:)` (`:191`) | present — already shared by the ⋯ popover and the WorkSidebar |
| the chat gate | `adapter.isChatSession` (`:654`) | present; the shell derives it once at attach (`ShellSessionHost.swift:1108`) and reconciles on directory change (`:1449-1455`) |

`ShellSessionHost` already exposes everything: the card is constructed *inside* `WindowContentView`,
which holds the `adapter` directly. **Nothing needs threading through the host.**

**The trap — and it is the one real correctness problem in Gap 2.** `adapter.sessionPolicy` is
seeded `"auto"` and is **only ever written on a successful `onSetPolicy` round trip**. Its own doc
(`FieldStateAdapter.swift:601-611`) says why: neither `session.list` nor `session.attach` returns
`approvalPolicy`. I verified this against `SessionListResult`
(`packages/protocol/src/methods.ts:160-215`) — the row carries `cwd`, `dirs`, `origin`, `mode`,
`model`, `effort`, `forkedFrom`, `activity`, `archived`, and **no `approvalPolicy`**.

In an ephemeral popover a stale value is a minor honesty debt: you open it, you see a tick, you
change it. **In a persistent row it becomes a permanently-displayed claim.** A code session created
by the CLI at `ask`, opened in the shell, would show a standing "Auto" label — indefinitely, and
`bypass` would never be shown when it *is* in force. That inverts the danger styling's whole point.

Three ways out, in order of honesty:

1. **Add `approvalPolicy` to `SessionListResult`** and read it on the row like `model`/`effort`
   already are. Full protocol-checklist sweep (`packages/protocol` → `pnpm protocol:generate` →
   `apple/NormaProtocol` → `NormaKit`), but it is a *field* on an existing result, not a new variant.
   Per CLAUDE.md's own field-vs-variant warning, nothing fails to compile — the sweep must be done
   by meaning: `store.list()`'s producer, `NormaClient.listSessions()`'s decoder,
   `SessionSummary`.
2. **Render the row without a current-value claim** — a "Permissions" chip that opens the picker but
   shows no label until the user sets one this session. Honest, zero backend work, weaker product.
3. **Ship the stale label.** Not recommended: a row that silently lies about `bypass` is worse than
   no row.

### 2.6 Surgery estimate — Gap 2

**Build new, from an existing recipe.** No new pure decisions, no new RPC, no new picker body.

Mechanical:

* Generalize the strip's gate. Today `stripSurface`'s two conditions and the `band` computation all
  read `newChatShowsCoworkControls(mode:)` (`NormaComposerCard.swift:63`, `:154`). It needs to become
  a decision that also answers yes for a non-chat live session — as its **own named pure function**,
  next to `newChatShowsCoworkControls`, so it is testable and so the cowork pin
  (`SidebarBrandTests.swift:320-323`) keeps meaning what it says.
* Swap the placeholder chip for a real one: `NewChatControlChip`'s visual, wrapped in a `.popover`
  whose content is `ForEach(sessionPolicyModes) { policyPickerRow($0) }` — the *exact* body
  `policyMenuContent` already renders (`WindowContentView.swift:371-386`). Label = the current
  policy's `policyDisplayLabel`, red + `⚠` when `isPolicyDangerous`.
* `policyPickerRow` is `internal` on an `extension WindowContentView` (`WorkSidebar.swift:191`).
  `NormaComposerCard` is a *different type*, so the row body must either move to a free function /
  small struct, or the card must be handed a `@ViewBuilder`. **Moving it is the right call** — it is
  already documented as "one implementation for both surfaces" and this makes it three.

Judgment:

* The chat question (§2.4) — must be decided first.
* Whether the row shows *only* the policy chip, or the folder chip beside it becomes real too. The
  strip currently carries both; a working-folders menu already exists
  (`ChatContent/WorkingDirsMenu.swift`, gated on `dirsMenuIsVisible(row.dirs)` — the daemon's own
  participation answer, absent for chat/dispatch). Wiring both in one pass is natural; wiring only
  policy leaves a second dead chip immediately beside a live one.
* Whether the header's ⋯ policy button stays (same duplication question as Gap 1's `cpu` glyph, and
  the same "the ⋯ also serves the detached and orb windows" constraint).

---

## Needs your call

### Decision 1 — the new-chat page's model/effort (Gap 1)

The composer appears before a session exists. Pick one:

* **(A) No picker on the new-chat page.** The chip is live only on a live session; the new-chat card
  either omits it or renders it disabled with "picks the default; change it once the chat starts".
* **(B) Hold the choice and stamp it at create.** Add `newChatModel`/`newChatEffort` to
  `ShellSessionHost` beside `newChatDraft`, widen `NormaClient.createSession` with the `model`/
  `effort` the daemon already accepts, and pass them through `sendFirstChatMessage`.

**Recommendation: (B).** Three reasons and they are all evidence, not taste. The daemon *already*
takes both at create (`methods.ts:133`, `:142`) and validates them with the same functions
`setModel`/`setEffort` use. That field exists for exactly this reason: its own comment says the
create-then-set pair "leave[s] a window in which a turn fired immediately after create resolves at
the GLOBAL effort, silently" — and `sendFirstChatMessage` fires a turn the instant the session
exists, which is precisely that window. And the kit change is two optional params on one function.

The honest counterweight, which is why this is your call and not mine: **iOS does (A)** — its picker
is per-session and there is no pre-session variant anywhere in `norma-ios`. Choosing (B) means the
Mac leads here rather than mirrors.

If (B): decide whether the choice sticks as the *default for subsequent new chats* or resets each
time (the page already resets `newChatDraft` on every fresh `.newChat` arrival). And note the T15
reuse branch (§1.5) — a bound-session send does not create, so the choice needs a `setModel`
follow-up there or the semantics must be "applies to the session this send creates".

### Decision 2 — does the above-composer permissions row appear in chat? (Gap 2)

The matrix's honest answer is **no** — chat's policy is immutable server-side and every row would be
an RPC error. But chat is the shell's default and the only thing the new-chat page creates, so under
the honest answer the user's most common screen shows no row.

* **(A) Honest gate.** Row appears on code (and dispatch) sessions; chat shows the composer exactly
  as it does today. Matches `WorkSidebar.swift:221`, `WindowContentView.swift:140`, and
  plan-immunity as designed.
* **(B) Show it in chat as a fixed, non-interactive statement** — one chip reading e.g.
  "Permissions: Chat" with a tooltip explaining that a chat session never asks and never touches the
  machine. Not a picker; a disclosure.
* **(C) Show the picker in chat anyway.** Every row returns an RPC error. Ruled out by an existing
  design decision; listing it only so the trade-off is explicit.

**Recommendation: (A) now, (B) as a follow-up if the empty chat composer reads as broken at the
gate.** (A) is the only option consistent with a ruling that is already enforced in two places and
documented in four. (B) is defensible but it is a *new* product statement — chat has never claimed a
policy in the UI — and it should be decided on its own, not smuggled in as a side effect of moving a
picker.

**And whichever you pick, decide the stale-label problem (§2.5) with it.** A persistent row that
reads `sessionPolicy` as-is will show "Auto" for any session it did not itself change — including one
running `bypass`. My recommendation is option 1 there: add `approvalPolicy` to `SessionListResult`
and read it off the row like `model`/`effort`. It is a protocol *field*, not a variant, so nothing
breaks the build — which means the sweep must be done by meaning, per CLAUDE.md's own warning.

---

## Appendix — file:line index

**Mac composer**
- `apple/Norma/Sources/AppShell/NormaComposerCard.swift` — `:10` strip edge enum, `:63` band gate,
  `:152-174` `stripSurface`, `:176-198` `coworkStrip`, `:181` the "Ask" placeholder, `:202-221`
  control row, `:204` Attach placeholder, `:207-215` **the model placeholder**, `:216` Dictate
  placeholder, `:223-254` mode segment, `:256-283` send button
- `apple/Norma/Sources/AppShell/NewChatPage.swift` — `:71` mode options, `:101-128` all metrics,
  `:118` `newChatModelPlaceholder`, `:136` `newChatShowsCoworkControls`, `:147`
  `newChatSendBlockedReason`, `:280-298` `NewChatControlButton`, `:301-330` `NewChatControlChip`,
  `:503-515` the page's card, `:522-526` `submit`

**Mac model/effort machinery (all live)**
- `apple/Norma/Sources/ChatContent/WindowContentView.swift` — `:100-143` header row, `:125`/`:131`
  the visibility gates, `:346-386` policy ⋯, `:388-463` model menu, `:465-549` effort menu,
  `:724-834` the pure decisions
- `apple/Norma/Sources/FieldKit/FieldStateAdapter.swift` — `:612-623` policy state, `:631-641` model
  state, `:654` `isChatSession`, `:722-747` catalogue + optimistic overlay, `:775` `armProbation`,
  `:844` `effectiveSelection`, `:914` `selectionRevertAxis`
- `apple/Norma/Sources/AppShell/ShellSessionHost.swift` — `:221` `managementClient`, `:756-770`
  new-chat published state, `:843-902` `sendFirstChatMessage`, `:904-916`
  `deliverPendingFirstMessage`, `:1490-1573` `wire(adapter:feed:)`, `:1595-1603`
  `refreshModelCatalogue`, `:1745-1840` `ShellSessionView`
- `apple/NormaKit/Sources/NormaKit/NormaClient+Methods.swift` — `:303` `createSession` (**no
  model/effort**), `:510` `setModel`, `:529` `setEffort`, `:1131` `SyncConfigModelInfo`, `:1168`
  `SyncConfigSnapshot`, `:1239` `syncConfig()`
- `apple/Norma/Tests/NormaAppTests/ModelPickerTests.swift` — 33 pins on the pure decisions
- `apple/Norma/Tests/NormaAppTests/PolicyMenuTests.swift:123-140` — the six modes, danger flag, labels

**Mac policy machinery**
- `apple/Norma/Sources/ChatContent/WorkSidebar.swift` — `:135` `sessionPolicyModes`, `:140`
  `policyDisplayLabel`, `:155` `isPolicyDangerous`, `:191-208` `policyPickerRow`, `:210-228`
  the sidebar's Options block + `:221` the chat gate, `:288` `currentSidebarSessionSummary`

**iOS**
- `norma-ios/Norma/Code/ChatComposerView.swift:97-126` — the model pill; `:78-80` the sheet
- `norma-ios/Norma/Code/ModelPickerSheet.swift` — the two-page sheet; `:53` the no-catalogue gate;
  `:244` `FailureBanner`; `:266-312` `PickerRow`
- `norma-ios/Norma/Code/ModelPickerModel.swift` — `:225` the model, `:325-338` `offeredEfforts`,
  `:368-378` the pill labels, `:385-449` the awaited applies
- `norma-ios/Norma/Code/CodeSessionView.swift:85-100` — construction; `:144` the composer mount
- (no policy/approval-mode picker exists anywhere in `norma-ios`)

**Daemon**
- `packages/core/src/settings.ts` — `:29` `REASONING_EFFORTS`, `:51` `CLIENT_EFFORTS`, `:58`
  `CLIENT_EFFORT_WIRE`, `:75` `wireEffort`, `:89` `clientEffortEligible`
- `packages/core/src/ipc/server.ts` — `:382-383` why `setPolicy` is not remote, `:476`
  `assertEffortSelectable`, `:510` `resolveModelSelection`, `:1518-1519` chat policy refusal,
  `:1521-1522` dispatch `plan` refusal, `:1560` dispatch model pin, `:1603` dispatch effort pin
- `packages/protocol/src/methods.ts` — `:111-142` `SessionCreateParams` (incl. `model`/`effort`),
  `:127` the mode enum, `:160-215` `SessionListResult` (**no `approvalPolicy`**)
