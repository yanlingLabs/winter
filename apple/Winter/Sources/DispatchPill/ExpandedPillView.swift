import SwiftUI

// The typing pill's own pieces. The expanded pill itself is `DispatchPillComposerBar`
// (`DispatchPillView.swift`) in its `.expanded` presentation — see that type's doc for why compact
// and expanded are one view. What is expanded-specific is drawn here:
//
//   [ text being typed ………………………… (⋯) (↗) (●) ]
//
// ↗ and ⋯ float over the field's trailing end and blur out as the text comes up to them
// (`dispatchPillAccessoryButtonsVisible`); the text runs on underneath, and the field never changes
// width for them. Past a line, the pill grows taller into a rounded rect. A 2-finger swipe — or a
// reply arriving — pins a turn, shown in a band above the composer (`ExpandedPillTurnPreview`).

/// ⋯ and ↗. ⋯ is a popover rather than a `Menu`: an `NSMenu` opens at the pop-up-menu window level,
/// BELOW this `.screenSaver`-level panel, so its items would draw underneath the pill; a popover is a
/// child window of the panel and orders above it.
///
/// There is no Hide row: only the 4-finger tap (the trigger) puts the pill away, and putting it away
/// is what starts the draft countdown (`DispatchPillDraftExpiry`).
struct ExpandedPillAccessoryButtons: View {
    let onFullScreen: () -> Void
    let onOpenInApp: () -> Void
    let onClearDraft: () -> Void
    /// Whether the ⋯ popover is open — the controller's click-outside monitor must not treat a click
    /// inside the popover as a click away from the pill.
    var onPopoverChange: (Bool) -> Void = { _ in }

    @State private var showsMore = false

    var body: some View {
        HStack(spacing: DispatchPillMetrics.rowSpacing) {
            Button { showsMore.toggle() } label: {
                accessoryGlyph("ellipsis")
            }
            .buttonStyle(.plain)
            .help("More")
            .popover(isPresented: $showsMore, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    moreRow("Open Dispatch in Winter", symbol: "macwindow") { onOpenInApp() }
                    moreRow("Clear Draft", symbol: "xmark.circle") { onClearDraft() }
                }
                .padding(6)
                .environment(\.colorScheme, .dark)
            }

            .onChange(of: showsMore) { _, open in onPopoverChange(open) }
            .onDisappear { if showsMore { onPopoverChange(false) } }

            Button(action: onFullScreen) {
                accessoryGlyph("arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(.plain)
            .help("Full screen")
        }
    }

    private func accessoryGlyph(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(Typography.label(.semibold))
            .foregroundStyle(Color.white)
            .frame(width: DispatchPillMetrics.accessoryButtonSize, height: DispatchPillMetrics.accessoryButtonSize)
            .background(Circle().fill(Color.white.opacity(0.12)))
            .contentShape(Circle())
    }

    private func moreRow(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button {
            showsMore = false
            action()
        } label: {
            Label(title, systemImage: symbol)
                .font(Typography.control())
                .foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A pinned turn — swiped to, or a reply that just arrived — shown ALONE in the pill (no composer):
/// its prompt shortened to one line, the start of its reply, and where it sits in the conversation
/// ("3/7"). Every line is at the composer's own text size; the prompt is told apart by colour, not
/// size. The pill is sized to the reply's lines (`dispatchPillPreviewHeight`). Typing, a click on
/// it, Esc, or swiping on past the newest turn returns to the composer.
struct ExpandedPillTurnPreview: View {
    let preview: DispatchPillTurnPreview

    var body: some View {
        VStack(alignment: .leading, spacing: DispatchPillMetrics.previewLineGap) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(preview.prompt)
                    .font(Typography.composerField(.medium))
                    .foregroundStyle(Color.white.opacity(0.5))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Text(preview.position)
                    .font(Typography.caption())
                    .foregroundStyle(Color.white.opacity(0.35))
            }
            Text(preview.reply)
                .font(Typography.composerField())
                .foregroundStyle(Color.white)
                .lineLimit(DispatchPillMetrics.previewReplyLines)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, DispatchPillMetrics.leadingPadding)
        .padding(.vertical, DispatchPillMetrics.previewVerticalInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
