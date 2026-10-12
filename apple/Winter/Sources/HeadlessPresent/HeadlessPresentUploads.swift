import Darwin
import Foundation
import UniformTypeIdentifiers

/// ComputerV2 Phase 4 (lane H3) — **files the person chooses for a headless page.**
///
/// Winter Headless reads a chosen file ONLY from `<home>/cache/headless-uploads/` (its file reply accepts no other
/// path), and the page never reaches the person's disk. So when a page asks for files, Winter.app shows its own open
/// panel, COPIES each chosen file's contents into a fresh folder of its own there — `<uploadDir>/<16 random
/// hex>/<file name>` — and hands the helper the copies' paths:
///   * the source is opened with `O_NOFOLLOW` and must be a regular file (a link is never followed, a device or a
///     folder never read);
///   * each copy is a NEW file (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600) in a NEW folder (0700) created under a checked
///     `uploadDir`, written from the source's contents — never a hard link to it, never a rename of it;
///   * at most `maxTotalBytes` in all, judged on the open descriptors before anything is copied;
///   * a name keeps only its last component, with separators and control characters replaced.
enum HeadlessPresentUploads {

    /// The most a chooser's copies may weigh, together.
    static let maxTotalBytes: Int64 = 200 * 1024 * 1024

    enum Failure: Error, Equatable {
        /// `uploadDir` is not Winter's own uploads folder (or is a link, or not a folder).
        case notTheUploadsFolder
        /// Together over `maxTotalBytes`.
        case tooLarge(bytes: Int64)
        /// One of the files could not be read as a regular file (a link, a folder, gone, unreadable).
        case unreadable(name: String)
        /// The copy itself failed (disk full, the folder vanished).
        case copyFailed(name: String, errno: Int32)

        var message: String {
            switch self {
            case .notTheUploadsFolder: return "Winter can hand the page files only through its own uploads folder"
            case .tooLarge: return "Those files are too large to hand to the page (200 MB at most in all)"
            case .unreadable(let name): return "Winter couldn't read “\(name)” — choose a regular file"
            case .copyFailed(let name, _): return "Winter couldn't copy “\(name)” for the page"
            }
        }
    }

    // MARK: - The folder

    /// Is `uploadDir` Winter's uploads folder (or inside it)? Both are compared as standardized absolute paths —
    /// `..` and `.` removed — so a daemon that named a path outside it is refused before anything is written.
    static func isInside(_ uploadDir: String, root: String) -> Bool {
        guard uploadDir.hasPrefix("/"), root.hasPrefix("/") else { return false }
        let dir = URL(fileURLWithPath: uploadDir).standardizedFileURL.path
        let base = URL(fileURLWithPath: root).standardizedFileURL.path
        return dir == base || dir.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }

    // MARK: - Names

    /// A file name safe to create: its last path component, with `/`, `:`, NUL and control characters replaced, never
    /// `.` or `..` or empty, at most 255 UTF-8 bytes (the extension kept when it is cut).
    static func safeName(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
        var out = String(String.UnicodeScalarView(last.unicodeScalars.map { scalar -> Unicode.Scalar in
            if scalar == "/" || scalar == ":" || scalar.value < 0x20 || scalar.value == 0x7F
                || (0x80...0x9F).contains(scalar.value) || scalar.value == 0x2028 || scalar.value == 0x2029 {
                return "_"
            }
            return scalar
        }))
        out = out.trimmingCharacters(in: .whitespaces)
        if out.isEmpty || out == "." || out == ".." { out = "file" }
        if out.hasPrefix(".") { out = "_" + out.dropFirst() }
        guard out.utf8.count > 255 else { return out }
        let ext = (out as NSString).pathExtension
        let keep = ext.isEmpty || ext.utf8.count > 32 ? "" : "." + ext
        var stem = ext.isEmpty ? out : String(out.dropLast(keep.count))
        while stem.utf8.count + keep.utf8.count > 255 { stem.removeLast() }
        return stem + keep
    }

    /// 16 random hex digits (a fresh folder's name).
    static func randomHex() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        arc4random_buf(&bytes, bytes.count)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - The page's accepted types

    /// The page's `accept` list (".pdf", "image/*", "image/png") as content types the open panel can filter by:
    /// an extension by itself, `type/*` as that type's supertype, a MIME type by itself — anything else (unknown,
    /// malformed) is ignored. Empty: no filter.
    static func contentTypes(accept: [String]) -> [UTType] {
        var out: [UTType] = []
        for raw in accept {
            let item = raw.trimmingCharacters(in: .whitespaces).lowercased()
            guard !item.isEmpty else { continue }
            var type: UTType?
            if item.hasPrefix(".") {
                let ext = String(item.dropFirst())
                if !ext.isEmpty, !ext.contains("/") { type = UTType(filenameExtension: ext) }
            } else if item.hasSuffix("/*") {
                switch item {
                case "image/*": type = .image
                case "video/*": type = .movie
                case "audio/*": type = .audio
                case "text/*": type = .text
                case "application/*": type = .data
                default: type = nil
                }
            } else if item.contains("/") {
                type = UTType(mimeType: item)
            }
            // A type the system made up on the spot for an unknown extension still filters by that extension.
            if let type, !out.contains(type) { out.append(type) }
        }
        return out
    }

    // MARK: - The copy

    /// Copy `sources` into fresh folders under `uploadDir` (checked inside `root`); the copies' paths, in order.
    /// Blocking: call it off the main thread.
    static func copy(_ sources: [URL], into uploadDir: String, root: String,
                     maxTotalBytes: Int64 = maxTotalBytes) -> Result<[String], Failure> {
        guard isInside(uploadDir, root: root) else { return .failure(.notTheUploadsFolder) }
        let dir = URL(fileURLWithPath: uploadDir).standardizedFileURL.path
        // The folder: made when it is missing (0700), refused when it is a link or not a folder.
        if mkdir(dir, 0o700) != 0, errno != EEXIST {
            // A missing parent: create the chain (cache/ already exists in a real home).
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
        }
        var st = stat()
        guard lstat(dir, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR else { return .failure(.notTheUploadsFolder) }
        let dirFd = open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard dirFd >= 0 else { return .failure(.notTheUploadsFolder) }
        defer { close(dirFd) }

        // Every source opened and measured first: nothing is written unless all of them can be copied.
        var opened: [(fd: Int32, name: String, size: Int64)] = []
        defer { for o in opened { close(o.fd) } }
        var total: Int64 = 0
        for url in sources {
            let display = url.lastPathComponent
            let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { return .failure(.unreadable(name: display)) }
            var s = stat()
            guard fstat(fd, &s) == 0, (s.st_mode & S_IFMT) == S_IFREG else {
                close(fd)
                return .failure(.unreadable(name: display))
            }
            opened.append((fd, safeName(display), Int64(s.st_size)))
            total += Int64(s.st_size)
            if total > maxTotalBytes { return .failure(.tooLarge(bytes: total)) }
        }

        var paths: [String] = []
        for o in opened {
            let folder = randomHex()
            guard mkdirat(dirFd, folder, 0o700) == 0 else { return .failure(.copyFailed(name: o.name, errno: errno)) }
            let folderFd = openat(dirFd, folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard folderFd >= 0 else { return .failure(.copyFailed(name: o.name, errno: errno)) }
            defer { close(folderFd) }
            let out = openat(folderFd, o.name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard out >= 0 else { return .failure(.copyFailed(name: o.name, errno: errno)) }
            let copied = copyContents(from: o.fd, to: out, limit: o.size)
            let closeResult = close(out)
            guard copied, closeResult == 0 else {
                unlinkat(folderFd, o.name, 0)
                return .failure(.copyFailed(name: o.name, errno: errno))
            }
            paths.append(dir + "/" + folder + "/" + o.name)
        }
        return .success(paths)
    }

    /// The source's bytes into `out`, at most `limit` of them (a file that grew after it was measured is cut where
    /// it was measured — the cap holds).
    private static func copyContents(from source: Int32, to out: Int32, limit: Int64) -> Bool {
        // The source was opened non-blocking (a FIFO swapped in never hangs the open); reading a regular file
        // is unaffected, but clear it anyway.
        _ = fcntl(source, F_SETFL, fcntl(source, F_GETFL) & ~O_NONBLOCK)
        var remaining = limit
        let size = 1 << 20
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
        defer { buffer.deallocate() }
        while remaining > 0 {
            let n = read(source, buffer, Int(min(Int64(size), remaining)))
            if n < 0 { if errno == EINTR { continue }; return false }
            if n == 0 { break }
            var written = 0
            while written < n {
                let w = write(out, buffer + written, n - written)
                if w < 0 { if errno == EINTR { continue }; return false }
                written += w
            }
            remaining -= Int64(n)
        }
        return true
    }
}
