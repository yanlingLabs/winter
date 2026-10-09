import CoreGraphics
import Foundation
import ImageIO

// `cu-live-viewprobe self-test`: arguments, the luma statistics on synthetic images, the wire shapes and the
// output lines. Opens no socket.

// sRGB throughout: DeviceRGB/DeviceGray colours are colour-managed on macOS (a "0.5" draws as ~146 once decoded),
// which would make the expected luma values in these checks depend on the display profile.
private let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

private func makeImage(width: Int, height: Int, _ draw: (CGContext) -> Void) -> CGImage? {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: srgb, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    draw(context)
    return context.makeImage()
}

private func jpegData(_ image: CGImage?) -> Data? {
    guard let image else { return nil }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
}

private func gray(_ value: CGFloat) -> CGColor { CGColor(colorSpace: srgb, components: [value, value, value, 1])! }

/// Cells of two grays, each `cell` pixels square.
private func checker(_ a: CGFloat, _ b: CGFloat, cell: Int) -> CGImage? {
    makeImage(width: 320, height: 200) { context in
        for row in 0..<(200 / cell + 1) {
            for column in 0..<(320 / cell + 1) {
                context.setFillColor(gray((row + column) % 2 == 0 ? a : b))
                context.fill(CGRect(x: column * cell, y: row * cell, width: cell, height: cell))
            }
        }
    }
}

private func parsed(_ line: String?) -> [String: Any]? {
    guard let line, let data = line.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
}

func runProbeSelfTest() -> Int32 {
    var passed = 0
    var failures: [String] = []
    func check(_ condition: Bool, _ name: String) {
        if condition { passed += 1 } else { failures.append(name) }
    }

    // --- arguments -------------------------------------------------------------------------------------------
    func args(_ list: [String]) -> ProbeCommand? {
        if case .success(let command) = ProbeArgs.parse(list) { return command }
        return nil
    }
    func argError(_ list: [String]) -> String? {
        if case .failure(let error) = ProbeArgs.parse(list) { return error.message }
        return nil
    }
    check(args(["--socket", "/h/run/computer-use.sock", "--home", "/h", "--session", "s_1"])
          == .run(ProbeOptions(socket: "/h/run/computer-use.sock", home: "/h", session: "s_1", maxFps: 10, maxWidth: 480)), "defaults are 10 fps and 480 px")
    check(args(["--socket=/s", "--home=/h", "--session=s", "--max-fps=4", "--max-width", "720"])
          == .run(ProbeOptions(socket: "/s", home: "/h", session: "s", maxFps: 4, maxWidth: 720)), "= forms and overrides")
    check(args(["self-test"]) == .selfTest, "self-test")
    check(args(["--help"]) == .help, "--help")
    check(argError(["--home", "/h", "--session", "s"]) == "--socket is required", "socket required")
    check(argError(["--socket", "/s", "--session", "s"]) == "--home is required", "home required")
    check(argError(["--socket", "/s", "--home", "/h"]) == "--session is required", "session required")
    check(argError(["--socket", "/s", "--home", "/h", "--session", "s", "--max-fps", "0"]) != nil, "max-fps 0 rejected")
    check(argError(["--socket", "/s", "--home", "/h", "--session", "s", "--max-width", "wide"]) != nil, "max-width non-number rejected")
    check(argError(["--socket", "/s", "--home", "/h", "--session", "s", "--frames", "no"]) != nil, "unknown option rejected")
    check(argError(["--socket", "/s", "--socket", "/t", "--home", "/h", "--session", "s"]) != nil, "repeated option rejected")
    check(argError(["--socket"]) != nil, "option without value rejected")
    check(argError([]) != nil, "no arguments rejected")
    check(ProbeClient.socketPathProblem("/tmp/short.sock") == nil, "short socket path accepted")
    check(ProbeClient.socketPathProblem("/" + String(repeating: "a", count: 120)) != nil, "over-long socket path refused (the helper could not bind it either)")

    // --- luma on synthetic images ----------------------------------------------------------------------------
    let white = makeImage(width: 320, height: 200) { $0.setFillColor(gray(1)); $0.fill(CGRect(x: 0, y: 0, width: 320, height: 200)) }
    let black = makeImage(width: 320, height: 200) { $0.setFillColor(gray(0)); $0.fill(CGRect(x: 0, y: 0, width: 320, height: 200)) }
    let flatGray = makeImage(width: 320, height: 200) { $0.setFillColor(gray(0.5)); $0.fill(CGRect(x: 0, y: 0, width: 320, height: 200)) }
    let whiteStats = jpegData(white).flatMap(Luma.stats(jpeg:))
    let blackStats = jpegData(black).flatMap(Luma.stats(jpeg:))
    let grayStats = jpegData(flatGray).flatMap(Luma.stats(jpeg:))
    check((whiteStats?.mean ?? 0) > 250, "white frame is bright")
    check(whiteStats?.blank == true, "white frame is blank")
    check((blackStats?.mean ?? 255) < 5, "black frame is dark")
    check(blackStats?.blank == true, "black frame is blank")
    check(abs((grayStats?.mean ?? 0) - 128) < 4, "flat gray frame has mean near 128")
    check(grayStats?.blank == true, "flat gray frame is blank")
    check((whiteStats?.stddev ?? 99) < 1, "a flat frame has ~0 spread")

    let strong = jpegData(checker(0, 1, cell: 40)).flatMap(Luma.stats(jpeg:))
    check((strong?.stddev ?? 0) > 100, "black/white checkerboard has a large spread")
    check(strong?.blank == false, "checkerboard is not blank")
    let faint = jpegData(checker(100.0 / 255, 102.0 / 255, cell: 80)).flatMap(Luma.stats(jpeg:))
    check(faint?.blank == true, "a 2-level-difference frame counts as blank (stddev under 2)")
    let visible = jpegData(checker(100.0 / 255, 110.0 / 255, cell: 80)).flatMap(Luma.stats(jpeg:))
    check(visible?.blank == false, "a 10-level-difference frame is not blank")
    let gradient = makeImage(width: 320, height: 200) { context in
        for x in 0..<320 {
            context.setFillColor(gray(CGFloat(x) / 319))
            context.fill(CGRect(x: x, y: 0, width: 1, height: 200))
        }
    }
    let gradientStats = jpegData(gradient).flatMap(Luma.stats(jpeg:))
    check(abs((gradientStats?.mean ?? 0) - 128) < 6, "gradient mean is mid-gray")
    check((gradientStats?.stddev ?? 0) > 60, "gradient has a wide spread")
    let mostlyWhite = makeImage(width: 320, height: 200) { context in
        context.setFillColor(gray(1)); context.fill(CGRect(x: 0, y: 0, width: 320, height: 200))
        context.setFillColor(gray(0)); context.fill(CGRect(x: 20, y: 20, width: 70, height: 30))
    }
    check(jpegData(mostlyWhite).flatMap(Luma.stats(jpeg:))?.blank == false, "a mostly-white window with some content is not blank")
    check(Luma.stats(jpeg: Data("not an image".utf8)) == nil, "undecodable bytes give no stats")
    check(Luma.stats(jpeg: Data()) == nil, "empty bytes give no stats")

    // --- the wire --------------------------------------------------------------------------------------------
    let hello = parsed(String(decoding: ProbeProtocol.hello(home: "/Users/x/.winter-dev"), as: UTF8.self))
    check(ProbeProtocol.hello(home: "/h").last == 0x0A, "requests end in a newline")
    check(hello?["method"] as? String == "hello" && hello?["id"] as? Int == 1, "hello is request 1")
    let helloParams = hello?["params"] as? [String: Any]
    check(helloParams?["client"] as? String == "app" && helloParams?["protocol"] as? Int == 1 && helloParams?["home"] as? String == "/Users/x/.winter-dev", "hello params")
    let subscribe = parsed(String(decoding: ProbeProtocol.subscribe(session: "s_9", maxFps: 5, maxWidth: 320), as: UTF8.self))
    let subscribeParams = subscribe?["params"] as? [String: Any]
    check(subscribe?["method"] as? String == "view.subscribe", "subscribe method")
    check(subscribeParams?["sessionId"] as? String == "s_9" && subscribeParams?["frames"] as? Bool == true
          && subscribeParams?["maxFps"] as? Int == 5 && subscribeParams?["maxWidth"] as? Int == 320, "subscribe params")
    let unsubscribe = parsed(String(decoding: ProbeProtocol.unsubscribe(session: "s_9"), as: UTF8.self))
    check(unsubscribe?["method"] as? String == "view.unsubscribe" && (unsubscribe?["params"] as? [String: Any])?["sessionId"] as? String == "s_9", "unsubscribe")

    func inbound(_ text: String) -> ProbeProtocol.Inbound { ProbeProtocol.decode(Data(text.utf8)) }
    if case .result(let id, let result) = inbound("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"targets\":[{\"targetId\":\"t1\"}]}}") {
        check(id == 2 && (result["targets"] as? [Any])?.count == 1, "subscribe result decodes")
    } else { check(false, "subscribe result decodes") }
    if case .failure(let id, let message) = inbound("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"nope\",\"data\":{\"code\":\"not_allowed\",\"reason\":\"identity\"}}}") {
        check(id == 1 && message == "not_allowed: nope", "typed error surfaces its data.code")
    } else { check(false, "typed error surfaces its data.code") }
    if case .notification(let method, let params) = inbound("{\"jsonrpc\":\"2.0\",\"method\":\"view.released\",\"params\":{\"targetId\":\"t1\"}}") {
        check(method == "view.released" && params["targetId"] as? String == "t1", "notification decodes")
    } else { check(false, "notification decodes") }
    if case .ignored = inbound("garbage") { check(true, "garbage ignored") } else { check(false, "garbage ignored") }
    if case .ignored = inbound("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"hello\"}") { check(true, "a server-side request is ignored") } else { check(false, "a server-side request is ignored") }

    // --- output lines ----------------------------------------------------------------------------------------
    let bound = parsed(ProbeProtocol.eventLine(method: "view.bound", params: ["sessionId": "s", "targetId": "t1", "pid": 321, "windowId": 77,
                                                                               "appName": "Winter CU Fixture", "bundleId": "com.winter.cu-fixture",
                                                                               "windowSize": [640, 390]], t: 1000))
    check(bound?["ev"] as? String == "bound" && bound?["targetId"] as? String == "t1" && bound?["pid"] as? Int == 321
          && bound?["windowId"] as? Int == 77 && bound?["appName"] as? String == "Winter CU Fixture" && bound?["t"] as? Int == 1000, "bound line")
    let released = parsed(ProbeProtocol.eventLine(method: "view.released", params: ["targetId": "t1"], t: 1))
    check(released?["ev"] as? String == "released" && released?["targetId"] as? String == "t1", "released line")
    let cursor = parsed(ProbeProtocol.eventLine(method: "view.cursor", params: ["targetId": "t1", "kind": "click", "point": [1, 2]], t: 1))
    check(cursor?["ev"] as? String == "cursor" && cursor?["kind"] as? String == "click" && cursor?["point"] == nil, "cursor line carries target and kind only")
    check(ProbeProtocol.eventLine(method: "view.unknown", params: [:]) == nil, "unknown notification gives no line")

    let whiteJPEG = jpegData(white) ?? Data()
    let whiteB64 = whiteJPEG.base64EncodedString()
    let whiteLine = ProbeProtocol.eventLine(method: "view.frame", params: ["sessionId": "s", "targetId": "t1", "seq": 5, "width": 480, "height": 300,
                                                                            "windowSize": [640, 390], "jpeg": whiteB64], t: 2)
    let frame = parsed(whiteLine)
    check(frame?["ev"] as? String == "frame" && frame?["seq"] as? Int == 5 && frame?["width"] as? Int == 480 && frame?["height"] as? Int == 300, "frame line fields")
    check(frame?["bytes"] as? Int == whiteJPEG.count && whiteJPEG.count > 0, "frame bytes is the decoded JPEG size")
    check(frame?["blank"] as? Bool == true && ((frame?["meanLuma"] as? NSNumber)?.doubleValue ?? 0) > 250, "white frame reports blank with high luma")
    check(!(whiteLine ?? "").contains(String(whiteB64.prefix(60))), "frame line never carries image bytes")
    check((whiteLine ?? "").utf8.count < 400, "frame line stays small")
    check(frame?["decodeFailed"] == nil, "a decodable frame has no decodeFailed")
    let checkerB64 = (jpegData(checker(0, 1, cell: 40)) ?? Data()).base64EncodedString()
    let busy = parsed(ProbeProtocol.eventLine(method: "view.frame", params: ["targetId": "t1", "seq": 6, "width": 320, "height": 200, "jpeg": checkerB64], t: 3))
    check(busy?["blank"] as? Bool == false && ((busy?["stddevLuma"] as? NSNumber)?.doubleValue ?? 0) > 100, "busy frame reports not blank")
    let broken = parsed(ProbeProtocol.eventLine(method: "view.frame", params: ["targetId": "t1", "seq": 7, "width": 1, "height": 1, "jpeg": "!!! not base64 !!!"], t: 4))
    check(broken?["decodeFailed"] as? Bool == true && broken?["blank"] as? Bool == true && broken?["bytes"] as? Int == 0 && broken?["meanLuma"] is NSNull, "undecodable frame is reported, not dropped")
    let notImage = parsed(ProbeProtocol.eventLine(method: "view.frame", params: ["targetId": "t1", "seq": 8, "jpeg": Data("hello".utf8).base64EncodedString()], t: 5))
    check(notImage?["decodeFailed"] as? Bool == true && notImage?["bytes"] as? Int == 5, "valid base64 that is not an image is reported")

    let subscribed = parsed(ProbeProtocol.subscribedLine(targets: [["targetId": "t1", "appName": "A/B", "windowSize": [640, 390]]], t: 9))
    check((subscribed?["targets"] as? [[String: Any]])?.first?["appName"] as? String == "A/B" && subscribed?["ev"] as? String == "subscribed", "subscribed line passes targets through")
    check(!ProbeProtocol.subscribedLine(targets: [["x": "a/b"]], t: 1).contains("\\/"), "slashes are not escaped")
    let errorLine = parsed(ProbeProtocol.errorLine("it \"broke\"\n", t: 10))
    check(errorLine?["ev"] as? String == "error" && errorLine?["message"] as? String == "it \"broke\"\n", "error line round-trips its message")
    check(JSONOut.line(t: 1, ev: "x", [("n", .d(.nan))]).contains("\"n\":null"), "non-finite numbers become null")

    if failures.isEmpty {
        print("SELFTEST OK")
        return 0
    }
    for failure in failures { print("SELFTEST FAIL \(failure)") }
    print("SELFTEST FAILED \(failures.count) of \(passed + failures.count) checks")
    return 1
}
