import AppKit
import Combine
import Metal
import WinterKit

/// ComputerV2 Phase 4 (lane H3) — **one headless tab shown in Winter's panel**: the viewer half of a presentation
/// (`WinterPresentConsumer`, the Mach channel to Winter Headless), the GPU side that draws it
/// (`HeadlessPresentRenderer`), and the facts the panel's chrome reads (welcomed yet, who has control, the page's
/// cursor, a dialog or file chooser waiting for the person).
///
/// Owned by the app-wide `HeadlessPresentStore`, never by a view: a session hop that dismantles the panel's view
/// leaves it running (and `headless.hide` reaches it with no window open). The view is a viewport that attaches
/// itself while it is on screen.
///
/// Threads: this object is main-actor. The consumer's delegate calls arrive on the presentation's own serial queue
/// (`queue`) — frames stay there, for the renderer; everything else hops to the main thread here. Every consumer
/// call that touches its ports is made on that queue too, except the ones it documents as "any thread": slot
/// releases and replies, and the person's input, IME and edits — those go out in order on their own serial queue
/// (`inputQueue`), so a send that waits for room in the helper's queue never holds the main thread or the frames.
@MainActor
final class HeadlessPresentation: ObservableObject, Identifiable {
    typealias Phase = HeadlessPresentChromeState.Phase

    nonisolated let id = UUID()
    let sessionId: String
    let tabId: String
    let uploadDir: String
    @Published private(set) var purpose: BrowserLinkHeadlessPurpose
    @Published private(set) var url: String
    @Published private(set) var title: String
    @Published private(set) var phase: Phase = .connecting
    /// The person holds control (input, IME, edits, dialogs, file choosers) — from the welcome and every CONTROL.
    @Published private(set) var control: Bool
    /// The page's size in CSS pixels (the welcome's).
    @Published private(set) var cssSize = CGSize(width: 1280, height: 800)
    /// An action of the person's on its way to the daemon.
    @Published private(set) var pending: BrowserLinkHeadlessAction?
    /// A sentence for the person (an action failed, a file chooser could not be answered) — cleared after a while.
    @Published private(set) var notice: String?
    @Published private(set) var cursor: HeadlessCursorKind = .arrow

    /// Where the composition's characters are drawn (CSS pixels), for the input method's candidate window.
    private(set) var imeRange = NSRange(location: NSNotFound, length: 0)
    private(set) var imeRects: [CGRect] = []

    let queue: DispatchQueue
    /// The person's input, IME and edits, in the order they made them.
    private let inputQueue: DispatchQueue
    let renderer: HeadlessPresentRenderer
    private let consumer: WinterPresentConsumer
    private let bridge: HeadlessPresentBridge
    private let uploadsRoot: String?

    /// The view showing it now (it presents dialogs and choosers on its window).
    weak var view: HeadlessPresentView? {
        didSet { if view != nil { presentNextPrompt() } }
    }
    /// The store's hook: the presentation ended by itself.
    var onEnded: ((HeadlessPresentation) -> Void)?

    // The render scale.
    private var sentScale: Double = 1
    private var wantedScale: Double?
    private var scaleWork: DispatchWorkItem?
    static let scaleDebounce: TimeInterval = 0.25

    // Dialogs and file choosers wait here until a view on a window can show them, one at a time.
    private enum Prompt {
        case dialog(WinterPresentDialog)
        case files(WinterPresentFileChooser)
    }
    private var prompts: [Prompt] = []
    private var activeDialog: (id: UInt32, alert: NSAlert, window: NSWindow)?
    private var activeChooser: (id: UInt32, panel: NSOpenPanel)?
    private var noticeWork: DispatchWorkItem?
    private(set) var closed = false

    init(show: BrowserLinkHeadlessCommand.Show, device: MTLDevice, uploadsRoot: String?) {
        sessionId = show.sessionId
        tabId = show.tabId
        uploadDir = show.uploadDir
        purpose = show.purpose
        url = show.url
        title = show.title
        control = show.control
        self.uploadsRoot = uploadsRoot
        queue = DispatchQueue(label: "com.winter.headless.present", qos: .userInteractive)
        inputQueue = DispatchQueue(label: "com.winter.headless.present.input", qos: .userInteractive)
        renderer = HeadlessPresentRenderer(queue: queue, device: device)
        bridge = HeadlessPresentBridge(renderer: renderer)
        consumer = WinterPresentConsumer(service: show.service, nonce: show.nonce, producerRequirement: show.producerRequirement,
                                         device: device, queue: queue, delegate: bridge)
        renderer.consumer = consumer
        bridge.presentation = self
    }

    /// Look the service up and say HELLO. nil on success, else why not.
    func connect() -> String? {
        let consumer = ConsumerRef(consumer)
        return queue.sync { () -> String? in
            var error: NSString?
            if consumer.consumer.connectWithError(&error) { return nil }
            return (error as String?) ?? "the presentation could not be reached"
        }
    }

    /// Stop presenting (BYE) and let everything go. Safe twice.
    func close() {
        guard !closed else { return }
        closed = true
        teardownPrompts()
        scaleWork?.cancel()
        renderer.reset()
        let consumer = ConsumerRef(consumer)
        queue.async { consumer.consumer.close() }
    }

    // MARK: - From the consumer (main thread)

    fileprivate func welcomed(cssWidth: Int32, cssHeight: Int32, scale: Double, control: Bool) {
        guard !closed else { return }
        if cssWidth > 0, cssHeight > 0 { cssSize = CGSize(width: Int(cssWidth), height: Int(cssHeight)) }
        sentScale = scale
        self.control = control
        phase = .live
        if let wanted = wantedScale { scheduleScale(wanted) }
        view?.presentationChanged()
    }

    fileprivate func controlChanged(_ control: Bool) {
        guard !closed, self.control != control else { return }
        self.control = control
        if !control { teardownPrompts() }
        view?.presentationChanged()
    }

    /// The producer named the shown page (after the welcome, and on every change of address or title).
    fileprivate func pageChanged(url: String, title: String) {
        guard !closed, url != self.url || title != self.title else { return }
        if !url.isEmpty { self.url = url }
        self.title = title
        view?.presentationChanged()
    }

    /// The daemon says why it is shown now (`headless.update`): a watch the person took over became the agent's
    /// hand-off, or a hand-off the agent stopped waiting on stays the person's.
    func purposeChanged(_ purpose: BrowserLinkHeadlessPurpose) {
        guard !closed, purpose != self.purpose else { return }
        self.purpose = purpose
        view?.presentationChanged()
    }

    fileprivate func cursorChanged(_ type: Int32) {
        let kind = HeadlessCursorKind.from(cefType: type)
        guard kind != cursor else { return }
        cursor = kind
        view?.cursorChanged()
    }

    fileprivate func ended(_ reason: String) {
        guard !closed else { return }
        closed = true
        teardownPrompts()
        scaleWork?.cancel()
        renderer.reset()
        phase = .ended(reason)
        view?.presentationChanged()
        onEnded?(self)
    }

    fileprivate func imeBounds(range: NSRange, rects: [CGRect]) {
        imeRange = range
        imeRects = rects
    }

    fileprivate func dialog(_ dialog: WinterPresentDialog) {
        guard !closed else { return }
        prompts.append(.dialog(dialog))
        presentNextPrompt()
    }

    fileprivate func dialogDone(_ dialogId: UInt32) {
        prompts.removeAll { if case .dialog(let d) = $0 { return d.dialogId == dialogId }; return false }
        if let active = activeDialog, active.id == dialogId {
            activeDialog = nil
            // Closed without an answer: the dialog went away by another route.
            active.window.endSheet(active.alert.window, returnCode: .abort)
        }
    }

    fileprivate func fileChooser(_ chooser: WinterPresentFileChooser) {
        guard !closed else { return }
        if chooser.mode == UInt32(WinterPresentFileOpenFolder) || chooser.mode == UInt32(WinterPresentFileSave) {
            // Only files can be handed to the page: a folder pick or a save is answered as cancelled.
            consumer.reply(toFileChooser: chooser.requestId, paths: nil)
            showNotice(chooser.mode == UInt32(WinterPresentFileSave)
                       ? "The page asked to save a file — Winter's headless browser can't save files"
                       : "The page asked for a folder — Winter can hand it files only")
            return
        }
        prompts.append(.files(chooser))
        presentNextPrompt()
    }

    // MARK: - The person's input (only while they hold control; the producer drops it otherwise)

    var acceptsInput: Bool { phase == .live && control && !closed }

    /// One input event (the consumer fills its header and sequence).
    func send(_ input: WinterPresentInputMsg) {
        guard acceptsInput else { return }
        let consumer = ConsumerRef(consumer)
        inputQueue.async { consumer.consumer.sendInput(input) }
    }

    func setComposition(_ text: String, selection: NSRange, replacement: NSRange) {
        guard acceptsInput else { return }
        let consumer = ConsumerRef(consumer)
        inputQueue.async { consumer.consumer.setComposition(text, selection: selection, replacement: replacement) }
    }

    func commitText(_ text: String, replacement: NSRange) {
        guard acceptsInput, !text.isEmpty else { return }
        let consumer = ConsumerRef(consumer)
        inputQueue.async { consumer.consumer.commitText(text, replacement: replacement) }
    }

    func finishComposing() {
        guard acceptsInput else { return }
        let consumer = ConsumerRef(consumer)
        inputQueue.async { consumer.consumer.finishComposing() }
    }

    func cancelComposition() {
        guard acceptsInput else { return }
        let consumer = ConsumerRef(consumer)
        inputQueue.async { consumer.consumer.cancelComposition() }
    }

    /// The longest paste carried to the page, in UTF-16 units (64 of the wire's pieces). Longer text is refused
    /// whole, with a notice — never cut.
    static let pasteMaxUnits = 64 * Int(WinterPresentTextMax)

    /// An edit command the person chose (`WinterPresentEditCopy` …); a paste carries the text Winter read from the
    /// pasteboard on their ⌘V — the helper never reads the pasteboard.
    func edit(_ command: UInt32, text: String? = nil) {
        guard acceptsInput else { return }
        if command == UInt32(WinterPresentEditPaste), let text, text.utf16.count > Self.pasteMaxUnits {
            showNotice("That's too much text to paste into the page at once (more than \(Self.pasteMaxUnits / 1024)K characters)")
            return
        }
        let consumer = ConsumerRef(consumer)
        inputQueue.async { [weak self] in
            guard !consumer.consumer.sendEdit(command, text: text), command == UInt32(WinterPresentEditPaste) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, !self.closed else { return }
                    self.showNotice("The paste didn't reach the page in full — Winter's headless browser was busy. Try again.")
                }
            }
        }
    }

    /// The view wants pixels at `scale` (device pixels per CSS pixel): asked of the producer after the welcome, only
    /// when it changed, and only once a live resize has settled.
    func viewWants(scale: Double) {
        wantedScale = scale
        guard phase == .live else { return }
        scheduleScale(scale)
    }

    private func scheduleScale(_ scale: Double) {
        scaleWork?.cancel()
        guard scale != sentScale, !closed else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.closed, self.phase == .live, scale != self.sentScale else { return }
            self.sentScale = scale
            let consumer = ConsumerRef(self.consumer)
            self.queue.async { consumer.consumer.setScale(scale) }
        }
        scaleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.scaleDebounce, execute: work)
    }

    // MARK: - The person's actions (set by the store)

    func markPending(_ action: BrowserLinkHeadlessAction?) { pending = action }

    func showNotice(_ text: String, for seconds: TimeInterval = 6) {
        notice = text
        noticeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.notice = nil }
        noticeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    // MARK: - Dialogs and file choosers

    private func presentNextPrompt() {
        guard activeDialog == nil, activeChooser == nil, !closed, !prompts.isEmpty,
              let window = view?.window else { return }
        switch prompts.removeFirst() {
        case .dialog(let dialog):
            presentDialog(dialog, on: window)
        case .files(let chooser):
            presentChooser(chooser, on: window)
        }
    }

    private func presentDialog(_ dialog: WinterPresentDialog, on window: NSWindow) {
        // Named after the page that raised it (its origin, as the helper read it then) — never the address the tab
        // was first shown at, and never a guess: an opaque origin is just "this page".
        let author = HeadlessPresentChromeState.dialogAuthor(origin: dialog.origin)
        let says = author.map { "\($0) says" } ?? "This page says"
        let alert = NSAlert()
        var field: NSTextField?
        switch dialog.type {
        case UInt32(WinterPresentDialogBeforeUnload):
            alert.messageText = "Leave this page?"
            alert.informativeText = author.map { "Changes you made on \($0) may not be saved." } ?? "Changes you made may not be saved."
            alert.addButton(withTitle: "Leave")
            alert.addButton(withTitle: "Stay")
        case UInt32(WinterPresentDialogConfirm):
            alert.messageText = says
            alert.informativeText = dialog.message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
        case UInt32(WinterPresentDialogPrompt):
            alert.messageText = says
            alert.informativeText = dialog.message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            let input = NSTextField(string: dialog.defaultText)
            input.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
            alert.accessoryView = input
            alert.window.initialFirstResponder = input
            field = input
        default:
            alert.messageText = says
            alert.informativeText = dialog.message
            alert.addButton(withTitle: "OK")
        }
        let consumer = self.consumer
        let dialogId = dialog.dialogId
        activeDialog = (dialogId, alert, window)
        alert.beginSheetModal(for: window) { [weak self] response in
            MainActor.assumeIsolated {
                guard let self else { return }
                let wasActive = self.activeDialog?.id == dialogId
                if wasActive { self.activeDialog = nil }
                // `.abort`: closed without an answer (the dialog went away, the presentation ended).
                if response != .abort, wasActive, !self.closed {
                    let accept = response == .alertFirstButtonReturn
                    consumer.reply(toDialog: dialogId, accept: accept, text: accept ? field?.stringValue : nil)
                }
                self.presentNextPrompt()
            }
        }
    }

    private func presentChooser(_ chooser: WinterPresentFileChooser, on window: NSWindow) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = chooser.mode == UInt32(WinterPresentFileOpenMultiple)
        panel.resolvesAliases = true
        panel.message = "Choose files for \(HeadlessPresentChromeState.host(of: url) ?? "the page") — Winter hands the page a copy"
        let types = HeadlessPresentUploads.contentTypes(accept: chooser.accept)
        if !types.isEmpty { panel.allowedContentTypes = types }
        let requestId = chooser.requestId
        activeChooser = (requestId, panel)
        panel.beginSheetModal(for: window) { [weak self] response in
            MainActor.assumeIsolated {
                guard let self else { return }
                let wasActive = self.activeChooser?.id == requestId
                if wasActive { self.activeChooser = nil }
                guard wasActive, !self.closed else { self.presentNextPrompt(); return }
                if response == .OK, !panel.urls.isEmpty {
                    self.copyAndReply(requestId: requestId, urls: panel.urls)
                } else {
                    self.consumer.reply(toFileChooser: requestId, paths: nil)
                }
                self.presentNextPrompt()
            }
        }
    }

    /// The chosen files copied where the helper may read them (off the main thread), then the copies' paths.
    private func copyAndReply(requestId: UInt32, urls: [URL]) {
        let consumer = ConsumerRef(self.consumer)
        guard let root = uploadsRoot else {
            consumer.consumer.reply(toFileChooser: requestId, paths: nil)
            showNotice(HeadlessPresentUploads.Failure.notTheUploadsFolder.message)
            return
        }
        let uploadDir = self.uploadDir
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = HeadlessPresentUploads.copy(urls, into: uploadDir, root: root)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    switch result {
                    case .success(let paths):
                        consumer.consumer.reply(toFileChooser: requestId, paths: paths)
                    case .failure(let failure):
                        consumer.consumer.reply(toFileChooser: requestId, paths: nil)
                        self?.showNotice(failure.message)
                    }
                }
            }
        }
    }

    /// Everything waiting for the person goes away unanswered (control went back, the presentation ended): a sheet
    /// on screen is closed without a reply — the producer withdraws its own dialog then.
    private func teardownPrompts() {
        prompts.removeAll()
        if let active = activeDialog {
            activeDialog = nil
            active.window.endSheet(active.alert.window, returnCode: .abort)
        }
        if let active = activeChooser {
            activeChooser = nil
            active.panel.cancel(nil)
        }
    }
}

/// The consumer handed to another queue. Every call made through it is one the consumer allows from any thread, or
/// is made on the presentation's own queue.
private struct ConsumerRef: @unchecked Sendable {
    let consumer: WinterPresentConsumer
    init(_ consumer: WinterPresentConsumer) { self.consumer = consumer }
}

/// The consumer's delegate. Not main-actor: the consumer calls it on the presentation's queue. Frames go straight to
/// the renderer there; everything else is handed to the main thread.
final class HeadlessPresentBridge: NSObject, WinterPresentConsumerDelegate, @unchecked Sendable {
    let renderer: HeadlessPresentRenderer
    /// Set once, on the main thread, before the consumer connects.
    weak var presentation: HeadlessPresentation?

    init(renderer: HeadlessPresentRenderer) {
        self.renderer = renderer
    }

    private func onMain(_ work: @escaping @MainActor (HeadlessPresentation) -> Void) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let presentation = self?.presentation else { return }
                work(presentation)
            }
        }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, welcomedCSSWidth width: Int32, height: Int32, scale: Double, control: Bool) {
        onMain { $0.welcomed(cssWidth: width, cssHeight: height, scale: scale, control: control) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, frame: WinterPresentFrame) {
        renderer.frame(frame)
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, pageURL url: String, title: String) {
        onMain { $0.pageChanged(url: url, title: title) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, cursor cursorType: Int32) {
        onMain { $0.cursorChanged(cursorType) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, endedWithReason reason: String) {
        onMain { $0.ended(reason) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, control: Bool) {
        onMain { $0.controlChanged(control) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, imeRange range: NSRange, characterBounds rects: [NSValue]) {
        let cgRects = rects.map { $0.rectValue }
        onMain { $0.imeBounds(range: range, rects: cgRects) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, dialog: WinterPresentDialog) {
        onMain { $0.dialog(dialog) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, dialogDone dialogId: UInt32) {
        onMain { $0.dialogDone(dialogId) }
    }

    func presentConsumer(_ consumer: WinterPresentConsumer, fileChooser chooser: WinterPresentFileChooser) {
        onMain { $0.fileChooser(chooser) }
    }
}
