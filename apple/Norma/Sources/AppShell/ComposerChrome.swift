import SwiftUI

/// How far a composer control dims while its own RPC is out — the one "busy" treatment the composer
/// has, shared so a second busy control cannot pick a different number.
///
/// Deliberately **not** a `Theme` entry (mac-chat-parity Task 8, which inherited it from Task 6 as a
/// bare `0.55` inline): `docs/brand.md` governs colour and type, and its § 3.1 anti-rule is about
/// never *deriving* a colour at runtime — a named asset owns the value instead. This is neither. It
/// is an alpha applied to a whole control to say "working", it has no light/dark halves to author,
/// and putting it in the palette would make `Theme` a general constants bag. Named here, next to the
/// only rule that reads it. Tune-at-gate: whether 0.55 reads as "working" rather than "broken" is a
/// live-gate question (Task 6 recorded it as one).
let composerBusyControlOpacity: Double = 0.55

// MARK: - The per-mode composers

/// mac-chat-parity Task 5 — **a composer per mode**, on the user's architecture ruling
/// (2026-08-12): *"each mode should have its own dedicated composer which can also have different
/// styling and maybe more features. but yes chat shouldnt show that row"*.
///
/// One mode's chrome is written in ONE type here, and nowhere else. `NormaComposerCard` — the
/// shared shell — holds the parts every mode has in common (the text field, the control row's fixed
/// buttons, the send button, the card's surface and hover rim) and knows nothing about modes at all;
/// the only mode → composer decision in the app is `composerChrome(_:)` below.
///
/// ## The shape, and why this one rather than four separate `View` types
///
/// The brief allowed either "distinct composer types" or "a mode-parameterised assembly with
/// per-mode chrome blocks". This is the second, and the reason is not taste — it is **view
/// identity**, measured against the one place `mode` changes while a composer is mounted:
///
/// The new-chat page's Chat/Cowork segment writes `mode` inside
/// `withAnimation(.easeInOut(duration: 0.24))` (`ComposerModeSegment` below). If each mode were its
/// own `View` type, the call site would need `switch mode { case .chat: ChatComposer() … }`, which
/// puts the modes in **different ViewBuilder branches** — SwiftUI gives those distinct structural
/// identity, so toggling the segment would tear down and rebuild the whole composer. Two live costs,
/// both on a surface the plan is judged on: the `NSTextView` inside `ComposerTextView` is recreated
/// (first responder lost mid-typing), and the band's slide-out — a documented deliberate effect
/// ("Animating THIS is the whole effect", `NormaComposerCard`) — has nothing to interpolate across
/// an identity change.
///
/// Handing the shell a per-mode chrome **value** keeps the shell one view instance across every
/// mode, so the field keeps focus and the band still animates, while each mode's chrome still lives
/// in its own type that nothing else can reach into. `AnyView` is the codebase's existing answer to
/// exactly this problem — `PanelTab`'s `makeChrome() -> AnyView` / `makeContent() -> AnyView`
/// (`PanelTab.swift:40-46`), the "tab-content boundary written ONCE".
///
/// ## One file today
///
/// Three of these are a handful of lines; splitting four short types across four files would hide
/// the shape rather than show it. A mode whose chrome grows moves to its own file **without
/// touching the others** — that is the property the split buys, and it does not depend on where the
/// types sit today.
///
/// Task 6's permissions row (spec §4) stayed here for a different reason than the others: it is not
/// one mode's chrome but the band **two** modes share, so it belongs beside the two types that
/// choose it rather than in a file of its own. It is also what a test scan holds to this file —
/// `ComposerStrip(` may be constructed nowhere else, because a band built in the shared shell would
/// reach every mode, chat included, with every value-level pin still green
/// (`ComposerChromeTests.testTheStripTypeIsConstructedOnlyWhereChromeIsDecided`).

// MARK: - What a chrome block may draw from

/// The card's own inputs, handed to the per-mode chrome whole.
///
/// Whole rather than parameter-by-parameter so that a mode wanting a new input adds a field here
/// once, instead of a parameter to four initialisers — the shape that makes "maybe more features"
/// cheap for whoever adds them.
///
/// `mode` is the **binding**, not the value: the new-chat page's segment writes back through it.
/// `composerChrome(_:)` reads its current value to pick the chrome, so there is exactly one source
/// of the mode and no way for the context and the chrome to disagree about which one it is.
struct ComposerContext {
    let mode: Binding<SessionMode>
    /// Whether the Chat/Cowork segment can be CHANGED. False on a live session — a session's mode is
    /// fixed at creation and Norma has no mode-switch.
    let modeIsSelectable: Bool
    /// The permissions row's wiring (mac-chat-parity Task 6, spec §4), or `nil` from a surface with
    /// no session to set a policy on — the new-chat page, whose session does not exist until the
    /// first send. `nil` makes the row ABSENT rather than dead, the same rule chat's row follows.
    ///
    /// Task 5's handoff shape: a mode wanting an input the others do not adds ONE field here rather
    /// than a parameter to four initialisers.
    ///
    /// **Task 7's model/effort slot did NOT land here, and the shape is worth stating.** It expected
    /// to; it turned out that no chrome consumes it. The chip is drawn by the shared shell for every
    /// mode (the slot has always been shared — see `NormaComposerCard.controlRow`), so its CONTROL
    /// is a card parameter (`NormaComposerCard.model`) and only its one per-mode question — may this
    /// mode select a tier? — is a chrome member (`offersClientEffortTiers`). This context carries
    /// what a chrome READS; that control is not read by one.
    let policy: ComposerPolicyControl?
    /// The cowork strip's trailing line. Only `CoworkComposerChrome` reads it.
    let announcement: String
}

// MARK: - The permissions row (mac-chat-parity Task 6, spec §4)

/// What a surface hands the composer so its permissions row can BE a control rather than a picture.
///
/// `policy` is an `Optional` and that optional **is** mac-chat-parity Task 4's `sessionPolicyKnown`,
/// collapsed at this one boundary: `nil` = the daemon has not told us this session's policy (its row
/// has not loaded, or the daemon predates the field). Task 4 kept the adapter's own pair as
/// (`sessionPolicy`, `sessionPolicyKnown`) because its existing consumers compare a plain `String`;
/// here — the one surface that makes a STANDING claim — the Optional is what makes "render no label
/// while unknown" a thing the row cannot forget rather than a thing someone must remember.
///
/// `onSet` is called with the raw wire string. It forwards to the surface's `onSetPolicy`, which
/// owns the in-flight/adopt bookkeeping — the same convention the two pickers and the three respond
/// callbacks already use.
struct ComposerPolicyControl {
    let policy: String?
    let changeInFlight: Bool
    let onSet: (String) -> Void
}

/// PURE: everything the permissions row shows and offers.
///
/// It rides on `ComposerStrip.Kind` as the case's payload — this plan's own Task 1 precedent
/// ("the result on the TOOL CASE, not sibling fields") — for a reason specific to this codebase:
/// SwiftUI bodies are not exercised in tests here, so a band whose contents were only inside its
/// `AnyView` would have no assertable form at all. On the case, "dispatch offers five policies" and
/// "no label while the daemon has not said" are values a test can read.
struct ComposerPermissionsRow: Equatable {
    /// The policies THIS mode may be set to. Code's is all six; dispatch's is all but `plan`. Chosen
    /// by each mode's own chrome — there is no `switch mode` here or anywhere below it.
    let offers: [String]
    /// The policy to DISPLAY, or `nil` when the daemon has not said (see `ComposerPolicyControl`).
    let showing: String?
    /// True while a `session.setPolicy` is in flight.
    let changeInFlight: Bool

    /// What the chip reads.
    ///
    /// **Never a policy name while `showing == nil`** — the row is persistent, so naming the `"auto"`
    /// placeholder would be a standing claim about how much the agent may do unattended, for a
    /// session nobody has asked. It names the CONTROL instead: not knowing yet is a different thing
    /// from having no control, and a blank chip would say the second.
    var chipTitle: String {
        guard let showing else { return "Approval mode" }
        return isDangerous ? "⚠ \(policyDisplayLabel(showing))" : policyDisplayLabel(showing)
    }

    /// `bypass` and only `bypass` (`isPolicyDangerous`) — the treatment the picker rows have always
    /// carried, now also on the persistent chip, which is where spec §4 says it matters most: a
    /// session quietly running `bypass` must look like one without opening anything.
    var isDangerous: Bool { showing.map(isPolicyDangerous) ?? false }

    /// One change at a time — the same single-flag discipline `policyChangeInFlight` documents.
    var isEnabled: Bool { !changeInFlight }

    /// Dimmed while a change is in flight, so the wait is VISIBLE and not merely a click that does
    /// nothing. (`ShellSidebarRowStyle` draws no disabled state of its own, so `.disabled` alone
    /// would refuse the click while looking exactly like a chip that works.)
    var chipOpacity: Double { isEnabled ? 1 : composerBusyControlOpacity }

    /// The chip's hover line and accessibility label.
    var help: String {
        if changeInFlight { return "Changing approval mode…" }
        guard let showing else { return "Approval mode — not known for this session yet" }
        return "Approval mode: \(policyDisplayLabel(showing))"
    }
}

/// The band behind the composer card — the second surface that slides out from underneath it.
///
/// `nil` from `makeStrip()` means the block is **absent**, not disabled: chat has no band at all,
/// rather than a greyed-out one. That distinction is the user's ruling expressed in the type.
struct ComposerStrip {
    /// What this band IS. Named rather than anonymous so a test can say which strip a mode carries
    /// without rendering it, and so the permissions row is a **labelled** hook — which is what lets
    /// chat's absence be a statement about a specific thing rather than about nothing.
    enum Kind: Equatable {
        /// Cowork's two unwired chips (working folder, approval mode) plus the announcement.
        case coworkPlaceholders
        /// The approval-policy row (mac-chat-parity Task 6, spec §4) — code's and dispatch's band.
        /// Carries what it shows and offers; see `ComposerPermissionsRow` for why on the case.
        case permissions(ComposerPermissionsRow)
    }

    let kind: Kind
    /// How far the band protrudes past the composer. The composer's own height never changes — a
    /// standing ruling — so this is the only thing that moves.
    let height: CGFloat
    let content: AnyView
}

/// What ONE mode adds to (or answers for) the shared composer shell.
///
/// Everything not named here is shared and unconditional in `NormaComposerCard`, so "the text field
/// and the send button are identical across modes" is true by construction rather than by
/// discipline. A mode that later needs its own send treatment adds a member here — visibly, in one
/// place, for all four modes at once. There are deliberately NO protocol-extension defaults: a new
/// mode must decide every member rather than inherit one silently.
protocol ComposerChrome {
    /// Which mode this chrome is for. Hard-coded per type rather than stored, so it names the type's
    /// identity and cannot be constructed disagreeing with itself.
    var mode: SessionMode { get }

    /// mac-chat-parity Task 7 (spec §5): whether this mode may select a **Norma-level effort tier**.
    ///
    /// **A boolean, because the mode-dependence of model/effort is exactly one row.**
    /// `CLIENT_EFFORTS` is a one-element list — `["ultra"]` (`packages/core/src/settings.ts:51`) —
    /// and `clientEffortEligible` is a fail-closed code-only allowlist (`settings.ts:89-91`). The
    /// WIRE efforts (`none/low/medium/high/xhigh/max`) are not mode-gated at all: they are validated
    /// against the MODEL (`assertEffortSelectable`, `packages/core/src/ipc/server.ts:476-489`). So a
    /// per-mode effort LIST would invent a distinction the daemon does not make.
    ///
    /// It is a chrome member rather than a check inside the shell because the shell holds no mode
    /// conditional — and a helper-shaped one (`availableEfforts(for: mode)`) is precisely what
    /// `ComposerChromeTests.testTheSharedShellHoldsNoModeConditionals` cannot see. Each type answers
    /// it with `effortTiersAreOffered` — the header's own decision function, the Swift mirror of
    /// `clientEffortEligible` — so the two doors onto this rule can never drift.
    var offersClientEffortTiers: Bool { get }

    /// The control row's leading accessory, drawn after the Attach button. `nil` = absent.
    func makeControlRowAccessory() -> AnyView?

    /// The band behind the composer. `nil` = absent.
    func makeStrip() -> ComposerStrip?
}

/// **The one mode → composer mapping in the app.**
///
/// Exhaustive over `SessionMode` on purpose: `case .cowork` is how "cowork is a named slot, not
/// built" becomes a compile-time obligation rather than a note — a mode added to `SessionMode` fails
/// this switch until someone decides what its composer is.
func composerChrome(_ context: ComposerContext) -> any ComposerChrome {
    switch context.mode.wrappedValue {
    case .chat: return ChatComposerChrome(context: context)
    case .code: return CodeComposerChrome(context: context)
    case .dispatch: return DispatchComposerChrome(context: context)
    case .cowork: return CoworkComposerChrome(context: context)
    }
}

// MARK: - Chat

/// Chat's composer: the Chat/Cowork segment, and **no band**.
///
/// The absent band is the user's ruling and spec §3's table. It is absent rather than disabled
/// because there is nothing behind it to enable: the daemon refuses `session.setPolicy` for a chat
/// target outright — *"chat sessions have a fixed policy and cannot be changed — chat never asks
/// permissions"* (`packages/core/src/ipc/server.ts:1525`) — and the method is deliberately off
/// `REMOTE_ALLOWED_METHODS` for the same reason. Chat's policy is resolved internally every turn
/// regardless of the stored row, so a row here could only ever show a value that is not in force and
/// offer changes that are all RPC errors.
///
/// The same gate already exists twice on this screen (`WindowContentView`'s ⋯ button and
/// `WorkSidebar`'s Options block, both gated on `adapter.isChatSession`); this type is the third
/// expression of it, and the only structural one — Task 6 could not give chat a row without editing
/// this type, and could not sneak one in through the shared shell either, because the strip type may
/// be constructed only in this file (see this file's own doc, and the scan it names).
struct ChatComposerChrome: ComposerChrome {
    let context: ComposerContext
    var mode: SessionMode { .chat }

    /// No tiers: `session.setEffort` refuses one for anything but a code session, and this page's
    /// own create would be refused outright with one held (`assertEffortSelectable` runs on
    /// `session.create` too) — chat never offering it is what keeps the new-chat page's Send working.
    var offersClientEffortTiers: Bool { effortTiersAreOffered(mode: mode.rawValue) }

    func makeControlRowAccessory() -> AnyView? { AnyView(ComposerModeSegment(context: context)) }

    func makeStrip() -> ComposerStrip? { nil }
}

// MARK: - Code

/// Code's composer: the full surface — the permissions row over the shared shell. The mode segment
/// is absent because a code session is neither of the two modes that segment offers.
///
/// **All six policies** (spec §3's table): `session.setPolicy` settles every one of them for a code
/// target — it refuses only a chat target outright, and only `plan` for a dispatch one
/// (`packages/core/src/ipc/server.ts:1524-1529`). Task 7 adds the model/effort wiring.
struct CodeComposerChrome: ComposerChrome {
    let context: ComposerContext
    var mode: SessionMode { .code }

    /// **The one mode that may select a Norma-level tier** (`clientEffortEligible`, code-only).
    var offersClientEffortTiers: Bool { effortTiersAreOffered(mode: mode.rawValue) }

    func makeControlRowAccessory() -> AnyView? { nil }

    func makeStrip() -> ComposerStrip? {
        permissionsStrip(offering: sessionPolicyModes, context.policy)
    }
}

// MARK: - Dispatch

/// Dispatch's composer. Reached through `DispatchSurface.swift:97` → `ShellSessionView` →
/// `WindowContentView`, the same card the sidebar's sessions get.
///
/// **A permissions row too, minus one row:** `session.setPolicy` refuses exactly `"plan"` for a
/// dispatch target — *"dispatch never asks permissions"*
/// (`packages/core/src/ipc/server.ts:1527-1528`) — while the other five are settable, so this row
/// offers `dispatchSettablePolicyModes`. That is the opposite shape from model/effort, which
/// dispatch pins entirely (`ipc/server.ts:1567`/`:1610`); Task 7 keeps the header's existing
/// shown-but-refused behaviour there rather than regressing it.
///
/// The one row is also why this type is separate from `CodeComposerChrome`, which was Task 5's
/// argument for splitting them a task before the difference existed: merging them then would have
/// meant splitting them again now.
struct DispatchComposerChrome: ComposerChrome {
    let context: ComposerContext
    var mode: SessionMode { .dispatch }

    /// No tiers — and note this is a DIFFERENT refusal from the row above: the daemon pins dispatch's
    /// model and effort entirely for non-null values (`DISPATCH_PIN_MESSAGE`, `ipc/server.ts`), while
    /// the header has always SHOWN both menus and let the daemon answer. Task 7 keeps that
    /// shown-but-refused posture rather than regressing it to absent (spec §3's table).
    var offersClientEffortTiers: Bool { effortTiersAreOffered(mode: mode.rawValue) }

    func makeControlRowAccessory() -> AnyView? { nil }

    func makeStrip() -> ComposerStrip? {
        permissionsStrip(offering: dispatchSettablePolicyModes, context.policy)
    }
}

/// The permissions band, built the same way for both modes that have one — each supplying its own
/// `offers`. Shared as a function rather than by a shared base type so the only thing a mode states
/// is the thing that actually differs between them.
///
/// `nil` control → `nil` strip: a surface that wired no policy control (the new-chat page, which has
/// no session to set a policy on) gets **no band**, not a chip that cannot do anything. Chat's
/// absent-rather-than-disabled rule, applied to the other absence.
private func permissionsStrip(offering offers: [String],
                              _ control: ComposerPolicyControl?) -> ComposerStrip? {
    guard let control else { return nil }
    let row = ComposerPermissionsRow(offers: offers,
                                     showing: control.policy,
                                     changeInFlight: control.changeInFlight)
    return ComposerStrip(kind: .permissions(row),
                         height: newChatComposerStripHeight,
                         content: AnyView(ComposerPermissionsStrip(row: row, onSelect: control.onSet)))
}

/// The permissions band's content: one chip on the composer's own leading column, and space.
///
/// Laid out exactly like `CoworkComposerStrip` below — same 18 pt inset, same band height, same chip
/// — because it is the same band, seen on a different mode. Spec §4's "measured recipe already in
/// the tree", reused rather than re-measured.
struct ComposerPermissionsStrip: View {
    let row: ComposerPermissionsRow
    let onSelect: (String) -> Void

    var body: some View {
        HStack(spacing: 10) {
            ComposerPolicyChip(row: row, onSelect: onSelect)
            Spacer(minLength: 12)
        }
        // Matches the control row's inset, so the chip's glyph lands on the same column as the plus.
        .padding(.horizontal, 18)
        .frame(height: newChatComposerStripHeight)
    }
}

/// The permissions chip and the picker behind it.
///
/// The picker is `PolicyPickerRow` (`WorkSidebar.swift`) — the same rows the header's ⋯ popover and
/// the WorkSidebar's Options block render, which is why that implementation moved off
/// `extension WindowContentView` in this task.
///
/// Selecting a row does **not** dismiss the popover, matching the ⋯ menu it shares its rows with:
/// the open menu is where a change in flight is most visible (every row disables, and the checkmark
/// moves only once the daemon has confirmed), and closing it would hide exactly that.
struct ComposerPolicyChip: View {
    let row: ComposerPermissionsRow
    let onSelect: (String) -> Void

    /// Local presentational state, the convention every other picker on this screen follows
    /// (`WindowContentView.showingPolicyMenu` and its four siblings).
    @State private var showingMenu = false

    var body: some View {
        NewChatControlChip(systemImage: "hand.raised",
                           title: row.chipTitle,
                           label: row.help,
                           titleStyle: row.isDangerous ? AnyShapeStyle(.red) : AnyShapeStyle(.primary),
                           action: { showingMenu = true })
            .opacity(row.chipOpacity)
            .disabled(!row.isEnabled)
            .popover(isPresented: $showingMenu, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Approval mode")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 4)
                    ForEach(row.offers, id: \.self) { policy in
                        PolicyPickerRow(policy: policy,
                                        current: row.showing,
                                        isDisabled: row.changeInFlight,
                                        onSelect: onSelect)
                    }
                }
                .padding(12)
                .frame(minWidth: 160)
            }
    }
}

// MARK: - Cowork — the named slot

/// **Cowork's composer is a named slot, not a built one.**
///
/// Cowork has no daemon mode at all: `SessionMode.isAvailable == false`
/// (`ShellNavigation.swift:47-52`), `session_spawn` pre-flight-rejects it, and a live session can
/// therefore never be cowork — this chrome is reachable only from the new-chat page, whose segment
/// can be moved to Cowork so the design is visible while `newChatSendBlockedReason` refuses to send.
///
/// So it renders exactly what it rendered before this task — the two unwired chips and the
/// announcement — and nothing more. Whoever ships cowork edits this one type: the strip's content,
/// its `Kind`, and whatever else the mode turns out to need.
struct CoworkComposerChrome: ComposerChrome {
    let context: ComposerContext
    var mode: SessionMode { .cowork }

    /// No tiers: cowork is not code, and `effortTiersAreOffered` is an allowlist — a mode nobody has
    /// written yet gets nothing for free.
    var offersClientEffortTiers: Bool { effortTiersAreOffered(mode: mode.rawValue) }

    func makeControlRowAccessory() -> AnyView? { AnyView(ComposerModeSegment(context: context)) }

    func makeStrip() -> ComposerStrip? {
        ComposerStrip(kind: .coworkPlaceholders,
                      height: newChatComposerStripHeight,
                      content: AnyView(CoworkComposerStrip(announcement: context.announcement)))
    }
}

/// Cowork's band content — moved here verbatim from `NormaComposerCard.coworkStrip`, unchanged.
/// Both chips stay placeholders and stay labelled as such (spec §8: Attach and Dictate, and these,
/// remain out of scope for v1).
struct CoworkComposerStrip: View {
    let announcement: String

    var body: some View {
        HStack(spacing: 10) {
            NewChatControlChip(systemImage: "folder", title: "Project or folder",
                               label: "Working folder (not wired yet)")
            // "Approval mode", not "Ask": the title was a POLICY NAME on a page with no session to
            // have one — a small standing claim of exactly the kind Task 6 removed from the real
            // row next door. It now wears that row's own unknown-case treatment
            // (`ComposerPermissionsRow.chipTitle`), which is what a control that does not yet know
            // its value looks like. Still a placeholder, still labelled as one.
            NewChatControlChip(systemImage: "hand.raised", title: "Approval mode",
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
        .frame(height: newChatComposerStripHeight)
    }
}

// MARK: - The Chat/Cowork segment (shared by the two modes that segment contains)

/// The Chat/Cowork segmented control — moved here verbatim from `NormaComposerCard.modeSegment`,
/// unchanged.
///
/// Shared between `ChatComposerChrome` and `CoworkComposerChrome` **by composition**: both construct
/// this type. That is the difference the ruling is about — the segment is offered by the two modes
/// that want it, rather than drawn by one view that asks whether the mode is one of them.
struct ComposerModeSegment: View {
    let context: ComposerContext

    var body: some View {
        HStack(spacing: 2) {
            ForEach(newChatModeOptions, id: \.self) { option in
                let isSelected = option == context.mode.wrappedValue
                Button {
                    guard context.modeIsSelectable else { return }
                    withAnimation(.easeInOut(duration: 0.24)) { context.mode.wrappedValue = option }
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
                .help(context.modeIsSelectable
                      ? (option.isAvailable ? option.title : "\(option.title) — not built yet")
                      : "This session is \(context.mode.wrappedValue.title.lowercased()) — a session's mode is fixed when it is created")
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.controlSurface)
        )
    }
}
