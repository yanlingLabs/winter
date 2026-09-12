import AppKit
import ApplicationServices

enum ScanResult {
    case candidates([ClickableCandidate])
    case emptyTree   // hit test failed or windowless/childless tree (Chromium pre-poke)
    case timedOut    // deadline exceeded — treat like a failure for degrade counting
}

/// Runs ONLY on StickinessEngine's serial queue — never the main thread (D1).
/// @unchecked Sendable: confined to that one serial queue by construction (the engine
/// never touches it from main); the conformance exists for the queue.async capture.
/// AX coordinates are top-left-origin; candidates are converted to AppKit
/// bottom-left screen coordinates before returning.
final class AXScanner: @unchecked Sendable {
    private let clickableRoles: Set<String> = [
        "AXButton", "AXLink", "AXMenuButton", "AXPopUpButton", "AXCheckBox",
        "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox", "AXMenuItem",
    ]
    private var pokedPids = Set<pid_t>()

    /// Called when the frontmost app changes — pokes may need re-applying after relaunch.
    func resetPokes() { pokedPids.removeAll() }

    /// Scans `pid`'s (the frontmost application's) own windows — v1's root model.
    /// NEVER a positional hit-test: overlay apps (e.g. BlueStacks on this machine)
    /// keep invisible, screen-wide, AX-visible windows, so
    /// `AXUIElementCopyElementAtPosition` lands on their childless tree for every
    /// on-screen point (visited=2, found=0). Anchoring on the frontmost app's own
    /// windows instead sidesteps that entirely (live-gate root cause).
    func scan(around point: CGPoint, pid: pid_t, deadline: TimeInterval) -> ScanResult {
        let start = CFAbsoluteTimeGetCurrent()
        let axPoint = toAXCoordinates(point)

        if !pokedPids.contains(pid) {
            // D2: Chromium/Electron ship a disabled AX tree until an assistive client
            // announces itself (v1 ClickableStickiness.swift:591-616). No-op for native apps.
            let appEl = AXUIElementCreateApplication(pid)
            AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            pokedPids.insert(pid)
        }

        let roots = scanRoots(for: pid)
        guard !roots.isEmpty else {
            OrbDebug.log("ax scan: emptyTree (noWindows) pid=\(pid) elapsedMs=\(Int((CFAbsoluteTimeGetCurrent() - start) * 1000))")
            return .emptyTree
        }

        var found: [ClickableCandidate] = []
        var visited = 0
        var prunedSubtrees = 0
        // FIFO queue (index-based head, no Deque dep) — BFS instead of DFS so shallow
        // toolbar/tab elements near the cursor are reached before a large content
        // subtree (browser web area, terminal scrollback) can burn the whole deadline.
        var queue: [AXUIElement] = roots
        var head = 0
        var sawAnyChild = false

        // Box approximation of the scan circle — over-inclusive at the corners,
        // never under, so pruning never drops a real candidate.
        let scanCircleBounds = CGRect(
            x: axPoint.x - StickinessConstants.scanRadius,
            y: axPoint.y - StickinessConstants.scanRadius,
            width: StickinessConstants.scanRadius * 2,
            height: StickinessConstants.scanRadius * 2)

        while head < queue.count {
            let el = queue[head]
            head += 1
            visited += 1
            // A fruitless over-deadline walk is a real timeout; but if we've already found
            // candidates near the cursor, partial results are useful — return them instead
            // of discarding everything (live gate: stickiness was dying on slow AX trees).
            if visited % 32 == 0, CFAbsoluteTimeGetCurrent() - start > deadline {
                let elapsedMs = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
                if !found.isEmpty {
                    OrbDebug.log("ax scan: candidates(\(found.count)) (deadline, partial) pid=\(pid) roots=\(roots.count) visited=\(visited) prunedSubtrees=\(prunedSubtrees) elapsedMs=\(elapsedMs)")
                    return .candidates(found)
                }
                OrbDebug.log("ax scan: timedOut (deadline) pid=\(pid) roots=\(roots.count) visited=\(visited) prunedSubtrees=\(prunedSubtrees) elapsedMs=\(elapsedMs)")
                return .timedOut
            }
            if visited >= StickinessConstants.maxVisitedNodes {
                let elapsedMs = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
                if !found.isEmpty {
                    OrbDebug.log("ax scan: candidates(\(found.count)) (nodeCap, partial) pid=\(pid) roots=\(roots.count) visited=\(visited) prunedSubtrees=\(prunedSubtrees) elapsedMs=\(elapsedMs)")
                    return .candidates(found)
                }
                OrbDebug.log("ax scan: timedOut (nodeCap) pid=\(pid) roots=\(roots.count) visited=\(visited) prunedSubtrees=\(prunedSubtrees) elapsedMs=\(elapsedMs)")
                return .timedOut
            }

            // Read the frame ONCE per element, then reuse it for both the prune
            // check and (if not pruned) the collection check below.
            let frame = copyFrame(el)
            if let frame, !frame.intersects(scanCircleBounds) {
                // Outside the scan circle: skip entirely — no collection, no
                // children enqueued. This is the subtree prune.
                prunedSubtrees += 1
                continue
            }

            if let frame, let role = copyString(el, kAXRoleAttribute), clickableRoles.contains(role) {
                let center = CGPoint(x: frame.midX, y: frame.midY)
                if hypot(center.x - axPoint.x, center.y - axPoint.y) <= StickinessConstants.scanRadius {
                    let appKitFrame = toAppKitRect(frame)
                    found.append(ClickableCandidate(center: CGPoint(x: appKitFrame.midX, y: appKitFrame.midY), frame: appKitFrame))
                }
            }
            // Frame unreadable (some containers) or readable-and-intersecting: descend.
            if let kids = copyChildren(el) {
                if !kids.isEmpty { sawAnyChild = true }
                queue.append(contentsOf: kids)
            }
        }
        if found.isEmpty && !sawAnyChild {
            OrbDebug.log("ax scan: emptyTree (childless) pid=\(pid) roots=\(roots.count) visited=\(visited) prunedSubtrees=\(prunedSubtrees) elapsedMs=\(Int((CFAbsoluteTimeGetCurrent() - start) * 1000))")
            return .emptyTree
        }
        OrbDebug.log("ax scan: pid=\(pid) roots=\(roots.count) visited=\(visited) found=\(found.count) prunedSubtrees=\(prunedSubtrees) elapsedMs=\(Int((CFAbsoluteTimeGetCurrent() - start) * 1000))")
        return .candidates(found)
    }

    // MARK: root discovery (v1 root model)

    /// Scan roots for `pid`'s application: the focused window first — that's where
    /// the user's attention lives, and it's a one-hop lookup — falling back to the
    /// full window list only if no focused window is reported (menu-bar-only /
    /// background-agent apps). Mirrors v1's `frontmostFocusedWindows()`
    /// (ClickableStickiness.swift:401-427); v1's order (focused-first) is kept
    /// here rather than windows-first since it's the proven-working behavior.
    private func scanRoots(for pid: pid_t) -> [AXUIElement] {
        let appEl = AXUIElementCreateApplication(pid)

        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focused) == .success,
           let win = focused {
            return [unsafeDowncast(win, to: AXUIElement.self)]
        }

        var list: CFTypeRef?
        if AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &list) == .success,
           let windows = list as? [AXUIElement], !windows.isEmpty {
            return windows
        }
        return []
    }

    // MARK: AX helpers

    private func copyString(_ el: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func copyChildren(_ el: AXUIElement) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value) == .success else { return nil }
        return value as? [AXUIElement]
    }

    /// Element frame in AX (top-left-origin) screen coordinates.
    private func copyFrame(_ el: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
        var pos = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posRef as! AXValue, .cgPoint, &pos),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: pos, size: size)
    }

    // MARK: coordinate conversion (AX top-left ↔ AppKit bottom-left)

    private func primaryScreenHeight() -> CGFloat {
        NSScreen.screens.first?.frame.maxY ?? 0
    }

    private func toAXCoordinates(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x, y: primaryScreenHeight() - p.y)
    }

    private func toAppKitRect(_ axRect: CGRect) -> CGRect {
        CGRect(x: axRect.origin.x,
               y: primaryScreenHeight() - axRect.origin.y - axRect.height,
               width: axRect.width, height: axRect.height)
    }
}
