import Foundation

/// editor-plumbing Task 3 — **the whole vocabulary spoken between the editor page and Swift**, one
/// enum per direction, and the only place either side's wire names are written on the Swift side.
///
/// The transport underneath is CEF's message router: the page calls `window.cefQuery` (wrapped by
/// its own `bridge-protocol.js`, Task 4) and the browser process delivers the request JSON to the
/// block registered with `NormaCEFSetBridgeHandler` (`NormaCEF.h`). This file is what turns those
/// bytes into something typed, and what turns a Swift decision back into one line of JavaScript.
///
/// ## Two rules this file exists to hold
///
/// **1. The page is DATA, never code.** Every outbound message renders as exactly one call to one
/// literal entry point — `window.normaEditor.dispatch(<json>)` — with the payload as a JSON
/// argument. Nothing a user's file contains can become an expression: a path, a language name and
/// a whole file's text all travel as JSON string values, which the page's `dispatch` reads off an
/// object. This is the same discipline `NormaCEF.h` states for the CDP door ("`method` is always a
/// literal … a model string may be a PARAMS VALUE, and only where the value is data by
/// construction"), applied to the one channel that carries the most attacker-shaped bytes in the
/// app: the contents of whatever file the user opened.
///
/// **2. Inbound is untrusted and answers `nil` rather than guessing.** Malformed JSON, an unknown
/// `type`, a missing or wrongly-typed field, or a frame over `editorBridgeMaxInboundBytes` all
/// decode to `nil`. There is deliberately no partially-built case and no defaulted field — a
/// `saveRequested` with no path would otherwise become a save of `""`.
///
/// Unknown MEMBERS are ignored, which is the one deliberate leniency: the page may start sending a
/// field before Swift reads it, and that must not break the message it rides on.

/// The largest inbound frame Swift will look at, in UTF-8 bytes of the whole JSON.
///
/// 8 MiB, matching the daemon's NDJSON frame ceiling rather than being invented here — the phone
/// transport hard-fails on oversized frames for the same reason this refuses them: an unbounded
/// field on a channel that carries file contents is a channel with no worst case. A `contentResponse`
/// for a file bigger than this is refused whole; the editor keeps its own copy either way, so the
/// failure mode is "Norma does not write a 9 MiB file it was never asked to open", not data loss.
let editorBridgeMaxInboundBytes = 8 * 1024 * 1024

/// **Page → Swift.** What the editor tells the app.
enum EditorBridgeInbound: Equatable {
    /// The page has loaded, Monaco is up, and `window.normaEditor.dispatch` exists. Nothing may be
    /// sent to the page before this arrives.
    case ready
    /// A model's dirty flag flipped — the tab's modified dot follows this and nothing else.
    case modelDirtyChanged(path: String, dirty: Bool)
    /// The user asked to save (⌘S in the editor). Swift owns the write; the page owns nothing on
    /// disk.
    case saveRequested(path: String)
    /// The answer to an `EditorBridgeOutbound.pullContent`. `seq` is the pull's own number, echoed
    /// back so a late answer to a superseded pull can be told from the current one.
    case contentResponse(path: String, seq: UInt64, text: String)

    /// **The wire vocabulary, in order.** The page carries the same list
    /// (`bridge-protocol.js`'s `INBOUND_MESSAGE_TYPES`) and a test compares them literally — this
    /// repo's standing discipline for a vocabulary that exists twice in two languages, the same one
    /// `REMOTE_ALLOWED_METHODS` and its parity test hold on the daemon side.
    static let wireTypes: [String] = ["ready", "modelDirtyChanged", "saveRequested", "contentResponse"]

    /// The name this case travels under. Kept beside `wireTypes` so neither can drift from the
    /// other unnoticed: a test walks the list, decodes one fixture per name, and asserts the case
    /// it gets back names itself the same way.
    var wireType: String {
        switch self {
        case .ready: return "ready"
        case .modelDirtyChanged: return "modelDirtyChanged"
        case .saveRequested: return "saveRequested"
        case .contentResponse: return "contentResponse"
        }
    }

    /// Decode one frame. `nil` for anything this does not understand completely — see the file
    /// header for why that is total rather than best-effort.
    static func decode(_ json: String) -> EditorBridgeInbound? {
        // The cap is checked on the BYTES, before any parse. `String.count` would count grapheme
        // clusters and `utf16.count` would undercount emoji; the frame's cost is its UTF-8 length,
        // which is also what the transport measured.
        guard json.utf8.count <= editorBridgeMaxInboundBytes else { return nil }

        guard let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let object = parsed as? [String: Any],
              let type = object["type"] as? String else {
            return nil
        }

        switch type {
        case "ready":
            return .ready
        case "modelDirtyChanged":
            guard let path = string(object["path"]), let dirty = bool(object["dirty"]) else { return nil }
            return .modelDirtyChanged(path: path, dirty: dirty)
        case "saveRequested":
            guard let path = string(object["path"]) else { return nil }
            return .saveRequested(path: path)
        case "contentResponse":
            guard let path = string(object["path"]),
                  let seq = unsigned(object["seq"]),
                  let text = string(object["text"]) else {
                return nil
            }
            return .contentResponse(path: path, seq: seq, text: text)
        default:
            // An unknown type is refused rather than ignored: the page and Swift ship together, so
            // a name Swift has never heard of means the two halves have drifted, and guessing is
            // the wrong answer to that.
            return nil
        }
    }

    private static func string(_ value: Any?) -> String? {
        return value as? String
    }

    /// A JSON `true`/`false` and nothing else. Foundation hands both booleans and numbers back as
    /// `NSNumber`, so a plain `as? Bool` would also accept `1` — this asks the bridged object what
    /// it actually is.
    private static func bool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return nil
        }
        return number.boolValue
    }

    /// A non-negative whole number that fits a `UInt64`. Swift's `NSNumber` conditional cast is
    /// value-preserving, so `-1` and `1.5` answer `nil` on their own; the boolean check in front of
    /// it is what keeps `true` from arriving as `1`.
    private static func unsigned(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }
        return number as? UInt64
    }
}

/// **Swift → page.** What the app tells the editor, rendered as the one JavaScript call the page
/// exposes.
enum EditorBridgeOutbound {
    /// Open a file in the editor: create the model, give it a language, fill it with `text`.
    case openModel(path: String, language: String, text: String)
    /// Bring an already-open model to the front.
    case activateModel(path: String)
    /// Drop a model the app is done with.
    case closeModel(path: String)
    /// Ask for a model's current text. The answer is an `EditorBridgeInbound.contentResponse`
    /// carrying the same `seq` — Swift never reads the editor's buffer directly.
    case pullContent(path: String, seq: UInt64)
    /// Replace a model's text with something that changed outside the editor (an agent edit, a
    /// reload from disk).
    case applyExternalContent(path: String, text: String)
    /// Restyle the editor. `tokensJSON` is a JSON OBJECT as a string — Norma's own theme tokens —
    /// embedded as an object so the page reads `message.tokens.…` rather than parsing a string.
    case setTheme(tokensJSON: String)
    /// **The save acknowledgement**: Swift has written to disk the content that `pullContent`'s
    /// `seq` answered with, so the page moves that model's saved point to **that** version and
    /// recomputes the dirty flag (emitting the resulting `modelDirtyChanged`, as for any transition).
    ///
    /// This case exists because nothing else could say it. The page's dirty flag is
    /// `alternativeVersionId != savedVersionId`, and `savedVersionId` otherwise moves only when a
    /// model is opened or externally replaced — so a saved file would keep its modified dot forever.
    /// The tempting shortcut, acking a save with `applyExternalContent(text: whatWasWritten)`, is a
    /// trap: it routes through Monaco's `setValue`, whose `_setValueFromTextBuffer` clears the
    /// model's command manager, and would silently throw away the user's undo history on every save.
    /// This message touches no content, no undo stack and no view state.
    ///
    /// **`seq` is not bookkeeping — it is the whole correctness of the acknowledgement.** Between
    /// Swift reading `contentResponse` and sending this, the user may type. A path-only ack would
    /// clear the dot against a buffer that no longer matches disk, and the trailing edits would be
    /// lost at the next close-without-prompt. This side cannot detect that: a keystroke on an
    /// already-dirty model emits nothing, because the page reports transitions only. Anchoring the
    /// ack to the pull it acknowledges makes the page compute "still dirty" on its own. **Send the
    /// `seq` of the pull whose text was written — never a fresh number**; the page fails closed on a
    /// `seq` it does not recognise (it warns and clears nothing) rather than guessing.
    case markSaved(path: String, seq: UInt64)

    /// The wire vocabulary, in order. See `EditorBridgeInbound.wireTypes` — the page's
    /// `OUTBOUND_MESSAGE_TYPES` is the other half, and a test compares them literally.
    static let wireTypes: [String] = [
        "openModel", "activateModel", "closeModel", "pullContent", "applyExternalContent",
        "setTheme", "markSaved"
    ]

    var wireType: String {
        switch self {
        case .openModel: return "openModel"
        case .activateModel: return "activateModel"
        case .closeModel: return "closeModel"
        case .pullContent: return "pullContent"
        case .applyExternalContent: return "applyExternalContent"
        case .setTheme: return "setTheme"
        case .markSaved: return "markSaved"
        }
    }

    /// **One call, one literal entry point, payload as data.** The whole Swift-facing API the page
    /// exposes is `window.normaEditor.dispatch`; everything this enum can say is a JSON object
    /// handed to it. Nothing here interpolates a value into JavaScript SYNTAX, which is what keeps a
    /// file containing `"); doSomething("` from being anything but text.
    var javascript: String {
        return "window.normaEditor.dispatch(" + payloadJSON + ")"
    }

    /// The message as a JSON object. `type` plus that case's own fields, nothing else.
    private var payload: [String: Any] {
        switch self {
        case .openModel(let path, let language, let text):
            return ["type": wireType, "path": path, "language": language, "text": text]
        case .activateModel(let path):
            return ["type": wireType, "path": path]
        case .closeModel(let path):
            return ["type": wireType, "path": path]
        case .pullContent(let path, let seq):
            return ["type": wireType, "path": path, "seq": seq]
        case .applyExternalContent(let path, let text):
            return ["type": wireType, "path": path, "text": text]
        case .markSaved(let path, let seq):
            return ["type": wireType, "path": path, "seq": seq]
        case .setTheme(let tokensJSON):
            // Unparseable or non-object tokens become an empty object rather than invalid
            // JavaScript. `javascript` must ALWAYS produce one well-formed call: a syntax error in
            // the page is not a failed theme, it is a dead bridge with no reply path — and the
            // tokens are Swift-authored, so a bad one is a bug on this side to find in a log, not
            // input to defend against.
            return ["type": wireType, "tokens": Self.object(fromJSON: tokensJSON) ?? [:]]
        }
    }

    private var payloadJSON: String {
        // `.sortedKeys` because a dictionary's order is otherwise unspecified and the rendered
        // string is pinned byte-for-byte by a test; `.withoutEscapingSlashes` because every payload
        // here carries a POSIX path and `\/` in all of them buys nothing.
        guard let data = try? JSONSerialization.data(withJSONObject: payload,
                                                     options: [.sortedKeys, .withoutEscapingSlashes]),
              let rendered = String(data: data, encoding: .utf8) else {
            // Unreachable — every payload above is strings, a `UInt64` and a parsed JSON object —
            // but not silence if it ever were: the type alone still reaches the page's switch,
            // which reports a message it cannot act on. (`CDPReasonJSON` in `NormaCEF.mm` carries
            // the same kind of can't-happen fallback for the same reason.)
            return "{\"type\":\"\(wireType)\"}"
        }
        return Self.escapingJavaScriptLineTerminators(rendered)
    }

    /// **U+2028 / U+2029, escaped — a JavaScript concern, not a JSON one.** Both are legal raw
    /// inside a JSON string, and this string is not consumed as JSON: it is JavaScript SOURCE
    /// evaluated in the page, where the two were line terminators until ES2019. Their escaped form
    /// is valid JSON as well, so this costs nothing and removes a whole class of "this one file
    /// breaks the editor" from a channel that carries arbitrary user text.
    private static func escapingJavaScriptLineTerminators(_ json: String) -> String {
        guard json.unicodeScalars.contains(where: { $0 == "\u{2028}" || $0 == "\u{2029}" }) else {
            return json
        }
        let backslash = #"\"#
        return json
            .replacingOccurrences(of: "\u{2028}", with: backslash + "u2028")
            .replacingOccurrences(of: "\u{2029}", with: backslash + "u2029")
    }

    private static func object(fromJSON json: String) -> [String: Any]? {
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)) else { return nil }
        return parsed as? [String: Any]
    }
}
