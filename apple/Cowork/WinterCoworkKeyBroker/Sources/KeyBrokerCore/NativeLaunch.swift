import Foundation
import Darwin
import CryptoKit
import Security
import KeyBrokerNative

public final class OwnedFD {
    public private(set) var value: Int32
    public init(_ value: Int32) { self.value=value }
    public func close() { if value>=0 { Darwin.close(value);value = -1 } }
    deinit { close() }
    public func write(_ data: Data) throws { guard data.withUnsafeBytes({kb_write_all(value,$0.baseAddress,data.count)})==0 else { throw BrokerFailure.processFailure } }
    public func packet(_ data: Data) throws { guard data.count<=4096,data.withUnsafeBytes({kb_send_packet(value,$0.baseAddress,data.count)})==0 else { throw BrokerFailure.processFailure } }
    public func receivePacket() throws -> Data { var bytes=[UInt8](repeating:0,count:4096);let count=kb_recv_packet(value,&bytes,bytes.count,2000);guard count>0 else { throw BrokerFailure.unauthorizedChannel };return Data(bytes.prefix(Int(count))) }
    public func line() throws -> Data { var bytes=[UInt8](repeating:0,count:4096);let count=kb_read_line(value,&bytes,bytes.count,2000);guard count>=0 else { throw BrokerFailure.processFailure };return Data(bytes.prefix(Int(count))) }
    public func eofBytes() throws -> Data { var bytes=[UInt8](repeating:0,count:4096);let count=kb_read_bounded(value,&bytes,bytes.count,2000);guard count>=0 else { throw BrokerFailure.processFailure };return Data(bytes.prefix(Int(count))) }
}
public func fixturePipe(channel: Bool = false) throws -> (OwnedFD,OwnedFD) {
    var fds:[Int32]=[-1,-1]
    guard (channel ? kb_channel(&fds) : kb_pipe(&fds))==0 else { throw BrokerFailure.processFailure }
    return (OwnedFD(fds[0]),OwnedFD(fds[1]))
}
public func fixtureSandbox() throws { guard kb_fixture_sandbox()==0 else { throw BrokerFailure.sandboxRequired } }
public func wipe(_ data: inout Data) { data.withUnsafeMutableBytes { kb_wipe($0.baseAddress,$0.count) };data.removeAll(keepingCapacity:false) }

/// Fixture ad-hoc CodeDirectory pin, not production team/hardened admission.
public struct FixedFixtureImage {
    public let path: String
    private let digest: Data
    private let device: UInt64
    private let inode: UInt64
    private let codeHash: Data
    public init(_ path: String) throws {
        var info=stat()
        guard path==URL(fileURLWithPath:path).resolvingSymlinksInPath().standardizedFileURL.path,lstat(path,&info)==0,info.st_mode&S_IFMT==S_IFREG,info.st_nlink==1 else { throw BrokerFailure.imageMismatch }
        self.path=path;device=UInt64(bitPattern:Int64(info.st_dev));inode=info.st_ino
        digest=Data(SHA256.hash(data:try Data(contentsOf:URL(fileURLWithPath:path))))
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath:path) as CFURL,[],&code)==errSecSuccess,let code else { throw BrokerFailure.imageMismatch }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code,SecCSFlags(rawValue:kSecCSSigningInformation),&information)==errSecSuccess,
              let dictionary=information as? [String:Any],let hash=dictionary[kSecCodeInfoUnique as String] as? Data else { throw BrokerFailure.imageMismatch }
        codeHash=hash
    }
    public func validatePath() throws {
        var info=stat()
        guard lstat(path,&info)==0,UInt64(bitPattern:Int64(info.st_dev))==device,info.st_ino==inode,info.st_nlink==1,
              Data(SHA256.hash(data:try Data(contentsOf:URL(fileURLWithPath:path))))==digest else { throw BrokerFailure.imageMismatch }
    }
    public func validateExecuted(_ pid: Int32) throws {
        var code: SecCode?
        let attributes=[kSecGuestAttributePid as String:NSNumber(value:pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil,attributes,[],&code)==errSecSuccess,let code,
              SecCodeCheckValidity(code,SecCSFlags(rawValue:kSecCSStrictValidate),nil)==errSecSuccess else { throw BrokerFailure.imageMismatch }
        var staticCode: SecStaticCode?, information: CFDictionary?
        guard SecCodeCopyStaticCode(code,[],&staticCode)==errSecSuccess,let staticCode,
              SecCodeCopySigningInformation(staticCode,SecCSFlags(rawValue:kSecCSSigningInformation),&information)==errSecSuccess,
              let dictionary=information as? [String:Any],dictionary[kSecCodeInfoUnique as String] as? Data == codeHash else { throw BrokerFailure.imageMismatch }
    }
}
public struct WorkerBootstrap: Codable {
    public let frameVersion: UInt32
    public let keyByteCount: UInt16
    public let identity: VolumeIdentity
    public let challenge: Data
    public let deniedFixturePath: String
    public init(identity: VolumeIdentity, challenge: Data, deniedFixturePath: String) {
        frameVersion=WorkerKeyFrame.version;keyByteCount=UInt16(identity.keyFormat.byteCount)
        self.identity=identity;self.challenge=challenge;self.deniedFixturePath=deniedFixturePath
    }
    public func validate() throws {
        try identity.validate()
        guard frameVersion==WorkerKeyFrame.version,Int(keyByteCount)==identity.keyFormat.byteCount,
              challenge.count==32,deniedFixturePath.utf8.count<=1024,deniedFixturePath.hasPrefix("/"),
              !deniedFixturePath.contains("\0") else { throw BrokerFailure.invalidFrame }
    }
    public static func decode(_ data: Data) throws -> WorkerBootstrap {
        guard data.count<2048,let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],
              Set(object.keys)==["frameVersion","keyByteCount","identity","challenge","deniedFixturePath"],
              let identity=object["identity"] as? [String:Any],Set(identity.keys)==VolumeIdentity.wireFields else { throw BrokerFailure.invalidFrame }
        do { let value=try JSONDecoder().decode(Self.self,from:data);try value.validate();return value }
        catch { throw BrokerFailure.invalidFrame }
    }
}
public struct WorkerReceipt: Codable {
    public let frameVersion: UInt32
    public let keyFormat: VolumeKeyFormat
    public let keyByteCount: UInt16
    public let challenge: Data
    public let proof: Data
    public let sandbox: Bool
    public let bootstrapClosed: Bool
    public let extraFDs: Int
    public let fileDenied: Bool
    public let networkDenied: Bool
    public let execDenied: Bool
    public let securityServiceDenied: Bool
    public init(keyFormat: VolumeKeyFormat, challenge: Data, proof: Data, sandbox: Bool, bootstrapClosed: Bool, extraFDs: Int, fileDenied: Bool, networkDenied: Bool, execDenied: Bool, securityServiceDenied: Bool) { frameVersion=WorkerKeyFrame.version;self.keyFormat=keyFormat;keyByteCount=UInt16(keyFormat.byteCount);self.challenge=challenge;self.proof=proof;self.sandbox=sandbox;self.bootstrapClosed=bootstrapClosed;self.extraFDs=extraFDs;self.fileDenied=fileDenied;self.networkDenied=networkDenied;self.execDenied=execDenied;self.securityServiceDenied=securityServiceDenied }
    public static func decode(_ data: Data) throws -> WorkerReceipt {
        guard data.count<=4096,let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],
              Set(object.keys)==["frameVersion","keyFormat","keyByteCount","challenge","proof","sandbox","bootstrapClosed","extraFDs","fileDenied","networkDenied","execDenied","securityServiceDenied"] else { throw BrokerFailure.invalidFrame }
        do {
            let value=try JSONDecoder().decode(Self.self,from:data)
            guard value.frameVersion==WorkerKeyFrame.version,Int(value.keyByteCount)==value.keyFormat.byteCount,
                  value.challenge.count==32,value.proof.count==32 else { throw BrokerFailure.invalidFrame }
            return value
        } catch { throw BrokerFailure.invalidFrame }
    }
}
public struct WorkerReady: Codable {
    public let frameVersion: UInt32;public let sandbox: Bool;public let bootstrapFD: Int
    public init(sandbox: Bool, bootstrapFD: Int) { frameVersion=WorkerKeyFrame.version;self.sandbox=sandbox;self.bootstrapFD=bootstrapFD }
    public static func decode(_ data: Data) throws -> WorkerReady {
        guard data.count<=4096,let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],Set(object.keys)==["frameVersion","sandbox","bootstrapFD"] else { throw BrokerFailure.invalidFrame }
        let value=try JSONDecoder().decode(Self.self,from:data)
        guard value.frameVersion==WorkerKeyFrame.version else { throw BrokerFailure.invalidFrame };return value
    }
}
public func emitFixtureJSON<T:Encodable>(_ value: T) throws { let data=try JSONEncoder().encode(value);try OwnedFD(dup(STDOUT_FILENO)).write(data+Data([10])) }

/// Native capability, never constructed from JSON/RPC. The only key-bearing
/// message targets a broker-created, image-validated child. No decrypt API.
public final class FixtureWorkerLauncher {
    private let image: FixedFixtureImage
    private let vault: SyntheticVault
    public private(set) var keyDeliveries=0
    public init(image: FixedFixtureImage,vault: SyntheticVault) { self.image=image;self.vault=vault }
    public func launch(_ record: SealedRecord, deniedFixturePath: String, beforeSpawn: (() throws -> Void)? = nil) throws -> WorkerReceipt {
        try vault.validate(record)
        let (reader,writer)=try fixturePipe(),(reportReader,reportWriter)=try fixturePipe()
        let child=try OwnedChild(image:image,mode:"worker",input:reader,output:reportWriter,beforeSpawn:beforeSpawn)
        reader.close();reportWriter.close();try child.resume()
        let ready=try WorkerReady.decode(reportReader.line())
        guard ready.sandbox,ready.bootstrapFD==3 else { throw BrokerFailure.sandboxRequired }
        // Validate actual code again after READY, before any raw material flows.
        try image.validateExecuted(child.pid)
        let bootstrap=WorkerBootstrap(identity:record.identity,challenge:Data(SymmetricKey(size:.bits256).withUnsafeBytes{Data($0)}),deniedFixturePath:deniedFixturePath)
        var key=try vault.unlockMaterial(record);defer { wipe(&key) }
        var frame=try WorkerKeyFrame.encode(bootstrap,material:key);defer { wipe(&frame) }
        try writer.write(frame);keyDeliveries+=1;writer.close()
        let receipt=try WorkerReceipt.decode(reportReader.line());try child.wait()
        guard receipt.frameVersion==WorkerKeyFrame.version,receipt.keyFormat==record.identity.keyFormat,
              Int(receipt.keyByteCount)==record.identity.keyFormat.byteCount,
              receipt.challenge==bootstrap.challenge,try vault.proofMatches(receipt.proof,record:record,challenge:bootstrap.challenge),receipt.sandbox,receipt.bootstrapClosed,receipt.extraFDs==0,receipt.fileDenied,receipt.networkDenied,receipt.execDenied,receipt.securityServiceDenied else { throw BrokerFailure.processFailure }
        return receipt
    }
}
