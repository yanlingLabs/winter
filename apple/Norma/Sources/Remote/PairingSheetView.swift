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

/// Task 7 (spec §1 windows disposition: "`PairingSheetWindow` → becomes a sheet on the shell"):
/// owns the pairing sheet's PRESENTATION state for `AppWindowController` — whether it's showing at
/// all (`isPresented`, for SwiftUI's `.sheet(isPresented:)`), and (once the async, relay-homing
/// stack is up) the live `PairingSheetModel` it's presenting. Built ONCE per `AppWindowController`
/// (alongside `dashboardSelection`, `DashboardSurface.swift`), replacing `PairingSheetWindowController`
/// (deleted this task) — which used to own its own `NSPanel` and a one-shot `onClosed` hook.
///
/// `isPresented` is a SEPARATE bool from `model != nil` deliberately: the sheet must open the
/// instant `present(beginPairing:onClosed:)` is called — the exact same "show the 'Preparing…'
/// panel immediately, before awaiting the cold-start relay homing" reasoning
/// `PairingSheetWindowController.init`/`AppDelegate.openPairDevice()` used to build a window for —
/// while `model` only arrives once `RemoteHost.openPairingWindow()` resolves, seconds later on a
/// hotspot. App-side glue only (no unit tests, per the SP2b T5 constraint carried into this task);
/// the tested state machine stays in `PairingSheetModel`.
@MainActor
final class PairingSheetPresentationModel: ObservableObject {
    @Published private(set) var isPresented = false
    @Published private(set) var model: PairingSheetModel?

    private var onClosed: (() -> Void)?

    /// A second invocation while already presented just no-ops — same guard
    /// `AppDelegate.openPairDevice()` used to make against a live `pairingSheetWindow` before
    /// re-showing a window; the sheet itself IS the refocus, there's no second window to show.
    func present(beginPairing: @escaping () async throws -> PairingSheetModel, onClosed: @escaping () -> Void) {
        guard !isPresented else { return }
        self.onClosed = onClosed
        isPresented = true
        model = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                let built = try await beginPairing()
                // The user may have dismissed the sheet while homing was in flight — don't
                // resurrect it; just stop the freshly-built model so its manager/offer doesn't
                // linger (mirrors `AppDelegate.openPairDevice`'s old "Preparing…-panel-closed-mid-
                // homing" race guard).
                guard self.isPresented else {
                    built.stop()
                    return
                }
                self.model = built
            } catch {
                OrbDebug.log("PairingSheetPresentationModel.present: couldn't start the pairing stack: \(error)")
                self.dismiss()
            }
        }
    }

    /// Fired by the SwiftUI sheet's own dismiss (the system close affordance, or a completed
    /// ceremony's own "Done") — same teardown ORDER `PairingSheetWindowController.onClosed` used to
    /// run: stop the model first (cancels its event/countdown background tasks — nothing else
    /// would, since the tasks retain the model for the duration of their in-flight calls), THEN the
    /// caller's own `onClosed` (which ends the manager's live offer and lets the stack tear itself
    /// down if idle).
    func dismiss() {
        guard isPresented else { return }
        isPresented = false
        model?.stop()
        model = nil
        let closed = onClosed
        onClosed = nil
        closed?()
    }
}

/// What the sheet actually hosts: a "Preparing…" placeholder until the pairing stack is up, then
/// the real `PairingSheetView`. Presenting this immediately (instead of awaiting the homing first)
/// is what makes the sheet appear the instant "Pair a Device…" is clicked — so the user never
/// stares at nothing and re-clicks. Deliberately mirrors `showingQRContent`'s structure — headline,
/// 220pt box, and TWO secondary lines — so swapping the spinner for the QR doesn't reflow/recenter
/// the sheet's contents.
struct PairingSheetContainerView: View {
    @ObservedObject var presentation: PairingSheetPresentationModel

    var body: some View {
        content
            // Task 7: a sheet has no titlebar/red-traffic-light of its own (the window this
            // replaces had one) — an explicit close affordance is this content's own to provide.
            // Top-trailing, same corner every other closable panel in this app's gallery uses.
            .overlay(alignment: .topTrailing) {
                Button {
                    presentation.dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .padding(10)
                .accessibilityLabel("Close")
            }
    }

    @ViewBuilder
    private var content: some View {
        if let model = presentation.model {
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
/// text, and never touches `RemoteHost`/`PairingManager` directly. Task 7: hosted as a SwiftUI
/// `.sheet` on the shell (`ShellRootView`, via `PairingSheetContainerView`) — no longer an `NSPanel`
/// (`PairingSheetWindowController`, deleted this task).
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
