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
/// changes) so `WinterFieldView`'s composer pill can grow with typed/wrapped text instead of
/// sitting fixed at `composerMinHeight`.
struct ComposerTextView: NSViewRepresentable {
    /// Single source of truth for the text container's inset — `makeNSView` applies these exact
    /// values to the real `NSTextView`, and `WinterFieldView`'s placeholder overlay (gate wave-3
    /// text-alignment fix) reads the SAME constants so "Ask Winter…" starts flush with where the
    /// real caret/first glyph renders instead of drifting off and overlapping it.
    static let textContainerInset = NSSize(width: 2, height: 4)
    static let lineFragmentPadding: CGFloat = 0

    /// The measured content height of a TWO-line draft at the composer's bound size — the
    /// threshold family for "has the draft grown past a couple of lines" checks
    /// (`WinterFieldView.showsClearButton`). Derived from the live face so a ladder change
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
    /// requires. Defaults `false` so the field's own call-site (`WinterFieldView.swift`) is
    /// byte-identical / zero behavior change; only the window opts in.
    var usesAdaptiveColors: Bool = false
    /// One colour for the typed text AND the caret, over whatever `usesAdaptiveColors` picks — the
    /// dispatch pill types in plain white, caret included, over its black. `nil` (the default) leaves every other surface as it was.
    var tintOverride: NSColor? = nil
    /// Handed the composer's scroll view once, when it is built — for a host that drives an effect
    /// on the AppKit view itself, which a SwiftUI modifier does not reach (the dispatch pill blurs
    /// it while its shape changes). `nil` (the default) everywhere else.
    var onViewCreated: ((NSScrollView) -> Void)? = nil
    /// The AppKit view's own alpha, eased over 0.2 s on a change. For a host that hides the
    /// composer while keeping it mounted (and first responder): SwiftUI's `.opacity` is not promised
    /// to reach an `NSViewRepresentable`'s view. `1` (the default) leaves every other surface alone.
    var viewAlpha: CGFloat = 1
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

    /// Ranges of the text to draw in `highlightColor` — the dispatch pill colours a fully typed command
    /// (`/permissions`). Applied as the layout manager's TEMPORARY attributes, so the text itself, its
    /// undo stack and the binding never change. `nil` (the default) leaves every other surface as it was.
    var highlightRanges: ((String) -> [NSRange])? = nil
    var highlightColor: NSColor = .systemBlue
    /// The highlight's colour for a given text, when it depends on the text (the dispatch pill draws a `/`
    /// command in blue and a shell command in purple). Overrides `highlightColor` when set.
    var highlightColorForText: ((String) -> NSColor)? = nil
    /// Dimmed completion text drawn right after the caret while it sits at the END of the text with nothing
    /// selected; Tab inserts it (the dispatch pill's command mode). `nil` (the default) draws nothing and
    /// leaves Tab as AppKit's.
    var ghostSuffix: String? = nil
    /// Tab with the caret at the END and nothing selected, consulted before the ghost is inserted: the edit to make
    /// (`ComposerTabEdit` — the dispatch pill accepts its ghost, or cycles on-screen paths on Tab again), or nil to
    /// fall back to inserting `ghostSuffix` / AppKit's Tab. `nil` (the default) leaves Tab as before.
    var onTab: ((String) -> ComposerTabEdit?)? = nil
    /// Shift-Tab with the caret at the end: the edit, or nil for AppKit's own (the pill: back one candidate, only
    /// while a Tab cycle holds).
    var onBackTab: ((String) -> ComposerTabEdit?)? = nil
    /// → (`word` false) or ⌥→ (`word` true) — consulted ONLY with the caret at the very end, nothing selected, no
    /// marked (IME) text and no modifier but ⌥ (`CommandTextView.ghostAcceptKey`): the edit accepting the ghost, or
    /// nil for the key's own meaning. Every other arrow, and → in any other state, is AppKit's.
    var onAcceptGhost: ((_ text: String, _ word: Bool) -> ComposerTabEdit?)? = nil
    /// Any key other than Tab and Shift-Tab, before it is handled (the pill ends its Tab cycle).
    var onNonTabKey: (() -> Void)? = nil
    /// Delete/Backspace with the caret at the END and nothing selected, consulted before anything is deleted
    /// (`true` = consumed, nothing deleted — the dispatch pill's command-mode opt-out). `nil` (the default)
    /// leaves Delete as AppKit's.
    var onDeleteBackwardAtEnd: (() -> Bool)? = nil
    /// ←/→, consulted before the caret moves (`true` = consumed) — the dispatch pill's picker walks its
    /// chips with them while the composer is hidden under it. `nil` (the default) leaves the caret's own.
    var onHorizontalKey: ((_ left: Bool) -> Bool)? = nil

    /// Composer attachments (`ComposerAttachments.swift`): pasted image data, and pasted or dropped files and
    /// folders, become attachments — chips IN the text, at the caret or the drop point — while `isEnabled()`
    /// answers true. `text` holds each chip as its marker character. `nil` (the default) — or
    /// `isEnabled() == false` — leaves paste and drop exactly as AppKit does them, so every surface that does not
    /// opt in (the orb's field) is byte-identical.
    var imageIntake: ComposerAttachmentIntake? = nil
    /// The "+" button's handle on this text view (`ComposerAttachPicker`) — registered when the view is built.
    var attachPicker: ComposerAttachPicker? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = CommandTextView()
        // TextKit 1 from the start: the inline chips are `NSTextAttachmentCell`s (`ComposerChipAttachmentCell`).
        _ = textView.layoutManager
        textView.delegate = context.coordinator
        textView.font = Typography.sansNS(ofSize: fontSize)
        // GATE-3 FIX (F2): this composer is rendered inside `WinterFieldView.composerOrResponseContent`,
        // which is wrapped in `.modifier(GlassForegroundLegibility())` — `.blendMode(.difference)`
        // against the glass surface beneath (see that type + `GlassChromeColor`'s doc). Difference
        // inverts cleanly ONLY against a pure-white source (`white − bg = inverse(bg)`); v1's own
        // `composerForegroundColor` (TextField/ComposerTextView.swift) hardcodes `.white` for exactly
        // this reason and documents the failure mode by name: "`.labelColor` would be ... already the
        // inverse of the typical glass tone — so subtracting it from the background would produce
        // near-white in both modes (the washed-out 'full white' symptom)" — i.e. typed text renders
        // invisible. `.labelColor` here was the transplant regression; `.white` restores v1 parity.
        textView.textColor = usesAdaptiveColors ? (NSColor(named: "TextPrimary") ?? .labelColor) : .white
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
            .foregroundColor: usesAdaptiveColors ? (NSColor(named: "TextPrimary") ?? .labelColor) : NSColor.white
        ]
        // The caret is WINTER'S accent (user call, 2026-08-07 — every cursor in the app one colour),
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
        if let tintOverride {
            textView.textColor = tintOverride
            textView.typingAttributes[.foregroundColor] = tintOverride
            textView.insertionPointColor = tintOverride
        }
        textView.imageIntake = imageIntake
        textView.setComposerText(text)
        textView.onSubmit = onSubmit
        textView.onFocusKey = onFocusKey
        textView.onHorizontalKey = onHorizontalKey
        textView.onTypingRefocus = onTypingRefocus
        textView.onEscape = onEscape
        textView.imageIntake = imageIntake
        textView.ghostSuffix = ghostSuffix
        textView.onTab = onTab
        textView.onBackTab = onBackTab
        textView.onAcceptGhost = onAcceptGhost
        textView.onNonTabKey = onNonTabKey
        textView.onDeleteBackwardAtEnd = onDeleteBackwardAtEnd
        attachPicker?.textView = textView

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.documentView = textView
        onViewCreated?(scrollView)

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
        textView.onHorizontalKey = onHorizontalKey
        textView.onTypingRefocus = onTypingRefocus
        // office-live-ux Job 1: re-assigned on EVERY update, exactly like the three above it. The
        // closure captures `adapter.turnRunning` freshly at CALL time (it asks the host, it does
        // not hold a Bool), but the closure OBJECT still has to be refreshed here or a card rebuilt
        // against a new attachment would keep interrupting the previous session.
        textView.onEscape = onEscape
        textView.imageIntake = imageIntake
        textView.onDeleteBackwardAtEnd = onDeleteBackwardAtEnd
        textView.onTab = onTab
        textView.onBackTab = onBackTab
        textView.onAcceptGhost = onAcceptGhost
        textView.onNonTabKey = onNonTabKey
        if let attachPicker, attachPicker.textView !== textView { attachPicker.textView = textView }
        // Keep the live view in step if the size changes across an update — otherwise the font
        // would be whatever `makeNSView` happened to set the first time this view was built.
        if textView.font?.pointSize != fontSize {
            textView.font = Typography.sansNS(ofSize: fontSize)
        }
        // Compared as the DRAFT spells it (chips as markers): the storage's own string holds U+FFFC where a
        // chip is, and writing `string` would wipe every chip.
        if textView.composerText != text {
            textView.setComposerText(text)
        }
        context.coordinator.applyHighlights(textView)
        // After the text is in step, so the ghost is judged against the text it was computed for.
        textView.ghostSuffix = ghostSuffix
        textView.textContainer?.containerSize = NSSize(
            width: max(1, nsView.contentSize.width),
            height: .greatestFiniteMagnitude
        )
        context.coordinator.reportHeight(textView)
        if nsView.alphaValue != viewAlpha {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                nsView.animator().alphaValue = viewAlpha
            }
        }

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
        // Focused` (`WinterComposerCard.swift`) is written against and `CardWiringTests` pins.
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
            parent.text = (textView as? CommandTextView)?.composerText ?? textView.string
            applyHighlights(textView)
            reportHeight(textView)
        }

        /// `highlightRanges`, drawn as temporary foreground colour — cleared first, so a range that no
        /// longer applies (a command edited away) goes back to the text's own colour.
        func applyHighlights(_ textView: NSTextView) {
            guard let highlight = parent.highlightRanges, let layoutManager = textView.layoutManager else { return }
            let length = (textView.string as NSString).length
            let color = parent.highlightColorForText?(textView.string) ?? parent.highlightColor
            layoutManager.removeTemporaryAttribute(.foregroundColor, forCharacterRange: NSRange(location: 0, length: length))
            for range in highlight(textView.string) where range.location >= 0 && NSMaxRange(range) <= length && range.length > 0 {
                layoutManager.addTemporaryAttribute(.foregroundColor, value: color, forCharacterRange: range)
            }
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
/// (`WinterComposerCard.swift`) documents that as a standing fact the card-key routing has to work
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
/// the Enter/Shift+Enter `doCommand(by:)` override — v1's paste-image interception and
/// selection-change reporting went with the image/caret-navigation surface above. Code-mode image
/// input (2026-09-29) brings back a paste/drop hook of its own, gated on `imageIntake` (see the MARK
/// at the bottom): with no live intake every paste and drop is AppKit's, unchanged.
///
/// Task 6 (FieldFocus) adds the virtual-focus keyboard chain on top: `onFocusKey` gets first
/// look at ↑/↓/Enter (see `FieldFocus.swift`'s header for why this is virtual, never a real
/// firstResponder change) — only when it returns `false`/`nil` (unconsumed) does the pre-existing
/// Enter/Shift+Enter contract below run, verbatim. `onTypingRefocus` fires on every inserted
/// character so typing while the chevron is virtually focused snaps focus back to the composer
/// before the character lands (`WinterFieldView`'s wiring sets `adapter.focusedElement = .composer`).
final class CommandTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onFocusKey: ((FieldFocusKey, _ caretAtFirstLine: Bool, _ caretAtLastLine: Bool) -> Bool)?
    var onHorizontalKey: ((_ left: Bool) -> Bool)?
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
        if event.keyCode != 48 { onNonTabKey?() } // 48: Tab (Shift-Tab too)
        if event.keyCode == 53, onEscape?() == true { return }
        super.keyDown(with: event)
    }

    override func doCommand(by selector: Selector) {
        let first = caretAtFirstLine(of: string, caretLocation: selectedRange().location)
        let last = caretAtLastLine(of: string, caretLocation: NSMaxRange(selectedRange()))
        switch selector {
        case #selector(NSResponder.deleteBackward(_:)):
            if caretAtEndWithNoSelection, onDeleteBackwardAtEnd?() == true { return }
            super.doCommand(by: selector)
        case #selector(NSResponder.insertTab(_:)):
            if caretAtEndWithNoSelection, let edit = onTab?(composerText) {
                applyTabEdit(edit)
                return
            }
            if let ghost = ghostSuffix, !ghost.isEmpty, caretAtEndWithNoSelection {
                insertText(ghost, replacementRange: selectedRange())
                return
            }
            super.doCommand(by: selector)
        case #selector(NSResponder.moveUp(_:)):
            if onFocusKey?(.up, first, last) == true { return }
            super.doCommand(by: selector)
        case #selector(NSResponder.moveDown(_:)):
            if onFocusKey?(.down, first, last) == true { return }
            super.doCommand(by: selector)
        case #selector(NSResponder.insertBacktab(_:)):
            if caretAtEndWithNoSelection, let edit = onBackTab?(composerText) {
                applyTabEdit(edit)
                return
            }
            super.doCommand(by: selector)
        case #selector(NSResponder.moveWordRight(_:)):
            if ghostAcceptKey(word: true), let edit = onAcceptGhost?(composerText, true) {
                applyTabEdit(edit)
                return
            }
            super.doCommand(by: selector)
        case #selector(NSResponder.moveLeft(_:)):
            if onHorizontalKey?(true) == true { return }
            super.doCommand(by: selector)
        case #selector(NSResponder.moveRight(_:)):
            if onHorizontalKey?(false) == true { return }
            if ghostAcceptKey(word: false), let edit = onAcceptGhost?(composerText, false) {
                applyTabEdit(edit)
                return
            }
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

    // MARK: Ghost completion and the Delete opt-out (the dispatch pill's command mode)

    /// See `ComposerTextView.onDeleteBackwardAtEnd`.
    var onDeleteBackwardAtEnd: (() -> Bool)?

    /// See `ComposerTextView.onTab`.
    var onTab: ((String) -> ComposerTabEdit?)?
    /// See `ComposerTextView.onBackTab`.
    var onBackTab: ((String) -> ComposerTabEdit?)?
    /// See `ComposerTextView.onAcceptGhost`.
    var onAcceptGhost: ((_ text: String, _ word: Bool) -> ComposerTabEdit?)?
    /// See `ComposerTextView.onNonTabKey`.
    var onNonTabKey: (() -> Void)?

    /// May → (or ⌥→, `word`) accept the ghost? Only with a ghost showing, the caret at the very end, nothing
    /// selected, no marked (IME) text, and no modifier held but ⌥ (for ⌥→; none at all for →). ⇧→ and ⌘→ arrive as
    /// other selectors and never get here.
    func ghostAcceptKey(word: Bool) -> Bool {
        guard let ghost = ghostSuffix, !ghost.isEmpty, caretAtEndWithNoSelection, !hasMarkedText() else { return false }
        let held = (NSApp.currentEvent?.modifierFlags ?? []).intersection([.shift, .command, .control, .option])
        return word ? held.isSubset(of: [.option]) : held.isEmpty
    }

    /// Replaces the text's last `edit.replacingSuffix` with `edit.insert` as one typed change (undoable, and the
    /// binding hears it). An edit whose suffix is not there changes nothing.
    func applyTabEdit(_ edit: ComposerTabEdit) {
        let text = string as NSString
        let suffixLength = (edit.replacingSuffix as NSString).length
        guard suffixLength <= text.length,
              text.substring(from: text.length - suffixLength) == edit.replacingSuffix else { return }
        guard suffixLength > 0 || !edit.insert.isEmpty else { return } // Tab consumed, nothing to change
        insertText(edit.insert, replacementRange: NSRange(location: text.length - suffixLength, length: suffixLength))
    }

    /// See `ComposerTextView.ghostSuffix`.
    var ghostSuffix: String? {
        didSet { if oldValue != ghostSuffix { needsDisplay = true } }
    }

    /// The caret sits after the last character and nothing is selected.
    var caretAtEndWithNoSelection: Bool {
        let selection = selectedRange()
        return selectedRanges.count == 1 && selection.length == 0 && selection.location == (string as NSString).length
    }

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        // The ghost shows only with the caret at the end — a caret that moves away takes it along.
        if ghostSuffix?.isEmpty == false { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        drawGhostSuffix()
    }

    /// The ghost, dimmed, starting where the next typed character would land.
    private func drawGhostSuffix() {
        guard let ghost = ghostSuffix, !ghost.isEmpty, caretAtEndWithNoSelection,
              let layoutManager, let container = textContainer else { return }
        let text = string as NSString
        guard text.length > 0, text.character(at: text.length - 1) != 0x0A else { return }
        let glyph = layoutManager.glyphIndexForCharacter(at: text.length - 1)
        let glyphRect = layoutManager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        let line = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let origin = textContainerOrigin
        let face = font ?? Typography.sansNS(ofSize: Typography.composerFieldSize)
        (ghost as NSString).draw(at: NSPoint(x: origin.x + glyphRect.maxX, y: origin.y + line.minY),
                                 withAttributes: [.font: face, .foregroundColor: ghostColor])
    }

    /// The ghost's ink: the text's own colour, faded.
    private var ghostColor: NSColor {
        (textColor ?? .white).withAlphaComponent(0.38)
    }

    // MARK: Composer attachments

    /// See `ComposerTextView.imageIntake`.
    var imageIntake: ComposerAttachmentIntake?

    /// The intake, only while it is live — every override below falls through to AppKit otherwise.
    private var liveIntake: ComposerAttachmentIntake? {
        guard let imageIntake, imageIntake.isEnabled() else { return nil }
        return imageIntake
    }

    /// Whether this composer takes attachments right now (a code session) — the "+" button asks the same.
    var composerAttachmentsEnabled: Bool { liveIntake != nil }

    override func paste(_ sender: Any?) {
        if pasteComposerChips(from: .general) { return }
        if takeComposerAttachments(from: .general) { return }
        super.paste(sender)
    }

    /// The paste/drop decision, on a pasteboard handed in (so a test never touches the user's general
    /// pasteboard). `true` = handled here: attachments were added, or image DATA was refused (its reason is on
    /// the surface's notice line; there is no text to fall back to). `false` = AppKit's own paste/drop runs —
    /// no live intake, nothing attachable on the pasteboard, or files whose every attach was refused (a
    /// text-only model): their paths are typed as before, beside the notice, instead of the paste silently
    /// doing nothing.
    func takeComposerAttachments(from pasteboard: NSPasteboard) -> Bool {
        guard liveIntake != nil, let kinds = composerAttachments(from: pasteboard) else { return false }
        if takeComposerAttachments(kinds) { return true }
        let hasFiles = !((pasteboard.readObjects(forClasses: [NSURL.self],
                                                 options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []).isEmpty
        return !hasFiles
    }

    /// Attach each, in order — a refused one (its reason on the notice line) does not stop the rest — and put
    /// their chips in the text at the caret (a drop moves the caret to its point first). Answers whether anything
    /// was attached. Also the "+" picker's door (`ComposerAttachPicker`).
    @discardableResult
    func takeComposerAttachments(_ kinds: [ComposerAttachmentKind]) -> Bool {
        guard let intake = liveIntake else { return false }
        let ids = kinds.compactMap { intake.attach($0) }
        guard !ids.isEmpty else { return false }
        insertComposerChips(ids)
        return true
    }

    /// A plain-text view does not enable Paste for image-only pasteboard content (a screenshot), so
    /// ⌘V would never reach `paste(_:)` — enabled here exactly when the intake would take it.
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), liveIntake != nil, composerPasteboardMayHaveAttachment(.general) {
            return true
        }
        return super.validateUserInterfaceItem(item)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let op = super.draggingEntered(sender)
        if liveIntake != nil, composerPasteboardMayHaveAttachment(sender.draggingPasteboard) { return .copy }
        return op
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        let op = super.draggingUpdated(sender)
        if liveIntake != nil, composerPasteboardMayHaveAttachment(sender.draggingPasteboard) { return .copy }
        return op
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if liveIntake != nil, composerPasteboardMayHaveAttachment(sender.draggingPasteboard) {
            window?.makeFirstResponder(self)
            // The chips land where the drop did.
            let previous = selectedRange()
            let point = convert(sender.draggingLocation, from: nil)
            setSelectedRange(NSRange(location: characterIndexForInsertion(at: point), length: 0))
            if takeComposerAttachments(from: sender.draggingPasteboard) { return true }
            setSelectedRange(previous)
        }
        return super.performDragOperation(sender)
    }

    // MARK: Inline chips (2026-10-13)
    //
    // Each chip is one character of the text storage: U+FFFC carrying a `ComposerChipAttachment`, drawn by its
    // cell as the shared chip (`AttachmentChipImages`). The draft spells it as its marker (`composerText`), so
    // the binding, undo (AppKit restores the same attachment object), caret movement (one character) and
    // Backspace/Delete are all the text system's own. What is ours: building the storage from a draft, the
    // copy/cut/paste of chips, the hover × and the drop point.

    /// The private pasteboard type a copied chip rides on, beside its placeholder text.
    static let composerChipsPasteboardType = NSPasteboard.PasteboardType("com.winter.composer.chips")

    /// What a copy of chips carries: the draft it came from, the selection as the draft spells it (markers), and
    /// each chip's placeholder — what a paste into another draft (or once the attachment is gone) types instead.
    struct ComposerChipClipboard: Codable, Equatable {
        let draft: String
        let text: String
        let placeholders: [String: String]
    }

    /// The face a chip is sized against: the text's own.
    var composerChipFont: NSFont { font ?? Typography.sansNS(ofSize: Typography.composerFieldSize) }

    /// The text as the draft spells it — each chip as its marker character (same UTF-16 length as the storage).
    var composerText: String {
        guard let storage = textStorage, storage.length > 0 else { return string }
        var chips: [(Int, Int)] = []
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let chip = value as? ComposerChipAttachment else { return }
            for index in range.location..<NSMaxRange(range) { chips.append((index, chip.attachmentID)) }
        }
        guard !chips.isEmpty else { return storage.string }
        let text = NSMutableString(string: storage.string)
        for (index, id) in chips {
            text.replaceCharacters(in: NSRange(location: index, length: 1), with: String(composerAttachmentMarker(id)))
        }
        return text as String
    }

    /// The storage built from a draft: text in the typing attributes, each marker the intake still knows as a
    /// chip. A marker it does not know stays as its character, so the storage still spells the draft.
    func composerAttributedText(_ text: String) -> NSAttributedString {
        let attributes = composerTextAttributes
        let result = NSMutableAttributedString()
        var run = ""
        func flush() {
            if !run.isEmpty { result.append(NSAttributedString(string: run, attributes: attributes)); run = "" }
        }
        for character in text {
            if let id = composerAttachmentID(marker: character), imageIntake?.chip(id, text) != nil {
                flush()
                result.append(composerChipString(id))
            } else {
                run.append(character)
            }
        }
        flush()
        return result
    }

    /// Replaces the whole text with a draft — an outside change (a send clearing it, a draft carried in).
    func setComposerText(_ text: String) {
        guard text.contains(where: { composerAttachmentID(marker: $0) != nil }) else {
            string = text
            return
        }
        textStorage?.setAttributedString(composerAttributedText(text))
        setSelectedRange(NSRange(location: (string as NSString).length, length: 0))
        breakUndoCoalescing()
        invalidateComposerChipLayout()
    }

    /// The text's own attributes, never an attachment's.
    private var composerTextAttributes: [NSAttributedString.Key: Any] {
        var attributes = typingAttributes
        attributes[.attachment] = nil
        attributes[.link] = nil
        if attributes[.font] == nil { attributes[.font] = composerChipFont }
        return attributes
    }

    /// One chip, as the storage holds it.
    private func composerChipString(_ id: Int) -> NSAttributedString {
        let chip = NSMutableAttributedString(attachment: ComposerChipAttachment(attachmentID: id, host: self))
        chip.addAttributes(composerTextAttributes, range: NSRange(location: 0, length: chip.length))
        return chip
    }

    /// Puts chips at the caret (replacing a selection), one undoable edit, with a space between each and the
    /// text either side so the placeholders never run into a word. The caret ends after them.
    func insertComposerChips(_ ids: [Int]) {
        guard !ids.isEmpty, let storage = textStorage else { return }
        let range = selectedRange()
        let ns = storage.string as NSString
        let isSpace: (Int) -> Bool = { index in
            guard let scalar = Unicode.Scalar(ns.character(at: index)) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        let insertion = NSMutableAttributedString()
        let space = NSAttributedString(string: " ", attributes: composerTextAttributes)
        if range.location > 0, !isSpace(range.location - 1) { insertion.append(space) }
        for (i, id) in ids.enumerated() {
            if i > 0 { insertion.append(space) }
            insertion.append(composerChipString(id))
        }
        if NSMaxRange(range) >= ns.length || !isSpace(NSMaxRange(range)) { insertion.append(space) }
        guard shouldChangeText(in: range, replacementString: insertion.string) else { return }
        storage.replaceCharacters(in: range, with: insertion)
        didChangeText()
        setSelectedRange(NSRange(location: range.location + insertion.length, length: 0))
        breakUndoCoalescing()
    }

    /// The chip's ×: takes it out of the text (one undoable edit), with the space it brought after it.
    func removeComposerChip(at index: Int) {
        guard let storage = textStorage, index < storage.length,
              storage.attribute(.attachment, at: index, effectiveRange: nil) is ComposerChipAttachment else { return }
        var range = NSRange(location: index, length: 1)
        let ns = storage.string as NSString
        if NSMaxRange(range) < ns.length, ns.character(at: NSMaxRange(range)) == 0x20 { range.length += 1 }
        guard shouldChangeText(in: range, replacementString: "") else { return }
        storage.deleteCharacters(in: range)
        didChangeText()
        setSelectedRange(NSRange(location: index, length: 0))
        hoveredChipIndex = nil
    }

    override func didChangeText() {
        composerChipFrames.removeAll()
        invalidateComposerChipLayout()
        super.didChangeText()
    }

    /// A chip's size can follow the text (pasted data is named by its number, which moves when chips move).
    private func invalidateComposerChipLayout() {
        guard let storage = textStorage, storage.length > 0, let layoutManager else { return }
        var any = false
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, stop in
            if value is ComposerChipAttachment { any = true; stop.pointee = true }
        }
        guard any else { return }
        let all = NSRange(location: 0, length: storage.length)
        layoutManager.invalidateLayout(forCharacterRange: all, actualCharacterRange: nil)
        layoutManager.invalidateDisplay(forCharacterRange: all)
    }

    /// The chip's picture: the shared chip, rasterised for this text's size and appearance.
    func composerChipImage(_ id: Int, hovered: Bool) -> NSImage {
        let model = imageIntake?.chip(id, composerText)
            ?? AttachmentChipModel(id: "gone-\(id)", name: "Attachment", visual: .file(path: ""))
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return AttachmentChipImages.image(for: model, size: .inline(for: composerChipFont), hovered: hovered, dark: dark,
                                          scale: window?.backingScaleFactor ?? 2,
                                          didLoad: { [weak self] in self?.composerChipArtDidLoad() })
    }

    private func composerChipArtDidLoad() {
        guard let storage = textStorage, let layoutManager else { return }
        layoutManager.invalidateDisplay(forCharacterRange: NSRange(location: 0, length: storage.length))
    }

    // Copy, cut, paste.

    /// The selection's chips as a clipboard, or `nil` when it holds none (AppKit's own copy then).
    func composerChipClipboard(for range: NSRange) -> (clip: ComposerChipClipboard, plain: String)? {
        guard range.length > 0, let intake = imageIntake else { return nil }
        let whole = composerText
        guard NSMaxRange(range) <= (whole as NSString).length else { return nil }
        let text = (whole as NSString).substring(with: range)
        let ids = composerAttachmentMarkerIDs(in: text)
        guard !ids.isEmpty else { return nil }
        var placeholders: [String: String] = [:]
        for id in ids { placeholders[String(id)] = intake.placeholder(id, whole) ?? "" }
        var plain = ""
        for character in text {
            if let id = composerAttachmentID(marker: character) {
                plain += placeholders[String(id)] ?? ""
            } else {
                plain.append(character)
            }
        }
        return (ComposerChipClipboard(draft: intake.draftToken(), text: text, placeholders: placeholders), plain)
    }

    /// Writes a selection holding chips: the placeholders as the plain text, the chips on the private type.
    /// `false` when the selection holds no chip.
    func writeComposerChips(to pasteboard: NSPasteboard) -> Bool {
        guard selectedRanges.count == 1, let (clip, plain) = composerChipClipboard(for: selectedRange()),
              let data = try? JSONEncoder().encode(clip) else { return false }
        pasteboard.clearContents()
        pasteboard.setData(data, forType: Self.composerChipsPasteboardType)
        pasteboard.setString(plain, forType: .string)
        return true
    }

    override func copy(_ sender: Any?) {
        if writeComposerChips(to: .general) { return }
        super.copy(sender)
    }

    override func cut(_ sender: Any?) {
        if cutComposerChips(to: .general) { return }
        super.cut(sender)
    }

    /// A cut of a selection holding chips: written as a copy is, then deleted — one undoable edit. `false` when
    /// the selection holds no chip (AppKit's own cut then).
    func cutComposerChips(to pasteboard: NSPasteboard) -> Bool {
        let range = selectedRange()
        guard writeComposerChips(to: pasteboard), let storage = textStorage,
              shouldChangeText(in: range, replacementString: "") else { return false }
        storage.deleteCharacters(in: range)
        didChangeText()
        undoManager?.setActionName("Cut")
        setSelectedRange(NSRange(location: range.location, length: 0))
        return true
    }

    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] {
        let types = super.writablePasteboardTypes
        guard selectedRanges.count == 1, composerChipClipboard(for: selectedRange()) != nil else { return types }
        return [Self.composerChipsPasteboardType] + types
    }

    /// A drag of a selection holding chips (AppKit's drag source) writes them as a copy does.
    override func writeSelection(to pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        guard selectedRanges.count == 1, let (clip, plain) = composerChipClipboard(for: selectedRange()) else {
            return super.writeSelection(to: pboard, type: type)
        }
        switch type {
        case Self.composerChipsPasteboardType:
            guard let data = try? JSONEncoder().encode(clip) else { return false }
            return pboard.setData(data, forType: type)
        case .string:
            return pboard.setString(plain, forType: .string)
        default:
            return super.writeSelection(to: pboard, type: type)
        }
    }

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        [Self.composerChipsPasteboardType] + super.readablePasteboardTypes
    }

    override var acceptableDragTypes: [NSPasteboard.PasteboardType] {
        [Self.composerChipsPasteboardType] + super.acceptableDragTypes
    }

    /// A drop (or AppKit's paste) of chips — AppKit has put the caret at the drop point. Chips this draft cannot
    /// restore (another draft's, or a composer that takes no attachments now) arrive as their placeholder text.
    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        guard type == Self.composerChipsPasteboardType else { return super.readSelection(from: pboard, type: type) }
        if pasteComposerChips(from: pboard) { return true }
        return super.readSelection(from: pboard, type: .string)
    }

    /// Pastes copied chips at the caret: each one this draft still holds comes back as a chip, any other as its
    /// placeholder text — and chips from ANOTHER draft (or into a composer that takes no attachments now) are
    /// left to AppKit, which pastes the placeholder text. `true` = pasted here.
    func pasteComposerChips(from pasteboard: NSPasteboard) -> Bool {
        guard let data = pasteboard.data(forType: Self.composerChipsPasteboardType),
              let clip = try? JSONDecoder().decode(ComposerChipClipboard.self, from: data),
              let intake = liveIntake, clip.draft == intake.draftToken(), let storage = textStorage else { return false }
        let whole = composerText
        let insertion = NSMutableAttributedString()
        var run = ""
        let attributes = composerTextAttributes
        func flush() {
            if !run.isEmpty { insertion.append(NSAttributedString(string: run, attributes: attributes)); run = "" }
        }
        for character in clip.text {
            if let id = composerAttachmentID(marker: character) {
                if intake.chip(id, whole) != nil {
                    flush()
                    insertion.append(composerChipString(id))
                } else {
                    run += clip.placeholders[String(id)] ?? ""
                }
            } else {
                run.append(character)
            }
        }
        flush()
        let range = selectedRange()
        guard insertion.length > 0, shouldChangeText(in: range, replacementString: insertion.string) else { return false }
        storage.replaceCharacters(in: range, with: insertion)
        didChangeText()
        setSelectedRange(NSRange(location: range.location + insertion.length, length: 0))
        return true
    }

    // Hover and the ×.

    /// Where each chip was last drawn (view coordinates), by character index — what hover and the × hit-test.
    /// Cleared on every edit; the next draw fills it again.
    private var composerChipFrames: [Int: NSRect] = [:]
    /// The chip under the mouse, by character index — its cell draws the ×.
    private(set) var hoveredChipIndex: Int? {
        didSet {
            guard oldValue != hoveredChipIndex else { return }
            for index in [oldValue, hoveredChipIndex].compactMap({ $0 }) {
                if let frame = composerChipFrames[index] { setNeedsDisplay(frame.insetBy(dx: -2, dy: -2)) }
            }
        }
    }
    private var composerChipTrackingArea: NSTrackingArea?

    /// The cell's report of where it drew.
    func noteComposerChipFrame(_ frame: NSRect, at index: Int) {
        composerChipFrames[index] = frame
    }

    /// The chip at a point (view coordinates), if any — checked against the storage, so a stale frame never
    /// answers for a character that is no longer a chip.
    func composerChip(at point: NSPoint) -> (index: Int, frame: NSRect)? {
        guard let storage = textStorage else { return nil }
        for (index, frame) in composerChipFrames where frame.contains(point) {
            if index < storage.length, storage.attribute(.attachment, at: index, effectiveRange: nil) is ComposerChipAttachment {
                return (index, frame)
            }
        }
        return nil
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let composerChipTrackingArea { removeTrackingArea(composerChipTrackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        composerChipTrackingArea = area
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        hoveredChipIndex = composerChip(at: convert(event.locationInWindow, from: nil))?.index
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        hoveredChipIndex = nil
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let hit = composerChip(at: point), attachmentChipInlineRemoveRect(in: hit.frame).contains(point) {
            removeComposerChip(at: hit.index)
            return
        }
        super.mouseDown(with: event)
    }
}

/// A chip in the composer's text: which attachment it is. Its cell draws it.
final class ComposerChipAttachment: NSTextAttachment {
    let attachmentID: Int

    init(attachmentID: Int, host: CommandTextView) {
        self.attachmentID = attachmentID
        super.init(data: nil, ofType: nil)
        attachmentCell = ComposerChipAttachmentCell(attachmentID: attachmentID, host: host)
    }

    required init?(coder: NSCoder) { nil }
}

/// Draws one inline chip (TextKit 1): the shared chip as an image, as tall as the text's ascender-to-descender
/// box and sitting on its descender (`AttachmentChipSize.inline(for:)`), with its × while hovered.
final class ComposerChipAttachmentCell: NSTextAttachmentCell {
    let attachmentID: Int
    weak var host: CommandTextView?

    init(attachmentID: Int, host: CommandTextView) {
        self.attachmentID = attachmentID
        self.host = host
        super.init(imageCell: nil)
    }

    required init(coder: NSCoder) { fatalError("not coded") }

    override func cellSize() -> NSSize {
        host?.composerChipImage(attachmentID, hovered: false).size ?? NSSize(width: 24, height: 16)
    }

    override func cellBaselineOffset() -> NSPoint {
        NSPoint(x: 0, y: host.map { AttachmentChipSize.baselineOffset(for: $0.composerChipFont) } ?? 0)
    }

    override func wantsToTrackMouse() -> Bool { false }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?, characterIndex charIndex: Int,
                       layoutManager: NSLayoutManager) {
        guard let host else { return }
        host.noteComposerChipFrame(cellFrame, at: charIndex)
        let image = host.composerChipImage(attachmentID, hovered: host.hoveredChipIndex == charIndex)
        image.draw(in: cellFrame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        host?.composerChipImage(attachmentID, hovered: false)
            .draw(in: cellFrame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}
