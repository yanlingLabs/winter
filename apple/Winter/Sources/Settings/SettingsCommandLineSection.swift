import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Command Line (2026-09-18). Settings-native, written in `SettingsChrome`'s vocabulary
// instead of mounting the Dashboard's `CliInstallerPane`.
//
// Every decision is still the pane's, through the SAME three pure helpers this file deliberately
// does not re-implement — `cliInstallStatusText`, `cliInstallButtonTitle`, `cliInstallActionable`
// (`Dashboard/panes/CliInstallerPane.swift`, table-tested by `DashboardSurfaceTests`). Copying any
// of them here would create a second answer to "is the command installed", and the copy would be
// the one that drifts. `CliInstallerPane` itself is untouched; the Dashboard still renders it.
//
// The dev/dist split is the same branch `MenuBarController.install()` makes: a dev build has no
// symlink to install, it has a wrapper to open.
// -----------------------------------------------------------------------------------------------

struct SettingsCommandLineSection: View {
    let isDev: Bool
    let cliInstallState: () -> CliInstallAction
    let installCli: () -> Void
    let openDevCli: () -> Void

    @State private var state: CliInstallAction = .install

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.commandLine),
                     subtitle: settingsSectionSubtitle(.commandLine)) {
            SettingsGroup {
                if isDev {
                    SettingsRow("Open the CLI",
                                description: "Dev builds use the winter-dev wrapper — this opens a Terminal window running the CLI straight out of this checkout.") {
                        SettingsButton("Open CLI") { openDevCli() }
                    }
                } else {
                    SettingsRow("The winter command",
                                description: cliInstallStatusText(state)) {
                        SettingsButton(cliInstallButtonTitle(state),
                                       isEnabled: cliInstallActionable(state)) {
                            installCli()
                            // Re-derive rather than trust a return value, exactly as
                            // `MenuBarController.didInstallCli()` does.
                            state = cliInstallState()
                        }
                    }
                }
            }
        }
        .task { state = cliInstallState() }
    }
}
