"""Build nonsecret stream v3 fixture artifacts only; no VM or global installation."""
import argparse,json,os,shutil,stat,subprocess
from build import ROOT,OUT,PINS,checked,digest,verify,cpio
from prepare_stream_v3 import prepare

def main():
    if os.uname().sysname!='Darwin' or os.uname().machine!='arm64':raise RuntimeError('Apple Silicon macOS required')
    parser=argparse.ArgumentParser();parser.add_argument('--receipt-only',action='store_true');args=parser.parse_args()
    source=prepare();artifacts=OUT/'stream-fixture-v3';artifacts.mkdir(exist_ok=True)
    prior_sha=digest(artifacts/'build.json') if (artifacts/'build.json').exists() else None
    if args.receipt_only:
        prior=json.loads((artifacts/'build.json').read_text())
        if prior['candidate']!=json.loads((ROOT/'stream-candidate-v3.json').read_text()):raise RuntimeError('Candidate changed; full build required')
        for name,pin in prior['artifacts'].items():verify(artifacts/name,pin)
        for name in ['stream_fixture_worker.c','stream_fixture_init.c','stream_frame_deadline.h']:verify(ROOT/name,prior['fixtureSources'][name])
        write_receipt(artifacts,prior_sha,True);return
    env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    checked([OUT/'rust/bin/cargo','rustc','--crate-type','staticlib','--manifest-path',source/'Cargo.toml','-p','libkrun','--locked','--offline','--no-default-features','--features','blk','--jobs','2','--','--print','native-static-libs'],env=env)
    library=artifacts/'libkrun.a';shutil.copy2(source/'target/debug/libkrun.a',library)
    checked(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-I',source/'include',ROOT/'stream_fixture_worker.c',library,'-framework','Hypervisor','-liconv','-o',artifacts/'cowork-hvf-stream-worker'])
    checked(['/usr/bin/codesign','--force','--sign','-','--options','runtime','--identifier','dev.cowork.hvf.stream-fixture-worker','--entitlements',ROOT/'worker.entitlements',artifacts/'cowork-hvf-stream-worker'])
    zig=(ROOT/PINS['zig']['cachedPath']).resolve();verify(ROOT/'../cowork-vm/out/tools/zig.tar.xz',PINS['zig']['archiveSha256'])
    if subprocess.check_output([str(zig),'version'],text=True).strip()!=PINS['zig']['version']:raise RuntimeError('Unexpected Zig')
    env=os.environ.copy();env.update(ZIG_GLOBAL_CACHE_DIR=str(OUT/'zig-global-cache'),ZIG_LOCAL_CACHE_DIR=str(OUT/'zig-local-cache'))
    checked([zig,'cc','-target','aarch64-linux-musl','-static','-O2','-Wall','-Wextra','-Werror','-DCOWORK_FIXTURE_SERIAL_LOG=1','-pthread',ROOT/'stream_fixture_init.c','-o',artifacts/'init'],env=env)
    kernel=(ROOT/PINS['kernel']['cachedPath']).resolve();verify(kernel,PINS['kernel']['sha256']);shutil.copy2(kernel,artifacts/'kernel')
    (artifacts/'initramfs.cpio').write_bytes(cpio([('dev',stat.S_IFDIR|0o755,b'',0,0),('dev/console',stat.S_IFCHR|0o600,b'',5,1),('init',stat.S_IFREG|0o755,(artifacts/'init').read_bytes(),0,0),('TRAILER!!!',0,b'',0,0)]))
    write_receipt(artifacts,prior_sha,False)

def write_receipt(artifacts,prior_sha,receipt_only):
    pin=json.loads((ROOT/'stream-candidate-v3.json').read_text())
    receipt={'pins':PINS,'candidate':pin,'productionReady':False,'vmStarted':False,'identity':'dev.cowork.hvf.stream-fixture-worker','nativeOwnedCompletionHoldMillis':25,'encryption':False,'nonsecretOnly':True,'sandboxBeforeFactory':True,'hardenedRuntime':True,'nativeLinkage':'staticlib','debuggerEntitlement':False,'kernelProfile':'previously-measured-Apple-kernel-with-HVC/virtio-console','priorBuildSha256':prior_sha,'receiptOnly':receipt_only,'artifactRebuilt':not receipt_only}
    receipt['artifacts']={name:digest(artifacts/name) for name in ['libkrun.a','cowork-hvf-stream-worker','init','initramfs.cpio','kernel']}
    receipt['fixtureSources']={name:digest(ROOT/name) for name in ['stream_fixture_worker.c','stream_fixture_init.c','stream_frame_deadline.h','build_stream_fixture.py','run_stream_fixture.py','stream_lifecycle.py','stream_capture_v2.py','block_capture.py','block_receipts.py','stream_fixture_oracle.py','run_block.py','reclaim_receipts.py','build.py','prepare_stream_v3.py','stream_io_v3.rs','stream_reclaim_access.rs','worker.entitlements','pins.json','stream-candidate-v3.json']}
    (artifacts/'build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
