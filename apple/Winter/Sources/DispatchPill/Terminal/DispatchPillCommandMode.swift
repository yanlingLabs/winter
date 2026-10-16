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

// MARK: - The ghost between verdicts (pure — `DispatchPillCommandModeTests`)

/// PURE: the ghost to show for `text` when the last verdict was for `evaluatedText` with `ghost`. The same text:
/// that ghost. The user typed on INTO it (the new characters are the ghost's next ones): the rest of it. The user
/// deleted back (`text` is a prefix of `evaluatedText`): what was deleted, then the ghost — still the same
/// completed line. Anything else: none until the next verdict.
func commandGhostContinuation(evaluatedText: String, ghost: String?, text: String) -> String? {
    guard let ghost, !ghost.isEmpty, !text.isEmpty else { return nil }
    if text == evaluatedText { return ghost }
    if text.hasPrefix(evaluatedText) {
        let typed = text.dropFirst(evaluatedText.count)
        guard ghost.hasPrefix(typed), ghost.count > typed.count else { return nil }
        return String(ghost.dropFirst(typed.count))
    }
    if evaluatedText.hasPrefix(text) {
        return String(evaluatedText.dropFirst(text.count)) + ghost
    }
    return nil
}

// MARK: - The live model the pill reads

/// Command mode for the Dispatch pill's composer: whether the draft is a command right now, and the ghost
/// completion after the caret. Validation never blocks typing: each edit schedules one evaluation, debounced,
/// on a background queue (the stat calls run there), and the verdict is memoized by text. Until a new verdict
/// lands the last one stands (`displaysCommand`), so the purple does not flicker off on every keystroke.
/// Return and Delete act only on a FRESH verdict for the exact text (`isActive(for:)`) — what the user saw
/// purple — and never touch the filesystem or zsh: Return never upgrades white text to a run, and Delete opts out
/// only of a purple that belongs to this text.
/// The memo is keyed by text alone (the working directory rarely changes under a draft).
@MainActor
final class DispatchPillCommandMode: ObservableObject {
    /// The draft the published state belongs to.
    @Published private(set) var evaluatedText = ""
    /// The evaluated draft validates as a command (before the opt-out).
    @Published private(set) var evaluatedValid = false
    /// The ghost completion for `evaluatedText`, or nil.
    @Published private(set) var ghost: String?
    /// The completion candidates for `evaluatedText`'s last word — what Tab cycles (`shellCompletionCandidates`).
    private(set) var candidates: ShellCandidates?
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

    /// Tab's cycle through the candidates, while it holds (`CompletionCycle`).
    @Published private(set) var cycle: CompletionCycle?

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

    /// The ghost text to show after the caret for `text`, or nil — STABLE between verdicts: while the next one is
    /// on its way the shown ghost stays, trimmed by what was typed into it (or grown by what was deleted), so a
    /// recompute that lands with the same suggestion changes nothing on screen (`commandGhostContinuation`).
    func ghost(for text: String) -> String? {
        commandGhostContinuation(evaluatedText: evaluatedText, ghost: ghost, text: text)
    }

    /// What the composer draws after the caret: the ghost — or, while Tab is cycling, a quiet "2/7" (which candidate
    /// is in, of how many) instead.
    func ghostDisplay(for text: String) -> String? {
        if let cycle, cycle.acceptedText == text {
            return cycle.position.map { "  \($0.index)/\($0.count)" }
        }
        return ghost(for: text)
    }

    /// Tab, with the caret at the end of `text` (`ComposerTextView.onTab`) — zsh's menu-complete: the first Tab puts
    /// in the candidates' common prefix (or the first candidate), each further Tab the next candidate, round and
    /// round (`CompletionCycle`). With no candidates for this exact text yet, the ghost is accepted. Nil when there
    /// is nothing to do (AppKit's own Tab).
    func tab(text: String) -> ComposerTabEdit? {
        if var cycle, let edit = cycle.step(text: text, forward: true) {
            self.cycle = cycle
            return edit
        }
        cycle = nil
        if text == evaluatedText, let candidates, let started = CompletionCycle.start(candidates) {
            cycle = started.cycle
            return started.edit
        }
        guard let ghost = ghost(for: text), !ghost.isEmpty else { return nil }
        return ComposerTabEdit(replacingSuffix: "", insert: ghost)
    }

    /// Shift-Tab: back one candidate — only while a cycle holds (nil otherwise: AppKit's own).
    func backTab(text: String) -> ComposerTabEdit? {
        guard var cycle, let edit = cycle.step(text: text, forward: false) else { return nil }
        self.cycle = cycle
        return edit
    }

    /// Any key but Tab and Shift-Tab: the cycle ends, keeping what it put in.
    func endCycle() {
        if cycle != nil { cycle = nil }
    }

    /// → (or ⌥→, `word`) at the end of `text` with a ghost showing (the text view checks the caret, the selection,
    /// marked text and the modifiers): the whole ghost, or its next word. Nil — the key's own meaning — when no
    /// ghost shows (a ghost exists only in command mode) or a cycle holds.
    func acceptGhost(text: String, word: Bool) -> ComposerTabEdit? {
        guard cycle?.acceptedText != text, let ghost = ghost(for: text), !ghost.isEmpty else { return nil }
        return ComposerTabEdit(replacingSuffix: "", insert: word ? commandGhostNextWord(ghost) : ghost)
    }

    /// Return's question: RUN this text? Only when a verdict for this exact text was already shown purple — Return
    /// never turns white text into a run. It reads the SHOWN verdict alone: no filesystem access on the main thread
    /// (a stat on a hung network mount would freeze the app), no zsh. The debounce keeps that verdict at most
    /// `debounce` older than the text.
    func shouldRunOnReturn(_ text: String) -> Bool {
        !text.isEmpty && environment.isEnabled && isActive(for: text)
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
                self.publish(text: text, valid: result.valid, ghost: result.ghost, candidates: result.candidates)
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
            candidates = nil
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

    private func evaluate(_ text: String, ghost: Bool = true) -> CommandEvaluation {
        let result = Self.evaluate(text, environment: environment, workingDirectory: workingDirectory(),
                                   onScreenPaths: onScreenPaths(), ghost: ghost)
        remember(text, valid: result.valid)
        return result
    }

    nonisolated static func evaluate(_ text: String, environment: CommandLineEnvironment, workingDirectory: String,
                                     onScreenPaths: [String] = [],
                                     ghost wantsGhost: Bool = true) -> CommandEvaluation {
        let snapshot = environment.snapshot()
        guard snapshot.enabled else { return CommandEvaluation(valid: false, ghost: nil, candidates: nil) }
        let context = snapshot.context(workingDirectory: workingDirectory)
        // The structural rules first (cheap); then, for a line that passes them, whole-command validation on
        // zsh's completion system within its budget — the prose guard when zsh cannot answer.
        var valid = shellLineIsCommand(text, context: context)
        if valid, snapshot.wholeCommandCheck {
            valid = shellCompletionCheckPasses(text, context: context, source: snapshot.completion,
                                               deadline: Date().addingTimeInterval(shellCompletionCheckBudget))
        }
        guard wantsGhost else { return CommandEvaluation(valid: valid, ghost: nil, candidates: nil) }
        // On-screen paths rank above the filesystem's and zsh's completion.
        let ghost = shellGhost(for: text, context: context, commandNames: snapshot.commandNames,
                               onScreenPaths: onScreenPaths, source: snapshot.completion,
                               deadline: Date().addingTimeInterval(shellCompletionGhostBudget))
        // What Tab would cycle — the same engine (its replies are memoized) and the same gates.
        let candidates = shellCompletionCandidates(for: text, context: context, commandNames: snapshot.commandNames,
                                                   onScreenPaths: onScreenPaths, source: snapshot.completion,
                                                   deadline: Date().addingTimeInterval(shellCompletionGhostBudget))
        return CommandEvaluation(valid: valid, ghost: ghost, candidates: candidates)
    }

    private func remember(_ text: String, valid: Bool) {
        if memo.count >= Self.memoLimit { memo.removeAll(keepingCapacity: true) }
        memo[text] = valid
    }

    private func publish(text: String, valid: Bool, ghost: ShellGhost?, candidates: ShellCandidates? = nil) {
        let wasDisplayed = lastDisplayed
        if evaluatedText != text { evaluatedText = text }
        if evaluatedValid != valid { evaluatedValid = valid }
        self.candidates = candidates
        if self.ghost != ghost?.suffix { self.ghost = ghost?.suffix }
        lastDisplayed = suppression.isCommandMode(text: text, isValid: valid)
        if lastDisplayed, !wasDisplayed { onCommandModeTurnedOn?() }
    }

    // MARK: Test seams

    /// Evaluate and publish `text` at once, as the debounced path would once it lands.
    func evaluateNowForTesting(_ text: String) {
        latest.bump()
        let result = evaluate(text)
        publish(text: text, valid: result.valid, ghost: result.ghost, candidates: result.candidates)
    }
}

/// One verdict: whether the text is a command, its ghost, and the candidates Tab would cycle.
struct CommandEvaluation {
    var valid: Bool
    var ghost: ShellGhost?
    var candidates: ShellCandidates?
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
