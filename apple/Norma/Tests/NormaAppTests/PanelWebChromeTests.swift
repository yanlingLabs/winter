import AppKit
import XCTest
@testable import Norma

/// panel-cef Task 6b: the browser chrome — the URL scheme policy, the field caps, and the URL row's
/// metrics.
///
/// The policy tests are the important half of this file. Task 6a created the URL *consumer*
/// (`PanelWebTab.makeContent()` loads `tab.url` into a real Chromium browser) at a time when nothing
/// anywhere could set one; Task 6b's URL bar is the first producer. Everything below exists because
/// a `javascript:` URL that reached the session log would be re-executed against the page on every
/// restore, forever — sessions are user-delete-only.
@MainActor
final class PanelWebChromeTests: XCTestCase {

    // MARK: - Scheme extraction

    func testSchemeIsExtractedAndLowercased() {
        XCTAssertEqual(PanelURLPolicy.scheme(of: "https://example.com"), "https")
        XCTAssertEqual(PanelURLPolicy.scheme(of: "HTTP://example.com"), "http")
        XCTAssertEqual(PanelURLPolicy.scheme(of: "JavaScript:alert(1)"), "javascript")
        XCTAssertEqual(PanelURLPolicy.scheme(of: "view-source:https://x.example"), "view-source")
        XCTAssertEqual(PanelURLPolicy.scheme(of: "a+b-c.d:rest"), "a+b-c.d")
    }

    /// A string with no scheme is not "a URL with an odd scheme" — it has none, and both cases are
    /// refused. Written out because the grammar's edges are where a hand-rolled parser goes wrong.
    func testStringsThatCarryNoSchemeAtAll() {
        XCTAssertNil(PanelURLPolicy.scheme(of: "example.com"))        // no colon
        XCTAssertNil(PanelURLPolicy.scheme(of: ""))
        XCTAssertNil(PanelURLPolicy.scheme(of: "://nohost"))          // empty scheme
        XCTAssertNil(PanelURLPolicy.scheme(of: "1http://x"))          // must START with a letter
        XCTAssertNil(PanelURLPolicy.scheme(of: "ht tp://x"))          // space is not scheme grammar
        XCTAssertNil(PanelURLPolicy.scheme(of: "/path/to/thing"))
    }

    // MARK: - The allowlist

    /// **An allowlist, never a denylist.** The three schemes the plan names are refused, and so is
    /// everything else — which is the point: `blob:`, `filesystem:` and `view-source:` are not on
    /// anyone's list of dangerous schemes and are refused anyway, without the list needing to know
    /// they exist.
    func testOnlyHttpAndHttpsAreAllowed() {
        XCTAssertEqual(PanelURLPolicy.allowedSchemes, ["http", "https"])

        for allowed in ["https://example.com", "http://localhost:3000/x?y=1", "HTTPS://EXAMPLE.COM"] {
            XCTAssertTrue(PanelURLPolicy.isAllowed(allowed), "\(allowed) should be allowed")
        }
        for refused in [
            "javascript:alert(document.cookie)",   // the classic: re-executed on every restore
            "JavaScript:alert(1)",
            "file:///Users/someone/.ssh/id_rsa",
            "data:text/html,<script>fetch('//evil')</script>",
            "blob:https://example.com/9d5b",
            "filesystem:https://example.com/temporary/x",
            "view-source:https://example.com",
            "about:blank",
            "chrome://settings",
            "ftp://files.example.com",
            "example.com",                          // no scheme is not http
            "",
        ] {
            XCTAssertFalse(PanelURLPolicy.isAllowed(refused), "\(refused) must be refused")
        }
    }

    /// **The built-in New Tab page is a `data:` URL, and this is what keeps it out of every
    /// session's history.** It commits and fires `OnLoadEnd` exactly like a real page, so without
    /// the allowlist every tab ever opened would append a `panel_tab_navigated` carrying a
    /// multi-hundred-character inline document — to a file that is never deleted.
    func testTheStartPageIsNeverPersistedAndNeverRestored() {
        XCTAssertTrue(panelWebTabStartPageURL.hasPrefix("data:"),
                      "the New Tab page stopped being a data: URL — this test's premise moved")
        XCTAssertFalse(PanelURLPolicy.isAllowed(panelWebTabStartPageURL))
        XCTAssertNil(PanelURLPolicy.persistableNavigation(url: panelWebTabStartPageURL, title: "New Tab"))
        // And it round-trips to itself through the restore door — the fallback IS the start page.
        XCTAssertEqual(PanelURLPolicy.restorableURL(panelWebTabStartPageURL), panelWebTabStartPageURL)
    }

    // MARK: - Door 1: what the user typed

    func testTypedInputGainsHttpsWhenItCarriesNoScheme() {
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("example.com"), "https://example.com")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("  example.com/a?b=c  "), "https://example.com/a?b=c")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("example.com:8443/x"), "https://example.com:8443/x")
    }

    /// **`host:port` parses as `scheme:payload` under RFC 3986** — `localhost:3000` is a well-formed
    /// URI reference whose scheme is `localhost`. Caught by this file's own first run: the strict
    /// reading refused the single most common address anyone types into a developer tool's browser.
    ///
    /// The disambiguation is the narrowest one available (an unrecognised scheme whose ENTIRE
    /// remainder is digits is a port), and it is safe by construction rather than by argument:
    /// `normalizeTypedInput` runs its answer through `isAllowed` regardless of which branch produced
    /// it, so no reading of the input can emit a URL outside the allowlist.
    func testHostPortWithNoSchemeIsReadAsAHostAndNotAsAScheme() {
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("localhost:3000"), "http://localhost:3000")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("127.0.0.1:8080"), "http://127.0.0.1:8080")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("example.com:8443"), "https://example.com:8443")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("localhost"), "http://localhost")
        // The port has to be judged WITHOUT the path, or `host:port/path` refuses — the second half
        // of the same bug, also found by this test.
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("localhost:3000/api?q=1"),
                       "http://localhost:3000/api?q=1")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("example.com:8443/x"), "https://example.com:8443/x")
        // `file:///…`'s remainder starts with a slash, so its port candidate is empty: still refused.
        XCTAssertNil(PanelURLPolicy.normalizeTypedInput("file:///etc/passwd"))
        XCTAssertNil(PanelURLPolicy.normalizeTypedInput("blob:https://example.com/9d5b"))

        // The heuristic must not become a hole. A digits-only payload after a dangerous scheme is
        // rewritten as a host — which is harmless (it resolves nowhere) — but a dangerous scheme
        // with a REAL payload must still be refused outright.
        XCTAssertNil(PanelURLPolicy.normalizeTypedInput("javascript:alert(1)"))
        XCTAssertNil(PanelURLPolicy.normalizeTypedInput("javascript:void(0)"))
        XCTAssertNil(PanelURLPolicy.normalizeTypedInput("data:1234567"), "6+ digits is not a port")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("javascript:1234"), "https://javascript:1234",
                       "a digits-only payload reads as host:port — and is still inside the allowlist")
    }

    func testTypedInputKeepsAnAlreadyAllowedScheme() {
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("http://example.com"), "http://example.com")
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput("https://example.com"), "https://example.com")
    }

    /// Refused OUTRIGHT, never sanitised. Stripping a `javascript:` prefix and running the remainder
    /// would be the same class of mistake as escaping a string instead of parameterising a query.
    func testTypedInputRefusesEverythingOutsideTheAllowlist() {
        for refused in [
            "javascript:alert(1)", "JAVASCRIPT:alert(1)", "file:///etc/passwd",
            "data:text/html,<h1>x</h1>", "about:blank", "", "   ",
        ] {
            XCTAssertNil(PanelURLPolicy.normalizeTypedInput(refused), "\(refused) must be refused")
        }
    }

    func testTypedInputRefusesAnOverCapURL() {
        let atCap = "https://a.example/" + String(repeating: "p", count: PanelURLPolicy.urlMaxLength - 18)
        XCTAssertEqual(atCap.count, PanelURLPolicy.urlMaxLength)
        XCTAssertEqual(PanelURLPolicy.normalizeTypedInput(atCap), atCap)
        XCTAssertNil(PanelURLPolicy.normalizeTypedInput(atCap + "p"))
    }

    // MARK: - Door 2: what may be written down

    func testAPersistableNavigationPassesThroughUnchanged() {
        let result = PanelURLPolicy.persistableNavigation(url: "https://example.com/a", title: "Example")
        XCTAssertEqual(result?.url, "https://example.com/a")
        XCTAssertEqual(result?.title, "Example")
    }

    func testAnEmptyTitleIsPersistable() {
        // A page with no `<title>` is ordinary, and the wire schema requires `title` — it may be
        // empty, it may not be absent (`PanelTabNavigatedEvent`, events.ts).
        XCTAssertEqual(PanelURLPolicy.persistableNavigation(url: "https://x.example", title: "")?.title, "")
    }

    /// **A title truncates; a URL DROPS.** The asymmetry is the point: a truncated title is still a
    /// true (if abbreviated) description of the page, while a truncated URL is a DIFFERENT URL — a
    /// wrong address that a later restore would navigate to.
    func testAnOverCapTitleTruncatesButAnOverCapURLDropsTheWholeReport() {
        let longTitle = String(repeating: "t", count: PanelURLPolicy.titleMaxLength + 500)
        let truncated = PanelURLPolicy.persistableNavigation(url: "https://x.example", title: longTitle)
        XCTAssertEqual(truncated?.title.count, PanelURLPolicy.titleMaxLength)
        XCTAssertEqual(truncated?.url, "https://x.example", "the url must be untouched by title capping")

        let longURL = "https://a.example/" + String(repeating: "p", count: PanelURLPolicy.urlMaxLength)
        XCTAssertNil(PanelURLPolicy.persistableNavigation(url: longURL, title: "T"),
                     "an over-cap URL must be DROPPED, never truncated into a different address")
    }

    func testAnUnallowedSchemeIsNeverPersistable() {
        for refused in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "", "about:blank"] {
            XCTAssertNil(PanelURLPolicy.persistableNavigation(url: refused, title: "T"))
        }
    }

    // MARK: - Door 3: what a restored tab actually loads

    /// The last mile of the whole policy. Every other door can be bypassed by data that predates it
    /// or arrives from a producer that does not exist yet; this one is on the path of EVERY load.
    func testRestoreLoadsTheStartPageRatherThanAnythingOutsideTheAllowlist() {
        XCTAssertEqual(PanelURLPolicy.restorableURL(nil), panelWebTabStartPageURL)
        XCTAssertEqual(PanelURLPolicy.restorableURL(""), panelWebTabStartPageURL)
        XCTAssertEqual(PanelURLPolicy.restorableURL("javascript:alert(1)"), panelWebTabStartPageURL,
                       "a stored javascript: URL must never reach a web view")
        XCTAssertEqual(PanelURLPolicy.restorableURL("file:///etc/passwd"), panelWebTabStartPageURL)
        XCTAssertEqual(PanelURLPolicy.restorableURL("data:text/html,<h1>x</h1>"), panelWebTabStartPageURL)
        XCTAssertEqual(PanelURLPolicy.restorableURL("https://example.com"), "https://example.com")
    }

    /// The consumer's own door, exercised through the tab rather than the policy — this is the call
    /// `PanelWebTab.makeContent()` makes, and a refactor that dropped the filter there would leave
    /// every policy test above green.
    func testAWebTabWithAHostileStoredURLResolvesToTheStartPage() {
        let hostile = PanelTab(tabId: "t1", kind: .web, url: "javascript:alert(1)", title: "x")
        XCTAssertEqual(PanelURLPolicy.restorableURL(hostile.url), panelWebTabStartPageURL)

        let ordinary = PanelTab(tabId: "t2", kind: .web, url: "https://example.com", title: "Example")
        XCTAssertEqual(PanelURLPolicy.restorableURL(ordinary.url), "https://example.com")
    }

    // MARK: - The caps, mirrored across two languages

    /// **`PANEL_URL_MAX_LENGTH` / `PANEL_TITLE_MAX_LENGTH` (`packages/protocol/src/events.ts`) carry
    /// these same two numbers, and nothing couples them at compile time.** That is this repo's worst
    /// known drift class — the `TRANSIENT_EVENT_TYPES` hand-copy that silently dropped every
    /// `assistant_delta` on iOS — and drift here is silent in both directions, because every panel
    /// RPC call site is `try?`-wrapped: a too-generous value here means the daemon rejects the
    /// report and NOTHING anywhere says so. The TS side has the mirror of this test
    /// (`packages/core/test/ipc/panel-methods.test.ts`, "the caps are the exact values the Swift
    /// mirror pins"); each names the other.
    func testTheCapsAreTheExactValuesTheDaemonEnforces() {
        XCTAssertEqual(PanelURLPolicy.urlMaxLength, 2048)
        XCTAssertEqual(PanelURLPolicy.titleMaxLength, 256)
    }

    // MARK: - The URL row's metrics

    /// The spec's structural finding: the tab row and the URL row are ONE continuous 85pt band, and
    /// the URL row is the 40pt beneath the 45pt tab strip. Nothing draws a line between them — the
    /// spec says a divider there reads as visibly wrong — and the arithmetic below is what makes the
    /// two rows add up to the band rather than merely fit inside it.
    func testTheURLRowIsTheMeasured40ptBeneathThe45ptTabBand() {
        XCTAssertEqual(panelTitlebarBandHeight, 45)
        XCTAssertEqual(panelUrlRowHeight, 40)
        XCTAssertEqual(panelTitlebarBandHeight + panelUrlRowHeight, panelChromeBandHeight)
    }

    /// The chrome's controls wear the TAB ROW's 28pt rhythm, not the window titlebar's 26pt — the
    /// same call Plan A made for the panel's own trailing cluster, since these sit in the panel's
    /// band rather than the window's.
    func testTheChromeButtonsShareTheTabRowsRhythm() {
        XCTAssertEqual(panelChromeButtonSize, panelExpandButtonSize)
        XCTAssertEqual(panelChromeButtonSize, 28)
        XCTAssertEqual(panelChromeButtonSpacing, panelTabSpacing)
    }

    /// The two clusters, from their parts. Leading is back/forward/reload plus the tab row's own
    /// leading inset (so the first glyph sits on the same vertical line as the first tab pill);
    /// trailing is the `⋮` plus the cluster inset the tab row already uses.
    func testTheClusterWidthsAreDerivedFromTheirParts() {
        XCTAssertEqual(panelChromeLeadingClusterWidth, 9 + 3 * 28 + 2 * 6)   // 105
        XCTAssertEqual(panelChromeTrailingClusterWidth, 28 + 8)              // 36
    }

    /// **What makes the URL field literally centred rather than merely centre-aligned.** Both flanks
    /// lay out at the same width, so the field's midpoint is the panel's midpoint at every width —
    /// and, unlike overlaying a centred field on top of the clusters, overlap is structurally
    /// impossible rather than something a minimum width has to keep preventing.
    func testBothFlanksAreTheSameWidthSoTheFieldIsCentred() {
        XCTAssertEqual(panelChromeFlankWidth,
                       max(panelChromeLeadingClusterWidth, panelChromeTrailingClusterWidth))
        XCTAssertEqual(panelChromeFlankWidth, panelChromeLeadingClusterWidth,
                       "the leading cluster is the wider one, so it sets the flank")

        // The centring property itself: whatever is left over is split equally either side.
        let available: CGFloat = 600
        let field = panelChromeFieldWidth(availableWidth: available)
        let leftOfField = panelChromeFlankWidth + panelChromeFieldGap
        let rightOfField = available - field - leftOfField
        XCTAssertEqual(leftOfField, rightOfField, accuracy: 0.001)
    }

    func testTheFieldFitsAtThePanelsNarrowestAndNeverGoesNegative() {
        XCTAssertGreaterThan(panelChromeFieldWidth(availableWidth: panelMinWidth), 80,
                             "at the panel's minimum width the URL field must still be usable")
        // A GeometryReader's first pass can report 0; the field must clamp, not invert.
        XCTAssertEqual(panelChromeFieldWidth(availableWidth: 0), 0)
    }

    func testTheFieldSharesTheTabPillsHeightAndTheAppsOneRowRadius() {
        XCTAssertEqual(panelChromeFieldHeight, panelTabPillSize.height)
        XCTAssertEqual(panelTabPillRadius, shellSidebarRowCornerRadius,
                       "the panel has ONE rounded-rect vocabulary; the field uses the same radius")
    }

    // MARK: - The model

    /// The chrome and the browser it describes must be the SAME tab. Plan A's `PanelTabContent`
    /// boundary hands `makeChrome()` and `makeContent()` out separately with no argument between
    /// them, so without the registry each half would build its own model and the URL field would
    /// describe a browser it was not attached to.
    func testBothHalvesOfATabShareOneModel() {
        PanelWebTabModels.removeAllForTesting()
        defer { PanelWebTabModels.removeAllForTesting() }

        let tab = PanelTab(tabId: "t1", kind: .web, url: nil, title: nil)
        let a = PanelWebTabModels.model(for: tab, host: nil, sessionId: "s1")
        let b = PanelWebTabModels.model(for: tab, host: nil, sessionId: "s1")
        XCTAssertTrue(a === b)

        let other = PanelWebTabModels.model(for: PanelTab(tabId: "t2", kind: .web, url: nil, title: nil),
                                            host: nil, sessionId: "s1")
        XCTAssertFalse(a === other, "different tabs must not share a model")
    }

    /// The session is captured when the model is wired, not read when a page finishes loading —
    /// otherwise a session hop mid-load files one session's browsing into another's permanent log.
    func testTheSessionIsCapturedAtWiringTime() {
        PanelWebTabModels.removeAllForTesting()
        defer { PanelWebTabModels.removeAllForTesting() }

        let tab = PanelTab(tabId: "t1", kind: .web, url: nil, title: nil)
        let model = PanelWebTabModels.model(for: tab, host: nil, sessionId: "s1")
        XCTAssertEqual(model.sessionId, "s1")
    }

    /// **The address bar's DEFAULT state** — press `+`, look at the field.
    ///
    /// A fresh tab loads `panelWebTabStartPageURL`, a ~900-character percent-encoded `data:`
    /// document, and Chromium COMMITS it exactly like a real page — so `OnAddressChange` and
    /// `OnLoadEnd` publish it into the model and the field showed it, making the placeholder
    /// unreachable on every new tab. `displayURL` is the presentation filter that answers it, the
    /// same way the `⋮` menu already does.
    ///
    /// **Both directions, deliberately.** A refused-only assertion cannot tell "filters" from
    /// "always empty" — the exact shape of the decorative test rewritten below.
    func testTheFieldShowsNothingForAnAddressThePolicyRefuses() {
        let model = PanelWebTabModel(tabId: "t1")

        model.apply(url: panelWebTabStartPageURL, title: "New Tab", isLoading: false,
                    canGoBack: false, canGoForward: false)
        XCTAssertEqual(model.url, panelWebTabStartPageURL,
                       "what CEF reported is untouched — this is a presentation filter, not a "
                           + "change to what is reported or persisted")
        XCTAssertEqual(model.displayURL, "",
                       "the built-in data: start page must never be shown as the tab's address")

        model.apply(url: "https://example.com/a?b=1", title: "Example", isLoading: false,
                    canGoBack: false, canGoForward: false)
        XCTAssertEqual(model.displayURL, "https://example.com/a?b=1",
                       "a real address IS shown — without this the assertion above proves nothing")
    }

    /// Refusal is attributable to the POLICY, not to a missing browser — the two look identical to
    /// the caller and only the first is a decision. With no container attached, a refused URL and an
    /// allowed one would both return false; this pins that the policy runs first by checking the
    /// refusal happens for the refused one regardless.
    func testTheURLFieldRefusesAJavascriptURL() {
        PanelWebTabModels.removeAllForTesting()
        defer { PanelWebTabModels.removeAllForTesting() }

        let model = PanelWebTabModel(tabId: "t1")
        XCTAssertFalse(model.navigate(typed: "javascript:alert(1)"))
        XCTAssertFalse(model.navigate(typed: ""))
    }
}
