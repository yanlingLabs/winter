import Foundation
import Darwin
import KeyBrokerCore

do {
    guard fcntl(3,F_GETFD)>=0 else { throw BrokerFailure.unauthorizedChannel }
    let channel=OwnedFD(3)
    let bootstrap=try channel.receivePacket()
    var request=try LaunchRequest.decode(bootstrap)
    func submit(_ bytes: Data, duplicate: Bool = false) throws { try channel.packet(bytes);if duplicate { try channel.packet(bytes) };guard try channel.receivePacket()==Data([1]) else { throw BrokerFailure.unauthorizedChannel };channel.close() }
    switch CommandLine.arguments.last {
    case "authorized", "replay": break
    case "cross-workspace":
        let id=request.identity
        let other=try VolumeIdentity(homeId:id.homeId,homePath:id.homePath,homeDevice:id.homeDevice,homeInode:id.homeInode,workspaceId:UUID().uuidString.lowercased(),volumeId:id.volumeId,creationId:id.creationId,keyVersion:id.keyVersion,purpose:id.purpose)
        request=LaunchRequest(nonce:request.nonce,identity:other)
    case "cross-home", "cross-volume", "cross-creation", "cross-version":
        let id=request.identity,mode=CommandLine.arguments.last!
        let other=try VolumeIdentity(homeId:mode=="cross-home" ? UUID().uuidString.lowercased():id.homeId,homePath:id.homePath,homeDevice:id.homeDevice,homeInode:id.homeInode,workspaceId:id.workspaceId,volumeId:mode=="cross-volume" ? UUID().uuidString.lowercased():id.volumeId,creationId:mode=="cross-creation" ? UUID().uuidString.lowercased():id.creationId,keyVersion:mode=="cross-version" ? id.keyVersion+1:id.keyVersion,purpose:id.purpose)
        request=LaunchRequest(nonce:request.nonce,identity:other)
    case "forged-pid":
        var object=try JSONSerialization.jsonObject(with:bootstrap) as! [String:Any];object["pid"]=getpid();try submit(JSONSerialization.data(withJSONObject:object));exit(0)
    case "forged-executable":
        var object=try JSONSerialization.jsonObject(with:bootstrap) as! [String:Any];object["executable"]="/usr/bin/true";try submit(JSONSerialization.data(withJSONObject:object));exit(0)
    case "derive", "decrypt":
        var object=try JSONSerialization.jsonObject(with:bootstrap) as! [String:Any];object[CommandLine.arguments.last!]="master";try submit(JSONSerialization.data(withJSONObject:object));exit(0)
    case "wrong-token": request=LaunchRequest(nonce:Data(repeating:0,count:32),identity:request.identity)
    default: throw BrokerFailure.unauthorizedChannel
    }
    try submit(JSONEncoder().encode(request),duplicate:CommandLine.arguments.last=="replay")
    // Client/daemon never receives a worker key or a generic decrypt result.
    channel.close()
} catch { exit(71) }
