import Foundation
import WinterProtocol

// The words on the Cowork composer's two chips. Pure, so `swift test` pins them: the folder chip in particular
// must not promise what the VM cannot do yet (owner decision O1 / design G1: no Mac folder can be mounted in the
// VM, so the first conversation works in its own outputs folder and the folder stays a source that is preparing).

/// A chip's visible title and its hover/accessibility line.
public struct CoworkChipCopy: Equatable, Sendable {
    public let title: String
    public let help: String
}

extension CoworkApprovalPolicy {
    /// Mirrors the app's `policyDisplayLabel` (the CLI footer's wording); an app test pins the two together.
    public var displayName: String {
        switch self {
        case .plan: return "Plan"
        case .dontAsk: return "Don't Ask"
        case .ask: return "Ask"
        case .acceptEdits: return "Accept Edits"
        case .auto: return "Auto"
        case .bypass: return "Bypass"
        }
    }
}

/// PURE: the working-folder chip.
public func coworkFolderChipCopy(_ choice: CoworkFolderChoice?) -> CoworkChipCopy {
    switch choice {
    case nil:
        return CoworkChipCopy(title: "Choose folder",
                              help: "Working folder: choose a folder for this Cowork workspace. It needs at least one.")
    case let .newWorkspace(folder)?:
        return CoworkChipCopy(
            title: folder.label,
            help: "\(folder.label) is added to a new workspace as a source. Winter can't share Mac folders with the VM yet, so it stays preparing and this conversation works in its own outputs folder instead.")
    case let .existingProject(_, title)?:
        return CoworkChipCopy(
            title: title,
            help: "This conversation joins the Project \(title). It shares the Project's folders and approval mode with the Project's other conversations, and works in its own outputs folder.")
    }
}

/// PURE: the approval-mode chip. A choice is the WORKSPACE's default, so the line says who else it reaches.
public func coworkApprovalChipCopy(_ policy: CoworkApprovalPolicy?) -> CoworkChipCopy {
    guard let policy else {
        return CoworkChipCopy(title: "Approval mode", help: "Approval mode: this workspace's own default. Choose one to change it.")
    }
    return CoworkChipCopy(
        title: policy.displayName,
        help: "Approval mode: \(policy.displayName). Saved as the workspace's default, so it applies to every conversation in it, not only this one.")
}

/// The line under the approval picker's title.
public let coworkApprovalPickerNote = "Changes the workspace's default for every conversation in it."

/// The line under the folder picker's title.
public let coworkFolderPickerNote = "Winter can't share Mac folders with the VM yet. Your folder joins the workspace as a source that stays preparing, and this conversation works in its own outputs folder."
