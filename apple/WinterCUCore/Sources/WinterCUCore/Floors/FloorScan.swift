import ApplicationServices
import Foundation

/// The live inputs to the floor classifiers: small, bounded AX scans run on the target's pid queue.
enum CUFloorScan {
    /// Window title, selected rows' names and AX identifiers of a System Settings window (≤ 400 elements).
    static func privacySignals(window: AXUIElement) -> (texts: [String], identifiers: [String]) {
        var texts: [String] = []
        var ids: [String] = []
        if let t = AX.string(window, kAXTitleAttribute) { texts.append(t) }
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var seen = 0
        while !queue.isEmpty, seen < 400 {
            let (e, depth) = queue.removeFirst()
            seen += 1
            guard let a = AX.copyMultiple(e, [kAXIdentifierAttribute, kAXSelectedAttribute, kAXTitleAttribute,
                                              kAXDescriptionAttribute, kAXChildrenAttribute]) else { continue }
            if let id = a[kAXIdentifierAttribute].flatMap(AX.stringValue) { ids.append(id) }
            if a[kAXSelectedAttribute].flatMap(AX.boolValue) == true {
                for k in [kAXTitleAttribute, kAXDescriptionAttribute] {
                    if let s = a[k].flatMap(AX.stringValue) { texts.append(s) }
                }
                // A selected sidebar row usually names its pane in a static-text child.
                for c in AX.elements(e, kAXChildrenAttribute).prefix(4) {
                    if let s = AX.string(c, kAXValueAttribute) ?? AX.string(c, kAXTitleAttribute) { texts.append(s) }
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

    static func isPrivacyPane(bundleId: String?, window: AXUIElement) -> Bool {
        guard let b = bundleId, CUFloors.systemSettingsBundleIds.contains(b) else { return false }
        let s = privacySignals(window: window)
        return CUFloors.isPrivacyPane(bundleId: b, texts: s.texts, identifiers: s.identifiers)
    }

    /// The `NSSavePanel` filename field's identifier.
    static let saveNameFieldIdentifiers: Set<String> = ["saveAsNameTextField"]
    /// Folders a save panel's location pop-up must not point at.
    static let protectedFolderNames: Set<String> = [".ssh", "LaunchAgents", "LaunchDaemons"]

    /// Panel subroles a save panel shows up as when it is its own window rather than a sheet.
    static let panelSubroles: Set<String> = [kAXDialogSubrole, kAXSystemDialogSubrole, kAXFloatingWindowSubrole]

    /// The save panel `e` sits in, if any: the nearest sheet (or dialog-like window) ancestor holding a
    /// filename field. An ordinary document window stops the walk without a scan, so this stays cheap.
    static func savePanel(containing e: AXUIElement) -> AXUIElement? {
        var cur: AXUIElement? = e
        for _ in 0..<14 {
            guard let c = cur else { return nil }
            let role = AX.string(c, kAXRoleAttribute)
            // A sheet without a filename field may sit on a save panel ("Go to folder"): keep walking.
            if role == kAXSheetRole, filenameField(in: c) != nil { return c }
            if role == kAXWindowRole {
                guard let sub = AX.string(c, kAXSubroleAttribute), panelSubroles.contains(sub) else { return nil }
                return filenameField(in: c) != nil ? c : nil
            }
            cur = AX.element(c, kAXParentAttribute)
        }
        return nil
    }

    static func filenameField(in panel: AXUIElement) -> AXUIElement? {
        var queue: [(AXUIElement, Int)] = [(panel, 0)]
        var seen = 0
        while !queue.isEmpty, seen < 300 {
            let (e, depth) = queue.removeFirst()
            seen += 1
            if let id = AX.string(e, kAXIdentifierAttribute), saveNameFieldIdentifiers.contains(id) { return e }
            if depth < 8 { queue.append(contentsOf: AX.elements(e, kAXChildrenAttribute).map { ($0, depth + 1) }) }
        }
        return nil
    }

    /// Location pop-up values of a panel (the folder it will save into, by display name).
    static func locationNames(in panel: AXUIElement) -> [String] {
        var out: [String] = []
        var queue: [(AXUIElement, Int)] = [(panel, 0)]
        var seen = 0
        while !queue.isEmpty, seen < 300 {
            let (e, depth) = queue.removeFirst()
            seen += 1
            if AX.string(e, kAXRoleAttribute) == kAXPopUpButtonRole, let v = AX.string(e, kAXValueAttribute) { out.append(v) }
            if depth < 8 { queue.append(contentsOf: AX.elements(e, kAXChildrenAttribute).map { ($0, depth + 1) }) }
        }
        return out
    }

    /// Typing `text` into `e`: refused when `e` is in a save panel and the text names a protected path.
    static func checkTypedIntoSavePanel(_ e: AXUIElement, text: String) throws {
        // The text test is free; the panel walk only runs for text that names a protected path.
        guard CUFloors.typedSavePathIsProtected(text), savePanel(containing: e) != nil else { return }
        throw CUError.refused(.savePath, "saving to that location is not allowed — ask the user to do it")
    }

    /// Pressing a button in a save panel: refused when the file name or the folder is protected.
    static func checkPressInSavePanel(_ e: AXUIElement) throws {
        guard let panel = savePanel(containing: e) else { return }
        let name = filenameField(in: panel).flatMap { AX.string($0, kAXValueAttribute) } ?? ""
        let folders = locationNames(in: panel)
        if CUFloors.typedSavePathIsProtected(name) || folders.contains(where: protectedFolderNames.contains) {
            throw CUError.refused(.savePath, "saving to that location is not allowed — ask the user to do it")
        }
    }
}
