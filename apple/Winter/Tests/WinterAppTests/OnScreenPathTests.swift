import AppKit
import XCTest
@testable import Winter

/// On-screen paths, the pure half: extraction from a window's text, existence (and the /Volumes guard)
/// (an injected filesystem probe that must never be asked about them), and the argument ghost's ranking.
final class OnScreenPathTests: XCTestCase {
    private let home = "/Users/u"

    // MARK: Extraction

    func testQuotesBracketsAndTrailingPunctuationAreTrimmedButAnExtensionIsKept() {
        let text = """
        Saved to /tmp/out.pdf. See "/tmp/My File.txt" and '/tmp/b.md', (/tmp/c.txt), `/tmp/d.json`;
        error: /tmp/src/main.swift:12:5: expected ';' — also [/tmp/e.log]!
        """
        let paths = onScreenPathCandidates(in: text, home: home)
        XCTAssertEqual(Set(paths), ["/tmp/out.pdf", "/tmp/My File.txt", "/tmp/b.md", "/tmp/c.txt", "/tmp/d.json",
                                    "/tmp/src/main.swift", "/tmp/e.log"])
    }

    func testFileURLsAreDecodedAndTildePathsKept() {
        let paths = onScreenPathCandidates(in: "file:///Users/u/My%20Doc.pdf file://localhost/tmp/x.txt ~/proj/README.md",
                                           home: home)
        XCTAssertEqual(paths, ["~/proj/README.md", "/tmp/x.txt", "/Users/u/My Doc.pdf"])
    }

    func testWhatIsNotAPath() {
        let text = "https://example.com/a/b and/or 10/15 / // s/foo/bar/ path:/x ~user/x /.. ///"
        XCTAssertEqual(onScreenPathCandidates(in: text, home: home), [])
    }

    func testAnEscapedSpaceStaysInThePath() {
        XCTAssertEqual(onScreenPathCandidates(in: #"ls /tmp/My\ Docs/a.txt"#, home: home), ["/tmp/My Docs/a.txt"])
    }

    func testWrappedLinesAreJoinedWhereObvious() {
        // Cut right after a slash.
        XCTAssertEqual(onScreenPathCandidates(in: "cat /Users/u/Projects/\nwinter/notes.md", home: home),
                       ["/Users/u/Projects/winter/notes.md"])
        // A line filled to the wrap width (the text's longest), going on without a space.
        let full = "open /Users/u/Documents/quarterly-rep"
        let padded = String(repeating: "x", count: 50 - full.count) + " " + full
        let text = "short line\n" + String(padded.suffix(50)) + "\nort-final.pdf done\nanother"
        XCTAssertTrue(onScreenPathCandidates(in: text, home: home).contains("/Users/u/Documents/quarterly-report-final.pdf"))
        // Not obvious: a short line's path stays as it is.
        XCTAssertEqual(onScreenPathCandidates(in: "see /tmp/a\nb.txt", home: home), ["/tmp/a"])
        // A next line that starts a path of its own is not glued on.
        XCTAssertEqual(onScreenPathCandidates(in: "cd /tmp/\n/usr/bin", home: home), ["/usr/bin", "/tmp/"])
    }

    func testMostRecentFirstDeduplicatedAndCapped() {
        XCTAssertEqual(onScreenPathCandidates(in: "a /tmp/1 b /tmp/2\n/tmp/3 /tmp/1", home: home),
                       ["/tmp/1", "/tmp/3", "/tmp/2"], "later is more recent; a repeat counts at its latest")
        XCTAssertEqual(onScreenPathCandidates(in: "/Users/u/x.txt then ~/x.txt and /Users/u/./x.txt/", home: home),
                       ["/Users/u/./x.txt/"], "one file, its most recent spelling")
        let many = (0..<45).map { "/tmp/f\($0).txt" }.joined(separator: " ")
        let capped = onScreenPathCandidates(in: many, home: home)
        XCTAssertEqual(capped.count, onScreenPathLimit)
        XCTAssertEqual(capped.first, "/tmp/f44.txt")
        XCTAssertEqual(capped.last, "/tmp/f15.txt")
    }

    // MARK: Existence, and slow volumes

    /// A filesystem that records every path it is asked about, and can be slow.
    final class RecordingFileSystem: ShellFileSystem, @unchecked Sendable {
        let inner: ShellFileSystem
        var delay: TimeInterval = 0
        private let lock = NSLock()
        private var _asked: [String] = []
        var asked: [String] { lock.lock(); defer { lock.unlock() }; return _asked }
        init(_ inner: ShellFileSystem) { self.inner = inner }
        private func note(_ path: String) {
            lock.lock(); _asked.append(path); lock.unlock()
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
        }
        func exists(_ path: String) -> Bool { note(path); return inner.exists(path) }
        func isDirectory(_ path: String) -> Bool { note(path); return inner.isDirectory(path) }
        func isExecutableFile(_ path: String) -> Bool { note(path); return inner.isExecutableFile(path) }
        func entries(ofDirectory path: String) -> [String]? { note(path); return inner.entries(ofDirectory: path) }
    }

    func testOnScreenPathsAreCheckedLikeAnyOtherPathDocumentsIncluded() {
        var nodes = ShellCommandLineTests.fileSystem.nodes
        nodes["/Users/u/Documents"] = .directory
        nodes["/Users/u/Documents/plan.key"] = .file
        let probe = RecordingFileSystem(ShellCommandLineTests.FakeShellFileSystem(nodes: nodes))
        let kept = onScreenPathsThatExist(["~/Documents/plan.key", "/tmp/x/notes.md", "/tmp/gone.txt", "~/Desktop/gone.png"],
                                          home: home, fileSystem: probe)
        XCTAssertEqual(kept, ["~/Documents/plan.key", "/tmp/x/notes.md"])
        XCTAssertEqual(probe.asked, ["/Users/u/Documents/plan.key", "/tmp/x/notes.md", "/tmp/gone.txt", "/Users/u/Desktop/gone.png"],
                       "every path is checked (macOS may ask once for Documents and the like)")
    }

    func testAVolumeIsAskedOnceThenFromMemoryAndASlowOneIsLeftAlone() {
        var nodes = ShellCommandLineTests.fileSystem.nodes
        nodes["/Volumes"] = .directory
        nodes["/Volumes/USB"] = .directory
        nodes["/Volumes/USB/a.mov"] = .file
        let probe = RecordingFileSystem(ShellCommandLineTests.FakeShellFileSystem(nodes: nodes))
        var clock = Date(timeIntervalSince1970: 0)
        let guarded = VolumeGuardedFileSystem(inner: probe, timeout: 0.2, now: { clock })
        XCTAssertTrue(guarded.exists("/Volumes/USB/a.mov"))
        XCTAssertTrue(guarded.exists("/Volumes/USB/a.mov"))
        XCTAssertEqual(probe.asked, ["/Volumes/USB/a.mov"], "the second answer comes from memory")
        XCTAssertTrue(guarded.exists("/tmp/x/notes.md"))
        XCTAssertTrue(guarded.exists("/tmp/x/notes.md"))
        XCTAssertEqual(probe.asked.filter { $0 == "/tmp/x/notes.md" }.count, 2, "outside /Volumes: asked directly")
        clock.addTimeInterval(VolumeGuardedFileSystem.memoLifetime + 1)
        // A volume that takes too long: "no" within the timeout, and left alone for a while.
        probe.delay = 1
        let started = Date()
        XCTAssertFalse(guarded.exists("/Volumes/USB/a.mov"))
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.8, "never waits on it")
        let askedSoFar = probe.asked.count
        XCTAssertFalse(guarded.isDirectory("/Volumes/USB"))
        XCTAssertNil(guarded.entries(ofDirectory: "/Volumes/USB/"))
        XCTAssertEqual(probe.asked.count, askedSoFar, "a slow volume is not asked again for a while")
        XCTAssertEqual(VolumeGuardedFileSystem.volume(of: "/Volumes/USB/x/y"), "/Volumes/USB")
        XCTAssertNil(VolumeGuardedFileSystem.volume(of: "/tmp/Volumes/x"))
    }

    func testTheValidatorAndZshWorkInDocumentsLikeAnywhereElse() {
        var nodes = ShellCommandLineTests.fileSystem.nodes
        nodes["/Users/u/Documents"] = .directory
        nodes["/Users/u/Documents/report.pdf"] = .file
        let context = ShellCommandContext(pathDirectories: ["/usr/bin", "/bin"], homeDirectory: home,
                                          workingDirectory: "/Users/u/Documents",
                                          fileSystem: ShellCommandLineTests.FakeShellFileSystem(nodes: nodes))
        XCTAssertTrue(shellLineIsCommand("open ~/Documents/report.pdf", context: context))
        XCTAssertFalse(shellLineIsCommand("open ~/Documents/missing.pdf", context: context), "checked, not taken by name")
        let zsh = ZshCompletionTests.FakeCompletionSource(captures: ["touch grass": ZshCompletionCapture(hits: [], kinds: [])],
                                                          functions: ["touch": true])
        XCTAssertFalse(shellCompletionCheckPasses("touch grass", context: context, source: zsh, deadline: .distantFuture),
                       "zsh is asked in a Documents project too: `touch grass` stays a message")
        XCTAssertEqual(zsh.asked, ["touch grass"])
    }

    // MARK: The ghost

    private func context(_ fileSystem: ShellFileSystem = ShellCommandLineTests.fileSystem) -> ShellCommandContext {
        ShellCommandContext(pathDirectories: ["/usr/bin", "/bin"], homeDirectory: home, workingDirectory: "/Users/u/proj",
                            fileSystem: fileSystem)
    }

    private let onScreen = ["/tmp/x/notes.md", "~/Desktop/shot one.png", "/tmp/x/a.log"]

    func testAnEmptyArgumentOffersTheMostRecentOnScreenPath() {
        let ghost = shellGhost(for: "open ", context: context(), commandNames: ["open"], onScreenPaths: onScreen)
        XCTAssertEqual(ghost?.suffix, "/tmp/x/notes.md")
        XCTAssertEqual(ghost?.offer?.candidates, ["/tmp/x/notes.md", #"~/Desktop/shot\ one.png"#, "/tmp/x/a.log"],
                       "in recency order, escaped for the shell")
        XCTAssertNil(shellGhost(for: "open ", context: context(), commandNames: ["open"], onScreenPaths: []),
                     "nothing on screen: no ghost for an empty argument")
    }

    func testAPrefixOfAnOnScreenPathRanksAboveTheFilesystem() {
        let c = context()
        // The filesystem alone would complete `/tmp/x/` to its common prefix — nothing (several entries).
        XCTAssertNil(shellCompletion(for: "cat /tmp/x/", context: c, commandNames: ["cat"]))
        XCTAssertEqual(shellGhost(for: "cat /tmp/x/", context: c, commandNames: ["cat"], onScreenPaths: onScreen)?.suffix,
                       "notes.md")
        XCTAssertEqual(shellGhost(for: "cat /tmp/x/a", context: c, commandNames: ["cat"], onScreenPaths: onScreen)?.suffix,
                       ".log")
        // No on-screen match: the filesystem's ghost, with no offer.
        let fallback = shellGhost(for: "cat /tmp/x/b", context: c, commandNames: ["cat"], onScreenPaths: onScreen)
        XCTAssertEqual(fallback?.suffix, ".log")
        XCTAssertNil(fallback?.offer)
    }

    func testTildeAndHomeSpellingsMatchEitherWay() {
        let c = context()
        XCTAssertEqual(shellGhost(for: "open ~/Des", context: c, commandNames: ["open"],
                                  onScreenPaths: ["/Users/u/Desktop/a.png"])?.suffix, "ktop/a.png")
        XCTAssertEqual(shellGhost(for: "open /Users/u/De", context: c, commandNames: ["open"],
                                  onScreenPaths: ["~/Desktop/a.png"])?.suffix, "sktop/a.png")
    }

    func testOnlyWhereFilesGo() {
        let c = context()
        XCTAssertNil(shellGhost(for: "op", context: c, commandNames: ["open"], onScreenPaths: onScreen)?.offer,
                     "the command word itself")
        XCTAssertNil(shellGhost(for: "ls -", context: c, commandNames: ["ls"], onScreenPaths: onScreen), "a flag")
        XCTAssertNil(shellGhost(for: "git ", context: c, commandNames: ["git"], onScreenPaths: onScreen),
                     "not a file command, and no zsh to ask")
        XCTAssertNil(shellGhost(for: "please open ", context: c, commandNames: [], onScreenPaths: onScreen),
                     "a sentence whose first word is no command")
        // zsh says the position takes files.
        let zsh = ZshCompletionTests.FakeCompletionSource(
            captures: ["git add ": ZshCompletionCapture(hits: ["a.log"], kinds: [.files])], functions: [:])
        XCTAssertEqual(shellGhost(for: "git add ", context: c, commandNames: ["git"], onScreenPaths: onScreen,
                                  source: zsh)?.suffix, "/tmp/x/notes.md")
        // A redirection's target.
        XCTAssertEqual(shellGhost(for: "grep x < ", context: c, commandNames: ["grep"], onScreenPaths: onScreen)?.suffix,
                       "/tmp/x/notes.md")
    }

    func testCdOffersDirectoriesOnly() {
        let ghost = shellGhost(for: "cd ", context: context(), commandNames: ["cd"],
                               onScreenPaths: ["/tmp/x/notes.md", "/tmp/x/My Files", "~/Documents/proj"])
        XCTAssertEqual(ghost?.offer?.candidates, [#"/tmp/x/My\ Files"#], "a folder that is not there is not offered")
    }

    // MARK: Tab again

    func testTabAgainCyclesWhileTheTextIsUnchanged() {
        let offer = OnScreenPathOffer(head: "open ", typed: "", candidates: ["/a", "/b", "/c"])
        var cycle = OnScreenPathCycle(accepting: offer)
        XCTAssertEqual(cycle.acceptedText, "open /a")
        XCTAssertNil(cycle.next(for: "open /a2"), "the text changed: no cycling")
        XCTAssertEqual(cycle.next(for: "open /a"), ComposerTabEdit(replacingSuffix: "/a", insert: "/b"))
        XCTAssertEqual(cycle.next(for: "open /b"), ComposerTabEdit(replacingSuffix: "/b", insert: "/c"))
        XCTAssertEqual(cycle.next(for: "open /c"), ComposerTabEdit(replacingSuffix: "/c", insert: "/a"), "and round")
        var single = OnScreenPathCycle(accepting: OnScreenPathOffer(head: "ls ", typed: "/t", candidates: ["/tmp/x"]))
        XCTAssertEqual(single.next(for: "ls /tmp/x"), ComposerTabEdit(replacingSuffix: "", insert: ""), "consumed, no change")
    }
}

/// The ghost and Tab in the live command-mode model, and the composer applying Tab's edit.
@MainActor
final class OnScreenPathCommandModeTests: XCTestCase {
    private func makeMode(paths: [String]) -> DispatchPillCommandMode {
        let environment = CommandLineEnvironment.fixed(pathDirectories: ["/usr/bin", "/bin"],
                                                       commandNames: ["ls", "open", "cat"], homeDirectory: "/Users/u",
                                                       fileSystem: ShellCommandLineTests.fileSystem)
        let mode = DispatchPillCommandMode(environment: environment, workingDirectory: { "/Users/u/proj" })
        mode.onScreenPaths = { paths }
        return mode
    }

    func testTabAcceptsThenCyclesOnScreenPaths() {
        let mode = makeMode(paths: ["/tmp/x/notes.md", "/tmp/x/a.log"])
        mode.evaluateNowForTesting("open ")
        XCTAssertEqual(mode.ghost(for: "open "), "/tmp/x/notes.md")
        XCTAssertEqual(mode.tab(text: "open "), ComposerTabEdit(replacingSuffix: "", insert: "/tmp/x/notes.md"))
        // The draft changes to the accepted text; its own verdict lands.
        mode.draftChanged("open /tmp/x/notes.md")
        mode.evaluateNowForTesting("open /tmp/x/notes.md")
        XCTAssertTrue(mode.isActive(for: "open /tmp/x/notes.md"), "an existing path: a command")
        XCTAssertEqual(mode.tab(text: "open /tmp/x/notes.md"),
                       ComposerTabEdit(replacingSuffix: "/tmp/x/notes.md", insert: "/tmp/x/a.log"))
        mode.draftChanged("open /tmp/x/a.log")
        XCTAssertEqual(mode.tab(text: "open /tmp/x/a.log"),
                       ComposerTabEdit(replacingSuffix: "/tmp/x/a.log", insert: "/tmp/x/notes.md"))
        // Typing ends the cycle: Tab is the ghost's again (none here → AppKit's).
        mode.draftChanged("open /tmp/x/notes.md ")
        mode.evaluateNowForTesting("open /tmp/x/notes.md ")
        XCTAssertNotEqual(mode.tab(text: "open /tmp/x/notes.md")?.replacingSuffix, "/tmp/x/notes.md")
    }

    func testAnOnScreenPathStillHasToValidateToTurnPurple() {
        let mode = makeMode(paths: ["~/Desktop/shot.png"])
        mode.evaluateNowForTesting("open ")
        XCTAssertEqual(mode.ghost(for: "open "), "~/Desktop/shot.png")
        mode.evaluateNowForTesting("open ~/Desktop/shot.png")
        // The file is not there (a fake filesystem): it stays white — the on-screen offer never bypasses the validator.
        XCTAssertFalse(mode.isActive(for: "open ~/Desktop/shot.png"))
    }

    func testTheComposerAppliesTabsEdit() {
        let view = CommandTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
        view.string = "open /tmp/x/notes.md"
        view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0))
        var asked: [String] = []
        view.onTab = { text in
            asked.append(text)
            return ComposerTabEdit(replacingSuffix: "/tmp/x/notes.md", insert: "/tmp/x/a.log")
        }
        view.ghostSuffix = "ignored"
        view.doCommand(by: #selector(NSResponder.insertTab(_:)))
        XCTAssertEqual(asked, ["open /tmp/x/notes.md"])
        XCTAssertEqual(view.string, "open /tmp/x/a.log", "the accepted path replaced, the ghost not inserted")
        // An edit whose suffix is not there changes nothing; nil falls back to the ghost.
        view.onTab = { _ in ComposerTabEdit(replacingSuffix: "/nope", insert: "/x") }
        view.doCommand(by: #selector(NSResponder.insertTab(_:)))
        XCTAssertEqual(view.string, "open /tmp/x/a.log")
        view.onTab = { _ in nil }
        view.ghostSuffix = "!"
        view.doCommand(by: #selector(NSResponder.insertTab(_:)))
        XCTAssertEqual(view.string, "open /tmp/x/a.log!")
    }
}

/// The reader over an INJECTED accessibility tree (no real accessibility in tests), and the store over an
/// injected read.
@MainActor
final class OnScreenTextReaderTests: XCTestCase {
    final class FakeElement: OnScreenAXElement {
        let role: String?
        let subrole: String?
        var children: [FakeElement]
        let text: String?
        let titleText: String?
        let count: Int?
        private(set) var valueReads = 0
        private(set) var rangeAsked: NSRange?
        private(set) var childLimitAsked: Int?
        var onBasics: (() -> Void)?

        init(_ role: String?, subrole: String? = nil, value: String? = nil, title: String? = nil, count: Int? = nil,
             children: [FakeElement] = []) {
            self.role = role
            self.subrole = subrole
            self.text = value
            self.titleText = title
            self.count = count
            self.children = children
        }

        func roles() -> (role: String?, subrole: String?) {
            onBasics?()
            return (role, subrole)
        }
        func children(limit: Int) -> [OnScreenAXElement] {
            childLimitAsked = limit
            return children.prefix(limit).map { $0 as OnScreenAXElement }
        }
        func value() -> String? { valueReads += 1; return text }
        func title() -> String? { titleText }
        func characterCount() -> Int? { count }
        func string(in range: NSRange) -> String? {
            rangeAsked = range
            return "…tail with /tmp/tail.txt"
        }
    }

    struct FakeSource: OnScreenAXSource {
        let window: FakeElement?
        func focusedWindow() -> OnScreenAXElement? { window }
    }

    func testReadingOrderSecureFieldsAndTheTextAreaTail() {
        let secret = FakeElement("AXStaticText", value: "/tmp/inside-secure.txt")
        let secure = FakeElement("AXTextField", subrole: "AXSecureTextField", value: "/tmp/password", children: [secret])
        let secureRole = FakeElement("AXSecureTextField", value: "/tmp/password2")
        let area = FakeElement("AXTextArea", value: "never copied whole", count: 200_000)
        let window = FakeElement("AXWindow", children: [
            FakeElement("AXGroup", children: [FakeElement("AXStaticText", value: "first /tmp/1.txt", title: "t")]),
            secure, secureRole, area,
            FakeElement("AXTextField", value: "last /tmp/2.txt"),
            FakeElement("AXButton", value: "/tmp/not-text"),
        ])
        let text = OnScreenTextReader.read(from: FakeSource(window: window))
        XCTAssertEqual(text, "first /tmp/1.txt t\n…tail with /tmp/tail.txt\nlast /tmp/2.txt", "depth-first, in reading order")
        XCTAssertEqual(secure.valueReads, 0, "a secure field is never read")
        XCTAssertEqual(secureRole.valueReads, 0)
        XCTAssertEqual(secret.valueReads, 0, "nor anything inside one")
        XCTAssertEqual(area.rangeAsked, NSRange(location: 200_000 - 65_536, length: 65_536), "only the tail is asked for")
        XCTAssertEqual(area.valueReads, 0)
        XCTAssertEqual(onScreenPathCandidates(in: text ?? "", home: "/Users/u"), ["/tmp/2.txt", "/tmp/tail.txt", "/tmp/1.txt"])
        XCTAssertNil(OnScreenTextReader.read(from: FakeSource(window: nil)), "no window, nothing")
    }

    func testTheElementCapAndTheDeadline() {
        // A long chain: at most `maxElements` are visited.
        var visited = 0
        var node = FakeElement("AXStaticText", value: "/tmp/deep.txt")
        for _ in 0..<3000 {
            let parent = FakeElement("AXGroup", children: [node])
            parent.onBasics = { visited += 1 }
            node = parent
        }
        _ = OnScreenTextReader.read(from: FakeSource(window: node))
        XCTAssertEqual(visited, OnScreenReadBudget.standard.maxElements)

        // A clock that jumps 0.1 s per element: the 0.15 s budget stops the walk after a couple.
        var clock = Date(timeIntervalSince1970: 0)
        visited = 0
        let wide = FakeElement("AXWindow", children: (0..<50).map { i in
            let leaf = FakeElement("AXStaticText", value: "/tmp/\(i).txt")
            leaf.onBasics = { visited += 1; clock.addTimeInterval(0.1) }
            return leaf
        })
        _ = OnScreenTextReader.read(from: FakeSource(window: wide), now: { clock })
        XCTAssertLessThanOrEqual(visited, 2)
    }

    // MARK: The store

    private final class Box: @unchecked Sendable {
        var reads: [pid_t] = []
        var result: [String] = ["/tmp/a.txt"]
        let lock = NSLock()
    }

    private func waitForReads(_ box: Box, count: Int, store: OnScreenPathStore? = nil) {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            box.lock.lock(); let n = box.reads.count; box.lock.unlock()
            if n >= count, store?.capturedAt != nil || store == nil { return }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }

    func testTheStoreReadsWhileUpThrottledAndDropsEverythingWhenThePillGoes() {
        let box = Box()
        var now = Date(timeIntervalSince1970: 1000)
        var frontmost: pid_t? = 4242
        let store = OnScreenPathStore(frontmostProcess: { frontmost }, read: { pid in
            box.lock.lock(); defer { box.lock.unlock() }
            box.reads.append(pid)
            return box.result
        }, now: { now })
        var changes = 0
        store.onChange = { changes += 1 }

        store.refresh()
        XCTAssertTrue(box.reads.isEmpty, "not up: no read")
        store.activate()
        waitForReads(box, count: 1, store: store)
        XCTAssertEqual(box.reads, [4242])
        XCTAssertEqual(store.paths, ["/tmp/a.txt"])
        XCTAssertEqual(changes, 1)

        store.refresh()
        now.addTimeInterval(0.5)
        store.refresh()
        XCTAssertEqual(box.reads.count, 1, "at most once a second")
        now.addTimeInterval(1)
        store.refreshIfStale()
        XCTAssertEqual(box.reads.count, 1, "1.5 s old is not stale")
        now.addTimeInterval(1)
        store.refreshIfStale()
        waitForReads(box, count: 2)
        XCTAssertEqual(box.reads.count, 2, "older than 2 s: read again")

        // Winter itself in front: nothing is read, nothing offered.
        now.addTimeInterval(2)
        frontmost = getpid()
        store.refresh()
        XCTAssertEqual(box.reads.count, 2)
        XCTAssertEqual(store.paths, [])

        // The pill goes while a read is out: the read's result is dropped.
        frontmost = 4242
        now.addTimeInterval(2)
        box.result = ["/tmp/late.txt"]
        store.refresh()
        store.deactivate()
        waitForReads(box, count: 3)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(store.paths, [], "dropped on hide")
        XCTAssertNil(store.capturedAt)
    }

    func testLongTextIsAskedForAsARangeOrSkippedAndChildrenAreCapped() {
        let longStatic = FakeElement("AXStaticText", value: "never copied", count: 100_000)
        let huge = FakeElement("AXTextField", value: "never copied", count: 9_000_000)
        let many = FakeElement("AXGroup", children: (0..<300).map { FakeElement("AXStaticText", value: "/tmp/c\($0).txt") })
        let window = FakeElement("AXWindow", children: [longStatic, huge, many])
        let text = OnScreenTextReader.read(from: FakeSource(window: window)) ?? ""
        XCTAssertEqual(longStatic.valueReads, 0, "a long static text: only its tail, as a range")
        XCTAssertEqual(longStatic.rangeAsked, NSRange(location: 100_000 - 65_536, length: 65_536))
        XCTAssertEqual(huge.valueReads, 0, "past the cap: skipped")
        XCTAssertNil(huge.rangeAsked)
        XCTAssertEqual(many.childLimitAsked, OnScreenReadBudget.standard.maxChildren)
        XCTAssertTrue(text.contains("/tmp/c199.txt"))
        XCTAssertFalse(text.contains("/tmp/c200.txt"), "the first 200 children only")
    }

    func testChromiumFamilyAppsAreRecognized() {
        XCTAssertTrue(onScreenAppIsChromiumFamily(bundleId: "com.google.Chrome", frameworkNames: []))
        XCTAssertTrue(onScreenAppIsChromiumFamily(bundleId: "com.example.chat", frameworkNames: ["Electron Framework.framework"]))
        XCTAssertTrue(onScreenAppIsChromiumFamily(bundleId: nil, frameworkNames: ["Chromium Embedded Framework.framework"]))
        XCTAssertFalse(onScreenAppIsChromiumFamily(bundleId: "com.apple.Terminal", frameworkNames: ["Sparkle.framework"]))
    }
}
