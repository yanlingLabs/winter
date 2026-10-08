import CoreGraphics
import Foundation

// STAND-IN for WinterCUPresentation's `CUEncodedFrame` / `CUWindowFrameSource` (the ComputerV2 contract's
// in-window mirror section), which the presentation lane is adding. Same shapes as pinned; `start()` captures
// nothing, so no `view.frame` flows until the real type lands. Internal on purpose: when WinterCUPresentation
// exports the real ones, deleting this file is the whole switch (only `LiveFrameCaptureFactory` uses them).

struct CUEncodedFrame: Sendable {
    let jpeg: Data
    let width: Int
    let height: Int
    let windowSize: CGSize
    let seq: Int
}

@MainActor final class CUWindowFrameSource {
    init(windowID: CGWindowID, maxFps: Int, maxWidth: Int,
         onFrame: @escaping @MainActor (CUEncodedFrame) -> Void, onError: @escaping @MainActor (Error) -> Void) {}

    func start() {}
    func stop() {}
}
