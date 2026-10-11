import Carbon
import Foundation

/// A compact summary of an app's scripting dictionary (its sdef): suites, then commands with their
/// parameters, then classes with their properties and elements — filtered by a search, and capped (the model
/// reads it to write `applescript()` against the app). Read from the app's own files, never by asking the app.
enum CUScriptingDictionary {
    struct Parameter: Equatable {
        var name: String
        var type: String
        var optional: Bool
        var description: String = ""
    }
    struct Command: Equatable {
        var name: String
        var description: String
        var direct: Parameter?
        var parameters: [Parameter]
        var result: String?
        /// The suite it is declared in, and its 8-character Apple Event code (`aevtodoc`).
        var suite: String = ""
        var code: String = ""
        /// Declared in a hidden suite (left out of `target.scriptingCommands`).
        var hiddenSuite: Bool = false
    }
    struct Property: Equatable { var name: String; var type: String; var readOnly: Bool }
    struct Class: Equatable {
        var name: String
        var description: String
        var properties: [Property]
        var elements: [String]
        var extends: Bool
    }
    struct Model: Equatable {
        var suites: [String]
        var commands: [Command]
        var classes: [Class]
        /// Enumeration name (lowercased) → its enumerators' names, hidden ones left out.
        var enumerations: [String: [String]] = [:]
    }

    // MARK: reading

    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cache: [String: Model] = [:]

    /// The app's dictionary, cached per bundle path and version; nil when the app is not scriptable.
    static func model(appURL: URL) -> Model? {
        let version = Bundle(url: appURL)?.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        let key = appURL.path + "\u{1F}" + version
        if let hit = cacheLock.withLock({ cache[key] }) { return hit }
        var data: Unmanaged<CFData>?
        guard OSACopyScriptingDefinitionFromURL(appURL as CFURL, 0, &data) == noErr, let sdef = data?.takeRetainedValue() as Data?,
              let model = try? parse(sdef) else { return nil }
        cacheLock.withLock { cache[key] = model }
        return model
    }

    /// The sdef's suites, commands and classes (XIncludes resolved: Cocoa apps include the standard suite).
    static func parse(_ data: Data) throws -> Model {
        let doc = try XMLDocument(data: data, options: [.documentXInclude])
        var model = Model(suites: [], commands: [], classes: [])
        for suite in try doc.nodes(forXPath: "//suite").compactMap({ $0 as? XMLElement }) {
            let suiteName = suite.attribute(forName: "name")?.stringValue ?? ""
            let suiteHidden = suite.attribute(forName: "hidden")?.stringValue == "yes"
            if !suiteName.isEmpty { model.suites.append(suiteName) }
            for e in suite.elements(forName: "enumeration") {
                guard let name = e.attribute(forName: "name")?.stringValue else { continue }
                let names = e.elements(forName: "enumerator").compactMap { x -> String? in
                    x.attribute(forName: "hidden")?.stringValue == "yes" ? nil : x.attribute(forName: "name")?.stringValue
                }
                model.enumerations[name.lowercased(), default: []] += names
            }
            for c in suite.elements(forName: "command") {
                guard let name = c.attribute(forName: "name")?.stringValue, c.attribute(forName: "hidden")?.stringValue != "yes" else { continue }
                let direct = c.elements(forName: "direct-parameter").first.map {
                    Parameter(name: "", type: typeOf($0), optional: $0.attribute(forName: "optional")?.stringValue == "yes",
                              description: $0.attribute(forName: "description")?.stringValue ?? "")
                }
                let params = c.elements(forName: "parameter").compactMap { p -> Parameter? in
                    guard let n = p.attribute(forName: "name")?.stringValue, p.attribute(forName: "hidden")?.stringValue != "yes" else { return nil }
                    return Parameter(name: n, type: typeOf(p), optional: p.attribute(forName: "optional")?.stringValue == "yes",
                                     description: p.attribute(forName: "description")?.stringValue ?? "")
                }
                let result = c.elements(forName: "result").first.map(typeOf)
                model.commands.append(Command(name: name, description: c.attribute(forName: "description")?.stringValue ?? "",
                                              direct: direct, parameters: params, result: result, suite: suiteName,
                                              code: c.attribute(forName: "code")?.stringValue ?? "", hiddenSuite: suiteHidden))
            }
            for tag in ["class", "class-extension"] {
                for k in suite.elements(forName: tag) {
                    guard k.attribute(forName: "hidden")?.stringValue != "yes",
                          let name = k.attribute(forName: tag == "class" ? "name" : "extends")?.stringValue else { continue }
                    let props = k.elements(forName: "property").compactMap { p -> Property? in
                        guard let n = p.attribute(forName: "name")?.stringValue, p.attribute(forName: "hidden")?.stringValue != "yes" else { return nil }
                        return Property(name: n, type: typeOf(p), readOnly: p.attribute(forName: "access")?.stringValue == "r")
                    }
                    let elements = k.elements(forName: "element").compactMap { $0.attribute(forName: "type")?.stringValue }
                    model.classes.append(Class(name: name, description: k.attribute(forName: "description")?.stringValue ?? "",
                                               properties: props, elements: elements, extends: tag == "class-extension"))
                }
            }
        }
        return model
    }

    private static func typeOf(_ e: XMLElement) -> String {
        if let t = e.attribute(forName: "type")?.stringValue { return t }
        let types = e.elements(forName: "type").compactMap { t -> String? in
            guard let name = t.attribute(forName: "type")?.stringValue else { return nil }
            return t.attribute(forName: "list")?.stringValue == "yes" ? "list of \(name)" : name
        }
        return types.isEmpty ? "any" : types.joined(separator: " | ")
    }

    // MARK: the commands, structured (`target.scriptingCommands`)

    /// At most this many commands are listed.
    static let maxCommands = 300

    /// Does the app ask to be asked for its dictionary (`OSAScriptingDefinition = dynamic`)? Reading such a dictionary
    /// sends the app an Apple Event, which a bind must never do (it could raise macOS's Automation question): it is
    /// then left unread.
    static func isDynamic(appURL: URL) -> Bool {
        (Bundle(url: appURL)?.infoDictionary?["OSAScriptingDefinition"] as? String)?.lowercased() == "dynamic"
    }

    /// The `"clas/id"` key of an 8-character event code, or nil when it isn't one.
    static func eventKey(_ code: String) -> String? {
        let chars = Array(code)
        guard chars.count == 8 else { return nil }
        return String(chars[0..<4]) + "/" + String(chars[4..<8])
    }

    /// A JavaScript door by any name: a command whose name, or one of whose parameters, says JavaScript (Safari's
    /// `do JavaScript`, a Chromium browser's `execute … javascript`).
    static func isJavaScriptDoor(_ c: Command) -> Bool {
        c.name.lowercased().contains("javascript") || c.parameters.contains { $0.name.lowercased().contains("javascript") }
    }

    /// The events of the app's JavaScript doors, refused for a script run against it whatever their code
    /// (`CUAppleScriptRunner`'s per-run refusals).
    static func javaScriptDoorRefusals(_ model: Model) -> [String: String] {
        var out: [String: String] = [:]
        for c in model.commands where isJavaScriptDoor(c) {
            if let key = eventKey(c.code) { out[key] = "`\(c.name)` runs JavaScript in a page — read it with state() or find()" }
        }
        return out
    }

    /// The commands a client may wrap: hidden ones (and hidden suites) out, the helper's own refused doors out (a
    /// wrapper for one would only fail), searched like `render`, at most `maxCommands`.
    static func commands(_ model: Model, search: String?) -> (commands: [ScriptingCommandInfo], truncated: Bool) {
        let q = search?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtering = q.map { !$0.isEmpty } ?? false
        func hit(_ s: String) -> Bool { q.map { s.lowercased().contains($0) } ?? true }
        func cap(_ s: String) -> String? { s.isEmpty ? nil : String(s.prefix(200)) }
        func enumerators(_ type: String) -> [String]? {
            let names = type.components(separatedBy: " | ").map { $0.hasPrefix("list of ") ? String($0.dropFirst(8)) : $0 }
            let found = names.flatMap { model.enumerations[$0.lowercased()] ?? [] }
            return found.isEmpty ? nil : found
        }
        var out: [ScriptingCommandInfo] = []
        var matched = 0
        for c in model.commands where !c.hiddenSuite {
            guard let key = eventKey(c.code), !CUAppleScriptPolicy.refusesEverywhere(key), !isJavaScriptDoor(c) else { continue }
            if filtering && !(hit(c.name) || hit(c.description) || c.parameters.contains { hit($0.name) }) { continue }
            matched += 1
            guard out.count < maxCommands else { continue }
            out.append(ScriptingCommandInfo(
                name: c.name, suite: c.suite, eventCode: c.code, description: cap(c.description),
                direct: c.direct.map { ScriptingCommandDirect(type: $0.type, optional: $0.optional, description: cap($0.description)) },
                params: c.parameters.map { ScriptingCommandParam(name: $0.name, type: $0.type, optional: $0.optional,
                                                                  description: cap($0.description), enumerators: enumerators($0.type)) },
                result: c.result.map { ScriptingCommandResultType(type: $0) }))
        }
        return (out, matched > out.count)
    }

    // MARK: the summary

    /// The summary text, at most `capBytes` (UTF-8), and whether anything was left out.
    static func render(_ model: Model, app: String, search: String?, capBytes: Int = 6_000) -> (text: String, truncated: Bool) {
        let q = search?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        func hit(_ s: String) -> Bool { q.map { !$0.isEmpty && s.lowercased().contains($0) } ?? true }
        let filtering = q.map { !$0.isEmpty } ?? false

        let commands = model.commands.filter { c in
            !filtering || hit(c.name) || hit(c.description) || c.parameters.contains { hit($0.name) }
        }
        let classes: [Class] = model.classes.compactMap { k in
            guard filtering else { return k }
            if hit(k.name) || hit(k.description) { return k }
            let props = k.properties.filter { hit($0.name) }
            let elements = k.elements.filter(hit)
            guard !props.isEmpty || !elements.isEmpty else { return nil }
            return Class(name: k.name, description: "", properties: props, elements: elements, extends: k.extends)
        }

        var lines = ["\(app) — scripting dictionary\(filtering ? " matching “\(search ?? "")”" : "") (suites: \(model.suites.joined(separator: ", ")))"]
        var body: [String] = []
        if !commands.isEmpty { body.append("Commands:") }
        for c in commands {
            var line = "- \(c.name)"
            if let d = c.direct { line += d.optional ? " [\(d.type)]" : " <\(d.type)>" }
            for p in c.parameters { line += p.optional ? " [\(p.name) <\(p.type)>]" : " \(p.name) <\(p.type)>" }
            if let r = c.result { line += " → \(r)" }
            if !c.description.isEmpty { line += " — \(c.description)" }
            body.append(line)
        }
        if !classes.isEmpty { body.append("Classes:") }
        for k in classes {
            var line = "- \(k.name)\(k.extends ? " (more)" : "")"
            if !k.description.isEmpty { line += " — \(k.description)" }
            if !k.properties.isEmpty {
                line += "; properties: " + k.properties.map { "\($0.name) (\($0.type)\($0.readOnly ? ", read-only" : ""))" }.joined(separator: ", ")
            }
            if !k.elements.isEmpty { line += "; elements: " + k.elements.joined(separator: ", ") }
            body.append(line)
        }
        if body.isEmpty { body.append(filtering ? "(nothing matches — try a shorter search, or none)" : "(the dictionary is empty)") }

        var size = lines[0].utf8.count + 1
        var shown = 0
        for line in body {
            let cost = line.utf8.count + 1
            if size + cost > capBytes { break }
            lines.append(line)
            size += cost
            shown += 1
        }
        let truncated = shown < body.count
        if truncated {
            lines.append("… \(body.count - shown) more lines not shown — narrow it with scriptingDictionary({ search: \"…\" }) (a command, class or property name)")
        }
        return (lines.joined(separator: "\n"), truncated)
    }
}
