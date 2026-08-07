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

    @State private var draft = ""

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 0)
            Text(newChatGreeting)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
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
        return Group {
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
        .frame(height: 88)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(.quaternary, lineWidth: 1)
        )
        .overlay(alignment: .bottomTrailing) {
            if ui.showsWorkingIndicator {
                ProgressView()
                    .controlSize(.small)
                    .padding(10)
                    .accessibilityLabel("Starting chat")
            }
        }
        .frame(maxWidth: 640)
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
