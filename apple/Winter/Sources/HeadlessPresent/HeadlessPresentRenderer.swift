import AppKit
import Metal
import QuartzCore

/// ComputerV2 Phase 4 (lane H3) — **the headless presentation's GPU side in Winter.app.**
///
/// Every frame the producer hands over (`WinterPresentFrame`, a slot of its IOSurface pool) is copied ON THE GPU into
/// a texture of the renderer's own, and that copy is what is drawn into the view's `CAMetalLayer` — from the top-left
/// corner at one point per CSS pixel (`HeadlessPresentGeometry.pageRect`): with the page laid out in the panel's own
/// size at its backing scale, one texel per device pixel. The slot goes back to the producer
/// (`-releaseSlot:generation:`) only from the command buffer's COMPLETED handler, never on commit: until then the GPU
/// may still be reading it.
///
/// - **Coalesced**: frames that arrive while one is already waiting to be drawn replace it, and the superseded
///   frame's slot is released at once (nothing ever read it). Only the newest frame is drawn.
/// - **Own copy**: a resize, a backing-scale change or a view that comes back redraws from the copy at once,
///   without waiting for the producer's next paint.
/// - **Thread**: everything here runs on `queue` — the consumer's delegate queue, so a frame is handled where it
///   arrives — except `setViewport`/`attach`, which the main thread calls and which only hand values over.
///
/// The view (`HeadlessPresentView`) owns nothing of this: a session hop that dismantles it detaches its layer and
/// the renderer keeps the copy for the next one.
final class HeadlessPresentRenderer: @unchecked Sendable {
    /// What the main thread hands the renderer about the view it draws into.
    struct Viewport: Equatable {
        /// The layer's drawable size, in device pixels.
        var drawableSize: CGSize
        /// The view's size in points, and device pixels per point.
        var bounds: CGSize
        var backingScale: CGFloat
        /// The colour around the page (the panel's own surface, resolved for the view's appearance) — seen only while a
        /// resize has not reached the page yet.
        var clear: MTLClearColor

        static func == (a: Viewport, b: Viewport) -> Bool {
            a.drawableSize == b.drawableSize && a.bounds == b.bounds && a.backingScale == b.backingScale
                && a.clear.red == b.clear.red && a.clear.green == b.clear.green
                && a.clear.blue == b.clear.blue && a.clear.alpha == b.clear.alpha
        }

        /// Where a page of `content` CSS pixels is drawn, in device pixels, top-left origin.
        func pageRect(content: CGSize) -> CGRect {
            let page = HeadlessPresentGeometry.pageRect(content: content, in: bounds)
            return CGRect(x: page.minX * backingScale, y: page.minY * backingScale,
                          width: page.width * backingScale, height: page.height * backingScale)
        }
    }

    /// The view the drawn frames show (CSS pixels) changed — called on `queue`. Set once, before the first frame.
    var onContentSize: ((CGSize) -> Void)?

    let queue: DispatchQueue
    let device: MTLDevice
    private let commandQueue: MTLCommandQueue?

    /// Set once, right after the consumer is made (the consumer needs this renderer's device first).
    weak var consumer: WinterPresentConsumer?

    // On `queue` only.
    private var layer: CAMetalLayer?
    private var copy: MTLTexture?
    /// The view the copy shows, in CSS pixels.
    private var copyContent: CGSize = .zero
    private var pending: WinterPresentFrame?
    private var drawScheduled = false
    private var redrawScheduled = false
    private var pipeline: MTLRenderPipelineState?
    private var pipelineFailed = false
    private var appliedDrawableSize: CGSize = .zero

    // Handed over by the main thread.
    private let lock = NSLock()
    private var viewport: Viewport?

    /// Frames drawn, and frames dropped here because a newer one arrived first (for tests and logs).
    private(set) var drawnFrames: UInt64 = 0
    private(set) var supersededFrames: UInt64 = 0

    init(queue: DispatchQueue, device: MTLDevice) {
        self.queue = queue
        self.device = device
        self.commandQueue = device.makeCommandQueue()
        commandQueue?.label = "Winter headless presentation"
    }

    // MARK: - From the main thread

    /// The view's layer to draw into (nil: no view right now). The newest copy is drawn into it at once.
    func attach(_ layer: CAMetalLayer?) {
        if let layer {
            layer.device = device
            layer.pixelFormat = .bgra8Unorm
            layer.framebufferOnly = true
            layer.isOpaque = true
            layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        }
        queue.async { [weak self] in
            guard let self else { return }
            self.layer = layer
            self.appliedDrawableSize = .zero
            if layer != nil { self.redrawSoon() }
        }
    }

    /// `layer`'s view lets go — only if it is still the one drawn into (a newer view may have attached since; its
    /// layer is never taken away by an older view's teardown).
    func detach(_ layer: CAMetalLayer) {
        queue.async { [weak self] in
            guard let self, self.layer === layer else { return }
            self.layer = nil
            self.appliedDrawableSize = .zero
        }
    }

    /// The view's size, the page's place in it and the letterbox colour changed: redraw from the copy.
    func setViewport(_ new: Viewport) {
        let changed: Bool = lock.withLock {
            defer { viewport = new }
            return viewport != new
        }
        guard changed else { return }
        queue.async { [weak self] in self?.redrawSoon() }
    }

    // MARK: - On `queue`

    /// A new frame from the producer (the consumer's delegate, on `queue`).
    func frame(_ frame: WinterPresentFrame) {
        if let superseded = pending {
            supersededFrames += 1
            consumer?.releaseSlot(superseded.slot, generation: superseded.generation)
        }
        pending = frame
        guard !drawScheduled else { return }
        drawScheduled = true
        // After the consumer's drain loop has handed over every frame it read in this turn: only the newest is drawn.
        queue.async { [weak self] in
            guard let self else { return }
            self.drawScheduled = false
            self.drawPending()
        }
    }

    /// Let everything go (the presentation ended or closed): a waiting frame's slot back, the copy dropped.
    func reset() {
        queue.async { [weak self] in
            guard let self else { return }
            if let frame = self.pending {
                self.consumer?.releaseSlot(frame.slot, generation: frame.generation)
                self.pending = nil
            }
            self.copy = nil
            self.copyContent = .zero
            self.layer = nil
        }
    }

    private func redrawSoon() {
        guard !redrawScheduled else { return }
        redrawScheduled = true
        queue.async { [weak self] in
            guard let self else { return }
            self.redrawScheduled = false
            guard self.pending == nil else { return } // a frame on its way draws anyway
            guard let commands = self.commandQueue?.makeCommandBuffer() else { return }
            if self.encodeDraw(into: commands) { commands.commit() }
        }
    }

    private func drawPending() {
        guard let frame = pending else { return }
        pending = nil
        let source = frame.texture
        let slot = frame.slot, generation = frame.generation
        guard let commands = commandQueue?.makeCommandBuffer(), ensureCopy(width: source.width, height: source.height),
              let copy, let blit = commands.makeBlitCommandEncoder() else {
            consumer?.releaseSlot(slot, generation: generation)
            return
        }
        blit.copy(from: source, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                  sourceSize: MTLSize(width: source.width, height: source.height, depth: 1),
                  to: copy, destinationSlice: 0, destinationLevel: 0, destinationOrigin: MTLOrigin(x: 0, y: 0, z: 0))
        blit.endEncoding()
        let content = Self.content(of: frame)
        if content != copyContent {
            copyContent = content
            onContentSize?(content)
        }
        _ = encodeDraw(into: commands)
        // The slot is the producer's again only once the GPU has finished reading it — completed, not committed.
        let consumer = self.consumer
        commands.addCompletedHandler { _ in consumer?.releaseSlot(slot, generation: generation) }
        commands.commit()
        drawnFrames += 1
    }

    /// The view a frame shows, in CSS pixels: as its generation says, else its pixels at its scale.
    static func content(of frame: WinterPresentFrame) -> CGSize {
        if frame.cssWidth > 0, frame.cssHeight > 0 { return CGSize(width: Int(frame.cssWidth), height: Int(frame.cssHeight)) }
        let scale = frame.scale >= 1 ? frame.scale : 1
        return CGSize(width: (Double(frame.texture.width) / scale).rounded(), height: (Double(frame.texture.height) / scale).rounded())
    }

    private func ensureCopy(width: Int, height: Int) -> Bool {
        if let copy, copy.width == width, copy.height == height { return true }
        guard width > 0, height > 0 else { return false }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height,
                                                                  mipmapped: false)
        descriptor.storageMode = .private
        descriptor.usage = [.shaderRead]
        copy = device.makeTexture(descriptor: descriptor)
        copy?.label = "Winter headless presentation copy"
        return copy != nil
    }

    /// The copy, from the top-left corner at one point per CSS pixel, into the layer's next drawable. False when nothing
    /// could be encoded (no view, no copy yet, an empty view, no drawable).
    private func encodeDraw(into commands: MTLCommandBuffer) -> Bool {
        guard let layer, let viewport = lock.withLock({ viewport }),
              viewport.drawableSize.width >= 1, viewport.drawableSize.height >= 1,
              let pipeline = makePipeline() else { return false }
        if appliedDrawableSize != viewport.drawableSize {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.drawableSize = viewport.drawableSize
            CATransaction.commit()
            appliedDrawableSize = viewport.drawableSize
        }
        guard let drawable = layer.nextDrawable() else { return false }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = viewport.clear
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return false }
        let fit = viewport.pageRect(content: copyContent)
        if let copy, fit.width >= 1, fit.height >= 1 {
            var rect = Self.ndcRect(fit: fit, drawable: viewport.drawableSize)
            encoder.setRenderPipelineState(pipeline)
            encoder.setVertexBytes(&rect, length: MemoryLayout<SIMD4<Float>>.stride, index: 0)
            encoder.setFragmentTexture(copy, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
        encoder.endEncoding()
        commands.present(drawable)
        return true
    }

    /// The fit rect (device pixels, top-left origin) in normalised device coordinates: (left, top, right, bottom).
    static func ndcRect(fit: CGRect, drawable: CGSize) -> SIMD4<Float> {
        let w = max(drawable.width, 1), h = max(drawable.height, 1)
        return SIMD4<Float>(Float(fit.minX / w * 2 - 1), Float(1 - fit.minY / h * 2),
                            Float(fit.maxX / w * 2 - 1), Float(1 - fit.maxY / h * 2))
    }

    // MARK: - The shader (compiled from source at runtime: no .metal build phase)

    static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct PresentOut {
        float4 position [[position]];
        float2 uv;
    };

    // Four vertices of a triangle strip covering `rect` = (left, top, right, bottom) in clip space.
    vertex PresentOut winter_present_vertex(uint vid [[vertex_id]], constant float4 &rect [[buffer(0)]]) {
        float2 uv = float2((vid & 1) ? 1.0 : 0.0, (vid & 2) ? 1.0 : 0.0);
        PresentOut out;
        out.position = float4(mix(rect.x, rect.z, uv.x), mix(rect.y, rect.w, uv.y), 0.0, 1.0);
        out.uv = uv;
        return out;
    }

    // The page over white (CEF's frames are premultiplied; a transparent page shows as a browser shows it).
    fragment float4 winter_present_fragment(PresentOut in [[stage_in]], texture2d<float> page [[texture(0)]]) {
        constexpr sampler linear(filter::linear, address::clamp_to_edge);
        float4 c = page.sample(linear, in.uv);
        return float4(c.rgb + (1.0 - c.a), 1.0);
    }
    """

    private func makePipeline() -> MTLRenderPipelineState? {
        if let pipeline { return pipeline }
        guard !pipelineFailed else { return nil }
        do {
            let library = try device.makeLibrary(source: Self.shaderSource, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.label = "Winter headless presentation"
            descriptor.vertexFunction = library.makeFunction(name: "winter_present_vertex")
            descriptor.fragmentFunction = library.makeFunction(name: "winter_present_fragment")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            pipelineFailed = true
            NSLog("[HeadlessPresent] the presentation shader did not compile: %@", "\(error)")
        }
        return pipeline
    }
}
