import SwiftUI

/// PURE: `CliInstallAction` → the pane's status line. Mirrors `MenuBarController.
/// applyCliInstallState(_:)`'s own four-way switch (that one drives menu-item title/enabled state;
/// this drives a sentence) — kept as its own function, table-tested directly, same "pure helper
/// next to its View" posture as every other pane in this directory. `@MainActor`: `CliInstaller`
/// (whose `linkPath` this reads) is itself `@MainActor`-isolated — this function's tests already
/// run on the main actor (`DashboardSurfaceTests` is `@MainActor final class`), so this costs
/// nothing there.
@MainActor
func cliInstallStatusText(_ action: CliInstallAction) -> String {
    switch action {
    case .install: return "The `norma` command isn't installed yet."
    case .repair: return "The `norma` command points at an old app location and needs repair."
    case .alreadyInstalled: return "The `norma` command is installed at \(CliInstaller.linkPath)."
    case .refuseForeign(let path): return "A file already exists at \(path) that Norma didn't create — see the logs."
    }
}

/// PURE: the action button's title.
func cliInstallButtonTitle(_ action: CliInstallAction) -> String {
    switch action {
    case .install: return "Install"
    case .repair: return "Repair"
    case .alreadyInstalled: return "Installed"
    case .refuseForeign: return "Can't Install"
    }
}

/// PURE: whether the action button can fire — mirrors `MenuBarController.applyCliInstallState(_:)`'s
/// own enabled/disabled split (`.alreadyInstalled`/`.refuseForeign` both disable there too).
func cliInstallActionable(_ action: CliInstallAction) -> Bool {
    switch action {
    case .install, .repair: return true
    case .alreadyInstalled, .refuseForeign: return false
    }
}

/// Task 7 (spec §4's Mac-group additions): the `norma` command's dashboard row — surfaces the SAME
/// `CliInstaller`(dist)/`CliLauncher`(dev) actions the menu bar already offers
/// (`MenuBarController.cliInstallItem`/`openCliItem`), not a new capability. Dumb view: `isDev` is
/// data, the rest are injected closures — same posture as every other pane in this directory.
struct CliInstallerPane: View {
    let isDev: Bool
    let cliInstallState: () -> CliInstallAction
    let installCli: () -> Void
    let openDevCli: () -> Void

    @State private var state: CliInstallAction = .install

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Command Line").font(.headline)
            if isDev {
                Text("Dev builds use the norma-dev wrapper — opens a Terminal window running the CLI straight out of this checkout.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open CLI") { openDevCli() }
            } else {
                Text(cliInstallStatusText(state))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(cliInstallButtonTitle(state)) {
                    installCli()
                    state = cliInstallState()
                }
                .disabled(!cliInstallActionable(state))
            }
            Spacer()
        }
        .padding()
        .task { state = cliInstallState() }
    }
}
