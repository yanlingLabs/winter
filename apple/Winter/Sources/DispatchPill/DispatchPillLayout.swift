import CoreGraphics
import Foundation

// MARK: - The dispatch pill's pure layer
//
// Everything `DispatchPillController` decides that can be decided without AppKit lives here, so it
// is table-tested directly (`DispatchPillControllerTests`, `DispatchPillViewTests`) — the same
// "extract the decision, keep the AppKit caller thin" convention as `escMonitorAction`/
// `summonToggleAction` (`OrbWindowController.swift`) and `navigateFieldSwipe`
// (`ExchangeNavigation.swift`).

/// The main pill's three shapes. "Working" is not a fourth case: it is `.compact` while a turn runs
/// (the stop button and the working animation are drawn off `FieldStateAdapter.turnRunning`), so a
/// turn starting or ending never moves the panel by itself.
enum DispatchPillPresentation: Equatable {
    /// Idle: the white circle and a "Type here" field. Also the working state, which swaps the
    /// field for the plume (`CompactPillWorking`).
    case compact
    /// Typing: wider, with ↗ (full screen) and ⋯ floating over the field's end; grows with the
    /// text. Also where a pinned turn (a swipe, or a reply that just arrived) shows.
    case expanded
    /// The transcript alone, filling the screen's visible frame — no composer.
    case fullScreen
}

/// Every fixed number the pill's geometry uses. Geometry only — no type metrics live here
/// (brand.md § 4.5: panel geometry is independent of text size); the composer's MEASURED height is
/// an input to `dispatchPillMainSize`, never a constant.
enum DispatchPillMetrics {
    static let compactWidth: CGFloat = 316
    static let expandedWidth: CGFloat = 560
    /// The capsule's resting height — one line of text plus the send circle's margin.
    static let pillHeight: CGFloat = 44
    /// The tallest a typing pill grows before the composer scrolls internally.
    static let maxExpandedHeight: CGFloat = 240
    /// Vertical room the composer row takes beyond the text view's own measured content height.
    static let composerVerticalPadding: CGFloat = 18
    /// The leading text inset inside the pill.
    static let leadingPadding: CGFloat = 18
    /// The trailing inset of the send circle (it sits inside the capsule's round end).
    static let trailingPadding: CGFloat = 6
    static let sendCircleSize: CGFloat = 32
    static let accessoryButtonSize: CGFloat = 28
    /// How close the typed text gets to ↗ and ⋯ before they blur out of its way.
    static let accessoryApproachMargin: CGFloat = 14
    /// The text view's bottom inset inside the pill: centres one line in the resting capsule.
    static var fieldBottomInset: CGFloat { composerVerticalPadding / 2 }
    /// The send circle's bottom inset: centres it in the resting capsule, and keeps it on the
    /// bottom line as the pill grows taller.
    static var sendBottomInset: CGFloat { (pillHeight - sendCircleSize) / 2 }
    static let rowSpacing: CGFloat = 6
    /// A pinned turn's padding above its prompt line and below its reply.
    static let previewVerticalInset: CGFloat = 12
    /// Between the prompt line and the reply.
    static let previewLineGap: CGFloat = 4
    /// How many lines of the reply a pinned turn shows.
    static let previewReplyLines = 2
    /// The text width inside a pinned turn.
    static var previewTextWidth: CGFloat { expandedWidth - 2 * leadingPadding }
    /// How far above the Dock (the visible frame's bottom edge) the pill's bottom sits.
    static let dockGap: CGFloat = 28
    /// Transparent margin around everything, for the shadow. The mouse gate passes clicks there
    /// through to whatever is underneath.
    static let shadowPad: CGFloat = 24
    /// Gap between the stacked layers: cards → child pills → main pill.
    static let stackGap: CGFloat = 8
    /// A child pill is the main pill's own height (the user's call: same height, same shape).
    static var childRowHeight: CGFloat { pillHeight }
    static let childPillGap: CGFloat = 6
    /// The narrowest a child pill gets before the row stops splitting and shows "+n" instead —
    /// its stop circle plus room for a few letters of its title.
    static let minChildPillWidth: CGFloat = 72
    /// The approval cards' width — wider than the compact pill, because a card has a summary and two
    /// buttons to fit.
    static let cardWidth: CGFloat = 440
    /// How many pending cards float at once; the rest wait behind a "+n more" line.
    static let maxFloatingCards = 2
    /// Inset of the full-screen surface from the visible frame's sides and top.
    static let fullScreenInset: CGFloat = 28
    /// The most the content blurs mid-change of shape (`dispatchPillMorphBlur`).
    static let maxMorphBlur: CGFloat = 8
    /// Points of remaining spring travel per point of blur.
    static let morphBlurFalloff: CGFloat = 12
    /// The rounded-rect radius a tall pill settles on — a capsule's radius at `pillHeight`.
    static let maxCornerRadius: CGFloat = 22

    /// Where ⋯'s leading edge sits in the typing pill's field — the line the typed text "reaches".
    static var fieldWidthBesideAccessories: CGFloat {
        expandedFieldWidth - 2 * accessoryButtonSize - 2 * rowSpacing
    }

    /// The typing pill's text field width. Constant: ↗ and ⋯ float over it rather than beside it.
    static var expandedFieldWidth: CGFloat { fieldWidth(pillWidth: expandedWidth) }

    /// The text field's width in a pill this wide — everything left of the send circle.
    static func fieldWidth(pillWidth: CGFloat) -> CGFloat {
        max(1, pillWidth - leadingPadding - trailingPadding - sendCircleSize - rowSpacing)
    }
}

/// PURE: the main pill's TARGET size for a presentation. The spring in `DispatchPillController`
/// animates toward this; the panel frame is sized from it (grown before the spring starts, shrunk
/// only once it has settled).
///
/// `composerContentHeight` is `ComposerTextView`'s own measured content height (0 until it has
/// reported). `previewHeight` is set while a turn is pinned (a swipe, or a reply that just
/// arrived): the pill then shows that turn ALONE, no composer, at the turn's own height
/// (`dispatchPillPreviewHeight`).
func dispatchPillMainSize(
    presentation: DispatchPillPresentation,
    composerContentHeight: CGFloat,
    previewHeight: CGFloat? = nil,
    visibleFrame: CGRect
) -> CGSize {
    switch presentation {
    case .compact:
        return CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight)
    case .expanded:
        let total = previewHeight ?? max(DispatchPillMetrics.pillHeight,
                                         composerContentHeight + DispatchPillMetrics.composerVerticalPadding)
        return CGSize(width: DispatchPillMetrics.expandedWidth,
                      height: min(max(total, DispatchPillMetrics.pillHeight), DispatchPillMetrics.maxExpandedHeight))
    case .fullScreen:
        let width = visibleFrame.width - 2 * DispatchPillMetrics.fullScreenInset
        let height = visibleFrame.height - DispatchPillMetrics.fullScreenInset - DispatchPillMetrics.dockGap
        return CGSize(width: max(DispatchPillMetrics.expandedWidth, width.rounded(.down)),
                      height: max(DispatchPillMetrics.maxExpandedHeight, height.rounded(.down)))
    }
}

/// PURE: how much the pill's content (text, icons, the plume) blurs while its shape is changing —
/// by how far the spring still has to go, so a change of shape softens everything inside and it
/// sharpens back as the shape settles. Nothing at rest: within `morphBlurFalloff` of the target the
/// radius is under a point and falls to zero.
func dispatchPillMorphBlur(size: CGSize, target: CGSize) -> CGFloat {
    let remaining = max(abs(target.width - size.width), abs(target.height - size.height))
    let radius = min(DispatchPillMetrics.maxMorphBlur, remaining / DispatchPillMetrics.morphBlurFalloff)
    return radius < 0.25 ? 0 : radius
}

/// PURE: pill ↔ rounded rect. At the resting height the radius is half the height (a capsule);
/// any taller and it holds at `maxCornerRadius` (a rounded rect). Read off the ANIMATED height, so
/// the shape morphs continuously as the spring grows or shrinks the pill.
func dispatchPillCornerRadius(height: CGFloat) -> CGFloat {
    min(max(0, height) / 2, DispatchPillMetrics.maxCornerRadius)
}

/// PURE: the panel's canvas — the main pill plus whatever floats above it (cards, child pills),
/// plus the shadow margin all round. `accessorySize` is `.zero` when nothing floats.
func dispatchPillCanvasSize(mainSize: CGSize, accessorySize: CGSize) -> CGSize {
    let hasAccessories = accessorySize.width > 0 && accessorySize.height > 0
    let width = max(mainSize.width, hasAccessories ? accessorySize.width : 0)
    let height = mainSize.height + (hasAccessories ? accessorySize.height + DispatchPillMetrics.stackGap : 0)
    return CGSize(width: ceil(width + 2 * DispatchPillMetrics.shadowPad),
                  height: ceil(height + 2 * DispatchPillMetrics.shadowPad))
}

/// PURE: where the panel goes — centred horizontally on the visible frame, its PILL's bottom edge
/// `dockGap` above the visible frame's bottom (which is the top of the Dock when the Dock is at the
/// bottom). The shadow margin hangs below that line. Bottom edge and midX are the two anchors every
/// resize keeps, so the pill grows up and out from where it sits.
func dispatchPillPanelFrame(canvasSize: CGSize, visibleFrame: CGRect) -> CGRect {
    let x = (visibleFrame.midX - canvasSize.width / 2).rounded()
    let y = visibleFrame.minY + DispatchPillMetrics.dockGap - DispatchPillMetrics.shadowPad
    return CGRect(x: x, y: y, width: canvasSize.width, height: canvasSize.height)
}

/// PURE: the main pill's rect in the canvas's own coordinates (y-down, the SwiftUI convention) —
/// bottom-centred, inside the shadow margin. `mainSize` is the ANIMATED size, so the mouse gate
/// tracks the shape the user actually sees.
func dispatchPillMainRect(canvasSize: CGSize, mainSize: CGSize) -> CGRect {
    CGRect(x: (canvasSize.width - mainSize.width) / 2,
           y: canvasSize.height - DispatchPillMetrics.shadowPad - mainSize.height,
           width: mainSize.width, height: mainSize.height)
}

/// The two-instant resize rule, as a decision. A canvas that must GROW grows now — before the
/// spring starts, so the shape always has room to animate into; one that must SHRINK waits until
/// the spring has settled, so the shape is never clipped mid-animation (the orb's own
/// `expandToField()`/`finishCollapse()` ordering).
enum DispatchPillCanvasStep: Equatable {
    case none
    /// Resize to this now. When it is larger than the target in some dimension (one axis grew while
    /// the other shrank), a deferred shrink to the exact target follows.
    case growNow(CGSize)
    /// Leave the frame alone until the spring settles, then shrink to the target.
    case shrinkLater
}

func dispatchPillCanvasStep(current: CGSize, target: CGSize) -> DispatchPillCanvasStep {
    if current == target { return .none }
    if target.width > current.width || target.height > current.height {
        return .growNow(CGSize(width: max(current.width, target.width),
                               height: max(current.height, target.height)))
    }
    return .shrinkLater
}

// MARK: - Routing

/// What the 4-finger tap (and the hotkey, and the menu's summon item — all of `TriggerHub`) does to
/// the pill. Hidden → show it. Full screen → collapse it back to the pill (spec: "4-finger tap
/// collapses"). Otherwise → hide it, keeping the draft (for as long as `DispatchPillDraftExpiry`
/// says). This is the ONLY way the pill is ever hidden: a click outside compresses it, and the ⋯
/// popover has no Hide row.
enum DispatchPillTriggerAction: Equatable { case show, hide, collapseFullScreen }

func dispatchPillTriggerAction(isVisible: Bool, presentation: DispatchPillPresentation) -> DispatchPillTriggerAction {
    guard isVisible else { return .show }
    return presentation == .fullScreen ? .collapseFullScreen : .hide
}

/// What Esc does. A running turn always wins (interrupt, whatever the shape); otherwise Esc backs
/// out one level: full screen → pill, a swiped-to turn → the composer, typing → compact, and a
/// compact pill hands the keyboard back to the app that had it.
enum DispatchPillEscAction: Equatable { case interrupt, exitFullScreen, exitPreview, compress, rest }

/// `escConsumed` is a closure (same reason as `escMonitorAction`'s): `onEsc()`'s interrupt side
/// effect may only fire once the caller has established the key really is Esc for this panel.
func dispatchPillEscAction(
    presentation: DispatchPillPresentation,
    previewing: Bool,
    escConsumed: () -> Bool
) -> DispatchPillEscAction {
    if escConsumed() { return .interrupt }
    switch presentation {
    case .fullScreen: return .exitFullScreen
    case .expanded: return previewing ? .exitPreview : .compress
    case .compact: return previewing ? .exitPreview : .rest
    }
}

/// Where leaving full screen lands: back to the typing pill when there is a draft to keep typing,
/// else the compact pill.
func dispatchPillPresentationLeavingFullScreen(draft: String) -> DispatchPillPresentation {
    draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .compact : .expanded
}

/// Typing auto-expands: a draft that CHANGED to something non-empty while compact moves the pill to
/// `.expanded`. Keyed on a change (not on the draft merely being non-empty) so a restored draft or a
/// click-outside compress never bounces the pill straight back open.
func dispatchPillPresentationAfterDraftChange(
    _ presentation: DispatchPillPresentation,
    old: String,
    new: String
) -> DispatchPillPresentation {
    guard presentation == .compact, old != new, !new.isEmpty else { return presentation }
    return .expanded
}

// MARK: - How long a put-away pill keeps its draft (Settings → Dispatch)

/// The `dispatchPillDraftExpiry` setting. The countdown starts only when the 4-finger tap puts the
/// pill away (`DispatchPillController.hide()`), and a reopen cancels it, so the next close starts
/// it afresh. A click outside never starts it: the pill stays on screen, compact, holding its draft.
///
/// Raw values are the stored spelling (`UserDefaults`, `DispatchPillSettings`) — never rename one.
enum DispatchPillDraftExpiry: String, CaseIterable, Sendable {
    /// Cleared the moment the pill is put away.
    case onClose
    case fiveMinutes = "5min"
    case tenMinutes = "10min"
    case fifteenMinutes = "15min"
    /// Kept until it is sent or cleared by hand.
    case never

    static let `default`: DispatchPillDraftExpiry = .fifteenMinutes

    /// How long after the close the draft is cleared: `0` = at the close itself, `nil` = never.
    var interval: TimeInterval? {
        switch self {
        case .onClose: return 0
        case .fiveMinutes: return 5 * 60
        case .tenMinutes: return 10 * 60
        case .fifteenMinutes: return 15 * 60
        case .never: return nil
        }
    }

    /// The settings menu's wording for the option.
    var label: String {
        switch self {
        case .onClose: return "Clear draft on close"
        case .fiveMinutes: return "5 min"
        case .tenMinutes: return "10 min"
        case .fifteenMinutes: return "15 min"
        case .never: return "Never"
        }
    }

    /// The stored value read back: an absent or unrecognised one is the default.
    init(storedValue: String?) {
        self = storedValue.flatMap(DispatchPillDraftExpiry.init(rawValue:)) ?? .default
    }
}

/// PURE: when a put-away pill's draft is cleared — the close plus the option's interval, or `nil`
/// for never. A deadline at or before "now" means clear at once (`onClose`, or a setting changed
/// to something shorter than the time already spent closed).
func dispatchPillDraftExpiryDeadline(closedAt: Date, interval: TimeInterval?) -> Date? {
    interval.map { closedAt.addingTimeInterval(max(0, $0)) }
}

// MARK: - ↗ and ⋯ give way to the text

/// PURE: whether ↗ and ⋯ show. They FLOAT over the trailing end of the text field — they take no
/// room of their own, so the field's width (and therefore its wrapping and its height) never
/// changes when they come or go. They blur out as the typed text comes within
/// `accessoryApproachMargin` of them, or on a second line, and the text runs on underneath where
/// they were; they blur back when the text shrinks below that line again.
func dispatchPillAccessoryButtonsVisible(draft: String, textWidth: CGFloat) -> Bool {
    guard !draft.contains("\n") else { return false }
    return textWidth + DispatchPillMetrics.accessoryApproachMargin <= DispatchPillMetrics.fieldWidthBesideAccessories
}

// MARK: - A reply opens the pill

/// PURE: whether a turn that just ended pins its reply (`historyIndex` → the newest turn) and opens
/// the pill to show it. Only on a pill that is on screen, not full screen (the transcript is already
/// there), not already showing a swiped-to turn, and not holding a draft — a reply never pushes
/// aside what the user is typing. A stopped turn, or one with no reply text, opens nothing.
func dispatchPillRevealsReply(
    isVisible: Bool,
    presentation: DispatchPillPresentation,
    previewing: Bool,
    draft: String,
    latest: Exchange?
) -> Bool {
    guard isVisible, presentation != .fullScreen, !previewing,
          draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let latest, !latest.aborted else { return false }
    return !latest.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

// MARK: - Swiping through turns

/// What the swiped-to-turn band shows: the turn's prompt, shortened to one line, and the first line
/// of its reply.
struct DispatchPillTurnPreview: Equatable {
    let prompt: String
    let reply: String
    /// "3/7" — which turn, of how many.
    let position: String
}

/// PURE: a pinned turn's height — the prompt line and as many reply lines as the reply needs (up to
/// `previewReplyLines`), all at the composer's own text size, plus the insets. `lineHeight` and
/// `replyWidth` are measured by the caller (`dispatchPillPreviewHeight(reply:)`).
func dispatchPillPreviewHeight(replyWidth: CGFloat, lineHeight: CGFloat) -> CGFloat {
    let lines = min(DispatchPillMetrics.previewReplyLines,
                    max(1, Int((replyWidth / DispatchPillMetrics.previewTextWidth).rounded(.up))))
    let height = 2 * DispatchPillMetrics.previewVerticalInset + lineHeight
        + DispatchPillMetrics.previewLineGap + CGFloat(lines) * lineHeight
    return ceil(max(DispatchPillMetrics.pillHeight, height))
}

/// The prompt line of a turn the user did not start — Dispatch reporting on its child sessions.
let dispatchPillSessionUpdateLabel = "Update from your sessions"

/// The longest a preview line gets before it is cut with "…".
let dispatchPillPreviewPromptLimit = 90
let dispatchPillPreviewReplyLimit = 140

/// PURE: the preview for `exchanges[index]`, or `nil` when the index is out of range.
func dispatchPillTurnPreview(exchanges: [Exchange], index: Int) -> DispatchPillTurnPreview? {
    guard exchanges.indices.contains(index) else { return nil }
    let exchange = exchanges[index]
    let prompt = dispatchPillShortened(exchange.prompt, limit: dispatchPillPreviewPromptLimit)
    let firstLine = exchange.reply
        .components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .first { !$0.isEmpty } ?? ""
    let reply = dispatchPillShortened(dispatchPillStrippingMarkdownLead(firstLine),
                                      limit: dispatchPillPreviewReplyLimit)
    return DispatchPillTurnPreview(
        // A turn with no prompt is Dispatch's own: the daemon woke it to report on the sessions it
        // spawned (`dispatch-wake`, which `SessionReducer` opens as a promptless exchange).
        prompt: prompt.isEmpty ? dispatchPillSessionUpdateLabel : prompt,
        reply: reply.isEmpty ? (exchange.aborted ? "stopped" : "no reply yet") : reply,
        position: "\(index + 1)/\(exchanges.count)"
    )
}

/// Collapses every run of whitespace (newlines included) to one space and cuts at `limit`
/// characters with a trailing "…".
func dispatchPillShortened(_ text: String, limit: Int) -> String {
    let collapsed = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    guard collapsed.count > limit, limit > 1 else { return collapsed }
    return String(collapsed.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
}

/// A reply's first line is often a markdown heading or bullet; the preview shows its words.
func dispatchPillStrippingMarkdownLead(_ line: String) -> String {
    var s = Substring(line)
    while let first = s.first, first == "#" || first == ">" { s = s.dropFirst() }
    if s.hasPrefix("- ") || s.hasPrefix("* ") || s.hasPrefix("+ ") { s = s.dropFirst(2) }
    return s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "**", with: "")
}
