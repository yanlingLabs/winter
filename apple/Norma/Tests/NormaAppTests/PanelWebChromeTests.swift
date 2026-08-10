import AppKit
import XCTest
@testable import Norma

/// panel-cef Task 6b: the browser chrome — the URL scheme policy, the field caps, and the URL row's
/// metrics.
///
/// The policy tests are the important half of this file. Task 6a created the URL *consumer* (a
/// stored `tab.url` loaded into a real Chromium browser) at a time when nothing anywhere could set
/// one; Task 6b's URL bar is the first producer. Everything below exists because a `javascript:` URL
/// that reached the session log would be re-executed against the page on every restore, forever —
/// sessions are user-delete-only.
///
/// browser-runtime T4 moved that consumer out of the view: the panel's content slot is a viewport
/// onto a browser `BrowserRuntime` owns and creates, so the load-time half of the policy is pinned
/// where the load happens (`BrowserRuntimeTests`, `PanelViewportTests`) rather than here.
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

    /// **What `makeContent()` is for, after browser-runtime T4: it hands the tab to a viewport, and
    /// filters nothing.**
    ///
    /// This test used to assert that `makeContent()` ran `PanelURLPolicy.restorableURL` on the
    /// stored url — enforcement point 3, "the last mile" — because the view was what loaded it. T4
    /// deleted that: `BrowserRuntime.create` is now the one path every browser is born on, including
    /// spec §5's headless ones that no view ever renders, and running the filter here as well would
    /// put the policy in two places while leaving the runtime's own path guarded by a view that
    /// never runs for it. **The door is pinned where it now lives** — `BrowserRuntimeTests
    /// .testTheRestoreDoorRefusesEveryDisallowedSchemeAndSeedsNothingForOne` at the runtime, and
    /// `PanelViewportTests.testAStoredHostileURLNeverReachesCEFThroughTheViewport` for this path
    /// reaching it — so what is left to assert here is the wiring: the right tab, carried through
    /// verbatim, to a viewport.
    ///
    /// `makeContent()` returns `AnyView`, so its content is not readable from outside — the view is
    /// recovered by reflecting through `AnyView`'s storage (`firstDescendant` below). That is
    /// SwiftUI-internal shape, and it fails LOUDLY if the shape ever changes rather than passing
    /// vacuously.
    func testAWebTabsContentIsAViewportCarryingThatExactTab() throws {
        PanelWebTabModels.removeAllForTesting()
        defer { PanelWebTabModels.removeAllForTesting() }

        let tab = PanelTab(tabId: "t1", kind: .web, url: "https://example.com/a?b=1", title: "Example")
        let viewport = try viewport(of: tab)
        XCTAssertEqual(viewport.tab.tabId, "t1", "the panel would mount some other tab's browser")
        XCTAssertEqual(viewport.tab.url, "https://example.com/a?b=1")

        // A stored url the policy refuses reaches the viewport UNCHANGED — the filtering happens one
        // layer down, on the create. Asserting the raw value here is what makes that division of
        // labour visible instead of implied: if this ever came back filtered, the runtime's own
        // restore door would be the thing to delete, not this.
        let hostile = PanelTab(tabId: "t2", kind: .web, url: "javascript:alert(1)", title: "x")
        XCTAssertEqual(try self.viewport(of: hostile).tab.url, "javascript:alert(1)")
    }

    /// The `PanelViewport` inside `makeContent()`'s `AnyView`.
    private func viewport(of tab: PanelTab) throws -> PanelViewport {
        let content = panelTabContent(for: tab)
        XCTAssertTrue(content is PanelWebTab, "a .web tab must resolve to PanelWebTab")
        return try XCTUnwrap(
            Self.firstDescendant(PanelViewport.self, in: content.makeContent()),
            "no PanelViewport inside makeContent()'s AnyView — either .web stopped resolving to the "
                + "browser surface, or AnyView's internal storage shape changed and this reflection "
                + "needs updating. Either way this test is no longer covering the content slot.")
    }

    /// Depth-first search for a value of type `T` anywhere inside `value`'s reflection tree.
    /// `AnyView` stores its wrapped view two levels down (`storage` -> `view`); the search is
    /// recursive rather than hard-coded to that path so a change in SwiftUI's storage shape does
    /// not silently break the pin.
    private static func firstDescendant<T>(_ type: T.Type, in value: Any, depth: Int = 0) -> T? {
        if let hit = value as? T { return hit }
        guard depth < 6 else { return nil }
        for child in Mirror(reflecting: value).children {
            if let hit = firstDescendant(type, in: child.value, depth: depth + 1) { return hit }
        }
        return nil
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

    /// **The NUMBERS agreed and the UNIT did not** — whole-branch review F4, and the reason the
    /// test above cannot catch it.
    ///
    /// Zod's `.max(256)` counts JS `String.length` — UTF-16 code units. Swift's `String.prefix(256)`
    /// counts extended grapheme clusters. Identical for ASCII, which is every literal both pin
    /// tests use. A page `<title>` over 256 characters containing one emoji was emitted at 256
    /// Swift `Character`s / 257+ UTF-16 units, the daemon refused the whole
    /// `panel.reportNavigation`, and `reportPanelNavigation`'s `try?` swallowed it: the navigation
    /// was silently never recorded and the tab kept its previous stored address.
    ///
    /// The TS counterpart is `packages/core/test/ipc/panel-methods.test.ts`, "the caps count UTF-16
    /// units, which is the unit the Swift mirror truncates in".
    func testTheCapsCountTheSameUnitTheDaemonCounts() throws {
        let emoji = "😀"
        XCTAssertEqual(emoji.count, 1, "one Character…")
        XCTAssertEqual(emoji.utf16.count, 2, "…and two UTF-16 units: the whole discrepancy")

        // The exact hazard: > 256 characters, carrying a surrogate pair.
        let hostile = emoji + String(repeating: "t", count: PanelURLPolicy.titleMaxLength + 400)
        let capped = try XCTUnwrap(
            PanelURLPolicy.persistableNavigation(url: "https://x.example", title: hostile)).title

        XCTAssertLessThanOrEqual(
            capped.utf16.count, PanelURLPolicy.titleMaxLength,
            "the title the app emits is over the cap in the unit the DAEMON counts — the whole "
                + "panel.reportNavigation is rejected and the try? swallows it, so the navigation "
                + "is silently never recorded. String.prefix(256) is not z.string().max(256).")
        XCTAssertEqual(capped.utf16.count, PanelURLPolicy.titleMaxLength,
                       "and it fills the cap rather than under-cutting it")
        XCTAssertEqual(capped.count, PanelURLPolicy.titleMaxLength - 1,
                       "255 Characters — the emoji costs two units, so one fewer fits")
        XCTAssertTrue(capped.hasPrefix(emoji),
                      "a surrogate pair must never be split: half a pair is invalid UTF-8 on the "
                          + "wire, which the encoder refuses just as surely as an over-long string")

        // An all-ASCII title is unchanged by the switch — the two units coincide there.
        let ascii = String(repeating: "t", count: PanelURLPolicy.titleMaxLength + 400)
        XCTAssertEqual(
            PanelURLPolicy.persistableNavigation(url: "https://x.example", title: ascii)?.title.count,
            PanelURLPolicy.titleMaxLength)

        // The URL side has the same unit, and DROPS rather than truncating. Reachable through the
        // type-in door (an IDN or a percent-free unicode path), not through CEF's own canonical
        // `frame->GetURL()`, which is percent-encoded ASCII.
        let wideURL = "https://a.example/" + String(repeating: emoji, count: 1100)
        XCTAssertLessThanOrEqual(wideURL.count, PanelURLPolicy.urlMaxLength,
                                 "under the cap by Swift's count — the shape that used to pass")
        XCTAssertGreaterThan(wideURL.utf16.count, PanelURLPolicy.urlMaxLength,
                             "and over it by the daemon's")
        XCTAssertNil(PanelURLPolicy.persistableNavigation(url: wideURL, title: "T"))
        XCTAssertNil(PanelURLPolicy.normalizeTypedInput(wideURL))
        XCTAssertFalse(PanelURLPolicy.mayOpenTab(kind: .web, url: wideURL))
    }

    /// `mayOpenTab` mirrors `PanelOpenTabParams` — and the caps in it are NOT kind-conditional.
    ///
    /// Only the scheme allowlist is (`superRefine` on `web`); `.max(PANEL_URL_MAX_LENGTH)` and
    /// `.max(PANEL_TITLE_MAX_LENGTH)` apply to every kind. Before F4 this door bounded `url` for
    /// `.web` only and never bounded `title` at all, so a request the daemon would refuse got as
    /// far as `openPanelTab`'s auto-create branch — which mints a session BEFORE the RPC and would
    /// have left an orphan empty session behind, the exact failure that guard is placed early to
    /// prevent.
    func testTheOpenTabDoorCapsBothFieldsForEveryKindAndGatesTheSchemeForWebOnly() {
        let overTitle = String(repeating: "t", count: PanelURLPolicy.titleMaxLength + 1)
        let overURL = "https://a.example/" + String(repeating: "p", count: PanelURLPolicy.urlMaxLength)

        for kind in [PanelTabKind.web, .document, .code, .note] {
            XCTAssertFalse(PanelURLPolicy.mayOpenTab(kind: kind, url: nil, title: overTitle),
                           "\(kind): an over-cap title is refused by the daemon for every kind")
            XCTAssertFalse(PanelURLPolicy.mayOpenTab(kind: kind, url: overURL),
                           "\(kind): so is an over-cap url")
            XCTAssertTrue(PanelURLPolicy.mayOpenTab(kind: kind, url: nil, title: "ordinary"))
        }

        // The scheme half stays kind-conditional: a local path is legitimate for the spec's
        // LibreOffice and Monaco slots, and never for a web tab.
        XCTAssertTrue(PanelURLPolicy.mayOpenTab(kind: .document, url: "file:///tmp/x.odt"))
        XCTAssertFalse(PanelURLPolicy.mayOpenTab(kind: .web, url: "file:///tmp/x.odt"))
        XCTAssertTrue(PanelURLPolicy.mayOpenTab(kind: .web, url: "https://example.com"))
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

    /// **The type-in door, with a real browser container attached** — enforcement point 1, which
    /// the brief named the most important deliverable of this task.
    ///
    /// The previous shape of this test built the model with NO container, so
    /// `guard let container else { return false }` answered false for EVERY input: deleting the
    /// policy guard above it left the test green, and its own doc comment admitted it could not
    /// distinguish the two failures. A test that cannot tell "refused by policy" from "no browser"
    /// is not a test of the policy.
    ///
    /// With a container attached the two separate, so BOTH directions are asserted. An accepted URL
    /// reaches `NormaCEFLoadURL`, which finds no browser hosted in this bare container and returns —
    /// CEF never starts under XCTest (`CEFRuntimeTests` pins that refusal), so nothing here can
    /// launch Chromium.
    func testTheURLFieldNavigatesToAnAllowedAddressAndRefusesEverythingElse() {
        let model = PanelWebTabModel(tabId: "t1")
        // Strong, for the test's whole duration: `model.container` is deliberately weak.
        let container = PanelCEFContainerView()
        model.container = container

        XCTAssertTrue(model.navigate(typed: "https://example.com"),
                      "an allowed address must be ACCEPTED — without this the refusals below cannot "
                          + "be attributed to the policy rather than to a missing browser")
        XCTAssertTrue(model.navigate(typed: "example.com"),
                      "a bare host gains a scheme, exactly like every browser's address bar")
        XCTAssertTrue(model.navigate(typed: "localhost:3000"), "and the developer's own address")

        XCTAssertFalse(model.navigate(typed: "javascript:alert(1)"),
                       "the classic: it would be persisted and re-executed on every restore")
        XCTAssertFalse(model.navigate(typed: "file:///etc/passwd"))
        XCTAssertFalse(model.navigate(typed: "data:text/html,<h1>x</h1>"))
        XCTAssertFalse(model.navigate(typed: ""), "an empty box goes nowhere")
        XCTAssertFalse(model.navigate(typed: "https://e.example/\(String(repeating: "a", count: 2048))"),
                       "past the cap the daemon would refuse the report anyway, silently")
    }
}
