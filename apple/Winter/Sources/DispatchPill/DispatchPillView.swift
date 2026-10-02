import AppKit
import SwiftUI

/// The pill panel's root: the floating layers (asks waiting on the user, then child sessions)
/// stacked above the main pill, bottom-aligned in a canvas exactly the panel's size.
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
    let morph: DispatchPillMorphModel

    init(controller: DispatchPillController) {
        self.controller = controller
        self.canvas = controller.canvas
        self.adapter = controller.adapter
        self.morph = controller.morph
    }

    private var hasAccessories: Bool {
        guard controller.presentation != .fullScreen else { return false }
        return !adapter.dispatchChildren.isEmpty
            || !pendingInteractionRecords(in: adapter.transcript, live: adapter.pendingInteractions,
                                          inactive: adapter.inactiveElicitations).isEmpty
    }

    var body: some View {
        let accessories = hasAccessories
        VStack(spacing: DispatchPillMetrics.stackGap) {
            if accessories {
                DispatchPillAccessories(controller: controller, adapter: adapter, morph: morph)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGRect.self) { proxy in
                        proxy.frame(in: .named(Self.canvasSpace))
                    } action: { frame in
                        controller.accessoryLayoutChanged(frame: frame)
                    }
                    // Cards and the child row rise out of the main pill, and sink back into it.
                    .transition(.childPill)
            }
            DispatchPillShell(morph: morph, tracksAnimatedWidth: controller.presentation != .fullScreen) {
                if controller.presentation == .fullScreen {
                    FullScreenPillView(controller: controller, adapter: adapter)
                } else {
                    DispatchPillComposerBar(controller: controller, adapter: adapter)
                }
            }
        }
        .padding(DispatchPillMetrics.shadowPad)
        .frame(width: canvas.size.width, height: canvas.size.height, alignment: .bottom)
        .coordinateSpace(.named(Self.canvasSpace))
        .environment(\.colorScheme, .dark)
        .onChange(of: accessories, initial: true) { _, present in
            if !present { controller.accessoryLayoutChanged(frame: .zero) }
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
        content
            .frame(width: tracksAnimatedWidth ? morph.size.width : morph.target.width,
                   height: morph.target.height)
            .frame(width: morph.size.width, height: morph.size.height, alignment: .bottom)
            .blur(radius: dispatchPillMorphBlur(size: morph.size, target: morph.target))
            .clipShape(shape)
            .background(shape.fill(Color.black))
            .overlay(shape.strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
            .compositingGroup()
            .shadow(color: .black.opacity(0.45), radius: 14, y: 4)
    }
}

/// What floats above the pill: the asks waiting on the user, then the child-session row.
private struct DispatchPillAccessories: View {
    @ObservedObject var controller: DispatchPillController
    @ObservedObject var adapter: FieldStateAdapter
    /// Observed so the child row follows the main pill's ANIMATED width frame by frame — it resizes
    /// with the pill as it grows or compresses, instead of snapping to where the pill is heading.
    @ObservedObject var morph: DispatchPillMorphModel

    private var rowWidth: CGFloat { morph.size.width }

    var body: some View {
        VStack(spacing: DispatchPillMetrics.stackGap) {
            ApprovalCardOverlay(adapter: adapter,
                                width: max(rowWidth, DispatchPillMetrics.cardWidth))
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
        }
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

    var body: some View {
        let expanded = controller.presentation == .expanded
        let running = adapter.turnRunning
        let draft = adapter.composerDraft
        let working = !expanded && running
        let preview = expanded ? controller.turnPreview : nil
        let showsAccessories = expanded && preview == nil
            && dispatchPillAccessoryButtonsVisible(draft: draft, textWidth: dispatchPillDraftTextWidth(draft))
        ZStack(alignment: .top) {
            composerRow(draft: draft, expanded: expanded, running: running, working: working,
                        hidesComposer: working || preview != nil, showsAccessories: showsAccessories)
                .animation(.easeOut(duration: 0.2)) { $0.opacity(preview == nil ? 1 : 0) }
                .allowsHitTesting(preview == nil)
            // A pinned turn shows ALONE — no composer. The composer stays mounted underneath,
            // invisible, so typing still lands in it (and the first keystroke leaves the turn).
            if let preview {
                ExpandedPillTurnPreview(preview: preview)
                    .contentShape(Rectangle())
                    .onTapGesture { controller.exitPreview() }
                    .transition(.opacity.animation(.easeOut(duration: 0.2)))
            }
        }
    }

    private func composerRow(draft: String, expanded: Bool, running: Bool, working: Bool,
                             hidesComposer: Bool, showsAccessories: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: DispatchPillMetrics.rowSpacing) {
                // Animations here are SCOPED (the body form, transitions carrying their own), never
                // `.animation(_:value:)` on a container: that would also ease the container's layout,
                // which the spring already drives frame by frame — the two would fight.
                field(draft: draft, expanded: expanded, running: running, hidden: hidesComposer,
                      showsAccessories: showsAccessories)
                    .animation(.easeOut(duration: 0.25)) { $0.opacity(working ? 0 : 1) }
                    .allowsHitTesting(!working)
                PillSendStopButton(
                    isRunning: running,
                    canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    onSend: { controller.submit(adapter.composerDraft) },
                    onStop: { controller.interrupt() }
                )
                .padding(.bottom, DispatchPillMetrics.sendBottomInset)
            }
            .padding(.leading, DispatchPillMetrics.leadingPadding)
            .padding(.trailing, DispatchPillMetrics.trailingPadding)
            .frame(maxHeight: .infinity)
            // Under the row, so the stop button sits on the plume's nozzle.
            .background(alignment: .bottom) {
                if working {
                    CompactPillWorking(thrown: controller.plumeThrows, repeating: controller.plumeRepeatingThrows)
                        .frame(height: DispatchPillMetrics.pillHeight)
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
    private func field(draft: String, expanded: Bool, running: Bool, hidden: Bool,
                       showsAccessories: Bool) -> some View {
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottomLeading) {
                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(running ? adapter.verbText : "Type here")
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
                        viewAlpha: hidden ? 0 : 1
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

/// A pinned turn's height for `reply`, measured at the composer's own face (the size every line of
/// the turn is drawn at).
func dispatchPillPreviewHeight(reply: String) -> CGFloat {
    let font = Typography.sansNS(ofSize: Typography.composerFieldSize)
    let width = ceil((reply as NSString).size(withAttributes: [.font: font]).width)
    return dispatchPillPreviewHeight(replyWidth: width,
                                     lineHeight: ceil(NSLayoutManager().defaultLineHeight(for: font)))
}

/// The draft's single-line width at the composer's own face — what `dispatchPillAccessoryButtonsVisible`
/// compares against the field's width beside ↗ and ⋯.
func dispatchPillDraftTextWidth(_ draft: String) -> CGFloat {
    guard !draft.isEmpty else { return 0 }
    let font = Typography.sansNS(ofSize: Typography.composerFieldSize)
    return ceil((draft as NSString).size(withAttributes: [.font: font]).width)
}
