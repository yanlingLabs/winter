"""Build explicit RAW fixture artifacts only; never starts a VM or installs globally."""
import json,os,shutil,stat,subprocess
from build import ROOT,OUT,PINS,checked,digest,verify,cpio
from prepare_block import prepare

def main():
    if os.uname().sysname!='Darwin' or os.uname().machine!='arm64':raise RuntimeError('Apple Silicon macOS required')
    source=prepare();artifacts=OUT/'raw-block';artifacts.mkdir(exist_ok=True)
    env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    checked([OUT/'rust/bin/cargo','build','--manifest-path',source/'Cargo.toml','-p','libkrun','--locked','--offline','--no-default-features','--features','blk','--jobs','2'],env=env)
    library=artifacts/'libkrun.1.dylib';shutil.copy2(source/'target/debug/libkrun.dylib',library)
    checked(['/usr/bin/install_name_tool','-id','@rpath/libkrun.1.dylib',library]);checked(['/usr/bin/codesign','--force','--sign','-',library])
    checked(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-I',source/'include',ROOT/'block_worker.c',library,'-Wl,-rpath,@executable_path','-o',artifacts/'cowork-hvf-block-worker'])
    checked(['/usr/bin/codesign','--force','--sign','-','--identifier','dev.cowork.hvf.raw-block-fixture-worker','--entitlements',ROOT/'worker.entitlements',artifacts/'cowork-hvf-block-worker'])
    zig=(ROOT/PINS['zig']['cachedPath']).resolve();verify(ROOT/'../cowork-vm/out/tools/zig.tar.xz',PINS['zig']['archiveSha256'])
    if subprocess.check_output([str(zig),'version'],text=True).strip()!=PINS['zig']['version']:raise RuntimeError('Unexpected Zig')
    env=os.environ.copy();env.update(ZIG_GLOBAL_CACHE_DIR=str(OUT/'zig-global-cache'),ZIG_LOCAL_CACHE_DIR=str(OUT/'zig-local-cache'))
    checked([zig,'cc','-target','aarch64-linux-musl','-static','-O2','-Wall','-Wextra','-Werror','-DCOWORK_FIXTURE_SERIAL_LOG=1','-pthread',ROOT/'block_init.c','-o',artifacts/'init'],env=env)
    kernel=(ROOT/PINS['kernel']['cachedPath']).resolve();verify(kernel,PINS['kernel']['sha256']);shutil.copy2(kernel,artifacts/'kernel')
    (artifacts/'initramfs.cpio').write_bytes(cpio([('dev',stat.S_IFDIR|0o755,b'',0,0),('dev/console',stat.S_IFCHR|0o600,b'',5,1),('init',stat.S_IFREG|0o755,(artifacts/'init').read_bytes(),0,0),('TRAILER!!!',0,b'',0,0)]))
    pin=json.loads((ROOT/'block-candidate.json').read_text())
    receipt={'pins':PINS,'candidate':pin,'productionReady':False,'vmStarted':False,'identity':'dev.cowork.hvf.raw-block-fixture-worker','nativeOwnedCompletionHoldMillis':25,'encryption':False}
    receipt['artifacts']={name:digest(artifacts/name) for name in ['libkrun.1.dylib','cowork-hvf-block-worker','init','initramfs.cpio','kernel']}
    receipt['fixtureSources']={name:digest(ROOT/name) for name in ['block_worker.c','block_init.c','build_block.py','run_block.py','block_receipts.py']}
    (artifacts/'build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
