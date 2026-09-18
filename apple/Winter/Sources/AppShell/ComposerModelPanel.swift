import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// The composer's model/effort picker (2026-09-18) — a small translucent panel floating directly
// above the composer's model button, replacing the stock popover of stacked menus.
//
//     click the button ─▶ [ models of the CURRENT family ]  ─▶ tap one ─▶ [ its providers ]
//                         [ Other…                       ]               [ Effort       › ]
//                         [ Effort                     › ]
//                                  │                 └─▶ [ ‹ Effort: Default / low / high… ]
//                                  └─▶ the full-size family card (`ModelFamilyPickerCard`, the
//                                      same one Settings → Roles uses) — commits a tag, closes,
//                                      and leaves this panel open on the new model's family.
//
// WHERE IT RENDERS. Not inside the composer: the composer's own layout would clip it and anything
// drawn later would cover it. The button publishes its bounds as an anchor preference
// (`ComposerModelPanelKey`) and `ShellRootView` draws the panel in its own overlay layer, resolved
// against that anchor — centred over the button, above everything but the full-size card.
//
// WHAT IT CAN COMMIT. Exactly what the session catalogue (`sync.config`) lists — the same "never
// compose a tag" rule the Roles picker keeps, through the same `roleProviderOptions`.
// -----------------------------------------------------------------------------------------------

// MARK: - What the button reads

/// PURE: a model's short name for the composer button — its catalogue display name with the vendor
/// word, any parenthesised provider note, and every "-" stripped: "GPT-5.6 Sol" → "5.6 Sol",
/// "Claude Fable 5.1" → "Fable 5.1". Never the provider, never the runtime, never the effort (user
/// call, 2026-09-18). Falls back to the tag's model portion when the catalogue has no row for it.
func composerModelShortName(_ tag: String, catalogue: SyncConfigSnapshot) -> String {
    let display = catalogue.models.first { $0.id == tag }?.displayName ?? ""
    return composerModelShortName(displayName: display.isEmpty ? modelIdPortion(of: tag) : display)
}

/// The vendor words stripped from the front of a model's name. Only as a whole word — "gpt-oss"
/// keeps nothing it should not, and a model merely STARTING with these letters is left alone.
let composerModelVendorWords = ["claude", "gpt"]

/// PURE: the string half of `composerModelShortName`, so the rule is testable without a catalogue.
func composerModelShortName(displayName: String) -> String {
    var name = displayName
    if let note = name.range(of: " (") { name = String(name[..<note.lowerBound]) }
    let lowered = name.lowercased()
    for word in composerModelVendorWords where lowered.hasPrefix(word) {
        let rest = name.dropFirst(word.count)
        if let next = rest.first, next == " " || next == "-" {
            name = String(rest.dropFirst())
        }
        break
    }
    let words = name.replacingOccurrences(of: "-", with: " ")
        .split(separator: " ", omittingEmptySubsequences: true)
    let short = words.joined(separator: " ")
    return short.isEmpty ? displayName : short
}

/// PURE: the session catalogue as the offerable set the family card reads — one entry per provider,
/// in the catalogue's own order, each listing its tags verbatim. Provider names come from
/// `models.catalog` when it has landed (the session catalogue carries none); the id otherwise.
func sessionPermittedProviders(_ catalogue: SyncConfigSnapshot,
                               facts: ModelCatalogFacts = .none) -> [ModelRolePermittedProvider] {
    var order: [String] = []
    var tags: [String: [String]] = [:]
    for model in catalogue.models {
        if tags[model.providerId] == nil {
            order.append(model.providerId)
            tags[model.providerId] = []
        }
        tags[model.providerId]?.append(model.id)
    }
    return order.map {
        ModelRolePermittedProvider(providerId: $0,
                                   displayName: facts.providerNames[$0] ?? $0,
                                   models: tags[$0] ?? [])
    }
}

/// PURE: the family the small panel lists — the one holding the model in force, else the first.
func composerModelPanelGroup(_ groups: [RoleModelFamilyGroup], effective: String?) -> RoleModelFamilyGroup? {
    if let effective,
       let group = groups.first(where: { $0.models.contains { $0.tags.contains(effective) } }) {
        return group
    }
    return groups.first
}

// MARK: - The anchor

/// What the model button hands the shell while its panel is open: where it is, and the live row and
/// doors the panel drives. Re-published on every render of the button, so the panel is never a
/// snapshot — a model change lands in it the moment the row does.
struct ComposerModelPanelEntry {
    let anchor: Anchor<CGRect>
    let row: ComposerModelRow
    let onSetModel: (String?) -> Void
    let onSetEffort: (String?) -> Void
    let onClose: () -> Void
}

struct ComposerModelPanelKey: PreferenceKey {
    static var defaultValue: ComposerModelPanelEntry? { nil }
    static func reduce(value: inout ComposerModelPanelEntry?, nextValue: () -> ComposerModelPanelEntry?) {
        // One composer is ever on screen; if two ever published, the first keeps the panel.
        if value == nil { value = nextValue() }
    }
}

/// The small panel's footprint and placement.
let composerModelPanelWidth: CGFloat = 264
let composerModelPanelListMaxHeight: CGFloat = 260
/// Gap between the button's top edge and the panel's bottom edge.
let composerModelPanelGap: CGFloat = 10
let composerModelPanelCornerRadius: CGFloat = 14

/// PURE: the panel's leading x — centred on the button, clamped inside the window.
func composerModelPanelX(buttonMidX: CGFloat, containerWidth: CGFloat,
                         width: CGFloat = composerModelPanelWidth, margin: CGFloat = 8) -> CGFloat {
    let centred = buttonMidX - width / 2
    return min(max(centred, margin), max(margin, containerWidth - width - margin))
}

/// The shell-level layer: a click-away catcher over the window and the panel above the button.
/// Rendered by `ShellRootView` from `ComposerModelPanelKey`.
struct ComposerModelPanelLayer: View {
    let entry: ComposerModelPanelEntry
    /// The "Other" door — opens the full-size card through the shell's modal layer.
    let onOther: (ComposerModelRow, @escaping (String) -> Void) -> Void

    var body: some View {
        GeometryReader { proxy in
            let button = proxy[entry.anchor]
            ZStack(alignment: .topLeading) {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { entry.onClose() }
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    ComposerModelPanel(row: entry.row,
                                       onSetModel: entry.onSetModel,
                                       onSetEffort: entry.onSetEffort,
                                       onOther: { onOther(entry.row, { entry.onSetModel($0) }) })
                }
                .frame(width: composerModelPanelWidth,
                       height: max(0, button.minY - composerModelPanelGap),
                       alignment: .bottom)
                .offset(x: composerModelPanelX(buttonMidX: button.midX, containerWidth: proxy.size.width))
            }
        }
        .background {
            Button("Close model picker") { entry.onClose() }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }
}

// MARK: - The small panel

enum ComposerModelPanelStep: Equatable {
    case models
    case providers(modelKey: String)
    case effort
}

struct ComposerModelPanel: View {
    let row: ComposerModelRow
    let onSetModel: (String?) -> Void
    let onSetEffort: (String?) -> Void
    let onOther: () -> Void

    @ObservedObject private var catalog = ModelCatalogFactsModel.shared
    @State private var step: ComposerModelPanelStep = .models

    private var facts: ModelCatalogFacts { catalog.facts }
    private var permitted: [ModelRolePermittedProvider] {
        sessionPermittedProviders(row.catalogue, facts: facts)
    }
    private var group: RoleModelFamilyGroup? {
        composerModelPanelGroup(roleModelFamilyGroups(permitted, facts: facts), effective: row.effectiveModel)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch step {
            case .models:
                list { modelRows }
                separator
                panelRow("Other models", trailing: nil, showsChevron: true, isEnabled: true, action: onOther)
                effortDoor
            case let .providers(modelKey):
                header(title: modelTitle(modelKey)) { step = .models }
                separator
                list { providerRows(modelKey) }
                effortDoor
            case .effort:
                header(title: "Effort") { step = .models }
                separator
                list { effortRows }
            }
        }
        .padding(6)
        .frame(width: composerModelPanelWidth)
        .clipShape(RoundedRectangle(cornerRadius: composerModelPanelCornerRadius, style: .continuous))
        .shellFloatingSurface(cornerRadius: composerModelPanelCornerRadius)
        .environment(\.shellRowFillIsVibrant, false)
        .animation(.easeOut(duration: 0.14), value: step)
        // Facts landing can change a model's key (tag portion → canonical id); a provider step
        // whose key no longer resolves goes back rather than showing an empty list.
        .onChange(of: facts) { _, updated in
            guard case let .providers(modelKey) = step,
                  roleProviderOptions(modelKey: modelKey, permitted: permitted, facts: updated).isEmpty
            else { return }
            step = .models
        }
    }

    // MARK: Steps

    @ViewBuilder
    private var modelRows: some View {
        if let group {
            ForEach(group.models) { option in
                let isCurrent = row.effectiveModel.map { option.tags.contains($0) } ?? false
                panelRow(option.tags.first.map { composerModelShortName($0, catalogue: row.catalogue) } ?? option.label,
                         trailing: nil, isSelected: isCurrent, showsChevron: false,
                         isEnabled: !row.modelChangeInFlight) {
                    step = .providers(modelKey: option.id)
                }
            }
        } else {
            Text("No models reported yet.")
                .font(Typography.control())
                .foregroundStyle(Theme.textMuted)
                .padding(10)
        }
    }

    @ViewBuilder
    private func providerRows(_ modelKey: String) -> some View {
        ForEach(roleProviderOptions(modelKey: modelKey, permitted: permitted, facts: facts)) { option in
            Button {
                onSetModel(option.tag)
                step = .models
            } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.displayName)
                            .font(Typography.body())
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Text(rolePricingText(option.pricing))
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    if row.effectiveModel == option.tag { checkmark }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(ShellSidebarRowStyle(isSelected: false))
            .disabled(row.modelChangeInFlight)
        }
    }

    @ViewBuilder
    private var effortRows: some View {
        let options: [String?] = [nil] + row.wire.map(Optional.some) + row.tiers.map(Optional.some)
        ForEach(Array(options.enumerated()), id: \.offset) { _, effort in
            panelRow(effortDisplayLabel(effort).capitalized, trailing: nil,
                     isSelected: selectionIsCurrent(effort, current: row.effort),
                     showsChevron: false, isEnabled: !row.effortChangeInFlight) {
                onSetEffort(effort)
                step = .models
            }
        }
    }

    /// The effort door, under the list on the models and providers steps — only when the model in
    /// force reported effort levels at all.
    @ViewBuilder
    private var effortDoor: some View {
        if !row.wire.isEmpty {
            separator
            panelRow("Effort", trailing: effortDisplayLabel(row.effort).capitalized,
                     showsChevron: true, isEnabled: true) { step = .effort }
        }
    }

    // MARK: Pieces

    private func modelTitle(_ modelKey: String) -> String {
        let option = group?.models.first { $0.id == modelKey }
            ?? roleModelFamilyGroups(permitted, facts: facts).flatMap(\.models).first { $0.id == modelKey }
        return option?.tags.first.map { composerModelShortName($0, catalogue: row.catalogue) } ?? modelKey
    }

    private func list<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) { content() }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: composerModelPanelListMaxHeight)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var separator: some View {
        Rectangle()
            .fill(Theme.hairlineElevated)
            .frame(height: 1)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
    }

    private var checkmark: some View {
        Image(systemName: "checkmark")
            .font(Typography.caption(.semibold))
            .foregroundStyle(Theme.textSecondary)
    }

    private func header(title: String, back: @escaping () -> Void) -> some View {
        Button(action: back) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.backward")
                    .font(Typography.control(.medium))
                    .foregroundStyle(Theme.textSecondary)
                Text(title)
                    .font(Typography.body(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: shellSidebarRowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .accessibilityLabel("Back")
    }

    private func panelRow(_ title: String,
                          trailing: String?,
                          isSelected: Bool = false,
                          showsChevron: Bool,
                          isEnabled: Bool,
                          action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(Typography.body())
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let trailing {
                    Text(trailing)
                        .font(Typography.control())
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                if isSelected { checkmark }
                if showsChevron {
                    Image(systemName: "chevron.forward")
                        .font(Typography.caption(.medium))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: shellSidebarRowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .disabled(!isEnabled)
    }
}

// MARK: - The full-size card, for the session

/// "Show the full family card for this session's model." Equatable by identity, like the Roles
/// request: two opens are two requests even for the same row.
struct SessionModelPickerRequest: Equatable {
    let id = UUID()
    let catalogue: SyncConfigSnapshot
    let current: String?
    let onCommit: (String) -> Void

    static func == (a: SessionModelPickerRequest, b: SessionModelPickerRequest) -> Bool { a.id == b.id }
}

/// Observes the catalog facts so provider names, families and prices land while the card is open.
/// No effort here — effort lives only on the small panel (user call, 2026-09-18).
struct SessionModelPickerHost: View {
    let request: SessionModelPickerRequest
    let onClose: () -> Void

    @ObservedObject private var catalog = ModelCatalogFactsModel.shared

    var body: some View {
        ModelFamilyPickerCard(title: "Choose a model",
                              subtitle: "Every model this session can run on.",
                              permitted: sessionPermittedProviders(request.catalogue, facts: catalog.facts),
                              selection: request.current.map { .tag($0) } ?? .useDefault,
                              facts: catalog.facts,
                              onCommit: { tag in
                                  if let tag { request.onCommit(tag) }
                                  onClose()
                              },
                              onClose: onClose)
            .task { await catalog.loadIfNeeded() }
    }
}
