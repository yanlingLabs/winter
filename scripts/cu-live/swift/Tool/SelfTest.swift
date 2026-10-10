import CoreGraphics
import Foundation
import ImageIO

// `cu-live-tool self-test`: argument parsing and JSON encoding. Touches no window server.

func runToolSelfTest() -> Int32 {
    var passed = 0
    var failures: [String] = []
    func check(_ condition: Bool, _ name: String) {
        if condition { passed += 1 } else { failures.append(name) }
    }
    func parse(_ args: [String]) -> ToolCommand? {
        if case .success(let command) = ArgParser.parse(args) { return command }
        return nil
    }
    func usageError(_ args: [String]) -> String? {
        if case .failure(let error) = ArgParser.parse(args) { return error.message }
        return nil
    }

    // --- arguments -------------------------------------------------------------------------------------------
    check(parse(["front"]) == .front, "front")
    check(parse(["windows", "Safari"]) == .windows(owner: "Safari"), "windows")
    check(parse(["fresh-decode", "l.json", "a.png", "b.png"]) == .freshDecode(layout: "l.json", files: ["a.png", "b.png"]), "fresh-decode")
    check(usageError(["fresh-decode", "l.json"]) != nil, "fresh-decode needs a capture")
    check(parse(["monitor"]) == .monitor(intervalMs: 20), "monitor default interval is 20 ms")
    check(parse(["monitor", "--interval-ms", "50"]) == .monitor(intervalMs: 50), "monitor --interval-ms 50")
    check(parse(["monitor", "--interval-ms=7"]) == .monitor(intervalMs: 7), "monitor --interval-ms=7")
    check(usageError(["monitor", "--interval-ms", "0"]) != nil, "interval 0 rejected")
    check(usageError(["monitor", "--interval-ms", "fast"]) != nil, "interval non-number rejected")
    check(usageError(["monitor", "--interval-ms"]) != nil, "interval without a value rejected")
    check(usageError(["monitor", "--interval-ms", "20", "--interval-ms", "30"]) != nil, "repeated option rejected")
    check(usageError(["monitor", "--bogus", "1"]) != nil, "unknown option rejected")
    check(usageError(["monitor", "stray"]) != nil, "stray positional rejected")
    check(parse(["self-test"]) == .selfTest, "self-test")
    check(parse(["--help"]) == .help, "--help")
    check(usageError([]) != nil, "no command rejected")
    check(usageError(["frobnicate"]) != nil, "unknown command rejected")
    check(usageError(["front", "extra"]) != nil, "front with arguments rejected")
    check(parse(["session"]) == .session, "session")
    check(usageError(["session", "extra"]) != nil, "session with arguments rejected")

    check(parse(["image-stats", "/tmp/shot.png"]) == .imageStats(path: "/tmp/shot.png"), "image-stats <file>")
    check(usageError(["image-stats"]) != nil, "image-stats needs a file")
    check(usageError(["image-stats", "a", "b"]) != nil, "image-stats takes one file")

    check(parse(["post", "--run", "r1", "--role", "main", "--cmd", "ping"]) == .post(run: "r1", role: "main", cmd: "ping", args: nil, seq: nil), "post minimal")
    check(parse(["post", "--run", "r1", "--role", "user", "--cmd", "steal", "--args", "{\"mode\":\"focus\"}", "--seq", "12"])
          == .post(run: "r1", role: "user", cmd: "steal", args: "{\"mode\":\"focus\"}", seq: "12"), "post with args and seq")
    check(parse(["post", "--run=r1", "--role=main", "--cmd=dump", "--args={\"a\":1}"]) == .post(run: "r1", role: "main", cmd: "dump", args: "{\"a\":1}", seq: nil), "post with = forms (value may hold =)")
    check(usageError(["post", "--role", "main", "--cmd", "ping"]) == "--run is required", "post needs --run")
    check(usageError(["post", "--run", "r", "--role", "robot", "--cmd", "ping"]) == "--role must be main or user", "post rejects other roles")
    check(usageError(["post", "--run", "r", "--role", "main"]) == "--cmd is required", "post needs --cmd")
    check(usageError(["post", "--run", "r", "--role", "main", "--cmd", "x", "--args", "[1]"]) == "--args must be a JSON object", "post rejects array args")
    check(usageError(["post", "--run", "r", "--role", "main", "--cmd", "x", "--args", "{oops"]) == "--args must be a JSON object", "post rejects malformed args")
    check(usageError(["post", "--run", "r", "--role", "main", "--cmd", "x", "--seq"]) != nil, "post --seq without a value rejected")

    // --- JSON encoding ---------------------------------------------------------------------------------------
    let full = Sample(t: 1_760_000_000_001, front: "com.apple.finder", frontPid: 412, space: 7, hidIdleMs: 1532)
    check(full.json == "{\"t\":1760000000001,\"front\":\"com.apple.finder\",\"frontPid\":412,\"space\":7,\"hidIdleMs\":1532}", "full sample line")
    let empty = Sample(t: 5, front: nil, frontPid: nil, space: nil, hidIdleMs: nil)
    check(empty.json == "{\"t\":5,\"front\":null,\"frontPid\":null,\"space\":null,\"hidIdleMs\":null}", "all-null sample line")
    check(JSONOut.quote("a\"b\\c\nd\te") == "\"a\\\"b\\\\c\\nd\\te\"", "quote escapes")
    check(JSONOut.quote("\u{01}") == "\"\\u0001\"", "quote control char")
    check(JSONOut.quote("\u{2028}") == "\"\\u2028\"", "quote U+2028")
    check(JSONOut.quote("caf\u{E9}") == "\"caf\u{E9}\"", "quote keeps non-ASCII")
    for sample in [full, empty, Sample(t: 1, front: "we\"ird\nid", frontPid: 1, space: nil, hidIdleMs: 0)] {
        let parsed = (try? JSONSerialization.jsonObject(with: Data(sample.json.utf8), options: [])) as? [String: Any]
        check(parsed != nil, "sample line is valid JSON")
        check((parsed?["t"] as? NSNumber)?.intValue == sample.t, "t round-trips")
        check(parsed?["front"] as? String == sample.front, "front round-trips")
        check(!sample.json.contains("\n"), "sample line has no newline")
    }
    check(Sampling.nowMs() > 1_700_000_000_000, "nowMs is epoch milliseconds")
    // IOKit needs no permission and no window server: either a sane number or nil, never negative.
    check((Sampling.hidIdleMs() ?? 0) >= 0, "hidIdleMs is non-negative when present")
    var pointed = Sample(t: 2, front: nil, frontPid: nil, space: nil, hidIdleMs: nil)
    pointed.mouse = (x: 10, y: -3)
    check(pointed.json == "{\"t\":2,\"front\":null,\"frontPid\":null,\"space\":null,\"hidIdleMs\":null,\"mouse\":[10,-3]}", "a sample with the pointer")
    var tapped = Sample(t: 3, front: nil, frontPid: nil, space: nil, hidIdleMs: nil)
    tapped.hardware = (count: 2, lastMs: 1_700, startedMs: 1_000, keys: false)
    check(tapped.json.hasSuffix(",\"hw\":2,\"hwLast\":1700,\"hwStart\":1000,\"hwKeys\":false}"), "a monitor sample with the hardware tap")
    tapped.hardware = (count: 0, lastMs: nil, startedMs: 1_000, keys: true)
    check(tapped.json.hasSuffix(",\"hw\":0,\"hwLast\":null,\"hwStart\":1000,\"hwKeys\":true}"), "no hardware event yet")
    // Only hardware-origin events of the watched types count (source pid 0); synthetic ones never do.
    check(HardwareInput.counts(type: .mouseMoved, sourcePid: 0, keys: false), "hardware: a real mouse move counts")
    check(HardwareInput.counts(type: .scrollWheel, sourcePid: 0, keys: false), "hardware: a real scroll counts")
    check(HardwareInput.counts(type: .leftMouseDown, sourcePid: 0, keys: false), "hardware: a real click counts")
    check(!HardwareInput.counts(type: .mouseMoved, sourcePid: 4242, keys: true), "hardware: a synthetic move never counts")
    check(!HardwareInput.counts(type: .keyDown, sourcePid: 77, keys: true), "hardware: a synthetic key never counts")
    check(HardwareInput.counts(type: .keyDown, sourcePid: 0, keys: true), "hardware: a real key counts when keys are watched")
    check(!HardwareInput.counts(type: .keyDown, sourcePid: 0, keys: false), "hardware: keys unwatched without listen access")
    check(HardwareInput.counts(type: .flagsChanged, sourcePid: 0, keys: true), "hardware: a modifier counts")
    check(!HardwareInput.counts(type: .null, sourcePid: 0, keys: true), "hardware: other types never count")
    check(HardwareInput.mask(keys: false) & (CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue)) == 0, "hardware: no key bit without access")
    check(HardwareInput.mask(keys: true) & (CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue)) != 0, "hardware: the key bit with access")
    // fresh-decode: a synthetic capture at 2 pixels per point, chrome above the content (24 px), the sentinel at
    // content (8, 8) 48 pt, one band of 17 cells at content (72, 12) carrying 5 = 0b101 (two ones: even parity).
    let fw = 1100, fh = 200, chrome = 24, s2 = 2.0
    var px = [UInt8](repeating: 255, count: fw * fh * 4)
    func paint(_ x0: Int, _ y0: Int, _ w: Int, _ h: Int, _ rgb: (UInt8, UInt8, UInt8)) {
        for y in y0..<(y0 + h) { for x in x0..<(x0 + w) { let i = (y * fw + x) * 4; px[i] = rgb.0; px[i + 1] = rgb.1; px[i + 2] = rgb.2 } }
    }
    paint(16, chrome + 16, 96, 96, (255, 0, 255))
    let band = FreshLayout.Region(name: "native", x: 72, y: 12, cell: 28, cells: 17)
    for i in [13, 15] { paint(Int((72 + 28 * Double(i)) * s2), chrome + Int(12 * s2), 56, 56, (0, 0, 0)) }
    let fbox = FreshDecode.sentinelBox(px, width: fw, height: fh)
    check(fbox == PixelBox(minX: 16, minY: chrome + 16, maxX: 111, maxY: chrome + 111), "fresh-decode: the sentinel's box")
    if let fbox, let origin = FreshDecode.locate(fbox, sentinel: .init(x: 8, y: 8, size: 48)) {
        check(origin.scale == 2 && origin.x == 0 && origin.y == Double(chrome), "fresh-decode: origin and scale from the sentinel")
        let lumas = FreshDecode.cellLumas(px, width: fw, height: fh, region: band, origin: origin)
        check(lumas.count == 17 && lumas[13] < 10 && lumas[15] < 10 && lumas[14] > 245 && lumas[0] > 245, "fresh-decode: dark cells where the bits are")
        let before = FreshDecode.bandHash(px, width: fw, height: fh, region: band, origin: origin)
        check(before == FreshDecode.bandHash(px, width: fw, height: fh, region: band, origin: origin), "fresh-decode: the hash is stable")
        paint(Int((72 + 28 * 3) * s2), chrome + Int(12 * s2), 56, 56, (0, 0, 0))
        check(before != FreshDecode.bandHash(px, width: fw, height: fh, region: band, origin: origin), "fresh-decode: a flipped cell changes the hash")
        let lineOut = FreshDecode.line(file: "\"x.png\"", pixels: px, width: fw, height: fh, layout: FreshLayout(sentinel: .init(x: 8, y: 8, size: 48), regions: [band]))
        check(lineOut.hasPrefix("{\"file\":\"x.png\",\"ok\":true,\"scale\":2,\"regions\":{\"native\":{\"hash\":"), "fresh-decode: the JSON line")
    } else {
        check(false, "fresh-decode: locate")
    }
    check(FreshDecode.line(file: "\"y.png\"", pixels: [UInt8](repeating: 255, count: 16), width: 2, height: 2, layout: FreshLayout(sentinel: .init(x: 8, y: 8, size: 48), regions: [])).contains("no sentinel"), "fresh-decode: no sentinel")
    // The session query: locked only when the (undocumented) key is set; no dictionary or no console key = not on the console.
    check(SessionState.parse([SessionState.onConsoleKey: 1]) == .init(locked: false, onConsole: true), "session: unlocked on the console")
    check(SessionState.parse([SessionState.onConsoleKey: 1, SessionState.lockedKey: 1]) == .init(locked: true, onConsole: true), "session: locked on the console")
    check(SessionState.parse([SessionState.onConsoleKey: true, SessionState.lockedKey: false]) == .init(locked: false, onConsole: true), "session: Bool values read too")
    check(SessionState.parse([SessionState.onConsoleKey: 0]) == .init(locked: false, onConsole: false), "session: another user's console")
    check(SessionState.parse([:]) == .init(locked: false, onConsole: false), "session: no console key is not the console")
    check(SessionState.parse(nil) == .init(locked: false, onConsole: false), "session: no GUI session is not the console")
    check(SessionState.Reading(locked: true, onConsole: false).json == "{\"locked\":true,\"onConsole\":false}", "session: the line")
    check(SessionState.read().json.hasPrefix("{\"locked\":"), "session: the live query answers a line")
    var withSession = Sample(t: 4, front: nil, frontPid: nil, space: nil, hidIdleMs: nil)
    withSession.session = .init(locked: true, onConsole: true)
    check(withSession.json == "{\"t\":4,\"front\":null,\"frontPid\":null,\"space\":null,\"hidIdleMs\":null,\"locked\":true,\"onConsole\":true}", "a monitor sample with the session state")
    tapped.session = .init(locked: false, onConsole: true)
    check(tapped.json.hasSuffix(",\"hwKeys\":true,\"locked\":false,\"onConsole\":true}"), "the session state follows the hardware fields")
    pointed.spaceType = 4
    check(pointed.json.hasSuffix(",\"mouse\":[10,-3],\"spaceType\":4}"), "a front sample with the Space's type")

    // --- image-stats on synthetic images ---------------------------------------------------------------------
    func image(width: Int, height: Int, space: CGColorSpace, _ draw: (CGContext) -> Void) -> CGImage? {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        draw(context)
        return context.makeImage()
    }
    func encode(_ image: CGImage?, type: String) -> Data? {
        guard let image else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
    let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
    let magenta = CGColor(colorSpace: srgb, components: [1, 0, 1, 1])!
    let white = CGColor(colorSpace: srgb, components: [1, 1, 1, 1])!
    /// A white 400x300 picture, with the sentinel (48x48 at 8,8 from the top-left) when asked.
    func screenshot(space: CGColorSpace, withSentinel: Bool) -> CGImage? {
        image(width: 400, height: 300, space: space) { context in
            context.setFillColor(white)
            context.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
            if withSentinel {
                context.setFillColor(magenta)
                context.fill(CGRect(x: 8, y: 300 - 8 - 48, width: 48, height: 48)) // CG's origin is bottom-left
            }
        }
    }
    func report(_ data: Data?) -> ImageReport? {
        guard let data, case .success(let report) = ImageStats.analyze(data: data) else { return nil }
        return report
    }

    let plainWhite = report(encode(screenshot(space: srgb, withSentinel: false), type: "public.png"))
    check(plainWhite?.width == 400 && plainWhite?.height == 300, "image-stats: size")
    check(plainWhite?.sentinelPixels == 0, "image-stats: a blank picture has no sentinel pixels")
    check(plainWhite?.blank == true, "image-stats: a white picture is blank")
    check((plainWhite?.meanLuma ?? 0) > 250, "image-stats: a white picture is bright")
    let marked = report(encode(screenshot(space: srgb, withSentinel: true), type: "public.png"))
    check(marked?.sentinelPixels == 2304, "image-stats: a 48x48 magenta block is 2304 pixels (got \(marked?.sentinelPixels ?? -1))")
    check(marked?.sentinelFraction == 2304.0 / 120_000.0, "image-stats: sentinelFraction is pixels over w*h")
    check(marked?.blank == false, "image-stats: a picture with a block is not blank")
    let markedJPEG = report(encode(screenshot(space: srgb, withSentinel: true), type: "public.jpeg"))
    check((1800...2304).contains(markedJPEG?.sentinelPixels ?? 0), "image-stats: JPEG fuzz keeps the sentinel countable (got \(markedJPEG?.sentinelPixels ?? -1))")
    check(report(encode(screenshot(space: srgb, withSentinel: false), type: "public.jpeg"))?.sentinelPixels == 0, "image-stats: a blank JPEG has no sentinel pixels")
    // A screenshot tagged Display P3 (what screencapture writes on a wide-gamut display): the block is drawn from
    // the sRGB magenta, so the file holds P3 code values — counting must still see 2304.
    let p3 = CGColorSpace(name: CGColorSpace.displayP3)!
    let markedP3 = report(encode(screenshot(space: p3, withSentinel: true), type: "public.png"))
    check(markedP3?.sentinelPixels == 2304, "image-stats: a Display P3 screenshot is converted before counting (got \(markedP3?.sentinelPixels ?? -1))")
    let markedDevice = report(encode(screenshot(space: CGColorSpaceCreateDeviceRGB(), withSentinel: true), type: "public.png"))
    check(markedDevice?.sentinelPixels == 2304, "image-stats: an untagged (device RGB) picture counts too (got \(markedDevice?.sentinelPixels ?? -1))")
    // Not magenta: pure red, pure blue, and pink with too much green must not count.
    let notSentinel = image(width: 100, height: 100, space: srgb) { context in
        context.setFillColor(CGColor(colorSpace: srgb, components: [1, 0, 0, 1])!); context.fill(CGRect(x: 0, y: 0, width: 50, height: 50))
        context.setFillColor(CGColor(colorSpace: srgb, components: [0, 0, 1, 1])!); context.fill(CGRect(x: 50, y: 0, width: 50, height: 50))
        context.setFillColor(CGColor(colorSpace: srgb, components: [1, 0.6, 1, 1])!); context.fill(CGRect(x: 0, y: 50, width: 100, height: 50))
    }
    check(report(encode(notSentinel, type: "public.png"))?.sentinelPixels == 0, "image-stats: red, blue and pink are not the sentinel")
    check(ImageStats.isSentinel(r: 200, g: 70, b: 200) && !ImageStats.isSentinel(r: 199, g: 0, b: 255)
          && !ImageStats.isSentinel(r: 255, g: 71, b: 255) && !ImageStats.isSentinel(r: 255, g: 0, b: 199), "image-stats: the rule's boundaries")
    if let marked {
        let parsed = (try? JSONSerialization.jsonObject(with: Data(marked.json.utf8), options: [])) as? [String: Any]
        check(parsed != nil && Set(parsed!.keys) == ["width", "height", "meanLuma", "stddevLuma", "blank", "sentinelPixels", "sentinelFraction"], "image-stats: the line has exactly the contract's keys")
        check(parsed?["sentinelPixels"] as? Int == 2304 && parsed?["blank"] as? Bool == false && parsed?["width"] as? Int == 400, "image-stats: the line's values")
        check(marked.json.hasPrefix("{\"width\":400,\"height\":300,\"meanLuma\":"), "image-stats: the line's key order")
    } else {
        check(false, "image-stats: the line has exactly the contract's keys")
    }
    if case .failure(let error) = ImageStats.analyze(data: Data("definitely not an image".utf8)) {
        check(error.message == "not an image ImageIO can decode", "image-stats: undecodable bytes are an error")
    } else { check(false, "image-stats: undecodable bytes are an error") }
    if case .failure(let error) = ImageStats.analyze(path: "/nonexistent/cu-live/shot.png") {
        check(error.message.hasPrefix("cannot read"), "image-stats: a missing file is an error")
    } else { check(false, "image-stats: a missing file is an error") }

    if failures.isEmpty {
        print("SELFTEST OK")
        return 0
    }
    for failure in failures { print("SELFTEST FAIL \(failure)") }
    print("SELFTEST FAILED \(failures.count) of \(passed + failures.count) checks")
    return 1
}
