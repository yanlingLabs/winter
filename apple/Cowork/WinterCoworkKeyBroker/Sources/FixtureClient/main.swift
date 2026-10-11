import Foundation
import Darwin
import KeyBrokerCore

do {
    guard fcntl(3,F_GETFD)>=0 else { throw BrokerFailure.unauthorizedChannel }
    let channel=OwnedFD(3)
    let bootstrap=try channel.receivePacket()
    var request=try LaunchRequest.decode(bootstrap)
    switch CommandLine.arguments.last {
    case "authorized": break
    case "cross-workspace":
        let id=request.identity
        let other=try VolumeIdentity(homeId:id.homeId,homePath:id.homePath,homeDevice:id.homeDevice,homeInode:id.homeInode,workspaceId:UUID().uuidString.lowercased(),volumeId:id.volumeId,creationId:id.creationId,keyVersion:id.keyVersion,purpose:id.purpose)
        request=LaunchRequest(nonce:request.nonce,identity:other)
    case "forged-pid":
        var object=try JSONSerialization.jsonObject(with:bootstrap) as! [String:Any];object["pid"]=getpid();try channel.packet(JSONSerialization.data(withJSONObject:object));channel.close();exit(0)
    case "forged-executable":
        var object=try JSONSerialization.jsonObject(with:bootstrap) as! [String:Any];object["executable"]="/usr/bin/true";try channel.packet(JSONSerialization.data(withJSONObject:object));channel.close();exit(0)
    case "wrong-token": request=LaunchRequest(nonce:Data(repeating:0,count:32),identity:request.identity)
    default: throw BrokerFailure.unauthorizedChannel
    }
    try channel.packet(JSONEncoder().encode(request))
    // Client/daemon never receives a worker key or a generic decrypt result.
    channel.close()
} catch { exit(71) }
