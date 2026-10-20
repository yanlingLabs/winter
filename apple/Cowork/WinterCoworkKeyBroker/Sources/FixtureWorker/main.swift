import Foundation
import Darwin
import CryptoKit
import KeyBrokerCore
import KeyBrokerNative

do {
    guard CommandLine.arguments==[CommandLine.arguments[0],"worker"],fcntl(3,F_GETFD)>=0 else { throw BrokerFailure.unauthorizedChannel }
    // Initialize immutable crypto/runtime code before the deny-default fixture.
    _=SHA256.hash(data:Data());let before=kb_security_service_denied()
    guard before==0 else { throw BrokerFailure.sandboxRequired }
    try fixtureSandbox()
    try emitFixtureJSON(WorkerReady(sandbox:true,bootstrapFD:3))
    let bootstrapFD=OwnedFD(3);var frame=try bootstrapFD.eofBytes();bootstrapFD.close()
    defer { wipe(&frame) }
    var decoded=try WorkerKeyFrame.decode(frame);defer { wipe(&decoded.material) }
    let bootstrap=decoded.bootstrap
    let key=SymmetricKey(data:decoded.material)
    wipe(&frame)
    let proof=Data(HMAC<SHA256>.authenticationCode(for:bootstrap.challenge,using:key))
    wipe(&decoded.material)
    let receipt=WorkerReceipt(keyFormat:bootstrap.identity.keyFormat,challenge:bootstrap.challenge,proof:proof,sandbox:true,bootstrapClosed:fcntl(3,F_GETFD) == -1,extraFDs:Int(kb_extra_fds()),fileDenied:kb_file_denied(bootstrap.deniedFixturePath)==1,networkDenied:kb_network_denied()==1,execDenied:kb_exec_denied()==1,securityServiceDenied:kb_security_service_denied()==1)
    try emitFixtureJSON(receipt)
} catch { exit(70) }
