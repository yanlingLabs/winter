import Foundation
import SystemConfiguration
import Virtualization
import CoworkNetworkC
import Darwin

public struct NetworkGrant: Sendable {
    public enum Transport: UInt8, Sendable { case tcp = 6, udp = 17 }
    public let address: String, port: UInt16, transport: Transport, expiresMonotonicNanoseconds: UInt64
    public init(address: String, port: UInt16, transport: Transport, expiresMonotonicNanoseconds: UInt64 = 0) {
        self.address=address; self.port=port; self.transport=transport; self.expiresMonotonicNanoseconds=expiresMonotonicNanoseconds
    }
}
public struct HostNetworkPrefix: Sendable {
    public let address: String, prefixLength: UInt8
    public init(address: String, prefixLength: UInt8) { self.address=address; self.prefixLength=prefixLength }
}
public struct SystemDNSConfiguration: Sendable {
    public let addresses: [String]
    public init(addresses: [String]) { self.addresses=addresses }
    /// Read-only OS configuration, never a silently selected third-party DNS.
    public static func current() throws -> Self {
        guard let store=SCDynamicStoreCreate(nil,"Winter Cowork DNS" as CFString,nil,nil),
              let config=SCDynamicStoreCopyValue(store,"State:/Network/Global/DNS" as CFString) as? [String:Any],
              let addresses=config["ServerAddresses"] as? [String], !addresses.isEmpty else {
            throw NetworkEndpointError("system_dns_unavailable", "Host primary DNS configuration is unavailable; configure an explicit host resolver policy")
        }
        return .init(addresses: addresses)
    }
}
public struct NetworkEndpointPolicy: Sendable {
    public let revision: UInt64, publicInternet: Bool, dns: SystemDNSConfiguration?, grants: [NetworkGrant], additionalHostNetworks: [HostNetworkPrefix]
    public init(revision: UInt64, publicInternet: Bool = true, dns: SystemDNSConfiguration? = nil, grants: [NetworkGrant] = [], additionalHostNetworks: [HostNetworkPrefix] = []) {
        self.revision=revision; self.publicInternet=publicInternet; self.dns=dns; self.grants=grants; self.additionalHostNetworks=additionalHostNetworks
    }
    func native(syntheticNoOutbound: Bool) throws -> wc_network_policy {
        var value=wc_network_policy(); value.revision=revision; value.public_internet=publicInternet; value.synthetic_no_outbound=syntheticNoOutbound
        value.system_dns_exception=dns != nil
        for address in dns?.addresses ?? [] { guard address.withCString({ wc_network_policy_resolver(&value,$0) }) else { throw NetworkEndpointError("invalid_resolver", "Only literal configured DNS addresses are accepted") } }
        for grant in grants { guard grant.address.withCString({ wc_network_policy_grant(&value,$0,grant.port,grant.transport.rawValue,grant.expiresMonotonicNanoseconds) }) else { throw NetworkEndpointError("invalid_grant", "Scoped exact address/port/transport grant required") } }
        for network in additionalHostNetworks { guard network.address.withCString({ wc_network_policy_prefix(&value,$0,network.prefixLength) }) else { throw NetworkEndpointError("invalid_host_network", "Invalid host/LAN prefix snapshot") } }
        return value
    }
}
public struct NetworkEndpointError: Error, LocalizedError, Sendable {
    public let code: String, message: String
    public init(_ code: String,_ message: String) { self.code=code; self.message=message }
    public var errorDescription: String? { message }
}
public struct NetworkEndpointStatistics: Sendable {
    public let revision: UInt64, packetsIn: UInt64, packetsOut: UInt64, denied: UInt64, unsupported: UInt64, dropped: UInt64, outboundAttempts: UInt64, activeSockets: UInt64, inboundPeerDenied: UInt64
}

public struct NetworkEndpointScope: Sendable {
    public let protocolVersion: UInt32, workspaceId: String, incarnationId: String, leaseEpoch: UInt64
    public init(protocolVersion: UInt32 = 1, workspaceId: String, incarnationId: String, leaseEpoch: UInt64) {
        self.protocolVersion=protocolVersion; self.workspaceId=workspaceId; self.incarnationId=incarnationId; self.leaseEpoch=leaseEpoch
    }
}

/// Host-owned endpoint. A dedicated native thread runs all slirp/host-socket
/// work; no packet is evaluated on Bun's event loop. The fd belongs to this
/// object, which must outlive its attached guest and be explicitly shut down.
public final class CoworkNetworkEndpoint: @unchecked Sendable {
    private let lock=NSLock()
    private var handle: OpaquePointer?
    private let queue=DispatchQueue(label:"winter.cowork.network.control")
    private let syntheticNoOutbound: Bool
    public let scope: NetworkEndpointScope
    public static let guestIPv4="10.0.2.15/24", gatewayIPv4="10.0.2.2", dnsIPv4="10.0.2.3"
    public static let guestIPv6="fd00:77::15/64", gatewayIPv6="fd00:77::2", dnsIPv6="fd00:77::3"
    public static let guestMAC="02:77:69:00:00:01"
    public init(scope: NetworkEndpointScope, policy: NetworkEndpointPolicy, syntheticNoOutbound: Bool = false) throws {
        guard scope.protocolVersion==1, !scope.workspaceId.isEmpty, !scope.incarnationId.isEmpty, scope.leaseEpoch>0 else {throw NetworkEndpointError("invalid_network_scope","Authenticated workspace incarnation and lease required")}
        self.scope=scope
        self.syntheticNoOutbound=syntheticNoOutbound
        var native=try policy.native(syntheticNoOutbound: syntheticNoOutbound)
        guard let handle=wc_network_create(&native) else { throw NetworkEndpointError("network_endpoint_unavailable", "Cannot create bounded native datagram endpoint") }
        self.handle=handle
    }
    private func withHandle<T>(_ body:(OpaquePointer)throws->T) throws->T {
        lock.lock(); defer {lock.unlock()}
        guard let handle else {throw NetworkEndpointError("network_endpoint_closed","Native endpoint is closed")}
        return try body(handle)
    }
    public func attachment() throws -> VZFileHandleNetworkDeviceAttachment {
        let fd=try withHandle { dup(wc_network_guest_fd($0)) }
        guard fd>=0 else {throw NetworkEndpointError("network_endpoint_unavailable","Cannot duplicate owned datagram attachment")}
        let value=VZFileHandleNetworkDeviceAttachment(fileHandle: FileHandle(fileDescriptor:fd,closeOnDealloc:true)); value.maximumTransmissionUnit=1500
        return value
    }
    public func duplicateGuestFDForSyntheticTest() throws -> Int32 { try withHandle { dup(wc_network_guest_fd($0)) } }
    public func replacePolicy(_ policy: NetworkEndpointPolicy, expectedRevision: UInt64) async throws {
        let value=try policy.native(syntheticNoOutbound:syntheticNoOutbound)
        try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in
            queue.async {
                do { try self.withHandle { handle in var value=value; let result=wc_network_replace_policy(handle,&value,expectedRevision); guard result==0 else {throw NetworkEndpointError("stale_network_policy","Network policy revision differs or endpoint is draining")}}; continuation.resume() }
                catch {continuation.resume(throwing:error)}
            }
        }
    }
    public func statistics() throws -> NetworkEndpointStatistics {
        try withHandle { handle in var s=wc_network_stats(); wc_network_read_stats(handle,&s); return .init(revision:s.revision,packetsIn:s.packets_in,packetsOut:s.packets_out,denied:s.denied,unsupported:s.unsupported,dropped:s.dropped,outboundAttempts:s.outbound_attempts,activeSockets:s.active_sockets,inboundPeerDenied:s.inbound_peer_denied) }
    }
    public func shutdown() async {
        await withCheckedContinuation { (continuation:CheckedContinuation<Void,Never>) in queue.async {self.lock.lock(); let h=self.handle; self.handle=nil; self.lock.unlock(); if let h {wc_network_destroy(h)}; continuation.resume()} }
    }
    deinit { if let handle {wc_network_destroy(handle)} }
}
