import XCTest
import Foundation

/// Structural guards over the package's own source: the properties that are easy to break with an innocent-looking edit and expensive
/// to notice later. Each reads the sources under `Sources/` (never the tests).
final class StaticChecksTests: XCTestCase {
    private static let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    private struct Source { let path: String; let text: String; var lines: [String] { text.components(separatedBy: "\n") } }
    private static let sources: [Source] = {
        let root = packageRoot.appendingPathComponent("Sources")
        let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        return enumerator.compactMap { $0 as? URL }.filter { ["swift", "c", "h"].contains($0.pathExtension) }
            .map { Source(path: String($0.path.dropFirst(root.path.count + 1)), text: try! String(contentsOf: $0, encoding: .utf8)) }.sorted { $0.path < $1.path }
    }()
    private func code(_ source: Source) -> [(number: Int, text: String)] {
        // Lines with comments stripped (// and a whole-line block-comment body), so prose cannot trip or hide a check.
        source.lines.enumerated().compactMap { index, line in
            var text = line
            if let range = text.range(of: "//") { text = String(text[..<range.lowerBound]) }
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("/*") || trimmed.hasPrefix("*") { return nil }
            return (index + 1, text)
        }
    }
    private func hits(_ pattern: String, in files: [Source] = StaticChecksTests.sources) -> [String] {
        let regex = try! NSRegularExpression(pattern: pattern)
        return files.flatMap { source in code(source).filter { regex.firstMatch(in: $0.text, range: NSRange($0.text.startIndex..., in: $0.text)) != nil }.map { "\(source.path):\($0.number)" } }
    }

    func testTheSourcesWereFound() {
        XCTAssertGreaterThan(Self.sources.count, 20)
        XCTAssertTrue(Self.sources.contains { $0.path == "LauncherNative/native.c" })
    }

    func testNoHypervisorLibkrunOrSandboxCallExistsAnywhere() {
        XCTAssertEqual(hits(#"hv_vm_|hv_vcpu|Hypervisor|krun_|sandbox_init|sandbox_check"#), [])
    }
    func testNoSleepAssertionIsEverCreated() {
        XCTAssertEqual(hits(#"IOPMAssertion|IOPMSetSystemPower|caffeinate|pmset"#), [], "the power observer observes; it never keeps the machine awake")
    }
    func testNoKeychainNoWinterHomeNoLaunchdNoEnvironmentRead() {
        XCTAssertEqual(hits(#"SecItem|kSecClass|Keychain|SecKeychain"#), [])
        XCTAssertEqual(hits(#"homeDirectory|NSHomeDirectory|getpwuid|\$HOME|expandingTildeInPath"#), [], "the launcher is told where to write; it never derives a home")
        XCTAssertEqual(hits(#"SMAppService|LaunchAgents|launchctl|launchd"#), [], "no persistence, no registration")
        XCTAssertEqual(hits(#"ProcessInfo|getenv\(|\benviron\b|setenv\(|CommandLine\.unsafeArgv"#), [], "no run-time switch can come from the environment")
    }
    func testTheOnlyReferenceToAWinterHomeIsTheStoresRefusalToUseOne() {
        let found = hits(#"["/]\.winter"#)
        XCTAssertEqual(found.count, 1, "\(found)")
        XCTAssertTrue(found[0].hasPrefix("LauncherCore/Session/DirectoryReceiptStore.swift"))
    }

    // MARK: the receipt key stays in memory

    func testTheReceiptKeyIsNeverLoggedWrittenOrPrintedBySourceCode() {
        // Nothing in the launcher's library prints, logs or dumps anything (the single stderr line is the argument parser's usage error)...
        let outputs = hits(#"\bprint\(|debugPrint\(|\bdump\(|NSLog\(|os_log|Logger\(|fputs\(|fprintf\(|FileHandle\.standardError|standardOutput"#, in: Self.sources.filter { $0.path.hasPrefix("LauncherCore/") })
        XCTAssertEqual(outputs, ["LauncherCore/Launcher/LauncherMain.swift:21"], "\(outputs)")
        // ...the key's text has exactly two readers: its own type (the redacted forms never use it) and the L1 serializer of `begin`...
        let reveal = hits(#"revealBase64\("#)
        XCTAssertEqual(reveal.map { $0.split(separator: ":")[0] }.sorted(), ["LauncherCore/Wire/LauncherLines.swift", "LauncherCore/Wire/ReceiptKey.swift"], "\(reveal)")
        // ...and nothing that holds the key writes a file other than the receipt store, which receives receipts (MAC included) and never the key.
        XCTAssertEqual(hits(#"receiptKey|ReceiptKey"#, in: Self.sources.filter { $0.path.contains("DirectoryReceiptStore") }).count, 1, "the store only takes a key to VERIFY with (the one `load` signature)")
    }

    // MARK: sole reaper, one signal path

    func testTheOnlySignalsAreInsideTheOwnedHandle() {
        let nativeCalls = hits(#"(^|[^_.\w])kill\("#, in: Self.sources.filter { $0.path.hasSuffix(".c") })
        XCTAssertEqual(nativeCalls.count, 2, "wait_signal (the SIGKILL after a fresh ownership probe) and the SIGCONT in lc_resume_owned: \(nativeCalls)")
        XCTAssertEqual(hits(#"(^|[^_.\w])(?<!func )(kill|killpg|raise|pthread_kill)\("#, in: Self.sources.filter { $0.path.hasSuffix(".swift") }), [], "no Swift code signals a pid")
        XCTAssertEqual(hits(#"\bkill\(\s*(pid|[a-zA-Z]*Pid|[a-zA-Z]*pid)"#, in: Self.sources.filter { $0.path.hasSuffix(".swift") }), [])
    }
    func testNothingButTheOwnedHandleWaitsOnAProcess() {
        let swift = Self.sources.filter { $0.path.hasSuffix(".swift") }
        XCTAssertEqual(hits(#"waitpid|wait4|\bwait\(|SIGCHLD|NSTask|\bProcess\("#, in: swift), [], "the launcher is the sole reaper; no competing wait and no Foundation.Process")
        let native = Self.sources.first { $0.path == "LauncherNative/native.c" }!
        XCTAssertEqual(hits(#"waitpid\("#, in: [native]).count, 1, "one waitpid, in the injectable probe")
    }
    func testNoApiTakesACallerSuppliedPidToSignalOrReap() {
        let header = Self.sources.first { $0.path == "LauncherNative/include/launcher_native.h" }!
        let regex = try! NSRegularExpression(pattern: #"lc_(kill|signal|wait|reap|resume|probe)\w*\s*\([^)]*pid_t"#)
        XCTAssertNil(regex.firstMatch(in: header.text, range: NSRange(header.text.startIndex..., in: header.text)), "every signalling entry point takes the owned handle")
    }

    // MARK: every read of a descriptor-bearing socket is recvmsg

    func testNoPlainReadReceiveOrFileHandleTouchesASocket() {
        // Two files read REGULAR files by descriptor (the receipt store and the guest-artifact hash); neither touches a socket.
        let swift = Self.sources.filter { $0.path.hasSuffix(".swift") && $0.path != "LauncherCore/Session/DirectoryReceiptStore.swift" && $0.path != "LauncherCore/Identity/GuestArtifacts.swift" }
        XCTAssertEqual(hits(#"(^|[^_.\w])(?<!func )(read|recv|recvfrom|readv)\("#, in: swift), [], "a plain read() installs SCM_RIGHTS descriptors")
        XCTAssertEqual(hits(#"FileHandle|DispatchIO|NWConnection|URLSession|InputStream|\.fileDescriptor"#, in: swift), [])
        let native = Self.sources.first { $0.path == "LauncherNative/native.c" }!
        XCTAssertEqual(hits(#"(^|[^_.\w])recvmsg\("#, in: [native]).count, 1, "one receive path in C: lc_recvmsg")
        XCTAssertEqual(hits(#"(^|[^_.\w])(read|recv|recvfrom)\("#, in: [native]), [])
    }

    // MARK: the test pin

    func testTheTestMarkerOnlyAppearsInsideACompileTimeTestBuildRegion() {
        var violations: [String] = []
        for source in Self.sources where source.path.hasSuffix(".swift") {
            var depth = 0, inside: [Bool] = []
            for (index, line) in source.lines.enumerated() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("#if") { inside.append(trimmed == "#if WINTER_COWORK_TEST_BUILD"); depth += 1 }
                else if trimmed.hasPrefix("#else") && !inside.isEmpty { inside[inside.count - 1] = false }
                else if trimmed.hasPrefix("#endif") && !inside.isEmpty { inside.removeLast(); depth -= 1 }
                else if line.contains("WINTER_COWORK_TEST_") || line.contains("cdhash H"), !trimmed.hasPrefix("//"), !trimmed.hasPrefix("///"), !trimmed.hasPrefix("*"), !inside.contains(true) { violations.append("\(source.path):\(index + 1)") }
            }
        }
        XCTAssertEqual(violations, [], "test hooks exist only under -DWINTER_COWORK_TEST_BUILD")
    }
    #if !WINTER_COWORK_TEST_BUILD
    func testTheBuiltLauncherOfANormalBuildCarriesNoTestHookAtAll() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: BuiltProducts.launcher))
        for marker in ["WINTER_COWORK_TEST_", "TEST_PARENT_CDHASH", "TEST_WORKER_CDHASH", "cdhash H"] {
            XCTAssertNil(data.range(of: Data(marker.utf8)), "\(marker) must not exist in a normal build")
        }
    }
    #endif
    func testTheProductionRequirementsAreNamedOnceEach() {
        XCTAssertEqual(hits(#""winter-core""#).count, 1, "the shipped daemon signs as winter-core, and the constant is named once")
        XCTAssertEqual(hits(#""com\.winter\.core\.dev""#).count, 1)
        XCTAssertEqual(hits(#""com\.winter\.core""#).count, 0, "not the identifier the shipped daemon carries")
        XCTAssertEqual(hits(#"37N77U9RSZ"#).count, 1)
    }
}
