// swift-tools-version:5.9
import PackageDescription

// winter-browser-host — the native-messaging host behind Winter for Chrome. Chrome starts it for the extension
// (`chrome.runtime.connectNative`); it checks the caller's origin, connects to the daemon's `<home>/run/browser.sock`,
// verifies the daemon's code by its audit token, introduces itself (`host.hello`) and from then on only relays: Chrome's
// native messages (a 4-byte length + JSON) ⇄ the daemon's NDJSON. It ships as `Contents/MacOS/winter-browser-host`
// inside the Winter Computer Use helper bundle, signed with its own identifier and a stated designated requirement.
//
// The library is the whole host and is what `swift test` covers; the executable is `Tool/main.swift` on top of it — the
// same file the xcodegen `WinterBrowserHost` tool target builds (apple/Winter/project.yml), where the test hooks compile
// in only under `WINTER_CU_TEST_BUILD`. It imports nothing outside apple/ComputerUse (nor anything inside it: a relay
// does not need the automation engine). The wire contract is PROTOCOL.md beside this file.
let package = Package(
    name: "WinterBrowserHost",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterBrowserHostCore", targets: ["WinterBrowserHostCore"]),
        .executable(name: "winter-browser-host", targets: ["winter-browser-host"]),
    ],
    targets: [
        .target(
            name: "WinterBrowserHostCore",
            // `#file` as `#fileID`: the release identity scan reads every shipped byte.
            swiftSettings: [.enableUpcomingFeature("ConciseMagicFile")],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Security"),
            ]
        ),
        .executableTarget(
            name: "winter-browser-host",
            dependencies: ["WinterBrowserHostCore"],
            path: "Tool",
            swiftSettings: [.enableUpcomingFeature("ConciseMagicFile")]
        ),
        .testTarget(
            name: "WinterBrowserHostCoreTests",
            dependencies: ["WinterBrowserHostCore"]
        ),
    ]
)
