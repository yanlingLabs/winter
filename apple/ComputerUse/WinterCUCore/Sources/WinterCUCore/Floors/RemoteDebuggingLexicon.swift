import Foundation

/// A Chromium resource pack (`<lang>.lproj/locale.pak`): the browser's own string table, in the open data-pack
/// format of Chromium's resource tooling (versions 4 and 5). Read-only and bounded: the entry table is binary-searched
/// and only the strings asked for are decoded. Pure over `Data`; a malformed pack reads as none.
struct CUResourcePack {
    private let data: Data
    /// 0 binary, 1 UTF-8, 2 UTF-16 (little-endian).
    let encoding: UInt8
    let entryCount: Int
    private let entriesOffset: Int
    private let aliasCount: Int
    private let aliasesOffset: Int

    init?(_ data: Data) {
        guard data.count >= 9 else { return nil }
        let d = data
        switch d.le32(0) {
        case 4:
            // uint32 version, uint32 entry count, uint8 encoding; then (uint16 id, uint32 offset) × (count + 1).
            guard let n = d.le32(4) else { return nil }
            entryCount = Int(n)
            encoding = d.byte(8) ?? 0xFF
            entriesOffset = 9
            aliasCount = 0
        case 5:
            // uint32 version, uint8 encoding + 3 bytes of padding, uint16 entry count, uint16 alias count; the entries;
            // then (uint16 id, uint16 entry index) × alias count.
            guard d.count >= 12, let n = d.le16(8), let a = d.le16(10) else { return nil }
            encoding = d.byte(4) ?? 0xFF
            entryCount = Int(n)
            aliasCount = Int(a)
            entriesOffset = 12
        default:
            return nil
        }
        guard encoding <= 2 else { return nil }
        aliasesOffset = entriesOffset + (entryCount + 1) * 6
        guard aliasesOffset + aliasCount * 4 <= d.count else { return nil }
        self.data = d
    }

    private func entryId(_ i: Int) -> UInt16? { data.le16(entriesOffset + i * 6) }
    private func entryOffset(_ i: Int) -> Int? { data.le32(entriesOffset + i * 6 + 2).map(Int.init) }

    /// The entry index of `id` (entries are sorted by id), following an alias.
    private func index(of id: UInt16) -> Int? {
        var lo = 0, hi = entryCount - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            guard let m = entryId(mid) else { return nil }
            if m == id { return mid }
            if m < id { lo = mid + 1 } else { hi = mid - 1 }
        }
        lo = 0; hi = aliasCount - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            guard let m = data.le16(aliasesOffset + mid * 4), let target = data.le16(aliasesOffset + mid * 4 + 2) else { return nil }
            if m == id { return Int(target) < entryCount ? Int(target) : nil }
            if m < id { lo = mid + 1 } else { hi = mid - 1 }
        }
        return nil
    }

    private func bytes(at i: Int) -> Data? {
        guard i >= 0, i < entryCount, let start = entryOffset(i), let end = entryOffset(i + 1),
              start <= end, end <= data.count else { return nil }
        return data.subdata(in: (data.startIndex + start)..<(data.startIndex + end))
    }

    private func decode(_ b: Data) -> String? {
        // A compressed entry (gzip, or the tooling's brotli header) is no string here.
        if b.count >= 2, (b[b.startIndex] == 0x1F && b[b.startIndex + 1] == 0x8B) || (b[b.startIndex] == 0x1E && b[b.startIndex + 1] == 0x9B) {
            return nil
        }
        switch encoding {
        case 2: return String(data: b, encoding: .utf16LittleEndian)
        default: return String(data: b, encoding: .utf8)
        }
    }

    /// The string resource `id`, or nil (absent, compressed, not text).
    func string(_ id: UInt16) -> String? {
        index(of: id).flatMap(bytes(at:)).flatMap(decode)
    }

    /// Every entry's id, in order (aliases are other ids for the same text: never needed to find an anchor).
    var ids: [UInt16] { (0..<entryCount).compactMap(entryId) }
}

private extension Data {
    func byte(_ o: Int) -> UInt8? { o >= 0 && o < count ? self[startIndex + o] : nil }
    func le16(_ o: Int) -> UInt16? {
        guard let a = byte(o), let b = byte(o + 1) else { return nil }
        return UInt16(a) | UInt16(b) << 8
    }
    func le32(_ o: Int) -> UInt32? {
        guard let a = le16(o), let b = le16(o + 2) else { return nil }
        return UInt32(a) | UInt32(b) << 16
    }
}

/// Floor F's words for the "Allow remote debugging?" dialog in EVERY language a Chromium browser ships: found by the
/// browser's own ENGLISH strings (the resources whose English text is the dialog's title or its first sentence), then
/// read in each of its locale packs under the same resource ids — so the dialog is recognized in whatever language the
/// browser shows it, with no word list of our own to keep up to date, and a new version's renumbered ids are found
/// again. Pure once built.
struct CURemoteDebuggingLexicon: Equatable {
    /// The dialog's phrases, normalized (`normalize`), in every language read.
    let phrases: Set<String>
    /// How many locale packs were read (English included).
    let languages: Int
    /// The base language codes (`fr`, `pt`, `zh`, …: a folder's name before `_`, `-` or `.lproj`, lowercased) whose
    /// pack gave at least one phrase — English included. A browser showing a language outside it has no words here.
    var languageCodes: Set<String> = []

    /// A locale folder's or a preferred language's base code: `pt_BR.lproj` → `pt`, `zh-Hans-CN` → `zh`. Pure.
    static func baseLanguage(_ s: String) -> String {
        var name = s.lowercased()
        if name.hasSuffix(".lproj") { name.removeLast(6) }
        return String(name.split(whereSeparator: { $0 == "_" || $0 == "-" }).first ?? Substring(name))
    }

    /// Whether the browser's words cover `language` (its shown language, a preferred-languages entry). Pure.
    func covers(_ language: String) -> Bool { languageCodes.contains(Self.baseLanguage(language)) }

    /// The English resources the lexicon is anchored on: the dialog's title ("Allow remote debugging?"), and its body
    /// ("An external app wants full control over this … session to debug it …"). Pure.
    static func isAnchor(_ english: String) -> Bool {
        let s = normalize(english)
        if s.count <= 60, s.contains("allow remote debugging") { return true }
        return s.contains("wants full control") && s.contains("debug")
    }

    /// Lowercased, every kind of space one space, runs collapsed, and the punctuation and symbols at either end
    /// trimmed (`¿…?`, `…？`, `…؟`, a no-break space before `?` in French). Pure.
    static func normalize(_ s: String) -> String {
        var out = ""
        var space = false
        for u in s.lowercased().unicodeScalars {
            if u.properties.isWhitespace || u.value == 0x00A0 || u.value == 0x202F || u.value == 0x2007 {
                space = true
                continue
            }
            if space, !out.isEmpty { out.append(" ") }
            space = false
            out.unicodeScalars.append(u)
        }
        let trim = CharacterSet.punctuationCharacters.union(.symbols).union(.whitespacesAndNewlines)
        return out.trimmingCharacters(in: trim)
    }

    /// The shortest phrase kept: a word or two in any script, never a lone letter that would match anything.
    static let minPhraseLength = 4

    /// Builds the lexicon from the English pack and the others (any order; English may be among them). Nil when the
    /// English pack names no anchor (the browser's wording changed, or it is no Chromium pack). Pure.
    static func build(english: CUResourcePack, others: [CUResourcePack]) -> CURemoteDebuggingLexicon? {
        build(english: english, named: others.enumerated().map { ("pack\($0.offset)", $0.element) })
    }

    /// `build`, with each other pack's folder name (`fr.lproj`), so the lexicon knows which languages gave words.
    static func build(english: CUResourcePack, named others: [(name: String, pack: CUResourcePack)]) -> CURemoteDebuggingLexicon? {
        let anchors = english.ids.filter { id in english.string(id).map(isAnchor) ?? false }
        guard !anchors.isEmpty else { return nil }
        var phrases = Set<String>()
        func add(_ raw: String?) -> Bool {
            guard let raw else { return false }
            // A placeholder (`$1`) splits a phrase the dialog fills in: its parts are not reliable alone.
            guard raw.range(of: #"\$\d"#, options: .regularExpression) == nil else { return false }
            let p = normalize(raw)
            guard p.count >= minPhraseLength else { return false }
            phrases.insert(p)
            return true
        }
        var codes: Set<String> = ["en"]
        for id in anchors { _ = add(english.string(id)) }
        for (name, pack) in others {
            var gave = false
            for id in anchors where add(pack.string(id)) { gave = true }
            if gave { codes.insert(baseLanguage(name)) }
        }
        return CURemoteDebuggingLexicon(phrases: phrases, languages: 1 + others.count, languageCodes: codes)
    }

    /// Whether `text` (a title, a label, a value) holds one of the dialog's phrases. Pure.
    func matches(_ text: String?) -> Bool {
        guard let text, !text.isEmpty else { return false }
        let s = Self.normalize(text)
        guard s.count >= Self.minPhraseLength else { return false }
        return phrases.contains { s.contains($0) }
    }
}

/// What Floor F can read a browser's dialog with.
enum CURemoteDebuggingWords: Equatable {
    /// The browser's own words for the dialog, in every language it ships (and the English rule beside them).
    case lexicon(CURemoteDebuggingLexicon)
    /// No lexicon could be read, and the browser shows English: the English rule alone.
    case englishOnly
    /// No lexicon could be read, and the browser shows another language: a dialog Winter cannot tell from the
    /// remote-debugging one is treated as it (fail closed).
    case unreadable
}

/// Reads (and keeps) the lexicon of an installed browser from its bundle. Thread-safe.
enum CURemoteDebuggingLexiconStore {
    private static let lock = NSLock()
    /// Per set of resource folders (a version's folder names its version: an update is a new key).
    private static var cache: [String: CURemoteDebuggingLexicon?] = [:]

    static let englishFolders = ["en.lproj", "en-US.lproj", "en_US.lproj", "en-GB.lproj", "en_GB.lproj"]

    /// Every folder of the app that holds an English locale pack: each version of each framework (`Versions/<v>/
    /// Resources` — a pending update keeps two), and the app's own `Contents/Resources`. Sorted, de-duplicated by path.
    static func resourceFolders(appBundle: URL, fileManager fm: FileManager = .default) -> [URL] {
        var out: [URL] = []
        func consider(_ dir: URL) {
            if englishFolders.contains(where: { fm.fileExists(atPath: dir.appendingPathComponent($0).appendingPathComponent("locale.pak").path) }) {
                out.append(dir)
            }
        }
        consider(appBundle.appendingPathComponent("Contents/Resources"))
        let frameworks = appBundle.appendingPathComponent("Contents/Frameworks")
        for fw in (try? fm.contentsOfDirectory(atPath: frameworks.path)) ?? [] where fw.hasSuffix(".framework") {
            let versions = frameworks.appendingPathComponent(fw).appendingPathComponent("Versions")
            for v in (try? fm.contentsOfDirectory(atPath: versions.path)) ?? [] where v != "Current" {
                consider(versions.appendingPathComponent(v).appendingPathComponent("Resources"))
            }
        }
        return Array(Set(out.map { $0.standardizedFileURL.path })).sorted().map { URL(fileURLWithPath: $0) }
    }

    /// The lexicon of the browser at `appBundle`: the union of its resource folders' lexicons (a version that still
    /// runs and the update waiting beside it). Nil when no folder yields one. Packs are mapped, not read: only the
    /// entry table and the few strings asked for are touched.
    static func lexicon(appBundle: URL) -> CURemoteDebuggingLexicon? {
        let folders = resourceFolders(appBundle: appBundle)
        guard !folders.isEmpty else { return nil }
        let key = folders.map(\.path).joined(separator: "\n")
        lock.lock()
        if let hit = cache[key] { lock.unlock(); return hit }
        lock.unlock()
        var phrases = Set<String>()
        var languages = 0
        var codes = Set<String>()
        for folder in folders {
            guard let l = lexicon(resources: folder) else { continue }
            phrases.formUnion(l.phrases)
            codes.formUnion(l.languageCodes)
            languages = max(languages, l.languages)
        }
        let built = phrases.isEmpty ? nil : CURemoteDebuggingLexicon(phrases: phrases, languages: languages, languageCodes: codes)
        lock.lock()
        cache[key] = .some(built)
        lock.unlock()
        CULog.act.notice("Floor F: \(built == nil ? "no remote-debugging lexicon" : "remote-debugging lexicon of \(languages) languages, \(phrases.count) phrases", privacy: .public) for \(appBundle.lastPathComponent, privacy: .public)")
        return built
    }

    /// One resource folder's lexicon. Nil when its English pack is missing, unreadable or names no anchor.
    static func lexicon(resources: URL, fileManager fm: FileManager = .default) -> CURemoteDebuggingLexicon? {
        func pack(_ url: URL) -> CUResourcePack? {
            (try? Data(contentsOf: url, options: .alwaysMapped)).flatMap(CUResourcePack.init)
        }
        guard let englishFolder = englishFolders.first(where: {
            fm.fileExists(atPath: resources.appendingPathComponent($0).appendingPathComponent("locale.pak").path)
        }), let english = pack(resources.appendingPathComponent(englishFolder).appendingPathComponent("locale.pak")) else { return nil }
        let others = ((try? fm.contentsOfDirectory(atPath: resources.path)) ?? [])
            .filter { $0.hasSuffix(".lproj") && $0 != englishFolder }
            .sorted()
            .compactMap { name in pack(resources.appendingPathComponent(name).appendingPathComponent("locale.pak")).map { (name, $0) } }
        return CURemoteDebuggingLexicon.build(english: english, named: others)
    }

    /// Whether the browser shows English: the first of its preferred languages (its own `AppleLanguages`, else the
    /// user's) is English. A browser whose language can't be read counts as NOT English (fail closed).
    static func showsEnglish(bundleId: String?) -> Bool {
        shownLanguage(bundleId: bundleId).map { CURemoteDebuggingLexicon.baseLanguage($0) == "en" } ?? false
    }

    /// The language the browser shows: the first of its preferred languages (its own `AppleLanguages`, else the
    /// user's). Nil when none can be read.
    static func shownLanguage(bundleId: String?) -> String? {
        let own = bundleId.flatMap { CFPreferencesCopyAppValue("AppleLanguages" as CFString, $0 as CFString) as? [String] }
        return (own ?? Locale.preferredLanguages).first
    }

    /// What Floor F reads a browser's dialogs with, from its lexicon (if any) and the language it shows: the lexicon
    /// only when that language gave it words (English always does) — a language the packs had no phrase for, or one
    /// that can't be read, is `.unreadable` (fail closed); with no lexicon, English reads by the English rule. Pure.
    static func words(lexicon: CURemoteDebuggingLexicon?, shownLanguage: String?) -> CURemoteDebuggingWords {
        guard let shownLanguage else { return .unreadable }
        let english = CURemoteDebuggingLexicon.baseLanguage(shownLanguage) == "en"
        if let lexicon { return english || lexicon.covers(shownLanguage) ? .lexicon(lexicon) : .unreadable }
        return english ? .englishOnly : .unreadable
    }

    private static var warming = Set<String>()

    /// Reads the lexicon of the browser at `appBundle` in the background, once per bundle path (a later `lexicon`
    /// call finds it cached).
    static func warm(appBundle: URL) {
        lock.lock()
        let first = warming.insert(appBundle.path).inserted
        lock.unlock()
        guard first else { return }
        DispatchQueue.global(qos: .utility).async { _ = lexicon(appBundle: appBundle) }
    }

    /// Forgets every lexicon (tests).
    static func reset() {
        lock.lock()
        cache.removeAll()
        warming.removeAll()
        lock.unlock()
    }
}
