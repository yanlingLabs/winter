import Foundation

// MARK: - editor-product Task 9: what a change on disk MEANS

/// **PURE: the classification every watcher event goes through**, and the one place the difference
/// between "somebody edited this file" and "we wrote it ourselves" is decided.
///
/// `diskText` is the file's text with any UTF-8 BOM already stripped — the same post-strip text the
/// page holds (`EditorRuntime.readTextFile` / `EditorFileContents`), which is the whole of T8's
/// second seam obligation: a comparator that diffed raw disk BYTES against the model's text would
/// report a phantom change on every BOM'd file from the moment it opened, forever, because the three
/// bytes the reader swallows can never come back through the page. `nil` means the file is not
/// there.
///
/// `baseline` is what Swift last knew the file to hold (`EditorRuntime.diskBaseline`), and `nil`
/// means it knows nothing — a file that was deleted and has come back is a CHANGE, not a match.
enum EditorDiskChange: Equatable {
    /// The bytes are exactly what Swift already knew about. The overwhelmingly common answer: our
    /// own completed save, a sibling file's change reaching a directory watch, a `touch`.
    case unchanged
    /// Different from the baseline, and one of this runtime's own writes has not been accounted for
    /// yet — so this is the echo of that write reaching us before the write's own continuation ran.
    /// The caller consumes ONE note (`EditorRuntime.consumeExpectedWrite`) and stays silent.
    case ours
    /// Different, and nobody claimed it. The agent, another editor, `git checkout`.
    case external(text: String)
    case deleted
}

/// The classification itself. Ordered content-first, deliberately: the baseline is a fact about
/// BYTES and the note bag is a fact about intentions, and bytes are the stronger evidence — a save
/// whose note was never consumed cannot make a genuine external change look like ours as long as
/// the baseline says the file has moved somewhere neither of them predicted.
func editorDiskChange(diskText: String?, baseline: String?, expectedWrites: Int) -> EditorDiskChange {
    guard let diskText else { return .deleted }
    if let baseline, diskText == baseline { return .unchanged }
    return expectedWrites > 0 ? .ours : .external(text: diskText)
}

// MARK: - The watcher seam

/// How an open model gets its watch. **Deliberately the same shape as `FileTreeWatcherFactory`, and
/// the same `FileTreeWatching` protocol** (T7): "a live watch somebody can stop" is one idea, and a
/// second protocol for it would be a second thing to keep true. What differs is only what is
/// watched — the tree watches a directory it renders, this watches a FILE whose contents are on
/// screen — which is why the two have different factories rather than different vocabularies.
///
/// `nil` when nothing could be watched at all: the same vanish-tolerance every reader in this app
/// keeps. A model with no watcher shows what it was opened with and never notices a change; it is
/// never wrong about anything, and it never crashes.
typealias EditorFileWatcherFactory =
    @MainActor (_ path: String, _ onChange: @escaping () -> Void) -> FileTreeWatching?

/// ~200 ms — the window a burst of filesystem events for one file coalesces into ONE read.
///
/// Shorter than the tree's 300 ms (`fileTreeWatcherDebounceInterval`) and separately named rather
/// than shared, because the two surfaces are answering different questions: a tree row appearing a
/// third of a second late is invisible, while this one gates how quickly an agent's edit shows up
/// in text the user is reading. Neither figure is measured beyond "well above one write, well under
/// noticeable"; they are allowed to differ, and the constant is what says so.
let editorFileWatchDebounceInterval: TimeInterval = 0.2

/// **The real watcher: TWO `DispatchSource`s per open model, one debounce, and a re-arm on every
/// fire.** Neither source alone is enough, and that is measured rather than reasoned — this probe
/// was run on this machine against a real temp directory before a line of this class was written:
///
/// ```
/// A. in-place rewrite (open O_TRUNC + write)  → dir: []        file: [attrib, write|extend]
/// B. tmp + rename replacement                 → dir: [write]   file: [delete]
/// C. in-place write AFTER a rename            → dir: []        file: []          ← the invisible failure
/// D. the same, after re-arming the file fd    → dir: []        file: [attrib, write|extend]
/// E. unlink                                   → dir: [write]   file: [delete|link]
/// ```
///
///   * **Row A is why a directory watch alone is not enough.** A kqueue `NOTE_WRITE` on a directory
///     fires for a change to the directory's ENTRIES — a create, a delete, a rename — and an
///     in-place rewrite of a child changes no entry. The daemon's own file tools write exactly that
///     way (`packages/core/src/agent/tools/fs-write.ts` is `writeFileSync(target, content)`, an
///     `O_TRUNC` rewrite of the same inode), so a directory-only watch would miss **every agent
///     edit** — the one case this whole feature exists for.
///   * **Row C is why a file watch alone is not enough**, and it is the re-arm race in the raw: a
///     `rename(2)` replacement (row B — what `EditorSaveCoordinator.writeAtomically` does, what most
///     editors do) unlinks the inode the file source holds. From then on the source watches an
///     orphan: the next in-place write to the file's NEW inode fires nothing anywhere, the event
///     never arrives, and a note filed for it would sit in the bag waiting to swallow the next
///     genuine external change. The directory source survives that rename because a directory is
///     not replaced by writing into it.
///   * **Row D is why the re-arm is load-bearing** rather than hygiene: re-opening the path after a
///     fire is what puts the file source back on the inode that now answers to the name.
///
/// So: the directory source is the one that cannot die, the file source is the one that sees writes
/// nothing else can see, and the re-arm — performed as part of consuming a debounced fire, before
/// the handler runs — is what keeps the second true across every rename. A re-arm that loses a race
/// (the file replaced again between the cancel and the open) self-heals at the very next directory
/// event, which the surviving source will deliver.
@MainActor
final class DispatchSourceFileWatcher: FileTreeWatching {
    /// Both sources use the same mask for the same reason `DispatchSourceDirectoryWatcher` does:
    /// which bit a given filesystem operation sets is the kernel's business (row E sets
    /// `delete|link` for one `unlink`), and this watcher's answer to every one of them is identical
    /// — go and read the file. Nothing here branches on the event data, so nothing here can be
    /// wrong about it.
    private static let eventMask: DispatchSource.FileSystemEvent =
        [.write, .delete, .rename, .extend, .attrib, .link]

    private let path: String
    private let queue: DispatchQueue
    private let debounceInterval: TimeInterval
    private let onChange: () -> Void

    private var directorySource: DispatchSourceFileSystemObject?
    private var fileSource: DispatchSourceFileSystemObject?
    private var debounceTask: Task<Void, Never>?

    /// Failable on the DIRECTORY, not on the file: the directory is the source that must exist for
    /// this watcher to be worth anything (it is the only one that survives a rename), while the file
    /// source is best-effort by construction — it is re-opened on every fire anyway, and a file that
    /// is momentarily absent gets its watch back at the next directory event.
    init?(path: String, debounceInterval: TimeInterval = editorFileWatchDebounceInterval,
          queue: DispatchQueue = .main, onChange: @escaping () -> Void) {
        let directory = (path as NSString).deletingLastPathComponent
        let directoryFD = open(directory, O_EVTONLY)
        guard directoryFD >= 0 else { return nil }
        self.path = path
        self.queue = queue
        self.debounceInterval = debounceInterval
        self.onChange = onChange

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: directoryFD, eventMask: Self.eventMask, queue: queue)
        source.setEventHandler { [weak self] in
            // The handler runs on `queue`, which the compiler does not recognise as the MainActor's
            // own executor even when it is `.main` — the same hop `DispatchSourceDirectoryWatcher`
            // and `OutputsWatcher` both take, `weak` on both closures so a fire racing a teardown
            // cannot resurrect anything.
            Task { @MainActor [weak self] in self?.scheduleFire() }
        }
        source.setCancelHandler { close(directoryFD) }
        directorySource = source
        source.resume()
        armFileSource()
    }

    /// Open the path as it is NOW and watch that inode. Called once at init and again after every
    /// debounced fire — see the class doc's row D.
    private func armFileSource() {
        let fd = open(path, O_EVTONLY)
        // A file that is not there right now (deleted; between an editor's unlink and its rewrite)
        // simply has no file source until the next fire re-tries. The directory source is what will
        // deliver that fire.
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: Self.eventMask, queue: queue)
        source.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in self?.scheduleFire() }
        }
        source.setCancelHandler { close(fd) }
        fileSource = source
        source.resume()
    }

    private func rearmFileSource() {
        fileSource?.cancel()
        fileSource = nil
        armFileSource()
    }

    /// Trailing-edge debounce — `DispatchSourceDirectoryWatcher`'s exact shape, so a burst reaches
    /// `onChange` once, `debounceInterval` after the LAST event, never once per event. Both sources
    /// feed this one timer: a `rename(2)` that fires the directory AND kills the file source (row B)
    /// is one change to the user, and it costs one read.
    ///
    /// **The re-arm happens here, before the handler runs**, so a write that lands while the
    /// handler is reading is already being watched for by the time it arrives.
    private func scheduleFire() {
        debounceTask?.cancel()
        let interval = debounceInterval
        debounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.rearmFileSource()
            self.onChange()
        }
    }

    func stop() {
        debounceTask?.cancel()
        debounceTask = nil
        directorySource?.cancel()
        directorySource = nil
        fileSource?.cancel()
        fileSource = nil
    }

    /// Direct property access rather than a call to `stop()` — the same strict-concurrency rule
    /// `DispatchSourceDirectoryWatcher.deinit` documents: a `nonisolated deinit` may touch its own
    /// actor-isolated stored properties, but not call an isolated method.
    deinit {
        debounceTask?.cancel()
        directorySource?.cancel()
        fileSource?.cancel()
    }
}
