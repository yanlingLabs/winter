import Foundation
import Combine

@MainActor
final class TriggerHub: ObservableObject {
    static let shared = TriggerHub()

    let didTrigger = PassthroughSubject<Void, Never>()

    private var lastFire = Date.distantPast
    private let debounce: TimeInterval = 0.35

    func fire(from _: String) {
        let now = Date()
        guard now.timeIntervalSince(lastFire) > debounce else { return }
        lastFire = now
        didTrigger.send(())
    }
}
