import SwiftUI

// MARK: - chatgpt-ui T2: the new-chat page (spec §2 — the pass's ONE behavior change)

/// PURE: the page's centered greeting — house voice (the field's own "Ask Norma…" register:
/// short, calm, ours), deliberately NOT ChatGPT's copy (spec §2's explicit rule; their rotating
/// question-form greetings — "What can I help with?" et al — are theirs). Pinned directly
/// (`AppShellTests`), same extracted-string discipline as `chatLandingEmptyStateSubtitle`.
let newChatGreeting = "Ask Norma anything."

/// PURE: the page's visible-failure copy for a create that could not ride an RpcError (transport
/// down, daemon unreachable) — the same fallback sentence every other RPC seam in the shell uses
/// (`setActivityFromRoster`/`applyDirsOp`), extracted so the page and the host publish ONE string.
let newChatUnreachableMessage = "couldn't reach the daemon — try again"

/// chatgpt-ui T3 (the T2 review's routed c-m3): what the page's send affordance shows for a given
/// create state — the pure half of the in-flight feedback, table-tested directly
/// (`AppShellTests`). A struct rather than a tuple so the pin compares whole values.
struct NewChatSendUI: Equatable {
    let composerEnabled: Bool
    let showsWorkingIndicator: Bool
}

/// PURE: send-state → {composer enabled, working indicator}. `.creating` is the ONLY state that
/// disables the composer and shows the indicator — the feedback spans exactly "send until
/// navigation (or visible error)": `.creating` lifts at the create ack, the same beat a
/// current-page create's navigation fires (`sendFirstChatMessage` sets `.idle` then calls
/// `onCreated` synchronously), and a failed create re-enables with the page's own error text
/// (its display is `NewChatPage.body`'s existing `.failed` branch, pinned by
/// `testFirstSendCreateFailureIsVisibleOnThePageAndNeverNavigates`). Idle and failed BOTH leave
/// the composer enabled — a failure must never wedge the page (Enter retries, the T2 contract).
/// This was the T2 review's named root cause of the send-race windows: a page with no in-flight
/// state read as a dead app and invited the navigate-away → re-enter → re-send flow.
func newChatSendUI(_ state: ShellSessionHost.NewChatCreateState) -> NewChatSendUI {
    switch state {
    case .creating: return NewChatSendUI(composerEnabled: false, showsWorkingIndicator: true)
    case .idle, .failed: return NewChatSendUI(composerEnabled: true, showsWorkingIndicator: false)
    }
}

// MARK: - sidebar-chrome-2: the composer card's control rows

/// The mode segmented picker's options, mirroring the reference's Chat/Cowork pair. Cowork is
/// present but NOT selectable — it has no daemon mode at all yet (`SessionMode.isAvailable`), the
/// same honest posture the sidebar's Cowork row takes. Shown rather than hidden on the user's
/// call: "keep the chat/cowork picker… it's not built yet in Norma but will be later."
let newChatModeOptions: [SessionMode] = [.chat, .cowork]

/// The announcement strip's fallback — what shows when Norma has nothing to announce.
///
/// The user's placeholder suggestion was "We are amazing!" and invited a better idea. This is it:
/// a rotating TIP. Self-congratulation reads as filler the second time you see it, whereas a tip
/// earns its space every time it changes — and every line here is true of the app TODAY, so the
/// strip can never advertise something that does not exist.
///
/// Keep this list honest. A tip for an unbuilt feature is worse than no tip at all.
let newChatTips: [String] = [
    "⌘K searches every session by title",
    "Move any session to the CLI from its right-click menu",
    "Your keys live in the Keychain — never on disk",
    "Sessions are append-only; nothing is deleted behind your back",
]

/// PURE: what the announcement strip shows. A real announcement wins; otherwise the day's tip.
///
/// `day` is injected (rather than read from the clock here) so the pin is not time-dependent, the
/// same discipline `relativeTimeBucket` follows. Picking by day rather than at random means the
/// line is stable for a whole session — a strip that reshuffled on every redraw would be noise.
func newChatAnnouncement(_ announcement: String?, day: Int) -> String {
    let trimmed = announcement?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmed.isEmpty { return trimmed }
    guard !newChatTips.isEmpty else { return "" }
    // `abs` + modulo: a negative or absurd day index must still land inside the list.
    return newChatTips[abs(day) % newChatTips.count]
}

/// PURE: the day-of-year the strip picks its tip by. Extracted so the view has no date logic and
/// the pin can hand it any date it likes.
func newChatTipDay(_ date: Date, calendar: Calendar = .current) -> Int {
    calendar.ordinality(of: .day, in: .year, for: date) ?? 0
}

/// The composer card's metrics — reference-measured (~670 pt wide), tune-at-gate like the rest.
let newChatCardWidth: CGFloat = 670
let newChatCardCornerRadius: CGFloat = 16

/// What the model/effort slot reads until it is wired. NOT a real model name: showing one would
/// claim this page had picked it, and the page has no session to pick for yet.
let newChatModelPlaceholder = "Default model"

/// A bare icon button in the composer card's control row.
struct NewChatControlButton: View {
    let systemImage: String
    let label: String

    var body: some View {
        Button {} label: {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textMuted)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        // The pane's ONE row treatment, so these hover exactly like the sidebar and titlebar.
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .help(label)
        .accessibilityLabel(label)
    }
}

/// A labelled chip in the card's second row — glyph, title, disclosure chevron.
struct NewChatControlChip: View {
    let systemImage: String
    let title: String
    let label: String

    var body: some View {
        Button {} label: {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 11))
                Text(title)
                    .font(.system(size: 11))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
            }
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .help(label)
        .accessibilityLabel(label)
    }
}

/// The new-chat page: centered greeting + the EXISTING composer component, chat mode context,
/// **no session on arrival** (spec §2's wire pin: navigating here mints ZERO `session.create`).
/// The first send runs create → attach → send as one flow through
/// `ShellSessionHost.sendFirstChatMessage` — this view never talks to a client itself, the same
/// no-client-in-a-view posture as `ChatLandingView`.
///
/// The composer is `ComposerTextView` AS-IS (Global Constraints: the page HOSTS the existing
/// component unchanged — same `usesAdaptiveColors: true` + 88pt frame as `WindowContentView`'s
/// own composer slot; the transcript/composer restyle is the NEXT pass).
///
/// Draft semantics (decided-and-disclosed, T2 report): the draft is view-local `@State`. It
/// SURVIVES a hide/re-summon (the shell hides, never closes — the view stays mounted) and DROPS
/// on navigate-away (the detail switch tears the page down) — the honest simple choice: no
/// second draft store to drift, and the page is one keystroke away from anywhere.
struct NewChatPage: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var host: ShellSessionHost
    /// The announcement strip's content. `nil`/blank shows the day's tip instead
    /// (`newChatAnnouncement`). Injected rather than fetched: nothing publishes announcements yet,
    /// and the slot should be ready for whatever eventually does without this view knowing about
    /// it — a settings key, a release note, the daemon.
    var announcement: String? = nil

    @State private var draft = ""

    var body: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 0)
            greeting
            composerCard
            // Visible failure (spec's honesty rule): a create that failed says so, in place —
            // the page never navigates on failure (`sendFirstChatMessage`'s own contract).
            if case .failed(let message) = host.newChatCreate {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Spacer(minLength: 0)
            Spacer(minLength: 0) // greeting+composer sit slightly above center, the reference's own balance
        }
        .padding(.horizontal, 32)
        .navigationTitle(shellDestinationTitle(.newChat))
    }

    /// The greeting — the reference's shape (brand mark + a serif line), Norma's own words.
    ///
    /// SERIF is a deliberate allowlist addition (`Theme.wordmark`'s doc, binding #5): the iOS
    /// gallery's typography file already sanctions "the home greeting" as a serif moment, and this
    /// is that moment. The COPY stays the house line rather than borrowing the reference's
    /// time-of-day form — it has no user name to greet, and "Ask Norma anything." is the register
    /// the field itself uses.
    private var greeting: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .scaledToFit()
                .frame(width: 30, height: 30)
            Text(newChatGreeting)
                .font(Theme.greeting)
                .foregroundStyle(.primary)
        }
        .multilineTextAlignment(.center)
    }

    /// The existing composer, in a quiet bordered card so it reads as THE affordance on an
    /// otherwise-empty page (framing only — the component inside is untouched).
    ///
    /// chatgpt-ui T3 (c-m3, the in-flight feedback): while a create is in flight
    /// (`newChatSendUI`'s `.creating` row) the live composer is SWAPPED for a non-editable
    /// held-draft rendering of the same text in the same card — the honest disable:
    /// `.disabled()` is a no-op on the `NSViewRepresentable` composer (its `NSTextView` never
    /// reads the SwiftUI environment, and the component itself is fenced — Global Constraints:
    /// hosted unchanged), so unmounting it is the one way keyboard input actually stops. The
    /// draft is view-local `@State`, so the text survives the swap in BOTH directions: shown
    /// (secondary, visibly held) while creating, restored verbatim into the live composer on
    /// failure. A small spinner rides the card's corner as the subtle working indicator. On
    /// success the whole page navigates away in the create-ack's own beat, so the re-enabled
    /// composer never flashes.
    private var composerCard: some View {
        let ui = newChatSendUI(host.newChatCreate)
        return VStack(spacing: 0) {
            Group {
                if ui.composerEnabled {
                    ComposerTextView(
                        text: $draft,
                        onSubmit: { submit() },
                        usesAdaptiveColors: true
                    )
                } else {
                    // The held draft — same type size, same top-leading start as the live composer
                    // (its `textContainerInset`/zero line-fragment padding, mirrored) so the swap
                    // doesn't visibly jump; secondary color is what reads as "disabled" here.
                    Text(draft)
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, ComposerTextView.textContainerInset.width)
                        .padding(.vertical, ComposerTextView.textContainerInset.height)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .frame(height: 76)
            .padding(.horizontal, 14)
            .padding(.top, 12)

            controlRow
            announcementRow
        }
        .background(
            RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                .fill(Theme.composerSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: newChatCardCornerRadius, style: .continuous)
                .strokeBorder(Theme.hairline, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
        .overlay(alignment: .bottomTrailing) {
            if ui.showsWorkingIndicator {
                ProgressView()
                    .controlSize(.small)
                    .padding(10)
                    .accessibilityLabel("Starting chat")
            }
        }
        .frame(maxWidth: newChatCardWidth)
    }

    /// The card's first control row — the reference's anatomy: attach, the mode picker, the model
    /// and effort, dictation, send.
    ///
    /// Everything but SEND is a **placeholder** (labelled "not wired yet" in its help text, the
    /// same honest posture the titlebar cluster takes). They are not fake for want of a backend —
    /// Norma has real models, efforts and approval policies — but because this page has NO SESSION
    /// yet: these controls would have to set DEFAULTS for the session about to be created, and
    /// that concept does not exist. Wiring them is its own piece of work.
    private var controlRow: some View {
        HStack(spacing: 8) {
            NewChatControlButton(systemImage: "plus", label: "Attach (not wired yet)")
            modePicker
            Spacer(minLength: 12)
            Text(newChatModelPlaceholder)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
            NewChatControlButton(systemImage: "mic", label: "Dictate (not wired yet)")
            sendButton
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    /// Chat / Cowork, the reference's segmented pair. Cowork renders but never selects — it has no
    /// daemon mode at all (`SessionMode.isAvailable`), the same "visible but honest" treatment the
    /// sidebar's Cowork row gets rather than hiding a mode the user knows is coming.
    private var modePicker: some View {
        HStack(spacing: 2) {
            ForEach(newChatModeOptions, id: \.self) { mode in
                let isSelected = mode == .chat
                Text(mode.title)
                    .font(.system(size: 12, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(mode.isAvailable ? AnyShapeStyle(.primary)
                                                      : AnyShapeStyle(Theme.textMuted))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isSelected ? AnyShapeStyle(Theme.canvas) : AnyShapeStyle(.clear))
                    )
                    .help(mode.isAvailable ? mode.title : "\(mode.title) — not built yet")
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.controlSurface)
        )
    }

    /// The send affordance — the ONE live control in the row. Accent-tinted like the reference's,
    /// which is the single place the brand teal earns its way onto this surface.
    private var sendButton: some View {
        Button(action: submit) {
            Image(systemName: "arrow.up")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.canvas)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Theme.accent))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .opacity(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
        .help("Send")
        .accessibilityLabel("Send")
    }

    /// The card's second row: the working-folder and approval-mode pickers (both placeholders, for
    /// the no-session-yet reason above), and the ANNOUNCEMENT strip at the trailing edge.
    ///
    /// The announcement slot replaces the reference's usage promotion (user call: keep the slot,
    /// drop the promotion). It is a place for Norma to say something occasionally — and when there
    /// is nothing to say it shows the day's tip rather than sitting empty or congratulating itself.
    private var announcementRow: some View {
        HStack(spacing: 14) {
            NewChatControlChip(systemImage: "folder", title: "Project or folder",
                               label: "Working folder (not wired yet)")
            NewChatControlChip(systemImage: "hand.raised", title: "Ask",
                               label: "Approval mode (not wired yet)")
            Spacer(minLength: 12)
            HStack(spacing: 5) {
                Image(systemName: "sparkles")
                    .font(.system(size: 10))
                Text(newChatAnnouncement(announcement, day: newChatTipDay(Date())))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .font(.system(size: 11))
            .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 11)
    }

    /// First send = the create-on-send flow (spec §2): exactly ONE `session.create` (mode chat,
    /// no cwd), then attach, then the typed text as the first message — `sendFirstChatMessage`
    /// owns the whole sequence and the double-send guard; on success the shell navigates onto the
    /// live session (the composer content carries — the host seeds the attached adapter's draft
    /// until the send lands, so there is no empty-composer flicker and no lost text).
    private func submit() {
        host.sendFirstChatMessage(draft) { sessionId in
            nav.navigate(to: .session(sessionId))
        }
    }
}
