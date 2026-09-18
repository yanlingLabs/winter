import Foundation

// MARK: - The update state machine (2026-09-18)
//
// PURE. Nothing in this file imports Sparkle, AppKit or SwiftUI: it is the vocabulary the panel
// renders and the user driver writes, and every function here is a table test away from being
// pinned. `WinterUserDriver` translates Sparkle's callbacks into these cases; `UpdatePresenter`
// owns the one live instance; `UpdatesPanel` reads it and nothing else.

/// The release notes Sparkle handed us for the update it found.
///
/// TWO sources, which is why this is a struct and not a `String`:
/// - `html` — the appcast item's own `<description>`, inline (`SUAppcastItem.itemDescription`).
///   Its `format` is the item's `sparkle:descriptionFormat` when present; Sparkle's own default
///   for an absent format is HTML, so `nil` is treated as HTML here too.
/// - `downloaded` — the body of `<sparkle:releaseNotesLink>`, fetched and signature-checked by
///   Sparkle's own release-notes driver and delivered as `showUpdateReleaseNotesWithDownloadData:`.
///   It arrives AFTER `showUpdateFoundWithAppcastItem:`, so the panel renders the inline notes
///   first and upgrades in place when the download lands.
///
/// Both are optional and both are routinely absent. Every item live in the feed today
/// (0.111.0 – 0.114.4) carries a bare one-line `<description>` and no link at all; from the next
/// release the `<description>` carries that same SDK version line followed by the notes as
/// semantic HTML, and still no link — so the INLINE path is the one that renders either way.
/// `ReleaseNotesMarkup.swift` parses both shapes. The panel renders NO notes section when this
/// resolves to nothing, rather than an empty box.
struct ReleaseNotes: Equatable {
    /// `true` when the body is HTML; `false` for `plain-text`.
    var isHTML: Bool
    var body: String

    /// PURE: Sparkle's `sparkle:descriptionFormat` value → our two-way flag. Sparkle's own reader
    /// treats anything that is not exactly `plain-text` (and `nil`) as HTML.
    static func format(_ sparkleFormat: String?) -> Bool {
        sparkleFormat?.lowercased() != "plain-text"
    }

    /// PURE: build from an appcast item's inline description, dropping blank bodies.
    static func inline(description: String?, format: String?) -> ReleaseNotes? {
        guard let description, !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return ReleaseNotes(isHTML: Self.format(format), body: description)
    }
}

/// Why a downloaded-and-staged update has not installed itself yet.
///
/// Not cosmetic: `UpdaterCoordinator`'s idle gate deliberately holds an install until no agent turn
/// is running and no editor/office buffer is dirty, and until now that policy had no surface at all
/// — the menu bar said only "Update ready — Restart Now". The panel is where a user can finally see
/// WHY their update is sitting there, so the reason is part of the state rather than a footnote.
enum UpdateHoldReason: Equatable {
    /// The gate has not reported; we only know it is staged.
    case unknown
    /// Winter is mid-turn or holding unsaved work — the poll installs at the next quiet moment.
    case busy
}

/// Everything the panel can be showing.
///
/// `unavailable` is first-class rather than an error: Sparkle is constructed `#if !DEBUG` and never
/// under the xctest host, so a dev build genuinely has no updater and must SAY so instead of
/// rendering a check button that does nothing.
enum UpdateStatus: Equatable {
    /// No updater in this build (Debug, or a unit-test host).
    case unavailable
    /// An updater exists and has nothing to report yet.
    case idle
    /// A user-initiated check is in flight.
    case checking
    /// Sparkle already has a session open — a scheduled check, or a background download. A manual
    /// check is a no-op while one runs (`SPUUpdater.checkForUpdates` returns early on
    /// `sessionInProgress`), so the panel says so rather than spinning forever. It is a TRANSIENT
    /// state with a way out: the button re-checks, and so does re-opening the panel. A scheduled
    /// check that finds nothing holds the session for a second or two, and without that way out
    /// this state would be a dead end for the life of the process.
    case backgroundBusy
    /// The check finished and there is nothing newer.
    case upToDate
    /// An update was found and Sparkle is waiting on our reply.
    case found(version: String)
    /// Downloading. `expected == 0` means Sparkle has not reported a content length (it warns the
    /// value can be absent or wrong), which is why the fraction is optional downstream.
    case downloading(received: UInt64, expected: UInt64)
    /// Unpacking. Sparkle reports 0…1; it also calls `showDownloadDidStartExtractingUpdate` first,
    /// which lands here as `extracting(progress: 0)` — indeterminate by convention.
    case extracting(progress: Double)
    /// Staged on disk and ready. Reached from BOTH directions: the user's own Install (Sparkle's
    /// `showReadyToInstallAndRelaunch:`) and the silent background download, which never touches
    /// the user driver at all and surfaces only through `UpdaterCoordinator.onStagedChange`.
    case readyToInstall(version: String?, hold: UpdateHoldReason)
    /// The swap is underway; the app is about to be replaced and relaunched.
    case installing
    /// Sparkle reported an error. The string is Sparkle's own localized description.
    case failed(message: String)
}

/// What the panel's primary button does in this state.
enum UpdateAction: Equatable {
    case check
    case download
    case install
    case cancel
    /// No button at all.
    case none
}

/// PURE: the one-line headline for a state.
func updateStatusHeadline(_ status: UpdateStatus) -> String {
    switch status {
    case .unavailable: return "Updates are disabled in this build"
    case .idle: return "Up to date, as far as we last checked"
    case .checking: return "Checking for updates…"
    case .backgroundBusy: return "Winter is checking on its own right now"
    case .upToDate: return "Winter is up to date"
    case .found(let version): return "Winter \(version) is available"
    case .downloading: return "Downloading…"
    case .extracting: return "Unpacking…"
    case .readyToInstall(let version, _):
        return version.map { "Winter \($0) is ready to install" } ?? "An update is ready to install"
    case .installing: return "Installing…"
    case .failed: return "The update could not be completed"
    }
}

/// PURE: the second line under the headline; `nil` where the headline says everything.
func updateStatusDetail(_ status: UpdateStatus) -> String? {
    switch status {
    case .unavailable:
        // The honest reason, not a shrug: this is what a developer sees every single day, and
        // "disabled" with no cause reads as a bug in the panel rather than a property of the build.
        return "Sparkle is only built into release builds of Winter, so there is nothing to check against here."
    case .idle:
        return "Winter checks on its own in the background and installs when you are not busy."
    case .checking:
        return nil
    case .backgroundBusy:
        return "A scheduled check or a background download is already running. Try again in a moment."
    case .upToDate:
        return nil
    case .found:
        return "Downloading will not interrupt anything — Winter installs at the next quiet moment."
    case .downloading(let received, let expected):
        return downloadProgressText(received: received, expected: expected)
    case .extracting:
        return nil
    case .readyToInstall(_, let hold):
        switch hold {
        case .unknown:
            return "It installs on the next restart. Restart Now does it immediately."
        case .busy:
            // The shipped idle-gate policy, said out loud for the first time.
            return "Waiting for the current turn to finish and for every editor to be saved. Restart Now installs anyway."
        }
    case .installing:
        return "Winter will quit and come back on its own."
    case .failed(let message):
        return message
    }
}

/// PURE: the primary button for a state, and its title.
func updatePrimaryAction(_ status: UpdateStatus) -> (action: UpdateAction, title: String)? {
    switch status {
    case .unavailable:
        return nil
    case .idle, .upToDate, .failed:
        return (.check, "Check Again")
    case .checking:
        return (.cancel, "Cancel")
    case .backgroundBusy:
        return (.check, "Check Again")
    case .found:
        return (.download, "Download and Install")
    case .downloading:
        return (.cancel, "Cancel")
    case .extracting:
        return nil
    case .readyToInstall:
        return (.install, "Restart Now")
    case .installing:
        return nil
    }
}

/// PURE: `true` while the panel should draw a progress bar at all.
func updateShowsProgress(_ status: UpdateStatus) -> Bool {
    switch status {
    case .checking, .downloading, .extracting, .installing: return true
    default: return false
    }
}

/// PURE: the bar's fraction, or `nil` for an indeterminate bar.
///
/// Three ways to be indeterminate, all real: a check in flight, an extraction Sparkle has started
/// but not yet reported progress for, and a download whose server sent no (or a nonsense) content
/// length — Sparkle's own header warns `expectedContentLength` may be absent or smaller than what
/// actually arrives, so a fraction is only honest while `received <= expected`.
func updateProgressFraction(_ status: UpdateStatus) -> Double? {
    switch status {
    case .downloading(let received, let expected):
        return downloadFraction(received: received, expected: expected)
    case .extracting(let progress):
        return progress > 0 ? min(max(progress, 0), 1) : nil
    default:
        return nil
    }
}

/// PURE: 0…1, or `nil` when the total is unknown or already overshot.
func downloadFraction(received: UInt64, expected: UInt64) -> Double? {
    guard expected > 0, received <= expected else { return nil }
    return Double(received) / Double(expected)
}

/// PURE: "12.4 MB of 48.1 MB" — or just "12.4 MB" when no total was advertised.
func downloadProgressText(received: UInt64, expected: UInt64) -> String {
    guard expected > 0 else { return formatUpdateBytes(received) }
    return "\(formatUpdateBytes(received)) of \(formatUpdateBytes(expected))"
}

/// PURE: bytes → a short human string, decimal units (what a download is quoted in).
///
/// Hand-rolled rather than `ByteCountFormatter` so the output is pinnable in a table test on any
/// machine — the formatter's spacing and unit choice are locale- and OS-version-dependent.
func formatUpdateBytes(_ bytes: UInt64) -> String {
    let units = ["bytes", "KB", "MB", "GB"]
    var value = Double(bytes)
    var unit = 0
    while value >= 1000, unit < units.count - 1 {
        value /= 1000
        unit += 1
    }
    if unit == 0 { return "\(bytes) bytes" }
    return String(format: value >= 100 ? "%.0f %@" : "%.1f %@", value, units[unit])
}
