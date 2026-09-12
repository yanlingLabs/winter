// swift-tools-version:5.9
import PackageDescription

// WinterChatKit — the phone's STANDALONE chat engine (chat Slice D).
//
// Everything the iOS app needs to run a chat turn with NO Mac in the loop: its own Codex OAuth
// (this task), the PageCore/tool ports, the ChatEngine, and the local event store + sync client.
// Deliberately a THIRD package rather than another WinterKit target: WinterKit's targets pull in
// IrohLib (a binary xcframework) and Mac-only code, and the chat engine must stay linkable on its
// own. Only WinterProtocol is shared — the two engines speak ONE `SessionEvent` dialect.
//
// KEEP IN SYNC with the root umbrella `Package.swift`: its `WinterChatKit` target must mirror this
// target's dependency list. norma-ios consumes the umbrella's product at a `v-*-kitN` git tag.
let package = Package(
    name: "WinterChatKit",
    // Latest-OS floors (standing user rule) — identical to WinterKit/WinterProtocol.
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "WinterChatKit", targets: ["WinterChatKit"]),
    ],
    dependencies: [
        .package(path: "../WinterProtocol"),
    ],
    targets: [
        .target(name: "WinterChatKit", dependencies: ["WinterProtocol"]),
        .testTarget(name: "WinterChatKitTests", dependencies: ["WinterChatKit", "WinterProtocol"]),
    ]
)
