// swift-tools-version: 6.2
import PackageDescription
let package = Package(
    name: "WinterCoworkNetwork", platforms: [.macOS("26.0")],
    products: [.library(name: "WinterCoworkNetwork", type: .dynamic, targets: ["WinterCoworkNetwork"])],
    targets: [
        .systemLibrary(name: "CGLib", pkgConfig: "glib-2.0"),
        .target(name: "CoworkSlirp", dependencies: ["CGLib"], path: "vendor/libslirp/src", exclude: ["libslirp.map", "libslirp.test.map", "libslirp-version.h.in"], publicHeadersPath: "include", cSettings: [.unsafeFlags(["-fno-modules"]), .headerSearchPath("."), .define("BUILDING_LIBSLIRP"), .define("G_LOG_DOMAIN", to: "\"Slirp\"")], linkerSettings: [.linkedLibrary("resolv")]),
        .target(name: "CoworkNetworkC", dependencies: ["CoworkSlirp"], publicHeadersPath: "include"),
        .target(name: "WinterCoworkNetwork", dependencies: ["CoworkNetworkC"]),
        .testTarget(name: "WinterCoworkNetworkTests", dependencies: ["WinterCoworkNetwork", "CoworkNetworkC"])
    ]
)
