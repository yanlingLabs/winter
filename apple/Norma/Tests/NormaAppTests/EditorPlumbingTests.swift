import Foundation
import XCTest
@testable import Norma

/// editor-plumbing Task 2: the `norma-editor://` scheme's path fence, executed for real.
///
/// **This is the only part of the scheme a test in this repo can run.** CEF never starts under
/// XCTest — the unit-test host IS `Norma.app` and `NormaCEFRuntime` refuses to start Chromium there
/// (`CEFRuntimeTests.testTheRuntimeRefusesToStartCEFUnderXCTest`) — so the resource handler, the
/// factory and the scheme registration are all unreachable from here and are proved by Task 5's
/// live harness instead. The fence was split into its own CEF-free translation unit
/// (`Sources/CEF/NormaCEFAssetResolve.h/.mm`) precisely so that the one property worth a test —
/// "this scheme cannot be talked into serving a file outside the app's editor assets" — is not
/// stranded behind a runtime the suite may never boot.
///
/// Every case below asserts only NULL-vs-non-NULL, never the returned string. Scratch directories
/// live under `/var/folders/...`, which is a symlink to `/private/var/folders/...`, so the resolved
/// path legitimately differs from the path this test built — comparing them would pin the
/// filesystem's symlink layout, not the fence.
final class EditorPlumbingTests: XCTestCase {

    // MARK: - Scratch plumbing

    private var scratchRoots: [URL] = []

    override func tearDown() {
        for root in scratchRoots {
            try? FileManager.default.removeItem(at: root)
        }
        scratchRoots = []
        super.tearDown()
    }

    /// A fresh directory the test owns, removed in `tearDown`. Never `~/.norma`, never the user's
    /// anything — this suite's standing rule.
    @discardableResult
    private func scratchDir(suffix: String = "") throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("EditorPlumbingTests-\(UUID().uuidString)\(suffix)",
                                    isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchRoots.append(dir)
        return dir
    }

    /// A scratch root holding one real file at `relative`. Returns the ROOT's path.
    private func scratchRootWithFile(at relative: String, contents: String = "x") throws -> String {
        let root = try scratchDir()
        try writeFile(at: relative, contents: contents, under: root)
        return root.path
    }

    private func writeFile(at relative: String, contents: String, under root: URL) throws {
        let file = root.appendingPathComponent(relative, isDirectory: false)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try contents.write(to: file, atomically: true, encoding: .utf8)
    }

    /// The fence itself, with its `malloc`/`free` contract discharged here so the cases read as
    /// `String?`. The C function is reached through the app target's bridging header
    /// (`Support/NormaBridge.h`), the same seam `NormaCEFBrowserState` already arrives by.
    private func resolved(_ root: String, _ urlPath: String) -> String? {
        guard let raw = NormaCEFEditorAssetResolve(root, urlPath) else { return nil }
        defer { free(raw) }
        return String(cString: raw)
    }

    // MARK: - The fence

    /// The brief's own case list, verbatim: a hit, dot-dot in three shapes, a miss, and empty.
    func testAssetResolveStaysInsideTheRoot() throws {
        let root = try scratchRootWithFile(at: "vs/loader.js")

        XCTAssertNotNil(resolved(root, "/vs/loader.js"),
                        "a real file inside the root must resolve")
        XCTAssertNil(resolved(root, "/../secrets.txt"),
                     "a bare parent traversal must not resolve")
        XCTAssertNil(resolved(root, "/vs/../../etc/passwd"),
                     "traversal back out through a real subdirectory must not resolve")
        XCTAssertNil(resolved(root, "/vs/%2e%2e/loader.js"),
                     "percent-encoded dots must be decoded BEFORE the fence runs, not after")
        XCTAssertNil(resolved(root, "/nonexistent.js"),
                     "the fence includes existence — a miss is NULL, not a path")
        XCTAssertNil(resolved(root, ""),
                     "an empty path resolves to the root directory, which is not an asset")
    }

    /// **The discriminating half of the percent-decoding claim.** `/vs/%2e%2e/loader.js` above
    /// answers NULL even against a resolver that does no decoding at all — a literal directory
    /// named `%2e%2e` does not exist either — so on its own it proves nothing about WHEN decoding
    /// happens. This case can only pass if the decode really runs: the bytes `%76` are `v`, and the
    /// literal path `/%76s/loader.js` exists nowhere.
    ///
    /// The uppercase case is here because hex escapes are case-insensitive and a decoder that
    /// handles only lowercase would serve `%2E%2E` straight through the fence as a literal name —
    /// which fails safe today, but stops failing safe the moment anything writes a file called
    /// `%2E%2E`. Pinned as a decode, not as a miss.
    func testAssetResolveDecodesPercentEscapesExactlyOnceBeforeFencing() throws {
        let root = try scratchRootWithFile(at: "vs/loader.js")

        XCTAssertNotNil(resolved(root, "/%76s/loader.js"),
                        "%76 is 'v' — a non-nil answer here is the only proof decoding happens")
        XCTAssertNotNil(resolved(root, "/vs/loader%2Ejs"),
                        "hex escapes are case-insensitive; %2E is '.'")
        // Decoded ONCE, never in a loop: `%252e%252e` is `%2e%2e` after one pass and `..` after
        // two. One pass leaves a literal directory name that cannot exist; a loop reaches the
        // parent. Same expectation either way — NULL — but for opposite reasons, so the case is
        // paired with the positive ones above rather than trusted on its own.
        XCTAssertNil(resolved(root, "/vs/%252e%252e/loader.js"),
                     "double-decoding must not happen")
    }

    /// Malformed escapes and an encoded NUL are REFUSED rather than passed through as literal
    /// bytes. A NUL in particular is the classic truncation trick against any C consumer of the
    /// resolved path, and there is no asset Norma ships whose name needs a bare `%`.
    func testAssetResolveRefusesMalformedEscapesAndEncodedNul() throws {
        let root = try scratchRootWithFile(at: "vs/loader.js")

        XCTAssertNil(resolved(root, "/vs/%zz.js"), "non-hex escape")
        XCTAssertNil(resolved(root, "/vs/%2"), "truncated escape")
        XCTAssertNil(resolved(root, "/vs/loader.js%"), "trailing bare percent")
        XCTAssertNil(resolved(root, "/vs/loader.js%00.png"), "encoded NUL")
    }

    /// A symlink INSIDE the root pointing at a real file OUTSIDE it. Both sides are `realpath`'d
    /// and the containment test runs on the results, so the link is followed and then refused.
    ///
    /// **The outside file genuinely exists**, and that is the point of the setup: against a
    /// nonexistent target `realpath` fails on its own and the test would pass without the prefix
    /// check ever executing — green for the wrong reason. Deleting the containment test from the
    /// implementation must make this case fail, and with a real file behind the link it does.
    func testAssetResolveRefusesSymlinkEscape() throws {
        let root = try scratchDir()
        try writeFile(at: "vs/loader.js", contents: "x", under: root)

        let outside = try scratchDir(suffix: "-outside")
        let secret = outside.appendingPathComponent("secret.txt", isDirectory: false)
        try "top secret".write(to: secret, atomically: true, encoding: .utf8)
        XCTAssertTrue(FileManager.default.fileExists(atPath: secret.path),
                      "the escape target must really exist or this test proves nothing")

        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("escape", isDirectory: false),
            withDestinationURL: outside
        )

        XCTAssertNil(resolved(root.path, "/escape/secret.txt"),
                     "a symlink out of the root must be resolved and then refused")
        XCTAssertNotNil(resolved(root.path, "/vs/loader.js"),
                        "the same root still serves its own files — the refusal is not blanket")
    }

    /// The separator-boundary half of the containment test, which a bare `strncmp` prefix check
    /// silently fails. The sibling directory's name STARTS WITH the root's name, so its paths are
    /// string-prefixed by the root and a fence that stopped at `strncmp` would serve them.
    func testAssetResolveRefusesASiblingWhoseNameSharesTheRootsPrefix() throws {
        let root = try scratchDir()
        try writeFile(at: "vs/loader.js", contents: "x", under: root)

        // `<root>-outside`, i.e. exactly the root's path plus a suffix.
        let sibling = URL(fileURLWithPath: root.path + "-outside", isDirectory: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        scratchRoots.append(sibling)
        try "top secret".write(to: sibling.appendingPathComponent("secret.txt"),
                               atomically: true, encoding: .utf8)

        let escape = "/../\(sibling.lastPathComponent)/secret.txt"
        XCTAssertNil(resolved(root.path, escape),
                     "a sibling that string-prefixes the root is outside it — the byte after the "
                        + "prefix must be a separator")
    }

    /// Degenerate inputs. An empty root is what the handler holds before
    /// `NormaCEFRegisterEditorAssetRoot` has run, and it must resolve NOTHING rather than fall back
    /// to the process's working directory.
    func testAssetResolveRefusesEmptyAndAbsentRoots() throws {
        _ = try scratchRootWithFile(at: "vs/loader.js")

        XCTAssertNil(resolved("", "/vs/loader.js"), "no root configured yet")
        XCTAssertNil(resolved("/nonexistent-root-\(UUID().uuidString)", "/vs/loader.js"),
                     "a root that does not exist cannot contain anything")
    }
}
