// swift-tools-version:5.9
import PackageDescription

// The visible layer of the Winter Computer Use helper: the live window mirror, the agent cursor
// overlay and the Esc stop tap. The helper app (apple/WinterComputerUse) links the library and
// drives it from core events; nothing here talks to the daemon.
let package = Package(
    name: "WinterCUPresentation",
    // Same OS floor as the rest of the Apple packages (SP3: 26 across the board). Mac only: the
    // helper is an LSUIElement Mac app.
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterCUPresentation", targets: ["WinterCUPresentation"]),
        .executable(name: "cu-presentation-demo", targets: ["cu-presentation-demo"]),
    ],
    targets: [
        .target(
            name: "WinterCUPresentation",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
            ]
        ),
        // Manual check for the controller and the user: mirrors one window, walks the agent cursor
        // over it and arms the Esc tap. Never run by tests or CI (it captures the screen).
        .executableTarget(name: "cu-presentation-demo", dependencies: ["WinterCUPresentation"]),
        .testTarget(name: "WinterCUPresentationTests", dependencies: ["WinterCUPresentation"]),
    ]
)
