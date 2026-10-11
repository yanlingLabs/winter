"""Prepare/check the frozen native candidate only. Does not compile or start a VM."""
import subprocess,json
from pathlib import Path
from build import ROOT,OUT,PINS,verify,digest,checked

def prepare():
    source=OUT/"libkrun-reclaim";patch=ROOT/"patches/0002-proposed-active-reclaim.patch"
    if not source.exists():
        base=OUT/"libkrun"
        if base.exists():checked(["git","clone",base,source])
        else:checked(["git","clone","--depth","1","--branch",PINS["libkrun"]["tag"],PINS["libkrun"]["url"],source])
    revision=subprocess.check_output(["git","-C",str(source),"rev-parse","HEAD"],text=True).strip()
    if revision!=PINS["libkrun"]["revision"]:raise RuntimeError("Wrong candidate base revision")
    verify(source/"Cargo.lock",PINS["libkrun"]["lockSha256"])
    if not subprocess.check_output(["git","-C",str(source),"status","--porcelain"],text=True).strip():
        checked(["git","-C",source,"apply","--check",patch]);checked(["git","-C",source,"apply",patch])
    added=["cowork_fixture.rs","cowork_ranges.rs","cowork_barrier.rs","cowork_ops.rs","cowork_control.rs","cowork_coordinator.rs"]
    checked(["git","-C",source,"add","-N",*["src/vmm/src/"+name for name in added]])
    if subprocess.check_output(["git","-C",str(source),"ls-files","--others","--exclude-standard"],text=True).strip():raise RuntimeError("Unexpected untracked candidate source")
    if subprocess.check_output(["git","-C",str(source),"diff","--binary"])!=patch.read_bytes():raise RuntimeError("Candidate source differs from frozen patch")
    for name in ["ranges","barrier","ops","control","coordinator"]:
        if (ROOT/("reclaim_"+name+".rs")).read_bytes()!=(source/("src/vmm/src/cowork_"+name+".rs")).read_bytes():raise RuntimeError("Extracted implementation differs from native candidate: "+name)
    print(json.dumps({"source":"spikes/cowork-hvf/out/libkrun-reclaim","revision":revision,"patchSha256":digest(patch),"vmStarted":False}))
    return source

if __name__=="__main__":prepare()
