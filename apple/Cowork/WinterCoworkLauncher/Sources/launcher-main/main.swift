import Foundation
import LauncherCore

// winter-cowork-launcher: the daemon's child that stands between Winter and the Cowork VM worker. No entitlements.
exit(LauncherMain.run(arguments: Array(CommandLine.arguments.dropFirst())))
