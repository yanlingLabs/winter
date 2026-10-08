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
}

public struct PermissionsRequestParams: Codable, Sendable, Equatable {
    public var kind: CUPermissionKind
    public init(kind: CUPermissionKind) { self.kind = kind }
}
public struct PermissionsRequestResult: Codable, Sendable, Equatable {
    public var opened: Bool
}

// MARK: - discovery

public typealias AppsListParams = CUEmpty
public struct CUAppInfo: Codable, Sendable, Equatable {
    public var name: String
    public var bundleId: String
    public var running: Bool
    public var pid: Int32?
}
public struct AppsListResult: Codable, Sendable, Equatable {
    public var apps: [CUAppInfo]
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
}
public struct ScreenWindowsResult: Codable, Sendable, Equatable {
    public var windows: [CUScreenWindow]
}

// MARK: - binding

public struct TargetBindParams: Codable, Sendable, Equatable {
    public var sessionId: String
    /// A name, a bundle id or a path.
    public var app: String
    public var window: CUWindowSelector?
    public var mirror: Bool
    public init(sessionId: String, app: String, window: CUWindowSelector? = nil, mirror: Bool) {
        self.sessionId = sessionId
        self.app = app
        self.window = window
        self.mirror = mirror
    }
}
public struct CUBoundApp: Codable, Sendable, Equatable {
    public var name: String
    public var bundleId: String
    public var pid: Int32
}
public struct CUWindowInfo: Codable, Sendable, Equatable {
    public var id: UInt32
    public var title: String
    public var frame: [Double]
}
public struct TargetBindResult: Codable, Sendable, Equatable {
    public var targetId: String
    public var app: CUBoundApp
    public var window: CUWindowInfo
}

public struct TargetUseWindowParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var window: CUWindowSelector
}
public struct TargetUseWindowResult: Codable, Sendable, Equatable {
    public var window: CUWindowInfo
}

public struct TargetWindowsParams: Codable, Sendable, Equatable {
    public var targetId: String
}
public struct CUTargetWindow: Codable, Sendable, Equatable {
    public var id: UInt32
    public var title: String
    public var focused: Bool
}
public struct TargetWindowsResult: Codable, Sendable, Equatable {
    public var windows: [CUTargetWindow]
}

public struct TargetReleaseParams: Codable, Sendable, Equatable {
    public var targetId: String
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
}
public struct TargetSnapshotResult: Codable, Sendable, Equatable {
    public var snapshotId: String
    public var text: String
    public var isDiff: Bool
    public var changedRatio: Double
    public var settled: Bool
    public var waitedMs: Int
}

public struct TargetFindParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var query: CUFindQuery
}
public struct CUElementSummary: Codable, Sendable, Equatable {
    public var ref: Int
    public var role: String
    public var name: String?
    public var value: String?
}
public struct TargetFindResult: Codable, Sendable, Equatable {
    public var elements: [CUElementSummary]
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
}
public struct TargetScreenshotResult: Codable, Sendable, Equatable {
    public var imageBase64: String
    public var mime: String
    public var width: Int
    public var height: Int
    public var shotId: String
    public var settled: Bool
    public var waitedMs: Int
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
}

// MARK: - waits

public struct TargetWaitIdleParams: Codable, Sendable, Equatable {
    public var targetId: String
    public var quietMs: Int
    public var timeoutMs: Int
    /// Optional extension (see `TargetSnapshotParams.callId`).
    public var callId: String?
}
public struct TargetWaitIdleResult: Codable, Sendable, Equatable {
    public var settled: Bool
    public var waitedMs: Int
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
}
public struct TargetWaitForResult: Codable, Sendable, Equatable {
    public var met: Bool
    public var waitedMs: Int
}

// MARK: - whole screen

public struct ScreenScreenshotParams: Codable, Sendable, Equatable {
    public var display: CUDisplaySelector?
    public var excludeBundleIds: [String]
    public var budget: CUImageBudget
}
public struct ScreenScreenshotResult: Codable, Sendable, Equatable {
    public var imageBase64: String
    public var mime: String
    public var width: Int
    public var height: Int
    public var shotId: String
}

public struct ScreenAppAtParams: Codable, Sendable, Equatable {
    public var shotId: String
    public var point: [Double]
}
public struct ScreenAppAtResult: Codable, Sendable, Equatable {
    public var app: String
    public var bundleId: String
    public var windowId: UInt32
}

// MARK: - lifecycle forwarded to core

public struct CancelParams: Codable, Sendable, Equatable {
    public var callId: String
    public init(callId: String) { self.callId = callId }
}
public typealias CancelResult = CUEmpty

public struct TurnEndedParams: Codable, Sendable, Equatable {
    public var sessionId: String
}
public typealias TurnEndedResult = CUEmpty

public struct SessionEndedParams: Codable, Sendable, Equatable {
    public var sessionId: String
}
public typealias SessionEndedResult = CUEmpty
