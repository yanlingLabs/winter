"""Offline static generic-port library/header build only. No worker, kernel or VM launch."""
import json,os,shutil,subprocess
from build import ROOT,OUT,PINS,digest
from prepare_runtime_port import prepare

def main():
    source=prepare();artifacts=OUT/'runtime-port-candidate';artifacts.mkdir(exist_ok=True)
    env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    command=[str(OUT/'rust/bin/cargo'),'rustc','--crate-type','staticlib','--manifest-path',str(source/'Cargo.toml'),'-p','libkrun','--locked','--offline','--no-default-features','--features','blk','--jobs','2','--','--print','native-static-libs']
    subprocess.run(command,check=True,env=env);shutil.copy2(source/'target/debug/libkrun.a',artifacts/'libkrun.a')
    smoke=artifacts/'header.cpp';smoke.write_text('#include "libkrun.h"\n#include "libkrun.h"\nextern "C" int32_t krun_create_cowork_runtime_stream(uint32_t);\nint32_t (*factory)(uint32_t)=krun_create_cowork_runtime_stream;\n')
    subprocess.run(['/usr/bin/clang++','-std=c++17','-Wall','-Wextra','-Werror','-fsyntax-only','-I',str(source/'include'),str(smoke)],check=True)
    receipt={'candidate':json.loads((ROOT/'runtime-port-candidate.json').read_text()),'vmStarted':False,'workerBuilt':False,'signedWorkerAdmissionVerified':False,'guestDriverBootVerified':False,'kernelBuilt':False,'productionReady':False,'fullResourceGatePassed':False,'activeReturnVerified':False,'keysOrUnlock':False,'headerCppDoubleIncludeCLinkageChecked':True,'nativeLinkage':'staticlib','archiveSha256':digest(artifacts/'libkrun.a'),'testReceiptSha256':digest(OUT/'runtime-port-test-receipt.json'),'sources':{name:digest(ROOT/name) for name in ['runtime_port.rs','runtime_port_control.rs','runtime-port-candidate.json','prepare_runtime_port.py','test_runtime_port.py','build_runtime_port.py','patches/0010-proposed-generic-runtime-port.patch','stream_io_v3.rs','stream_reclaim_access.rs']}}
    (artifacts/'build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
