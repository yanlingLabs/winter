import AppKit
import SwiftUI

// The Winter island's Shelf tab (`docs/claude/island.md`): the files dropped on the island, as tiles with a QuickLook
// thumbnail (the workspace icon until one arrives). Drag a tile out — to a session's composer or any app — as a file
// URL; double-click opens it with its default app; ✕ (or the menu) takes it off the shelf without touching the file;
// the copy button, the menu or ⌘C (a click on a tile lets the island take the keyboard for it) put its file URL on the
// pasteboard. A file that is gone shows as missing, with its remove action.

struct IslandShelfTab: View {
    @ObservedObject var shelf: IslandShelfStore
    @ObservedObject var thumbnails: IslandShelfThumbnails
    /// The offscreen gallery draws flat (no scroll view).
    var scrolls = true

    static let columns = 4

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
        return VStack(spacing: IslandLayout.rowGap) {
            ForEach(Array(stride(from: 0, to: items.count, by: Self.columns)), id: \.self) { start in
                HStack(spacing: IslandLayout.rowGap) {
                    ForEach(start..<min(start + Self.columns, items.count), id: \.self) { i in
                        IslandShelfTile(item: items[i], shelf: shelf, thumbnails: thumbnails)
                    }
                    ForEach(0..<max(0, Self.columns - (items.count - start)), id: \.self) { _ in
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
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
        IslandHoverSurface { hovered in
            VStack(spacing: 6) {
                ZStack {
                    if let url {
                        Image(nsImage: thumbnails.image(for: url))
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 52, height: 52)
                            .onAppear { thumbnails.request(url) }
                    } else {
                        Image(systemName: "questionmark.folder")
                            .font(Typography.heading(.light))
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: 52, height: 52)
                    }
                }
                Text(item.name)
                    .font(Typography.caption(.medium))
                    .foregroundStyle(url == nil ? Theme.textMuted : Color.white)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .multilineTextAlignment(.center)
                    .frame(height: 28, alignment: .top)
                // The same height for every tile: the "Missing" line has its slot whether shown or not.
                Text("Missing").font(Typography.tiny(.semibold)).foregroundStyle(pillReviewAmber)
                    .opacity(url == nil ? 1 : 0)
                    .accessibilityHidden(url != nil)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity)
            .overlay(alignment: .topTrailing) {
                if hovered || url == nil {
                    HStack(spacing: 4) {
                        if url != nil {
                            IslandShelfMiniButton(symbol: "doc.on.doc", label: "Copy \(item.name)") { shelf.copy(item.id) }
                        }
                        IslandShelfMiniButton(symbol: "xmark", label: "Remove \(item.name) from the shelf") { shelf.remove(item.id) }
                    }
                    .padding(5)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: IslandLayout.rowCorner, style: .continuous)
                .strokeBorder(Color.white.opacity(selected ? 0.55 : 0), lineWidth: 1.5))
        }
        .contentShape(RoundedRectangle(cornerRadius: IslandLayout.rowCorner, style: .continuous))
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

/// A tile's small round action (copy, remove).
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
