import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Floor F's language-independent signature: the "Allow remote debugging?" dialog is known by the browser's OWN words
/// for it, read from its locale packs under the resource ids its English pack anchors — in every language it ships —
/// and, when those can't be read and the browser does not show English, any dialog of it is refused (fail closed).
final class RemoteDebuggingLexiconTests: XCTestCase {
    // MARK: - A data pack, as Chromium's resource tooling writes one

    /// A pack of `strings` (version 4 or 5; encoding 1 = UTF-8, 2 = UTF-16LE), with `aliases` (id → an entry's id).
    static func pack(_ strings: [UInt16: String], version: UInt32 = 5, encoding: UInt8 = 1, aliases: [UInt16: UInt16] = [:]) -> Data {
        let ids = strings.keys.sorted()
        func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xFF), UInt8(v >> 8)] }
        func le32(_ v: UInt32) -> [UInt8] { le16(UInt16(v & 0xFFFF)) + le16(UInt16(v >> 16)) }
        func bytes(_ s: String) -> [UInt8] {
            encoding == 2 ? s.utf16.flatMap { le16($0) } : Array(s.utf8)
        }
        var header: [UInt8]
        if version == 4 {
            header = le32(4) + le32(UInt32(ids.count)) + [encoding]
        } else {
            header = le32(version) + [encoding, 0, 0, 0] + le16(UInt16(ids.count)) + le16(UInt16(aliases.count))
        }
        let tableSize = (ids.count + 1) * 6 + (version == 4 ? 0 : aliases.count * 4)
        var offset = header.count + tableSize
        var table: [UInt8] = []
        var body: [UInt8] = []
        for id in ids {
            table += le16(id) + le32(UInt32(offset))
            let b = bytes(strings[id]!)
            body += b
            offset += b.count
        }
        table += le16(0) + le32(UInt32(offset))
        if version != 4 {
            for (alias, target) in aliases.sorted(by: { $0.key < $1.key }) {
                table += le16(alias) + le16(UInt16(ids.firstIndex(of: target)!))
            }
        }
        return Data(header + table + body)
    }

    func testAPackReadsItsStringsInBothVersionsAndEncodings() throws {
        let v5 = try XCTUnwrap(CUResourcePack(Self.pack([7: "seven", 3: "three", 9: "neuf ✓"], aliases: [12: 9])))
        XCTAssertEqual(v5.string(3), "three")
        XCTAssertEqual(v5.string(9), "neuf ✓")
        XCTAssertEqual(v5.string(12), "neuf ✓", "an alias reads its entry")
        XCTAssertNil(v5.string(8))
        XCTAssertEqual(v5.ids, [3, 7, 9])
        let v4 = try XCTUnwrap(CUResourcePack(Self.pack([1: "one", 2: "two"], version: 4)))
        XCTAssertEqual(v4.string(2), "two")
        let utf16 = try XCTUnwrap(CUResourcePack(Self.pack([5: "リモート デバッグ"], encoding: 2)))
        XCTAssertEqual(utf16.string(5), "リモート デバッグ")
        // Malformed: too short, an unknown version, a table past the end, an unknown encoding.
        XCTAssertNil(CUResourcePack(Data([5, 0, 0])))
        XCTAssertNil(CUResourcePack(Self.pack([1: "x"], version: 6)))
        XCTAssertNil(CUResourcePack(Self.pack([1: "x", 2: "y"]).prefix(16)))
        XCTAssertNil(CUResourcePack(Self.pack([1: "x"], encoding: 7)))
        // An offset past the end reads as nothing, never a crash.
        var broken = Self.pack([1: "abc"])
        broken[12 + 6 + 2] = 0xFF
        XCTAssertNil(CUResourcePack(broken)?.string(1))
    }

    // MARK: - The lexicon

    /// The English pack of a browser, and three others: the dialog's title (100) and body (101), its buttons (102/103,
    /// words every dialog uses), and another dialog's title (104).
    static let english: [UInt16: String] = [
        100: "Allow remote debugging?",
        101: "An external app wants full control over this Browser session to debug it. This includes access to your saved data.",
        102: "Allow", 103: "Deny", 104: "Save password?", 105: "\"$1\" started debugging this browser",
    ]
    static let french: [UInt16: String] = [
        100: "Autoriser le débogage à distance\u{00A0}?",
        101: "Une application externe souhaite contrôler entièrement cette session de Browser pour la déboguer. Cela inclut l'accès à vos données enregistrées.",
        102: "Autoriser", 103: "Refuser", 104: "Enregistrer le mot de passe\u{00A0}?",
    ]
    static let japanese: [UInt16: String] = [100: "リモート デバッグを許可しますか？", 102: "許可", 104: "パスワードを保存しますか？"]
    static let spanish: [UInt16: String] = [100: "¿Permitir la depuración remota?", 102: "Permitir"]

    static func lexicon() -> CURemoteDebuggingLexicon {
        CURemoteDebuggingLexicon.build(english: CUResourcePack(pack(english))!,
                                       others: [french, japanese, spanish].map { CUResourcePack(pack($0))! })!
    }

    func testTheLexiconIsAnchoredOnTheBrowsersOwnEnglishWords() {
        let l = Self.lexicon()
        XCTAssertEqual(l.languages, 4)
        XCTAssertTrue(l.matches("Autoriser le débogage à distance ?"), "French, an ordinary space before ?")
        XCTAssertTrue(l.matches("Autoriser le débogage à distance\u{00A0}?"), "French, the pack's no-break space")
        XCTAssertTrue(l.matches("リモート デバッグを許可しますか？"))
        XCTAssertTrue(l.matches("¿Permitir la depuración remota?"))
        XCTAssertTrue(l.matches("ALLOW REMOTE DEBUGGING?"))
        XCTAssertTrue(l.matches(Self.french[101]), "the body, in French")
        // Never the buttons' words, another dialog, a placeholder phrase, or nothing.
        for s in ["Autoriser", "Refuser", "許可", "Permitir", "Enregistrer le mot de passe ?", "パスワードを保存しますか？",
                  "started debugging this browser", "", "?"] {
            XCTAssertFalse(l.matches(s), s)
        }
        XCTAssertFalse(l.matches(nil))
    }

    func testANewVersionsRenumberedIdsAreFoundAgainByTheirEnglishWords() {
        let renumber: ([UInt16: String]) -> [UInt16: String] = { Dictionary(uniqueKeysWithValues: $0.map { ($0.key + 5000, $0.value) }) }
        let l = CURemoteDebuggingLexicon.build(english: CUResourcePack(Self.pack(renumber(Self.english)))!,
                                               others: [CUResourcePack(Self.pack(renumber(Self.french)))!])
        XCTAssertEqual(l?.matches("Autoriser le débogage à distance ?"), true)
    }

    func testNoEnglishAnchorIsNoLexicon() {
        let en = CUResourcePack(Self.pack([1: "Save password?", 2: "Allow"]))!
        XCTAssertNil(CURemoteDebuggingLexicon.build(english: en, others: [CUResourcePack(Self.pack(Self.french))!]))
        XCTAssertTrue(CURemoteDebuggingLexicon.isAnchor("Allow remote debugging?"))
        XCTAssertFalse(CURemoteDebuggingLexicon.isAnchor("How to allow remote debugging in your browser: a long guide to every flag and switch"),
                       "a long text naming it is no title")
    }

    func testNormalizingFoldsSpacesCaseAndEndPunctuation() {
        XCTAssertEqual(CURemoteDebuggingLexicon.normalize("  ¿Permitir  la\u{202F}depuración\nremota?  "), "permitir la depuración remota")
        XCTAssertEqual(CURemoteDebuggingLexicon.normalize("السماح بتصحيح الأخطاء عن بُعد؟"), "السماح بتصحيح الأخطاء عن بُعد")
    }

    // MARK: - Reading an installed browser's packs

    func testTheStoreReadsEveryVersionsLocalePacksFromTheBundle() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("rd-lexicon-\(UUID().uuidString)")
        addTeardownBlock { try? fm.removeItem(at: root) }
        let app = root.appendingPathComponent("Some Browser.app")
        let versions = app.appendingPathComponent("Contents/Frameworks/Some Browser Framework.framework/Versions")
        func write(_ version: String, _ lang: String, _ strings: [UInt16: String]) throws {
            let dir = versions.appendingPathComponent(version).appendingPathComponent("Resources").appendingPathComponent("\(lang).lproj")
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try Self.pack(strings).write(to: dir.appendingPathComponent("locale.pak"))
        }
        try write("2.0", "en", Self.english)
        try write("2.0", "fr", Self.french)
        // The update waiting beside the running version: renumbered, with Japanese.
        try write("2.1", "en", Dictionary(uniqueKeysWithValues: Self.english.map { ($0.key + 1, $0.value) }))
        try write("2.1", "ja", Dictionary(uniqueKeysWithValues: Self.japanese.map { ($0.key + 1, $0.value) }))
        try fm.createSymbolicLink(atPath: versions.appendingPathComponent("Current").path, withDestinationPath: "2.1")
        try fm.createDirectory(at: app.appendingPathComponent("Contents/Frameworks/Other.framework/Versions/A/Resources"),
                               withIntermediateDirectories: true)

        let folders = CURemoteDebuggingLexiconStore.resourceFolders(appBundle: app).map(\.lastPathComponent)
        XCTAssertEqual(folders.count, 2, "each version once, never through Current; a framework with no locale pack is none")
        CURemoteDebuggingLexiconStore.reset()
        let l = try XCTUnwrap(CURemoteDebuggingLexiconStore.lexicon(appBundle: app))
        XCTAssertTrue(l.matches("Autoriser le débogage à distance ?"))
        XCTAssertTrue(l.matches("リモート デバッグを許可しますか？"))
        XCTAssertNil(CURemoteDebuggingLexiconStore.lexicon(appBundle: root.appendingPathComponent("Nothing.app")))
        CURemoteDebuggingLexiconStore.reset()
    }

    /// Opt-in, read-only: an installed Chromium browser's own packs (`WINTER_CU_LEXICON_APP=<path to the .app>`) yield a
    /// lexicon in many languages, built in well under a second. Nothing is launched.
    func testAnInstalledBrowsersPacksIfNamed() throws {
        guard let path = ProcessInfo.processInfo.environment["WINTER_CU_LEXICON_APP"] else { throw XCTSkip("WINTER_CU_LEXICON_APP not set") }
        CURemoteDebuggingLexiconStore.reset()
        let start = Date()
        let l = try XCTUnwrap(CURemoteDebuggingLexiconStore.lexicon(appBundle: URL(fileURLWithPath: path)))
        let ms = Date().timeIntervalSince(start) * 1000
        print("lexicon: \(l.languages) languages, \(l.phrases.count) phrases, \(Int(ms)) ms")
        XCTAssertGreaterThan(l.languages, 10)
        XCTAssertTrue(l.matches("Allow remote debugging?"))
        XCTAssertLessThan(ms, 2000)
        CURemoteDebuggingLexiconStore.reset()
    }

    // MARK: - The floor, on a localized fixture tree

    let pid: pid_t = 6262
    let window = fakeElement(98_001)
    let toolbarButton = fakeElement(98_002)
    let area = fakeElement(98_003)
    let dialog = fakeElement(98_005)
    let dialogTitle = fakeElement(98_006)
    let dialogBody = fakeElement(98_007)
    let allowButton = fakeElement(98_008)
    let denyButton = fakeElement(98_009)
    let slowWindow = fakeElement(98_010)

    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!

    /// A browser window on an ordinary page, and — when `dialogTexts` is given — a dialog window (no page) with those
    /// texts and two buttons: the remote-debugging dialog's shape, in any language.
    private func world(words: CURemoteDebuggingWords, dialogTexts: (title: String, body: String, buttons: [String])? = nil,
                       sheet: Bool = false) {
        ax = FakeAX()
        var windows = [window]
        if dialogTexts != nil, !sheet { windows.insert(dialog, at: 0) }
        ax.put(ax.application(pid), [kAXWindowsAttribute: windows])
        var windowKids = [toolbarButton, area]
        if dialogTexts != nil, sheet { windowKids.append(dialog) }
        ax.add(window, role: kAXWindowRole, subrole: kAXStandardWindowSubrole, title: "Example",
               frame: CGRect(x: 0, y: 0, width: 800, height: 600), extra: [kAXChildrenAttribute: windowKids])
        ax.windowIDs[AXIdentity(element: window)] = 78
        ax.add(toolbarButton, role: kAXButtonRole, title: "Back", frame: CGRect(x: 10, y: 10, width: 30, height: 30),
               extra: [kAXParentAttribute: window])
        ax.setActions(toolbarButton, [kAXPressAction])
        ax.add(area, role: "AXWebArea", frame: CGRect(x: 0, y: 60, width: 800, height: 540),
               extra: [kAXParentAttribute: window, "AXURL": "https://example.com/"])
        if let d = dialogTexts {
            ax.add(dialog, role: sheet ? kAXSheetRole : kAXWindowRole, subrole: sheet ? nil : kAXDialogSubrole,
                   frame: CGRect(x: 200, y: 200, width: 400, height: 200),
                   extra: [kAXChildrenAttribute: [dialogTitle, dialogBody, allowButton, denyButton]])
            ax.add(dialogTitle, role: kAXStaticTextRole, extra: [kAXParentAttribute: dialog, kAXValueAttribute: d.title])
            ax.add(dialogBody, role: kAXStaticTextRole, extra: [kAXParentAttribute: dialog, kAXValueAttribute: d.body])
            ax.add(allowButton, role: kAXButtonRole, title: d.buttons[0], extra: [kAXParentAttribute: dialog])
            ax.add(denyButton, role: kAXButtonRole, title: d.buttons[1], extra: [kAXParentAttribute: dialog])
        }
        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.google.Chrome"
        sys.windows[78] = FakeSystem.window(78, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 600))
        sys.stack = [sys.windows[78]!]
        sys.front = 1
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: recordingSkyLight(), poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.remoteDebuggingWordsOverride = { _ in words }
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.google.Chrome", appName: "Google Chrome",
                          isChromium: true, mirror: false, windowID: 78, windowTitle: "Example")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func params(_ a: CUAction) -> TargetActParams {
        TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full, allowForeground: false, privatePath: true)
    }
    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func refusal(_ e: Error) -> CUError? {
        guard let e = e as? CUError, e.code == "refused", e.data?["reason"] == .string("remote_debugging") else { return nil }
        return e
    }
    private var pressBack: TargetActParams { params(.click(CUClickAction(ref: ref(toolbarButton)))) }

    static let frenchDialog = (title: french[100]!, body: french[101]!, buttons: ["Autoriser", "Refuser"])
    static let japaneseDialog = (title: japanese[100]!, body: "外部アプリがこのセッションを完全に制御しようとしています。", buttons: ["許可", "拒否"])
    static let frenchPasswordDialog = (title: french[104]!, body: "Votre mot de passe sera enregistré.", buttons: ["Enregistrer", "Jamais"])

    func testALocalizedRemoteDebuggingDialogIsRefusedInTheBrowsersOwnWords() async throws {
        for d in [Self.frenchDialog, Self.japaneseDialog] {
            world(words: .lexicon(Self.lexicon()), dialogTexts: d)
            do {
                _ = try await core.targetAct(pressBack)
                XCTFail("refused: \(d.title)")
            } catch {
                XCTAssertEqual(refusal(error)?.message, CUCore.remoteDebuggingSentence, "\(error)")
            }
            XCTAssertTrue(ax.performed.isEmpty, "nothing pressed")
            // Its own buttons too — "Autoriser" is never pressed by Winter.
            XCTAssertThrowsError(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(allowButton)))), target))
        }
        // As a sheet on the window, the same.
        world(words: .lexicon(Self.lexicon()), dialogTexts: Self.frenchDialog, sheet: true)
        XCTAssertThrowsError(try core.floorCheckRemoteDebugging(pressBack, target)) { XCTAssertNotNil(self.refusal($0)) }
    }

    func testAnotherLocalizedDialogOfTheSameShapeIsLeftAlone() {
        world(words: .lexicon(Self.lexicon()), dialogTexts: Self.frenchPasswordDialog)
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(pressBack, target))
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(allowButton)))), target))
    }

    func testTheEnglishRuleStaysOneInput() {
        let en = (title: "Allow remote debugging?", body: "An external app wants full control.", buttons: ["Allow", "Deny"])
        for words in [CURemoteDebuggingWords.lexicon(Self.lexicon()), .englishOnly, .unreadable] {
            world(words: words, dialogTexts: en)
            XCTAssertThrowsError(try core.floorCheckRemoteDebugging(pressBack, target)) {
                XCTAssertEqual(self.refusal($0)?.message, CUCore.remoteDebuggingSentence, "\(words)")
            }
        }
    }

    /// Fail closed: no words for the browser's language — any dialog of it is refused, said as such; with no dialog up,
    /// nothing is.
    func testWithNoWordsForTheBrowsersLanguageAnyDialogIsRefused() {
        world(words: .unreadable, dialogTexts: Self.frenchPasswordDialog)
        XCTAssertThrowsError(try core.floorCheckRemoteDebugging(pressBack, target)) {
            let e = self.refusal($0)
            XCTAssertEqual(e?.message, CUCore.remoteDebuggingUnreadableSentence("Google Chrome"))
            XCTAssertTrue(e?.message.contains("ask the user") == true)
        }
        world(words: .unreadable)
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(pressBack, target), "no dialog: nothing refused")
        // A browser that shows English and has no lexicon reads its dialogs with the English rule alone.
        world(words: .englishOnly, dialogTexts: Self.frenchPasswordDialog)
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(pressBack, target))
    }

    /// A slow page's window (its walk ran out of time) is no dialog for the fail-closed rule.
    func testASlowPageWindowIsNoDialogForTheFailClosedRule() {
        world(words: .unreadable)
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window, slowWindow]])
        ax.add(slowWindow, role: kAXWindowRole, subrole: kAXStandardWindowSubrole, title: "Une page lente",
               frame: CGRect(x: 900, y: 0, width: 400, height: 300), extra: [kAXChildrenAttribute: [fakeElement(98_011)]])
        ax.add(fakeElement(98_011), role: kAXGroupRole, extra: [kAXParentAttribute: slowWindow])
        // Its walk out of time: marked slow a moment ago, so it is not walked again now.
        if let id = ax.windowID(slowWindow) { target.remoteDebuggingSlowWalks[id] = core.clock.nowMs() }
        else {
            ax.windowIDs[AXIdentity(element: slowWindow)] = 79
            target.remoteDebuggingSlowWalks[79] = core.clock.nowMs()
        }
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(pressBack, target))
    }

    /// The scan's answer is kept per set of windows, the fail-closed kind with it.
    func testTheCachedAnswerKeepsItsKind() {
        world(words: .unreadable, dialogTexts: Self.frenchPasswordDialog)
        sys.windows[80] = FakeSystem.window(80, pid: pid, CGRect(x: 200, y: 200, width: 400, height: 200))
        for _ in 0..<2 {
            XCTAssertThrowsError(try core.floorCheckRemoteDebugging(pressBack, target)) {
                XCTAssertEqual(self.refusal($0)?.message, CUCore.remoteDebuggingUnreadableSentence("Google Chrome"))
            }
        }
        XCTAssertEqual(target.remoteDebuggingScan?.unreadable, true)
    }
}
