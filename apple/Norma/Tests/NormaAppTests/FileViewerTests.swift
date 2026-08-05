import XCTest
@testable import Norma

/// app-shell T8 (spec §3): `fileRendersAsText` is the one PURE decision behind `FileViewer` — the
/// rest of that view (the `QLPreviewView` embedding, the Open-in-default-app/Reveal-in-Finder
/// escapes) is AppKit/QuickLook-backed and pinned only by PRESENCE — it compiles, is reachable from
/// `ShellSessionView`, and is not force-unwrapped or otherwise unsafe (verified at review) — never by
/// a runtime XCTest, the same "SwiftUI bodies and AppKit panels aren't unit-testable" posture
/// `WorkingDirsTests`' own doc comment states for this codebase's other AppKit-backed surfaces.
final class FileViewerTests: XCTestCase {
    private func url(_ name: String) -> URL {
        URL(fileURLWithPath: "/tmp/dd-fileviewer/\(name)")
    }

    func testPlainTextExtensionsRenderAsText() {
        XCTAssertTrue(fileRendersAsText(url("report.txt")))
        XCTAssertTrue(fileRendersAsText(url("notes.md")))
        XCTAssertTrue(fileRendersAsText(url("data.json")))
        XCTAssertTrue(fileRendersAsText(url("script.swift")))
    }

    func testNonTextExtensionsFallThroughToQuickLook() {
        XCTAssertFalse(fileRendersAsText(url("photo.png")))
        XCTAssertFalse(fileRendersAsText(url("doc.pdf")))
        XCTAssertFalse(fileRendersAsText(url("archive.zip")))
    }

    /// No extension at all (a common agent-written artifact name, e.g. `README`) is unrecognized —
    /// it falls through to QuickLook rather than being force-read as text, the same "empty/unknown is
    /// a real answer, never a license to guess" posture this file's own doc comment cites.
    func testNoExtensionFallsThroughToQuickLook() {
        XCTAssertFalse(fileRendersAsText(url("README")))
    }
}
