import AppKit
import SwiftUI

/// v1 port (TextField/ComposerTextView.swift, 437 lines), stripped for 2c's text-only field:
/// every `ComposerImageItem`/image-paste path and `SelectedTextContext` reference is gone (no
/// paste override, no appearanceStyle/accentColor/isEditable/caret-line-navigation surface —
/// those existed to support v1's image chips and cross-widget arrow-key navigation, neither of
/// which apply here). What's kept, verbatim in spirit:
///   - `doCommand(by:)` Enter-submits / Shift+Enter-inserts-newline (v1 CommandTextView:418-430).
///   - NSScrollView wrapping the NSTextView (D7: no custom scrollWheel — the scroll view does
///     the work natively).
///   - Focus plumbing: simplified from v1's `isFocused` binding (driven by a focus coordinator
///     that doesn't exist in 2c) to "always try to become first responder" — the field has
///     exactly one editable surface, so there's no cross-widget focus to arbitrate.
///   - Placeholder rendering: moved OUT of this view into `FieldView`, which overlays a plain
///     SwiftUI `Text` when `text.isEmpty` — v1 didn't have composer placeholder text at all
///     (its "placeholder" was an image-capture pill), so there's no v1 shape to port here.
///
/// Task B (v1 field transplant, window choreography) adds back v1's `onContentHeightChange`
/// (`TextField/ComposerTextView.swift:39,301-315`, verbatim measurement: laid-out text height
/// via `NSLayoutManager.usedRect(for:)` plus the container's vertical insets, deduped to >0.5pt
/// changes) so `NormaFieldView`'s composer pill can grow with typed/wrapped text instead of
/// sitting fixed at `composerMinHeight`.
struct ComposerTextView: NSViewRepresentable {
    /// Single source of truth for the text container's inset — `makeNSView` applies these exact
    /// values to the real `NSTextView`, and `NormaFieldView`'s placeholder overlay (gate wave-3
    /// text-alignment fix) reads the SAME constants so "Ask Norma…" starts flush with where the
    /// real caret/first glyph renders instead of drifting off and overlapping it.
    static let textContainerInset = NSSize(width: 2, height: 4)
    static let lineFragmentPadding: CGFloat = 0

    /// The measured content height of a TWO-line draft at the composer's bound size — the
    /// threshold family for "has the draft grown past a couple of lines" checks
    /// (`NormaFieldView.showsClearButton`). Derived from the live face so a ladder change
    /// moves it with the text it measures: heights jump a whole line at a time, so any
    /// consumer comparing `> twoLineContentHeight` fires exactly when the third line arrives,
    /// at every ladder.
    static var twoLineContentHeight: CGFloat {
        NSLayoutManager().defaultLineHeight(for: Typography.sansNS(ofSize: Typography.composerFieldSize)) * 2
            + textContainerInset.height * 2
    }

    @Binding var text: String
    var onSubmit: () -> Void
    var onContentHeightChange: (CGFloat) -> Void = { _ in }
    /// Task 4 (`ChatWindowRootView`): that window is an opaque, normally-colored surface — NOT
    /// under the field's difference-blend LAW (see `textColor`'s doc above) — so its composer
    /// needs real adaptive text/insertion colors instead of the hardcoded `.white` the field
    /// requires. Defaults `false` so the field's own call-site (`NormaFieldView.swift`) is
    /// byte-identical / zero behavior change; only the window opts in.
    var usesAdaptiveColors: Bool = false
    /// The typed text's point size. The default is BOUND to the user-message size (ruling
    /// 2026-08-13: the composer types at the size the sent bubble renders, derived from the
    /// same live metrics, so the two can never diverge). NO home overrides it any more: the
    /// new-chat page's 16-pt opt-up and the orb field's brief hold-at-14 were both retired by
    /// rulings the same day (the final one accepting the orb's +1 pt resting-height
    /// consequence) — `TypographyTests` pins that the orb passes no override at all.
    ///
    /// Anything drawing a PLACEHOLDER over this composer must use the same value, or the text
    /// changes size the moment you type.
    var fontSize: CGFloat = Typography.composerFieldSize
    /// Task 6 (FieldFocus): virtual-focus keyboard chain, consulted first by
    /// `CommandTextView.doCommand(by:)` on ↑/↓/Enter — returning `true` means consumed (the
    /// pre-existing Enter/Shift+Enter contract does NOT run). Defaults `nil` so the chat window's
    /// call-site (`ChatWindowRootView`) is untouched — that surface has real mouse/key focus, no
    /// virtual focus concept in 2d-i (see `FieldFocus.swift`'s header).
    var onFocusKey: ((FieldFocusKey, _ caretAtFirstLine: Bool, _ caretAtLastLine: Bool) -> Bool)?
    /// Task 6 (FieldFocus): fired on every inserted character so typing while the chevron is
    /// virtually focused snaps focus back to the composer. Defaults `nil` for the same reason as
    /// `onFocusKey` above.
    var onTypingRefocus: (() -> Void)?

    /// office-live-ux Job 1: **Esc in the composer**, the CLI's own stop gesture. Returns `true`
    /// when it CONSUMED the key (a turn was running and has been interrupted); `false` leaves the
    /// key to AppKit untouched.
    ///
    /// **Why `keyDown`, not `doCommand(by:)`.** `NSTextView` routes Escape through the key-binding
    /// manager, where it is bound to `complete:` (autocompletion) rather than to
    /// `cancelOperation:` — so a `doCommand` arm would be guessing at which selector arrives.
    /// `keyDown` sees the raw `keyCode == 53` before `interpretKeyEvents(_:)` translates anything,
    /// which is the one place the answer does not depend on a binding table.
    ///
    /// **Why a per-view closure and not a window-level `NSEvent` monitor** (which is what
    /// `DetachedWindowController.installEscMonitor` uses): a local monitor fires AHEAD of
    /// first-responder dispatch — `cardKeyAction`'s own header records that as a measured fact —
    /// so a shell-window monitor would take Esc away from `SidebarSearchPalette`, whose
    /// `.onKeyPress(.escape)` (`SidebarSearchPalette.swift:152`) is the palette's only dismissal.
    /// Hanging it off the composer's own responder scopes it to "the composer has focus", which is
    /// exactly what the requirement asks for and leaves every other Esc consumer alone.
    ///
    /// `nil` (the default) means this surface offers no Esc contract, so every pre-existing call
    /// site — the orb field, the detached window, the new-chat page — is byte-identical.
    var onEscape: (() -> Bool)?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = CommandTextView()
        textView.delegate = context.coordinator
        textView.font = Typography.sansNS(ofSize: fontSize)
        // GATE-3 FIX (F2): this composer is rendered inside `NormaFieldView.composerOrResponseContent`,
        // which is wrapped in `.modifier(GlassForegroundLegibility())` — `.blendMode(.difference)`
        // against the glass surface beneath (see that type + `GlassChromeColor`'s doc). Difference
        // inverts cleanly ONLY against a pure-white source (`white − bg = inverse(bg)`); v1's own
        // `composerForegroundColor` (TextField/ComposerTextView.swift) hardcodes `.white` for exactly
        // this reason and documents the failure mode by name: "`.labelColor` would be ... already the
        // inverse of the typical glass tone — so subtracting it from the background would produce
        // near-white in both modes (the washed-out 'full white' symptom)" — i.e. typed text renders
        // invisible. `.labelColor` here was the transplant regression; `.white` restores v1 parity.
        textView.textColor = usesAdaptiveColors ? .labelColor : .white
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.drawsBackground = false
        textView.textContainerInset = Self.textContainerInset
        textView.textContainer?.lineFragmentPadding = Self.lineFragmentPadding
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.heightTracksTextView = false
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.typingAttributes = [
            .font: textView.font ?? Typography.sansNS(ofSize: fontSize),
            .foregroundColor: usesAdaptiveColors ? NSColor.labelColor : NSColor.white
        ]
        // The caret is NORMA'S accent (user call, 2026-08-07 — every cursor in the app one colour),
        // never `.controlAccentColor`: that is whatever the user picked in System Settings, so it
        // rendered in an unrelated colour (yellow, in the report that prompted this) and read as a
        // bug rather than a theme. SwiftUI text fields get the same colour from the shell's
        // `.tint(Theme.accent)`.
        //
        // The FIELD (`usesAdaptiveColors == false`) is the one exception, and not by preference:
        // that surface renders under `GlassForegroundLegibility`'s `.blendMode(.difference)` (see
        // `textColor` above), which inverts whatever colour is set — an accent caret there would
        // come out as its inverse, i.e. a different colour from every other caret, which is the
        // opposite of what was asked. White is what survives that blend, so it stays.
        textView.insertionPointColor = usesAdaptiveColors
            ? (NSColor(named: "AccentColor") ?? .labelColor)
            : .white
        textView.string = text
        textView.onSubmit = onSubmit
        textView.onFocusKey = onFocusKey
        textView.onTypingRefocus = onTypingRefocus
        textView.onEscape = onEscape

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.documentView = textView

        DispatchQueue.main.async { [weak textView] in
            guard let textView else { return }
            // Live-gate fix D: yield to whatever text input the user is already in. A composer
            // MOUNTING is not a reason to take the caret out of a field somebody is typing in — the
            // panel opening beside a focused URL bar is exactly that case.
            if let window = textView.window,
               composerShouldClaimFirstResponder(current: window.firstResponder, composer: textView) {
                _ = window.makeFirstResponder(textView)
            }
            context.coordinator.reportHeight(textView)
        }
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? CommandTextView else { return }
        context.coordinator.parent = self
        textView.onSubmit = onSubmit
        textView.onFocusKey = onFocusKey
        textView.onTypingRefocus = onTypingRefocus
        // office-live-ux Job 1: re-assigned on EVERY update, exactly like the three above it. The
        // closure captures `adapter.turnRunning` freshly at CALL time (it asks the host, it does
        // not hold a Bool), but the closure OBJECT still has to be refreshed here or a card rebuilt
        // against a new attachment would keep interrupting the previous session.
        textView.onEscape = onEscape
        // Keep the live view in step if the size changes across an update — otherwise the font
        // would be whatever `makeNSView` happened to set the first time this view was built.
        if textView.font?.pointSize != fontSize {
            textView.font = Typography.sansNS(ofSize: fontSize)
        }
        if textView.string != text {
            textView.string = text
        }
        textView.textContainer?.containerSize = NSSize(
            width: max(1, nsView.contentSize.width),
            height: .greatestFiniteMagnitude
        )
        context.coordinator.reportHeight(textView)

        // **The re-claim, and live-gate fix D's main site.**
        //
        // This runs on EVERY SwiftUI update pass of the composer, and in the shell those are
        // constant: the 5-second `session.list` poll republishes `SessionDirectory.rows`, every
        // streamed delta republishes `SessionModel.state`, and `FieldStateAdapter` is an
        // `@ObservedObject` of the view that owns this. Before this fix the re-claim was
        // unconditional — "if I am not first responder, become it" — so any of that churn arriving
        // while the user typed in the panel's URL field pulled the caret into the composer, one or
        // two keystrokes in. That is the user's report exactly, and it is why the predicate is
        // consulted INSIDE the hop: the responder can change between the update pass and the block.
        //
        // The resting behaviour is deliberately unchanged — with the window, a button or a scroll
        // view as first responder the composer still claims, which is the premise `isTextEditing
        // Focused` (`NormaComposerCard.swift`) is written against and `CardWiringTests` pins.
        DispatchQueue.main.async { [weak textView] in
            guard let textView, let window = textView.window,
                  composerShouldClaimFirstResponder(current: window.firstResponder, composer: textView)
            else { return }
            _ = window.makeFirstResponder(textView)
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        private var lastReportedHeight: CGFloat = -1

        init(_ parent: ComposerTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            reportHeight(textView)
        }

        /// v1 port (`TextField/ComposerTextView.swift:301-315`, verbatim measurement): the
        /// laid-out text height plus the container's vertical insets, so the composer starts
        /// single-line and grows as the user writes instead of reserving multi-line space up
        /// front. Deduped (>0.5pt) so tiny rounding jitter doesn't spam `onContentHeightChange`.
        func reportHeight(_ textView: NSTextView) {
            guard let layoutManager = textView.layoutManager,
                  let container = textView.textContainer else { return }
            layoutManager.ensureLayout(for: container)
            let usedRect = layoutManager.usedRect(for: container)
            let insetsHeight = textView.textContainerInset.height * 2
            let height = ceil(usedRect.height + insetsHeight)
            guard abs(height - lastReportedHeight) > 0.5 else { return }
            lastReportedHeight = height
            DispatchQueue.main.async { [weak self] in
                self?.parent.onContentHeightChange(height)
            }
        }
    }
}

/// **Live-gate fix D: may the composer take first responder right now?**
///
/// The composer is designed to hold `firstResponder` at rest — `isTextEditingFocused`
/// (`NormaComposerCard.swift`) documents that as a standing fact the card-key routing has to work
/// around — and it does that by re-claiming on every mount and every SwiftUI update. That is right
/// against the window, a button, or nothing at all. It is wrong against **another text input the
/// user is in the middle of using**: the panel's URL field is a SwiftUI `TextField` in the same
/// window, and the shell's ordinary churn (the 5-second session-list poll, every streamed delta)
/// was enough to pull the caret out of it mid-address, which is what the user reported.
///
/// So the one thing this refuses is stealing from a text input:
///   * `nil` — nobody has it. Claim.
///   * the composer itself — nothing to do.
///   * an `NSText` (a SwiftUI `TextField`'s shared field editor is one, as is any `NSTextView`) or
///     an `NSTextInputClient` (which is what Chromium's `RenderWidgetHostViewCocoa` is, so typing
///     INTO a page is protected by the same rule) — **yield**.
///   * anything else, `NSWindow` included — claim, exactly as before.
///
/// Both conformance tests are kept even though `NSTextView` satisfies both: `NSTextField` itself is
/// neither (its field editor is the responder), and a view that is only `NSTextInputClient` — CEF's
/// — is not an `NSText`. Either test alone leaves a real text input unprotected.
func composerShouldClaimFirstResponder(current: NSResponder?, composer: NSView) -> Bool {
    guard let current else { return true }
    if current === composer { return false }
    return !(current is NSText || current is NSTextInputClient)
}

/// v1 port of `CommandTextView` (TextField/ComposerTextView.swift:333-437), stripped to just
/// the Enter/Shift+Enter `doCommand(by:)` override — the paste-image interception and
/// selection-change reporting are gone with the image/caret-navigation surface above.
///
/// Task 6 (FieldFocus) adds the virtual-focus keyboard chain on top: `onFocusKey` gets first
/// look at ↑/↓/Enter (see `FieldFocus.swift`'s header for why this is virtual, never a real
/// firstResponder change) — only when it returns `false`/`nil` (unconsumed) does the pre-existing
/// Enter/Shift+Enter contract below run, verbatim. `onTypingRefocus` fires on every inserted
/// character so typing while the chevron is virtually focused snaps focus back to the composer
/// before the character lands (`NormaFieldView`'s wiring sets `adapter.focusedElement = .composer`).
final class CommandTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onFocusKey: ((FieldFocusKey, _ caretAtFirstLine: Bool, _ caretAtLastLine: Bool) -> Bool)?
    var onTypingRefocus: (() -> Void)?
    /// office-live-ux Job 1 — see `ComposerTextView.onEscape` for why this hangs off `keyDown`
    /// rather than off `doCommand(by:)` or a window-level monitor.
    var onEscape: (() -> Bool)?

    /// The ONE key this view intercepts before `interpretKeyEvents(_:)` — Escape (`keyCode == 53`).
    ///
    /// Unhandled (no closure wired, or the closure answers `false` because no turn is running) the
    /// event goes to `super` **verbatim**, so Escape keeps whatever meaning AppKit already gave it.
    /// That asymmetry is the contract, not an optimisation: consuming Escape on an idle session
    /// would silently remove a gesture from every surface that hosts this composer, in exchange for
    /// nothing.
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53, onEscape?() == true { return }
        super.keyDown(with: event)
    }

    override func doCommand(by selector: Selector) {
        let first = caretAtFirstLine(of: string, caretLocation: selectedRange().location)
        let last = caretAtLastLine(of: string, caretLocation: NSMaxRange(selectedRange()))
        switch selector {
        case #selector(NSResponder.moveUp(_:)):
            if onFocusKey?(.up, first, last) == true { return }
            super.doCommand(by: selector)
        case #selector(NSResponder.moveDown(_:)):
            if onFocusKey?(.down, first, last) == true { return }
            super.doCommand(by: selector)
        case #selector(insertNewline(_:)):
            if onFocusKey?(.enter, first, last) == true { return }
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                super.doCommand(by: selector)
            } else {
                onSubmit?()
            }
        default:
            super.doCommand(by: selector)
        }
    }

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        onTypingRefocus?()
        super.insertText(insertString, replacementRange: replacementRange)
    }
}
