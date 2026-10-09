import AppKit
import WebKit

// MARK: - (e) Fixture Docs

/// "Fixture Docs": a WKWebView on `docs.html`, a local page that mimics Google Docs' hard parts (see its header): a
/// hidden off-screen contenteditable iframe that takes the keys while a canvas draws the text, Closure-style
/// buttons that ignore `click`, a Find and replace panel, its own HTML menu bar, and single-line inputs. Every
/// message the page posts becomes a `docs.<type>` log line with the message's own fields.
@MainActor
final class DocsController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let window: FixtureWindow
    let webView: FixtureWebView

    init(slot: Int) {
        window = makeFixtureWindow(title: "Fixture Docs", slot: slot)
        let configuration = WKWebViewConfiguration()
        webView = FixtureWebView(frame: NSRect(origin: .zero, size: WindowGrid.contentSize), configuration: configuration)
        super.init()
        configuration.userContentController.add(self, name: "docs")
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
    }

    func start() {
        if let page = Bundle.main.url(forResource: "docs", withExtension: "html") {
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        } else {
            webView.loadHTMLString("<!doctype html><title>Fixture Docs</title><p>docs.html is missing from the bundle.</p>", baseURL: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Fixture.shared.emit("docs.didFinish", [])
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Fixture.shared.emit("docs.didFail", [("error", .str(error.localizedDescription))])
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String, DocsEvent.isName(type) else { return }
        Fixture.shared.emit("docs.\(type)", DocsEvent.fields(body))
    }

    /// The page's `docsFixture.state()`, or null when it has not loaded / the script fails.
    func state(completion: @escaping (JV) -> Void) {
        let once = OneShot()
        webView.evaluateJavaScript("JSON.stringify(window.docsFixture && window.docsFixture.state())") { result, _ in
            once.run {
                if let text = result as? String, let data = text.data(using: .utf8),
                   let object = try? JSONSerialization.jsonObject(with: data, options: []) {
                    completion(JV.from(any: object))
                } else {
                    completion(.null)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { once.run { completion(.null) } }
    }

    func run(_ script: String, completion: @escaping (Bool) -> Void) {
        let once = OneShot()
        webView.evaluateJavaScript(script) { result, error in once.run { completion(error == nil && (result as? Bool) == true) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { once.run { completion(false) } }
    }
}

/// The page's messages as log fields — pure, so `--self-test` checks it.
enum DocsEvent {
    /// A message type becomes part of an event name: letters only, short.
    static func isName(_ type: String) -> Bool {
        !type.isEmpty && type.count <= 24 && type.allSatisfy { $0.isASCII && $0.isLetter }
    }

    /// Every field but `type`, in key order.
    static func fields(_ body: [String: Any]) -> [(String, JV)] {
        body.keys.filter { $0 != "type" }.sorted().map { ($0, JV.from(any: body[$0])) }
    }
}
