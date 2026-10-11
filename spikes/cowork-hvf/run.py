"""Opt-in bounded worker lifecycle; kills only the Popen child it created on timeout."""
import argparse, fcntl, json, os, shutil, subprocess, tempfile, time
from pathlib import Path
from build import OUT, digest
from reporting import summary as reporting_summary
from reclaim_receipts import summary as reclaim_summary

def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run-fixture", action="store_true")
    group.add_argument("--run-reclaim-fixture", action="store_true")
    group.add_argument("--sandbox-check", action="store_true")
    profile=parser.add_mutually_exclusive_group()
    profile.add_argument("--instrument-reports", action="store_true")
    profile.add_argument("--reclaim", action="store_true")
    args = parser.parse_args()
    if args.run_reclaim_fixture:
        if args.instrument_reports:parser.error("Reclaim uses the separately reviewed candidate")
        args.reclaim=True
    if args.reclaim and args.run_fixture:parser.error("Use --run-reclaim-fixture for explicit reclaim opt-in")
    # Writable fixture ownership is separate from conversation concurrency.
    with (OUT / "worker.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        processes=subprocess.check_output(["/bin/ps","-axo","pid=,comm="],text=True)
        for line in processes.splitlines():
            parts=line.strip().split(None,1)
            if len(parts)==2 and parts[1].endswith("/cowork-hvf-worker"):
                raise RuntimeError(f"Existing fixture worker pid {parts[0]}; refusing overlap, no process killed")
        fixture = Path(tempfile.mkdtemp(prefix="fixture-", dir=OUT)).resolve()
        fixture.chmod(0o700)
        artifacts=OUT/("reclaim" if args.reclaim else "instrumented") if args.reclaim or args.instrument_reports else OUT
        build = json.loads((artifacts / "build.json").read_text())
        if args.reclaim:
            candidate=json.loads((OUT.parent/"results/2026-10-11-reclaim-candidate.json").read_text())
            if build.get("reclaimPatchSha256")!=candidate["patchSha256"]:raise RuntimeError("Build differs from frozen candidate")
        for name, pin in [("cowork-hvf-worker",build["workerSha256"]),("libkrun.1.dylib",build["librarySha256"]),("kernel",build["pins"]["kernel"]["sha256"]),("initramfs.cpio",build["initramfsSha256"])]:
            if digest(artifacts / name) != pin: raise RuntimeError(f"Artifact changed: {name}")
            shutil.copy2(artifacts / name,fixture / name)
        mode = "--run-reclaim-fixture" if args.run_reclaim_fixture else "--run-fixture" if args.run_fixture else "--sandbox-check"
        command = [str(fixture/"cowork-hvf-worker"),mode,str(fixture),str(fixture/"kernel"),str(fixture/"initramfs.cpio")]
        rows=[]; start=time.monotonic(); timed_out=False
        with (fixture/"worker.log").open("w") as log, (fixture/"worker.stdout.log").open("w") as stdout_log, (fixture/"worker.stderr.log").open("w") as stderr_log:
            # Empty credential environment. File handles are limited to inherited stdio.
            child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={"PATH":"/usr/bin:/bin","HOME":str(fixture),"TMPDIR":str(fixture)},text=True,bufsize=1,start_new_session=True)
            (fixture/"pid.json").write_text(json.dumps({"pid":child.pid,"command":command})+"\n")
            try:
                # Worker alarm is 120 s; host watchdog also covers sandbox/library-start failures.
                import queue, threading
                pending=queue.Queue()
                def read_output(stream,channel):
                    for line in stream: pending.put((channel,line))
                    pending.put((channel,None))
                for stream,channel in [(child.stdout,"stdout"),(child.stderr,"stderr")]:
                    threading.Thread(target=read_output,args=(stream,channel),daemon=True).start()
                closed=0
                while True:
                    if time.monotonic()-start>130:
                        timed_out=True; child.kill(); break
                    try: channel,line=pending.get(timeout=1)
                    except queue.Empty: continue
                    if line is None:
                        closed+=1
                        if closed==2:break
                        continue
                    log.write(line); log.flush()
                    target=stdout_log if channel=="stdout" else stderr_log;target.write(line);target.flush()
                    try:
                        payload=line
                        # PID 1's /dev/console goes through libkrun's kernel logger with no init blob.
                        marker=" init_or_kernel] "
                        if line.startswith("[") and marker in line:
                            payload=line.split(marker,1)[1]
                        elif line.startswith("[") and "] {" in line:
                            payload=line.split("] ",1)[1]
                        row=json.loads(payload)
                        row["channel"]=channel
                        row["hostElapsedSeconds"]=round(time.monotonic()-start,3); rows.append(row)
                        print(json.dumps(row),flush=True)
                    except ValueError: pass
                code=child.wait(timeout=5)
            finally:
                if child.poll() is None: child.kill(); child.wait()
        kinds=[row.get("kind") for row in rows]
        boot=next((row for row in rows if row.get("kind")=="linux_boot"),None)
        complete=next((row for row in rows if row.get("kind")=="guest_complete"),None)
        sandbox=next((row for row in rows if row.get("kind")=="sandbox"),None)
        memory=[]
        for cycle in range(1,4):
            touch=next((r for r in rows if r.get("kind")=="guest_touched" and r.get("cycle")==cycle),None)
            free=next((r for r in rows if r.get("kind")=="guest_freed" and r.get("cycle")==cycle),None)
            integrity=next((r for r in rows if r.get("kind")=="guest_integrity" and r.get("cycle")==cycle),None)
            if touch and free and integrity:
                before=[r["footprintBytes"] for r in rows if r.get("kind")=="host_memory" and touch["hostElapsedSeconds"]<r["hostElapsedSeconds"]<free["hostElapsedSeconds"]]
                after=[r["footprintBytes"] for r in rows if r.get("kind")=="host_memory" and free["hostElapsedSeconds"]+8<r["hostElapsedSeconds"]<integrity["hostElapsedSeconds"]]
                memory.append({"cycle":cycle,"touchedFootprintBytes":max(before,default=None),"postFreeFootprintBytes":min(after,default=None)})
        passed=code==0 and not timed_out and bool(sandbox)
        devices=[r for r in rows if r.get("kind")=="virtio_device"]
        expected_devices={"0x0004","0x0005"} if args.reclaim else {"0x0003","0x0004","0x0005"}
        inventory_ok=len(devices)==len(expected_devices) and {r.get("device") for r in devices}==expected_devices
        balloon=next((r for r in devices if r.get("device")=="0x0005"),None)
        reporting=bool(balloon and len(balloon["features"])>5 and balloon["features"][5]=="1")
        integrity_ok={r.get("cycle") for r in rows if r.get("kind")=="guest_integrity" and r.get("retained") is True and r.get("progress") is True}=={1,2,3}
        if args.run_fixture or args.run_reclaim_fixture: passed=passed and bool(boot) and bool(complete) and len(memory)==3 and integrity_ok and inventory_ok and "guest_failure" not in kinds
        result={"fixture":str(fixture),"exitCode":code,"timedOut":timed_out,"sandboxPassed":bool(sandbox),"linuxBoot":boot,"boundedBaselinePassed":passed,"deviceInventoryPassed":inventory_ok,"freePageReportingNegotiated":reporting,"memory":memory,"activeReturnVerified":False,"productionReady":False,"pins":build["pins"]}
        result["artifactDigests"]={name:digest(fixture/name) for name in ["cowork-hvf-worker","libkrun.1.dylib","kernel","initramfs.cpio"]}
        if args.instrument_reports:
            result["instrumentationPatchSha256"]=build["instrumentationPatchSha256"]
            result["reporting"]=reporting_summary(rows)
        if args.reclaim:
            result["reclaimPatchSha256"]=build["reclaimPatchSha256"]
            result["profile"]="reviewed-linux-hvf-reclaim-fixture"
            result["wfeAbsoluteDeadlineCaveat"]=True
            result["timerLatencyGuarantee"]=False
            result["boundedReclaimRunPassed"]=passed
            result["reclaimReceipts"]=reclaim_summary(rows)
            result["guestReuseIntegrityPassed"]={r.get("cycle") for r in rows if r.get("kind")=="guest_reuse" and r.get("anonymousZeroFill") is True and r.get("writtenIntegrity") is True}=={1,2,3}
            result["boundedReclaimRunPassed"]=passed and result["guestReuseIntegrityPassed"] and result["reclaimReceipts"]["receiptOrderingPassed"]
        (fixture/"events.jsonl").write_text("".join(json.dumps(r)+"\n" for r in rows))
        (fixture/"result.json").write_text(json.dumps(result,indent=2)+"\n")
        (OUT/"latest-fixture.txt").write_text(str(fixture)+"\n")
        print(json.dumps(result),flush=True)
        if not passed: raise SystemExit(1)

if __name__=="__main__": main()
