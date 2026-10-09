import AppKit
import Foundation

// The app delegate: menus, the command channel, and the glue between the commands and the windows.

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private let fixture: Fixture
    private var form: FormController?
    private var web: WebController?
    private var canvas: CanvasController?
    private var offspace: OffspaceController?
    private var user: UserController?
    private var documents: [FixtureWindow] = []
    private var activity: NSObjectProtocol?
    private var launchedLogged = false
    private var fullscreenToken = 0
    private var fullscreenWait: (token: Int, expectEntered: Bool, done: (Bool) -> Void)?

    init(fixture: Fixture) {
        self.fixture = fixture
        super.init()
    }

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The rig drives this app while it is in the background; App Nap would delay the command handler and the
        // animation timer. Held for the process's life.
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical],
                                                         reason: "cu-live fixture is driven in the background")
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(appDidBecomeActive), name: NSApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(appDidResignActive), name: NSApplication.didResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(windowDidBecomeKey(_:)), name: NSWindow.didBecomeKeyNotification, object: nil)
        center.addObserver(self, selector: #selector(windowDidEnterFullScreen(_:)), name: NSWindow.didEnterFullScreenNotification, object: nil)
        center.addObserver(self, selector: #selector(windowDidExitFullScreen(_:)), name: NSWindow.didExitFullScreenNotification, object: nil)
        installMenus()

        if fixture.role == "main" {
            let form = FormController(slot: 0, openDocument: { [weak self] in self?.openSample(via: "button") })
            let web = WebController(slot: 1)
            let canvas = CanvasController(slot: 2)
            self.form = form
            self.web = web
            self.canvas = canvas
            // orderFront, never makeKeyAndOrderFront: the app must not become active, and no window.key at launch.
            for window in [form.window, web.window, canvas.window] { window.orderFront(nil) }
            // `open -j` launches hidden, and a hidden app's windows are not drawn: show them, without activating.
            NSApp.unhideWithoutActivation()
            registerCommandObserver()
            // "launched" means READY: windows exist, the page has loaded, commands are being heard.
            web.onLoaded = { [weak self] in self?.markLaunched() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                MainActor.assumeIsolated { self?.markLaunched() }
            }
            web.start()
        } else {
            let user = UserController()
            self.user = user
            NSApp.unhideWithoutActivation()
            registerCommandObserver()
            fixture.activate(reason: "user-launch")
            user.window.makeKeyAndOrderFront(nil)
            _ = user.window.makeFirstResponder(user.field)
            markLaunched()
        }
    }

    private func markLaunched() {
        guard !launchedLogged else { return }
        launchedLogged = true
        fixture.emit("launched", [("pid", .int(Int(getpid()))), ("role", .str(fixture.role))])
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Nothing here is document-based, so there is no "save changes" sheet to wait for.
        .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: LaunchServices document open

    func application(_ application: NSApplication, open urls: [URL]) {
        // Only the main fixture has document windows; the "user's app" ignores the file silently.
        guard fixture.role == "main" else { return }
        for url in urls where url.pathExtension == "wcufix" { openDocument(url, via: "launchservices") }
    }

    private func openSample(via: String) {
        if let url = sampleURL() { openDocument(url, via: via) }
    }

    private func sampleURL() -> URL? {
        if let url = Bundle.main.url(forResource: "sample", withExtension: "wcufix") { return url }
        // Running the bare binary (not from a bundle): look beside it.
        let beside = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("sample.wcufix")
        return FileManager.default.fileExists(atPath: beside.path) ? beside : nil
    }

    private func openDocument(_ url: URL, via: String) {
        fixture.emit("doc.open", [("path", .str(url.path)), ("via", .str(via))])
        let window = makeDocumentWindow(url: url, slot: 4 + documents.count)
        documents.append(window)
        window.orderFront(nil)
        // With stealing on, opening a document is itself a steal (and then the window may as well be key).
        fixture.fire(.documentOpen)
        if fixture.stealMode != .off { window.makeKeyAndOrderFront(nil) }
        fixture.emit("doc.window", [("title", .str(window.title))])
    }

    // MARK: Notifications

    @objc private func appDidBecomeActive() { fixture.emit("app.active", [("active", .bool(true))]) }
    @objc private func appDidResignActive() { fixture.emit("app.active", [("active", .bool(false))]) }

    @objc private func windowDidBecomeKey(_ note: Notification) {
        guard let window = note.object as? NSWindow else { return }
        fixture.emit("window.key", [("title", .str(window.title))])
    }

    @objc private func windowDidEnterFullScreen(_ note: Notification) { fullscreenChanged(note, entered: true) }
    @objc private func windowDidExitFullScreen(_ note: Notification) { fullscreenChanged(note, entered: false) }

    private func fullscreenChanged(_ note: Notification, entered: Bool) {
        guard let window = note.object as? NSWindow else { return }
        fixture.emit("fullscreen", [("window", .str(window.title)), ("entered", .bool(entered))])
        if let wait = fullscreenWait, wait.expectEntered == entered {
            fullscreenWait = nil
            wait.done(true)
        }
    }

    /// Waits for the next full-screen transition in the given direction; `done(false)` if none arrives in time.
    private func awaitFullscreen(entered: Bool, timeout: Double, done: @escaping (Bool) -> Void) {
        fullscreenToken += 1
        let token = fullscreenToken
        fullscreenWait = (token, entered, done)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let wait = self.fullscreenWait, wait.token == token else { return }
                self.fullscreenWait = nil
                wait.done(false)
            }
        }
    }

    // MARK: Menus

    private func installMenus() {
        let appName = (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? ProcessInfo.processInfo.processName
        let mainMenu = NSMenu(title: "Main")

        // App menu
        let appMenu = NSMenu(title: appName)
        appMenu.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        addTopLevel(appMenu, to: mainMenu)

        // Edit menu: first-responder selectors, so the same items serve native fields and the web view.
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        addTopLevel(editMenu, to: mainMenu)

        // Fixture menu (main role only): the app-specific commands the rig drives through the menu bar.
        if fixture.role == "main" {
            let fixtureMenu = NSMenu(title: "Fixture")
            for (title, action) in [("Uppercase Selection", #selector(uppercaseSelection(_:))),
                                    ("Insert Stamp", #selector(insertStamp(_:))),
                                    ("Log Ping", #selector(logPing(_:)))] {
                let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
                item.target = self
                fixtureMenu.addItem(item)
            }
            addTopLevel(fixtureMenu, to: mainMenu)
        }

        // Window menu
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        addTopLevel(windowMenu, to: mainMenu)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    private func addTopLevel(_ submenu: NSMenu, to menu: NSMenu) {
        let item = NSMenuItem(title: submenu.title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        menu.addItem(item)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(uppercaseSelection(_:)) {
            guard let notes = form?.notes else { return false }
            return MenuRules.uppercaseEnabled(selectionLength: notes.selectedRange().length)
        }
        return true
    }

    @objc private func uppercaseSelection(_ sender: NSMenuItem) {
        fixture.emit("menu", [("title", .str(sender.title))])
        guard let notes = form?.notes else { return }
        let range = notes.selectedRange()
        guard let result = MenuRules.uppercase(text: notes.string, range: range) else { return }
        replace(range, in: notes, with: result.replacement, selecting: result.selection)
    }

    @objc private func insertStamp(_ sender: NSMenuItem) {
        fixture.emit("menu", [("title", .str(sender.title))])
        guard let notes = form?.notes else { return }
        let range = notes.selectedRange()
        let caret = NSRange(location: range.location + (MenuRules.stamp as NSString).length, length: 0)
        replace(range, in: notes, with: MenuRules.stamp, selecting: caret)
    }

    @objc private func logPing(_ sender: NSMenuItem) {
        fixture.emit("menu", [("title", .str(sender.title))])
    }

    /// An edit the text system knows about (undo works, `field.change` fires), independent of whether the notes
    /// view is first responder.
    private func replace(_ range: NSRange, in view: NSTextView, with text: String, selecting selection: NSRange) {
        guard view.shouldChangeText(in: range, replacementString: text) else { return }
        view.replaceCharacters(in: range, with: text)
        view.setSelectedRange(selection)
        view.didChangeText()
    }

    // MARK: Commands

    private func registerCommandObserver() {
        // object: nil — the run id is compared in CommandDecoder, not by the notification center.
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(commandReceived(_:)),
                                                            name: Notification.Name(CommandDecoder.notificationName),
                                                            object: nil, suspensionBehavior: .deliverImmediately)
    }

    @objc private func commandReceived(_ note: Notification) {
        switch CommandDecoder.decode(object: note.object, userInfo: note.userInfo, role: fixture.role, run: fixture.run) {
        case .ignore:
            return
        case .reject(let cmd, let seq, let message):
            fixture.emit("cmd.error", [("cmd", .str(cmd)), ("seq", seq), ("message", .str(message))])
        case .run(let command):
            execute(command) { [fixture] error in
                if let error {
                    fixture.emit("cmd.error", [("cmd", .str(command.name)), ("seq", command.seq), ("message", .str(error))])
                } else {
                    fixture.emit("cmd.ack", [("cmd", .str(command.name)), ("seq", command.seq)])
                }
            }
        }
    }

    /// `done(nil)` acks; `done(message)` reports `cmd.error`. Every path calls it exactly once.
    private func execute(_ command: FixtureCommand, done: @escaping (String?) -> Void) {
        switch command.name {
        case "ping":
            done(nil)
        case "steal":
            switch CommandDecoder.stealMode(command.args) {
            case .success(let mode):
                fixture.setSteal(mode)
                done(nil)
            case .failure(let error):
                done(error.message)
            }
        case "animate":
            switch CommandDecoder.animateOn(command.args) {
            case .success(let on):
                canvas?.canvas.setAnimating(on)
                fixture.emit("animate", [("on", .bool(on))])
                done(nil)
            case .failure(let error):
                done(error.message)
            }
        case "reset":
            reset { done(nil) }
        case "dump":
            dump { done(nil) }
        case "fullscreen":
            enterFullscreen(done)
        case "exitFullscreen":
            exitFullscreen(done)
        case "openSample":
            if sampleURL() == nil {
                done("sample.wcufix is missing from the app bundle")
            } else {
                openSample(via: "button")
                done(nil)
            }
        case "activate":
            fixture.activate(reason: "user-command")
            done(nil)
        case "quit":
            quit(done)
        default:
            done("unhandled command \(command.name)")
        }
    }

    private func reset(done: @escaping () -> Void) {
        fixture.setSteal(.off)
        if fixture.role == "user" {
            user?.field.stringValue = ""
            done()
            return
        }
        // Focus first (ends any editing), then the values — both silent: programmatic changes fire no field
        // delegate callbacks, the page's reset is guarded against logging, and focus loss logs nothing.
        for window in ([form?.window, web?.window, canvas?.window, offspace?.window] + documents.map { Optional($0) }) {
            _ = window?.makeFirstResponder(nil)
        }
        form?.reset()
        offspace?.field.stringValue = ""
        canvas?.canvas.clearTint()
        if canvas?.canvas.animating == true {
            canvas?.canvas.setAnimating(false)
            fixture.emit("animate", [("on", .bool(false))])
        }
        if let web { web.reset(completion: done) } else { done() }
    }

    private func dump(done: @escaping () -> Void) {
        let keyWindow: JV = NSApp.keyWindow.map { JV.str($0.title) } ?? .null
        if fixture.role == "user" {
            fixture.emit("state", [("userNotes", .str(user?.field.stringValue ?? "")), ("active", .bool(NSApp.isActive)), ("keyWindow", keyWindow)])
            done()
            return
        }
        let finish: (JV) -> Void = { [fixture, form, canvas] webState in
            let selection = form?.notes.selectedRange() ?? NSRange(location: 0, length: 0)
            fixture.emit("state", [
                ("name", .str(form?.name.stringValue ?? "")),
                ("email", .str(form?.email.stringValue ?? "")),
                ("notes", .str(form?.notes.string ?? "")),
                ("notesSelection", .arr([.int(selection.location), .int(selection.length)])),
                ("agree", .bool(form?.agree.state == .on)),
                ("web", webState),
                ("active", .bool(NSApp.isActive)),
                ("keyWindow", keyWindow),
                ("steal", .str(fixture.stealMode.rawValue)),
                ("animating", .bool(canvas?.canvas.animating ?? false)),
            ])
            done()
        }
        if let web { web.state(completion: finish) } else { finish(.null) }
    }

    // MARK: Full screen

    private func enterFullscreen(_ done: @escaping (String?) -> Void) {
        let controller = offspace ?? {
            let created = OffspaceController(slot: 3)
            offspace = created
            return created
        }()
        if controller.isFullScreen {
            done(nil)
            return
        }
        awaitFullscreen(entered: true, timeout: 5) { entered in
            done(entered ? nil : "the Offspace window did not enter full screen within 5 s")
        }
        // Visible first: a window that is not on screen cannot transition. No makeKey: the app is not activated.
        controller.window.orderFront(nil)
        controller.window.toggleFullScreen(nil)
    }

    private func exitFullscreen(_ done: @escaping (String?) -> Void) {
        guard let controller = offspace, controller.isFullScreen else {
            done(nil)
            return
        }
        awaitFullscreen(entered: false, timeout: 5) { exited in
            done(exited ? nil : "the Offspace window did not leave full screen within 5 s")
        }
        controller.window.toggleFullScreen(nil)
    }

    private func quit(_ done: @escaping (String?) -> Void) {
        let finish = { [weak self] in
            // Ack first: the process is about to go away.
            done(nil)
            NSApp.terminate(nil)
            // Never hang: if terminate is somehow deferred (a modal loop), leave anyway.
            DispatchQueue.global().asyncAfter(deadline: .now() + 2.5) { exit(0) }
            _ = self
        }
        // Leave full screen first: terminating from inside a full-screen Space can strand the Space.
        if let controller = offspace, controller.isFullScreen {
            awaitFullscreen(entered: false, timeout: 3) { _ in finish() }
            controller.window.toggleFullScreen(nil)
        } else {
            finish()
        }
    }
}
