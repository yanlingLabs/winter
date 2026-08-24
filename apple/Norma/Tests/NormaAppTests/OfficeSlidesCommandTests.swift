import AppKit
import NormaKit
import NormaProtocol
import XCTest
@testable import Norma

/// office-agent-tools T6 — live drills for `slides` against the REAL helper, REAL vendored
/// LibreOffice, and REAL fixtures. Mirrors `OfficeSheetsCommandTests.swift`'s own established shape
/// exactly (fixtures/boilerplate, wire-decoded `PanelCommand` fixtures driven through the real
/// `OfficeCommandConsumer` -> `OfficeAgentBroker` -> `OfficeRuntime` -> `OfficeHelperClient` -> the
/// wire -> `NormaOfficeHelper` -> `LOKBridge` -> real LOK stack) — see that file's own header for the
/// full rationale, not repeated here.
@MainActor
final class OfficeSlidesCommandTests: XCTestCase {

    // MARK: - Fixtures/boilerplate (byte-identical to OfficeSheetsCommandTests' own copy)

    private static var repoRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url
    }
    private static var vendorProductSetRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/vendor/libreoffice/product-set", isDirectory: true)
    }
    private static var fixturesRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/Tests/NormaAppTests/Fixtures/office", isDirectory: true)
    }
    private static var sandboxProfilePath: URL {
        repoRoot.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
    }
    private static var helperURL: URL {
        Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
    }

    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("officeslidescommand-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    private func requireLiveEngine() throws {
        try XCTSkipIf(!FileManager.default.fileExists(atPath: Self.helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(Self.helperURL.path)) — add it to the scheme's build list and re-run.")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: Self.vendorProductSetRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(Self.vendorProductSetRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
    }

    private func makeWritableCopy(of fixtureName: String, as destName: String? = nil) throws -> String {
        let fixturePath = Self.fixturesRoot.appendingPathComponent(fixtureName).path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "\(fixtureName) fixture missing")
        let scratch = makeScratchDirectory()
        let docPath = scratch.appendingPathComponent(destName ?? fixtureName).path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))
        return docPath
    }

    private func codeRow(_ sessionId: String, dirs: [SessionDirEntry]?) -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global",
                       cwd: dirs?.first?.path, mode: "code", dirs: dirs)
    }

    private func makeLiveHost(stateDir: URL, dirs: [SessionDirEntry], sessionId: String = "S1") -> ShellSessionHost {
        let directory = SessionDirectory(lister: { [self.codeRow(sessionId, dirs: dirs)] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: Self.helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", Self.vendorProductSetRoot.path,
                                 "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        return host
    }

    private func waitUntilLive(timeout: TimeInterval = 90, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    // MARK: - Driving OfficeCommandConsumer with wire-decoded PanelCommand fixtures

    struct Sent: Equatable {
        var sessionId: String
        var commandId: String
        var ok: Bool
        var result: String?
    }

    private func command(_ action: String, args: [String: Any], sessionId: String,
                         commandId: String = "pcmd_1") -> SessionEvent.PanelCommand {
        let fields: [String: Any] = [
            "type": "panel_command", "seq": 1, "sessionId": sessionId, "ts": 0,
            "commandId": commandId, "action": action, "deadlineMs": 155_000, "args": args,
        ]
        let data = try! JSONSerialization.data(withJSONObject: fields) // swiftlint:disable:this force_try
        guard case .panelCommand(let decoded)? = try? JSONDecoder().decode(SessionEvent.self, from: data) else {
            fatalError("the fixture did not decode as a panel_command")
        }
        return decoded
    }

    private func send(_ command: SessionEvent.PanelCommand, through host: ShellSessionHost) async -> Sent {
        var sent: Sent?
        let consumer = OfficeCommandConsumer(
            sendResult: { sessionId, commandId, ok, result, _ in
                sent = Sent(sessionId: sessionId, commandId: commandId, ok: ok, result: result)
            },
            officeAgentBroker: { [weak host] _ in host?.officeAgentBroker })
        consumer.handle(command)
        let arrived = await waitUntilLive { sent != nil }
        guard arrived, let sent else {
            XCTFail("slides \(command.action) never answered")
            return Sent(sessionId: command.sessionId, commandId: command.commandId, ok: false, result: nil)
        }
        return sent
    }

    // MARK: - Probe A live drill — the Tab-cycling text mechanism, against real content

    /// **The first live test of `selectSlidePlaceholderOnDedicatedThread`/`readSelectedShapeText
    /// OnDedicatedThread` against real content.** `three-slide.fodp` (this task's own fixture) has
    /// three slides, each with a REAL title+outline placeholder frame and distinct, known text
    /// ("Norma T6 Slide One/Two/Three", "first/second/third bullet") — if Tab-cycling and the
    /// `GRAPHIC_SELECTION`-based verification actually work, `info` (which now reads every slide's
    /// title, ruling 2) must report exactly this content, in order, and `read` must return both
    /// title AND body for one slide directly.
    func testLiveSlidesInfoReadsRealTitlesFromThreeSlideFixture() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "three-slide.fodp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        // Distinct commandIds — `OfficeAgentBroker.perform`'s own `requestId`-keyed memoization
        // (deliberate, Task 2's own design) returns the FIRST call's cached outcome verbatim for a
        // repeated commandId; two `send()` calls sharing the default "pcmd_1" is exactly the trap
        // task-3-report.md §6 already documented hitting once (there, a wire-decode collision; here,
        // the identical mechanism). Never reuse the default across more than one `send()` in the same
        // test.
        let infoResult = await send(command("office.slides.info", args: ["path": path], sessionId: "S1", commandId: "pcmd_info"), through: host)
        XCTAssertTrue(infoResult.ok, "\(infoResult)")
        let infoText = infoResult.result ?? ""
        XCTAssertTrue(infoText.contains("3 slides"), infoText)
        XCTAssertTrue(infoText.contains("Norma T6 Slide One"), infoText)
        XCTAssertTrue(infoText.contains("Norma T6 Slide Two"), infoText)
        XCTAssertTrue(infoText.contains("Norma T6 Slide Three"), infoText)
        XCTAssertFalse(infoText.lowercased().contains("layout"), "info must never mention layout: \(infoText)")

        let readResult = await send(command("office.slides.read", args: ["path": path, "slide": 2], sessionId: "S1", commandId: "pcmd_read"), through: host)
        XCTAssertTrue(readResult.ok, "\(readResult)")
        let readText = readResult.result ?? ""
        XCTAssertTrue(readText.contains("Norma T6 Slide Two"), readText)
        XCTAssertTrue(readText.contains("second bullet"), readText)
    }
}
