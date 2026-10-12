"""Offline static admitted-FD backend and C/C++ ABI checks. No signing/worker/kernel/VM launch."""
import json, os, shutil, subprocess, tempfile
from build import ROOT, OUT, digest
from prepare_workspace_disks import prepare

def main():
    source=prepare();artifacts=OUT/'workspace-disks-candidate';artifacts.mkdir(exist_ok=True)
    tests=json.loads((OUT/'workspace-disks-test-receipt.json').read_text())
    if not tests.get('passed') or tests['patchSha256']!=digest(ROOT/'patches/0012-proposed-admitted-workspace-disks.patch'):raise RuntimeError('Exact native test receipt required')
    env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    with tempfile.TemporaryDirectory(prefix='workspace-native-build-',dir=OUT) as directory:
        env['TMPDIR']=directory
        command=[str(OUT/'rust/bin/cargo'),'rustc','--crate-type','staticlib','--manifest-path',str(source/'Cargo.toml'),'-p','libkrun','--locked','--offline','--no-default-features','--features','blk','--jobs','2','--','--print','native-static-libs']
        subprocess.run(command,check=True,env=env)
    shutil.copy2(source/'target/debug/libkrun.a',artifacts/'libkrun.a')
    smoke=artifacts/'header.cpp';smoke.write_text('#include "libkrun.h"\n#include "libkrun.h"\n#include <cstddef>\nstatic_assert(sizeof(krun_cowork_volume_identity)==32);\nstatic_assert(offsetof(krun_cowork_volume_identity,uid)==24);\nextern "C" int32_t krun_set_cowork_workspace_disks(uint32_t,int32_t,const krun_cowork_volume_identity*,int32_t,const krun_cowork_volume_identity*);\nauto intake=&krun_set_cowork_workspace_disks;\n')
    subprocess.run(['/usr/bin/clang++','-std=c++17','-Wall','-Wextra','-Werror','-fsyntax-only','-I',str(source/'include'),str(smoke)],check=True)
    symbols=subprocess.check_output(['/usr/bin/nm','-g',str(artifacts/'libkrun.a')],text=True,stderr=subprocess.DEVNULL)
    if ' T _krun_set_cowork_workspace_disks' not in symbols:raise RuntimeError('Missing native FD intake symbol')
    abi=artifacts/'workspace-disks-abi-smoke'
    subprocess.run(['/usr/bin/clang','-std=c11','-O2','-Wall','-Wextra','-Werror','-I',str(source/'include'),str(ROOT/'workspace_disks_abi_smoke.c'),str(artifacts/'libkrun.a'),'-framework','Hypervisor','-liconv','-lSystem','-lc','-lm','-o',str(abi)],check=True)
    abi_result=subprocess.run([str(abi)],check=True,capture_output=True,text=True,timeout=15)
    abi_receipt=json.loads(abi_result.stdout)
    if abi_receipt.get('cAbiIntakeVerified') is not True or abi_receipt.get('vmStarted') is not False:raise RuntimeError('Invalid no-VM C ABI receipt')
    receipt={'candidate':json.loads((ROOT/'workspace-disks-candidate.json').read_text()),'vmStarted':False,'workerBuilt':False,'signedWorkerAdmissionVerified':False,'nativeAuthorityImplemented':False,'guestFilesystemReady':False,'twoDiskActiveReturnVerified':False,'productionReady':False,'fullResourceGatePassed':False,'archiveSha256':digest(artifacts/'libkrun.a'),'testReceiptSha256':digest(OUT/'workspace-disks-test-receipt.json'),'nativeLinkage':'staticlib','headerCppDoubleIncludeCLinkageAndLayoutChecked':True,'exportedIntakeSymbolChecked':True,'cAbiProbeSha256':digest(abi),'cAbiProbeReceipt':abi_receipt,'sources':{name:digest(ROOT/name) for name in ['workspace_disks.rs','workspace_raw_storage.rs','workspace_disks_api_tests.rs','workspace_disks_device_tests.rs','workspace_disks_builder_tests.rs','workspace_disks_abi_smoke.c','workspace-disks-candidate.json','prepare_workspace_disks.py','test_workspace_disks.py','build_workspace_disks.py','patches/0012-proposed-admitted-workspace-disks.patch']}}
    (artifacts/'build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
