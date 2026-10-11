import Foundation

// The params/result structs of every helper RPC method `CUCore` serves (spine §2.1, §3b). Stored property
// names ARE the JSON keys, so the shell decodes a request's `params` straight into `<Name>Params` and
// encodes `<Name>Result` straight back. Frames and points are `[Double]` arrays (`[x, y, w, h]`, `[x, y]`).
// Unions live in CUUnions.swift.

/// An empty `{}` result (release, cancel, turn/session ended).
public struct CUEmpty: Codable, Sendable, Equatable { public init() {} }

public enum CUPermissionKind: String, Codable, Sendable { case accessibility, screenRecording }

public struct CUPermissions: Codable, Sendable, Equatable {
    public var accessibility: Bool
    public var screenRecording: Bool
    public init(accessibility: Bool, screenRecording: Bool) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
    }
}

// MARK: - status & permissions

public typealias StatusParams = CUEmpty
public struct StatusResult: Codable, Sendable, Equatable {
    public var helperVersion: String
    public var permissions: CUPermissions
    public init(helperVersion: String, permissions: CUPermissions) {
        self.helperVersion = helperVersion
        self.permissions = permissions
    }
}

public struct PermissionsRequestParams: Codable, Sendable, Equatable {
    public var kind: CUPermissionKind
    public init(kind: CUPermissionKind) { self.kind = kind }
}
public struct PermissionsRequestResult: Codable, Sendable, Equatable {
    public var opened: Bool
    public init(opened: Bool) {
        self.opened = opened
    }
}

// MARK: - discovery

public typealias AppsListParams = CUEmpty
public struct CUAppInfo: Codable, Sendable, Equatable {
    public var name: String
    public var bundleId: String
    public var running: Bool
    public var pid: Int32?
    public init(name: String, bundleId: String, running: Bool, pid: Int32? = nil) {
        self.name = name
        self.bundleId = bundleId
        self.running = running
        self.pid = pid
    }
}
public struct AppsListResult: Codable, Sendable, Equatable {
    public var apps: [CUAppInfo]
    public init(apps: [CUAppInfo]) {
        self.apps = apps
    }
}

public typealias ScreenWindowsParams = CUEmpty
public struct CUScreenWindow: Codable, Sendable, Equatable {
    public var app: String
    public var bundleId: String
    public var pid: Int32
    public var windowId: UInt32
    public var title: String
    public var frame: [Double]
    public var onScreen: Bool
    public init(app: String, bundleId: String, pid: Int32, windowId: UInt32, title: String, frame: [Double], onScreen: Bool) {
        self.app = app
        self.bundleId = bundleId
        self.pid = pid
        self.windowId = windowId
        self.title = title
        self.frame = frame
        self.onScreen = onScreen
    }
}
public struct ScreenWindowsResult: Codable, Sendable, Equatable {
    public var windows: [CUScreenWindow]
    public init(windows: [CUScreenWindow]) {
        self.windows = windows
    }
}

// MARK: - binding

public struct TargetBindParams: Codable, Sendable, Equatable {
    public var sessionId: String
    /// A name, a bundle id or a path.
    public var app: String
    public var window: CUWindowSelector?
    public var mirror: Bool
    /// The `computerUse.privateEventPath` setting (absent → true, its default): may the bind reach a window
    /// on another Space or in full screen through private APIs (and move it here when needed)?
    public var privatePath: Bool?
    public init(sessionId: String, app: String, window: CUWindowSelector? = nil, mirror: Bool, privatePath: Bool? = nil) {
        self.sessionId = sessionId
        self.app = app
        self.window = window
        self.mirror = mirror
        self.privatePath = privatePath
    }
}
public struct CUBoundApp: Codable, Sendable, Equatable {
    public var name: String
    public var bundleId: String
    public var pid: Int32
    /// helper 1.8.0, on `target.bind`: the running bundle's path and its `CFBundleShortVersionString`.
    public var path: String?
    public var version: String?
    public init(name: String, bundleId: String, pid: Int32, path: String? = nil, version: String? = nil) {
        self.name = name
        self.bundleId = bundleId
        self.pid = pid
        self.path = path
        self.version = version
    }
}
public struct CUWindowInfo: Codable, Sendable, Equatable {
    public var id: UInt32
    public var title: String
    public var frame: [Double]
    public init(id: UInt32, title: String, frame: [Double]) {
        self.id = id
        self.title = title
        self.frame = frame
    }
}
public struct TargetBindResult: Codable, Sendable, Equatable {
    public var targetId: String
    public var app: CUBoundApp
    public var window: CUWindowInfo
    /// What the bind had to do to get a usable window (bound one on another Space in place, moved one here,
    /// opened a new one), for the model; absent when it simply bound a window on this desktop.
    public var detail: String?
    public init(targetId: String, app: CUBoundApp, window: CUWindowInfo, detail: String? = nil) {
        self.targetId = targetId
        self.app = app
        self.window = window
        self.detail = detail
    }
}

public struct TargetUseWindowParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var window: CUWindowSelector
    public init(targetId: String, window: CUWindowSelector) {
        self.targetId = targetId
        self.window = window
    }
}
public struct TargetUseWindowResult: Codable, Sendable, Equatable {
    public var window: CUWindowInfo
    public var detail: String?
    public init(window: CUWindowInfo, detail: String? = nil) {
        self.window = window
        self.detail = detail
    }
}

public struct TargetWindowsParams: Codable, Sendable, Equatable {
    public var targetId: String
    public init(targetId: String) {
        self.targetId = targetId
    }
}
public struct CUTargetWindow: Codable, Sendable, Equatable {
    public var id: UInt32
    public var title: String
    public var focused: Bool
    public init(id: UInt32, title: String, focused: Bool) {
        self.id = id
        self.title = title
        self.focused = focused
    }
}
public struct TargetWindowsResult: Codable, Sendable, Equatable {
    public var windows: [CUTargetWindow]
    public init(windows: [CUTargetWindow]) {
        self.windows = windows
    }
}

public struct TargetReleaseParams: Codable, Sendable, Equatable {
    public var targetId: String
    public init(targetId: String) {
        self.targetId = targetId
    }
}
public typealias TargetReleaseResult = CUEmpty

// MARK: - observation

public struct CUSettleOption: Codable, Sendable, Equatable {
    public var maxMs: Int
    public init(maxMs: Int) { self.maxMs = maxMs }
}

public struct TargetSnapshotParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var since: String?
    public var full: Bool?
    public var within: Int?
    public var settle: CUSettleOption?
    /// NOT in the pinned §2.1 shape: an optional extension so `cancel {callId}` can reach a settle wait.
    /// Absent → the wait is still bounded by `settle.maxMs` and honours Swift task cancellation.
    public var callId: String?
    public init(targetId: String, since: String? = nil, full: Bool? = nil, within: Int? = nil,
                settle: CUSettleOption? = nil, callId: String? = nil) {
        self.targetId = targetId
        self.since = since
        self.full = full
        self.within = within
        self.settle = settle
        self.callId = callId
    }
}
public struct TargetSnapshotResult: Codable, Sendable, Equatable {
    public var snapshotId: String
    public var text: String
    public var isDiff: Bool
    public var changedRatio: Double
    public var settled: Bool
    public var waitedMs: Int
    public init(snapshotId: String, text: String, isDiff: Bool, changedRatio: Double, settled: Bool, waitedMs: Int) {
        self.snapshotId = snapshotId
        self.text = text
        self.isDiff = isDiff
        self.changedRatio = changedRatio
        self.settled = settled
        self.waitedMs = waitedMs
    }
}

public struct TargetFindParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var query: CUFindQuery
    /// Optional extension (see `TargetSnapshotParams.callId`): a cancel reaches a window watched through a transition.
    public var callId: String?
    public init(targetId: String, query: CUFindQuery, callId: String? = nil) {
        self.targetId = targetId
        self.query = query
        self.callId = callId
    }
}
public struct CUElementSummary: Codable, Sendable, Equatable {
    public var ref: Int
    public var role: String
    public var name: String?
    public var value: String?
    /// The state words state() shows for it (`disabled`, `selected`, `checked`, `focused`, …); absent when none.
    public var states: [String]?
    public init(ref: Int, role: String, name: String? = nil, value: String? = nil, states: [String]? = nil) {
        self.ref = ref
        self.role = role
        self.name = name
        self.value = value
        self.states = states
    }
}
public struct TargetFindResult: Codable, Sendable, Equatable {
    public var elements: [CUElementSummary]
    /// The window's page number (as state() headers say it); nil when it shows no web page.
    public var page: Int?
    /// The page changed since the last state(), or the read was cut short: said.
    public var note: String?
    public init(elements: [CUElementSummary], page: Int? = nil, note: String? = nil) {
        self.elements = elements
        self.page = page
        self.note = note
    }
}

public struct CUImageBudget: Codable, Sendable, Equatable {
    public var maxLongEdge: Int
    public var tile: Int?
    public var maxTiles: Int?
    public var quality: Double
    /// When the encoded JPEG is over this many bytes, the SAME captured image is encoded again at the next lower
    /// quality (0.8, 0.6, 0.45, 0.3 — only those below `quality`) and the first that fits is returned, else the
    /// last: a picture is captured once (a visited live shot is never taken again for size).
    public var maxBytes: Int?
    public init(maxLongEdge: Int, tile: Int? = nil, maxTiles: Int? = nil, quality: Double, maxBytes: Int? = nil) {
        self.maxBytes = maxBytes
        self.maxLongEdge = maxLongEdge
        self.tile = tile
        self.maxTiles = maxTiles
        self.quality = quality
    }
}

public struct TargetScreenshotParams: Codable, Sendable, Equatable {
    public var targetId: String
    /// Window-relative points.
    public var region: [Double]?
    public var budget: CUImageBudget
    public var settle: CUSettleOption?
    /// Optional extension (see `TargetSnapshotParams.callId`).
    public var callId: String?
    /// The model needs what is on screen NOW. A window on screen is captured as ever; a window on another
    /// desktop is taken from the window server first, and returned when that picture is known live (it changed
    /// since the last one); otherwise it needs a moment on its desktop (`needs_desktop_visit`, `why: "live"`).
    public var live: Bool?
    /// The user allowed a brief visit to the window's desktop for this (the daemon's desktop-switch prompt).
    public var desktopVisit: Bool?
    /// With `desktopVisit`: how long that visit may last (the primitive's own deadline) — the guardian's visit mode
    /// lasts that long, clamped to 10…330 s (absent: 10 s).
    public var visitMaxMs: Int?
    public init(targetId: String, region: [Double]? = nil, budget: CUImageBudget, settle: CUSettleOption? = nil,
                callId: String? = nil, live: Bool? = nil, desktopVisit: Bool? = nil, visitMaxMs: Int? = nil) {
        self.visitMaxMs = visitMaxMs
        self.targetId = targetId
        self.region = region
        self.budget = budget
        self.settle = settle
        self.callId = callId
        self.live = live
        self.desktopVisit = desktopVisit
    }
}

/// One CLOSED desktop visit (user ruling 2026-10-10, 5d): the user was taken to a window's desktop for a stretch of
/// work — every primitive that needed it — and brought back after the last one. `visit.close` returns each once,
/// and the `desktopVisited` notification announces it.
public struct CUVisitReport: Codable, Sendable, Equatable {
    /// A helper-unique id ("v<N>").
    public var visitId: String
    /// The target whose window the visit was opened for.
    public var targetId: String
    public var app: String
    /// What opened it: "act" | "live".
    public var why: String
    /// How many primitives ran in it.
    public var actions: Int
    /// How long the user was away (from the switch to back, or to the end).
    public var ms: Int
    public var returned: Bool
    /// The user moved somewhere of their own during it: left there, never fought.
    public var userMoved: Bool?
    /// Said when the user is not back.
    public var detail: String?
    public init(visitId: String, targetId: String, app: String, why: String, actions: Int, ms: Int, returned: Bool,
                userMoved: Bool? = nil, detail: String? = nil) {
        self.visitId = visitId
        self.targetId = targetId
        self.app = app
        self.why = why
        self.actions = actions
        self.ms = ms
        self.returned = returned
        self.userMoved = userMoved
        self.detail = detail
    }
}

/// `visit.close`: the session's open visit is closed (the user returned) and every closed, unclaimed report of the
/// session comes back once.
public struct VisitCloseParams: Codable, Sendable, Equatable {
    public var sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}
public struct VisitCloseResult: Codable, Sendable, Equatable {
    public var visits: [CUVisitReport]
    public init(visits: [CUVisitReport]) { self.visits = visits }
}

public struct TargetScreenshotResult: Codable, Sendable, Equatable {
    public var imageBase64: String
    public var mime: String
    public var width: Int
    public var height: Int
    public var shotId: String
    public var settled: Bool
    public var waitedMs: Int
    /// The captured area's size in WINDOW POINTS (what a click's point maps onto differs from the image px).
    public var pointsWidth: Double?
    public var pointsHeight: Double?
    /// What was done to take it (e.g. the window was moved here from another Space).
    public var detail: String?
    /// The capture ran inside (or opened) a desktop visit: taken on the window's own desktop.
    public var inVisit: Bool?
    public init(imageBase64: String, mime: String, width: Int, height: Int, shotId: String, settled: Bool, waitedMs: Int,
                pointsWidth: Double? = nil, pointsHeight: Double? = nil, detail: String? = nil, inVisit: Bool? = nil) {
        self.imageBase64 = imageBase64
        self.mime = mime
        self.width = width
        self.height = height
        self.shotId = shotId
        self.settled = settled
        self.waitedMs = waitedMs
        self.pointsWidth = pointsWidth
        self.pointsHeight = pointsHeight
        self.detail = detail
        self.inVisit = inVisit
    }
}

// MARK: - actions

public enum CUAccess: String, Codable, Sendable { case full, click }

/// `target.foreground`: the user agreed (the daemon's card) that the app may come to the front and stay there
/// until the session's script ends (`script.active` false) — on the user's own desktop only.
public struct TargetForegroundParams: Codable, Sendable, Equatable {
    public var targetId: String
    /// Accepted and IGNORED since helper 1.7.0: a window on another desktop is never held in front (that would
    /// keep the user there); an act that needs it on screen asks for a brief visit instead (`desktopVisit`).
    public var moveDesktop: Bool?
    /// Optional extension (see `TargetSnapshotParams.callId`).
    public var callId: String?
    public init(targetId: String, moveDesktop: Bool? = nil, callId: String? = nil) {
        self.targetId = targetId; self.moveDesktop = moveDesktop; self.callId = callId
    }
}
public struct TargetForegroundResult: Codable, Sendable, Equatable {
    /// The app is in front now.
    public var front: Bool
    public var detail: String?
    public init(front: Bool, detail: String? = nil) { self.front = front; self.detail = detail }
}

public struct TargetActParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var sessionId: String
    public var callId: String
    public var action: CUAction
    public var access: CUAccess
    public var allowForeground: Bool
    public var privatePath: Bool
    /// The user allowed a brief visit to the window's desktop for this app (the daemon's desktop-switch prompt).
    /// The act is still tried in the background first; only when that needs the window on screen and it is on
    /// another desktop is it done once more inside a visit (the foreground implied there).
    public var desktopVisit: Bool?
    /// With `desktopVisit`: how long that visit may last (the act's own deadline, a long type/paste's included) —
    /// the guardian's visit mode lasts that long, clamped to 10…330 s (absent: 10 s).
    public var visitMaxMs: Int?
    public init(targetId: String, sessionId: String, callId: String, action: CUAction, access: CUAccess,
                allowForeground: Bool, privatePath: Bool, desktopVisit: Bool? = nil, visitMaxMs: Int? = nil) {
        self.visitMaxMs = visitMaxMs
        self.targetId = targetId
        self.sessionId = sessionId
        self.callId = callId
        self.action = action
        self.access = access
        self.allowForeground = allowForeground
        self.privatePath = privatePath
        self.desktopVisit = desktopVisit
    }
}
public struct TargetActResult: Codable, Sendable, Equatable {
    public var rung: Int
    public var detail: String?
    /// type, paste, key, setValue: the element that received the input (`[14] text area "Comment"`).
    public var input: String?
    /// true when the app reported no focused element, so where the input went is unknown.
    public var inputUnknown: Bool?
    /// The bound window's focus moved during the act: where it is now (name and role only).
    public var focusNow: String?
    /// The focus was known before the act and the app reports none now.
    public var focusLost: Bool?
    /// The act changed the bound window's page (a link navigated, a tab switched): its title now.
    public var pageNow: String?
    /// The act ran inside (or opened) a desktop visit: done on the window's own desktop.
    public var inVisit: Bool?
    public init(rung: Int, detail: String? = nil, input: String? = nil, inputUnknown: Bool? = nil,
                focusNow: String? = nil, focusLost: Bool? = nil, pageNow: String? = nil, inVisit: Bool? = nil) {
        self.rung = rung
        self.detail = detail
        self.input = input
        self.inputUnknown = inputUnknown
        self.focusNow = focusNow
        self.focusLost = focusLost
        self.pageNow = pageNow
        self.inVisit = inVisit
    }
}

// MARK: - waits

public struct TargetWaitIdleParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var quietMs: Int
    public var timeoutMs: Int
    /// Optional extension (see `TargetSnapshotParams.callId`).
    public var callId: String?
    public init(targetId: String, quietMs: Int, timeoutMs: Int, callId: String? = nil) {
        self.targetId = targetId
        self.quietMs = quietMs
        self.timeoutMs = timeoutMs
        self.callId = callId
    }
}
public struct TargetWaitIdleResult: Codable, Sendable, Equatable {
    public var settled: Bool
    public var waitedMs: Int
    public init(settled: Bool, waitedMs: Int) {
        self.settled = settled
        self.waitedMs = waitedMs
    }
}

public struct CUWaitCondition: Codable, Sendable, Equatable {
    public var text: String?
    public var ref: Int?
    public var gone: CURefOrText?
    public var title: String?
    public init(text: String? = nil, ref: Int? = nil, gone: CURefOrText? = nil, title: String? = nil) {
        self.text = text
        self.ref = ref
        self.gone = gone
        self.title = title
    }
}
public struct TargetWaitForParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var cond: CUWaitCondition
    public var timeoutMs: Int
    /// Optional extension (see `TargetSnapshotParams.callId`).
    public var callId: String?
    public init(targetId: String, cond: CUWaitCondition, timeoutMs: Int, callId: String? = nil) {
        self.targetId = targetId
        self.cond = cond
        self.timeoutMs = timeoutMs
        self.callId = callId
    }
}
public struct TargetWaitForResult: Codable, Sendable, Equatable {
    public var met: Bool
    public var waitedMs: Int
    public init(met: Bool, waitedMs: Int) {
        self.met = met
        self.waitedMs = waitedMs
    }
}

// MARK: - whole screen

public struct ScreenScreenshotParams: Codable, Sendable, Equatable {
    /// An index into the active displays (0 = main), or "all".
    public var display: CUDisplaySelector?
    /// A specific CGDirectDisplayID; wins over `display` when both are given.
    public var displayId: UInt32?
    public var excludeBundleIds: [String]
    public var budget: CUImageBudget
    public init(display: CUDisplaySelector? = nil, displayId: UInt32? = nil, excludeBundleIds: [String],
                budget: CUImageBudget) {
        self.display = display
        self.displayId = displayId
        self.excludeBundleIds = excludeBundleIds
        self.budget = budget
    }
}
public struct ScreenScreenshotResult: Codable, Sendable, Equatable {
    public var imageBase64: String
    public var mime: String
    public var width: Int
    public var height: Int
    public var shotId: String
    /// Where Winter's own windows are in the image (a picture of an app inside one is Winter's live mirror of it).
    public var detail: String?
    public init(imageBase64: String, mime: String, width: Int, height: Int, shotId: String, detail: String? = nil) {
        self.imageBase64 = imageBase64
        self.mime = mime
        self.width = width
        self.height = height
        self.shotId = shotId
        self.detail = detail
    }
}

public struct ScreenAppAtParams: Codable, Sendable, Equatable {
    public var shotId: String
    public var point: [Double]
    public init(shotId: String, point: [Double]) {
        self.shotId = shotId
        self.point = point
    }
}
public struct ScreenAppAtResult: Codable, Sendable, Equatable {
    public var app: String
    public var bundleId: String
    public var windowId: UInt32
    public init(app: String, bundleId: String, windowId: UInt32) {
        self.app = app
        self.bundleId = bundleId
        self.windowId = windowId
    }
}

// MARK: - lifecycle forwarded to core

public struct CancelParams: Codable, Sendable, Equatable {
    public var callId: String
    public init(callId: String) { self.callId = callId }
}
public typealias CancelResult = CUEmpty

public struct TurnEndedParams: Codable, Sendable, Equatable {
    public var sessionId: String
    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}
public typealias TurnEndedResult = CUEmpty

public struct SessionEndedParams: Codable, Sendable, Equatable {
    public var sessionId: String
    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}
public typealias SessionEndedResult = CUEmpty

// MARK: AppleScript (target.applescript, target.scriptingDictionary)

/// `target.applescript`: a script for the bound app, run in the helper with every Apple Event checked.
public struct TargetAppleScriptParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var source: String
    /// "applescript" (the default). "javascript" is refused: JXA's Objective-C bridge is past every check.
    public var language: String?
    public var timeoutMs: Int?
    public var callId: String?
    public init(targetId: String, source: String, language: String? = nil, timeoutMs: Int? = nil, callId: String? = nil) {
        self.targetId = targetId
        self.source = source
        self.language = language
        self.timeoutMs = timeoutMs
        self.callId = callId
    }
}

public struct TargetAppleScriptResult: Codable, Sendable, Equatable {
    /// The script's result as AppleScript displays it; nil when it returned nothing.
    public var result: String?
    /// What else happened (macOS asked the user for Automation; what moved the user's view and was put back).
    public var detail: String?
    public init(result: String?, detail: String? = nil) {
        self.result = result
        self.detail = detail
    }
}

/// `target.scriptingDictionary`: the bound app's scripting dictionary, summarised.
public struct TargetScriptingDictionaryParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var search: String?
    /// Optional extension (see `TargetSnapshotParams.callId`).
    public var callId: String?
    public init(targetId: String, search: String? = nil, callId: String? = nil) {
        self.targetId = targetId
        self.search = search
        self.callId = callId
    }
}

public struct TargetScriptingDictionaryResult: Codable, Sendable, Equatable {
    public var scriptable: Bool
    public var text: String?
    public var truncated: Bool?
    public init(scriptable: Bool, text: String? = nil, truncated: Bool? = nil) {
        self.scriptable = scriptable
        self.text = text
        self.truncated = truncated
    }
}

/// `target.scriptingCommands` (helper 1.8.0): the bound app's dictionary COMMANDS, structured, for typed wrappers —
/// read from its sdef like `target.scriptingDictionary`, never by asking the app.
public struct TargetScriptingCommandsParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var search: String?
    /// Optional extension (see `TargetSnapshotParams.callId`).
    public var callId: String?
    public init(targetId: String, search: String? = nil, callId: String? = nil) {
        self.targetId = targetId
        self.search = search
        self.callId = callId
    }
}

public struct ScriptingCommandDirect: Codable, Sendable, Equatable {
    public var type: String
    public var optional: Bool
    public var description: String?
    public init(type: String, optional: Bool, description: String? = nil) {
        self.type = type
        self.optional = optional
        self.description = description
    }
}

public struct ScriptingCommandParam: Codable, Sendable, Equatable {
    public var name: String
    public var type: String
    public var optional: Bool
    public var description: String?
    /// The enumerators of an enumeration type (`save options` → yes, no, ask).
    public var enumerators: [String]?
    public init(name: String, type: String, optional: Bool, description: String? = nil, enumerators: [String]? = nil) {
        self.name = name
        self.type = type
        self.optional = optional
        self.description = description
        self.enumerators = enumerators
    }
}

public struct ScriptingCommandResultType: Codable, Sendable, Equatable {
    public var type: String
    public init(type: String) { self.type = type }
}

public struct ScriptingCommandInfo: Codable, Sendable, Equatable {
    public var name: String
    public var suite: String
    /// The 8-character Apple Event code (`aevtodoc`).
    public var eventCode: String
    /// At most 200 characters.
    public var description: String?
    public var direct: ScriptingCommandDirect?
    public var params: [ScriptingCommandParam]
    public var result: ScriptingCommandResultType?
    public init(name: String, suite: String, eventCode: String, description: String? = nil, direct: ScriptingCommandDirect? = nil,
                params: [ScriptingCommandParam], result: ScriptingCommandResultType? = nil) {
        self.name = name
        self.suite = suite
        self.eventCode = eventCode
        self.description = description
        self.direct = direct
        self.params = params
        self.result = result
    }
}

public struct TargetScriptingCommandsResult: Codable, Sendable, Equatable {
    public var scriptable: Bool
    /// The app's `CFBundleVersion` (clients cache what they make of the list by it).
    public var bundleVersion: String?
    /// At most 300; hidden ones, hidden suites and the helper's refused doors left out.
    public var commands: [ScriptingCommandInfo]
    public var truncated: Bool?
    public init(scriptable: Bool, bundleVersion: String? = nil, commands: [ScriptingCommandInfo] = [], truncated: Bool? = nil) {
        self.scriptable = scriptable
        self.bundleVersion = bundleVersion
        self.commands = commands
        self.truncated = truncated
    }
}

// MARK: apps.open for documents (file paths / URLs)

/// `apps.open` for a file path or URL: open it with `app` (a name, bundle id or path), or the default app.
public struct OpenDocumentsParams: Codable, Sendable, Equatable {
    public var urls: [String]
    public var app: String?
    public var sessionId: String
    public var mirror: Bool
    public var privatePath: Bool?
    public init(urls: [String], app: String? = nil, sessionId: String, mirror: Bool, privatePath: Bool? = nil) {
        self.urls = urls
        self.app = app
        self.sessionId = sessionId
        self.mirror = mirror
        self.privatePath = privatePath
    }
}

/// The app that opened the documents (never activated), and the new window to bind when one was found.
public struct OpenDocumentsResult: Codable, Sendable, Equatable {
    public var app: CUBoundApp
    public var windowID: UInt32?
    public init(app: CUBoundApp, windowID: UInt32? = nil) {
        self.app = app
        self.windowID = windowID
    }
}

/// `apps.open`: who would open these urls (for the opener's per-app card), without opening anything.
public struct DefaultOpenerParams: Codable, Sendable, Equatable {
    public var urls: [String]
    public var app: String?
    public init(urls: [String], app: String? = nil) { self.urls = urls; self.app = app }
}
public struct DefaultOpenerResult: Codable, Sendable, Equatable {
    public var bundleId: String
    public var name: String
    public var path: String
    public init(bundleId: String, name: String, path: String) { self.bundleId = bundleId; self.name = name; self.path = path }
}
