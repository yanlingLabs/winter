import AppKit
import SwiftUI
import NormaKit

/// working-directories T8: the CREATE-TIME working-folder picker (design doc §1) — the CC-style
/// sheet a new code session opens with: **Recent** (locked primaries from session history, newest
/// first, latest preselected), **Open folder…** (a native `NSOpenPanel`), and an explicit **No
/// folder (outputs only)** row.
///
/// Starting work without touching the picker keeps the preselected default — `initialWorkingDirChoice`
/// decides what that is, and the Start button is the sheet's DEFAULT button (Return), so the whole
/// flow for the common case is one keystroke.
///
/// The model holds no AppKit and no socket: the panel is run by the controller below (an
/// `NSOpenPanel` must never be launched from a SwiftUI body), and the chosen `WorkingDirChoice` goes
/// back to `DetachedWindowController` which owns the `session.create` call.
@MainActor
final class WorkingDirPickerModel: ObservableObject {
    /// Locked primaries from history (`recentWorkingDirs`) — never mutated by a pick: "recent" means
    /// "a project Norma has actually worked in", and a folder chosen in this sheet has not been
    /// worked in yet. It joins `folderRows` for THIS sheet, and joins the real recents only once the
    /// session it creates writes something.
    @Published private(set) var recents: [String]
    @Published var choice: WorkingDirChoice
    /// The folder picked through "Open folder…" during this sheet's life, if any.
    @Published private(set) var pickedFolder: String?

    /// Wired by the controller: run the native panel (it owns the AppKit half).
    var onOpenPanel: () -> Void = {}
    /// Wired by the controller: create the session with this choice.
    var onStart: (WorkingDirChoice) -> Void = { _ in }
    /// Wired by the controller: dismiss, creating nothing.
    var onCancel: () -> Void = {}

    init(recents: [String]) {
        self.recents = recents
        self.choice = initialWorkingDirChoice(recents: recents)
    }

    /// The panel's answer. Selects the folder immediately — the user just navigated a file dialog to
    /// name it, so asking them to then select the row they created would be a second confirmation of
    /// the same act. (The mid-session ADD is the one that carries a confirm alert; this is create
    /// time, where the Start button IS the confirm.)
    func folderPicked(_ path: String) {
        pickedFolder = path
        choice = .folder(path)
    }

    /// The folder rows the sheet renders, in order: a just-picked folder first (when it isn't
    /// already one of the recents), then the recents themselves.
    var folderRows: [String] {
        guard let picked = pickedFolder, !recents.contains(picked) else { return recents }
        return [picked] + recents
    }

    func start() { onStart(choice) }
    func cancel() { onCancel() }
}

/// The sheet's content. Functional-first styling per the existing app patterns (sub-project 3
/// restyles) — plain rows with a checkmark for the selection, exactly like the model/effort menus.
struct WorkingDirPickerView: View {
    @ObservedObject var model: WorkingDirPickerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Working folder")
                .font(.system(size: 13, weight: .semibold))
            Text("Norma can write inside the folder you choose. Everything else stays read-only.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if !model.folderRows.isEmpty {
                Text("Recent")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(model.folderRows, id: \.self) { path in
                            choiceRow(label: workingDirDisplayName(path), detail: path, choice: .folder(path))
                        }
                    }
                }
                .frame(maxHeight: 180)
            }

            Divider().opacity(0.5)

            Button("Open folder…") { model.onOpenPanel() }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))

            choiceRow(label: "No folder (outputs only)",
                      detail: "Writes only to this session's outputs folder.",
                      choice: .noFolder)

            HStack {
                Spacer()
                Button("Cancel") { model.cancel() }
                    .keyboardShortcut(.cancelAction)
                Button("Start") { model.start() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 4)
        }
        .padding(16)
        .frame(width: 420)
    }

    @ViewBuilder
    private func choiceRow(label: String, detail: String, choice: WorkingDirChoice) -> some View {
        Button {
            model.choice = choice
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(label).font(.system(size: 12))
                    Text(detail)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if model.choice == choice {
                    Image(systemName: "checkmark").font(.system(size: 11))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 3)
    }
}

/// Hosts `WorkingDirPickerView` as a real AppKit SHEET on the window that asked for it — the create
/// flow is modal to that window by nature (it decides what the session about to be created can
/// write to), and a sheet is what macOS uses to say so.
///
/// Lifetime: the caller holds this controller for the sheet's life (see
/// `DetachedWindowController.dirPickerSheet`) and drops it in the completion — an unowned sheet
/// controller is deallocated the moment `present` returns, taking its callbacks with it.
@MainActor
final class WorkingDirPickerSheetController: NSObject {
    private let sheetWindow: NSWindow
    private let model: WorkingDirPickerModel
    private weak var host: NSWindow?
    /// `nil` = the user cancelled and nothing should be created. Fired EXACTLY once (the `didFinish`
    /// latch), whichever way the sheet ends.
    private var completion: ((WorkingDirChoice?) -> Void)?
    private var didFinish = false

    init(recents: [String], host: NSWindow?, completion: @escaping (WorkingDirChoice?) -> Void) {
        self.model = WorkingDirPickerModel(recents: recents)
        self.host = host
        self.completion = completion
        // Sized to the SwiftUI content's own fixed width; the hosting view drives the height.
        self.sheetWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 380),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        super.init()
        sheetWindow.isReleasedWhenClosed = false
        model.onOpenPanel = { [weak self] in self?.runOpenPanel() }
        model.onStart = { [weak self] choice in self?.finish(choice) }
        model.onCancel = { [weak self] in self?.finish(nil) }
        let hosting = NSHostingView(rootView: WorkingDirPickerView(model: model))
        sheetWindow.contentView = hosting
        sheetWindow.setContentSize(hosting.fittingSize)
    }

    func present() {
        guard let host else {
            // No window to hang a sheet on: run it as an ordinary modal panel rather than silently
            // creating a session with an unchosen folder.
            NSApp.runModal(for: sheetWindow)
            return
        }
        host.beginSheet(sheetWindow, completionHandler: nil)
    }

    private func runOpenPanel() {
        runWorkingDirOpenPanel(on: sheetWindow) { [weak self] path in
            guard let self, let path else { return }
            self.model.folderPicked(path)
            self.sheetWindow.setContentSize(self.sheetWindow.contentView?.fittingSize ?? self.sheetWindow.frame.size)
        }
    }

    private func finish(_ choice: WorkingDirChoice?) {
        guard !didFinish else { return }
        didFinish = true
        if let host {
            host.endSheet(sheetWindow)
        } else {
            NSApp.stopModal()
            sheetWindow.orderOut(nil)
        }
        let done = completion
        completion = nil
        done?(choice)
    }
}

// MARK: - The AppKit half, shared by the create sheet and the mid-session chip

/// The native folder chooser, configured the one way a working-directory picker ever wants it:
/// DIRECTORIES only, exactly one, no file creation. Presented as a sheet on `host` when there is one
/// (the create sheet nests it; the chip hangs it off the chat window), else as a plain modal.
///
/// `completion` receives the chosen path, or `nil` for a cancel — a cancel is a real answer here and
/// must never fall through to "use whatever was selected before".
@MainActor
func runWorkingDirOpenPanel(on host: NSWindow?, completion: @escaping (String?) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = true
    panel.resolvesAliases = true
    panel.prompt = "Choose"
    panel.message = "Choose a working folder — Norma will be able to write inside it."
    let handle: (NSApplication.ModalResponse) -> Void = { response in
        completion(response == .OK ? panel.url?.path : nil)
    }
    if let host {
        panel.beginSheetModal(for: host, completionHandler: handle)
    } else {
        handle(panel.runModal())
    }
}

/// The manual-add CONFIRM (the user's explicit ruling: selection + confirm — picking a folder in a
/// file dialog is not the same act as granting write access to it, and the mid-session doors widen a
/// live session's fence rather than shaping a new one).
///
/// Names the FULL path (`workingDirConfirmMessage`) and says what approving grants
/// (`workingDirConfirmDetail`). Default button is the affirmative one, Cancel is the escape key.
@MainActor
func confirmWorkingDir(op: SessionDirsOp, path: String, on host: NSWindow?, completion: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = workingDirConfirmMessage(op: op, path: path)
    alert.informativeText = workingDirConfirmDetail
    alert.addButton(withTitle: op == .setPrimary ? "Make Primary" : "Add Folder")
    alert.addButton(withTitle: "Cancel")
    if let host {
        alert.beginSheetModal(for: host) { completion($0 == .alertFirstButtonReturn) }
    } else {
        completion(alert.runModal() == .alertFirstButtonReturn)
    }
}
