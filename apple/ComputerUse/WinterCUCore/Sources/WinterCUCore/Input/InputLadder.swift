import Foundation

/// The input ladder's choice for event-based input (spec §8), with no I/O. Rung 1 (pure AX) is chosen by
/// the action code itself when the element supports it; this decides between rungs 2–4 once events are
/// needed:
/// - rung 4 (foreground) for apps known to accept only foreground pointer input — refused with
///   `needs_foreground` unless the user agreed (`allowForeground`);
/// - rung 3 (SkyLight) for Chromium/Electron targets when the private path is on and resolved;
/// - rung 2 (public pid-routed events) otherwise, with a note when a Chromium target had to settle for it.
public enum CUInputLadder {
    public enum Rung: Int, Sendable, Comparable {
        case accessibility = 1, processEvents = 2, privatePath = 3, foreground = 4
        public static func < (a: Rung, b: Rung) -> Bool { a.rawValue < b.rawValue }
    }

    public struct Context: Sendable, Equatable {
        public var appName: String
        public var bundleId: String?
        public var isChromium: Bool
        public var privatePath: Bool
        public var skyLightAvailable: Bool
        public var allowForeground: Bool
        /// The input is pointer input at a coordinate (not a ref resolved to an element).
        public var pointerAtPoint: Bool

        public init(appName: String, bundleId: String?, isChromium: Bool, privatePath: Bool, skyLightAvailable: Bool,
                    allowForeground: Bool, pointerAtPoint: Bool) {
            self.appName = appName
            self.bundleId = bundleId
            self.isChromium = isChromium
            self.privatePath = privatePath
            self.skyLightAvailable = skyLightAvailable
            self.allowForeground = allowForeground
            self.pointerAtPoint = pointerAtPoint
        }
    }

    public struct Decision: Sendable, Equatable {
        public var rung: Rung
        public var detail: String?
    }

    /// Canvas-style apps that filter pid-routed pointer events entirely: a coordinate click there only works
    /// with the real pointer in front.
    public static let foregroundPointerApps: Set<String> = [
        "org.blenderfoundation.blender", "com.figma.Desktop", "com.unity3d.UnityEditor5.x", "com.unity3d.unityhub",
        "org.godotengine.godot", "com.adobe.illustrator", "com.adobe.Photoshop", "com.bohemiancoding.sketch3",
        "com.autodesk.fusion360", "com.valvesoftware.steam",
    ]

    public static func decideEvents(_ c: Context) throws -> Decision {
        if c.pointerAtPoint, let b = c.bundleId, foregroundPointerApps.contains(b) {
            guard c.allowForeground else { throw CUError.needsForeground(c.appName) }
            return Decision(rung: .foreground, detail: "\(c.appName) needs the real pointer in front")
        }
        if c.isChromium {
            if c.privatePath && c.skyLightAvailable { return Decision(rung: .privatePath, detail: nil) }
            let why = c.privatePath ? "the private event path is unavailable on this macOS"
                                    : "the private event path is off in Settings"
            return Decision(rung: .processEvents,
                            detail: "\(c.appName) is Chromium-based and may ignore background events — \(why)")
        }
        return Decision(rung: .processEvents, detail: nil)
    }

    static func route(for rung: Rung) -> CURoute {
        switch rung {
        case .accessibility, .processEvents: return .publicPid
        case .privatePath: return .skyLight
        case .foreground: return .hid
        }
    }
}
