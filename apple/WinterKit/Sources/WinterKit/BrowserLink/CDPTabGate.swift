import Foundation

/// **What the browser link lets through to one tab's browser, and back out of it.** One per tab the
/// daemon holds; pure bookkeeping, no CEF — so every rule below runs under `swift test`.
///
/// Three jobs, each the app's half of a rule the daemon also keeps (a transport never trusts its
/// sender to have checked):
///
///  1. **The allowlist** (`CDPAllowlist`, equal to the daemon's `cdp-allowlist.ts`): a method or a
///     subscribed event outside it is refused `not_allowed` before anything reaches CEF.
///  2. **The world rules** — code runs only in an isolated world named `"winter"` THAT THIS LINK MADE,
///     never in the page's own and never in someone else's world that happens to share the name. A
///     context counts as winter only when the gate saw it returned by its own successful
///     `Page.createIsolatedWorld`, or saw the browser report a `"winter"` context in a frame it made
///     that world in — never by the name alone. The gate watches those contexts and the objects
///     minted in them, and refuses:
///       * `Runtime.evaluate` without a `contextId` (or a `uniqueContextId`) of such a world;
///       * `Runtime.callFunctionOn` without such a context or an `objectId` it saw minted in one —
///         and with an argument naming any other object;
///       * `DOM.resolveNode` without such an `executionContextId`;
///       * `Page.createIsolatedWorld` naming another world, or asking for universal access.
///       * `Page.reload` carrying `scriptToEvaluateOnLoad` (it runs in the page's main world);
///       * `Page.navigate` to anything but `http:`, `https:` or exactly `about:blank` (a `javascript:`
///         URL runs in the page's main world).
///     Contexts and objects are scoped to the CDP session they belong to (the tab's own, or a flattened
///     child target's), because their ids are. And within a session a context is matched by the
///     browser's `uniqueId` wherever it reported one: a process-local `contextId` can be handed out
///     again after a cross-process navigation, so an id the gate once saw as "winter" is "winter" only
///     while the LATEST context the browser reported under that id is the winter one.
///  3. **The events** — only subscribed, allowlisted ones leave, and a `Network.*` event leaves with its
///     params cut to `requestId`, `timestamp` and `type`.
public final class CDPTabGate {
    /// Why a send was refused — the message of a `not_allowed` answer.
    public struct Refusal: Error, Equatable, Sendable {
        public let message: String
        public init(_ message: String) { self.message = message }
    }

    public enum EventDisposition: Equatable, Sendable {
        case drop
        case forward
        /// Forward, with params cut to `CDPAllowlist.networkEventParams`.
        case forwardStripped
    }

    /// The events the daemon asked for (`cdp.subscribe`), replaced wholesale by each subscribe.
    public private(set) var subscribed: Set<String> = []

    /// Objects remembered per session past this many lose their oldest tenth. A page that is navigated
    /// clears its contexts and so its objects long before this; the cap only bounds a pathological run.
    static let objectCap = 50_000

    private struct ObjectOrigin {
        var context: Int?
        var group: String?
    }

    private struct World {
        /// Frames this link made a winter world in (`Page.createIsolatedWorld`'s `frameId`, on success).
        /// A later winter-named context in one of them is that world again (a new document).
        var madeFrames: Set<String> = []
        /// Winter-NAMED contexts the browser reported in a frame not (yet) known to be one of
        /// `madeFrames` — the browser announces a world's context before it answers the call that made
        /// it, so the answer confirms one of these; anything never confirmed never counts.
        var candidates: [Int: (unique: String?, frame: String?)] = [:]
        /// Context ids of winter worlds this link made.
        var contexts: Set<Int> = []
        /// A winter world's `uniqueId` → its context id.
        var uniqueIds: [String: Int] = [:]
        /// Any context id → the `uniqueId` of the LATEST context the browser reported under it.
        var latestUnique: [Int: String] = [:]
        var objects: [String: ObjectOrigin] = [:]
        var objectOrder: [String] = []

        /// A context id names a winter world — and, where the browser said which context the id
        /// belongs to now, that context is still the winter one.
        func isWinter(_ id: Int) -> Bool {
            guard contexts.contains(id) else { return false }
            guard let latest = latestUnique[id] else { return true }
            return uniqueIds[latest] == id
        }

        /// The id no longer names a winter world: forget it, its unique id and every object minted in it.
        mutating func invalidate(_ id: Int) {
            contexts.remove(id)
            uniqueIds = uniqueIds.filter { $0.value != id }
            objects = objects.filter { $0.value.context != id }
        }

        /// Every context is gone (`Runtime.executionContextsCleared`); the frames this link made worlds
        /// in are not.
        mutating func clearContexts() {
            let frames = madeFrames
            self = World()
            madeFrames = frames
        }
    }

    /// `""` is the tab's own session; anything else is a flattened child target's `sessionId`.
    private var worlds: [String: World] = [:]

    public init() {}

    private static func key(_ cdpSessionId: String?) -> String { cdpSessionId ?? "" }

    // MARK: - Subscriptions

    /// Replace the tab's subscription. Refused whole if any event is outside the allowlist.
    public func subscribe(_ events: [String]) -> Refusal? {
        let outside = events.filter { !CDPAllowlist.eventSet.contains($0) }
        if !outside.isEmpty {
            return Refusal("not on the CDP event allowlist: \(outside.sorted().joined(separator: ", "))")
        }
        subscribed = Set(events)
        return nil
    }

    /// What happens to one event the browser reported for this tab.
    public func disposition(forEvent method: String) -> EventDisposition {
        guard CDPAllowlist.eventSet.contains(method), subscribed.contains(method) else { return .drop }
        return method.hasPrefix("Network.") ? .forwardStripped : .forward
    }

    /// A `Network.*` event's params, cut to the three keys idle detection needs. Anything that is not an
    /// object becomes an empty one.
    public static func strippedNetworkParams(_ params: JSONValue) -> JSONValue {
        guard case .object(let all) = params else { return .object([:]) }
        return .object(all.filter { CDPAllowlist.networkEventParamSet.contains($0.key) })
    }

    /// Whether `noteEvent` needs this event's params — the host parses only these, whatever is subscribed.
    public static func tracksEvent(_ method: String) -> Bool {
        switch method {
        case "Runtime.executionContextCreated", "Runtime.executionContextDestroyed",
             "Runtime.executionContextsCleared", "Target.detachedFromTarget", "Page.frameDetached":
            return true
        default:
            return false
        }
    }

    // MARK: - Sends

    /// `nil` when `method` may be sent to this tab with `params`, else why not.
    public func check(method: String, params: JSONValue, cdpSessionId: String?) -> Refusal? {
        guard CDPAllowlist.methodSet.contains(method) else {
            return Refusal("\(method) is not on the CDP method allowlist")
        }
        let world = worlds[Self.key(cdpSessionId)] ?? World()
        switch method {
        case "Runtime.evaluate":
            if case .some(let raw) = params["contextId"] {
                guard let context = raw.intValue, world.isWinter(context) else {
                    return Refusal("Runtime.evaluate: contextId is not a \"winter\" world")
                }
                if let unique = params["uniqueContextId"], world.uniqueIds[unique.stringValue ?? ""] == nil {
                    return Refusal("Runtime.evaluate: uniqueContextId is not a \"winter\" world")
                }
                return nil
            }
            if let unique = params["uniqueContextId"]?.stringValue, world.uniqueIds[unique] != nil { return nil }
            return Refusal("Runtime.evaluate runs only in a \"winter\" world — name its contextId")
        case "Runtime.callFunctionOn":
            var anchored = false
            if let raw = params["objectId"] {
                guard let objectId = raw.stringValue, world.objects[objectId] != nil else {
                    return Refusal("Runtime.callFunctionOn: objectId was not minted in a \"winter\" world")
                }
                anchored = true
            }
            if let raw = params["executionContextId"] {
                guard let context = raw.intValue, world.isWinter(context) else {
                    return Refusal("Runtime.callFunctionOn: executionContextId is not a \"winter\" world")
                }
                anchored = true
            }
            if let raw = params["uniqueContextId"] {
                guard let unique = raw.stringValue, world.uniqueIds[unique] != nil else {
                    return Refusal("Runtime.callFunctionOn: uniqueContextId is not a \"winter\" world")
                }
                anchored = true
            }
            guard anchored else {
                return Refusal("Runtime.callFunctionOn runs only in a \"winter\" world — name its context or an object from it")
            }
            for argument in params["arguments"]?.arrayValue ?? [] {
                if let raw = argument["objectId"] {
                    guard let objectId = raw.stringValue, world.objects[objectId] != nil else {
                        return Refusal("Runtime.callFunctionOn: an argument's objectId was not minted in a \"winter\" world")
                    }
                }
            }
            return nil
        case "DOM.resolveNode":
            guard let context = params["executionContextId"]?.intValue, world.isWinter(context) else {
                return Refusal("DOM.resolveNode resolves only into a \"winter\" world — name its executionContextId")
            }
            return nil
        case "Page.createIsolatedWorld":
            guard params["worldName"]?.stringValue == CDPAllowlist.worldName else {
                return Refusal("Page.createIsolatedWorld: the only world is \"\(CDPAllowlist.worldName)\"")
            }
            // CDP's own spelling of the flag is `grantUniveralAccess`; the correct spelling is refused too.
            if params["grantUniveralAccess"]?.boolValue == true || params["grantUniversalAccess"]?.boolValue == true {
                return Refusal("Page.createIsolatedWorld: universal access is never granted")
            }
            return nil
        case "Page.navigate":
            guard let url = params["url"]?.stringValue, Self.isNavigableURL(url) else {
                return Refusal("Page.navigate goes only to http:, https: or about:blank")
            }
            return nil
        case "Page.reload":
            if params["scriptToEvaluateOnLoad"] != nil {
                return Refusal("Page.reload: scriptToEvaluateOnLoad would run in the page's own world")
            }
            return nil
        default:
            return nil
        }
    }

    /// `http(s):` or exactly `about:blank` — never `javascript:` (main-world code), `data:`, `file:`, or
    /// a browser-internal page.
    static func isNavigableURL(_ url: String) -> Bool {
        if url.caseInsensitiveCompare("about:blank") == .orderedSame { return true }
        guard let colon = url.firstIndex(of: ":") else { return false }
        let scheme = url[..<colon].lowercased()
        return scheme == "http" || scheme == "https"
    }

    /// A send that `check` allowed has answered successfully: remember the contexts and objects it
    /// created, and forget the ones it released.
    public func noteResult(method: String, params: JSONValue, cdpSessionId: String?, result: JSONValue) {
        let key = Self.key(cdpSessionId)
        switch method {
        case "Page.createIsolatedWorld":
            // The one way a context BECOMES winter: this link's own call answered it.
            if let context = result["executionContextId"]?.intValue {
                var world = worlds[key] ?? World()
                let frame = params["frameId"]?.stringValue
                if let frame { world.madeFrames.insert(frame) }
                world.contexts.insert(context)
                if let candidate = world.candidates.removeValue(forKey: context),
                   frame == nil || candidate.frame == nil || candidate.frame == frame {
                    // Its context was announced before the answer: that announcement is this world.
                    if let unique = candidate.unique { world.uniqueIds[unique] = context }
                } else if let latest = world.latestUnique[context], world.uniqueIds[latest] != context {
                    // The id is the winter world's NOW; which unique context it is arrives with its event.
                    world.latestUnique[context] = nil
                }
                worlds[key] = world
            }
        case "Runtime.evaluate":
            let context = params["contextId"]?.intValue
                ?? params["uniqueContextId"]?.stringValue.flatMap { worlds[key]?.uniqueIds[$0] }
            mint(result["result"]?["objectId"], context: context, params: params, key: key)
            mint(result["exceptionDetails"]?["exception"]?["objectId"], context: context, params: params, key: key)
        case "Runtime.callFunctionOn":
            var context = params["executionContextId"]?.intValue
                ?? params["uniqueContextId"]?.stringValue.flatMap { worlds[key]?.uniqueIds[$0] }
            if context == nil, let objectId = params["objectId"]?.stringValue {
                context = worlds[key]?.objects[objectId]?.context
            }
            mint(result["result"]?["objectId"], context: context, params: params, key: key)
            mint(result["exceptionDetails"]?["exception"]?["objectId"], context: context, params: params, key: key)
        case "DOM.resolveNode":
            mint(result["object"]?["objectId"], context: params["executionContextId"]?.intValue, params: params, key: key)
        case "Runtime.releaseObject":
            if let objectId = params["objectId"]?.stringValue { worlds[key]?.objects[objectId] = nil }
        case "Runtime.releaseObjectGroup":
            if let group = params["objectGroup"]?.stringValue, var world = worlds[key] {
                world.objects = world.objects.filter { $0.value.group != group }
                worlds[key] = world
            }
        default:
            break
        }
    }

    private func mint(_ objectId: JSONValue?, context: Int?, params: JSONValue, key: String) {
        guard let objectId = objectId?.stringValue, !objectId.isEmpty else { return }
        var world = worlds[key] ?? World()
        if world.objects[objectId] == nil { world.objectOrder.append(objectId) }
        world.objects[objectId] = ObjectOrigin(context: context, group: params["objectGroup"]?.stringValue)
        if world.objects.count > Self.objectCap {
            let drop = max(1, Self.objectCap / 10)
            for old in world.objectOrder.prefix(drop) { world.objects[old] = nil }
            world.objectOrder.removeFirst(min(drop, world.objectOrder.count))
        }
        if world.objectOrder.count > world.objects.count * 2 + 64 {
            world.objectOrder = world.objectOrder.filter { world.objects[$0] != nil }
        }
        worlds[key] = world
    }

    // MARK: - Events

    /// Track the contexts the browser reports, whatever is subscribed. Only the methods `tracksEvent`
    /// names change anything.
    public func noteEvent(method: String, params: JSONValue, cdpSessionId: String?) {
        let key = Self.key(cdpSessionId)
        switch method {
        case "Runtime.executionContextCreated":
            guard let context = params["context"], let id = context["id"]?.intValue else { return }
            var world = worlds[key] ?? World()
            let unique = context["uniqueId"]?.stringValue
            let frame = context["auxData"]?["frameId"]?.stringValue
            let winterNamed = context["name"]?.stringValue == CDPAllowlist.worldName
            if winterNamed, let frame, world.madeFrames.contains(frame) {
                // A winter world in a frame this link made one in.
                world.candidates[id] = nil
                world.contexts.insert(id)
                if let unique { world.uniqueIds[unique] = id }
            } else {
                // The page's own world, someone else's, or a winter-named world in a frame this link
                // never made one in. If the id was a winter world's, it is not any more (a cross-process
                // navigation hands process-local ids out again).
                if world.contexts.contains(id) { world.invalidate(id) }
                world.candidates[id] = winterNamed ? (unique, frame) : nil
            }
            world.latestUnique[id] = unique
            worlds[key] = world
        case "Runtime.executionContextDestroyed":
            guard var world = worlds[key] else { return }
            if let unique = params["executionContextUniqueId"]?.stringValue {
                // By unique id: only the context that really went. A late "destroyed" for an older
                // context that once had this id must not take a newer winter world with it.
                let id = world.uniqueIds.removeValue(forKey: unique) ?? params["executionContextId"]?.intValue
                if let id, world.latestUnique[id] == unique {
                    world.latestUnique[id] = nil
                    world.candidates[id] = nil
                    if world.contexts.contains(id) { world.invalidate(id) }
                }
            } else if let id = params["executionContextId"]?.intValue {
                world.latestUnique[id] = nil
                world.candidates[id] = nil
                world.invalidate(id)
            }
            worlds[key] = world
        case "Runtime.executionContextsCleared":
            worlds[key]?.clearContexts()
        case "Page.frameDetached":
            if let frame = params["frameId"]?.stringValue { worlds[key]?.madeFrames.remove(frame) }
        case "Target.detachedFromTarget":
            if let child = params["sessionId"]?.stringValue { worlds[child] = nil }
        default:
            break
        }
    }

    // MARK: - Test seams

    /// The `"winter"` contexts the gate knows for a session — for tests.
    func knownContexts(cdpSessionId: String? = nil) -> Set<Int> { worlds[Self.key(cdpSessionId)]?.contexts ?? [] }
    /// How many objects the gate remembers for a session — for tests.
    func knownObjectCount(cdpSessionId: String? = nil) -> Int { worlds[Self.key(cdpSessionId)]?.objects.count ?? 0 }
}
