// swift-tools-version:5.9
import PackageDescription

// NormaChatKit — the phone's STANDALONE chat engine (chat Slice D).
//
// Everything the iOS app needs to run a chat turn with NO Mac in the loop: its own Codex OAuth
// (this task), the PageCore/tool ports, the ChatEngine, and the local event store + sync client.
// Deliberately a THIRD package rather than another NormaKit target: NormaKit's targets pull in
// IrohLib (a binary xcframework) and Mac-only code, and the chat engine must stay linkable on its
// own. Only NormaProtocol is shared — the two engines speak ONE `SessionEvent` dialect.
//
// KEEP IN SYNC with the root umbrella `Package.swift`: its `NormaChatKit` target must mirror this
// target's dependency list. norma-ios consumes the umbrella's product at a `v-*-kitN` git tag.
let package = Package(
    name: "NormaChatKit",
    // Latest-OS floors (standing user rule) — identical to NormaKit/NormaProtocol.
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "NormaChatKit", targets: ["NormaChatKit"]),
    ],
    dependencies: [
        .package(path: "../NormaProtocol"),
    ],
    targets: [
        .target(name: "NormaChatKit", dependencies: ["NormaProtocol"]),
        .testTarget(name: "NormaChatKitTests", dependencies: ["NormaChatKit", "NormaProtocol"]),
    ]
)
