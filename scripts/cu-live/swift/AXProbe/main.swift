// cu-live-axprobe — the chrome group's INDEPENDENT accessibility reader (finding A, 2026-10-13): what a browser's own
// accessibility tree holds, read by a second client beside the helper, so a page missing from the helper's state can
// be told apart from a page the browser never built. Runs with the runner's own Accessibility access (none: it says
// so). Reads, and sets one app-level switch when asked; never sends input, never touches another app than the pid.
//
//   cu-live-axprobe web <pid>                 → {"trusted":…, "manual":…, "enhanced":…, "windows":[{title, webAreas, webChildren, nodes}]}
//   cu-live-axprobe set <pid> <attr> <true|false>  → {"error": <AXError code>}   (AXManualAccessibility / AXEnhancedUserInterface only)
import ApplicationServices
import Foundation

func out(_ o: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

func boolAttr(_ e: AXUIElement, _ name: String) -> Any {
    guard let v = attr(e, name) else { return NSNull() }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    return String(describing: v)
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[2]) else { out(["usage": "web <pid> | set <pid> <attr> <true|false>"]); exit(64) }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2)

switch args[1] {
case "web":
    var windows: [[String: Any]] = []
    for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
        var nodes = 0, webAreas = 0, webChildren = 0
        var queue = [(w, 0)]
        var next = 0
        while next < queue.count, nodes < 6000 {
            let (e, depth) = queue[next]; next += 1; nodes += 1
            if (attr(e, kAXRoleAttribute) as? String) == "AXWebArea" { webAreas += 1; webChildren += children(e).count }
            if depth < 60 { queue.append(contentsOf: children(e).map { ($0, depth + 1) }) }
        }
        windows.append(["title": (attr(w, kAXTitleAttribute) as? String) ?? "", "nodes": nodes, "webAreas": webAreas, "webChildren": webChildren])
    }
    out(["trusted": AXIsProcessTrusted(), "manual": boolAttr(app, "AXManualAccessibility"), "enhanced": boolAttr(app, "AXEnhancedUserInterface"), "windows": windows])
case "attrs":
    // attrs <pid> <role> <name>: every attribute (name, value, settable) of the first element of that role named so.
    guard args.count == 5 else { out(["usage": "attrs <pid> <role> <name>"]); exit(64) }
    func named(_ e: AXUIElement) -> Bool {
        [kAXTitleAttribute, kAXDescriptionAttribute].contains { (attr(e, $0) as? String) == args[4] }
            || ((attr(e, kAXTitleUIElementAttribute)).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? attr($0 as! AXUIElement, kAXValueAttribute) as? String : nil } == args[4])
    }
    var queue = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).map { ($0, 0) }
    var next = 0
    var found: AXUIElement?
    while next < queue.count, next < 8000 {
        let (e, d) = queue[next]; next += 1
        if (attr(e, kAXRoleAttribute) as? String) == args[3], named(e) { found = e; break }
        if d < 60 { queue.append(contentsOf: children(e).map { ($0, d + 1) }) }
    }
    guard let e = found else { out(["found": false]); exit(0) }
    var names: CFArray?
    AXUIElementCopyAttributeNames(e, &names)
    var values: [String: String] = [:], settable: [String: Bool] = [:]
    for n in (names as? [String]) ?? [] {
        values[n] = attr(e, n).map { String(describing: $0).replacingOccurrences(of: "\n", with: " ").prefix(160).description } ?? "<no value>"
        var s: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(e, n as CFString, &s) == .success { settable[n] = s.boolValue }
    }
    var params: CFArray?
    AXUIElementCopyParameterizedAttributeNames(e, &params)
    var actions: CFArray?
    AXUIElementCopyActionNames(e, &actions)
    out(["found": true, "names": (names as? [String]) ?? [], "values": values, "settable": settable,
         "parameterized": (params as? [String]) ?? [], "actions": (actions as? [String]) ?? []])
case "focus-trace":
    // focus-trace <pid> <ms> <interval>: one line per sample — the app's focused element, the focused window's, and
    // which text fields say AXFocused (by title).
    guard args.count == 5, let ms = Double(args[3]), let every = UInt32(args[4]) else { out(["usage": "focus-trace <pid> <ms> <interval>"]); exit(64) }
    func desc(_ v: CFTypeRef?) -> String {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return "nil" }
        let e = v as! AXUIElement
        let role = attr(e, kAXRoleAttribute) as? String ?? "?"
        let title = attr(e, kAXTitleAttribute) as? String ?? attr(e, kAXDescriptionAttribute) as? String ?? ""
        let label = attr(e, kAXTitleUIElementAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? attr($0 as! AXUIElement, kAXValueAttribute) as? String : nil } ?? ""
        return "\(role) \"\(title.isEmpty ? label : title)\""
    }
    let t0 = Date().timeIntervalSince1970 * 1000
    var lastLine = ""
    while Date().timeIntervalSince1970 * 1000 - t0 < ms {
        let now = Date().timeIntervalSince1970 * 1000
        let appF = desc(attr(app, kAXFocusedUIElementAttribute))
        let win = attr(app, kAXFocusedWindowAttribute)
        let winF = win.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? desc(attr($0 as! AXUIElement, kAXFocusedUIElementAttribute)) : nil } ?? "no window"
        let line = "app=\(appF) win=\(winF)"
        if line != lastLine { out(["t": Int(now), "app": appF, "window": winF]); lastLine = line }
        usleep(every * 1000)
    }
    out(["t": Int(Date().timeIntervalSince1970 * 1000), "end": true])
case "set":
    guard args.count == 5, ["AXManualAccessibility", "AXEnhancedUserInterface"].contains(args[3]) else { out(["usage": "set <pid> AXManualAccessibility|AXEnhancedUserInterface true|false"]); exit(64) }
    let err = AXUIElementSetAttributeValue(app, args[3] as CFString, (args[4] == "true" ? kCFBooleanTrue : kCFBooleanFalse)!)
    out(["error": Int(err.rawValue)])
default:
    out(["usage": "web <pid> | set <pid> <attr> <true|false>"]); exit(64)
}
