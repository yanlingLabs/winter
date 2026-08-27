import SwiftUI
// mac-chat-parity T7: `SyncConfigSnapshot` — the daemon's model catalogue, which the model/effort
// chip's two lists are built from.
import NormaKit
// The composer morph (2026-08-12): `SessionEvent.Question` — what `ComposerQuestionBox` renders
// when the composer's slot is holding an ask instead of a draft.
import NormaProtocol

// MARK: - office-live-ux Job 1: stopping the turn from the composer

/// What a surface hands the composer so it can STOP a running turn — the direct counterpart of
/// `ComposerPolicyControl`/`ComposerModelControl`, one slot further out.
///
/// Deliberately a value carrying the LIVE flag and the action together, rather than two independent
/// parameters: the whole requirement is that the send/stop button and Esc agree about whether a turn
/// is up, and one value read twice in one render is the only shape where "agree" is not something a
/// test has to check.
///
/// `isRunning` is *not* cached anywhere. The one surface that wires this (`WindowContentView`
/// .composerCard`) fills it from `FieldStateAdapter.turnRunning`, which is a computed read of
/// `SessionModel.state.turnRunning` — and the adapter re-publishes the session's own
/// `objectWillChange` (`FieldStateAdapter.init`), so the card re-renders on the turn boundary.
struct ComposerStopControl {
    /// Whether the attached session has a turn running RIGHT NOW.
    let isRunning: Bool
    /// Interrupt it. Called by the stop button's click AND by Esc in the text field.
    let onStop: () -> Void
}

/// What the composer's trailing button IS at this instant. PURE, table-tested
/// (`ComposerStopButtonTests`), because the precedence below is a decision and not an accident.
enum ComposerSendButtonRole: Equatable {
    case send
    case stop
    /// Send is unavailable. The payload is `sendBlockedReason` verbatim — empty means
    /// "self-explanatory" (an empty draft).
    case blocked(String)
}

/// PURE: **running beats blocked.**
///
/// That ordering is the one real choice here and it is worth stating, because the obvious ordering
/// is wrong: today an empty draft renders the `waveform` placeholder, and an empty draft is the
/// ordinary state while you watch a turn run. Checking `sendBlockedReason` first would mean the stop
/// button appears only if you happen to have typed something — i.e. exactly never, in the case the
/// user asked for. So a running turn claims the slot regardless of the draft.
///
/// What that costs, stated rather than hidden: while a turn runs, the button no longer offers
/// *send*. Enter still does — `ShellSessionHost.submit(_:)` routes a submit during a running turn to
/// `session.steer`, and nothing in this change touches that path. The click affordance for steering
/// is what is traded for the stop affordance, which is what the requirement asked for.
func composerSendButtonRole(isRunning: Bool, sendBlockedReason: String?) -> ComposerSendButtonRole {
    if isRunning { return .stop }
    if let reason = sendBlockedReason { return .blocked(reason) }
    return .send
}

/// PURE: what Esc in the composer should do. `nil` means "not ours — hand it back to AppKit
/// untouched", which is the contract `CommandTextView.keyDown` implements by falling through to
/// `super`.
///
/// Separate from `composerSendButtonRole` in NAME only — both read the same `isRunning`, and
/// `ComposerStopButtonTests` pins that they agree on every input pair, which is the assertion the
/// requirement actually asks for.
func composerEscapeInterrupts(isRunning: Bool, canStop: Bool) -> Bool {
    isRunning && canStop
}

// MARK: - The shared composer shell

/// Which edge the per-mode strip emerges from.
///
/// The new-chat page's composer floats mid-page, so its strip slides DOWN from underneath. A live
/// session's composer sits at the BOTTOM of the window, where "below" is off-screen — so there the
/// strip slides UP from behind the composer's top edge instead. Same surface, same motion, mirrored.
///
/// A property of the HOME, not of the mode: both are set by the call site, and every mode's chrome
/// uses whichever edge the surface it is mounted on hands it.
enum NormaComposerStripEdge: Equatable {
    case below
    case above
}

/// PURE: which end of the composer the two surfaces are pinned to.
///
/// The strip surface is TALLER than the composer by exactly the band, and both sit in one `ZStack`,
/// so the alignment is what decides which end sticks out. `.below` anchors them at the TOP, leaving
/// the extra height protruding downward; `.above` anchors them at the BOTTOM, leaving it protruding
/// upward. Either way the composer's own height is untouched — the standing ruling.
///
/// Extracted from the `ZStack`'s inline ternary at Task 6, because that task is the first thing ever
/// to render `.above` (cowork was the only strip producer before it, and cowork is unreachable on a
/// live session) — the one direction with no live evidence behind it deserved a value a test can
/// read rather than an expression only the screen can check.
func composerStripStackAlignment(_ edge: NormaComposerStripEdge) -> Alignment {
    edge == .below ? .top : .bottom
}

/// PURE: where the strip's CONTENT sits on that surface — the growing edge, i.e. the band that
/// protrudes past the composer, never the part the opaque composer covers. The mirror of
/// `composerStripStackAlignment`: get the two out of step and the row renders behind the composer,
/// perfectly, invisibly.
func composerStripContentAlignment(_ edge: NormaComposerStripEdge) -> Alignment {
    edge == .below ? .bottom : .top
}

/// PURE: the strip surface's height — the composer, plus the band it protrudes by. Written down so
/// "the band grows, the composer does not" is a thing that can be asserted rather than only seen.
func composerStripSurfaceHeight(_ band: CGFloat) -> CGFloat {
    newChatComposerHeight + band
}

// MARK: - The model/effort chip (mac-chat-parity Task 7, spec §5)

/// What a surface hands the composer so its model/effort chip can BE a control rather than a
/// picture — the direct counterpart of `ComposerPolicyControl`, one slot out.
///
/// Two surfaces wire it and they are not alike, which is why this is a plain value rather than an
/// adapter: a LIVE session's (`WindowContentView.composerModelControl`) forwards to
/// `session.setModel`/`session.setEffort` through its adapter, while the NEW-CHAT PAGE's
/// (`ShellSessionHost.newChatModelControl`) has no session to set anything on and simply HOLDS the
/// choice until the create stamps it (spec §5's ruling). The chip cannot tell the two apart, and
/// should not: it offers a choice and reports it.
///
/// `onOpen` is the header's own "a snapshot, refreshed exactly when it is about to be read"
/// convention (`modelMenuButton`/`effortMenuButton` both call `onRefreshModelCatalogue` before
/// showing their popover), reproduced rather than reinvented.
struct ComposerModelControl {
    /// The model in force — the session's own (with its optimistic overlay) on a live session, the
    /// held pick pre-session. `nil` = no override, i.e. the daemon's live default.
    let model: String?
    /// The effort in force, on the same terms. May be a Norma-level TIER reported verbatim.
    let effort: String?
    /// The daemon's catalogue (`sync.config`). EMPTY is a real answer and never a licence to guess —
    /// see `modelPickerOptions`' own doc.
    let catalogue: SyncConfigSnapshot
    let modelChangeInFlight: Bool
    let effortChangeInFlight: Bool
    /// Fired as the menu is about to be read — refreshes the catalogue.
    let onOpen: () -> Void
    /// `nil` selects "Default" (clears the override).
    let onSetModel: (String?) -> Void
    let onSetEffort: (String?) -> Void
}

/// PURE: everything the model/effort chip shows and offers.
///
/// On a value rather than only inside the chip's `body` for this codebase's standing reason (SwiftUI
/// bodies are not exercised in tests here) and for one specific to this task: "chat's chip offers no
/// `ultra`" is the single claim that decides whether the new-chat page's create succeeds at all, and
/// it must be assertable without rendering anything.
struct ComposerModelRow: Equatable {
    let model: String?
    let effort: String?
    /// The model slugs on offer — the catalogue's, verbatim.
    let options: [String]
    /// The WIRE effort levels this model accepts. Model-scoped, never mode-scoped.
    let wire: [String]
    /// The NORMA-LEVEL tiers this mode may select — `["ultra"]` on code, EMPTY everywhere else.
    /// The one per-mode thing about this chip (`ComposerChrome.offersClientEffortTiers`).
    let tiers: [String]
    let modelChangeInFlight: Bool
    let effortChangeInFlight: Bool

    /// What the chip reads: the model in force, and the effort beside it once one is chosen.
    ///
    /// `newChatModelPlaceholder` while nothing is pinned — the exact text this slot has rendered
    /// since it was a placeholder, so an unpicked composer looks unchanged. Naming the effort only
    /// when it is set keeps the common case short while making a chosen effort visible somewhere on
    /// the page (before this task it was visible nowhere on the new-chat page at all).
    var chipTitle: String {
        let model = model ?? newChatModelPlaceholder
        guard let effort else { return model }
        return "\(model) · \(effort)"
    }

    /// The chip's hover line and accessibility label. Both axes, always named, including their
    /// "Default" readings — the tooltip is where "inherited from the daemon's default" can be said
    /// in full without crowding the row.
    var help: String {
        "Model: \(modelDisplayLabel(model)) · Reasoning effort: \(effortDisplayLabel(effort))"
    }
}

/// The model/effort chip and the menu behind it — the composer's door onto the machinery the
/// header's two buttons already drive (spec §8: "the composer chip is an additional door to the same
/// menus, not a replacement").
///
/// **One chip, both axes.** The header has room for two icon buttons; the composer's control row has
/// one slot, and it was always labelled "Model and effort". So the popover stacks the two shared
/// sections — `ModelMenuContent` over `EffortMenuContent`, the same rows the header renders.
///
/// Selecting a row DOES dismiss (unlike the permissions chip next door, whose in-flight state is only
/// visible with the menu open): these two axes are set-and-forget, and the chip itself shows the
/// result immediately.
struct ComposerModelChip: View {
    let row: ComposerModelRow
    let onOpen: () -> Void
    let onSetModel: (String?) -> Void
    let onSetEffort: (String?) -> Void

    /// Local presentational state, the convention every other picker on this screen follows.
    @State private var showingMenu = false

    var body: some View {
        Button {
            onOpen()
            showingMenu = true
        } label: {
            HStack(spacing: 4) {
                Text(row.chipTitle)
                    .font(Typography.body())
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(Typography.badge(.semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(row.help)
        .accessibilityLabel(row.help)
        .popover(isPresented: $showingMenu, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 2) {
                ModelMenuContent(options: row.options, current: row.model,
                                 isDisabled: row.modelChangeInFlight,
                                 onSelect: { onSetModel($0); showingMenu = false })
                Divider().opacity(0.5).padding(.vertical, 6)
                EffortMenuContent(wire: row.wire, tiers: row.tiers, current: row.effort,
                                  isDisabled: row.effortChangeInFlight,
                                  onSelect: { onSetEffort($0); showingMenu = false })
            }
            .padding(12)
            .frame(minWidth: 200)
        }
    }
}

/// The composer's **shared shell** — the parts every mode's composer has in common, and the mount
/// point for the parts it does not.
///
/// ## History, in two rulings
///
/// It was extracted (2026-08-07) rather than reimplemented, on the user's call that the live chat
/// page's composer "is basically non existent" and "should be the same as the one of the new chat
/// page" — the point being that two composers meant to be identical WILL drift if they are two
/// views, and the drift shows up as the live page quietly falling a pass behind.
///
/// mac-chat-parity Task 5 (2026-08-12) then split it per mode, on the user's ruling that *"each mode
/// should have its own dedicated composer which can also have different styling and maybe more
/// features"*. Those two rulings pull in opposite directions and this shape is how both are kept:
/// **the shared parts stay written once, here**, and the parts that differ live in one type per mode
/// (`ComposerChrome.swift`), which is also where the shape's reasoning is written down.
///
/// So this view knows nothing about modes. It holds the text field, the control row's fixed buttons,
/// the send button, the card's surface and hover rim, and the strip's mechanics; it asks
/// `composerChrome(_:)` for whatever the current mode adds, and draws that. There is deliberately no
/// mode conditional anywhere below — a source scan in `ComposerChromeTests` keeps it that way.
///
/// What it does NOT own: the suggestion chips and idea list below the new-chat card. Those belong
/// to an EMPTY page — there is nothing to suggest once a conversation is underway.
struct NormaComposerCard: View {
    @Binding var text: String
    var onSubmit: () -> Void

    /// The session's mode — **which composer this is**. `composerChrome(_:)` maps it to that mode's
    /// chrome; nothing here branches on it.
    ///
    /// A binding rather than a value because the new-chat page's Chat/Cowork segment writes back
    /// through it. On a live session it is `.constant`: a session's mode is fixed at creation.
    @Binding var mode: SessionMode
    /// Whether the mode segment can be CHANGED. False on a live session: a session's mode is fixed
    /// at creation and Norma has no mode-switch, so an interactive segment there would be a control
    /// that cannot do what it appears to offer.
    var modeIsSelectable: Bool = true

    /// The permissions row's wiring (mac-chat-parity Task 6, spec §4). `nil` from a surface with no
    /// session to set a policy on — the new-chat page.
    ///
    /// **`let`, and that keyword is the whole mechanism.** A surface that forgets the row must not
    /// compile: the miss Task 4's mutation run found on this plan ("the adapter method was pinned,
    /// its WIRING was not") looks exactly like a composer with no band, and every value-level test
    /// stays green through it.
    ///
    /// Writing no `= nil` is NOT enough to get that, which is the trap worth naming here: Swift
    /// gives an **optional `var`** an implicit `nil` in the synthesized memberwise initializer, so
    /// `var policy: ComposerPolicyControl?` is silently omittable at every call site. `let` is what
    /// makes it a required argument (`missing argument for parameter 'policy' in call`).
    /// `ComposerContext.policy` is `let` for the same reason — this outer boundary was the loose one.
    let policy: ComposerPolicyControl?

    /// The model/effort chip's wiring (mac-chat-parity Task 7, spec §5).
    ///
    /// **NOT an Optional**, which is a stronger requirement than `policy` above, because the two
    /// absences are different. A surface can genuinely have no session to set a POLICY on (the
    /// new-chat page), so that one is `nil`-able and its row is absent. Model and effort have no such
    /// case: every surface that draws this card can offer them, pre-session included — the choice is
    /// simply HELD there until the create stamps it. So there is nothing for `nil` to mean.
    ///
    /// **And the NON-OPTIONALITY is what makes it required, not the `let`** — compiled both ways
    /// before writing this, because the neighbouring claim on `policy` was once wrong in exactly the
    /// opposite direction. `var model: ComposerModelControl` with the argument dropped still fails
    /// ("missing argument for parameter 'model' in call"): Swift's synthesized memberwise initializer
    /// defaults a stored property only when it has an initial value, or when it is an **optional
    /// `var`** (the implicit `= nil` that made `policy` silently omittable until it became a `let`).
    /// `let` here is for immutability and consistency with `policy`; the requiredness is the type's.
    let model: ComposerModelControl

    var stripEdge: NormaComposerStripEdge = .below
    var placeholder: String = newChatComposerPlaceholder
    /// A trailing line for a mode whose chrome shows one — today only cowork's strip. Empty renders
    /// that strip's controls with nothing after them.
    var announcement: String = ""

    /// False while a create is in flight — swaps the live composer for a non-editable rendering of
    /// the same text. `.disabled()` is a no-op on the `NSViewRepresentable` composer (its
    /// `NSTextView` never reads the SwiftUI environment), so unmounting it is the only way keyboard
    /// input actually stops.
    var isEnabled: Bool = true
    var showsWorkingIndicator: Bool = false
    /// Why send is unavailable, or `nil` when it is. Empty string = blocked but self-explanatory
    /// (an empty draft); a non-empty string is shown on hover.
    var sendBlockedReason: String?

    /// office-live-ux Job 1 — **the stop affordance**, or `nil` for a surface that offers none.
    ///
    /// **ONE value feeds BOTH of Job 1's surfaces, and that is the point of it being one value.**
    /// The requirement is that the stop button and Esc "cannot disagree"; they cannot, because
    /// neither holds its own copy of anything — `sendButton` derives its role from `stop?.isRunning`
    /// and `composerBox` derives the Esc closure from the same optional, in the same render. There
    /// is no second flag to fall out of step with the first.
    ///
    /// `nil` is the gate, and it is what keeps the new-chat page (which builds this same card,
    /// `NewChatPage.swift:531-556`) untouched: no session there to stop, so no stop button and Esc
    /// keeps its AppKit meaning. Optional for the same reason `FieldStateAdapter.onSetActivity` is —
    /// a non-optional closure with a no-op default grows a button on every surface whose click does
    /// nothing.
    ///
    /// **`let`, deliberately, exactly like `policy` above** — an optional `var` gets an implicit
    /// `nil` in the synthesized memberwise initializer and is therefore silently omittable at every
    /// call site, and a silently-omitted stop button is invisible in every value-level test. `let`
    /// makes the compiler ask each surface the question.
    let stop: ComposerStopControl?

    @State private var isHovered = false

    /// The chrome THIS card renders, derived from its own inputs.
    ///
    /// Internal rather than private so the tests can drive it through the card's real initialiser —
    /// the one both call sites use. Pinning `composerChrome(_:)` alone would leave a card that
    /// ignored `mode` entirely, and always built one mode's chrome, completely green: the Task 4
    /// lesson recorded in this plan's ledger ("the method was pinned, its WIRING was not").
    var chrome: any ComposerChrome {
        composerChrome(ComposerContext(mode: $mode,
                                       modeIsSelectable: modeIsSelectable,
                                       policy: policy,
                                       announcement: announcement))
    }

    /// What the model/effort chip shows, for THIS card's control and THIS mode's tier answer.
    ///
    /// The whole path is one value — control → chrome's Bool → row — for the reason
    /// `WindowContentView.composerCard`'s own hoist exists: the claim that matters ("a chat composer
    /// offers no `ultra`") is then assertable without rendering, and a card that asked the catalogue
    /// directly instead of asking its chrome would red rather than pass quietly.
    var modelRow: ComposerModelRow {
        modelRow(offersTiers: chrome.offersClientEffortTiers)
    }

    private func modelRow(offersTiers: Bool) -> ComposerModelRow {
        let efforts = effortPickerOptions(catalogue: model.catalogue, model: model.model,
                                          offersTiers: offersTiers)
        return ComposerModelRow(model: model.model,
                                effort: model.effort,
                                options: modelPickerOptions(model.catalogue),
                                wire: efforts.wire,
                                tiers: efforts.tiers,
                                modelChangeInFlight: model.modelChangeInFlight,
                                effortChangeInFlight: model.effortChangeInFlight)
    }

    var body: some View {
        let chrome = self.chrome
        // How far the strip protrudes past the composer. Animating THIS is the whole effect: the
        // strip is a rounded rect sitting BEHIND the composer, and growing it slides its band out
        // from underneath. The composer's own height never changes (the standing ruling).
        //
        // A mode with no strip contributes nothing to draw and no band — an ABSENT block, not a
        // disabled one. That is how chat's missing permissions row is expressed (see
        // `ChatComposerChrome`).
        let strip = chrome.makeStrip()
        // The chip's two lists, decided ONCE per render off this mode's own tier answer — the only
        // per-mode thing about the chip, and the reason it can live unconditionally in the shared
        // shell (`ComposerChrome.offersClientEffortTiers`).
        let modelRow = self.modelRow(offersTiers: chrome.offersClientEffortTiers)

        ZStack(alignment: composerStripStackAlignment(stripEdge)) {
            stripSurface(strip)
            composerBox(accessory: chrome.makeControlRowAccessory(), modelRow: modelRow)
        }
        .frame(maxWidth: newChatCardWidth)
    }

    // MARK: - The composer proper

    private func composerBox(accessory: AnyView?, modelRow: ComposerModelRow) -> some View {
        VStack(spacing: 0) {
            Group {
                if isEnabled {
                    ComposerTextView(
                        text: $text,
                        onSubmit: onSubmit,
                        usesAdaptiveColors: true,
                        // office-live-ux Job 1 — Esc, derived from the SAME `stop` value the send
                        // button's role is derived from. `composerEscapeInterrupts` is checked
                        // rather than `stop != nil` alone so an idle session hands Esc back to
                        // AppKit untouched (`CommandTextView.keyDown`'s own contract).
                        onEscape: { [stop] in
                            guard composerEscapeInterrupts(isRunning: stop?.isRunning ?? false,
                                                           canStop: stop != nil) else { return false }
                            stop?.onStop()
                            return true
                        }
                    )
                    // The component has no placeholder parameter, so this is an overlay that steps
                    // aside the moment there is text. Non-hit-testing, or it would eat the click
                    // that focuses the field underneath it. Same size as the live text, or the
                    // words would change size the instant you type.
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text(placeholder)
                                .font(Typography.composerField())
                                .foregroundStyle(Theme.textMuted)
                                .padding(.horizontal, ComposerTextView.textContainerInset.width)
                                .padding(.vertical, ComposerTextView.textContainerInset.height)
                                .allowsHitTesting(false)
                        }
                    }
                } else {
                    // The held draft — same size and same top-leading start as the live composer,
                    // so the swap does not visibly jump; secondary colour is what reads as held.
                    Text(text)
                        .font(Typography.composerField())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, ComposerTextView.textContainerInset.width)
                        .padding(.vertical, ComposerTextView.textContainerInset.height)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .frame(height: 54)
            .padding(.horizontal, 16)
            .padding(.top, 20)

            controlRow(accessory: accessory, modelRow: modelRow)
        }
        .frame(height: newChatComposerHeight)
        // The composer keeps its OWN complete face and border — all four corners, always. That is
        // what makes the strip read as a second surface behind it rather than as this card growing
        // a section.
        .background(
            RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                .fill(Theme.composerSurface)
        )
        // The rim strengthens on hover; only the RIM moves, never the fill — a card that changed
        // colour under the pointer would read as selected rather than as ready.
        //
        // Hover, NOT focus: `ComposerTextView` exposes no first-responder callback, so "focused to
        // type" cannot be observed without giving that component one. Tracked, not faked.
        .overlay(
            RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                .strokeBorder(isHovered ? AnyShapeStyle(Color.primary.opacity(0.30))
                                        : AnyShapeStyle(Theme.hairline),
                              lineWidth: shellSidebarHairlineWidth)
        )
        .shadow(color: .black.opacity(0.05), radius: 16, y: 4)
        .animation(.easeOut(duration: 0.14), value: isHovered)
        .onHover { isHovered = $0 }
        .overlay(alignment: .bottomTrailing) {
            if showsWorkingIndicator {
                ProgressView()
                    .controlSize(.small)
                    .padding(10)
                    .accessibilityLabel("Starting")
            }
        }
    }

    // MARK: - The strip behind

    /// The second surface. It spans the composer's whole height PLUS the band, so only its far
    /// edge and side rims ever show — the opaque composer covers the rest. Its rim is fainter than
    /// the composer's: a surface behind should not trace itself as strongly as the thing in front.
    ///
    /// The surface exists only when the mode's chrome supplies a strip. Before Task 5 this was two
    /// conditions and an opacity gate reading the same cowork predicate three times; they collapse
    /// to one `if let` because all three were the same question — no behaviour changed, and a mode
    /// with no strip renders exactly the nothing it rendered before.
    @ViewBuilder
    private func stripSurface(_ strip: ComposerStrip?) -> some View {
        if let strip {
            RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                .fill(Theme.canvas)
                .overlay(
                    RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                        .strokeBorder(Theme.hairline.opacity(0.5),
                                      lineWidth: shellSidebarHairlineWidth)
                )
                .frame(height: composerStripSurfaceHeight(strip.height))
                .overlay(alignment: composerStripContentAlignment(stripEdge)) {
                    // Pinned to the GROWING edge, so the row sits in the band that protrudes rather
                    // than anywhere else on the surface, and clipped so it can never spill past it.
                    //
                    // Before Task 5 this was TWO frames — the content's natural height, then the
                    // band's — with the alignment on the outer one. They were always the same
                    // number: the band was `showsCowork ? 40 : 0` and the surface itself rendered
                    // only when that was 40, so a partial band has never existed. Collapsed to one;
                    // a mode that later wants a band that animates part-open restores the pair.
                    strip.content
                        .frame(height: strip.height)
                        .clipped()
                }
        }
    }

    // MARK: - The control row

    /// The control row. Attach, the mode's own accessory, the model/effort chip, Dictate and Send —
    /// the four fixed ones written once, here, for every mode.
    ///
    /// Attach and Dictate remain placeholders and remain labelled as such (spec §8). The model slot
    /// is REAL as of mac-chat-parity Task 7 (spec §5) — `ComposerModelChip`, opening the same rows
    /// the header's two menus render.
    ///
    /// **Where the model slot goes was not settled by "it is shared", and Task 5's own report was
    /// corrected on this by its review:** the single slot covers model AND effort, and effort's
    /// Norma-level tiers are gated to code sessions (`clientEffortEligible`, `settings.ts:89-91`,
    /// enforced by `assertEffortSelectable`, `ipc/server.ts:476-489`), so the slot's CONTENTS are
    /// mode-dependent even though the slot itself is not. Wiring it here unconditionally would ship
    /// an `ultra` row on chat that RPC-errors; filtering it here would drag a mode conditional back
    /// into the shared shell, and the source scan would not catch a helper-shaped one.
    ///
    /// Task 7 took the structural answer that leaves: a third `ComposerChrome` member, answered by
    /// each mode's own chrome, arriving here as a decided `ComposerModelRow`. The chip stays one chip
    /// written once, and this shell still knows nothing about modes.
    private func controlRow(accessory: AnyView?, modelRow: ComposerModelRow) -> some View {
        HStack(spacing: 8) {
            NewChatControlButton(systemImage: "plus", label: "Attach (not wired yet)", font: Typography.composerPlusGlyph)
            accessory
            Spacer(minLength: 12)
            ComposerModelChip(row: modelRow,
                              onOpen: model.onOpen,
                              onSetModel: model.onSetModel,
                              onSetEffort: model.onSetEffort)
            NewChatControlButton(systemImage: "mic", label: "Dictate (not wired yet)", font: Typography.bodyLarge(.medium))
            sendButton
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
    }

    /// office-live-ux Job 1: the trailing slot is now send / **stop** / blocked, decided by
    /// `composerSendButtonRole` — one pure function, so the precedence is assertable without
    /// rendering anything.
    var sendButtonRole: ComposerSendButtonRole {
        composerSendButtonRole(isRunning: stop?.isRunning ?? false,
                               sendBlockedReason: sendBlockedReason)
    }

    private var sendButton: some View {
        Group {
            switch sendButtonRole {
            case .send:
                Button(action: onSubmit) {
                    Image(systemName: "arrow.up")
                        .font(Typography.body(.semibold))
                        .foregroundStyle(Theme.canvas)
                        .frame(width: newChatSendButtonSize, height: newChatSendButtonSize)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Theme.accent)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Send")
                .accessibilityLabel("Send")
            case .stop:
                // The SAME footprint and the same filled slot as send — the button does not move or
                // resize when a turn starts, only its glyph and its verb change. `stop.fill` inside
                // the accent square is the macOS-native stop shape (`NormaFieldView`'s own "⏹
                // stopped" caption already speaks it) rather than a second, differently-coloured
                // control appearing beside the first.
                Button(action: { stop?.onStop() }) {
                    Image(systemName: "stop.fill")
                        .font(Typography.body(.semibold))
                        .foregroundStyle(Theme.canvas)
                        .frame(width: newChatSendButtonSize, height: newChatSendButtonSize)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Theme.accent)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Stop (Esc)")
                .accessibilityLabel("Stop")
            case .blocked(let reason):
                Image(systemName: "waveform")
                    .font(Typography.bodyLarge(.medium))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: newChatSendButtonSize, height: newChatSendButtonSize)
                    .help(reason.isEmpty ? "Type a message to send" : reason)
                    .accessibilityLabel(reason.isEmpty
                                        ? "Send — type a message first" : reason)
            }
        }
    }
}

// MARK: - The composer's other face (user call, 2026-08-12 — iOS's SP-ask-morph)

/// The pending question wearing the composer's own face — what the composer becomes while an ask is
/// waiting (iOS `QuestionComposerView`).
///
/// **The same fill as the composer** (user call): `Theme.composerSurface`, its rim, its shadow. The
/// morph reads as one surface changing shape only if the surface does not change colour on the way.
/// The RADIUS does grow, 18 → 24, which is iOS's own 22 → 28 relationship at this shell's scale: a
/// taller box wants a rounder corner, and it is the one thing about the box that says "this is not
/// the composer" while it is up.
struct ComposerQuestionBox: View {
    /// The composer's own hover behaviour, inherited on purpose (user call, 2026-08-13): only the
    /// RIM moves, never the fill. The box is standing in the composer's place, so it should answer
    /// the pointer the way the thing it replaced does — a surface that went inert under the cursor
    /// would read as disabled rather than as waiting.
    @State private var isHovered = false

    let callId: String
    let questions: [SessionEvent.Question]
    let childSessionId: String?
    let isInFlight: Bool
    let onQuestion: (String, [String: String], [String: String], String?) -> Void
    /// Hands the composer back and returns the ask to the transcript — see `PendingQuestionBody.onClose`.
    let onClose: () -> Void
    @Binding var draft: PendingCardDraft

    /// iOS's 28-on-a-22-composer, at this shell's 18.
    static let cornerRadius: CGFloat = 24

    var body: some View {
        PendingQuestionBody(
            callId: callId,
            questions: questions,
            childSessionId: childSessionId,
            isInFlight: isInFlight,
            onQuestion: onQuestion,
            onClose: onClose,
            draft: $draft
        )
        .padding(16)
        // THE COMPOSER'S OWN WIDTH, not the column's (user call, twice). The composer caps at
        // `newChatCardWidth` and centres; the box was taking `.infinity` and running the full width
        // of the detail column, so the morph changed the surface's SIZE as well as its shape — the
        // one thing that breaks the illusion of a single surface changing form. Same constant, so
        // the two cannot drift.
        .frame(maxWidth: newChatCardWidth)
        .background(
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .fill(Theme.composerSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .strokeBorder(isHovered ? AnyShapeStyle(Color.primary.opacity(0.30))
                                        : AnyShapeStyle(Theme.hairline),
                              lineWidth: shellSidebarHairlineWidth)
        )
        .shadow(color: .black.opacity(0.05), radius: 16, y: 4)
        .animation(.easeOut(duration: 0.14), value: isHovered)
        .onHover { isHovered = $0 }
        // Centring goes LAST, outside the face: applied before the background, it would have handed
        // the fill an infinite width to paint and the box would have been full-bleed with a cap
        // drawn only around its contents — the exact bug this change is fixing, one layer in.
        .frame(maxWidth: .infinity, alignment: .center)
    }
}
