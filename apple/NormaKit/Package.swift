// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NormaKit",
    // SP3: OS floor raised to 26 across the board (see docs/RELEASE-NOTES-sp3-os-floor.md).
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "NormaKit", targets: ["NormaKit"]),
        .library(name: "NormaSessionKit", targets: ["NormaSessionKit"]),
        .executable(name: "norma-probe", targets: ["norma-probe"]),
        .executable(name: "norma-fake-phone", targets: ["norma-fake-phone"]),
    ],
    dependencies: [
        .package(path: "../NormaProtocol"),
    ],
    targets: [
        // iroh-ffi v1.1.0's Apple XCFramework: raw C FFI only (module `Iroh`,
        // NOT `IrohLib` despite the release asset's filename — see vendor/README.md).
        // Fetched by vendor/fetch-iroh.sh; not committed (see .gitignore).
        .binaryTarget(name: "Iroh", path: "vendor/IrohLib.xcframework"),
        // The ergonomic Swift API (Endpoint, Connection, BiStream, ...) is a
        // generated Swift *source* file upstream ships alongside the binary,
        // not inside it. Vendored verbatim; see vendor/README.md for why.
        .target(
            name: "IrohLib",
            dependencies: ["Iroh"],
            path: "vendor/IrohLibSwift",
            linkerSettings: [
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("Network"),
                .linkedFramework("CoreWLAN", .when(platforms: [.macOS])),
            ]
        ),
        // SP3 Task 1: the pure/portable seam (RemoteConn/RemoteListener + loopback/scripted test
        // doubles, ResumePlanner) carved out of NormaKit so an iOS app can link it without any
        // Mac-only NormaKit code. Later SP3 tasks move the iroh transport + session client here.
        .target(name: "NormaSessionKit", dependencies: ["NormaProtocol", "IrohLib"]),
        .target(name: "NormaKit", dependencies: ["NormaProtocol", "IrohLib", "NormaSessionKit"]),
        .executableTarget(name: "norma-probe", dependencies: ["NormaKit", "NormaProtocol"]),
        // SP2b Task 5: the dev/fake-phone CLI — closes the pairing loop end-to-end without any
        // iOS code (`PhonePairingClient` is the reusable phone-side ceremony it drives). SP3 Task 2:
        // `PhonePairingClient` moved into `NormaSessionKit`, so this target now depends on it
        // directly too (the CLI's own hand-rolled attach dial is untouched — that's SP3 Task 5).
        .executableTarget(name: "norma-fake-phone", dependencies: ["NormaKit", "NormaProtocol", "NormaSessionKit", "IrohLib"]),
        .testTarget(name: "NormaKitTests", dependencies: ["NormaKit", "IrohLib", "NormaSessionKit"]),
    ]
)
