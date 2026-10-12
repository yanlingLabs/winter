"""Offline two-disk fixture worker/init build; never starts worker/VM or rewrites old caches."""
import argparse,hashlib,json,os,shutil,stat,subprocess
from pathlib import Path
from build import ROOT,OUT,PINS,checked,digest,verify,cpio
from workspace_fixture import ARTIFACT_DIRECTORY

SOURCES=['workspace_fixture_worker.c','workspace_fixture_init.c','workspace_fixture_layout.h','workspace_fd_handoff.h','workspace_fixture.py','build_workspace_fixture.py','run_workspace_fixture.py','generic_fixture_lifecycle.py','generic_fixture_oracle.py','generic_fixture_receipts.py','generic_capture.py','generic_sampler.h','generic_port_discovery.h','stream_frame_deadline.h','stream_capture_v2.py','stream_lifecycle.py','stream_fixture_oracle.py','run_stream_fixture.py','run_block.py','block_capture.py','block_receipts.py','reclaim_receipts.py','build.py','worker.entitlements','pins.json','workspace-disks-candidate-v2.json']
IDENTITY='dev.cowork.hvf.workspace-fixture-worker'

def verified_native(native_root):
    candidate=json.loads((ROOT/'workspace-disks-candidate-v2.json').read_text())
    artifacts=native_root/'out/workspace-disks-candidate-v2';receipt=json.loads((artifacts/'build.json').read_text())
    if receipt['candidate']!=candidate or receipt['vmStarted'] is not False or receipt['cAbiProbeReceipt'].get('cAbiIntakeVerified') is not True:raise RuntimeError('Accepted no-VM native two-disk receipt required')
    verify(artifacts/'libkrun.a',receipt['archiveSha256'])
    for name,pin in receipt['sources'].items():verify(ROOT/name,pin)
    source=native_root/candidate['source']
    if subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()!=candidate['baseRevision']:raise RuntimeError('Native revision changed')
    diff=subprocess.check_output(['git','-C',str(source),'diff','--binary','--no-ext-diff'])
    if hashlib.sha256(diff).hexdigest()!=candidate['fullSourceDiffSha256']:raise RuntimeError('Native composed source changed')
    for local,native in candidate['moduleCorrespondence'].items():
        if (ROOT/local).read_bytes()!=(source/native).read_bytes():raise RuntimeError('Native module changed: '+local)
    return source,artifacts,receipt

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--native-root',type=Path,required=True);parser.add_argument('--cache-root',type=Path,required=True);args=parser.parse_args()
    if os.uname().sysname!='Darwin' or os.uname().machine!='arm64':raise RuntimeError('Apple Silicon macOS required')
    source,native,receipt=verified_native(args.native_root.resolve());OUT.mkdir(exist_ok=True);artifacts=OUT/ARTIFACT_DIRECTORY
    # Each build must use a virgin namespace; frozen receipts are never refreshed in place.
    artifacts.mkdir()
    shutil.copy2(native/'libkrun.a',artifacts/'libkrun.a')
    worker=artifacts/'cowork-hvf-workspace-worker'
    checked(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-I',source/'include',ROOT/'workspace_fixture_worker.c',artifacts/'libkrun.a','-framework','Hypervisor','-liconv','-o',worker])
    checked(['/usr/bin/codesign','--force','--sign','-','--options','runtime','--identifier',IDENTITY,'--entitlements',ROOT/'worker.entitlements',worker])
    cache=args.cache_root.resolve();zig=(cache/PINS['zig']['cachedPath']).resolve();verify(cache/'../cowork-vm/out/tools/zig.tar.xz',PINS['zig']['archiveSha256'])
    if subprocess.check_output([str(zig),'version'],text=True).strip()!=PINS['zig']['version']:raise RuntimeError('Unexpected Zig')
    env=os.environ.copy();env.update(ZIG_GLOBAL_CACHE_DIR=str(OUT/'workspace-zig-global-cache'),ZIG_LOCAL_CACHE_DIR=str(OUT/'workspace-zig-local-cache'))
    checked([zig,'cc','-target','aarch64-linux-musl','-static','-O2','-Wall','-Wextra','-Werror','-DCOWORK_FIXTURE_SERIAL_LOG=1','-pthread',ROOT/'workspace_fixture_init.c','-o',artifacts/'init'],env=env)
    kernel=(cache/PINS['kernel']['cachedPath']).resolve();verify(kernel,PINS['kernel']['sha256']);shutil.copy2(kernel,artifacts/'kernel')
    (artifacts/'initramfs.cpio').write_bytes(cpio([('dev',stat.S_IFDIR|0o755,b'',0,0),('dev/console',stat.S_IFCHR|0o600,b'',5,1),('init',stat.S_IFREG|0o755,(artifacts/'init').read_bytes(),0,0),('TRAILER!!!',0,b'',0,0)]))
    result={'schemaVersion':1,'artifactDirectory':ARTIFACT_DIRECTORY,'identity':IDENTITY,'candidate':receipt['candidate'],'nativeBuildSha256':digest(native/'build.json'),'nativeArchiveSha256':receipt['archiveSha256'],'artifacts':{name:digest(artifacts/name) for name in ['libkrun.a','cowork-hvf-workspace-worker','init','initramfs.cpio','kernel']},'fixtureSources':{name:digest(ROOT/name) for name in SOURCES},'hostSamplerTransport':'dedicated-inherited-pipe-v1','volumeHandoff':'unnamed-datagram-after-sandbox-v1','runtimeAccessDevice':2,'volumeCapacities':[67108864,83886080],'vmStarted':False,'workerExecuted':False,'twoDiskActiveReturnVerified':False,'productionReady':False,'encryption':False}
    (artifacts/'build.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
if __name__=='__main__':main()
