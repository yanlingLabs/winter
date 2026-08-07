import SwiftUI

// MARK: - The shared composer card

/// Which edge the Cowork strip emerges from.
///
/// The new-chat page's composer floats mid-page, so its strip slides DOWN from underneath. A live
/// session's composer sits at the BOTTOM of the window, where "below" is off-screen — so there the
/// strip slides UP from behind the composer's top edge instead. Same surface, same motion, mirrored.
enum NormaComposerStripEdge: Equatable {
    case below
    case above
}

/// THE composer card — one component, two homes: the new-chat page and the shell's live chat page.
///
/// Extracted (2026-08-07) rather than reimplemented, on the user's call that the live chat page's
/// composer "is basically non existent" and "should be the same as the one of the new chat page".
/// The point of a shared component here is not tidiness: it is that two composers that are meant to
/// be identical WILL drift if they are two views, and the drift shows up as the live page quietly
/// falling a pass behind whenever the new-chat page is tuned.
///
/// What it does NOT own: the suggestion chips and idea list below the new-chat card. Those belong
/// to an EMPTY page — there is nothing to suggest once a conversation is underway.
struct NormaComposerCard: View {
    @Binding var text: String
    var onSubmit: () -> Void

    /// The session's mode. Drives the Chat/Cowork segment (shown only for the two modes that
    /// segment offers — a code or dispatch session has no business displaying it) and whether the
    /// Cowork strip is present at all.
    @Binding var mode: SessionMode
    /// Whether the segment can be CHANGED. False on a live session: a session's mode is fixed at
    /// creation and Norma has no mode-switch, so an interactive segment there would be a control
    /// that cannot do what it appears to offer.
    var modeIsSelectable: Bool = true

    var stripEdge: NormaComposerStripEdge = .below
    var placeholder: String = newChatComposerPlaceholder
    /// The Cowork strip's trailing line. Empty renders the strip's controls with nothing after them.
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

    @State private var isHovered = false

    /// The segment is offered only for the modes it actually contains. A code or dispatch session
    /// renders the card without it rather than showing a Chat/Cowork choice that means nothing.
    private var showsModeSegment: Bool { newChatModeOptions.contains(mode) }

    var body: some View {
        // How far the strip protrudes past the composer. Animating THIS is the whole effect: the
        // strip is a rounded rect sitting BEHIND the composer, and growing it slides its band out
        // from underneath. The composer's own height never changes (the standing ruling).
        let band = newChatShowsCoworkControls(mode: mode) ? newChatCoworkStripHeight : 0

        ZStack(alignment: stripEdge == .below ? .top : .bottom) {
            stripSurface(band: band)
            composerBox
        }
        .frame(maxWidth: newChatCardWidth)
    }

    // MARK: - The composer proper

    private var composerBox: some View {
        VStack(spacing: 0) {
            Group {
                if isEnabled {
                    ComposerTextView(
                        text: $text,
                        onSubmit: onSubmit,
                        usesAdaptiveColors: true,
                        fontSize: newChatComposerFontSize
                    )
                    // The component has no placeholder parameter, so this is an overlay that steps
                    // aside the moment there is text. Non-hit-testing, or it would eat the click
                    // that focuses the field underneath it. Same size as the live text, or the
                    // words would change size the instant you type.
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text(placeholder)
                                .font(.system(size: newChatComposerFontSize))
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
                        .font(.system(size: newChatComposerFontSize))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, ComposerTextView.textContainerInset.width)
                        .padding(.vertical, ComposerTextView.textContainerInset.height)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .frame(height: 54)
            .padding(.horizontal, 16)
            .padding(.top, 20)

            controlRow
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
    @ViewBuilder
    private func stripSurface(band: CGFloat) -> some View {
        if band > 0 || newChatShowsCoworkControls(mode: mode) {
            RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                .fill(Theme.canvas)
                .overlay(
                    RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                        .strokeBorder(Theme.hairline.opacity(0.5),
                                      lineWidth: shellSidebarHairlineWidth)
                )
                .frame(height: newChatComposerHeight + band)
                .overlay(alignment: stripEdge == .below ? .bottom : .top) {
                    // Pinned to the GROWING edge and clipped, so the row travels with the band
                    // instead of being uncovered in place — the difference between sliding out
                    // from beneath and fading in.
                    coworkStrip
                        .frame(height: newChatCoworkStripHeight)
                        .frame(height: band, alignment: stripEdge == .below ? .bottom : .top)
                        .clipped()
                }
                .opacity(band > 0 ? 1 : 0)
        }
    }

    private var coworkStrip: some View {
        HStack(spacing: 10) {
            NewChatControlChip(systemImage: "folder", title: "Project or folder",
                               label: "Working folder (not wired yet)")
            NewChatControlChip(systemImage: "hand.raised", title: "Ask",
                               label: "Approval mode (not wired yet)")
            Spacer(minLength: 12)
            if !announcement.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 11))
                    Text(announcement)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
            }
        }
        // Matches the control row's inset, so the folder glyph lands on the same column as the plus.
        .padding(.horizontal, 18)
        .frame(height: newChatCoworkStripHeight)
    }

    // MARK: - The control row

    private var controlRow: some View {
        HStack(spacing: 8) {
            NewChatControlButton(systemImage: "plus", label: "Attach (not wired yet)", size: 17)
            if showsModeSegment { modeSegment }
            Spacer(minLength: 12)
            HStack(spacing: 4) {
                Text(newChatModelPlaceholder)
                    .font(.system(size: 14))
                    .foregroundStyle(.primary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .help("Model and effort (not wired yet)")
            NewChatControlButton(systemImage: "mic", label: "Dictate (not wired yet)", size: 15)
            sendButton
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
    }

    private var modeSegment: some View {
        HStack(spacing: 2) {
            ForEach(newChatModeOptions, id: \.self) { option in
                let isSelected = option == mode
                Button {
                    guard modeIsSelectable else { return }
                    withAnimation(.easeInOut(duration: 0.24)) { mode = option }
                } label: {
                    Text(option.title)
                        .font(.system(size: 14, weight: isSelected ? .medium : .regular))
                        .foregroundStyle(isSelected ? AnyShapeStyle(.primary)
                                                    : AnyShapeStyle(Theme.textMuted))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(isSelected ? AnyShapeStyle(Theme.composerSurface)
                                         : AnyShapeStyle(Color.clear))
                )
                .help(modeIsSelectable
                      ? (option.isAvailable ? option.title : "\(option.title) — not built yet")
                      : "This session is \(mode.title.lowercased()) — a session's mode is fixed when it is created")
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.controlSurface)
        )
    }

    private var sendButton: some View {
        Group {
            if sendBlockedReason == nil {
                Button(action: onSubmit) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .semibold))
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
            } else {
                Image(systemName: "waveform")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: newChatSendButtonSize, height: newChatSendButtonSize)
                    .help(sendBlockedReason!.isEmpty ? "Type a message to send" : sendBlockedReason!)
                    .accessibilityLabel(sendBlockedReason!.isEmpty
                                        ? "Send — type a message first" : sendBlockedReason!)
            }
        }
    }
}
