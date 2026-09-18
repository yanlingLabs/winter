import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Roles: the two-step model picker (2026-09-18).
//
// THE FLOW, as the user specified it:
//
//   click a role's model value
//     → STEP ONE   families down the left, that family's models on the right
//     → STEP TWO   the same card, REPLACED by the providers that can serve the chosen model,
//                  each with its price when we have one, and a back arrow to step one
//     → commit     the pair becomes a provider-qualified tag and goes through
//                  `settings.setModelRole`
//
// WHY THE SEAM. `settings.modelRoles`' per-role `permitted` — providers, each with the
// fully-qualified tags it can serve for that role — answers step two completely and step one not at
// all. So the picker takes ONE injected value, `ModelCatalogFacts`, defaulted to `.none`, and every
// decision that could depend on family, price or credential state is a pure function of
// (`permitted`, `facts`).
//
// WIRED 2026-09-18: `models.catalog` fills that seam (families, per-tag pricing evidence, and each
// provider's CREDENTIAL DOOR and READINESS — `credentialPresent`). `modelCatalogFacts(_:)` is the
// whole mapping and it is pure; `ModelCatalogFactsModel` is the one thing that reads a
// daemon. `.none` REMAINS a first-class state, not a degraded one — it is what a daemon that
// predates `models.catalog` produces, and the picker is fully usable in it:
//
//   - NO FAMILY DATA   every model lands in one group titled `roleModelAllModelsGroupTitle`.
//                      It does NOT invent families by splitting ids on a dash — a family is a
//                      curated catalog fact (`ModelFamilyDescriptor`), not a string pattern, and a
//                      guessed heading is a claim the app cannot back.
//   - NO PRICING       the provider row says `rolePricingNotPublishedText`. It never shows a
//                      number, and in particular never shows 0: the catalog's own rule is that an
//                      unpriced model reports `0` with `costBasis: "unknown"`, so a zero is the
//                      ABSENCE of a price, not a cheap one. `rolePricing` turns exactly that shape
//                      into `.notPublished` before any formatting happens, which is why the rule
//                      is a constructor fact here rather than a formatting accident.
//
// TWO RULES A LATER EDIT MUST NOT SOFTEN.
//
//   1. **NOTHING IS EVER COMPOSED.** Only the exact tag strings out of `permitted` may be
//      committed; a model+provider pair that is not in it is not OFFERED. `setModelRole` checks
//      that a value is a well-formed tag, not that a catalog row backs it, so a stitched-together
//      pair would be accepted, stored, and then blow up at session start — a failure arriving hours
//      and several screens away from the click that caused it. See `roleModelTag`.
//   2. **READINESS IS THE DAEMON'S ANSWER, READ STRAIGHT OFF THE PROVIDER ROW.** `permitted` is
//      CATALOG ELIGIBILITY — it applies the blocked floor and nothing else, so it names providers
//      the user has no credential for. Since 2026-09-18 every `models.catalog` provider row carries
//      `credentialPresent`, computed daemon-side by the rule that backs the composer's model list
//      (the on-disk `ant` profile for the console arm, stored material otherwise). That boolean IS
//      the readiness test. There is no `credential.list` join and no slot lookup any more — the
//      join is gone, not bypassed, because a providerId- or slot-keyed guess was provably wrong
//      for a real user (two secrets live under the id `anthropic` alone).
//
//      `credentialDoor` answers a SEPARATE question — which flow to offer when it is not ready —
//      and is branched on, never a hardcoded provider id (`roleProviderCredentialState`):
//
//        - `keychain` (~96)          not ready → "add one in Settings → Providers".
//        - `console-profile` (1)     not ready → `winter login --anthropic-console`, never "add a
//                                    key": there is no key to add.
//        - `none` (5)                this daemon stores no credential for them, so NOTHING is said
//                                    either way — whatever the boolean says.
//
//      An absent boolean (a daemon that predates it), and a door this build does not know, say
//      nothing at all. Saying nothing beats saying something false.
//
// Offerable is not the same as promised.
// -----------------------------------------------------------------------------------------------

// MARK: - The injected seam

/// List prices for ONE provider+model pair, per million tokens, exactly as the catalog states them
/// (`ModelPricing` + the `costBasis` its evidence wrapper carries).
///
/// `costBasis` is kept as the RAW string for the same reason `SettingsRoleValue.constraint` is: a
/// basis a later catalog adds must reach the classifier, not be dropped by a decode that knows two.
/// The one value this code interprets is `"unknown"`, which is the catalog's spelling of "these
/// numbers are placeholders".
struct ModelPricingFact: Equatable, Sendable {
    let inputPerMTokUsd: Double
    let outputPerMTokUsd: Double
    let costBasis: String
    /// Independently optional, and a missing rate is NOT zero — most providers publish neither.
    /// Shown only inside the provenance disclosure, never on the row: the row answers "what does a
    /// turn cost", and a cache rate is a footnote to that.
    let cacheReadPerMTokUsd: Double?
    let cacheWritePerMTokUsd: Double?
    /// The catalog's attribution for the figure. Both are REQUIRED on the wire (a price with
    /// neither does not decode at all — `CatalogPricing`), so nil here means no price was carried.
    let source: String?
    let confidence: String?
    let observedAt: String?
    /// **PROSE, up to ~1178 characters** — the evidence for the number, including the catalog's own
    /// disclosures (cache-WRITE rates are under-reported; batch/fast-lane/geographic modifiers are
    /// not folded in). Genuinely useful ON DEMAND and genuinely not a tooltip: it lives behind
    /// `roleProvenanceDisclosureTitle` on the priced row, in full, never truncated and never inline.
    let sourceRef: String?

    init(inputPerMTokUsd: Double,
         outputPerMTokUsd: Double,
         costBasis: String,
         cacheReadPerMTokUsd: Double? = nil,
         cacheWritePerMTokUsd: Double? = nil,
         source: String? = nil,
         confidence: String? = nil,
         observedAt: String? = nil,
         sourceRef: String? = nil) {
        self.inputPerMTokUsd = inputPerMTokUsd
        self.outputPerMTokUsd = outputPerMTokUsd
        self.costBasis = costBasis
        self.cacheReadPerMTokUsd = cacheReadPerMTokUsd
        self.cacheWritePerMTokUsd = cacheWritePerMTokUsd
        self.source = source
        self.confidence = confidence
        self.observedAt = observedAt
        self.sourceRef = sourceRef
    }
}

/// What the catalog says about ONE provider's credential — the two fields the readiness question
/// turns on, and nothing else.
///
/// `credentialPresent` is THE readiness answer, computed daemon-side; nil = not told (an older
/// daemon), which renders as no claim at all. `credentialDoor` is the raw door (`keychain` |
/// `console-profile` | `none`, and whatever a later catalog adds) and decides only which FLOW a
/// not-ready row points at. No slot id is kept: nothing app-side joins on one any more.
struct ProviderCredentialFact: Equatable, Sendable {
    var credentialDoor: String?
    var credentialPresent: Bool?

    init(credentialDoor: String? = nil, credentialPresent: Bool? = nil) {
        self.credentialDoor = credentialDoor
        self.credentialPresent = credentialPresent
    }
}

/// What the app has been told about one TAG (one provider's copy of one model), beyond the bare
/// string `permitted` carries. Every field optional: this whole type is additive, and a fact that
/// has not arrived must leave the picker in its honest no-data rendering rather than in a broken
/// one.
struct ModelCatalogFact: Equatable, Sendable {
    /// The family this model belongs to (`ModelFamilyDescriptor.id`) — `claude`, `gpt`, … Nil means
    /// "not told", which is NOT the catalog's reserved `other` bucket; both land in the trailing
    /// group, but only one of them is a statement.
    var familyId: String?
    /// The vendor's model identity with the provider's spelling removed
    /// (`WinterModelDescriptor.canonicalModelId`) — the thing that makes `deepseek/deepseek-v4-pro`
    /// and `openrouter/deepseek-v4-pro` ONE row in step one and two rows in step two.
    var canonicalId: String?
    /// The catalog's own facing name for the model. Nil falls back to the tag's model portion.
    var displayName: String?
    /// This pair's list price, when the catalog publishes one.
    var pricing: ModelPricingFact?

    init(familyId: String? = nil,
         canonicalId: String? = nil,
         displayName: String? = nil,
         pricing: ModelPricingFact? = nil) {
        self.familyId = familyId
        self.canonicalId = canonicalId
        self.displayName = displayName
        self.pricing = pricing
    }
}

/// THE SEAM. Everything the picker knows that `permitted` does not.
///
/// `.none` is the live value today and must stay a first-class state, not a degraded one: the
/// picker is fully usable with it (you can still choose a model and a provider and commit), it
/// simply groups under one heading and publishes no prices.
///
/// Injected as a plain value rather than fetched here, for the reason `SettingsRolesSection`'s
/// header already gives about `values`: the daemon is the side that holds and validates the
/// catalog, so when this data lands it lands as a payload, and a picker that derived families
/// app-side would be wrong the first time the SDK's catalog moved (which happens on an SDK bump,
/// with no app release).
struct ModelCatalogFacts: Equatable, Sendable {
    /// Keyed by the FULL provider-qualified tag, because pricing and family are both per-row facts
    /// and two providers' copies of one model are two rows.
    var byTag: [String: ModelCatalogFact]
    /// An EXPLICIT family order, when someone has one to state. Usually empty — **the catalog has
    /// no canonical family order** (it sorts by id, and an id is not a label), so the order down
    /// the left column is Winter's policy, not data. That policy is `roleModelFamilyOrdering`.
    var familyOrder: [String]
    /// Family id → its facing name. The label is NOT derivable from the id, so a family with no
    /// entry here renders under its id: plainer, never wrong.
    var familyNames: [String: String]
    /// How the vendor charges for the credential Winter actually uses, per provider
    /// (`WinterProviderDescriptor.pricingBasis`: `token` | `subscription` | `free`). It OVERRIDES
    /// any per-token number, because the catalog says in as many words that a subscription row's
    /// published list prices do not describe what that credential is billed.
    var providerPricingBasis: [String: String]
    /// Provider id → its credential door and the daemon's readiness boolean (`models.catalog`'s
    /// `providers`). Absent for a provider means "not told", which renders as no credential state.
    var providerCredentials: [String: ProviderCredentialFact]

    init(byTag: [String: ModelCatalogFact] = [:],
         familyOrder: [String] = [],
         familyNames: [String: String] = [:],
         providerPricingBasis: [String: String] = [:],
         providerCredentials: [String: ProviderCredentialFact] = [:]) {
        self.byTag = byTag
        self.familyOrder = familyOrder
        self.familyNames = familyNames
        self.providerPricingBasis = providerPricingBasis
        self.providerCredentials = providerCredentials
    }

    /// Told nothing. Still a fully usable picker — and the exact state a daemon that predates
    /// `models.catalog` leaves it in.
    static let none = ModelCatalogFacts()

    var hasFamilies: Bool { !familyOrder.isEmpty || byTag.values.contains { $0.familyId != nil } }
}

// MARK: - The wire → the seam

/// PURE: `models.catalog` → the seam. Readiness comes off the catalog's own provider rows
/// (`credentialPresent`); nothing else is read or joined.
///
/// The ONE place the payload becomes app facts, so every rule below is testable without a socket.
///
/// **`familyOrder` is deliberately left EMPTY.** The catalog ships no canonical family order — it
/// sorts by id, and an id is not a label — so copying the array's incidental order here would make
/// the catalog's accident into Winter's policy by the back door, and the column would silently
/// rearrange itself on an SDK bump. The order is `roleModelFamilyOrdering`'s, and only its.
///
/// The whole catalog lands in `byTag` (~618 rows). That is a lookup table, not a list: nothing
/// iterates it to build options — the offerable set is `permitted` and nothing else, forever.
func modelCatalogFacts(_ catalog: ModelsCatalog) -> ModelCatalogFacts {
    var byTag: [String: ModelCatalogFact] = [:]
    byTag.reserveCapacity(catalog.models.count)
    for model in catalog.models {
        byTag[model.tag] = ModelCatalogFact(
            familyId: model.familyId,
            canonicalId: model.canonicalModelId,
            // The catalog carries no FACING name for a model, only ids — so the label is the
            // canonical model id, which is the merged row's own identity and is provider-neutral.
            // The alternative (the first tag's model portion) labels a row that several providers
            // serve with whichever provider happened to come first on the wire.
            displayName: model.canonicalModelId,
            pricing: model.pricing.map { p in
                ModelPricingFact(inputPerMTokUsd: p.inputPerMTokUsd,
                                 outputPerMTokUsd: p.outputPerMTokUsd,
                                 // Daemon-COMPUTED, and the only thing that makes a number
                                 // quotable. Never inferred from the presence of digits.
                                 costBasis: model.costBasis,
                                 cacheReadPerMTokUsd: p.cacheReadPerMTokUsd,
                                 cacheWritePerMTokUsd: p.cacheWritePerMTokUsd,
                                 source: p.source,
                                 confidence: p.confidence,
                                 observedAt: p.observedAt,
                                 sourceRef: p.sourceRef)
            }
        )
    }

    var familyNames: [String: String] = [:]
    for family in catalog.families { familyNames[family.id] = family.displayName }

    var basis: [String: String] = [:]
    var credentialsByProvider: [String: ProviderCredentialFact] = [:]
    for provider in catalog.providers {
        if let pricingBasis = provider.pricingBasis { basis[provider.id] = pricingBasis }
        credentialsByProvider[provider.id] =
            ProviderCredentialFact(credentialDoor: provider.credentialDoor,
                                   credentialPresent: provider.credentialPresent)
    }

    return ModelCatalogFacts(byTag: byTag,
                             familyOrder: [],
                             familyNames: familyNames,
                             providerPricingBasis: basis,
                             providerCredentials: credentialsByProvider)
}

// MARK: - The one thing in this file that reads a daemon

/// Holds the seam for the session. Everything ABOVE is pure; this is the only part with a socket
/// behind it, and it exists because `models.catalog` is ~134 KB of compiled-in, immutable catalog
/// data — read it once, keep it, never re-read it per keystroke.
///
/// **LAZY: nothing loads until a picker actually opens.** Settings is opened far more often than a
/// model is changed, and 134 KB on every visit to buy a table nobody looked at is a bad trade.
///
/// **`static let shared` is a bridge, and a narrow one.** `SettingsSectionView`
/// (`AppShell/SettingsSurface.swift`) already holds the whole `DashboardWiring` and constructs
/// `SettingsRolesSection(loader:writer:)` — one more argument there would make this an ordinary
/// injected dependency, and that file was not this change's to edit. Everything needed for the swap
/// is already in place: the type is fully injectable (`init(catalog:)`), the section
/// takes it as a parameter, and the shared instance is only its DEFAULT. One `catalog:` argument at
/// that call site retires the singleton.
@MainActor
final class ModelCatalogFactsModel: ObservableObject {
    typealias CatalogLoader = () async throws -> ModelsCatalog

    /// Configured once by `AppDelegate.makeDashboardWiring` from the same closures it puts on the
    /// wiring, so the two can never name different daemons.
    static let shared = ModelCatalogFactsModel()

    @Published private(set) var facts: ModelCatalogFacts = .none

    private var catalog: CatalogLoader?
    /// True once the question is ANSWERED — including answered "this daemon has no such method".
    /// A real failure (a dead socket, a timeout) deliberately does NOT settle it, so the next time
    /// a picker opens it asks again.
    private var settled = false
    private var loading = false

    /// Whether a load would do anything. False with no wiring, which is a state the picker renders
    /// exactly as it renders an old daemon: `.none`, honestly.
    var isWired: Bool { catalog != nil }

    init(catalog: CatalogLoader? = nil) {
        self.catalog = catalog
    }

    /// Point it at a daemon. Re-configuring drops whatever was cached: a new wiring is a new
    /// connection, and a catalog read from the previous one is not a fact about this one.
    func configure(catalog: CatalogLoader?) {
        self.catalog = catalog
        self.settled = false
        self.facts = .none
    }

    /// Called when a picker opens. Idempotent, single-flight, and silent about every failure —
    /// this is a table that makes the picker nicer, never one it needs. Anything that goes wrong
    /// leaves `.none`, which is a fully usable picker.
    func loadIfNeeded() async {
        guard !settled, !loading, let catalog else { return }
        loading = true
        defer { loading = false }
        do {
            let payload = try await catalog()
            facts = modelCatalogFacts(payload)
            settled = true
        } catch {
            // `-32601` is the EXPECTED answer from a daemon that predates the method, exactly as it
            // is for the other settings-surface reads. It is an answer, so it settles: re-asking a
            // daemon that has already said it does not know the method just costs round trips.
            if isMethodNotFoundError(error) { settled = true }
        }
    }

}

// MARK: - Pricing, classified before it is formatted

/// PURE: what we can honestly say about one provider+model pair's price. Four cases, and only one
/// of them carries numbers.
///
/// Split from its own text so the RULE is testable independently of the wording: "never render 0 or
/// a guess as a price" is enforced here, at construction, and no formatter can undo it.
enum RolePricing: Equatable, Sendable {
    /// Real list prices, USD per million tokens.
    case published(inputPerMTokUsd: Double, outputPerMTokUsd: Double)
    /// The credential is a seat, not a meter. Any per-token number the catalog carries for this row
    /// describes its API twin, not this login.
    case subscription
    /// The provider charges nothing for this.
    case free
    /// We were told nothing, or we were told a placeholder.
    case notPublished
}

/// The cost bases a number may be QUOTED under. An allowlist of one, deliberately.
///
/// `costBasis` is COMPUTED, not copied: `"list"` is asserted only when the figure came from an
/// official published document. A price Winter INFERRED still reports `"unknown"` while carrying
/// real, plausible numbers — so "has numbers" and "may be shown as the price" are different
/// questions, and only this constant answers the second. A basis a later catalog adds is not
/// quotable until someone adds it here on purpose.
let rolePricingQuotableCostBases: Set<String> = ["list"]

/// PURE: the classification, in the order the catalog's own rules impose.
///
/// 1. **Provider basis first.** `subscription` and `free` are statements about the CREDENTIAL,
///    joined by PROVIDER (it is a provider field, never a model one), and they override any list
///    price on the row — the catalog is explicit that a per-token number for a seat "is not a
///    smaller error than no number, it is a wrong one that reads as authoritative". This is not a
///    corner: the default Codex model is priced this way by policy.
/// 2. **Only a `list` basis may be quoted.** Everything else, `"unknown"` included, is a number
///    nobody published — an unpriced model reports `0`/`"unknown"`, and an inferred one reports
///    real digits under the same `"unknown"`. Both are `.notPublished`.
/// 3. **A bare 0/0 is also not a price**, even under a quotable basis. Free is said by the
///    provider's basis, never inferred from two zeroes — a row that zeroed out because its evidence
///    was missing is indistinguishable from one that is genuinely free, and of the two readings
///    only one is safe.
func rolePricing(_ pricing: ModelPricingFact?, providerBasis: String?) -> RolePricing {
    switch providerBasis {
    case "subscription": return .subscription
    case "free": return .free
    default: break
    }
    guard let pricing else { return .notPublished }
    guard rolePricingQuotableCostBases.contains(pricing.costBasis) else { return .notPublished }
    guard pricing.inputPerMTokUsd != 0 || pricing.outputPerMTokUsd != 0 else { return .notPublished }
    return .published(inputPerMTokUsd: pricing.inputPerMTokUsd,
                      outputPerMTokUsd: pricing.outputPerMTokUsd)
}

/// The sentence a provider row shows when there is no price to show. Deliberately about the
/// PUBLISHER, not about us: Winter is not withholding anything, the catalog carries no figure.
///
/// **THIS IS THE ORDINARY ROW, not the sad one.** Roughly 18 of ~618 catalog rows are priced, and
/// the model most users are looking at (the default Codex one) is unpriced by policy. So it is
/// worded as a settled fact and drawn in the same muted caption every other secondary line on this
/// surface uses — never a spinner, never a warning colour, never an ellipsis that would read as a
/// figure still loading. A priced row is the EXCEPTION layered on top of this one.
let rolePricingNotPublishedText = "Pricing not published"

/// PURE: one USD amount. Two decimals for anything a dollar or over, three when the third is
/// significant — a sub-cent-per-million figure rounded to two decimals reads as free.
func rolePriceAmountText(_ usd: Double) -> String {
    let three = String(format: "%.3f", usd)
    return "$" + (three.hasSuffix("0") ? String(format: "%.2f", usd) : three)
}

/// PURE: the price line under a provider's name. The unit is spelled out on every row rather than
/// once in a header, because these rows are read one at a time.
func rolePricingText(_ pricing: RolePricing) -> String {
    switch pricing {
    case let .published(input, output):
        return "\(rolePriceAmountText(input)) in / \(rolePriceAmountText(output)) out per 1M tokens"
    case .subscription:
        return "Included in the plan — no per-token price"
    case .free:
        return "Free"
    case .notPublished:
        return rolePricingNotPublishedText
    }
}

// MARK: - Where a price came from (the disclosure, never the row)

/// The disclosure's own label. A question, because that is what a user clicking it is asking.
let roleProvenanceDisclosureTitle = "Where this price comes from"

/// PURE: the one-line attribution above the prose — `source · confidence · observed date`, with
/// whichever parts the catalog stated. Nil when it stated none.
func rolePricingAttributionText(_ pricing: ModelPricingFact?) -> String? {
    guard let pricing else { return nil }
    var parts: [String] = []
    if let source = pricing.source { parts.append(source) }
    if let confidence = pricing.confidence { parts.append("\(confidence) confidence") }
    if let observedAt = pricing.observedAt { parts.append("observed \(observedAt)") }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

/// PURE: the cache rates, when the catalog publishes any. Inside the disclosure only — the row's
/// price line answers "what does a turn cost", and a cache rate is a footnote to that.
///
/// A missing rate is NOT zero and is simply not mentioned; `rolePriceAmountText` keeps the third
/// decimal these figures usually need.
func rolePricingCacheText(_ pricing: ModelPricingFact?) -> String? {
    guard let pricing else { return nil }
    var parts: [String] = []
    if let read = pricing.cacheReadPerMTokUsd { parts.append("\(rolePriceAmountText(read)) cache read") }
    if let write = pricing.cacheWritePerMTokUsd { parts.append("\(rolePriceAmountText(write)) cache write") }
    return parts.isEmpty ? nil : parts.joined(separator: " / ") + " per 1M tokens"
}

/// PURE: whether this row has provenance to disclose at all.
///
/// Gated on the price being SHOWN, not merely carried: provenance under a figure the row refuses to
/// quote would be evidence for a number nobody can see, which reads as Winter withholding a price.
func roleHasProvenance(_ pricing: ModelPricingFact?, classified: RolePricing) -> Bool {
    guard case .published = classified else { return false }
    return pricing?.sourceRef?.isEmpty == false
}

// MARK: - Credential state: readiness from the daemon, the FLOW from the door

/// Which fix a not-ready provider points at — derived from `credentialDoor`, never a provider id.
enum RoleCredentialFlow: Equatable, Sendable {
    /// `keychain`: a key in Settings → Providers.
    case providersSettings
    /// `console-profile`: `winter login --anthropic-console`. Never "add a key" — there is none.
    case consoleLogin
}

/// PURE: what we may honestly say about whether a provider is ready to run.
///
/// Four cases, and **two of them render nothing at all** — which is the point of having four.
enum RoleProviderCredentialState: Equatable, Sendable {
    /// The daemon says `credentialPresent: true`.
    case ready(RoleCredentialFlow)
    /// The daemon says `credentialPresent: false`. The ONLY state that may say "not set up".
    case missing(RoleCredentialFlow)
    /// `none` door. This daemon stores no credential for the provider — so there is no credential
    /// state to show, whatever the boolean says, and showing one would invent a problem with no fix.
    case notApplicable
    /// Not told: no catalog row, a daemon that predates `credentialPresent`, or a door this build
    /// does not know. Renders nothing.
    case unknown
}

/// PURE: the fix a door points at — nil for `none` and for any door this build does not know.
func roleCredentialFlow(door: String?) -> RoleCredentialFlow? {
    switch door {
    case "keychain": return .providersSettings
    case "console-profile": return .consoleLogin
    default: return nil
    }
}

/// PURE: the state for one provider. **Readiness is `credentialPresent` and nothing else** — no
/// `credential.list`, no slot id. The door is consulted FIRST, because a door can void the
/// boolean: `none` reports `false` on every daemon (it stores nothing to be present), and would
/// otherwise render "not set up" on rows nobody can fix. A door this build does not know may be
/// the same kind, so readiness is stated only for a door whose fix we can name.
func roleProviderCredentialState(providerId: String,
                                 facts: ModelCatalogFacts) -> RoleProviderCredentialState {
    guard let fact = facts.providerCredentials[providerId] else { return .unknown }
    if fact.credentialDoor == "none" { return .notApplicable }
    guard let flow = roleCredentialFlow(door: fact.credentialDoor),
          let present = fact.credentialPresent else { return .unknown }
    return present ? .ready(flow) : .missing(flow)
}

let roleCredentialStoredText = "Key stored"
let roleCredentialMissingText = "No key stored — add one in Settings → Providers"
let roleCredentialConsoleReadyText = "Signed in to the Anthropic Console"
/// Never "add a key": there is no key to add. The door is the Console login.
///
/// Plain text, no backticks: this string reaches `Text` as a VARIABLE, and only a literal is parsed
/// as Markdown — a backtick here would render as a backtick.
let roleCredentialConsoleMissingText =
    "Not signed in to the Anthropic Console — sign in with: winter login --anthropic-console"

/// PURE: the credential line under a provider's name, or nil for the two states that must stay
/// silent (`notApplicable`, `unknown`).
func roleCredentialNote(_ state: RoleProviderCredentialState) -> String? {
    switch state {
    case .ready(.providersSettings): return roleCredentialStoredText
    case .ready(.consoleLogin): return roleCredentialConsoleReadyText
    case .missing(.providersSettings): return roleCredentialMissingText
    case .missing(.consoleLogin): return roleCredentialConsoleMissingText
    case .notApplicable, .unknown: return nil
    }
}

// MARK: - Step one: families and their models

/// One model in step one — a MODEL, not a provider's copy of one, which is why `providerIds` is a
/// list.
struct RoleModelOption: Identifiable, Equatable, Sendable {
    /// The grouping key: the catalog's canonical model id when we have one, else the tag's model
    /// portion. Identity for the picker, never sent on the wire.
    let id: String
    let label: String
    /// Every permitted tag for this model, in the wire's own provider order.
    let tags: [String]
    /// The providers that can serve it, same order.
    let providerIds: [String]
    /// The same providers by their FACING names — what step one's summary line shows, so the two
    /// steps call a provider the same thing (step two has always shown `displayName`, and a
    /// summary reading "codex-oauth · openai" over a list reading "Codex · OpenAI" is two
    /// vocabularies for one fact).
    let providerNames: [String]
}

/// One heading in step one's left column.
struct RoleModelFamilyGroup: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let models: [RoleModelOption]
}

/// The heading everything sits under when no family data has arrived. One honest group, not a
/// pretence at families.
let roleModelAllModelsGroupTitle = "All models"

/// The trailing group: models the catalog puts in its reserved `other` bucket, and models we were
/// told nothing about. Only used when there IS family data — otherwise there is one group and this
/// title would be a lie about the rest.
let roleModelOtherFamilyTitle = "Other"

/// PURE: the key one tag groups under in step one.
func roleModelKey(for tag: String, facts: ModelCatalogFacts) -> String {
    facts.byTag[tag]?.canonicalId ?? modelIdPortion(of: tag)
}

/// PURE: `permitted` → step one's left column and its lists.
///
/// With no family data: exactly one group, `roleModelAllModelsGroupTitle`, holding every model in
/// the wire's own order. With family data: `facts.familyOrder` first, then any family named on a
/// row but absent from that order in first-appearance order, then one trailing `Other` group for
/// the catalog's `other` bucket and for rows with no family at all.
///
/// A model that several providers serve appears ONCE, at the position of its first tag, with every
/// provider recorded on it — which is precisely what makes step two a real second step rather than
/// a one-row formality.
func roleModelFamilyGroups(_ permitted: [ModelRolePermittedProvider],
                           facts: ModelCatalogFacts = .none) -> [RoleModelFamilyGroup] {
    // One pass over the wire order, folding a model's providers together.
    var keyOrder: [String] = []
    var labels: [String: String] = [:]
    var tags: [String: [String]] = [:]
    var providers: [String: [String]] = [:]
    var providerNames: [String: [String]] = [:]
    var familyOf: [String: String?] = [:]
    for provider in permitted {
        for tag in provider.models {
            let key = roleModelKey(for: tag, facts: facts)
            if tags[key] == nil {
                keyOrder.append(key)
                tags[key] = []
                providers[key] = []
                providerNames[key] = []
                labels[key] = facts.byTag[tag]?.displayName ?? modelIdPortion(of: tag)
                familyOf[key] = facts.byTag[tag]?.familyId
            }
            tags[key]?.append(tag)
            // A provider listing the same model twice would otherwise appear twice in step two.
            if providers[key]?.contains(provider.providerId) == false {
                providers[key]?.append(provider.providerId)
                providerNames[key]?.append(provider.displayName)
            }
            // A later row may know the family when the first did not. Never overwrites a known one.
            if (familyOf[key] ?? nil) == nil { familyOf[key] = facts.byTag[tag]?.familyId }
        }
    }
    func option(_ key: String) -> RoleModelOption {
        RoleModelOption(id: key,
                        label: labels[key] ?? key,
                        tags: tags[key] ?? [],
                        providerIds: providers[key] ?? [],
                        providerNames: providerNames[key] ?? [])
    }

    guard facts.hasFamilies else {
        let models = keyOrder.map(option)
        return models.isEmpty ? [] : [RoleModelFamilyGroup(id: "all",
                                                           title: roleModelAllModelsGroupTitle,
                                                           models: models)]
    }

    // `other` is the catalog's own reserved id for a row no matcher claimed, so it joins the
    // untold rows in the trailing group rather than being listed as a family of its own.
    var byFamily: [String: [RoleModelOption]] = [:]
    var seen: [String] = []
    var leftovers: [RoleModelOption] = []
    for key in keyOrder {
        let model = option(key)
        guard let family = familyOf[key] ?? nil, family != catalogOtherFamilyId else {
            leftovers.append(model)
            continue
        }
        if byFamily[family] == nil {
            byFamily[family] = []
            seen.append(family)
        }
        byFamily[family]?.append(model)
    }
    // Only families with at least one offerable model are listed — an empty heading is a promise
    // the right-hand column cannot keep.
    var groups = roleModelFamilyOrdering(seen,
                                         explicit: facts.familyOrder,
                                         names: facts.familyNames)
        .compactMap { family -> RoleModelFamilyGroup? in
            guard let models = byFamily[family], !models.isEmpty else { return nil }
            return RoleModelFamilyGroup(id: family,
                                        title: facts.familyNames[family] ?? family,
                                        models: models)
        }
    if !leftovers.isEmpty {
        // `other` is a REAL family the catalog ships (~149 rows resolve to it), so when the catalog
        // named it, that name is what the heading says. The fallback covers the other occupant of
        // this group: rows we were told nothing about.
        groups.append(RoleModelFamilyGroup(id: catalogOtherFamilyId,
                                           title: facts.familyNames[catalogOtherFamilyId]
                                                ?? roleModelOtherFamilyTitle,
                                           models: leftovers))
    }
    return groups
}

/// The catalog's family id for a model no matcher claims.
///
/// **It is a REAL, shipped family** — `models.catalog` lists it among the families in use and ~149
/// of the 618 rows resolve to it — not a client-side fallback. It gets a curated facing name from
/// the catalog like any other. What makes it special is only its PLACE: a bucket named "everything
/// else" belongs at the end of a list, never sorted into the middle of it alphabetically.
let catalogOtherFamilyId = "other"

/// PURE: **WINTER'S OWN family order. This is our policy, not the catalog's.**
///
/// The catalog states no canonical order — it sorts families by id, and an id is not a label
/// ("gpt" sorts nowhere near "GPT-5"), so any order the left column shows is a choice this app is
/// making. It is written here, once, so that choice has a name and a place to be argued with:
///
/// - an EXPLICIT order, if a caller ever states one, wins for the families it names;
/// - everything else is alphabetical by FACING NAME (case- and locale-insensitively), because that
///   is the string the user is actually reading down the column;
/// - a family with no facing name sorts under its id, which is what it will be displayed as;
/// - **`other` always goes LAST**, whoever asks for otherwise. It is a real catalog family, but it
///   is the "everything else" one, and the catalog gives it a facing name that would otherwise sort
///   it into the middle of the column ("Other models" lands between Gemini and Qwen). An explicit
///   order cannot pin it either — a bucket is not a peer of the families it is the remainder of.
///
/// Deliberately NOT "most models first" or "cheapest first": both would reorder the column when a
/// catalog refresh moved a row, and a list that rearranges itself between two openings is a list
/// nobody can learn.
func roleModelFamilyOrdering(_ families: [String],
                             explicit: [String] = [],
                             names: [String: String] = [:]) -> [String] {
    let listed = families.filter { $0 != catalogOtherFamilyId }
    let pinned = explicit.filter { listed.contains($0) }
    let rest = listed.filter { !pinned.contains($0) }
        .sorted { (names[$0] ?? $0).localizedCaseInsensitiveCompare(names[$1] ?? $1) == .orderedAscending }
    return pinned + rest + (families.contains(catalogOtherFamilyId) ? [catalogOtherFamilyId] : [])
}

// MARK: - Step two: the providers that can serve it

/// One provider row in step two: who serves the model, the exact tag committing it would send, and
/// what we can say about the price.
struct RoleProviderOption: Identifiable, Equatable, Sendable {
    var id: String { providerId }
    let providerId: String
    let displayName: String
    let tag: String
    let pricing: RolePricing
    /// What we may say about readiness — see `RoleProviderCredentialState`. Two of its four cases
    /// are "say nothing", which a plain `Bool` could not express.
    let credential: RoleProviderCredentialState
    /// The raw pricing evidence for THIS pair, carried so the row's disclosure can show the
    /// catalog's prose provenance. Not the row's price — `pricing` above is the verdict.
    let pricingFact: ModelPricingFact?

    init(providerId: String,
         displayName: String,
         tag: String,
         pricing: RolePricing,
         credential: RoleProviderCredentialState = .unknown,
         pricingFact: ModelPricingFact? = nil) {
        self.providerId = providerId
        self.displayName = displayName
        self.tag = tag
        self.pricing = pricing
        self.credential = credential
        self.pricingFact = pricingFact
    }
}

/// PURE: **the tag that gets written — or `nil`, which means the pair is not offerable.**
///
/// **NOTHING IS EVER COMPOSED.** The only strings this picker can commit are the exact ones the
/// daemon listed in `permitted`. The reason is not style: `setModelRole` validates that a value is
/// a well-formed `<provider>/<model>` tag, NOT that any catalog row backs it — so a pair this app
/// stitched together would be ACCEPTED, written into settings, and then fail at session start, a
/// long way from the click that caused it. This picker is the only gate between the two, so a pair
/// it was not handed is a pair it does not offer.
///
/// `nil` therefore has exactly one caller-correct handling: drop the row. Never fall back, never
/// guess, never disable-with-a-tooltip (an option nobody may pick is not information).
func roleModelTag(modelKey: String,
                  providerId: String,
                  permitted: [ModelRolePermittedProvider],
                  facts: ModelCatalogFacts = .none) -> String? {
    guard let provider = permitted.first(where: { $0.providerId == providerId }) else { return nil }
    return provider.models.first { roleModelKey(for: $0, facts: facts) == modelKey }
}

/// PURE: step two's list for one model — every permitted provider that serves it, in the wire's own
/// order, each carrying the exact tag it would commit and its classified price.
///
/// A provider with no exact tag for this model contributes NO ROW (`roleModelTag` → nil). Since
/// every provider here comes from `permitted` in the first place, that branch is unreachable in
/// practice — it is kept as the structural guarantee that no unlisted pair can reach the wire.
func roleProviderOptions(modelKey: String,
                         permitted: [ModelRolePermittedProvider],
                         facts: ModelCatalogFacts = .none) -> [RoleProviderOption] {
    permitted.compactMap { provider in
        guard let tag = roleModelTag(modelKey: modelKey, providerId: provider.providerId,
                                     permitted: permitted, facts: facts)
        else { return nil }
        let fact = facts.byTag[tag]?.pricing
        return RoleProviderOption(
            providerId: provider.providerId,
            displayName: provider.displayName,
            tag: tag,
            pricing: rolePricing(fact,
                                 providerBasis: facts.providerPricingBasis[provider.providerId]),
            credential: roleProviderCredentialState(providerId: provider.providerId, facts: facts),
            pricingFact: fact
        )
    }
}

// MARK: - What a role will accept

/// What the checkmark in the picker is on.
enum RoleModelPickerSelection: Equatable, Sendable {
    /// Nothing is pinned — the role is following its derived default.
    case useDefault
    /// This exact tag was chosen for this role.
    case tag(String)
}

/// PURE: **which row is ticked**, and it is NOT simply "the row whose tag equals `value.model`".
///
/// A role that is not `explicit` reports a model all the same — the DERIVED one, which moves on its
/// own when the default session model changes. Ticking that model's row would say "someone chose
/// this", and it would leave "Use the default" unticked on the very rows that are using the
/// default. The pane's Pinned/Default badge used to make the same distinction visible in the row;
/// the badge is gone (user call, 2026-09-18) and THIS is now the only place it is drawn, which
/// makes the rule more load-bearing than it was, not less.
///
/// So: not explicit (or cleared) → the default row. Explicit → its tag.
func settingsRolePickerSelection(_ value: SettingsRoleValue) -> RoleModelPickerSelection {
    guard value.isExplicit, let model = value.model else { return .useDefault }
    return .tag(model)
}

/// PURE: whether this role may be CLEARED back to its derived default.
///
/// `provider.model` may not: it is the default every other role's default is derived FROM, so there
/// is always one and the daemon refuses a `null` for it outright. Offering the row anyway would be
/// offering a button whose only outcome is an error.
func settingsRoleAllowsClearing(_ role: SettingsModelRole) -> Bool {
    role != .sessionDefault
}

/// PURE: whether the value on a row is a door at all. FOUR reasons it is not, and each is a state
/// the pane already renders honestly: the daemon told us nothing about this role, it named no
/// permitted providers (which means "not told", never "none allowed" — see `SettingsRoleValue`),
/// this app has no write door, or there is nowhere to PRESENT the card.
///
/// `canPresent` is required rather than defaulted on purpose. Since 2026-09-18 the picker is
/// rendered by the shell (`SettingsRolePickerPresenting`), so a pane built without that door — a
/// preview, a test, any future host that forgets to pass it — can genuinely not open one. A
/// defaulted `true` would hide exactly that, leaving a chevron that does nothing when clicked.
func settingsRoleIsPickable(_ value: SettingsRoleValue?, canWrite: Bool, canPresent: Bool) -> Bool {
    guard canWrite, canPresent, let value else { return false }
    return !value.permittedProviders.isEmpty
}

/// Where a failed write's sentence goes.
enum SettingsRoleWriteErrorSink: Equatable, Sendable {
    /// Into the card, under its own rows — where the click that caused it was made.
    case picker
    /// Onto the pane, because the card that made the write is gone. The write outlived it (closing
    /// the card cancels nothing), and a failure nobody is told about is the one outcome that is
    /// never acceptable.
    case pane
}

/// PURE: the sink. Into the card only when the card on screen is the one for the role that was
/// WRITTEN — a card for a different role is somebody else's conversation, and "Couldn't set
/// dispatch" under the titles picker reads as the titles write having failed.
func settingsRoleWriteErrorSink(openRole: SettingsModelRole?,
                                writtenRole: SettingsModelRole) -> SettingsRoleWriteErrorSink {
    openRole == writtenRole ? .picker : .pane
}

/// The picker's own title, per role — the job it is choosing a model for.
func settingsRolePickerTitle(_ role: SettingsModelRole) -> String {
    "Model for \(settingsModelRoleTitle(role).lowercased())"
}

/// The one sentence that keeps the whole list honest. `permitted` is catalog eligibility: a
/// provider appears here whether or not it is set up, so the card says so once; step two's rows
/// then state each provider's readiness where the daemon told us.
let roleModelPickerEligibilityNote =
    "Everything this daemon's catalog allows for this job — a provider listed here may still need setting up."

/// The row that clears a role. Worded as the outcome, not the mechanism.
let roleModelPickerClearTitle = "Use the default"
let roleModelPickerClearDetail = "Follows the default session model, and moves when it does."

// MARK: - Reasoning effort — LIVE since 2026-09-18

/// **THE ONE SWITCH for the per-role effort control. ON.**
///
/// It was built gated OFF because the daemon stored and validated a role's effort while nothing
/// SPENT it, and a control that lets you choose something with no effect is worse than none. The
/// daemon session confirmed the flip condition (origin/main 00642f81): every role's stored effort now
/// reaches its real consumer through one resolver — dispatch, dream, cleaner, research and its
/// fallback, titles, the reviewer — mapped onto the role's CURRENT model at spend time rather than
/// refused, so even a stale effort degrades to "mapped or omitted", never to a broken job.
///
/// The advisor is the exception and needs nothing here: neither SDK's advisor option carries an
/// effort (and the parity rule forbids inventing one), so its `efforts` is `null` whatever its model,
/// and the null-vocabulary rule already renders no control. A null on a model that obviously HAS a
/// vocabulary is correct there, not a bug.
///
/// Still needs the three-argument write door (`SettingsRolesModel.RoleWriter`) wired, or the control
/// stays hidden (`canWriteEffort`). Setting this back to `false` hides every effort surface at once.
let settingsRoleEffortControlEnabled = true

/// Winter-level tiers that are SESSION concepts, refused by `setModelRole` on every role. Never
/// offered, even if a catalog row were to list one.
let roleEffortNeverOffered: Set<String> = ["ultra"]

/// The effort `setModelRole` accepts on any model WITH a vocabulary but that no vocabulary lists.
let roleEffortNone = "none"

/// PURE: the efforts a menu may offer for a vocabulary — **in the row's own order, never sorted**.
///
/// - `nil` (no reasoning block) and `[]` (an empty vocabulary) → nothing.
/// - Otherwise the vocabulary minus `roleEffortNeverOffered`, then `"none"` appended — `"none"` is
///   offered EXACTLY when there is a real vocabulary to offer it beside, and nowhere else. A row
///   whose every entry is filtered away offers nothing (not a lone "none").
/// - A row may LIST `"none"` itself (measured: `deepseek/deepseek-v4-flash` is none/low/high/max). It
///   is then kept in the row's own position and never appended a second time.
func roleEffortOptions(_ efforts: [String]?) -> [String] {
    guard let efforts else { return [] }
    var out: [String] = []
    for effort in efforts where !roleEffortNeverOffered.contains(effort) && !out.contains(effort) {
        out.append(effort)
    }
    guard out.contains(where: { $0 != roleEffortNone }) else { return [] }
    if !out.contains(roleEffortNone) { out.append(roleEffortNone) }
    return out
}

/// What a role's stored effort IS, measured against its current model's vocabulary.
enum RoleEffortSelection: Equatable, Sendable {
    /// None stored: the model's own default applies.
    case modelDefault
    /// Stored, and one of `roleEffortOptions`.
    case valid(String)
    /// Stored, and NOT offerable for this model — a leftover from an earlier model, or a tier this
    /// app never offers. Rendered as a MISMATCH, never as a ticked option.
    case stale(String)
}

/// PURE: the classification. `"none"` counts as valid only where it is offered (a non-empty
/// vocabulary); on a model with no vocabulary every stored value is stale.
func roleEffortSelection(effort: String?, efforts: [String]?) -> RoleEffortSelection {
    guard let effort else { return .modelDefault }
    return roleEffortOptions(efforts).contains(effort) ? .valid(effort) : .stale(effort)
}

/// What the picker draws for effort.
enum RoleEffortControl: Equatable, Sendable {
    /// Nothing at all. The ONLY state while `settingsRoleEffortControlEnabled` is false.
    case hidden
    /// No menu — the model takes no effort setting. `stale` carries a leftover stored effort, which
    /// must still be named as a mismatch (with a way to clear it) rather than vanish.
    case noSetting(stale: String?)
    /// A menu of `options` (row order), with `selection` possibly `.stale`.
    case menu(options: [String], selection: RoleEffortSelection)
}

/// PURE: the whole control decision. Takes `enabled` as a parameter so the tests can drive the
/// rules with the flag both ways; the view passes `settingsRoleEffortControlEnabled`.
///
/// Hidden unless enabled AND an effort can reach the wire AND the role has an EXPLICIT model: an
/// effort-only write must re-send the role's current tag (`model` is required-nullable), and doing
/// that on a DERIVED role would silently pin its model — a side effect nobody asked for.
///
/// Then: `nil` vocabulary → hidden (or a mismatch note if an effort is stored); `[]` (or nothing
/// offerable) → a quiet "takes no effort setting", plus the mismatch if any; otherwise the menu.
func roleEffortControl(enabled: Bool, canWriteEffort: Bool,
                       value: SettingsRoleValue) -> RoleEffortControl {
    guard enabled, canWriteEffort, value.isExplicit, value.model != nil else { return .hidden }
    let options = roleEffortOptions(value.efforts)
    guard !options.isEmpty else {
        // `nil`: no reasoning block — no control at all, unless a leftover must be named.
        guard value.efforts != nil else {
            return value.effort.map { .noSetting(stale: $0) } ?? .hidden
        }
        // `[]` (or nothing offerable): the quiet line — never an empty menu.
        return .noSetting(stale: value.effort)
    }
    return .menu(options: options,
                 selection: roleEffortSelection(effort: value.effort, efforts: value.efforts))
}

/// PURE: the effort to send ALONGSIDE a model change. A different model → `.clear` (a stored
/// effort the new model may not offer must not survive the switch), unless the user explicitly
/// kept it. The same model → `.leave`.
func roleEffortWriteForModelChange(currentModel: String?, newModel: String?,
                                   keepEffort: Bool) -> ModelRoleEffortWrite {
    guard currentModel != newModel, !keepEffort else { return .leave }
    return .clear
}

/// PURE: the effort to send when the user picks one from the menu. `nil` = "Model default".
func roleEffortWriteForChoice(_ choice: String?) -> ModelRoleEffortWrite {
    choice.map { .set($0) } ?? .clear
}

let roleEffortTitle = "Reasoning effort"
let roleEffortModelDefaultTitle = "Model default"
let roleEffortNoSettingText = "This model takes no effort setting."
/// PURE: the mismatch sentence. Names the stored value so the user can see what is wrong.
func roleEffortStaleText(_ effort: String) -> String {
    "Stored effort \u{201C}\(effort)\u{201D} isn't offered by this model"
}

// MARK: - The picker

/// Which half of the two-step flow is on screen. A model KEY rather than a whole option, so the
/// step-two list is always recomputed from the current `permitted` instead of from a snapshot the
/// picker took a while ago.
enum RoleModelPickerStep: Equatable {
    case models
    case providers(modelKey: String)
}

/// The picker itself, wearing `ShellPanelCard` — the same card, the same size, the same place as
/// the library/devices/updates panels and ⌘K, because it is the same kind of thing: a consultation
/// you make and dismiss.
///
/// Every decision it renders comes from the pure functions above; this view holds only which family
/// and which step are showing. It never reads the daemon and never writes: committing calls
/// `onCommit`, which is the owning section's single write path.
struct SettingsRoleModelPicker: View {
    let role: SettingsModelRole
    let value: SettingsRoleValue
    var facts: ModelCatalogFacts = .none
    /// True while a write is in flight — every row goes inert rather than queueing a second write.
    var isWriting: Bool = false
    /// A failed write's sentence, already through `shellPanelErrorText`. Shown INSIDE the card,
    /// because the card is where the action was taken and closing it would hide the news.
    var errorText: String?
    /// `nil` clears the role. Only ever called with `nil` when `settingsRoleAllowsClearing` is true.
    let onCommit: (String?) -> Void
    let onClose: () -> Void
    /// Whether an effort write can reach the daemon (`SettingsRolesModel.canWriteEffort`).
    var canWriteEffort: Bool = false
    /// An effort-only write for the role's CURRENT model. Only reachable from the gated control.
    var onCommitEffort: (ModelRoleEffortWrite) -> Void = { _ in }

    @State private var step: RoleModelPickerStep = .models
    @State private var familyId: String?
    /// Which priced row has its provenance open. ONE at a time (a tag, not a set): the paragraph is
    /// long, and two of them open at once turns the list into a document.
    @State private var expandedProvenanceTag: String?

    private var groups: [RoleModelFamilyGroup] {
        roleModelFamilyGroups(value.permittedProviders, facts: facts)
    }

    private var selectedGroup: RoleModelFamilyGroup? {
        groups.first { $0.id == familyId } ?? groups.first
    }

    private var selection: RoleModelPickerSelection { settingsRolePickerSelection(value) }

    private var effortControl: RoleEffortControl {
        roleEffortControl(enabled: settingsRoleEffortControlEnabled,
                          canWriteEffort: canWriteEffort,
                          value: value)
    }

    var body: some View {
        ShellPanelCard(accessibilityName: settingsRolePickerTitle(role), onClose: onClose) {
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider()
                switch step {
                case .models:
                    effortBar
                    modelsStep
                case let .providers(modelKey):
                    providersStep(modelKey)
                }
                footer
            }
        }
        // THE SEAM CAN LAND WHILE THE CARD IS OPEN. `models.catalog` is read lazily on the click
        // that opens this card, so the facts usually arrive a beat LATER — and a model's key is
        // `roleModelKey`, which is the tag's model portion before they land and the catalog's
        // canonical id after. For a provider whose spelling differs from the canonical id
        // (`openrouter/deepseek/v4-pro` → `deepseek-v4-pro`) the step-two key stops matching
        // anything and the list empties under the user, with a back arrow as the only way out.
        //
        // So: if the arriving facts leave this step with nothing to show, go back a step rather
        // than render an empty card. Step one is always correct, whatever the facts say.
        .onChange(of: facts) { _, updated in
            guard case let .providers(modelKey) = step,
                  roleProviderOptions(modelKey: modelKey,
                                      permitted: value.permittedProviders,
                                      facts: updated).isEmpty
            else { return }
            step = .models
            expandedProvenanceTag = nil
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            if case .providers = step {
                Button {
                    step = .models
                    expandedProvenanceTag = nil
                } label: {
                    Image(systemName: "chevron.backward")
                        .font(Typography.control())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.textSecondary)
                .accessibilityLabel("Back to models")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(headerTitle)
                    .font(Typography.control(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(headerSubtitle)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        // The card's close button lives in this corner; every hosted pane owes it this much room.
        .padding(.trailing, shellOverlayCloseGutter)
    }

    private var headerTitle: String {
        switch step {
        case .models: return settingsRolePickerTitle(role)
        case let .providers(modelKey): return modelLabel(modelKey)
        }
    }

    private var headerSubtitle: String {
        switch step {
        case .models: return settingsModelRoleExplanation(role)
        case .providers: return "Who serves it"
        }
    }

    private func modelLabel(_ modelKey: String) -> String {
        groups.flatMap(\.models).first { $0.id == modelKey }?.label ?? modelKey
    }

    // MARK: Effort (gated — see `settingsRoleEffortControlEnabled`)

    /// Renders NOTHING for `.hidden`, which is the only state while the flag is false.
    @ViewBuilder
    private var effortBar: some View {
        switch effortControl {
        case .hidden:
            EmptyView()
        case let .noSetting(stale):
            VStack(alignment: .leading, spacing: 4) {
                Text(roleEffortNoSettingText)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                if let stale { staleNote(stale) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()
        case let .menu(options, selection):
            HStack(spacing: 10) {
                Text(roleEffortTitle)
                    .font(Typography.control())
                    .foregroundStyle(Theme.textSecondary)
                Spacer(minLength: 8)
                Menu {
                    effortMenuItem(roleEffortModelDefaultTitle, choice: nil,
                                   isSelected: selection == .modelDefault)
                    Divider()
                    ForEach(options, id: \.self) { option in
                        effortMenuItem(option, choice: option, isSelected: selection == .valid(option))
                    }
                } label: {
                    Text(effortMenuLabel(selection))
                        .font(Typography.controlMono())
                        .foregroundStyle(Theme.textPrimary)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(isWriting)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            if case let .stale(stale) = selection {
                staleNote(stale)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
            }
            Divider()
        }
    }

    /// A stale value is NEVER a ticked option: the menu ticks nothing and the label says so.
    private func effortMenuLabel(_ selection: RoleEffortSelection) -> String {
        switch selection {
        case .modelDefault: return roleEffortModelDefaultTitle
        case let .valid(effort): return effort
        case .stale: return "Mismatch"
        }
    }

    @ViewBuilder
    private func effortMenuItem(_ title: String, choice: String?, isSelected: Bool) -> some View {
        Button {
            onCommitEffort(roleEffortWriteForChoice(choice))
        } label: {
            if isSelected { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }

    /// The mismatch line, with the one fix it can offer: clear back to the model's default.
    @ViewBuilder
    private func staleNote(_ stale: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(Typography.caption())
                .foregroundStyle(Theme.textSecondary)
            Text(roleEffortStaleText(stale))
                .font(Typography.caption())
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            Button(roleEffortModelDefaultTitle) { onCommitEffort(.clear) }
                .buttonStyle(.plain)
                .font(Typography.caption(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .disabled(isWriting)
        }
    }

    // MARK: Step one

    private var modelsStep: some View {
        HStack(spacing: 0) {
            familyColumn
            Divider()
            modelColumn
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var familyColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(groups) { group in
                    Button {
                        familyId = group.id
                    } label: {
                        HStack(spacing: 8) {
                            Text(group.title)
                                .font(Typography.body())
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Text("\(group.models.count)")
                                .font(Typography.caption())
                                .foregroundStyle(Theme.textMuted)
                        }
                        .padding(.horizontal, 10)
                        .frame(height: shellSidebarRowHeight)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(ShellSidebarRowStyle(isSelected: group.id == selectedGroup?.id))
                }
                Spacer(minLength: 0)
            }
            .padding(8)
        }
        .frame(width: libraryTabColumnWidth)
    }

    @ViewBuilder
    private var modelColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                if settingsRoleAllowsClearing(role) {
                    pickerRow(title: roleModelPickerClearTitle,
                              detail: roleModelPickerClearDetail,
                              isSelected: selection == .useDefault,
                              showsChevron: false) {
                        onCommit(nil)
                    }
                }
                ForEach(selectedGroup?.models ?? []) { option in
                    pickerRow(title: option.label,
                              detail: providerSummary(option),
                              isSelected: option.tags.contains { selection == .tag($0) },
                              showsChevron: true) {
                        step = .providers(modelKey: option.id)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// The one-line "and who has it" under a model. Names the providers rather than counting them:
    /// at these list sizes the names are shorter than the sentence describing them, and they are
    /// the same names step two will use.
    private func providerSummary(_ option: RoleModelOption) -> String {
        option.providerNames.joined(separator: " · ")
    }

    // MARK: Step two

    @ViewBuilder
    private func providersStep(_ modelKey: String) -> some View {
        let options = roleProviderOptions(modelKey: modelKey,
                                          permitted: value.permittedProviders,
                                          facts: facts)
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(options) { option in
                    providerRow(option)
                }
                Spacer(minLength: 0)
            }
            .padding(8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Step two's row. Not `pickerRow`: it carries a SECOND caption (the credential line, which
    /// wraps rather than truncating — a clipped "no key stored…" is worse than no line) and, on a
    /// priced row, a disclosure for the catalog's prose provenance.
    ///
    /// The disclosure toggle is a SIBLING of the commit button, never nested inside it: a button
    /// inside a button is a coin toss about which one a click reaches, and the wrong side of that
    /// toss writes a setting.
    @ViewBuilder
    private func providerRow(_ option: RoleProviderOption) -> some View {
        let isExpanded = expandedProvenanceTag == option.tag
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Button {
                    onCommit(option.tag)
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.displayName)
                                .font(Typography.body())
                                .lineLimit(1)
                            Text(rolePricingText(option.pricing))
                                .font(Typography.caption())
                                .foregroundStyle(Theme.textMuted)
                                .lineLimit(1)
                            // Absent for `notApplicable` and `unknown` — the two states that must
                            // say nothing. A row with no line here is not a row with a problem.
                            if let note = roleCredentialNote(option.credential) {
                                Text(note)
                                    .font(Typography.caption())
                                    .foregroundStyle(Theme.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 8)
                        if selection == .tag(option.tag) {
                            Image(systemName: "checkmark")
                                .font(Typography.caption())
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(ShellSidebarRowStyle(isSelected: false))
                .disabled(isWriting)

                if roleHasProvenance(option.pricingFact, classified: option.pricing) {
                    Button {
                        expandedProvenanceTag = isExpanded ? nil : option.tag
                    } label: {
                        Image(systemName: isExpanded ? "info.circle.fill" : "info.circle")
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 6)
                            .frame(maxHeight: .infinity)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(roleProvenanceDisclosureTitle)
                }
            }
            if isExpanded { provenance(option) }
        }
    }

    /// The provenance paragraph. **In full and selectable** — `sourceRef` runs to ~1178 characters
    /// and its value is entirely in the disclosures it makes (cache-write rates are under-reported;
    /// batch, fast-lane and geographic modifiers are not folded into the figure above). Truncating
    /// it would leave the number and drop the caveats, which is the one edit that makes it worse
    /// than showing nothing.
    @ViewBuilder
    private func provenance(_ option: RoleProviderOption) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(roleProvenanceDisclosureTitle)
                .font(Typography.caption(.semibold))
                .foregroundStyle(Theme.textSecondary)
            if let attribution = rolePricingAttributionText(option.pricingFact) {
                Text(attribution)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let cache = rolePricingCacheText(option.pricingFact) {
                Text(cache)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let sourceRef = option.pricingFact?.sourceRef {
                Text(sourceRef)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.top, 2)
        .padding(.bottom, 10)
    }

    // MARK: Rows and footer

    @ViewBuilder
    private func pickerRow(title: String,
                           detail: String,
                           isSelected: Bool,
                           showsChevron: Bool,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Typography.body())
                        .lineLimit(1)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textSecondary)
                }
                if showsChevron {
                    Image(systemName: "chevron.forward")
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .disabled(isWriting)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider()
            if let errorText {
                Text(errorText)
                    .font(Typography.caption())
                    .foregroundStyle(Color.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
            }
            Text(isWriting ? "Saving…" : roleModelPickerEligibilityNote)
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.top, errorText == nil ? 8 : 0)
                .padding(.bottom, 10)
        }
    }
}

// MARK: - Presenting the picker at SHELL level (2026-09-18)

/// **Everything the shell needs in order to show this card, and nothing more.**
///
/// The picker used to be an `.overlay` on the settings detail pane, which had two visible costs the
/// user named: the scrim dimmed only the detail area (the settings sidebar stayed lit), and the
/// card's top inset was measured from the pane, so it sat lower than the library/devices/updates
/// panels and ⌘K. It is the same `ShellPanelCard` as those three — it should therefore land in the
/// same rectangle, and the only way to guarantee that is to render it where they render.
///
/// So the pane publishes a REQUEST and the shell renders it (`ShellRootView`). The request carries
/// object references rather than a snapshot, deliberately: the card shows live state — which write
/// is in flight, which sentence a failed write produced, and the repainted `values` a successful
/// one returned — and a struct of copied values would freeze all three at the moment of the click.
/// `SettingsRolePickerHost` is what observes them.
struct SettingsRolePickerRequest {
    let role: SettingsModelRole
    /// The pane's live model: the values, the in-flight flag, the write error, and the write door.
    let roles: SettingsRolesModel
    /// The families/pricing/credential store, observed so facts arriving a beat after the click
    /// reach the open card (`SettingsRoleModelPicker`'s own `onChange(of: facts)` depends on it).
    let catalog: ModelCatalogFactsModel
    /// A directly-injected override for the facts (previews and tests). Nil means "use the store".
    let injectedFacts: ModelCatalogFacts?
    /// The pane's injected values, used only while the model has loaded none — the same fallback
    /// the pane itself applies, carried so the card cannot disagree with the row behind it.
    let fallbackValues: [SettingsModelRole: SettingsRoleValue]

    init(role: SettingsModelRole,
         roles: SettingsRolesModel,
         catalog: ModelCatalogFactsModel,
         injectedFacts: ModelCatalogFacts? = nil,
         fallbackValues: [SettingsModelRole: SettingsRoleValue] = [:]) {
        self.role = role
        self.roles = roles
        self.catalog = catalog
        self.injectedFacts = injectedFacts
        self.fallbackValues = fallbackValues
    }
}

/// Identity, so the shell can animate on it and so a stale close can be refused
/// (`ShellOverlayPresentation.closeRolePicker(ifShowing:)`). The two models compare by IDENTITY —
/// they are the live objects, and "the same pane's model" is the question being asked, not "two
/// models holding equal values".
extension SettingsRolePickerRequest: Equatable {
    static func == (lhs: SettingsRolePickerRequest, rhs: SettingsRolePickerRequest) -> Bool {
        lhs.role == rhs.role
            && lhs.roles === rhs.roles
            && lhs.catalog === rhs.catalog
            && lhs.injectedFacts == rhs.injectedFacts
            && lhs.fallbackValues == rhs.fallbackValues
    }
}

/// The one thing Settings asks of the shell. A protocol rather than the concrete
/// `ShellOverlayPresentation` so this pane depends on the CAPABILITY — and so a pane built without
/// one (previews, tests) is honestly unpickable rather than offering a click that cannot land.
@MainActor
protocol SettingsRolePickerPresenting: AnyObject {
    func openRolePicker(_ request: SettingsRolePickerRequest)
}

/// The shell-level wrapper: it observes what the card renders, so that in-flight and error states
/// still appear INSIDE the card even though the card no longer lives inside the pane.
///
/// Esc lives here rather than on `ShellPanelCard`: adding it to the shared card would change the
/// three existing panels' behaviour, and this change is not about them. A zero-size hidden button
/// with `.cancelAction` is how a SwiftUI view registers Esc with no menu item behind it — the same
/// device `ShellRootView` uses for ⌘K — and because it is rendered only while the card is up, it
/// can never swallow an Esc meant for the composer. `.onExitCommand` is kept as a second path for
/// the case where something in the card holds focus.
struct SettingsRolePickerHost: View {
    let request: SettingsRolePickerRequest
    let onClose: () -> Void

    @ObservedObject private var roles: SettingsRolesModel
    @ObservedObject private var catalog: ModelCatalogFactsModel

    init(request: SettingsRolePickerRequest, onClose: @escaping () -> Void) {
        self.request = request
        self.onClose = onClose
        _roles = ObservedObject(initialValue: request.roles)
        _catalog = ObservedObject(initialValue: request.catalog)
    }

    private var facts: ModelCatalogFacts { request.injectedFacts ?? catalog.facts }

    private var value: SettingsRoleValue? {
        (roles.values.isEmpty ? request.fallbackValues : roles.values)[request.role]
    }

    var body: some View {
        Group {
            if let value {
                SettingsRoleModelPicker(role: request.role,
                                        value: value,
                                        facts: facts,
                                        isWriting: roles.writing,
                                        errorText: roles.writeErrorText,
                                        onCommit: commit,
                                        onClose: onClose,
                                        canWriteEffort: roles.canWriteEffort,
                                        onCommitEffort: commitEffort)
            } else {
                // The role vanished from under an open card (a reply that no longer reports it).
                // Rendering nothing would leave the shell believing a picker is up with no way to
                // dismiss it, so the card closes itself instead.
                Color.clear.onAppear(perform: onClose)
            }
        }
        .background {
            Button("Close the model picker", action: onClose)
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        .onExitCommand(perform: onClose)
    }

    /// The write is a plain `Task`, NOT `.task`: it must outlive this view. Closing the card mid-
    /// write cancels nothing — the write lands, the pane repaints from its reply, and a failure
    /// that arrives after the close is reported on the pane (`SettingsRolesModel.commit`), never
    /// dropped. `onClose` is the shell's identity-checked close, so a reply arriving after another
    /// picker has been opened cannot take that one down.
    ///
    /// A MODEL change carries `effort: null` (rule 5, `roleEffortWriteForModelChange`) so a stored
    /// effort the new model may not offer does not survive the switch. Only reaches the wire when
    /// the three-argument writer is wired — see `SettingsRolesModel.RoleWriter`.
    private func commit(_ tag: String?) {
        let effort = roleEffortWriteForModelChange(currentModel: value?.model, newModel: tag,
                                                   keepEffort: false)
        Task {
            if await roles.commit(request.role, model: tag, effort: effort) { onClose() }
        }
    }

    /// An effort-only write: re-sends the role's CURRENT tag (the wire's `model` is required-
    /// nullable) and keeps the card open, since the model list is still the thing on screen.
    private func commitEffort(_ effort: ModelRoleEffortWrite) {
        guard let model = value?.model else { return }
        Task { _ = await roles.commit(request.role, model: model, effort: effort) }
    }
}
