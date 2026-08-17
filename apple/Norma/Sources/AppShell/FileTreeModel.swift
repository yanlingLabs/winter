import Foundation

// MARK: - editor-product Task 7: the Files tab's tree — pure-ish disk reads + a per-node watcher.

/// One directory entry, as read off disk — immutable once produced; `FileTreeNode` (below) is what
/// carries the parts that DO change over the tree's life (expansion, children, the watcher).
struct FileTreeEntry: Equatable {
    let path: String
    let name: String
    let isDirectory: Bool
}

/// PURE: dirs-first, then case-insensitive name — the one ordering rule every level of the tree
/// obeys (design spec: "sorted dirs-first" over the session's working directory). A comparator that
/// returns `false` both ways for two entries that tie on kind AND name leaves `sorted(by:)` free to
/// keep them in whatever order `listTreeEntries` handed them — never a concern in practice, since
/// two on-disk entries can never share both a kind and a name.
func sortedTreeEntries(_ entries: [FileTreeEntry]) -> [FileTreeEntry] {
    entries.sorted { lhs, rhs in
        if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }
}

/// One disk read: `path`'s own level, hidden entries filtered (`.skipsHiddenFiles` —
/// `OutputsBox.listOutputFiles`'s own precedent for the identical option, same rule this app
/// already applies to a different directory listing), sorted.
///
/// VANISH-TOLERANT, the same posture `OutputsBox`/`OutputsWatcher` keep for a directory that can
/// disappear between a listing and the read that acts on it: an unreadable or missing directory
/// (deleted underneath an open Files tab; a dangling symlink) answers `[]` rather than throwing.
func listTreeEntries(of path: String, fileManager: FileManager = .default) -> [FileTreeEntry] {
    let url = URL(fileURLWithPath: path, isDirectory: true)
    guard let items = try? fileManager.contentsOfDirectory(
        at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
    ) else { return [] }
    let entries = items.map { child -> FileTreeEntry in
        let isDir = (try? child.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        return FileTreeEntry(path: child.path, name: child.lastPathComponent, isDirectory: isDir)
    }
    return sortedTreeEntries(entries)
}

// MARK: - The watcher seam

/// One live watch on a single directory path. `FileTreeModel` mints one per EXPANDED node (design
/// spec) and stops it on collapse — the mechanism that bounds the tree's OS-level footprint to
/// exactly what is currently open on screen, never to everything the tree has ever shown.
@MainActor
protocol FileTreeWatching: AnyObject {
    func stop()
}

/// How a node gets its watcher. The house seam (`ShellSessionHost.makeEditorRuntime`,
/// `SessionDirectory`'s `lister`): production wires the real `DispatchSourceDirectoryWatcher` below
/// via an inline closure literal at `FileTreeModel.init`'s default-argument position (not a named
/// static property — see that init's own comment for why); tests substitute a recorder that never
/// touches the filesystem and can fire `onChange` synchronously on demand — see `FileTreeModelTests`.
///
/// Returns `nil` when a watch could not be started (the path vanished between the listing that
/// found it and this call — the same race every vanish-tolerant reader in this app already
/// accepts): a node with no watcher simply has no LIVE updates until the next manual refresh, never
/// a crash and never a wrong answer.
///
/// `onChange` is `@escaping`: verified empirically, not assumed — a build attempt without it fails
/// at the `DispatchSourceDirectoryWatcher` call site with "passing non-escaping parameter 'onChange'
/// to function expecting an '@escaping' closure". The inner parameter of a function-type typealias
/// does not inherit non-escaping-by-default the way a plain function parameter does once the
/// typealias itself is used as an `@escaping` stored-property type; trust the compiler over any
/// general rule of thumb here.
typealias FileTreeWatcherFactory = @MainActor (_ path: String, _ onChange: @escaping () -> Void) -> FileTreeWatching?

/// ~300ms (design spec) — the debounce a burst of filesystem events (an agent writing several files
/// in one tool call; a `git checkout` touching a dozen at once) coalesces into ONE refresh rather
/// than one per raw event. Not tuned further than "well above one write, well under 'the user
/// notices a delay'" — no measurement session backs the exact figure, matching the spec's own "~".
let fileTreeWatcherDebounceInterval: TimeInterval = 0.3

/// The REAL watcher: a `DispatchSource` file-system-object source on an `O_EVTONLY` descriptor —
/// the standard technique for "tell me when a directory's CONTENTS change" (`.write` fires on the
/// WATCHED directory's own fd for a child create/delete/rename; `O_EVTONLY` is what lets this hold
/// a descriptor open on a directory without blocking anything else from using it, or requiring read
/// permission on the directory's bytes). Debounced internally so a burst of raw events reaches
/// `onChange` once.
@MainActor
final class DispatchSourceDirectoryWatcher: FileTreeWatching {
    private var source: DispatchSourceFileSystemObject?
    private var debounceTask: Task<Void, Never>?
    private let debounceInterval: TimeInterval
    private let onChange: () -> Void

    /// Failable: `open()` refusing (the path is gone, or was never real) means there is nothing to
    /// watch — `FileTreeModel`'s own factory type answers `FileTreeWatching?` for exactly this,
    /// never a crash.
    init?(path: String, debounceInterval: TimeInterval = fileTreeWatcherDebounceInterval,
          queue: DispatchQueue = .main, onChange: @escaping () -> Void) {
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        self.debounceInterval = debounceInterval
        self.onChange = onChange
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename, .extend, .attrib, .link],
            queue: queue)
        source.setEventHandler { [weak self] in
            // The handler runs on `queue` (production: `.main`), not necessarily recognized by the
            // compiler as the MainActor's own executor — the same hop `OutputsWatcher.start()`'s C
            // callback takes for the identical reason, `weak` on both closures so a fire racing a
            // teardown cannot resurrect anything.
            Task { @MainActor [weak self] in self?.scheduleFire() }
        }
        source.setCancelHandler { close(fd) }
        self.source = source
        source.resume()
    }

    /// Trailing-edge debounce: every fire cancels whatever was pending and reschedules — so a burst
    /// of raw events reaches `onChange` exactly once, `debounceInterval` after the LAST one, never
    /// once per event.
    private func scheduleFire() {
        debounceTask?.cancel()
        let interval = debounceInterval
        debounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.onChange()
        }
    }

    func stop() {
        debounceTask?.cancel()
        debounceTask = nil
        source?.cancel()
        source = nil
    }

    /// **Direct property access, not a call to `stop()`.** `deinit` on a `@MainActor` class may
    /// touch its own actor-isolated STORED PROPERTIES synchronously (`OutputsWatcher.deinit`'s own
    /// precedent, immediately above this file's sibling) — but calling an isolated METHOD from a
    /// nonisolated `deinit` context is the variant strict concurrency refuses, so the teardown is
    /// inlined here rather than routed through `stop()`.
    deinit {
        debounceTask?.cancel()
        source?.cancel()
    }
}

// MARK: - The tree

/// One node — a file or a directory — `@MainActor`/`ObservableObject` so each row can observe only
/// the parts of the tree it actually renders, rather than the whole model republishing on every
/// change anywhere in it.
///
/// **Identity is the path.** A refresh that finds the same path still present REUSES this exact
/// object (`FileTreeModel.reload`) rather than minting a fresh one — the only thing that makes
/// `isExpanded`/`children`/the watcher survive a refresh for a node the user has not touched.
@MainActor
final class FileTreeNode: ObservableObject, Identifiable {
    let path: String
    let name: String
    let isDirectory: Bool
    /// `nonisolated`: `Identifiable`'s own requirement is not actor-isolated, and `path` is an
    /// immutable `let` — safe to read from any context without a hop, so the conformance never
    /// needs to "cross into" this type's actor isolation at all.
    nonisolated var id: String { path }

    /// `fileprivate(set)`: only `FileTreeModel` (this file) mints, expands or collapses a node — the
    /// view layer (`PanelFilesTab.swift`) reads these and calls back through the model's own
    /// `toggle`/`expand`/`collapse`, never mutates them directly.
    @Published fileprivate(set) var children: [FileTreeNode] = []
    @Published fileprivate(set) var isExpanded: Bool = false
    fileprivate var watcher: FileTreeWatching?

    init(path: String, name: String, isDirectory: Bool) {
        self.path = path
        self.name = name
        self.isDirectory = isDirectory
    }
}

/// One session working directory, as the tree shows it. `rootPath` names the section
/// (`PanelFilesContent`'s header when there is more than one); `node` is a directory node whose OWN
/// row is never drawn — only its children are, flush against the top of its section — and which is
/// auto-expanded the moment it is built (`FileTreeModel.setRoots`), unlike every node below it.
struct FileTreeSection: Identifiable {
    let rootPath: String
    let node: FileTreeNode
    var id: String { rootPath }
}

/// editor-product Task 7: the Files tab's model — lazy children, a watcher per EXPANDED node, roots
/// = the session's own working directories. Deliberately ignorant of `ShellSessionHost`/
/// `SessionDirectory`: `PanelFilesTabModel` resolves the session's roots and calls `setRoots(_:)`,
/// which is what keeps this type testable with nothing but a temp directory.
@MainActor
final class FileTreeModel: ObservableObject {
    @Published private(set) var sections: [FileTreeSection] = []

    private let fileManager: FileManager
    private let makeWatcher: FileTreeWatcherFactory

    /// `makeWatcher`'s default is an INLINE closure literal, not a reference to a named static
    /// property — a default-argument expression is evaluated in a context Swift does not treat as
    /// already on the main actor, even though this initializer itself is (the same trap
    /// `PanelFilesTabModel.init`'s own doc names for a sibling case); a fresh closure LITERAL runs
    /// nothing at creation time, so it sidesteps the trap rather than needing a workaround for it.
    init(fileManager: FileManager = .default,
         makeWatcher: @escaping FileTreeWatcherFactory = { path, onChange in
             DispatchSourceDirectoryWatcher(path: path, onChange: onChange)
         }) {
        self.fileManager = fileManager
        self.makeWatcher = makeWatcher
    }

    /// Rebuild the roots for a session's working directories — called whenever they resolve or
    /// change (`PanelFilesTabModel`'s own `SessionDirectory.$rows` subscription; an empty array for
    /// a dirless/unresolved session releases everything and shows nothing). Multiple paths become
    /// multiple SECTIONS (design spec: "multi-root -> top-level sections"); each root is
    /// auto-expanded immediately — a project root is never itself a click away — while everything
    /// BELOW a root stays lazy.
    ///
    /// **Idempotent against its own prior output**, not merely against the caller being careful: the
    /// SAME paths, in the SAME order, leave every existing section (and so every watcher and every
    /// expand state below it) untouched rather than tearing the tree down and rebuilding it — a
    /// `SessionDirectory.$rows` publish that changes some OTHER field on the row (title, activity)
    /// still calls this with identical paths, and churning the tree on every one of those would
    /// collapse whatever the user had open.
    func setRoots(_ paths: [String]) {
        guard paths != sections.map(\.rootPath) else { return }
        for section in sections { releaseSubtree(section.node) }
        sections = paths.map { path in
            let node = FileTreeNode(path: path, name: (path as NSString).lastPathComponent,
                                    isDirectory: true)
            expand(node)
            return FileTreeSection(rootPath: path, node: node)
        }
    }

    /// The row's disclosure tap: closed -> open, open -> closed. The one entry point the view layer
    /// calls for a directory row (`FileTreeRowView`, `PanelFilesTab.swift`).
    func toggle(_ node: FileTreeNode) {
        node.isExpanded ? collapse(node) : expand(node)
    }

    /// Read `node`'s own level, start its watcher, mark it expanded. Idempotent — an already-
    /// expanded node is left exactly as it is; a second tap closes it via `toggle`, never re-enters
    /// here.
    ///
    /// **This is the whole of "lazy children, expand-on-demand"**: nothing anywhere else in this
    /// file ever calls `listTreeEntries` for a node that has not been handed to this method (or to
    /// `setRoots`, for a root) — a collapsed directory's children are never read, however long it
    /// sits on screen.
    func expand(_ node: FileTreeNode) {
        guard node.isDirectory, !node.isExpanded else { return }
        reload(node)
        node.watcher = makeWatcher(node.path) { [weak self, weak node] in
            guard let self, let node else { return }
            self.reload(node)
        }
        node.isExpanded = true
    }

    /// **Bound memory** (design spec: "collapse releases children + watcher"): stop this node's own
    /// watcher, recurse into every descendant doing the same, and drop every loaded child — a tree
    /// expanded once and collapsed back to its roots ends up holding no more state, and no more open
    /// file descriptors, than one that was never expanded at all. Re-expanding later reads fresh,
    /// exactly like a first expand. `releaseSubtree` clears `isExpanded` for `node` itself as part of
    /// the same recursion that clears it for every descendant — see that method's own doc for why a
    /// SEPARATE `node.isExpanded = false` here would have been correct for `node` but silently wrong
    /// for an expanded grandchild two levels down.
    func collapse(_ node: FileTreeNode) {
        guard node.isExpanded else { return }
        releaseSubtree(node)
    }

    /// The chrome's manual refresh button (`ShellTitlebarButton`, `PanelFilesTab.swift`): re-read
    /// every currently EXPANDED node, root down, without disturbing which nodes are expanded — the
    /// watcher's own automatic path (`reload`, fired debounced) minus "wait for a filesystem event".
    func refreshAll() {
        for section in sections { refreshSubtree(section.node) }
    }

    private func refreshSubtree(_ node: FileTreeNode) {
        guard node.isExpanded else { return }
        reload(node)
        for child in node.children { refreshSubtree(child) }
    }

    /// Re-read `node`'s own level. Existing children that are STILL PRESENT (same path, same
    /// directory-ness) keep their identity — and so their `isExpanded`/`children`/watcher; only a
    /// genuinely new entry mints a fresh node, and only a genuinely vanished one releases its
    /// subtree. Without identity-preservation a refresh (manual, or the watcher's own automatic one)
    /// would silently collapse every expanded child back to closed on every single fire.
    ///
    /// Looks children up by path in a dictionary rather than `first(where:)`-scanning the array per
    /// entry — `O(n)` instead of `O(n^2)` against the directory's own entry count, which is the
    /// difference between "a refresh" and "a stall" on a directory with thousands of entries.
    private func reload(_ node: FileTreeNode) {
        let fresh = listTreeEntries(of: node.path, fileManager: fileManager)
        let existingByPath = Dictionary(uniqueKeysWithValues: node.children.map { ($0.path, $0) })
        var next: [FileTreeNode] = []
        next.reserveCapacity(fresh.count)
        var keptPaths = Set<String>()
        for entry in fresh {
            if let existing = existingByPath[entry.path], existing.isDirectory == entry.isDirectory {
                next.append(existing)
                keptPaths.insert(entry.path)
            } else {
                next.append(FileTreeNode(path: entry.path, name: entry.name,
                                         isDirectory: entry.isDirectory))
            }
        }
        for gone in node.children where !keptPaths.contains(gone.path) {
            releaseSubtree(gone)
        }
        node.children = next
    }

    /// Stop `node`'s own watcher, recurse into its children doing the same, then drop them — the one
    /// place every watcher this model ever created is guaranteed to be stopped exactly once, whether
    /// the reason is a collapse, a vanished entry, or a whole new set of roots.
    ///
    /// **`isExpanded` is cleared for EVERY node this touches, `node` included, not only its
    /// children.** Caught by a test, not reasoned out in advance: `collapse` used to clear `node
    /// .isExpanded` itself, separately, AFTER calling this — correct for `node`, but silently wrong
    /// for an expanded GRANDCHILD, whose own `isExpanded` this recursion released the watcher and
    /// children of but never touched. A node re-discovered later (a fresh expand of its now-collapsed
    /// parent) must start `isExpanded == false`, or the view renders a disclosure triangle open over
    /// content that was never re-read.
    private func releaseSubtree(_ node: FileTreeNode) {
        node.watcher?.stop()
        node.watcher = nil
        for child in node.children { releaseSubtree(child) }
        node.children = []
        node.isExpanded = false
    }
}
