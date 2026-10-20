import Foundation
import Darwin
import KeyBrokerCore
import KeyBrokerNative

// No arguments/PIDs accepted. Only this process's suspended /bin/sleep
// child is admitted; no keys, Winter home, daemon, network or VM are involved.
guard CommandLine.arguments.count==1 else { exit(64) }
do {
    guard kb_fixture_spawn_policy_refused()==1 else { throw BrokerFailure.processFailure }
    let image=try FixedFixtureImage("/bin/sleep")
    let (reader,writer)=try fixturePipe(),(reportReader,reportWriter)=try fixturePipe()
    let child=try OwnedChild(image:image,mode:"10",input:reader,output:reportWriter)
    reader.close();writer.close();reportWriter.close();reportReader.close()
    try child.resume()
    let start=ContinuousClock.now
    var timedOut=false
    do { _=try child.waitStatus() }
    catch ChildLifecycleFailure.timeout { timedOut=true }
    let elapsed=start.duration(to:ContinuousClock.now)
    let result=child.lifecycle
    guard timedOut,result.state == .confirmedExit,result.status==137,result.killSent,
          OwnedChild.ownershipDebt.isEmpty,OwnedChild.admissionCount==0 else { throw BrokerFailure.processFailure }
    let components=elapsed.components
    let receipt: [String:Any] = ["ownedChildTimeoutFixture":true,"createdChildOnly":true,"autoReapAdmissionRefused":true,
        "noKeys":true,"realVM":false,"productionReady":false,"timedOut":timedOut,
        "confirmedReap":true,"exitStatus":137,"killSent":true,"ownershipDebtCount":OwnedChild.ownershipDebt.count,
        "configuredWaitMilliseconds":2000,"configuredPostKillReapMilliseconds":250,
        "elapsedSeconds":Double(components.seconds)+Double(components.attoseconds)/1e18,
        "wallClockOSGuarantee":false]
    print(String(decoding:try JSONSerialization.data(withJSONObject:receipt,options:[.sortedKeys]),as:UTF8.self))
} catch { fputs("owned-child fixture failed\n",stderr);exit(1) }
