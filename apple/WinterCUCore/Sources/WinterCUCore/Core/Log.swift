import os

/// The helper's unified-log channels (`log stream --predicate 'subsystem == "com.winter.computeruse"' --info`).
enum CULog {
    /// How binds reach a window: reuse, on this desktop, (0) where it is, (a) moved, (b) a new window — and
    /// remote-token probe misses.
    static let bind = Logger(subsystem: "com.winter.computeruse", category: "bind")
}
