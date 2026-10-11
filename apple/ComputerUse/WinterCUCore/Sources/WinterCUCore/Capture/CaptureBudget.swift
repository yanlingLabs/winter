import CoreGraphics
import Foundation

/// Fits a capture into the provider's image budget (spine §2.1 `budget`, §5's table): the long edge at most
/// `maxLongEdge`, and — when `tile`/`maxTiles` are given — at most `maxTiles` tiles of `tile` px. Never
/// upscales. JPEG quality steps down while the encoding is over `byteCap`, then the size does.
public enum CUCaptureBudget {
    /// Encoded images above this are re-encoded smaller (the spine's 3 MiB).
    public static let byteCap = 3 * 1024 * 1024
    static let minQuality = 0.4
    static let qualityStep = 0.1
    static let shrinkFactor = 0.8

    /// The output pixel size for a source of `source` pixels.
    public static func targetSize(source: CGSize, budget: CUImageBudget) -> (width: Int, height: Int) {
        let sw = max(1, Int(source.width.rounded())), sh = max(1, Int(source.height.rounded()))
        let longEdge = Double(max(sw, sh))
        var scale = min(1, Double(max(1, budget.maxLongEdge)) / longEdge)
        var (w, h) = sized(sw, sh, scale)
        if let tile = budget.tile, tile > 0, let maxTiles = budget.maxTiles, maxTiles > 0 {
            func tiles(_ w: Int, _ h: Int) -> Int { ((w + tile - 1) / tile) * ((h + tile - 1) / tile) }
            if tiles(w, h) > maxTiles {
                // Analytic first guess, then shave until it fits (ceil rounding can leave it one row over).
                scale *= (Double(maxTiles) / Double(tiles(w, h))).squareRoot()
                (w, h) = sized(sw, sh, scale)
                var guardCount = 0
                while tiles(w, h) > maxTiles, guardCount < 10_000 {
                    scale *= 0.99
                    (w, h) = sized(sw, sh, scale)
                    guardCount += 1
                }
            }
        }
        return (w, h)
    }

    private static func sized(_ w: Int, _ h: Int, _ scale: Double) -> (Int, Int) {
        (max(1, Int((Double(w) * scale).rounded(.down))), max(1, Int((Double(h) * scale).rounded(.down))))
    }

    /// The quality sequence tried when an encoding is over the cap: `start`, then 0.1 lower each time,
    /// down to 0.4.
    public static func qualitySteps(start: Double) -> [Double] {
        var q = min(1, max(minQuality, start))
        var out = [q]
        while q - qualityStep >= minQuality - 1e-9 {
            q = ((q - qualityStep) * 100).rounded() / 100
            out.append(q)
        }
        return out
    }

    /// The qualities a picture over the caller's `maxBytes` is encoded at again, in order — only those below the
    /// quality asked for. Pure.
    public static func maxBytesLadder(below quality: Double) -> [Double] {
        [0.8, 0.6, 0.45, 0.3].filter { $0 < quality - 1e-9 }
    }

    /// `first` (encoded at `quality`) when it fits `maxBytes`; else the same picture re-encoded down the ladder —
    /// the first that fits, else the last that could be encoded (or `first` when none could). Pure.
    public static func fitMaxBytes(_ first: Data, quality: Double, maxBytes: Int, encode: (Double) -> Data?) -> Data {
        guard first.count > maxBytes else { return first }
        var last = first
        for q in maxBytesLadder(below: quality) {
            guard let d = encode(q) else { continue }
            last = d
            if d.count <= maxBytes { return d }
        }
        return last
    }

    /// Encodes with `encode(width, height, quality) -> bytes`, stepping quality and then size down until the
    /// result fits `byteCap`. Returns the bytes and the final size; nil when the encoder fails.
    public static func encodeWithinCap(
        width: Int, height: Int, quality: Double, byteCap: Int = byteCap,
        encode: (Int, Int, Double) -> Data?
    ) -> (data: Data, width: Int, height: Int)? {
        var w = width, h = height
        for _ in 0..<8 {
            var last: Data?
            for q in qualitySteps(start: quality) {
                guard let d = encode(w, h, q) else { return nil }
                last = d
                if d.count <= byteCap { return (d, w, h) }
            }
            guard last != nil, w > 64 || h > 64 else { break }
            w = max(1, Int(Double(w) * shrinkFactor))
            h = max(1, Int(Double(h) * shrinkFactor))
        }
        guard let d = encode(w, h, minQuality) else { return nil }
        return (d, w, h)
    }
}
