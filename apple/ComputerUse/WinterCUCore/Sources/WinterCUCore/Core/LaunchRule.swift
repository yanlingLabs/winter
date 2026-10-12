import Foundation

/// THE LAUNCH RULE as a DECISION TABLE (the user's process ruling, effective round 17 — begun in round 16): facts →
/// verdict as data, a test walking every row (`LaunchRuleTableTests`). PROTOCOL.md §4.12 is its prose. An app comes to
/// the front for the first time after its process started: which verdict its coming forward gets.
/// Every path that attributes a launch decides through it (round 18): the guardian's `launchVerdict` reads each fact
/// from the world (its own records of the user's input, the agent's acts and launches, Secure Event Input, the first
/// sightings) and the never-adopt gate, the undo and the adoption all read that one verdict.
public enum CULaunchVerdict: String, Equatable, Sendable {
    /// Theirs: adopted as the user's place.
    case theirs
    /// Clearly the agent's: undone and said.
    case undo
    /// Left in front and said — never adopted, never undone.
    case leftAndSaid
    /// Not this rule's: the ordinary rules decide (a visit's, a launch with no agent act before it).
    case ordinary
}

/// The facts the rule reads, each one a plain yes or no.
public struct CULaunchFacts: Hashable, Sendable, CaseIterable {
    /// An agent opener act (any reach) or a pending launch of the agent's came within the causal window before the start.
    public var afterAgentAct: Bool
    /// LAUNCH-CAPABLE input of the user's between that act and the start (R17-d (i), the controller's ruling): a click,
    /// Return/Enter, a chord with ⌘/⌃/⌥, a function key — never plain typing, a key-up or a scroll.
    public var userInputBetween: Bool
    /// An INTERACTIVE LAUNCHER within the causal window before the start (R17-d (ii)): a Return or click whose destination
    /// is Spotlight (or a launcher), the Dock or Launchpad, or a Finder double-click.
    public var launcherBefore: Bool
    /// The app is within that act's reach (the act could have opened it).
    public var withinReach: Bool
    /// No input of the user's in the 2.5 s before the start (an interactive launcher — Spotlight's Return, a Dock click,
    /// a Finder double-click — never passes this).
    public var quietBeforeStart: Bool
    /// Its first sighting in front (a second's grace for the same state heard again by another path).
    public var firstSighting: Bool
    /// The user's keys are hidden from the session tap (Secure Event Input on, or no input observable at all).
    public var keysHidden: Bool
    /// A system dialog's process (permission, authentication).
    public var systemUI: Bool
    /// A desktop visit is open.
    public var visit: Bool
    /// Input of the user's since the start (a key or a click by the judgment), or their keys hidden now — then (2) leaves
    /// it rather than undoes it (R18 L2: was computed outside the table).
    public var inputSinceStart: Bool

    public init(afterAgentAct: Bool, userInputBetween: Bool, launcherBefore: Bool = false, withinReach: Bool,
                quietBeforeStart: Bool, firstSighting: Bool, keysHidden: Bool, systemUI: Bool, visit: Bool,
                inputSinceStart: Bool = false) {
        self.inputSinceStart = inputSinceStart
        self.afterAgentAct = afterAgentAct; self.userInputBetween = userInputBetween; self.launcherBefore = launcherBefore
        self.withinReach = withinReach
        self.quietBeforeStart = quietBeforeStart; self.firstSighting = firstSighting; self.keysHidden = keysHidden
        self.systemUI = systemUI; self.visit = visit
    }

    /// Every combination of the facts (2^10): what a test walks.
    public static var allCases: [CULaunchFacts] {
        (0..<1024).map { b in
            CULaunchFacts(afterAgentAct: b & 1 != 0, userInputBetween: b & 2 != 0, launcherBefore: b & 256 != 0,
                          withinReach: b & 4 != 0, quietBeforeStart: b & 8 != 0, firstSighting: b & 16 != 0,
                          keysHidden: b & 32 != 0, systemUI: b & 64 != 0, visit: b & 128 != 0, inputSinceStart: b & 512 != 0)
        }
    }

    /// The facts by name, for the fact-flip test and the log.
    public static let names: [String] = ["afterAgentAct", "userInputBetween", "launcherBefore", "withinReach",
                                         "quietBeforeStart", "firstSighting", "keysHidden", "systemUI", "visit", "inputSinceStart"]
    public subscript(_ name: String) -> Bool {
        get {
            switch name {
            case "afterAgentAct": return afterAgentAct
            case "userInputBetween": return userInputBetween
            case "launcherBefore": return launcherBefore
            case "withinReach": return withinReach
            case "quietBeforeStart": return quietBeforeStart
            case "firstSighting": return firstSighting
            case "keysHidden": return keysHidden
            case "systemUI": return systemUI
            case "visit": return visit
            case "inputSinceStart": return inputSinceStart
            default: preconditionFailure("no fact \(name)")
            }
        }
        set {
            switch name {
            case "afterAgentAct": afterAgentAct = newValue
            case "userInputBetween": userInputBetween = newValue
            case "launcherBefore": launcherBefore = newValue
            case "withinReach": withinReach = newValue
            case "quietBeforeStart": quietBeforeStart = newValue
            case "firstSighting": firstSighting = newValue
            case "keysHidden": keysHidden = newValue
            case "systemUI": systemUI = newValue
            case "visit": visit = newValue
            case "inputSinceStart": inputSinceStart = newValue
            default: preconditionFailure("no fact \(name)")
            }
        }
    }
}

public enum CULaunchRule {
    public struct Row: Sendable {
        public let name: String
        public let when: @Sendable (CULaunchFacts) -> Bool
        public let verdict: CULaunchVerdict
    }

    /// The table, read top to bottom; the first row whose condition holds decides.
    public static let rows: [Row] = [
        Row(name: "a desktop visit is open: the visit's rules", when: { $0.visit }, verdict: .ordinary),
        Row(name: "not its first sighting: the ordinary rules", when: { !$0.firstSighting }, verdict: .ordinary),
        Row(name: "no agent act before its start: the ordinary rules", when: { !$0.afterAgentAct }, verdict: .ordinary),
        Row(name: "a system dialog: left for the user to answer", when: { $0.systemUI }, verdict: .leftAndSaid),
        Row(name: "(1) their launch-capable input between the act and the start, or an interactive launcher before it: theirs",
            when: { $0.userInputBetween || $0.launcherBefore }, verdict: .theirs),
        Row(name: "(2) within reach, quiet before the start, keys visible, no input since: clearly the agent's",
            when: { $0.withinReach && $0.quietBeforeStart && !$0.keysHidden && !$0.inputSinceStart }, verdict: .undo),
        Row(name: "(3) otherwise: left and said", when: { _ in true }, verdict: .leftAndSaid),
    ]

    /// The verdict and the row that gave it.
    public static func decide(_ f: CULaunchFacts) -> (verdict: CULaunchVerdict, row: String) {
        for r in rows where r.when(f) { return (r.verdict, r.name) }
        return (.ordinary, "no row")  // (never: the last row always holds)
    }
}
