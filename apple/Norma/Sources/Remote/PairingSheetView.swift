import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import NormaKit
import SwiftUI

/// Renders `string` as a QR bitmap — `CIFilter.qrCodeGenerator`, correction level M (SP2b T5
/// brief). `CIFilter`'s own output is a tiny (a few dozen px) 1:1-module bitmap; scaled up here
/// via an integral affine transform (nearest-neighbor — no blending) rather than relying on
/// display-time resampling alone, so the modules stay crisp at both the transform step and the
/// `.interpolation(.none)` the `Image` below applies again at draw time.
func renderPairingQRCode(_ string: String) -> NSImage? {
    guard let data = string.data(using: .utf8) else { return nil }
    let filter = CIFilter.qrCodeGenerator()
    filter.message = data
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
    let rep = NSCIImageRep(ciImage: scaled)
    let image = NSImage(size: rep.size)
    image.addRepresentation(rep)
    return image
}

/// Holds the (async, relay-homing) pairing sheet's model once it exists. The window is presented
/// the instant the user picks "Pair a Device…", BEFORE the pairing stack is up — `model` is `nil`
/// until `RemoteHost.openPairingWindow()`'s cold-start homing completes (seconds on a hotspot),
/// which is what `PairingSheetContainerView` shows a "Preparing…" spinner for. App-side glue only
/// (no unit tests, per the SP2b T5 constraint); the tested state machine stays in `PairingSheetModel`.
@MainActor
final class PairingSheetContainer: ObservableObject {
    @Published var model: PairingSheetModel?
    init() {}
}

/// What the pairing panel actually hosts: a "Preparing…" placeholder until the pairing stack is up,
/// then the real `PairingSheetView`. Presenting this immediately (instead of awaiting the homing
/// first) is what makes the panel appear the instant the menu item is clicked — so the user never
/// stares at nothing and re-clicks. Deliberately mirrors `showingQRContent`'s structure — headline,
/// 220pt box, and TWO secondary lines — so swapping the spinner for the QR doesn't reflow/recenter
/// the panel's contents.
struct PairingSheetContainerView: View {
    @ObservedObject var container: PairingSheetContainer

    var body: some View {
        if let model = container.model {
            PairingSheetView(model: model)
        } else {
            VStack(spacing: 12) {
                Text("Pair a Device").font(.headline)
                ProgressView()
                    .frame(width: 220, height: 220)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.white))
                Text("Preparing your Mac…")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Text("This only takes a moment.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .frame(width: 360)
        }
    }
}

/// The Mac's pairing sheet (SP2b Task 5): a dumb SwiftUI presentation over `PairingSheetModel`
/// (NormaKit, pure) — this view owns no state of its own beyond the label `TextField`'s live
/// text, and never touches `RemoteHost`/`PairingManager` directly. Hosted in an `NSPanel` by
/// `PairingSheetWindowController` (inside a `PairingSheetContainerView`).
struct PairingSheetView: View {
    @ObservedObject var model: PairingSheetModel
    @State private var label: String = ""

    var body: some View {
        VStack(spacing: 16) {
            switch model.state {
            case .showingQR(let payload, let secondsLeft):
                showingQRContent(payload: payload, secondsLeft: secondsLeft)
            case .confirming(let words, _):
                confirmingContent(words: words)
            case .done(let record):
                doneContent(record: record)
            case .failed(let message):
                failedContent(message: message)
            }
        }
        .padding(24)
        .frame(width: 360)
        .task { await model.begin() }
    }

    private func showingQRContent(payload: String, secondsLeft: Int) -> some View {
        VStack(spacing: 12) {
            Text("Pair a Device").font(.headline)
            Group {
                if let image = renderPairingQRCode(payload) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 220, height: 220)
                } else {
                    ProgressView()
                        .frame(width: 220, height: 220)
                }
            }
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.white))
            Text("Scan this with the Norma companion app")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("Expires in \(secondsLeft)s")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    private func confirmingContent(words: [String]) -> some View {
        VStack(spacing: 16) {
            Text("Confirm on this Mac").font(.headline)
            Text(words.joined(separator: "  "))
                .font(.system(size: 22, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Make sure these words match what your phone shows.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            TextField("Device name", text: $label, prompt: Text("e.g. My iPhone"))
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Deny", role: .destructive) {
                    Task { await model.denyTapped() }
                }
                Spacer()
                Button("Confirm") {
                    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task { await model.confirmTapped(label: trimmed.isEmpty ? "iPhone" : trimmed) }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
    }

    private func doneContent(record: PairRecord) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.green)
            Text("\(record.label) is paired")
                .font(.headline)
            Text("It can now reach this Mac remotely.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }

    private func failedContent(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "xmark.circle")
                .font(.system(size: 30))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("New QR") { Task { await model.regenerate() } }
        }
    }
}
