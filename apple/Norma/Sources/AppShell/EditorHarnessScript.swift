import Foundation

/// editor-plumbing Task 5 — **the drill run's sequencing and judging, with nothing in it that
/// touches CEF, a window, a file or a clock.**
///
/// `EditorBridgeHarness` (`#if DEBUG`, next door) owns the effects: it creates the browser, sends
/// each outbound message, drives CDP, writes files and screenshots. This file owns the part of the
/// run that can be *wrong in a way no live run would notice* — what the next step is, which arriving
/// message satisfies it, and which one condemns it. Splitting them is what lets the whole ordering
/// contract be executed by the unit suite on a machine where Chromium never starts.
///
/// **Not `#if DEBUG`, unlike the harness it serves.** The gate would make the test bundle's ability
/// to compile depend on the configuration, and this half is pure `Foundation` data with no
/// instantiation anywhere in the product.
///
/// ## The three judgements that are the point of extracting it
///
///  1. **A `contentResponse` for the wrong `seq` FAILS the step** — it never waits for a better one.
///     The save protocol's whole correctness is that `seq` anchors an acknowledgement to the pull it
///     acknowledges (`EditorBridgeOutbound.markSaved`), and a harness that quietly skipped a
///     mismatched answer would report the race drill green whatever the page did.
///  2. **A timeout is an EVENT, not an exception** — so "nothing arrived" is judged by the same
///     function as "something arrived", and the one expectation whose PASS is a timeout
///     (`.silence`) is not a special case bolted onto the driver.
///  3. **Text is compared as UTF-8 BYTES.** Swift's `String ==` is canonical equivalence: `"é"` as
///     U+00E9 and as `e` + U+0301 are the same `String` and different files. The round-trip drills
///     exist to prove a byte-identical round trip, so `String ==` would be the one comparison that
///     cannot see the failure it was written for.
enum EditorHarnessVerdict: Equatable {
    /// Nothing conclusive yet — keep waiting on this step.
    case pending
    /// The step is satisfied. The payload is the evidence, verbatim, for the transcript.
    case passed(String)
    /// The step is condemned. The payload is why, in enough detail to act on without a re-run.
    case failed(String)

    var isConclusive: Bool { self != .pending }
}

/// What the script is waiting for after a step's action has been performed.
enum EditorHarnessExpectation: Equatable {
    /// The page booted. Nothing may be sent before this.
    case ready
    /// Exactly this dirty transition, for exactly this path.
    case dirty(path: String, dirty: Bool)
    /// An answer to a pull: this path, this `seq`, and these bytes.
    case content(path: String, seq: UInt64, text: String)
    /// ⌘S reached Monaco's command.
    case saveRequested(path: String)
    /// **Nothing of these wire types may arrive before the step's timeout, and the timeout is the
    /// PASS.** The race drill's central assertion is an absence — a `markSaved` for a superseded
    /// pull must clear nothing — and an absence has no message to wait for.
    case silence(types: [String])
    /// The driver judges this one itself (a CDP read, a file write, a screenshot) and reports the
    /// answer as `.local`. The script still owns WHEN it is asked and what a timeout means.
    case local

    /// For failure messages and the transcript.
    var describedForTranscript: String {
        switch self {
        case .ready:
            return "ready"
        case .dirty(let path, let dirty):
            return "modelDirtyChanged { path: \(path), dirty: \(dirty) }"
        case .content(let path, let seq, let text):
            return "contentResponse { path: \(path), seq: \(seq), \(text.utf8.count) byte(s) }"
        case .saveRequested(let path):
            return "saveRequested { path: \(path) }"
        case .silence(let types):
            return "silence (no \(types.joined(separator: "/")) before the timeout)"
        case .local:
            return "a locally judged result"
        }
    }
}

/// Everything that can move the script forward.
enum EditorHarnessEvent: Equatable {
    /// A decoded message the page sent over the bridge.
    case bridge(EditorBridgeInbound)
    /// The current step's window elapsed.
    case timeout
    /// The driver finished judging a `.local` step.
    case local(ok: Bool, detail: String)
}

/// One drill step: an identity, the drill it belongs to, and what must then happen.
///
/// The ACTION is not here. A step's effect needs the driver's live state (the text a pull just
/// answered with, the browser that exists), so it lives in the harness's `perform(_:)` switch keyed
/// by `id`. What is here is everything a test can check without Chromium.
struct EditorHarnessStep: Equatable {
    /// Stable, unique, and the key the driver's action switch matches on.
    let id: String
    /// Which of the plan's drills this step belongs to — the transcript groups by it.
    let drill: Int
    /// One line, for the harness window and the transcript.
    let title: String
    let expectation: EditorHarnessExpectation
    /// How long the step may wait. For `.silence` this is how long the absence must hold.
    let timeout: TimeInterval
}

/// The run: an ordered step list, a cursor, and the one function that moves it.
struct EditorHarnessScript: Equatable {
    private(set) var steps: [EditorHarnessStep]
    private(set) var index: Int = 0
    /// Verdicts in the order they were reached, one per finished step.
    private(set) var results: [(id: String, drill: Int, title: String, verdict: EditorHarnessVerdict)] = []
    /// Bridge messages that arrived while a step of a different shape was current. Recorded rather
    /// than judged — the page legitimately interleaves (an external write emits its dirty transition
    /// while a pull is in flight) — but never dropped: an unexplained stray is how a real defect
    /// would first show itself.
    private(set) var strays: [String] = []

    init(steps: [EditorHarnessStep]) {
        self.steps = steps
    }

    static func == (lhs: EditorHarnessScript, rhs: EditorHarnessScript) -> Bool {
        return lhs.steps == rhs.steps && lhs.index == rhs.index && lhs.strays == rhs.strays
            && lhs.results.map({ [$0.id, "\($0.verdict)"] }) == rhs.results.map({ [$0.id, "\($0.verdict)"] })
    }

    var current: EditorHarnessStep? {
        return index < steps.count ? steps[index] : nil
    }

    var isFinished: Bool { index >= steps.count }

    var passedCount: Int {
        return results.filter { if case .passed = $0.verdict { return true } else { return false } }.count
    }

    var failedCount: Int {
        return results.filter { if case .failed = $0.verdict { return true } else { return false } }.count
    }

    /// **Judge one event against the current step.**
    ///
    /// A conclusive verdict — pass OR fail — records the step and moves the cursor on. **Failure
    /// does not stop the run**, deliberately: a harness that halted on the first red would leave
    /// every later drill unmeasured and the transcript would say nothing about them, when the
    /// question the run exists to answer is which of eleven independent claims hold. The
    /// consequences of a failed step land on the steps that depend on it, and they say so in their
    /// own verdicts.
    @discardableResult
    mutating func advance(event: EditorHarnessEvent) -> EditorHarnessVerdict {
        guard let step = current else {
            // Past the end. Everything still arriving is recorded and nothing is judged — a page
            // that keeps talking after the script is done is information, not a failure.
            strays.append("after the script ended: \(Self.describe(event))")
            return .pending
        }

        let verdict = Self.judge(event: event, against: step.expectation)
        guard verdict.isConclusive else {
            if case .bridge = event {
                strays.append("step \(step.id) was waiting for \(step.expectation.describedForTranscript) "
                              + "— ignored \(Self.describe(event))")
            }
            return .pending
        }
        results.append((id: step.id, drill: step.drill, title: step.title, verdict: verdict))
        index += 1
        return verdict
    }

    /// The judging itself — `static`, so every case is a function of its two arguments and nothing
    /// else, and a test can ask it a question without building a run.
    static func judge(event: EditorHarnessEvent, against expectation: EditorHarnessExpectation) -> EditorHarnessVerdict {
        switch event {
        case .timeout:
            if case .silence(let types) = expectation {
                return .passed("nothing of \(types.joined(separator: "/")) arrived — the absence held")
            }
            return .failed("timed out waiting for \(expectation.describedForTranscript)")

        case .local(let ok, let detail):
            guard case .local = expectation else {
                // The driver reported a local answer for a step that is waiting on the page. That is
                // a harness bug, and a silent one if it were ignored: the step would then sit until
                // its timeout and be reported as a page failure it never caused.
                return .failed("a locally judged result arrived while the step was waiting for "
                               + "\(expectation.describedForTranscript): \(detail)")
            }
            return ok ? .passed(detail) : .failed(detail)

        case .bridge(let message):
            return judgeBridge(message, against: expectation)
        }
    }

    private static func judgeBridge(_ message: EditorBridgeInbound,
                                    against expectation: EditorHarnessExpectation) -> EditorHarnessVerdict {
        if case .silence(let types) = expectation {
            guard types.contains(message.wireType) else { return .pending }
            return .failed("the page spoke when it had to stay silent: \(describe(.bridge(message)))")
        }
        if case .local = expectation { return .pending }

        // **Same kind → judged; different kind → ignored.** The page emits transitions on its own
        // schedule and a strict "next message must be mine" would fail on legal interleaving. What
        // this must never do is treat a WRONG member of the right kind as "not for me and therefore
        // fine", which is the whole of the two guards below.
        switch (expectation, message) {
        case (.ready, .ready):
            return .passed("ready")

        case (.dirty(let path, let dirty), .modelDirtyChanged(let gotPath, let gotDirty)):
            guard gotPath == path else {
                return .failed("modelDirtyChanged for the wrong model — expected \(path), got \(gotPath)")
            }
            guard gotDirty == dirty else {
                return .failed("\(path) reported dirty = \(gotDirty); the step required \(dirty)")
            }
            return .passed("modelDirtyChanged { \(path), dirty: \(dirty) }")

        case (.saveRequested(let path), .saveRequested(let gotPath)):
            guard gotPath == path else {
                return .failed("saveRequested named \(gotPath), not \(path)")
            }
            return .passed("saveRequested { \(path) }")

        case (.content(let path, let seq, let text), .contentResponse(let gotPath, let gotSeq, let gotText)):
            guard gotPath == path else {
                return .failed("contentResponse for the wrong model — expected \(path), got \(gotPath)")
            }
            // **The out-of-order pin.** A late answer to a superseded pull carries the OLD seq, and
            // accepting it would judge the wrong bytes and, worse, prove the anchor with an
            // acknowledgement the page had already forgotten.
            guard gotSeq == seq else {
                return .failed("contentResponse carried seq \(gotSeq); this step pulled seq \(seq) "
                               + "— an answer to a superseded pull is not an answer to this one")
            }
            if let difference = firstByteDifference(expected: text, actual: gotText) {
                return .failed("the round trip was not byte-identical: \(difference)")
            }
            return .passed("contentResponse { \(path), seq: \(seq) } — \(text.utf8.count) byte(s), identical")

        default:
            return .pending
        }
    }

    /// **UTF-8 bytes, not `String`.** See this file's header for why `String ==` cannot be used
    /// here. Returns `nil` when the two are byte-identical, and otherwise a description precise
    /// enough to act on: where they first diverge, what each holds there, and both lengths.
    static func firstByteDifference(expected: String, actual: String) -> String? {
        let want = Array(expected.utf8)
        let got = Array(actual.utf8)
        if want == got { return nil }
        var offset = 0
        while offset < want.count && offset < got.count && want[offset] == got[offset] {
            offset += 1
        }
        let wantByte = offset < want.count ? String(format: "0x%02x", want[offset]) : "<end>"
        let gotByte = offset < got.count ? String(format: "0x%02x", got[offset]) : "<end>"
        return "first difference at byte \(offset) — expected \(wantByte), got \(gotByte) "
            + "(expected \(want.count) byte(s), got \(got.count))"
    }

    static func describe(_ event: EditorHarnessEvent) -> String {
        switch event {
        case .timeout:
            return "a timeout"
        case .local(let ok, let detail):
            return "a local result (\(ok ? "ok" : "not ok")): \(detail)"
        case .bridge(let message):
            switch message {
            case .ready:
                return "ready"
            case .modelDirtyChanged(let path, let dirty):
                return "modelDirtyChanged { \(path), dirty: \(dirty) }"
            case .saveRequested(let path):
                return "saveRequested { \(path) }"
            case .contentResponse(let path, let seq, let text):
                return "contentResponse { \(path), seq: \(seq), \(text.utf8.count) byte(s) }"
            }
        }
    }
}

// MARK: - What Monaco will hand back

/// **The text a Monaco model returns for text you put into it — which is not always the text you
/// put in.**
///
/// A round-trip drill that compares bytes has to know this, or it measures the harness's ignorance
/// instead of the bridge. Monaco's buffer builder NORMALISES line endings on construction, so a file
/// with mixed EOLs comes back with one kind throughout. That is a real, shipped property of the
/// editor — mixed-EOL files are rewritten on the first save — and it belongs in the drill's
/// EXPECTATION, computed, rather than being discovered as a mysterious red.
///
/// **Ported from the vendored build, not from memory** (`vendor/monaco/vs/editor/editor.main.js`,
/// `PieceTreeTextBufferBuilder`):
///
/// ```js
/// finish(_ = !0) { … new E(chunks, BOM, cr, lf, crlf, …, _) }          // normalizeEOL defaults TRUE
/// _getEOL(defaultEOL) { const b = cr+lf+crlf, p = cr+crlf;
///                       return b === 0 ? (defaultEOL === 1 ? "\n" : "\r\n")
///                                      : (p > b/2 ? "\r\n" : "\n") }
/// create(defaultEOL) { const b = this._getEOL(defaultEOL);
///   if (this._normalizeEOL && ((b === "\r\n" && (cr > 0 || lf > 0)) ||
///                              (b === "\n"   && (cr > 0 || crlf > 0))))
///     …chunk.buffer.replace(/\r\n|\r|\n/g, b)… }
/// ```
///
/// `defaultEOL` is `1` (LF) in `TextModel.DEFAULT_CREATION_OPTIONS`, and `setValue` rebuilds the
/// buffer from the NEW text through the same path — so an external write brings its own EOL with it
/// rather than inheriting the model's.
///
/// So the rule in one sentence: **the majority wins, and it is a STRICT majority — an exact tie
/// goes to LF, never CRLF**, because both the vendored `p > b/2` and this port use `>`, not `>=`.
/// **"Uniform" is not "untouched", either** — a file that uses lone CRs throughout is internally
/// uniform, but the majority rule still picks CRLF for it (every one of its terminators is
/// CR-bearing), so every lone CR is rewritten to CRLF rather than left alone. Only a text whose
/// terminators already match what the rule would pick — uniform LF, or uniform CRLF — survives
/// untouched.
enum MonacoTextBuffer {
    /// What `model.getValue()` will answer for a model created (or `setValue`d) with `text`.
    static func normalisedEOL(_ text: String) -> String {
        let counts = terminatorCounts(text)
        let total = counts.cr + counts.lf + counts.crlf
        let carriageBearing = counts.cr + counts.crlf
        // `b === 0` → `defaultEOL === 1` → LF. A text with no line terminator at all is returned as
        // it is either way; the branch is kept so the port reads against its source.
        let eol: String = total == 0 ? "\n" : (carriageBearing * 2 > total ? "\r\n" : "\n")
        let mustRewrite = (eol == "\r\n" && (counts.cr > 0 || counts.lf > 0))
            || (eol == "\n" && (counts.cr > 0 || counts.crlf > 0))
        guard mustRewrite else { return text }
        // A byte scan rather than three chained `replacingOccurrences` through a placeholder: the
        // placeholder trick needs a character the text cannot contain, and this channel carries
        // whatever the user's file holds. `/\r\n|\r|\n/g` is one left-to-right pass, and so is this.
        let replacement = Array(eol.utf8)
        let bytes = Array(text.utf8)
        var out: [UInt8] = []
        out.reserveCapacity(bytes.count + 8)
        var index = 0
        while index < bytes.count {
            if bytes[index] == 0x0D {
                out.append(contentsOf: replacement)
                index += (index + 1 < bytes.count && bytes[index + 1] == 0x0A) ? 2 : 1
            } else if bytes[index] == 0x0A {
                out.append(contentsOf: replacement)
                index += 1
            } else {
                out.append(bytes[index])
                index += 1
            }
        }
        // The input came from a `String`, so the bytes are valid UTF-8 and only ASCII terminators
        // were substituted — the decode cannot fail, and the fallback is the untouched text rather
        // than a crash in a debug harness.
        return String(bytes: out, encoding: .utf8) ?? text
    }

    /// Lone CRs, lone LFs and CRLF pairs, counted the way `acceptChunk` counts them.
    static func terminatorCounts(_ text: String) -> (cr: Int, lf: Int, crlf: Int) {
        var cr = 0, lf = 0, crlf = 0
        let bytes = Array(text.utf8)
        var index = 0
        while index < bytes.count {
            if bytes[index] == 0x0D {
                if index + 1 < bytes.count && bytes[index + 1] == 0x0A {
                    crlf += 1
                    index += 2
                    continue
                }
                cr += 1
            } else if bytes[index] == 0x0A {
                lf += 1
            }
            index += 1
        }
        return (cr, lf, crlf)
    }
}
