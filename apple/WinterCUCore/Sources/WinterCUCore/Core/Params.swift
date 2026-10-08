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
    public init(name: String, bundleId: String, pid: Int32) {
        self.name = name
        self.bundleId = bundleId
        self.pid = pid
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
    public init(targetId: String, query: CUFindQuery) {
        self.targetId = targetId
        self.query = query
    }
}
public struct CUElementSummary: Codable, Sendable, Equatable {
    public var ref: Int
    public var role: String
    public var name: String?
    public var value: String?
    public init(ref: Int, role: String, name: String? = nil, value: String? = nil) {
        self.ref = ref
        self.role = role
        self.name = name
        self.value = value
    }
}
public struct TargetFindResult: Codable, Sendable, Equatable {
    public var elements: [CUElementSummary]
    public init(elements: [CUElementSummary]) {
        self.elements = elements
    }
}

public struct CUImageBudget: Codable, Sendable, Equatable {
    public var maxLongEdge: Int
    public var tile: Int?
    public var maxTiles: Int?
    public var quality: Double
    public init(maxLongEdge: Int, tile: Int? = nil, maxTiles: Int? = nil, quality: Double) {
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
    public init(targetId: String, region: [Double]? = nil, budget: CUImageBudget, settle: CUSettleOption? = nil,
                callId: String? = nil) {
        self.targetId = targetId
        self.region = region
        self.budget = budget
        self.settle = settle
        self.callId = callId
    }
}
public struct TargetScreenshotResult: Codable, Sendable, Equatable {
    public var imageBase64: String
    public var mime: String
    public var width: Int
    public var height: Int
    public var shotId: String
    public var settled: Bool
    public var waitedMs: Int
    public init(imageBase64: String, mime: String, width: Int, height: Int, shotId: String, settled: Bool, waitedMs: Int) {
        self.imageBase64 = imageBase64
        self.mime = mime
        self.width = width
        self.height = height
        self.shotId = shotId
        self.settled = settled
        self.waitedMs = waitedMs
    }
}

// MARK: - actions

public enum CUAccess: String, Codable, Sendable { case full, click }

public struct TargetActParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var sessionId: String
    public var callId: String
    public var action: CUAction
    public var access: CUAccess
    public var allowForeground: Bool
    public var privatePath: Bool
    public init(targetId: String, sessionId: String, callId: String, action: CUAction, access: CUAccess,
                allowForeground: Bool, privatePath: Bool) {
        self.targetId = targetId
        self.sessionId = sessionId
        self.callId = callId
        self.action = action
        self.access = access
        self.allowForeground = allowForeground
        self.privatePath = privatePath
    }
}
public struct TargetActResult: Codable, Sendable, Equatable {
    public var rung: Int
    public var detail: String?
    public init(rung: Int, detail: String? = nil) {
        self.rung = rung
        self.detail = detail
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
    public init(imageBase64: String, mime: String, width: Int, height: Int, shotId: String) {
        self.imageBase64 = imageBase64
        self.mime = mime
        self.width = width
        self.height = height
        self.shotId = shotId
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
