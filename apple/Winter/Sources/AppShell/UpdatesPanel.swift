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
            .padding(updatesPanelPadding)
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
                if let detail = updateStatusDetail(presenter.status) {
                    Text(detail)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            // Clears the close button, which rides the card's own top-trailing corner.
            .padding(.trailing, updatesPanelCloseButtonClearance)

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

/// Whatever Sparkle handed us for this version, rendered as text.
///
/// **Deliberately de-styled.** The notes arrive as HTML (the appcast's `<description>` CDATA, or a
/// downloaded `<sparkle:releaseNotesLink>` body) authored outside this app, and rendering it with
/// its own fonts and colours would put Times New Roman on black text into a themed, dark-mode-aware
/// panel — and would drive a whole second type system through a surface the typography sweep
/// governs. So the HTML is flattened to its text and set in Winter's own type. The link is offered
/// alongside for anyone who wants the formatted page.
///
/// It also degrades to nothing: `UpdatesPanel` only builds this when notes exist, and today's
/// appcast `<description>` is a bare version line (the richer CDATA + link is landing in the
/// release script from another session), so "absent" is the common case and must not leave a box.
private struct ReleaseNotesSection: View {
    let notes: ReleaseNotes
    let link: URL?

    @State private var text: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LibraryGroupHeader(title: "What's new")
            if !text.isEmpty {
                Text(text)
                    .font(Typography.label())
                    .foregroundStyle(Theme.textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10)
            }
            if let link {
                Link("Read the full notes", destination: link)
                    .font(Typography.caption())
                    .padding(.horizontal, 10)
            }
        }
        .task(id: notes) { text = releaseNotesText(notes) }
    }
}

/// Flatten release notes to plain text.
///
/// Not pure (HTML parsing goes through `NSAttributedString`, which is `@MainActor` and reads the
/// text system), which is exactly why it is isolated here and driven from a `.task(id:)` rather
/// than from a view body: parsing is done once per notes value, never per layout pass. Plain-text
/// notes pass straight through. A parse failure falls back to the raw body rather than showing
/// nothing — half-legible beats blank.
@MainActor
func releaseNotesText(_ notes: ReleaseNotes) -> String {
    guard notes.isHTML else { return notes.body.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard let data = notes.body.data(using: .utf8),
          let attributed = try? NSAttributedString(
            data: data,
            options: [.documentType: NSAttributedString.DocumentType.html,
                      .characterEncoding: String.Encoding.utf8.rawValue],
            documentAttributes: nil)
    else { return notes.body.trimmingCharacters(in: .whitespacesAndNewlines) }
    return attributed.string.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - Metrics + glyphs

/// The panel's own inset. Matches `LibraryPanelPlaceholderBody`'s so the two single-pane panels
/// start their content on the same line.
let updatesPanelPadding: CGFloat = 24
let updatesPanelSectionSpacing: CGFloat = 18
/// Room for `ShellFloatingPanel`'s close button, which sits on the card's top-trailing corner
/// rather than in a header band (there is no header — the panels are nameless).
let updatesPanelCloseButtonClearance: CGFloat = 32

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
