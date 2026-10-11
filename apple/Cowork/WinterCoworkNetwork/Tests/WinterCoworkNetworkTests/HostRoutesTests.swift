import Testing
import Foundation
import Darwin
import CoworkNetworkC
@testable import WinterCoworkNetwork

private func routeSockaddr(_ text: String) -> [UInt8] {
    var parsed=wc_network_address(); precondition(text.withCString {wc_network_parse_address($0,0,&parsed)})
    let bytes=withUnsafeBytes(of:parsed.bytes) {Array($0)}
    if parsed.family==4 {
        var sa=sockaddr_in();sa.sin_len=UInt8(MemoryLayout<sockaddr_in>.size);sa.sin_family=sa_family_t(AF_INET)
        withUnsafeMutableBytes(of:&sa.sin_addr) {$0.copyBytes(from:bytes.prefix(4))}
        return withUnsafeBytes(of:sa) {Array($0)}
    }
    var sa=sockaddr_in6();sa.sin6_len=UInt8(MemoryLayout<sockaddr_in6>.size);sa.sin6_family=sa_family_t(AF_INET6)
    withUnsafeMutableBytes(of:&sa.sin6_addr) {$0.copyBytes(from:bytes)}
    return withUnsafeBytes(of:sa) {Array($0)}
}
private func routeMask(_ bits: Int, family: Int, short: Bool) -> [UInt8] {
    let offset=family==4 ? MemoryLayout<sockaddr_in>.offset(of:\.sin_addr)! : MemoryLayout<sockaddr_in6>.offset(of:\.sin6_addr)!
    let width=family==4 ? 4 : 16
    var mask=[UInt8](repeating:0,count:offset+width)
    for index in 0..<bits {mask[offset+index/8] |= UInt8(1 << (7-index%8))}
    if short {
        while mask.count>2 && mask.last==0 {mask.removeLast()}
        if bits==0 {return [0,0,0,0]}
    }
    mask[0]=UInt8(mask.count);mask[1]=0
    while mask.count%4 != 0 {mask.append(0)}
    return mask
}
private func routeRecord(_ destination: String, bits: Int? = nil, flags: Int32 = Int32(RTF_UP|RTF_GATEWAY), index: UInt16 = 7, shortMask: Bool = false, parentFlags: Int32 = 0) -> [UInt8] {
    let destinationBytes=routeSockaddr(destination)
    let family=destinationBytes[1]==UInt8(AF_INET) ? 4:6
    var payload=destinationBytes
    if let bits {payload += routeMask(bits,family:family,short:shortMask)}
    var header=rt_msghdr2();header.rtm_msglen=UInt16(MemoryLayout<rt_msghdr2>.size+payload.count);header.rtm_version=UInt8(RTM_VERSION);header.rtm_type=UInt8(RTM_GET2);header.rtm_index=index;header.rtm_flags=flags;header.rtm_parentflags=parentFlags;header.rtm_addrs=Int32(RTA_DST | (bits == nil ? 0:RTA_NETMASK))
    return withUnsafeBytes(of:header) {Array($0)}+payload
}
private func routeParse(_ bytes:[UInt8])->(Bool,wc_host_route_snapshot) {
    var result=wc_host_route_snapshot();let success=bytes.withUnsafeBufferPointer {wc_host_routes_parse($0.baseAddress,$0.count,&result)};return(success,result)
}
private func routePrefixes(_ snapshot:wc_host_route_snapshot)->[wc_network_prefix] {
    withUnsafeBytes(of:snapshot.deny_prefixes) {Array($0.bindMemory(to:wc_network_prefix.self).prefix(Int(snapshot.deny_prefix_count)))}
}
private func routeMatches(_ snapshot:wc_host_route_snapshot,_ text:String,_ bits:UInt8)->Bool {
    var address=wc_network_address();precondition(text.withCString {wc_network_parse_address($0,0,&address)})
    let expected=withUnsafeBytes(of:address.bytes) {Array($0)}
    return routePrefixes(snapshot).contains {p in p.address.family==address.family && p.prefix_length==bits && withUnsafeBytes(of:p.address.bytes) {Array($0)}==expected}
}
struct HostRoutesTests {
    @Test func finalDestinationRequiresCompleteRouteAndCorrectFamilyDefault() throws {
        var p=try NetworkEndpointPolicy(revision:1).native(syntheticNoOutbound:true)
        var routes=routeParse(routeRecord("0.0.0.0",bits:0,index:4)+routeRecord("8.8.8.0",bits:24)).1
        var address=wc_network_address();var interface:UInt32=99
        func admit(_ text:String)->Bool {precondition(text.withCString{wc_network_parse_address($0,443,&address)});return wc_network_admit_routed_destination(&p,&routes,&address,6,false,1,&interface)}
        #expect(!admit("8.8.8.8"));#expect(!admit("::ffff:8.8.8.8"));#expect(admit("9.9.9.9"));#expect(interface==4)
        #expect(!admit("2606:4700:4700::1111"));routes.inventory_complete=false;#expect(!admit("9.9.9.9"));#expect(interface==0)
        p=try NetworkEndpointPolicy(revision:1,publicInternet:false,grants:[.init(address:"127.0.0.1",port:443,transport:.tcp)]).native(syntheticNoOutbound:true)
        #expect(admit("127.0.0.1"));#expect(interface==0)
    }
    @Test func interfaceBindingUsesKernelSocketOptionsWithoutSendingTraffic() {
        let loopback=if_nametoindex("lo0");#expect(loopback>0)
        for family in [UInt8(4),UInt8(6)] {
            let fd=socket(family==4 ? AF_INET:AF_INET6,SOCK_DGRAM,0);#expect(fd>=0);guard fd>=0 else {continue};defer{close(fd)}
            #expect(wc_network_bind_interface(fd,family,loopback))
            var got:UInt32=0;var bytes=socklen_t(MemoryLayout<UInt32>.size)
            #expect(getsockopt(fd,family==4 ? IPPROTO_IP:IPPROTO_IPV6,family==4 ? IP_BOUND_IF:IPV6_BOUND_IF,&got,&bytes)==0);#expect(got==loopback)
            #expect(!wc_network_bind_interface(fd,family,UInt32.max));#expect(wc_network_bind_interface(fd,family,0))
        }
    }
    @Test func unscopedDefaultsPinEachFamilyAndAbsentFamilyIsDistinct() {
        let (_,four)=routeParse(routeRecord("0.0.0.0",bits:0,index:4,shortMask:true))
        #expect(four.inventory_complete);#expect(four.default_ipv4_ifindex==4);#expect(four.default_ipv6_ifindex==0)
        let (valid,both)=routeParse(routeRecord("0.0.0.0",bits:0,index:4)+routeRecord("::",bits:0,index:9,shortMask:true))
        #expect(valid);#expect(both.default_ipv4_ifindex==4);#expect(both.default_ipv6_ifindex==9);#expect(both.deny_prefix_count==0)
    }
    @Test func publicVPNPrefixesAndStaticHostRoutesBecomeDenials() {
        let (valid,s)=routeParse(routeRecord("0.0.0.0",bits:0)+routeRecord("8.8.8.0",bits:24,flags:Int32(RTF_UP|RTF_GATEWAY|RTF_STATIC))+routeRecord("9.9.9.9",flags:Int32(RTF_UP|RTF_HOST|RTF_STATIC))+routeRecord("2001:4860::",bits:32))
        #expect(valid);#expect(s.deny_prefix_count==3);#expect(routeMatches(s,"8.8.8.0",24));#expect(routeMatches(s,"9.9.9.9",32));#expect(routeMatches(s,"2001:4860::",32))
    }
    @Test func clonedAndARPCachesAreExcludedButStaticOverridesThem() {
        let generated=Int32(RTF_UP|RTF_HOST|RTF_WASCLONED|RTF_LLINFO)
        let (valid,s)=routeParse(routeRecord("8.8.8.8",flags:generated,parentFlags:Int32(RTF_STATIC))+routeRecord("9.9.9.9",flags:generated|Int32(RTF_STATIC))+routeRecord("8.8.4.4",flags:generated|Int32(RTF_LOCAL)))
        #expect(valid);#expect(s.ignored_generated_count==1);#expect(s.deny_prefix_count==2);#expect(routeMatches(s,"9.9.9.9",32));#expect(routeMatches(s,"8.8.4.4",32))
    }
    @Test func cloningParentNetworkIsNotGeneratedHostCache() {
        let (valid,s)=routeParse(routeRecord("8.8.8.0",bits:24,flags:Int32(RTF_UP|RTF_CLONING|RTF_PRCLONING)))
        #expect(valid);#expect(s.ignored_generated_count==0);#expect(routeMatches(s,"8.8.8.0",24))
    }
    @Test func rejectsAndBlackholesRemainDenialsIncludingDefault() {
        let (valid,s)=routeParse(routeRecord("8.0.0.0",bits:8,flags:Int32(RTF_REJECT))+routeRecord("2001:4860::",bits:32,flags:Int32(RTF_BLACKHOLE))+routeRecord("0.0.0.0",bits:0,flags:Int32(RTF_UP|RTF_BLACKHOLE)))
        #expect(valid);#expect(s.default_ipv4_ifindex==0);#expect(routeMatches(s,"8.0.0.0",8));#expect(routeMatches(s,"2001:4860::",32));#expect(routeMatches(s,"0.0.0.0",0))
    }
    @Test func shortMasksUseFourByteAlignmentAndZeroFill() {
        // /8 IPv4 mask is5 bytes, padded to8. A following record must stay aligned.
        let (valid,s)=routeParse(routeRecord("8.9.8.7",bits:8,shortMask:true)+routeRecord("2001:4860:1::",bits:33,shortMask:true)+routeRecord("0.0.0.0",bits:0,index:12,shortMask:true))
        #expect(valid);#expect(s.record_count==3);#expect(routeMatches(s,"8.0.0.0",8));#expect(routeMatches(s,"2001:4860::",33));#expect(s.default_ipv4_ifindex==12)
    }
    @Test func radixMaskFamilyByteIsMaskDataNotAnAddressFamily() {
        var bytes=routeRecord("8.8.8.0",bits:24,shortMask:true)
        let mask=MemoryLayout<rt_msghdr2>.size+MemoryLayout<sockaddr_in>.size
        bytes[mask+1]=255
        let (valid,s)=routeParse(bytes);#expect(valid);#expect(routeMatches(s,"8.8.8.0",24))
    }
    @Test func multipleUnscopedDefaultsCloseOnlyTheirFamily() {
        let (valid,s)=routeParse(routeRecord("0.0.0.0",bits:0,index:4)+routeRecord("0.0.0.0",bits:0,index:8)+routeRecord("::",bits:0,index:9))
        #expect(valid);#expect(s.default_ipv4_ifindex==0);#expect(s.default_ipv6_ifindex==9)
        let (_,duplicates)=routeParse(routeRecord("0.0.0.0",bits:0,index:4)+routeRecord("0.0.0.0",bits:0,index:4))
        #expect(duplicates.default_ipv4_ifindex==4)
    }
    @Test func repeatedIPv6RoutersOnOneInterfaceRemainUsable() {
        let (_,same)=routeParse(routeRecord("::",bits:0,index:9)+routeRecord("::",bits:0,index:9))
        #expect(same.default_ipv6_ifindex==9)
        let (_,different)=routeParse(routeRecord("::",bits:0,index:9)+routeRecord("::",bits:0,index:10))
        #expect(different.default_ipv6_ifindex==0)
    }
    @Test func pairedSplitDefaultsSupersedeOrdinaryDefaultButRetainOtherFences() {
        let (_,s)=routeParse(routeRecord("0.0.0.0",bits:0,index:4)+routeRecord("0.0.0.0",bits:1,index:8)+routeRecord("128.0.0.0",bits:1,index:8)+routeRecord("::",bits:1,index:9)+routeRecord("8000::",bits:1,index:9)+routeRecord("8.8.8.0",bits:24,index:8)+routeRecord("10.0.0.0",bits:8,index:8))
        #expect(s.inventory_complete);#expect(s.default_ipv4_ifindex==8);#expect(s.default_ipv6_ifindex==9)
        #expect(s.deny_prefix_count==2);#expect(routeMatches(s,"8.8.8.0",24));#expect(routeMatches(s,"10.0.0.0",8))
    }
    @Test func incompleteAmbiguousOrRestrictedSplitDefaultsRemainDenied() {
        let variants=[
            routeRecord("0.0.0.0",bits:1,index:8),
            routeRecord("0.0.0.0",bits:1,index:8)+routeRecord("128.0.0.0",bits:1,index:9),
            routeRecord("0.0.0.0",bits:1,index:8)+routeRecord("0.0.0.0",bits:1,index:9)+routeRecord("128.0.0.0",bits:1,index:8),
            routeRecord("0.0.0.0",bits:1,index:8)+routeRecord("128.0.0.0",bits:1,index:8,shortMask:true, parentFlags:0)+routeRecord("128.0.0.0",bits:1,flags:Int32(RTF_UP|RTF_BLACKHOLE),index:8)
        ]
        for (position,bytes) in variants.enumerated() {
            let (_,s)=routeParse(routeRecord("0.0.0.0",bits:0,index:4)+bytes)
            #expect(s.inventory_complete);#expect(s.deny_prefix_count>0)
            #expect(routeMatches(s,position==variants.count-1 ? "128.0.0.0":"0.0.0.0",1))
        }
        let (_,scoped)=routeParse(routeRecord("0.0.0.0",bits:1,flags:Int32(RTF_UP|RTF_IFSCOPE),index:8)+routeRecord("128.0.0.0",bits:1,index:8))
        #expect(scoped.default_ipv4_ifindex==0);#expect(scoped.deny_prefix_count==2)
    }
    @Test func mappedIPv6RoutesCannotLoseTheirIPv4Denial() {
        let (valid,s)=routeParse(routeRecord("::ffff:8.8.8.0",bits:120)+routeRecord("::ffff:9.9.9.9",flags:Int32(RTF_UP|RTF_HOST|RTF_STATIC)))
        #expect(valid);#expect(routeMatches(s,"8.8.8.0",24));#expect(routeMatches(s,"9.9.9.9",32))
    }
    @Test func scopedDefaultsCannotChoosePublicInterface() {
        let flags=Int32(RTF_UP|RTF_GATEWAY|RTF_IFSCOPE)
        let (valid,s)=routeParse(routeRecord("0.0.0.0",bits:0,flags:flags,index:2)+routeRecord("0.0.0.0",bits:0,index:4)+routeRecord("::",bits:0,flags:flags,index:8))
        #expect(valid);#expect(s.default_ipv4_ifindex==4);#expect(s.default_ipv6_ifindex==0);#expect(s.deny_prefix_count==0)
    }
    @Test func prefixDedupAndInventoryOverflowFailClosed() {
        let repeated=routeRecord("8.8.8.0",bits:24)
        let (valid,s)=routeParse(repeated+repeated);#expect(valid);#expect(s.deny_prefix_count==1)
        var entries:[UInt8]=[]
        for i in 0...Int(WC_NETWORK_MAX_PREFIXES) {entries += routeRecord("8.\(i).0.0",bits:16)}
        let (overflow,out)=routeParse(entries);#expect(!overflow);#expect(!out.inventory_complete);#expect(out.default_ipv4_ifindex==0);#expect(out.deny_prefix_count==0)
    }
    @Test func truncatedAndUnknownInventoryNeverReturnsPartialReadyState() {
        let good=routeRecord("0.0.0.0",bits:0,index:4)
        for length in 1..<good.count {let (valid,s)=routeParse(Array(good.prefix(length)));#expect(!valid);#expect(!s.inventory_complete);#expect(s.default_ipv4_ifindex==0)}
        var bad=good;bad[2]=UInt8(RTM_VERSION+1)
        let (version,s)=routeParse(good+bad);#expect(!version);#expect(s.default_ipv4_ifindex==0)
        bad=good;bad[3]=UInt8(RTM_GET);#expect(!routeParse(bad).0)
        bad=good;bad[0]=0;bad[1]=0;#expect(!routeParse(bad).0)
    }
    @Test func noncontiguousMaskAndUnknownAddressBitsAreRefused() {
        var bad=routeRecord("8.0.0.0",bits:8);let mask=MemoryLayout<rt_msghdr2>.size+MemoryLayout<sockaddr_in>.size;bad[mask+5]=1
        #expect(!routeParse(bad).0)
        var header=rt_msghdr2();header.rtm_msglen=UInt16(MemoryLayout<rt_msghdr2>.size);header.rtm_version=UInt8(RTM_VERSION);header.rtm_type=UInt8(RTM_GET2);header.rtm_addrs=1<<10
        #expect(!routeParse(withUnsafeBytes(of:header) {Array($0)}).0)
    }
    @Test func unalignedAddressStorageAndInvalidLinkSockaddrAreHandled() {
        let data=routeRecord("8.8.8.0",bits:24)
        var padded:[UInt8]=[255];padded += data
        var result=wc_host_route_snapshot()
        let valid=padded.withUnsafeBufferPointer {wc_host_routes_parse($0.baseAddress!.advanced(by:1),data.count,&result)}
        #expect(valid);#expect(routeMatches(result,"8.8.8.0",24))
        var header=rt_msghdr2();header.rtm_msglen=UInt16(MemoryLayout<rt_msghdr2>.size+MemoryLayout<sockaddr_in>.size+8);header.rtm_version=UInt8(RTM_VERSION);header.rtm_type=UInt8(RTM_GET2);header.rtm_flags=Int32(RTF_UP|RTF_HOST);header.rtm_addrs=Int32(RTA_DST|RTA_GATEWAY)
        // AF_LINK claims20 bytes of name/address data in an8-byte record.
        let bad=withUnsafeBytes(of:header) {Array($0)}+routeSockaddr("8.8.8.8")+[8,UInt8(AF_LINK),0,0,0,10,10,0]
        #expect(!routeParse(bad).0)
    }
    @Test func limitsRejectOversizedBytesAndRecordCounts() {
        let oversized=[UInt8](repeating:0,count:Int(WC_HOST_ROUTE_MAX_BYTES)+1);#expect(!routeParse(oversized).0)
        let generated=routeRecord("8.8.8.8",flags:Int32(RTF_UP|RTF_HOST|RTF_WASCLONED))
        let bytes=Array(repeating:generated,count:Int(WC_HOST_ROUTE_MAX_RECORDS)+1).flatMap {$0}
        #expect(!routeParse(bytes).0)
    }
    @Test func actualReadOnlySnapshotReportsCountsAndBooleansOnly() {
        var s=wc_host_route_snapshot();let valid=wc_host_routes_read(&s)
        // No address inventory or interface indices are emitted from this check.
        print("{\"routeSnapshotComplete\":\(valid),\"routeRecords\":\(s.record_count),\"routePrefixes\":\(s.deny_prefix_count),\"routeGeneratedIgnored\":\(s.ignored_generated_count),\"ipv4DefaultAvailable\":\(s.default_ipv4_ifindex != 0),\"ipv6DefaultAvailable\":\(s.default_ipv6_ifindex != 0)}")
        #expect(valid == s.inventory_complete)
    }
}
