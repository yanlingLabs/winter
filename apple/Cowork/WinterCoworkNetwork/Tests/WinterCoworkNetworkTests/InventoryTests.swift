import Testing
import CoworkNetworkC
@testable import WinterCoworkNetwork

private func hosts(_ prefix: String = "192.0.2.0", index: UInt32 = 4) throws -> wc_network_policy {
    var value = try NetworkEndpointPolicy(revision: 1, additionalHostNetworks: [.init(address: prefix, prefixLength: 24)]).native(syntheticNoOutbound: true)
    value.host_networks.0.address.scope_id = index; return value
}
private func identity(_ cache: inout wc_network_inventory, _ index: UInt32 = 4, _ family: UInt8 = 4) -> UInt64 { wc_network_inventory_identity(&cache, index, family) }
private func addHost(_ hosts: inout wc_network_policy, _ text: String, _ bits: UInt8, _ index: UInt32) {
    precondition(text.withCString {wc_network_policy_prefix(&hosts, $0, bits)})
    let at=hosts.host_network_count-1
    withUnsafeMutablePointer(to:&hosts.host_networks) {$0.withMemoryRebound(to:wc_network_prefix.self,capacity:Int(WC_NETWORK_MAX_PREFIXES)) {$0[at].address.scope_id=index}}
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
    @Test func unrelatedInterfacesOtherFamiliesAndTemporaryAddressesPreserveBoundPaths() throws {
        for routeFailure in [false, true] {
            var cache=wc_network_inventory(),routes=routeSnapshot(),interfaces=try hosts(),policy=try hosts()
            routes.default_ipv6_ifindex=4
            addHost(&interfaces,"2001:db8:1::1234",64,4);addHost(&interfaces,"2001:db8:1::1234",128,4)
            addHost(&interfaces,"fe80::1",64,10);addHost(&interfaces,"fe80::2",64,11)
            wc_network_inventory_update(&cache,&routes,&interfaces,1)
            let v4=identity(&cache),v6=identity(&cache,4,6)
            interfaces=try hosts("192.0.2.44") // Same connected subnet; different getifaddrs host bits.
            addHost(&interfaces,"2001:db8:1::5678",128,4);addHost(&interfaces,"2001:db8:1::5678",64,4)
            addHost(&interfaces,"fe80::99",64,10);addHost(&interfaces,"10.44.0.1",24,12)
            routes.inventory_complete = !routeFailure
            wc_network_inventory_update(&cache,&routes,&interfaces,2)
            #expect(identity(&cache)==v4);#expect(identity(&cache,4,6)==v6)
            #expect(matches(&cache,&policy,3,bound:4,generation:v4))
            #expect(matches(&cache,&policy,3,bound:4,generation:v6,address:"2001:4860:4860::8888"))
            #expect(admit(&cache,&policy,3,existing:false) == !routeFailure)
            #expect(!cache.unsafe_hosts)
        }
    }
    @Test func boundNetworkIdentityChangesAreScopedToTheirAddressFamily() throws {
        var cache=wc_network_inventory(),routes=routeSnapshot(),interfaces=try hosts(),policy=try hosts()
        routes.default_ipv6_ifindex=4;addHost(&interfaces,"2001:db8:1::1",64,4)
        wc_network_inventory_update(&cache,&routes,&interfaces,1)
        let v4=identity(&cache),v6=identity(&cache,4,6)
        interfaces=try hosts("198.51.100.0");addHost(&interfaces,"2001:db8:1::2",64,4)
        wc_network_inventory_update(&cache,&routes,&interfaces,2)
        #expect(identity(&cache) != v4);#expect(identity(&cache,4,6)==v6)
        #expect(!matches(&cache,&policy,3,bound:4,generation:v4))
        #expect(matches(&cache,&policy,3,bound:4,generation:v6,address:"2001:4860:4860::8888"))
    }
    @Test func disappearanceAndReusedNumericInterfaceCannotContinueOldFlow() throws {
        var cache=wc_network_inventory(),routes=routeSnapshot(),interfaces=try hosts(),policy=try hosts()
        wc_network_inventory_update(&cache,&routes,&interfaces,1);let old=identity(&cache)
        interfaces.host_network_count=0;wc_network_inventory_update(&cache,&routes,&interfaces,2)
        #expect(!admit(&cache,&policy,3,existing:false));#expect(!matches(&cache,&policy,3,bound:4,generation:old))
        interfaces=try hosts();wc_network_inventory_update(&cache,&routes,&interfaces,4)
        #expect(identity(&cache) != old);#expect(!matches(&cache,&policy,5,bound:4,generation:old))
        #expect(admit(&cache,&policy,5,existing:false))
    }
    @Test func destinationBecomingHostOrLANClosesOnlyAffectedPeerIncludingDuringGrace() throws {
        for routeFailure in [false, true] {
            var cache=wc_network_inventory(),routes=routeSnapshot(),interfaces=try hosts(),policy=try hosts()
            wc_network_inventory_update(&cache,&routes,&interfaces,1);let old=identity(&cache)
            addHost(&interfaces,"8.8.8.8",32,12);routes.inventory_complete = !routeFailure
            wc_network_inventory_update(&cache,&routes,&interfaces,2)
            #expect(identity(&cache)==old);#expect(!matches(&cache,&policy,3,bound:4,generation:old))
            #expect(matches(&cache,&policy,3,bound:4,generation:old,address:"9.9.9.9"))
            // Removed host fences remain in grace while the route is unknown.
            interfaces=try hosts();wc_network_inventory_update(&cache,&routes,&interfaces,4)
            #expect(matches(&cache,&policy,5,bound:4,generation:old) == !routeFailure)
        }
    }
    @Test func routeChangesRecheckDestinationAndBindingIndependentlyOfHostEpoch() throws {
        var cache=wc_network_inventory(),routes=routeSnapshot(),interfaces=try hosts(),policy=try hosts()
        addHost(&interfaces,"198.51.100.0",24,8)
        wc_network_inventory_update(&cache,&routes,&interfaces,1);let old=identity(&cache)
        routes.deny_prefix_count=1;routes.deny_prefixes.0 = .init(address:peer(),prefix_length:32)
        wc_network_inventory_update(&cache,&routes,&interfaces,2)
        #expect(identity(&cache)==old);#expect(!matches(&cache,&policy,3,bound:4,generation:old))
        #expect(matches(&cache,&policy,3,bound:4,generation:old,address:"9.9.9.9"))
        routes.deny_prefix_count=0;routes.default_ipv4_ifindex=8
        wc_network_inventory_update(&cache,&routes,&interfaces,4)
        #expect(!matches(&cache,&policy,5,bound:4,generation:old,address:"9.9.9.9"))
        routes.default_ipv4_ifindex=0;wc_network_inventory_update(&cache,&routes,&interfaces,6)
        #expect(!admit(&cache,&policy,7,existing:false));#expect(!matches(&cache,&policy,7,bound:4,generation:old))
    }
    @Test func unknownHostSnapshotCannotRegainGraceUntilCombinedRefreshSucceeds() throws {
        var cache=wc_network_inventory(),routes=routeSnapshot(),interfaces=try hosts(),policy=try hosts()
        wc_network_inventory_update(&cache,&routes,&interfaces,1);let old=identity(&cache)
        interfaces.public_internet=false;wc_network_inventory_update(&cache,&routes,&interfaces,2)
        #expect(!matches(&cache,&policy,3,bound:4,generation:old))
        interfaces.public_internet=true;routes.inventory_complete=false
        wc_network_inventory_update(&cache,&routes,&interfaces,4)
        #expect(!matches(&cache,&policy,5,bound:4,generation:old))
        routes.inventory_complete=true;wc_network_inventory_update(&cache,&routes,&interfaces,6)
        #expect(!matches(&cache,&policy,7,bound:4,generation:old))
        #expect(matches(&cache,&policy,7,bound:4,generation:identity(&cache)))
    }
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
        let generation = identity(&cache)
        routes.inventory_complete = false; routes.default_ipv4_ifindex = 0
        wc_network_inventory_update(&cache, &routes, &interfaces, 100)
        #expect(cache.routes.default_ipv4_ifindex == 4)
        #expect(!admit(&cache, &policy, 101, existing: false))
        #expect(matches(&cache, &policy, 101, bound: 4, generation: generation))
        // Repeated failures must never renew the grace window.
        wc_network_inventory_update(&cache, &routes, &interfaces, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) - 1)
        #expect(matches(&cache, &policy, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) - 1, bound: 4, generation: generation))
        #expect(!matches(&cache, &policy, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS), bound: 4, generation: generation))
        routes = routeSnapshot(8); interfaces = try hosts(index: 8); wc_network_inventory_update(&cache, &routes, &interfaces, 100 + UInt64(WC_NETWORK_ROUTE_GRACE_NS) + 1)
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
        #expect(!matches(&cache, &policy, 9, bound: 4, generation: identity(&cache)))
    }
    @Test func changedOrUnknownHostIdentitiesClosePublicFlowsImmediately() throws {
        for unknown in [false, true] {
            var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("9.9.9.0"), policy = try hosts()
            wc_network_inventory_update(&cache, &routes, &interfaces, 1)
            let generation = identity(&cache)
            routes.inventory_complete = false
            interfaces = try hosts("7.7.7.0"); interfaces.public_internet = !unknown
            wc_network_inventory_update(&cache, &routes, &interfaces, 2)
            #expect(cache.unsafe_hosts == unknown); #expect(!matches(&cache, &policy, 3, bound: 4, generation: generation))
        }
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("9.9.9.0"), policy = try hosts()
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        let generation = identity(&cache)
        interfaces = try hosts("7.7.7.0"); wc_network_inventory_update(&cache, &routes, &interfaces, 2)
        #expect(!matches(&cache, &policy, 3, bound: 4, generation: generation))
        #expect(admit(&cache, &policy, 3, existing: false))
    }
    @Test func interfaceMoveIsDetectedButDuplicateFencesAreNotNewIdentity() throws {
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("9.9.9.0"), policy = try hosts()
        interfaces.host_networks.0.address.scope_id = 4
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        let generation = identity(&cache)
        interfaces.host_networks.0.address.scope_id = 8
        wc_network_inventory_update(&cache, &routes, &interfaces, 2)
        #expect(identity(&cache) == 0)
        #expect(!matches(&cache, &policy, 3, bound: 4, generation: generation))
        interfaces.host_network_count = 2; interfaces.host_networks.1 = interfaces.host_networks.0
        wc_network_inventory_update(&cache, &routes, &interfaces, 4)
        let duplicatedGeneration = identity(&cache, 8)
        interfaces.host_networks.1.address.scope_id = 9
        wc_network_inventory_update(&cache, &routes, &interfaces, 5)
        #expect(identity(&cache, 8) == duplicatedGeneration)
    }
    @Test func lastGoodLANFencesRemainEffectiveDuringRouteGrace() throws {
        var cache = wc_network_inventory(), routes = routeSnapshot(), interfaces = try hosts("8.8.8.0"), policy = try hosts()
        wc_network_inventory_update(&cache, &routes, &interfaces, 1)
        routes.inventory_complete = false; wc_network_inventory_update(&cache, &routes, &interfaces, 2)
        #expect(!admit(&cache, &policy, 3, existing: true))
        #expect(admit(&cache, &policy, 3, existing: true, address: "9.9.9.9"))
    }
}
