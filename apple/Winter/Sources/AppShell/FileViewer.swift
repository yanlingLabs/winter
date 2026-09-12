import AppKit
import SwiftUI
import QuickLookUI
import UniformTypeIdentifiers

/// The third panel's own width — same "one named constant, not an inlined literal" convention
/// `SidebarLayout.swift`'s `sidebarRightWidth`/`sidebarLeftWidth` already keep.
let fileViewerWidth: CGFloat = 320

/// Whether a file renders as PLAIN TEXT (a scrollable monospaced `Text`) rather than QuickLook —
/// spec §3: "text as text, else QuickLook". Extension-driven (`UTType(filenameExtension:)`
/// conforming to `.text`); an unrecognized or absent extension falls through to QuickLook rather
/// than being force-read as text — the same "empty/unknown is a real answer, never a license to
/// guess" posture `WindowContentView.modelPickerOptions`' own doc comment keeps for a different
/// field.
func fileRendersAsText(_ url: URL) -> Bool {
    guard let type = UTType(filenameExtension: url.pathExtension) else { return false }
    return type.conforms(to: .text)
}

/// app-shell T8, spec §3: the third panel beside the transcript — text as text, else
/// `QLPreviewView`; Open-in-default-app and Reveal-in-Finder escapes either way. ONE panel,
/// CLOSABLE, WINDOW-OWNED: it lives inline in `ShellSessionView`'s own `HStack` (no separate
/// `NSWindow` — contrast the floating corner panel, T9, which genuinely is one), and its open/closed
/// state belongs to `ShellSessionHost` (one shell, one window, one viewer at a time), not to any
/// per-attachment adapter.
///
/// GALLERY EXTENSION POINT: `norma-ios/docs/ios26-design-gallery` has no file-viewer-beside-
/// transcript geometry — the phone has no `$OUTDIR` surface at all yet (spec §3's own iOS-debt
/// note). This panel's shape is Mac-authored, same posture as `HopAwayBackgroundBar`'s own
/// extension-point doc comment in `ShellSessionHost.swift`.
struct FileViewer: View {
    let url: URL
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .frame(width: fileViewerWidth)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(url.lastPathComponent)
                .font(Typography.label(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            Button {
                NSWorkspace.shared.open(url)
            } label: {
                Image(systemName: "arrow.up.forward.app")
            }
            .buttonStyle(.plain)
            .help("Open in default app")
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .help("Reveal in Finder")
            Button(action: onClose) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .help("Close")
        }
        .font(Typography.label())
        .foregroundStyle(.secondary)
        .padding(10)
    }

    @ViewBuilder
    private var content: some View {
        if fileRendersAsText(url) {
            TextFileContent(url: url)
        } else {
            QuickLookContainer(url: url)
        }
    }
}

/// Plain scrollable text render — `String(contentsOf:)` best-effort; a decode failure (e.g. a
/// `.txt`-named binary) falls through to QuickLook's own "can't preview" rendering rather than
/// crashing or showing a blank pane.
private struct TextFileContent: View {
    let url: URL

    var body: some View {
        if let text = try? String(contentsOf: url, encoding: .utf8) {
            ScrollView {
                Text(text)
                    .font(Typography.captionMono())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
        } else {
            QuickLookContainer(url: url)
        }
    }
}

/// `QLPreviewView` (AppKit), wrapped for SwiftUI. `NSURL` conforms to `QLPreviewItem` via a
/// first-party category (`QuickLookUI`'s own `NSURL (QLPreviewConvenienceAdditions)`) — no custom
/// wrapper type needed, just the bridge from Swift's `URL`.
private struct QuickLookContainer: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        // The ObjC designated initializer imports as failable (`(id)initWithFrame:style:`) — it
        // never actually returns nil for a plain `.normal`-style, zero-frame construction; a force
        // unwrap here matches how `NSViewRepresentable.makeNSView` is expected to always hand back
        // a real view.
        let view = QLPreviewView(frame: .zero, style: .normal)!
        view.autostarts = true
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ nsView: QLPreviewView, context: Context) {
        guard (nsView.previewItem?.previewItemURL as URL?) != url else { return }
        nsView.previewItem = url as NSURL
    }
}
