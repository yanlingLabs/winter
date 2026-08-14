import AppKit
import NormaKit
import SwiftUI

// MARK: - Metrics

/// The gap either side of the ± marker column, and between the gutter and the code. Small: the
/// gutter is a rail, not a column of content, and the eye should cross it without stopping.
let panelDiffGutterGap: CGFloat = 6

/// Breathing room at the end of the longest line, so the last character never sits flush against
/// the right edge of a maximally-scrolled row.
let panelDiffTrailingPad: CGFloat = 16

/// Per-row vertical padding. One point either side: a diff is read as a BLOCK, and any more turns a
/// 40-line hunk into a scroll marathon. (The transcript's code block uses 8-10pt for the whole
/// block, not per line.)
let panelDiffRowVerticalPad: CGFloat = 1

/// How many of the longest lines are actually MEASURED when sizing the scrollable content
/// (`diffMeasuredTextWidth`). Character count picks the candidates; only these few are rendered
/// into a size, because a character count is not a width — tabs, CJK and combining marks all break
/// the assumption, and the widest line by characters is not always the widest by points.
let panelDiffWidthSampleCount = 8

// MARK: - Pure presentation decisions

/// How many DIGITS the gutter's number columns need — the largest line number either side, in
/// digits. Both columns get the same width, so a hunk at line 9 and one at line 1204 do not draw
/// two differently-indented blocks in the same file.
///
/// Never zero: a patch with no numbered rows at all (an empty parse, or one that is nothing but a
/// truncation banner) still lays out, one digit wide.
func diffGutterDigits(_ rows: [DiffRow]) -> Int {
    let largest = rows.reduce(0) { max($0, max($1.oldLine ?? 0, $1.newLine ?? 0)) }
    return max(1, String(largest).count)
}

/// The width of `count` monospaced characters in the diff's ONE face — `Typography.syntaxCodeNS`,
/// the same face `SyntaxHighlighter` stamps into every code run (`docs/brand.md` § 4.3's
/// `codeBlock` role). Measured rather than assumed, and measured from the token rather than from a
/// literal: this surface introduces no size of its own, which is what "bound to the existing
/// code-block role" means (design spec § 4).
@MainActor
func panelDiffMonoWidth(characters count: Int) -> CGFloat {
    guard count > 0 else { return 0 }
    let probe = String(repeating: "0", count: count) as NSString
    return ceil(probe.size(withAttributes: [.font: Typography.syntaxCodeNS]).width)
}

/// A cheap, monospace-aware proxy for how WIDE a line renders. Used ONLY to nominate the handful of
/// candidates that are then really measured — never as a width itself.
///
/// Raw character count is the obvious proxy and it is wrong in one systematic direction: in a
/// monospaced face a CJK glyph occupies TWO advances while counting as one character, so a line of
/// 30 kanji renders wider than a line of 50 ASCII characters that beats it on count. Scalars beyond
/// Latin-1 count double, which is what makes the nomination track the rendering rather than fight
/// it.
func diffApproxWidthUnits(_ text: String) -> Int {
    text.unicodeScalars.reduce(0) { $0 + ($1.value > 0xFF ? 2 : 1) }
}

/// The widest CODE line, in points — the sampled few really rendered into a size.
///
/// **Sampled rather than exhaustive, and the number behind that:** measuring every line of a patch
/// at the daemon's 1 MiB cap (~19k lines) costs ~93 ms on this machine, all of it on the main actor
/// at the instant a tab opens; nominating by `diffApproxWidthUnits` and measuring the top few costs
/// ~5 ms and lands on the same answer for any line-based file. What a bad nomination could cost is
/// bounded and cosmetic — the row tint stopping short of an unusually wide line — because the row
/// text is `fixedSize`d, so an under-estimated width can never TRUNCATE code, which is the failure
/// that would actually matter.
@MainActor
func diffMeasuredTextWidth(_ rows: [DiffRow], sampling limit: Int = panelDiffWidthSampleCount) -> CGFloat {
    let candidates = rows
        .filter { $0.kind == .context || $0.kind == .added || $0.kind == .removed }
        .map { (units: diffApproxWidthUnits($0.text), text: $0.text) }
        .sorted { $0.units > $1.units }
        .prefix(limit)
    let attributes: [NSAttributedString.Key: Any] = [.font: Typography.syntaxCodeNS]
    return candidates.reduce(CGFloat(0)) { widest, candidate in
        max(widest, ceil((candidate.text as NSString).size(withAttributes: attributes).width))
    }
}

/// A file extension → the language name `SyntaxHighlighter` understands (`normalizedLanguage`'s
/// vocabulary, extended here for the extensions a diff actually arrives with). `nil` — an unknown
/// or absent extension — is the highlighter's generic branch, which still tints strings, numbers,
/// `//` comments and the four universal literals.
///
/// **`yaml` and `markdown` are returned honestly, not faked.** The highlighter has no branch for
/// either today, so they land on that same generic branch — a YAML file's `#` comments will not
/// tint. Mapping them to `shell` would buy that one effect by lying about the language, and the
/// moment the highlighter grows a real branch the lie becomes a bug that nothing points at. The
/// truthful name costs nothing now and is correct later.
func diffSyntaxLanguage(forPath path: String) -> String? {
    switch (path as NSString).pathExtension.lowercased() {
    case "swift": return "swift"
    case "py", "pyi": return "python"
    case "js", "jsx", "mjs", "cjs": return "javascript"
    case "ts", "tsx", "mts", "cts": return "typescript"
    case "json", "jsonc": return "json"
    case "html", "htm": return "html"
    case "xml", "svg", "plist", "storyboard", "xib": return "xml"
    case "css", "scss": return "css"
    case "sh", "bash", "zsh": return "shell"
    case "yml", "yaml": return "yaml"
    case "md", "markdown": return "markdown"
    default: return nil
    }
}

/// Mono text at the code face, carried as an ATTRIBUTE rather than as a `.font(...)` modifier.
///
/// Two reasons, and the second is the binding one. It guarantees the gutter is set in the exact
/// face `SyntaxHighlighter` uses for the code beside it, so the numbers and the lines they number
/// share a baseline and an advance. And a `Font(_: NSFont)` conversion at a call site is precisely
/// what `TypographyTests`' sweep bans — the sanctioned way to reach an `NSFont` token from a view
/// is the `NSAttributedString` pipeline the transcript's own highlighter already uses.
///
/// Carries no colour: the caller's `.foregroundStyle` therefore applies, which is what lets one
/// helper serve muted context numbers and both diff roles.
func diffMonoText(_ string: String) -> AttributedString {
    AttributedString(NSAttributedString(string: string,
                                        attributes: [.font: Typography.syntaxCodeNS]))
}

/// The ± column's one character. Not decoration: it is the ONLY channel that survives colour
/// blindness, a screenshot in greyscale, and a screen reader — the washes and the roles both being
/// colour (`docs/brand.md` § 3's diff block records the same reasoning for the chip's signs).
func diffRowMarker(_ kind: DiffRowKind) -> String {
    switch kind {
    case .added: return "+"
    case .removed: return "-"
    case .context, .hunkSeparator, .truncatedBanner: return " "
    }
}

// MARK: - The fetch, and the three states

/// Why a diff tab has nothing to show. Deliberately ONE case with no payload: every failure —
/// no client, a NOT_FOUND for a patch that was deleted, an INVALID_PARAMS for a malformed id, a
/// transport error — lands the user in the same calm place, because there is nothing they could do
/// differently for any of them. The distinction lives in the log, not on screen.
/// (The other "nothing to show" case — a tab carrying no `diffId` — never becomes an error at all:
/// it is decided by inspection, before any fetch. See `PanelDiffTabModel.load`.)
enum PanelDiffUnavailable: Error {
    /// The shell has no management client — a shell built without one (every test that does not ask
    /// for one, and the brief window before the app finishes booting).
    case noClient
}

/// A loaded diff, with every derived value computed ONCE at load rather than per render pass: the
/// parse, the language, the gutter's digit width and the scrollable content width are all pure
/// functions of a patch that CANNOT CHANGE — a diff is frozen by construction (design spec § 1), so
/// recomputing them would be work whose answer is known.
struct PanelDiffLoaded: Equatable {
    let payload: PanelDiffPayload
    let rows: [DiffRow]
    let language: String?
    let gutterDigits: Int
    /// Width of ONE number column (both are equal — see `diffGutterDigits`).
    let numberColumnWidth: CGFloat
    /// The full gutter: two number columns, the marker, and the gaps around them.
    let gutterWidth: CGFloat
    /// Gutter + the widest measured line + trailing pad. The row's frame is `max(this, viewport)`,
    /// which is what makes a full-row tint reach both the end of the longest line and the right
    /// edge of the panel.
    let contentWidth: CGFloat

    @MainActor
    init(payload: PanelDiffPayload) {
        self.payload = payload
        let rows = UnifiedDiffParser.parse(payload.patch)
        self.rows = rows
        self.language = diffSyntaxLanguage(forPath: payload.path)
        let digits = diffGutterDigits(rows)
        self.gutterDigits = digits
        let numberWidth = panelDiffMonoWidth(characters: digits)
        self.numberColumnWidth = numberWidth
        let markerWidth = panelDiffMonoWidth(characters: 1)
        self.gutterWidth = panelDiffGutterGap + numberWidth + panelDiffGutterGap + numberWidth
            + panelDiffGutterGap + markerWidth + panelDiffGutterGap
        self.contentWidth = self.gutterWidth + diffMeasuredTextWidth(rows) + panelDiffTrailingPad
    }
}

/// Loading → loaded, or loading → unavailable. There is no retry state and no error state to act
/// on: the patch either exists or it is gone forever (the diff store never rewrites a file), so an
/// offered retry would be a button that cannot work.
enum PanelDiffState: Equatable {
    case loading
    case loaded(PanelDiffLoaded)
    case unavailable
}

/// diff-tabs Task 10: what a `.diff` tab KNOWS. One per tab, held by `PanelDiffTabModels` rather
/// than by the view, for the same reason `PanelWebTabModel` is: `ShellPanel` gives the content slot
/// `.id(tabId)`, so switching tabs and switching back REBUILDS the view — a `@StateObject` here
/// would re-fetch the same frozen patch on every visit.
@MainActor
final class PanelDiffTabModel: ObservableObject {
    let tabId: String
    /// Which persisted patch this tab shows. Optional because `PanelTab.diffId` is (every other kind
    /// carries `nil`); a `.diff` tab minted by `openDiffTab` always has one.
    let diffId: String?
    /// The session the patch belongs to — a diff is stored per session, so this is half the key.
    /// Re-bindable until the load starts, because the factory runs on every render pass and the
    /// first one can precede the shell knowing which session it is showing.
    private(set) var sessionId: String?

    @Published private(set) var state: PanelDiffState = .loading

    /// `@MainActor` because it IS main-actor work: the only production implementation reaches
    /// `ShellSessionHost` (main-actor by declaration), and this model — which owns the state the
    /// view renders — is too. Annotating the type says so instead of leaving every call site to
    /// hop actors for a closure that never leaves this one.
    private let fetch: @MainActor (String, String) async throws -> PanelDiffPayload

    /// **The load is UNSTRUCTURED, and that is the point.** Driving it from the view's `.task`
    /// alone would tie it to the view's lifetime: switching tabs mid-fetch cancels the task, and
    /// with a "did we start" flag already set the tab would sit on its spinner forever, with no
    /// retry door (there is deliberately none — see `PanelDiffState`). Owning the `Task` here means
    /// the fetch outlives the view that asked for it, and the second visit finds it finished.
    private var loadTask: Task<Void, Never>?

    init(tabId: String, diffId: String?, sessionId: String?,
         fetch: @escaping @MainActor (String, String) async throws -> PanelDiffPayload) {
        self.tabId = tabId
        self.diffId = diffId
        self.sessionId = sessionId
        self.fetch = fetch
    }

    /// Re-point at a session. Called from the factory on every render pass, so it must be
    /// idempotent and must not disturb `state` — and it deliberately stops mattering once the load
    /// has begun: the patch a fetch is already in flight for is the patch this tab shows.
    func bind(sessionId: String?) {
        guard loadTask == nil, let sessionId else { return }
        self.sessionId = sessionId
    }

    /// Fetch once, ever. Not "once per appear": `loadTask` is the flag, so a second appear, a tab
    /// switch, a window move and a re-render all find the same task (or its result).
    func startLoadingIfNeeded() {
        guard loadTask == nil else { return }
        loadTask = Task { @MainActor [weak self] in await self?.load() }
    }

    private func load() async {
        guard let diffId, let sessionId else {
            // No fetch at all — an id-less tab is unavailable by inspection, not by round trip.
            state = .unavailable
            return
        }
        do {
            state = .loaded(PanelDiffLoaded(payload: try await fetch(sessionId, diffId)))
        } catch {
            // Every error is the same calm state — see `PanelDiffUnavailable`.
            state = .unavailable
        }
    }

    /// The RAW patch onto the pasteboard — hunk headers, `\ No newline` markers and all. What is on
    /// screen is a rendering; what a person pastes into `git apply`, a message or an editor has to
    /// be the artifact itself, so this deliberately does not reassemble anything from `rows`.
    ///
    /// `pasteboard` is a parameter so a test can drive it against its own named pasteboard: the app
    /// suite runs on the developer's own Mac, and a test that wrote to `.general` would silently
    /// eat whatever they had copied.
    @discardableResult
    func copyPatch(to pasteboard: NSPasteboard = .general) -> Bool {
        guard case .loaded(let loaded) = state else { return false }
        pasteboard.clearContents()
        return pasteboard.setString(loaded.payload.patch, forType: .string)
    }

    /// Test seam: start the load and await it. Production never awaits — the view watches
    /// `@Published state` instead.
    func loadForTesting() async {
        startLoadingIfNeeded()
        await loadTask?.value
    }
}

/// One model per tab id, mirroring `PanelWebTabModels` (`PanelWebChrome.swift`) — including its
/// reason for existing: the content factory runs on every render pass, so the model cannot be born
/// there without being reborn there.
@MainActor
enum PanelDiffTabModels {
    private static var models: [String: PanelDiffTabModel] = [:]

    /// The cached model for this tab, or a fresh one.
    ///
    /// **A cached model whose `diffId` disagrees with the tab's is REPLACED**, not re-bound. It
    /// cannot happen — a diff tab's id is minted with the tab and the patch behind it never changes
    /// — but the alternative behaviour if it ever did is a tab confidently showing another edit's
    /// diff, which is the kind of wrong that is never noticed.
    static func model(for tab: PanelTab, host: ShellSessionHost?, sessionId: String?) -> PanelDiffTabModel {
        if let cached = models[tab.tabId], cached.diffId == tab.diffId {
            cached.bind(sessionId: sessionId)
            return cached
        }
        let fresh = PanelDiffTabModel(tabId: tab.tabId, diffId: tab.diffId, sessionId: sessionId) {
            [weak host] session, diff in
            guard let host else { throw PanelDiffUnavailable.noClient }
            return try await host.readPanelDiff(sessionId: session, diffId: diff)
        }
        models[tab.tabId] = fresh
        return fresh
    }

    /// Dropped when the user closes the tab (`ShellSessionHost.closePanelTab`, beside the web
    /// registry's own discard). Not merely tidy here: a loaded model holds the patch string and its
    /// parsed rows, and a patch is capped at 1 MiB — twenty closed diff tabs would otherwise pin
    /// twenty of them for the life of the process.
    static func discard(tabId: String) {
        models.removeValue(forKey: tabId)
    }

    /// Test seam only — `models` is process-global state.
    static func removeAllForTesting() {
        models.removeAll()
    }
}

// MARK: - The tab

/// diff-tabs Task 10: the `.diff` implementation of `PanelTabContent`, replacing the placeholder
/// Task 9 routed here.
///
/// It renders a FROZEN artifact: the patch was written once, at the moment the agent edited the
/// file, and nothing ever rewrites it. Everything below follows from that — one fetch, no refresh,
/// no retry, no live updates, and every derived value computed at load.
struct PanelDiffTab: PanelTabContent {
    let tab: PanelTab
    /// Shared by both slots, so the chrome's counts and the content's rows can never describe two
    /// different loads. Looked up once, in `panelTabContent(for:host:sessionId:)`.
    let model: PanelDiffTabModel

    var kind: PanelTabKind { .diff }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(.diff)) }

    func makeChrome() -> AnyView { AnyView(PanelDiffChrome(model: model, tab: tab)) }
    func makeContent() -> AnyView { AnyView(PanelDiffContent(model: model, tab: tab)) }
}

// MARK: - The chrome row

/// Path, counts, copy. **No URL bar and no navigation** — there is nowhere to go: a diff tab has
/// exactly one destination and it is already there.
struct PanelDiffChrome: View {
    @ObservedObject var model: PanelDiffTabModel
    let tab: PanelTab

    @State private var didCopy = false

    var body: some View {
        HStack(spacing: panelDiffGutterGap) {
            Text(displayPath)
                .font(Typography.captionMono())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                // Middle, like the transcript chip's own path: the tail is the filename and the
                // head is the folder, and the middle is the part nobody reads.
                .truncationMode(.middle)

            if case .loaded(let loaded) = model.state {
                // `-N` first, then `+M` — the SAME order and the same roles as the chip that opened
                // this tab (`fileDiffChipText`), so the two surfaces read as one thing.
                Text("-\(loaded.payload.removed)")
                    .font(Typography.captionMono())
                    .foregroundStyle(Theme.diffRemovedRole)
                Text("+\(loaded.payload.added)")
                    .font(Typography.captionMono())
                    .foregroundStyle(Theme.diffAddedRole)
            }

            Spacer(minLength: panelDiffGutterGap)

            if case .loaded = model.state {
                // `ShellTitlebarButton` is the app's ONE chrome-button treatment (hover, highlight,
                // hit box all from `ShellSidebarRowStyle`) — the transcript's copy control has its
                // own hover grammar because it lives in the transcript, and reproducing it here
                // would be a second mechanism that merely happens to agree. The BEHAVIOUR is the
                // transcript's, verbatim: clear, set, and a 1.2s confirmation on the glyph itself.
                ShellTitlebarButton(systemImage: didCopy ? "checkmark" : "doc.on.doc",
                                    label: didCopy ? "Copied" : "Copy patch",
                                    size: panelChromeButtonSize) {
                    guard model.copyPatch() else { return }
                    didCopy = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { didCopy = false }
                }
            }
        }
        .padding(.horizontal, panelTabPillInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The loaded patch's own path once it is known; until then the tab's title, which
    /// `openDiffTab` set to the file's basename — so the row never flashes empty and never lies.
    private var displayPath: String {
        if case .loaded(let loaded) = model.state {
            return fileDiffChipDisplayPath(loaded.payload.path)
        }
        return panelTabDisplayTitle(tab)
    }
}

// MARK: - The content

/// The three states, and the row list.
struct PanelDiffContent: View {
    @ObservedObject var model: PanelDiffTabModel
    /// Only for the unavailable state's path line — the tab's title is the file's basename
    /// (`openDiffTab`), and it is the ONLY thing left to name the file with when the fetch that
    /// would have carried the real path is the thing that failed.
    let tab: PanelTab

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .unavailable:
                unavailable
            case .loaded(let loaded):
                rows(loaded)
            }
        }
        // The view ASKS; the model decides whether anything happens (`startLoadingIfNeeded`), and
        // owns the task so a tab switch cannot cancel it half-way.
        .onAppear { model.startLoadingIfNeeded() }
    }

    /// Calm, centred, and honest about which file it could not show. No retry button: the patch is
    /// gone, and a button that cannot work is worse than none (`PanelDiffState`).
    private var unavailable: some View {
        VStack(spacing: 6) {
            Text("Diff unavailable")
                .font(Typography.emptyStateSubtitle)
                .foregroundStyle(.primary)
            Text(fileDiffChipDisplayPath(panelTabDisplayTitle(tab)))
                .font(Typography.captionMono())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Vertical scroll wrapping horizontal scroll wrapping a `LazyVStack` (design spec § 4, and the
    /// transcript code block's own precedent for the horizontal layer). The `GeometryReader` is
    /// load-bearing rather than decorative: rows are laid out at
    /// `max(contentWidth, viewport width)`, which is the only way a full-row tint both REACHES the
    /// end of the longest line and FILLS the panel on a short line.
    private func rows(_ loaded: PanelDiffLoaded) -> some View {
        GeometryReader { geometry in
            ScrollView(.vertical) {
                ScrollView(.horizontal) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(loaded.rows.enumerated()), id: \.offset) { index, row in
                            PanelDiffRowView(row: row, loaded: loaded, isFirstRow: index == 0,
                                             width: max(loaded.contentWidth, geometry.size.width))
                        }
                    }
                }
            }
        }
    }
}

/// One rendered row — a line, a hunk rule, or the truncation banner.
struct PanelDiffRowView: View {
    let row: DiffRow
    let loaded: PanelDiffLoaded
    let isFirstRow: Bool
    let width: CGFloat

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        switch row.kind {
        case .hunkSeparator:
            // A rule, never `@@ -1,6 +1,6 @@` (design spec § 4): the header's numbers are already
            // in the gutter of every row it governs, so printing it would be the same fact twice in
            // the format only a machine reads. Suppressed entirely for the FIRST row — a patch
            // always opens with a header, and a rule there would draw a second line directly under
            // the chrome band's own divider.
            if isFirstRow {
                Color.clear.frame(width: width, height: 0)
            } else {
                Rectangle()
                    .fill(Theme.hairline)
                    .frame(width: width, height: 1)
                    .padding(.vertical, panelDiffGutterGap)
            }
        case .truncatedBanner:
            HStack(spacing: panelDiffGutterGap) {
                Image(systemName: "scissors")
                Text("This patch was too large to store in full — the rest is not shown.")
            }
            .font(Typography.caption())
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, panelDiffGutterGap)
            .padding(.vertical, panelDiffGutterGap)
            .frame(width: width, alignment: .leading)
            .background(Theme.elevatedSurface)
        case .context, .added, .removed:
            lineRow
        }
    }

    private var lineRow: some View {
        HStack(spacing: 0) {
            number(row.oldLine)
            number(row.newLine)

            Text(diffMonoText(diffRowMarker(row.kind)))
                .foregroundStyle(numberStyle)
                .frame(width: panelDiffMonoWidth(characters: 1), alignment: .center)
                .padding(.leading, panelDiffGutterGap)
                .padding(.trailing, panelDiffGutterGap)

            // The transcript's own highlighter, per row. It stamps `Typography.syntaxCodeNS` and
            // `labelColor` into every run, so the code reads identically here and in a chat code
            // block — and its explicit foreground is why the washes below can be soft: the text is
            // not fighting them for legibility.
            Text(SyntaxHighlighter.highlighted(row.text, language: loaded.language,
                                               colorScheme: colorScheme))
                .textSelection(.enabled)
                // A diff line is ONE line, always. Without these a row whose text is wider than the
                // width computed at load would wrap or ellipsise — i.e. silently hide code, which is
                // the one outcome this surface must never produce. `fixedSize` makes an
                // under-estimate cost a short tint instead (see `diffMeasuredTextWidth`).
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)

            Spacer(minLength: 0)
        }
        .padding(.vertical, panelDiffRowVerticalPad)
        .frame(width: width, alignment: .leading)
        .background(wash)
    }

    private func number(_ value: Int?) -> some View {
        Text(diffMonoText(value.map(String.init) ?? ""))
            .foregroundStyle(numberStyle)
            .frame(width: loaded.numberColumnWidth, alignment: .trailing)
            .padding(.leading, panelDiffGutterGap)
    }

    /// Changed rows wear their role; context rows wear the meta register (`docs/brand.md` § 3.5 —
    /// `TextMuted`, not one of the system's faint greys). The gutter is the one place the two roles
    /// appear as TEXT rather than as a wash, which is why they are foreground tokens at all.
    private var numberStyle: Color {
        switch row.kind {
        case .added: return Theme.diffAddedRole
        case .removed: return Theme.diffRemovedRole
        case .context, .hunkSeparator, .truncatedBanner: return Theme.textMuted
        }
    }

    /// The full-row tint. Context rows are deliberately UNTINTED — a diff where every row has a
    /// background is a diff where nothing stands out.
    private var wash: Color {
        switch row.kind {
        case .added: return Theme.diffAddedWash
        case .removed: return Theme.diffRemovedWash
        case .context, .hunkSeparator, .truncatedBanner: return .clear
        }
    }
}
