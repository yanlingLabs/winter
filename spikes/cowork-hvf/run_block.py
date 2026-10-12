"""Explicit sandbox/prelaunch/run lifecycle. Review receipt gates VM; only direct owned child killed."""
import argparse,fcntl,json,os,shutil,stat,struct,subprocess,tempfile
from pathlib import Path
from build import ROOT,OUT,digest
from block_receipts import summary
from block_capture import capture_owned_child

LAUNCH_DEPENDENCIES=frozenset(['run_block.py','block_capture.py','block_receipts.py','reclaim_receipts.py','build.py'])

def processes():
    lines=subprocess.check_output(['/bin/ps','-axo','pid=,comm='],text=True).splitlines()
    return [line.strip().split(None,1) for line in lines if len(line.strip().split(None,1))==2]
def disk_integrity(path,rows):
    results=[]
    with path.open('rb') as disk:
        for thread in [0,1]:
            row=next((r for r in rows if r.get('kind')=='guest_block_thread_complete' and r.get('thread')==thread),None)
            if row is None:return {'passed':False,'reason':'thread completion absent'}
            count=row['iterations'];good=True
            for slot in range(16):
                disk.seek(thread*4*1024*1024+slot*256*1024);data=disk.read(256*1024)
                last=count-1-((count-1-slot)%16) if count>slot else None
                for word,(value,) in enumerate(struct.iter_unpack('<Q',data)):
                    expected=0x6a39000000000000 ^ (thread<<48) ^ (last<<24) ^ word if last is not None else 0
                    if value!=expected:good=False;break
            results.append({'thread':thread,'iterations':count,'everyWordPassed':good})
    return {'passed':all(r['everyWordPassed'] and r['iterations']>0 for r in results),'threads':results}

def main():
    parser=argparse.ArgumentParser();mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--sandbox-check',action='store_true');mode.add_argument('--run-raw-block-fixture',action='store_true');parser.add_argument('--review-receipt',type=str);args=parser.parse_args()
    artifacts=OUT/'raw-block';build=json.loads((artifacts/'build.json').read_text());candidate=json.loads((ROOT/'block-candidate.json').read_text())
    if build['candidate']!=candidate:raise RuntimeError('Built candidate differs from frozen source manifest')
    for name,pin in build['artifacts'].items():
        if digest(artifacts/name)!=pin:raise RuntimeError('Artifact changed: '+name)
    if not LAUNCH_DEPENDENCIES.issubset(build['fixtureSources']):raise RuntimeError('Build omits a launch/audit dependency')
    for name,pin in build['fixtureSources'].items():
        if digest(ROOT/name)!=pin:raise RuntimeError('Fixture source changed: '+name)
    subprocess.run(['/usr/bin/codesign','--verify','--strict',str(artifacts/'cowork-hvf-block-worker')],check=True)
    inventory=processes()
    if any(parts[1].endswith(('/cowork-hvf-worker','/cowork-hvf-block-worker')) for parts in inventory):raise RuntimeError('Stale owned fixture worker; refusing overlap without killing')
    if args.run_raw_block_fixture:
        if not args.review_receipt:raise RuntimeError('Explicit independent prelaunch review receipt required; sandbox-check remains available')
        review=json.loads(open(args.review_receipt).read())
        if review.get('accepted') is not True or review.get('buildSha256')!=digest(artifacts/'build.json') or review.get('heavyCompileQuiescent') is not True:raise RuntimeError('Review does not bind this exact build/quiescence')
        if any(os.path.basename(parts[1]) in ['clang','cc1','rustc','gmake','make','ld.lld'] for parts in inventory):raise RuntimeError('Compile still active; no VM launched')
        pressure=subprocess.check_output(['/usr/bin/memory_pressure','-Q'],text=True)
        import re
        found=re.search(r'System-wide memory free percentage:\s*(\d+)%',pressure)
        if not found or int(found.group(1))<15:raise RuntimeError('Ordinary host pressure preflight not acceptable; no VM launched')
    with (OUT/'worker.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        fixture=Path(tempfile.mkdtemp(prefix='raw-block-fixture-',dir=OUT)).resolve();fixture.chmod(0o700)
        for name in build['artifacts']:
            if name=='init':continue
            shutil.copy2(artifacts/name,fixture/name)
        disk=fixture/'fixture.raw';fd=os.open(disk,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.ftruncate(fd,64*1024*1024);identity=os.fstat(fd);os.close(fd)
        command=[str(fixture/'cowork-hvf-block-worker'),'--run-raw-block-fixture' if args.run_raw_block_fixture else '--sandbox-check',str(fixture),str(fixture/'kernel'),str(fixture/'initramfs.cpio'),str(disk)]
        child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin','HOME':str(fixture),'TMPDIR':str(fixture)},bufsize=0,start_new_session=True)
        (fixture/'pid.json').write_text(json.dumps({'pid':child.pid,'command':command})+'\n')
        rows,capture=capture_owned_child(child,fixture)
        code=capture['exitCode'];timed_out=capture['timedOut']
        if not capture['exitVerified']:
            result={'fixture':fixture.name,'vmStarted':args.run_raw_block_fixture,**capture,'diskAuditSkipped':True,'diskSha256':None,'buildSha256':digest(artifacts/'build.json'),'candidate':candidate,'productionReady':False,'fullResourceGatePassed':False,'encryption':False,'activeReturnVerified':False}
            (fixture/'events.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));(fixture/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(1)
        after=disk.lstat();same=stat.S_ISREG(after.st_mode) and after.st_nlink==1 and after.st_dev==identity.st_dev and after.st_ino==identity.st_ino and after.st_size==64*1024*1024
        result={'fixture':fixture.name,'vmStarted':args.run_raw_block_fixture,'exitCode':code,'timedOut':timed_out,'diskSameIdentity':same,'diskSha256':digest(disk),'buildSha256':digest(artifacts/'build.json'),'candidate':candidate,**capture,'productionReady':False,'fullResourceGatePassed':False,'encryption':False}
        if args.run_raw_block_fixture:
            result.update(audit=summary(rows),diskIntegrity=disk_integrity(disk,rows))
            inventory_ok=sorted(r.get('device') for r in rows if r.get('kind')=='virtio_device')==['0x0002','0x0004','0x0005']
            guest_ok=any(r.get('kind')=='linux_boot' for r in rows) and any(r.get('kind')=='guest_complete' and r.get('cycles')==3 for r in rows)
            guest_ok=guest_ok and sum(r.get('kind')=='guest_reuse' and r.get('anonymousZeroFill') and r.get('writtenIntegrity') for r in rows)==3 and sum(r.get('kind')=='guest_integrity' and r.get('retained') and r.get('progress') for r in rows)==3
            result['footprint']=[]
            for cycle in range(1,4):
                touched=next((r for r in rows if r.get('kind')=='guest_touched' and r.get('cycle')==cycle),None);free=next((r for r in rows if r.get('kind')=='guest_freed' and r.get('cycle')==cycle),None);integrity=next((r for r in rows if r.get('kind')=='guest_integrity' and r.get('cycle')==cycle),None)
                if touched and free and integrity:
                    before=[r['footprintBytes'] for r in rows if r.get('kind')=='host_memory' and touched['hostElapsedSeconds']<r['hostElapsedSeconds']<free['hostElapsedSeconds']];after_samples=[r['footprintBytes'] for r in rows if r.get('kind')=='host_memory' and free['hostElapsedSeconds']+8<r['hostElapsedSeconds']<integrity['hostElapsedSeconds']]
                    result['footprint'].append({'cycle':cycle,'touchedBytes':max(before,default=None),'postFreeBytes':min(after_samples,default=None)})
            result['fixtureChecksPassed']=inventory_ok and guest_ok and result['diskIntegrity']['passed'] and result['audit']['blockReceiptsPassed'] and result['audit']['reclaim']['receiptOrderingPassed'] and all(w['heartbeatsDuringWindow']>=8 for w in result['audit']['reclaim']['afterGuestFree']) and not any(r.get('kind') in ['guest_failure','reclaim_failure','block_trace_overflow'] for r in rows)

        result['sandbox']=next((r for r in rows if r.get('kind')=='sandbox'),None)
        (fixture/'events.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));(fixture/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
        if code or timed_out or not capture['captureComplete'] or not same or not result['sandbox'] or (args.run_raw_block_fixture and not result.get('fixtureChecksPassed')):raise SystemExit(1)
if __name__=='__main__':
    from pathlib import Path
    main()
