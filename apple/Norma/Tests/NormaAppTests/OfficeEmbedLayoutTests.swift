import XCTest
@testable import Norma

/// Office Stage A Task 2, carry T2-b: zero directory symlinks anywhere under
/// `Contents/Resources/LibreOffice/` in the BUILT app, and `Resources/` is `Frameworks/`'s real
/// (non-symlinked) sibling. project.yml's "Embed LibreOffice (signed)" postCompileScript already
/// asserts this at BUILD time and fails the build on a violation — the carry's own wording allows
/// "a build-phase or test assertion"; this is the test half, so the same property also shows up in
/// an ordinary test run rather than only a build log.
///
/// **`Contents/Resources/LibreOffice/`, not `Contents/Frameworks/LibreOffice/`** — an
/// implementer-discovered deviation from the brief's own wording (which named the Frameworks/
/// path), forced by a real codesign failure: `Contents/Frameworks/` is Apple's "nested code"
/// territory (TN2206) and requires every immediate item there to be independently-signed code
/// (a `.framework`, a bare dylib, an executable) — LibreOffice's product-set is a loose mixed tree
/// of dylibs AND plain resources, which is none of those, so sealing the outer app failed on the
/// first non-code resource it found. See project.yml's own comment on the "Embed LibreOffice
/// (signed)" phase for the full mechanism and the exact error. T2-b's real invariant — zero
/// directory symlinks, Resources/ as Frameworks/'s real sibling — is unchanged in substance; only
/// its root moved.
///
/// Skips if the embed phase has not run for this build (e.g. a target list that excludes `Norma`
/// itself) — same `XCTSkipIf` shape as `OfficeHelperLiveSmokeTests`.
final class OfficeEmbedLayoutTests: XCTestCase {
    func testEmbeddedLibreOfficeTreeHasNoDirectorySymlinks() throws {
        let root = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/LibreOffice")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: root.path),
                      "Contents/Resources/LibreOffice was not embedded into this run's built app "
                        + "(\(root.path)) — the \"Embed LibreOffice (signed)\" postCompileScript "
                        + "did not run for this build. This pin goes live the moment it does.")

        let resources = root.appendingPathComponent("Resources")
        var resourcesIsDirectory: ObjCBool = false
        let resourcesExists = FileManager.default.fileExists(atPath: resources.path, isDirectory: &resourcesIsDirectory)
        XCTAssertTrue(resourcesExists && resourcesIsDirectory.boolValue,
                      "Contents/Resources/LibreOffice/Resources must exist as a directory")
        let resourcesAttrs = try FileManager.default.attributesOfItem(atPath: resources.path)
        XCTAssertNotEqual(resourcesAttrs[.type] as? FileAttributeType, .typeSymbolicLink,
                          "Resources must be a REAL directory, the literal sibling of Frameworks/ — "
                            + "a symlink here is exactly the T2-b hazard: dyld resolves a dlopen'd "
                            + "library's path through directory symlinks before LOK's ${ORIGIN} "
                            + "bootstrap runs, silently loading the wrong Resources/")

        // Same tool the build-phase check uses (find -type l), for the same reason: symlink
        // detection via a directory-tree walk has real edge cases (circular links, following vs.
        // not) that `find` already handles correctly and this need not re-litigate.
        let find = Process()
        find.executableURL = URL(fileURLWithPath: "/usr/bin/find")
        find.arguments = [root.path, "-type", "l"]
        let pipe = Pipe()
        find.standardOutput = pipe
        try find.run()
        find.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let symlinks = output.split(separator: "\n").map(String.init)

        var directorySymlinks: [String] = []
        for path in symlinks {
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue {
                directorySymlinks.append(path)
            }
        }
        XCTAssertTrue(directorySymlinks.isEmpty,
                      "directory symlink(s) found under Contents/Resources/LibreOffice/: "
                        + directorySymlinks.joined(separator: ", "))
    }
}
