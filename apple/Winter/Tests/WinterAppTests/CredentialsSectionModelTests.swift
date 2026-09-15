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

    /// The console arm's REMOVE refusal carries `door: "provider.logout"` — a value that is NOT
    /// among `CredentialRow.door`'s three (W19-5). It must still render a real sentence; this is
    /// exactly the case a closed Swift enum would have swallowed.
    func testKindUnsupportedRefusalOnRemoveRendersTheLogoutDoor() async {
        let fake = FakeCredentialsClient()
        fake.removeResult = .failure(FakeCredentialsClient.refusal(code: "credential_kind_unsupported", door: "provider.logout"))
        let model = CredentialsSectionModel(client: fake)

        await model.remove(providerId: "anthropic")

        XCTAssertEqual(model.errorText, credentialDoorText("provider.logout"))
        XCTAssertTrue(model.errorText?.contains("Anthropic") == true)
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

    func testDoorTextCoversEveryKnownDoorAndFallsBackNeutrallyForAnUnknownOne() {
        XCTAssertEqual(credentialDoorText("credential.set"), "Enter a key here.")
        XCTAssertTrue(credentialDoorText("provider.login").contains("Anthropic"))
        XCTAssertTrue(credentialDoorText("cli-oauth").contains("winter login"))
        XCTAssertTrue(credentialDoorText("provider.logout").contains("Sign out"))
        // A door from a newer daemon: a neutral sentence, never an empty string (which would render
        // as a row that says nothing at all).
        XCTAssertFalse(credentialDoorText("door.from.a.newer.daemon").isEmpty)
        XCTAssertFalse(credentialDoorText(nil).isEmpty)
    }

    // MARK: - two rows may share a providerId

    /// The inventory carries both an `anthropic:default` (api-key, manageable) slot and an
    /// `anthropic:console` (bearer, not manageable) slot, so two rows can share a `providerId`.
    /// `CredentialRow.id` is a composite for exactly this reason — a `ForEach` keyed on
    /// `providerId` alone would collide and silently render one of them.
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
