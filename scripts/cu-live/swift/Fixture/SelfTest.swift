import AppKit
import Foundation

// `--self-test`: checks the pure logic in Core.swift. No NSApplication, no windows, nothing on screen.

private struct Checker {
    var passed = 0
    var failures: [String] = []

    mutating func check(_ condition: Bool, _ name: String) {
        if condition { passed += 1 } else { failures.append(name) }
    }

    mutating func equal<T: Equatable>(_ actual: T, _ expected: T, _ name: String) {
        if actual == expected {
            passed += 1
        } else {
            failures.append("\(name): expected \(expected), got \(actual)")
        }
    }
}

private func parseObject(_ line: String) -> [String: Any]? {
    guard let data = line.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
}

func runFixtureSelfTest() -> Int32 {
    var c = Checker()

    // --- JSON line encoding ---------------------------------------------------------------------------------
    c.equal(JSONText.quote("plain"), "\"plain\"", "quote plain")
    c.equal(JSONText.quote("a\"b\\c"), "\"a\\\"b\\\\c\"", "quote quote+backslash")
    c.equal(JSONText.quote("l1\nl2\r\t"), "\"l1\\nl2\\r\\t\"", "quote newline/cr/tab")
    c.equal(JSONText.quote("\u{01}\u{1F}"), "\"\\u0001\\u001f\"", "quote control chars")
    c.equal(JSONText.quote("caf\u{E9} \u{1F600}"), "\"caf\u{E9} \u{1F600}\"", "non-ASCII passes through")
    c.equal(JSONText.quote("\u{2028}\u{2029}"), "\"\\u2028\\u2029\"", "line separators escaped")
    c.equal(JSONText.number(12), "12", "integral double prints as int")
    c.equal(JSONText.number(12.5), "12.5", "half prints with fraction")
    c.equal(JSONText.number(-0.5), "-0.5", "negative half")
    c.equal(JSONText.number(.nan), "null", "NaN -> null")
    c.equal(JSONText.number(.infinity), "null", "infinity -> null")
    c.equal(JSONText.number(-0.0), "0", "negative zero")

    let line = LogLine.make(tMs: 1_760_000_000_123, role: "main", ev: "web.input",
                            fields: [("id", .str("first")), ("value", .str("he said \"hi\"\nbye")), ("n", .int(3)),
                                     ("x", .num(10.5)), ("ok", .bool(true)), ("none", .null),
                                     ("list", .arr([.int(1), .int(2)])), ("sel", .arr([.int(0), .int(5)]))])
    c.check(!line.contains("\n"), "log line has no raw newline")
    c.check(line.hasPrefix("{\"t\":1760000000123,\"role\":\"main\",\"ev\":\"web.input\""), "log line leads with t, role, ev")
    if let parsed = parseObject(line) {
        c.equal((parsed["t"] as? NSNumber)?.int64Value, 1_760_000_000_123, "t round-trips as a number")
        c.equal(parsed["value"] as? String, "he said \"hi\"\nbye", "string value round-trips")
        c.equal((parsed["x"] as? NSNumber)?.doubleValue, 10.5, "double round-trips")
        c.check(parsed["none"] is NSNull, "null round-trips")
        c.equal((parsed["sel"] as? [Int]) ?? [], [0, 5], "array round-trips")
    } else {
        c.check(false, "log line is valid JSON")
    }

    // JV.from(any:) — what dump uses to embed the page's state and what seq echo uses.
    c.equal(JSONText.encode(JV.from(any: "7")), "\"7\"", "string seq stays a string")
    c.equal(JSONText.encode(JV.from(any: NSNumber(value: 7))), "7", "number seq stays a number")
    c.equal(JSONText.encode(JV.from(any: NSNumber(value: true))), "true", "bool stays a bool")
    c.equal(JSONText.encode(JV.from(any: NSNumber(value: 2.5))), "2.5", "double stays a double")
    c.equal(JSONText.encode(JV.from(any: nil)), "null", "nil -> null")
    c.equal(JSONText.encode(JV.from(any: ["b": 1, "a": "x"] as [String: Any])), "{\"a\":\"x\",\"b\":1}", "object keys sorted")

    // --- the log file: append, one line per write, two writers -----------------------------------------------
    let tempPath = NSTemporaryDirectory() + "cu-fixture-selftest-\(getpid()).jsonl"
    try? FileManager.default.removeItem(atPath: tempPath)
    if let first = FixtureLog(path: tempPath, role: "main"), let second = FixtureLog(path: tempPath, role: "user") {
        first.event("launched", [("pid", .int(1)), ("role", .str("main"))])
        second.event("user.key", [("chars", .str("a"))])
        first.event("cmd.ack", [("cmd", .str("ping")), ("seq", .str("1"))])
        let text = (try? String(contentsOfFile: tempPath, encoding: .utf8)) ?? ""
        let lines = text.split(separator: "\n").map(String.init)
        c.equal(lines.count, 3, "log file has one line per event")
        c.check(lines.allSatisfy { parseObject($0) != nil }, "every log line parses")
        c.equal(parseObject(lines.count > 1 ? lines[1] : "")?["role"] as? String, "user", "second writer appends with its own role")
    } else {
        c.check(false, "log file opens")
    }
    try? FileManager.default.removeItem(atPath: tempPath)
    c.check(FixtureLog(path: "/nonexistent-dir-cu-fixture/x.jsonl", role: "main") == nil, "unwritable log path fails")

    // --- command decoding ------------------------------------------------------------------------------------
    func decode(object: Any? = "run1", info: [AnyHashable: Any]?, role: String = "main", run: String = "run1") -> CommandDecision {
        CommandDecoder.decode(object: object, userInfo: info, role: role, run: run)
    }
    func runCommand(_ decision: CommandDecision) -> FixtureCommand? {
        if case .run(let command) = decision { return command }
        return nil
    }
    func isIgnore(_ decision: CommandDecision) -> Bool {
        if case .ignore = decision { return true }
        return false
    }
    func rejection(_ decision: CommandDecision) -> (cmd: String, message: String)? {
        if case .reject(let cmd, _, let message) = decision { return (cmd, message) }
        return nil
    }

    let ping = runCommand(decode(info: ["role": "main", "cmd": "ping", "seq": "41"]))
    c.equal(ping?.name, "ping", "valid command decodes")
    c.equal(JSONText.encode(ping?.seq ?? .null), "\"41\"", "String seq echoed as a string")
    c.check((ping?.args.isEmpty) ?? false, "absent args = {}")
    c.equal(JSONText.encode(runCommand(decode(info: ["role": "main", "cmd": "ping", "seq": NSNumber(value: 9)]))?.seq ?? .null), "9", "NSNumber seq echoed as a number")
    c.equal(JSONText.encode(runCommand(decode(info: ["role": "main", "cmd": "ping"]))?.seq ?? .int(-1)), "null", "absent seq echoes null")
    c.check(isIgnore(decode(object: "other-run", info: ["role": "main", "cmd": "ping"])), "other run id ignored")
    c.check(isIgnore(decode(object: nil, info: ["role": "main", "cmd": "ping"])), "no run id ignored when ours is non-empty")
    c.check(isIgnore(decode(info: ["role": "user", "cmd": "ping"])), "other role ignored")
    c.check(isIgnore(decode(info: ["cmd": "ping"])), "missing role ignored")
    c.check(isIgnore(decode(info: nil)), "no userInfo ignored")
    c.check(runCommand(decode(object: nil, info: ["role": "main", "cmd": "ping"], run: "")) != nil, "empty run id matches a nil object")
    let steal = runCommand(decode(info: ["role": "main", "cmd": "steal", "args": "{\"mode\":\"focus\"}"]))
    c.equal(steal?.args["mode"] as? String, "focus", "args JSON parsed")
    c.equal(rejection(decode(info: ["role": "main", "cmd": "steal", "args": "{nope"]))?.message, "args is not valid JSON", "bad args JSON rejected")
    c.equal(rejection(decode(info: ["role": "main", "cmd": "steal", "args": "[1,2]"]))?.message, "args must be a JSON object", "array args rejected")
    c.check(runCommand(decode(info: ["role": "main", "cmd": "ping", "args": "   "])) != nil, "blank args = {}")
    c.equal(rejection(decode(info: ["role": "main", "cmd": "frobnicate"]))?.cmd, "frobnicate", "unknown command rejected with its name")
    c.check(rejection(decode(info: ["role": "main"])) != nil, "missing cmd rejected")
    c.check(rejection(decode(info: ["role": "main", "cmd": "activate"])) != nil, "activate is not a main command")
    c.check(runCommand(decode(info: ["role": "user", "cmd": "activate"], role: "user")) != nil, "activate is a user command")
    c.check(rejection(decode(info: ["role": "user", "cmd": "steal"], role: "user")) != nil, "steal is not a user command")
    c.check(CommandDecoder.supported(role: "main").isSuperset(of: ["ping", "steal", "reset", "dump", "fullscreen", "exitFullscreen", "openSample", "quit", "animate", "offspace", "restoreSpace"]), "main command set")
    c.check(!CommandDecoder.supported(role: "user").contains("offspace"), "offspace is not a user command")
    c.check(runCommand(decode(info: ["role": "main", "cmd": "offspace", "seq": "3"])) != nil, "offspace decodes")
    c.check(runCommand(decode(info: ["role": "main", "cmd": "restoreSpace"])) != nil, "restoreSpace decodes")
    c.equal(CommandDecoder.supported(role: "user"), ["ping", "activate", "reset", "dump", "quit"], "user command set")

    for raw in ["off", "focus", "mousedown", "delayed"] {
        if case .success(let mode) = CommandDecoder.stealMode(["mode": raw]) { c.equal(mode.rawValue, raw, "steal mode \(raw)") } else { c.check(false, "steal mode \(raw)") }
    }
    if case .success = CommandDecoder.stealMode(["mode": "loud"]) { c.check(false, "bad steal mode rejected") } else { c.check(true, "bad steal mode rejected") }
    if case .success = CommandDecoder.stealMode([:]) { c.check(false, "missing steal mode rejected") } else { c.check(true, "missing steal mode rejected") }
    if case .success(let on) = CommandDecoder.animateOn(["on": true as NSNumber]) { c.check(on, "animate on") } else { c.check(false, "animate on") }
    if case .success(let on) = CommandDecoder.animateOn(["on": false as NSNumber]) { c.check(!on, "animate off") } else { c.check(false, "animate off") }
    if case .success = CommandDecoder.animateOn(["on": NSNumber(value: 1)]) { c.check(false, "animate on:1 rejected") } else { c.check(true, "animate on:1 rejected") }
    if case .success = CommandDecoder.animateOn([:]) { c.check(false, "animate without on rejected") } else { c.check(true, "animate without on rejected") }
    // The args really arrive as JSON text: true must survive JSONSerialization as a boolean.
    let animate = runCommand(decode(info: ["role": "main", "cmd": "animate", "args": "{\"on\":true}"]))
    if let animate, case .success(let on) = CommandDecoder.animateOn(animate.args) { c.check(on, "animate {on:true} text -> true") } else { c.check(false, "animate {on:true} text -> true") }

    // --- steal state machine ---------------------------------------------------------------------------------
    let table: [(StealMode, StealTrigger, StealAction)] = [
        (.off, .fieldFocus, .none), (.off, .mouseDown, .none), (.off, .documentOpen, .none),
        (.focus, .fieldFocus, .now("steal-focus")), (.focus, .mouseDown, .none), (.focus, .documentOpen, .now("doc-open")),
        (.mousedown, .fieldFocus, .none), (.mousedown, .mouseDown, .now("steal-mousedown")), (.mousedown, .documentOpen, .now("doc-open")),
        (.delayed, .fieldFocus, .after(1.0, "steal-delayed")), (.delayed, .mouseDown, .after(1.0, "steal-delayed")), (.delayed, .documentOpen, .now("doc-open")),
    ]
    for (mode, trigger, expected) in table {
        c.equal(StealPolicy.action(mode: mode, trigger: trigger), expected, "steal \(mode.rawValue) x \(trigger)")
    }
    c.equal(StealPolicy.delay, 1.0, "delayed steal waits 1 s")

    // --- menu rules ------------------------------------------------------------------------------------------
    c.check(!MenuRules.uppercaseEnabled(selectionLength: 0), "Uppercase Selection disabled with an empty selection")
    c.check(MenuRules.uppercaseEnabled(selectionLength: 1), "Uppercase Selection enabled with a selection")
    let up = MenuRules.uppercase(text: "hello world", range: NSRange(location: 6, length: 5))
    c.equal(up?.replacement, "WORLD", "uppercase replacement")
    c.equal(up?.selection, NSRange(location: 6, length: 5), "uppercase keeps the selection")
    c.equal(MenuRules.uppercase(text: "stra\u{DF}e", range: NSRange(location: 0, length: 6))?.selection, NSRange(location: 0, length: 7), "uppercase selection follows a longer result")
    c.check(MenuRules.uppercase(text: "abc", range: NSRange(location: 0, length: 0)) == nil, "no uppercase for an empty selection")
    c.check(MenuRules.uppercase(text: "abc", range: NSRange(location: 2, length: 5)) == nil, "no uppercase for an out-of-range selection")
    c.equal(MenuRules.stamp, "[stamp]", "stamp literal")

    // --- vocabularies and geometry ---------------------------------------------------------------------------
    c.equal(Mods.names([.command, .shift]), ["shift", "command"], "mods in fixed order")
    c.equal(Mods.names([]), [], "no mods")
    c.equal(Mods.names([.option, .control, .function, .numericPad]), ["control", "option", "function", "numericPad"], "arrow-key style mods")
    c.equal(MouseButton.name(for: .leftMouseDown), "left", "left button")
    c.equal(MouseButton.name(for: .rightMouseDown), "right", "right button")
    c.equal(MouseButton.name(for: .otherMouseDown), "other", "other button")
    c.equal(Rounding.half(10.74), 10.5, "round to half down")
    c.equal(Rounding.half(10.76), 11.0, "round to half up")
    c.equal(Rounding.half(-3.3), -3.5, "round negative to half")
    c.equal(DocTitle.make(path: "/tmp/x/sample.wcufix"), "Document: sample.wcufix", "document title")

    let visible = CGRect(x: 0, y: 25, width: 1512, height: 920)
    let slot0 = WindowGrid.topLeft(slot: 0, visible: visible)
    let slot1 = WindowGrid.topLeft(slot: 1, visible: visible)
    let slot2 = WindowGrid.topLeft(slot: 2, visible: visible)
    c.equal(slot0, CGPoint(x: 12, y: 937), "grid slot 0")
    c.check(slot1.x >= slot0.x + WindowGrid.contentSize.width, "grid columns do not overlap")
    c.check(slot2.y <= slot0.y - WindowGrid.contentSize.height, "grid rows do not overlap")
    c.equal(WindowGrid.topLeft(slot: 0, visible: visible), slot0, "grid is deterministic")
    c.check(WindowGrid.topLeft(slot: 5, visible: visible) != WindowGrid.topLeft(slot: 4, visible: visible), "cascade slots differ")

    // --- scroll throttle -------------------------------------------------------------------------------------
    var throttle = ScrollThrottle(minInterval: 0.25)
    c.equal(throttle.offer(10, now: 0.0), .emit(10), "first scroll emits at once")
    c.equal(throttle.offer(20, now: 0.05), .flushAt(0.25), "second scroll waits for the interval")
    c.equal(throttle.offer(30, now: 0.10), .absorbed, "scroll during the wait is absorbed")
    c.equal(throttle.flush(now: 0.25), 30, "the last position of a burst goes out")
    c.equal(throttle.flush(now: 0.26), nil, "nothing left to flush")
    c.equal(throttle.offer(40, now: 0.30), .flushAt(0.5), "a scroll right after a flush is held again")
    c.equal(throttle.offer(50, now: 2.0), .absorbed, "a held scroll stays held until flushed")
    c.equal(throttle.flush(now: 2.0), 50, "late flush sends the newest")
    c.equal(throttle.offer(60, now: 2.5), .emit(60), "quiet period re-arms the leading edge")
    // <= 4 per second over a 60 Hz burst
    var burst = ScrollThrottle(minInterval: 0.25)
    var emitted = 0
    var nextFlush: Double?
    var t = 0.0
    while t < 1.0 {
        if let due = nextFlush, t >= due { if burst.flush(now: t) != nil { emitted += 1 }; nextFlush = nil }
        switch burst.offer(t * 100, now: t) {
        case .emit: emitted += 1
        case .flushAt(let due): nextFlush = due
        case .absorbed: break
        }
        t += 1.0 / 60.0
    }
    c.check(emitted <= 5, "a 1 s burst emits at most ~4 scrolls (got \(emitted))")

    // --- animation -------------------------------------------------------------------------------------------
    let width = 640.0
    c.equal(Animation.squareX(elapsed: 0, width: width), 0, "animation starts at the left edge")
    var inBounds = true
    var moved = false
    var previous = Animation.squareX(elapsed: 0, width: width)
    for step in 1...400 {
        let x = Animation.squareX(elapsed: Double(step) / Animation.framesPerSecond, width: width)
        if x < 0 || x > width - Animation.squareSize { inBounds = false }
        if x != previous { moved = true }
        previous = x
    }
    c.check(inBounds, "animation stays inside the canvas")
    c.check(moved, "animation moves")
    c.check(abs(Animation.squareX(elapsed: (width - Animation.squareSize) / Animation.speed, width: width) - (width - Animation.squareSize)) < 0.001, "animation reaches the right edge")
    c.check(Animation.squareX(elapsed: -3, width: width) >= 0, "animation tolerates negative elapsed")
    c.check(Animation.squareX(elapsed: 5, width: 10) >= 0, "animation tolerates a tiny canvas")

    // --- scroller route --------------------------------------------------------------------------------------
    c.equal(ScrollerMath.value(offset: 0, contentHeight: 1000, viewportHeight: 150), 0, "scroller at the top is 0")
    c.equal(ScrollerMath.value(offset: 850, contentHeight: 1000, viewportHeight: 150), 1, "scroller at the bottom is 1")
    c.equal(ScrollerMath.value(offset: 425, contentHeight: 1000, viewportHeight: 150), 0.5, "scroller halfway is 0.5")
    c.equal(ScrollerMath.value(offset: 50, contentHeight: 100, viewportHeight: 150), 0, "everything fits -> 0")
    c.equal(ScrollerMath.value(offset: 900, contentHeight: 1000, viewportHeight: 150), 1, "overscroll clamps to 1")
    c.equal(ScrollerMath.value(offset: -20, contentHeight: 1000, viewportHeight: 150), 0, "rubber-band clamps to 0")
    c.equal(ScrollerMath.rounded(0.123456), 0.123, "scroller value rounds to 0.001")
    c.equal(ScrollerMath.rounded(0.9996), 1.0, "scroller value rounds up to 1")

    var wheel = WheelWindow()
    c.check(!wheel.isWheel(now: 10), "no wheel yet: a scroll is not by wheel")
    wheel.begin()
    c.check(wheel.isWheel(now: 10.5), "while a wheel event is handled, a scroll is by wheel")
    wheel.end(now: 11)
    c.check(wheel.isWheel(now: 11.0), "right after the wheel it is still by wheel")
    c.check(wheel.isWheel(now: 11.29), "just under 300 ms after the wheel it is still by wheel")
    c.check(!wheel.isWheel(now: 11.31), "past 300 ms after the wheel it is not")
    wheel.begin(); wheel.end(now: 20)
    c.check(wheel.isWheel(now: 20.1) && !wheel.isWheel(now: 20.5), "a new wheel event restarts the window")

    var report = ScrollerReport()
    report.rebase(0)
    c.check(!report.changed(0), "an unmoved position is not reported")
    c.check(report.changed(0.25), "a moved position is reported")
    c.check(!report.changed(0.25), "the same position twice is reported once")
    report.rebase(0.5)
    c.check(!report.changed(0.5), "a re-based position is not reported")
    c.check(report.changed(0.6), "movement after a re-base is reported")

    var scrollerThrottle = Throttle<ScrollerSample>(minInterval: 0.1)
    c.equal(scrollerThrottle.offer(ScrollerSample(value: 0.1, byWheel: true), now: 0), .emit(ScrollerSample(value: 0.1, byWheel: true)), "scroller: first change emits at once")
    c.equal(scrollerThrottle.offer(ScrollerSample(value: 0.2, byWheel: true), now: 0.03), .flushAt(0.1), "scroller: the next waits for the interval")
    c.equal(scrollerThrottle.offer(ScrollerSample(value: 0.3, byWheel: false), now: 0.06), .absorbed, "scroller: a burst is absorbed")
    c.equal(scrollerThrottle.flush(now: 0.1), ScrollerSample(value: 0.3, byWheel: false), "scroller: the burst's final sample (with its own byWheel) goes out")
    var scrollerBurst = Throttle<ScrollerSample>(minInterval: 0.1)
    var scrollerLines = 0
    var scrollerDue: Double?
    var clock = 0.0
    while clock < 1.0 {
        if let due = scrollerDue, clock >= due { if scrollerBurst.flush(now: clock) != nil { scrollerLines += 1 }; scrollerDue = nil }
        switch scrollerBurst.offer(ScrollerSample(value: clock, byWheel: true), now: clock) {
        case .emit: scrollerLines += 1
        case .flushAt(let due): scrollerDue = due
        case .absorbed: break
        }
        clock += 1.0 / 120
    }
    c.check(scrollerLines <= 11, "scroller: a 1 s burst logs at most ~10 lines (got \(scrollerLines))")

    // --- sentinel ----------------------------------------------------------------------------------------------
    c.equal(Sentinel.rect, CGRect(x: 8, y: 8, width: 48, height: 48), "sentinel is 48x48 inset 8 from the top-left")
    c.check(Sentinel.red == 255 && Sentinel.green == 0 && Sentinel.blue == 255, "sentinel colour is #FF00FF")

    /// Renders what a view's `draw` produces into a 640x390 sRGB bitmap (top-left origin, as on screen) and
    /// measures the magenta in it. Headless: a bitmap context, no window, no NSApplication.
    func magenta(width: Int, height: Int, draw: () -> Void) -> (exact: Int, rule: Int, minX: Int, minY: Int, maxX: Int, maxY: Int)? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = context.data else { return nil }
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        draw()
        NSGraphicsContext.restoreGraphicsState()
        let pixels = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
        var exact = 0, rule = 0, minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width {
                let r = pixels[(y * width + x) * 4], g = pixels[(y * width + x) * 4 + 1], b = pixels[(y * width + x) * 4 + 2]
                if r == 255 && g == 0 && b == 255 { exact += 1 }
                if r >= 200 && g <= 70 && b >= 200 {
                    rule += 1
                    minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y)
                }
            }
        }
        return (exact, rule, minX, minY, maxX, maxY)
    }
    MainActor.assumeIsolated {
        let size = WindowGrid.contentSize
        let width = Int(size.width), height = Int(size.height)
        // The canvas, with its animation running (the moving square must not touch the sentinel) and its title text.
        let canvas = CanvasView(frame: NSRect(origin: .zero, size: size))
        canvas.setAnimating(true)
        let canvasResult = magenta(width: width, height: height) { canvas.draw(canvas.bounds) }
        canvas.setAnimating(false)
        c.equal(canvasResult?.exact, 2304, "canvas: exactly 48x48 pixels of #FF00FF")
        c.equal(canvasResult?.rule, 2304, "canvas: nothing else in the canvas passes the magenta rule")
        c.check(canvasResult?.minX == 8 && canvasResult?.minY == 8 && canvasResult?.maxX == 55 && canvasResult?.maxY == 55, "canvas: the sentinel is at the top-left, inset 8")
        // The view used by Form and Offspace, drawn at its position in a window-sized bitmap.
        let sentinelView = SentinelView(frame: Sentinel.rect)
        let viewResult = magenta(width: width, height: height) {
            let context = NSGraphicsContext.current!.cgContext
            context.saveGState()
            context.translateBy(x: sentinelView.frame.minX, y: sentinelView.frame.minY)
            sentinelView.draw(sentinelView.bounds)
            context.restoreGState()
        }
        c.equal(viewResult?.exact, 2304, "SentinelView: exactly 48x48 pixels of #FF00FF")
        c.check(viewResult?.minX == 8 && viewResult?.minY == 8 && viewResult?.maxX == 55 && viewResult?.maxY == 55, "SentinelView: lands at the top-left, inset 8")
        c.check(sentinelView.isOpaque && sentinelView.hitTest(NSPoint(x: 10, y: 10)) == nil && !sentinelView.isAccessibilityElement(), "SentinelView is opaque, takes no events, is not an accessibility element")
        // The rainbow behind Offspace's sentinel must never pass the magenta rule on its own.
        let rainbow = RainbowView(frame: NSRect(origin: .zero, size: size))
        let rainbowResult = magenta(width: width, height: height) { rainbow.draw(rainbow.bounds) }
        c.equal(rainbowResult?.rule, 0, "Offspace background has no pixel that passes the magenta rule")
    }

    // --- Spaces (pure planning on the real SLSCopyManagedDisplaySpaces shape) ------------------------------------
    func space(_ id: Int, _ type: Int) -> [String: Any] { ["id64": NSNumber(value: id), "ManagedSpaceID": NSNumber(value: id), "type": NSNumber(value: type), "uuid": "u\(id)"] }
    let rawDisplays: [[String: Any]] = [[
        "Display Identifier": "D1",
        "Current Space": space(2926, 4),
        "Spaces": [space(1853, 0), space(2926, 4), space(2994, 4), space(2498, 0), space(2688, 0)],
    ]]
    let displays = SpacePlanner.parse(rawDisplays)
    c.equal(displays.count, 1, "one display parsed")
    c.equal(displays.first?.identifier, "D1", "display identifier parsed")
    c.equal(displays.first?.current, 2926, "current Space parsed")
    c.equal(displays.first?.spaces.map(\.id) ?? [], [1853, 2926, 2994, 2498, 2688], "Spaces parsed in order")
    c.equal(displays.first?.spaces.map(\.type) ?? [], [0, 4, 4, 0, 0], "Space types parsed")
    c.equal(SpacePlanner.otherDesktop(displays: displays, windowSpaces: [2926], active: 2926), 1853, "picks the first desktop that is not showing")
    c.equal(SpacePlanner.otherDesktop(displays: displays, windowSpaces: [1853], active: 1853), 2498, "never picks the Space the window is on")
    c.equal(SpacePlanner.otherDesktop(displays: SpacePlanner.parse([["Display Identifier": "D", "Current Space": space(5, 0), "Spaces": [space(5, 0), space(6, 4)]]]), windowSpaces: [5], active: 5), nil, "no other desktop -> nil (full-screen Spaces do not count)")
    c.equal(SpacePlanner.otherDesktop(displays: [], windowSpaces: [1], active: 1), nil, "no displays -> nil")
    let twoDisplays = SpacePlanner.parse([
        ["Display Identifier": "A", "Current Space": space(10, 0), "Spaces": [space(10, 0), space(11, 0)]],
        ["Display Identifier": "B", "Current Space": space(20, 0), "Spaces": [space(20, 0), space(21, 0)]],
    ])
    c.equal(SpacePlanner.otherDesktop(displays: twoDisplays, windowSpaces: [20], active: 10), 21, "stays on the window's own display")
    c.equal(SpacePlanner.visibleSpaces(twoDisplays, active: 10), [10, 20], "every display's current Space is visible")
    c.check(SpacePlanner.isOffScreen(windowSpaces: [1853], visible: [2926], mustBeOn: 1853), "on a hidden Space = off screen")
    c.check(!SpacePlanner.isOffScreen(windowSpaces: [1853, 2926], visible: [2926]), "also on the active Space = still on screen")
    c.check(!SpacePlanner.isOffScreen(windowSpaces: [], visible: [2926]), "on no Space at all is not success")
    c.check(!SpacePlanner.isOffScreen(windowSpaces: [1853], visible: [2926], mustBeOn: 2498), "not on the Space it was sent to")
    c.equal(OffspaceMethod.managedSpace.rawValue, "managed-space", "method name managed-space")
    c.equal(OffspaceMethod.createdSpace.rawValue, "created-space", "method name created-space")
    c.equal(OffspaceMethod.fullscreen.rawValue, "fullscreen", "method name fullscreen")
    c.check(SpacePlanner.spaceID(NSNumber(value: 0)) == nil && SpacePlanner.spaceID("x") == nil, "bad Space ids are rejected")

    // --- self-activation -------------------------------------------------------------------------------------
    c.check(ActivationOutcome.took(isActive: true, frontPid: 42, ownPid: 42), "took: active and frontmost")
    c.check(!ActivationOutcome.took(isActive: true, frontPid: 7, ownPid: 42), "did not take: another app is frontmost")
    c.check(!ActivationOutcome.took(isActive: false, frontPid: 42, ownPid: 42), "did not take: the app reports inactive")
    c.check(!ActivationOutcome.took(isActive: true, frontPid: nil, ownPid: 42), "did not take: no frontmost app known")

    // --- the completion window's model (`--done`; nothing is shown) ------------------------------------------
    let utc = TimeZone(identifier: "UTC")!
    let passed = DoneModel.parse(#"{"status":"pass","passed":42,"failed":0,"skipped":14,"durationMs":372400,"finishedAt":1791552423000,"path":"/tmp/r.json"}"#)
    c.check(passed != nil, "done: a well-formed model parses")
    if let m = passed {
        c.equal(m.glyph, "✓", "done: pass → ✓")
        c.equal(m.tone, .green, "done: pass → green")
        c.equal(m.subtitle, "Everything passed.", "done: pass subtitle")
        c.equal(m.countsLine, "42 passed · 0 failed · 14 skipped", "done: counts line")
        c.equal(m.durationText, "6 min 12 s", "done: duration")
        c.equal(m.finishedText(timeZone: utc), "13:27:03", "done: finish time (UTC)")
        c.equal(m.timingLine(timeZone: utc), "Took 6 min 12 s · finished at 13:27:03", "done: timing line")
        c.equal(m.path, "/tmp/r.json", "done: report path")
    }
    let failed = DoneModel(status: .fail, passed: 42, failed: 13, skipped: 14, durationMs: 59_400, finishedAt: 0, path: "")
    c.equal(failed.glyph, "!", "done: fail → !")
    c.equal(failed.tone, .amber, "done: fail → amber")
    c.equal(failed.subtitle, "13 tests failed.", "done: fail subtitle")
    c.equal(failed.durationText, "59 s", "done: seconds only")
    c.equal(DoneModel(status: .fail, passed: 1, failed: 1, skipped: 0, durationMs: 120_000, finishedAt: 0, path: "").subtitle, "1 test failed.", "done: one failure")
    c.equal(DoneModel(status: .fail, passed: 1, failed: 1, skipped: 0, durationMs: 120_000, finishedAt: 0, path: "").durationText, "2 min", "done: whole minutes")
    let aborted = DoneModel(status: .aborted, passed: 3, failed: 1, skipped: 0, durationMs: 1, finishedAt: 0, path: "")
    c.equal(aborted.glyph, "✕", "done: aborted → ✕")
    c.equal(aborted.tone, .red, "done: aborted → red")
    c.equal(DoneModel.title, "Winter computer-use live test finished", "done: title")
    c.check(DoneModel.lifetime == 1800, "done: 30 minutes at most")
    c.check(DoneModel.parse(#"{"status":"maybe","passed":1,"failed":0,"skipped":0,"durationMs":1,"finishedAt":1,"path":""}"#) == nil, "done: unknown status refused")
    c.check(DoneModel.parse(#"{"status":"pass","passed":-1,"failed":0,"skipped":0,"durationMs":1,"finishedAt":1,"path":""}"#) == nil, "done: negative count refused")
    c.check(DoneModel.parse("not json") == nil, "done: malformed refused")

    // --- the run's banners (`--banner`; nothing is shown) ------------------------------------------------------
    let countdown = BannerModel.parse(#"{"kind":"countdown","seconds":30,"watchPid":4242}"#)
    c.check(countdown != nil, "banner: a countdown parses")
    if let m = countdown {
        c.equal(m.text(remaining: 30), "Winter's computer-use test will take over the screen in 30 s — move the mouse or press a key to postpone", "banner: countdown text")
        c.equal(m.text(remaining: -2), "Winter's computer-use test will take over the screen in 0 s — move the mouse or press a key to postpone", "banner: never below 0 s")
        c.equal(m.watchPid, 4242, "banner: watches the runner")
    }
    let running = BannerModel.parse(#"{"kind":"running","watchPid":7}"#)
    c.equal(running?.text(remaining: 0), "Winter test running — don't touch the Mac (stops on any input)", "banner: running text")
    c.check(BannerModel.parse(#"{"kind":"countdown","seconds":0,"watchPid":7}"#) == nil, "banner: a countdown needs seconds")
    c.check(BannerModel.parse(#"{"kind":"running"}"#) == nil, "banner: a runner pid is required")
    c.check(BannerModel.parse(#"{"kind":"toast","watchPid":7}"#) == nil, "banner: unknown kind refused")

    // --- the Docs-like page's messages → `docs.<type>` log fields ----------------------------------------------
    c.check(DocsEvent.isName("paste") && DocsEvent.isName("panel"), "docs: plain names pass")
    c.check(!DocsEvent.isName("") && !DocsEvent.isName("a.b") && !DocsEvent.isName("x y") && !DocsEvent.isName(String(repeating: "a", count: 25)), "docs: odd names refused")
    let fields = DocsEvent.fields(["type": "paste", "length": 3000, "text": "abc"])
    c.equal(fields.map { $0.0 }, ["length", "text"], "docs: every field but type, sorted")
    c.check(CommandDecoder.supported(role: "main").contains("docsOpenFind"), "docs: the panel command")

    if c.failures.isEmpty {
        print("SELFTEST OK \(c.passed) checks")
        return 0
    }
    for failure in c.failures { print("SELFTEST FAIL \(failure)") }
    print("SELFTEST FAILED \(c.failures.count) of \(c.passed + c.failures.count) checks")
    return 1
}
