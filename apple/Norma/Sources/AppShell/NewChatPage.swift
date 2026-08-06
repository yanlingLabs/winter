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
    private var composerCard: some View {
        ComposerTextView(
            text: $draft,
            onSubmit: { submit() },
            usesAdaptiveColors: true
        )
        .frame(height: 88)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(.quaternary, lineWidth: 1)
        )
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
