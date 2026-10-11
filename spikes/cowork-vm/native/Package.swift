// swift-tools-version: 6.2
import PackageDescription
import Foundation
import CryptoKit

// BUILD-ONLY profile selector. It cannot select an arbitrary source path and
// is never read by the compiled native runtime.
let verifiedEOF = ProcessInfo.processInfo.environment["WINTER_COWORK_NATIVE_PROFILE"] == "verified-eof"
if let profile = ProcessInfo.processInfo.environment["WINTER_COWORK_NATIVE_PROFILE"], !["upstream", "verified-eof"].contains(profile) { fatalError("Unknown native build profile") }
func verifiedSource(_ relative: String) -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(relative).standardizedFileURL
    guard root.resolvingSymlinksInPath().path == root.path else { fatalError("Verified dependency path aliases are refused") }
    let ignored: Set<String> = [".build", ".swiftpm", ".git"]
    guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { fatalError("Run fixed prepare-containerization.py first") }
    var entries: [(String, String)] = []
    for case let file as URL in files {
        let path = String(file.path.dropFirst(root.path.count + 1))
        if path.split(separator: "/").contains(where: { ignored.contains(String($0)) }) { files.skipDescendants(); continue }
        let attributes = try! file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard attributes.isSymbolicLink != true else { fatalError("Verified source symlinks are refused") }
        if attributes.isRegularFile == true { entries.append((path, SHA256.hash(data: try! Data(contentsOf: file)).map { String(format: "%02x", $0) }.joined())) }
    }
    let manifest = entries.sorted { $0.0 < $1.0 }.map { $0.0 + "\0" + $0.1 + "\n" }.joined()
    let digest = SHA256.hash(data: Data(manifest.utf8)).map { String(format: "%02x", $0) }.joined()
    guard digest == "812a8b6c38acfc87f1abb1ff6f96110de912d09a769f27f73bd86ef228f680dc" else { fatalError("Verified Containerization full tree differs from compiled pin") }
    return root.path
}


let package = Package(
    name: "WinterCoworkVMProbe",
    platforms: [.macOS("26.0")],
    products: [.library(name: "WinterCoworkVM", type: .dynamic, targets: ["WinterCoworkVM"])],
    dependencies: [
        .package(path: "../../../apple/Cowork/WinterCoworkVM"),
        verifiedEOF ? .package(path: verifiedSource("../../../apple/Cowork/WinterCoworkVM/out/dependencies/containerization")) : .package(url: "https://github.com/apple/containerization.git", revision: "bc994b88df46207fad7775b0eabc51947e315881")
    ],
    targets: [
        .target(name: "WinterCoworkVM", dependencies: [
            .product(name: "WinterCoworkPrimitives", package: "WinterCoworkVM"),
            .product(name: "Containerization", package: "containerization"),
            .product(name: "ContainerizationExtras", package: "containerization"),
            .product(name: "ContainerizationOCI", package: "containerization")
        ]),
        .testTarget(name: "WinterCoworkVMTests", dependencies: ["WinterCoworkVM", .product(name: "WinterCoworkPrimitives", package: "WinterCoworkVM")])
    ]
)
