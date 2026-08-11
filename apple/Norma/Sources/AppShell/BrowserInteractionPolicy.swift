import Foundation
import NormaProtocol

/// b2-agent-browser Task 5 — **the two pure pieces of the interaction verbs**: the operands a
/// `panel_command` carries, and the SENSITIVE FLOOR that decides whether a `type` may happen at all.
///
/// Both live here rather than inside `PanelCommandConsumer` for the same reason `PanelCDPReply`
/// does: they are pure functions of their input, they are the parts a test can drive without a
/// browser, a scheduler or a runtime, and the floor in particular is policy that a reader must be
/// able to FIND. `PanelCommandConsumer` is then only mechanism — resolve, inspect, act, answer.

// ================================================================================================
// The operands
// ================================================================================================

/// **`panel_command.args`, read for the first time.**
///
/// Until Task 5 this field was decoded and deliberately never looked at, and `NormaCEF.h`'s CDP-door
/// header said exactly why: every CDP method name and every JavaScript expression this app sends is
/// a LITERAL written in `PanelCommandConsumer`, so the bridge — which really is a navigation door,
/// `Page.navigate` and an `location.href` assignment both being one protocol call away — was
/// contained by producer discipline rather than by policy. This type is where that discipline is now
/// carried out, and the rule it implements is one sentence:
///
/// > **A model string may become a CDP PARAMETER VALUE. It may never become part of a method name,
/// > an expression, or a `functionDeclaration`.**
///
/// The two strings that cross are `selector` and `text`, and each has exactly one destination:
///
///   * `selector` → `DOM.querySelector`'s own `selector` parameter, where **Blink's CSS parser**
///     reads it. A CSS selector is not a program: the worst a hostile one can do is match a
///     different element or fail to parse (which comes back as a protocol error and is reported).
///     It is never concatenated into JavaScript — the alternative design, `Runtime.evaluate` over
///     `"document.querySelector('" + selector + "')"`, is the actual vulnerability the door's header
///     warned about, and it is why this app resolves elements over the **DOM domain** rather than by
///     evaluating a string.
///   * `text` → `Input.insertText`'s `text` parameter, which the browser treats as an IME commit
///     into whatever is focused. It is never evaluated, never becomes markup, and never reaches a
///     `functionDeclaration`.
///
/// Everything else on the wire is a NUMBER or one of a fixed set of WORDS (`direction`, `until`),
/// and this type maps those words to values of its own before anything downstream sees them — so a
/// verb's params are assembled from this app's constants, not from the command's bytes.
///
/// **The bounds below are not that mechanism and must not be read as one.** They are ordinary
/// defence in depth: the daemon bounds these fields too (`browser.ts`'s
/// `BROWSER_SELECTOR_MAX_LENGTH`, `BROWSER_TYPE_TEXT_MAX_LENGTH`, `BROWSER_WAIT_MAX_TIMEOUT_MS`, and
/// the wire's own 8 KiB `args` cap), and this app checks anyway because it is the last thing before
/// a real browser in the user's own profile, and "the sender says it validated" is not a check.
/// They are deliberately NOT hand-mirrored caps in the `PanelURLPolicy.urlMaxLength` sense — nothing
/// breaks silently if they drift, because a value the daemon allows and this refuses comes back as a
/// visible `ok:false` naming the limit, not as a dropped result.
enum PanelCommandArguments {

    /// A selector's ceiling. Matches the daemon's so a legal command is never refused here.
    static let selectorMaxLength = 1024
    /// `type`'s text ceiling, in the daemon's unit — `PanelURLPolicy.wireLength`, i.e. UTF-16 code
    /// units, because that is what zod's `.max` counts on the other side.
    static let insertTextMaxLength = 4096
    /// `scroll`'s directional distance, in CSS pixels.
    static let scrollAmountMaxPx = 20_000
    /// **`wait`'s ceiling, and the one bound that is load-bearing rather than hygienic.** The
    /// model's timeout has to finish INSIDE the command's own `deadlineMs`, or a wait that ran its
    /// full course answers into a pending entry the daemon already timed out — and the agent is told
    /// "the Mac app did not answer" for a verb that completed and reported honestly.
    /// `browser.ts`'s `BROWSER_WAIT_MAX_TIMEOUT_MS` carries the arithmetic (20 s inside a 30 s
    /// deadline, ten seconds of headroom for the round trip). CLAMPED here rather than refused: an
    /// over-long wait is not a malformed request, it is one this app can only honour in part, and
    /// waiting 20 s and saying so beats refusing outright.
    static let waitTimeoutCeilingMs = 20_000

    /// What `scroll` was asked to do.
    enum ScrollTarget: Equatable {
        /// Bring one element into view.
        case element(selector: String)
        /// Wheel the page. The deltas are already signed and in CSS pixels.
        case wheel(deltaX: Double, deltaY: Double)
    }

    /// What `wait` was asked to wait for.
    enum WaitPredicate: String, Equatable {
        /// `document.readyState === "complete"`.
        case load
        /// Loaded, AND no new resource has finished fetching across two consecutive polls. A PROXY
        /// for network idle and honestly named as one — see `PanelCommandConsumer.waitProbeScript`.
        case idle
        /// Just wait the timeout out. Touches no browser at all.
        case ms
    }

    /// A read that either produced the operand or produced the sentence explaining why not.
    /// `Result` rather than an optional: every refusal here is reported to the model, so the reason
    /// is part of the value.
    enum Read<Value> {
        case ok(Value)
        case refused(String)
    }

    // MARK: - The readers

    /// A required CSS selector.
    static func selector(_ args: [String: SessionEvent.JSONValue]?, verb: String) -> Read<String> {
        guard case .string(let raw)? = args?["selector"], !raw.isEmpty else {
            return .refused("\(verb) needs a `selector` naming the element")
        }
        guard PanelURLPolicy.wireLength(raw) <= selectorMaxLength else {
            return .refused("that selector is \(PanelURLPolicy.wireLength(raw)) characters, past the "
                            + "\(selectorMaxLength)-character limit")
        }
        return .ok(raw)
    }

    /// `type`'s text. Empty is refused rather than treated as "clear the field": clearing is a
    /// different intention, and a verb that silently emptied a field because a string arrived empty
    /// would be the worst possible reading of an ambiguous command.
    static func text(_ args: [String: SessionEvent.JSONValue]?) -> Read<String> {
        guard case .string(let raw)? = args?["text"], !raw.isEmpty else {
            return .refused("type needs non-empty `text`")
        }
        guard PanelURLPolicy.wireLength(raw) <= insertTextMaxLength else {
            return .refused("that text is \(PanelURLPolicy.wireLength(raw)) characters, past the "
                            + "\(insertTextMaxLength)-character limit on one `type`")
        }
        return .ok(raw)
    }

    /// `scroll`'s target: either a selector or a signed wheel delta built from this app's own
    /// constants and the command's NUMBER.
    static func scrollTarget(_ args: [String: SessionEvent.JSONValue]?) -> Read<ScrollTarget> {
        if args?["selector"] != nil {
            switch selector(args, verb: "scroll") {
            case .ok(let value): return .ok(.element(selector: value))
            case .refused(let why): return .refused(why)
            }
        }
        guard case .string(let direction)? = args?["direction"] else {
            return .refused("scroll needs either a `selector` or a `direction`")
        }
        let amount: Double
        if case .number(let n)? = args?["amount"] {
            guard n > 0, n <= Double(scrollAmountMaxPx) else {
                return .refused("scroll's amount must be between 1 and \(scrollAmountMaxPx) pixels")
            }
            amount = n
        } else {
            return .refused("scroll needs an `amount` in pixels alongside its direction")
        }
        // The direction WORD becomes a sign and an axis here, chosen from this file's own literals.
        // Nothing about the command's bytes reaches the params beyond the number above.
        switch direction {
        case "down": return .ok(.wheel(deltaX: 0, deltaY: amount))
        case "up": return .ok(.wheel(deltaX: 0, deltaY: -amount))
        case "right": return .ok(.wheel(deltaX: amount, deltaY: 0))
        case "left": return .ok(.wheel(deltaX: -amount, deltaY: 0))
        default:
            return .refused("scroll's direction must be up, down, left or right")
        }
    }

    /// `wait`'s predicate and its clamped budget.
    static func wait(_ args: [String: SessionEvent.JSONValue]?)
        -> Read<(predicate: WaitPredicate, timeoutMs: Int)> {
        guard case .string(let raw)? = args?["until"],
              let predicate = WaitPredicate(rawValue: raw) else {
            return .refused("wait needs `until` to be load, idle or ms")
        }
        guard case .number(let ms)? = args?["timeoutMs"], ms >= 1 else {
            return .refused("wait needs a positive `timeoutMs`")
        }
        return .ok((predicate, min(Int(ms), waitTimeoutCeilingMs)))
    }
}

// ================================================================================================
// THE SENSITIVE FLOOR (spec §4)
// ================================================================================================

/**
 * **The sensitive floor: the agent never types into a password or payment field.**
 *
 * Spec §4, stated there as an absolute for every unattended mode and, for v1, everywhere —
 * "unattended" has no complement yet because the attended-approval path is Task 6's. Until it
 * exists this refuses in EVERY mode including an interactive code session, and that is the correct
 * conservative reading of a spec whose only stated exception is "a live human approval" that cannot
 * currently be obtained. See `taskSixSeam` below for the shape that exception must take.
 *
 * ## Why policy lives in the app, when policy normally lives in the daemon
 *
 * This is a deliberate exception to this repo's usual split (the daemon owns approvals, the app owns
 * scheme policy at the seam), and spec §4 makes it in as many words: "enforced at the consumer by
 * CDP field inspection before `type`, fail-closed on inspection failure". The reason is not
 * convenience — it is that **the question cannot be asked anywhere else.** "Is this a password
 * field?" is a fact about a live DOM in a renderer process. The daemon has a selector string and
 * nothing else; it has never seen the page, cannot see the page, and no event on the wire carries
 * the page's markup. A daemon-side floor could only guess from the selector's TEXT, which is exactly
 * the check an attacker controls.
 *
 * ## What it reads, and why it reads it THAT way
 *
 * `DOM.describeNode`'s attribute list — **Blink's own view of the element**, obtained over the DOM
 * domain, not by evaluating JavaScript in the page.
 *
 * That is the security-relevant half of the design. An inspector written as `Runtime.evaluate` over
 * `el.type` reads a PROPERTY, and a page can shadow a property:
 * `Object.defineProperty(input, "type", {get: () => "text"})` makes a password field introduce
 * itself as a text field, and the floor would wave it through. Attributes come from the DOM tree
 * Blink holds; page script can change an attribute (which is a real change to the element) but
 * cannot make the protocol report one value while the element behaves as another.
 *
 * ## What it CANNOT see — enumerated, because a floor whose limits are unwritten reads as a
 * guarantee it is not
 *
 *  1. **Anything inside an iframe.** `DOM.querySelector` runs against the top document, so a
 *     cross-origin payment iframe (Stripe Elements, PayPal, 3-D Secure) is not merely un-inspected —
 *     it is entirely unreachable, and `type` into it fails with "no element matched". The floor is
 *     not bypassed; the verb simply cannot act there. That is the safe direction, and it means the
 *     single most common real payment form is out of the agent's reach altogether.
 *  2. **Anything inside a shadow root**, for the same reason and with the same safe consequence.
 *  3. **A field with no telling attributes.** A `<div contenteditable>` or a bare `<input>` whose
 *     only clue is a `<label>` beside it reading "Card number" passes: label TEXT is not an
 *     attribute of the field, and `describeNode` does not carry it. Closing this needs the computed
 *     accessible name (`Accessibility.getPartialAXTree`), which is an experimental domain this task
 *     did not take a dependency on. It is the largest known hole and is named in the task report.
 *  4. **A credential field the site calls something else.** The needles below are a list, and a list
 *     is never complete — `heslo`, `contraseña`, a field named `q4`.
 *  5. **Where the caret actually ends up.** The floor judges the element the agent NAMED, and
 *     `DOM.focus` puts focus on that element; a page's own `focus` handler may then move focus
 *     elsewhere before `Input.insertText` arrives, and no mechanism on this protocol prevents that.
 *     It is the same exposure a human user has, minus the seeing.
 *  6. **Anything about `click` or `submit`.** The floor bounds what the AGENT TYPES. A form the
 *     browser autofilled can be submitted by clicking its button, and gating `submit` alone would be
 *     theatre while `click` exists. What bounds that is the domain gate (Task 6), not this.
 *
 * ## Fail closed
 *
 * `judge` is only ever called with a node the inspection actually produced. Everything else —
 * `DOM.describeNode` failing, a payload that does not parse, a node with no name — is a REFUSAL at
 * the call site (`PanelCommandConsumer.type`), never a default-allow. The task's own mutation test
 * is written against exactly that: break the inspector and `type` starts refusing, never allowing.
 */
enum SensitiveFieldFloor {

    /// What the inspection produced: a tag name and the element's attributes, both lowercased.
    struct Field: Equatable {
        /// Lowercased element name — `"input"`, `"textarea"`, `"div"`.
        var tagName: String
        /// Lowercased attribute names to their raw values.
        var attributes: [String: String]

        init(tagName: String, attributes: [String: String]) {
            self.tagName = tagName.lowercased()
            self.attributes = Dictionary(
                attributes.map { ($0.key.lowercased(), $0.value) },
                uniquingKeysWith: { first, _ in first })
        }
    }

    enum Verdict: Equatable {
        case allow
        /// `kind` is the short name the refusal message leads with ("password field", "payment
        /// field"); `evidence` says which attribute gave it away, so a false positive is arguable
        /// by the person reading the transcript rather than mysterious.
        case refuse(kind: String, evidence: String)
    }

    /// **The Task 6 seam, written down where the exception will have to be made.**
    ///
    /// Spec §4's floor is absolute "unattended"; the attended path is an approval this app cannot
    /// currently obtain. When Task 6 builds it, the signal that a human said yes must arrive as a
    /// field the DAEMON stamped after a real approval — never as a key on `panel_command.args`,
    /// which is model-authored. `browser.ts`'s `commandArgs` already builds that object field by
    /// field precisely so a model cannot write such a key; the matching obligation on this side is
    /// that this function must not learn to read one out of `args`.
    static let taskSixSeam = "attended approval is Task 6's; until it exists this refuses everywhere"

    /// The autofill tokens that name a credential outright (WHATWG HTML's autofill field names).
    /// `cc-*` is handled as a PREFIX below, which is what covers `cc-number`, `cc-csc`, `cc-exp`
    /// and the rest without listing them.
    private static let credentialAutocompleteTokens: Set<String> = [
        "current-password", "new-password", "one-time-code",
    ]

    /// Substring needles, matched against a NORMALISED haystack (lowercased, with `-`, `_`, `.`,
    /// `:` and spaces removed) so that `card-number`, `card_number` and `cardNumber` are one thing.
    ///
    /// **Every needle here is long enough not to fire inside an ordinary English word**, which is
    /// the discipline that keeps a false-positive-biased list usable: `pin` was dropped because
    /// "shipping" normalises to a string containing it, and `ssn` because "classname" does. The bias
    /// is still deliberately toward refusing — a wrongly refused field is a visible message the user
    /// can act on, a wrongly accepted one is the agent typing a card number into the internet.
    private static let needles: [(needle: String, kind: String)] = [
        // Credentials
        ("password", "password field"),
        ("passwd", "password field"),
        ("passphrase", "password field"),
        ("onetimecode", "one-time-code field"),
        ("onetimepassword", "one-time-code field"),
        ("otpcode", "one-time-code field"),
        ("verificationcode", "one-time-code field"),
        // Card numbers
        ("cardnumber", "payment field"),
        ("creditcard", "payment field"),
        ("debitcard", "payment field"),
        ("ccnumber", "payment field"),
        ("ccnum", "payment field"),
        ("cardno", "payment field"),
        // Card verification
        ("cvv", "payment field"),
        ("cvc", "payment field"),
        ("securitycode", "payment field"),
        ("cardcode", "payment field"),
        // Card expiry
        ("cardexpiry", "payment field"),
        ("expirydate", "payment field"),
        ("expirationdate", "payment field"),
        ("expmonth", "payment field"),
        ("expyear", "payment field"),
        // Bank and identity
        ("iban", "bank-details field"),
        ("routingnumber", "bank-details field"),
        ("accountnumber", "bank-details field"),
        ("sortcode", "bank-details field"),
        ("socialsecurity", "identity field"),
        ("ssnumber", "identity field"),
        ("taxid", "identity field"),
        ("nationalid", "identity field"),
    ]

    /// The attribute VALUES the needles are matched against. Names, ids and labels a site chooses
    /// for a card field are the whole signal here; `class` is included because component libraries
    /// put the field's purpose there and nowhere else (`class="StripeElement card-number"`), and
    /// because a false positive costs a message.
    private static let haystackAttributes = [
        "name", "id", "placeholder", "aria-label", "title", "autocomplete", "class", "data-testid",
    ]

    /// **The verdict.** `allow` means nothing matched — never "the inspection was inconclusive",
    /// which is a state this function cannot be in and its caller must not manufacture.
    static func judge(_ field: Field) -> Verdict {
        // 1. The type attribute. The one unambiguous signal, and the one a page cannot fake at the
        //    protocol level without actually being a password field.
        if field.attributes["type"]?.lowercased() == "password" {
            return .refuse(kind: "password field", evidence: "type=\"password\"")
        }

        // 2. The autofill contract. A token list, so `section-blue billing cc-number` is read as the
        //    three tokens it is rather than searched as one string.
        if let autocomplete = field.attributes["autocomplete"] {
            for token in autocomplete.lowercased().split(whereSeparator: { $0 == " " || $0 == "\t" }) {
                let value = String(token)
                if value.hasPrefix("cc-") {
                    return .refuse(kind: "payment field", evidence: "autocomplete=\"\(value)\"")
                }
                if credentialAutocompleteTokens.contains(value) {
                    let kind = value == "one-time-code" ? "one-time-code field" : "password field"
                    return .refuse(kind: kind, evidence: "autocomplete=\"\(value)\"")
                }
            }
        }

        // 3. The heuristics, over what the site called the field.
        for attribute in haystackAttributes {
            guard let raw = field.attributes[attribute] else { continue }
            let haystack = normalise(raw)
            for (needle, kind) in needles where haystack.contains(needle) {
                return .refuse(kind: kind, evidence: "\(attribute) contains \"\(needle)\"")
            }
        }

        return .allow
    }

    /// Lowercase, and drop the separators sites vary freely: `Card Number`, `card-number`,
    /// `card_number`, `cardNumber` and `card.number` all normalise to `cardnumber`.
    static func normalise(_ value: String) -> String {
        value.lowercased().filter { $0 != "-" && $0 != "_" && $0 != "." && $0 != ":" && $0 != " " }
    }

    /// The sentence the model is answered with. Names the field kind and the evidence, and says
    /// plainly that no retry will work — otherwise a model reasonably tries a different selector for
    /// the same field, three times.
    static func refusal(kind: String, evidence: String) -> String {
        "refused: that is a \(kind) (\(evidence)), and Norma never types into one. This is not a "
        + "retryable failure and no different selector will change it — ask the person to fill that "
        + "field in themselves."
    }
}
