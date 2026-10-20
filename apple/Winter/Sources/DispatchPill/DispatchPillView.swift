import AppKit
import SwiftUI
import WinterCUPresentation

/// The pill panel's root: the floating layers (child sessions, command runs, notices) stacked above
/// the main pill, bottom-aligned in a canvas exactly the panel's size. An ask waiting on the user is
/// not one of them: the main pill itself morphs into its card (`DispatchPillComposerBar`).
///
/// Rendered in the dark appearance whatever the system's is: the pill floats over arbitrary desktop
/// content like the Dynamic Island, and every token below resolves to its dark half (`CardSurface`
/// is near-black there, `TextPrimary` white).
struct DispatchPillView: View {
    /// The canvas's own coordinate space — the mouse gate's (y-down, origin top-left).
    static let canvasSpace = "dispatchPillCanvas"

    @ObservedObject var controller: DispatchPillController
    @ObservedObject var canvas: DispatchPillCanvasModel
    @ObservedObject var adapter: FieldStateAdapter
    /// Observed so the first command run mounts the floating stack (and the last one leaving unmounts it).
    @ObservedObject var commandRuns: CommandRunStore
    let morph: DispatchPillMorphModel

    init(controller: DispatchPillController) {
        self.controller = controller
        self.canvas = controller.canvas
        self.adapter = controller.adapter
        self.commandRuns = controller.commandRuns
        self.morph = controller.morph
    }

    private var hasAccessories: Bool {
        guard controller.presentation != .fullScreen else { return false }
        return !adapter.dispatchChildren.isEmpty
            || !commandRuns.runs.isEmpty
            || commandMenu != nil
            || controller.commandNotice != nil
            || adapter.compactionStartedAt != nil
            || controller.setAsideCardCount > 0
    }

    /// The `/` menu for what is typed (`DispatchPillController.currentMenu`).
    private var commandMenu: DispatchPillMenu? { controller.currentMenu }

    var body: some View {
        let accessories = hasAccessories
        VStack(spacing: DispatchPillMetrics.stackGap) {
            if accessories {
                DispatchPillAccessories(controller: controller, adapter: adapter, commandRuns: commandRuns, morph: morph,
                                        commandMenu: commandMenu)
                    .fixedSize(horizontal: false, vertical: true)
                    // Their own laid-out SIZE (a frame measured in the canvas would include the hover grow).
                    .onGeometryChange(for: CGSize.self) { proxy in
                        proxy.size
                    } action: { size in
                        controller.accessoryLayoutChanged(size: size)
                    }
                    // Cards and the child row rise out of the main pill, and sink back into it.
                    .transition(.childPill)
            }
            DispatchPillShell(morph: morph, tracksAnimatedWidth: controller.presentation != .fullScreen) {
                if controller.presentation == .fullScreen {
                    FullScreenPillView(controller: controller, adapter: adapter)
                } else {
                    DispatchPillComposerBar(controller: controller, adapter: adapter, commandMode: controller.commandMode)
                }
            }
        }
        // A slight grow under the pointer — the whole stack, anchored at the pill's bottom edge, so the floating
        // layers above move up and scale with it and stay aligned. By the compact pill's few POINTS whatever the
        // shape (`controller.hoverScale`, `HoverGrowth`): a card or the typing pill grows as much as the compact pill,
        // not 3 % of itself. Not in full screen.
        // The animation is scoped to the scale alone: a container-wide one would also ease the layout the morph
        // spring drives frame by frame.
        .animation(HoverGrowth.animation) { view in
            view.scaleEffect(controller.drawnHoverScale, anchor: .bottom)
        }
        .padding(DispatchPillMetrics.shadowPad)
        .frame(width: canvas.size.width, height: canvas.size.height, alignment: .bottom)
        .coordinateSpace(.named(Self.canvasSpace))
        .environment(\.colorScheme, .dark)
        .environment(\.dispatchPillPointer, controller.pointer)
        .onChange(of: accessories, initial: true) { _, present in
            if !present { controller.accessoryLayoutChanged(size: .zero) }
        }
    }
}

/// The main pill's shape: a black capsule at rest, a black rounded rect once it grows taller (the
/// corner radius follows the spring's CURRENT height). The only view that observes the 60Hz morph.
///
/// Content is laid out at the TARGET height, bottom-anchored, so a pill growing taller reveals its
/// upper lines as the shape rises and a shrinking one never squeezes its rows. Its WIDTH follows the
/// spring's current width when `tracksAnimatedWidth`: the send circle and ↗/⋯ then ride the shape's
/// edge as it widens or narrows, instead of jumping to where the edge will be once the spring
/// settles (laid out at the target width, they appeared — or vanished — ahead of the shape). The
/// text view inside has a fixed width (`composerFieldWidth`), so this re-layout never re-wraps it.
/// Full screen keeps the target width: re-wrapping a whole transcript 60 times a second is not free,
/// and revealing it reads fine.
///
/// While the shape changes, everything inside is blurred by how far the spring still has to travel
/// (`dispatchPillMorphBlur`), sharpening as it settles — so content never reads as snapping into
/// place ahead of, or behind, the shape around it.
struct DispatchPillShell<Content: View>: View {
    @ObservedObject var morph: DispatchPillMorphModel
    var tracksAnimatedWidth = true
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: dispatchPillCornerRadius(height: morph.size.height),
                                     style: .continuous)
        // A content swap (the pill ↔ a card): the old content fades out before the shape moves (`fade`), the new one
        // stays hidden while it grows and fades and sharpens in near its end (`reveal`). Outside a swap both are 1.
        let visibility = morph.fade * morph.reveal
        content
            .frame(width: tracksAnimatedWidth ? morph.size.width : morph.target.width,
                   height: morph.target.height)
            .frame(width: morph.size.width, height: morph.size.height, alignment: .bottom)
            .opacity(visibility)
            .blur(radius: max(dispatchPillMorphBlur(size: morph.size, target: morph.target),
                              dispatchPillContentBlur(visibility: visibility)))
            // Clipped to the morphing shape itself at every frame — nothing inside ever draws past its edge.
            .clipShape(shape)
            .background(shape.fill(Color.black))
            .overlay(shape.strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
            .compositingGroup()
            .shadow(color: .black.opacity(0.45), radius: 14, y: 4)
    }
}

/// What floats above the pill, top to bottom: the child-session row, the
/// commands run from the pill (`CommandPillsView`), a running compaction's clock, a command's notice, the cards the
/// user set aside by typing (`DispatchPillSetAsidePill`), and — right above the main pill — the `/` menu while a
/// command is being typed. Each layer is present only while it has something to show, and the stack
/// closes up around one that leaves, so the child sessions always stay on top. (`/permissions` floats
/// nothing: it turns the main pill itself into the picker.)
private struct DispatchPillAccessories: View {
    @ObservedObject var controller: DispatchPillController
    @ObservedObject var adapter: FieldStateAdapter
    @ObservedObject var commandRuns: CommandRunStore
    /// Observed so the child row follows the main pill's ANIMATED width frame by frame — it resizes
    /// with the pill as it grows or compresses, instead of snapping to where the pill is heading.
    @ObservedObject var morph: DispatchPillMorphModel
    let commandMenu: DispatchPillMenu?

    private var rowWidth: CGFloat { morph.size.width }

    var body: some View {
        VStack(spacing: DispatchPillMetrics.stackGap) {
            if !adapter.dispatchChildren.isEmpty {
                ChildSessionPillsView(
                    children: adapter.dispatchChildren,
                    rowWidth: rowWidth,
                    onOpen: { controller.onOpenChild?($0) },
                    onStop: { controller.onStopChild?($0) },
                    onOpenOverflow: { controller.onOpenInApp?() },
                    childSession: { controller.childSession($0) },
                    palette: { controller.childPalette(for: $0) }
                )
                .transition(.childPill)
            }
            if !commandRuns.runs.isEmpty {
                CommandPillsView(store: commandRuns, rowWidth: rowWidth)
                    .transition(.childPill)
            }
            if let startedAt = adapter.compactionStartedAt {
                DispatchPillCompactionPill(startedAtMs: startedAt, width: rowWidth)
                    .transition(.childPill)
            }
            if let notice = controller.commandNotice {
                DispatchPillNoticePill(text: notice)
                    .transition(.childPill)
            }
            if controller.setAsideCardCount > 0 {
                DispatchPillSetAsidePill(count: controller.setAsideCardCount) { controller.bringBackCards() }
                    .transition(.childPill)
            }
            if let commandMenu {
                DispatchPillMenuView(menu: commandMenu, selected: controller.menuSelection, width: rowWidth,
                                     onPick: { controller.runMenuItem($0) })
                    .transition(.childPill)
            }
        }
        .animation(childRowSpring, value: adapter.compactionStartedAt != nil)
        .animation(childRowSpring, value: controller.setAsideCardCount > 0)
    }
}

/// The compact AND expanded pill — ONE view, so the `ComposerTextView` inside keeps its identity
/// (its `NSTextView`, its caret, its first-responder status) when the first keystroke grows the pill.
/// Swapping a `CompactPillView` for an `ExpandedPillView` here would rebuild the text view mid-word.
/// The state-specific pieces live in those files: `CompactPillWorking` and `PillSendStopButton`
/// (`CompactPillView.swift`), `ExpandedPillAccessoryButtons` and `ExpandedPillTurnPreview`
/// (`ExpandedPillView.swift`).
///
/// WORKING (compact while a turn runs) shows no composer: the plume fills the pill, streaming out
/// from behind the stop button. The text view stays mounted underneath, invisible and untouchable,
/// so a keystroke still lands in it — the first one opens the typing pill — and a click on the plume
/// opens it too (`openComposer`), for a steer.
struct DispatchPillComposerBar: View {
    @ObservedObject var controller: DispatchPillController
    @ObservedObject var adapter: FieldStateAdapter
    /// Command mode: the draft in purple, its ghost completion, Delete's opt-out, the send circle's run look.
    @ObservedObject var commandMode: DispatchPillCommandMode
    /// The plume is up: it starts once the working look is wanted AND the shape has stopped moving
    /// (`DispatchPillController.shapeSharp`), then stays for as long as the look is wanted — the shape blurring again
    /// while the pill is still working does not take it down. It goes the moment the look does (the typing pill, a
    /// card, the picker, the turn's end), and the next start waits for the shape again.
    @State private var plumeUp = false

    var body: some View {
        let expanded = controller.presentation == .expanded
        // The session's turn, or a sent message's turn on its way (`awaitingTurnStart`): Enter goes from the typing
        // pill straight to the working one, never through the idle pill.
        let running = controller.showsTurnRunning
        let draft = adapter.composerDraft
        // An ask waiting on the user: the pill IS its card (`DispatchPillCardQueue`).
        let card = controller.cardShowsOnPill ? controller.frontCard : nil
        let look = dispatchPillBarLook(expanded: expanded, running: running, draft: draft, cardShown: card != nil,
                                       verbText: adapter.verbText)
        let working = look.working
        let preview = expanded && card == nil ? controller.turnPreview : nil
        let picker = controller.permissionsPickerOpen && card == nil
        let covered = preview != nil || picker || card != nil
        let showsAccessories = expanded && !covered
            && dispatchPillAccessoryButtonsVisible(draft: draft, textWidth: dispatchPillDraftTextWidth(draft))
        let plumeGate = DispatchPillPlumeGate(wanted: working && !picker, shapeSharp: controller.shapeSharp)
        ZStack(alignment: .top) {
            composerRow(draft: draft, expanded: expanded, running: running, working: working && !picker,
                        showsPlume: working && !picker && (plumeUp || plumeGate.startsPlume),
                        placeholder: look.placeholder,
                        hidesComposer: working || covered || controller.contentFadingOut,
                        showsAccessories: showsAccessories)
                .animation(.easeOut(duration: 0.2)) { $0.opacity(covered ? 0 : 1) }
                .allowsHitTesting(!covered)
            // `/permissions`: the pill IS the picker — the composer stays mounted underneath, hidden, and
            // comes back on × or Esc.
            if picker {
                DispatchPillPermissionsRow(
                    modes: dispatchSettablePolicyModes,
                    current: adapter.sessionPolicyKnown ? adapter.sessionPolicy : nil,
                    pending: controller.policyPending,
                    refusal: adapter.policyRefusal,
                    focused: controller.pickerFocus,
                    onPick: { controller.choosePolicy($0) },
                    onClose: { controller.closePermissionsPicker() }
                )
                .transition(.opacity.animation(.easeOut(duration: 0.2)))
            }
            // A pinned turn shows ALONE — no composer. The composer stays mounted underneath,
            // invisible, so typing still lands in it (and the first keystroke leaves the turn).
            if let preview {
                ExpandedPillTurnPreview(preview: preview, scrolls: controller.previewReplyScrolls,
                                        onReplyHeight: { controller.previewReplyLaidOut(preview.reply, height: $0) })
                    .contentShape(Rectangle())
                    .onTapGesture { controller.exitPreview() }
                    .transition(.opacity.animation(.easeOut(duration: 0.2)))
            }
            // The card: laid out at its TARGET width (fixed while the shell springs — no re-wrap, no re-measure mid-
            // morph) and at its own height, which it reports so the shell grows to exactly it. The composer stays
            // mounted underneath, hidden, so a keystroke still lands in it (and sets the card aside). Its spring, rim,
            // shadow, clip and its fade in and out are the shell's (`DispatchPillShell`: the content swap) — nothing
            // here animates.
            if let card {
                let records = controller.pendingCardRecords
                DispatchPillCardView(record: card,
                                     wiring: dispatchPillCardWiring(adapter: adapter, records: records),
                                     header: controller.cardHeader(for: card),
                                     waiting: controller.cardQueue.waiting,
                                     bodyCap: controller.cardBodyCap)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: controller.cardLayoutWidth)
                    .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.height } action: { height in
                        controller.cardContentHeightChanged(height)
                    }
                    .id(card.callId)
                    // Fading out ahead of a swap (answered, or leaving): no second click lands on it.
                    .allowsHitTesting(!controller.contentFadingOut)
            }
        }
        .onChange(of: plumeGate, initial: true) { _, gate in
            if !gate.wanted {
                plumeUp = false
            } else if gate.startsPlume {
                plumeUp = true
            }
        }
    }

    private func composerRow(draft: String, expanded: Bool, running: Bool, working: Bool, showsPlume: Bool,
                             placeholder: String?,
                             hidesComposer: Bool, showsAccessories: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: DispatchPillMetrics.rowSpacing) {
                // Animations here are SCOPED (the body form, transitions carrying their own), never
                // `.animation(_:value:)` on a container: that would also ease the container's layout,
                // which the spring already drives frame by frame — the two would fight.
                field(draft: draft, expanded: expanded, placeholder: placeholder, hidden: hidesComposer,
                      showsAccessories: showsAccessories)
                    .animation(.easeOut(duration: 0.25)) { $0.opacity(working ? 0 : 1) }
                    .allowsHitTesting(!working)
                PillSendStopButton(
                    isRunning: running,
                    canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    runsCommand: commandMode.displaysCommand(draft),
                    onSend: { controller.submit(adapter.composerDraft) },
                    onStop: { controller.interrupt() }
                )
                .padding(.bottom, DispatchPillMetrics.sendBottomInset)
            }
            .padding(.leading, DispatchPillMetrics.leadingPadding)
            .padding(.trailing, DispatchPillMetrics.trailingPadding)
            .frame(maxHeight: .infinity)
            // Under the row, so the stop button sits on the plume's nozzle.
            // Laid out at the shape's TARGET width, its trailing end (the nozzle) on the stop button: a spring that runs
            // under a plume already up never lays it out again frame by frame.
            .background(alignment: .bottomTrailing) {
                if showsPlume {
                    CompactPillWorking(thrown: controller.plumeThrows, repeating: controller.plumeRepeatingThrows)
                        .frame(width: controller.plumeLayoutWidth, height: DispatchPillMetrics.pillHeight)
                        .contentShape(Rectangle())
                        .onTapGesture { controller.openComposer() }
                        .transition(.opacity.animation(.easeOut(duration: 0.25)))
                }
            }
        }
    }

    /// The text field, at a FIXED width (`composerFieldWidth`) in a flexible, clipped slot — the slot
    /// follows the animated shape, the text inside never re-wraps mid-animation. ↗ and ⋯ float over
    /// its trailing end, outside the clip so their blur is not cut off.
    private func field(draft: String, expanded: Bool, placeholder: String?, hidden: Bool,
                       showsAccessories: Bool) -> some View {
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottomLeading) {
                ZStack(alignment: .topLeading) {
                    if let placeholder {
                        Text(placeholder)
                            .font(Typography.composerField())
                            .foregroundStyle(expanded ? Color.white.opacity(0.5) : Theme.textPlaceholder)
                            .lineLimit(1)
                            .padding(.leading, ComposerTextView.textContainerInset.width)
                            .padding(.top, ComposerTextView.textContainerInset.height)
                            .allowsHitTesting(false)
                    }
                    ComposerTextView(
                        text: adapter.draftBinding,
                        onSubmit: { controller.submit(adapter.composerDraft) },
                        onContentHeightChange: { controller.composerContentHeightChanged($0) },
                        usesAdaptiveColors: true,
                        tintOverride: .white,
                        onViewCreated: { controller.registerComposerView($0) },
                        viewAlpha: hidden ? 0 : 1,
                        // Under a card the composer never holds the keyboard: a Return meant for the card must not
                        // reach (and send) a draft hidden underneath.
                        takesFocus: !controller.composerKeyboardBlocked,
                        onFocusKey: { key, _, _ in controller.handleMenuKey(key) },
                        // A shell line the pill will RUN reads in purple, whole; a `/` command typed in full in blue.
                        highlightRanges: { [commandMode] text in
                            if commandMode.displaysCommand(text) { return [NSRange(location: 0, length: (text as NSString).length)] }
                            return dispatchPillCommandHighlightRange(text).map { [$0] } ?? []
                        },
                        highlightColor: dispatchPillCommandBlueNS,
                        highlightColorForText: { [commandMode] text in
                            commandMode.displaysCommand(text) ? dispatchPillCommandPurpleNS : dispatchPillCommandBlueNS
                        },
                        ghostSuffix: commandMode.ghostDisplay(for: draft),
                        onTab: { [commandMode] text in commandMode.tab(text: text) },
                        onBackTab: { [commandMode] text in commandMode.backTab(text: text) },
                        onAcceptGhost: { [commandMode] text, word in commandMode.acceptGhost(text: text, word: word) },
                        onNonTabKey: { [commandMode] in commandMode.endCycle() },
                        onDeleteBackwardAtEnd: { controller.handleDeleteBackwardAtEnd() },
                        onHorizontalKey: { controller.handleHorizontalKey(left: $0) },
                        // Image and file attachments (2026-10-19): a pasted or dropped screenshot or file is a chip in
                        // the text, as in a code window — live while the bound session is code or dispatch.
                        imageIntake: adapter.composerImageIntake
                    )
                }
                .frame(width: controller.composerFieldWidth, height: controller.composerFieldHeight)
                .padding(.bottom, DispatchPillMetrics.fieldBottomInset)
            }
            .clipped()
            .overlay(alignment: .bottomTrailing) {
                if expanded {
                    ExpandedPillAccessoryButtons(
                        onFullScreen: { controller.requestFullScreen() },
                        onOpenInApp: { controller.onOpenInApp?() },
                        onClearDraft: { controller.clearDraft() },
                        onPopoverChange: { controller.auxiliaryPopoverOpen = $0 }
                    )
                    .animation(.easeOut(duration: 0.22)) { view in
                        view.opacity(showsAccessories ? 1 : 0)
                            .blur(radius: showsAccessories ? 0 : 6)
                            .scaleEffect(showsAccessories ? 1 : 0.9)
                    }
                    .allowsHitTesting(showsAccessories)
                    .padding(.bottom, DispatchPillMetrics.sendBottomInset
                        + (DispatchPillMetrics.sendCircleSize - DispatchPillMetrics.accessoryButtonSize) / 2)
                    .transition(.opacity.animation(.easeOut(duration: 0.2)))
                }
            }
    }
}

/// When the working plume may start: the look wants it and the shape is no longer moving (`shapeSharp`). Once
/// started it stays while `wanted` holds (`DispatchPillComposerBar.plumeUp`).
struct DispatchPillPlumeGate: Equatable {
    let wanted: Bool
    let shapeSharp: Bool
    var startsPlume: Bool { wanted && shapeSharp }
}

/// What the pill's bar shows, as one value: the working look (the plume, the composer hidden), the trailing circle's
/// role, and the placeholder line (nil: none drawn).
struct DispatchPillBarLook: Equatable {
    let working: Bool
    let circle: ComposerSendButtonRole
    let placeholder: String?
}

/// PURE: the bar's look. `running` is `DispatchPillController.showsTurnRunning` — the session's turn, or a sent
/// message's turn on its way — so Enter goes from the typing pill straight to the working one. No placeholder under
/// the plume: the field is fading out there, and one popping in at full strength (the cleared draft's) and changing
/// words as the turn starts read as flashes (user, 2026-10-20).
func dispatchPillBarLook(expanded: Bool, running: Bool, draft: String, cardShown: Bool,
                         verbText: String) -> DispatchPillBarLook {
    let working = !expanded && running && !cardShown
    let canSend = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let placeholder: String? = draft.isEmpty && !working ? (running ? verbText : "Type here") : nil
    return DispatchPillBarLook(working: working,
                               circle: composerSendButtonRole(isRunning: running, sendBlockedReason: canSend ? nil : ""),
                               placeholder: placeholder)
}

/// A pinned turn's height for `reply`, laid out whole at the preview's text width and the composer's own face (the
/// size every line of the turn is drawn at), up to `ceiling`. `measuredReplyHeight` is the reply's own laid-out height
/// once the view has reported it (`DispatchPillController.previewReplyLaidOut`); until then it is measured here.
func dispatchPillPreviewHeight(reply: String, ceiling: CGFloat, measuredReplyHeight: CGFloat? = nil) -> CGFloat {
    let font = Typography.sansNS(ofSize: Typography.composerFieldSize)
    return dispatchPillPreviewHeight(replyHeight: measuredReplyHeight ?? dispatchPillPreviewReplyHeight(reply),
                                     lineHeight: ceil(NSLayoutManager().defaultLineHeight(for: font)),
                                     ceiling: ceiling)
}

/// The reply's height laid out at `previewTextWidth` in the composer's face — every line, wrapped.
func dispatchPillPreviewReplyHeight(_ reply: String) -> CGFloat {
    let font = Typography.sansNS(ofSize: Typography.composerFieldSize)
    let storage = NSTextStorage(string: reply.isEmpty ? " " : reply, attributes: [.font: font])
    let layout = NSLayoutManager()
    let container = NSTextContainer(size: CGSize(width: DispatchPillMetrics.previewTextWidth,
                                                 height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    layout.addTextContainer(container)
    storage.addLayoutManager(layout)
    layout.ensureLayout(for: container)
    return ceil(layout.usedRect(for: container).height)
}

/// The draft's single-line width at the composer's own face — what `dispatchPillAccessoryButtonsVisible`
/// compares against the field's width beside ↗ and ⋯.
func dispatchPillDraftTextWidth(_ draft: String) -> CGFloat {
    guard !draft.isEmpty else { return 0 }
    let font = Typography.sansNS(ofSize: Typography.composerFieldSize)
    return ceil((draft as NSString).size(withAttributes: [.font: font]).width)
}
