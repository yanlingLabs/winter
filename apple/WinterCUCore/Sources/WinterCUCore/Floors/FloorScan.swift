import ApplicationServices
import Foundation

/// The live inputs to the floor classifiers: small AX scans, bounded in elements AND wall time, run on the
/// target's pid queue through the injectable AX backend.
enum CUFloorScan {
    /// Wall-time budget of one scan. A scan that runs out answers with what it saw.
    static let budgetMs: Double = 150

    struct Deadline {
        let end: Double
        init(ms: Double = CUFloorScan.budgetMs) { end = Self.now() + ms }
        var passed: Bool { Self.now() >= end }
        static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
    }

    /// Window title, selected rows' names and AX identifiers of a System Settings window (≤ 400 elements).
    static func privacySignals(window: AXUIElement, ax: CUAXBackend) -> (texts: [String], identifiers: [String]) {
        var texts: [String] = []
        var ids: [String] = []
        if let t = ax.string(window, kAXTitleAttribute) { texts.append(t) }
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var seen = 0
        let deadline = Deadline()
        while !queue.isEmpty, seen < 400, !deadline.passed {
            let (e, depth) = queue.removeFirst()
            seen += 1
            guard let a = ax.copyMultiple(e, [kAXIdentifierAttribute, kAXSelectedAttribute, kAXTitleAttribute,
                                              kAXDescriptionAttribute, kAXChildrenAttribute]) else { continue }
            if let id = a[kAXIdentifierAttribute].flatMap(AX.stringValue) { ids.append(id) }
            if a[kAXSelectedAttribute].flatMap(AX.boolValue) == true {
                for k in [kAXTitleAttribute, kAXDescriptionAttribute] {
                    if let s = a[k].flatMap(AX.stringValue) { texts.append(s) }
                }
                // A selected sidebar row usually names its pane in a static-text child.
                for c in ax.elements(e, kAXChildrenAttribute).prefix(4) {
                    if let s = ax.string(c, kAXValueAttribute) ?? ax.string(c, kAXTitleAttribute) { texts.append(s) }
                }
            }
            if depth < 10, let kids = a[kAXChildrenAttribute], CFGetTypeID(kids) == CFArrayGetTypeID() {
                for k in (kids as! [AnyObject]) where CFGetTypeID(k) == AXUIElementGetTypeID() {
                    queue.append((k as! AXUIElement, depth + 1))
                }
            }
        }
        return (texts, ids)
    }

    static func isPrivacyPane(bundleId: String?, window: AXUIElement, ax: CUAXBackend) -> Bool {
        guard let b = bundleId, CUFloors.systemSettingsBundleIds.contains(b) else { return false }
        let s = privacySignals(window: window, ax: ax)
        return CUFloors.isPrivacyPane(bundleId: b, texts: s.texts, identifiers: s.identifiers)
    }

    /// The `NSSavePanel` filename field's identifier.
    static let saveNameFieldIdentifiers: Set<String> = ["saveAsNameTextField"]
    /// Panel subroles a save panel shows up as when it is its own window rather than a sheet.
    static let panelSubroles: Set<String> = [kAXDialogSubrole, kAXSystemDialogSubrole, kAXFloatingWindowSubrole]

    /// The save panel `e` sits in, if any: the nearest sheet (or dialog-like window) ancestor holding a
    /// filename field. An ordinary document window stops the walk without a scan, so this stays cheap.
    static func savePanel(containing e: AXUIElement, ax: CUAXBackend) -> AXUIElement? {
        var cur: AXUIElement? = e
        for _ in 0..<14 {
            guard let c = cur else { return nil }
            let role = ax.string(c, kAXRoleAttribute)
            // A sheet without a filename field may sit on a save panel ("Go to folder"): keep walking.
            if role == kAXSheetRole, filenameField(in: c, ax: ax) != nil { return c }
            if role == kAXWindowRole {
                guard let sub = ax.string(c, kAXSubroleAttribute), panelSubroles.contains(sub) else { return nil }
                return filenameField(in: c, ax: ax) != nil ? c : nil
            }
            cur = ax.element(c, kAXParentAttribute)
        }
        return nil
    }

    /// Every save panel the app has open: dialog-like windows and the sheets on any window.
    static func openSavePanels(pid: pid_t, ax: CUAXBackend) -> [AXUIElement] {
        let deadline = Deadline()
        var out: [AXUIElement] = []
        for w in ax.elements(ax.application(pid), kAXWindowsAttribute) {
            if deadline.passed { break }
            if let sub = ax.string(w, kAXSubroleAttribute), panelSubroles.contains(sub), filenameField(in: w, ax: ax) != nil {
                out.append(w)
                continue
            }
            for c in ax.elements(w, kAXChildrenAttribute) where ax.string(c, kAXRoleAttribute) == kAXSheetRole {
                if filenameField(in: c, ax: ax) != nil { out.append(c) }
            }
        }
        return out
    }

    static func filenameField(in panel: AXUIElement, ax: CUAXBackend) -> AXUIElement? {
        var queue: [(AXUIElement, Int)] = [(panel, 0)]
        var seen = 0
        let deadline = Deadline()
        while !queue.isEmpty, seen < 300, !deadline.passed {
            let (e, depth) = queue.removeFirst()
            seen += 1
            if let id = ax.string(e, kAXIdentifierAttribute), saveNameFieldIdentifiers.contains(id) { return e }
            if depth < 8 { queue.append(contentsOf: ax.elements(e, kAXChildrenAttribute).map { ($0, depth + 1) }) }
        }
        return nil
    }

    /// The folder the panel will save into, as a chain of display names, current folder first: the location
    /// pop-up's value, then the path items at the top of its menu (the menu lists the current folder and its
    /// ancestors first, then a separator, then favourites and recent places — only the part before the
    /// first separator is the path).
    static func locationChains(in panel: AXUIElement, ax: CUAXBackend) -> [[String]] {
        var out: [[String]] = []
        var queue: [(AXUIElement, Int)] = [(panel, 0)]
        var seen = 0
        let deadline = Deadline()
        while !queue.isEmpty, seen < 300, !deadline.passed {
            let (e, depth) = queue.removeFirst()
            seen += 1
            if ax.string(e, kAXRoleAttribute) == kAXPopUpButtonRole {
                var chain: [String] = []
                if let v = ax.string(e, kAXValueAttribute) { chain.append(v) }
                let menuItems = ax.elements(e, kAXChildrenAttribute)
                    .filter { ax.string($0, kAXRoleAttribute) == kAXMenuRole }
                    .flatMap { ax.elements($0, kAXChildrenAttribute) }
                for item in menuItems {
                    guard let title = ax.string(item, kAXTitleAttribute), !title.isEmpty else { break }
                    if chain.last != title { chain.append(title) }
                }
                if !chain.isEmpty { out.append(chain) }
                continue
            }
            if depth < 8 { queue.append(contentsOf: ax.elements(e, kAXChildrenAttribute).map { ($0, depth + 1) }) }
        }
        return out
    }

    /// Whether a panel currently points at a protected destination (file name, folder, or folder chain).
    static func panelIsProtected(_ panel: AXUIElement, ax: CUAXBackend) -> Bool {
        let name = filenameField(in: panel, ax: ax).flatMap { ax.string($0, kAXValueAttribute) } ?? ""
        let chains = locationChains(in: panel, ax: ax)
        if chains.isEmpty { return CUFloors.isProtectedSaveDestination(fileName: name, folderChain: []) }
        return chains.contains { CUFloors.isProtectedSaveDestination(fileName: name, folderChain: $0) }
    }

    /// What a scan of a window found: whether it holds a password or payment field, whether the scan saw
    /// the whole tree, and the elements that say they have keyboard focus (`AXFocused`).
    struct SensitiveScan {
        var sensitive: Bool
        var complete: Bool
        var focused: [AXUIElement]

        /// Typing blind is safe only when the whole window was seen and nothing in it is sensitive.
        var clear: Bool { complete && !sensitive }
    }

    static let sensitiveScanMaxElements = 5000
    static let sensitiveScanBudgetMs: Double = 1000
    static let sensitiveScanAttributes: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
        kAXPlaceholderValueAttribute, kAXIdentifierAttribute, "AXDOMIdentifier", kAXFocusedAttribute,
        kAXChildrenAttribute,
    ]

    /// Walks `roots` (the bound window, and the app's focused window when it is another) for a password or
    /// payment field, bounded in elements and wall time. Used only when the focus can't be read.
    static func sensitiveScan(roots: [AXUIElement], ax: CUAXBackend, maxElements: Int = sensitiveScanMaxElements,
                              budgetMs: Double = sensitiveScanBudgetMs) -> SensitiveScan {
        let deadline = Deadline(ms: budgetMs)
        var queue = roots
        var head = 0
        var seen = 0
        var focused: [AXUIElement] = []
        while head < queue.count {
            if seen >= maxElements || deadline.passed { return SensitiveScan(sensitive: false, complete: false, focused: focused) }
            let e = queue[head]
            head += 1
            seen += 1
            let a = ax.copyMultiple(e, sensitiveScanAttributes) ?? [:]
            let role = a[kAXRoleAttribute].flatMap(AX.stringValue) ?? ""
            let texts = [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXIdentifierAttribute,
                         "AXDOMIdentifier"].map { a[$0].flatMap(AX.stringValue) }
            if CUFloors.isSensitiveField(role: role, subrole: a[kAXSubroleAttribute].flatMap(AX.stringValue), texts: texts) {
                return SensitiveScan(sensitive: true, complete: false, focused: focused)
            }
            if a[kAXFocusedAttribute].flatMap(AX.boolValue) == true { focused.append(e) }
            if let v = a[kAXChildrenAttribute], CFGetTypeID(v) == CFArrayGetTypeID() {
                queue += (v as! [AnyObject]).compactMap {
                    CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil
                }
            }
        }
        return SensitiveScan(sensitive: false, complete: true, focused: focused)
    }

    static let savePathRefusal = CUError.refused(
        .savePath, "a save panel points at a protected location (a shell startup file, ~/.ssh, LaunchAgents, or Winter's or Claude's settings) — ask the user to finish or cancel it")

    /// Typing `text` into `e`: refused when `e` is in a save panel and the text names a protected path. With
    /// the focus unknown (`e` nil), any open save panel of the app counts.
    static func checkTypedIntoSavePanel(_ e: AXUIElement?, text: String, pid: pid_t, ax: CUAXBackend) throws {
        // The text test is free; the panel walk only runs for text that names a protected path.
        guard CUFloors.typedSavePathIsProtected(text) else { return }
        let inPanel = e.map { savePanel(containing: $0, ax: ax) != nil } ?? !openSavePanels(pid: pid, ax: ax).isEmpty
        if inPanel { throw savePathRefusal }
    }
}
