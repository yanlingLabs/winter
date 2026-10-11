import Testing
import CoworkNetworkC
@testable import WinterCoworkNetwork

private func hosts(_ prefix: String? = nil) throws -> wc_network_policy {
    try NetworkEndpointPolicy(revision: 1, additionalHostNetworks: prefix.map { [.init(address: $0, prefixLength: 24)] } ?? []).native(syntheticNoOutbound: true)
}
private func routeSnapshot(_ index: UInt32 = 4) -> wc_host_route_snapshot {
    var routes = wc_host_route_snapshot(); routes.inventory_complete = true; routes.default_ipv4_ifindex = index; return routes
}
private func peer(_ text: String = "8.8.8.8") -> wc_network_address {
    var value = wc_network_address(); precondition(text.withCString { wc_network_parse_address($0, 443, &value) }); return value
}
private func admit(_ cache: inout wc_network_inventory, _ policy: inout wc_network_policy, _ now: UInt64, existing: Bool, address: String = "8.8.8.8") -> Bool {
    var effective = wc_network_policy(), destination = peer(address), index: UInt32 = 0
    wc_network_inventory_effective(&cache, &policy, &effective)
    return wc_network_inventory_admit(&cache, &effective, &destination, 6, false, now, existing, &index)
}
private func matches(_ cache: inout wc_network_inventory, _ policy: inout wc_network_policy, _ now: UInt64, bound: UInt32, generation: UInt64, address: String = "8.8.8.8") -> Bool {
    var effective = wc_network_policy(), destination = peer(address)
    wc_network_inventory_effective(&cache, &policy, &effective)
    return wc_network_inventory_matches(&cache, &effective, &destination, 6, false, now, bound, generation)
}

struct InventoryTests {
    @Test func refreshTTLAndFirstAttemptAreBounded() {
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = wc_network_policy(); interfaces.public_internet = true
        #expect(wc_network_inventory_due(&cache, 0))
        wc_network_inventory_update(&cache, &routes, &interfaces, 0)
        #expect(!wc_network_inventory_due(&cache, UInt64(WC_NETWORK_INVENTORY_TTL_NS) - 1))
        #expect(wc_network_inventory_due(&cache, UInt64(WC_NETWORK_INVENTORY_TTL_NS)))
    }
    @Test func routeFailureDeniesNewPublicPeersAndKeepsOldOnlyForOriginalGrace() throws {
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts(), policy = try hosts()
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        let generation = cache.host_generation
        routes.inventory_complete = false; routes.default_ipv4_ifindex = 0
        wc_network_inventory_update(&cache, &routes, &interfaces, 100)
        #expect(cache.routes.default_ipv4_ifindex == 4)
        #expect(!admit(&cache, &policy, 101, existing: false))
        #expect(matches(&cache, &policy, 101, bound: 4, generation: generation))
        // Repeated failures must never renew the grace window.
        wc_network_inventory_update(&cache, &routes, &interfaces, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) - 1)
        #expect(matches(&cache, &policy, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) - 1, bound: 4, generation: generation))
        #expect(!matches(&cache, &policy, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS), bound: 4, generation: generation))
        routes = routeSnapshot(8); wc_network_inventory_update(&cache, &routes, &interfaces, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) + 1)
        #expect(admit(&cache, &policy, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) + 2, existing: false))
        #expect(!matches(&cache, &policy, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) + 2, bound: 4, generation: generation))
    }
    @Test func unknownInventoryNeverAllowsPublicAdmissionOrContinuation() throws {
        var cache = wc_network_inventory(), routes = wc_host_route_snapshot(), interfaces = try hosts(), policy = try hosts()
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        #expect(!admit(&cache, &policy, 2, existing: false)); #expect(!admit(&cache, &policy, 2, existing: true))
    }
    @Test func staleCacheCannotRetainRevokedOrExpiredExplicitAuthority() throws {
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts()
        var policy = try NetworkEndpointPolicy(revision: 1, grants: [.init(address: "127.0.0.1", port: 443, transport: .tcp, expiresMonotonicNanoseconds: 10)]).native(syntheticNoOutbound: true)
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        routes.inventory_complete = false; wc_network_inventory_update(&cache, &routes, &interfaces, 2)
        #expect(matches(&cache, &policy, 9, bound: 0, generation: 0, address: "127.0.0.1"))
        #expect(!matches(&cache, &policy, 10, bound: 0, generation: 0, address: "127.0.0.1"))
        policy.grant_count = 0
        #expect(!matches(&cache, &policy, 9, bound: 0, generation: 0, address: "127.0.0.1"))
        // A formerly exact public grant cannot become an unbound public flow.
        #expect(!matches(&cache, &policy, 9, bound: 0, generation: 0))
        policy.public_internet = false
        #expect(!matches(&cache, &policy, 9, bound: 4, generation: cache.host_generation))
    }
    @Test func changedOrUnknownHostIdentitiesClosePublicFlowsImmediately() throws {
        for unknown in [false, true] {
            var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("9.9.9.0"), policy = try hosts()
            wc_network_inventory_update(&cache, &routes, &interfaces, 1)
            let generation = cache.host_generation
            routes.inventory_complete = false
            interfaces = try hosts("7.7.7.0"); interfaces.public_internet = !unknown
            wc_network_inventory_update(&cache, &routes, &interfaces, 2)
            #expect(cache.unsafe_hosts); #expect(!matches(&cache, &policy, 3, bound: 4, generation: generation))
        }
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("9.9.9.0"), policy = try hosts()
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        let generation = cache.host_generation
        interfaces = try hosts("7.7.7.0"); wc_network_inventory_update(&cache, &routes, &interfaces, 2)
        #expect(!matches(&cache, &policy, 3, bound: 4, generation: generation))
        #expect(admit(&cache, &policy, 3, existing: false))
    }
    @Test func interfaceIdentityChangesAndDuplicateMultiplicityAreDetected() throws {
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("9.9.9.0"), policy = try hosts()
        interfaces.host_networks.0.address.scope_id = 4
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        let generation = cache.host_generation
        interfaces.host_networks.0.address.scope_id = 8
        wc_network_inventory_update(&cache, &routes, &interfaces, 2)
        #expect(cache.host_generation != generation)
        #expect(!matches(&cache, &policy, 3, bound: 4, generation: generation))
        interfaces.host_network_count = 2; interfaces.host_networks.1 = interfaces.host_networks.0
        wc_network_inventory_update(&cache, &routes, &interfaces, 4)
        let duplicatedGeneration = cache.host_generation
        interfaces.host_networks.1.address.scope_id = 9
        wc_network_inventory_update(&cache, &routes, &interfaces, 5)
        #expect(cache.host_generation != duplicatedGeneration)
    }
    @Test func lastGoodLANFencesRemainEffectiveDuringRouteGrace() throws {
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("8.8.8.0"), policy = try hosts()
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        routes.inventory_complete = false; wc_network_inventory_update(&cache, &routes, &interfaces, 2)
        #expect(!admit(&cache, &policy, 3, existing: true))
        #expect(admit(&cache, &policy, 3, existing: true, address: "9.9.9.9"))
    }
}
