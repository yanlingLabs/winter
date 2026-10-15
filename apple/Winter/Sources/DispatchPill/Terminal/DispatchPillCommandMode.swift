import Foundation

// MARK: - Delete to opt out (pure — `ShellCommandLineTests`)

/// The opt-out from command mode, as the spec words it. While command mode is ON, Delete/Backspace with the
/// caret at the END and nothing selected deletes nothing: it records the text, and that exact text is no
/// longer a command (it reads in the normal colour and sends as a message). Command mode comes back by itself
/// as soon as the text DIFFERS from the record and is valid again — more valid command typed, or a bit deleted
/// and retyped. The next Delete after the opt-out deletes normally (the mode is off for that text, so nothing
/// intercepts it).
///
/// The record is kept until `reset()` — a run, a send, Clear Draft — so the opted-out text stays a message
/// even if it is deleted and typed again exactly; any OTHER valid text is a command again.
struct CommandModeSuppression: Equatable {
    private(set) var suppressedText: String?

    /// Command mode for `text`, given whether it validates as a command.
    func isCommandMode(text: String, isValid: Bool) -> Bool {
        isValid && text != suppressedText
    }

    /// Delete/Backspace. Returns true when it was CONSUMED — the opt-out, with no character deleted.
    mutating func deleteBackward(text: String, isValid: Bool, caretAtEnd: Bool, hasSelection: Bool) -> Bool {
        guard caretAtEnd, !hasSelection, isCommandMode(text: text, isValid: isValid) else { return false }
        suppressedText = text
        return true
    }

    mutating func reset() { suppressedText = nil }
}

// MARK: - The live model the pill reads

/// Command mode for the Dispatch pill's composer: whether the draft is a command right now, and the ghost
/// completion after the caret. Validation never blocks typing: each edit schedules one evaluation, debounced,
/// on a background queue (the stat calls run there), and the verdict is memoized by text. Until a new verdict
/// lands the last one stands (`displaysCommand`), so the purple does not flicker off on every keystroke.
/// Return and Delete act only on a FRESH verdict for the exact text (`isActive(for:)`) — what the user saw
/// purple — and never ask zsh: Return never upgrades white text to a run (a quick structural recheck may only
/// downgrade it, say a path that vanished), and Delete opts out only of a purple that belongs to this text.
/// The memo is keyed by text alone (the working directory rarely changes under a draft).
@MainActor
final class DispatchPillCommandMode: ObservableObject {
    /// The draft the published state belongs to.
    @Published private(set) var evaluatedText = ""
    /// The evaluated draft validates as a command (before the opt-out).
    @Published private(set) var evaluatedValid = false
    /// The ghost completion for `evaluatedText`, or nil.
    @Published private(set) var ghost: String?
    /// When the ghost is an on-screen path: the offer it came from (Tab again cycles through it).
    private(set) var ghostOffer: OnScreenPathOffer?
    /// The opt-out record.
    @Published private(set) var suppression = CommandModeSuppression()

    let environment: CommandLineEnvironment
    /// Where a line would run — read when an evaluation is scheduled.
    var workingDirectory: () -> String
    /// The paths on screen in the app the user is in, most recent first (`OnScreenPathStore`) — read when an
    /// evaluation is scheduled.
    var onScreenPaths: () -> [String] = { [] }
    /// An evaluation is about to offer on-screen paths: refresh them if they are stale.
    var onScreenPathsWanted: (() -> Void)?
    /// Command mode turned ON for the draft (the pill reads the screen again then).
    var onCommandModeTurnedOn: (() -> Void)?

    /// Tab accepted an on-screen ghost: Tab again with the text unchanged cycles.
    private var cycle: OnScreenPathCycle?

    static let debounce: TimeInterval = 0.05
    static let memoLimit = 512

    private var memo: [String: Bool] = [:]
    private var lastDisplayed = false
    /// The newest edit's number — read from the evaluation queue, so it is locked, not actor-bound.
    private let latest = CommandModeGeneration()
    private let queue = DispatchQueue(label: "winter.dispatch-pill.command-mode", qos: .userInitiated)

    init(environment: CommandLineEnvironment, workingDirectory: @escaping () -> String) {
        self.environment = environment
        self.workingDirectory = workingDirectory
    }

    /// Command mode ON for `text` as last evaluated — what the composer colours and Delete reads.
    func isActive(for text: String) -> Bool {
        text == evaluatedText && suppression.isCommandMode(text: text, isValid: evaluatedValid)
    }

    /// What the composer draws for `text` while its own verdict may still be on its way: the memo's answer
    /// when it has one, else the last thing shown (sticky — no flicker between keystrokes).
    func displaysCommand(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        if let valid = memo[text] { return suppression.isCommandMode(text: text, isValid: valid) }
        return lastDisplayed
    }

    /// The ghost text to show after the caret for `text`, or nil.
    func ghost(for text: String) -> String? {
        text == evaluatedText ? ghost : nil
    }

    /// Tab, with the caret at the end of `text` (`ComposerTextView.onTab`): Tab AGAIN with the text unchanged since
    /// an on-screen path was accepted cycles to the next on-screen candidate; otherwise the ghost is accepted. Nil
    /// when there is nothing to do (AppKit's own Tab).
    func tab(text: String) -> ComposerTabEdit? {
        if var cycle, let edit = cycle.next(for: text) {
            self.cycle = cycle
            return edit
        }
        guard let ghost = ghost(for: text), !ghost.isEmpty else {
            cycle = nil
            return nil
        }
        cycle = ghostOffer.map(OnScreenPathCycle.init(accepting:))
        return ComposerTabEdit(replacingSuffix: "", insert: ghost)
    }

    /// Return's question: RUN this text? Only when a verdict for this exact text was already shown purple — Return
    /// never turns white text into a run. A quick structural recheck (stat calls; never zsh, never the engine
    /// lock) may still DOWNGRADE it to a message, e.g. when a path it names has vanished since.
    func shouldRunOnReturn(_ text: String) -> Bool {
        guard !text.isEmpty, isActive(for: text) else { return false }
        let snapshot = environment.snapshot()
        guard snapshot.enabled else { return false }
        return shellLineIsCommand(text, context: snapshot.context(workingDirectory: workingDirectory()))
    }

    /// Every edit of the draft.
    func draftChanged(_ text: String) {
        let generation = latest.bump()
        // An edit other than Tab's own ends the cycling.
        if let cycle, cycle.acceptedText != text { self.cycle = nil }
        if text.isEmpty {
            publish(text: "", valid: false, ghost: nil)
            return
        }
        guard environment.isEnabled else {
            publish(text: text, valid: false, ghost: nil)
            return
        }
        // An argument is being typed: the on-screen paths should be fresh for its ghost.
        if text.contains(where: \.isWhitespace) { onScreenPathsWanted?() }
        let cwd = workingDirectory()
        let paths = onScreenPaths()
        let environment = environment
        let latest = latest
        queue.asyncAfter(deadline: .now() + Self.debounce) { [weak self] in
            // Only the newest edit is evaluated; older ones were overtaken while they waited.
            guard latest.value == generation else { return }
            let result = Self.evaluate(text, environment: environment, workingDirectory: cwd, onScreenPaths: paths)
            DispatchQueue.main.async {
                guard let self else { return }
                self.remember(text, valid: result.valid)
                guard latest.value == generation else { return }
                self.publish(text: text, valid: result.valid, ghost: result.ghost)
            }
        }
    }

    /// Delete/Backspace from the composer (caret at the end, nothing selected — the text view checks).
    /// True when consumed: command mode was on, and the opt-out is recorded instead of a character deleted.
    func deleteBackward(text: String, caretAtEnd: Bool, hasSelection: Bool) -> Bool {
        // Only a purple that is a fresh verdict for THIS text — a stale one (still showing from the last keystroke)
        // lets Delete delete. Never an evaluation: Delete repeats as it is held.
        guard !text.isEmpty, isActive(for: text) else { return false }
        let consumed = suppression.deleteBackward(text: text, isValid: true, caretAtEnd: caretAtEnd,
                                                  hasSelection: hasSelection)
        if consumed {
            lastDisplayed = false
            ghost = nil
            ghostOffer = nil
        }
        return consumed
    }

    /// A run or a send spent the draft.
    func reset() {
        suppression.reset()
        cycle = nil
        latest.bump()
        publish(text: "", valid: false, ghost: nil)
    }

    // MARK: Evaluation

    private func evaluate(_ text: String, ghost: Bool = true) -> (valid: Bool, ghost: ShellGhost?) {
        let result = Self.evaluate(text, environment: environment, workingDirectory: workingDirectory(),
                                   onScreenPaths: onScreenPaths(), ghost: ghost)
        remember(text, valid: result.valid)
        return result
    }

    nonisolated static func evaluate(_ text: String, environment: CommandLineEnvironment, workingDirectory: String,
                                     onScreenPaths: [String] = [],
                                     ghost wantsGhost: Bool = true) -> (valid: Bool, ghost: ShellGhost?) {
        let snapshot = environment.snapshot()
        guard snapshot.enabled else { return (false, nil) }
        let context = snapshot.context(workingDirectory: workingDirectory)
        // The structural rules first (cheap); then, for a line that passes them, whole-command validation on
        // zsh's completion system within its budget — the prose guard when zsh cannot answer.
        var valid = shellLineIsCommand(text, context: context)
        if valid, snapshot.wholeCommandCheck {
            valid = shellCompletionCheckPasses(text, context: context, source: snapshot.completion,
                                               deadline: Date().addingTimeInterval(shellCompletionCheckBudget))
        }
        guard wantsGhost else { return (valid, nil) }
        // On-screen paths rank above the filesystem's and zsh's completion.
        let ghost = shellGhost(for: text, context: context, commandNames: snapshot.commandNames,
                               onScreenPaths: onScreenPaths, source: snapshot.completion,
                               deadline: Date().addingTimeInterval(shellCompletionGhostBudget))
        return (valid, ghost)
    }

    private func remember(_ text: String, valid: Bool) {
        if memo.count >= Self.memoLimit { memo.removeAll(keepingCapacity: true) }
        memo[text] = valid
    }

    private func publish(text: String, valid: Bool, ghost: ShellGhost?) {
        let wasDisplayed = lastDisplayed
        if evaluatedText != text { evaluatedText = text }
        if evaluatedValid != valid { evaluatedValid = valid }
        ghostOffer = ghost?.offer
        if self.ghost != ghost?.suffix { self.ghost = ghost?.suffix }
        lastDisplayed = suppression.isCommandMode(text: text, isValid: valid)
        if lastDisplayed, !wasDisplayed { onCommandModeTurnedOn?() }
    }

    // MARK: Test seams

    /// Evaluate and publish `text` at once, as the debounced path would once it lands.
    func evaluateNowForTesting(_ text: String) {
        latest.bump()
        let result = evaluate(text)
        publish(text: text, valid: result.valid, ghost: result.ghost)
    }
}

/// A counter two threads read: the main actor bumps it per edit, the evaluation queue checks it.
private final class CommandModeGeneration: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0

    var value: Int {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    @discardableResult
    func bump() -> Int {
        lock.lock(); defer { lock.unlock() }
        current += 1
        return current
    }
}
