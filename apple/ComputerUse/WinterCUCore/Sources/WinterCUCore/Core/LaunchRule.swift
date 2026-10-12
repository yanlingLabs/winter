import Foundation

/// THE LAUNCH RULE as a DECISION TABLE (the user's process ruling, effective round 17 — begun in round 16): facts →
/// verdict as data, a test walking every row (`LaunchRuleTableTests`). PROTOCOL.md §4.12 is its prose. An app comes to
/// the front for the first time after its process started: which verdict its coming forward gets.
/// So far the guardian reads its NEVER-ADOPT gate off this table (`openerBeforeStart`); its undo (`clearlyTheAgents`)
/// and adoption (`launchIsTheirs`) paths still compute the same facts inline and are moved onto it in round 17.
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
    /// Hardware input of the user's (a key, a click, a switch input) between that act and the start.
    public var userInputBetween: Bool
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

    public init(afterAgentAct: Bool, userInputBetween: Bool, withinReach: Bool, quietBeforeStart: Bool, firstSighting: Bool,
                keysHidden: Bool, systemUI: Bool, visit: Bool) {
        self.afterAgentAct = afterAgentAct; self.userInputBetween = userInputBetween; self.withinReach = withinReach
        self.quietBeforeStart = quietBeforeStart; self.firstSighting = firstSighting; self.keysHidden = keysHidden
        self.systemUI = systemUI; self.visit = visit
    }

    /// Every combination of the facts (2^8): what a test walks.
    public static var allCases: [CULaunchFacts] {
        (0..<256).map { b in
            CULaunchFacts(afterAgentAct: b & 1 != 0, userInputBetween: b & 2 != 0, withinReach: b & 4 != 0,
                          quietBeforeStart: b & 8 != 0, firstSighting: b & 16 != 0, keysHidden: b & 32 != 0,
                          systemUI: b & 64 != 0, visit: b & 128 != 0)
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
        Row(name: "(1) their input between the act and the start: theirs", when: { $0.userInputBetween }, verdict: .theirs),
        Row(name: "(2) within reach, quiet before the start, keys visible: clearly the agent's",
            when: { $0.withinReach && $0.quietBeforeStart && !$0.keysHidden }, verdict: .undo),
        Row(name: "(3) otherwise: left and said", when: { _ in true }, verdict: .leftAndSaid),
    ]

    /// The verdict and the row that gave it.
    public static func decide(_ f: CULaunchFacts) -> (verdict: CULaunchVerdict, row: String) {
        for r in rows where r.when(f) { return (r.verdict, r.name) }
        return (.ordinary, "no row")  // (never: the last row always holds)
    }
}
