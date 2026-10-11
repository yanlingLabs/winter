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
    func identity(workspace: String = UUID().uuidString.lowercased(),volume: String = UUID().uuidString.lowercased(),creation: String = UUID().uuidString.lowercased(),version: UInt64 = 1,purpose: VolumePurpose = .data) throws -> VolumeIdentity {
        try VolumeIdentity(homeId:homeId,homePath:home.path,homeDevice:UInt64(bitPattern:Int64(info.st_dev)),homeInode:info.st_ino,workspaceId:workspace,volumeId:volume,creationId:creation,keyVersion:version,purpose:purpose)
    }
    let vault=SyntheticVault(),first=try vault.provisionForFixture(identity()),second=try vault.provisionForFixture(identity())
    try require(try vault.fixtureDomainSeparation([first,second]))
    for _ in 0..<160 { let fd=open("/dev/null",O_RDONLY|O_CLOEXEC);try require(fd>=0);extras.append(fd) }
    let launcher=FixtureWorkerLauncher(image:worker,vault:vault)
    func request(_ mode: String, record: SealedRecord) throws -> (OneShotAdmission,Data,Int32) {
        let (host,peer)=try fixturePipe(channel:true),(reportReader,reportWriter)=try fixturePipe()
        let child=try OwnedChild(image:client,mode:mode,input:peer,output:reportWriter)
        peer.close();reportWriter.close()
        let admission=OneShotAdmission(record:record,launchedPID:child.pid)
        try host.packet(JSONEncoder().encode(admission.bootstrap()));try child.resume()
        let bytes=try host.receivePacket();var peerPID:Int32=0;try require(kb_peer_pid(host.value,&peerPID)==0)
        try child.wait();try require(try reportReader.eofBytes().isEmpty);host.close()
        return (admission,bytes,peerPID)
    }
    var receipts:[WorkerReceipt]=[]
    for record in [first,second] {
        let (admission,bytes,pid)=try request("authorized",record:record)
        let admitted=try admission.consume(bytes,kernelPeerPID:pid,vault:vault)
        receipts.append(try launcher.launch(admitted,deniedFixturePath:denied.path))
        do { _=try admission.consume(bytes,kernelPeerPID:pid,vault:vault);throw BrokerFailure.processFailure } catch BrokerFailure.replay {}
    }
    let deliveries=launcher.keyDeliveries
    for mode in ["cross-workspace","forged-pid","forged-executable","wrong-token"] {
        let (admission,bytes,pid)=try request(mode,record:first)
        do { _=try admission.consume(bytes,kernelPeerPID:pid,vault:vault);throw BrokerFailure.processFailure }
        catch BrokerFailure.unauthorizedChannel {} catch BrokerFailure.forbiddenField {}
    }
    // Independently launched same fixture code has no inherited capability.
    let (dummyRead,dummyWrite)=try fixturePipe(),(outRead,outWrite)=try fixturePipe()
    let outsider=try OwnedChild(image:client,mode:"authorized",input:dummyRead,output:outWrite)
    dummyRead.close();dummyWrite.close();outWrite.close();try outsider.resume()
    do { try outsider.wait();throw BrokerFailure.unauthorizedChannel } catch BrokerFailure.processFailure {}
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
    try require(receipts[0].proof != receipts[1].proof)
    try emitFixtureJSON(["nativeKeyBrokerFixture":true,"twoRealWorkers":true,"sealedIdentity":true,"perWorkspaceKeyRouting":true,"inheritedOneShotAdmission":true,"crossWorkspaceDenied":true,"clientPIDAndExecutableDenied":true,"replayDenied":true,"independentClientDenied":true,"swappedExecutedImageDenied":true,"extra160FDsExcluded":true,"actualSandboxDenials":true,"daemonReceivesNoKeys":true,"actualKeychain":false,"realVM":false,"productionReady":false])
} catch { try? emitFixtureJSON(["nativeKeyBrokerFixture":false]);exit(72) }
