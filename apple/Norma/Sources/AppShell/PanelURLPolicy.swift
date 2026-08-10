import Foundation

/// panel-cef Task 6b — **what may be loaded into the panel's browser, and what may be written down
/// about it.** Pure, and the only place either question is answered on the Mac side.
///
/// This exists because Task 6b builds the FIRST PRODUCER of a panel tab's `url`. Task 6a created
/// the consumer — `PanelWebTab.makeContent()` loads `tab.url` verbatim into a real Chromium
/// browser — at a time when nothing anywhere could set one, so the policy had nothing to guard yet.
/// The URL bar below changes that, which is why this lands WITH it rather than after: a
/// `javascript:` URL typed into that field would otherwise be persisted to a permanent session log
/// and re-executed against the page on every restore, forever (sessions are user-delete-only).
///
/// ## An allowlist, never a denylist
///
/// `http` and `https` are the whole list. The three schemes the plan names — `javascript:`,
/// `file://`, `data:` — are the ones known TODAY; a denylist would silently admit `blob:`,
/// `filesystem:`, `chrome:`, `view-source:` and whatever Chromium adds next, and would have to be
/// kept correct forever. The same discipline `HISTORY_EVENT_TYPES` is held to in the daemon, for
/// the same reason.
///
/// ## Three enforcement points, one meaning
///
/// The guarantee that matters is "never LOADED", not "never stored", so the policy is applied at
/// each door rather than at one choke point:
///
///  1. **type-in** — `normalizeTypedInput` refuses anything else, so the field cannot navigate to it;
///  2. **report** — `persistableNavigation` refuses anything else, so it never reaches the log. This
///     is also what keeps the built-in `data:` New Tab page (`panelWebTabStartPageURL`) out of every
///     session's history — it commits and fires `OnLoadEnd` exactly like a real page would;
///  3. **restore** — `restorableURL` refuses anything else, so even a value that reached the log by
///     some OTHER route (a hand-edited JSONL, a future producer, a daemon that predates the guard)
///     can never be loaded back into a web view.
///
/// A fourth lives in the daemon (`isPersistablePanelWebUrl`, `packages/protocol/src/methods.ts`),
/// so the app is not the only thing between a hostile URL and a permanent file.
///
/// **`mayOpenTab` (below) is door "1b"** — the app's OTHER producer of a panel url,
/// `ShellSessionHost.openPanelTab(url:)`, added by the Task 6b review. Deliberately not renumbered:
/// "enforcement point 3" and "the four places" are named verbatim in `PanelWebTab.swift`,
/// `methods.ts` and this file's tests, and renumbering would make every one of them wrong.
///
/// **Not every caller of `isAllowed` is one of these doors.** `PanelWebTabModel.displayURL` and the
/// `⋮` menu ask the same question for PRESENTATION — what the address bar shows, whether Copy Link
/// is enabled. Those change nothing about what may be loaded or stored, and removing one is a
/// cosmetic defect, not a security one.
enum PanelURLPolicy {
    /// The complete set of schemes that may be loaded into the panel's browser or persisted as a
    /// web tab's address. Lowercase; comparison is case-insensitive (`JavaScript:` is `javascript:`).
    static let allowedSchemes: Set<String> = ["http", "https"]

    /// MIRRORS `PANEL_URL_MAX_LENGTH` / `PANEL_TITLE_MAX_LENGTH` (`packages/protocol/src/events.ts`).
    ///
    /// **Two hand-mirrored numbers in two languages with no compile-time coupling** — this repo's
    /// worst known drift class (the `TRANSIENT_EVENT_TYPES` hand-copy that silently dropped every
    /// `assistant_delta` on iOS). Drift here is silent in BOTH directions: every panel RPC call site
    /// is `try?`-wrapped, so a too-generous value here means the daemon rejects the report and
    /// nothing anywhere says so — navigations simply stop being recorded.
    /// `PanelWebChromeTests.testTheCapsAreTheExactValuesTheDaemonEnforces` pins these literals and
    /// names its TS counterpart; the TS test pins the same two and names this one.
    ///
    /// **A NUMBER is only half a mirrored cap — the other half is the UNIT**, and that is the half
    /// that drifted (whole-branch review F4). Never measure against these with `String.count`; use
    /// `wireLength` / `cappedTitle` below.
    static let urlMaxLength = 2048
    static let titleMaxLength = 256

    /// **The UNIT the two caps are measured in — and the half that drifted while the numbers
    /// agreed.** Zod's `.max(n)` on a string counts JS `String.length`, i.e. UTF-16 code units.
    /// Swift's `String.count` (and `.prefix(n)`) counts extended grapheme clusters. For ASCII the
    /// two are identical, which is why every literal-pinning test on both sides was structurally
    /// blind to this: the drift was never in the number.
    ///
    /// A page `<title>` longer than 256 characters containing even ONE emoji is 256 Swift
    /// `Character`s and ≥ 257 UTF-16 units, so the daemon rejected the entire
    /// `panel.reportNavigation` — and `ShellSessionHost.reportPanelNavigation`'s `try?` swallowed
    /// the rejection, exactly as the caps' own doc comments warn. The navigation was silently never
    /// recorded and the tab kept its previous stored address. Whole-branch review F4;
    /// `testTheCapsCountTheSameUnitTheDaemonCounts` is the pin that reds if this reverts.
    static func wireLength(_ s: String) -> Int { s.utf16.count }

    /// Truncate to `titleMaxLength` **UTF-16 units**, never splitting a grapheme cluster.
    ///
    /// Both properties are required: cutting at a raw UTF-16 offset could split a surrogate pair
    /// (producing an unpaired surrogate — invalid UTF-8 on the wire, which the socket's JSON
    /// encoder would reject just as surely as an over-long string), and cutting by `Character`
    /// alone is the bug above. So: take whole `Character`s while the running UTF-16 total fits.
    static func cappedTitle(_ title: String) -> String {
        guard wireLength(title) > titleMaxLength else { return title }
        var capped = ""
        var units = 0
        for character in title {
            let width = String(character).utf16.count
            if units + width > titleMaxLength { break }
            capped.append(character)
            units += width
        }
        return capped
    }

    /// The scheme of `url`, lowercased, or `nil` when the string does not start with one.
    ///
    /// Matched against RFC 3986's grammar directly rather than via `URL(string:)`: a parser that
    /// returns nil for malformed input makes "unparseable" indistinguishable from "wrong scheme",
    /// and `URL` on Apple platforms has repeatedly changed how tolerant it is across OS releases —
    /// a policy that shifts with the SDK is not a policy. Both cases are refused anyway.
    static func scheme(of url: String) -> String? {
        guard let first = url.first, first.isASCII, first.isLetter else { return nil }
        var scheme = String(first)
        for ch in url.dropFirst() {
            if ch == ":" { return scheme.lowercased() }
            guard ch.isASCII, ch.isLetter || ch.isNumber || ch == "+" || ch == "-" || ch == "." else {
                return nil
            }
            scheme.append(ch)
        }
        return nil   // no ":" at all — not a URL
    }

    /// May this string be loaded into the panel's browser and written to the session log?
    static func isAllowed(_ url: String) -> Bool {
        guard let scheme = scheme(of: url) else { return false }
        return allowedSchemes.contains(scheme)
    }

    /// Hosts that get `http://` rather than `https://` when the user types no scheme at all. Exactly
    /// Chrome's own behaviour, and for the same reason: a loopback address has no meaningful
    /// transport to downgrade, and every local dev server in existence is plain HTTP. Defaulting
    /// `localhost:3000` to HTTPS would make the single most common address in a developer-facing
    /// tool fail to load.
    private static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]

    /// PURE: the scheme to prepend to a string the user typed with none.
    static func schemeToPrepend(forHostPortInput input: String) -> String {
        let host = input.split(separator: "/", maxSplits: 1).first.map(String.init) ?? input
        let bare = host.split(separator: ":", maxSplits: 1).first.map(String.init) ?? host
        return loopbackHosts.contains(bare.lowercased()) ? "http://" : "https://"
    }

    /// **Door 1 — what the user typed.** Returns the URL to navigate to, or `nil` to refuse.
    ///
    /// A bare host (`example.com`) gains a scheme, which is what every browser's address bar does
    /// and the only reason `isAllowed` alone is not enough here. Anything that still fails the
    /// allowlist afterwards is refused OUTRIGHT rather than sanitised: stripping a `javascript:`
    /// prefix and running the remainder would be the same class of mistake as escaping a string
    /// instead of parameterising a query.
    ///
    /// **`host:port` is genuinely ambiguous with `scheme:payload`, and is resolved the narrow way.**
    /// `localhost:3000` parses as the scheme `localhost` under RFC 3986's grammar — it is a
    /// well-formed URI reference, just not one anybody means. The disambiguation here is the
    /// tightest available: an unrecognised scheme whose ENTIRE remainder is digits is a port, not a
    /// payload. That is safe by construction rather than by argument, because whatever this branch
    /// produces is still run through `isAllowed` below before being returned — so no reading of the
    /// input, however clever or however wrong, can emit a URL outside the allowlist.
    ///
    /// **NOT a search box.** Free text with no scheme becomes `https://<text>` and will simply fail
    /// to resolve. Routing non-URL input to a search engine is a product decision (which engine,
    /// what it learns about the user) that this task does not get to make on the user's behalf —
    /// named as a gap rather than guessed at.
    static func normalizeTypedInput(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let candidate: String
        if let scheme = scheme(of: trimmed) {
            // Everything after the colon, up to where a path/query/fragment would begin — so
            // `example.com:8443/docs` is judged on `8443` rather than on `8443/docs`. Missing that
            // was the second half of the same bug, found by this file's own tests.
            let remainder = String(trimmed.dropFirst(scheme.count + 1))
            let portCandidate = remainder.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
            let looksLikeAPort = !portCandidate.isEmpty
                && portCandidate.count <= 5
                && portCandidate.allSatisfy { $0.isASCII && $0.isNumber }
            candidate = (!allowedSchemes.contains(scheme) && looksLikeAPort)
                ? schemeToPrepend(forHostPortInput: trimmed) + trimmed
                : trimmed
        } else {
            candidate = schemeToPrepend(forHostPortInput: trimmed) + trimmed
        }

        guard isAllowed(candidate), wireLength(candidate) <= urlMaxLength else { return nil }
        return candidate
    }

    /// **Door 2 — what may be written down.** `nil` when this navigation must not be persisted.
    ///
    /// The title is TRUNCATED to the cap; the URL is DROPPED if it exceeds one. That asymmetry is
    /// deliberate and is the whole reason this returns an optional rather than a sanitised pair: a
    /// truncated title is still a true (if abbreviated) description of the page, while a truncated
    /// URL is a DIFFERENT URL — a wrong address that a later restore would navigate to. Not
    /// recording a navigation leaves the tab pointing at the last page it was known to be on, which
    /// is honest; recording a corrupted address is not.
    ///
    /// Both measured in the daemon's unit (`wireLength` / `cappedTitle`), not Swift's — see
    /// `wireLength`'s own doc for the drift that cost.
    static func persistableNavigation(url: String, title: String) -> (url: String, title: String)? {
        guard isAllowed(url), !url.isEmpty, wireLength(url) <= urlMaxLength else { return nil }
        return (url, cappedTitle(title))
    }

    /// **Door 1b — opening a tab with a url already in hand.** May `ShellSessionHost.openPanelTab`
    /// ask the daemon for this tab at all?
    ///
    /// The other Swift-side producer of a panel url, and until this it was ungated: every call site
    /// happens to pass `nil` today, which is not an invariant — this repo has a recorded incident
    /// (`turn_completed.contextTokens`) where a second producer kept emitting the old shape past a
    /// consumer with no gate, for exactly that reason. With this, "every Swift-side panel-url
    /// producer runs through `PanelURLPolicy`" is structurally true rather than accidentally true.
    ///
    /// **KIND-CONDITIONAL, mirroring `PanelOpenTabParams`'s own `superRefine`
    /// (`packages/protocol/src/methods.ts`) exactly** — `web` is held to the allowlist, every other
    /// kind is not, because a `.document`/`.code`/`.note` tab legitimately carries a local path
    /// (the spec's LibreOffice and Monaco slots are precisely that). An unconditional refusal here
    /// would foreclose a design that is already in the spec.
    ///
    /// **Refuses the CALL, not just the url** — it does not quietly drop the url and open a blank
    /// tab. That mirrors what the daemon does with the same params (a failed `superRefine` rejects
    /// the whole request), and it keeps this file's standing rule: refuse outright, never sanitise.
    /// The daemon's own refusal stays where it is; this is the producer-side half of one guard, not
    /// a replacement for it.
    ///
    /// **Only the SCHEME test is kind-conditional; the field caps are not** (whole-branch review
    /// F4). `PanelOpenTabParams` applies `.max(PANEL_URL_MAX_LENGTH)` / `.max(PANEL_TITLE_MAX_LENGTH)`
    /// to both fields for every kind, and only `superRefine`s the allowlist for `web` — so an
    /// over-cap url on a `.document` tab, or an over-cap title on any tab, was refused by the
    /// daemon and waved through here. That is not merely untidy: `openPanelTab` runs this guard
    /// BEFORE its auto-create branch precisely so a request the daemon will refuse cannot mint an
    /// orphan empty session first (its own comment says so).
    static func mayOpenTab(kind: PanelTabKind, url: String?, title: String? = nil) -> Bool {
        if let title, wireLength(title) > titleMaxLength { return false }
        guard let url else { return true }
        guard wireLength(url) <= urlMaxLength else { return false }
        return kind != .web || isAllowed(url)
    }

    /// **Door 3 — what a restored tab actually loads.** Falls back to the local New Tab page for
    /// `nil`, for an empty string, and for any stored value the allowlist refuses.
    ///
    /// The fallback is not merely defensive: it is the guarantee's last mile. Every other door can
    /// be bypassed by data that predates it or arrives from somewhere new; this one is on the path
    /// of every single load, so nothing outside the allowlist can reach a web view regardless of
    /// how it got into the log.
    static func restorableURL(_ stored: String?) -> String {
        guard let stored, isAllowed(stored) else { return panelWebTabStartPageURL }
        return stored
    }
}
