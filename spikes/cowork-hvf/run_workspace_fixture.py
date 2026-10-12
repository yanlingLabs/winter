"""Explicit reviewed two-disk fixture launch. No production mode, host shares or credential APIs."""
import argparse,fcntl,json,os,re,shutil,socket,stat,subprocess,tempfile
from pathlib import Path
from build import ROOT,OUT,digest
from build_workspace_fixture import SOURCES,IDENTITY
from workspace_fixture import ARTIFACT_DIRECTORY,RUN_PREFIX,CAPACITIES,volume_identity,transfer_then_receive,disk_integrity,workspace_audit
from generic_fixture_lifecycle import supervise
from block_receipts import summary
from run_block import processes
from run_stream_fixture import verify_signed_worker

def verify_build(artifacts):
    build=json.loads((artifacts/'build.json').read_text())
    if build.get('schemaVersion')!=1 or build.get('artifactDirectory')!=ARTIFACT_DIRECTORY or build.get('volumeHandoff')!='unnamed-datagram-after-sandbox-v1' or build.get('hostSamplerTransport')!='dedicated-inherited-pipe-v1' or build.get('runtimeAccessDevice')!=2 or build.get('volumeCapacities')!=list(CAPACITIES) or build.get('identity')!=IDENTITY:raise RuntimeError('Exact two-disk fixture build required')
    if build['candidate']!=json.loads((ROOT/'workspace-disks-candidate-v2.json').read_text()) or set(build['fixtureSources'])!=set(SOURCES) or set(build['artifacts'])!={'libkrun.a','cowork-hvf-workspace-worker','init','initramfs.cpio','kernel'} or build['nativeArchiveSha256']!=build['artifacts']['libkrun.a']:raise RuntimeError('Build dependency/pin mismatch')
    for name,pin in build['fixtureSources'].items():
        if digest(ROOT/name)!=pin:raise RuntimeError('Source changed: '+name)
    for name,pin in build['artifacts'].items():
        if digest(artifacts/name)!=pin:raise RuntimeError('Artifact changed: '+name)
    return build

def verify_review(review,build_sha,run_requested):
    if review.get('accepted') is not True or review.get('buildSha256')!=build_sha or review.get('scenario')!=('two-disk-normal' if run_requested else 'two-disk-sandbox') or run_requested and review.get('heavyCompileQuiescent') is not True:raise RuntimeError('Independent exact two-disk source/artifact admission required')

def main():
    parser=argparse.ArgumentParser();mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--sandbox-check',action='store_true');mode.add_argument('--run-workspace-fixture',action='store_true');parser.add_argument('--review-receipt',type=Path,required=True);args=parser.parse_args();run=args.run_workspace_fixture
    artifacts=OUT/ARTIFACT_DIRECTORY;build=verify_build(artifacts);build_sha=digest(artifacts/'build.json');verify_review(json.loads(args.review_receipt.read_text()),build_sha,run)
    signing=verify_signed_worker(artifacts/'cowork-hvf-workspace-worker')
    signature=subprocess.run(['/usr/bin/codesign','-dvv',str(artifacts/'cowork-hvf-workspace-worker')],capture_output=True,text=True,check=True).stderr
    if 'Identifier='+IDENTITY+'\n' not in signature:raise RuntimeError('Exact fixture signature identity required')
    inventory=processes()
    if any(parts[1].endswith(('/cowork-hvf-worker','/cowork-hvf-block-worker','/cowork-hvf-stream-worker','/cowork-hvf-generic-worker','/cowork-hvf-workspace-worker')) for parts in inventory):raise RuntimeError('Fixture owner already active; never kill unrelated owner')
    if run:
        if any(os.path.basename(parts[1]) in ['clang','cc1','rustc','gmake','make','ld.lld'] for parts in inventory):raise RuntimeError('Heavy compiler active; no VM launched')
        pressure=subprocess.check_output(['/usr/bin/memory_pressure','-Q'],text=True);free=re.search(r'System-wide memory free percentage:\s*(\d+)%',pressure)
        if not free or int(free.group(1))<15:raise RuntimeError('Ordinary host pressure unacceptable; no VM launched')
    with (OUT/'worker.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        directory=Path(tempfile.mkdtemp(prefix=RUN_PREFIX,dir=OUT)).resolve();directory.chmod(0o700)
        for name in ['cowork-hvf-workspace-worker','kernel','initramfs.cpio']:shutil.copy2(artifacts/name,directory/name)
        descriptors=[];identities=[];paths=[]
        try:
            for name,capacity in zip(['data.raw','environment.raw'],CAPACITIES):
                path=directory/name;fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600);descriptors.append(fd);os.ftruncate(fd,capacity);identities.append(volume_identity(fd));paths.append(path)
            parent,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
            command=[str(directory/'cowork-hvf-workspace-worker'),'--run-runtime-port-fixture' if run else '--sandbox-check',str(directory),str(directory/'kernel'),str(directory/'initramfs.cpio'),str(paths[0]),str(worker.fileno())]
            # Disk FDs are NOT pass_fds. Only control/sampler inherit; the pair is
            # sent privately after exec and received only after sandbox admission.
            rows,capture,raw,sandbox_eof=supervise(command,directory,run,parent,worker,receive_fn=transfer_then_receive(tuple(descriptors)))
            result={'schemaVersion':1,'fixture':directory.name,'scenario':'two-disk-normal' if run else 'two-disk-sandbox','vmStarted':run,'buildSha256':build_sha,'candidate':build['candidate'],'signing':signing,**capture,'streamOracle':raw,'sandboxPeerEOF':sandbox_eof,'sandbox':next((r for r in rows if r.get('kind')=='sandbox'),None),'streamSandbox':next((r for r in rows if r.get('kind')=='stream_sandbox'),None),'diskAuditSkipped':not capture['ownersQuiescent'],'twoDiskActiveReturnVerified':False,'productionReady':False,'fullResourceGatePassed':False,'encryption':False}
            result['fixtureChecksPassed']=False
            if capture['ownersQuiescent']:
                same=[]
                for path,fd,expected in zip(paths,descriptors,identities):
                    current=path.lstat();same.append(stat.S_ISREG(current.st_mode) and current.st_nlink==1 and (current.st_dev,current.st_ino,current.st_size,current.st_uid,stat.S_IMODE(current.st_mode))==expected and volume_identity(fd)==expected)
                result['diskSameIdentity']=same
                result['diskSha256']=[digest(path) for path in paths] if all(same) else None
                if run and all(same):
                    result['diskIntegrity']=[disk_integrity(path,index,rows) for index,path in enumerate(paths)];result['workspaceAudit']=workspace_audit(rows,raw or {});result['blockAudit']=summary(rows)
                    inventory_ok=sorted(r.get('device') for r in rows if r.get('kind')=='virtio_device')==['0x0002','0x0002','0x0003','0x0004','0x0005']
                    guest_ok=any(r.get('kind')=='guest_complete' and r.get('cycles')==3 for r in rows) and sum(r.get('kind')=='guest_reuse' and r.get('anonymousZeroFill') is True and r.get('writtenIntegrity') is True for r in rows)==3 and sum(r.get('kind')=='guest_integrity' and r.get('retained') is True and r.get('progress') is True for r in rows)==3
                    result['fixtureChecksPassed']=inventory_ok and guest_ok and result['workspaceAudit']['passed'] and all(v['passed'] for v in result['diskIntegrity']) and result['blockAudit']['blockReceiptsPassed'] and result['blockAudit']['reclaim']['receiptOrderingPassed'] and all(w['heartbeatsDuringWindow']>=8 for w in result['blockAudit']['reclaim']['afterGuestFree']) and not any(r.get('kind') in ['guest_failure','reclaim_failure','block_trace_overflow'] for r in rows)
                elif not run:result['fixtureChecksPassed']=all(same) and sandbox_eof is True
                if raw and raw.get('threadStarted') and raw.get('threadJoined'):result['rawCaptureHashes']={name:digest(directory/name) for name in ['stream-host-to-guest.bin','stream-guest-to-host.bin']}
            passed=result['fixtureChecksPassed'] and capture['exitVerified'] and capture['exitCode']==0 and capture['captureComplete'] and not capture['lifecycleError'] and not capture['timedOut'] and not any(capture.get('malformedJsonLines',{}).values()) and result['sandbox'] and result['streamSandbox']
            result['passed']=bool(passed)
            (directory/'events.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows));(directory/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(0 if passed else 1)
        finally:
            for fd in descriptors:os.close(fd)
if __name__=='__main__':main()
