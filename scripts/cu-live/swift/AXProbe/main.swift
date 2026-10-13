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
case "set":
    guard args.count == 5, ["AXManualAccessibility", "AXEnhancedUserInterface"].contains(args[3]) else { out(["usage": "set <pid> AXManualAccessibility|AXEnhancedUserInterface true|false"]); exit(64) }
    let err = AXUIElementSetAttributeValue(app, args[3] as CFString, (args[4] == "true" ? kCFBooleanTrue : kCFBooleanFalse)!)
    out(["error": Int(err.rawValue)])
default:
    out(["usage": "web <pid> | set <pid> <attr> <true|false>"]); exit(64)
}
