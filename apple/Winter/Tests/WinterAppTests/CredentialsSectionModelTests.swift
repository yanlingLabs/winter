import XCTest
import WinterKit
@testable import Winter

/// Winter Phase 10b amendment (c), WS-19 acceptance B-6: `CredentialsSectionModel` against
/// `FakeCredentialsClient` — list → rows, save clears the field and refreshes, remove, and the two
/// typed refusals that have to render differently (a `credential_kind_unsupported` shows its DOOR,
/// a `credential_value_invalid` shows a neutral sentence that is not, and cannot be, the value).
/// No `WinterClient`, no socket, no daemon: this model depends on the `CredentialsClient` protocol
/// precisely so it can be driven this way (see `CredentialsSection.swift`'s header).
@MainActor
final class CredentialsSectionModelTests: XCTestCase {
    /// A stand-in for a real key, used wherever a test needs to prove a value did NOT end up
    /// somewhere. Deliberately shaped like W19-14's daemon-side sweep sentinel, for the same
    /// reason: a `contains` assertion is only meaningful against a string nothing else would
    /// plausibly produce.
    private let sentinel = "WS19-SENTINEL-8f2c1d"

    // MARK: - list → rows

    func testRefreshLoadsRowsFromTheClient() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [.success([
            FakeCredentialsClient.row(providerId: "openai", displayName: "OpenAI", present: true),
            FakeCredentialsClient.row(providerId: "deepseek", displayName: "DeepSeek", risk: "review-required"),
        ])]
        let model = CredentialsSectionModel(client: fake)

        await model.refresh()

        XCTAssertEqual(model.rows.map(\.providerId), ["openai", "deepseek"])
        XCTAssertEqual(model.rows.map(\.present), [true, false])
        XCTAssertNil(model.loadErrorText)
    }

    /// The model never fetches in `init` — only `.task`/`refresh()` does (same shape as
    /// `AnthropicAuthSectionModel`, whose tests pin the same property).
    func testInitDoesNotFetch() {
        let fake = FakeCredentialsClient()
        _ = CredentialsSectionModel(client: fake)

        XCTAssertEqual(fake.listCallCount, 0)
    }

    func testRefreshFailureSurfacesAsLoadErrorAndKeepsNoRows() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [.failure(FakeCredentialsClient.SimpleError())]
        let model = CredentialsSectionModel(client: fake)

        await model.refresh()

        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertNotNil(model.loadErrorText)
    }

    /// WS-19 §9 A-4, the model half: an unreadable reply reaches the user as "couldn't load", never
    /// as a silently empty list. The wire half — `list()` THROWING instead of answering `[]` — is
    /// `LiveCredentialsClientTests`; this pins that the model doesn't then swallow it.
    func testAMalformedListReplySurfacesAsCouldntLoadRatherThanAnEmptyList() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [
            .success([FakeCredentialsClient.row(providerId: "openai", present: true)]),
            .failure(CredentialsClientError.malformedListReply),
        ]
        let model = CredentialsSectionModel(client: fake)
        await model.refresh()
        XCTAssertEqual(model.rows.count, 1)

        await model.refresh()

        XCTAssertNotNil(model.loadErrorText)
        XCTAssertTrue(model.loadErrorText?.contains("couldn't load credentials") == true)
    }

    // MARK: - save clears the field + refreshes

    /// The headline behaviour (W19-12: "the key never reaches a log, `UserDefaults`, or the view
    /// after Save — field cleared"). Three things at once, because they are one guarantee: the key
    /// crossed the seam UNMODIFIED, the draft is gone afterward, and the list was re-read so the
    /// row now says "stored".
    func testSaveSendsTheKeyThenClearsTheDraftAndRefreshes() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [
            .success([FakeCredentialsClient.row(providerId: "deepseek", present: false)]),
            .success([FakeCredentialsClient.row(providerId: "deepseek", present: true)]),
        ]
        let model = CredentialsSectionModel(client: fake)
        await model.refresh()
        model.setDraft(sentinel, for: "deepseek")

        await model.save(providerId: "deepseek")

        XCTAssertEqual(fake.setCalls.count, 1)
        XCTAssertEqual(fake.setCalls.first?.providerId, "deepseek")
        XCTAssertEqual(fake.setCalls.first?.apiKey, sentinel, "the key must cross the seam verbatim — never trimmed or normalised")
        XCTAssertEqual(model.draft(for: "deepseek"), "", "the field must be empty once the write lands")
        XCTAssertEqual(fake.listCallCount, 2, "a successful save re-reads the inventory")
        XCTAssertEqual(model.rows.first?.present, true)
        XCTAssertNil(model.errorText)
    }

    /// Whitespace-only is as unsendable as empty — `credential.set` would refuse it
    /// `credential_value_invalid` anyway (W19-4), so the round-trip is never made.
    func testSaveIsBlockedForAnEmptyOrWhitespaceOnlyDraft() async {
        let fake = FakeCredentialsClient()
        let model = CredentialsSectionModel(client: fake)

        await model.save(providerId: "deepseek")
        model.setDraft("   \n", for: "deepseek")
        await model.save(providerId: "deepseek")

        XCTAssertTrue(fake.setCalls.isEmpty)
        XCTAssertFalse(model.canSave("deepseek"))
    }

    /// A failed save KEEPS the draft: the likeliest refusal is a mistyped key, and clearing the
    /// field there would make the user retype a long secret to fix one character.
    func testFailedSaveKeepsTheDraftAndDoesNotRefresh() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [.success([FakeCredentialsClient.row(providerId: "deepseek")])]
        fake.setResult = .failure(FakeCredentialsClient.SimpleError())
        let model = CredentialsSectionModel(client: fake)
        await model.refresh()
        model.setDraft(sentinel, for: "deepseek")

        await model.save(providerId: "deepseek")

        XCTAssertEqual(model.draft(for: "deepseek"), sentinel)
        XCTAssertEqual(fake.listCallCount, 1, "a failed save must not re-read the inventory")
        XCTAssertNotNil(model.errorText)
    }

    // MARK: - remove

    func testRemoveCallsTheClientAndRefreshes() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [
            .success([FakeCredentialsClient.row(providerId: "deepseek", present: true)]),
            .success([FakeCredentialsClient.row(providerId: "deepseek", present: false)]),
        ]
        let model = CredentialsSectionModel(client: fake)
        await model.refresh()

        await model.remove(providerId: "deepseek")

        XCTAssertEqual(fake.removeCalls, ["deepseek"])
        XCTAssertEqual(fake.listCallCount, 2)
        XCTAssertEqual(model.rows.first?.present, false)
        XCTAssertNil(model.errorText)
    }

    /// `removed: false` — nothing was stored — is a SUCCESS (the post-state the user asked for
    /// already holds), so it must not surface as an error.
    func testRemoveOfSomethingNotStoredIsNotAnError() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [.success([FakeCredentialsClient.row(providerId: "deepseek")])]
        fake.removeResult = .success(false)
        let model = CredentialsSectionModel(client: fake)

        await model.remove(providerId: "deepseek")

        XCTAssertNil(model.errorText)
        XCTAssertEqual(fake.listCallCount, 1, "the refresh still runs")
    }

    // MARK: - typed refusals

    /// `credential_kind_unsupported` is the one refusal that carries a destination — the view must
    /// render THAT, since "no" without "go here instead" is the dead end this section exists to
    /// remove. Driven with `cli-oauth` (Codex's door, W19-4).
    func testKindUnsupportedRefusalRendersItsDoor() async {
        let fake = FakeCredentialsClient()
        fake.setResult = .failure(FakeCredentialsClient.refusal(code: "credential_kind_unsupported", door: "cli-oauth"))
        let model = CredentialsSectionModel(client: fake)
        model.setDraft("whatever", for: "codex-oauth")

        await model.save(providerId: "codex-oauth")

        XCTAssertEqual(model.errorText, credentialDoorText("cli-oauth"))
        XCTAssertTrue(model.errorText?.contains("winter login") == true, "the Codex door is the CLI's `winter login`")
    }

    /// A door value this build has never seen still renders a real sentence. Not hypothetical: the
    /// vocabulary already moved once (WS-19 §9 A-1 withdrew `"provider.logout"`), and the inventory
    /// behind it is catalog-derived, so an older app meeting a newer daemon is the normal case.
    /// This is exactly what a closed Swift enum would have swallowed.
    func testKindUnsupportedRefusalWithAnUnknownDoorStillRendersASentence() async {
        let fake = FakeCredentialsClient()
        fake.setResult = .failure(FakeCredentialsClient.refusal(code: "credential_kind_unsupported", door: "door.from.a.newer.daemon"))
        let model = CredentialsSectionModel(client: fake)
        model.setDraft("k", for: "something")

        await model.save(providerId: "something")

        XCTAssertEqual(model.errorText, credentialDoorText("door.from.a.newer.daemon"))
        XCTAssertFalse(model.errorText?.isEmpty ?? true)
    }

    /// `credential_value_invalid` renders a NEUTRAL message. The assertion that matters is the
    /// negative one: whatever the user typed must not be echoed back to the screen — not the value,
    /// not a fragment of it. (A naive "invalid key: \(key)" would put a real API key into a label,
    /// and from there into a screenshot.)
    func testValueInvalidRefusalRendersNeutralTextAndNeverTheValue() async {
        let fake = FakeCredentialsClient()
        fake.setResult = .failure(FakeCredentialsClient.refusal(
            code: "credential_value_invalid",
            message: "rejected key \(sentinel)"   // a daemon that DID leak it — the model must not relay this
        ))
        let model = CredentialsSectionModel(client: fake)
        model.setDraft(sentinel, for: "deepseek")

        await model.save(providerId: "deepseek")

        guard let shown = model.errorText else {
            return XCTFail("a refused save must publish an error")
        }
        XCTAssertFalse(shown.contains(sentinel), "the typed value must never reach the error text")
        XCTAssertFalse(shown.contains("rejected key"), "the daemon's own message must never be relayed verbatim")
        XCTAssertEqual(shown, "that key wasn't accepted — check it and try again")
    }

    /// An untyped/unknown failure falls back to a generic sentence rather than daemon prose — and
    /// the two verbs say different things, so the user knows which action failed.
    func testUnknownFailuresUseTheirVerbsFallbackText() async {
        let fake = FakeCredentialsClient()
        fake.setResult = .failure(FakeCredentialsClient.refusal(code: "some_future_code"))
        fake.removeResult = .failure(FakeCredentialsClient.SimpleError())
        let model = CredentialsSectionModel(client: fake)

        model.setDraft("k", for: "deepseek")
        await model.save(providerId: "deepseek")
        let saveText = model.errorText

        await model.remove(providerId: "deepseek")
        let removeText = model.errorText

        XCTAssertEqual(saveText, "couldn't save that key — try again")
        XCTAssertEqual(removeText, "couldn't remove that credential — try again")
    }

    // MARK: - door text for non-manageable rows

    /// The door vocabulary is exactly the three §5 values (WS-19 §9 A-1).
    func testDoorTextCoversEveryKnownDoorAndFallsBackNeutrallyForAnUnknownOne() {
        XCTAssertEqual(credentialDoorText("credential.set"), "Enter a key here.")
        XCTAssertTrue(credentialDoorText("provider.login").contains("Anthropic"))
        XCTAssertTrue(credentialDoorText("cli-oauth").contains("winter login"))
        // A door from a newer daemon: a neutral sentence, never an empty string (which would render
        // as a row that says nothing at all).
        XCTAssertFalse(credentialDoorText("door.from.a.newer.daemon").isEmpty)
        XCTAssertFalse(credentialDoorText(nil).isEmpty)
    }

    // MARK: - A-3: Remove is offered independently of `manageable`

    /// The ruling's headline case: a stored Codex OAuth login is `manageable: false` (nothing to
    /// type) but must still be removable from the app — gating Remove on `manageable`, as this
    /// section first did, left it with no exit but the CLI.
    func testAPresentCodexOAuthRowOffersRemoveEvenThoughItIsNotManageable() {
        let codex = FakeCredentialsClient.row(
            providerId: "codex-oauth", displayName: "ChatGPT (Codex)", authKinds: ["oauth"],
            manageable: false, present: true, kind: "oauth", door: "cli-oauth"
        )

        XCTAssertTrue(credentialRowOffersRemove(codex))
    }

    /// The one exclusion: the Anthropic CONSOLE slot. `credential.remove anthropic` acts on
    /// `anthropic:default` ONLY (A-1), so a Remove on this row would either do nothing visible or
    /// delete the OTHER anthropic row's key. Its sign-out is `AnthropicAuthSection`'s.
    func testThePresentAnthropicConsoleRowNeverOffersRemove() {
        let console = FakeCredentialsClient.row(
            providerId: "anthropic", displayName: "Anthropic (Console)", authKinds: ["oauth"],
            manageable: false, present: true, kind: "bearer", door: "provider.login"
        )

        XCTAssertFalse(credentialRowOffersRemove(console))
    }

    /// `present` is still the other half of the gate — nothing stored, nothing to remove. Checked
    /// on both an api-key row and the console row so "absent" can't pass by way of the door test.
    func testAbsentRowsNeverOfferRemove() {
        XCTAssertFalse(credentialRowOffersRemove(
            FakeCredentialsClient.row(providerId: "deepseek", present: false)))
        XCTAssertFalse(credentialRowOffersRemove(
            FakeCredentialsClient.row(providerId: "anthropic", manageable: false, present: false,
                                      kind: "bearer", door: "provider.login")))
    }

    /// And the ordinary case stays ordinary: a present api-key row offers Remove.
    func testAPresentApiKeyRowOffersRemove() {
        XCTAssertTrue(credentialRowOffersRemove(
            FakeCredentialsClient.row(providerId: "deepseek", present: true)))
        // A tool row is an api-key row too (A-2) — same rule, no special case.
        XCTAssertTrue(credentialRowOffersRemove(
            FakeCredentialsClient.row(providerId: "exa", displayName: "Exa", group: "tool", present: true)))
    }

    // MARK: - two rows may share a providerId

    /// WS-19 §9 A-1: rows are emitted per SLOT, so `anthropic` appears TWICE — `anthropic:default`
    /// (api-key, manageable) and `anthropic:console` (bearer, not manageable) — and A-1 names
    /// `providerId|door|kind` as the key clients use. `CredentialRow.id` is that composite; a
    /// `ForEach` keyed on `providerId` alone would collide and silently render one of them.
    func testTwoRowsSharingAProviderIdHaveDistinctIdentity() async {
        let fake = FakeCredentialsClient()
        fake.listResults = [.success([
            FakeCredentialsClient.row(providerId: "anthropic", displayName: "Anthropic", kind: "api-key", door: "credential.set"),
            FakeCredentialsClient.row(providerId: "anthropic", displayName: "Anthropic (Console)",
                                      authKinds: ["oauth"], manageable: false, present: true,
                                      kind: "bearer", door: "provider.login"),
        ])]
        let model = CredentialsSectionModel(client: fake)

        await model.refresh()

        XCTAssertEqual(Set(model.rows.map(\.id)).count, 2, "rows sharing a providerId must still be distinctly identifiable")
    }
}
