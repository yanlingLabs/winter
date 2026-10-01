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
                DispatchPillAccessories(controller: controller, adapter: adapter, rowWidth: morph.target.width)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGRect.self) { proxy in
                        proxy.frame(in: .named(Self.canvasSpace))
                    } action: { frame in
                        controller.accessoryLayoutChanged(frame: frame)
                    }
            }
            DispatchPillShell(morph: morph) {
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

/// The main pill's shape: content laid out at the TARGET size, revealed by a shape at the spring's
/// CURRENT size (bottom-anchored), whose corner radius follows its height — a capsule at rest, a
/// rounded rect once it grows taller. The only view that observes the 60Hz morph.
struct DispatchPillShell<Content: View>: View {
    @ObservedObject var morph: DispatchPillMorphModel
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: dispatchPillCornerRadius(height: morph.size.height),
                                     style: .continuous)
        content
            .frame(width: morph.target.width, height: morph.target.height)
            .frame(width: morph.size.width, height: morph.size.height, alignment: .bottom)
            .clipShape(shape)
            .background(shape.fill(Theme.cardSurface))
            .overlay(shape.strokeBorder(Theme.hairlineElevated, lineWidth: 1))
            .compositingGroup()
            .shadow(color: .black.opacity(0.4), radius: 14, y: 4)
    }
}

/// What floats above the pill: the asks waiting on the user, then the child-session row.
private struct DispatchPillAccessories: View {
    @ObservedObject var controller: DispatchPillController
    @ObservedObject var adapter: FieldStateAdapter
    let rowWidth: CGFloat

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
                    onOpenOverflow: { controller.onOpenInApp?() }
                )
            }
        }
    }
}

/// The compact AND expanded pill — ONE view, so the `ComposerTextView` inside keeps its identity
/// (its `NSTextView`, its caret, its first-responder status) when the first keystroke grows the pill.
/// Swapping a `CompactPillView` for an `ExpandedPillView` here would rebuild the text view mid-word.
/// The state-specific pieces live in those files: `CompactPillLeading` and `PillSendStopButton`
/// (`CompactPillView.swift`), `ExpandedPillAccessoryButtons` and `ExpandedPillTurnPreview`
/// (`ExpandedPillView.swift`).
struct DispatchPillComposerBar: View {
    @ObservedObject var controller: DispatchPillController
    @ObservedObject var adapter: FieldStateAdapter

    var body: some View {
        let expanded = controller.presentation == .expanded
        let running = adapter.turnRunning
        let draft = adapter.composerDraft
        let showsAccessories = expanded
            && dispatchPillAccessoryButtonsVisible(draft: draft, textWidth: dispatchPillDraftTextWidth(draft))
        VStack(spacing: 0) {
            if expanded, let preview = controller.turnPreview {
                ExpandedPillTurnPreview(preview: preview)
            }
            HStack(alignment: .center, spacing: DispatchPillMetrics.rowSpacing) {
                if !expanded, running {
                    CompactPillLeading(toolName: controller.runningToolName)
                }
                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(running ? adapter.verbText : "Type here")
                            .font(Typography.composerField())
                            .foregroundStyle(Theme.textPlaceholder)
                            .lineLimit(1)
                            .padding(.leading, ComposerTextView.textContainerInset.width)
                            .padding(.top, ComposerTextView.textContainerInset.height)
                            .allowsHitTesting(false)
                    }
                    ComposerTextView(
                        text: adapter.draftBinding,
                        onSubmit: { controller.submit(adapter.composerDraft) },
                        onContentHeightChange: { controller.composerContentHeightChanged($0) },
                        usesAdaptiveColors: true
                    )
                }
                .frame(height: controller.composerFieldHeight)
                if showsAccessories {
                    ExpandedPillAccessoryButtons(
                        onFullScreen: { controller.requestFullScreen() },
                        onOpenInApp: { controller.onOpenInApp?() },
                        onClearDraft: { controller.clearDraft() },
                        onPopoverChange: { controller.auxiliaryPopoverOpen = $0 }
                    )
                    .transition(.opacity)
                }
                PillSendStopButton(
                    isRunning: running,
                    canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    onSend: { controller.submit(adapter.composerDraft) },
                    onStop: { controller.interrupt() }
                )
            }
            .padding(.leading, DispatchPillMetrics.leadingPadding)
            .padding(.trailing, DispatchPillMetrics.trailingPadding)
            .frame(maxHeight: .infinity)
            .animation(.easeOut(duration: 0.15), value: showsAccessories)
        }
    }
}

/// The draft's single-line width at the composer's own face — what `dispatchPillAccessoryButtonsVisible`
/// compares against the field's width beside ↗ and ⋯.
func dispatchPillDraftTextWidth(_ draft: String) -> CGFloat {
    guard !draft.isEmpty else { return 0 }
    let font = Typography.sansNS(ofSize: Typography.composerFieldSize)
    return ceil((draft as NSString).size(withAttributes: [.font: font]).width)
}
