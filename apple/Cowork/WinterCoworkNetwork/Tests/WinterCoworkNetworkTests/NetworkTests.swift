import Testing
import Foundation
import Darwin
import CoworkNetworkC
@testable import WinterCoworkNetwork

private func address(_ text: String, _ port: UInt16 = 443) -> wc_network_address {
    var a=wc_network_address(); precondition(text.withCString {wc_network_parse_address($0,port,&a)}); return a
}
private func allowed(_ policy: wc_network_policy,_ text:String,_ port:UInt16=443,_ proto:UInt8=6,_ dns:Bool=false,_ now:UInt64=1)->Bool {
    var p=policy,a=address(text,port); return wc_network_destination_allowed(&p,&a,proto,dns,now)
}
private func sum(_ bytes:[UInt8])->UInt16 {
    var value:UInt32=0; for i in stride(from:0,to:bytes.count,by:2) {value += UInt32(bytes[i])<<8; if i+1<bytes.count {value += UInt32(bytes[i+1])}}
    while value>>16 != 0 {value=(value&65535)+(value>>16)}; return ~UInt16(value)
}
private func put(_ v:UInt16,_ bytes:inout [UInt8],_ offset:Int) {bytes[offset]=UInt8(v>>8); bytes[offset+1]=UInt8(v&255)}
private func packet(destination:[UInt8],port:UInt16,protocol proto:UInt8=17,payload:[UInt8]=[1,2,3]) -> [UInt8] {
    let transport=proto==6 ? 20:8; var frame=[UInt8](repeating:0,count:34+transport+payload.count)
    frame.replaceSubrange(0..<6,with:[0x52,0x55,10,0,2,2]); frame.replaceSubrange(6..<12,with:[2,0x77,0x69,0,0,1]); frame[12]=8
    frame[14]=0x45; put(UInt16(frame.count-14),&frame,16); frame[22]=64; frame[23]=proto
    frame.replaceSubrange(26..<30,with:[10,0,2,15]); frame.replaceSubrange(30..<34,with:destination)
    put(sum(Array(frame[14..<34])),&frame,24); put(40000,&frame,34); put(port,&frame,36)
    if proto==17 {put(UInt16(transport+payload.count),&frame,38)} else {frame[41]=1; frame[46]=0x50;frame[47]=2;put(65535,&frame,48)}
    frame.replaceSubrange(34+transport..<frame.count,with:payload)
    if proto==6 {var pseudo=Array(frame[26..<34]);pseudo += [0,6,UInt8((transport+payload.count)>>8),UInt8((transport+payload.count)&255)];pseudo += frame[34...];put(sum(pseudo),&frame,50)}
    return frame
}
private func classify(_ policy:wc_network_policy,_ bytes:[UInt8])->Int32 {var p=policy;return bytes.withUnsafeBufferPointer {wc_network_classify_frame(&p,$0.baseAddress,$0.count,1)}}
private func scope()->NetworkEndpointScope {.init(workspaceId:"test-workspace",incarnationId:UUID().uuidString,leaseEpoch:1)}

@Test func publicAndPrivateDestinations() throws {
    let p=try NetworkEndpointPolicy(revision:1).native(syntheticNoOutbound:true)
    #expect(allowed(p,"8.8.8.8")); #expect(allowed(p,"2606:4700:4700::1111"))
    for ip in ["127.0.0.1","10.1.2.3","192.168.1.2","172.16.1.2","169.254.169.254","100.64.0.1","::1","fc00::1","fe80::1","ff02::1","::ffff:127.0.0.1","::ffff:192.168.1.1","198.18.0.1","192.0.2.1","2001:db8::1","2002:c0a8:101::1"] {#expect(!allowed(p,ip),"\(ip)")}
}
@Test func exactGrantTransportPortAndExpiry() throws {
    let p=try NetworkEndpointPolicy(revision:1,publicInternet:false,grants:[.init(address:"127.0.0.1",port:1234,transport:.tcp,expiresMonotonicNanoseconds:10)]).native(syntheticNoOutbound:true)
    #expect(allowed(p,"127.0.0.1",1234,6,false,9));#expect(!allowed(p,"127.0.0.1",1234,6,false,10));#expect(!allowed(p,"127.0.0.1",1234,17));#expect(!allowed(p,"127.0.0.1",1235));#expect(!allowed(p,"127.0.0.2",1234))
}
@Test func globallyRoutableHostNetworkDenied() throws {
    let p=try NetworkEndpointPolicy(revision:1,additionalHostNetworks:[.init(address:"8.8.8.0",prefixLength:24),.init(address:"2606:4700::",prefixLength:32)]).native(syntheticNoOutbound:true)
    #expect(!allowed(p,"8.8.8.8"));#expect(!allowed(p,"2606:4700:4700::1111"));#expect(allowed(p,"9.9.9.9"))
    let mapped=try NetworkEndpointPolicy(revision:1,additionalHostNetworks:[.init(address:"::ffff:8.8.8.8",prefixLength:128)]).native(syntheticNoOutbound:true)
    #expect(!allowed(mapped,"8.8.8.8"));#expect(!allowed(mapped,"::ffff:8.8.8.8"))
}
@Test func fullSuppliedPrefixInventoryCannotSkipObservedHostFences() async throws {
    // Synthetic mode still executes final translated-tuple policy, then refuses before
    // any outbound syscall. Compare the same otherwise-public datagram in both views.
    for full in [false, true] {
        let prefixes: [HostNetworkPrefix] = full ? Array(repeating: .init(address: "192.0.2.0", prefixLength: 24), count: 128) : []
        let endpoint = try CoworkNetworkEndpoint(scope: scope(), policy: .init(revision: 1, additionalHostNetworks: prefixes), syntheticNoOutbound: true)
        let fd = try endpoint.duplicateGuestFDForSyntheticTest()
        let frame = packet(destination: [8,8,8,8], port: 443)
        #expect(frame.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) } == frame.count)
        for _ in 0..<200 {
            let stats = try endpoint.statistics()
            if stats.denied > 0 || stats.outboundAttempts > 0 { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        let stats = try endpoint.statistics()
        #expect(full ? stats.denied > 0 && stats.outboundAttempts == 0 : stats.outboundAttempts == 1)
        close(fd); await endpoint.shutdown()
    }
}
@Test func controlledSystemResolverException() throws {
    let p=try NetworkEndpointPolicy(revision:1,dns:.init(addresses:["192.168.1.1"])).native(syntheticNoOutbound:true)
    #expect(allowed(p,"192.168.1.1",53,17,true));#expect(allowed(p,"192.168.1.1",53,6,true));#expect(!allowed(p,"192.168.1.1",53,17,false));#expect(!allowed(p,"192.168.1.2",53,17,true));#expect(!allowed(p,"192.168.1.1",80,6,true))
    #expect(!allowed(try NetworkEndpointPolicy(revision:1,publicInternet:false,dns:.init(addresses:["192.168.1.1"])).native(syntheticNoOutbound:true),"192.168.1.1",53,17,true))
}
@Test func noMulticastEvenExplicitGrant() throws {
    let p=try NetworkEndpointPolicy(revision:1,grants:[.init(address:"224.0.0.1",port:1234,transport:.udp)]).native(syntheticNoOutbound:true)
    #expect(!allowed(p,"224.0.0.1",1234,17))
}
@Test func packetPolicyAndGatewayFinalTuple() throws {
    let p=try NetworkEndpointPolicy(revision:1).native(syntheticNoOutbound:true)
    #expect(classify(p,packet(destination:[8,8,8,8],port:443))==1)
    #expect(classify(p,packet(destination:[127,0,0,1],port:443))==0)
    #expect(classify(p,packet(destination:[10,0,2,2],port:443))==0)
    let grant=try NetworkEndpointPolicy(revision:1,publicInternet:false,grants:[.init(address:"127.0.0.1",port:443,transport:.udp)]).native(syntheticNoOutbound:true)
    #expect(classify(grant,packet(destination:[10,0,2,2],port:443))==1)
    #expect(classify(grant,packet(destination:[10,0,2,4],port:443))==0)
}
@Test func packetFragmentsAndRawProtocolsUnsupported() throws {
    let p=try NetworkEndpointPolicy(revision:1).native(syntheticNoOutbound:true)
    var f=packet(destination:[8,8,8,8],port:443); f[20]=0x20; #expect(classify(p,f)==(-1))
    f=packet(destination:[8,8,8,8],port:443);f[23]=1;#expect(classify(p,f)==(-1))
    f=packet(destination:[8,8,8,8],port:443);f[6]=0;#expect(classify(p,f)==(-1))
}
@Test func packetDNSAliasNoImplicitResolver() throws {
    var query=[UInt8](repeating:0,count:17);query[5]=1;query[12]=0;query[14]=1;query[16]=1
    let frame=packet(destination:[10,0,2,3],port:53,payload:query)
    #expect(classify(try NetworkEndpointPolicy(revision:1).native(syntheticNoOutbound:true),frame)==0)
    #expect(classify(try NetworkEndpointPolicy(revision:1,dns:.init(addresses:["192.168.1.1"])).native(syntheticNoOutbound:true),frame)==1)
    #expect(classify(try NetworkEndpointPolicy(revision:1).native(syntheticNoOutbound:true),packet(destination:[192,168,1,1],port:53,payload:query))==0)
}
@Test func policyReplacementAcknowledgesAndRejectsStaleRevision() async throws {
    let e=try CoworkNetworkEndpoint(scope:scope(),policy:.init(revision:3),syntheticNoOutbound:true)
    try await e.replacePolicy(.init(revision:4,publicInternet:false),expectedRevision:3);#expect(try e.statistics().revision==4)
    await #expect(throws:NetworkEndpointError.self) {try await e.replacePolicy(.init(revision:5),expectedRevision:3)}
    await e.shutdown();#expect(throws:NetworkEndpointError.self) {try e.statistics()}
}
private func localSocket(_ type:Int32)->(Int32,UInt16) {
    let fd=socket(AF_INET,type,0);precondition(fd>=0);var a=sockaddr_in();a.sin_len=UInt8(MemoryLayout<sockaddr_in>.size);a.sin_family=sa_family_t(AF_INET);a.sin_addr.s_addr=inet_addr("127.0.0.1")
    let result=withUnsafePointer(to:&a) {$0.withMemoryRebound(to:sockaddr.self,capacity:1) {bind(fd,$0,socklen_t(MemoryLayout<sockaddr_in>.size))}};precondition(result==0)
    var n=socklen_t(MemoryLayout<sockaddr_in>.size);withUnsafeMutablePointer(to:&a) {$0.withMemoryRebound(to:sockaddr.self,capacity:1) {_=getsockname(fd,$0,&n)}}
    _ = fcntl(fd,F_SETFL,O_NONBLOCK)
    return (fd,UInt16(bigEndian:a.sin_port))
}
private func readable(_ fd:Int32,_ timeout:Int32=1500)->Bool {var p=pollfd(fd:fd,events:Int16(POLLIN),revents:0);return poll(&p,1,timeout)>0 && p.revents&Int16(POLLIN) != 0}
@Test func realUDPRequiresGrantAndRejectsUnsolicitedPeer() async throws {
    let (server,port)=localSocket(SOCK_DGRAM);defer {close(server)}
    let e=try CoworkNetworkEndpoint(scope:scope(),policy:.init(revision:1,publicInternet:false,grants:[.init(address:"127.0.0.1",port:port,transport:.udp)]))
    let fd=try e.duplicateGuestFDForSyntheticTest();defer{close(fd)}
    let frame=packet(destination:[10,0,2,2],port:port,payload:[0x77,0x69,0x6e]);#expect(frame.withUnsafeBytes {send(fd,$0.baseAddress,$0.count,0)}==frame.count)
    #expect(readable(server));var bytes=[UInt8](repeating:0,count:64);var peer=sockaddr_storage();var n=socklen_t(MemoryLayout<sockaddr_storage>.size)
    let received=withUnsafeMutablePointer(to:&peer) {$0.withMemoryRebound(to:sockaddr.self,capacity:1) {sa in recvfrom(server,&bytes,bytes.count,0,sa,&n)}};#expect(received==3)
    let (rogue,_)=localSocket(SOCK_DGRAM);defer{close(rogue)}
    withUnsafePointer(to:&peer) {$0.withMemoryRebound(to:sockaddr.self,capacity:1) {_=sendto(rogue,[UInt8](repeating:8,count:3),3,0,$0,n)}}
    for _ in 0..<2000 {if try e.statistics().inboundPeerDenied>0 {break};try await Task.sleep(for:.milliseconds(1))}
    let deniedPeers=try e.statistics().inboundPeerDenied;#expect(deniedPeers==1)
    try await e.replacePolicy(.init(revision:2,publicInternet:false),expectedRevision:1);#expect(try e.statistics().activeSockets==0)
    #expect(frame.withUnsafeBytes {send(fd,$0.baseAddress,$0.count,0)}==frame.count);#expect(!readable(server,150));#expect(try e.statistics().denied>0)
    await e.shutdown()
}
private func udpReply(_ server:Int32,_ text:String)throws {
    try #require(readable(server));var data=[UInt8](repeating:0,count:64),peer=sockaddr_storage();var size=socklen_t(MemoryLayout<sockaddr_storage>.size)
    let count=withUnsafeMutablePointer(to:&peer){$0.withMemoryRebound(to:sockaddr.self,capacity:1){recvfrom(server,&data,data.count,0,$0,&size)}}
    try #require(count>0)
    let bytes=Array(text.utf8)
    let sent=withUnsafePointer(to:&peer){$0.withMemoryRebound(to:sockaddr.self,capacity:1){destination in bytes.withUnsafeBytes{sendto(server,$0.baseAddress,$0.count,0,destination,size)}}}
    #expect(sent==bytes.count)
}
private func receiveUDPText(_ fd:Int32,_ expected:String)throws {
    let deadline=Date().addingTimeInterval(2)
    while Date()<deadline {
        if !readable(fd,20){continue};var bytes=[UInt8](repeating:0,count:1600);let count=recv(fd,&bytes,bytes.count,0)
        if count<42 || bytes[12] != 8 || bytes[13] != 0 || bytes[23] != 17 {continue}
        let at=14+Int(bytes[14]&15)*4+8,end=14+Int(bytes[16])*256+Int(bytes[17])
        if at<=end && end<=count && String(decoding:bytes[at..<end],as:UTF8.self)==expected {return}
    }
    throw NetworkEndpointError("fixture_timeout","Expected UDP payload was not observed")
}
@Test func UDPRemembersEachAdmittedPeerAndExpiryKeepsTheUnrelatedFlow() async throws {
    let (a,portA)=localSocket(SOCK_DGRAM),(b,portB)=localSocket(SOCK_DGRAM);defer{close(a);close(b)}
    var now=timespec();clock_gettime(CLOCK_MONOTONIC,&now);let expires=UInt64(now.tv_sec)*1_000_000_000+UInt64(now.tv_nsec)+500_000_000
    let endpoint=try CoworkNetworkEndpoint(scope:scope(),policy:.init(revision:1,publicInternet:false,grants:[.init(address:"127.0.0.1",port:portA,transport:.udp,expiresMonotonicNanoseconds:expires),.init(address:"127.0.0.1",port:portB,transport:.udp)]))
    let fd=try endpoint.duplicateGuestFDForSyntheticTest();defer{close(fd)};learnGuestARP(fd)
    for port in [portA,portB] {let f=packet(destination:[10,0,2,2],port:port);#expect(f.withUnsafeBytes{send(fd,$0.baseAddress,$0.count,0)}==f.count)}
    try udpReply(a,"first");try receiveUDPText(fd,"first");try udpReply(b,"second");try receiveUDPText(fd,"second")
    #expect(try endpoint.statistics().inboundPeerDenied==0);#expect(try endpoint.statistics().activeSockets==1)
    // Queue a second B request before A expires, then reply after the deadline. A stack
    // reset would close B's old host socket and lose this legitimate response.
    let f=packet(destination:[10,0,2,2],port:portB);_ = f.withUnsafeBytes{send(fd,$0.baseAddress,$0.count,0)}
    try await Task.sleep(for:.milliseconds(600));#expect(try endpoint.statistics().activeSockets==1)
    try udpReply(b,"still-second");try receiveUDPText(fd,"still-second");await endpoint.shutdown()
}
@Test func realTCPConnectionRequiresExactGrant() async throws {
    let (server,port)=localSocket(SOCK_STREAM);defer{close(server)};#expect(listen(server,1)==0)
    let e=try CoworkNetworkEndpoint(scope:scope(),policy:.init(revision:1,publicInternet:false,grants:[.init(address:"127.0.0.1",port:port,transport:.tcp)]))
    let fd=try e.duplicateGuestFDForSyntheticTest();defer{close(fd)};let frame=packet(destination:[10,0,2,2],port:port,protocol:6,payload:[])
    #expect(frame.withUnsafeBytes {send(fd,$0.baseAddress,$0.count,0)}==frame.count);#expect(readable(server));let peer=accept(server,nil,nil);#expect(peer>=0);if peer>=0 {close(peer)}
    try await e.replacePolicy(.init(revision:2,publicInternet:false),expectedRevision:1);#expect(try e.statistics().activeSockets==0);await e.shutdown()
}
private func put32(_ n:UInt32,_ bytes:inout[UInt8],_ at:Int) {for i in 0..<4 {bytes[at+i]=UInt8(truncatingIfNeeded:n>>UInt32((3-i)*8))}}
private func read32(_ bytes:[UInt8],_ at:Int)->UInt32 {(0..<4).reduce(0){($0<<8)|UInt32(bytes[at+$1])}}
private func tcpPacket(_ port:UInt16,_ seq:UInt32,_ ack:UInt32,_ flags:UInt8,_ payload:[UInt8]=[])->[UInt8] {
    var f=packet(destination:[10,0,2,2],port:port,protocol:6,payload:payload)
    put32(seq,&f,38);put32(ack,&f,42);f[47]=flags;put(0,&f,50)
    let count=f.count-34;var pseudo=Array(f[26..<34]);pseudo += [0,6,UInt8(count>>8),UInt8(count&255)];pseudo += f[34...];put(sum(pseudo),&f,50);return f
}
private func learnGuestARP(_ fd:Int32) {
    var f=[UInt8](repeating:0,count:42);f.replaceSubrange(0..<6,with:[UInt8](repeating:255,count:6));f.replaceSubrange(6..<12,with:[2,0x77,0x69,0,0,1]);put(0x806,&f,12);put(1,&f,14);put(0x800,&f,16);f[18]=6;f[19]=4;put(1,&f,20)
    f.replaceSubrange(22..<28,with:[2,0x77,0x69,0,0,1]);f.replaceSubrange(28..<32,with:[10,0,2,15]);f.replaceSubrange(38..<42,with:[10,0,2,2]);_ = f.withUnsafeBytes{send(fd,$0.baseAddress,$0.count,0)}
}
private func receiveTCP(_ fd:Int32,where matches:([UInt8],Int)->Bool) throws -> ([UInt8],Int) {
    let deadline=Date().addingTimeInterval(2)
    while Date()<deadline {
        if !readable(fd,20){continue};var bytes=[UInt8](repeating:0,count:1600);let count=recv(fd,&bytes,bytes.count,0)
        if count<54 {continue};bytes=Array(bytes.prefix(count));if bytes[12] != 8 || bytes[13] != 0 || bytes[23] != 6 {continue}
        let tcp=14+Int(bytes[14]&15)*4, ipEnd=14+Int(bytes[16])*256+Int(bytes[17])
        // Ethernet may pad a pure ACK to its minimum frame size; that is not TCP payload.
        if tcp+20<=ipEnd && ipEnd<=count {bytes=Array(bytes.prefix(ipEnd));if matches(bytes,tcp){return(bytes,tcp)}}
    }
    throw NetworkEndpointError("fixture_timeout","Expected TCP frame was not observed")
}
@Test func realTCPPayloadAndResetCloseTheFlowWithoutPollingSpin() async throws {
    let (server,port)=localSocket(SOCK_STREAM);defer{close(server)};#expect(listen(server,1)==0)
    let endpoint=try CoworkNetworkEndpoint(scope:scope(),policy:.init(revision:1,publicInternet:false,grants:[.init(address:"127.0.0.1",port:port,transport:.tcp)]))
    let fd=try endpoint.duplicateGuestFDForSyntheticTest();defer{close(fd)};learnGuestARP(fd)
    var frame=tcpPacket(port,1,0,2);#expect(frame.withUnsafeBytes{send(fd,$0.baseAddress,$0.count,0)}==frame.count)
    #expect(readable(server));let peer=accept(server,nil,nil);#expect(peer>=0)
    guard peer>=0 else {await endpoint.shutdown();return}
    var peerClosed=false;defer{if !peerClosed {close(peer)}}
    let (syn,tcp)=try receiveTCP(fd){$0[$1+13]&0x12==0x12};let remoteSeq=read32(syn,tcp+4)
    frame=tcpPacket(port,2,remoteSeq&+1,0x10);_ = frame.withUnsafeBytes{send(fd,$0.baseAddress,$0.count,0)}
    frame=tcpPacket(port,2,remoteSeq&+1,0x18,Array("hello".utf8));_ = frame.withUnsafeBytes{send(fd,$0.baseAddress,$0.count,0)}
    #expect(readable(peer));var data=[UInt8](repeating:0,count:5);#expect(recv(peer,&data,5,0)==5);#expect(String(decoding:data,as:UTF8.self)=="hello")
    let reply=Array("world".utf8);#expect(reply.withUnsafeBytes{send(peer,$0.baseAddress,$0.count,0)}==5)
    let (returned,start)=try receiveTCP(fd){frame,tcp in let at=tcp+Int(frame[tcp+12]>>4)*4;return at<frame.count}
    let dataAt=start+Int(returned[start+12]>>4)*4;#expect(String(decoding:returned[dataAt...],as:UTF8.self)=="world")
    frame=tcpPacket(port,7,remoteSeq&+6,0x10);_ = frame.withUnsafeBytes{send(fd,$0.baseAddress,$0.count,0)}
    var reset=linger(l_onoff:1,l_linger:0);#expect(setsockopt(peer,SOL_SOCKET,SO_LINGER,&reset,socklen_t(MemoryLayout<linger>.size))==0);close(peer);peerClosed=true
    for _ in 0..<200 {if try endpoint.statistics().activeSockets==0 {break};try await Task.sleep(for:.milliseconds(1))}
    #expect(try endpoint.statistics().activeSockets==0)
    let turns=try endpoint.statistics().pollTurns;try await Task.sleep(for:.milliseconds(150));#expect(try endpoint.statistics().pollTurns-turns<20)
    await endpoint.shutdown()
}
@Test func directIPv6AndPublicLocalMappingCannotBypass() async throws {
    let e=try CoworkNetworkEndpoint(scope:scope(),policy:.init(revision:1),syntheticNoOutbound:true);let fd=try e.duplicateGuestFDForSyntheticTest();defer{close(fd)}
    var f=[UInt8](repeating:0,count:62);f.replaceSubrange(6..<12,with:[2,0x77,0x69,0,0,1]);f[12]=0x86;f[13]=0xdd;f[14]=0x60;f[19]=8;f[20]=17;f[21]=64;f[22]=0xfd;f[25]=0x77;f[37]=0x15;f[53]=1;put(1234,&f,56);put(8,&f,58)
    #expect(f.withUnsafeBytes {send(fd,$0.baseAddress,$0.count,0)}==f.count);let local=packet(destination:[127,0,0,1],port:80);#expect(local.withUnsafeBytes {send(fd,$0.baseAddress,$0.count,0)}==local.count)
    try await Task.sleep(for:.milliseconds(100));#expect(try e.statistics().denied==2);#expect(try e.statistics().outboundAttempts==0);await e.shutdown()
}
