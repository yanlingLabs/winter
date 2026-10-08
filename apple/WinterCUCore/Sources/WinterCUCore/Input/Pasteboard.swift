import AppKit
import ApplicationServices
import Foundation

/// The user's clipboard as `paste` sees it: saved, replaced, verified, then restored (spec §8, §13.3).
protocol CUPasteboardIO: AnyObject {
    var changeCount: Int { get }
    /// Every item with the types it already carries (see `CUSystemPasteboard.save`).
    func save() -> [[String: Data]]
    /// Replaces the contents; returns the new change count.
    func write(_ items: [[String: Data]]) -> Int
    func readString() -> String?
}

/// Markers clipboard managers honour (nspasteboard.org): Winter's own contents are short-lived and may be
/// sensitive, so they are never recorded or shown in a clipboard history.
enum CUPasteboardMarkers {
    static let transient = "org.nspasteboard.TransientType"
    static let concealed = "org.nspasteboard.ConcealedType"

    static func marked(_ items: [[String: Data]]) -> [[String: Data]] {
        items.map { item in
            var i = item
            i[transient] = Data()
            i[concealed] = Data()
            return i
        }
    }
}

final class CUSystemPasteboard: CUPasteboardIO {
    /// A saved type larger than this is left out of the restore (and logged), rather than held in memory.
    static let maxSavedTypeBytes = 16 * 1024 * 1024

    private let pb: NSPasteboard
    init(_ pb: NSPasteboard = .general) { self.pb = pb }

    var changeCount: Int { pb.changeCount }

    /// Saves what the clipboard already holds, through the Pasteboard Manager so each type's flags can be
    /// read first: a *promised* type (one the source app would render on demand — often a large image) is
    /// skipped instead of forcing that app to render it. Huge types are skipped too.
    func save() -> [[String: Data]] {
        var ref: Pasteboard?
        guard PasteboardCreate(kPasteboardClipboard as CFString, &ref) == noErr, let carbon = ref else { return [] }
        PasteboardSynchronize(carbon)
        var count = 0
        guard PasteboardGetItemCount(carbon, &count) == noErr, count > 0 else { return [] }
        var out: [[String: Data]] = []
        var skipped: [String] = []
        for index in 1...count {
            var itemID: PasteboardItemID?
            guard PasteboardGetItemIdentifier(carbon, index, &itemID) == noErr, let item = itemID else { continue }
            var flavors: CFArray?
            guard PasteboardCopyItemFlavors(carbon, item, &flavors) == noErr, let types = flavors as? [String] else { continue }
            var saved: [String: Data] = [:]
            for type in types {
                var flags = PasteboardFlavorFlags()
                guard PasteboardGetItemFlavorFlags(carbon, item, type as CFString, &flags) == noErr else { continue }
                if Self.isPromised(flags) { skipped.append("\(type) (promised)"); continue }
                var data: CFData?
                guard PasteboardCopyItemFlavorData(carbon, item, type as CFString, &data) == noErr, let d = data as Data? else {
                    continue
                }
                if d.count > Self.maxSavedTypeBytes { skipped.append("\(type) (\(d.count) bytes)"); continue }
                saved[type] = d
            }
            if !saved.isEmpty { out.append(saved) }
        }
        if !skipped.isEmpty {
            NSLog("WinterCUCore: clipboard save skipped %d type(s) it would have had to render or that were too large: %@",
                  skipped.count, skipped.joined(separator: ", "))
        }
        return out
    }

    /// `kPasteboardFlavorPromised` (1 << 9, HIServices/Pasteboard.h).
    static func isPromised(_ flags: PasteboardFlavorFlags) -> Bool { flags.rawValue & (1 << 9) != 0 }

    func write(_ items: [[String: Data]]) -> Int {
        pb.clearContents()
        let objects: [NSPasteboardItem] = items.map { dict in
            let item = NSPasteboardItem()
            for (t, d) in dict { item.setData(d, forType: NSPasteboard.PasteboardType(t)) }
            return item
        }
        if !objects.isEmpty { pb.writeObjects(objects) }
        return pb.changeCount
    }

    func readString() -> String? { pb.string(forType: .string) }
}

/// The clipboard dance around one paste, with the key press and the evidence wait injected so the ordering
/// is testable: save → write (marked transient) → verify → paste → wait for evidence → restore (only if
/// nobody else wrote meanwhile).
struct CUPasteSequence {
    let pasteboard: CUPasteboardIO
    /// Sends the paste to the target.
    let sendPaste: () throws -> Void
    /// Waits until the target has visibly taken the paste (its value changed, or it went quiet after a
    /// value-change notification), at most ~1.5 s. Returns whether evidence was seen.
    let waitForEvidence: () -> Bool
    /// The user's clipboard as an earlier paste saved it, while that paste's restore is still pending: reused,
    /// so Winter's own text on the clipboard is never saved as the user's.
    var pendingSaved: [[String: Data]]? = nil
    /// Set when the paste can't be confirmed (a web or canvas editor with no readable value or selection): the
    /// sequence returns right after the paste and hands `(saved, ours)` here to restore once the target has
    /// had time to read the clipboard.
    var deferRestore: (([[String: Data]], Int) -> Void)? = nil

    enum Outcome: Equatable {
        /// The user's clipboard is back. `evidence`: the paste was observed before restoring.
        case restored(evidence: Bool)
        case leftAlone
        /// Not confirmable: the restore is scheduled.
        case deferred
    }

    func run(items: [[String: Data]], plain: String) throws -> Outcome {
        let saved = pendingSaved ?? pasteboard.save()
        let ours = pasteboard.write(CUPasteboardMarkers.marked(items))
        // Verify the write took before pasting, so a stale clipboard is never pasted into the target.
        guard pasteboard.changeCount == ours, pasteboard.readString() == plain else {
            _ = pasteboard.write(saved)
            throw CUError.unsupported("could not place the text on the clipboard")
        }
        do {
            try sendPaste()
        } catch {
            _ = pasteboard.write(saved)
            throw error
        }
        if let deferRestore {
            deferRestore(saved, ours)
            return .deferred
        }
        let evidence = waitForEvidence()
        // If the user (or the target) copied something meanwhile, theirs wins.
        guard pasteboard.changeCount == ours else { return .leftAlone }
        _ = pasteboard.write(saved)
        return .restored(evidence: evidence)
    }

    /// Pasteboard items for `text` in the requested format. Markdown and HTML also carry a plain string, so
    /// apps without rich paste still get text.
    static func items(text: String, format: CUPasteFormat) -> [[String: Data]] {
        let plainType = NSPasteboard.PasteboardType.string.rawValue
        switch format {
        case .text:
            return [[plainType: Data(text.utf8)]]
        case .html:
            return [[NSPasteboard.PasteboardType.html.rawValue: Data(text.utf8),
                     plainType: Data(plainFromHTML(text).utf8)]]
        case .markdown:
            var item: [String: Data] = [plainType: Data(text.utf8), "net.daringfireball.markdown": Data(text.utf8)]
            if let rtf = rtfFromMarkdown(text) { item[NSPasteboard.PasteboardType.rtf.rawValue] = rtf }
            return [item]
        }
    }

    /// The plain string `items` carries for `format` (what the verify step reads back).
    static func plain(text: String, format: CUPasteFormat) -> String {
        format == .html ? plainFromHTML(text) : text
    }

    static func plainFromHTML(_ html: String) -> String {
        var s = html.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "</(p|div|li|h[1-6]|tr)>", with: "\n", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (e, c) in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", " ")] {
            s = s.replacingOccurrences(of: e, with: c)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Inline Markdown rendered to RTF, so rich-text targets (Notes, Mail, TextEdit) get bold/italic/links.
    static func rtfFromMarkdown(_ md: String) -> Data? {
        guard let attributed = try? AttributedString(
            markdown: md, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else { return nil }
        let ns = NSAttributedString(attributed)
        return try? ns.data(from: NSRange(location: 0, length: ns.length),
                            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
    }
}

/// Polls for evidence that an edit landed (spec I6/I9): the element's value differs from `before`, or a
/// value-change notification from the pid arrived after `since`. Pure apart from the injected readers.
struct CUEditEvidence {
    var readValue: () -> String?
    var lastValueChangeMs: () -> Double?
    var nowMs: () -> Double
    var sleepMs: (Double) -> Void

    /// The selected range, as text, when the element has one (a paste moves the caret).
    var readSelection: () -> String? = { nil }

    /// Waits up to `capMs`. A notification counts once the app has been quiet on it for `quietMs`.
    func wait(before: String?, selectionBefore: String? = nil, since: Double, capMs: Double, pollMs: Double = 25,
              quietMs: Double = 60) -> Bool {
        let start = nowMs()
        while true {
            if let v = readValue(), v != before { return true }
            if let s = readSelection(), let b = selectionBefore, s != b { return true }
            if let n = lastValueChangeMs(), n > since, nowMs() - n >= quietMs { return true }
            if nowMs() - start >= capMs { return false }
            sleepMs(pollMs)
        }
    }
}
