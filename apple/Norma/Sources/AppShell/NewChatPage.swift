import SwiftUI

// MARK: - chatgpt-ui T2: the new-chat page (spec §2 — the pass's ONE behavior change)

/// The page's greeting, ROTATING (user call, 2026-08-07 — a fresh line on every new-chat page and
/// every launch). This retires the single fixed "Ask Norma anything.", and with it the 2026-08-06
/// ruling that the greeting must be a calm STATEMENT rather than a question: the user asked for
/// the reference's register explicitly, so the question form is now wanted, not avoided.
///
/// Time-aware. The hour's own lines come first and the neutral ones always follow, so every band
/// has a real pool rather than two lines on repeat — and the copy is OURS, in the reference's
/// register rather than its words.
func newChatGreetings(hour: Int) -> [String] {
    let timely: [String]
    switch hour {
    case 5..<12:  timely = ["Morning. What's first?", "Morning. Where do we start?"]
    case 12..<17: timely = ["Afternoon. What's on your mind?", "Afternoon. What needs doing?"]
    case 17..<22: timely = ["Evening. What's left?", "Evening. How's it going?"]
    default:      timely = ["Late one. What do you need?", "Still up? Let's get to it."]
    }
    return timely + [
        "What's on your mind?",
        "What are we making?",
        "Where do we start?",
        "Tell me what you need.",
        "What can I take off your hands?",
    ]
}

/// PURE: the hour a greeting pool is chosen for. Injected so the pin is not clock-dependent.
func newChatGreetingHour(_ date: Date, calendar: Calendar = .current) -> Int {
    calendar.component(.hour, from: date)
}

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

/// The announcement strip's resting lines — what shows when Norma has nothing to announce.
///
/// This REPLACES the tips list (user call, 2026-08-07: it "looks like a dev tool", and it did —
/// keyboard shortcuts and Keychain facts are documentation, not a thing you want to read on an
/// empty page). These are meant to be worth glancing at: short, warm, about the WORK rather than
/// about the app. The register belongs with the serif greeting above them.
let newChatAnnouncementLines: [String] = [
    "Half-formed ideas are welcome here.",
    "Small steps still arrive.",
    "Ask for more than seems reasonable.",
    "Nothing you write here is ever lost.",
    "Good work is mostly patience.",
    "Start anywhere — we can rearrange later.",
    "Think out loud. That's what I'm for.",
]

/// PURE: what the announcement strip shows. A real announcement always wins; otherwise the line
/// the page picked when it appeared.
///
/// The rotation itself lives in the VIEW (`.onAppear`), not here, so this stays deterministic and
/// pinnable — and so "a new line each time the page opens" means exactly that rather than a line
/// that reshuffles on every redraw.
func newChatAnnouncement(_ announcement: String?, fallback: String) -> String {
    let trimmed = announcement?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? fallback : trimmed
}

/// The composer card's metrics — reference-measured (~670 pt wide), tune-at-gate like the rest.
let newChatCardWidth: CGFloat = 670
let newChatCardCornerRadius: CGFloat = 18

/// The composer box's FIXED height — field + control row. Fixed by ruling: a mode's strip adds a
/// band beyond this rather than resizing it, so the field and its controls never move under you.
/// Every strip positions itself against this figure, so the two must stay in step.
let newChatComposerHeight: CGFloat = 124

/// The strip's height — the band that slides out from behind the composer.
///
/// Named for the composer rather than for cowork since mac-chat-parity Task 6: it was measured for
/// cowork's placeholder chips, and it is now also the permissions row's band (spec §4's "40pt band,
/// 26pt chips") on code and dispatch. One figure, because the two bands are the same band seen on
/// different modes — a second constant would let them drift apart for no reason anyone chose.
let newChatComposerStripHeight: CGFloat = 40

/// The send affordance's square. The reference's is a squircle a touch larger than a
/// control-row icon button — it is the row's one primary action.
let newChatSendButtonSize: CGFloat = 30

/// What the model/effort slot reads until it is wired. NOT a real model name: showing one would
/// claim this page had picked it, and the page has no session to pick for yet.
let newChatModelPlaceholder = "Default model"

/// The composer's own placeholder, inside the card. The greeting above already says what this
/// page is for, so this asks rather than repeats — the reference's own split.
let newChatComposerPlaceholder = "How can I help you today?"

/// ONE size for everything the composer slot renders — the live text, its placeholder, and the
/// held draft shown while a create is in flight. They must agree or the text changes size the
/// moment you type, or the moment you send. 16 pt, not the component's default 14: on this page
/// the composer IS the subject rather than a strip under a transcript (user call, 2026-08-07).
let newChatComposerFontSize: CGFloat = 16

/// PURE: whether this page is showing its COWORK shape — today, the idea list in place of the
/// starter chips (`NewChatPage.starters`).
///
/// Cowork only (user ruling, 2026-08-07): a chat has no working folder and takes no approvals —
/// showing those controls on a chat would offer settings that cannot apply to what it is about to
/// create.
///
/// **It no longer governs the composer's second control row** (mac-chat-parity Task 5). That row is
/// cowork's own chrome now — `CoworkComposerChrome.makeStrip()` — because each mode's composer is
/// its own type rather than one card asking which mode it is in. The two answers still coincide for
/// cowork and are not tied together — Task 6 gave code and dispatch a band of their own (the
/// permissions row) and this function says no for both, correctly, because it is about this page's
/// layout and this page creates neither.
func newChatShowsCoworkControls(mode: SessionMode) -> Bool {
    mode == .cowork
}

/// PURE: why send is unavailable, or `nil` when it is available.
///
/// Two independent reasons, and the ORDER matters: an empty draft is the ordinary resting state
/// and needs no explanation, whereas a Cowork selection needs one — the mode picker can be moved
/// to Cowork so the design is visible, but Cowork has no daemon mode at all, so sending would
/// silently create a CHAT session instead. Refusing with a reason is the honest alternative to
/// either hiding the mode or quietly lying about what was created.
func newChatSendBlockedReason(draft: String, mode: SessionMode) -> String? {
    if !mode.isAvailable { return "\(mode.title) isn't built yet" }
    if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "" }
    return nil
}

/// One suggestion chip below the card — a prompt starter that PREFILLS the composer.
///
/// Genuinely wired, unlike the card's control placeholders: prefilling a draft needs no session,
/// no defaults concept, and no backend, so there is no reason to fake it.
struct NewChatStarter: Equatable {
    let title: String
    let systemImage: String
    /// What lands in the composer. Deliberately an OPENING, not a whole prompt — it hands you the
    /// first few words and leaves the sentence yours to finish.
    let prefill: String
}

/// One Cowork idea — the vertical list that REPLACES the starter chips in Cowork mode (user call,
/// 2026-08-07). Same prefill mechanism as a starter; different shape because these are whole tasks
/// rather than sentence openers, and a task does not fit on a chip.
struct NewChatIdea: Equatable {
    let title: String
    let systemImage: String
    let prefill: String
}

/// Cowork's ideas. Deliberately things Norma could plausibly be ASKED to do rather than features
/// it ships — Cowork itself is unbuilt, so an idea list that implied working capabilities would be
/// advertising vapour. They prefill the composer exactly like the chat starters.
let newChatCoworkIdeas: [NewChatIdea] = [
    NewChatIdea(title: "Send me a daily briefing", systemImage: "sun.horizon",
                prefill: "Every morning, send me a briefing covering "),
    NewChatIdea(title: "Keep an eye on a project folder", systemImage: "folder.badge.gearshape",
                prefill: "Watch this folder and tell me when "),
    NewChatIdea(title: "Set Cowork up for me", systemImage: "slider.horizontal.3",
                prefill: "Help me set up Cowork so that "),
]

let newChatStarters: [NewChatStarter] = [
    NewChatStarter(title: "Write", systemImage: "pencil", prefill: "Help me write "),
    NewChatStarter(title: "Learn", systemImage: "graduationcap", prefill: "Explain "),
    NewChatStarter(title: "Code", systemImage: "chevron.left.forwardslash.chevron.right",
                   prefill: "Help me with this code: "),
    NewChatStarter(title: "Plan", systemImage: "list.bullet.rectangle", prefill: "Help me plan "),
    NewChatStarter(title: "Norma's choice", systemImage: "lightbulb",
                   prefill: "Surprise me — pick something useful."),
]

/// A starter chip. Hovering tints it with the ACCENT rather than a grey (user call, 2026-08-07:
/// "rather than turning grey they should become the color of the send button") — so the page's one
/// brand colour is used by exactly two things, the send button and the affordances that fill the
/// composer, which is a coherent story rather than decoration.
///
/// The fill is the accent at low alpha with an accent rim, not a solid accent block: a chip is a
/// suggestion, and solid brand colour on hover would read as "selected" or "primary action" — a
/// claim these do not make. The send button keeps the solid fill precisely because it IS that.
struct NewChatStarterChip: View {
    let starter: NewChatStarter
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: starter.systemImage)
                    .font(.system(size: 12))
                Text(starter.title)
                    .font(.system(size: 13))
            }
            .foregroundStyle(isHovered ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(.primary))
            .padding(.horizontal, 14)
            .frame(height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(isHovered ? AnyShapeStyle(Theme.accent.opacity(0.10))
                                : AnyShapeStyle(Theme.composerSurface))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isHovered ? AnyShapeStyle(Theme.accent.opacity(0.45))
                                        : AnyShapeStyle(Theme.hairline),
                              lineWidth: shellSidebarHairlineWidth)
        )
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .onHover { isHovered = $0 }
        .help("Start with: \(starter.prefill)")
    }
}

/// One Cowork idea row — glyph, title, and the trailing mode tag the reference carries. Same
/// accent-on-hover treatment as the chips, since both do the same job: fill the composer.
struct NewChatIdeaRow: View {
    let idea: NewChatIdea
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: idea.systemImage)
                    .font(.system(size: 15))
                    .foregroundStyle(isHovered ? AnyShapeStyle(Theme.accent)
                                               : AnyShapeStyle(Theme.textMuted))
                    .frame(width: 22)
                Text(idea.title)
                    .font(.system(size: 14))
                    .foregroundStyle(.primary)
                Spacer(minLength: 12)
                Text(SessionMode.cowork.title)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(isHovered ? AnyShapeStyle(Theme.accent.opacity(0.10))
                                : AnyShapeStyle(Color.clear))
        )
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .onHover { isHovered = $0 }
        .help("Start with: \(idea.prefill)")
    }
}

/// A bare icon button in the composer card's control row.
struct NewChatControlButton: View {
    let systemImage: String
    let label: String
    var size: CGFloat = 13

    var body: some View {
        Button {} label: {
            Image(systemName: systemImage)
                .font(.system(size: size, weight: .medium))
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
///
/// Both added parameters default to what this chip has always done, so its two placeholder call
/// sites (`CoworkComposerStrip`) render byte-identically:
///
/// - `action` — `nil` keeps the dead `Button {}` these chips have carried since they were drawn.
///   mac-chat-parity Task 6's permissions chip is the first REAL one, and it reuses this type
///   rather than redrawing it so the measured metrics (26 pt, 14 pt title, the pane's one row
///   treatment) stay written once.
/// - `titleStyle` — the danger treatment `policyPickerRow` has always used for `bypass`, which the
///   permissions chip must carry too: the persistent row is exactly where a session quietly running
///   `bypass` needs to look like one.
struct NewChatControlChip: View {
    let systemImage: String
    let title: String
    let label: String
    var titleStyle: AnyShapeStyle = AnyShapeStyle(.primary)
    var action: (() -> Void)? = nil

    var body: some View {
        Button { action?() } label: {
            HStack(spacing: 7) {
                Image(systemName: systemImage)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                // PRIMARY, not muted, and at the control row's own size — these are CONTROLS you
                // would click, and the reference sets them as such. Muted 11 pt read as captions
                // sitting under the composer rather than as pickers.
                Text(title)
                    .font(.system(size: 14))
                    .foregroundStyle(titleStyle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
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
/// The composer is still `ComposerTextView` AS-IS — the component itself remains untouched
/// (`usesAdaptiveColors: true`, hosted unchanged). What changed in the sidebar-chrome-2 pass is
/// only its FRAMING: the field is 54 pt rather than the 88 it shared with `WindowContentView`'s
/// slot, it carries a placeholder overlay (the component has no placeholder parameter of its
/// own), and it sits inside a card with two control rows. The TRANSCRIPT's restyle is still a
/// later pass; this one reshaped the new-chat page only.
///
/// Draft semantics (decided-and-disclosed, T2 report; RE-HOMED panel-shell T10b): the draft
/// SURVIVES a hide/re-summon (the shell hides, never closes — the view stays mounted) and DROPS
/// on navigate-away (the detail switch tears the page down) — unchanged from T2's original
/// ruling. What changed is WHERE it lives: T2's `@State private var draft` did not survive
/// `ShellRootView`'s `.maximized` teardown of `detail` (a THIRD trigger for "the view gets torn
/// down and rebuilt", one T2 never had to consider), so the draft is hoisted onto
/// `host.newChatDraft` instead — mirroring `FieldStateAdapter.composerDraft`'s own precedent for
/// the live composer. `host` outlives `detail` entirely (it's constructed before `ShellRootView`
/// even exists — see `ShellSessionHost`'s own type doc), so the draft now survives ALL THREE
/// triggers; `ShellSessionHost.apply(destination:)`'s `.newChat` case clears it on a genuine fresh
/// arrival, which is what still makes it drop on navigate-away — "no second draft store to drift"
/// no longer applies verbatim (there IS a second store now, `host` itself), but "the page is one
/// keystroke away from anywhere" still holds, and drop-on-navigate-away is unchanged behavior,
/// not a new one.
struct NewChatPage: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var host: ShellSessionHost
    /// The announcement strip's content. `nil`/blank shows the day's tip instead
    /// (`newChatAnnouncement`). Injected rather than fetched: nothing publishes announcements yet,
    /// and the slot should be ready for whatever eventually does without this view knowing about
    /// it — a settings key, a release note, the daemon.
    var announcement: String? = nil

    /// panel-shell T10b: no longer `@State` — see the type doc above and `host.newChatDraft`'s
    /// own doc. `draftBinding` below is the Binding-compatible wrapper the composer actually
    /// consumes, mirroring `FieldStateAdapter.draftBinding`'s identical shape.
    private var draftBinding: Binding<String> {
        Binding(get: { host.newChatDraft }, set: { host.newChatDraft = $0 })
    }
    /// The card's mode segment. View-local: it selects nothing real yet (the create is always a
    /// chat), which is exactly why sending is refused while it sits on an unbuilt mode rather than
    /// quietly creating something else — `newChatSendBlockedReason`.
    @State private var mode: SessionMode = .chat
    /// Whether the pointer is over the composer card — drives its rim only. See the rim's own note
    /// for why this is hover and not focus.
    @State private var composerHovered = false
    /// The greeting and announcement lines this page opened with. Picked ONCE in `.onAppear`, not
    /// per redraw: the page is torn down on navigate-away and rebuilt on return, so "once per
    /// appearance" is exactly the user's "every time a new chat page or the app is opened", while
    /// a per-redraw pick would reshuffle the words under you as you type.
    @State private var greetingLine = ""
    @State private var announcementLine = ""

    var body: some View {
        // Reference-measured gaps, and they DIFFER — greeting→card ~33 pt, card→chips ~22 — so a
        // single uniform stack spacing cannot produce both. The greeting carries the extra.
        VStack(spacing: 20) {
            Spacer(minLength: 0)
            greeting
                .padding(.bottom, 12)
            composerCard
            // The suggestions step aside the moment there is a draft (user call, 2026-08-07) —
            // in BOTH modes. They exist to get you started; once you have started they are just
            // something else on the page.
            if host.newChatDraft.isEmpty {
                starters
                    .transition(.opacity)
            }
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
        // A fresh greeting and a fresh line per appearance. Guarded on empty rather than assigned
        // unconditionally: `onAppear` can fire again for the same live page (a window re-show),
        // and re-rolling the words while someone is mid-thought would be worse than repeating one.
        .onAppear {
            if greetingLine.isEmpty {
                greetingLine = newChatGreetings(hour: newChatGreetingHour(Date()))
                    .randomElement() ?? ""
            }
            if announcementLine.isEmpty {
                announcementLine = newChatAnnouncementLines.randomElement() ?? ""
            }
        }
        .animation(.easeOut(duration: 0.15), value: host.newChatDraft.isEmpty)
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
            // Norma's own brand mark, ACCENT-TINTED — the reference sets its mark in the brand
            // colour beside the greeting, and this is that treatment with our mark and our teal.
            //
            // The VECTOR asset (`BrandMark`, the scale-burst SVG with
            // `preserves-vector-representation`), not the menu bar's `mb-idle`: that one is an
            // 18×18 PNG authored for a status item, so drawing it at 30 pt upscaled it ~1.7× and
            // it read visibly soft. A vector has no native size to outgrow. The app icon is no use
            // either — full-colour artwork on a white tile reads as an icon pasted onto the page
            // rather than as a mark, and cannot be tinted.
            Image("BrandMark")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: 36, height: 36)
                .foregroundStyle(Theme.accent)
            Text(greetingLine)
                .font(Theme.greeting)
                // `inverseCanvas`, not `.primary` — the reference sets its greeting in a WARM dark
                // rather than near-black, and this token is precisely "the base plane of the
                // opposite appearance", so it softens the line in light mode and brightens it in
                // dark by the same construction. `.primary` reads as a hard near-black here.
                .foregroundStyle(Theme.inverseCanvas.opacity(0.72))
        }
        .multilineTextAlignment(.center)
    }

    /// The prompt starters below the card (the reference's own row). Each PREFILLS the composer
    /// and focuses it — real behaviour, not a placeholder: a starter needs no session and no
    /// backend, so there was no reason to fake it.
    /// Chat's starter chips, or Cowork's idea list — never both. Cowork's tasks do not fit on a
    /// chip, which is why the reference changes shape here rather than just changing the words.
    @ViewBuilder
    private var starters: some View {
        if newChatShowsCoworkControls(mode: mode) {
            coworkIdeas
        } else {
            HStack(spacing: 10) {
                ForEach(newChatStarters, id: \.title) { starter in
                    NewChatStarterChip(starter: starter) { host.newChatDraft = starter.prefill }
                }
            }
        }
    }

    /// Cowork's "Ideas for you" — a vertical list with a trailing mode tag, the reference's shape.
    private var coworkIdeas: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Ideas for you")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
            ForEach(newChatCoworkIdeas, id: \.title) { idea in
                NewChatIdeaRow(idea: idea) { host.newChatDraft = idea.prefill }
            }
        }
        .frame(width: newChatCardWidth, alignment: .leading)
    }

    /// The composer — now the SHARED `NormaComposerCard`, the same component the live chat page
    /// renders (user call, 2026-08-07). This page owns only what is specific to it: the deferred
    /// create's in-flight state, and the mode segment being interactive because no session exists
    /// yet to have a fixed mode.
    private var composerCard: some View {
        let ui = newChatSendUI(host.newChatCreate)
        return NormaComposerCard(
            text: draftBinding,
            onSubmit: submit,
            mode: $mode,
            // No session exists yet — the create happens on the first send — so there is nothing to
            // set an approval policy ON. The permissions row is therefore ABSENT here rather than
            // present-and-dead (mac-chat-parity Task 6, spec §4); this page's own chat/cowork modes
            // carry no permissions band in any case.
            policy: nil,
            stripEdge: .below,
            announcement: newChatAnnouncement(announcement, fallback: announcementLine),
            isEnabled: ui.composerEnabled,
            showsWorkingIndicator: ui.showsWorkingIndicator,
            sendBlockedReason: newChatSendBlockedReason(draft: host.newChatDraft, mode: mode)
        )
    }

    /// First send = the create-on-send flow (spec §2): exactly ONE `session.create` (mode chat,
    /// no cwd), then attach, then the typed text as the first message — `sendFirstChatMessage`
    /// owns the whole sequence and the double-send guard; on success the shell navigates onto the
    /// live session (the composer content carries — the host seeds the attached adapter's draft
    /// until the send lands, so there is no empty-composer flicker and no lost text).
    private func submit() {
        host.sendFirstChatMessage(host.newChatDraft) { sessionId in
            nav.navigate(to: .session(sessionId))
        }
    }
}
