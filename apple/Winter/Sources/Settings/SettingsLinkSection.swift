import AppKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → the Winter group (2026-09-18): Support, Feedback, Discord, Donate.
//
// These are LINKS, not settings. Each page is one card with one row: the row opens its URL in the
// default browser, or — while the URL is not known — says "Coming soon" and is not clickable. The
// four pages are built identically so none of them reads as more finished than the others.
// -----------------------------------------------------------------------------------------------

/// The four links, and nothing else. Keyed by its own enum rather than by `SettingsSection` so the
/// table cannot grow a URL for a section that is not a link.
enum WinterLink: String, CaseIterable, Hashable, Sendable {
    case support
    case feedback
    case discord
    case donate
}

/// **THE URL TABLE — every one of these is nil, deliberately.**
///
/// WAITING ON THE USER: the real Support, Feedback, Discord and Donate addresses have not been
/// supplied, and none may be guessed — a plausible-looking wrong link is worse than no link. Fill
/// each one in here (and nowhere else); its row becomes clickable with no other change.
struct WinterLinkTable: Hashable, Sendable {
    var support: URL?
    var feedback: URL?
    var discord: URL?
    var donate: URL?

    func url(for link: WinterLink) -> URL? {
        switch link {
        case .support: return support
        case .feedback: return feedback
        case .discord: return discord
        case .donate: return donate
        }
    }
}

/// The shipped table. See `WinterLinkTable` — all four are waiting on the user.
let winterLinks = WinterLinkTable(support: nil, feedback: nil, discord: nil, donate: nil)

/// PURE: which link a settings section is, or nil for a section that is not one.
func winterLink(for section: SettingsSection) -> WinterLink? {
    switch section {
    case .support: return .support
    case .feedback: return .feedback
    case .discord: return .discord
    case .donate: return .donate
    default: return nil
    }
}

/// PURE: what a link row does. `.opens` carries the URL the row hands the browser; `.comingSoon`
/// is a row with no action at all.
enum WinterLinkRowState: Hashable, Sendable {
    case opens(URL)
    case comingSoon
}

func winterLinkRowState(_ link: WinterLink, in table: WinterLinkTable = winterLinks) -> WinterLinkRowState {
    if let url = table.url(for: link) { return .opens(url) }
    return .comingSoon
}

/// The muted trailing label a URL-less row wears in place of a button.
let winterLinkComingSoonLabel = "Coming soon"

/// PURE: the row's description — what the link is for. The sidebar subtitle, so the two agree.
func winterLinkDescription(_ link: WinterLink) -> String {
    switch link {
    case .support: return settingsSectionSubtitle(.support)
    case .feedback: return settingsSectionSubtitle(.feedback)
    case .discord: return settingsSectionSubtitle(.discord)
    case .donate: return settingsSectionSubtitle(.donate)
    }
}

/// One link page. `table` and `open` are injectable so a preview or a test can supply a URL and
/// record the open without touching the real browser.
struct SettingsLinkSection: View {
    let section: SettingsSection
    var table: WinterLinkTable = winterLinks
    var open: (URL) -> Void = { NSWorkspace.shared.open($0) }

    var body: some View {
        SettingsPage(title: settingsSectionTitle(section)) {
            SettingsGroup {
                if let link = winterLink(for: section) {
                    SettingsRow(settingsSectionTitle(section), description: winterLinkDescription(link)) {
                        switch winterLinkRowState(link, in: table) {
                        case .opens(let url):
                            SettingsButton("Open") { open(url) }
                        case .comingSoon:
                            Text(winterLinkComingSoonLabel)
                                .font(Typography.control())
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                }
            }
        }
    }
}
