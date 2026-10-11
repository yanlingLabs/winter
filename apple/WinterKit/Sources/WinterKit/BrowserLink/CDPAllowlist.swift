import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 — the ONLY CDP the browser engine may send or subscribe to, Winter.app's copy.
//
// The source of truth is the daemon's `packages/core/src/computer-use/browser/cdp-allowlist.ts`; this
// is the Swift copy the browser link enforces before anything reaches CEF (`CDPTabGate`), kept equal to
// it — element for element, in order — by `BrowserLinkParityTests`, which reads the TypeScript file.
// Change it only together with that file, and only through the controller: the allowlist is the
// extension's store justification as much as a guard. Nothing here reads cookies, storage, credentials,
// request bodies or headers; a response body crosses only when the model asks for one, cut at
// `responseBodyMaxChars`. The link refuses `Fetch.*` and `IO.*` itself (`CDPTabGate`): the built-in
// browser saves downloads through Winter.app's own handler.
// -----------------------------------------------------------------------------------------------

public enum CDPAllowlist {
    public static let methods: [String] = [
        "Page.enable", "Page.disable", "Page.getFrameTree", "Page.navigate", "Page.reload", "Page.stopLoading",
        "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Page.captureScreenshot", "Page.getLayoutMetrics",
        "Page.handleJavaScriptDialog", "Page.createIsolatedWorld", "Page.setLifecycleEventsEnabled",
        "Page.setInterceptFileChooserDialog",
        "Runtime.enable", "Runtime.disable", "Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.releaseObject",
        "Runtime.releaseObjectGroup",
        "DOM.enable", "DOM.disable", "DOM.getDocument", "DOM.describeNode", "DOM.resolveNode", "DOM.requestNode",
        "DOM.getBoxModel", "DOM.getContentQuads", "DOM.scrollIntoViewIfNeeded", "DOM.focus", "DOM.setFileInputFiles",
        "DOM.getFrameOwner",
        "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
        "Network.enable", "Network.disable",
        "Target.setAutoAttach", "Target.getTargetInfo",
        "Emulation.setFocusEmulationEnabled",
        // Phase 3
        "Log.enable", "Log.disable",
        "Network.getResponseBody",
        "Fetch.enable", "Fetch.disable",
        "Fetch.continueRequest", "Fetch.failRequest",
        "Fetch.takeResponseBodyAsStream", "IO.read", "IO.close",
        "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
    ]

    public static let events: [String] = [
        "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.domContentEventFired", "Page.loadEventFired",
        "Page.lifecycleEvent", "Page.frameAttached", "Page.frameDetached", "Page.frameStartedLoading",
        "Page.frameStoppedLoading", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened",
        "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
        "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed",
        "Target.attachedToTarget", "Target.detachedFromTarget", "Inspector.detached", "Inspector.targetCrashed",
        // Phase 3
        "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded",
        "Network.responseReceived",
        "Fetch.requestPaused",
        "Page.downloadWillBegin",
    ]

    /// The params every Network event keeps whatever else it carries (idle detection needs nothing more).
    public static let networkEventParams: [String] = ["requestId", "timestamp", "type"]

    /// Which params of an event leave the app (`CDP_EVENT_PARAMS`): dotted paths, `[]` = every element of
    /// an array. An event not listed leaves whole. Applied by `CDPEventReducer`.
    public static let eventParams: [String: [String]] = [
        "Network.requestWillBeSent": ["requestId", "timestamp", "wallTime", "type", "frameId", "request.url", "request.method", "redirectResponse.status"],
        "Network.responseReceived": ["requestId", "timestamp", "type", "frameId", "response.url", "response.status", "response.statusText",
                                     "response.mimeType", "response.protocol", "response.fromDiskCache", "response.fromServiceWorker", "response.encodedDataLength"],
        "Network.loadingFinished": ["requestId", "timestamp", "type", "encodedDataLength"],
        "Network.loadingFailed": ["requestId", "timestamp", "type", "errorText", "canceled", "blockedReason"],
        "Runtime.consoleAPICalled": ["type", "timestamp", "executionContextId", "args[].type", "args[].subtype", "args[].value",
                                     "args[].unserializableValue", "args[].description", "args[].className",
                                     "stackTrace.callFrames[].url", "stackTrace.callFrames[].lineNumber", "stackTrace.callFrames[].columnNumber"],
        "Runtime.exceptionThrown": ["timestamp", "exceptionDetails.text", "exceptionDetails.url", "exceptionDetails.lineNumber",
                                    "exceptionDetails.columnNumber", "exceptionDetails.executionContextId", "exceptionDetails.exception.description",
                                    "exceptionDetails.exception.className"],
        "Log.entryAdded": ["entry.source", "entry.level", "entry.text", "entry.url", "entry.lineNumber", "entry.timestamp", "entry.networkRequestId"],
        "Fetch.requestPaused": ["requestId", "frameId", "resourceType", "request.url", "request.method", "responseStatusCode",
                                "responseErrorReason", "responseHeaders[].name", "responseHeaders[].value"],
        "Page.downloadWillBegin": ["frameId", "guid", "url", "suggestedFilename"],
    ]
    public static let eventStringMax = 4096
    public static let eventArrayMax = 32
    /// `Fetch.requestPaused`'s `responseHeaders` keep only these, by name in any case.
    public static let fetchResponseHeaders: [String] = ["content-type", "content-disposition", "content-length"]
    /// `Network.enable`'s response buffers at most these; request bodies never (`maxPostDataSize` 0).
    public static let networkBufferMaxResource = 1_048_576
    public static let networkBufferMaxTotal = 8_388_608
    /// `Network.getResponseBody`'s `body` is cut here before it leaves the app.
    public static let responseBodyMaxChars = 1_048_576
    public static let ioReadMax = 1_048_576

    /// Code runs only in an isolated world with this name (the world rules, `CDPTabGate`).
    public static let worldName = "winter"

    public static let methodSet: Set<String> = Set(methods)
    public static let eventSet: Set<String> = Set(events)
    static let networkEventParamSet: Set<String> = Set(networkEventParams)
}

/// The Swift twin of the daemon's `cdp-reduce.ts` (`cdpEventParams`): what of an event leaves the app.
/// Only the listed paths survive; a leaf keeps a string (cut at `eventStringMax` characters), a number, a
/// boolean or null — never an object or an array; an array keeps at most `eventArrayMax` elements; an
/// object left empty is dropped. `Fetch.requestPaused`'s `responseHeaders` lose every entry whose name is
/// not in `fetchResponseHeaders` first. Held to the TypeScript by the shared cases in
/// `packages/core/test/computer-use/fixtures/cdp-reduce-cases.json` (`CDPEventReducerTests`).
public enum CDPEventReducer {
    final class Node {
        var leaf = false
        var array = false
        var children: [String: Node] = [:]
        var order: [String] = []
    }

    static let tries: [String: Node] = CDPAllowlist.eventParams.mapValues { paths in
        let root = Node()
        for path in paths {
            var level = root
            let segments = path.split(separator: ".").map(String.init)
            for (i, raw) in segments.enumerated() {
                let array = raw.hasSuffix("[]")
                let key = array ? String(raw.dropLast(2)) : raw
                let node: Node
                if let existing = level.children[key] { node = existing } else {
                    node = Node()
                    node.array = array
                    level.children[key] = node
                    level.order.append(key)
                }
                if i == segments.count - 1 { node.leaf = true }
                level = node
            }
        }
        return root
    }

    /// Does this event leave reduced (rather than whole)?
    public static func reduces(_ method: String) -> Bool { CDPAllowlist.eventParams[method] != nil }

    public static func reduce(method: String, params: JSONValue) -> JSONValue {
        guard let trie = tries[method] else { return params }
        guard case .object(var source) = params else { return .object([:]) }
        if method == "Fetch.requestPaused", case .array(let headers)? = source["responseHeaders"] {
            let allowed = Set(CDPAllowlist.fetchResponseHeaders)
            source["responseHeaders"] = .array(headers.filter { h in
                guard let name = h["name"]?.stringValue else { return false }
                return allowed.contains(name.lowercased())
            })
        }
        return .object(pick(source, trie))
    }

    private static func leafValue(_ v: JSONValue) -> JSONValue? {
        switch v {
        case .string(let s):
            // Cut by UTF-16 code units, as JavaScript's `slice` does.
            let units = Array(s.utf16)
            guard units.count > CDPAllowlist.eventStringMax else { return v }
            return .string(String(decoding: units.prefix(CDPAllowlist.eventStringMax), as: UTF16.self))
        case .number, .bool, .null: return v
        case .array, .object: return nil
        }
    }

    private static func element(_ v: JSONValue, _ node: Node) -> JSONValue? {
        if !node.children.isEmpty {
            guard case .object(let o) = v else { return nil }
            let r = pick(o, node)
            return r.isEmpty ? nil : .object(r)
        }
        return leafValue(v)
    }

    private static func pick(_ obj: [String: JSONValue], _ level: Node) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for key in level.order {
            guard let node = level.children[key], let v = obj[key] else { continue }
            if node.array {
                guard case .array(let items) = v else { continue }
                out[key] = .array(items.prefix(CDPAllowlist.eventArrayMax).compactMap { element($0, node) })
                continue
            }
            if let r = element(v, node) { out[key] = r }
        }
        return out
    }
}
