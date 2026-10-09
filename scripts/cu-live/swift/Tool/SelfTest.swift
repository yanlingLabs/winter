import Foundation

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

    if failures.isEmpty {
        print("SELFTEST OK")
        return 0
    }
    for failure in failures { print("SELFTEST FAIL \(failure)") }
    print("SELFTEST FAILED \(failures.count) of \(passed + failures.count) checks")
    return 1
}
