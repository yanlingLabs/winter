import AppKit
import SwiftUI

// The Winter island's Shelf tab (`docs/claude/island.md`): the files dropped on the island, as thumbnails floating on the
// island's black (a QuickLook thumbnail; the workspace icon until one arrives) — no tile behind them. Each says its name
// in one quiet line; under the pointer the thumbnail lifts, the whole name shows, white, and copy and remove appear.
// Drag a file out — to a session's composer or any app — as a file URL; double-click opens it with its default app; ✕
// (or the menu) takes it off the shelf without touching the file; the copy button, the menu or ⌘C (a click on a file
// lets the island take the keyboard for it) put its file URL on the pasteboard. A file that is gone says "Missing", with
// its remove action.

struct IslandShelfTab: View {
    @ObservedObject var shelf: IslandShelfStore
    @ObservedObject var thumbnails: IslandShelfThumbnails
    /// The offscreen gallery draws flat (no scroll view).
    var scrolls = true

    static let columns = 5

    /// A file's thumbnail, its side.
    static let thumbnail: CGFloat = 48

    /// The selected file's mark: a short line under its name.
    static let selectionLine = CGSize(width: 22, height: 3)

    /// PURE: whether a file shows the selection's line — selected and present (a missing file says "Missing" there).
    static func showsSelectionLine(selected: Bool, missing: Bool) -> Bool { selected && !missing }

    /// PURE: how many lines a file's name takes — one at rest (it is the thumbnail's caption), the whole of it (two)
    /// under the pointer.
    static func nameLines(hovered: Bool) -> Int { hovered ? 2 : 1 }

    /// PURE: whether a file's copy and remove show — under the pointer; a missing file always offers its remove.
    static func showsActions(hovered: Bool, missing: Bool) -> Bool { hovered || missing }

    var body: some View {
        if shelf.items.isEmpty {
            IslandEmptyTab(symbol: shelf.dropTargeted ? "tray.and.arrow.down.fill" : "tray",
                           line: shelf.dropTargeted ? "Drop to keep it here" : "Drop files here",
                           detail: "Drag a file or a screenshot onto the island. Winter keeps only where it is — never a copy.")
                .background(dropOutline)
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
        } else {
            // The grid scrolls inside the island's fixed size, like every tab.
            IslandTabScroll(scrolls: scrolls) { grid }
        }
    }

    private var dropOutline: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(Color.white.opacity(shelf.dropTargeted ? 0.5 : 0.14), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
    }

    private var grid: some View {
        let items = shelf.items
        return VStack(spacing: 4) {
            ForEach(Array(stride(from: 0, to: items.count, by: Self.columns)), id: \.self) { start in
                HStack(alignment: .top, spacing: 4) {
                    ForEach(start..<min(start + Self.columns, items.count), id: \.self) { i in
                        IslandShelfTile(item: items[i], shelf: shelf, thumbnails: thumbnails)
                    }
                    ForEach(0..<max(0, Self.columns - (items.count - start)), id: \.self) { _ in
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
                    }
                }
            }
        }
        .padding(.horizontal, IslandQuietRow.inset - 6)
        .padding(.top, 2)
        .padding(.bottom, 14)
        .overlay(dropOutline.padding(.horizontal, 8).padding(.bottom, 8).opacity(shelf.dropTargeted ? 1 : 0))
    }
}

struct IslandShelfTile: View {
    let item: IslandShelfItem
    @ObservedObject var shelf: IslandShelfStore
    @ObservedObject var thumbnails: IslandShelfThumbnails

    var body: some View {
        let url = shelf.url(of: item.id)
        let selected = shelf.selectedId == item.id
        // No tile behind a file — its thumbnail floats. Under the pointer the thumbnail lifts from its bottom edge, the
        // name shows whole and white, and copy and remove appear; the selected file (what ⌘C copies) is marked by a short
        // white line under its name.
        HoverLiftReader(id: "shelf:\(item.id)") { hovered in
            VStack(spacing: 5) {
                ZStack {
                    if let url {
                        Image(nsImage: thumbnails.image(for: url))
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: IslandShelfTab.thumbnail, height: IslandShelfTab.thumbnail)
                            .onAppear { thumbnails.request(url) }
                    } else {
                        Image(systemName: "questionmark.folder")
                            .font(Typography.heading(.light))
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: IslandShelfTab.thumbnail, height: IslandShelfTab.thumbnail)
                    }
                }
                .hoverLiftLabel(hovered, anchor: .bottom)
                .overlay(alignment: .topTrailing) {
                    if IslandShelfTab.showsActions(hovered: hovered, missing: url == nil) {
                        HStack(spacing: 4) {
                            if url != nil {
                                IslandShelfMiniButton(symbol: "doc.on.doc", label: "Copy \(item.name)") { shelf.copy(item.id) }
                            }
                            IslandShelfMiniButton(symbol: "xmark", label: "Remove \(item.name) from the shelf") { shelf.remove(item.id) }
                        }
                        .offset(x: 14, y: -6)
                        .transition(.opacity)
                    }
                }
                Text(item.name)
                    .font(Typography.tiny(.medium))
                    .foregroundStyle(url == nil ? Theme.textMuted : (hovered ? Color.white : (selected ? Color.white.opacity(0.85) : Theme.textMuted)))
                    .lineLimit(IslandShelfTab.nameLines(hovered: hovered))
                    .truncationMode(.middle)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                // The mark's slot is there whether shown or not — "Missing" for a file that is gone, else the selection's
                // line.
                ZStack {
                    Capsule().fill(Color.white.opacity(0.75))
                        .frame(width: IslandShelfTab.selectionLine.width, height: IslandShelfTab.selectionLine.height)
                        .opacity(IslandShelfTab.showsSelectionLine(selected: selected, missing: url == nil) ? 1 : 0)
                        .accessibilityHidden(true)
                    Text("Missing").font(Typography.tiny(.semibold)).foregroundStyle(pillReviewAmber)
                        .opacity(url == nil ? 1 : 0)
                        .accessibilityHidden(url != nil)
                }
                .frame(height: 12)
            }
            .padding(.top, 8)
            .padding(.bottom, 4)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity)
        }
        .contentShape(Rectangle())
        .gesture(TapGesture(count: 2).onEnded { shelf.open(item.id) }
            .exclusively(before: TapGesture().onEnded { shelf.select(item.id) }))
        .onDrag {
            guard let url else { return NSItemProvider() }
            let provider = NSItemProvider(object: url as NSURL)
            provider.suggestedName = url.lastPathComponent
            return provider
        }
        .contextMenu {
            if url != nil {
                Button("Open") { shelf.open(item.id) }
                Button("Copy") { shelf.copy(item.id) }
                Button("Show in Finder") { if let url { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
                Divider()
            }
            Button("Remove from Shelf") { shelf.remove(item.id) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(url == nil ? "\(item.name), missing" : item.name)
        .accessibilityHint("Double-click to open, drag to use it elsewhere")
    }
}

/// A file's small round action (copy, remove).
struct IslandShelfMiniButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(Typography.micro(.bold))
                .foregroundStyle(Color.black)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color.white))
                .pillHoverGlow(Color.white)
        }
        .buttonStyle(IslandPressStyle())
        .accessibilityLabel(label)
    }
}
