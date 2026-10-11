import AppKit

// The fixture's one scripting command, `mark fixture` (WinterCUFixture.sdef): it logs what arrived — the text, the
// integer, the boolean, the enumerator and the list — as a `script.mark` event and returns `marked: <text>`. The live
// suite's adapters group runs it through ComputerV2's generated `app.dict.markFixture(…)` wrapper, but only when
// Winter Computer Use already holds the Automation grant for the fixture (never asked by a test).

@objc(WCUMarkCommand)
final class WCUMarkCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        let text = directParameter as? String ?? ""
        let args = evaluatedArguments ?? [:]
        let fields = WCUMarkCommand.fields(text: text, args: args)
        MainActor.assumeIsolated { Fixture.shared?.emit("script.mark", fields) }
        return "marked: \(text)"
    }

    /// The log fields for one call. Pure (the self-test drives it).
    static func fields(text: String, args: [String: Any]) -> [(String, JV)] {
        var out: [(String, JV)] = [("text", .str(text))]
        if let n = args["repeats"] as? NSNumber { out.append(("repeats", .int(n.intValue))) }
        if let b = args["flagged"] as? NSNumber { out.append(("flagged", .bool(b.boolValue))) }
        if let t = args["tone"] as? NSNumber { out.append(("tone", .str(toneName(OSType(truncating: t))))) }
        if let tags = args["tags"] as? [String] { out.append(("tags", .arr(tags.map { .str($0) }))) }
        return out
    }

    /// The enumerator's name for its code (`WCpl` plain, `WClo` loud).
    static func toneName(_ code: OSType) -> String {
        switch code {
        case fourCharCode("WCpl"): return "plain"
        case fourCharCode("WClo"): return "loud"
        default: return "unknown"
        }
    }

    static func fourCharCode(_ s: String) -> OSType {
        s.utf8.prefix(4).reduce(0) { ($0 << 8) | OSType($1) }
    }
}
