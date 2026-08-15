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

    /// **The exact bytes, pinned.** Quotes, a newline, a non-ASCII dash and an emoji in one payload
    /// — everything an escaper gets wrong. Key order is deterministic (`.sortedKeys`), slashes are
    /// not escaped (`.withoutEscapingSlashes`), and non-ASCII stays literal UTF-8, which is valid
    /// JSON and what every browser's `JSON.parse` reads.
    func testOpenModelRendersExactlyTheseBytes() throws {
        let js = EditorBridgeOutbound.openModel(
            path: "/tmp/a b.swift",
            language: "swift",
            text: "let s = \"hi\"\nprint(s) — ✅"
        ).javascript

        XCTAssertEqual(
            js,
            #"window.normaEditor.dispatch({"language":"swift","path":"/tmp/a b.swift","text":"let s = \"hi\"\nprint(s) — ✅","type":"openModel"})"#
        )
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
             "setTheme", ["tokens": ["background": "black"]])
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
                        "applyExternalContent", "setTheme"])

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
            .setTheme(tokensJSON: "{}")
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
        // `#filePath` is this file at `apple/Norma/Tests/NormaAppTests/`; four levels up is
        // `apple/Norma`, where `Resources/` lives.
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // NormaAppTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // Norma
            .appendingPathComponent("Resources/EditorAssets/app/bridge-protocol.js")

        let found = [bundled, source].first { FileManager.default.fileExists(atPath: $0.path) }
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

    /// Pull `NAME = [ "a", "b" ]` out of JavaScript source. Deliberately a small, strict reader
    /// rather than a JS parser: it takes the first `NAME` followed by `=` and an array literal on
    /// the same statement, and reads only quoted strings out of it. `nil` when the declaration is
    /// absent, which fails the comparison above rather than silently matching an empty list.
    private static func jsStringArray(named name: String, in source: String) -> [String]? {
        guard let nameRange = source.range(of: name),
              let open = source.range(of: "[", range: nameRange.upperBound..<source.endIndex),
              let close = source.range(of: "]", range: open.upperBound..<source.endIndex) else {
            return nil
        }
        // Nothing but whitespace and `=` may sit between the name and the bracket, or this matched
        // some other statement entirely.
        let between = source[nameRange.upperBound..<open.lowerBound]
        guard between.allSatisfy({ $0 == "=" || $0.isWhitespace }) else { return nil }

        let body = source[open.upperBound..<close.lowerBound]
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
