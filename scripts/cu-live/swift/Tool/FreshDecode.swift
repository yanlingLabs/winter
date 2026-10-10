import CoreGraphics
import Foundation
import ImageIO

// `cu-live-tool fresh-decode <layout.json> <png>…`: for each capture of the Fixture Fresh window, find the sentinel
// (it gives the content's origin and the pixels-per-point scale wherever the window chrome put it), then per region
// a hash of its band's pixels and the mean luma of each cell. One JSON line per file. Deciding what the cells SAY
// (the counter, its parity, the CSS slot) is the runner's (lib.ts), so it is unit-tested without a screen.

struct FreshLayout: Decodable, Equatable {
    struct Sentinel: Decodable, Equatable { var x: Double; var y: Double; var size: Double }
    struct Region: Decodable, Equatable { var name: String; var x: Double; var y: Double; var cell: Double; var cells: Int }
    var sentinel: Sentinel
    var regions: [Region]
}

struct PixelBox: Equatable { var minX: Int; var minY: Int; var maxX: Int; var maxY: Int }

enum FreshDecode {
    /// The bounding box of the sentinel's pixels (top-left rows first), or nil.
    static func sentinelBox(_ pixels: [UInt8], width: Int, height: Int) -> PixelBox? {
        var box: PixelBox?
        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                guard ImageStats.isSentinel(r: pixels[i], g: pixels[i + 1], b: pixels[i + 2]) else { continue }
                if var b = box {
                    b.minX = min(b.minX, x); b.maxX = max(b.maxX, x); b.minY = min(b.minY, y); b.maxY = max(b.maxY, y)
                    box = b
                } else {
                    box = PixelBox(minX: x, minY: y, maxX: x, maxY: y)
                }
            }
        }
        return box
    }

    /// The content's origin (pixels) and the scale (pixels per point), from the sentinel's box.
    static func locate(_ box: PixelBox, sentinel: FreshLayout.Sentinel) -> (x: Double, y: Double, scale: Double)? {
        let scale = Double(box.maxX - box.minX + 1) / sentinel.size
        guard scale > 0.5, scale < 8 else { return nil }
        return (Double(box.minX) - sentinel.x * scale, Double(box.minY) - sentinel.y * scale, scale)
    }

    /// The mean Rec. 601 luma of each cell's middle (a box half the cell wide), 0…255.
    static func cellLumas(_ pixels: [UInt8], width: Int, height: Int, region: FreshLayout.Region, origin: (x: Double, y: Double, scale: Double)) -> [Int] {
        let half = max(1, Int((region.cell * origin.scale * 0.25).rounded()))
        return (0..<region.cells).map { i in
            let cx = Int((origin.x + (region.x + region.cell * (Double(i) + 0.5)) * origin.scale).rounded())
            let cy = Int((origin.y + (region.y + region.cell * 0.5) * origin.scale).rounded())
            var sum = 0.0, n = 0.0
            for y in max(0, cy - half)..<min(height, cy + half) {
                for x in max(0, cx - half)..<min(width, cx + half) {
                    let p = (y * width + x) * 4
                    sum += 0.299 * Double(pixels[p]) + 0.587 * Double(pixels[p + 1]) + 0.114 * Double(pixels[p + 2])
                    n += 1
                }
            }
            return n == 0 ? -1 : Int((sum / n).rounded())
        }
    }

    /// FNV-1a 64 over the RGB bytes of the region's band, hex.
    static func bandHash(_ pixels: [UInt8], width: Int, height: Int, region: FreshLayout.Region, origin: (x: Double, y: Double, scale: Double)) -> String {
        let x0 = max(0, Int((origin.x + region.x * origin.scale).rounded()))
        let y0 = max(0, Int((origin.y + region.y * origin.scale).rounded()))
        let x1 = min(width, Int((origin.x + (region.x + region.cell * Double(region.cells)) * origin.scale).rounded()))
        let y1 = min(height, Int((origin.y + (region.y + region.cell) * origin.scale).rounded()))
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        if x0 < x1, y0 < y1 {
            for y in y0..<y1 {
                for x in x0..<x1 {
                    let p = (y * width + x) * 4
                    for c in 0..<3 { hash = (hash ^ UInt64(pixels[p + c])) &* 0x0000_0100_0000_01b3 }
                }
            }
        }
        return String(hash, radix: 16)
    }

    /// One capture → its JSON line.
    static func decode(path: String, layout: FreshLayout) -> String {
        let file = JSONOut.quote((path as NSString).lastPathComponent)
        guard let data = FileManager.default.contents(atPath: path),
              let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              let pixels = ImageStats.bitmap(of: image, width: image.width, height: image.height) else {
            return "{\"file\":\(file),\"ok\":false,\"error\":\"not an image ImageIO can decode\"}"
        }
        return line(file: file, pixels: pixels, width: image.width, height: image.height, layout: layout)
    }

    static func line(file: String, pixels: [UInt8], width: Int, height: Int, layout: FreshLayout) -> String {
        guard let box = sentinelBox(pixels, width: width, height: height), let origin = locate(box, sentinel: layout.sentinel) else {
            return "{\"file\":\(file),\"ok\":false,\"error\":\"no sentinel in the capture\"}"
        }
        let regions = layout.regions.map { r -> String in
            let lumas = cellLumas(pixels, width: width, height: height, region: r, origin: origin).map(String.init).joined(separator: ",")
            return "\(JSONOut.quote(r.name)):{\"hash\":\(JSONOut.quote(bandHash(pixels, width: width, height: height, region: r, origin: origin))),\"lumas\":[\(lumas)]}"
        }.joined(separator: ",")
        return "{\"file\":\(file),\"ok\":true,\"scale\":\(JSONOut.number((origin.scale * 1000).rounded() / 1000)),\"regions\":{\(regions)}}"
    }
}
