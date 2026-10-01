import SwiftUI

// The typing pill's own pieces. The expanded pill itself is `DispatchPillComposerBar`
// (`DispatchPillView.swift`) in its `.expanded` presentation — see that type's doc for why compact
// and expanded are one view. What is expanded-specific is drawn here:
//
//   [ text being typed ………………………… (⋯) (↗) (●) ]
//
// ↗ and ⋯ step aside the moment the text reaches them (`dispatchPillAccessoryButtonsVisible`), and
// the field takes their room; past a line, the pill grows taller into a rounded rect. A 2-finger
// swipe pins a past turn, shown in a band above the composer (`ExpandedPillTurnPreview`).

/// ⋯ and ↗. ⋯ is a popover rather than a `Menu`: an `NSMenu` opens at the pop-up-menu window level,
/// BELOW this `.screenSaver`-level panel, so its items would draw underneath the pill; a popover is a
/// child window of the panel and orders above it.
struct ExpandedPillAccessoryButtons: View {
    let onFullScreen: () -> Void
    let onOpenInApp: () -> Void
    let onClearDraft: () -> Void
    let onHide: () -> Void
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
                    moreRow("Hide", symbol: "eye.slash") { onHide() }
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
            .foregroundStyle(Theme.textSecondary)
            .frame(width: DispatchPillMetrics.accessoryButtonSize, height: DispatchPillMetrics.accessoryButtonSize)
            .background(Circle().fill(Theme.controlSurface))
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

/// A swiped-to past turn: its prompt shortened to one line, the first line of its reply, and where it
/// sits in the conversation ("3/7"). Swiping on past the newest turn returns to the composer.
struct ExpandedPillTurnPreview: View {
    let preview: DispatchPillTurnPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(preview.prompt)
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Text(preview.position)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
            }
            Text(preview.reply)
                .font(Typography.label())
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
                .truncationMode(.tail)
        }
        .padding(.horizontal, DispatchPillMetrics.leadingPadding)
        .padding(.top, 10)
        .frame(height: DispatchPillMetrics.previewHeight, alignment: .top)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.hairlineElevated)
                .frame(height: 1)
                .padding(.horizontal, DispatchPillMetrics.leadingPadding)
        }
    }
}
