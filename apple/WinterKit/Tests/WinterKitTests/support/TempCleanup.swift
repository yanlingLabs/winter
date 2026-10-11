import XCTest

extension XCTestCase {
    /// Remove `url` (a directory or a file) when the test ends, pass or fail.
    ///
    /// The per-user temp folder grew to ~878,000 entries because tests made `winter-…-<uuid>` directories
    /// there and never removed them. A directory chmod'ed read-only by a test is made writable again first,
    /// so `removeItem` cannot be defeated by the fixture that locked it.
    func removeAtTeardown(_ url: URL) {
        addTeardownBlock {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
            try? FileManager.default.removeItem(at: url)
        }
    }
}
