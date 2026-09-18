import XCTest
import WinterKit
@testable import Winter

/// Settings → Roles' two-step model picker (2026-09-18) — the PURE half.
///
/// Nothing here drives the SwiftUI card (the same posture `ModelPickerTests` and `PolicyMenuTests`
/// take: a `Button` inside a `ScrollView` is not independently unit testable). What IS covered is
/// every decision the card renders, because all of them are pure functions of (`permitted`,
/// `ModelCatalogFacts`) — which is the whole reason the seam has that shape:
///
/// - **tag composition**: there is none, and that is the thing being pinned. Only an exact string
///   out of `permitted` may be committed; an unlisted pair is unofferable.
/// - **family grouping** with and without family data.
/// - **pricing formatting**, unpriced case first — including the two shapes that carry numbers and
///   still may not be quoted (`costBasis: "unknown"`, and a subscription provider).
/// - **which roles allow clearing.**
final class SettingsRolePickerTests: XCTestCase {
    private func provider(_ id: String, _ name: String, _ models: [String]) -> ModelRolePermittedProvider {
        ModelRolePermittedProvider(providerId: id, displayName: name, models: models)
    }

    /// Two providers, one model in common (`gpt-5.6-terra`) — the case that makes step two real.
    private var permitted: [ModelRolePermittedProvider] {
        [
            provider("codex-oauth", "Codex", ["codex-oauth/gpt-5.6-terra", "codex-oauth/gpt-5.6-luna"]),
            provider("openai", "OpenAI", ["openai/gpt-5.6-terra"]),
            provider("anthropic", "Anthropic", ["anthropic/claude-opus-5"]),
        ]
    }

    private func value(_ model: String?,
                       permitted: [ModelRolePermittedProvider]) -> SettingsRoleValue {
        SettingsRoleValue(model: model, isExplicit: model != nil, constraint: "any",
                          permitted: permitted.flatMap(\.models), permittedProviders: permitted)
    }

    // MARK: - The tag

    /// THE rule: the committed string is the daemon's own, character for character.
    func testTheCommittedTagIsTheExactStringFromPermitted() {
        XCTAssertEqual(roleModelTag(modelKey: "gpt-5.6-terra", providerId: "codex-oauth",
                                    permitted: permitted),
                       "codex-oauth/gpt-5.6-terra")
        XCTAssertEqual(roleModelTag(modelKey: "gpt-5.6-terra", providerId: "openai",
                                    permitted: permitted),
                       "openai/gpt-5.6-terra")
    }

    /// **NOTHING IS COMPOSED.** A pair the daemon did not list has no tag and therefore no row:
    /// `setModelRole` validates a tag's SHAPE but not that a catalog row backs it, so a composed
    /// `anthropic/gpt-5.6-terra` would be accepted, written into settings, and fail at session
    /// start — far from the click that caused it. The picker is the only gate, so it offers
    /// nothing it was not handed.
    func testAnUnlistedPairIsNotOfferable() {
        // Anthropic is a real permitted provider; it just does not serve this model.
        XCTAssertNil(roleModelTag(modelKey: "gpt-5.6-terra", providerId: "anthropic",
                                  permitted: permitted))
        // A provider that is not in the list at all.
        XCTAssertNil(roleModelTag(modelKey: "gpt-5.6-terra", providerId: "openrouter",
                                  permitted: permitted))
        // And it reaches no row: step two lists only the two providers that do serve it.
        let options = roleProviderOptions(modelKey: "gpt-5.6-terra", permitted: permitted)
        XCTAssertEqual(options.map(\.providerId), ["codex-oauth", "openai"])
        XCTAssertFalse(options.contains { $0.tag == "anthropic/gpt-5.6-terra" })
        // Every offered tag is one the daemon itself listed.
        let listed = Set(permitted.flatMap(\.models))
        for option in options { XCTAssertTrue(listed.contains(option.tag), option.tag) }
    }

    /// Step two keeps the wire's own provider order, because the wire's order is the daemon's
    /// answer and nothing app-side is better informed.
    func testProviderOptionsKeepTheWireOrder() {
        let reversed: [ModelRolePermittedProvider] = [
            provider("openai", "OpenAI", ["openai/gpt-5.6-terra"]),
            provider("codex-oauth", "Codex", ["codex-oauth/gpt-5.6-terra"]),
        ]
        XCTAssertEqual(roleProviderOptions(modelKey: "gpt-5.6-terra", permitted: reversed)
                        .map(\.providerId),
                       ["openai", "codex-oauth"])
    }

    // MARK: - Family grouping

    /// NO FAMILY DATA — the live state. One group, every model under it, in the wire's order, and
    /// no invented headings: a family is a curated catalog fact, not a dash-separated prefix.
    func testWithNoFamilyDataEveryModelIsUnderOneHeading() {
        let groups = roleModelFamilyGroups(permitted)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].title, roleModelAllModelsGroupTitle)
        XCTAssertEqual(groups[0].models.map(\.id),
                       ["gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-5"])
        XCTAssertEqual(groups[0].models.map(\.label),
                       ["gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-5"])
    }

    /// One model served by two providers is ONE row in step one, carrying both providers — which
    /// is what makes the second step a choice rather than a formality.
    func testAModelServedTwiceAppearsOnce() throws {
        let models = roleModelFamilyGroups(permitted).flatMap(\.models)
        let terra = try XCTUnwrap(models.first { $0.id == "gpt-5.6-terra" })
        XCTAssertEqual(terra.providerIds, ["codex-oauth", "openai"])
        XCTAssertEqual(terra.tags, ["codex-oauth/gpt-5.6-terra", "openai/gpt-5.6-terra"])
        // Step one names providers the way step two does — facing names, not ids.
        XCTAssertEqual(terra.providerNames, ["Codex", "OpenAI"])
        XCTAssertEqual(models.filter { $0.id == "gpt-5.6-terra" }.count, 1)
    }

    /// WITH family data: one group per family, our own ordering, families with no offerable model
    /// omitted, and the catalog's reserved `other` bucket folded into the trailing group along with
    /// anything we were told nothing about.
    func testWithFamilyDataModelsGroupByFamily() {
        let facts = ModelCatalogFacts(
            byTag: [
                "codex-oauth/gpt-5.6-terra": ModelCatalogFact(familyId: "gpt",
                                                              canonicalId: "gpt-5.6-terra",
                                                              displayName: "GPT-5.6 Terra"),
                "openai/gpt-5.6-terra": ModelCatalogFact(familyId: "gpt",
                                                         canonicalId: "gpt-5.6-terra",
                                                         displayName: "GPT-5.6 Terra"),
                "codex-oauth/gpt-5.6-luna": ModelCatalogFact(familyId: "gpt",
                                                             canonicalId: "gpt-5.6-luna",
                                                             displayName: "GPT-5.6 Luna"),
                "anthropic/claude-opus-5": ModelCatalogFact(familyId: catalogOtherFamilyId,
                                                            canonicalId: "claude-opus-5"),
            ],
            familyNames: ["gpt": "GPT", "gemini": "Gemini"]
        )
        let groups = roleModelFamilyGroups(permitted, facts: facts)
        XCTAssertEqual(groups.map(\.title), ["GPT", roleModelOtherFamilyTitle])
        // The catalog's facing name wins over the tag's model portion...
        XCTAssertEqual(groups[0].models.map(\.label), ["GPT-5.6 Terra", "GPT-5.6 Luna"])
        // ...and a row with no facing name falls back to it.
        XCTAssertEqual(groups[1].models.map(\.label), ["claude-opus-5"])
        // A named family nobody serves is not a heading.
        XCTAssertFalse(groups.contains { $0.id == "gemini" })
    }

    /// The canonical id is what makes two providers' spellings ONE row; without it the two would
    /// group apart and step two would have one provider each.
    func testTheCanonicalIdMergesTwoSpellingsOfOneModel() {
        let split: [ModelRolePermittedProvider] = [
            provider("deepseek", "DeepSeek", ["deepseek/deepseek-v4-pro"]),
            provider("openrouter", "OpenRouter", ["openrouter/deepseek/v4-pro"]),
        ]
        XCTAssertEqual(roleModelFamilyGroups(split).flatMap(\.models).count, 2,
                       "with no facts the two spellings are two models, honestly")

        let facts = ModelCatalogFacts(byTag: [
            "deepseek/deepseek-v4-pro": ModelCatalogFact(canonicalId: "deepseek-v4-pro",
                                                         displayName: "DeepSeek V4 Pro"),
            "openrouter/deepseek/v4-pro": ModelCatalogFact(canonicalId: "deepseek-v4-pro",
                                                           displayName: "DeepSeek V4 Pro"),
        ])
        let merged = roleModelFamilyGroups(split, facts: facts).flatMap(\.models)
        XCTAssertEqual(merged.map(\.id), ["deepseek-v4-pro"])
        XCTAssertEqual(roleProviderOptions(modelKey: "deepseek-v4-pro", permitted: split, facts: facts)
                        .map(\.tag),
                       ["deepseek/deepseek-v4-pro", "openrouter/deepseek/v4-pro"],
                       "still the exact listed strings, never a recomposed canonical one")
    }

    /// The order down the left column is WINTER'S policy, not the catalog's — the catalog states
    /// none (it sorts by id, and an id is not a label). Alphabetical by facing name, with an
    /// explicit order winning where one is given, and `other` never pinned into the middle.
    func testFamilyOrderIsOursAndAlphabeticalByFacingName() {
        let names = ["gpt": "GPT", "claude": "Claude", "gemini": "Gemini"]
        XCTAssertEqual(roleModelFamilyOrdering(["gpt", "gemini", "claude"], names: names),
                       ["claude", "gemini", "gpt"])
        XCTAssertEqual(roleModelFamilyOrdering(["gpt", "gemini", "claude"],
                                               explicit: ["gpt"], names: names),
                       ["gpt", "claude", "gemini"])
        // An unnamed family sorts under the id it will be displayed as.
        XCTAssertEqual(roleModelFamilyOrdering(["zephyr", "gpt"], names: names), ["gpt", "zephyr"])
        // `other` is never a pinnable family: it is the trailing bucket.
        XCTAssertEqual(roleModelFamilyOrdering(["gpt"], explicit: [catalogOtherFamilyId, "gpt"],
                                               names: names),
                       ["gpt"])
    }

    func testAnEmptyPermittedListYieldsNoGroups() {
        XCTAssertTrue(roleModelFamilyGroups([]).isEmpty)
        XCTAssertTrue(roleModelFamilyGroups([provider("openai", "OpenAI", [])]).isEmpty)
    }

    // MARK: - Pricing

    /// THE COMMON CASE, tested first because it is what almost every row shows: ~18 of ~618 catalog
    /// rows are priced at all, and the default Codex model is unpriced by policy.
    func testNoPricingSaysSoRatherThanShowingANumber() {
        XCTAssertEqual(rolePricing(nil, providerBasis: nil), .notPublished)
        XCTAssertEqual(rolePricingText(.notPublished), rolePricingNotPublishedText)
        XCTAssertEqual(rolePricingText(rolePricing(nil, providerBasis: "token")),
                       "Pricing not published")
    }

    /// **0 IS NOT A PRICE.** An unpriced model reports `0` with `costBasis: "unknown"`; rendering
    /// that as "$0.00" would tell a user the most expensive model on the list is free.
    func testAnUnpricedRowIsNeverRenderedAsZero() {
        let unpriced = ModelPricingFact(inputPerMTokUsd: 0, outputPerMTokUsd: 0, costBasis: "unknown")
        XCTAssertEqual(rolePricing(unpriced, providerBasis: "token"), .notPublished)
        XCTAssertFalse(rolePricingText(rolePricing(unpriced, providerBasis: "token")).contains("0"))
        XCTAssertFalse(rolePricingText(rolePricing(unpriced, providerBasis: "token")).contains("$"))
    }

    /// `costBasis` is COMPUTED: an INFERRED price carries real numbers and still reports
    /// `"unknown"`, so "has digits" and "may be quoted" are different questions. Only `list` is
    /// quotable.
    func testRealNumbersUnderAnUnknownBasisAreStillNotQuotable() {
        let inferred = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "unknown")
        XCTAssertEqual(rolePricing(inferred, providerBasis: "token"), .notPublished)
        let future = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "estimated")
        XCTAssertEqual(rolePricing(future, providerBasis: "token"), .notPublished,
                       "a basis nobody has allowlisted is not quotable by default")
        XCTAssertEqual(rolePricingQuotableCostBases, ["list"])
    }

    /// A zeroed row under a quotable basis is still not a price — "free" is said by the provider's
    /// basis, never inferred from two zeroes.
    func testTwoZeroesAreNotAPriceEvenUnderAQuotableBasis() {
        let zeroed = ModelPricingFact(inputPerMTokUsd: 0, outputPerMTokUsd: 0, costBasis: "list")
        XCTAssertEqual(rolePricing(zeroed, providerBasis: "token"), .notPublished)
        XCTAssertEqual(rolePricing(zeroed, providerBasis: "free"), .free)
        XCTAssertEqual(rolePricingText(.free), "Free")
    }

    /// `pricingBasis` is a PROVIDER field and it wins: a seat is not billed by the token, so the
    /// list prices published for that model's API twin do not describe this credential.
    func testASubscriptionProviderOverridesAnyListPrice() {
        let priced = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "list")
        XCTAssertEqual(rolePricing(priced, providerBasis: "subscription"), .subscription)
        XCTAssertFalse(rolePricingText(.subscription).contains("$"))
    }

    /// The exception layered on top of the unpriced row: a real, published pair of list prices,
    /// labelled with its unit and never presented as a total or a per-turn cost.
    func testAPublishedPriceRendersBothSidesPerMillionTokens() {
        let priced = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "list")
        XCTAssertEqual(rolePricing(priced, providerBasis: "token"),
                       .published(inputPerMTokUsd: 3, outputPerMTokUsd: 15))
        XCTAssertEqual(rolePricingText(rolePricing(priced, providerBasis: "token")),
                       "$3.00 in / $15.00 out per 1M tokens")
        // Sub-cent figures keep a third decimal rather than rounding to something that reads free.
        XCTAssertEqual(rolePriceAmountText(0.075), "$0.075")
        XCTAssertEqual(rolePriceAmountText(0.15), "$0.15")
        XCTAssertEqual(rolePriceAmountText(1), "$1.00")
    }

    /// Pricing joins per PAIR, not per model: the same model on two providers can price apart, and
    /// the provider's basis is looked up by provider.
    func testPricingIsJoinedPerProviderAndModelPair() {
        let facts = ModelCatalogFacts(
            byTag: [
                "openai/gpt-5.6-terra": ModelCatalogFact(
                    pricing: ModelPricingFact(inputPerMTokUsd: 1.25, outputPerMTokUsd: 10,
                                              costBasis: "list")),
                "codex-oauth/gpt-5.6-terra": ModelCatalogFact(
                    pricing: ModelPricingFact(inputPerMTokUsd: 1.25, outputPerMTokUsd: 10,
                                              costBasis: "list")),
            ],
            providerPricingBasis: ["codex-oauth": "subscription", "openai": "token"]
        )
        let options = roleProviderOptions(modelKey: "gpt-5.6-terra", permitted: permitted, facts: facts)
        XCTAssertEqual(options.first { $0.providerId == "codex-oauth" }?.pricing, .subscription)
        XCTAssertEqual(options.first { $0.providerId == "openai" }?.pricing,
                       .published(inputPerMTokUsd: 1.25, outputPerMTokUsd: 10))
    }

    // MARK: - Clearing, and whether a row is a door at all

    /// `provider.model` may not be cleared: it is the value every other role's default is derived
    /// from, so there is always one and the daemon refuses a `null` outright. Every other role may.
    func testOnlyTheDefaultSessionModelRefusesClearing() {
        XCTAssertFalse(settingsRoleAllowsClearing(.sessionDefault))
        for role in SettingsModelRole.allCases where role != .sessionDefault {
            XCTAssertTrue(settingsRoleAllowsClearing(role), "\(role) should offer clear-to-default")
        }
    }

    /// **A DERIVED value does not tick its own model's row.** A role that is not `explicit` still
    /// reports a model — the derived one, which moves on its own — so ticking it would claim
    /// somebody chose it and would leave "Use the default" unticked on exactly the rows that are
    /// using the default. The tick follows Pinned/Default, not the string.
    func testTheTickFollowsPinnedVersusDefault() {
        let pinned = SettingsRoleValue(model: "openai/gpt-5.6-terra", isExplicit: true,
                                       constraint: "any", permitted: [], permittedProviders: permitted)
        XCTAssertEqual(settingsRolePickerSelection(pinned), .tag("openai/gpt-5.6-terra"))

        let derived = SettingsRoleValue(model: "openai/gpt-5.6-terra", isExplicit: false,
                                        constraint: "any", permitted: [], permittedProviders: permitted)
        XCTAssertEqual(settingsRolePickerSelection(derived), .useDefault)
        XCTAssertNotEqual(settingsRolePickerSelection(derived), .tag("openai/gpt-5.6-terra"))

        let cleared = SettingsRoleValue(model: nil, isExplicit: false, constraint: "any",
                                        permitted: [], permittedProviders: permitted)
        XCTAssertEqual(settingsRolePickerSelection(cleared), .useDefault)
    }

    /// Four reasons a value is not a door, each a state the pane already renders honestly: the
    /// daemon said nothing about the role, it named no providers (which means "not told", never
    /// "none allowed"), this app has no write door, or there is no shell to present the card in.
    func testARowIsOnlyADoorWhenThereIsSomethingToPickSomewhereToWriteAndSomewhereToShowIt() {
        let pickable = value("openai/gpt-5.6-terra", permitted: permitted)
        XCTAssertTrue(settingsRoleIsPickable(pickable, canWrite: true, canPresent: true))
        XCTAssertFalse(settingsRoleIsPickable(nil, canWrite: true, canPresent: true))
        XCTAssertFalse(settingsRoleIsPickable(value("openai/gpt-5.6-terra", permitted: []),
                                              canWrite: true, canPresent: true))
        XCTAssertFalse(settingsRoleIsPickable(pickable, canWrite: false, canPresent: true))
        // The card is rendered by the SHELL now. A pane with no presenter must not offer a
        // chevron that opens nothing.
        XCTAssertFalse(settingsRoleIsPickable(pickable, canWrite: true, canPresent: false))
    }

    /// **A write outlives its card, and its failure is never dropped.** The card is where the news
    /// belongs while it is up; once it is gone (close, scrim, Esc, or another floating surface
    /// taking its place mid-write) the pane is the only surface left that can carry it.
    func testAFailedWriteReportsToItsOwnCardWhileItIsUpAndToThePaneOtherwise() {
        XCTAssertEqual(settingsRoleWriteErrorSink(openRole: .dispatch, writtenRole: .dispatch), .picker)
        XCTAssertEqual(settingsRoleWriteErrorSink(openRole: nil, writtenRole: .dispatch), .pane)
        // Closed mid-write, then another role's card opened: that card is not where this news goes.
        XCTAssertEqual(settingsRoleWriteErrorSink(openRole: .titles, writtenRole: .dispatch), .pane)
    }

    /// The same rule, end to end through the model: close the card while the write is in flight,
    /// let the write fail, and the sentence lands on the PANE — the card's slot stays empty, because
    /// nobody is looking at it.
    @MainActor
    func testClosingTheCardMidWriteMovesTheFailureToThePane() async {
        let gate = WriteGate()
        let model = SettingsRolesModel(loader: { [:] }, writer: { _, _ in
            await gate.wait()
            throw RpcError(code: -32603, message: "refused")
        })
        model.pickerDidOpen(.dispatch)
        let write = Task { await model.commit(.dispatch, model: "openai/gpt-5.6-terra") }
        for _ in 0..<1000 where !model.writing { await Task.yield() }
        XCTAssertTrue(model.writing, "the write is in flight")

        model.pickerDidClose()
        await gate.open()
        let landed = await write.value

        XCTAssertFalse(landed)
        XCTAssertFalse(model.writing, "the in-flight flag is released, not orphaned")
        XCTAssertNil(model.writeErrorText, "the card is gone — nothing may be written into it")
        XCTAssertNotNil(model.errorText, "…so the failure is on the pane instead")
    }

    /// And while the card is up, the failure is the card's — the pane is not where the click was.
    @MainActor
    func testAFailedWriteWithTheCardUpStaysInTheCard() async {
        let model = SettingsRolesModel(loader: { [:] }, writer: { _, _ in
            throw RpcError(code: -32603, message: "refused")
        })
        model.pickerDidOpen(.dispatch)
        let landed = await model.commit(.dispatch, model: "openai/gpt-5.6-terra")
        XCTAssertFalse(landed)
        XCTAssertNotNil(model.writeErrorText)
        XCTAssertNil(model.errorText)

        model.pickerDidClose()
        XCTAssertNil(model.writeErrorText, "a closed card carries no stale sentence into its next opening")
    }

    /// A one-shot latch a test can hold a write open on.
    private actor WriteGate {
        private var isOpen = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func wait() async {
            if isOpen { return }
            await withCheckedContinuation { waiters.append($0) }
        }
        func open() {
            isOpen = true
            waiters.forEach { $0.resume() }
            waiters.removeAll()
        }
    }

    // MARK: - models.catalog → the seam

    private func catalogProvider(_ id: String,
                                 _ name: String,
                                 basis: String? = "token",
                                 slot: String? = nil,
                                 door: String? = "keychain",
                                 present: Bool? = nil) -> CatalogProvider {
        CatalogProvider(id: id, displayName: name, pricingBasis: basis,
                        authKinds: ["api-key"], credentialSlotId: slot, credentialDoor: door,
                        credentialPresent: present)
    }

    /// The whole payload → the seam, in one pass: family NAMES (never ids), the provider's pricing
    /// basis, per-tag pricing evidence with its daemon-computed basis, and the credential doors.
    func testTheMapperTurnsTheCatalogIntoTheSeam() throws {
        let catalog = ModelsCatalog(
            schemaVersion: 2,
            catalogVersion: "v3.8.50+winter.1",
            families: [CatalogFamily(id: "gpt", displayName: "GPT"),
                       CatalogFamily(id: "other", displayName: "Other models")],
            providers: [catalogProvider("openai", "OpenAI", slot: "openai:default"),
                        catalogProvider("codex-oauth", "Codex", basis: "subscription",
                                        slot: "codex-oauth:default")],
            models: [
                CatalogModel(tag: "openai/gpt-5.6-terra", canonicalModelId: "gpt-5.6-terra",
                             providerId: "openai", familyId: "gpt", status: "stable",
                             pricing: CatalogPricing(inputPerMTokUsd: 1.25, outputPerMTokUsd: 10,
                                                     cacheReadPerMTokUsd: 0.125,
                                                     source: "vendor-pricing-page",
                                                     confidence: "high",
                                                     observedAt: "2026-09-01",
                                                     sourceRef: "Cache WRITE rates are under-reported."),
                             costBasis: "list"),
                CatalogModel(tag: "codex-oauth/gpt-5.6-terra", canonicalModelId: "gpt-5.6-terra",
                             providerId: "codex-oauth", familyId: "gpt"),
            ]
        )
        let facts = modelCatalogFacts(catalog)

        XCTAssertEqual(facts.familyNames["gpt"], "GPT")
        XCTAssertEqual(facts.familyNames[catalogOtherFamilyId], "Other models",
                       "`other` is a real catalog family with a curated name")
        XCTAssertTrue(facts.familyOrder.isEmpty,
                      "the catalog states NO family order — copying its array order would make its accident our policy")
        XCTAssertEqual(facts.providerPricingBasis["codex-oauth"], "subscription")

        let terra = try XCTUnwrap(facts.byTag["openai/gpt-5.6-terra"])
        XCTAssertEqual(terra.familyId, "gpt")
        XCTAssertEqual(terra.canonicalId, "gpt-5.6-terra")
        XCTAssertEqual(terra.pricing?.costBasis, "list", "the MODEL's computed basis, not the price's own word")
        XCTAssertEqual(terra.pricing?.cacheReadPerMTokUsd, 0.125)
        XCTAssertEqual(terra.pricing?.confidence, "high")
        XCTAssertEqual(terra.pricing?.sourceRef, "Cache WRITE rates are under-reported.")

        let codex = try XCTUnwrap(facts.byTag["codex-oauth/gpt-5.6-terra"])
        XCTAssertNil(codex.pricing, "600 of 618 rows carry none, and that is the ordinary case")
        XCTAssertEqual(codex.canonicalId, "gpt-5.6-terra", "the same model, so step one shows ONE row")
    }

    /// The catalog names 618 rows and `permitted` names three. **The catalog never widens the
    /// offer**: it only annotates what the daemon already said this role may use.
    func testTheCatalogNeverAddsAnOfferablePair() {
        let catalog = ModelsCatalog(
            providers: [catalogProvider("anthropic", "Anthropic", slot: "anthropic:default")],
            models: [CatalogModel(tag: "anthropic/gpt-5.6-terra", canonicalModelId: "gpt-5.6-terra",
                                  providerId: "anthropic", familyId: "gpt")]
        )
        let facts = modelCatalogFacts(catalog)
        // Anthropic is permitted and the catalog says it serves this model — but `permitted` does
        // not list that pair, so it is not offerable and no row exists for it.
        XCTAssertNil(roleModelTag(modelKey: "gpt-5.6-terra", providerId: "anthropic",
                                  permitted: permitted, facts: facts))
        let options = roleProviderOptions(modelKey: "gpt-5.6-terra", permitted: permitted, facts: facts)
        XCTAssertEqual(options.map(\.providerId), ["codex-oauth", "openai"])
        let listed = Set(permitted.flatMap(\.models))
        for option in options { XCTAssertTrue(listed.contains(option.tag), option.tag) }
    }

    // MARK: - Credential state: readiness off the provider row, the fix from the door

    /// THE TABLE: every door × `credentialPresent` ∈ {true, false, nil}. Readiness is the boolean
    /// and nothing else; the door silences `none` (checked BEFORE the boolean, whose value is
    /// `false` there on every daemon) and otherwise only names the fix.
    func testReadinessIsTheProviderRowsBooleanAndTheDoorOnlyNamesTheFix() {
        let doors: [String?] = ["keychain", "console-profile", "none", "smartcard", nil]
        let presents: [Bool?] = [true, false, nil]
        let expected: [String: RoleProviderCredentialState] = [
            "keychain/true": .ready(.providersSettings),
            "keychain/false": .missing(.providersSettings),
            "keychain/nil": .unknown,
            "console-profile/true": .ready(.consoleLogin),
            "console-profile/false": .missing(.consoleLogin),
            "console-profile/nil": .unknown,
            "none/true": .notApplicable,
            "none/false": .notApplicable,
            "none/nil": .notApplicable,
            // A door this build does not know may void the boolean the way `none` does, so it
            // states nothing — readiness only where the fix can be named.
            "smartcard/true": .unknown,
            "smartcard/false": .unknown,
            "smartcard/nil": .unknown,
            "nil/true": .unknown,
            "nil/false": .unknown,
            "nil/nil": .unknown,
        ]
        for door in doors {
            for present in presents {
                let facts = modelCatalogFacts(ModelsCatalog(providers: [
                    catalogProvider("p", "P", door: door, present: present),
                ]))
                let key = "\(door ?? "nil")/\(present.map { "\($0)" } ?? "nil")"
                XCTAssertEqual(roleProviderCredentialState(providerId: "p", facts: facts), expected[key], key)
            }
        }
        XCTAssertEqual(roleProviderCredentialState(providerId: "nobody", facts: .none), .unknown,
                       "a provider the catalog never mentioned says nothing")
    }

    /// What each state SAYS. Keychain points at Settings → Providers; the Console arm names
    /// `winter login --anthropic-console` and never "add a key"; `none` and `unknown` say nothing.
    func testEachStateRendersItsOwnLineAndTwoRenderNothing() {
        XCTAssertEqual(roleCredentialNote(.ready(.providersSettings)), roleCredentialStoredText)
        let keyMissing = roleCredentialNote(.missing(.providersSettings)) ?? ""
        XCTAssertTrue(keyMissing.contains("Providers"))

        let consoleMissing = roleCredentialNote(.missing(.consoleLogin)) ?? ""
        XCTAssertTrue(consoleMissing.contains("winter login --anthropic-console"))
        XCTAssertFalse(consoleMissing.lowercased().contains("key"), "there is no key to add on the Console arm")
        let consoleReady = roleCredentialNote(.ready(.consoleLogin)) ?? ""
        XCTAssertFalse(consoleReady.lowercased().contains("key"))

        XCTAssertNil(roleCredentialNote(.notApplicable))
        XCTAssertNil(roleCredentialNote(.unknown))
    }

    /// **NO JOIN SURVIVES.** Readiness never depends on a slot id: the same boolean gives the same
    /// answer whether the catalog names a slot, names none (the console arm), or names a slot that
    /// is not `<providerId>:default`. The seam does not even carry a slot any more.
    func testReadinessNeverDependsOnASlotId() {
        for slot in ["anthropic:default", "anthropic:work", nil] as [String?] {
            let facts = modelCatalogFacts(ModelsCatalog(providers: [
                catalogProvider("anthropic", "Anthropic", slot: slot, present: true),
            ]))
            XCTAssertEqual(roleProviderCredentialState(providerId: "anthropic", facts: facts),
                           .ready(.providersSettings), "slot \(slot ?? "nil")")
            XCTAssertEqual(facts.providerCredentials["anthropic"],
                           ProviderCredentialFact(credentialDoor: "keychain", credentialPresent: true))
        }
    }

    /// The state reaches the row it belongs to, per PROVIDER, inside step two.
    func testStepTwoCarriesEachProvidersOwnCredentialState() throws {
        let catalog = ModelsCatalog(providers: [
            catalogProvider("openai", "OpenAI", slot: "openai:default", present: false),
            catalogProvider("codex-oauth", "Codex", basis: "subscription", slot: nil, door: "none",
                            present: false),
        ])
        let facts = modelCatalogFacts(catalog)
        let options = roleProviderOptions(modelKey: "gpt-5.6-terra", permitted: permitted, facts: facts)
        XCTAssertEqual(options.first { $0.providerId == "openai" }?.credential, .missing(.providersSettings))
        XCTAssertEqual(options.first { $0.providerId == "codex-oauth" }?.credential, .notApplicable)
    }

    // MARK: - The store: when it asks again, and when it stops

    /// A tiny counting loader, so "did it ask a second time" is an assertion rather than a guess.
    private final class CallCounter: @unchecked Sendable {
        private(set) var count = 0
        func hit() { count += 1 }
    }

    /// **`-32601` IS AN ANSWER.** A daemon that predates `models.catalog` will not grow it while the
    /// app is open, so the store settles and stops asking — the same posture every other
    /// settings-surface read takes — and the picker keeps running on `.none`.
    @MainActor
    func testAMissingMethodSettlesTheStoreAndLeavesTheFactsEmpty() async {
        let calls = CallCounter()
        let store = ModelCatalogFactsModel(catalog: {
            calls.hit()
            throw RpcError(code: -32601, message: "method not found: models.catalog")
        })

        await store.loadIfNeeded()
        await store.loadIfNeeded()
        XCTAssertEqual(calls.count, 1, "an answered question is not re-asked")
        XCTAssertEqual(store.facts, .none, "…and `.none` is a fully usable picker, not an error state")
    }

    /// A REAL failure (a dead socket, a timeout) is not an answer, so it must NOT settle: the next
    /// time a picker opens, it asks again.
    @MainActor
    func testARealFailureIsRetriedOnTheNextOpen() async {
        let calls = CallCounter()
        let store = ModelCatalogFactsModel(catalog: {
            calls.hit()
            if calls.count == 1 { throw RpcError(code: -32603, message: "boom") }
            return ModelsCatalog(families: [CatalogFamily(id: "gpt", displayName: "GPT")])
        })

        await store.loadIfNeeded()
        XCTAssertEqual(store.facts, .none)
        await store.loadIfNeeded()
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(store.facts.familyNames["gpt"], "GPT")

        await store.loadIfNeeded()
        XCTAssertEqual(calls.count, 2, "settled once it succeeded — the catalog is immutable for a daemon's life")
    }

    /// The readiness boolean lands WITH the catalog, in the one read — there is no second read that
    /// could fail apart from it.
    @MainActor
    func testTheStoreCarriesReadinessStraightOffTheCatalog() async {
        let store = ModelCatalogFactsModel(catalog: {
            ModelsCatalog(providers: [CatalogProvider(id: "openai", displayName: "OpenAI",
                                                      credentialSlotId: "openai:default",
                                                      credentialDoor: "keychain",
                                                      credentialPresent: true)])
        })
        await store.loadIfNeeded()
        XCTAssertEqual(roleProviderCredentialState(providerId: "openai", facts: store.facts),
                       .ready(.providersSettings))
    }

    /// With no wiring at all there is nothing to ask, and that is the same `.none` an old daemon
    /// produces — not a distinct broken state.
    @MainActor
    func testAnUnwiredStoreStaysAtNone() async {
        let store = ModelCatalogFactsModel()
        XCTAssertFalse(store.isWired)
        await store.loadIfNeeded()
        XCTAssertEqual(store.facts, .none)
    }

    // MARK: - `other` is real data, and it goes last

    /// `other` is a REAL family the catalog ships (~149 rows) with its own curated name — which is
    /// precisely why it needs pinning to the tail: "Other models" would otherwise sort into the
    /// middle of the column, and an explicit order could pin it anywhere.
    func testTheOtherFamilyIsNamedByTheCatalogAndAlwaysSortsLast() {
        let names = ["gpt": "GPT", "other": "Other models", "qwen": "Qwen"]
        // Alphabetical by FACING name for the real families — and `other` last, although "Other
        // models" would sort between "GPT" and "Qwen".
        XCTAssertEqual(roleModelFamilyOrdering(["other", "qwen", "gpt"], names: names),
                       ["gpt", "qwen", "other"])
        XCTAssertEqual(roleModelFamilyOrdering(["other", "gpt"], explicit: ["other"], names: names),
                       ["gpt", "other"], "a bucket is not a peer of the families it is the remainder of")

        let facts = ModelCatalogFacts(
            byTag: [
                "codex-oauth/gpt-5.6-terra": ModelCatalogFact(familyId: "gpt", canonicalId: "gpt-5.6-terra"),
                "openai/gpt-5.6-terra": ModelCatalogFact(familyId: "gpt", canonicalId: "gpt-5.6-terra"),
                "codex-oauth/gpt-5.6-luna": ModelCatalogFact(familyId: "gpt", canonicalId: "gpt-5.6-luna"),
                "anthropic/claude-opus-5": ModelCatalogFact(familyId: catalogOtherFamilyId,
                                                            canonicalId: "claude-opus-5"),
            ],
            familyNames: names)
        let groups = roleModelFamilyGroups(permitted, facts: facts)
        XCTAssertEqual(groups.map(\.title), ["GPT", "Other models"],
                       "the catalog's facing name, never the id")
        XCTAssertEqual(groups.last?.id, catalogOtherFamilyId)
    }

    // MARK: - Provenance: on demand, in full, and only under a price we actually show

    /// `sourceRef` is ~1178 characters of prose. It is offered only where it is EVIDENCE — under a
    /// figure the row is actually quoting. Provenance under a price we refuse to show would read
    /// as Winter withholding one.
    func testProvenanceIsOfferedOnlyUnderAPriceTheRowActuallyShows() {
        let ref = "Published list prices. Cache WRITE rates are under-reported and batch, fast-lane and geographic modifiers are not folded in."
        let quotable = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "list",
                                        source: "vendor", confidence: "high", sourceRef: ref)
        XCTAssertTrue(roleHasProvenance(quotable, classified: rolePricing(quotable, providerBasis: "token")))

        // Real numbers, real prose, unquotable basis ⇒ the row shows no price, so it offers no
        // evidence for one.
        let inferred = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "unknown",
                                        source: "inference", confidence: "low", sourceRef: ref)
        XCTAssertFalse(roleHasProvenance(inferred, classified: rolePricing(inferred, providerBasis: "token")))
        // A seat's row shows no per-token price either.
        XCTAssertFalse(roleHasProvenance(quotable, classified: rolePricing(quotable, providerBasis: "subscription")))
        // Priced, but the catalog carried no prose.
        let bare = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "list",
                                    source: "vendor", confidence: "high")
        XCTAssertFalse(roleHasProvenance(bare, classified: rolePricing(bare, providerBasis: "token")))
        XCTAssertFalse(roleHasProvenance(nil, classified: .notPublished))
    }

    /// The disclosure's two derived lines: the attribution, and the cache rates — which never reach
    /// the row itself. A missing cache rate is NOT zero and is simply not mentioned.
    func testTheDisclosureLinesStateOnlyWhatTheCatalogStated() {
        let full = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "list",
                                    cacheReadPerMTokUsd: 0.3, cacheWritePerMTokUsd: 3.75,
                                    source: "vendor-pricing-page", confidence: "high",
                                    observedAt: "2026-09-01")
        XCTAssertEqual(rolePricingAttributionText(full),
                       "vendor-pricing-page · high confidence · observed 2026-09-01")
        XCTAssertEqual(rolePricingCacheText(full), "$0.30 cache read / $3.75 cache write per 1M tokens")

        let readOnly = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "list",
                                        cacheReadPerMTokUsd: 0.075, source: "vendor", confidence: "medium")
        XCTAssertEqual(rolePricingCacheText(readOnly), "$0.075 cache read per 1M tokens")
        XCTAssertEqual(rolePricingAttributionText(readOnly), "vendor · medium confidence")

        let none = ModelPricingFact(inputPerMTokUsd: 3, outputPerMTokUsd: 15, costBasis: "list")
        XCTAssertNil(rolePricingCacheText(none), "no published cache rate is not a rate of 0")
        XCTAssertNil(rolePricingAttributionText(none))
        XCTAssertNil(rolePricingCacheText(nil))

        // The row's own price line never grows any of this.
        XCTAssertEqual(rolePricingText(rolePricing(full, providerBasis: "token")),
                       "$3.00 in / $15.00 out per 1M tokens")
    }

    /// The grouping survives the wire → pane decode with its providers intact — the picker is built
    /// on `permittedProviders`, and a decode that flattened them would leave every row unpickable.
    func testTheDecodeKeepsTheProviderGrouping() {
        let wire: [String: ModelRoleValue] = [
            SettingsModelRole.dispatch.rawValue: ModelRoleValue(
                model: "openai/gpt-5.6-terra", explicit: true, constraint: "any",
                permitted: permitted),
        ]
        let decoded = settingsModelRoleValues(wire)
        XCTAssertEqual(decoded[.dispatch]?.permittedProviders.map(\.providerId),
                       ["codex-oauth", "openai", "anthropic"])
        XCTAssertEqual(decoded[.dispatch]?.permitted.count, 4, "the flat view is unchanged")
    }

    // MARK: - Reasoning effort: built, table-tested, and GATED OFF

    private func effortValue(model: String? = "openai/o4-mini", explicit: Bool = true,
                             effort: String? = nil, efforts: [String]?) -> SettingsRoleValue {
        SettingsRoleValue(model: model, isExplicit: explicit, constraint: "any", permitted: [],
                          effort: effort, effortExplicit: effort != nil, efforts: efforts)
    }

    /// THE FLAG's off-position still means what it always meant: with it false NOTHING renders — for
    /// every shape, stale ones included, and even with a write door wired. The flag itself is ON now
    /// (`testTheEffortControlIsLive`); this pins that switching it back off is a clean kill switch.
    func testOffRendersNothingForAnyShape() {
        let shapes: [SettingsRoleValue] = [
            effortValue(efforts: nil), effortValue(efforts: []),
            effortValue(efforts: ["low", "high"]), effortValue(effort: "high", efforts: ["low"]),
            effortValue(effort: "high", efforts: nil), effortValue(effort: "ultra", efforts: ["low"]),
        ]
        for value in shapes {
            XCTAssertEqual(roleEffortControl(enabled: false, canWriteEffort: true, value: value), .hidden)
        }
    }

    /// Rules 1–3: only what `efforts` lists, IN ITS ORDER (never sorted); `none` appended exactly
    /// when the vocabulary is non-empty; `ultra` never.
    func testOptionsFollowTheRowsOrderAddNoneOnlyBesideARealVocabularyAndNeverUltra() {
        let table: [([String]?, [String])] = [
            (nil, []),
            ([], []),
            (["low", "medium", "high"], ["low", "medium", "high", "none"]),
            (["high", "medium", "low"], ["high", "medium", "low", "none"]),
            (["low", "ultra", "high"], ["low", "high", "none"]),
            (["ultra"], []),
            (["none"], []),
            (["low", "none", "high"], ["low", "none", "high"]),
            (["low", "low"], ["low", "none"]),
        ]
        for (efforts, expected) in table {
            XCTAssertEqual(roleEffortOptions(efforts), expected, "\(String(describing: efforts))")
        }
    }

    /// Rule 4: a stored effort outside the current vocabulary is a MISMATCH, never a selection —
    /// `ultra` and a `none` on a vocabulary-less model included.
    func testAStaleEffortIsAMismatchNeverASelection() {
        let table: [(String?, [String]?, RoleEffortSelection)] = [
            (nil, ["low", "high"], .modelDefault),
            ("low", ["low", "high"], .valid("low")),
            ("none", ["low", "high"], .valid("none")),
            ("medium", ["low", "high"], .stale("medium")),
            ("ultra", ["low", "ultra"], .stale("ultra")),
            ("none", [], .stale("none")),
            ("none", nil, .stale("none")),
            ("high", nil, .stale("high")),
            (nil, nil, .modelDefault),
        ]
        for (effort, efforts, expected) in table {
            XCTAssertEqual(roleEffortSelection(effort: effort, efforts: efforts), expected,
                           "\(effort ?? "nil") on \(String(describing: efforts))")
        }
    }

    /// The whole control, flag ON: `null` → nothing (unless a leftover must be named); `[]` → the
    /// quiet line, never an empty menu; a vocabulary → the menu with its selection; and hidden for
    /// a DERIVED role (an effort write would pin its model) or with no effort-capable writer.
    func testTheControlWithTheFlagOn() {
        func control(_ v: SettingsRoleValue, canWrite: Bool = true) -> RoleEffortControl {
            roleEffortControl(enabled: true, canWriteEffort: canWrite, value: v)
        }
        XCTAssertEqual(control(effortValue(efforts: nil)), .hidden)
        XCTAssertEqual(control(effortValue(effort: "high", efforts: nil)), .noSetting(stale: "high"))
        XCTAssertEqual(control(effortValue(efforts: [])), .noSetting(stale: nil))
        XCTAssertEqual(control(effortValue(effort: "low", efforts: [])), .noSetting(stale: "low"))
        XCTAssertEqual(control(effortValue(efforts: ["ultra"])), .noSetting(stale: nil),
                       "nothing offerable is the quiet line, not an empty menu")
        XCTAssertEqual(control(effortValue(effort: "high", efforts: ["high", "medium", "low"])),
                       .menu(options: ["high", "medium", "low", "none"], selection: .valid("high")))
        XCTAssertEqual(control(effortValue(effort: "xhigh", efforts: ["low", "high"])),
                       .menu(options: ["low", "high", "none"], selection: .stale("xhigh")))
        XCTAssertEqual(control(effortValue(efforts: ["low"]), canWrite: false), .hidden)
        XCTAssertEqual(control(effortValue(explicit: false, efforts: ["low"])), .hidden)
        XCTAssertEqual(control(effortValue(model: nil, efforts: ["low"])), .hidden)
    }

    /// Rule 5: a MODEL change sends `effort: null` unless the user explicitly kept it; the same
    /// model leaves it; a menu choice sets it and "Model default" clears it.
    func testTheEffortThatRidesAlongWithEachWrite() {
        XCTAssertEqual(roleEffortWriteForModelChange(currentModel: "a/x", newModel: "a/y", keepEffort: false), .clear)
        XCTAssertEqual(roleEffortWriteForModelChange(currentModel: "a/x", newModel: "a/y", keepEffort: true), .leave)
        XCTAssertEqual(roleEffortWriteForModelChange(currentModel: "a/x", newModel: "a/x", keepEffort: false), .leave)
        XCTAssertEqual(roleEffortWriteForModelChange(currentModel: "a/x", newModel: nil, keepEffort: false), .clear,
                       "clearing the role moves it to a derived model, so the effort goes too")
        XCTAssertEqual(roleEffortWriteForModelChange(currentModel: nil, newModel: "a/y", keepEffort: false), .clear)
        XCTAssertEqual(roleEffortWriteForChoice("low"), .set("low"))
        XCTAssertEqual(roleEffortWriteForChoice(nil), .clear)
    }

    /// The model's two doors. With the three-argument writer the effort reaches it verbatim; with
    /// only the legacy two-argument writer (today's live wiring) a `.set` is REFUSED rather than
    /// silently dropped, while a model change still lands.
    @MainActor
    func testTheModelRoutesEffortOnlyThroughADoorThatCanCarryIt() async {
        final class Box: @unchecked Sendable { var effort: ModelRoleEffortWrite?; var legacyCalls = 0 }
        let box = Box()
        let full = SettingsRolesModel(loader: { [:] }, roleWriter: { _, _, effort in
            box.effort = effort
            return [:]
        })
        XCTAssertTrue(full.canWriteEffort)
        let cleared = await full.commit(.dispatch, model: "a/y", effort: .clear)
        XCTAssertTrue(cleared)
        XCTAssertEqual(box.effort, .clear)
        let set = await full.commit(.dispatch, model: "a/y", effort: .set("low"))
        XCTAssertTrue(set)
        XCTAssertEqual(box.effort, .set("low"))

        let legacy = SettingsRolesModel(loader: { [:] }, writer: { _, _ in
            box.legacyCalls += 1
            return [:]
        })
        XCTAssertFalse(legacy.canWriteEffort)
        let refused = await legacy.commit(.dispatch, model: "a/y", effort: .set("low"))
        XCTAssertFalse(refused, "a chosen effort that could never reach the daemon is refused, not dropped")
        XCTAssertEqual(box.legacyCalls, 0)
        let modelChange = await legacy.commit(.dispatch, model: "a/y", effort: .clear)
        XCTAssertTrue(modelChange)
        XCTAssertEqual(box.legacyCalls, 1)
    }

    /// The pane decode carries the three effort fields through untouched.
    func testTheDecodeCarriesEffortFields() {
        let decoded = settingsModelRoleValues([
            SettingsModelRole.dream.rawValue: ModelRoleValue(
                model: "xai-oauth/grok-4.5", explicit: true, constraint: "any", permitted: [],
                effort: "high", effortExplicit: true, efforts: ["high", "medium", "low"]),
        ])
        XCTAssertEqual(decoded[.dream]?.effort, "high")
        XCTAssertEqual(decoded[.dream]?.effortExplicit, true)
        XCTAssertEqual(decoded[.dream]?.efforts, ["high", "medium", "low"])
    }

    /// A catalog row can list "none" itself (deepseek-v4-flash: none/low/high/max). It must stay
    /// where the row put it and must not be offered twice.
    func testANoneTheRowListsIsKeptInPlaceAndNeverDuplicated() {
        XCTAssertEqual(roleEffortOptions(["none", "low", "high", "max"]),
                       ["none", "low", "high", "max"])
        XCTAssertEqual(roleEffortOptions(["low", "high", "none"]), ["low", "high", "none"])
        XCTAssertEqual(roleEffortOptions(["low", "medium", "high"]), ["low", "medium", "high", "none"],
                       "an unlisted none is still appended beside a real vocabulary")
    }

    /// The flip condition is met (roles' efforts are spent): the switch is on.
    func testTheEffortControlIsLive() {
        XCTAssertTrue(settingsRoleEffortControlEnabled)
    }

    // MARK: - The effort's OWN picker (2026-09-18)

    /// The comment table is Winter's own copy: every known name has ONE line, and a name the table
    /// does not know — including `ultra` and a provider word we have never seen — gets NOTHING.
    func testTheCommentTableKnowsItsNamesAndInventsNothingForOthers() {
        for name in ["none", "minimal", "low", "medium", "high", "xhigh", "max"] {
            let comment = roleEffortComment(name)
            XCTAssertNotNil(comment, name)
            XCTAssertFalse(comment?.contains("\n") ?? true, "\(name): one line")
            XCTAssertFalse(comment?.isEmpty ?? true, name)
        }
        for unknown in ["ultra", "turbo", "", "High", "extra-high", "default"] {
            XCTAssertNil(roleEffortComment(unknown), "\(unknown) must get no comment")
        }
        // The model-default row has its own line, and it is NOT in the vocabulary table.
        XCTAssertEqual(roleEffortDetailComment(nil), roleEffortModelDefaultComment)
        XCTAssertNil(roleEffortComments[roleEffortModelDefaultTitle])
        XCTAssertEqual(roleEffortDetailComment("low"), roleEffortComment("low"))
        XCTAssertNil(roleEffortDetailComment("turbo"))
        // Generic by rule: no token budgets, no provider names.
        for comment in roleEffortComments.values {
            XCTAssertFalse(comment.lowercased().contains("token"), comment)
            XCTAssertNil(comment.rangeOfCharacter(from: .decimalDigits), comment)
        }
    }

    /// The row's effort door: only on an EXPLICIT model with a real vocabulary (a derived role
    /// would be silently PINNED by the effort-only write's re-sent tag), or with a stale leftover
    /// that must stay visible and clearable. Never for the advisor's `efforts: null`, never
    /// without a writer or a place to present, never with the flag off.
    func testTheRowShowsAnEffortDoorOnlyWhereOneCanLand() {
        func pickable(_ v: SettingsRoleValue?, canWrite: Bool = true, canPresent: Bool = true,
                      enabled: Bool = true) -> Bool {
            settingsRoleEffortIsPickable(v, canWriteEffort: canWrite, canPresent: canPresent,
                                         enabled: enabled)
        }
        XCTAssertTrue(pickable(effortValue(efforts: ["low", "high"])))
        XCTAssertTrue(pickable(effortValue(effort: "xhigh", efforts: ["low", "high"])), "stale on a vocabulary")
        XCTAssertTrue(pickable(effortValue(effort: "high", efforts: nil)), "stale leftover stays clearable")
        XCTAssertTrue(pickable(effortValue(effort: "low", efforts: [])))
        XCTAssertFalse(pickable(effortValue(efforts: nil)), "the advisor's shape: nothing")
        XCTAssertFalse(pickable(effortValue(efforts: [])))
        XCTAssertFalse(pickable(effortValue(efforts: ["ultra"])), "nothing offerable")
        XCTAssertFalse(pickable(effortValue(explicit: false, efforts: ["low"])),
                       "derived: the re-sent tag would pin it")
        XCTAssertFalse(pickable(effortValue(explicit: false, effort: "x", efforts: nil)))
        XCTAssertFalse(pickable(effortValue(model: nil, efforts: ["low"])))
        XCTAssertFalse(pickable(effortValue(efforts: ["low"]), canWrite: false))
        XCTAssertFalse(pickable(effortValue(efforts: ["low"]), canPresent: false))
        XCTAssertFalse(pickable(effortValue(efforts: ["low"]), enabled: false))
        XCTAssertFalse(pickable(nil))
    }

    /// A stale value never reads as a choice — not on the row, not as the card's opening highlight.
    func testAStaleEffortNeverReadsOrOpensAsAChoice() {
        XCTAssertEqual(roleEffortValueLabel(.modelDefault), roleEffortModelDefaultTitle)
        XCTAssertEqual(roleEffortValueLabel(.valid("low")), "low")
        XCTAssertEqual(roleEffortValueLabel(.stale("xhigh")), roleEffortMismatchLabel)
        XCTAssertNotEqual(roleEffortValueLabel(.stale("xhigh")), "xhigh")
        XCTAssertNil(roleEffortInitialHighlight(.modelDefault))
        XCTAssertEqual(roleEffortInitialHighlight(.valid("high")), "high")
        XCTAssertNil(roleEffortInitialHighlight(.stale("high")))
    }

    /// The card's left column is `roleEffortOptions` verbatim — the row's order, `none` once.
    func testTheCardOffersTheRowsOwnOrder() {
        XCTAssertEqual(roleEffortOptions(["none", "low", "high", "max"]), ["none", "low", "high", "max"])
        XCTAssertEqual(roleEffortOptions(["high", "low"]), ["high", "low", "none"])
    }
}
