"""Explicit sandbox/prelaunch/run lifecycle. Review receipt gates VM; only direct owned child killed."""
import argparse,fcntl,json,os,plistlib,re,shutil,socket,stat,subprocess,tempfile,time
from pathlib import Path
from build import ROOT,OUT,digest
from block_receipts import summary
from generic_fixture_lifecycle import supervise
from generic_fixture_receipts import audit as stream_audit
from run_block import disk_integrity,processes

LAUNCH_DEPENDENCIES=frozenset(['run_generic_fixture.py','generic_fixture_lifecycle.py','generic_fixture_oracle.py','generic_fixture_receipts.py','run_stream_fixture.py','stream_lifecycle.py','stream_fixture_oracle.py','stream_capture_v2.py','run_block.py','block_capture.py','block_receipts.py','reclaim_receipts.py','build.py'])

from run_stream_fixture import verify_signed_worker

def main():
    parser=argparse.ArgumentParser();mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--sandbox-check',action='store_true');mode.add_argument('--run-runtime-port-fixture',action='store_true');mode.add_argument('--run-runtime-port-close-fixture',action='store_true');parser.add_argument('--review-receipt',type=str);args=parser.parse_args()
    run_requested=args.run_runtime_port_fixture or args.run_runtime_port_close_fixture
    scenario='terminal-close' if args.run_runtime_port_close_fixture else 'normal'
    artifacts=OUT/'generic-fixture';build=json.loads((artifacts/'build.json').read_text());candidate=json.loads((ROOT/'runtime-port-trace-candidate.json').read_text())
    if build['candidate']!=candidate:raise RuntimeError('Built candidate differs from frozen source manifest')
    for name,pin in build['artifacts'].items():
        if digest(artifacts/name)!=pin:raise RuntimeError('Artifact changed: '+name)
    if not LAUNCH_DEPENDENCIES.issubset(build['fixtureSources']):raise RuntimeError('Build omits a launch/audit dependency')
    for name,pin in build['fixtureSources'].items():
        if digest(ROOT/name)!=pin:raise RuntimeError('Fixture source changed: '+name)
    signing=verify_signed_worker(artifacts/'cowork-hvf-generic-worker')
    inventory=processes()
    if any(parts[1].endswith(('/cowork-hvf-worker','/cowork-hvf-block-worker','/cowork-hvf-stream-worker','/cowork-hvf-generic-worker')) for parts in inventory):raise RuntimeError('Stale owned fixture worker; refusing overlap without killing')
    if run_requested:
        if not args.review_receipt:raise RuntimeError('Explicit independent prelaunch review receipt required; sandbox-check remains available')
        review=json.loads(Path(args.review_receipt).read_text())
        if review.get('accepted') is not True or review.get('buildSha256')!=digest(artifacts/'build.json') or review.get('heavyCompileQuiescent') is not True or review.get('scenario')!=scenario:raise RuntimeError('Review does not bind this exact build/quiescence')
        if any(os.path.basename(parts[1]) in ['clang','cc1','rustc','gmake','make','ld.lld'] for parts in inventory):raise RuntimeError('Compile still active; no VM launched')
        pressure=subprocess.check_output(['/usr/bin/memory_pressure','-Q'],text=True)
        found=re.search(r'System-wide memory free percentage:\s*(\d+)%',pressure)
        if not found or int(found.group(1))<15:raise RuntimeError('Ordinary host pressure preflight not acceptable; no VM launched')
    with (OUT/'worker.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        fixture=Path(tempfile.mkdtemp(prefix='generic-fixture-',dir=OUT)).resolve();fixture.chmod(0o700)
        for name in build['artifacts']:
            if name in ['init','libkrun.a']:continue
            shutil.copy2(artifacts/name,fixture/name)
        disk=fixture/'fixture.raw';fd=os.open(disk,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.ftruncate(fd,64*1024*1024);identity=os.fstat(fd);os.close(fd)
        command=[str(fixture/'cowork-hvf-generic-worker'),'--run-runtime-port-close-fixture' if args.run_runtime_port_close_fixture else '--run-runtime-port-fixture' if run_requested else '--sandbox-check',str(fixture),str(fixture/'kernel'),str(fixture/'initramfs.cpio'),str(disk)]
        parent_control,worker_control=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
        command.append(str(worker_control.fileno()))
        rows,capture,raw_result,sandbox_eof=supervise(command,fixture,run_requested,parent_control,worker_control,scenario=scenario)
        transfer_error=capture.get('lifecycleError')
        code=capture['exitCode'];timed_out=capture['timedOut']
        if not capture['ownersQuiescent']:
            result={'fixture':fixture.name,'vmStarted':run_requested,**capture,'diskAuditSkipped':True,'diskSha256':None,'streamOracle':raw_result,'peerTransferError':transfer_error,'buildSha256':digest(artifacts/'build.json'),'candidate':candidate,'productionReady':False,'fullResourceGatePassed':False,'encryption':False,'activeReturnVerified':False}
            (fixture/'events.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));(fixture/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(1)
        if args.run_runtime_port_close_fixture:
            result={'fixture':fixture.name,'vmStarted':True,'scenario':scenario,**capture,'diskAuditSkipped':True,'diskSha256':None,'effectOutcome':'UNCERTAIN','streamOracle':raw_result,'genericAudit':stream_audit(rows,raw_result or {},terminal_close=True),'buildSha256':digest(artifacts/'build.json'),'productionReady':False,'fullResourceGatePassed':False,'activeReturnVerified':False,'encryption':False}
            result['terminalRecoveryChecksPassed']=code==77 and capture['captureComplete'] and not transfer_error and result['genericAudit']['genericChecksPassed'] and not any(row.get('kind')=='guest_failure' for row in rows)
            result['rawCaptureHashes']={name:digest(fixture/name) for name in ['stream-host-to-guest.bin','stream-guest-to-host.bin']} if raw_result and raw_result.get('threadStarted') and raw_result.get('threadJoined') else None
            (fixture/'events.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows));(fixture/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
            raise SystemExit(0 if result['terminalRecoveryChecksPassed'] else 1)
        after=disk.lstat();same=stat.S_ISREG(after.st_mode) and after.st_nlink==1 and after.st_dev==identity.st_dev and after.st_ino==identity.st_ino and after.st_size==64*1024*1024
        result={'fixture':fixture.name,'vmStarted':run_requested,'exitCode':code,'timedOut':timed_out,'diskSameIdentity':same,'diskSha256':digest(disk),'buildSha256':digest(artifacts/'build.json'),'candidate':candidate,**capture,'productionReady':False,'fullResourceGatePassed':False,'encryption':False,'streamOracle':raw_result,'peerTransferError':transfer_error,'sandboxPeerEOF':sandbox_eof}
        if run_requested:
            result.update(audit=summary(rows),diskIntegrity=disk_integrity(disk,rows),streamAudit=stream_audit(rows,raw_result or {}))
            inventory_ok=sorted(r.get('device') for r in rows if r.get('kind')=='virtio_device')==['0x0002','0x0003','0x0004','0x0005']
            guest_ok=any(r.get('kind')=='linux_boot' for r in rows) and any(r.get('kind')=='guest_complete' and r.get('cycles')==3 for r in rows)
            guest_ok=guest_ok and sum(r.get('kind')=='guest_reuse' and r.get('anonymousZeroFill') and r.get('writtenIntegrity') for r in rows)==3 and sum(r.get('kind')=='guest_integrity' and r.get('retained') and r.get('progress') for r in rows)==3
            result['footprint']=[]
            for cycle in range(1,4):
                touched=next((r for r in rows if r.get('kind')=='guest_touched' and r.get('cycle')==cycle),None);free=next((r for r in rows if r.get('kind')=='guest_freed' and r.get('cycle')==cycle),None);integrity=next((r for r in rows if r.get('kind')=='guest_integrity' and r.get('cycle')==cycle),None)
                if touched and free and integrity:
                    before=[r['footprintBytes'] for r in rows if r.get('kind')=='host_memory' and touched['hostElapsedSeconds']<r['hostElapsedSeconds']<free['hostElapsedSeconds']];after_samples=[r['footprintBytes'] for r in rows if r.get('kind')=='host_memory' and free['hostElapsedSeconds']+8<r['hostElapsedSeconds']<integrity['hostElapsedSeconds']]
                    result['footprint'].append({'cycle':cycle,'touchedBytes':max(before,default=None),'postFreeBytes':min(after_samples,default=None)})
            result['fixtureChecksPassed']=result['streamAudit']['genericChecksPassed'] and inventory_ok and guest_ok and result['diskIntegrity']['passed'] and result['audit']['blockReceiptsPassed'] and result['audit']['reclaim']['receiptOrderingPassed'] and all(w['heartbeatsDuringWindow']>=8 for w in result['audit']['reclaim']['afterGuestFree']) and not any(r.get('kind') in ['guest_failure','reclaim_failure','block_trace_overflow'] for r in rows)

        result['signing']=signing
        result['rawCaptureHashes']={name:digest(fixture/name) for name in ['stream-host-to-guest.bin','stream-guest-to-host.bin']} if raw_result and raw_result.get('threadStarted') and raw_result.get('threadJoined') else None
        result['streamSandbox']=next((r for r in rows if r.get('kind')=='stream_sandbox'),None)
        result['activeReturnVerified']=False
        result['streamStopVerified']=False  # Normal poweroff/EOF is not an MMIO reset/Stop proof.
        result['sandbox']=next((r for r in rows if r.get('kind')=='sandbox'),None)
        (fixture/'events.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));(fixture/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
        if code or timed_out or not capture['captureComplete'] or not same or not result['sandbox'] or not result['streamSandbox'] or transfer_error or (not run_requested and not sandbox_eof) or (run_requested and not result.get('fixtureChecksPassed')):raise SystemExit(1)
if __name__=='__main__':main()
