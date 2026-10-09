import CoreGraphics
import Foundation
import ImageIO

// cu-live-viewprobe's pure parts: arguments, the wire's request/notification shapes, the luma statistics of a
// frame, and the output lines. Nothing here opens a socket.

// MARK: - JSON output

/// A value for an output line. `raw` is already-encoded JSON (the subscribe result's targets, passed through).
enum J {
    case s(String)
    case i(Int)
    case d(Double)
    case b(Bool)
    case null
    case raw(String)
}

enum JSONOut {
    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    static func number(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
        return "\(d)"
    }

    static func value(_ v: J) -> String {
        switch v {
        case .s(let s): return quote(s)
        case .i(let i): return String(i)
        case .d(let d): return number(d)
        case .b(let b): return b ? "true" : "false"
        case .null: return "null"
        case .raw(let r): return r
        }
    }

    /// `{"t":<ms>,"ev":"<ev>", ...fields}` — no trailing newline.
    static func line(t: Int, ev: String, _ fields: [(String, J)] = []) -> String {
        var out = "{\"t\":\(t),\"ev\":\(quote(ev))"
        for (key, v) in fields { out += ",\(quote(key)):\(value(v))" }
        return out + "}"
    }

    static func nowMs() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }
}

// MARK: - Arguments

struct ProbeOptions: Equatable {
    var socket: String
    var home: String
    var session: String
    var maxFps: Int = 10
    var maxWidth: Int = 480
}

enum ProbeCommand: Equatable {
    case run(ProbeOptions)
    case selfTest
    case help
}

struct UsageError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

enum ProbeArgs {
    static let usage = """
    usage:
      cu-live-viewprobe --socket <path> --home <home> --session <sessionId> [--max-fps 10] [--max-width 480]
      cu-live-viewprobe self-test
      cu-live-viewprobe --help
    Connects to the Computer Use helper as the "app" client, subscribes to the session's view stream and prints one
    JSON line per event (subscribed, bound, released, cursor, frame, error). Frames are summarised, never printed.
    Runs until stdin reaches EOF or SIGTERM. Exit codes: 0 clean, 2 error, 3 closed by the helper.
    """

    static func parse(_ argv: [String]) -> Result<ProbeCommand, UsageError> {
        if argv.isEmpty { return .failure(UsageError("no arguments given")) }
        if argv == ["--help"] || argv == ["-h"] || argv == ["help"] { return .success(.help) }
        if argv == ["self-test"] || argv == ["--self-test"] { return .success(.selfTest) }

        var found: [String: String] = [:]
        var index = 0
        let allowed: Set<String> = ["socket", "home", "session", "max-fps", "max-width"]
        while index < argv.count {
            let arg = argv[index]
            guard arg.hasPrefix("--") else { return .failure(UsageError("unexpected argument \(arg)")) }
            var name = String(arg.dropFirst(2))
            var value: String
            if let equals = name.firstIndex(of: "=") {
                value = String(name[name.index(after: equals)...])
                name = String(name[..<equals])
            } else {
                index += 1
                guard index < argv.count else { return .failure(UsageError("--\(name) needs a value")) }
                value = argv[index]
            }
            guard allowed.contains(name) else { return .failure(UsageError("unknown option --\(name)")) }
            guard found[name] == nil else { return .failure(UsageError("--\(name) given twice")) }
            found[name] = value
            index += 1
        }
        guard let socket = found["socket"], !socket.isEmpty else { return .failure(UsageError("--socket is required")) }
        guard let home = found["home"], !home.isEmpty else { return .failure(UsageError("--home is required")) }
        guard let session = found["session"], !session.isEmpty else { return .failure(UsageError("--session is required")) }
        var options = ProbeOptions(socket: socket, home: home, session: session)
        if let raw = found["max-fps"] {
            guard let n = Int(raw), n > 0 else { return .failure(UsageError("--max-fps must be a positive whole number")) }
            options.maxFps = n
        }
        if let raw = found["max-width"] {
            guard let n = Int(raw), n > 0 else { return .failure(UsageError("--max-width must be a positive whole number")) }
            options.maxWidth = n
        }
        return .success(.run(options))
    }
}

// MARK: - Luma statistics

struct LumaStats: Equatable {
    var mean: Double
    var stddev: Double
    /// A window that is blank (or a failed capture, which comes back flat) has next to no spread in luma.
    var blank: Bool { stddev < Luma.blankThreshold }
}

enum Luma {
    /// The frame is reduced to this many samples before measuring: cheap, and a flat window stays flat.
    static let gridWidth = 64
    static let gridHeight = 40
    static let blankThreshold = 2.0

    /// Decodes a JPEG and measures it. nil when the bytes are not an image ImageIO can decode.
    static func stats(jpeg: Data) -> LumaStats? {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return stats(image: image)
    }

    /// The image is drawn into a 64x40 sRGB bitmap (the interpolated downscale is the averaging), then each
    /// sample's luma is Rec. 601: 0.299 R + 0.587 G + 0.114 B on the 0-255 code values. NOT a gray colour space:
    /// Core Graphics' color-managed conversion is non-linear (sRGB 128 comes out as ~146), which would make
    /// `meanLuma` mean something other than "how bright is this picture in the numbers the encoder holds".
    static func stats(image: CGImage) -> LumaStats? {
        let count = gridWidth * gridHeight
        var pixels = [UInt8](repeating: 0, count: count * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(data: buffer.baseAddress, width: gridWidth, height: gridHeight, bitsPerComponent: 8,
                                          bytesPerRow: gridWidth * 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: gridWidth, height: gridHeight))
            return true
        }
        guard drawn else { return nil }
        var lumas = [Double](repeating: 0, count: count)
        for index in 0..<count {
            let base = index * 4
            lumas[index] = 0.299 * Double(pixels[base]) + 0.587 * Double(pixels[base + 1]) + 0.114 * Double(pixels[base + 2])
        }
        let mean = lumas.reduce(0, +) / Double(count)
        let variance = lumas.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(count)
        return LumaStats(mean: mean, stddev: variance.squareRoot())
    }
}

// MARK: - The wire

enum ProbeProtocol {
    static let protocolVersion = 1
    static let helloId = 1
    static let subscribeId = 2
    static let unsubscribeId = 3

    private static func request(id: Int, method: String, params: [String: Any]) -> Data {
        let body: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method, "params": params]
        var data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        data.append(0x0A)
        return data
    }

    static func hello(home: String) -> Data {
        request(id: helloId, method: "hello", params: ["protocol": protocolVersion, "client": "app", "home": home])
    }

    static func subscribe(session: String, maxFps: Int, maxWidth: Int) -> Data {
        request(id: subscribeId, method: "view.subscribe", params: ["sessionId": session, "frames": true, "maxFps": maxFps, "maxWidth": maxWidth])
    }

    static func unsubscribe(session: String) -> Data {
        request(id: unsubscribeId, method: "view.unsubscribe", params: ["sessionId": session])
    }

    enum Inbound {
        case result(id: Int, result: [String: Any])
        case failure(id: Int, message: String)
        case notification(method: String, params: [String: Any])
        case ignored
    }

    static func decode(_ line: Data) -> Inbound {
        guard let object = (try? JSONSerialization.jsonObject(with: line, options: [])) as? [String: Any] else { return .ignored }
        if let method = object["method"] as? String, object["id"] == nil {
            return .notification(method: method, params: (object["params"] as? [String: Any]) ?? [:])
        }
        // A message with both a method and an id is a request; the helper never sends one to a client.
        guard object["method"] == nil, let id = (object["id"] as? NSNumber)?.intValue else { return .ignored }
        if let error = object["error"] as? [String: Any] {
            // The helper's typed code lives in error.data.code; the numeric JSON-RPC code is only a courtesy.
            let data = error["data"] as? [String: Any]
            let code = data?["code"] as? String
            let message = (error["message"] as? String) ?? "unknown error"
            return .failure(id: id, message: code.map { "\($0): \(message)" } ?? message)
        }
        return .result(id: id, result: (object["result"] as? [String: Any]) ?? [:])
    }

    // MARK: Output lines

    static func errorLine(_ message: String, t: Int = JSONOut.nowMs()) -> String {
        JSONOut.line(t: t, ev: "error", [("message", .s(message))])
    }

    static func subscribedLine(targets: [Any], t: Int = JSONOut.nowMs()) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: targets, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("[]".utf8)
        return JSONOut.line(t: t, ev: "subscribed", [("targets", .raw(String(decoding: data, as: UTF8.self)))])
    }

    private static func int(_ value: Any?) -> J {
        (value as? NSNumber).map { .i($0.intValue) } ?? .null
    }

    private static func string(_ value: Any?) -> J {
        (value as? String).map { .s($0) } ?? .null
    }

    /// The output line for one `view.*` notification; nil for anything else. Frames are SUMMARISED — the image
    /// bytes are decoded to measure them and never printed or stored.
    static func eventLine(method: String, params: [String: Any], t: Int = JSONOut.nowMs()) -> String? {
        switch method {
        case "view.bound":
            return JSONOut.line(t: t, ev: "bound", [("targetId", string(params["targetId"])), ("pid", int(params["pid"])),
                                                    ("windowId", int(params["windowId"])), ("appName", string(params["appName"]))])
        case "view.released":
            return JSONOut.line(t: t, ev: "released", [("targetId", string(params["targetId"]))])
        case "view.cursor":
            return JSONOut.line(t: t, ev: "cursor", [("targetId", string(params["targetId"])), ("kind", string(params["kind"]))])
        case "view.frame":
            let jpeg = (params["jpeg"] as? String).flatMap { Data(base64Encoded: $0) }
            var fields: [(String, J)] = [("targetId", string(params["targetId"])), ("seq", int(params["seq"])),
                                         ("width", int(params["width"])), ("height", int(params["height"])),
                                         ("bytes", .i(jpeg?.count ?? 0))]
            if let jpeg, let stats = Luma.stats(jpeg: jpeg) {
                fields += [("meanLuma", .d((stats.mean * 10).rounded() / 10)),
                           ("stddevLuma", .d((stats.stddev * 100).rounded() / 100)),
                           ("blank", .b(stats.blank))]
            } else {
                // A frame we cannot decode is no picture: report it as blank, and say why.
                fields += [("meanLuma", .null), ("stddevLuma", .null), ("blank", .b(true)), ("decodeFailed", .b(true))]
            }
            return JSONOut.line(t: t, ev: "frame", fields)
        default:
            return nil
        }
    }
}
