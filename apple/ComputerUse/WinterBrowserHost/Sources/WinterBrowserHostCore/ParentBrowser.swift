import AppKit
import Darwin
import Foundation

/// The browser that started the host: its parent process. Chrome launches a native-messaging host from its main browser
/// process, so the parent's bundle id is the browser app's — what the daemon checks against the Chromium families and
/// what Winter's per-app card names.
public enum ParentBrowser {
    public static func resolve(pid: pid_t) -> (bundleId: String, pid: pid_t) {
        if let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier, !id.isEmpty { return (id, pid) }
        // A process LaunchServices does not list (a browser started from a script): its executable's enclosing app.
        if let path = executablePath(pid: pid), let app = enclosingApp(of: path), let id = Bundle(path: app)?.bundleIdentifier {
            return (id, pid)
        }
        return ("", pid)
    }

    static func executablePath(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard n > 0 else { return nil }
        return String(cString: buffer)
    }

    /// The OUTERMOST `.app` containing `path` (a browser's helper processes live in nested apps; its main process is the
    /// outer one's executable).
    static func enclosingApp(of path: String) -> String? {
        let parts = (path as NSString).standardizingPath.split(separator: "/").map(String.init)
        guard let i = parts.firstIndex(where: { $0.hasSuffix(".app") }) else { return nil }
        return "/" + parts[0...i].joined(separator: "/")
    }
}
