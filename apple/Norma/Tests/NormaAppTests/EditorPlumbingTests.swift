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
        // two. **This probe path is chosen so the two behaviors land on DIFFERENT targets rather
        // than both reading NULL for unrelated reasons** — an earlier version used
        // `/vs/%252e%252e/loader.js`, whose one-pass answer is NULL (no `%2e%2e` directory exists)
        // and whose two-pass answer is ALSO NULL (`/vs/../loader.js` misses too, because the only
        // real file lives at `vs/loader.js`, not at the root), so it could not tell a correct
        // resolver from a decode-loop bug. Here, one pass leaves the literal, nonexistent segment
        // `/vs/%2e%2e/vs/loader.js` — NULL, correctly. A decode-loop bug turns the SAME input into
        // `/vs/../vs/loader.js`, which `realpath` walks straight back to the one real file this
        // root has — a non-nil hit, so the assertion below is what actually fails under that bug.
        XCTAssertNil(resolved(root, "/vs/%252e%252e/vs/loader.js"),
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

    // MARK: - The scheme, as far as a CEF-less host can see it

    /// `NormaCEFRegisterEditorAssetRoot` must be safe in a process where CEF never started — which
    /// is every process this suite runs in, and also a shipped app that never opens a web tab.
    /// `NormaCEF.h`'s standing contract ("EVERY function here is safe to call when CEF was never
    /// loaded or initialised") is the thing being pinned; idempotence is the brief's own word.
    ///
    /// `kNormaEditorScheme` is checked here rather than in a case of its own because it is the same
    /// claim: the Swift-facing surface of the scheme resolves, and says what the C++ side says. The
    /// constant is DEFINED from `NormaEditorScheme.h`'s `kNormaEditorSchemeName` — the one string
    /// the browser process and the five helpers both register — so this reads the far end of that
    /// chain from the only language that cannot see it directly.
    func testRegisteringTheEditorAssetRootIsSafeWithoutCEFAndIsIdempotent() throws {
        XCTAssertEqual(String(cString: kNormaEditorScheme), "norma-editor",
                       "the Swift-facing scheme name must be the one the C++ side registers")

        let root = try scratchRootWithFile(at: "vs/loader.js")
        NormaCEFRegisterEditorAssetRoot(root)
        NormaCEFRegisterEditorAssetRoot(root)
        NormaCEFRegisterEditorAssetRoot(nil)
        XCTAssertFalse(NormaCEFIsInitialized(),
                       "this suite must not have started CEF — the point of the call above")
    }

    /// **The pin for this task's one genuine discovery: the helpers do not share the browser
    /// process's `CefApp`.** `CEFHelperSources/process_helper_mac.cc` passed `nullptr` to
    /// `CefExecuteProcess` from the day it was written, so `OnRegisterCustomSchemes` ran in exactly
    /// one process of six. CEF requires the identical scheme list in all of them (`cef_app.h`), and
    /// a renderer that has not been told `norma-editor://` is STANDARD and SECURE gives the editor
    /// page no real origin, no secure context, and therefore no workers, no ES modules and no
    /// `fetch` — Monaco simply does not start.
    ///
    /// Nothing else in this repo can catch a regression here. No test boots CEF, so reverting the
    /// helper's app to `nullptr` compiles, links, leaves the whole suite green, and surfaces only
    /// as a blank editor in a live run.
    ///
    /// The technique is this repo's existing one for exactly that shape of risk (see
    /// `CEFRuntimeTests.testTheTerminationObserverIsACTUALLYSUBSCRIBED`): the literal lands in
    /// `__cstring` and survives stripping, so the BUILT PRODUCT can be scanned for it. Debug builds
    /// put the code in a sibling `.debug.dylib` and Release builds in the executable itself, so
    /// both are searched and either one counts.
    ///
    /// What this pins and what it does not, measured by mutation rather than assumed:
    ///
    ///   * Restoring `process_helper_mac.cc` to its pre-task shape — `CefExecuteProcess(main_args,
    ///     nullptr, nullptr)` with the include gone — fails this test **5 times, once per helper**,
    ///     with the app binary still passing. That is the realistic regression (a revert, a
    ///     dropped include, a helper target losing the header search path) and it is caught.
    ///   * Changing ONLY the third argument, leaving `new NormaSubprocessApp()` constructed above
    ///     it, still passes: the class is instantiated, so the literal is still emitted. No scan of
    ///     a built binary can see what was passed to a call, and a host that must never start CEF
    ///     cannot observe the registration firing — the same limit
    ///     `testTheTerminationObserverIsACTUALLYSUBSCRIBED` carries, stated here for the same
    ///     reason. Task 5's live harness is what closes it.
    func testTheEditorSchemeIsCompiledIntoEveryProcessAndNotOnlyTheBrowser() throws {
        let app = Bundle.main.bundleURL
        var binaries: [(String, URL)] = [
            ("Norma (browser process)", app.appendingPathComponent("Contents/MacOS/Norma"))
        ]
        for suffix in ["", " (Alerts)", " (GPU)", " (Plugin)", " (Renderer)"] {
            let name = "Norma Helper\(suffix)"
            binaries.append((name, app.appendingPathComponent(
                "Contents/Frameworks/\(name).app/Contents/MacOS/\(name)")))
        }

        for (name, executable) in binaries {
            XCTAssertTrue(
                Self.binaryCarries("norma-editor", at: executable),
                "\(name) does not carry the `norma-editor` scheme literal — its process would not "
                    + "register the scheme, and a renderer without it cannot run the editor page"
            )
        }
    }

    // MARK: - Task 3: the bridge codec, JS → Swift

    /// The four inbound shapes, decoded from the exact bytes the page will send. Fixtures are
    /// written out literally rather than built from the enum, so a change to either side of the
    /// wire has to be made twice — which is the point of a fixture.
    func testEveryInboundMessageDecodesFromItsExactWireBytes() throws {
        XCTAssertEqual(EditorBridgeInbound.decode(#"{"type":"ready"}"#), .ready)

        XCTAssertEqual(
            EditorBridgeInbound.decode(#"{"type":"modelDirtyChanged","path":"/a/b.swift","dirty":true}"#),
            .modelDirtyChanged(path: "/a/b.swift", dirty: true))
        XCTAssertEqual(
            EditorBridgeInbound.decode(#"{"type":"modelDirtyChanged","path":"/a/b.swift","dirty":false}"#),
            .modelDirtyChanged(path: "/a/b.swift", dirty: false))

        XCTAssertEqual(EditorBridgeInbound.decode(#"{"type":"saveRequested","path":"/a/b.swift"}"#),
                       .saveRequested(path: "/a/b.swift"))

        XCTAssertEqual(
            EditorBridgeInbound.decode(#"{"type":"contentResponse","path":"/a/b.swift","seq":7,"text":"let x = 1\n"}"#),
            .contentResponse(path: "/a/b.swift", seq: 7, text: "let x = 1\n"))

        // Key ORDER is not part of the wire, and a page's JSON.stringify makes no promise about it.
        XCTAssertEqual(EditorBridgeInbound.decode(#"{"path":"/a/b.swift","type":"saveRequested"}"#),
                       .saveRequested(path: "/a/b.swift"))
        // Unknown members are ignored, not fatal — the page may gain a field before Swift reads it.
        XCTAssertEqual(EditorBridgeInbound.decode(#"{"type":"ready","version":2}"#), .ready)
    }

    /// Malformed, unknown, and wrong-shaped input all answer `nil` — never a partially-built case
    /// and never a crash. The page is the least trusted producer in the app: it is the only place
    /// user files and third-party editor code meet Swift.
    func testInboundDecodeRefusesEverythingItDoesNotUnderstand() throws {
        XCTAssertNil(EditorBridgeInbound.decode(""), "empty is not JSON")
        XCTAssertNil(EditorBridgeInbound.decode("{"), "truncated JSON")
        XCTAssertNil(EditorBridgeInbound.decode("not json at all"), "not JSON")
        XCTAssertNil(EditorBridgeInbound.decode(#"["ready"]"#), "an array is not a message")
        XCTAssertNil(EditorBridgeInbound.decode(#""ready""#), "a bare string is not a message")

        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"quit"}"#), "unknown type")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":""}"#), "empty type")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"path":"/a"}"#), "no type at all")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":42}"#), "a non-string type")
        // Case matters: the wire names are literals, not a case-insensitive vocabulary.
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"Ready"}"#), "wire names are exact")

        // A known type with a missing or wrongly-typed field is refused outright rather than
        // defaulted — a `saveRequested` with no path would otherwise become a save of "".
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"saveRequested"}"#), "no path")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"saveRequested","path":7}"#), "path is not a string")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"modelDirtyChanged","path":"/a"}"#), "no dirty")
        // Foundation hands JSON booleans and JSON numbers back as the same class, so `as? Bool`
        // alone would accept `1` here. A flag that arrives as a number means the page is not
        // sending what this side thinks it is.
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"modelDirtyChanged","path":"/a","dirty":1}"#),
                     "a number is not a boolean")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"contentResponse","path":"/a","seq":1}"#), "no text")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"contentResponse","path":"/a","seq":-1,"text":""}"#),
                     "a negative seq is not a UInt64")
        XCTAssertNil(EditorBridgeInbound.decode(#"{"type":"contentResponse","path":"/a","seq":"1","text":""}"#),
                     "a stringified seq is not a UInt64")
    }

    /// **The ceiling, pinned at the byte.** `editorBridgeMaxInboundBytes` is measured in UTF-8
    /// bytes of the whole frame, and the boundary is tested from BOTH sides: exactly at the cap
    /// must decode, one byte past it must not. The over-cap case alone would pass against a
    /// decoder that refused every large payload for some unrelated reason.
    func testInboundDecodeRefusesAnythingOverTheCapAndAcceptsExactlyTheCap() throws {
        XCTAssertEqual(editorBridgeMaxInboundBytes, 8 * 1024 * 1024,
                       "the ceiling is the NDJSON frame precedent — 8 MiB")

        let prefix = #"{"type":"contentResponse","path":"/a","seq":1,"text":""#
        let suffix = #""}"#
        let fillerAtCap = editorBridgeMaxInboundBytes - prefix.utf8.count - suffix.utf8.count

        let atCap = prefix + String(repeating: "a", count: fillerAtCap) + suffix
        XCTAssertEqual(atCap.utf8.count, editorBridgeMaxInboundBytes, "the fixture must sit exactly on the cap")
        XCTAssertNotNil(EditorBridgeInbound.decode(atCap), "exactly at the cap is allowed")

        let overCap = prefix + String(repeating: "a", count: fillerAtCap + 1) + suffix
        XCTAssertEqual(overCap.utf8.count, editorBridgeMaxInboundBytes + 1)
        XCTAssertNil(EditorBridgeInbound.decode(overCap), "one byte over the cap is refused")
    }

    // MARK: - Task 3: the bridge codec, Swift → page

    /// **The exact bytes, pinned.** One payload carrying every shape an escaper gets wrong: a
    /// quote, a newline, a TAB, a LITERAL BACKSLASH, a C0 control character, a non-ASCII dash and an
    /// emoji. Key order is deterministic (`.sortedKeys`), slashes are not escaped
    /// (`.withoutEscapingSlashes`), and non-ASCII stays literal UTF-8, which is valid JSON and what
    /// every browser's `JSON.parse` reads.
    ///
    /// The backslash and the control character were added by the fix round: the behaviour was
    /// already right, but without them the pin would not have NOTICED a regression in the two cases
    /// an escaper most often gets wrong — a lone `\` (which must double, or every following escape
    /// shifts by one) and a byte with no printable form (which must become `\u00XX`, not vanish).
    func testOpenModelRendersExactlyTheseBytes() throws {
        // A lone backslash, assembled rather than typed, so this file never contains the escape
        // sequences it is asserting about — the same reason the U+2028 case below does it.
        let backslash = #"\"#
        let js = EditorBridgeOutbound.openModel(
            path: "/tmp/a b.swift",
            language: "swift",
            text: "let s = \"hi\"\n\tprint(s" + backslash + ") — ✅\u{01}"
        ).javascript

        let expected = #"window.normaEditor.dispatch({"language":"swift","path":"/tmp/a b.swift","#
            + #""text":"let s = \"hi\"\n\tprint(s"# + backslash + backslash
            + #") — ✅"# + backslash + #"u0001","type":"openModel"})"#
        XCTAssertEqual(js, expected)
    }

    /// **`markSaved`'s exact bytes** — the save acknowledgement, pinned like `openModel` because it
    /// carries the same attacker-shaped value (a real filesystem path) through the same renderer.
    ///
    /// The path here contains a quote and a literal backslash, both legal in a POSIX filename and
    /// both the shapes that turn a mis-escaped payload into JavaScript SYNTAX rather than data.
    ///
    /// **`seq` renders as a JSON NUMBER, and the bytes are what pin that.** The page matches it
    /// against the `seq` it remembered for its own `pullContent` reply with `===`, so a quoted
    /// `"41"` would never match anything: every acknowledgement would fail closed and every saved
    /// file would keep its modified dot. `editor.js`'s `markSaved` DOES `console.warn` when that
    /// happens ("an unknown or superseded pull — nothing cleared") — this is not a SILENT failure,
    /// only one nobody is watching a console for during a live save, which is exactly the failure
    /// mode this byte-level pin exists to keep out of the page in the first place. Three members
    /// and no more — a `text` member here would be the content-carrying shortcut this case exists
    /// to avoid.
    func testMarkSavedRendersExactlyTheseBytes() throws {
        // Assembled rather than typed, like `openModel`'s pin, so this file never contains the
        // escape sequences it is asserting about.
        let backslash = #"\"#
        let quote = "\""
        let path = "/tmp/a " + backslash + quote + "b" + quote + ".swift"

        let js = EditorBridgeOutbound.markSaved(path: path, seq: 41).javascript

        let expected = #"window.normaEditor.dispatch({"path":"/tmp/a "#
            + backslash + backslash          // the lone backslash, doubled
            + backslash + quote + "b"        // the opening quote, escaped
            + backslash + quote              // and the closing one
            + #".swift","seq":41,"type":"markSaved"})"#
        XCTAssertEqual(js, expected)

        // It round-trips with the path intact — the escaping above belongs to the wire, not to the
        // value — and it carries exactly its three members.
        let payload = String(js.dropFirst("window.normaEditor.dispatch(".count).dropLast())
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        XCTAssertEqual(object["path"] as? String, path)
        XCTAssertEqual(object["seq"] as? UInt64, 41)
        XCTAssertEqual(object.count, 3, "markSaved carries a path, a seq and a type, and nothing else")
    }

    /// Every outbound case renders as the ONE entry point with a valid-JSON argument, and the
    /// argument carries the case's own wire name plus its fields. The entry point is a literal in
    /// exactly one place in the app — the page's whole Swift-facing API is this single function.
    func testEveryOutboundMessageRendersAsOneDispatchCallWithValidJSON() throws {
        let cases: [(EditorBridgeOutbound, String, [String: Any])] = [
            (.openModel(path: "/a.swift", language: "swift", text: "x"),
             "openModel", ["path": "/a.swift", "language": "swift", "text": "x"]),
            (.activateModel(path: "/a.swift"), "activateModel", ["path": "/a.swift"]),
            (.closeModel(path: "/a.swift"), "closeModel", ["path": "/a.swift"]),
            (.pullContent(path: "/a.swift", seq: 9), "pullContent", ["path": "/a.swift", "seq": 9]),
            (.applyExternalContent(path: "/a.swift", text: "y"),
             "applyExternalContent", ["path": "/a.swift", "text": "y"]),
            (.setTheme(tokensJSON: #"{"background":"black"}"#),
             "setTheme", ["tokens": ["background": "black"]]),
            (.markSaved(path: "/a.swift", seq: 3), "markSaved", ["path": "/a.swift", "seq": 3])
        ]

        for (message, wireType, expectedFields) in cases {
            let js = message.javascript
            XCTAssertTrue(js.hasPrefix("window.normaEditor.dispatch("),
                          "\(wireType) must go through the single entry point, got: \(js)")
            XCTAssertTrue(js.hasSuffix(")"), "\(wireType) must close the call")

            let payload = String(js.dropFirst("window.normaEditor.dispatch(".count).dropLast())
            let object = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
                "\(wireType) must render a JSON OBJECT — the page's payload is DATA, never code")

            XCTAssertEqual(object["type"] as? String, wireType)
            XCTAssertEqual(object.count, expectedFields.count + 1,
                           "\(wireType) must carry exactly its own fields plus `type`")
            for (key, value) in expectedFields {
                switch value {
                case let string as String: XCTAssertEqual(object[key] as? String, string, key)
                case let number as Int: XCTAssertEqual(object[key] as? Int, number, key)
                case let nested as [String: String]:
                    XCTAssertEqual(object[key] as? [String: String], nested, key)
                default: XCTFail("unhandled fixture value for \(key)")
                }
            }
        }
    }

    /// **U+2028 and U+2029 are escaped, and that is about the JS parser rather than the JSON one.**
    /// The rendered string is JavaScript SOURCE evaluated in the page, and those two characters are
    /// legal inside a JSON string while having been line terminators in JavaScript source before
    /// ES2019. Escaping them costs nothing (the escaped form is valid JSON too) and removes a
    /// whole class of "this file breaks the editor" from a codec carrying arbitrary user text.
    func testLineAndParagraphSeparatorsAreEscapedRatherThanEmittedRaw() throws {
        let js = EditorBridgeOutbound.applyExternalContent(path: "/a.txt",
                                                           text: "a\u{2028}b\u{2029}c").javascript

        XCTAssertFalse(js.unicodeScalars.contains("\u{2028}"), "a raw U+2028 must never reach the page")
        XCTAssertFalse(js.unicodeScalars.contains("\u{2029}"), "a raw U+2029 must never reach the page")
        // The expected six-character escape, assembled from a lone backslash so this source file
        // never has to contain the sequence it is asserting about.
        let backslash = #"\"#
        XCTAssertTrue(js.contains("a" + backslash + "u2028b" + backslash + "u2029c"),
                      "they must be escaped, not dropped: \(js)")

        // Still valid JSON, and still the same text on the other side.
        let payload = String(js.dropFirst("window.normaEditor.dispatch(".count).dropLast())
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        XCTAssertEqual(object["text"] as? String, "a\u{2028}b\u{2029}c")
    }

    /// `setTheme` takes JSON as a STRING and embeds it as an OBJECT — the page reads
    /// `message.tokens.background`, not a string it has to parse itself. Unparseable or non-object
    /// input becomes `{}` rather than invalid JavaScript: `javascript` must ALWAYS produce one
    /// well-formed call, because a malformed one is a syntax error in the page with no reply path.
    func testSetThemeEmbedsTokensAsAnObjectAndFallsBackToAnEmptyOne() throws {
        let good = EditorBridgeOutbound.setTheme(tokensJSON: #"{"a":1}"#).javascript
        XCTAssertEqual(good, #"window.normaEditor.dispatch({"tokens":{"a":1},"type":"setTheme"})"#)

        for bad in ["", "{", "not json", "[1,2]", #""a string""#] {
            let js = EditorBridgeOutbound.setTheme(tokensJSON: bad).javascript
            XCTAssertEqual(js, #"window.normaEditor.dispatch({"tokens":{},"type":"setTheme"})"#,
                           "unparseable tokens (\(bad)) must still render one valid call")
        }
    }

    // MARK: - Task 3: the C surface of the bridge, as far as a CEF-less host can see it

    /// `NormaCEF.h`'s standing contract — "EVERY function here is safe to call when CEF was never
    /// loaded or initialised" — applied to the bridge's two new doors, which is every process this
    /// suite runs in.
    ///
    /// The answer path is the one that could plausibly reach the framework (`Callback::Success`
    /// posts a task through libcef), and the guard against that is structural rather than a check
    /// for initialisation: with no live query there is no callback, so a `queryId` nobody minted
    /// returns before anything CEF-shaped is touched. Answering a stale or unknown id is also the
    /// ordinary case in production — a query cancelled by a navigation between delivery and the
    /// answer — so "safe" here means "a no-op", not "a refusal".
    ///
    /// **What this cannot cover** is the router itself: registering a handler that actually
    /// receives a query needs a live `CefBrowser`, which this host can never create (the same
    /// standing constraint that leaves the scheme handler, the CDP observer and the click routing
    /// unreachable from here). Task 5's live harness is the first execution of any of it.
    func testTheBridgeDoorsAreSafeWithNoCEFAndAnswerNothingForAQueryNobodyMinted() throws {
        // The typedef and the function must have the same shape — if either drifts this stops
        // compiling, which is the only way a C header's two halves can be held together.
        let respond: NormaCEFBridgeRespond = NormaCEFBridgeRespondCall

        var delivered: [UInt64] = []
        NormaCEFSetBridgeHandler { _, queryId, _ in delivered.append(queryId) }
        defer { NormaCEFSetBridgeHandler(nil) }

        // Ids far outside anything a live browser could have minted in this process — and no live
        // browser can exist here anyway.
        respond(910_001, true, #"{"ok":true}"#)
        NormaCEFBridgeRespondCall(910_002, false, #"{"message":"no"}"#)
        NormaCEFBridgeRespondCall(0, true, nil)

        XCTAssertTrue(delivered.isEmpty,
                      "answering an unknown query must not call the handler — it is a no-op")
        XCTAssertFalse(NormaCEFIsInitialized(),
                       "this suite must not have started CEF — the point of the calls above")

        NormaCEFSetBridgeHandler(nil)
        NormaCEFBridgeRespondCall(910_001, true, "{}")
    }

    // MARK: - Task 3: the wire vocabulary, and the parity pin Task 4 lights up

    /// The two `wireTypes` lists are what the parity test compares against the page's own
    /// `MESSAGE_TYPES`, so they must not be able to drift from the code that actually encodes and
    /// decodes. Every inbound name decodes; every outbound case renders a name from the list; and
    /// the lists have no duplicates and no overlap between directions.
    func testTheWireTypeListsAreExactlyWhatTheCodecSpeaks() throws {
        XCTAssertEqual(EditorBridgeInbound.wireTypes,
                       ["ready", "modelDirtyChanged", "saveRequested", "contentResponse"])
        XCTAssertEqual(EditorBridgeOutbound.wireTypes,
                       ["openModel", "activateModel", "closeModel", "pullContent",
                        "applyExternalContent", "setTheme", "markSaved"])

        // Every name in the inbound list is a name `decode` actually answers to. The fixture per
        // name is minimal-but-complete; a name in the list that decode rejects fails here.
        let minimalInbound: [String: String] = [
            "ready": #"{"type":"ready"}"#,
            "modelDirtyChanged": #"{"type":"modelDirtyChanged","path":"/a","dirty":false}"#,
            "saveRequested": #"{"type":"saveRequested","path":"/a"}"#,
            "contentResponse": #"{"type":"contentResponse","path":"/a","seq":0,"text":""}"#
        ]
        for name in EditorBridgeInbound.wireTypes {
            let fixture = try XCTUnwrap(minimalInbound[name], "no fixture for inbound `\(name)`")
            let decoded = try XCTUnwrap(EditorBridgeInbound.decode(fixture),
                                        "`\(name)` is listed but does not decode")
            XCTAssertEqual(decoded.wireType, name, "`\(name)` decodes to a case that names itself differently")
        }

        // And every outbound case renders a name from its list.
        let everyOutbound: [EditorBridgeOutbound] = [
            .openModel(path: "/a", language: "swift", text: ""),
            .activateModel(path: "/a"),
            .closeModel(path: "/a"),
            .pullContent(path: "/a", seq: 0),
            .applyExternalContent(path: "/a", text: ""),
            .setTheme(tokensJSON: "{}"),
            .markSaved(path: "/a", seq: 0)
        ]
        XCTAssertEqual(everyOutbound.map(\.wireType), EditorBridgeOutbound.wireTypes,
                       "the list must be the cases, in order, with none missing")

        XCTAssertEqual(Set(EditorBridgeInbound.wireTypes).count, EditorBridgeInbound.wireTypes.count)
        XCTAssertEqual(Set(EditorBridgeOutbound.wireTypes).count, EditorBridgeOutbound.wireTypes.count)
        XCTAssertTrue(Set(EditorBridgeInbound.wireTypes)
                        .isDisjoint(with: Set(EditorBridgeOutbound.wireTypes)),
                      "a name must mean one direction — the page switches on it too")
    }

    /// **The literal-parity pin between Swift and the page** — this repo's standing discipline for
    /// a vocabulary that exists twice in two languages (`REMOTE_ALLOWED_METHODS` and its parity
    /// test are the daemon's version of the same thing).
    ///
    /// **This test is SKIPPED until Task 4 creates the file, and it is a CONTRACT on what Task 4
    /// must write**, not merely a reader of it. `Resources/EditorAssets/app/bridge-protocol.js`
    /// must declare, at top level and each on one line:
    ///
    /// ```js
    /// export const INBOUND_MESSAGE_TYPES = ["ready", "modelDirtyChanged", ...];   // page → Swift
    /// export const OUTBOUND_MESSAGE_TYPES = ["openModel", "activateModel", ...];  // Swift → page
    /// ```
    ///
    /// Two arrays rather than one, because the two directions are two vocabularies with two
    /// switches; double-quoted or single-quoted strings both parse here. The names must equal the
    /// Swift lists EXACTLY, including order.
    ///
    /// Both the built bundle and the source tree are searched, and the skip only happens if the
    /// file is in NEITHER — a test that could only ever find the built copy would go on skipping
    /// silently if Task 4 landed the file without wiring the embed phase, which is precisely the
    /// failure the parity pin exists to catch.
    func testTheJavaScriptSideSpeaksExactlyTheSameWireVocabulary() throws {
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/EditorAssets/app/bridge-protocol.js")
        // `#filePath` is this file at `apple/Norma/Tests/NormaAppTests/`; three deletions up is
        // `apple/Norma`, where `Resources/` lives — the same computation `pageFile(named:)` below
        // makes; kept local here (rather than reading it back out of that helper) only because the
        // skip message below needs both candidate paths spelled out.
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // NormaAppTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // Norma
            .appendingPathComponent("Resources/EditorAssets/app/bridge-protocol.js")

        let found = Self.pageFile(named: "bridge-protocol.js")
        try XCTSkipIf(found == nil,
                      "Task 4 has not created Resources/EditorAssets/app/bridge-protocol.js yet — "
                        + "this pin goes live the moment it does. Looked in \(bundled.path) and "
                        + "\(source.path).")
        let js = try String(contentsOf: try XCTUnwrap(found), encoding: .utf8)

        XCTAssertEqual(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES", in: js),
                       EditorBridgeInbound.wireTypes,
                       "the page's INBOUND_MESSAGE_TYPES must equal EditorBridgeInbound.wireTypes")
        XCTAssertEqual(Self.jsStringArray(named: "OUTBOUND_MESSAGE_TYPES", in: js),
                       EditorBridgeOutbound.wireTypes,
                       "the page's OUTBOUND_MESSAGE_TYPES must equal EditorBridgeOutbound.wireTypes")
    }

    /// **The vocabulary lists agreeing is not the same as the page ACTING on them**, and the gap
    /// between the two is silent by construction: `dispatch` refuses a type that is not in
    /// `OUTBOUND_MESSAGE_TYPES`, so a name added to the array without a matching `case` in the
    /// switch is *accepted* and then does nothing at all — no error, no effect, no clue. That is
    /// exactly the shape of the miss this suite exists to catch, and the parity pin above cannot
    /// see it: both lists would be perfectly equal.
    ///
    /// `markSaved` is why this test exists. It arrived as a seventh outbound type after review, and
    /// the whole point of that message is a transition the user watches for (the modified dot
    /// clearing after a save) — the failure mode of a missing arm is a dot that never clears, which
    /// looks exactly like the bug the message was added to fix.
    ///
    /// Comments are stripped first, for the same reason the parity reader strips them: a `case`
    /// spelled in a doc comment must not satisfy this.
    func testThePagesDispatchSwitchHandlesEveryOutboundType() throws {
        let source = try XCTUnwrap(Self.pageFile(named: "editor.js"),
                                   "editor.js is in neither the built bundle nor the source tree")
        let code = Self.strippingJavaScriptComments(
            try String(contentsOf: source, encoding: .utf8))

        for name in EditorBridgeOutbound.wireTypes {
            XCTAssertTrue(code.contains("case \"\(name)\":"),
                          "editor.js's dispatch switch has no arm for `\(name)` — the page would "
                            + "accept that message (it is in OUTBOUND_MESSAGE_TYPES) and silently "
                            + "ignore it")
        }
    }

    /// One of the page's own files, wherever it can be found: the built bundle first, then the
    /// source tree. Same two-place search as the parity pin, and for the same reason — a test that
    /// could only read the built copy would go quiet if the embed phase stopped running.
    private static func pageFile(named name: String) -> URL? {
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/EditorAssets/app/\(name)")
        // `#filePath` is this file at `apple/Norma/Tests/NormaAppTests/`; three deletions up is
        // `apple/Norma`, where `Resources/` lives.
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // NormaAppTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // Norma
            .appendingPathComponent("Resources/EditorAssets/app/\(name)")
        return [bundled, source].first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// **The reader's own regression cases — the two ways it was measured to be wrong**, both
    /// running un-skipped against scratch JavaScript rather than waiting for Task 4's file.
    ///
    /// A parity pin that can be satisfied by a COMMENT is not a parity pin, and one that trips over
    /// a comment is a pin Task 4 cannot land. Both were real: the first version of this reader took
    /// the first textual occurrence of the name and never stripped comments.
    func testTheParityReaderIsNotFooledByCommentsInEitherDirection() throws {
        // (a) FALSE PASS, as measured: a comment spelling the CORRECT list sits above a declaration
        // that has drifted. The reader must report the drifted list — the one that ships — so the
        // pin FAILS. Reading the comment would leave the page and Swift disagreeing, silently, with
        // a green test.
        let commentedOverDrift = """
            // export const INBOUND_MESSAGE_TYPES = ["ready", "modelDirtyChanged", "saveRequested", "contentResponse"];
            export const INBOUND_MESSAGE_TYPES = ["wrong"];
            """
        XCTAssertEqual(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES", in: commentedOverDrift),
                       ["wrong"],
                       "the DECLARATION is the wire, not a comment describing it")
        XCTAssertNotEqual(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES", in: commentedOverDrift),
                          EditorBridgeInbound.wireTypes,
                          "with the drift read correctly, the parity pin must fail")

        // (b) FALSE FAIL, as measured: a doc comment merely NAMING the constant — which is the
        // likeliest first encounter, since this test file's own doc comment hands Task 4 a code
        // block containing the identifier — must not stop the real declaration being found.
        let documented = """
            /**
             * INBOUND_MESSAGE_TYPES is the page -> Swift vocabulary.
             * Keep it equal to EditorBridgeInbound.wireTypes.
             */
            // INBOUND_MESSAGE_TYPES: see EditorBridgeCodec.swift
            const INBOUND_MESSAGE_TYPES = ["ready", "modelDirtyChanged", "saveRequested", "contentResponse"];
            """
        XCTAssertEqual(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES", in: documented),
                       EditorBridgeInbound.wireTypes,
                       "a doc comment naming the constant must not hide the declaration below it")

        // The rest of the reader's contract, so a rewrite cannot quietly loosen it.
        XCTAssertEqual(Self.jsStringArray(named: "OUTBOUND_MESSAGE_TYPES",
                                          in: "export const OUTBOUND_MESSAGE_TYPES = ['a', 'b'];"),
                       ["a", "b"], "single quotes parse too")
        XCTAssertNil(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES", in: "const OTHER = [\"a\"];"),
                     "an absent declaration is nil, never an empty list")
        XCTAssertNil(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES",
                                        in: "// INBOUND_MESSAGE_TYPES = [\"ready\"]\n"),
                     "a comment alone is not a declaration")
        XCTAssertNil(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES",
                                        in: "send(INBOUND_MESSAGE_TYPES); const x = [\"a\"];"),
                     "a USE of the name is not its declaration")
        // A `//` inside a string must not eat the rest of the line — the shape that would otherwise
        // delete a real declaration sitting after a URL.
        XCTAssertEqual(Self.jsStringArray(named: "INBOUND_MESSAGE_TYPES",
                                          in: "const doc = \"https://x/y\"; const INBOUND_MESSAGE_TYPES = [\"ready\"];"),
                       ["ready"], "a // inside a string literal is not a comment")
    }

    /// Pull `NAME = [ "a", "b" ]` out of JavaScript source. Deliberately a small, strict reader
    /// rather than a JS parser: it reads only quoted strings out of the first array literal that a
    /// declaration of `name` introduces. `nil` when the declaration is absent, which fails the
    /// comparison above rather than silently matching an empty list.
    ///
    /// **Comments are stripped first, and every occurrence is tried.** Both were measured
    /// failures of the first version: a comment above a drifted declaration satisfied the pin
    /// (a false PASS — the worst possible outcome for a parity test), and a doc comment merely
    /// naming the constant made the reader answer `nil` against perfectly correct JavaScript
    /// (a false FAIL). Stripping fixes the first; trying each occurrence until one parses as a
    /// declaration fixes the second and also survives Task 4 writing `const` rather than
    /// `export const`, since nothing here cares which keyword precedes the name.
    ///
    /// The residual, stated rather than hidden: a STRING LITERAL containing the whole declaration
    /// text would be read as one. Nothing else in either direction reaches it, and a file that did
    /// that would have to spell the exact list to pass anyway.
    private static func jsStringArray(named name: String, in source: String) -> [String]? {
        let code = strippingJavaScriptComments(source)
        var searchFrom = code.startIndex
        while let nameRange = code.range(of: name, range: searchFrom..<code.endIndex) {
            searchFrom = nameRange.upperBound
            guard let open = code.range(of: "[", range: nameRange.upperBound..<code.endIndex),
                  let close = code.range(of: "]", range: open.upperBound..<code.endIndex) else {
                return nil
            }
            // Nothing but whitespace and `=` may sit between the name and the bracket, or this
            // occurrence is a mention rather than the declaration — try the next one.
            let between = code[nameRange.upperBound..<open.lowerBound]
            guard between.allSatisfy({ $0 == "=" || $0.isWhitespace }) else { continue }

            let body = code[open.upperBound..<close.lowerBound]
            var names: [String] = []
            var current: String?
            var quote: Character?
            for character in body {
                if let open = quote {
                    if character == open {
                        names.append(current ?? "")
                        current = nil
                        quote = nil
                    } else {
                        current = (current ?? "") + String(character)
                    }
                } else if character == "\"" || character == "'" {
                    quote = character
                    current = ""
                }
            }
            return quote == nil ? names : nil
        }
        return nil
    }

    /// Remove `//` line comments and `/* … */` block comments, leaving string literals alone.
    ///
    /// String-awareness is not fussiness: without it a `"https://…"` anywhere in the file would
    /// swallow the rest of its line, and if a declaration sat there the pin would report a drift
    /// that does not exist. Quotes, apostrophes and backticks all open a literal, and a backslash
    /// escapes the next character inside one. (A regular-expression literal would confuse this —
    /// noted rather than handled: a file of protocol constants has none, and the failure would be a
    /// loud `nil`, not a false pass.)
    private static func strippingJavaScriptComments(_ source: String) -> String {
        var out = ""
        var index = source.startIndex
        var quote: Character?
        var escaped = false

        while index < source.endIndex {
            let character = source[index]
            let after = source.index(after: index)
            let next = after < source.endIndex ? source[after] : nil

            if let open = quote {
                out.append(character)
                if escaped {
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == open {
                    quote = nil
                }
                index = after
                continue
            }

            if character == "\"" || character == "'" || character == "`" {
                quote = character
                out.append(character)
                index = after
                continue
            }

            if character == "/", next == "/" {
                // `.isNewline`, not `!= "\n"`: Swift's `Character` is an extended grapheme
                // cluster, so a CRLF line ending is ONE `Character`, equal to neither `"\n"` nor
                // `"\r"` alone. The `!=` form never matches it and would run this loop past the
                // end of the string on CRLF input, swallowing the rest of the file into the
                // "comment" — a loud false-FAIL against a source file this repo authors as LF, but
                // still worth being correct about.
                while index < source.endIndex, !source[index].isNewline {
                    index = source.index(after: index)
                }
                continue   // the newline itself is kept by the next turn
            }

            if character == "/", next == "*" {
                index = source.index(index, offsetBy: 2)
                while index < source.endIndex {
                    let close = source.index(after: index)
                    if source[index] == "*", close < source.endIndex, source[close] == "/" {
                        index = source.index(index, offsetBy: 2)
                        break
                    }
                    index = source.index(after: index)
                }
                // A space, so `a/* */b` does not become `ab`.
                out.append(" ")
                continue
            }

            out.append(character)
            index = after
        }
        return out
    }

    /// **The pin for the half of the bridge no test can execute: the router is actually LINKED into
    /// every process, renderers included.**
    ///
    /// The browser side and the renderer side of `CefMessageRouterBrowserSide` /
    /// `CefMessageRouterRendererSide` both live in ONE object file of the static wrapper library
    /// (`libcef_dll/wrapper/cef_message_router.cc`), and a static library only contributes an object
    /// file that something actually references. So the router's own string literals are in a binary
    /// if and only if that binary calls `…::Create`. That makes a string scan a real structural test
    /// here rather than a proxy: it is reading the linker's answer to "does this process build a
    /// router at all?".
    ///
    /// **The needle is `cefQueryCancel`, and the obvious `cefQuery` is a TAUTOLOGY** — measured in
    /// the fix round: `Norma.debug.dylib` carries three matches for it, one of which is this app's
    /// own log format string `"editor bridge router created (window.cefQuery, id=%d)"`. Deleting
    /// the browser-side `Create` while leaving that `Log` line in place would have kept the app half
    /// of this test green, which is precisely the zero-coupling shape `DoClose`'s own pin was
    /// rewritten to avoid ("a string scan cannot see a return value"). `cefQueryCancel` appears
    /// exactly once per binary, always from the router's config constructor; Norma names it only in
    /// comments, and comments do not compile in.
    ///
    /// Measured by mutation, not assumed. Deleting the single `CefMessageRouterRendererSide::Create`
    /// call from `NormaSubprocessApp` (leaving the class, the member, the three overrides and every
    /// other line untouched) drops the literal from **all five helpers while the app keeps it** —
    /// this test then fails five times, once per renderer-capable process, which is exactly the
    /// regression it exists for. A renderer with no router installs no `window.cefQuery`, and the
    /// editor page's every message would fail with the router's own -1, silently, in a live run.
    ///
    /// What it does NOT prove is that the two sides agree — the config is shared through one
    /// function (`NormaEditorBridge.h`) precisely because no scan of a binary could see a mismatch —
    /// nor that any callback is wired to anything. Task 5's live harness is the first execution.
    func testTheMessageRouterIsLinkedIntoTheBrowserProcessAndEveryRenderer() throws {
        let app = Bundle.main.bundleURL
        var binaries: [(String, URL)] = [
            ("Norma (browser process)", app.appendingPathComponent("Contents/MacOS/Norma"))
        ]
        for suffix in ["", " (Alerts)", " (GPU)", " (Plugin)", " (Renderer)"] {
            let name = "Norma Helper\(suffix)"
            binaries.append((name, app.appendingPathComponent(
                "Contents/Frameworks/\(name).app/Contents/MacOS/\(name)")))
        }

        for (name, executable) in binaries {
            XCTAssertTrue(
                Self.binaryCarries("cefQueryCancel", at: executable),
                "\(name) does not carry the message router — the wrapper's cef_message_router.o was "
                    + "not linked in, so this process builds no router and installs no window.cefQuery"
            )
        }
    }

    // MARK: - Task 4: the host page, as EMBEDDED

    /// **The page reaches the built app, nested, and exactly once.**
    ///
    /// The first half is presence: without `EditorAssets/app/editor.html` beside `EditorAssets/vs/`
    /// there is nothing for `norma-editor://app/editor.html` to serve, and the scheme's fence
    /// answers 404 to a page that exists perfectly well in the source tree. The embed phase's `app/`
    /// copy is `[ -d ]`-guarded (it was wired a task before the directory existed), so a source tree
    /// that stopped being copied would fail nothing on its own.
    ///
    /// The second half is the one with teeth. `- path: Resources` in `project.yml` is an xcodegen
    /// GROUP, so everything under it ALSO goes through Xcode's automatic Copy Bundle Resources —
    /// and that copy flattens: this project's own build log shows `Resources/MenuBar/mb-dev-idle.png`
    /// arriving as `Contents/Resources/mb-dev-idle.tiff`, no subdirectory surviving and the bytes
    /// transformed on the way. Dropping the `excludes: [EditorAssets]` entry does not break a build;
    /// it silently mints a second, dead copy of the page at the Resources root, on paths the release
    /// name-scan rules do not describe. Only an absence assertion can see that.
    func testTheEditorPageIsEmbeddedNestedAndNotFlattened() throws {
        let resources = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources", isDirectory: true)
        let editorAssets = resources.appendingPathComponent("EditorAssets", isDirectory: true)

        for relative in ["app/editor.html", "app/editor.js", "app/bridge-protocol.js", "vs/loader.js"] {
            XCTAssertTrue(
                FileManager.default.fileExists(
                    atPath: editorAssets.appendingPathComponent(relative).path),
                "EditorAssets/\(relative) is missing from the built app — the editor page cannot boot"
            )
        }

        for flattened in ["editor.html", "editor.js", "bridge-protocol.js"] {
            XCTAssertFalse(
                FileManager.default.fileExists(
                    atPath: resources.appendingPathComponent(flattened).path),
                "\(flattened) sits at the Resources ROOT — Copy Bundle Resources took EditorAssets a "
                    + "second time and flattened it, which means project.yml's `- path: Resources` "
                    + "lost its `excludes: [EditorAssets]`"
            )
        }
    }

    // MARK: - Task 5: the harness's page seam

    /// **The page's debug seam exists and stays data-only.**
    ///
    /// `normaEditorDebugState()` is how the live harness sees the model table at all: `page` is
    /// module-scoped, so nothing outside `editor.js` can reach it, and the harness reads this global
    /// through CDP `Runtime.evaluate` with `returnByValue`. Two failures it guards:
    ///
    ///  * the function going missing — every `.local` step in the drill that inspects models would
    ///    fail as a JavaScript exception, with the harness reporting a page fault for a seam that
    ///    was simply deleted;
    ///  * it starting to return live objects. `returnByValue` serialises the answer, and a Monaco
    ///    model or a disposable cannot be serialised — the evaluate would fail rather than answer,
    ///    which is why the three members are asserted by name.
    func testTheEditorPageExposesTheDataOnlyDebugStateSeam() throws {
        let source = try XCTUnwrap(Self.pageFile(named: "editor.js"),
                                   "editor.js is in neither the built bundle nor the source tree")
        let code = Self.strippingJavaScriptComments(try String(contentsOf: source, encoding: .utf8))

        XCTAssertTrue(code.contains("window.normaEditorDebugState"),
                      "editor.js no longer exposes normaEditorDebugState — Task 5's harness reads "
                        + "the model table through it and has no other door to `page`")
        // `viewTop`/`position` are Task 1's addition (Stage B hygiene): the view-state drill's
        // round-trip assertion has no other door to what the live editor is actually showing.
        for member in ["paths", "current", "dirtyMap", "viewTop", "position"] {
            XCTAssertTrue(code.contains("\(member):"),
                          "normaEditorDebugState must still answer `\(member)` — the harness's "
                            + "model-table assertions read it by name")
        }
        XCTAssertFalse(code.contains("return page;"),
                       "the debug seam must stay DATA — returning `page` hands back Monaco models "
                         + "and disposables, which returnByValue cannot serialise at all")
    }

    // MARK: - Task 5: the harness's drill script, judged without Chromium

    private func step(_ expectation: EditorHarnessExpectation,
                      id: String = "s", timeout: TimeInterval = 5) -> EditorHarnessStep {
        return EditorHarnessStep(id: id, drill: 1, title: id, expectation: expectation,
                                 timeout: timeout)
    }

    /// **The pin the whole save protocol rests on.** A `contentResponse` carrying a `seq` other than
    /// the one this step pulled must CONDEMN the step, not be skipped in the hope a better one
    /// arrives. `markSaved`'s correctness is that an acknowledgement is anchored to the pull it
    /// acknowledges; a harness that quietly accepted a late answer to a superseded pull would report
    /// the race drill green whatever the page did.
    func testAContentResponseForASupersededPullCondemnsTheStep() {
        var script = EditorHarnessScript(steps: [step(.content(path: "/a.ts", seq: 2, text: "hello"))])

        let verdict = script.advance(event: .bridge(.contentResponse(path: "/a.ts", seq: 1,
                                                                     text: "hello")))

        guard case .failed(let reason) = verdict else {
            return XCTFail("a superseded seq must fail the step, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("seq 1"), reason)
        XCTAssertTrue(reason.contains("seq 2"), reason)
        XCTAssertEqual(script.failedCount, 1)
    }

    /// The other two ways a `contentResponse` can be wrong, and neither may be treated as "not for
    /// me": a wrong path would let one model's bytes satisfy another's round trip.
    func testAContentResponseForTheWrongModelCondemnsTheStep() {
        var script = EditorHarnessScript(steps: [step(.content(path: "/a.ts", seq: 1, text: "hello"))])

        let verdict = script.advance(event: .bridge(.contentResponse(path: "/b.ts", seq: 1,
                                                                     text: "hello")))

        guard case .failed(let reason) = verdict else {
            return XCTFail("a wrong path must fail the step, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("/b.ts"), reason)
    }

    /// **Bytes, not `String`.** Swift's `==` is canonical equivalence, so a precomposed `é` and an
    /// `e` + U+0301 are the same `String` and different files. The round-trip drills exist to prove
    /// a byte-identical round trip, so `String ==` is the one comparison that could not see the
    /// failure they were written for — this is that claim, executed.
    func testTextIsComparedAsBytesSoCanonicalEquivalenceCannotPassAsIdentity() {
        let precomposed = "caf\u{00E9}"
        let decomposed = "cafe\u{0301}"
        XCTAssertEqual(precomposed, decomposed,
                       "precondition: Swift's String == calls these equal, which is exactly the trap")

        var script = EditorHarnessScript(steps: [step(.content(path: "/a.ts", seq: 1,
                                                              text: precomposed))])
        let verdict = script.advance(event: .bridge(.contentResponse(path: "/a.ts", seq: 1,
                                                                     text: decomposed)))

        guard case .failed(let reason) = verdict else {
            return XCTFail("two different byte sequences must fail the round trip, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("byte 3"), reason)
        XCTAssertNil(EditorHarnessScript.firstByteDifference(expected: precomposed,
                                                             actual: precomposed))
    }

    /// A timeout is an ORDINARY EVENT, judged by the same function as an arriving message — which is
    /// what lets `.silence` exist at all, since its pass is a timeout and its failure is a message.
    func testATimeoutFailsAWaitingStepAndPassesASilenceStep() {
        var waiting = EditorHarnessScript(steps: [step(.dirty(path: "/a.ts", dirty: true))])
        guard case .failed(let reason) = waiting.advance(event: .timeout) else {
            return XCTFail("a timeout must fail a step that was waiting for a message")
        }
        XCTAssertTrue(reason.contains("timed out"), reason)

        var silent = EditorHarnessScript(steps: [step(.silence(types: ["modelDirtyChanged"]))])
        guard case .passed = silent.advance(event: .timeout) else {
            return XCTFail("a timeout is how a silence step PASSES")
        }
        XCTAssertTrue(silent.isFinished)
    }

    /// **The race drill's whole shape.** A `.silence` step is condemned by the message it forbade —
    /// this is what "markSaved for a superseded pull must clear NOTHING" is measured with — and
    /// deliberately unmoved by any other, because the page legitimately interleaves.
    func testASilenceStepIsCondemnedByTheMessageItForbadeAndIgnoresEveryOther() {
        var script = EditorHarnessScript(steps: [step(.silence(types: ["modelDirtyChanged"]))])

        XCTAssertEqual(script.advance(event: .bridge(.saveRequested(path: "/a.ts"))), .pending,
                       "a message of another kind must leave the absence intact")
        XCTAssertEqual(script.strays.count, 1, "…and be recorded rather than dropped")

        guard case .failed(let reason) = script.advance(
            event: .bridge(.modelDirtyChanged(path: "/a.ts", dirty: false))) else {
            return XCTFail("the forbidden message must condemn the step")
        }
        XCTAssertTrue(reason.contains("stay silent"), reason)
    }

    /// A dirty transition with the right shape but the wrong VALUE is a failure, not a stray. The
    /// race drill's negative half is exactly "a `dirty: false` that must not have happened".
    func testAWrongDirtyValueCondemnsTheStepRatherThanBeingIgnored() {
        var script = EditorHarnessScript(steps: [step(.dirty(path: "/a.ts", dirty: true))])

        guard case .failed(let reason) = script.advance(
            event: .bridge(.modelDirtyChanged(path: "/a.ts", dirty: false))) else {
            return XCTFail("the wrong dirty value must fail the step")
        }
        XCTAssertTrue(reason.contains("required true"), reason)
    }

    /// Legal interleaving must not be judged. The page emits transitions on its own schedule — an
    /// external write's dirty transition can land while a pull is in flight — so a message of
    /// another kind leaves the step waiting and is recorded as a stray.
    func testAMessageOfAnotherKindLeavesTheStepWaitingAndIsRecorded() {
        var script = EditorHarnessScript(steps: [step(.content(path: "/a.ts", seq: 1, text: "x"))])

        XCTAssertEqual(script.advance(event: .bridge(.modelDirtyChanged(path: "/a.ts", dirty: true))),
                       .pending)
        XCTAssertEqual(script.index, 0, "the step must still be current")
        XCTAssertEqual(script.strays.count, 1)

        guard case .passed = script.advance(event: .bridge(.contentResponse(path: "/a.ts", seq: 1,
                                                                            text: "x"))) else {
            return XCTFail("the answer it was waiting for must still satisfy it")
        }
    }

    /// **A failed step does not stop the run.** The question eleven drills exist to answer is which
    /// of eleven independent claims hold; halting on the first red would leave the other ten
    /// unmeasured and the transcript silent about them.
    func testAFailedStepAdvancesTheRunSoTheRemainingDrillsAreStillMeasured() {
        var script = EditorHarnessScript(steps: [
            step(.ready, id: "one"),
            step(.saveRequested(path: "/a.ts"), id: "two")
        ])

        XCTAssertEqual(script.advance(event: .timeout), .failed("timed out waiting for ready"))
        XCTAssertEqual(script.current?.id, "two", "the run must move on to the next claim")

        guard case .passed = script.advance(event: .bridge(.saveRequested(path: "/a.ts"))) else {
            return XCTFail("the second step must be judged on its own merits")
        }
        XCTAssertEqual(script.passedCount, 1)
        XCTAssertEqual(script.failedCount, 1)
        XCTAssertTrue(script.isFinished)
    }

    /// A locally judged answer arriving for a step that is waiting on the PAGE is a harness bug, and
    /// a silent one if it were ignored: the step would sit until its timeout and be reported as a
    /// page failure it never caused.
    func testALocalAnswerForAPageStepIsAFailureRatherThanSilence() {
        var script = EditorHarnessScript(steps: [step(.ready)])

        guard case .failed(let reason) = script.advance(
            event: .local(ok: true, detail: "wrote the file")) else {
            return XCTFail("a local answer must not be swallowed by a step waiting on the page")
        }
        XCTAssertTrue(reason.contains("wrote the file"), reason)
    }

    /// Everything arriving after the last step is recorded and nothing is judged — a page that keeps
    /// talking once the run is over is information, not a verdict.
    func testMessagesArrivingAfterTheRunEndsAreRecordedAndNotJudged() {
        var script = EditorHarnessScript(steps: [step(.ready)])
        _ = script.advance(event: .bridge(.ready))
        XCTAssertTrue(script.isFinished)

        XCTAssertEqual(script.advance(event: .bridge(.saveRequested(path: "/a.ts"))), .pending)
        XCTAssertEqual(script.results.count, 1, "no verdict may be recorded for a step that is gone")
        XCTAssertEqual(script.strays.count, 1)
    }

    // MARK: - Task 5: what Monaco hands back

    /// **The round-trip drills' expected bytes are COMPUTED, and this is the computation.**
    ///
    /// Monaco's buffer builder normalises line endings when it constructs a model, so a file with
    /// mixed endings does not come back as it went in. Ported from the vendored build
    /// (`vendor/monaco/vs/editor/editor.main.js`, `PieceTreeTextBufferBuilder._getEOL` / `create`,
    /// with `normalizeEOL` defaulting to `true` and `defaultEOL` = LF), and pinned here so a wrong
    /// expectation shows up as a unit failure rather than as an unexplained red in a live run.
    func testMonacoEOLNormalisationMatchesTheVendoredRule() {
        // Uniform LF: nothing to rewrite.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("a\nb\nc"), "a\nb\nc")
        // Uniform CRLF: `p > b/2` picks CRLF, and with no lone terminator nothing is rewritten —
        // this is the branch fixture B is built to take, so its round trip must be byte-identical.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("a\r\nb\r\nc"), "a\r\nb\r\nc")
        // Mixed, LF in the majority — fixture A's shape. Every CRLF becomes LF.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("a\nb\nc\r\nd"), "a\nb\nc\nd")
        // Mixed, CR-bearing terminators in the majority: everything becomes CRLF.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("a\r\nb\r\nc\nd"), "a\r\nb\r\nc\r\nd")
        // An exact TIE — one CRLF against one bare LF, so `carriageBearing` is 1 of a total of 2.
        // `1 * 2 > 2` is false, so the strict majority rule sends a tie to LF, not to CRLF.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("a\r\nb\nc"), "a\nb\nc")
        // A lone CR is a terminator too, and it is never left alone.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("a\rb\nc"), "a\nb\nc")
        // No terminator at all: `defaultEOL` decides, and it decides nothing here.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("no newlines"), "no newlines")
        // A trailing terminator is preserved as one — nothing adds or removes a final newline.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("a\r\n"), "a\r\n")
        // Non-ASCII passes through the byte scan untouched, including a decomposed sequence.
        XCTAssertEqual(MonacoTextBuffer.normalisedEOL("caf\u{00E9}\r\ncafe\u{0301}\nx"),
                       "caf\u{00E9}\ncafe\u{0301}\nx")

        let counts = MonacoTextBuffer.terminatorCounts("a\r\nb\nc\rd")
        XCTAssertEqual(counts.crlf, 1)
        XCTAssertEqual(counts.lf, 1)
        XCTAssertEqual(counts.cr, 1)
    }

    #if DEBUG
    /// **The drill list itself** — the harness's own script, built the way the live run builds it.
    ///
    /// The plan's seven drills plus the four the earlier tasks' reviews earned are eleven claims,
    /// and a step quietly dropped from the sequence is invisible in a green live run: nothing fails,
    /// the transcript simply never mentions it. This asserts every drill is present, in order, and
    /// that the two round-trip expectations really carry the NORMALISED bytes rather than the raw
    /// fixtures — which is the one place a wrong expectation would look like a page defect.
    func testTheStageADrillScriptCarriesEveryDrillInOrder() throws {
        let scratch = try scratchDir()
        let fixtures = EditorHarnessFixtures(scratch: scratch)
        let steps = EditorHarnessFixtures.steps(fixtures)

        let drills = steps.map(\.drill)
        // editor-product Task 11: `steps` now ALSO carries Stage B's own drills (12-18, appended
        // after Stage A's) — `subtracting` rather than an exact-equality asks the ORIGINAL
        // question ("is every Stage-A drill present") without becoming false the moment a later
        // task appends more of them after it.
        XCTAssertEqual(Set(0...11).subtracting(Set(drills)), [],
                       "every drill from the setup step to the foreign-browser refusal must be present")
        XCTAssertEqual(drills, drills.sorted(),
                       "the steps must be in drill order — the transcript is read as eleven claims, "
                       + "then (editor-product Task 11) Stage B's own seven more, never interleaved")
        XCTAssertEqual(Set(steps.map(\.id)).count, steps.count, "step ids must be unique — the "
                       + "harness matches its actions on them")
        for drill in 0...11 {
            XCTAssertNotNil(EditorHarnessFixtures.drillTitles[drill],
                            "drill \(drill) has no title for the transcript")
        }

        // Fixture A carries a CRLF block; its round trip must expect LF throughout, plus the
        // keystroke drill 3 inserts at the caret.
        XCTAssertTrue(fixtures.fixtureA.contains("\r\n"), "fixture A must exercise mixed endings")
        guard case .content(_, let seqA, let expectedA)? = steps.first(where: { $0.id == "4.pull" })?.expectation else {
            return XCTFail("the round-trip step is missing from the script")
        }
        XCTAssertEqual(seqA, 1)
        XCTAssertFalse(expectedA.contains("\r\n"),
                       "the expected round trip must be the NORMALISED text — Monaco rewrites a "
                         + "minority CRLF block to LF, and expecting the raw fixture would fail a "
                         + "correct page")
        // editor-product Task 8: computed through the PRODUCT-facing name for the same rule
        // (`savedText(forFileOpenedWith:)` — what a save writes back), which is what the page's own
        // EOL step at `openModel` re-asserts. Same function, same bytes; the name is what says which
        // question the drill is asking.
        XCTAssertEqual(expectedA, "x" + MonacoTextBuffer.savedText(forFileOpenedWith: fixtures.fixtureA))

        // Fixture B is uniformly CRLF, so it must come back exactly as written — and it still must
        // after Task 8's `setEOL` step, which picks CRLF for exactly this text and therefore asks
        // Monaco for the ending it had already chosen (`TextModel.setEOL` early-returns on a match).
        guard case .content(_, _, let expectedB)? = steps.first(where: { $0.id == "7.pull3" })?.expectation else {
            return XCTFail("the external-write round-trip step is missing from the script")
        }
        XCTAssertEqual(expectedB, fixtures.fixtureB,
                       "a uniformly-CRLF file has nothing to normalise and must round-trip verbatim")
        XCTAssertTrue(MonacoTextBuffer.opensWithCRLF(fixtures.fixtureB),
                      "fixture B is the CRLF-dominant branch — the one the page's EOL step acts on")
        XCTAssertFalse(MonacoTextBuffer.opensWithCRLF(fixtures.fixtureA),
                       "fixture A is LF-dominant: the page's EOL step must NOT fire for it, or its "
                       + "minority CRLF block would come back as CRLF and drill 4 would fail")

        // The `.ts`/`.json` extensions are load-bearing: the language workers are the only thing in
        // the page that exercises the loader's cross-origin fetch path.
        XCTAssertTrue(fixtures.pathA.hasSuffix(".ts"))
        XCTAssertTrue(fixtures.pathC.hasSuffix(".json"))
        XCTAssertFalse(fixtures.fixtureA.hasSuffix("\n"),
                       "fixture A must end without a trailing newline")
    }

    /// **Task 1 (Stage B hygiene): the view-state round trip the Stage-A exit gate never asserted.**
    ///
    /// `9.setView` sets a real scroll position and cursor on the CURRENT model — which by drill 9 is
    /// pathA holding FIXTURE B's text, not fixture A's: drill 7's `7.apply` (`applyExternalContent`)
    /// replaced it, and nothing replaces it again before drill 9 runs. `9.setView` has to be the
    /// step immediately before `9.openC`, because `9.openC`'s implicit switch-away is what captures
    /// the view state (`activateModel`'s `saveViewState()`) — set any earlier and a later step's own
    /// cursor movement (`insertText`'s `setPosition({1,1})`) would overwrite it first. `9.viewState`
    /// has to be immediately after `9.activateA`, which is the step that restores it
    /// (`restoreViewState()`) and is therefore the earliest point the round trip can be judged.
    ///
    /// This also pins why fixture B could not stay 5 lines: a 5-line buffer has nothing to scroll —
    /// `setScrollTop(400)` clamps to a few dozen px regardless of the target line, so extending the
    /// TARGET LINE alone (the other option the brief allowed) could never satisfy a 400±50 assertion.
    /// The fixture itself needed the extra height; the target position stayed {30, 5}.
    func testTheViewStateStepsBracketTheSecondModelOpenAtExactlyTheRightPoints() throws {
        let scratch = try scratchDir()
        let fixtures = EditorHarnessFixtures(scratch: scratch)
        let steps = EditorHarnessFixtures.steps(fixtures)
        let ids = steps.map(\.id)

        // editor-product Task 11 appended Stage B (26 more steps, drills 12-18) AFTER Stage A's
        // own — scoped to `drill <= 11` so this stays the Stage-A-specific count it always was;
        // `testTheStageBDrillScriptCarriesEveryDrillInOrder`, below, pins the combined total.
        let stageASteps = steps.filter { $0.drill <= 11 }
        XCTAssertEqual(stageASteps.count, 44, "two new steps (9.setView, 9.viewState) joined the "
                       + "Stage-A script's 41 (Task 1); editor-product Task 4 adds a third, "
                       + "1.brand, so the branded theme is live before drill 10's before-screenshot "
                       + "runs")

        guard let setViewIndex = ids.firstIndex(of: "9.setView"),
              let openCIndex = ids.firstIndex(of: "9.openC"),
              let activateAIndex = ids.firstIndex(of: "9.activateA"),
              let viewStateIndex = ids.firstIndex(of: "9.viewState"),
              let closeActiveIndex = ids.firstIndex(of: "9.closeActive") else {
            return XCTFail("one of the view-state steps or its neighbours is missing from the script")
        }
        XCTAssertEqual(setViewIndex + 1, openCIndex,
                       "9.setView must be the step immediately before 9.openC — the switch-away it "
                         + "provokes is what captures the view state")
        XCTAssertEqual(activateAIndex + 1, viewStateIndex,
                       "9.viewState must read back immediately after 9.activateA restores it")
        XCTAssertLessThan(viewStateIndex, closeActiveIndex,
                          "the view state must be judged before the model it lives on is closed")
        XCTAssertEqual(steps[setViewIndex].drill, 9)
        XCTAssertEqual(steps[viewStateIndex].drill, 9)

        // Fixture B is what pathA holds at that point (drill 7's applyExternalContent) — long
        // enough for `viewStateLine` to be real content and for a `viewStateScrollTop`-sized scroll
        // not to clamp to nothing, without disturbing drill 7's own byte-identical expectation
        // (asserted separately, above — this only checks the NEW shape this task added).
        let lines = fixtures.fixtureB.components(separatedBy: "\r\n")
        XCTAssertGreaterThanOrEqual(lines.count, EditorHarnessFixtures.viewStateLine,
                                    "fixture B must have a real line \(EditorHarnessFixtures.viewStateLine) "
                                      + "for setPosition to land on content instead of being clamped")
        let targetLine = lines[EditorHarnessFixtures.viewStateLine - 1]
        XCTAssertGreaterThanOrEqual(targetLine.count, EditorHarnessFixtures.viewStateColumn,
                                    "line \(EditorHarnessFixtures.viewStateLine) must have at least "
                                      + "column \(EditorHarnessFixtures.viewStateColumn) worth of content")
        XCTAssertGreaterThanOrEqual(lines.count, 60, "fixture B must be tall enough that "
                                    + "scrollTop(\(EditorHarnessFixtures.viewStateScrollTop)) is not "
                                    + "clamped near 0 in the harness's ~600px-tall viewport")
    }

    /// **editor-product Task 11 — Stage B's own drill-list pin**, the same rigor
    /// `testTheStageADrillScriptCarriesEveryDrillInOrder` applies to Stage A: every drill 12-18
    /// present, ids unique, steps in drill order, and the fixtures whose EOL rule the undo/CRLF
    /// drills depend on actually carry the bytes those drills need — a wrong fixture here would
    /// look like a runtime defect, not a harness one.
    func testTheStageBDrillScriptCarriesEveryDrillInOrder() throws {
        let scratch = try scratchDir()
        let fixtures = EditorHarnessFixtures(scratch: scratch)
        let steps = EditorHarnessFixtures.steps(fixtures)
        XCTAssertEqual(steps.count, 70, "Stage A's own 44 steps (Task 1 + editor-product Task 4's "
                       + "1.brand) plus Stage B's 26 (editor-product Task 11)")

        let stageB = steps.filter { $0.drill >= 12 }
        XCTAssertEqual(Set(stageB.map(\.drill)), Set(12...18),
                       "every drill from the runtime's own boot to the files-tree smoke must be "
                       + "present")
        XCTAssertEqual(stageB.map(\.drill), stageB.map(\.drill).sorted(),
                       "Stage B's steps must be in drill order too")
        XCTAssertEqual(Set(steps.map(\.id)).count, steps.count,
                       "step ids must be unique across BOTH stages — the harness matches its "
                       + "actions on them")
        for drill in 12...18 {
            XCTAssertNotNil(EditorHarnessFixtures.drillTitles[drill],
                            "drill \(drill) has no title for the transcript")
        }

        // The EOL-sensitive fixtures the undo drill and the CRLF round trip depend on.
        XCTAssertTrue(MonacoTextBuffer.opensWithCRLF(fixtures.fixtureCRLF),
                      "drill 14's file must be the CRLF-dominant branch, or the round trip proves "
                      + "nothing about the normalisation rule")
        XCTAssertEqual(fixtures.fixtureCRLF, fixtures.fixtureB,
                       "drill 14 deliberately reuses fixture B's own content — its saved-text byte "
                       + "count is already independently pinned by drill 7's own live pull, so the "
                       + "two are cross-checks of the SAME number rather than two hand-counted ones")
        XCTAssertFalse(MonacoTextBuffer.opensWithCRLF(fixtures.fixtureUndoOriginal),
                       "drill 15's ORIGINAL file must be LF-dominant — the undo drill's whole claim "
                       + "is about the FLIP the simulated agent write causes")
        XCTAssertTrue(MonacoTextBuffer.opensWithCRLF(fixtures.fixtureAgentWrite),
                      "drill 15's simulated agent write must be CRLF-dominant — the flip pushEOL "
                      + "(editor-product Task 11, Part 0) exists to make undoable")
        XCTAssertNotEqual(
            MonacoTextBuffer.savedText(forFileOpenedWith: "U" + fixtures.fixtureUndoOriginal),
            MonacoTextBuffer.savedText(forFileOpenedWith: fixtures.fixtureAgentWrite),
            "the pre-agent (user-edited) text and the agent's write must be genuinely DIFFERENT "
            + "content, or \"content updated\" is unprovable")
        XCTAssertNotEqual(fixtures.fixtureBanner, fixtures.fixtureBannerExternal,
                          "the banner drill's external write must be genuinely different content, "
                          + "or the conflict it raises proves nothing")

        // 13.timeout's whole premise is a path the page never opened — never written, even after
        // the SAME writeToDisk() the live run calls at 0.setup.
        try fixtures.writeToDisk()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixtures.pathNeverOpened),
                       "pathNeverOpened must not exist on disk even after writeToDisk()")
        // 18's tree starts empty — the debounce-window claim needs a file that arrives AFTER the
        // watcher is already armed, not one the tree already knew about.
        let treeEntries = try FileManager.default.contentsOfDirectory(atPath: fixtures.filesTreeDir)
        XCTAssertEqual(treeEntries, [], "the files-tree smoke needs an EMPTY directory to start from")
    }
    #endif

    /// Search a built binary — and its `.debug.dylib` sibling, which is where a Debug build's code
    /// actually lives — for a literal.
    private static func binaryCarries(_ needle: String, at executable: URL) -> Bool {
        let candidates = [
            executable,
            executable.deletingLastPathComponent()
                .appendingPathComponent(executable.lastPathComponent + ".debug.dylib")
        ]
        let bytes = Data(needle.utf8)
        for candidate in candidates {
            guard let data = try? Data(contentsOf: candidate, options: .mappedIfSafe) else {
                continue
            }
            if data.range(of: bytes) != nil {
                return true
            }
        }
        return false
    }
}
