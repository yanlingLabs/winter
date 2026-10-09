import Foundation

// Taking the fixture's OWN window off the active Space without switching Spaces, through private SkyLight.
// Nothing here touches a window it does not own, and nothing switches the user's Space: it only changes which
// Space the Offspace window lives on (and creates/destroys one Space, when it has to).

// MARK: - The private symbols (one place; these are undocumented and may change between macOS releases)

/// Every private symbol the fixture uses, resolved with dlopen/dlsym. A symbol that does not resolve is a nil
/// member, and the operation that needs it reports "unavailable" — the caller falls back to the next method; it
/// is never a crash. The prototypes are the ones the window-manager community documents (yabai et al.); the
/// comments say what each is believed to take, and this file is the only place to correct them.
struct SkyLight {
    /// `int SLSMainConnectionID(void)` — this process's connection to the window server (needs AppKit to have
    /// connected, which a running NSApplication has).
    typealias MainConnectionID = @convention(c) () -> Int32
    /// `uint64_t SLSGetActiveSpace(int cid)` — the Space being shown.
    typealias GetActiveSpace = @convention(c) (Int32) -> UInt64
    /// `CFArrayRef SLSCopyManagedDisplaySpaces(int cid)` — one dictionary per display ("Display Identifier",
    /// "Spaces" [each "id64", "type": 0 desktop / 4 full screen], "Current Space"). Create rule: we own the result.
    typealias CopyManagedDisplaySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
    /// `void SLSMoveWindowsToManagedSpace(int cid, CFArrayRef windowIDs, uint64_t spaceID)` — windowIDs are CFNumbers.
    typealias MoveWindowsToManagedSpace = @convention(c) (Int32, CFArray, UInt64) -> Void
    /// `uint64_t SLSSpaceCreate(int cid, int/void* unknown, CFDictionaryRef options)` — called as (cid, 1, NULL).
    /// The second parameter is declared pointer-sized so a 64-bit register holds exactly 1 whichever the real
    /// prototype is. Returns 0 on failure.
    typealias SpaceCreate = @convention(c) (Int32, Int, CFDictionary?) -> UInt64
    /// `void SLSSpaceDestroy(int cid, uint64_t spaceID)`.
    typealias SpaceDestroy = @convention(c) (Int32, UInt64) -> Void
    /// `void SLSAddWindowsToSpaces(int cid, CFArrayRef windowIDs, CFArrayRef spaceIDs)`.
    typealias AddWindowsToSpaces = @convention(c) (Int32, CFArray, CFArray) -> Void
    /// `void SLSRemoveWindowsFromSpaces(int cid, CFArrayRef windowIDs, CFArrayRef spaceIDs)`.
    typealias RemoveWindowsFromSpaces = @convention(c) (Int32, CFArray, CFArray) -> Void
    /// `CFArrayRef SLSCopySpacesForWindows(int cid, int selector, CFArrayRef windowIDs)` — the Spaces the windows
    /// are on, as CFNumbers. Selector 7 = all Spaces (current, other and full-screen). Create rule.
    typealias CopySpacesForWindows = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?

    static let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    static let allSpacesSelector: Int32 = 7

    let connection: Int32
    let getActiveSpace: GetActiveSpace?
    let copyManagedDisplaySpaces: CopyManagedDisplaySpaces?
    let moveWindowsToManagedSpace: MoveWindowsToManagedSpace?
    let spaceCreate: SpaceCreate?
    let spaceDestroy: SpaceDestroy?
    let addWindowsToSpaces: AddWindowsToSpaces?
    let removeWindowsFromSpaces: RemoveWindowsFromSpaces?
    let copySpacesForWindows: CopySpacesForWindows?

    /// nil when SkyLight itself, or the connection call, is missing — then nothing in here is available.
    static let shared: SkyLight? = SkyLight()

    private init?() {
        guard let handle = dlopen(Self.path, RTLD_LAZY) else { return nil }
        func symbol<T>(_ name: String, as type: T.Type) -> T? {
            guard let raw = dlsym(handle, name) else { return nil }
            return unsafeBitCast(raw, to: type)
        }
        guard let mainConnection = symbol("SLSMainConnectionID", as: MainConnectionID.self) else { return nil }
        connection = mainConnection()
        getActiveSpace = symbol("SLSGetActiveSpace", as: GetActiveSpace.self)
        copyManagedDisplaySpaces = symbol("SLSCopyManagedDisplaySpaces", as: CopyManagedDisplaySpaces.self)
        moveWindowsToManagedSpace = symbol("SLSMoveWindowsToManagedSpace", as: MoveWindowsToManagedSpace.self)
        spaceCreate = symbol("SLSSpaceCreate", as: SpaceCreate.self)
        spaceDestroy = symbol("SLSSpaceDestroy", as: SpaceDestroy.self)
        addWindowsToSpaces = symbol("SLSAddWindowsToSpaces", as: AddWindowsToSpaces.self)
        removeWindowsFromSpaces = symbol("SLSRemoveWindowsFromSpaces", as: RemoveWindowsFromSpaces.self)
        copySpacesForWindows = symbol("SLSCopySpacesForWindows", as: CopySpacesForWindows.self)
    }

    // MARK: Reads

    func activeSpace() -> UInt64? {
        guard let id = getActiveSpace?(connection), id != 0 else { return nil }
        return id
    }

    func displays() -> [DisplaySpaces]? {
        guard let copy = copyManagedDisplaySpaces,
              let raw = copy(connection)?.takeRetainedValue() as? [[String: Any]] else { return nil }
        return SpacePlanner.parse(raw)
    }

    /// The Spaces a window is on; empty while the window server has not placed it (not yet ordered in).
    func spaces(ofWindow window: UInt32) -> [UInt64]? {
        guard let copy = copySpacesForWindows,
              let raw = copy(connection, Self.allSpacesSelector, Self.numbers([UInt64(window)]))?.takeRetainedValue() as? [Any] else { return nil }
        return raw.compactMap { SpacePlanner.spaceID($0) }
    }

    // MARK: Writes — each returns an error message, or nil on success

    func move(window: UInt32, toSpace space: UInt64) -> String? {
        guard let move = moveWindowsToManagedSpace else { return "SLSMoveWindowsToManagedSpace is not available" }
        move(connection, Self.numbers([UInt64(window)]), space)
        return nil
    }

    func add(window: UInt32, toSpace space: UInt64) -> String? {
        guard let add = addWindowsToSpaces else { return "SLSAddWindowsToSpaces is not available" }
        add(connection, Self.numbers([UInt64(window)]), Self.numbers([space]))
        return nil
    }

    func remove(window: UInt32, fromSpaces spaces: [UInt64]) -> String? {
        guard let remove = removeWindowsFromSpaces else { return "SLSRemoveWindowsFromSpaces is not available" }
        remove(connection, Self.numbers([UInt64(window)]), Self.numbers(spaces))
        return nil
    }

    func createSpace() -> Result<UInt64, SpaceError> {
        guard let create = spaceCreate else { return .failure(SpaceError("SLSSpaceCreate is not available")) }
        let id = create(connection, 1, nil)
        return id == 0 ? .failure(SpaceError("SLSSpaceCreate returned no Space")) : .success(id)
    }

    func destroy(space: UInt64) -> String? {
        guard let destroy = spaceDestroy else { return "SLSSpaceDestroy is not available" }
        destroy(connection, space)
        return nil
    }

    private static func numbers(_ values: [UInt64]) -> CFArray {
        values.map { NSNumber(value: $0) } as CFArray
    }
}

struct SpaceError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

// MARK: - Placing and restoring the window

/// Where the Offspace window was put, kept so it can be put back.
struct SpacePlacement {
    let method: OffspaceMethod
    /// The Space it now lives on (the target desktop, or the Space created for it).
    let spaceId: UInt64?
    /// A Space this process created and must destroy on restore.
    let createdSpace: UInt64?
}

@MainActor
struct SpaceMover {
    let skyLight: SkyLight

    /// Polls until `check` passes or about half a second is up: the window server applies a move a moment after the
    /// call returns.
    private func settles(_ check: () -> Bool) async -> Bool {
        for attempt in 0..<6 {
            if check() { return true }
            if attempt < 5 { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
        return false
    }

    private func isOffScreen(window: UInt32, mustBeOn: UInt64?) -> Bool {
        guard let spaces = skyLight.spaces(ofWindow: window) else { return false }
        let visible = SpacePlanner.visibleSpaces(skyLight.displays() ?? [], active: skyLight.activeSpace())
        return SpacePlanner.isOffScreen(windowSpaces: spaces, visible: visible, mustBeOn: mustBeOn)
    }

    /// Tries (a) another existing desktop on the window's display, then (b) a Space created for the purpose, and
    /// VERIFIES each (the window must be on a Space nobody is showing). Neither switches the active Space. The
    /// failures of the methods that did not work come back in `failures`, in the order tried.
    func place(window: UInt32) async -> (placement: SpacePlacement?, failures: [String]) {
        var failures: [String] = []
        // A window the window server has not placed yet has no Spaces; give it a moment after orderFront.
        var before: [UInt64] = []
        _ = await settles {
            before = skyLight.spaces(ofWindow: window) ?? []
            return !before.isEmpty
        }
        guard !before.isEmpty else {
            return (nil, ["the window server reports no Space for the Offspace window"])
        }
        let active = skyLight.activeSpace()

        // (a) another desktop that already exists
        if let target = SpacePlanner.otherDesktop(displays: skyLight.displays() ?? [], windowSpaces: before, active: active) {
            if let error = skyLight.move(window: window, toSpace: target) {
                failures.append("managed-space: \(error)")
            } else if await settles({ isOffScreen(window: window, mustBeOn: target) }) {
                return (SpacePlacement(method: .managedSpace, spaceId: target, createdSpace: nil), failures)
            } else {
                failures.append("managed-space: the window is still on a visible Space after the move")
                _ = skyLight.move(window: window, toSpace: before[0]) // put it back before trying anything else
            }
        } else {
            failures.append("managed-space: no other desktop on the window's display")
        }

        // (b) a Space of our own
        switch skyLight.createSpace() {
        case .failure(let error):
            failures.append("created-space: \(error.message)")
        case .success(let created):
            if let error = skyLight.add(window: window, toSpace: created) ?? skyLight.remove(window: window, fromSpaces: before) {
                failures.append("created-space: \(error)")
            } else if await settles({ isOffScreen(window: window, mustBeOn: created) }) {
                return (SpacePlacement(method: .createdSpace, spaceId: created, createdSpace: created), failures)
            } else {
                failures.append("created-space: the window is still on a visible Space after the move")
            }
            // Undo: back to where it was, and the Space we made goes away.
            _ = skyLight.add(window: window, toSpace: before[0])
            _ = skyLight.remove(window: window, fromSpaces: [created])
            _ = skyLight.destroy(space: created)
        }
        return (nil, failures)
    }

    /// Puts the window back on the active Space and destroys a Space this process created. Returns an error
    /// message when the window could not be verified back (the Space is destroyed regardless: leaking a Space is
    /// worse than a window left somewhere odd on a process that is about to exit).
    func restore(window: UInt32, placement: SpacePlacement, verify: Bool = true) async -> String? {
        guard let active = skyLight.activeSpace() else { return "the active Space is unknown" }
        var problem: String?
        switch placement.method {
        case .managedSpace:
            problem = skyLight.move(window: window, toSpace: active)
        case .createdSpace:
            problem = skyLight.add(window: window, toSpace: active)
            if problem == nil, let created = placement.createdSpace { problem = skyLight.remove(window: window, fromSpaces: [created]) }
        case .fullscreen:
            return nil // handled by the caller (leaving full screen is a window operation)
        }
        if problem == nil, verify {
            let back = await settles { (skyLight.spaces(ofWindow: window) ?? []).contains(active) }
            if !back { problem = "the window did not come back to the active Space" }
        }
        if let created = placement.createdSpace, let error = skyLight.destroy(space: created), problem == nil { problem = error }
        return problem
    }

    /// For `applicationWillTerminate` / signals: the same moves, no waiting.
    func restoreNow(window: UInt32, placement: SpacePlacement) {
        guard let active = skyLight.activeSpace() else { return }
        switch placement.method {
        case .managedSpace:
            _ = skyLight.move(window: window, toSpace: active)
        case .createdSpace:
            _ = skyLight.add(window: window, toSpace: active)
            if let created = placement.createdSpace { _ = skyLight.remove(window: window, fromSpaces: [created]) }
        case .fullscreen:
            break
        }
        if let created = placement.createdSpace { _ = skyLight.destroy(space: created) }
    }
}
