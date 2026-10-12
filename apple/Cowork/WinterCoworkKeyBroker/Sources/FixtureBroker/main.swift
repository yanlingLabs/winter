import Foundation
import Darwin
import KeyBrokerCore
import KeyBrokerNative

func require(_ value: Bool) throws { if !value { throw BrokerFailure.processFailure } }
let fixture=FileManager.default.temporaryDirectory.appendingPathComponent("winter-key-broker-"+UUID().uuidString).resolvingSymlinksInPath()
var extras:[Int32]=[]
do {
    guard CommandLine.arguments.count==3,CommandLine.arguments[1]=="--fixture" else { throw BrokerFailure.productionBlocked }
    let artifacts=URL(fileURLWithPath:CommandLine.arguments[2]).resolvingSymlinksInPath()
    let worker=try FixedFixtureImage(artifacts.appendingPathComponent("cowork-key-worker-fixture").path)
    let client=try FixedFixtureImage(artifacts.appendingPathComponent("cowork-key-client-fixture").path)
    try FileManager.default.createDirectory(at:fixture,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    defer { for fd in extras { Darwin.close(fd) };try? FileManager.default.removeItem(at:fixture) }
    let home=fixture.appendingPathComponent("home");try FileManager.default.createDirectory(at:home,withIntermediateDirectories:true)
    let denied=fixture.appendingPathComponent("sibling-private-sentinel");try Data("fixture-only".utf8).write(to:denied)
    var info=stat();try require(lstat(home.path,&info)==0)
    let homeId=UUID().uuidString.lowercased()
    func identity(workspace: String = UUID().uuidString.lowercased(),volume: String = UUID().uuidString.lowercased(),creation: String = UUID().uuidString.lowercased(),version: UInt64 = 1,keyFormat: VolumeKeyFormat = .fixtureRaw256V1,purpose: VolumePurpose = .data) throws -> VolumeIdentity {
        try VolumeIdentity(homeId:homeId,homePath:home.path,homeDevice:UInt64(bitPattern:Int64(info.st_dev)),homeInode:info.st_ino,workspaceId:workspace,volumeId:volume,creationId:creation,keyVersion:version,keyFormat:keyFormat,purpose:purpose)
    }
    let vault=SyntheticVault(),first=try vault.provisionForFixture(identity()),second=try vault.provisionForFixture(identity(keyFormat:.luks2AES256XTSHMACSHA256V1))
    try require(try vault.fixtureKeysDistinct([first,second]))
    for _ in 0..<160 { let fd=open("/dev/null",O_RDONLY);try require(fd>=0 && fcntl(fd,F_GETFD)&FD_CLOEXEC==0);extras.append(fd) }
    let launcher=FixtureWorkerLauncher(image:worker,vault:vault)
    func request(_ mode: String, record: SealedRecord) throws -> (OneShotAdmission,[Data],Int32) {
        let (host,peer)=try fixturePipe(channel:true),(reportReader,reportWriter)=try fixturePipe()
        let child=try OwnedChild(image:client,mode:mode,input:peer,output:reportWriter)
        peer.close();reportWriter.close()
        let admission=OneShotAdmission(record:record,launchedPID:child.pid)
        try host.packet(JSONEncoder().encode(admission.bootstrap()));try child.resume()
        let bytes=try host.receivePacket();var frames=[bytes];if mode=="replay" { frames.append(try host.receivePacket()) };var peerPID:Int32=0;try require(kb_peer_pid(host.value,&peerPID)==0)
        try client.validateExecuted(child.pid)
        try host.packet(Data([1]));try child.wait();try require(try reportReader.eofBytes().isEmpty);host.close()
        return (admission,frames,peerPID)
    }
    var receipts:[WorkerReceipt]=[]
    for record in [first,second] {
        let (admission,frames,pid)=try request("authorized",record:record)
        let admitted=try admission.consume(frames[0],kernelPeerPID:pid,vault:vault)
        receipts.append(try launcher.launch(admitted,deniedFixturePath:denied.path))
        do { _=try admission.consume(frames[0],kernelPeerPID:pid,vault:vault);throw BrokerFailure.processFailure } catch BrokerFailure.replay {}
    }
    try require(receipts.map { Int($0.keyByteCount) } == [32,96])
    let (replayAdmission,replayFrames,replayPID)=try request("replay",record:first)
    try require(replayFrames.count==2)
    let replayRecord=try replayAdmission.consume(replayFrames[0],kernelPeerPID:replayPID,vault:vault)
    _=try launcher.launch(replayRecord,deniedFixturePath:denied.path)
    let deliveries=launcher.keyDeliveries
    do { _=try replayAdmission.consume(replayFrames[1],kernelPeerPID:replayPID,vault:vault);throw BrokerFailure.processFailure } catch BrokerFailure.replay {}

    for mode in ["cross-workspace","cross-home","cross-volume","cross-creation","cross-version","cross-format","unknown-key-format","forged-pid","forged-executable","wrong-token","derive","decrypt"] {
        let (admission,frames,pid)=try request(mode,record:first)
        do { _=try admission.consume(frames[0],kernelPeerPID:pid,vault:vault);throw BrokerFailure.processFailure }
        catch BrokerFailure.unauthorizedChannel {} catch BrokerFailure.forbiddenField {} catch BrokerFailure.invalidIdentity {}
    }
    let (crossFormatAdmission,crossFormatFrames,crossFormatPID)=try request("cross-format",record:second)
    do { _=try crossFormatAdmission.consume(crossFormatFrames[0],kernelPeerPID:crossFormatPID,vault:vault);throw BrokerFailure.processFailure } catch BrokerFailure.unauthorizedChannel {}
    // Independently launched same fixture code has no inherited capability.
    let (dummyRead,dummyWrite)=try fixturePipe(),(outRead,outWrite)=try fixturePipe()
    let outsider=try OwnedChild(image:client,mode:"authorized",input:dummyRead,output:outWrite)
    dummyRead.close();dummyWrite.close();outWrite.close();try outsider.resume()
    try require(try outsider.waitStatus()==71)
    _=try outRead.eofBytes()
    // Deterministically replace the worker AFTER path verification. Its actual
    // spawned CodeDirectory differs, and no key may be sent to the wrong image.
    let swapped=fixture.appendingPathComponent("swapped-worker")
    try FileManager.default.copyItem(at:URL(fileURLWithPath:worker.path),to:swapped)
    let swappedImage=try FixedFixtureImage(swapped.path),swapLauncher=FixtureWorkerLauncher(image:swappedImage,vault:vault)
    do {
        _=try swapLauncher.launch(first,deniedFixturePath:denied.path,beforeSpawn:{
            try FileManager.default.removeItem(at:swapped)
            try FileManager.default.copyItem(at:URL(fileURLWithPath:client.path),to:swapped)
        });throw BrokerFailure.processFailure
    } catch BrokerFailure.imageMismatch {}
    try require(swapLauncher.keyDeliveries==0 && launcher.keyDeliveries==deliveries)
    // A worker's possession proof for A cannot prove possession of B's key.
    try require(!(try vault.proofMatches(receipts[0].proof,record:second,challenge:receipts[0].challenge)))
    try require(OwnedChild.ownershipDebt.isEmpty && OwnedChild.admissionCount==0)
    try emitFixtureJSON(["ownedChildNoUnresolvedDebt":true,"nativeKeyBrokerFixture":true,"twoWorkspaceWorkers":true,"format32And96WorkerDelivery":true,"workerFrameVersion2":true,"crossFormatEchoDeniedBothDirections":true,"unknownKeyFormatEchoDenied":true,"sealedIdentity":true,"ownedWorkerKeyDelivery":true,"daemonWorkspaceAuthorizationVerified":false,"inheritedOneShotEchoAdmission":true,"brokerSelectedIdentityEchoTamperingDenied":true,"clientPIDAndExecutableDenied":true,"replayDenied":true,"replayRealPacketsDenied":true,"genericDeriveDecryptDenied":true,"sameChallengeCrossKeyProofDenied":true,"independentClientDenied":true,"swappedExecutedImageDenied":true,"extra160InheritableFDsExcluded":true,"actualSandboxDenials":true,"daemonReceivesNoKeys":true,"actualKeychain":false,"realVM":false,"productionReady":false])
} catch { try? emitFixtureJSON(["nativeKeyBrokerFixture":false]);exit(72) }
