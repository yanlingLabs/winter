import AppKit
import Charts
import SwiftUI
import WinterCUPresentation
import WinterKit

/// The Usage window (`docs/claude/usage.md`): drawn entirely by Winter in the pill material, like a detached session
/// window (`PillChromeWindow`, its own traffic lights, drag band and resize grips). Opened from the island's Usage tab
/// ("Open usage") and the menu bar's "Usage…". The model refreshes only while it is open.
@MainActor
final class UsageWindowController: NSObject, NSWindowDelegate {
    let window: PillChromeWindow
    let model: UsageWindowModel
    var onClosed: (() -> Void)?

    static let defaultSize = NSSize(width: 920, height: 680)

    init(model: UsageWindowModel) {
        self.model = model
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = Self.defaultSize
        let frame = NSRect(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2,
                           width: min(size.width, visible.width - 40), height: min(size.height, visible.height - 40))
        window = PillChromeWindow(contentRect: frame)
        window.title = "Usage"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 640, height: 420)
        window.appearance = NSAppearance(named: .darkAqua)
        super.init()
        window.delegate = self
        let hosting = FirstClickHostingView(rootView: UsageWindowRootView(
            model: model,
            onClose: { [weak window] in window?.performClose(nil) },
            onMinimize: { [weak window] in window?.performMiniaturize(nil) },
            onZoom: { [weak window] in window?.performZoom(nil) }))
        let container = NSView(frame: NSRect(origin: .zero, size: frame.size))
        hosting.frame = container.bounds
        hosting.autoresizingMask = [.width, .height]
        hosting.sizingOptions = []
        container.addSubview(hosting)
        let grips = PillWindowResizeHandles(frame: container.bounds)
        grips.autoresizingMask = [.width, .height]
        container.addSubview(grips)
        window.contentView = container
        window.setFrame(frame, display: true)
    }

    func show() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.orderFrontRegardless()
        window.makeKey()
        model.start()
    }

    func close() { window.close() }

    func windowWillClose(_ notification: Notification) {
        model.stop()
        onClosed?()
        onClosed = nil
    }
}

/// The window's content on the pill's black, clipped to its corner radius.
struct UsageWindowRootView: View {
    @ObservedObject var model: UsageWindowModel
    let onClose: () -> Void
    let onMinimize: () -> Void
    let onZoom: () -> Void
    /// The offscreen gallery lays the content out flat (no scroll view).
    var scrolls = true

    static let headerBand: CGFloat = 56

    var body: some View {
        VStack(spacing: 0) {
            header
            if scrolls {
                ScrollView(.vertical) { UsageWindowContent(model: model).padding(24) }
                    .scrollIndicators(.automatic)
            } else {
                UsageWindowContent(model: model).padding(24)
                Spacer(minLength: 0)
            }
        }
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: PillChromeWindow.cornerRadius, style: .continuous))
        .environment(\.colorScheme, .dark)
        .ignoresSafeArea()
    }

    private var header: some View {
        ZStack {
            Color.clear
                .contentShape(Rectangle())
                .gesture(WindowDragGesture())
                .onTapGesture(count: 2, perform: onZoom)
            HStack(spacing: 14) {
                MacTrafficLights(onClose: onClose, onMinimize: onMinimize, onZoom: onZoom)
                    .padding(.leading, 20)
                Text("Usage")
                    .font(Typography.label(.semibold))
                    .foregroundStyle(Color.white.opacity(0.85))
                    .frame(maxWidth: .infinity)
                    .allowsHitTesting(false)
                UsageRangePicker(range: $model.range)
                    .padding(.trailing, 16)
            }
        }
        .frame(height: Self.headerBand)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1) }
    }
}

/// The range as capsules: 1H · 24H · 7D · 30D · All.
struct UsageRangePicker: View {
    @Binding var range: UsageRange
    var compact = false

    var body: some View {
        HStack(spacing: 2) {
            ForEach(UsageRange.allCases, id: \.self) { r in
                Button { range = r } label: {
                    Text(UsagePresentation.rangeShort(r))
                        .font(Typography.caption(range == r ? .semibold : .medium))
                        .foregroundStyle(Color.white.opacity(range == r ? 0.95 : 0.55))
                        .padding(.horizontal, compact ? 7 : 10)
                        .frame(height: compact ? 20 : 24)
                        .background(Capsule().fill(Color.white.opacity(range == r ? 0.16 : 0)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(UsagePresentation.rangeTitle(r))
            }
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.06)))
    }
}

struct UsageWindowContent: View {
    @ObservedObject var model: UsageWindowModel
    @State private var editing: UsageSubscription?

    var body: some View {
        let now = model.now()
        VStack(alignment: .leading, spacing: 20) {
            plans(now: now)
            tiles
            sourcesRow
            chartCard
            modelsTable
            subscriptionsCard(now: now)
            trackingRow
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: plans

    private func plans(now: Date) -> some View {
        // Codex, Claude Code, Antigravity — only the apps on this Mac; one title column for every line.
        let slots = UsagePresentation.plans(model.summary).filter { UsagePresentation.showsSlot($0.reading) }
            .map { UsagePresentation.slot(provider: $0.provider, reading: $0.reading, now: now) }
        let titleWidth = UsagePresentation.titleColumnWidth(slots.flatMap { $0.rings.map(\.title) }, compact: false)
        return VStack(alignment: .leading, spacing: 18) {
            ForEach(slots) { slot in
                VStack(alignment: .leading, spacing: 6) {
                    UsagePlanSlotCard(slot: slot, titleWidth: titleWidth, alarms: model.alarms ?? [], alarmActions: model.alarmActions)
                    if slot.id == "claude-code", let line = UsagePresentation.statsHistoryLine(before: model.summary?.claudeCodeStatsBefore) {
                        Text(line).font(Typography.tiny()).foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
    }

    // MARK: tiles

    private var tiles: some View {
        let t = model.series?.totals ?? UsageTotals()
        return HStack(spacing: 12) {
            UsageTile(title: "Cost", value: UsagePresentation.cost(t.costUsd),
                      detail: t.unpricedTokens > 0 ? "\(UsagePresentation.tokens(t.unpricedTokens)) tokens unpriced" : UsagePresentation.rangeTitle(model.range),
                      large: true)
            UsageTile(title: "Tokens", value: UsagePresentation.tokens(t.input + t.output),
                      detail: "\(UsagePresentation.tokens(t.input)) in · \(UsagePresentation.tokens(t.output)) out")
            UsageTile(title: "Cached", value: UsagePresentation.tokens(t.cacheRead + t.cacheWrite),
                      detail: "\(UsagePresentation.tokens(t.cacheRead)) read · \(UsagePresentation.tokens(t.cacheWrite)) written")
            UsageTile(title: "Cache savings", value: UsagePresentation.cost(t.cacheSavingsUsd), detail: "vs. the same tokens uncached")
        }
    }

    // MARK: sources

    private var sourcesRow: some View {
        HStack(spacing: 8) {
            ForEach(UsageSource.allCases.filter { UsagePresentation.showsToggle($0, summary: model.summary) }, id: \.self) { s in
                let on = model.sources.contains(s)
                let cost = model.series?.bySource[s]?.costUsd ?? 0
                Button { model.toggle(s) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: on ? "checkmark.circle.fill" : "circle")
                            .font(Typography.caption(.semibold))
                            .foregroundStyle(on ? Theme.accent : Color.white.opacity(0.4))
                        Text(UsagePresentation.sourceTitle(s)).font(Typography.caption(.medium))
                        if on { Text(UsagePresentation.cost(cost)).font(Typography.captionDigits()).foregroundStyle(Color.white.opacity(0.5)) }
                    }
                    .foregroundStyle(Color.white.opacity(on ? 0.9 : 0.5))
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(Capsule().fill(Color.white.opacity(on ? 0.1 : 0.04)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 8)
            HStack(spacing: 2) {
                ForEach(UsageMetric.allCases, id: \.self) { m in
                    Button { model.metric = m } label: {
                        Text(m == .cost ? "Cost" : "Tokens")
                            .font(Typography.caption(model.metric == m ? .semibold : .medium))
                            .foregroundStyle(Color.white.opacity(model.metric == m ? 0.95 : 0.55))
                            .padding(.horizontal, 10)
                            .frame(height: 24)
                            .background(Capsule().fill(Color.white.opacity(model.metric == m ? 0.16 : 0)))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(2)
            .background(Capsule().fill(Color.white.opacity(0.06)))
        }
    }

    // MARK: chart

    private var chartCard: some View {
        let shaped: (points: [UsageChartPoint], order: [String]) = model.series.map { UsagePresentation.chartPoints($0, metric: model.metric) } ?? (points: [], order: [])
        let colors = UsagePresentation.seriesColors(shaped.order)
        return VStack(alignment: .leading, spacing: 10) {
            UsageSectionTitle(text: model.metric == .cost ? "Cost by model" : "Tokens by model")
            if shaped.order.isEmpty {
                Text(model.failed ? "Couldn’t read usage." : "No usage in this range.")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, minHeight: 180)
            } else {
                let labels = model.series.map { UsagePresentation.axisLabels($0) } ?? []
                let labelText = Dictionary(labels.map { ($0.key, $0.text) }, uniquingKeysWith: { a, _ in a })
                Chart(shaped.points) { p in
                    BarMark(x: .value("Time", p.slotKey), y: .value(model.metric == .cost ? "USD" : "Tokens", p.value), width: .ratio(0.75))
                        .foregroundStyle(by: .value("Model", p.series))
                }
                .chartForegroundStyleScale(domain: shaped.order, range: colors)
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine().foregroundStyle(Color.white.opacity(0.08))
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text(model.metric == .cost ? UsagePresentation.cost(v) : UsagePresentation.tokens(v))
                                    .font(Typography.tiny()).foregroundStyle(Theme.textMuted)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: labels.map(\.key)) { value in
                        AxisValueLabel(centered: false) {
                            if let key = value.as(String.self), let text = labelText[key] {
                                Text(text).font(Typography.tiny()).foregroundStyle(Theme.textMuted).fixedSize()
                            }
                        }
                    }
                }
                .chartLegend(position: .bottom, alignment: .leading, spacing: 10) {
                    UsageLegend(order: shaped.order, colors: colors)
                }
                .frame(height: 240)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.05)))
    }

    // MARK: models

    private var modelsTable: some View {
        let rows = model.series?.models ?? []
        return VStack(alignment: .leading, spacing: 8) {
            UsageSectionTitle(text: "By model")
            if rows.isEmpty {
                Text("Nothing yet.").font(Typography.caption()).foregroundStyle(Theme.textMuted)
            } else {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 7) {
                    GridRow {
                        ForEach(["Model", "Source", "Input", "Output", "Cache read", "Cache write", "Cost"], id: \.self) { h in
                            Text(h).font(Typography.tiny(.semibold)).foregroundStyle(Theme.textMuted)
                                .gridColumnAlignment(["Model", "Source"].contains(h) ? .leading : .trailing)
                        }
                    }
                    Divider().overlay(Color.white.opacity(0.08)).gridCellUnsizedAxes(.horizontal)
                    ForEach(rows) { r in
                        GridRow {
                            Text(UsagePresentation.modelName(r.model)).font(Typography.captionMono()).foregroundStyle(Color.white.opacity(0.9))
                                .lineLimit(1).truncationMode(.middle).frame(maxWidth: 240, alignment: .leading)
                            Text(UsagePresentation.sourceTitle(r.source)).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                            num(r.totals.input)
                            num(r.totals.output)
                            num(r.totals.cacheRead)
                            num(r.totals.cacheWrite)
                            HStack(spacing: 4) {
                                if !UsagePresentation.basisMark(r).isEmpty {
                                    Text(UsagePresentation.basisMark(r)).font(Typography.tiny()).foregroundStyle(Theme.textMuted)
                                }
                                Text(r.costBasis == "unknown" ? "—" : UsagePresentation.cost(r.totals.costUsd))
                                    .font(Typography.captionDigits(.semibold)).foregroundStyle(Color.white)
                            }
                        }
                    }
                }
                Text("“est.” — a list-price estimate: what the same tokens would cost on the API (a subscription isn’t billed per token).")
                    .font(Typography.tiny()).foregroundStyle(Theme.textMuted)
                if rows.contains(where: { $0.costBasis == "reported" }) {
                    Text("“reported” — the cost OpenCode itself recorded for those tokens.")
                        .font(Typography.tiny()).foregroundStyle(Theme.textMuted)
                }
                if rows.contains(where: { $0.totals.syntheticRecords > 0 }) {
                    Text("* includes days from Claude Code’s /stats, kept after its transcripts were deleted: daily totals split by each model’s overall mix, so the cache split and cost are estimates.")
                        .font(Typography.tiny()).foregroundStyle(Theme.textMuted)
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.05)))
    }

    private func num(_ v: Double) -> some View {
        Text(UsagePresentation.tokens(v)).font(Typography.captionDigits()).foregroundStyle(Color.white.opacity(0.8))
    }

    // MARK: subscriptions

    private func subscriptionsCard(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                UsageSectionTitle(text: "Subscriptions")
                Spacer()
                if editing == nil {
                    UsageChromeButton(symbol: "plus", label: "Add plan") {
                        editing = UsageSubscription(name: "", provider: "openai", price: 20, covers: UsagePresentation.defaultCovers(provider: "openai"))
                    }
                }
            }
            if model.subscriptions.isEmpty && editing == nil {
                Text("Add the plans you pay for to see what each one is worth at list price.")
                    .font(Typography.caption()).foregroundStyle(Theme.textMuted)
            }
            ForEach(model.subscriptions) { s in
                if editing?.id == s.id {
                    UsageSubscriptionEditor(draft: binding(), onSave: save, onCancel: { editing = nil })
                } else {
                    UsageSubscriptionRow(subscription: s, now: now, onEdit: { editing = s }, onRemove: { Task { await model.remove(id: s.id) } })
                }
            }
            if let draft = editing, draft.id.isEmpty {
                UsageSubscriptionEditor(draft: binding(), onSave: save, onCancel: { editing = nil })
            }
            if let error = model.subscriptionError {
                Text(error).font(Typography.caption()).foregroundStyle(Color(nsColor: .systemRed))
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.05)))
    }

    private func binding() -> Binding<UsageSubscription> {
        Binding(get: { editing ?? UsageSubscription(name: "", provider: "openai", price: 0) }, set: { editing = $0 })
    }

    private func save() {
        guard let draft = editing else { return }
        Task { if await model.save(draft) { editing = nil } }
    }

    // MARK: tracking

    private var trackingRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            UsageSectionTitle(text: "Reading other apps")
            UsageSwitchRow(on: model.summary?.trackCodex ?? true, text: "Codex — its session files and its own plan report") { v in
                Task { await model.setTrack(codex: v) }
            }
            UsageSwitchRow(on: model.summary?.trackClaudeCode ?? true, text: "Claude Code — its transcripts and its own /usage report") { v in
                Task { await model.setTrack(claudeCode: v) }
            }
            // Only when the daemon reports the switch (an older one has neither: the switch would do nothing).
            if let on = model.summary?.trackAntigravity {
                UsageSwitchRow(on: on, text: "Antigravity — its own /usage report") { v in
                    Task { await model.setTrack(antigravity: v) }
                }
            }
            if let on = model.summary?.trackOpencode {
                UsageSwitchRow(on: on, text: "OpenCode — its own stats: tokens and cost per model") { v in
                    Task { await model.setTrack(opencode: v) }
                }
            }
            Text("Only numbers, model names and times are kept — never what was said, never a path or a project name. Winter never reads any of these apps’ sign-in.")
                .font(Typography.tiny()).foregroundStyle(Theme.textMuted)
        }
    }
}

/// A switch drawn by Winter (custom chrome; an AppKit switch also draws blank offscreen).
struct UsageSwitchRow: View {
    let on: Bool
    let text: String
    let onChange: (Bool) -> Void

    var body: some View {
        Button { onChange(!on) } label: {
            HStack(spacing: 10) {
                ZStack(alignment: on ? .trailing : .leading) {
                    Capsule().fill(on ? Theme.accent : Color.white.opacity(0.16)).frame(width: 30, height: 18)
                    Circle().fill(Color.white).frame(width: 14, height: 14).padding(2)
                }
                .animation(.easeOut(duration: 0.15), value: on)
                Text(text).font(Typography.caption()).foregroundStyle(Color.white.opacity(0.85))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(on ? "On" : "Off")
    }
}

struct UsageSectionTitle: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(Typography.tiny(.semibold)).tracking(0.6).foregroundStyle(Theme.textMuted)
    }
}

struct UsageTile: View {
    let title: String
    let value: String
    let detail: String
    var large = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Typography.caption(.medium)).foregroundStyle(Theme.textMuted)
            Text(value).font(large ? Typography.settingsPageTitle : Typography.heading(.semibold))
                .foregroundStyle(Color.white).lineLimit(1).minimumScaleFactor(0.7)
            Text(detail).font(Typography.tiny()).foregroundStyle(Theme.textMuted).lineLimit(1)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.05)))
    }
}

/// The plan lines' colours (user 2026-10-18): Codex green, Claude Code Claude's own clay, Antigravity Google blue.
enum UsagePlanColor {
    static let codex = Color(red: 0.063, green: 0.639, blue: 0.498)
    static let claudeCode = Color(red: 0.851, green: 0.467, blue: 0.341)
    static let antigravity = Color(red: 0.259, green: 0.522, blue: 0.957)

    static func of(provider: String) -> Color {
        switch provider {
        case "codex": return codex
        case "antigravity": return antigravity
        default: return claudeCode
        }
    }
}

/// A plan's slot (user 2026-10-18): the plan's name, then one LINE per window filling left to right with what is LEFT
/// (Codex green, Claude Code clay; grey while stale) — or why there are none — then the source and its age. No card
/// behind it.
struct UsagePlanSlotCard: View {
    let slot: UsagePlanSlot
    var compact = false
    /// The lines' title column (`UsagePresentation.titleColumnWidth`, shared by every slot of a block); nil = this slot's own.
    var titleWidth: CGFloat? = nil
    /// Every plan alarm (this slot draws its own plan's), and what a click on a line does with them (nil: nothing).
    var alarms: [UsageAlarm] = []
    var alarmActions: UsageAlarmActions? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 8) {
            HStack(spacing: 6) {
                Text(slot.title).font(compact ? Typography.caption(.semibold) : Typography.label(.semibold)).foregroundStyle(Color.white)
                if let plan = slot.planType {
                    Text(plan).font(Typography.tiny(.semibold)).foregroundStyle(Theme.textMuted)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.08)))
                }
                Spacer(minLength: 8)
                if !slot.sourceLine.isEmpty {
                    Text(slot.sourceLine).font(Typography.tiny()).foregroundStyle(Theme.textMuted).lineLimit(1)
                }
            }
            if let empty = slot.emptyLine {
                Text(empty).font(Typography.caption()).foregroundStyle(Theme.textMuted).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                UsagePlanLineGroup(rings: slot.rings, color: UsagePlanColor.of(provider: slot.id), compact: compact,
                                   titleWidth: titleWidth ?? UsagePresentation.titleColumnWidth(slot.rings.map(\.title), compact: compact),
                                   provider: slot.id, alarms: alarms.filter { $0.provider == slot.id }, alarmActions: alarmActions)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One plan's lines, hovered together (user 2026-10-18): the pointer over any of them opens them all.
struct UsagePlanLineGroup: View {
    let rings: [UsagePlanRing]
    let color: Color
    var compact = false
    /// The title column; nil = the floor (52 pt compact, 72 in the window).
    var titleWidth: CGFloat? = nil
    /// The plan ("codex", "claude-code", "antigravity"), its alarms, and what a click does (nil: nothing).
    var provider = ""
    var alarms: [UsageAlarm] = []
    var alarmActions: UsageAlarmActions? = nil
    @State private var localHover = false

    var body: some View {
        // The island's own pointer (its panels are never key), or the window's hover.
        IslandPointerReader { islandHovered in
            VStack(alignment: .leading, spacing: compact ? 5 : 8) {
                ForEach(rings) { ring in
                    UsagePlanLine(ring: ring, color: color, compact: compact, hovered: islandHovered || localHover, titleWidth: titleWidth,
                                  alarms: alarms.filter { $0.windowKey == ring.alarmKey },
                                  onSetAlarm: alarmActions.map { actions in { actions.set(provider, ring.alarmKey, $0) } },
                                  onRemoveAlarm: alarmActions?.remove)
                }
            }
        }
        .onHover { localHover = $0 }
    }
}

/// One window as a line: its name and the bar (what is USED, from the left); under the pointer, the used and left shares.
struct UsagePlanLine: View {
    let ring: UsagePlanRing
    let color: Color
    var compact = false
    /// Its plan's group is under the pointer (`UsagePlanLineGroup`).
    var hovered = false
    /// The title column (`UsagePresentation.titleColumnWidth`); nil = the floor (52 pt compact, 72 in the window).
    var titleWidth: CGFloat? = nil

    /// The line at rest and under the pointer (user 2026-10-18: just the line; on hover it thickens, lengthens a little
    /// and shows the used share inside the fill and what is left at the track's end).
    static func thickness(compact: Bool, hovered: Bool) -> CGFloat {
        hovered ? (compact ? 14 : 16) : (compact ? 5 : 7)
    }

    /// How much longer the line is under the pointer, half on each end: twice every panel's hover grow (≈19 pt) —
    /// with the title's grow, the row reads as lifting toward the viewer (user 2026-10-18: "a 3D hover").
    static func lengthGrowth(hovered: Bool) -> CGFloat { hovered ? HoverGrowth.points * 2 : 0 }

    /// The title's grow under the pointer, from its leading edge.
    static func titleScale(hovered: Bool) -> CGFloat { hovered ? 1.12 : 1 }

    /// The gap between the title column and the track.
    static func titleGap(compact: Bool) -> CGFloat { compact ? 8 : 12 }

    /// The narrowest a figure's slot is ("100%" in the tiny face plus its inset): the used one never squeezes below it
    /// (it then runs past a short fill), and the left one is dropped when the grey left over is shorter.
    static func figureSlot(compact: Bool) -> CGFloat { compact ? 30 : 34 }

    /// Where the reset words go inside a hovered line: the grey after the fill (before the left figure), else the fill
    /// (before the used figure), else nowhere (they stay in the VoiceOver label).
    enum ResetPlacement: Equatable { case grey, fill, none }

    /// About how wide the reset words are in the tiny face (≈ 5.4 pt a character at 10 pt) plus their gap.
    static func resetWidth(_ words: String?) -> CGFloat { words.map { CGFloat($0.count) * 5.4 + 10 } ?? 0 }

    /// PURE: where the figures go on a track `width` wide — the used one glued to the fill's END, inside it (its slot
    /// never narrower than `figureSlot`); the left one at the track's end, only when the grey left over fits it; the
    /// reset words where they fit whole (`ResetPlacement`).
    static func figureLayout(width: CGFloat, fraction: Double, compact: Bool, resetWidth: CGFloat = 0)
        -> (usedSlot: CGFloat, showsLeft: Bool, reset: ResetPlacement) {
        let fill = width * CGFloat(min(1, max(0, fraction)))
        let slot = figureSlot(compact: compact)
        let usedSlot = min(width, max(fill, slot))
        let showsLeft = width - usedSlot >= slot
        let reset: ResetPlacement
        if resetWidth <= 0 { reset = .none }
        else if showsLeft && width - usedSlot - slot >= resetWidth { reset = .grey }
        else if usedSlot - slot >= resetWidth { reset = .fill }
        else { reset = .none }
        return (usedSlot, showsLeft, reset)
    }

    /// PURE: the two hover figures — used (inside the fill) and left (at the track's end) — always summing to 100.
    static func percents(_ fraction: Double) -> (used: Int, left: Int) {
        let used = Int((min(1, max(0, fraction)) * 100).rounded())
        return (used, 100 - used)
    }

    /// This window's alarms (their ticks), and what a click does — nil: the line takes no clicks (`UsageAlarmRules`).
    var alarms: [UsageAlarm] = []
    var onSetAlarm: ((Int) -> Void)? = nil
    var onRemoveAlarm: ((String) -> Void)? = nil

    /// The row's own space: the track's resting frame and the pointer are both read in it.
    private static let rowSpace = "usagePlanLineRow"
    /// The track's RESTING frame in the row, and the row's frame in the island's canvas (for the island's pointer).
    @State private var slot: CGRect = .zero
    @State private var rowInCanvas: CGRect = .zero
    /// The window's pointer over this row (x in the row), from `onContinuousHover`.
    @State private var windowPointerX: CGFloat?
    /// "Already past" at the spot clicked, for a moment.
    @State private var pastFlash: PastFlash?

    private struct PastFlash: Equatable { let x: CGFloat; let token: Int }

    var body: some View {
        // The island's panels are never key: its own pointer (in the canvas) says where it is; in the window, the hover.
        IslandPointerLocationReader { canvasPoint in
            line(pointerX: islandPointerX(canvasPoint) ?? windowPointerX)
        }
    }

    /// The island's pointer as an x in this row, when it is over the row.
    private func islandPointerX(_ p: CGPoint?) -> CGFloat? {
        guard let p, rowInCanvas.contains(p) else { return nil }
        return p.x - rowInCanvas.minX
    }

    private func line(pointerX: CGFloat?) -> some View {
        let used = min(1, max(0, ring.fraction))
        let pct = Self.percents(ring.fraction)
        let height = Self.thickness(compact: compact, hovered: hovered)
        // The marker: under the pointer, on the hovered track (x along it, from its grown start).
        let marker = hovered ? pointerX.flatMap { UsageAlarmRules.trackPoint(rowX: $0, slot: slot, hovered: true) } : nil
        let flash = hovered ? pastFlash : nil
        return HStack(spacing: Self.titleGap(compact: compact)) {
            Text(ring.title).font(Typography.tiny(.medium)).foregroundStyle(Color.white.opacity(hovered ? 1 : 0.85)).lineLimit(1)
                .scaleEffect(Self.titleScale(hovered: hovered), anchor: .leading)
                .frame(width: titleWidth ?? (compact ? 52 : 72), alignment: .leading)
            GeometryReader { proxy in
                let resetWidth = Self.resetWidth(ring.resetsHover)
                let at = flash?.x ?? marker?.x
                let aside = at.map { UsageAlarmRules.markerLayout(x: $0, width: proxy.size.width, fraction: used, compact: compact, resetWidth: resetWidth) }
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule().fill(ring.stale ? Color(nsColor: .systemGray) : color)
                        .frame(width: max(used > 0 ? height : 0, proxy.size.width * used))
                    ForEach(alarms) { alarm in
                        UsageAlarmTick(x: UsageAlarmRules.tickX(alarm.thresholdPercent, width: proxy.size.width), height: height, hovered: hovered)
                    }
                    if hovered {
                        // A lighter weight than the titles: the figures sit in the line, they do not shout. Under the marker
                        // (or its label) a figure or the reset words step aside.
                        let layout = Self.figureLayout(width: proxy.size.width, fraction: used, compact: compact, resetWidth: resetWidth)
                        ZStack(alignment: .leading) {
                            HStack(spacing: 0) {
                                if layout.reset == .fill, let words = ring.resetsHover {
                                    Text(words).foregroundStyle(Color.white.opacity(0.85)).padding(.leading, 6)
                                        .opacity(aside?.hidesReset == true ? 0 : 1)
                                }
                                Spacer(minLength: 4)
                                Text("\(pct.used)%").foregroundStyle(Color.white).padding(.trailing, 6)
                                    .opacity(aside?.hidesUsed == true ? 0 : 1)
                            }
                            .frame(width: layout.usedSlot)
                            if layout.showsLeft {
                                HStack(spacing: 8) {
                                    if layout.reset == .grey, let words = ring.resetsHover {
                                        Text(words).foregroundStyle(Color.white.opacity(0.6))
                                            .opacity(aside?.hidesReset == true ? 0 : 1)
                                    }
                                    Text("\(pct.left)%").foregroundStyle(Color.white.opacity(0.6))
                                        .opacity(aside?.hidesLeft == true ? 0 : 1)
                                }
                                .padding(.trailing, 6)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                            }
                        }
                        .font(Typography.tinyDigits(.regular))
                        .lineLimit(1)
                        .transition(.opacity)
                        if let at, let aside {
                            UsageAlarmMarker(x: at, height: height,
                                             text: flash != nil ? "Already past" : "\(UsageAlarmRules.percent(x: at, width: proxy.size.width))%",
                                             onRight: flash != nil ? at + 80 <= proxy.size.width : aside.labelOnRight)
                        }
                    }
                }
            }
            .frame(height: height)
            .padding(.horizontal, -Self.lengthGrowth(hovered: hovered) / 2)
            // The padding's own frame is the track's RESTING slot in the row (the reader inside reaches past it).
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.rowSpace)) } action: { slot = $0 }
            .opacity(ring.stale ? 0.6 : 1)
        }
        .coordinateSpace(.named(Self.rowSpace))
        .frame(height: Self.thickness(compact: compact, hovered: true))
        .contentShape(Rectangle())
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(DispatchPillView.canvasSpace)) } action: { rowInCanvas = $0 }
        .onContinuousHover(coordinateSpace: .local) { phase in
            switch phase {
            case .active(let p): windowPointerX = p.x
            case .ended: windowPointerX = nil
            }
        }
        .gesture(SpatialTapGesture(coordinateSpace: .local).onEnded { tapped(rowX: $0.location.x) }, including: onSetAlarm == nil ? .none : .all)
        .animation(HoverGrowth.animation, value: hovered)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(ring.title): \(pct.used)% used, \(pct.left)% left\(ring.resets.map { ", \($0)" } ?? "")"
            + (alarms.isEmpty ? "" : ", alarm at " + alarms.map { "\($0.thresholdPercent)%" }.joined(separator: ", ")))
    }

    /// A click on the line: on a tick, that alarm goes; at or below what is used, "Already past"; else an alarm there.
    private func tapped(rowX: CGFloat) {
        guard let onSetAlarm, let point = UsageAlarmRules.trackPoint(rowX: rowX, slot: slot, hovered: hovered) else { return }
        switch UsageAlarmRules.tap(x: point.x, width: point.width, usedPercent: ring.fraction * 100, alarms: alarms) {
        case .remove(let id):
            onRemoveAlarm?(id)
        case .set(let pct):
            onSetAlarm(pct)
        case .alreadyPast:
            let flash = PastFlash(x: point.x, token: (pastFlash?.token ?? 0) + 1)
            pastFlash = flash
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(UsageAlarmRules.pastFlashSeconds * 1_000_000_000))
                if pastFlash == flash { pastFlash = nil }
            }
        }
    }
}

struct UsageLegend: View {
    let order: [String]
    let colors: [Color]

    var body: some View {
        HStack(spacing: 12) {
            ForEach(Array(order.enumerated()), id: \.offset) { i, name in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(colors[i]).frame(width: 8, height: 8)
                    Text(name).font(Typography.tiny()).foregroundStyle(Color.white.opacity(0.7)).lineLimit(1)
                }
            }
        }
    }
}

struct UsageChromeButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(Typography.caption(.semibold))
                Text(label).font(Typography.caption(.medium)).lineLimit(1)
            }
            .foregroundStyle(Color.white.opacity(0.85))
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Capsule().fill(Color.white.opacity(hovering ? 0.14 : 0.08)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

struct UsageSubscriptionRow: View {
    let subscription: UsageSubscription
    let now: Date
    let onEdit: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(subscription.name).font(Typography.label(.semibold)).foregroundStyle(Color.white)
                    Text(UsagePresentation.priceLine(subscription)).font(Typography.captionDigits()).foregroundStyle(Theme.textMuted)
                }
                Text(UsagePresentation.renewalLine(subscription, now: now)).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                Text(UsagePresentation.valueLine(subscription)).font(Typography.caption(.medium)).foregroundStyle(Color.white.opacity(0.85))
            }
            Spacer(minLength: 8)
            UsageChromeButton(symbol: "pencil", label: "Edit", action: onEdit)
            UsageChromeButton(symbol: "trash", label: "Remove", action: onRemove)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.05)))
    }
}

/// The plan editor: name, provider, price and currency, cadence, renewal day (and month), what it covers.
struct UsageSubscriptionEditor: View {
    @Binding var draft: UsageSubscription
    let onSave: () -> Void
    let onCancel: () -> Void

    private static let providers: [(String, String)] = [("openai", "OpenAI (ChatGPT)"), ("anthropic", "Anthropic (Claude)"), ("other", "Other")]
    private static let months = DateFormatter().monthSymbols ?? []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                field("Name") { TextField("ChatGPT Pro", text: $draft.name).textFieldStyle(.plain).font(Typography.caption()) }
                field("Provider") {
                    Picker("", selection: Binding(get: { draft.provider }, set: { p in
                        if draft.covers == UsagePresentation.defaultCovers(provider: draft.provider) { draft.covers = UsagePresentation.defaultCovers(provider: p) }
                        draft.provider = p
                    })) {
                        ForEach(Self.providers, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .labelsHidden().pickerStyle(.menu).font(Typography.caption())
                }
            }
            HStack(spacing: 10) {
                field("Price") { TextField("20", value: $draft.price, format: .number).textFieldStyle(.plain).font(Typography.captionDigits()) }
                field("Currency") {
                    Picker("", selection: $draft.currency) { ForEach(["USD", "EUR", "GBP", "JPY", "CAD", "AUD"], id: \.self) { Text($0).tag($0) } }
                        .labelsHidden().pickerStyle(.menu).font(Typography.caption())
                }
                field("Billed") {
                    Picker("", selection: $draft.cadence) { Text("Monthly").tag("monthly"); Text("Yearly").tag("yearly") }
                        .labelsHidden().pickerStyle(.menu).font(Typography.caption())
                }
                field("Renews on day") {
                    Picker("", selection: $draft.renewalDay) { ForEach(1...31, id: \.self) { Text("\($0)").tag($0) } }
                        .labelsHidden().pickerStyle(.menu).font(Typography.caption())
                }
                if draft.cadence == "yearly" {
                    field("of") {
                        Picker("", selection: Binding(get: { draft.renewalMonth ?? 1 }, set: { draft.renewalMonth = $0 })) {
                            ForEach(Array(Self.months.enumerated()), id: \.offset) { Text($0.element).tag($0.offset + 1) }
                        }
                        .labelsHidden().pickerStyle(.menu).font(Typography.caption())
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Counts usage from").font(Typography.tiny(.semibold)).foregroundStyle(Theme.textMuted)
                HStack(spacing: 6) {
                    ForEach(UsagePresentation.coverOptions, id: \.id) { option in
                        let on = draft.covers.contains(option.id)
                        Button {
                            if on { draft.covers.removeAll { $0 == option.id } } else { draft.covers.append(option.id) }
                        } label: {
                            Text(option.title).font(Typography.caption(.medium))
                                .foregroundStyle(Color.white.opacity(on ? 0.95 : 0.5))
                                .padding(.horizontal, 9).frame(height: 22)
                                .background(Capsule().fill(Color.white.opacity(on ? 0.16 : 0.05)))
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            HStack {
                Spacer()
                UsageChromeButton(symbol: "xmark", label: "Cancel", action: onCancel)
                UsageChromeButton(symbol: "checkmark", label: "Save", action: onSave)
                    .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty || draft.price < 0)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.07)))
    }

    private func field<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(Typography.tiny(.semibold)).foregroundStyle(Theme.textMuted)
            content()
                .padding(.horizontal, 8)
                .frame(minWidth: 70, minHeight: 24, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.white.opacity(0.06)))
        }
    }
}
