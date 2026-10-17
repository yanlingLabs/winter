// swift-tools-version: 6.2
import PackageDescription

// winter-cowork-launcher: the signed Swift process between Winter's daemon and the Cowork VM worker
// (N2 slice S2; contract: docs/cowork-native-worker.md). SOURCE ONLY: nothing links Hypervisor.framework,
// nothing here starts a VM, and nothing in the daemon spawns this binary yet (S7 wires it).
//
// Targets:
//   LauncherNative    small C: recvmsg/sendmsg with descriptors, the suspended spawn, the sole-reaper owned child.
//   LauncherCore      the wire codec, the session state machine, parent/worker identity, the receipt store.
//   launcher-main     the executable (product `winter-cowork-launcher`). No entitlements.
//   FakeWorker        a plain non-HVF child that speaks the worker side of L2/L3, for tests.
//
// The test-build pin (a parent identified by cdhash) exists only when the compiler is given
// -Xswiftc -DWINTER_COWORK_TEST_BUILD (see launcher-main/main.swift); no manifest setting, no environment
// variable and no argument turns it on in a normal build.
let package = Package(
    name: "WinterCoworkLauncher",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "winter-cowork-launcher", targets: ["launcher-main"]),
        .library(name: "LauncherCore", targets: ["LauncherCore"]),
    ],
    targets: [
        .target(name: "LauncherNative"),
        .target(
            name: "LauncherCore",
            dependencies: ["LauncherNative"],
            // Swift 6 mode makes `#file` mean `#fileID`: the release name scan reads every shipped byte, and a full source path baked in
            // by an assertion's default argument is exactly the leak it looks for.
            linkerSettings: [.linkedFramework("Security"), .linkedFramework("IOKit")]
        ),
        .executableTarget(
            name: "launcher-main",
            dependencies: ["LauncherCore"]
        ),
        .executableTarget(
            name: "FakeWorker",
            dependencies: ["LauncherCore", "LauncherNative"]
        ),
        .testTarget(
            name: "LauncherCoreTests",
            dependencies: ["LauncherCore", "LauncherNative", "FakeWorker", "launcher-main"],
            resources: [.copy("Vectors")]
        ),
    ]
)
