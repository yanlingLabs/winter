import AppKit
import XCTest
@testable import Winter

/// A web tab's real page icon (`WinterCEFSetFaviconObserver` → `PanelWebTabModel.favicon` → the tab
/// pill). The CEF half — candidate order, the download, the PNG taken at 2x — needs a live Chromium
/// and is not reachable under XCTest; these pin the Swift half, which is where every decision about
/// SHOWING or DROPPING an icon lives.
@MainActor
final class PanelTabFaviconTests: XCTestCase {

    private func icon() -> NSImage { NSImage(size: NSSize(width: 16, height: 16)) }

    private func makeModel(at url: String) -> PanelWebTabModel {
        let model = PanelWebTabModel(tabId: "fav")
        model.apply(url: url, title: "", isLoading: false, canGoBack: false, canGoForward: false)
        return model
    }

    // MARK: - Pure rules

    func testTheKeyIsTheDisplayedHostForWebPagesOnly() {
        XCTAssertEqual(panelFaviconKey("https://www.youtube.com/watch?v=1"), "youtube.com")
        XCTAssertEqual(panelFaviconKey("http://YouTube.com/"), "youtube.com")
        XCTAssertNil(panelFaviconKey(panelWebTabStartPageURL))
        XCTAssertNil(panelFaviconKey("about:blank"))
        XCTAssertNil(panelFaviconKey("file:///etc/hosts"))
        XCTAssertNil(panelFaviconKey(""))
    }

    func testAnIconIsAcceptedOnlyForTheSameSite() {
        XCTAssertTrue(panelFaviconAccepts(pageURL: "https://youtube.com/", currentURL: "https://www.youtube.com/watch#t=3"))
        XCTAssertFalse(panelFaviconAccepts(pageURL: "https://youtube.com/", currentURL: "https://github.com/"))
        XCTAssertFalse(panelFaviconAccepts(pageURL: panelWebTabStartPageURL, currentURL: panelWebTabStartPageURL))
        XCTAssertFalse(panelFaviconAccepts(pageURL: "", currentURL: ""))
    }

    // MARK: - The model

    func testAFreshModelHasNoIcon() {
        XCTAssertNil(PanelWebTabModel(tabId: "fav").favicon)
    }

    func testAnIconForThePageOnScreenIsShown() {
        let model = makeModel(at: "https://www.youtube.com/")
        let image = icon()
        model.receiveFavicon(image, forPageURL: "https://www.youtube.com/")
        XCTAssertTrue(model.favicon === image)
    }

    /// The download is asynchronous; one that lands after the user went elsewhere is dropped.
    func testAnIconThatArrivesAfterNavigatingToAnotherSiteIsDropped() {
        let model = makeModel(at: "https://github.com/")
        model.receiveFavicon(icon(), forPageURL: "https://www.youtube.com/")
        XCTAssertNil(model.favicon)
    }

    func testANilIconChangesNothing() {
        let model = makeModel(at: "https://youtube.com/")
        let image = icon()
        model.receiveFavicon(image, forPageURL: "https://youtube.com/")
        model.receiveFavicon(nil, forPageURL: "https://youtube.com/")
        XCTAssertTrue(model.favicon === image)
    }

    func testNavigatingToAnotherSiteClearsTheIcon() {
        let model = makeModel(at: "https://youtube.com/")
        model.receiveFavicon(icon(), forPageURL: "https://youtube.com/")
        model.apply(url: "https://github.com/", title: "", isLoading: true, canGoBack: true, canGoForward: false)
        XCTAssertNil(model.favicon)
    }

    func testTheBuiltInStartPageClearsTheIcon() {
        let model = makeModel(at: "https://youtube.com/")
        model.receiveFavicon(icon(), forPageURL: "https://youtube.com/")
        model.apply(url: panelWebTabStartPageURL, title: "", isLoading: false, canGoBack: true, canGoForward: false)
        XCTAssertNil(model.favicon)
    }

    /// Same site: a fragment jump, a path change, a loading flip, or `www.` ↔ bare keep the icon —
    /// there is no flash back to the globe while the next page on the site loads.
    func testStayingOnTheSameSiteKeepsTheIcon() {
        let model = makeModel(at: "https://www.youtube.com/")
        let image = icon()
        model.receiveFavicon(image, forPageURL: "https://www.youtube.com/")
        for url in ["https://www.youtube.com/#top", "https://www.youtube.com/watch?v=2", "https://youtube.com/feed"] {
            model.apply(url: url, title: "YouTube", isLoading: true, canGoBack: true, canGoForward: false)
            model.apply(url: url, title: "YouTube", isLoading: false, canGoBack: true, canGoForward: false)
            XCTAssertTrue(model.favicon === image, url)
        }
    }

    /// A later icon for the same site (a notification badge) replaces the earlier one.
    func testANewerIconForTheSameSiteReplacesTheOld() {
        let model = makeModel(at: "https://mail.example.com/")
        model.receiveFavicon(icon(), forPageURL: "https://mail.example.com/")
        let badged = icon()
        model.receiveFavicon(badged, forPageURL: "https://mail.example.com/inbox")
        XCTAssertTrue(model.favicon === badged)
    }
}
