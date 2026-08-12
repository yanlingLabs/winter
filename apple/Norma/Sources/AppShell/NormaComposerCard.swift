import SwiftUI

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
                                       announcement: announcement))
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

        ZStack(alignment: stripEdge == .below ? .top : .bottom) {
            stripSurface(strip)
            composerBox(accessory: chrome.makeControlRowAccessory())
        }
        .frame(maxWidth: newChatCardWidth)
    }

    // MARK: - The composer proper

    private func composerBox(accessory: AnyView?) -> some View {
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

            controlRow(accessory: accessory)
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
                .frame(height: newChatComposerHeight + strip.height)
                .overlay(alignment: stripEdge == .below ? .bottom : .top) {
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

    /// The control row. Attach, the mode's own accessory, the model slot, Dictate and Send — the
    /// four fixed ones written once, here, for every mode.
    ///
    /// Attach, the model slot and Dictate all remain placeholders and remain labelled as such
    /// (spec §8). Task 7 makes the model slot real; it is a shared control, so it stays here.
    private func controlRow(accessory: AnyView?) -> some View {
        HStack(spacing: 8) {
            NewChatControlButton(systemImage: "plus", label: "Attach (not wired yet)", size: 17)
            accessory
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
