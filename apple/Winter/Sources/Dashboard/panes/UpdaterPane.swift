import SwiftUI

/// PURE: `updates.channel`'s wire value (`nil`/anything but `"beta"` → stable) → display text —
/// mirrors `UpdaterCoordinator.allowedChannelSet(for:)`'s own "stable/nil/unknown → default only;
/// beta → +beta" fail-toward-stable posture.
func updateChannelDisplay(_ channel: String?) -> String {
    channel == "beta" ? "Beta" : "Stable"
}

/// Task 7 (spec §4's Mac-group additions): the updater's dashboard row — version + channel (READ-
/// ONLY: no settings-WRITE surface exists anywhere in the Mac app yet, and inventing a live
/// channel-picker is out of this task's "re-hosting, not rewrites" scope; a v1 cut, disclosed in
/// the report) + the SAME manual "Check for Updates…" action the menu bar already offers
/// (`MenuBarController.checkForUpdatesItem`). Staged-update state (the menu bar's "Restart Now"
/// line) stays a menu-bar-only affordance this task — `UpdaterCoordinator.stagedVersion`/
/// `onStagedChange` are closure-driven, not `@Published`, and bridging them into a new
/// `ObservableObject` here would be new plumbing beyond a plain re-host.
struct UpdaterPane: View {
    let appVersion: () -> String
    let updateChannel: () -> String?
    let checkForUpdates: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Updates").font(Typography.paneTitle)
            VStack(alignment: .leading, spacing: 6) {
                row("Version", appVersion())
                row("Channel", updateChannelDisplay(updateChannel()))
            }
            Button("Check for Updates…") { checkForUpdates() }
            // 2026-09-18: the Updates panel (the account row's arrow glyph) is now where the check
            // itself renders — progress, release notes, and the installed-versions table. This pane
            // stays the Dashboard's read-only summary + the same manual check; duplicating the
            // panel's live state here would be two surfaces telling the same story.
            Text("Updates install automatically in the background. Progress and release notes show in the Updates panel; a ready update also offers Restart Now from the menu bar.")
                .font(Typography.caption())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding()
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .textSelection(.enabled)
        }
        .font(Typography.labelMono())
    }
}
