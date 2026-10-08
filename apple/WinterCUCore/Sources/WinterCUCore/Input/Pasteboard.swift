import AppKit
import Foundation

/// The user's clipboard as `paste` sees it: saved, replaced, verified, then restored (spec §8, §13.3).
protocol CUPasteboardIO: AnyObject {
    var changeCount: Int { get }
    /// Every item with every type it carries.
    func save() -> [[String: Data]]
    /// Replaces the contents; returns the new change count.
    func write(_ items: [[String: Data]]) -> Int
    func readString() -> String?
}

final class CUSystemPasteboard: CUPasteboardIO {
    private let pb: NSPasteboard
    init(_ pb: NSPasteboard = .general) { self.pb = pb }

    var changeCount: Int { pb.changeCount }

    func save() -> [[String: Data]] {
        (pb.pasteboardItems ?? []).map { item in
            var out: [String: Data] = [:]
            for t in item.types { if let d = item.data(forType: t) { out[t.rawValue] = d } }
            return out
        }
    }

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

/// The clipboard dance around one paste, with the key press and the waits injected so the ordering is
/// testable: save → write → verify → paste → wait → restore (only if nobody else wrote meanwhile).
struct CUPasteSequence {
    let pasteboard: CUPasteboardIO
    /// Sends cmd+v to the target.
    let sendPaste: () throws -> Void
    let sleep: (Double) -> Void
    /// How long the target gets to read the clipboard before it is restored.
    var readWindowMs: Double = 250

    enum Outcome: Equatable { case restored, leftAlone }

    func run(items: [[String: Data]], plain: String) throws -> Outcome {
        let saved = pasteboard.save()
        let ours = pasteboard.write(items)
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
        sleep(readWindowMs)
        // If the user (or the target) copied something meanwhile, theirs wins.
        guard pasteboard.changeCount == ours else { return .leftAlone }
        _ = pasteboard.write(saved)
        return .restored
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
