import SwiftUI

// MARK: - The updates panel (2026-09-17, built 2026-09-18)

/// What this panel is, and why it is a panel rather than a settings row:
///
/// - it CHECKS on open, so opening it is the action;
/// - it shows the release notes for whatever it found;
/// - it renders the download's own progress, which is the point — the user's call was to replace
///   Sparkle's stock progress window, and a settings row cannot host that;
/// - it lists what is installed: Winter itself, Chromium/CEF (both readable locally), and the three
///   SDK versions (which need the daemon's versions RPC — another session is building it, and the
///   answer carries BOTH the compile-time pins and what is actually installed, because a mismatch
///   is a normal state to render rather than an error).
///
/// The Sparkle swap this implies SHIPPED: `SPUUpdater`'s engine — appcast parsing, channel gating,
/// EdDSA verification, the install — is untouched. What is replaced is `SPUStandardUserDriver`, the
/// UI half `SPUStandardUpdaterController` used to bundle in (`WinterUserDriver`,
/// `Sources/Updates/`).
///
/// **It has no header.** `ShellFloatingPanel` owns the chrome and these panels are nameless by
/// design (user call, 2026-09-17); the first thing in the body is the update state itself.
///
/// **In a Debug build there is no updater at all** — Sparkle is constructed `#if !DEBUG`, so the
/// dev app reaches this panel with `UpdateStatus.unavailable`. That is a rendered, explained state
/// (`updateStatusHeadline`/`updateStatusDetail`), not an empty box: the installed-versions half
/// still works, because both of its local readers are plain `Info.plist` reads.
struct UpdatesPanel: View {
    let wiring: DashboardWiring?

    var body: some View {
        if let presenter = wiring?.updates {
            UpdatesPanelBody(presenter: presenter, sdkVersions: wiring?.sdkVersions)
        } else {
            // Reachable only with no daemon wiring at all (`makeDashboardWiring` returns nil when
            // the peripheral provider or helper client is missing). The presenter is constructed
            // unconditionally in the real app, so this is not the Debug case.
            LibraryPanelPlaceholderBody(
                title: "Updates",
                detail: "Installed versions, release notes, and the download itself.",
                hasWiring: false)
        }
    }
}

/// The panel proper, split out so `presenter` can be an `@ObservedObject` (a property wrapper needs
/// a non-optional value, and the wiring hands one down optionally).
private struct UpdatesPanelBody: View {
    @ObservedObject var presenter: UpdatePresenter
    let sdkVersions: (() async throws -> [InstalledComponent])?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: updatesPanelSectionSpacing) {
                statusSection
                if let notes = presenter.notes {
                    ReleaseNotesSection(notes: notes, link: presenter.notesURL)
                }
                versionsSection
            }
            .padding(.horizontal, shellPanelEdgeInset)
            .padding(.bottom, updatesPanelPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Opening the panel IS the check (see the type doc). `checkOnOpen` refuses to stomp a flow
        // already in progress, so re-opening mid-download shows the download rather than restarting
        // anything.
        .task {
            presenter.checkOnOpen()
            await presenter.loadSdkVersions(sdkVersions)
        }
        // The reply contract: a `.found` state is Sparkle waiting on an answer, and closing the
        // panel has to be an answer or the updater wedges for the life of the process.
        .onDisappear { presenter.panelClosed() }
    }

    // MARK: The state

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(updateStatusHeadline(presenter.status))
                    .font(Typography.bodyLarge(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    // On the shared header line, level with the close glyph.
                    .frame(height: shellPanelHeaderHeight)
                if let detail = updateStatusDetail(presenter.status) {
                    Text(detail)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            // Clears the close button, which rides the card's own top-trailing corner.
            .padding(.trailing, shellOverlayCloseGutter)

            if updateShowsProgress(presenter.status) {
                progressBar
            }
            if let primary = updatePrimaryAction(presenter.status) {
                Button(primary.title) { presenter.perform(primary.action) }
                    .font(Typography.control())
            }
        }
    }

    /// Determinate where Sparkle gave us a total, indeterminate where it did not — which is a real
    /// case, not a defect: `showDownloadDidReceiveExpectedContentLength:` is optional, the value can
    /// be wrong, and extraction reports nothing until its first progress callback.
    @ViewBuilder
    private var progressBar: some View {
        if let fraction = updateProgressFraction(presenter.status) {
            ProgressView(value: fraction)
                .progressViewStyle(.linear)
        } else {
            ProgressView()
                .progressViewStyle(.linear)
        }
    }

    // MARK: The installed-versions table

    private var versionsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            LibraryGroupHeader(title: "Installed")
            ForEach(rows) { component in
                LibraryRow(systemImage: updatesComponentGlyph(component.name),
                           title: component.name,
                           subtitle: installedComponentValue(component),
                           subtitleIsMono: true)
            }
            if let error = presenter.sdkError {
                Text(error)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .padding(.horizontal, 10)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Recomputed per body evaluation on purpose: both local reads are `Info.plist` lookups off an
    /// already-loaded (Winter) or memory-mapped (CEF) bundle, and neither one initialises anything.
    /// Caching them would buy nothing and would go stale across a staged install.
    private var rows: [InstalledComponent] {
        installedComponents(winter: winterInstalledVersion(),
                            chromium: embeddedChromiumVersion(),
                            sdk: presenter.sdkComponents)
    }
}

// MARK: - Release notes

/// Whatever Sparkle handed us for this version, set in Winter's own type.
///
/// **Structured, not flattened — and not imported either.** The notes arrive as HTML: the appcast's
/// `<description>`, which from the next release carries the SDK version line followed by the
/// release notes as `h2`/`h3`/`p`/`ul`/`pre`/`code`/`strong`. The previous pass flattened all of
/// that to `attributed.string`, which was right while a `<description>` was one plain line and is
/// wrong now — it throws away the headings, lists and code the reader is here for.
///
/// It is still not rendered as HTML. `NSAttributedString(html:)` imports the document's OWN fonts
/// and colours (Times New Roman on black, into a themed dark-mode-aware panel) and would drive a
/// second type system straight through the surface `TypographyTests` sweeps. Instead
/// `parseReleaseNotesHTML` — pure, table-tested, `Sources/Updates/ReleaseNotesMarkup.swift` —
/// turns the markup into blocks, and every one of them is drawn below with `Typography`/`Theme`
/// tokens. An unknown tag degrades to its text; raw markup never reaches the screen.
///
/// It also degrades to nothing: `UpdatesPanel` only builds this when notes exist, so "absent" stays
/// a common case that must not leave an empty box. The link is offered when the feed carries a
/// `<sparkle:releaseNotesLink>` — the new feed deliberately does NOT, so the inline path above is
/// the one that renders.
private struct ReleaseNotesSection: View {
    let notes: ReleaseNotes
    let link: URL?

    /// Parsed once per notes VALUE, in a `.task(id:)` — never per layout pass. The parse is pure
    /// and cheap, but a 3800-character description re-parsed on every body evaluation would be a
    /// silly thing to do to a scroll view.
    @State private var blocks: [ReleaseNotesBlock] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LibraryGroupHeader(title: "What's new")
            VStack(alignment: .leading, spacing: releaseNotesBlockSpacing) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { entry in
                    ReleaseNotesBlockView(block: entry.element)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            if let link {
                Link("Read the full notes", destination: link)
                    .font(Typography.caption())
                    .padding(.horizontal, 10)
            }
        }
        .task(id: notes) { blocks = releaseNotesBlocks(notes) }
    }
}

/// One parsed block, in Winter's type.
///
/// The whole point of the pure/impure split: every DECISION (what is a heading, what is a bullet,
/// which runs are code) was made in `ReleaseNotesMarkup.swift` and pinned by a table test. This
/// view only chooses tokens.
private struct ReleaseNotesBlockView: View {
    let block: ReleaseNotesBlock

    var body: some View {
        switch block {
        case .subtitle(let runs):
            // Metadata, not notes: the SDK version pair reads as a quiet caption under the heading
            // rather than as the first sentence of the release.
            releaseNotesText(runs, style: .subtitle)
                .foregroundStyle(Theme.textMuted)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let runs):
            releaseNotesText(runs, style: .heading(level))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, releaseNotesHeadingLead)
        case .paragraph(let runs):
            releaseNotesText(runs, style: .body)
                .foregroundStyle(Theme.textSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .bullet(let runs):
            HStack(alignment: .firstTextBaseline, spacing: releaseNotesBulletGap) {
                Text("•")
                    .font(Typography.label())
                    .foregroundStyle(Theme.textMuted)
                releaseNotesText(runs, style: .body)
                    .foregroundStyle(Theme.textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, releaseNotesBulletIndent)
        case .code(let text):
            // Wrapped, not horizontally scrolled: a nested scroll view inside the panel's own
            // ScrollView is a worse trade than a long `winter login …` line folding.
            Text(text)
                .font(Typography.captionMono())
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(releaseNotesCodePadding)
                .background(
                    RoundedRectangle(cornerRadius: releaseNotesCodeCorner, style: .continuous)
                        .fill(Theme.controlSurface))
        }
    }
}

/// Which register a set of runs is drawn in. One value per block kind, so the ladder lives in one
/// `switch` rather than being spelled at four call sites.
private enum ReleaseNotesTextStyle {
    case subtitle
    case heading(Int)
    case body

    /// The proportional face for a run, at the weight its marks ask for.
    func font(strong: Bool) -> Font {
        switch self {
        case .subtitle:
            return Typography.caption(strong ? .semibold : .regular)
        case .heading(let level):
            // h1 is the panel's largest step; h2 — the only level this feed actually emits — sits
            // one under it; h3 and deeper share the row/control step. All semibold: a heading is
            // heavy whether or not the author also bolded a word inside it.
            if level <= 1 { return Typography.heading(.semibold) }
            if level == 2 { return Typography.bodyLarge(.semibold) }
            return Typography.control(.semibold)
        case .body:
            return Typography.label(strong ? .semibold : .regular)
        }
    }

    /// The monospaced face for an inline `code` run, matched to its neighbours as closely as the
    /// three mono steps allow (there is no 15 pt mono, so a heading's inline code sits at 13).
    func monoFont(strong: Bool) -> Font {
        switch self {
        case .subtitle:
            return Typography.captionMono(strong ? .semibold : .regular)
        case .heading(let level):
            return level <= 2 ? Typography.controlMono(.semibold) : Typography.labelMono(.semibold)
        case .body:
            return Typography.labelMono(strong ? .semibold : .regular)
        }
    }
}

/// Inline runs → one concatenated `Text`.
///
/// Concatenation rather than per-run views because a paragraph must WRAP across its runs: three
/// `Text`s in an `HStack` would lay out as three unbreakable columns. `Text + Text` keeps it one
/// paragraph, and per-run `.font(...)` is the only styling this surface is allowed (`.bold()` and
/// friends are banned by the typography sweep — every face here comes from a named token).
private func releaseNotesText(_ runs: [ReleaseNotesRun], style: ReleaseNotesTextStyle) -> Text {
    runs.reduce(Text(verbatim: "")) { accumulated, run in
        let face = run.isCode ? style.monoFont(strong: run.isStrong) : style.font(strong: run.isStrong)
        return accumulated + Text(run.text).font(face)
    }
}

// MARK: - Release-notes metrics

/// The gap between two notes blocks. Headings buy extra room above them (`releaseNotesHeadingLead`)
/// so a section reads as a section rather than as one more paragraph.
let releaseNotesBlockSpacing: CGFloat = 7
let releaseNotesHeadingLead: CGFloat = 5
let releaseNotesBulletGap: CGFloat = 6
let releaseNotesBulletIndent: CGFloat = 2
let releaseNotesCodePadding: CGFloat = 8
let releaseNotesCodeCorner: CGFloat = 6

// MARK: - Metrics + glyphs

/// The panel's own inset. Matches `LibraryPanelPlaceholderBody`'s so the two single-pane panels
/// start their content on the same line.
let updatesPanelPadding: CGFloat = 24
let updatesPanelSectionSpacing: CGFloat = 18

/// PURE: the row glyph for an installed component. Unknown names fall back to the generic one, so a
/// row the daemon adds later still renders.
func updatesComponentGlyph(_ name: String) -> String {
    switch name {
    case "Winter": return "snowflake"
    case "Chromium": return "globe"
    case "Claude agent SDK": return "sparkles"
    default: return "shippingbox"
    }
}
