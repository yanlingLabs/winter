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
/// Return and Delete — actions, not typing — ask synchronously when the memo has no answer yet
/// (`isCommandNow`), so they act on the text as it is.
@MainActor
final class DispatchPillCommandMode: ObservableObject {
    /// The draft the published state belongs to.
    @Published private(set) var evaluatedText = ""
    /// The evaluated draft validates as a command (before the opt-out).
    @Published private(set) var evaluatedValid = false
    /// The ghost completion for `evaluatedText`, or nil.
    @Published private(set) var ghost: String?
    /// The opt-out record.
    @Published private(set) var suppression = CommandModeSuppression()

    let environment: CommandLineEnvironment
    /// Where a line would run — read when an evaluation is scheduled.
    var workingDirectory: () -> String

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

    /// Validity NOW — the memo, or a synchronous evaluation (Return and Delete are actions, not typing).
    func isCommandNow(_ text: String) -> Bool {
        let valid = memo[text] ?? evaluate(text).valid
        return suppression.isCommandMode(text: text, isValid: valid)
    }

    /// Every edit of the draft.
    func draftChanged(_ text: String) {
        let generation = latest.bump()
        if text.isEmpty {
            publish(text: "", valid: false, ghost: nil)
            return
        }
        guard environment.isEnabled else {
            publish(text: text, valid: false, ghost: nil)
            return
        }
        let cwd = workingDirectory()
        let environment = environment
        let latest = latest
        queue.asyncAfter(deadline: .now() + Self.debounce) { [weak self] in
            // Only the newest edit is evaluated; older ones were overtaken while they waited.
            guard latest.value == generation else { return }
            let result = Self.evaluate(text, environment: environment, workingDirectory: cwd)
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
        guard !text.isEmpty else { return false }
        let valid = memo[text] ?? evaluate(text).valid
        let consumed = suppression.deleteBackward(text: text, isValid: valid, caretAtEnd: caretAtEnd,
                                                  hasSelection: hasSelection)
        if consumed {
            lastDisplayed = false
            ghost = nil
        }
        return consumed
    }

    /// A run or a send spent the draft.
    func reset() {
        suppression.reset()
        latest.bump()
        publish(text: "", valid: false, ghost: nil)
    }

    // MARK: Evaluation

    private func evaluate(_ text: String) -> (valid: Bool, ghost: String?) {
        let result = Self.evaluate(text, environment: environment, workingDirectory: workingDirectory())
        remember(text, valid: result.valid)
        return result
    }

    nonisolated static func evaluate(_ text: String, environment: CommandLineEnvironment,
                                     workingDirectory: String) -> (valid: Bool, ghost: String?) {
        let snapshot = environment.snapshot()
        guard snapshot.enabled else { return (false, nil) }
        let context = snapshot.context(workingDirectory: workingDirectory)
        let valid = shellLineIsCommand(text, context: context)
        let ghost = shellCompletion(for: text, context: context, commandNames: snapshot.commandNames)
        return (valid, ghost)
    }

    private func remember(_ text: String, valid: Bool) {
        if memo.count >= Self.memoLimit { memo.removeAll(keepingCapacity: true) }
        memo[text] = valid
    }

    private func publish(text: String, valid: Bool, ghost: String?) {
        if evaluatedText != text { evaluatedText = text }
        if evaluatedValid != valid { evaluatedValid = valid }
        if self.ghost != ghost { self.ghost = ghost }
        lastDisplayed = suppression.isCommandMode(text: text, isValid: valid)
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
