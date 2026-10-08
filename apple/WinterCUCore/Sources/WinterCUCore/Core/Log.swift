import os

/// The helper's unified-log channels, at `.notice` so `log show` keeps them
/// (`log show --predicate 'subsystem == "com.winter.computeruse"' --last 1h`). Only fixed wording, app names,
/// ids, routes and error codes are logged — never screen text or typed text.
enum CULog {
    /// How binds reach a window: reuse, on this desktop, (0) where it is, (a) moved, (b) a new window — and
    /// remote-token probe misses.
    static let bind = Logger(subsystem: "com.winter.computeruse", category: "bind")
    /// Which route each act took (AX, pid events, private path, foreground) and why one failed.
    static let act = Logger(subsystem: "com.winter.computeruse", category: "act")
}
