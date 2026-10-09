import AppKit
import CoreGraphics
import Foundation

/// Makes a background app BELIEVE it is active without the window server making it front, so it does not
/// activate itself and pull the user to its Space when it is typed into: a synthetic "application activated"
/// event (carrying the bound window) makes the target believe it is active, so it doesn't activate itself.
/// Behind the private-path setting; the user-view guard stays the backstop.
///
/// This file holds the PURE pieces — the synthetic focus state, the activation event's construction, the CPS
/// constants and field numbers, and the decide-what-to-do-with-an-observed-event predicates — so they are
/// tested on fakes without any event tap. `CULiveFocusEnforcer` wires them to real CGEvent taps and the
/// SkyLight update-suspension bracket.

// MARK: synthetic focus state

/// What the target is made to believe, tracked apart from what is really true (an app can believe it is
/// active while the window server knows it is not front). The cache is only trustworthy once the persistent
/// activation tap feeds it; without that tap the live enforcer re-reads reality each call instead (a real
/// deactivate, from the user clicking away, must not leave a stale "believes active").
public struct CUSyntheticFocusState: Equatable, Sendable {
    public var believesActive: Bool
    public var believesFocus: Bool
    public var isReallyActive: Bool
    public init(believesActive: Bool = false, believesFocus: Bool = false, isReallyActive: Bool = false) {
        self.believesActive = believesActive
        self.believesFocus = believesFocus
        self.isReallyActive = isReallyActive
    }

    /// Post the app-activated notification when it does not already believe it is active.
    public var needsActivation: Bool { !believesActive }
    /// Post the key-focus-returned notification when it does not already believe it has focus.
    public var needsFocus: Bool { !believesFocus }
    /// Whether anything is to be sent at all.
    public var needsEnforcing: Bool { needsActivation || needsFocus }

    /// After the step is sent, the app believes it is active and focused (its real front state is unchanged).
    public mutating func markEnforced() {
        believesActive = true
        believesFocus = true
    }
}

// MARK: the synthetic activation event

/// The AppKit "application activated" notification (`NSEvent.otherEvent` type 13, subtype 1) and the private
/// CPS "key focus returned" notification (type 21, subtype 0x8000) posted to the target pid. Pure field values
/// (for tests) plus the real CGEvents.
public enum CUFocusEvents {
    public static let appKitDefinedType: CGEventType = CGEventType(rawValue: 13)!
    public static let processNotificationType: CGEventType = CGEventType(rawValue: 21)!
    /// NSApplicationActivated subtype, and the window-carrying modifier flags AppKit sets with it.
    public static let activatedSubtype: Int64 = 1
    public static let windowFlags: Int64 = 0xc0000
    /// Private CPS subtype bit patterns (16-bit; keep the pattern when widening to a signed field).
    public static let keyFocusReturned: Int64 = 0x8000

    /// The activation event's fields for `windowID` (0 = no window): the pure description the live builder sets.
    public struct ActivationFields: Equatable, Sendable {
        public var type: Int64
        public var subtype: Int64
        public var flags: Int64
        public var windowNumber: Int64
    }
    public static func activationFields(windowID: UInt32) -> ActivationFields {
        ActivationFields(type: Int64(appKitDefinedType.rawValue), subtype: activatedSubtype,
                         flags: windowID != 0 ? windowFlags : 0, windowNumber: Int64(windowID))
    }

    /// An `NSEvent.otherEvent` of `type`/`subtype` for `windowID`, as a CGEvent addressed to a pid — or nil
    /// when AppKit refuses to build it.
    static func notification(type: NSEvent.EventType, subtype: Int16, windowID: UInt32, flags: NSEvent.ModifierFlags) -> CGEvent? {
        let event = NSEvent.otherEvent(with: type, location: .zero, modifierFlags: flags, timestamp: 0,
                                       windowNumber: Int(windowID), context: nil, subtype: subtype, data1: 0, data2: 0)
        return event?.cgEvent
    }

    /// The app-activated notification (type 13 / subtype 1).
    public static func appActivated(windowID: UInt32) -> CGEvent? {
        notification(type: .appKitDefined, subtype: 1, windowID: windowID,
                     flags: windowID != 0 ? NSEvent.ModifierFlags(rawValue: UInt(windowFlags)) : [])
    }

    /// The key-focus-returned CPS notification (type 21 / subtype 0x8000). `NSEvent` has no type 21, so it is
    /// built as a raw CGEvent-shaped NSEvent through `appKitDefined` and retyped; nil when unavailable.
    public static func keyFocusReturnedEvent() -> CGEvent? {
        // A bare event of the private type, carrying the subtype in its integer field.
        guard let e = CGEvent(source: nil) else { return nil }
        e.type = processNotificationType
        e.setIntegerValueField(CGEventField(rawValue: 64)!, value: keyFocusReturned)  // cpsEventSubtype
        return e
    }
}

// MARK: CPS fields and the focus-theft guard

/// The CGEvent field numbers the window server uses for focus notifications.
public enum CUFocusField {
    public static let targetPID: UInt32 = 40
    public static let sourcePID: UInt32 = 41
    public static let windowID: UInt32 = 51
    public static let cpsSubtype: UInt32 = 64
    public static let stoleTypingFocus: UInt32 = 69
    public static let theftID: UInt32 = 71
    public static let subjectPID: UInt32 = 73
    public static let appKitSubtype: UInt32 = 83
}

/// CPS process-notification subtypes (private type 21).
public enum CUCPSSubtype {
    public static let newFront: Int64 = 0x0002
    public static let lostKeyFocus: Int64 = 0x1000
    public static let keyFocusTaken: Int64 = 0x4000
    public static let keyFocusReturned: Int64 = 0x8000
}

/// A focus notification as the guard reads it (filled from CGEvent fields on the live path).
public struct CUFocusNotification: Equatable, Sendable {
    public var recipientPID: pid_t   // field 40
    public var subtype: Int64        // field 64
    public var subjectPID: pid_t     // field 73
    public var theftID: Int32        // field 71
    public init(recipientPID: pid_t, subtype: Int64, subjectPID: pid_t, theftID: Int32) {
        self.recipientPID = recipientPID
        self.subtype = subtype
        self.subjectPID = subjectPID
        self.theftID = theftID
    }
}

/// An outstanding key-focus theft the guard is undoing.
public struct CUFocusSuppression: Equatable, Sendable {
    public var thiefPID: pid_t
    public var victimPID: pid_t
    public var releasedTheft: Bool = false
    public var suppressedReturn: Bool = false
}

/// The focus-theft state machine. Pure: the live tap fills `CUFocusNotification`s and
/// applies the verdicts. Protects the TARGETs it is told about — when another process steals key focus from a
/// protected target, the theft is recorded, its notification dropped, the thief's token released and the
/// user's own keys rerouted back to the victim.
public struct CUFocusGuard: Equatable, Sendable {
    public private(set) var protectedPIDs: Set<pid_t> = []
    public private(set) var suppression: CUFocusSuppression?
    public private(set) var currentFocus: pid_t?
    public init() {}

    public mutating func protect(_ pid: pid_t) { protectedPIDs.insert(pid) }
    public mutating func unprotect(_ pid: pid_t) {
        protectedPIDs.remove(pid)
        if let s = suppression, s.victimPID == pid || s.thiefPID == pid { suppression = nil }
    }
    public var isEmpty: Bool { protectedPIDs.isEmpty }

    /// What the guard does with one observed focus notification.
    public enum Verdict: Equatable, Sendable {
        case pass
        case drop                              // swallow the notification
        case release(theftID: Int32)           // drop it AND release the stolen focus by its token
    }

    /// A focus notification about a protected target: decide and record.
    public mutating func handle(_ n: CUFocusNotification) -> Verdict {
        switch n.subtype {
        case CUCPSSubtype.keyFocusTaken:
            // Something took key focus FROM a protected target: record the theft and drop the notice.
            guard let victim = currentFocus ?? protectedPIDs.first(where: { $0 != n.subjectPID }),
                  protectedPIDs.contains(victim), n.subjectPID != victim else { return .pass }
            suppression = CUFocusSuppression(thiefPID: n.subjectPID, victimPID: victim, releasedTheft: true)
            return n.theftID != 0 ? .release(theftID: n.theftID) : .drop
        case CUCPSSubtype.keyFocusReturned:
            // The victim's focus is coming back: drop the one extra return we caused, once.
            if var s = suppression, s.victimPID == n.recipientPID, !s.suppressedReturn {
                s.suppressedReturn = true
                suppression = s
                return .drop
            }
            return .pass
        case CUCPSSubtype.newFront, CUCPSSubtype.lostKeyFocus:
            if n.subtype == CUCPSSubtype.newFront { suppression = nil }
            return .pass
        default:
            currentFocus = n.recipientPID
            return .pass
        }
    }

    /// Where a physical key event addressed to `targetPID` should really go while a theft is suppressed: back
    /// to the victim (so the user's typing is not eaten by the thief), else nil (leave it alone).
    public func reroute(targetPID: pid_t) -> pid_t? {
        guard let s = suppression, targetPID == s.thiefPID else { return nil }
        return s.victimPID
    }
}

// MARK: tap predicates

/// The event taps the enforcer installs, with their raw CG types. Pure data, so the
/// live wiring and the tests agree on exactly what is tapped.
public enum CUFocusTaps {
    /// Target activation notifications (type 13 app-defined, 20, 19) — a tail tap that watches/suppresses them.
    public static let activationTypes: [UInt32] = [13, 20, 19]
    /// Keyboard events (10 key down, 11 key up, 12 flags changed).
    public static let keyboardTypes: [UInt32] = [10, 11, 12]
    /// The private process-notification type (21), watched system-wide for CPS focus theft.
    public static let processNotificationType: UInt32 = 21
    /// Mouse events whose stray delivery dismisses a background menu (down/up/drag, left/right/other).
    public static let mouseTypes: [UInt32] = [1, 2, 6, 3, 4, 7, 25, 26, 27]

    public static func mask(_ types: [UInt32]) -> CGEventMask { types.reduce(0) { $0 | (CGEventMask(1) << $1) } }

    /// A keyboard event the enforcer tapped: pass the helper's own synthetic keys (their source pid is the
    /// helper), reroute a user key addressed to the focus thief back to the victim, else pass.
    public enum KeyVerdict: Equatable, Sendable { case pass, reroute(to: pid_t) }
    public static func keyVerdict(sourcePID: pid_t, targetPID: pid_t, helperPID: pid_t, guard g: CUFocusGuard) -> KeyVerdict {
        if sourcePID == helperPID { return .pass }
        if let victim = g.reroute(targetPID: targetPID) { return .reroute(to: victim) }
        return .pass
    }

    /// A mouse event the menu-dismissal tap saw: drop it when it belongs to a window owned by neither the
    /// target nor the open menu's process, so the user's clicks elsewhere do not dismiss a background menu.
    public static func dismissesMenu(windowOwnerPID: pid_t?, targetPID: pid_t, menuPID: pid_t?) -> Bool {
        guard let owner = windowOwnerPID else { return false }  // unknown owner: pass (never guess a drop)
        return owner != targetPID && owner != menuPID
    }

    /// An activation/deactivation notification the temporary suppression tap saw (type and AppKit subtype from
    /// field 83): drop the target's resign/deactivate so it keeps believing it is active while focus is set up.
    public static func suppressesActivation(type: UInt32, appKitSubtype: Int64) -> Bool {
        if type == 19 { return true }                               // app deactivated
        if type == 13, appKitSubtype == 2 { return true }           // app resigned active
        if type == 13, appKitSubtype == 22 || appKitSubtype == 23 { return true }  // window resigned key/main
        return false
    }
}

// MARK: the enforcer

/// Makes the target believe it is active for the length of one keyboard action; replaceable by tests.
public protocol CUFocusEnforcing: AnyObject {
    /// Ensure the target believes it is active before keys are sent. Returns whether an enforcement was done
    /// (true) — for logging "the enforcer prevented an activation" versus the guard undoing one.
    func enforce(windowID: UInt32) -> Bool
    func teardown()
}

/// The live enforcer: synthetic activation posted to the target under an `SLSDisableUpdate` bracket, with
/// temporary head taps that drop the target's own resign/deactivate events while focus is set up. One per
/// bound target, reused across actions, torn down on release. Gated by the private-path setting at the call
/// site. Best-effort: a missing symbol or tap degrades to posting the activation alone, with the user-view
/// guard still the backstop.
/// A test core's enforcer: posts nothing (the live one would post events and suspend the real window server's
/// updates from a unit test).
final class CUNoopFocusEnforcer: CUFocusEnforcing {
    func enforce(windowID: UInt32) -> Bool { false }
    func teardown() {}
}

public final class CULiveFocusEnforcer: CUFocusEnforcing {
    private let pid: pid_t
    private let skyLight: CUSkyLight
    private let post: (CGEvent, pid_t) -> Void
    private let helperPID: pid_t
    private var state: CUSyntheticFocusState
    private let lock = NSLock()

    public init(pid: pid_t, skyLight: CUSkyLight, helperPID: pid_t = getpid(),
                post: @escaping (CGEvent, pid_t) -> Void = { e, p in e.postToPid(p) }) {
        self.pid = pid
        self.skyLight = skyLight
        self.post = post
        self.helperPID = helperPID
        let running = NSRunningApplication(processIdentifier: pid)?.isActive ?? false
        self.state = CUSyntheticFocusState(believesActive: running, believesFocus: running, isReallyActive: running)
    }

    public func enforce(windowID: UInt32) -> Bool {
        lock.lock(); defer { lock.unlock() }
        // Already front for the user: nothing to fake (and nothing to restore).
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
            state = CUSyntheticFocusState(believesActive: true, believesFocus: true, isReallyActive: true)
            return false
        }
        // No observation tap yet: re-read reality instead of trusting a cached belief, so a real deactivation
        // (the user clicked away) does not leave a stale "believes active" that skips the re-enforcement.
        let active = NSRunningApplication(processIdentifier: pid)?.isActive ?? false
        state = CUSyntheticFocusState(believesActive: active, believesFocus: active, isReallyActive: active)
        guard state.needsEnforcing else { return false }
        let (activate, focus) = (state.needsActivation, state.needsFocus)
        // Suspend drawing so the synthetic activation never shows, enforce, re-enable on every exit.
        let cid = skyLight.disableUpdate()
        defer { if let cid { skyLight.reenableUpdate(cid) } }
        if activate, let activation = CUFocusEvents.appActivated(windowID: windowID) {
            activation.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
            post(activation, pid)
        }
        if focus, let focusEvent = CUFocusEvents.keyFocusReturnedEvent() {
            post(focusEvent, pid)
        }
        state.markEnforced()
        return true
    }

    public func teardown() {
        lock.lock(); defer { lock.unlock() }
        state = CUSyntheticFocusState()
    }
}
