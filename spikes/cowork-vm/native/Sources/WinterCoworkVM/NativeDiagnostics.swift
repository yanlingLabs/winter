import Foundation
import ContainerizationError

enum NativeDiagnostics {
    static func safeMessage(_ value: String, fixtureRoot: URL?) -> String {
        var result = String(value.prefix(2048))
        if let urls = try? NSRegularExpression(pattern: "https?://[^\\s\\\"<>]+") {
            result = urls.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "<redacted-url>")
        }
        guard let paths = try? NSRegularExpression(pattern: "(?:file://)?/[A-Za-z0-9_./@%:+~\\-]+") else { return result }
        let matches = paths.matches(in: result, range: NSRange(result.startIndex..., in: result))
        var allowed: [String] = []
        if let fixtureRoot {
            allowed.append(fixtureRoot.path)
            if fixtureRoot.path.hasPrefix("/var/") { allowed.append("/private" + fixtureRoot.path) }
        }
        for match in matches.reversed() {
            guard let range = Range(match.range, in: result) else { continue }
            let path = String(result[range]).replacingOccurrences(of: "file://", with: "")
            if !allowed.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) {
                result.replaceSubrange(range, with: "<redacted-path>")
            }
        }
        return result
    }

    static func chain(_ error: any Error, fixtureRoot: URL?) -> [[String: Any]] {
        var output: [[String: Any]] = []
        var next: (any Error)? = error
        var seen: Set<ObjectIdentifier> = []
        var retained: [NSError] = []
        while let current = next, output.count < 8 {
            let native = current as NSError
            guard seen.insert(ObjectIdentifier(native)).inserted else { break }
            // Keep bridged struct errors alive so a reused bridge allocation
            // cannot be mistaken for an underlying NSError cycle.
            retained.append(native)
            let container = current as? ContainerizationError
            var node: [String: Any] = ["domain": String(native.domain.prefix(200)), "code": native.code,
                                      "message": safeMessage(container?.message ?? native.localizedDescription, fixtureRoot: fixtureRoot)]
            if let container { node["containerizationCode"] = container.code.description }
            output.append(node)
            next = container?.cause ?? (native.userInfo[NSUnderlyingErrorKey] as? any Error)
        }
        withExtendedLifetime(retained) {}
        return output
    }
}
