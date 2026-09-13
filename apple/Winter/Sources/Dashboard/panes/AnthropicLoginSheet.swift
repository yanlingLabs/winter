import WinterKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// AnthropicLoginSheet — Winter Phase 10a Task A2: the "Waiting for your browser…" sheet
// `AnthropicAuthSectionModel.startLogin()` opens. Mirrors `ConsentSheet.swift`'s presentation idiom
// (opaque VStack, fixed width, `.padding(20)`, no `.ultraThinMaterial`/glass blend) and its
// `.sheet(item:)` wiring (`AnthropicAuthSection.swift`'s own `.sheet(item: $model.loginSheet)`).
//
// M2 amendment (2026-09-13, measured against the real embedded binary): Console login is a
// paste-a-code flow — the binary opens the browser itself, then Anthropic's page shows a code the
// user must paste back; there is no automatic callback. So this sheet, beyond listing progress
// lines (with a `https://` line rendered as a clickable fallback link), carries a "Paste the code
// from Anthropic" field + "Continue" button that submits it — the terminal outcome (success/
// failure) arrives later, asynchronously, on `client.loginUpdates()`.
// -----------------------------------------------------------------------------------------------

@MainActor
final class AnthropicLoginSheetModel: ObservableObject, Identifiable {
    enum Phase: Equatable {
        case waiting
        case success
        case failure(reason: String?)
    }

    let id = UUID()
    private let client: AnthropicAuthClient
    private var updatesTask: Task<Void, Never>?

    @Published private(set) var phase: Phase = .waiting
    @Published private(set) var lines: [String] = []
    @Published var code: String = ""
    @Published private(set) var submitting = false
    @Published var submitErrorText: String?

    init(client: AnthropicAuthClient) {
        self.client = client
    }

    /// Calls `loginUpdates()` SYNCHRONOUSLY (before the first `await` in this function) to obtain
    /// the stream, and only THEN starts consuming it in its own task and calls `login()` — so a
    /// progress line landing between the two (the daemon opening the browser) is never lost to a
    /// race. Getting this ordering from `Task { [weak self] in ... self.client.loginUpdates() ... }`
    /// alone would NOT be enough: a freshly-created `Task` is only SCHEDULED, not guaranteed to
    /// have started running before this function's own next line executes — same "subscribe before
    /// you can miss anything" posture as `SessionFeed.start()`'s own `client.events` pump
    /// (`apple/Winter/Sources/Model/SessionFeed.swift`), applied one call earlier here because that
    /// pump's `client.events` already exists before `start()` runs, while `loginUpdates()` is
    /// this attempt's OWN stream, freshly vended per call. `login()` itself throwing (couldn't even
    /// start the login binary) is a `.failure`, same terminal shape as a later
    /// `provider_login_finished` reporting one.
    func start() async {
        let updates = client.loginUpdates()
        updatesTask = Task { [weak self] in
            guard let self else { return }
            for await update in updates {
                self.handle(update)
            }
        }
        do {
            try await client.login()
        } catch {
            phase = .failure(reason: "couldn't start sign-in")
        }
    }

    private func handle(_ update: AnthropicLoginEvent) {
        switch update {
        case .progress(let line):
            lines.append(line)
        case .finished(let ok, let reason):
            phase = ok ? .success : .failure(reason: reason)
        }
    }

    /// Trimmed, sent once, and the field is cleared IMMEDIATELY — before the RPC even resolves —
    /// regardless of outcome: a one-time code is as unwritable as a password once submitted, never
    /// retained in the field for a "fix a typo and resubmit" affordance.
    func submitCode() async {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !submitting else { return }
        submitting = true
        code = ""
        defer { submitting = false }
        do {
            try await client.submitLoginCode(trimmed)
            submitErrorText = nil
        } catch {
            submitErrorText = "couldn't submit the code — try again"
        }
    }

    /// The first `https://` URL in `line`, if any — the sheet's clickable fallback link (P10a-6:
    /// the daemon opens the browser itself; this is only for when that fails or the user closed it).
    static func urlFallback(in line: String) -> URL? {
        guard let range = line.range(of: #"https://\S+"#, options: .regularExpression) else { return nil }
        return URL(string: String(line[range]))
    }

    deinit {
        updatesTask?.cancel()
    }
}

struct AnthropicLoginSheet: View {
    @ObservedObject var model: AnthropicLoginSheetModel
    /// Fired by the "Done" button — `AnthropicAuthSection`'s own `.sheet(item:)` closure both nils
    /// `loginSheet` (closing the sheet, same "the PARENT owns dismissal via its `@Published`
    /// binding" posture as `PluginManagerModel.cancelConsent()`) and refreshes the status row. This
    /// view has no daemon-side-effect knowledge of its own — it only reports, same as `ConsentSheet`.
    let onDone: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Waiting for your browser…")
                .font(Typography.paneTitle)

            switch model.phase {
            case .waiting:
                waitingBody
            case .success:
                Text("Signed in to Anthropic Console.")
                    .foregroundStyle(.green)
                    .font(Typography.label())
                doneButton
            case .failure(let reason):
                Text(reason ?? "Sign-in failed.")
                    .foregroundStyle(.red)
                    .font(Typography.label())
                doneButton
            }
        }
        .padding(20)
        .frame(width: 420)
    }

    private var waitingBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("A browser window should open. Sign in to Anthropic Console, then paste the code it shows you below.")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if !model.lines.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(model.lines.enumerated()), id: \.offset) { _, line in
                            if let url = AnthropicLoginSheetModel.urlFallback(in: line) {
                                Link(line, destination: url)
                                    .font(Typography.labelMono())
                            } else {
                                Text(line)
                                    .font(Typography.labelMono())
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                }
                .frame(minHeight: 40, maxHeight: 160)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.quaternary))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Code from Anthropic").font(Typography.caption()).foregroundStyle(.secondary)
                TextField("Paste the code from Anthropic", text: $model.code)
                    .textFieldStyle(.roundedBorder)
                    .font(Typography.labelMono())
                    .disabled(model.submitting)
            }

            if let submitErrorText = model.submitErrorText {
                Text(submitErrorText).foregroundStyle(.red).font(Typography.label())
            }

            HStack {
                Spacer()
                Button {
                    Task { await model.submitCode() }
                } label: {
                    HStack(spacing: 6) {
                        if model.submitting {
                            ProgressView().controlSize(.small)
                        }
                        Text("Continue")
                    }
                }
                .disabled(model.submitting || model.code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var doneButton: some View {
        HStack {
            Spacer()
            Button("Done") { onDone() }
        }
    }
}
