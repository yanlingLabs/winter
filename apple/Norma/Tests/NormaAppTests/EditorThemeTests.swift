import AppKit
import SwiftUI
import XCTest
@testable import Norma

/// editor-product Task 4 — the branded Monaco theme + the white-flash elimination.
///
/// Structure pins only, the same posture `PanelKindTintTests`/`EditorRuntimeTests` already state for
/// this codebase: this suite mounts no view and boots no CEF (`EditorTheme.tokensJSON` is pure JSON
/// construction over resolved `NSColor`s, reachable with neither). Editor visuals/feel — does it
/// actually LOOK branded — is the live gate, the same split every other Mac-only visual claim in this
/// repo draws.
///
/// **What each pin actually catches**, since a payload built from named tokens can look "structurally
/// fine" while still being wrong: `testEditorBackgroundMatchesCardSurfacesOwnResolvedHexBothSchemes`
/// resolves `CardSurface` a SECOND, INDEPENDENT way (this file's own `srgb`, `PanelKindTintTests`'
/// identical helper) rather than trusting `EditorTheme`'s own arithmetic; `testExactStringPinForLightScheme`
/// is the one test that would fail on a silently reordered key or a dropped `#`, which every
/// `.contains(...)` check in the other tests is structurally blind to.
@MainActor
final class EditorThemeTests: XCTestCase {

    // MARK: - Structure

    func testTokensJSONIsValidJSONObjectBothSchemes() throws {
        for scheme in [ColorScheme.light, .dark] {
            let json = EditorTheme.tokensJSON(for: scheme)
            let data = try XCTUnwrap(json.data(using: .utf8), "\(scheme): not even valid UTF-8")
            let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any],
                                        "\(scheme) did not decode to a JSON OBJECT: \(json)")
            XCTAssertEqual(Set(decoded.keys), ["base", "colors", "inherit", "rules"], "\(scheme)")
        }
    }

    /// `editor.js`'s `setTheme` validates `base` against Monaco's OWN allowlist and falls back to
    /// `"vs"` for anything it does not recognise — so a wrong value here would not throw, it would
    /// silently theme the editor light regardless of scheme. This is the pin that would catch that.
    func testBaseIsTheCorrectMonacoBuiltinPerScheme() throws {
        XCTAssertEqual(try base(for: .light), "vs")
        XCTAssertEqual(try base(for: .dark), "vs-dark")
    }

    func testInheritIsAlwaysTrue() throws {
        for scheme in [ColorScheme.light, .dark] {
            XCTAssertEqual(try object(for: scheme)["inherit"] as? Bool, true, "\(scheme)")
        }
    }

    /// **The pin that would catch a stale or hardcoded background.** `CardSurface` is resolved a
    /// SECOND, INDEPENDENT way — `PanelKindTintTests.srgb`'s identical `performAsCurrentDrawingAppearance`
    /// + `usingColorSpace(.sRGB)` pattern, applied to the SAME asset by name, not by reading
    /// `EditorTheme`'s own arithmetic back at itself.
    func testEditorBackgroundMatchesCardSurfacesOwnResolvedHexBothSchemes() throws {
        let cases: [(scheme: ColorScheme, appearance: NSAppearance.Name)] = [
            (.light, .aqua), (.dark, .darkAqua)
        ]
        for testCase in cases {
            let colors = try self.colors(for: testCase.scheme)
            let cardSurface = try XCTUnwrap(NSColor(named: "CardSurface"))
            let expected = "#" + hex(srgb(cardSurface, testCase.appearance))
            XCTAssertEqual(colors["editor.background"], expected, "\(testCase.scheme)")
        }
    }

    func testEveryChromeColorIsPresentAndAPlausibleOpaqueHex() throws {
        let keys = ["editor.background", "editor.foreground", "editor.selectionBackground",
                   "editor.lineHighlightBackground", "editorCursor.foreground"]
        for scheme in [ColorScheme.light, .dark] {
            let colors = try self.colors(for: scheme)
            XCTAssertEqual(Set(colors.keys), Set(keys), "\(scheme): exactly these five, no more, no fewer")
            for key in keys {
                let value = try XCTUnwrap(colors[key], "\(scheme) is missing \(key)")
                XCTAssertTrue(isHashedHex(value), "\(scheme) \(key) = \(value) is not #RRGGBB")
            }
        }
    }

    /// Every syntax rule the brief names — keyword/string/number/comment/type — present, with a
    /// hex Monaco's `rules[].foreground` can actually use (bare, no `#`: measured against the
    /// vendored bundle's own built-in theme rules, `hex(_:)`'s doc).
    func testEverySyntaxRuleIsPresentWithAPlausibleHex() throws {
        for scheme in [ColorScheme.light, .dark] {
            let rules = try self.rules(for: scheme)
            let tokens = Set(rules.compactMap { $0["token"] })
            XCTAssertEqual(tokens, ["keyword", "string", "number", "comment", "type"], "\(scheme)")
            XCTAssertEqual(rules.count, 5, "\(scheme): exactly one rule per token, no duplicates")
            for rule in rules {
                let foreground = try XCTUnwrap(rule["foreground"], "\(scheme) rule missing foreground: \(rule)")
                XCTAssertTrue(isBareHex(foreground), "\(scheme) \(rule) — not a bare RRGGBB hex")
            }
        }
    }

    /// The documented mapping choice (`EditorTheme.syntaxRules`'s own header): `SyntaxHighlighter`
    /// has no `type` role, so `type` reuses `keyword`'s color rather than introducing a fifth
    /// `NSColor` the transcript never paints with.
    func testTypeReusesKeywordsColorRatherThanANewNSColor() throws {
        for scheme in [ColorScheme.light, .dark] {
            let rules = try self.rules(for: scheme)
            let keyword = try XCTUnwrap(rules.first { $0["token"] == "keyword" }?["foreground"])
            let type = try XCTUnwrap(rules.first { $0["token"] == "type" }?["foreground"])
            XCTAssertEqual(keyword, type, "\(scheme)")
        }
    }

    /// `docs/brand.md` § 3.6 already publishes the identical contrast ratios these five hexes
    /// reproduce on `CardSurface` (14.35/3.34/2.11/3.95/3.91 light — labelColor/systemBlue/
    /// systemGreen/systemPurple/secondaryLabelColor) — this is the same claim at the COLOR level
    /// rather than the ratio level: light and dark must resolve to DIFFERENT bytes, not a copy-paste
    /// that happens to produce the same JSON shape twice.
    ///
    /// **`editorCursor.foreground` is the one deliberate exception** — `AccentColor`'s own asset is
    /// the SAME `#2E9484` in both appearances (`Theme.accent`'s doc: "stays out of navigation",
    /// the one brand hue that does not shift with the scheme), so a real, non-buggy payload
    /// reproduces that identity rather than hiding it.
    func testLightAndDarkResolveToDifferentColorsThroughout() throws {
        let light = try colors(for: .light)
        let dark = try colors(for: .dark)
        for key in light.keys where key != "editorCursor.foreground" {
            XCTAssertNotEqual(light[key], dark[key], "\(key): light and dark must not collide")
        }
        XCTAssertEqual(light["editorCursor.foreground"], dark["editorCursor.foreground"],
                       "AccentColor is the one token that is scheme-invariant by design")
        let lightRules = try rules(for: .light).sorted { $0["token"]! < $1["token"]! }
        let darkRules = try rules(for: .dark).sorted { $0["token"]! < $1["token"]! }
        for (lightRule, darkRule) in zip(lightRules, darkRules) {
            XCTAssertNotEqual(lightRule["foreground"], darkRule["foreground"], "\(lightRule["token"]!)")
        }
    }

    // MARK: - Exact-string pin (light)

    /// **Learned by running the suite, not hand-computed** — the literal encodes THIS OS's own
    /// resolution of `NSColor.systemBlue`/`.systemGreen`/`.systemPurple`/`.secondaryLabelColor`/
    /// `.labelColor`, composited over `CardSurface`. `docs/brand.md` § 3.6 already publishes the
    /// identical contrast ratios these same five hexes reproduce on light `CardSurface`
    /// (14.35 / 3.34 / 2.11 / 3.95 / 3.91) — cross-checked against that, not merely trusted. A future
    /// macOS release shifting one of those system colors reds THIS pin as OS drift to re-measure, not
    /// a code bug; every other test in this file stays green either way (none of them hardcode a hex).
    func testExactStringPinForLightScheme() {
        let expected = """
        {"base":"vs","colors":{"editor.background":"#F9F9F7","editor.foreground":"#262626",\
        "editor.lineHighlightBackground":"#EFEDE8","editor.selectionBackground":"#E8E6E1",\
        "editorCursor.foreground":"#2E9484"},"inherit":true,"rules":[{"foreground":"0088FF",\
        "token":"keyword"},{"foreground":"34C759","token":"string"},{"foreground":"CB30E0",\
        "token":"number"},{"foreground":"7D7D7C","token":"comment"},{"foreground":"0088FF",\
        "token":"type"}]}
        """
        XCTAssertEqual(EditorTheme.tokensJSON(for: .light), expected)
    }

    // MARK: - cardSurfaceBackgroundARGB (the white-flash fix's other producer)

    /// CEF's own contract for `background_color` (`NormaCEF.h`, `cef_types.h`): the alpha byte must
    /// be either fully opaque or fully transparent. This is always the "override" half of that pair.
    func testCardSurfaceBackgroundARGBIsFullyOpaque() {
        for scheme in [ColorScheme.light, .dark] {
            let argb = EditorTheme.cardSurfaceBackgroundARGB(for: scheme)
            XCTAssertEqual(argb >> 24, 0xFF, "\(scheme): alpha must be fully opaque")
        }
    }

    /// The SAME bytes `tokensJSON`'s `editor.background` carries — one `CardSurface`, two payloads,
    /// never two independently-resolved colors that could drift apart.
    func testCardSurfaceBackgroundARGBMatchesTokensJSONsEditorBackground() throws {
        for scheme in [ColorScheme.light, .dark] {
            let argb = EditorTheme.cardSurfaceBackgroundARGB(for: scheme)
            let rgbHex = String(format: "%06X", argb & 0xFFFFFF)
            let colors = try self.colors(for: scheme)
            XCTAssertEqual(colors["editor.background"], "#" + rgbHex, "\(scheme)")
        }
    }

    func testCardSurfaceBackgroundARGBDiffersBetweenSchemes() {
        XCTAssertNotEqual(EditorTheme.cardSurfaceBackgroundARGB(for: .light),
                          EditorTheme.cardSurfaceBackgroundARGB(for: .dark))
    }

    // MARK: - Helpers (mirrors `PanelKindTintTests`' own duplicated-per-file posture — private to
    // each file by Swift's own rule, so duplicated rather than shared)

    private func object(for scheme: ColorScheme) throws -> [String: Any] {
        let data = try XCTUnwrap(EditorTheme.tokensJSON(for: scheme).data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func base(for scheme: ColorScheme) throws -> String {
        try XCTUnwrap(object(for: scheme)["base"] as? String)
    }

    private func colors(for scheme: ColorScheme) throws -> [String: String] {
        let raw = try XCTUnwrap(object(for: scheme)["colors"] as? [String: Any])
        return raw.compactMapValues { $0 as? String }
    }

    private func rules(for scheme: ColorScheme) throws -> [[String: String]] {
        let raw = try XCTUnwrap(object(for: scheme)["rules"] as? [Any])
        return raw.compactMap { $0 as? [String: Any] }.map { $0.compactMapValues { $0 as? String } }
    }

    private func isHashedHex(_ value: String) -> Bool {
        value.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil
    }

    private func isBareHex(_ value: String) -> Bool {
        value.range(of: #"^[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil
    }

    /// Identical to `PanelKindTintTests.srgb` — resolve a named/dynamic color for an EXPLICIT
    /// appearance rather than the ambient one.
    private func srgb(_ color: NSColor, _ appearance: NSAppearance.Name) -> NSColor {
        var resolved = color
        NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
            resolved = color.usingColorSpace(.sRGB) ?? color
        }
        return resolved
    }

    private func hex(_ color: NSColor) -> String {
        func byte(_ value: CGFloat) -> Int { min(max(Int((value * 255).rounded()), 0), 255) }
        return String(format: "%02X%02X%02X", byte(color.redComponent), byte(color.greenComponent),
                      byte(color.blueComponent))
    }
}
