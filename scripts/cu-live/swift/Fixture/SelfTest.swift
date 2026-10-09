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
    c.check(CommandDecoder.supported(role: "main").isSuperset(of: ["ping", "steal", "reset", "dump", "fullscreen", "exitFullscreen", "openSample", "quit", "animate"]), "main command set")
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

    if c.failures.isEmpty {
        print("SELFTEST OK \(c.passed) checks")
        return 0
    }
    for failure in c.failures { print("SELFTEST FAIL \(failure)") }
    print("SELFTEST FAILED \(c.failures.count) of \(c.passed + c.failures.count) checks")
    return 1
}
