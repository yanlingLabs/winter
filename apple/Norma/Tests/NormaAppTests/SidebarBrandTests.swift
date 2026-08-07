import XCTest
import AppKit
import SwiftUI
@testable import Norma

/// sidebar-brand: the brand palette's catalog wiring, the shared Recents row filter, and the
/// search palette's pure helpers. Same posture as `AppShellTests` — the PURE decision helpers are
/// exercised directly; SwiftUI bodies are deliberately NOT, per this codebase's convention (see
/// `DashboardTests`' own file doc).
@MainActor
final class SidebarBrandTests: XCTestCase {
    // MARK: - T1: the asset catalog is really wired

    /// The one failure mode here that is otherwise SILENT: a misspelled asset name, or a colorset
    /// missing from the catalog, renders a fallback color at runtime with no error anywhere.
    /// `NSColor(named:)` resolves against `Bundle.main`, which under this bundle's `TEST_HOST` is
    /// the real app bundle — so this pin proves the catalog compiled INTO the app, not merely
    /// that the JSON files exist on disk.
    func testEveryThemeColorResolvesInTheAssetCatalog() {
        for name in Theme.assetColorNames {
            XCTAssertNotNil(
                NSColor(named: name),
                "\(name) is missing from Assets.xcassets, or misspelled in Theme")
        }
    }

    /// The list is meant to be TOTAL — every color `Theme` names appears in it, or the pin above
    /// silently stops covering the ones it forgot. Bump deliberately when adding a token.
    func testThemeAssetColorNameListIsComplete() {
        XCTAssertEqual(Theme.assetColorNames.count, 14)
        XCTAssertEqual(Set(Theme.assetColorNames).count, 14, "no duplicates")
    }

    /// The plane mapping (`docs/brand.md`): the content card must be BRIGHTER than the sidebar
    /// base in BOTH appearances — that difference IS the sidebar/content separation. A future
    /// palette tune that inverted it would make the whole shell read inside-out, and nothing else
    /// in the suite would notice.
    func testCardSurfaceIsBrighterThanCanvasInBothAppearances() {
        for appearance in [NSAppearance(named: .aqua)!, NSAppearance(named: .darkAqua)!] {
            var canvasBrightness: CGFloat = 0
            var cardBrightness: CGFloat = 0
            appearance.performAsCurrentDrawingAppearance {
                canvasBrightness = Self.brightness(of: NSColor(named: "Canvas")!)
                cardBrightness = Self.brightness(of: NSColor(named: "CardSurface")!)
            }
            XCTAssertGreaterThan(
                cardBrightness, canvasBrightness,
                "CardSurface must be brighter than Canvas in \(appearance.name.rawValue)")
        }
    }

    private static func brightness(of color: NSColor) -> CGFloat {
        let rgb = color.usingColorSpace(.sRGB)!
        return 0.299 * rgb.redComponent + 0.587 * rgb.greenComponent + 0.114 * rgb.blueComponent
    }
}
